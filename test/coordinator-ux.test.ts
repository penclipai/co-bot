import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Kernel } from '../src/core/kernel.ts';
import { defineChannelPlugin } from '../src/core/channel-contract.ts';
import { OpenMausBotBridge } from '../src/openmausbot/bridge.ts';
import { OpenMausBotClient } from '../src/openmausbot/client.ts';
import { imContextPlugin } from '../src/plugins/im-context.ts';
import { inspectorPlugin } from '../src/plugins/inspector.ts';
import { openmausbotPlugin } from '../src/plugins/openmausbot.ts';
import { webPlugin } from '../src/plugins/web.ts';
import type { InboundEvent, RawConfig } from '../src/types.ts';
import type { WebServer } from '../src/web/server.ts';
import { makeMockHarness } from './helpers/mock-im-context.ts';
import { startMockOmb } from './helpers/mock-omb.ts';

const until = async (fn: () => boolean | Promise<boolean>, ms = 4000): Promise<void> => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail('timeout waiting for condition');
};

test('Coordinator UX 1: pendingFollowUps survives restart, resumes thread, and fires one-shot timeout reminders', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-coord-fp-'));
  let nowTs = 1_795_800_000_000;
  let nextText = '请向 Bob 确认连接池配置。\n[cobot:ask chat=grp_ops to=bob] 请问线上 Redis 连接池目前是多少？';

  const mock = makeMockHarness({
    onSendMessage() {
      const reqId = `req_${mock.sentPrompts.length}`;
      return {
        message: { id: reqId },
        reply: nextText,
      };
    },
  });
  const threadMessages = new Map<string, Array<Record<string, unknown>>>();
  mock.client.sendMessage = async (botId: string, opts: { text: string; sendId?: string; threadId?: string }) => {
    mock.sentPrompts.push({ botId, ...opts });
    const reqId = `req_${mock.sentPrompts.length}`;
    const tid = String(opts.threadId || 't1');
    const arr = threadMessages.get(tid) ?? [];
    const botMsg = { id: `bot_${reqId}`, role: 'bot', kind: 'text', threadId: tid, requestMessageId: reqId, text: nextText, turnTerminal: true };
    arr.push({ id: reqId, role: 'user', text: opts.text, sendId: opts.sendId }, botMsg);
    threadMessages.set(tid, arr);
    return { message: { id: reqId } };
  };
  mock.client.getMessages = async (tid: string) => ({ messages: threadMessages.get(tid) ?? [] });

  const sent: Array<{ chatId: string; text: string; replyTo?: string; actions?: Array<{ label: string; text?: string; kind?: string }> }> = [];
  let seq = 0;
  const transport = {
    selfChatId: 'chat_self',
    capabilities: { markdown: true, files: false, images: false, replyTo: true, actions: true, history: false, notify: false },
    async start() {},
    async send(chatId: string, text: string, opts: { replyTo?: string; actions?: Array<{ label: string; text?: string; kind?: string }> } = {}) {
      sent.push({ chatId, text, replyTo: opts.replyTo, actions: opts.actions });
      return `im_${++seq}`;
    },
  };

  const b1 = new OpenMausBotBridge({
    client: mock.client,
    transport,
    dataDir: tmpDir,
    sendRetries: 0,
    turnStallMs: 0,
    stateSaveDebounceMs: 0,
    followUpRemindMs: 15 * 60_000,
    delegationRemindMs: 30 * 60_000,
    now: () => nowTs,
  });
  await b1.start();

  try {
    // 1. Seed grp_ops conversation and generate [cobot:ask] follow-up draft
    await b1.onEvent({
      id: 'g_bob_1',
      ts: nowTs - 1000,
      chat: { id: 'grp_ops', type: 'group', name: '运维群' },
      sender: { id: 'bob', name: 'Bob', isSelf: false },
      text: 'Redis 有偶发超时',
    });
    await b1.onEvent({
      id: 'g_ask_me',
      ts: nowTs,
      chat: { id: 'grp_ops', type: 'group', name: '运维群' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot 查一下并找 Bob 确认 Redis 连接池配置',
    });
    await until(() => sent.some((s) => s.chatId === 'chat_self' && s.text.includes('确认向「运维群」追问')));

    // Confirm sending follow-up
    const sentBeforeConfirm = sent.length;
    await b1.onEvent({
      id: 'self_confirm_fp',
      ts: nowTs + 100,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '确认发送',
    });
    await until(() => sent.slice(sentBeforeConfirm).some((s) => s.chatId === 'grp_ops' && s.text.includes('@Bob')));
    assert.equal(b1.pendingFollowUps.size, 1);

    // Seed an outbound delegation aged 15m before advancing 16m so both stay cleanly testable
    b1.delegations.trackOutbound({ id: 'd_test_1', targetChatId: 'dm_bob', targetChatName: 'Bob', project: 'happy-bot', question: '查超时阈值', createdAt: nowTs - 15 * 60_000 });
    b1.flushState();
  } finally {
    await b1.stop();
  }

  // 2. Restart bridge b2 from disk and test reminders + resumption
  const b2 = new OpenMausBotBridge({
    client: mock.client,
    transport,
    dataDir: tmpDir,
    sendRetries: 0,
    turnStallMs: 0,
    stateSaveDebounceMs: 0,
    followUpRemindMs: 15 * 60_000,
    delegationRemindMs: 30 * 60_000,
    now: () => nowTs,
  });
  await b2.start();
  let askMsgId!: string;
  try {
    assert.equal(b2.pendingFollowUps.size, 1, '重启后 pendingFollowUps 必须恢复');
    assert.equal(b2.delegations.pendingOutbound.size, 1, '重启后 delegations 必须恢复');
    askMsgId = [...b2.pendingFollowUps.values()][0].askMsgId;
    assert.ok(askMsgId, '恢复的追问应保留原 IM askMsgId');

    // Before threshold: 0 reminders
    assert.equal(await b2.checkPendingReminders(), 0);

    // Advance 16 minutes: follow-up (>15m, <30m TTL) and delegation (>30m) both remind once
    nowTs += 16 * 60_000;
    const remindSentBefore = sent.length;
    const cnt = await b2.checkPendingReminders();
    assert.equal(cnt, 2);
    assert.ok(sent.slice(remindSentBefore).some((s) => s.chatId === 'chat_self' && s.text.includes('追问超时提醒')));
    assert.ok(sent.slice(remindSentBefore).some((s) => s.chatId === 'chat_self' && s.text.includes('协作委托超时提醒') && s.text.includes('d_test_1')));
    // Second run must be idempotent (single-shot)
    assert.equal(await b2.checkPendingReminders(), 0);
  } finally {
    await b2.stop();
  }

  // 3. Bridge 3 restarts with original persisted follow-up still valid, receives Bob's reply, resumes analysis privately to self
  const b3 = new OpenMausBotBridge({
    client: mock.client,
    transport,
    dataDir: tmpDir,
    sendRetries: 0,
    turnStallMs: 0,
    stateSaveDebounceMs: 0,
    now: () => nowTs,
  });
  nextText = '收到 Bob 补充（连接池 64），建议先扩容到 128。';
  await b3.start();
  try {
    assert.equal(b3.pendingFollowUps.size, 1);
    const beforeResume = sent.length;
    await b3.onEvent({
      id: 'bob_reply_1',
      ts: nowTs + 50,
      chat: { id: 'grp_ops', type: 'group', name: '运维群' },
      sender: { id: 'bob', name: 'Bob', isSelf: false },
      replyTo: askMsgId,
      text: '目前是 64',
    });
    await until(() => sent.slice(beforeResume).some((s) => s.chatId === 'chat_self' && s.text.includes('建议先扩容到 128')));
    assert.equal(b3.pendingFollowUps.size, 0, '一次性追问回流后应移除跟踪');
  } finally {
    await b3.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Coordinator UX 2: multi-slot concurrent drafts/sendbacks, action pills, 1-step quote confirm/cancel, and status inbox', async () => {
  const omb = await startMockOmb([{ id: 'b1', name: 'co-bot', threadId: 't_self', chiefOfStaff: true }]);
  const sent: Array<{ chatId: string; text: string; replyTo?: string; actions?: Array<{ label: string; text?: string; kind?: string }> }> = [];
  let seq = 0;
  const transport = {
    selfChatId: 'chat_self',
    capabilities: { markdown: true, files: false, images: false, replyTo: true, actions: true, history: false, notify: false },
    async start() {},
    async send(chatId: string, text: string, opts: { replyTo?: string; actions?: Array<{ label: string; text?: string; kind?: string }> } = {}) {
      sent.push({ chatId, text, replyTo: opts.replyTo, actions: opts.actions });
      return `m_${++seq}`;
    },
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-coord-multi-'));
  const bridge = new OpenMausBotBridge({
    client: new OpenMausBotClient({ baseUrl: omb.baseUrl }),
    transport,
    dataDir: tmpDir,
    sendRetries: 0,
    turnStallMs: 0,
    stateSaveDebounceMs: 0,
  });

  await bridge.start();
  try {
    // Idle status must omit inbox noise
    await bridge.onEvent({ id: 'st_idle', ts: Date.now(), chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot status' });
    const idleReply = sent.at(-1)!;
    assert.equal(idleReply.text.includes('待处理事项'), false, '空闲状态不应显示待处理事项区块');
    assert.equal(bridge.getCoordinatorInbox().total, 0);

    // Produce two concurrent @bot! drafts (grp_dev and grp_ops)
    let draftNum = 0;
    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      draftNum += 1;
      const fin = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: `草稿正文_${draftNum}`, turnTerminal: true };
      messages.push(fin);
      jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
      broadcast({ kind: 'message', threadId, message: fin });
    });

    await bridge.onEvent({ id: 'g1_bang', ts: Date.now() + 1, chat: { id: 'grp_dev', type: 'group', name: '研发群' }, sender: { id: 'me', isSelf: true }, text: '@bot! 同步进展' });
    await until(() => sent.some((s) => s.chatId === 'chat_self' && s.text.includes('草稿正文_1')));
    await bridge.onEvent({ id: 'g2_bang', ts: Date.now() + 2, chat: { id: 'grp_ops', type: 'group', name: '运维群' }, sender: { id: 'me', isSelf: true }, text: '@bot! 发维护公告' });
    await until(() => sent.some((s) => s.chatId === 'chat_self' && s.text.includes('草稿正文_2')));

    const draftIdx1 = sent.findIndex((s) => s.text.includes('草稿正文_1'));
    const draftIdx2 = sent.findIndex((s) => s.text.includes('草稿正文_2'));
    const draftMsg1 = sent[draftIdx1];
    const draftMsg2 = sent[draftIdx2];
    const draftImId1 = `m_${draftIdx1 + 1}`;
    const draftImId2 = `m_${draftIdx2 + 1}`;
    const draftKey1 = draftMsg1.text.match(/draft_[a-z0-9_]+/i)![0];
    const draftKey2 = draftMsg2.text.match(/draft_[a-z0-9_]+/i)![0];

    // Both draft bubbles include 1-tap actions
    assert.deepEqual(draftMsg1.actions, [
      { label: '发回原群', text: `@bot sendback ${draftKey1}`, kind: 'primary' },
      { label: '忽略', text: `@bot sendback cancel ${draftKey1}` },
    ]);
    assert.equal(draftMsg2.actions?.[0]?.text, `@bot sendback ${draftKey2}`);

    // Status shows unified inbox with 2 drafts
    await bridge.onEvent({ id: 'st_busy', ts: Date.now() + 3, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot status' });
    assert.match(sent.at(-1)!.text, /\*\*📋 待处理事项（2）\*\*/);
    assert.match(sent.at(-1)!.text, /研发群/);
    assert.match(sent.at(-1)!.text, /运维群/);

    // Put BOTH drafts into pendingSendBacks concurrently without overwriting!
    await bridge.onEvent({ id: 'sb_p1', ts: Date.now() + 4, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: `@bot sendback ${draftKey1}` });
    assert.deepEqual(sent.at(-1)!.actions?.map((a) => a.label), ['确认发送', '取消']);
    await bridge.onEvent({ id: 'sb_p2', ts: Date.now() + 5, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: `@bot sendback ${draftKey2}` });
    assert.equal(bridge.pendingSendBacks.size, 2, '两条并发 sendback 预览必须并存，不得互相覆盖');

    // Cancel draft 2 by id; draft 1 must still survive
    await bridge.onEvent({ id: 'sb_cancel2', ts: Date.now() + 6, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: `@bot sendback cancel ${draftKey2}` });
    assert.equal(bridge.pendingSendBacks.size, 1);
    assert.match(sent.at(-1)!.text, /已取消发回原群/);

    // Bare confirm sends remaining draft 1 to grp_dev
    await bridge.onEvent({ id: 'sb_ok1', ts: Date.now() + 7, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '确认发送' });
    assert.ok(sent.some((s) => s.chatId === 'grp_dev' && s.text.includes('草稿正文_1')));
    assert.equal(bridge.pendingSendBacks.size, 0);

    // One-step quote cancel discards draft 2 completely; then re-create draft 3 and quote with free text (LLM polish still works) + quote `确认发送`
    await bridge.onEvent({ id: 'q_discard2', ts: Date.now() + 8, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, replyTo: draftImId2, text: '取消' });
    assert.match(sent.at(-1)!.text, /已忽略/);
    assert.equal(bridge.privateDrafts.has(draftKey2), false);

    // Discard draft 1 message ref wasn't re-used; test one-step quote `确认发送` on fresh draft 3
    assert.equal(bridge.privateDrafts.has(draftImId1), false);
    await bridge.onEvent({ id: 'g3_bang', ts: Date.now() + 9, chat: { id: 'grp_dev', type: 'group', name: '研发群' }, sender: { id: 'me', isSelf: true }, text: '@bot! 第二条' });
    await until(() => sent.some((s) => s.chatId === 'chat_self' && s.text.includes('草稿正文_3')));
    const idx3 = sent.findIndex((s) => s.text.includes('草稿正文_3'));
    const imId3 = `m_${idx3 + 1}`;

    // Quoting draft 3 with free text triggers LLM polish (does not prematurely confirm or discard)
    await bridge.onEvent({ id: 'q_polish', ts: Date.now() + 10, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', name: '我', isSelf: true }, replyTo: imId3, text: '翻成更简短的版本' });
    await until(() => sent.some((s) => s.chatId === 'chat_self' && s.text.includes('草稿正文_4')));

    // Quoting draft 3 directly with `确认发送` skips preview and sends in one step
    await bridge.onEvent({ id: 'q_direct', ts: Date.now() + 11, chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', name: '我', isSelf: true }, replyTo: imId3, text: '确认发送' });
    assert.ok(sent.some((s) => s.chatId === 'grp_dev' && s.text.includes('草稿正文_3')), '引用草稿直接回复 确认发送 应一步发回原群');
  } finally {
    await bridge.stop();
    await omb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Coordinator UX 3: owner self cross-chat L3 pull, 403 external isolation, L3 @bot summary, leak firewall, muted hint, and collaborator ack', async () => {
  const omb = await startMockOmb([
    { id: 'b_chief', name: 'co-bot', threadId: 't_chief', chiefOfStaff: true },
    { id: 'b_forge', name: 'Forge', threadId: 't_forge', chiefOfStaff: false },
  ]);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-coord-l3-'));
  const sent: Array<{ chatId: string; text: string; replyTo?: string; actions?: Array<{ label: string; text?: string; kind?: string }> }> = [];
  const files = new Map<string, Buffer>([['f_rel', Buffer.from('Release=v0.8.0\nCanary=CROSS_DEV_9012\n', 'utf8')]]);
  let emitIn!: (ev: InboundEvent) => Promise<unknown>;

  const chanPlugin = defineChannelPlugin({
    name: 'mock-coord-im',
    create() {
      return {
        selfChatId: 'chat_self',
        capabilities: { markdown: true, files: true, images: false, replyTo: true, actions: true, history: true },
        async start(onEv) { emitIn = async (ev) => onEv(ev); },
        async stop() {},
        async send(chatId, text, opts = {}) {
          sent.push({ chatId, text, replyTo: opts.replyTo, actions: opts.actions as Array<{ label: string; text?: string; kind?: string }> });
          return `out_${sent.length}`;
        },
        async sendFile() { return 'out_file'; },
        async download(att, savePath) {
          fs.writeFileSync(savePath, files.get(att.id) ?? Buffer.from('empty'));
        },
      };
    },
  });

  const cfg: RawConfig = {
    openmausbot: { url: omb.baseUrl, autoStart: false, syncChiefIdentity: false },
    web: { host: '127.0.0.1', port: 0 },
    pluginsDir: '',
    dataDir: tmpDir,
    chats: {
      mode: 'owner_everywhere',
      collaboratorConfirmAck: true,
      collaborators: [{ id: 'carol', name: 'Carol', policy: 'confirm_in_self', projects: ['happy-bot'], chats: ['dm_carol'] }],
    },
  };
  const kernel = new Kernel({ config: cfg });
  await kernel.use(webPlugin);
  await kernel.use(chanPlugin);
  await kernel.use(imContextPlugin);
  await kernel.use(openmausbotPlugin);
  await kernel.use(inspectorPlugin);

  try {
    await kernel.start();
    const web = kernel.get<WebServer>('web');
    const port = (web.server!.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    // Seed external chats + self memo + external Forge message
    await emitIn({
      id: 'm_dev_1', ts: Date.now() - 3000,
      chat: { id: 'grp_dev', type: 'group', name: '研发群' },
      sender: { id: 'alice', name: 'Alice', isSelf: false },
      text: '上传了发布单',
      attachments: [{ id: 'f_rel', msgId: 'm_dev_1', name: 'release-plan.md', size: 35, mime: 'text/markdown' }],
    });
    await emitIn({
      id: 'm_ops_1', ts: Date.now() - 2000,
      chat: { id: 'grp_ops', type: 'group', name: '运维群' },
      sender: { id: 'bob', name: 'Bob', isSelf: false },
      text: '运维窗口 OPS_CANARY_4488 周六凌晨1点',
    });
    await emitIn({
      id: 'm_memo', ts: Date.now() - 1500,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '# 备忘 SELF_MEMO_999',
    });

    // 1. Owner asks chief bot in self -> context_pull gets owner_all grant + external_chats & chats_url
    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      const fin = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: 'ok', turnTerminal: true };
      messages.push(fin);
      jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
      broadcast({ kind: 'message', threadId, message: fin });
    });
    const sentBeforeOwnerAsk = sent.length;
    await emitIn({
      id: 'self_cross_1', ts: Date.now(),
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot 对比一下研发群和运维群的计划',
    });
    await until(() => sent.slice(sentBeforeOwnerAsk).some((s) => s.chatId === 'chat_self'));
    const ownerPrompt = String(omb.sentToOmb.at(-1)?.text || '');
    const pullM = ownerPrompt.match(/context_pull:\s+(http:\/\/127\.0\.0\.1:\d+\/api\/context\/history\?grant=(g_[a-f0-9]+))/);
    assert.ok(pullM, `自聊主 Bot 应拿到 context_pull 入口: ${ownerPrompt}`);
    assert.match(ownerPrompt, /external_chats=\d+/);
    assert.match(ownerPrompt, /chats_url=http:\/\/127\.0\.0\.1:\d+\/api\/context\/chats\?grant=/);
    const ownerGrant = pullM[2];

    // Query /api/context/chats + /api/context/history?chatId=... + /api/context/attachment?chatId=...
    const chatsRes = await fetch(`${baseUrl}/api/context/chats?grant=${ownerGrant}`).then((r) => r.json()) as {
      ok: boolean;
      chats: Array<{ chatId: string; count: number; fileCount?: number }>;
    };
    assert.equal(chatsRes.ok, true);
    assert.ok(chatsRes.chats.some((c) => c.chatId === 'grp_dev' && c.fileCount === 1));
    assert.ok(chatsRes.chats.some((c) => c.chatId === 'grp_ops'));
    assert.equal(chatsRes.chats.some((c) => c.chatId === 'chat_self'), false, 'chats 列表不应包含 self 会话');

    const crossOps = await fetch(`${baseUrl}/api/context/history?grant=${ownerGrant}&chatId=grp_ops`).then((r) => r.json()) as {
      ok: boolean;
      chatId: string;
      messages: Array<{ preview: string }>;
    };
    assert.equal(crossOps.ok, true);
    assert.equal(crossOps.chatId, 'grp_ops');
    assert.ok(crossOps.messages.some((m) => m.preview.includes('OPS_CANARY_4488')));

    const crossAtt = await fetch(`${baseUrl}/api/context/attachment?grant=${ownerGrant}&chatId=grp_dev&msgId=m_dev_1&attId=f_rel`).then((r) => r.json()) as {
      ok: boolean;
      text: string;
    };
    assert.equal(crossAtt.ok, true);
    assert.match(crossAtt.text, /CROSS_DEV_9012/);

    // Self memo # 备忘 remains blocked even via owner_all grant!
    const crossSelf = await fetch(`${baseUrl}/api/context/history?grant=${ownerGrant}&chatId=chat_self`).then((r) => r.json()) as {
      messages: Array<{ preview: string }>;
    };
    assert.equal(crossSelf.messages.some((m) => m.preview.includes('SELF_MEMO_999')), false, '即使跨群 grant 也不得暴露 # 备忘');

    // 2. External chat @Forge gets single-chat grant -> 403 on /api/context/chats and cross-chat &chatId=
    // AND Forge returning internal panel diagnostic triggers internalOpsLeak firewall!
    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      const fin = {
        id: nextId(),
        role: 'bot',
        kind: 'text',
        threadId,
        requestMessageId: reqMsg.id,
        text: '请在 Bot 面板里打开 **Bot\'s screen**，在「Where Forge works」下选 **This computer**',
        turnTerminal: true,
      };
      messages.push(fin);
      jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
      broadcast({ kind: 'message', threadId, message: fin });
    });
    const beforeForge = sent.length;
    await emitIn({
      id: 'ext_forge_1', ts: Date.now() + 10,
      chat: { id: 'grp_dev', type: 'group', name: '研发群' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@Forge 看一下发布单',
    });
    await until(() => sent.slice(beforeForge).some((s) => s.chatId === 'grp_dev'));
    const forgePrompt = String(omb.sentToOmb.at(-1)?.text || '');
    const extGrant = forgePrompt.match(/grant=(g_[a-f0-9]+)/)![1];

    const forbidChats = await fetch(`${baseUrl}/api/context/chats?grant=${extGrant}`);
    assert.equal(forbidChats.status, 403, '外部会话 grant 不得列出跨群会话');
    const forbidCross = await fetch(`${baseUrl}/api/context/history?grant=${extGrant}&chatId=grp_ops`);
    assert.equal(forbidCross.status, 403, '外部会话 grant 不得跨 chatId 拉取');

    const forgeOutExt = sent.slice(beforeForge).find((s) => s.chatId === 'grp_dev')!;
    assert.doesNotMatch(forgeOutExt.text, /Bot's screen|Where Forge works|This computer/, '外部群不得泄漏底层面板路径');
    assert.match(forgeOutExt.text, /暂时无法直接访问该工作区/);
    assert.ok(sent.slice(beforeForge).some((s) => s.chatId === 'chat_self' && s.text.includes('已拦截外部会话内部运维细节') && s.text.includes('Where Forge works')));

    // 3. L3 @bot summary grp_ops uses pull-only context_pull (does NOT pre-inject raw text!)
    const beforeSum = omb.sentToOmb.length;
    await emitIn({
      id: 'self_sum_ops', ts: Date.now() + 20,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot summary grp_ops 10',
    });
    await until(() => omb.sentToOmb.length > beforeSum);
    const sumPrompt = String(omb.sentToOmb.at(-1)?.text || '');
    assert.match(sumPrompt, /context_pull:\s+http:\/\/127\.0\.0\.1:/, '开启本地 HTTP 服务时 @bot summary 应走 L3 按需拉取');
    assert.doesNotMatch(sumPrompt, /OPS_CANARY_4488/, 'L3 @bot summary 不应在首轮预注入原始群消息正文');

    // 4. Muted chat emits 1 throttled self hint with Unmute button and 0 external output
    await emitIn({
      id: 'cmd_mute_ops', ts: Date.now() + 30,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot mute grp_ops',
    });
    await until(() => sent.some((s) => s.chatId === 'chat_self' && s.text.includes('已静音「运维群」')));
    const beforeMutedPing = sent.length;
    await emitIn({
      id: 'ext_muted_1', ts: Date.now() + 40,
      chat: { id: 'grp_ops', type: 'group', name: '运维群' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot ping 1',
    });
    await emitIn({
      id: 'ext_muted_2', ts: Date.now() + 41,
      chat: { id: 'grp_ops', type: 'group', name: '运维群' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot ping 2',
    });
    await until(() => sent.slice(beforeMutedPing).some((s) => s.chatId === 'chat_self' && s.text.includes('当前已静音')));
    await new Promise((r) => setTimeout(r, 40));
    const mutedSlice = sent.slice(beforeMutedPing);
    assert.equal(mutedSlice.some((s) => s.chatId === 'grp_ops'), false, '静音群外部必须零输出');
    const mutedHints = mutedSlice.filter((s) => s.chatId === 'chat_self' && s.text.includes('当前已静音'));
    assert.equal(mutedHints.length, 1, `静音群重复 @bot 在冷却期内自聊仅提示一次; mutedSlice=${JSON.stringify(mutedSlice)}`);
    assert.deepEqual(mutedHints[0].actions, [{ label: '解除静音', text: '@bot unmute grp_ops', kind: 'primary' }]);

    // 5. Collaborator confirm_in_self with collaboratorConfirmAck=true sends receipt in dm_carol without leaking answer
    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      const fin = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: 'happy-bot version is 0.7.1', turnTerminal: true };
      messages.push(fin);
      jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
      broadcast({ kind: 'message', threadId, message: fin });
    });
    const beforeCarol = sent.length;
    await emitIn({
      id: 'col_carol_1', ts: Date.now() + 50,
      chat: { id: 'dm_carol', type: 'direct', name: 'Carol' },
      sender: { id: 'carol', name: 'Carol', isSelf: false },
      text: '@bot 查 happy-bot 状态',
    });
    await until(() => sent.slice(beforeCarol).some((s) => s.chatId === 'chat_self' && s.text.includes('同事协作草稿') && s.text.includes('0.7.1')));
    const carolOut = sent.slice(beforeCarol).filter((s) => s.chatId === 'dm_carol');
    assert.equal(carolOut.length, 1);
    assert.equal(carolOut[0].replyTo, 'col_carol_1');
    assert.match(carolOut[0].text, /已收到，正在整理并转交主人确认后回复/);
    const stPayload = await fetch(`${baseUrl}/api/status`).then((r) => r.json()) as {
      bridge?: { inbox?: { drafts?: unknown[] } };
    };
    assert.equal((stPayload?.bridge?.inbox?.drafts?.length ?? 0) >= 1, true);
  } finally {
    await kernel.stop();
    await omb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
