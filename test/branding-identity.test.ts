import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateConfig } from '../src/config.ts';
import { WebSimTransport } from '../src/im/sim.ts';
import { OpenMausBotBridge } from '../src/openmausbot/bridge.ts';
import { OpenMausBotClient } from '../src/openmausbot/client.ts';
import {
  COBOT_COORDINATOR_SOUL,
  COBOT_COORDINATOR_TITLE,
  COBOT_MANAGED_SOUL_PREFIX,
} from '../src/openmausbot/persona.ts';
import type { BridgeTransport, OmbBot, OmbGroup, OmbMessage, OmbSseEvent } from '../src/openmausbot/types.ts';
import type { ChannelSendOptions, InboundEvent } from '../src/types.ts';
import { WebServer } from '../src/web/server.ts';

const until = (fn: () => boolean, ms = 3000): Promise<void> => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const check = () => {
    if (fn()) return resolve();
    if (Date.now() - t0 > ms) return reject(new Error(`timeout: ${fn.toString()}`));
    setTimeout(check, 15);
  };
  check();
});

function makeTransport() {
  const sent: Array<{ id: string; chatId: string; text: string } & ChannelSendOptions> = [];
  const filesSent: Array<{ chatId: string; name: string; content: string }> = [];
  let onMsg: ((ev: InboundEvent) => unknown) | null = null;
  let seq = 0;
  const transport: BridgeTransport = {
    selfChatId: 'chat_self',
    canFiles: true,
    capabilities: { markdown: true, files: true, images: false, replyTo: true, actions: true, history: false, maxChars: 0 },
    status() { return { kind: 'mock', connected: true, selfChatId: 'chat_self' }; },
    async start(cb) { onMsg = cb; },
    async stop() {},
    async send(chatId: string, text: string, opts: ChannelSendOptions = {}) {
      const id = `b_${++seq}`;
      sent.push({ id, chatId, text, ...opts });
      return id;
    },
    async sendFile(chatId: string, { path: p, name }: { path: string; name: string }) {
      filesSent.push({ chatId, name, content: fs.readFileSync(p, 'utf8') });
      return `f_${++seq}`;
    },
  };
  return {
    sent,
    filesSent,
    async emitUser(text: string, extra: Partial<InboundEvent> = {}) {
      await onMsg?.({
        id: `u_${++seq}`,
        ts: Date.now(),
        chat: { id: 'chat_self', type: 'self', name: '自聊' },
        sender: { id: 'me', name: '我', isSelf: true },
        text,
        ...extra,
      });
    },
    transport,
  };
}

