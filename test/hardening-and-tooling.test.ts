import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { replayChannelSamples, runChannelContractTest } from '../scripts/channel-test.ts';
import { auditDeploymentSafety, auditZeroExternalRuntimeImports } from '../scripts/check.ts';
import { loadConfig } from '../src/config.ts';
import { Kernel } from '../src/core/kernel.ts';
import { discoverPlugins } from '../src/core/plugin-loader.ts';
import { scanAndRedactOutbound } from '../src/core/security.ts';
import { WebSimTransport } from '../src/im/sim.ts';
import { OpenMausBotBridge } from '../src/openmausbot/bridge.ts';
import { handleCommand } from '../src/openmausbot/commands.ts';
import { handleSseEvent, pruneExpiredQueues } from '../src/openmausbot/dispatch.ts';
import { getCachedBotRoster, refreshMultiBot } from '../src/openmausbot/thread-manager.ts';
import { extensionsPlugin } from '../src/plugins/extensions.ts';
import type { HooksExtensionService, InboundEvent, KernelPlugin, TelemetryEvent } from '../src/types.ts';
import { WebServer } from '../src/web/server.ts';
import { makeMockHarness, makeMockTransport } from './helpers/mock-im-context.ts';

test('大文件拆分：5 个核心模块及其拆分模块均严格 <= 800 行', () => {
  const files = [
    'src/openmausbot/bridge.ts',
    'src/openmausbot/message-cache.ts',
    'src/openmausbot/bridge-lifecycle.ts',
    'src/core/chat-context.ts',
    'src/core/prompt-context.ts',
    'src/openmausbot/commands.ts',
    'src/openmausbot/commands-governance.ts',
    'src/openmausbot/inbound-router.ts',
    'src/openmausbot/collaborator-router.ts',
    'src/openmausbot/dispatch.ts',
    'src/openmausbot/queue-and-sse.ts',
  ];
  for (const rel of files) {
    const lineCount = fs.readFileSync(path.resolve(rel), 'utf8').split(/\r?\n/).length;
    assert.ok(lineCount <= 800, `${rel} 行数过高：${lineCount} > 800`);
  }
});

