import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { validateConfig } from '../src/config.ts';
import { Kernel } from '../src/core/kernel.ts';
import { scanAndRedactOutbound } from '../src/core/security.ts';
import { defineChannelPlugin } from '../src/core/channel-contract.ts';
import { OpenMausBotBridge } from '../src/openmausbot/bridge.ts';
import type { OpenMausBotClient } from '../src/openmausbot/client.ts';
import { buildHelpHtml, buildHelpText } from '../src/openmausbot/commands.ts';
import type { BridgeTransport, OmbMessage } from '../src/openmausbot/types.ts';
import { openmausbotPlugin } from '../src/plugins/openmausbot.ts';
import { inspectorPlugin } from '../src/plugins/inspector.ts';
import { webPlugin } from '../src/plugins/web.ts';
import type { ChannelSendOptions, InboundEvent, RawConfig, TelemetryEvent } from '../src/types.ts';
import type { WebServer } from '../src/web/server.ts';

const until = (fn: () => boolean, ms = 3000): Promise<void> => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const check = () => {
    if (fn()) return resolve();
    if (Date.now() - t0 > ms) return reject(new Error('timeout waiting condition'));
    setTimeout(check, 15);
  };
  check();
});

function makeTransport() {
  const sent: Array<{ id: string; chatId: string; text: string } & ChannelSendOptions> = [];
  let connected = true;
  let onMsg: ((ev: InboundEvent) => unknown) | null = null;
  let seq = 0;
  const transport: BridgeTransport = {
    selfChatId: 'chat_self',
    canFiles: true,
    capabilities: { markdown: true, files: true, images: true, replyTo: true, actions: true, history: true, maxChars: 0, multiDevice: true },
    status() { return { kind: 'mock', connected, selfChatId: 'chat_self' }; },
    async start(cb) { onMsg = cb; },
    async stop() {},
    async send(chatId: string, text: string, opts: ChannelSendOptions = {}) {
      if (!connected) throw new Error('transport offline');
      const id = `im_${++seq}`;
      sent.push({ id, chatId, text, ...opts });
      return id;
    },
    async sendFile(chatId: string, { name }: { name: string }, opts: ChannelSendOptions = {}) {
      const id = `imf_${++seq}`;
      sent.push({ id, chatId, text: `[file:${name}]`, ...opts });
      return id;
    },
  };
  return {
    sent,
    setConnected(v: boolean) { connected = Boolean(v); },
    async push(ev: InboundEvent) { await onMsg?.(ev); },
    transport,
  };
}

interface MakeMockClientOpts {
  onSendMessage?: (payload: { threadId: string; text: string; sendId?: string }) => unknown;
  getJob?: (threadId: string, opts: { signal?: AbortSignal }, registerWaiter: (fn: () => void) => void) => Promise<unknown>;
  getMessages?: (threadId: string, limit?: number) => Promise<{ messages: OmbMessage[] }>;
}

function makeMockClient({ onSendMessage, getJob: customGetJob, getMessages: customGetMessages }: MakeMockClientOpts = {}) {
  const sentPrompts: Array<Record<string, unknown>> = [];
  const ssePushers: Array<(evt: unknown) => void> = [];
  const jobWaiters: Array<() => void> = [];
  const client = {
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
    async sendMessage(botId: string, payload: { threadId: string; text: string; sendId?: string }) {
      sentPrompts.push({ botId, ...payload });
      if (onSendMessage) return onSendMessage(payload);
      return { ok: true, threadId: payload.threadId, message: { id: `req_${sentPrompts.length}`, role: 'user', sendId: payload.sendId } };
    },
    async getJob(threadId: string, opts: { signal?: AbortSignal }) {
      if (customGetJob) return customGetJob(threadId, opts, (fn) => jobWaiters.push(fn));
      return { state: 'completed', version: 'v1' };
    },
    async getMessages(threadId: string, limit?: number) {
      if (customGetMessages) return customGetMessages(threadId, limit);
      return { messages: [] };
    },
    async subscribeEvents(cb: (evt: unknown) => Promise<void> | void, { signal }: { signal?: AbortSignal }) {
      ssePushers.push(cb);
      await cb({ kind: 'hello', cursor: '1' });
      await new Promise<void>((r) => {
        if (signal?.aborted) return r();
        signal?.addEventListener('abort', () => r(), { once: true });
      });
    },
    async interrupt() {},
  } as unknown as OpenMausBotClient;

  return {
    sentPrompts,
    pushSse(evt: unknown) { for (const cb of ssePushers) cb(evt); },
    releaseJobs() {
      for (const w of jobWaiters.splice(0)) w();
    },
    client,
  };
}

