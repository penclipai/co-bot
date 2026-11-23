import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { validateConfig } from '../src/config.js';
import { Kernel } from '../src/core/kernel.js';
import { defineChannelPlugin } from '../src/core/channel-contract.js';
import { OpenMausBotBridge } from '../src/openmausbot/bridge.js';
import { buildHelpText } from '../src/openmausbot/commands.js';
import { openmausbotPlugin } from '../src/plugins/openmausbot.js';
import { inspectorPlugin } from '../src/plugins/inspector.js';
import { webPlugin } from '../src/plugins/web.js';

const until = (fn, ms = 3000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const check = () => {
    if (fn()) return resolve();
    if (Date.now() - t0 > ms) return reject(new Error('timeout waiting condition'));
    setTimeout(check, 15);
  };
  check();
});

function makeTransport() {
  const sent = [];
  let connected = true;
  let onMsg = null;
  let seq = 0;
  return {
    sent,
    setConnected(v) { connected = Boolean(v); },
    async push(ev) { await onMsg?.(ev); },
    transport: {
      selfChatId: 'chat_self',
      canFiles: true,
      capabilities: { markdown: true, files: true, images: true, replyTo: true, actions: true, history: true, maxChars: 0, multiDevice: true },
      status() { return { kind: 'mock', connected, selfChatId: 'chat_self' }; },
      async start(cb) { onMsg = cb; },
      async stop() {},
      async send(chatId, text, opts = {}) {
        if (!connected) throw new Error('transport offline');
        const id = `im_${++seq}`;
        sent.push({ id, chatId, text, ...opts });
        return id;
      },
      async sendFile(chatId, { name }, opts = {}) {
        const id = `imf_${++seq}`;
        sent.push({ id, chatId, text: `[file:${name}]`, ...opts });
        return id;
      },
    },
  };
}

function makeMockClient({ onSendMessage, getJob: customGetJob, getMessages: customGetMessages } = {}) {
  const sentPrompts = [];
  const ssePushers = [];
  const jobWaiters = [];
  return {
    sentPrompts,
    pushSse(evt) { for (const cb of ssePushers) cb(evt); },
    releaseJobs() {
      for (const w of jobWaiters.splice(0)) w();
    },
    client: {
      async health() { return { ok: true, version: '0.1.173', box: 'off' }; },
      async environment() { return { capabilities: {} }; },
      async authSession() { return { kind: 'none' }; },
      async listBots() {
        return {
          bots: [{ id: 'b1', name: 'MausBot', threadId: 'th_self_1', chiefOfStaff: true, tasks: [{ threadId: 'th_self_1', title: '自聊主线' }] }],
          groups: [],
        };
      },
      async resolveBot() { return { id: 'b1', name: 'MausBot', threadId: 'th_self_1', chiefOfStaff: true }; },
      async sendMessage(botId, payload) {
        sentPrompts.push({ botId, ...payload });
        if (onSendMessage) return onSendMessage(payload);
        return { ok: true, threadId: payload.threadId, message: { id: `req_${sentPrompts.length}`, role: 'user', sendId: payload.sendId } };
      },
      async getJob(threadId, opts) {
        if (customGetJob) return customGetJob(threadId, opts, (fn) => jobWaiters.push(fn));
        return { state: 'completed', version: 'v1' };
      },
      async getMessages(threadId, limit) {
        if (customGetMessages) return customGetMessages(threadId, limit);
        return { messages: [] };
      },
      async subscribeEvents(cb, { signal }) {
        ssePushers.push(cb);
        await cb({ kind: 'hello', cursor: '1' });
        await new Promise((r) => {
          if (signal?.aborted) return r();
          signal?.addEventListener('abort', r, { once: true });
        });
      },
      async interrupt() {},
    },
  };
}

