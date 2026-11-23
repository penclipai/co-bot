import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { redactSecrets } from '../src/core/chat-context.js';
import { defineChannelPlugin } from '../src/core/channel-contract.js';
import { Kernel } from '../src/core/kernel.js';
import { normalizeProjectsConfig } from '../src/core/projects.js';
import { WebSimTransport } from '../src/im/sim.js';
import { OpenMausBotBridge } from '../src/openmausbot/bridge.js';
import { maskNonTriggerSpans, parseInlineTriggerMention, parseStartMention } from '../src/openmausbot/mentions.js';
import { imContextPlugin } from '../src/plugins/im-context.js';
import { inspectorPlugin } from '../src/plugins/inspector.js';
import { webPlugin } from '../src/plugins/web.js';
import { WebServer } from '../src/web/server.js';
import { makeMockHarness, makeMockTransport } from './helpers/mock-im-context.js';

const until = (fn, ms = 3000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const check = () => {
    if (fn()) return resolve();
    if (Date.now() - t0 > ms) return reject(new Error(`timeout: ${fn.toString()}`));
    setTimeout(check, 15);
  };
  check();
});

test('WebServer & WebSimTransport: 严格校验 JSON 对象、身份伪造、撤回鉴权、上传与 SSE 断连', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-chaos-sim-'));
  const events = [];
  const web = new WebServer({ host: '127.0.0.1', port: 0, publicDir: path.resolve('public') });
  const sim = new WebSimTransport({ web, filesDir: path.join(tmpDir, 'files') });
  await sim.start((ev) => events.push(ev));
  await web.start();

  const postRaw = async (urlPath, rawBody) => {
    const port = web.server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rawBody,
    });
    return { status: res.status, body: await res.json() };
  };

  try {
    // 1. WebServer 拒绝 JSON null / array / string / number
    for (const bad of ['null', '[1,2]', '"hello"', '123']) {
      const r = await postRaw('/send', bad);
      assert.equal(r.status, 400);
      assert.equal(r.body.error, '请求体必须是 JSON 对象');
    }

    // 2. 未知发送者与大小写变体绝不能被提升为 me (isSelf: true)
    const rCharlie = await postRaw('/send', JSON.stringify({ chatId: 'grp_dev', sender: 'charlie', text: '@bot status' }));
    assert.equal(rCharlie.status, 200);
    assert.equal(events.at(-1).sender.id, 'charlie');
    assert.equal(events.at(-1).sender.isSelf, false);

    const rCapAlice = await postRaw('/send', JSON.stringify({ chatId: 'grp_dev', sender: 'Alice', text: '@bot status' }));
    assert.equal(rCapAlice.status, 200);
    assert.equal(events.at(-1).sender.id, 'Alice');
    assert.equal(events.at(-1).sender.isSelf, false);

    // 3. 自聊禁止非本人发送者，空 chatId / 原型键 / 非字符串 sender 返回 400
    const rSelfSpoof = await postRaw('/send', JSON.stringify({ chatId: 'self', sender: 'alice', text: '@bot status' }));
    assert.equal(rSelfSpoof.status, 403);
    assert.equal((await postRaw('/send', JSON.stringify({ chatId: '', text: 'hi' }))).status, 400);
    assert.equal((await postRaw('/send', JSON.stringify({ chatId: 'grp_dev', sender: null, text: 'hi' }))).status, 400);
    assert.equal((await postRaw('/send', JSON.stringify({ chatId: 'grp_dev', sender: '__proto__', text: 'hi' }))).status, 400);

    // 4. 撤回鉴权与幽灵撤回防护
    const rGhost = await postRaw('/recall', JSON.stringify({ chatId: 'grp_dev', msgId: 'nonexistent_id', sender: 'me' }));
    assert.equal(rGhost.status, 404);
    assert.equal(events.some((e) => e.kind === 'recall' && e.recalledMsgId === 'nonexistent_id'), false);

    const rMeGrp = await postRaw('/send', JSON.stringify({ chatId: 'grp_dev', sender: 'me', text: 'owner msg' }));
    assert.equal(rMeGrp.status, 200);
    const rCrossRecall = await postRaw('/recall', JSON.stringify({ chatId: 'grp_dev', msgId: rMeGrp.body.id, sender: 'alice' }));
    assert.equal(rCrossRecall.status, 403);

    const botMsgId = await sim.send('grp_dev', '🤖 助手回复');
    assert.equal((await postRaw('/recall', JSON.stringify({ chatId: 'grp_dev', msgId: botMsgId, sender: 'me' }))).status, 403);

    // 5. 上传文件名 ".." 与非法 base64 返回 400；损坏的 SSE client 被清理且不抛异常
    assert.equal((await postRaw('/upload', JSON.stringify({ chatId: 'grp_dev', sender: 'me', name: '..', data: 'aGVsbG8=' }))).status, 400);
    assert.equal((await postRaw('/upload', JSON.stringify({ chatId: 'grp_dev', sender: 'me', name: 'bad.txt', data: '!!!notbase64!!!' }))).status, 400);

    let closedClientRemoved = false;
    const deadSse = {
      writableEnded: false,
      destroyed: false,
      write() { throw new Error('EPIPE'); },
      end() {},
    };
    sim.clients.add(deadSse);
    const rOk = await postRaw('/send', JSON.stringify({ chatId: 'grp_dev', sender: 'me', text: 'after broken sse' }));
    assert.equal(rOk.status, 200);
    closedClientRemoved = !sim.clients.has(deadSse);
    assert.equal(closedClientRemoved, true);

    // 本人自己的消息可正常撤回
    const rOwnRecall = await postRaw('/recall', JSON.stringify({ chatId: 'grp_dev', msgId: rMeGrp.body.id, sender: 'me' }));
    assert.equal(rOwnRecall.status, 200);
    assert.equal(rOwnRecall.body.removed, true);
  } finally {
    await sim.stop();
    await web.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('redactSecrets 与 inspector: 脱敏 DB URL/JWT/AWS 且 /api/debug/events 支持 ?limit=', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-chaos-insp-'));
  const redacted = redactSecrets('db=mysql://root:dbpass99@10.0.0.5/core jwt=eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiYSJ9.sig_1234567890 aws=AKIAIOSFODNN7EXAMPLE tok=omb_sess_abc123');
  assert.doesNotMatch(redacted, /dbpass99|sig_1234567890|AKIAIOSFODNN7EXAMPLE|omb_sess_abc123/);
  assert.match(redacted, /\[REDACTED\]/);
  assert.match(redacted, /\[已脱敏:db_url\]/);

  let emitInbound = null;
  const mockChannel = defineChannelPlugin({
    name: 'chaos-insp-mock',
    capabilities: { markdown: true, files: false, images: false, history: false },
    create() {
      return {
        async start(cb) { emitInbound = cb; },
        async send() { return 'out_1'; },
        async stop() {},
      };
    },
  });

  const kernel = new Kernel({ config: { web: { host: '127.0.0.1', port: 0 }, dataDir: tmpDir, chats: {} } });
  kernel.use(webPlugin);
  kernel.use(mockChannel);
  kernel.use(imContextPlugin);
  kernel.use(inspectorPlugin);
  await kernel.start();

  try {
    const web = kernel.get('web');
    const imContext = kernel.get('imContext');
    const channel = kernel.get('channel');
    await channel.start((ev) => imContext.recordInbound(ev));
    const base = `http://127.0.0.1:${web.server.address().port}`;

    for (let i = 1; i <= 4; i += 1) {
      await emitInbound({
        id: `m_${i}`,
        ts: Date.now() + i,
        chat: { id: 'grp_dev', type: 'group', name: '研发群' },
        sender: { id: 'alice', name: 'Alice', isSelf: false },
        text: i === 2 ? '连接串 mysql://root:dbpass99@10.0.0.5/core 请勿外泄' : `普通日志 ${i}`,
      });
    }

    const evRes = await fetch(`${base}/api/debug/events?limit=2`).then((r) => r.json());
    assert.equal(evRes.ok, true);
    assert.equal(evRes.filter.limit, 2);
    assert.equal(evRes.events.length, 2);

    const allEvRes = await fetch(`${base}/api/debug/events`).then((r) => r.json());
    assert.doesNotMatch(JSON.stringify(allEvRes), /dbpass99/);

    const bundleText = await fetch(`${base}/api/debug/bundle`).then((r) => r.text());
    assert.doesNotMatch(bundleText, /dbpass99/);
  } finally {
    await kernel.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('mentions & C2C [cobot:req]: 忽略 Markdown 引用块且限制群聊或未授权项目的委托', async () => {
  // 1. Markdown 引用行不误触发，非引用行正常触发
  assert.equal(parseStartMention('> @bot 帮我看下日志'), null);
  assert.equal(parseInlineTriggerMention('> @bot 帮我看下日志'), null);
  assert.match(maskNonTriggerSpans('> @bot quoted\nhello'), /^\s+\nhello$/);
  const realHit = parseInlineTriggerMention('> 引用他人 @bot\n请 @bot 排查超时');
  assert.equal(realHit?.isDefault, true);
  assert.match(realHit?.bodyText || '', /排查超时/);

  // 2. C2C [cobot:req] 仅允许 direct 会话，且无 proj= 时提未授权项目也会被策略拒绝
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-chaos-c2c-'));
  const orderDir = path.join(tmpDir, 'order');
  const hrDir = path.join(tmpDir, 'private-hr');
  fs.mkdirSync(orderDir, { recursive: true });
  fs.mkdirSync(hrDir, { recursive: true });
  const { client, sentPrompts } = makeMockHarness();
  const { transport } = makeMockTransport();
  const telemetry = [];

  const bridge = new OpenMausBotBridge({
    client,
    transport,
    dataDir: tmpDir,
    projects: normalizeProjectsConfig([
      { name: 'order', path: orderDir },
      { name: 'private-hr', path: hrDir },
    ]),
    chats: {
      collaborators: [{ id: 'alice', name: 'Alice', policy: 'auto_readonly', projects: ['order'] }],
    },
    onTelemetry: (e) => telemetry.push(e),
    turnStallMs: 0,
    stateSaveDebounceMs: 0,
  });
  await bridge.start();

  try {
    await bridge.onEvent({
      id: 'c2c_in_grp',
      ts: Date.now(),
      chat: { id: 'grp_dev', type: 'group', name: '研发群' },
      sender: { id: 'alice', name: 'Alice', isSelf: false },
      text: '帮我看下 order\n[cobot:req id=d_grp_1]',
    });
    assert.equal(sentPrompts.length, 0);
    assert.ok(telemetry.some((t) => t.type === 'policy_denied' && /delegation_requires_direct/.test(t.summary)));

    await bridge.onEvent({
      id: 'c2c_no_proj_tag',
      ts: Date.now() + 1,
      chat: { id: 'dm_alice', type: 'direct', name: 'Alice' },
      sender: { id: 'alice', name: 'Alice', isSelf: false },
      text: '读取 private-hr 薪资表\n[cobot:req id=d_unauth_1]',
    });
    assert.equal(sentPrompts.length, 0);
    assert.equal(bridge.status().policyDenials, 2);
    assert.ok(telemetry.some((t) => t.type === 'policy_denied' && /project_not_authorized:private-hr/.test(t.summary)));
  } finally {
    await bridge.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('turn-tracker & commands: dead 状态检测、空转显式报错、媒体静默放行及命令边界校验', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-chaos-cmd-'));
  const orderDir = path.join(tmpDir, 'order');
  fs.mkdirSync(orderDir, { recursive: true });
  let botActivity = 'dead';
  let messagesMode = 'empty';
  const telemetry = [];

  const mock = makeMockHarness({
    onSendMessage() {
      return { message: { id: `req_${mock.sentPrompts.length}` } };
    },
  });
  mock.client.listBots = async () => ({
    bots: [{
      id: 'bot_main',
      name: 'MausBot',
      chiefOfStaff: true,
      activity: botActivity,
      threadId: 'th_self_main',
      mainThreadId: 'th_self_main',
      tasks: [{ id: 'th_self_main', threadId: 'th_self_main', title: '主线' }],
    }],
    groups: [],
  });
  mock.client.getJob = async () => ({ state: 'idle', since: 2, version: 2 });
  mock.client.getMessages = async (_tid) => {
    if (messagesMode === 'media') {
      const reqId = `req_${mock.sentPrompts.length}`;
      return {
        messages: [{
          id: `m_media_${mock.sentPrompts.length}`,
          role: 'bot',
          requestMessageId: reqId,
          kind: 'screen',
          hasImage: true,
        }],
      };
    }
    return { messages: [] };
  };
  mock.client.downloadMessageImage = async () => ({
    buf: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
    mime: 'image/png',
  });

  const { transport, sent, sentFiles } = makeMockTransport();
  const bridge = new OpenMausBotBridge({
    client: mock.client,
    transport,
    dataDir: tmpDir,
    projects: normalizeProjectsConfig([{ name: 'order', path: orderDir }]),
    onTelemetry: (e) => telemetry.push(e),
    turnStallMs: 0,
    stateSaveDebounceMs: 0,
  });
  await bridge.start();
  bridge.lastNow = Date.now();
  // 加快 empty/idle 轮次在单测中无需等满 2.5s：模拟 startedAt 为 3 秒前
  const realNow = bridge.now;
  let fakeOffset = 0;
  bridge.now = () => realNow() + fakeOffset;

  try {
    // 1. @bot status 统一展示健康状态与团队成员 dead 异常标示
    await bridge.onEvent({ id: 'cmd_status', ts: Date.now() + 1, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot status' });
    assert.match(sent.at(-1).text, /异常\(dead\)/);
    assert.match(sent.at(-1).text, /🔴.*异常（主协调 dead）/);

    // 2. dead 空轮次显式通知并记入 turn_failed 遥测
    await bridge.onEvent({ id: 'turn_dead', ts: Date.now() + 2, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot 测试 dead 空回执' });
    fakeOffset += 3000;
    await until(() => sent.some((m) => m.text.includes('dead') && m.text.includes('❌')));
    assert.ok(telemetry.some((t) => t.type === 'turn_failed' && t.summary === 'bot_dead'));

    // 3. 纯媒体（无文本）轮次正常投递附件，不触发 ❌ 空转误报
    botActivity = 'idle';
    messagesMode = 'media';
    const failCountBefore = telemetry.filter((t) => t.type === 'turn_failed').length;
    await bridge.onEvent({ id: 'turn_media', ts: Date.now() + 3, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot 截张图' });
    fakeOffset += 3000;
    await until(() => sentFiles.length >= 1);
    assert.equal(telemetry.filter((t) => t.type === 'turn_failed').length, failCountBefore);

    // 4. 命令边界场景验证（不误调 LLM）
    const promptsBeforeCmds = mock.sentPrompts.length;
    await bridge.onEvent({ id: 'grp_seed', ts: Date.now() + 4, chat: { id: 'grp_dev', type: 'group', name: '研发架构群' }, sender: { id: 'me', isSelf: true }, text: '群讨论基准消息' });

    // sendback 不存在的 draft ID
    await bridge.onEvent({ id: 'cmd_sb1', ts: Date.now() + 5, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot sendback draft_missing_999' });
    assert.match(sent.at(-1).text, /未找到或已过期的草稿/);
    assert.equal(bridge.pendingSendBack, null);

    // bind <chat> unbind & bind <chat> 缺参数提示
    await bridge.onEvent({ id: 'cmd_b1', ts: Date.now() + 6, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot bind grp_dev order' });
    assert.match(sent.at(-1).text, /已将「研发架构群」绑定到项目/);
    await bridge.onEvent({ id: 'cmd_b2', ts: Date.now() + 7, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot bind grp_dev unbind' });
    assert.match(sent.at(-1).text, /已解除「研发架构群」的项目绑定/);
    await bridge.onEvent({ id: 'cmd_b3', ts: Date.now() + 8, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot bind grp_dev' });
    assert.match(sent.at(-1).text, /用法：/);

    // delegate 未知会话拒绝
    await bridge.onEvent({ id: 'cmd_del', ts: Date.now() + 9, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot delegate unknown_chat 你好' });
    assert.match(sent.at(-1).text, /未找到可委托的外部群\/联系人/);

    // summary 越界条数 99999 与 0 拒绝
    await bridge.onEvent({ id: 'cmd_sum1', ts: Date.now() + 10, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot summary grp_dev 99999' });
    assert.match(sent.at(-1).text, /1～200/);
    await bridge.onEvent({ id: 'cmd_sum2', ts: Date.now() + 11, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot summary grp_dev 0' });
    assert.match(sent.at(-1).text, /1～200/);

    // task 非法序号本地拦截
    for (const arg of ['0', '-1', 'abc']) {
      await bridge.onEvent({ id: `cmd_t_${arg}`, ts: Date.now() + 12, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: `@bot task ${arg}` });
      assert.match(sent.at(-1).text, /用法：.*task \[正整数序号\]/);
    }
    assert.equal(mock.sentPrompts.length, promptsBeforeCmds);

    // new <prompt> 在回复成功前不提前激活粘性窗口
    bridge.lastBotReplyAt = 0;
    mock.client.sendMessage = async () => { throw new Error('boom'); };
    await bridge.onEvent({ id: 'cmd_new_fail', ts: Date.now() + 15, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot new 排查故障' });
    assert.equal(bridge.lastBotReplyAt, 0);
  } finally {
    await bridge.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
