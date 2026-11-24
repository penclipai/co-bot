import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Kernel } from '../src/core/kernel.js';
import {
  clipSummary,
  defineChannelPlugin,
  normalizeInboundEvent,
  validateChannelAdapter,
  validateInboundEvent,
} from '../src/core/channel-contract.js';
import { webPlugin } from '../src/plugins/web.js';
import { openmausbotPlugin } from '../src/plugins/openmausbot.js';
import { inspectorPlugin } from '../src/plugins/inspector.js';
import { loadChannelPlugin } from '../src/plugins/channel-loader.js';
import { OpenMausBotBridge } from '../src/openmausbot/bridge.js';
import { runChannelContractTest } from '../scripts/channel-test.js';
import { APP_ROOT } from '../src/config.js';

async function getFreePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

const until = async (fn, ms = 4000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail('timeout waiting for condition');
};

test('Kernel: resolves topological provides/inject, rolls back on startup failure, reverses effects on stop, and isolates bus errors', async () => {
  const trace = [];
  const k1 = new Kernel({ logger: { warn() {} } });

  // 故意逆序注册（consumer 在 provider 之前），测试拓扑排序
  k1.use({
    name: 'consumer',
    inject: ['db'],
    provides: ['api'],
    apply(ctx) {
      trace.push(`mount:consumer(db=${ctx.get('db')})`);
      ctx.provide('api', 'v1');
      ctx.on('ping', (x) => trace.push(`ok:${x}`));
      ctx.on('ping', () => { throw new Error('listener boom'); });
      ctx.effect(() => trace.push('dispose:consumer'));
    },
  });
  k1.use({
    name: 'db',
    provides: ['db'],
    apply(ctx) {
      trace.push('mount:db');
      ctx.provide('db', 'sqlite');
      ctx.effect(() => trace.push('dispose:db'));
    },
  });

  await k1.start();
  assert.deepEqual(trace.slice(0, 2), ['mount:db', 'mount:consumer(db=sqlite)']);
  k1.emit('ping', 'hello');
  assert.ok(trace.includes('ok:hello'));

  await k1.stop();
  assert.deepEqual(trace.slice(-2), ['dispose:consumer', 'dispose:db'], 'stop() 应按挂载逆序回收副作用');
  assert.equal(k1.has('db'), false);
  assert.equal(k1.has('api'), false);

  // 缺少依赖服务时报错
  const kMissing = new Kernel();
  kMissing.use({ name: 'orphan', inject: ['missingSvc'], apply() {} });
  await assert.rejects(() => kMissing.start(), /缺少依赖服务：missingSvc/);

  // 第二个插件启动失败时自动回滚已挂载插件的 effect
  const rolledBack = [];
  const kFail = new Kernel();
  kFail.use({
    name: 'first',
    provides: ['a'],
    apply(ctx) {
      ctx.provide('a', 1);
      ctx.effect(() => rolledBack.push('first'));
    },
  });
  kFail.use({
    name: 'second',
    inject: ['a'],
    apply() { throw new Error('init failed'); },
  });
  await assert.rejects(() => kFail.start(), /init failed/);
  assert.deepEqual(rolledBack, ['first']);
  assert.equal(kFail.has('a'), false);

  // provides 契约校验：声明 provides 但未调用 ctx.provide 时立即失败并回滚
  const kMissingProvide = new Kernel();
  kMissingProvide.use({
    name: 'bad-provider',
    provides: ['promisedSvc'],
    apply() {},
  });
  await assert.rejects(() => kMissingProvide.start(), /未调用 ctx\.provide/);
});