test('Resilience A1: inFlightTurns survives restart and delivers final reply exactly once', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-res-turn-'));
  try {
    // 1. 首轮发出消息但未完成即 stop()
    const t1 = makeTransport();
    let completeNow = false;
    const m1 = makeMockClient({
      onSendMessage(payload) {
        return { ok: true, threadId: payload.threadId, message: { id: 'req_long_1', role: 'user', sendId: payload.sendId } };
      },
      async getJob(_tid, { signal }) {
        if (completeNow) return { state: 'completed', version: 'v2' };
        await new Promise((r) => {
          if (signal?.aborted) return r();
          signal?.addEventListener('abort', r, { once: true });
        });
        return { state: 'running', version: 'v1' };
      },
      async getMessages() {
        return {
          messages: completeNow
            ? [
                { id: 'req_long_1', role: 'user', sendId: 's1' },
                { id: 'bot_long_1', role: 'bot', requestMessageId: 'req_long_1', kind: 'text', turnTerminal: true, text: '后台长任务执行完成，结论正常。' },
              ]
            : [{ id: 'req_long_1', role: 'user', sendId: 's1' }],
        };
      },
    });
    const b1 = new OpenMausBotBridge({ client: m1.client, transport: t1.transport, dataDir: tmpDir, turnStallMs: 0 });
    await b1.start();
    await t1.push({ id: 'u_long_1', ts: Date.now(), chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot 跑个长任务' });
    await until(() => b1.inFlightTurns.size === 1);
    assert.equal(t1.sent.length, 0);
    await b1.stop();

    // 2. 重启 b2 后自动续接在途任务并补发终稿
    completeNow = true;
    const t2 = makeTransport();
    const events2 = [];
    const b2 = new OpenMausBotBridge({
      client: m1.client,
      transport: t2.transport,
      dataDir: tmpDir,
      turnStallMs: 0,
      onTelemetry: (ev) => events2.push(ev),
    });
    await b2.start();
    await until(() => t2.sent.some((m) => m.text.includes('后台长任务执行完成')));
    assert.equal(b2.inFlightTurns.size, 0, '交付完成后应清理在途任务记录');
    assert.ok(events2.some((e) => e.type === 'turn_resumed'));
    await b2.stop();

    // 3. 再次重启 b3 不应重复补发
    const t3 = makeTransport();
    const b3 = new OpenMausBotBridge({ client: m1.client, transport: t3.transport, dataDir: tmpDir, turnStallMs: 0 });
    await b3.start();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(t3.sent.length, 0);
    await b3.stop();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Resilience A2+A3: corrupt bridge-state recovery, disconnect outbound buffer replay, and failed telemetry', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-res-buf-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'bridge-state.json'), '{not-valid-json', 'utf8');
    const tr = makeTransport();
    const mc = makeMockClient();
    const tele = [];
    const bridge = new OpenMausBotBridge({
      client: mc.client,
      transport: tr.transport,
      dataDir: tmpDir,
      turnStallMs: 0,
      sendRetries: 0,
      stateSaveDebounceMs: 50,
      onTelemetry: (ev) => tele.push(ev),
    });

    assert.equal(bridge.stateCorruptRecoveries, 1);
    assert.ok(tele.some((e) => e.type === 'state_corrupt'));
    assert.ok(fs.readdirSync(tmpDir).some((f) => f.startsWith('bridge-state.json.corrupt.')), '损坏状态文件应自动备份');

    await bridge.start();

    // 断线期间写入按序缓冲，恢复连接后按 FIFO 重放
    tr.setConnected(false);
    const id1 = await bridge.say('第一条断线消息');
    const id2 = await bridge.say('第二条断线消息');
    assert.equal(id1, null);
    assert.equal(id2, null);
    assert.equal(bridge.status().outboundBuffered, 2);
    assert.ok(tele.some((e) => e.type === 'outbound_buffered'));

    tr.setConnected(true);
    const replayed = await bridge.flushOutboundBuffer();
    assert.equal(replayed, 2);
    assert.equal(bridge.status().outboundBuffered, 0);
    assert.equal(bridge.status().outboundReplayed, 2);
    assert.equal(tr.sent.length, 2);
    assert.match(tr.sent[0].text, /第一条断线消息/);
    assert.match(tr.sent[1].text, /第二条断线消息/);
    assert.ok(tele.some((e) => e.type === 'outbound_replayed'));

    // 发送抛错（非断线态，sendRetries=0）计入 outboundFailures 并上报 outbound_failed
    tr.transport.send = async () => { throw new Error('rate limit'); };
    const failId = await bridge.say('会失败的消息');
    assert.equal(failId, null);
    assert.equal(bridge.status().outboundFailures, 1);
    assert.ok(tele.some((e) => e.type === 'outbound_failed'));

    // stop() 前 flushState 落盘合法 JSON
    await bridge.stop();
    const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, 'bridge-state.json'), 'utf8'));
    assert.equal(saved.selfChatId, 'chat_self');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Resilience A4: stall watchdog alerts once on idle turn and stays quiet on needs-input', async () => {
  const tr = makeTransport();
  let fakeNow = 10_000;
  let jobState = 'needs-input';
  const tele = [];
  const mc = makeMockClient({
    async getJob(_tid, { signal }) {
      if (jobState === 'needs-input') {
        await new Promise((r) => setTimeout(r, 15));
        return { state: 'needs-input', version: 'v1' };
      }
      await new Promise((r) => {
        if (signal?.aborted) return r();
        signal?.addEventListener('abort', r, { once: true });
      });
      return { state: jobState, version: 'v1' };
    },
    async getMessages() { return { messages: [] }; },
  });
  const bridge = new OpenMausBotBridge({
    client: mc.client,
    transport: tr.transport,
    turnStallMs: 60,
    now: () => fakeNow,
    onTelemetry: (ev) => tele.push(ev),
  });
  await bridge.start();
  // needs-input 状态不应误报卡死
  await tr.push({ id: 'u_stall_1', ts: fakeNow, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot 深度分析' });
  await until(() => mc.sentPrompts.length === 1);
  await new Promise((r) => setTimeout(r, 30));
  fakeNow += 120;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(tele.some((e) => e.type === 'turn_stalled'), false);

  // 从新建一轮并保持 running 超阈值 -> 仅提示一次，带 stop 按钮
  await tr.push({ id: 'u_stop', ts: fakeNow, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot stop' });
  jobState = 'running';
  await tr.push({ id: 'u_stall_2', ts: fakeNow, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot 再跑一次' });
  fakeNow += 120;
  await until(() => tele.some((e) => e.type === 'turn_stalled'));
  const stallMsg = tr.sent.find((m) => m.text.includes('持续无新进展'));
  assert.ok(stallMsg);
  assert.ok(stallMsg.actions?.some((a) => a.text.includes('stop')));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(tele.filter((e) => e.type === 'turn_stalled').length, 1, '同一静默期只提醒一次');
  await bridge.stop();
});

test('Usability B1+B2: validateConfig catches typos/bad values and scripts/setup.js scaffolds clean config', async () => {
  const bad = validateConfig({
    web: { port: 70000 },
    openmausbot: { url: 'ftp://invalid' },
    selfChat: { quietHour: { enabled: true }, quietHours: { start: '25:99' }, turnStallMs: -5 },
    chats: { mode: 'bad_mode', autoCompactThreshold: 0.2, externalSanitizeMentions: 'invalid' },
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.warnings.some((w) => w.includes('selfChat.quietHours')));
  assert.ok(bad.errors.some((e) => e.includes('web.port')));
  assert.ok(bad.errors.some((e) => e.includes('openmausbot.url')));
  assert.ok(bad.errors.some((e) => e.includes('quietHours.start')));
  assert.ok(bad.errors.some((e) => e.includes('turnStallMs')));
  assert.ok(bad.errors.some((e) => e.includes('chats.mode')));
  assert.ok(bad.errors.some((e) => e.includes('autoCompactThreshold')));
});

test('Usability B3: /api/debug/bundle redacts secrets and POST /api/debug/action manages chat policies', async () => {
  const ombServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('content-type', 'application/json');
    if (u.pathname === '/api/health') return res.end(JSON.stringify({ ok: true, version: '0.1.173', box: 'off' }));
    if (u.pathname === '/api/environment') return res.end(JSON.stringify({ capabilities: {} }));
    if (u.pathname === '/api/auth/session') return res.end(JSON.stringify({ kind: 'none' }));
    if (u.pathname === '/api/bots') return res.end(JSON.stringify({ bots: [{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }], groups: [] }));
    if (u.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"kind":"hello"}\n\n');
      req.on('close', () => res.end());
      return;
    }
    res.end('{}');
  });
  await new Promise((r) => ombServer.listen(0, '127.0.0.1', r));
  const ombPort = ombServer.address().port;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-dbg-act-'));

  let pushInbound = null;
  const chanPlugin = defineChannelPlugin({
    name: 'mock-ops',
    capabilities: { markdown: true, files: false },
    create() {
      return {
        async start(onMsg) { pushInbound = onMsg; },
        async send() { return 'out_1'; },
        async stop() {},
      };
    },
  });

  const cfg = {
    openmausbot: { url: `http://127.0.0.1:${ombPort}`, timeoutMs: 3000, token: 'omb_sess_top_secret_999', autoStart: false },
    transport: 'sim',
    channel: { use: 'mock-ops', options: {} },
    ipc: { selfId: 'u_secret_self_id', selfChatId: 'chat_self' },
    web: { host: '127.0.0.1', port: 0 },
    selfChat: { trigger: '@bot', fileRetentionDays: 0 },
    chats: { mode: 'owner_everywhere' },
    dataDir,
  };

  const kernel = new Kernel({ config: cfg });
  kernel.use(webPlugin);
  kernel.use(chanPlugin, { selfId: 'u_me', selfChatId: 'chat_self' });
  kernel.use(openmausbotPlugin, { autoHealOmb: null });
  kernel.use(inspectorPlugin);

  try {
    await kernel.start();
    const port = kernel.get('web').server.address().port;
    pushInbound({ id: 'ext_1', ts: Date.now(), chat: { id: 'grp_ops', type: 'group', name: '运维群' }, sender: { id: 'colleague', isSelf: false }, text: 'hi' });
    await new Promise((r) => setTimeout(r, 30));

    // 1. /api/debug/bundle?download=1 脱敏导出
    const bundleResp = await fetch(`http://127.0.0.1:${port}/api/debug/bundle?download=1`);
    assert.equal(bundleResp.status, 200);
    assert.match(bundleResp.headers.get('content-disposition') || '', /attachment; filename="co-bot-diag-/);
    const bundle = await bundleResp.json();
    assert.equal(bundle.sanitizedConfig.openmausbot.token, '[REDACTED]');
    assert.equal(bundle.sanitizedConfig.ipc.selfId, '[REDACTED]');
    assert.ok(bundle.runtime.memoryRssMB > 0);
    assert.ok(Array.isArray(bundle.events));

    // 2. POST /api/debug/action 动态静音群并反映到 /api/status
    const act1 = await fetch(`http://127.0.0.1:${port}/api/debug/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'chat_mute', chatId: 'grp_ops' }),
    }).then((r) => r.json());
    assert.equal(act1.ok, true);
    assert.ok(act1.chatPolicy.muted.includes('grp_ops'));

    const st = await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => r.json());
    assert.ok(st.runtime?.pid > 0);
    assert.ok(st.chatPolicy.muted.includes('grp_ops'));
  } finally {
    await kernel.stop();
    ombServer.closeAllConnections?.();
    await new Promise((r) => ombServer.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('UX C1+C2+C3: concise help, persistent privateDraft polish & externalAckInSelf', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-ux-polish-'));
  try {
    const fakeBridge = { trigger: '@bot', followUpWindowMs: 120_000 };
    const help = buildHelpText(fakeBridge);
    assert.match(help, /chats[\s\S]*mute\|unmute[\s\S]*summary[\s\S]*new[\s\S]*task[\s\S]*compact[\s\S]*status/);
    assert.doesNotMatch(help, /schedule|routines|@bot model|export|style cobot|@bot bots|@bot tasks|@bot context|@bot memory|@bot approval|@bot digest|steer|cancel/);

    // 2. Live bridge flow: externalAckInSelf + persistent privateDraft polish + sendback
    let replySeq = 0;
    const threadMsgs = new Map();
    const tr1 = makeTransport();
    const mc = makeMockClient({
      onSendMessage(payload) {
        replySeq += 1;
        const reqId = `u_${replySeq}`;
        const reply = payload.text.includes('帮我起草回复')
          ? '请 @Alice 尽快扩容数据库连接池并排查 502 超时原因。'
          : (payload.text.includes('[待润色草稿') ? '@Alice 麻烦看下 502，建议先扩连接池。' : `已处理：${payload.text}`);
        threadMsgs.set(payload.threadId, [
          { id: reqId, role: 'user', sendId: payload.sendId },
          { id: `b_${replySeq}`, role: 'bot', requestMessageId: reqId, kind: 'text', turnTerminal: true, text: reply },
        ]);
        return { ok: true, threadId: payload.threadId, message: { id: reqId, role: 'user', sendId: payload.sendId } };
      },
      async getMessages(tid) {
        return { messages: threadMsgs.get(tid) ?? [] };
      },
    });
    const b1 = new OpenMausBotBridge({
      client: mc.client,
      transport: tr1.transport,
      dataDir: tmpDir,
      turnStallMs: 0,
      chats: { externalAckInSelf: true },
    });
    await b1.start();

    // Normal English `@bot hello` 透传到 OpenMausBot，不被误拦截
    await tr1.push({ id: 'ux_hi', ts: Date.now(), chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot hello' });
    await until(() => tr1.sent.some((m) => m.text.includes('建议先扩连接池') || m.text.includes('已处理')));
    const hiCount = mc.sentPrompts.length;
    assert.equal(hiCount, 1);
    assert.equal(mc.sentPrompts[0].text, 'hello');

    // 外部群发起 `@bot!` 私密起草，且因 externalAckInSelf=true 自聊收到轻量提示
    await tr1.push({ id: 'grp_m1', ts: Date.now(), chat: { id: 'grp_arch', type: 'group', name: '架构群' }, sender: { id: 'alice', name: 'Alice', isSelf: false }, text: '线上 502 报警' });
    await tr1.push({ id: 'grp_req', ts: Date.now() + 1, chat: { id: 'grp_arch', type: 'group', name: '架构群' }, sender: { id: 'me', isSelf: true }, replyTo: 'grp_m1', text: '@bot! 帮我起草回复' });
    await until(() => tr1.sent.some((m) => m.text.includes('私密回复') && m.text.includes('架构群')));
    assert.ok(tr1.sent.some((m) => m.chatId === 'chat_self' && m.text.includes('已收到来自「架构群」的提问')));
    const draftBubbleV1 = tr1.sent.find((m) => m.text.includes('私密回复'));
    assert.equal(b1.status().privateDraftsCount, 1);

    // 重启 bridge：验证 privateDrafts 持久化不丢失
    await b1.stop();
    const tr2 = makeTransport();
    const b2 = new OpenMausBotBridge({ client: mc.client, transport: tr2.transport, dataDir: tmpDir, turnStallMs: 0 });
    await b2.start();
    assert.equal(b2.status().privateDraftsCount, 1);

    // 在自聊直接引用 v1 草稿让 Bot 润色更简洁 -> 生成 v2 草稿并继承原群路由与 sendback 按钮
    await tr2.push({
      id: 'self_polish',
      ts: Date.now() + 100,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', isSelf: true },
      replyTo: draftBubbleV1.id,
      text: '改得更短一点',
    });
    await until(() => tr2.sent.some((m) => m.text.includes('建议先扩连接池')));
    const polishPrompt = mc.sentPrompts.at(-1).text;
    assert.match(polishPrompt, /\[待润色草稿 · 原目标会话「架构群」\]/);
    const draftBubbleV2 = tr2.sent.find((m) => m.text.includes('建议先扩连接池'));
    assert.ok(draftBubbleV2.actions?.some((a) => a.label.includes('发回「架构群」')));

    // 对 v2 发 `@bot sendback` -> `确认发送` -> 自动防误艾特且引用 grp_m1 发回架构群
    await tr2.push({
      id: 'self_sb',
      ts: Date.now() + 200,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', isSelf: true },
      replyTo: draftBubbleV2.id,
      text: '@bot sendback',
    });
    assert.ok(tr2.sent.some((m) => m.text.includes('确认发回到「架构群」')));
    await tr2.push({
      id: 'self_sb_confirm',
      ts: Date.now() + 300,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', isSelf: true },
      text: '确认发送',
    });
    const backInGroup = tr2.sent.find((m) => m.chatId === 'grp_arch');
    assert.ok(backInGroup, '润色后的草稿应确认发回原群');
    assert.equal(backInGroup.replyTo, 'grp_m1');
    assert.match(backInGroup.text, /@\u200BAlice/);
    await b2.stop();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