test('Resilience A1: inFlightTurns survives restart and delivers final reply exactly once', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-res-turn-'));
  try {
    const t1 = makeTransport();
    let completeNow = false;
    const m1 = makeMockClient({
      onSendMessage(payload) {
        return { ok: true, threadId: payload.threadId, message: { id: 'req_long_1', role: 'user', sendId: payload.sendId } };
      },
      async getJob(_tid, { signal }) {
        if (completeNow) return { state: 'completed', version: 'v2' };
        await new Promise<void>((r) => {
          if (signal?.aborted) return r();
          signal?.addEventListener('abort', () => r(), { once: true });
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

    completeNow = true;
    const t2 = makeTransport();
    const events2: TelemetryEvent[] = [];
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
    const tele: TelemetryEvent[] = [];
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

    tr.transport.send = async () => { throw new Error('rate limit'); };
    const failId = await bridge.say('会失败的消息');
    assert.equal(failId, null);
    assert.equal(bridge.status().outboundFailures, 1);
    assert.ok(tele.some((e) => e.type === 'outbound_failed'));

    await bridge.stop();
    const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, 'bridge-state.json'), 'utf8')) as { selfChatId: string };
    assert.equal(saved.selfChatId, 'chat_self');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Resilience A4: stall watchdog alerts once on idle turn and stays quiet on needs-input', async () => {
  const tr = makeTransport();
  let fakeNow = 10_000;
  let jobState = 'needs-input';
  const tele: TelemetryEvent[] = [];
  const mc = makeMockClient({
    async getJob(_tid, { signal }) {
      if (jobState === 'needs-input') {
        await new Promise((r) => setTimeout(r, 15));
        return { state: 'needs-input', version: 'v1' };
      }
      await new Promise<void>((r) => {
        if (signal?.aborted) return r();
        signal?.addEventListener('abort', () => r(), { once: true });
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
  await tr.push({ id: 'u_stall_1', ts: fakeNow, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot 深度分析' });
  await until(() => mc.sentPrompts.length === 1);
  await new Promise((r) => setTimeout(r, 30));
  fakeNow += 120;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(tele.some((e) => e.type === 'turn_stalled'), false);

  await tr.push({ id: 'u_stop', ts: fakeNow, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot stop' });
  jobState = 'running';
  await tr.push({ id: 'u_stall_2', ts: fakeNow, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot 再跑一次' });
  fakeNow += 120;
  await until(() => tele.some((e) => e.type === 'turn_stalled'));
  const stallMsg = tr.sent.find((m) => m.text.includes('持续无新进展'))!;
  assert.ok(stallMsg);
  assert.match(stallMsg.text, /@bot stop/);
  assert.equal(stallMsg.actions?.length ?? 0, 0);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(tele.filter((e) => e.type === 'turn_stalled').length, 1, '同一静默期只提醒一次');
  await bridge.stop();
});

test('Usability B1+B2: validateConfig catches typos and invalid config values', async () => {
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
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
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
  await new Promise<void>((r) => ombServer.listen(0, '127.0.0.1', r));
  const ombPort = (ombServer.address() as AddressInfo).port;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-dbg-act-'));

  let pushInbound: ((rawMsg: unknown) => void) | null = null;
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

  const cfg: RawConfig = {
    openmausbot: { url: `http://127.0.0.1:${ombPort}`, timeoutMs: 3000, token: 'omb_sess_top_secret_999', autoStart: false },
    channel: { use: 'mock-ops', options: { selfId: 'u_secret_self_id', selfChatId: 'chat_self' } },
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
    const { port } = kernel.get<WebServer>('web').server!.address() as AddressInfo;
    pushInbound!({ id: 'ext_1', ts: Date.now(), chat: { id: 'grp_ops', type: 'group', name: '运维群' }, sender: { id: 'colleague', isSelf: false }, text: 'hi' });
    await new Promise((r) => setTimeout(r, 30));

    const bundleResp = await fetch(`http://127.0.0.1:${port}/api/debug/bundle?download=1`);
    assert.equal(bundleResp.status, 200);
    assert.match(bundleResp.headers.get('content-disposition') || '', /attachment; filename="co-bot-diag-/);
    const bundle = await bundleResp.json() as {
      sanitizedConfig: { openmausbot: { token: string }; channel: { options: { selfId: string } } };
      runtime: { memoryRssMB: number };
      events: unknown[];
    };
    assert.equal(bundle.sanitizedConfig.openmausbot.token, '[REDACTED]');
    assert.equal(bundle.sanitizedConfig.channel.options.selfId, '[REDACTED]');
    assert.ok(bundle.runtime.memoryRssMB > 0);
    assert.ok(Array.isArray(bundle.events));

    const act1 = await fetch(`http://127.0.0.1:${port}/api/debug/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'chat_mute', chatId: 'grp_ops' }),
    }).then((r) => r.json()) as { ok: boolean; chatPolicy: { muted: string[] } };
    assert.equal(act1.ok, true);
    assert.ok(act1.chatPolicy.muted.includes('grp_ops'));

    const st = await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => r.json()) as {
      runtime?: { pid: number };
      chatPolicy: { muted: string[] };
    };
    assert.ok(st.runtime!.pid > 0);
    assert.ok(st.chatPolicy.muted.includes('grp_ops'));
  } finally {
    await kernel.stop();
    ombServer.closeAllConnections?.();
    await new Promise<void>((r) => ombServer.close(() => r()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('UX C1+C2+C3: concise help, persistent privateDraft polish & externalAckInSelf', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-ux-polish-'));
  try {
    const fakeBridge = { trigger: '@bot', botName: 'co-bot', followUpWindowMs: 120_000 } as OpenMausBotBridge;
    const help = buildHelpText(fakeBridge);
    assert.match(help, /通用（`@bot` \/ `@Bot名` \/ `@群名`）[\s\S]*new[\s\S]*task[\s\S]*stop[\s\S]*status \[群\][\s\S]*compact \[群\][\s\S]*bye/);
    assert.match(help, /仅 `@bot` 可用[\s\S]*sendback[\s\S]*chats[\s\S]*mute\|unmute[\s\S]*summary[\s\S]*bind[\s\S]*delegate/);
    assert.match(help, /`@bot help`/);
    assert.doesNotMatch(help, /schedule|routines|@bot model|export|style cobot|@bot bots|@bot tasks|@bot context|@bot memory|@bot approval|@bot digest|steer|cancel/);

    const html = buildHelpHtml(fakeBridge);
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /<svg\b/);
    assert.match(html, /多人协作的 IM 智能体工作区/);
    assert.match(html, /常用指令速查/);
    assert.match(html, /id="theme-toggle"/);
    assert.match(html, /for="theme-toggle"/);
    assert.match(html, /#theme-toggle:checked/);
    assert.match(html, /#f7f6f2/);
    for (const banned of [
      '<script',
      'OpenMausBot',
      'MausBot',
      'opencode',
      '手机端 IM',
      'sharedContextDir',
      'context_pull',
      'cobot:req',
      '/burst',
      'SSE',
      '零宽空格',
      'Coordinator Bot',
    ]) {
      assert.equal(html.includes(banned), false, `HTML 帮助不应暴露内部细节「${banned}」`);
    }
    assert.equal(scanAndRedactOutbound(html).redacted, false, 'HTML 帮助不应误触发安全脱敏规则');

    const escapedHtml = buildHelpHtml({
      trigger: '@my<bot>&"',
      botName: 'X<Bot>"&',
      followUpWindowMs: 90_000,
      commandRegistry: {
        list: () => [{ name: 'ping<1>', description: '测"试&<脚本>' }],
      },
    } as unknown as OpenMausBotBridge);
    assert.match(escapedHtml, /X&lt;Bot&gt;&quot;&amp;/);
    assert.match(escapedHtml, /@my&lt;bot&gt;&amp;&quot; ping&lt;1&gt;/);
    assert.match(escapedHtml, /测&quot;试&amp;&lt;脚本&gt;/);
    assert.equal(escapedHtml.includes('<1>'), false);

    let replySeq = 0;
    const threadMsgs = new Map<string, OmbMessage[]>();
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

    await tr1.push({ id: 'ux_hi', ts: Date.now(), chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot hello' });
    await until(() => tr1.sent.some((m) => m.text.includes('建议先扩连接池') || m.text.includes('已处理')));
    const hiCount = mc.sentPrompts.length;
    assert.equal(hiCount, 1);
    assert.equal(mc.sentPrompts[0].text, 'hello');

    await tr1.push({ id: 'grp_m1', ts: Date.now(), chat: { id: 'grp_arch', type: 'group', name: '架构群' }, sender: { id: 'alice', name: 'Alice', isSelf: false }, text: '线上 502 报警' });
    await tr1.push({ id: 'grp_req', ts: Date.now() + 1, chat: { id: 'grp_arch', type: 'group', name: '架构群' }, sender: { id: 'me', isSelf: true }, replyTo: 'grp_m1', text: '@bot! 帮我起草回复' });
    await until(() => tr1.sent.some((m) => m.text.includes('私密回复') && m.text.includes('架构群')));
    assert.ok(tr1.sent.some((m) => m.chatId === 'chat_self' && m.text.includes('已收到来自「架构群」的提问')));
    const draftBubbleV1 = tr1.sent.find((m) => m.text.includes('私密回复'))!;
    assert.equal(b1.status().privateDraftsCount, 1);

    await b1.stop();
    const tr2 = makeTransport();
    const b2 = new OpenMausBotBridge({ client: mc.client, transport: tr2.transport, dataDir: tmpDir, turnStallMs: 0 });
    await b2.start();
    assert.equal(b2.status().privateDraftsCount, 1);

    await tr2.push({
      id: 'self_polish',
      ts: Date.now() + 100,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', isSelf: true },
      replyTo: draftBubbleV1.id,
      text: '改得更短一点',
    });
    await until(() => tr2.sent.some((m) => m.text.includes('建议先扩连接池')));
    const polishPrompt = String(mc.sentPrompts.at(-1)!.text);
    assert.match(polishPrompt, /\[待润色草稿 · 原目标会话「架构群」\]/);
    const draftBubbleV2 = tr2.sent.find((m) => m.text.includes('建议先扩连接池'))!;
    assert.match(draftBubbleV2.text, /@bot sendback draft_/);
    assert.match(draftBubbleV2.text, /发回「架构群」/);
    assert.deepEqual(draftBubbleV2.actions?.map((a) => a.label), ['发回原群', '忽略']);

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
    const backInGroup = tr2.sent.find((m) => m.chatId === 'grp_arch')!;
    assert.ok(backInGroup, '润色后的草稿应确认发回原群');
    assert.equal(backInGroup.replyTo, 'grp_m1');
    assert.match(backInGroup.text, /@\u200BAlice/);
    await b2.stop();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('@bot help falls back to plain text when transport disables files', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-help-fallback-'));
  try {
    const tr = makeTransport();
    tr.transport.canFiles = false;
    tr.transport.capabilities = { ...tr.transport.capabilities!, files: false };
    const mc = makeMockClient();
    const bridge = new OpenMausBotBridge({
      client: mc.client,
      transport: tr.transport,
      dataDir: tmpDir,
      turnStallMs: 0,
    });
    await bridge.start();
    await tr.push({
      id: 'help_no_file',
      ts: Date.now(),
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', isSelf: true },
      text: '@bot help',
    });
    await until(() => tr.sent.some((m) => m.text.includes('常用指南') && m.text.includes('@bot help')));
    assert.equal(tr.sent.some((m) => m.text.startsWith('[file:')), false);
    assert.equal(mc.sentPrompts.length, 0);
    await bridge.stop();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