test('channel-contract: normalizeInboundEvent, ManagedChannel reconnect & selfChatId learning, and validateChannelAdapter', async () => {
  const flatEv = normalizeInboundEvent({
    msgId: 'm1',
    chatId: 'c_self',
    chatType: 'self',
    fromId: 'u_me',
    fromName: 'Jack',
    fromDevice: { id: 'd1', type: 'mobile', name: 'Phone' },
    text: '@bot status',
  }, { selfId: 'u_me' });
  assert.equal(flatEv.sender.isSelf, true);
  assert.equal(flatEv.chat.type, 'self');

  const stdEv = normalizeInboundEvent({
    id: 'm2',
    chat: { id: 'c_direct', type: 'direct' },
    sender: { id: 'u_me', isSelf: true },
    text: 'hi',
  });
  assert.equal(stdEv.id, 'm2');
  assert.equal('kind' in stdEv, false);
  assert.equal('mentions' in stdEv, false);

  // B1: 标准/扁平 recall 事件与结构化 mentions 归一化
  const recallFlat = normalizeInboundEvent({
    kind: 'recall',
    chatId: 'grp_dev',
    chatType: 'group',
    fromId: 'alice',
    fromName: 'Alice',
    recalledMsgId: 'm_old_1',
  }, { selfId: 'u_me' });
  assert.equal(recallFlat.kind, 'recall');
  assert.equal(recallFlat.recalledMsgId, 'm_old_1');
  assert.equal(validateInboundEvent(recallFlat).ok, true);

  const mentionedEv = normalizeInboundEvent({
    id: 'm3',
    chat: { id: 'grp_dev', type: 'group' },
    sender: { id: 'alice', isSelf: false },
    text: '帮看下',
    mentions: [{ id: 'u_me', name: 'Me' }, { id: 'bob', name: 'Bob' }],
  }, { selfId: 'u_me' });
  assert.equal(mentionedEv.mentionsMe, true);
  assert.equal(mentionedEv.mentions.length, 2);
  assert.equal(mentionedEv.mentions[0].isSelf, true);

  const badCheck = validateChannelAdapter({ start() {}, capabilities: { files: true } });
  assert.equal(badCheck.ok, false);
  assert.ok(badCheck.errors.some((e) => e.includes('send')));
  assert.ok(badCheck.errors.some((e) => e.includes('stop')));

  // ManagedChannel: 指数重连（含 stop 时同步发出 onDisconnect 防重入）+ static status 不掩盖离线 + 脱敏
  let connectCount = 0;
  let emitFn = null;
  let disconnectFn = null;
  let stopEmitLoops = 0;
  const telemetry = [];
  const plugin = defineChannelPlugin({
    name: 'mock-managed',
    capabilities: { markdown: false, files: false, actions: false, maxChars: 120 },
    create() {
      return {
        status() { return { connected: true }; },
        async start(onMsg, ctx) {
          connectCount += 1;
          emitFn = onMsg;
          disconnectFn = ctx.onDisconnect;
          if (connectCount === 2) throw new Error('flaky');
        },
        async send() { return 'out_1'; },
        async stop() {
          // 模拟某些 SDK 在关闭旧连接时同步发出 close -> onDisconnect
          if (stopEmitLoops < 2) {
            stopEmitLoops += 1;
            disconnectFn?.(new Error('closing old socket'));
          }
        },
      };
    },
    reconnectDelayMs: 20,
    maxReconnectDelayMs: 60,
  });

  const k = new Kernel({ config: {}, logger: { warn() {}, error() {} } });
  k.on('channel:inbound', (d) => telemetry.push({ t: 'in', ...d }));
  k.on('channel:outbound', (d) => telemetry.push({ t: 'out', ...d }));
  k.on('channel:state', (d) => telemetry.push({ t: 'st', ...d }));
  k.use(plugin, { selfId: 'u_me' });
  await k.start();

  const ch = k.get('channel');
  const received = [];
  await ch.start((ev) => received.push(ev));

  // 畸形消息跳过不崩溃
  emitFn({ invalid: true });
  assert.equal(received.length, 0);

  // 正常自聊消息触发 selfChatId 学习与入站脱敏遥测
  emitFn({ msgId: 'x1', chatId: 'room_self', chatType: 'self', fromId: 'u_me', text: 'token=omb_sess_secret1234 Bearer mytok99' });
  assert.equal(ch.selfChatId, 'room_self');
  assert.equal(received.length, 1);
  assert.match(clipSummary('omb_sess_abc123 sk-abcdefghijklmnop Bearer xyz999'), /\[REDACTED\].*\[REDACTED\].*Bearer \[REDACTED\]/);

  await ch.send('room_self', 'reply');
  assert.ok(telemetry.some((x) => x.t === 'in' && x.msgId === 'x1' && !x.summary.includes('omb_sess_secret1234')));
  assert.ok(telemetry.some((x) => x.t === 'out' && x.msgId === 'out_1'));

  disconnectFn(new Error('drop'));
  assert.equal(ch.status().connected, false, '即使适配器静态返回 connected:true，断线期间状态必须反映重连中');
  await until(() => ch.status().connected === true);
  assert.ok(connectCount >= 3);
  await k.stop();
});