function makeRichMockClient({
  bots = [
    {
      id: 'b1',
      name: 'MausBot',
      threadId: 't_chief',
      chiefOfStaff: true,
      replyStyle: 'default',
      soul: '',
      tasks: [{ threadId: 't_chief', title: '主线会话', updatedAt: 100 }],
    },
    {
      id: 'b2',
      name: 'Plum',
      threadId: 't_plum',
      chiefOfStaff: false,
      tasks: [{ threadId: 't_plum', title: '研发会话', updatedAt: 90 }],
    },
  ] as Array<OmbBot & { soul?: string }>,
  groups = [{ id: 'g1', name: '项目组', threadId: 't_grp', memberIds: ['b1', 'b2'] }] as OmbGroup[],
  patchError = null as (Error & { status?: number }) | null,
} = {}) {
  const patches: Array<{ botId: string; patch: Record<string, unknown> }> = [];
  const sentMessages: Array<Record<string, unknown>> = [];
  const threadMsgs = new Map<string, OmbMessage[]>();
  let ssePush: ((evt: OmbSseEvent) => unknown) | null = null;
  let msgSeq = 0;
  let newTaskSeq = 0;

  const clientObj = {
    baseUrl: 'http://127.0.0.1:8799',
    token: '',
    async health() { return { ok: true, version: '0.1.177', box: 'off', doctor: { checked: 5, problems: [] } }; },
    async environment() { return { capabilities: {} }; },
    async authSession() { return { kind: 'none' }; },
    async listBots() { return { bots, groups }; },
    async resolveBot(q = '') {
      const low = String(q || '').trim().toLowerCase();
      if (!low || /^(bot|ai|主bot|co-bot|cobot|default|chief)$/i.test(low)) {
        return bots.find((b) => b.chiefOfStaff) ?? bots[0];
      }
      return bots.find((b) => b.name.toLowerCase() === low || b.id === q) ?? null;
    },
    async resolveGroup(q = '') {
      const low = String(q || '').trim().toLowerCase();
      return groups.find((g) => g.name.toLowerCase() === low || g.id === q) ?? null;
    },
    async patchBot(botId: string, patch: Record<string, unknown>) {
      if (patchError) throw patchError;
      patches.push({ botId, patch });
      const b = bots.find((x) => x.id === botId);
      if (b) Object.assign(b, patch);
      return { ok: true, bot: b };
    },
    async sendMessage(botId: string, payload: { threadId: string; text: string; sendId?: string }) {
      const b = bots.find((x) => x.id === botId);
      const reqId = `req_${++msgSeq}`;
      sentMessages.push({ kind: 'bot', botId, ...payload });
      const replyText = payload.text.includes('超长正文')
        ? '主协调回复内容。'.repeat(18)
        : `${b?.name === 'Plum' ? 'Plum' : '已'}处理：${payload.text}`;
      threadMsgs.set(payload.threadId, [
        { id: reqId, role: 'user', sendId: payload.sendId },
        { id: `bot_${reqId}`, role: 'bot', kind: 'text', requestMessageId: reqId, text: replyText, turnTerminal: true },
      ]);
      return { ok: true, threadId: payload.threadId, message: { id: reqId, role: 'user', sendId: payload.sendId } };
    },
    async sendGroupMessage(groupId: string, payload: { threadId: string; text: string; sendId?: string }) {
      const reqId = `req_${++msgSeq}`;
      sentMessages.push({ kind: 'group', groupId, ...payload });
      threadMsgs.set(payload.threadId, [
        { id: reqId, role: 'user', sendId: payload.sendId },
        { id: `bot_${reqId}_1`, role: 'bot', kind: 'text', requestMessageId: reqId, from: { botId: 'b1', name: 'MausBot' }, text: '协调方案已对齐。' },
        { id: `bot_${reqId}_2`, role: 'bot', kind: 'text', requestMessageId: reqId, from: { botId: 'b2', name: 'Plum' }, text: '接口已实现。', turnTerminal: true },
      ]);
      return { ok: true, threadId: payload.threadId, message: { id: reqId, role: 'user', sendId: payload.sendId } };
    },
    async getJob() { return { state: 'completed', version: 'v1', needsInput: [] }; },
    async getMessages(tid: string) { return { messages: threadMsgs.get(tid) ?? [] }; },
    async createTask(_botId: string) {
      const tid = `t_new_${++newTaskSeq}`;
      return { task: { threadId: tid } };
    },
    async compact() { return { ok: true }; },
    async subscribeEvents(cb: (evt: OmbSseEvent) => unknown, { signal }: { signal?: AbortSignal }) {
      ssePush = cb;
      await new Promise<void>((r) => signal?.addEventListener('abort', () => r(), { once: true }));
    },
  };

  return {
    patches,
    sentMessages,
    emitSse(evt: OmbSseEvent) { ssePush?.(evt); },
    client: clientObj as unknown as OpenMausBotClient,
    rawListBots: clientObj.listBots,
  };
}