test('DraftStore 单一事实源与遗留 pendingSendBacks 状态文件迁移兼容', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-draft-mig-'));
  try {
    let nowMs = 1_000_000;
    const { client } = makeMockHarness();
    const { transport } = makeMockTransport();
    const draft = {
      id: 'draft_legacy_1',
      imMsgId: 'im_1',
      originChatId: 'grp_dev',
      originChatName: '研发群',
      originChatType: 'group' as const,
      replyToImMsgId: null,
      rawText: '待发送回复内容',
      addBotPrefix: false,
      createdAt: nowMs - 1000,
    };
    fs.writeFileSync(path.join(tmpDir, 'bridge-state.json'), JSON.stringify({
      privateDrafts: [draft],
      pendingSendBacks: [[draft.id, { id: draft.id, draft, text: '修订后回复', imMsgId: 'im_99', expiresAt: nowMs + 60_000 }]],
      lastPrivateDraftId: draft.id,
    }), 'utf8');

    const bridge = new OpenMausBotBridge({
      client,
      transport,
      dataDir: tmpDir,
      draftTtlMs: 60_000,
      now: () => nowMs,
    });
    assert.equal(bridge.privateDrafts.get(draft.id)?.rawText, '待发送回复内容');
    assert.equal(bridge.pendingSendBacks.get(draft.id)?.text, '修订后回复');
    assert.equal(bridge.pendingSendBack?.imMsgId, 'im_99');

    bridge.draftStore.setConfirmingFromEntry(draft.id, { id: draft.id, draft, text: '再次修订', imMsgId: 'im_100', expiresAt: nowMs + 60_000 });
    assert.equal(bridge.pendingSendBacks.get(draft.id)?.text, '再次修订');
    assert.equal(bridge.pendingSendBack?.imMsgId, 'im_100');

    nowMs += 120_000;
    assert.equal(bridge.getCoordinatorInbox().total, 0);
    assert.equal(bridge.privateDrafts.size, 0);
    assert.equal(bridge.pendingSendBacks.size, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('listBots 短时 TTL 缓存命中、force 强制刷新与 SSE/变更失效', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-roster-cache-'));
  try {
    let nowMs = 10_000;
    let calls = 0;
    const { client } = makeMockHarness();
    const baseList = client.listBots.bind(client);
    client.listBots = async () => {
      calls += 1;
      return baseList();
    };
    client.compact = async () => ({ ok: true });
    const { transport } = makeMockTransport();

    const bridge = new OpenMausBotBridge({
      client,
      transport,
      dataDir: tmpDir,
      botListCacheTtlMs: 3000,
      now: () => nowMs,
    });

    await refreshMultiBot(bridge);
    assert.equal(calls, 1);

    nowMs += 1000;
    await getCachedBotRoster(bridge);
    assert.equal(calls, 1, '3s 内重复调用应复用缓存');

    await getCachedBotRoster(bridge, { force: true });
    assert.equal(calls, 2, 'force=true 应穿透缓存');

    await handleSseEvent(bridge, { kind: 'bot', bot: { id: 'bot_main', name: 'MausBot', threadId: 'th_self_main', busy: false } });
    await getCachedBotRoster(bridge);
    assert.equal(calls, 3, 'SSE bot 事件应使缓存失效');

    await handleCommand(bridge, 'compact', {
      isDefault: true,
      targetBot: { id: 'bot_main', name: 'MausBot', threadId: 'th_self_main' },
      quotedRoute: null,
      mid: 'u_cmd',
      quotedId: null,
    });
    await getCachedBotRoster(bridge);
    assert.equal(calls, 4, 'compact 变更应使缓存失效');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('channel-test：replayChannelSamples 与 --check-notify dry 模式校验', async () => {
  const okReplay = replayChannelSamples([
    {
      id: 'm1',
      chat: { id: 'grp_dev', type: 'group', name: '研发群' },
      sender: { id: 'alice', name: 'Alice', isSelf: false },
      text: '@我 帮忙看下日志',
      mentionsMe: true,
      mentions: [{ id: 'me', name: '我', idKind: 'platform' }],
      ts: 1700000000000,
    },
    {
      id: 'm2',
      chat: { id: 'dm_self', type: 'self', name: '自聊' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot status',
      ts: 1700000001000,
    },
  ], { selfId: 'me', selfChatId: 'dm_self', strict: true });
  assert.equal(okReplay.ok, true, `unexpected errors: ${JSON.stringify(okReplay.errors)} warnings: ${JSON.stringify(okReplay.warnings)}`);
  assert.equal(okReplay.passed, 2);
  assert.equal(okReplay.summary.mentionsMeCount, 1);
  assert.equal(okReplay.summary.mentionsObserved, 1);

  const dupReplay = replayChannelSamples([
    { id: 'dup1', chat: { id: 'grp_dev', type: 'group' }, sender: { id: 'alice', isSelf: false }, text: 'hi', ts: 1700000000000 },
    { id: 'dup1', chat: { id: 'grp_dev', type: 'group' }, sender: { id: 'alice', isSelf: false }, text: 'hi2', ts: 1700000001000 },
  ], { strict: true });
  assert.equal(dupReplay.ok, false);
  assert.ok(dupReplay.errors.some((e) => e.includes('重复消息键')), `errors: ${JSON.stringify(dupReplay.errors)}`);

  const dryRes = await runChannelContractTest(loadConfig([]), {
    overrideUse: 'sim',
    dry: true,
    checkNotify: true,
    log: () => {},
  });
  assert.equal(dryRes.ok, true);
  assert.equal(dryRes.capabilities?.notify, true);
});

test('check.ts：部署安全基线审计与零三方运行时依赖审计', () => {
  const safeCfg = loadConfig([]);
  const safeAudit = auditDeploymentSafety(safeCfg, 'sim');
  assert.equal(safeAudit.ok, true);

  const dangerousAudit = auditDeploymentSafety({
    ...safeCfg,
    web: { host: '0.0.0.0', port: 8787 },
    chats: {
      ...safeCfg.chats,
      externalSanitizeMentions: 'none',
      collaborators: [{ id: '*', name: 'anyone', policy: 'auto_readonly', projects: [], chats: [] }],
    },
  }, 'external-im');
  assert.equal(dangerousAudit.ok, false);
  assert.ok(dangerousAudit.errors.some((e) => e.includes('web.host')));
  assert.ok(dangerousAudit.errors.some((e) => e.includes('auto_readonly')));
  assert.ok(dangerousAudit.warnings.some((w) => w.includes('externalSanitizeMentions')));
  assert.ok(dangerousAudit.warnings.some((w) => w.includes('selfChatId')));

  const zeroDeps = auditZeroExternalRuntimeImports(process.cwd());
  assert.equal(zeroDeps.ok, true, `发现外部运行时依赖：${JSON.stringify(zeroDeps.violations)}`);
  assert.ok(zeroDeps.filesScanned >= 30);
});

test('plugin-loader 忽略 *.example.*，且两份内网模板可干净接入 Kernel', async () => {
  const disc = await discoverPlugins(path.resolve('plugins'), { logger: { warn: () => {} } });
  const names = new Set(disc.plugins.map((p) => p.name));
  assert.equal(names.has('custom-redactor'), false);
  assert.equal(names.has('audio-transcriber'), false);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-example-plugins-'));
  const origFetch = globalThis.fetch;
  try {
    const audioFile = path.join(tmpDir, 'voice.wav');
    fs.writeFileSync(audioFile, Buffer.from('RIFF_FAKE_WAV'));
    globalThis.fetch = async () => new Response(JSON.stringify({ text: '内网语音转写文本' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    const redactorMod = await import(pathToFileURL(path.resolve('plugins/_custom-redactor.example.ts')).href) as KernelPlugin;
    const asrMod = await import(pathToFileURL(path.resolve('plugins/_audio-transcriber.example.ts')).href) as KernelPlugin;

    const cfg = loadConfig([]);
    cfg.plugins['audio-transcriber'] = { endpoint: 'http://asr.internal/v1/transcribe', timeoutMs: 2000 };
    const kernel = new Kernel({ config: cfg, logger: { warn: () => {}, error: () => {} } });
    kernel.use(extensionsPlugin);
    kernel.use(redactorMod);
    kernel.use(asrMod, { endpoint: 'http://asr.internal/v1/transcribe', timeoutMs: 2000 });
    await kernel.start();

    try {
      const scanned = scanAndRedactOutbound('工号 EMP-123456 凭证 INTRA-TOK-abcdef1234');
      assert.ok(scanned.text.includes('[EMP-REDACTED]'));
      assert.ok(scanned.text.includes('[INTRA-TOKEN-REDACTED]'));
      assert.equal(scanned.text.includes('123456'), false);

      const hooks = kernel.get<HooksExtensionService>('hooks');
      const transcript = await hooks.transcribeAudio(audioFile, {
        id: 'att1',
        msgId: 'm1',
        name: 'voice.wav',
        kind: 'audio',
        durationSec: 4,
      });
      assert.equal(transcript, '内网语音转写文本');
    } finally {
      await kernel.stop();
    }
  } finally {
    globalThis.fetch = origFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('queuedByThread TTL 自动清理与 bridge.status() 可观测增强字段', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-queue-ttl-'));
  try {
    let nowMs = 50_000;
    const telemetry: TelemetryEvent[] = [];
    const { client } = makeMockHarness();
    const { transport } = makeMockTransport();
    const bridge = new OpenMausBotBridge({
      client,
      transport,
      dataDir: tmpDir,
      queueTtlMs: 10_000,
      chats: { passiveMentionAlert: true, collaboratorBot: 'helper-bot' },
      quietHours: { enabled: true, start: '00:00', end: '23:59' },
      onTelemetry: (ev) => telemetry.push(ev),
      now: () => nowMs,
    });

    bridge.queuedByThread.set('th_1', [
      { queueId: 'q_old', botId: 'bot_main', botName: 'MausBot', threadId: 'th_1', isGroup: false, text: '过期消息', sendId: 's1', at: nowMs - 20_000, chatCtx: null },
      { queueId: 'q_new', botId: 'bot_main', botName: 'MausBot', threadId: 'th_1', isGroup: false, text: '新鲜消息', sendId: 's2', at: nowMs - 1000, chatCtx: null },
    ]);

    const st = bridge.status();
    assert.equal(st.queuedCount, 1);
    assert.equal(st.queuedItems.length, 1);
    assert.equal(st.queuedItems[0].text, '新鲜消息');
    assert.equal(st.quietHours.enabled, true);
    assert.equal(st.passiveMentionAlert, true);
    assert.equal(st.collaboratorBot, 'helper-bot');
    assert.ok(Array.isArray(st.activeTurnsList));
    assert.ok(telemetry.some((t) => t.type === 'queued_expired'));

    nowMs += 20_000;
    assert.equal(pruneExpiredQueues(bridge), 1);
    assert.equal(bridge.queuedByThread.size, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('/debug 页面与 /sim 页面及 WebSimTransport 增强功能对齐', async () => {
  const debugHtml = fs.readFileSync(path.resolve('public/debug.html'), 'utf8');
  for (const token of [
    'inboxBox',
    'inboxBody',
    'queued_expired',
    'passive_mention_triage',
    'turn_timeout',
    'internal_leak_intercepted',
  ]) {
    assert.ok(debugHtml.includes(token), `debug.html 缺少 ${token}`);
  }

  const indexHtml = fs.readFileSync(path.resolve('public/index.html'), 'utf8');
  for (const token of ['atMeBtn', 'showToast', "msg.kind === 'notify'"]) {
    assert.ok(indexHtml.includes(token), `index.html 缺少 ${token}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-sim-notify-'));
  const web = new WebServer({ host: '127.0.0.1', port: 0, publicDir: path.resolve('public') });
  const sim = new WebSimTransport({ web, filesDir: path.join(tmpDir, 'files') });
  const events: InboundEvent[] = [];
  await sim.start(async (ev) => { events.push(ev); });
  await web.start();
  const base = `http://127.0.0.1:${(web.server!.address() as AddressInfo).port}`;

  try {
    assert.equal(sim.capabilities.notify, true);

    const ac = new AbortController();
    const sseReq = http.get(`${base}/events`, { signal: ac.signal });
    const chunks: string[] = [];
    let markReady!: () => void;
    const sseReady = new Promise<void>((resolve) => { markReady = resolve; });
    const notifySeen = new Promise<void>((resolve) => {
      sseReq.on('response', (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          chunks.push(chunk);
          const full = chunks.join('');
          if (full.includes('"kind":"history_end"')) markReady();
          if (full.includes('"kind":"notify"')) resolve();
        });
      });
    });

    await Promise.race([sseReady, new Promise((_, rej) => setTimeout(() => rej(new Error('SSE 建连超时')), 2000))]);
    await sim.notify({ title: '测试提醒', body: 'Alice 提到了你', chatId: 'self', urgent: true });
    await Promise.race([notifySeen, new Promise((_, rej) => setTimeout(() => rej(new Error('SSE notify 超时')), 2000))]);
    ac.abort();
    sseReq.on('error', () => {});

    const status = sim.status();
    assert.equal(status.notifications, 1);
    assert.equal(status.recentNotifications[0]?.title, '测试提醒');

    const sendRes = await fetch(`${base}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'grp_dev', sender: 'alice', text: '@我 请看下这个报错' }),
    });
    assert.equal(sendRes.status, 200);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.mentionsMe, true);
    assert.equal(events[0]?.mentions?.[0]?.id, 'me');
  } finally {
    await sim.stop();
    await web.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