test('loadChannelPlugin: dynamically loads declarative defineChannelPlugin and Cordis apply plugin, rejecting legacy module', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-chan-load-'));
  const contractUrl = new URL('../src/core/channel-contract.js', import.meta.url).href;

  // 1. 新版 defineChannelPlugin 文件
  const pNew = path.join(dir, 'custom-new.mjs');
  fs.writeFileSync(pNew, `
    import { defineChannelPlugin } from ${JSON.stringify(contractUrl)};
    export default defineChannelPlugin({
      name: 'custom-im',
      capabilities: { markdown: false, files: false, maxChars: 800 },
      create() {
        return {
          async start() {},
          async send() { return 'm1'; },
          async stop() {},
        };
      },
    });
  `);
  const resNew = await loadChannelPlugin({ channel: { use: pNew, options: { token: 'ok' } } });
  assert.equal(resNew.resolvedName, 'custom-im');
  assert.equal(resNew.plugin.kind, 'channel');
  assert.deepEqual(resNew.options, { token: 'ok' });

  // 2. 原生 apply(ctx) 插件
  const pApply = path.join(dir, 'custom-apply.mjs');
  fs.writeFileSync(pApply, `
    export default {
      name: 'apply-im',
      provides: ['channel'],
      apply(ctx) {
        ctx.provide('channel', {
          capabilities: { markdown: true, files: false, images: false, replyTo: false, actions: false, maxChars: 0 },
          async start() {},
          async send() { return 'a1'; },
          async stop() {},
        });
      },
    };
  `);
  const resApply = await loadChannelPlugin({ channel: { use: pApply, options: {} } });
  assert.equal(resApply.resolvedName, 'apply-im');

  // 3. 拒绝不符合 defineChannelPlugin / apply 契约的旧式导出模块
  const pLegacy = path.join(dir, 'legacy-client.mjs');
  fs.writeFileSync(pLegacy, `
    export async function connect() {}
    export async function send() { return { msgId: 'leg1' }; }
  `);
  await assert.rejects(
    () => loadChannelPlugin({ channel: { use: pLegacy, options: {} } }),
    /不符合插件契约/,
  );
});

test('OpenMausBotBridge capability-aware degradation: strips markdown, honors maxChars/replyTo/actions/files', async () => {
  const sentCalls = [];
  const fileCalls = [];
  const transport = {
    selfChatId: 'self_plain',
    canFiles: true,
    capabilities: { markdown: false, files: false, images: false, replyTo: false, actions: false, maxChars: 45 },
    async start() {},
    async stop() {},
    async send(chatId, text, opts) {
      sentCalls.push({ chatId, text, opts });
      return `out_${sentCalls.length}`;
    },
    async sendFile(chatId, file, opts) {
      fileCalls.push({ chatId, file, opts });
      return 'f1';
    },
  };
  const bridge = new OpenMausBotBridge({
    client: { async listBots() { return { bots: [], groups: [] }; }, async subscribeEvents() {} },
    transport,
    resultChars: 1500,
    softSplitChars: 2800,
  });

  // 1. say(): markdown=false -> plain()；replyTo=false / actions=false -> 不透传 opts.replyTo 与 opts.actions
  await bridge.say('# 标题\n**加粗内容**与`代码`', null, 'u_quote_1', [{ label: '允许', text: 'ok' }]);
  assert.equal(sentCalls.length, 1);
  assert.equal(sentCalls[0].text, '标题\n加粗内容与代码');
  assert.deepEqual(sentCalls[0].opts, {});

  // 2. maxChars=45 且 files=false -> #deliverBotReply 按 45 字截断且不触发 sendFile()
  const mockMsgs = [];
  bridge.client = {
    async listBots() { return { bots: [{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }] }; },
    async resolveBot() { return { id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }; },
    async sendMessage(_id, { text, threadId, sendId }) {
      const req = { id: 'u1', role: 'user', kind: 'text', threadId, text, sendId };
      const botMsg = {
        id: 'b_long',
        role: 'bot',
        kind: 'text',
        threadId,
        requestMessageId: req.id,
        text: '**这是一段超过四十五个字的回复内容**用于测试能力降级下的最大字数截断且不发送文件附件。',
        turnTerminal: true,
      };
      mockMsgs.push(req, botMsg);
      return { ok: true, threadId, message: req };
    },
    async getMessages() { return { messages: mockMsgs }; },
    async getJob() { return { state: 'completed', version: 'v1', needsInput: [] }; },
    async subscribeEvents(_cb, { signal }) {
      await new Promise((r) => signal?.addEventListener('abort', r, { once: true }));
    },
  };

  await bridge.start();
  await bridge.dispatchToBot({ id: 'b1', name: 'MausBot', threadId: 't1' }, '测下超长截断', 'm_in_1', null, null);
  await until(() => sentCalls.length >= 2);
  assert.ok(sentCalls[1].text.length <= 50, `应按 maxChars=45 截断，实际=${sentCalls[1].text.length}`);
  assert.equal(sentCalls[1].text.includes('**'), false, 'markdown=false 时不得保留 ** 语法');
  assert.equal(fileCalls.length, 0, 'files=false 时不得发送 .md 附件');
  await bridge.stop();
});