test('Brand isolation: zero MausBot/OpenMausBot leaks across all user-facing replies, cards, commands & filenames', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-brand-'));
  const nowMs = new Date(2026, 10, 20, 10, 0, 0).getTime();
  const tr = makeTransport();
  const mock = makeRichMockClient();

  const bridge = new OpenMausBotBridge({
    client: mock.client,
    transport: tr.transport,
    dataDir: tmpDir,
    resultChars: 120,
    softSplitChars: 120,
    hideChiefPrefix: false,
    turnStallMs: 0,
    now: () => nowMs,
  });

  try {
    await bridge.start();

    await tr.emitUser('@co-bot 你好');
    await until(() => tr.sent.some((m) => m.text.includes('已处理：你好')));
    assert.match(tr.sent.at(-1)!.text, /^🤖 \*\*\[co-bot\]\*\*/);

    await tr.emitUser('@cobot 测试英文别名');
    await until(() => tr.sent.some((m) => m.text.includes('测试英文别名')));
    assert.match(tr.sent.at(-1)!.text, /^🤖 \*\*\[co-bot\]\*\*/);

    await tr.emitUser('@Plum 查一下构建');
    await until(() => tr.sent.some((m) => m.text.includes('Plum处理：查一下构建')));
    assert.match(tr.sent.at(-1)!.text, /^🤖 \*\*\[Plum\]\*\*/);

    await tr.emitUser('@项目组 对齐方案');
    await until(() => tr.sent.some((m) => m.text.includes('协调方案已对齐')) && tr.sent.some((m) => m.text.includes('接口已实现')));
    assert.ok(tr.sent.some((m) => m.text.includes('🤖 **[项目组 · co-bot]**')));
    assert.ok(tr.sent.some((m) => m.text.includes('🤖 **[项目组 · Plum]**')));

    await tr.emitUser('@bot 超长正文输出测试');
    await until(() => tr.filesSent.length === 1);
    assert.equal(tr.filesSent[0].name, 'co-bot.md');

    mock.emitSse({
      kind: 'message',
      threadId: 't_chief',
      message: { id: 'pro_chief', role: 'bot', kind: 'text', text: '巡检报告已就绪', turnTerminal: true },
    });
    await until(() => tr.sent.some((m) => m.text.includes('巡检报告已就绪')));
    assert.match(tr.sent.at(-1)!.text, /^🔔 \*\*co-bot 通知\*\*/);

    mock.emitSse({
      kind: 'message',
      threadId: 't_plum',
      message: { id: 'pro_plum', role: 'bot', kind: 'text', text: '测试流水线完成', turnTerminal: true },
    });
    await until(() => tr.sent.some((m) => m.text.includes('测试流水线完成')));
    assert.match(tr.sent.at(-1)!.text, /^🔔 \*\*Plum 通知\*\*/);

    bridge.quietHours = { enabled: true, start: '09:00', end: '12:00' };
    mock.emitSse({
      kind: 'message',
      threadId: 't_chief',
      message: { id: 'pro_q1', role: 'bot', kind: 'text', text: '静默期间主协调消息', turnTerminal: true },
    });
    await until(() => bridge.quietQueue.length === 1);
    await tr.emitUser('@bot status');
    await until(() => tr.sent.some((m) => m.text.includes('待汇总 1')));
    await bridge.flushQuietDigest();
    await until(() => tr.sent.some((m) => m.text.includes('静默期间主协调消息')));
    assert.ok(tr.sent.some((m) => m.text.includes('- **co-bot**：静默期间主协调消息')));
    bridge.quietHours = { enabled: false, start: '22:00', end: '08:30' };

    mock.emitSse({
      kind: 'message',
      threadId: 't_chief',
      message: { id: 'blk_sec', role: 'bot', kind: 'text', secret: { label: 'API Key' } },
    });
    await until(() => tr.sent.some((m) => m.text.includes('API Key')));
    assert.ok(tr.sent.at(-1)!.text.includes('管理后台'));

    const cmds = ['@bot', '@bot help', '@bot status', '@bot new', '@bot task', '@bot compact', '@bot chats'];
    for (const c of cmds) {
      const before = tr.sent.length + tr.filesSent.length;
      await tr.emitUser(c);
      await until(() => tr.sent.length + tr.filesSent.length > before);
    }

    for (const m of tr.sent) {
      assert.equal(/mausbot/i.test(m.text), false, `检测到未替换的 MausBot/OpenMausBot 文案：${m.text}`);
      assert.equal(/grok/i.test(m.text), false, `检测到旧品牌 Grok 文案：${m.text}`);
    }
    for (const f of tr.filesSent) {
      assert.equal(/mausbot/i.test(f.name), false, `检测到未替换的附件文件名：${f.name}`);
      assert.equal(/mausbot|opencode|grok|手机端\s*IM/i.test(f.content), false, `检测到未清理的技术/旧品牌文案：${f.name}`);
    }
  } finally {
    await bridge.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Custom botName & client.resolveBot support co-bot/cobot/custom aliases seamlessly', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-custom-name-'));
  const tr = makeTransport();
  const mock = makeRichMockClient();
  const bridge = new OpenMausBotBridge({
    client: mock.client,
    transport: tr.transport,
    dataDir: tmpDir,
    botName: '协调官',
    hideChiefPrefix: false,
    turnStallMs: 0,
  });

  try {
    await bridge.start();
    await tr.emitUser('@协调官 汇报进展');
    await until(() => tr.sent.some((m) => m.text.includes('已处理：汇报进展')));
    assert.match(tr.sent.at(-1)!.text, /^🤖 \*\*\[协调官\]\*\*/);

    await tr.emitUser('@bot status');
    await until(() => tr.sent.some((m) => m.text.includes('**✅ 协调官 在线**')));

    const c = new OpenMausBotClient({ baseUrl: 'http://127.0.0.1:8799' });
    c.listBots = mock.rawListBots;
    assert.equal((await c.resolveBot('co-bot'))?.id, 'b1');
    assert.equal((await c.resolveBot('cobot'))?.id, 'b1');
    assert.equal((await c.resolveBot('Plum'))?.id, 'b2');
  } finally {
    await bridge.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('syncChiefIdentity patches MausBot->co-bot & legacy soul idempotently, preserves custom soul, and tolerates 403', async () => {
  const tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-sync1-'));
  const tr1 = makeTransport();
  const m1 = makeRichMockClient({
    bots: [{ id: 'b1', name: 'MausBot', title: '', soul: '你是 Grok Bot 风格助手', replyStyle: 'conversational', chiefOfStaff: true, threadId: 't1' }],
  });
  const b1 = new OpenMausBotBridge({
    client: m1.client,
    transport: tr1.transport,
    dataDir: tmpDir1,
    syncChiefIdentity: true,
    turnStallMs: 0,
  });
  try {
    await b1.start();
    assert.equal(m1.patches.length, 1);
    assert.equal(m1.patches[0].patch.name, 'co-bot');
    assert.equal(m1.patches[0].patch.title, COBOT_COORDINATOR_TITLE);
    assert.equal(m1.patches[0].patch.soul, COBOT_COORDINATOR_SOUL);
    assert.equal(m1.patches[0].patch.replyStyle, 'conversational');
    assert.match(COBOT_COORDINATOR_SOUL, /Bot 账号.*Boat 账号.*Composio/);

    await b1.refreshMultiBot();
    assert.equal(m1.patches.length, 1);
  } finally {
    await b1.stop();
    fs.rmSync(tmpDir1, { recursive: true, force: true });
  }

  // 旧版托管 default soul（含 COBOT_MANAGED_SOUL_PREFIX 前缀但未带最新第 7 条规则）自动升级，最新则不重复 PATCH
  const tmpDirUpgrade = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-sync-up-'));
  const trUpgrade = makeTransport();
  const oldManagedSoul = `${COBOT_MANAGED_SOUL_PREFIX}\n回复原则：\n1. 身份统一：对外始终以 co-bot 身份沟通。`;
  const mUpgrade = makeRichMockClient({
    bots: [{ id: 'b1', name: 'co-bot', title: COBOT_COORDINATOR_TITLE, soul: oldManagedSoul, replyStyle: 'conversational', chiefOfStaff: true, threadId: 't1' }],
  });
  const bUpgrade = new OpenMausBotBridge({
    client: mUpgrade.client,
    transport: trUpgrade.transport,
    dataDir: tmpDirUpgrade,
    syncChiefIdentity: true,
    turnStallMs: 0,
  });
  try {
    await bUpgrade.start();
    assert.equal(mUpgrade.patches.length, 1);
    assert.equal(mUpgrade.patches[0].patch.soul, COBOT_COORDINATOR_SOUL);
    bUpgrade.chiefIdentitySynced = false;
    await bUpgrade.syncChiefBotIdentity();
    assert.equal(mUpgrade.patches.length, 1, '已同步最新版 soul 后不再重复 PATCH');
  } finally {
    await bUpgrade.stop();
    fs.rmSync(tmpDirUpgrade, { recursive: true, force: true });
  }

  const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-sync2-'));
  const tr2 = makeTransport();
  const m2 = makeRichMockClient({
    bots: [{ id: 'b1', name: 'MausBot', title: 'My Chief', soul: '我只保留主人手写的规则', replyStyle: 'conversational', chiefOfStaff: true, threadId: 't1' }],
  });
  const b2 = new OpenMausBotBridge({
    client: m2.client,
    transport: tr2.transport,
    dataDir: tmpDir2,
    syncChiefIdentity: true,
    turnStallMs: 0,
  });
  try {
    await b2.start();
    assert.equal(m2.patches.length, 1);
    assert.deepEqual(m2.patches[0].patch, { name: 'co-bot' });
  } finally {
    await b2.stop();
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  }

  const tmpDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-sync3-'));
  const tr3 = makeTransport();
  const m3 = makeRichMockClient({
    patchError: Object.assign(new Error('Forbidden'), { status: 403 }),
  });
  const b3 = new OpenMausBotBridge({
    client: m3.client,
    transport: tr3.transport,
    dataDir: tmpDir3,
    syncChiefIdentity: true,
    hideChiefPrefix: false,
    turnStallMs: 0,
  });
  try {
    await b3.start();
    await tr3.emitUser('@bot status');
    await until(() => tr3.sent.length === 1);
    assert.equal(/mausbot/i.test(tr3.sent[0].text), false);
    assert.ok(tr3.sent[0].text.includes('co-bot'));
  } finally {
    await b3.stop();
    fs.rmSync(tmpDir3, { recursive: true, force: true });
  }
});

test('WebSimTransport uses co-bot senderName and validateConfig checks branding fields', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-sim-brand-'));
  const web = new WebServer({ host: '127.0.0.1', port: 0, publicDir: path.join(process.cwd(), 'public') });
  const sim = new WebSimTransport({ web, filesDir: path.join(dir, 'files'), historyFile: null });
  const customWeb = new WebServer({ host: '127.0.0.1', port: 0, publicDir: path.join(process.cwd(), 'public') });
  const customSim = new WebSimTransport({ web: customWeb, filesDir: path.join(dir, 'files2'), historyFile: null, botName: 'CoPilot' });
  await web.start();
  await sim.start(async () => {});
  try {
    await sim.send('self', 'hello from co-bot');
    assert.equal(sim.history.at(-1)?.senderName, 'co-bot');
    await customSim.send('self', 'hi');
    assert.equal(customSim.history.at(-1)?.senderName, 'CoPilot');

    const okRes = validateConfig({ openmausbot: { syncChiefIdentity: true }, selfChat: { botName: 'co-bot' } });
    assert.equal(okRes.ok, true);
    assert.equal(okRes.warnings.length, 0);

    const badRes = validateConfig({ openmausbot: { syncChiefIdentity: 'yes' }, selfChat: { botName: '   ' } });
    assert.equal(badRes.ok, false);
    assert.equal(badRes.errors.length, 2);
  } finally {
    await customSim.stop();
    await sim.stop();
    await web.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
