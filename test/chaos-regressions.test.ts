import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { redactSecrets } from '../src/core/chat-context.ts';
import { defineChannelPlugin } from '../src/core/channel-contract.ts';
import { Kernel } from '../src/core/kernel.ts';
import { normalizeProjectsConfig } from '../src/core/projects.ts';
import { WebSimTransport } from '../src/im/sim.ts';
import { OpenMausBotBridge } from '../src/openmausbot/bridge.ts';
import { maskNonTriggerSpans, parseInlineTriggerMention, parseStartMention } from '../src/openmausbot/mentions.ts';
import type { ImContextService } from '../src/openmausbot/types.ts';
import { imContextPlugin } from '../src/plugins/im-context.ts';
import { inspectorPlugin } from '../src/plugins/inspector.ts';
import { webPlugin } from '../src/plugins/web.ts';
import type { ChannelAdapter, InboundEvent, RawConfig, TelemetryEvent } from '../src/types.ts';
import { WebServer } from '../src/web/server.ts';
import { makeMockHarness, makeMockTransport } from './helpers/mock-im-context.ts';

const until = (fn: () => boolean, ms = 3000): Promise<void> => new Promise((resolve, reject) => {
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
  const events: InboundEvent[] = [];
  const web = new WebServer({ host: '127.0.0.1', port: 0, publicDir: path.resolve('public') });
  const sim = new WebSimTransport({ web, filesDir: path.join(tmpDir, 'files') });
  await sim.start((ev) => events.push(ev));
  await web.start();

  const postRaw = async (urlPath: string, rawBody: string) => {
    const { port } = web.server!.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rawBody,
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };

  try {
    for (const bad of ['null', '[1,2]', '"hello"', '123']) {
      const r = await postRaw('/send', bad);
      assert.equal(r.status, 400);
      assert.equal(r.body.error, '请求体必须是 JSON 对象');
    }

    const rCharlie = await postRaw('/send', JSON.stringify({ chatId: 'grp_dev', sender: 'charlie', text: '@bot status' }));
    assert.equal(rCharlie.status, 200);
    assert.equal(events.at(-1)!.sender.id, 'charlie');
    assert.equal(events.at(-1)!.sender.isSelf, false);

    const rCapAlice = await postRaw('/send', JSON.stringify({ chatId: 'grp_dev', sender: 'Alice', text: '@bot status' }));
    assert.equal(rCapAlice.status, 200);
    assert.equal(events.at(-1)!.sender.id, 'Alice');
    assert.equal(events.at(-1)!.sender.isSelf, false);

    const rSelfSpoof = await postRaw('/send', JSON.stringify({ chatId: 'self', sender: 'alice', text: '@bot status' }));
    assert.equal(rSelfSpoof.status, 403);
    assert.equal((await postRaw('/send', JSON.stringify({ chatId: '', text: 'hi' }))).status, 400);
    assert.equal((await postRaw('/send', JSON.stringify({ chatId: 'grp_dev', sender: null, text: 'hi' }))).status, 400);
    assert.equal((await postRaw('/send', JSON.stringify({ chatId: 'grp_dev', sender: '__proto__', text: 'hi' }))).status, 400);

    const rGhost = await postRaw('/recall', JSON.stringify({ chatId: 'grp_dev', msgId: 'nonexistent_id', sender: 'me' }));
    assert.equal(rGhost.status, 404);
    assert.equal(events.some((e) => e.kind === 'recall' && e.recalledMsgId === 'nonexistent_id'), false);

    const rMeGrp = await postRaw('/send', JSON.stringify({ chatId: 'grp_dev', sender: 'me', text: 'owner msg' }));
    assert.equal(rMeGrp.status, 200);
    const rCrossRecall = await postRaw('/recall', JSON.stringify({ chatId: 'grp_dev', msgId: rMeGrp.body.id, sender: 'alice' }));
    assert.equal(rCrossRecall.status, 403);

    const botMsgId = await sim.send('grp_dev', '🤖 助手回复');
    assert.equal((await postRaw('/recall', JSON.stringify({ chatId: 'grp_dev', msgId: botMsgId, sender: 'me' }))).status, 403);

    assert.equal((await postRaw('/upload', JSON.stringify({ chatId: 'grp_dev', sender: 'me', name: '..', data: 'aGVsbG8=' }))).status, 400);
    assert.equal((await postRaw('/upload', JSON.stringify({ chatId: 'grp_dev', sender: 'me', name: 'bad.txt', data: '!!!notbase64!!!' }))).status, 400);

    const deadSse = {
      writableEnded: false,
      destroyed: false,
      write() { throw new Error('EPIPE'); },
      end() {},
    } as unknown as http.ServerResponse;
    sim.clients.add(deadSse);
    const rOk = await postRaw('/send', JSON.stringify({ chatId: 'grp_dev', sender: 'me', text: 'after broken sse' }));
    assert.equal(rOk.status, 200);
    assert.equal(!sim.clients.has(deadSse), true);

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

  let emitInbound: ((rawMsg: unknown) => void) | null = null;
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

  const kernel = new Kernel({ config: { web: { host: '127.0.0.1', port: 0 }, dataDir: tmpDir, chats: {} } as RawConfig });
  kernel.use(webPlugin);
  kernel.use(mockChannel);
  kernel.use(imContextPlugin);
  kernel.use(inspectorPlugin);
  await kernel.start();

  try {
    const web = kernel.get<WebServer>('web');
    const imContext = kernel.get<ImContextService>('imContext');
    const channel = kernel.get<ChannelAdapter>('channel');
    await channel.start((ev) => imContext.recordInbound(ev as Partial<InboundEvent>), {});
    const base = `http://127.0.0.1:${(web.server!.address() as AddressInfo).port}`;

    for (let i = 1; i <= 4; i += 1) {
      await emitInbound!({
        id: `m_${i}`,
        ts: Date.now() + i,
        chat: { id: 'grp_dev', type: 'group', name: '研发群' },
        sender: { id: 'alice', name: 'Alice', isSelf: false },
        text: i === 2 ? '连接串 mysql://root:dbpass99@10.0.0.5/core 请勿外泄' : `普通日志 ${i}`,
      });
    }

    const evRes = await fetch(`${base}/api/debug/events?limit=2`).then((r) => r.json()) as { ok: boolean; filter: { limit: number }; events: unknown[] };
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
  assert.equal(parseStartMention('> @bot 帮我看下日志'), null);
  assert.equal(parseInlineTriggerMention('> @bot 帮我看下日志'), null);
  assert.match(maskNonTriggerSpans('> @bot quoted\nhello'), /^\s+\nhello$/);
  const realHit = parseInlineTriggerMention('> 引用他人 @bot\n请 @bot 排查超时');
  assert.equal(realHit?.isDefault, true);
  assert.match(realHit?.bodyText || '', /排查超时/);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-chaos-c2c-'));
  const orderDir = path.join(tmpDir, 'order');
  const hrDir = path.join(tmpDir, 'private-hr');
  fs.mkdirSync(orderDir, { recursive: true });
  fs.mkdirSync(hrDir, { recursive: true });
  const { client, sentPrompts } = makeMockHarness();
  const { transport } = makeMockTransport();
  const telemetry: TelemetryEvent[] = [];

  const bridge = new OpenMausBotBridge({
    client,
    transport,
    dataDir: tmpDir,
    projects: normalizeProjectsConfig([
      { name: 'order', path: orderDir },
      { name: 'private-hr', path: hrDir },
    ]),
    chats: {
      collaborators: [{ id: 'alice', name: 'Alice', policy: 'auto_readonly', projects: ['order'], chats: [] }],
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
    assert.ok(telemetry.some((t) => t.type === 'policy_denied' && /delegation_requires_direct/.test(t.summary || '')));

    await bridge.onEvent({
      id: 'c2c_no_proj_tag',
      ts: Date.now() + 1,
      chat: { id: 'dm_alice', type: 'direct', name: 'Alice' },
      sender: { id: 'alice', name: 'Alice', isSelf: false },
      text: '读取 private-hr 薪资表\n[cobot:req id=d_unauth_1]',
    });
    assert.equal(sentPrompts.length, 0);
    assert.equal(bridge.status().policyDenials, 2);
    assert.ok(telemetry.some((t) => t.type === 'policy_denied' && /project_not_authorized:private-hr/.test(t.summary || '')));
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
  const telemetry: TelemetryEvent[] = [];

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
  mock.client.getMessages = async () => {
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
  const realNow = bridge.now;
  let fakeOffset = 0;
  bridge.now = () => realNow() + fakeOffset;

  try {
    await bridge.onEvent({ id: 'cmd_status', ts: Date.now() + 1, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot status' });
    assert.match(sent.at(-1)!.text, /🔴.*异常（主协调 dead）/);

    await bridge.onEvent({ id: 'turn_dead', ts: Date.now() + 2, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot 测试 dead 空回执' });
    fakeOffset += 3000;
    await until(() => sent.some((m) => m.text.includes('dead') && m.text.includes('❌')));
    assert.ok(telemetry.some((t) => t.type === 'turn_failed' && t.summary === 'bot_dead'));

    botActivity = 'idle';
    messagesMode = 'media';
    const failCountBefore = telemetry.filter((t) => t.type === 'turn_failed').length;
    await bridge.onEvent({ id: 'turn_media', ts: Date.now() + 3, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot 截张图' });
    fakeOffset += 3000;
    await until(() => sentFiles.length >= 1);
    assert.equal(telemetry.filter((t) => t.type === 'turn_failed').length, failCountBefore);

    const promptsBeforeCmds = mock.sentPrompts.length;
    await bridge.onEvent({ id: 'grp_seed', ts: Date.now() + 4, chat: { id: 'grp_dev', type: 'group', name: '研发架构群' }, sender: { id: 'me', isSelf: true }, text: '群讨论基准消息' });

    await bridge.onEvent({ id: 'cmd_sb1', ts: Date.now() + 5, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot sendback draft_missing_999' });
    assert.match(sent.at(-1)!.text, /未找到或已过期的草稿/);
    assert.equal(bridge.pendingSendBack, null);

    await bridge.onEvent({ id: 'cmd_b1', ts: Date.now() + 6, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot bind grp_dev order' });
    assert.match(sent.at(-1)!.text, /已将「研发架构群」绑定到项目/);
    await bridge.onEvent({ id: 'cmd_b2', ts: Date.now() + 7, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot bind grp_dev unbind' });
    assert.match(sent.at(-1)!.text, /已解除「研发架构群」的项目绑定/);
    await bridge.onEvent({ id: 'cmd_b3', ts: Date.now() + 8, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot bind grp_dev' });
    assert.match(sent.at(-1)!.text, /用法：/);

    await bridge.onEvent({ id: 'cmd_del', ts: Date.now() + 9, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot delegate unknown_chat 你好' });
    assert.match(sent.at(-1)!.text, /未找到可委托的外部群\/联系人/);
    await bridge.onEvent({ id: 'cmd_del_grp', ts: Date.now() + 9.5, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot delegate grp_dev 你好' });
    assert.match(sent.at(-1)!.text, /仅支持点对点私聊/);

    await bridge.onEvent({ id: 'cmd_sum1', ts: Date.now() + 10, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot summary grp_dev 99999' });
    assert.match(sent.at(-1)!.text, /1～200/);
    await bridge.onEvent({ id: 'cmd_sum2', ts: Date.now() + 11, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot summary grp_dev 0' });
    assert.match(sent.at(-1)!.text, /1～200/);

    for (const arg of ['0', '-1', 'abc']) {
      await bridge.onEvent({ id: `cmd_t_${arg}`, ts: Date.now() + 12, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: `@bot task ${arg}` });
      assert.match(sent.at(-1)!.text, /用法：.*task \[正整数序号\]/);
    }
    assert.equal(mock.sentPrompts.length, promptsBeforeCmds);

    bridge.lastBotReplyAt = 0;
    mock.client.sendMessage = async () => { throw new Error('boom'); };
    await bridge.onEvent({ id: 'cmd_new_fail', ts: Date.now() + 15, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot new 排查故障' });
    assert.equal(bridge.lastBotReplyAt, 0);
  } finally {
    await bridge.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('externalBotPrefix custom/empty, disconnected noBuffer + mentions replay, and polish forceBotPrefix', async () => {
  for (const [extPrefix, expectRe] of [
    ['', /^纯正文回复$/],
    ['[AI] ', /^\[AI\] 纯正文回复$/],
    ['🤖 ', /^🤖 \*\*\[co-bot\]\*\* 纯正文回复$/],
  ] as Array<[string, RegExp]>) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-prefix-'));
    const mock = makeMockHarness({
      onSendMessage(entry) {
        return { message: { id: `req_${mock.sentPrompts.length}` }, text: entry.text };
      },
    });
    mock.client.getMessages = async (_tid: string) => ({
      messages: [
        { id: `req_${mock.sentPrompts.length}`, role: 'user', text: 'hi' },
        { id: `bot_${mock.sentPrompts.length}`, role: 'bot', requestMessageId: `req_${mock.sentPrompts.length}`, kind: 'text', turnTerminal: true, text: '纯正文回复' },
      ],
    });
    const { sent, transport } = makeMockTransport();
    const bridge = new OpenMausBotBridge({
      client: mock.client,
      transport,
      dataDir: tmpDir,
      chats: { mode: 'owner_everywhere', externalBotPrefix: extPrefix, isolateThreadsByChat: false },
    });
    await bridge.start();
    try {
      await bridge.onEvent({ id: 's0', ts: 1, chat: { id: 'self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: 'hi' });
      await bridge.onEvent({ id: 'g1', ts: 2, chat: { id: 'grp_1', type: 'group', name: 'G1' }, sender: { id: 'me', isSelf: true }, text: '@bot ping' });
      await until(() => sent.length >= 1, 2000);
      assert.match(sent.at(-1)!.text, expectRe);
    } finally {
      await bridge.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // Disconnected noBuffer + mentions replay + polish forceBotPrefix
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-nobuf-'));
  let connected = false;
  const replayedOpts: Array<Record<string, unknown>> = [];
  const mock = makeMockHarness();
  let lastReqId = '';
  mock.client.sendMessage = async () => {
    lastReqId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    return { message: { id: lastReqId } };
  };
  mock.client.getMessages = async () => ({
    messages: [
      { id: lastReqId, role: 'user', text: 'q' },
      { id: `bot_${lastReqId}`, role: 'bot', requestMessageId: lastReqId, kind: 'text', turnTerminal: true, text: '草稿内容' },
    ],
  });
  const transport = {
    selfChatId: 'self',
    status: () => ({ kind: 'mock', connected, selfChatId: 'self', lastError: null, reconnectAttempts: 0 }),
    async start() {},
    async stop() {},
    async send(_chatId: string, _text: string, opts: Record<string, unknown> = {}) {
      if (!connected) throw new Error('disconnected');
      replayedOpts.push(opts);
      return `m_${replayedOpts.length}`;
    },
  };
  const bridge = new OpenMausBotBridge({
    client: mock.client,
    transport: transport as never,
    dataDir: tmpDir,
    sendRetries: 0,
    chats: { mode: 'owner_everywhere', collaborators: [{ id: 'u_col', name: 'Alice', policy: 'confirm_in_self', projects: [], chats: [] }] },
  });
  await bridge.start();
  try {
    // 1. Disconnected say buffers with mentions and replays with mentions
    await bridge.say('hello @Alice', { targetChatId: 'grp_1' }, null, null, { mentions: [{ id: 'u_col', name: 'Alice' }] });
    assert.equal(bridge.disconnectedBuffer.length, 1);
    assert.equal(bridge.disconnectedBuffer[0].mentions?.[0]?.id, 'u_col');
    connected = true;
    await bridge.flushOutboundBuffer();
    assert.equal(replayedOpts.length, 1);
    assert.deepEqual(replayedOpts[0].mentions, [{ id: 'u_col', name: 'Alice' }]);

    // 2. Disconnected sendDelegation & confirmSendBack do not buffer
    connected = false;
    const delRes = await bridge.sendDelegation({ id: 'dm_1', name: 'Bob', type: 'direct' }, '请协助排查');
    assert.equal(delRes.ok, false);
    assert.equal(bridge.disconnectedBuffer.length, 0);

    bridge.pendingSendBack = {
      draft: {
        id: 'd_sb',
        imMsgId: 'im_d_sb',
        originChatId: 'grp_1',
        originChatName: 'G1',
        originChatType: 'group',
        replyToImMsgId: null,
        rawText: '回发测试',
        addBotPrefix: true,
        createdAt: bridge.now(),
      },
      text: '回发测试',
      expiresAt: bridge.now() + 60_000,
    };
    const sbRes = await bridge.confirmSendBack();
    assert.equal(sbRes, null);
    assert.equal(bridge.disconnectedBuffer.filter((x) => x.chatId === 'grp_1').length, 0);
    bridge.disconnectedBuffer.length = 0;

    // 3. PolishDraft preserves forceBotPrefix on confirm_in_self / draft_first drafts
    connected = true;
    await bridge.onEvent({
      id: 'col_q',
      ts: Date.now(),
      chat: { id: 'grp_col', type: 'group', name: '协同群' },
      sender: { id: 'u_col', name: 'Alice', isSelf: false },
      text: '@bot 查一下发布状态',
    });
    await until(() => bridge.privateDrafts.size >= 1, 2000);
    const origDraft = [...bridge.privateDrafts.values()][0];
    assert.equal(origDraft.forceBotPrefix, true);

    await bridge.onEvent({
      id: 'pol_1',
      ts: Date.now() + 10,
      chat: { id: 'self', type: 'self' },
      sender: { id: 'me', isSelf: true },
      replyTo: origDraft.imMsgId,
      text: '@bot 改得更简洁一点',
    });
    await until(() => bridge.privateDrafts.size >= 2, 2000);
    const polished = [...bridge.privateDrafts.values()].at(-1)!;
    assert.equal(polished.forceBotPrefix, true, '润色草稿应继承原草稿的 forceBotPrefix');
  } finally {
    await bridge.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