test('Kernel full-stack: WebPlugin + custom channel + OpenMausBotPlugin + InspectorPlugin (/api/status, /api/debug/events, /debug)', async () => {
  // 极简本地 mock OpenMausBot
  const ombServer = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const json = (c, d) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (req.method === 'GET' && u.pathname === '/api/health') return json(200, { app: 'openmausbot', version: '0.1.173-mock', box: 'off' });
    if (req.method === 'GET' && u.pathname === '/.well-known/openmausbot/environment') return json(200, { capabilities: { selfUpdate: 'operator' } });
    if (req.method === 'GET' && u.pathname === '/api/auth/session') return json(200, { kind: 'loopback', scopes: ['admin', 'client'] });
    if (req.method === 'GET' && u.pathname === '/api/bots') return json(200, { bots: [{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }], groups: [] });
    if (req.method === 'GET' && u.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"kind":"hello","cursor":"1"}\n\n');
      return;
    }
    if (req.method === 'POST' && u.pathname === '/api/bots/b1/messages') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return json(202, { ok: true, threadId: 't1', message: { id: 'u1', role: 'user', kind: 'text', threadId: 't1', text: body.text, sendId: body.sendId } });
    }
    if (req.method === 'GET' && u.pathname === '/api/threads/t1/job') return json(200, { state: 'completed', version: 'v1', needsInput: [] });
    if (req.method === 'GET' && u.pathname === '/api/threads/t1/messages') {
      return json(200, { messages: [{ id: 'b_r1', role: 'bot', kind: 'text', threadId: 't1', requestMessageId: 'u1', text: '微内核全链路正常！', turnTerminal: true }] });
    }
    json(404, { error: 'not found' });
  });
  await new Promise((r) => ombServer.listen(0, '127.0.0.1', r));
  const ombPort = ombServer.address().port;
  const webPort = await getFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-kernel-e2e-'));

  let pushInbound = null;
  const sentOutbound = [];
  const customChanPlugin = defineChannelPlugin({
    name: 'custom-mock',
    capabilities: { markdown: false, files: false, images: false, replyTo: true, actions: false },
    create() {
      return {
        async start(onEvent) { pushInbound = onEvent; },
        async send(chatId, text, opts) { sentOutbound.push({ chatId, text, opts }); return `m_${sentOutbound.length}`; },
        async stop() {},
      };
    },
  });

  const cfg = {
    openmausbot: { url: `http://127.0.0.1:${ombPort}`, timeoutMs: 3000, token: '', autoStart: false, cliComputerOff: false },
    channel: { use: 'custom-mock', options: { selfId: 'u_me', selfChatId: 'chat_1' } },
    web: { host: '127.0.0.1', port: webPort },
    selfChat: { trigger: '@bot', fileRetentionDays: 0 },
    dataDir,
  };

  const kernel = new Kernel({ config: cfg });
  kernel.use(webPlugin);
  kernel.use(customChanPlugin, { selfId: 'u_me', selfChatId: 'chat_1' });
  kernel.use(openmausbotPlugin, { autoHealOmb: null });
  kernel.use(inspectorPlugin);

  try {
    await kernel.start();

    // 1. 经自定义通道入站消息并拿到回复
    pushInbound({ msgId: 'in_1', chatId: 'chat_1', chatType: 'self', fromId: 'u_me', text: '@bot 状态如何' });
    await until(() => sentOutbound.length === 1);
    assert.match(sentOutbound[0].text, /微内核全链路正常/);

    // 2. /api/status 返回插件清单、通道能力与兼容字段
    const st = await fetch(`http://127.0.0.1:${webPort}/api/status`).then((r) => r.json());
    assert.equal(st.ok, true);
    assert.equal(st.channel?.name, 'custom-mock');
    assert.equal(st.channel?.capabilities?.markdown, false);
    assert.equal(st.plugins?.length, 4);
    assert.ok(st.plugins.every((p) => p.active));
    assert.equal(st.openmausbot?.ok, true);

    // 3. /api/debug/events 包含脱敏事件流，无头模式下 / 与 /debug 均返回诊断 HTML
    const evRes = await fetch(`http://127.0.0.1:${webPort}/api/debug/events`).then((r) => r.json());
    assert.equal(evRes.ok, true);
    assert.ok(evRes.events.some((e) => e.source === 'channel' && e.type === 'inbound'));
    assert.ok(evRes.events.some((e) => e.source === 'channel' && e.type === 'outbound'));

    const debugHtml = await fetch(`http://127.0.0.1:${webPort}/debug`).then((r) => r.text());
    const rootHtml = await fetch(`http://127.0.0.1:${webPort}/`).then((r) => r.text());
    assert.match(debugHtml, /co-bot 本地只读诊断台/);
    assert.match(rootHtml, /co-bot 本地只读诊断台/);
  } finally {
    await kernel.stop();
    ombServer.closeAllConnections?.();
    await new Promise((r) => ombServer.close(r));
  }
});

test('scripts/channel-test.js: --dry validates custom channel plugins and catches broken adapters', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-chantest-'));
  const contractUrl = new URL('../src/core/channel-contract.js', import.meta.url).href;

  const validPath = path.join(dir, 'valid.mjs');
  fs.writeFileSync(validPath, `
    import { defineChannelPlugin } from ${JSON.stringify(contractUrl)};
    export default defineChannelPlugin({
      name: 'ok-im',
      capabilities: { markdown: true, files: false },
      create() {
        return { async start() {}, async send() { return '1'; }, async stop() {} };
      },
    });
  `);

  const brokenPath = path.join(dir, 'broken.mjs');
  fs.writeFileSync(brokenPath, `
    import { defineChannelPlugin } from ${JSON.stringify(contractUrl)};
    export default defineChannelPlugin({
      name: 'broken-im',
      capabilities: { files: true },
      create() {
        return { async start() {}, async stop() {} };
      },
    });
  `);

  const logs = [];
  const resOk = await runChannelContractTest(
    { channel: { use: validPath, options: {} }, web: { host: '127.0.0.1', port: 0 }, dataDir: dir },
    { dry: true, baseDir: APP_ROOT, log: (s) => logs.push(s) },
  );
  assert.equal(resOk.ok, true);
  assert.equal(resOk.channelName, 'ok-im');

  const resBroken = await runChannelContractTest(
    { channel: { use: brokenPath, options: {} }, web: { host: '127.0.0.1', port: 0 }, dataDir: dir },
    { dry: true, baseDir: APP_ROOT, log: () => {} },
  );
  assert.equal(resBroken.ok, false);
  assert.ok(resBroken.errors.some((e) => /不符合契约/.test(e) && /send/.test(e)));

  // 即使已预设 selfChatId，传入 waitExplicit: true 仍会等待并校验入站消息字段
  const inboundPath = path.join(dir, 'inbound.mjs');
  fs.writeFileSync(inboundPath, `
    import { defineChannelPlugin } from ${JSON.stringify(contractUrl)};
    export default defineChannelPlugin({
      name: 'inbound-wait-im',
      capabilities: { markdown: true, files: false },
      create() {
        return {
          async start(onMsg) {
            setTimeout(() => onMsg({ msgId: 'w1', chatId: 'preset_chat', chatType: 'self', fromId: 'u1', text: 'hi' }), 20);
          },
          async send() { return 'w_out'; },
          async stop() {},
        };
      },
    });
  `);
  const resWait = await runChannelContractTest(
    { channel: { use: inboundPath, options: { selfId: 'u1', selfChatId: 'preset_chat' } }, web: { host: '127.0.0.1', port: 0 }, dataDir: dir },
    { dry: false, waitSec: 2, waitExplicit: true, sendText: 'ping', log: () => {} },
  );
  assert.equal(resWait.ok, true);
  assert.equal(resWait.inboundValidated, true);
  assert.equal(resWait.sentMsgId, 'w_out');
});
