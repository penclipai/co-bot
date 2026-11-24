import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Kernel } from '../src/core/kernel.ts';
import { defineChannelPlugin } from '../src/core/channel-contract.ts';
import { webPlugin } from '../src/plugins/web.ts';
import { imContextPlugin } from '../src/plugins/im-context.ts';
import { inspectorPlugin } from '../src/plugins/inspector.ts';
import { extractCardInfo, inQuietHours, OpenMausBotBridge } from '../src/openmausbot/bridge.ts';
import { parseInlineTriggerMention, parseStartMention } from '../src/openmausbot/mentions.ts';
import type { ImContextService, OmbMessage, OmbSseEvent } from '../src/openmausbot/types.ts';
import { WebSimTransport } from '../src/im/sim.ts';
import type { ChannelAdapter, InboundEvent, RawConfig } from '../src/types.ts';
import { WebServer } from '../src/web/server.ts';
import { makeMockHarness, makeMockTransport } from './helpers/mock-im-context.ts';

test('任何群/私聊仅本人触发、携带引用+附件+历史并隔离 Thread 与卡片隐私', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-multichat-'));
  const messagesByThread: Record<string, OmbMessage[]> = {};
  let permApproved = false;
  let permThreadId: string | null = null;
  let notifyApproved: (() => void) | null = null;
  const mock = makeMockHarness({
    onSendMessage(entry) {
      const reqId = `req_${mock.sentPrompts.length}`;
      const tid = String(entry.threadId || '');
      const txt = String(entry.text || '');
      if (txt.includes('触发审批')) {
        permThreadId = tid;
        messagesByThread[tid] = [
          { id: reqId, role: 'user', text: txt, sendId: entry.sendId ? String(entry.sendId) : undefined },
          {
            id: `omb_card_${reqId}`,
            role: 'bot',
            requestMessageId: reqId,
            kind: 'text',
            card: { requestId: 'perm_1', requestType: 'permission', title: '执行检查', command: 'cat /tmp/app.log' } as OmbMessage['card'],
          },
        ];
      } else {
        messagesByThread[tid] = [
          { id: reqId, role: 'user', text: txt, sendId: entry.sendId ? String(entry.sendId) : undefined },
          {
            id: `omb_bot_${reqId}`,
            role: 'bot',
            requestMessageId: reqId,
            kind: 'text',
            text: '让我先看下上下文……',
            turnTerminal: false,
          },
          {
            id: `omb_final_${reqId}`,
            role: 'bot',
            requestMessageId: reqId,
            kind: 'text',
            text: '原因已定位：Alice 上传的日志里 nginx upstream 超时。',
            turnTerminal: true,
          },
        ];
      }
      return { message: { id: reqId } };
    },
    onRespond({ threadId }) {
      permApproved = true;
      const list = messagesByThread[String(threadId || '')] ?? [];
      list.push({
        id: `omb_ans_${list.length}`,
        role: 'bot',
        requestMessageId: list.find((m) => m.role === 'user')?.id,
        kind: 'text',
        turnTerminal: true,
        text: '日志显示端口被占用，建议清理后重启。',
      });
      notifyApproved?.();
      notifyApproved = null;
      return { ok: true };
    },
  });
  mock.client.getMessages = async (threadId: string) => ({ messages: messagesByThread[threadId] ?? [] });
  mock.client.getJob = async (threadId: string, { wait = 0, signal }: { wait?: number; signal?: AbortSignal } = {}) => {
    if (threadId === permThreadId && !permApproved) {
      if (wait > 0 && !signal?.aborted) {
        await new Promise<void>((resolve) => {
          notifyApproved = resolve;
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      if (!permApproved) {
        return { state: 'needs-input', needsInput: [{ requestId: 'perm_1' }], since: 1, version: 1 };
      }
    }
    return { state: 'idle', since: 2, version: 2 };
  };

  const { sent, transport } = makeMockTransport({
    att_log_1: 'ERROR 502 upstream timed out (110: Connection timed out)\n',
  });

  const bridge = new OpenMausBotBridge({
    client: mock.client,
    transport,
    dataDir: tmpDir,
    resultChars: 1500,
    sendRetries: 0,
    followUpWindowMs: 120_000,
  });
  await bridge.start();

  try {
    await bridge.onEvent({
      id: 'm_alice_1',
      ts: Date.now() - 20_000,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'alice', name: 'Alice', isSelf: false },
      text: '@bot 帮我看看线上 502 报错',
      attachments: [{ id: 'att_log_1', msgId: 'm_alice_1', name: 'err.log', size: 55, mime: 'text/plain' }],
    });
    assert.equal(mock.sentPrompts.length, 0, '非本人发送 @bot 绝不应触发 OpenMausBot');

    await bridge.onEvent({
      id: 'm_bob_2',
      ts: Date.now() - 10_000,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'bob', name: 'Bob', isSelf: false },
      text: '我也复现了这个 timeout 问题',
    });

    await bridge.onEvent({
      id: 'm_me_3',
      ts: Date.now(),
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: '我', isSelf: true },
      replyTo: 'm_alice_1',
      text: '@bot 分析下原因',
    });

    await new Promise((r) => setTimeout(r, 40));

    assert.equal(mock.createdTasks.length, 1);
    assert.equal(mock.createdTasks[0].opts.select, false, '外部会话建 thread 不应切换当前选中');
    assert.equal(mock.sentPrompts.length, 1);
    const p1 = mock.sentPrompts[0];
    assert.equal(p1.threadId, mock.createdTasks[0].threadId);
    assert.match(String(p1.text), /<im-context>/);
    assert.match(String(p1.text), /chat_name: 研发架构群/);
    assert.match(String(p1.text), /reply_destination: current_chat/);
    assert.match(String(p1.text), /quoted_message:/);
    assert.match(String(p1.text), /Alice \(id:m_alice_1\): @bot 帮我看看线上 502 报错/);
    assert.match(String(p1.text), /Bob \(id:m_bob_2\): 我也复现了这个 timeout 问题/);
    assert.match(String(p1.text), /<attached-file/);
    assert.match(String(p1.text), /err\.log/);

    const grpReplies = sent.filter((s) => s.chatId === 'grp_dev');
    assert.equal(grpReplies.length, 1);
    assert.match(grpReplies[0].text, /nginx upstream 超时/);
    assert.equal(grpReplies[0].opts.replyTo, 'm_me_3');

    assert.equal(bridge.focus, null);
    assert.equal(bridge.isStickyActive(), false);

    const botReplyId = grpReplies[0].id;
    await bridge.onEvent({
      id: 'm_me_4',
      ts: Date.now() + 1000,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: '我', isSelf: true },
      replyTo: botReplyId,
      text: '那 upstream 超时调多少秒？',
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mock.sentPrompts.length, 2);
    assert.equal(mock.sentPrompts[1].threadId, p1.threadId, '引用 Bot 回复续聊应复用同一个群 thread');

    const beforeGrpCount = sent.filter((s) => s.chatId === 'grp_dev').length;
    await bridge.onEvent({
      id: 'm_me_5',
      ts: Date.now() + 2000,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot! 私密汇总刚才结论',
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sent.filter((s) => s.chatId === 'grp_dev').length, beforeGrpCount, '@bot! 私密 reply 不得发往群聊');
    const selfPrivReplies = sent.filter((s) => s.chatId === 'chat_self');
    assert.ok(selfPrivReplies.some((s) => s.text.includes('私密回复 · 来自「研发架构群」') && s.text.includes('nginx upstream 超时')));
    assert.match(String(mock.sentPrompts[2].text), /reply_destination: self_chat_private/);

    await bridge.onEvent({
      id: 'm_me_6',
      ts: Date.now() + 3000,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot status',
    });
    assert.equal(sent.filter((s) => s.chatId === 'grp_dev').length, beforeGrpCount);
    assert.ok(sent.some((s) => s.chatId === 'chat_self' && s.text.includes('来自「研发架构群」的指令结果')));

    await bridge.onEvent({
      id: 'm_me_7',
      ts: Date.now() + 4000,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot 触发审批检查日志',
    });
    await new Promise((r) => setTimeout(r, 30));
    const cardNotice = sent.find((s) => s.chatId === 'chat_self' && s.text.includes('来自「研发架构群」的审批'));
    assert.ok(cardNotice, '外部群触发的审批卡应只发到自聊');
    assert.equal(sent.filter((s) => s.chatId === 'grp_dev' && s.text.includes('执行检查')).length, 0);

    await bridge.onEvent({
      id: 'm_self_ok',
      ts: Date.now() + 5000,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: 'ok',
    });
    assert.equal(mock.responds.length, 1);
    assert.equal(mock.responds[0].behavior, 'allow');

    await new Promise((r) => setTimeout(r, 180));
    assert.ok(
      sent.some((s) => s.chatId === 'grp_dev' && s.text.includes('日志显示端口被占用')),
      '自聊批准完成后最终回复应回到原群聊',
    );
  } finally {
    await bridge.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('imContextPlugin 保持按 chatId 隔离并支持通过通道 getMessage 回溯历史', async () => {
  const now = Date.now();
  const remoteHistory: Record<string, InboundEvent[]> = {
    grp_dev: [
      { id: 'r_1', ts: now - 3000, chat: { id: 'grp_dev', type: 'group', name: '研发群' }, sender: { id: 'alice', name: 'Alice', isSelf: false }, text: '老消息：Redis 池配置为 64' },
      { id: 'r_2', ts: now - 2000, chat: { id: 'grp_dev', type: 'group', name: '研发群' }, sender: { id: 'bob', name: 'Bob', isSelf: false }, text: '收到，准备压测' },
    ],
    dm_secret: [
      { id: 's_1', ts: now - 2500, chat: { id: 'dm_secret', type: 'direct', name: 'SecretDM' }, sender: { id: 'other', name: 'Other', isSelf: false }, text: '绝密私聊内容 Redis_Secret_XYZ' },
    ],
  };

  const mockChannel = defineChannelPlugin({
    name: 'hist-mock',
    capabilities: { history: true },
    create() {
      return {
        async start() {},
        async send() { return 'out_1'; },
        async stop() {},
        async getMessage(chatId: string, msgId: string) {
          return (remoteHistory[chatId] ?? []).find((m) => m.id === msgId) ?? null;
        },
        async getHistory(chatId: string, { limit = 30, beforeMsgId } = {}) {
          const arr = remoteHistory[chatId] ?? [];
          if (!beforeMsgId) return arr.slice(-limit);
          const idx = arr.findIndex((m) => m.id === beforeMsgId);
          return idx >= 0 ? arr.slice(Math.max(0, idx - limit), idx) : [];
        },
      };
    },
  });

  const kernel = new Kernel({ config: { web: { host: '127.0.0.1', port: 0 }, chats: {} } as RawConfig });
  kernel.use(webPlugin);
  kernel.use(mockChannel);
  kernel.use(imContextPlugin);
  kernel.use(inspectorPlugin);
  await kernel.start();

  try {
    const web = kernel.get<WebServer>('web');
    const imContext = kernel.get<ImContextService>('imContext');
    const { port } = web.server!.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    imContext.recordInbound({
      id: 'live_3',
      ts: now - 1000,
      chat: { id: 'grp_dev', type: 'group', name: '研发群' },
      sender: { id: 'me', name: '我', isSelf: true },
      replyTo: 'r_1',
      text: '@bot 之前 Redis 池设的多少？',
    });

    const ctx = await imContext.buildPromptContext({
      ev: {
        id: 'live_3',
        ts: now - 1000,
        chat: { id: 'grp_dev', type: 'group', name: '研发群' },
        sender: { id: 'me', name: '我', isSelf: true },
        replyTo: 'r_1',
        text: '@bot 之前 Redis 池设的多少？',
      },
      contextWindow: 15,
    });
    assert.match(ctx.header, /老消息：Redis 池配置为 64/, '应通过 channel.getMessage 自动补全引用消息');
    assert.doesNotMatch(ctx.header, /more_context_api|\/api\/im-context/);
    assert.doesNotMatch(ctx.header, /Redis_Secret_XYZ/, '绝不可泄漏其他会话内容');

    const hist = await imContext.getHistory('grp_dev', { limit: 10 });
    assert.ok(hist.some((m) => m.id === 'r_1'));
    assert.equal(hist.some((m) => m.text.includes('Redis_Secret_XYZ')), false);

    await kernel.get<ChannelAdapter>('channel').send('grp_dev', 'telemetry probe');
    const dbg = await fetch(`${base}/api/debug/events`).then((r) => r.json()) as { events: Array<Record<string, unknown>> };
    assert.ok(dbg.events.some((e) => e.source === 'channel' && e.type === 'outbound' && e.chatId === 'grp_dev'));
  } finally {
    await kernel.stop();
  }
});

test('chats 白名单/黑名单/self_only 策略与 WebSimTransport 多会话接口', async () => {
  const mock = makeMockHarness();
  const { transport } = makeMockTransport();
  const bridge = new OpenMausBotBridge({
    client: mock.client,
    transport,
    chats: { mode: 'owner_everywhere', denyChatIds: ['grp_blocked'] },
  });
  await bridge.start();
  await bridge.onEvent({
    id: 'm_block',
    ts: Date.now(),
    chat: { id: 'grp_blocked', type: 'group', name: '禁止群' },
    sender: { id: 'me', name: '我', isSelf: true },
    text: '@bot hi',
  });
  assert.equal(mock.sentPrompts.length, 0, '黑名单群聊不应触发 Bot');
  await bridge.stop();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-sim-multi-'));
  const web = new WebServer({ host: '127.0.0.1', port: 0 });
  const sim = new WebSimTransport({
    web,
    filesDir: path.join(tmpDir, 'files'),
    historyFile: path.join(tmpDir, 'history.json'),
  });
  const inbound: InboundEvent[] = [];
  await sim.start((ev) => inbound.push(ev));
  await web.start();

  try {
    const base = `http://127.0.0.1:${(web.server!.address() as AddressInfo).port}`;
    assert.equal(sim.capabilities.history, true);

    const chatsRes = await fetch(`${base}/api/sim/chats`).then((r) => r.json()) as { ok: boolean; chats: unknown[] };
    assert.equal(chatsRes.ok, true);
    assert.equal(chatsRes.chats.length, 3);

    await fetch(`${base}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'grp_dev', sender: 'alice', text: '接口返回 504' }),
    });
    await fetch(`${base}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'dm_alice', sender: 'me', text: '私聊测一下' }),
    });

    assert.equal(inbound.length, 2);
    assert.equal(inbound[0].chat.id, 'grp_dev');
    assert.equal(inbound[0].sender.isSelf, false);
    assert.equal(inbound[0].sender.name, 'Alice');
    assert.equal(inbound[1].chat.id, 'dm_alice');
    assert.equal(inbound[1].sender.isSelf, true);

    const grpHist = await sim.getHistory('grp_dev');
    assert.equal(grpHist.length, 1);
    assert.equal(grpHist[0].text, '接口返回 504');
  } finally {
    await sim.stop();
    await web.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('自聊 Thread 防串台修复：resolveBot 漂移到外部群 thread 时自动保底自聊主线且隔离后台通知', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-drift-'));
  const threadMsgs: Record<string, OmbMessage[]> = {};
  const mock = makeMockHarness({
    onSendMessage(entry) {
      const reqId = `req_${mock.sentPrompts.length}`;
      threadMsgs[String(entry.threadId || '')] = [
        { id: reqId, role: 'user', text: String(entry.text || ''), sendId: entry.sendId ? String(entry.sendId) : undefined },
        { id: `bot_${reqId}`, role: 'bot', requestMessageId: reqId, kind: 'text', turnTerminal: true, text: 'done' },
      ];
      return { message: { id: reqId } };
    },
  });
  mock.client.getMessages = async (tid: string) => ({ messages: threadMsgs[tid] ?? [] });
  let serverBotThreadId = 'th_self_main';
  let emitSse: ((evt: OmbSseEvent) => unknown) | null = null;
  mock.client.resolveBot = async () => ({ id: 'bot_main', name: 'MausBot', threadId: serverBotThreadId });
  mock.client.subscribeEvents = (cb, { signal }: { signal?: AbortSignal } = {}) => {
    emitSse = cb;
    return new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
  };

  const { sent, sentFiles, transport } = makeMockTransport();
  const bridge = new OpenMausBotBridge({
    client: mock.client,
    transport,
    dataDir: tmpDir,
    sendRetries: 0,
  });
  await bridge.start();

  try {
    await bridge.onEvent({
      id: 'self_1',
      ts: Date.now(),
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot 自聊测试',
    });
    assert.equal(mock.sentPrompts.at(-1)!.threadId, 'th_self_main');
    assert.equal(bridge.focus?.threadId, 'th_self_main');

    await bridge.onEvent({
      id: 'grp_1',
      ts: Date.now() + 100,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot 群内问题',
    });
    const firstExtTid = String(mock.sentPrompts.at(-1)!.threadId);
    assert.match(firstExtTid, /^th_ext_/);

    await bridge.onEvent({
      id: 'grp_2',
      ts: Date.now() + 200,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot new 另一个群话题',
    });
    const secondExtTid = String(mock.sentPrompts.at(-1)!.threadId);
    assert.match(secondExtTid, /^th_ext_/);
    assert.notEqual(secondExtTid, firstExtTid);

    serverBotThreadId = firstExtTid;
    await bridge.onEvent({
      id: 'self_2',
      ts: Date.now() + 300,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot 回到自聊',
    });
    assert.equal(mock.sentPrompts.at(-1)!.threadId, 'th_self_main', '自聊绝不应误入外部群 thread');
    assert.equal(bridge.focus?.threadId, 'th_self_main');

    await new Promise((r) => setTimeout(r, 40));

    await emitSse!({
      kind: 'message',
      threadId: secondExtTid,
      message: { id: 'pro_img', role: 'bot', kind: 'screen', hasImage: true },
    });
    assert.equal(sentFiles.length, 0, '外部群后台异常截图不应误发自聊');

    await emitSse!({
      kind: 'message',
      threadId: secondExtTid,
      message: { id: 'pro_txt', role: 'bot', kind: 'text', turnTerminal: true, text: '后台任务完成' },
    });
    const lastPro = sent.at(-1);
    assert.ok(lastPro, '应向自聊发出后台主动通知');
    assert.equal(lastPro.chatId, 'chat_self');
    assert.match(lastPro.text, /🔔/);
    assert.match(lastPro.text, /来自「研发架构群」/);
    assert.doesNotMatch(lastPro.text, /私密回复/);

    await bridge.stop();
    const stateFile = path.join(tmpDir, 'bridge-state.json');
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
    saved.focus = { botId: 'bot_main', botName: 'MausBot', threadId: firstExtTid };
    fs.writeFileSync(stateFile, JSON.stringify(saved));

    const restarted = new OpenMausBotBridge({ client: mock.client, transport: makeMockTransport().transport, dataDir: tmpDir });
    assert.equal(restarted.focus?.threadId, 'th_self_main', '重启加载时应清洗已被外部 thread 污染的 focus');
    await restarted.stop();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('动态管群指令（chats/mute/allow/mode）、跨群只读汇总（summary）与持久化的端到端流程', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-optb-cmd-'));
  const threadMsgs: Record<string, OmbMessage[]> = {};
  const mock = makeMockHarness({
    onSendMessage(entry) {
      const reqId = `req_${mock.sentPrompts.length}`;
      threadMsgs[String(entry.threadId || '')] = [
        { id: reqId, role: 'user', text: String(entry.text || ''), sendId: entry.sendId ? String(entry.sendId) : undefined },
        { id: `bot_${reqId}`, role: 'bot', requestMessageId: reqId, kind: 'text', turnTerminal: true, text: '群纪要：1. 定位 502 超时；2. 需扩大连接池。' },
      ];
      return { message: { id: reqId } };
    },
  });
  mock.client.getMessages = async (tid: string) => ({ messages: threadMsgs[tid] ?? [] });
  const { sent, transport } = makeMockTransport();

  const bridge = new OpenMausBotBridge({
    client: mock.client,
    transport,
    dataDir: tmpDir,
    sendRetries: 0,
  });
  await bridge.start();

  try {
    await bridge.onEvent({
      id: 'g_a1',
      ts: Date.now() - 5000,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'alice', name: 'Alice', isSelf: false },
      text: '线上 502 需要确认 upstream 配置与连接池大小',
    });

    await bridge.onEvent({
      id: 's_chats',
      ts: Date.now(),
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot chats',
    });
    assert.match(sent.at(-1)!.text, /研发架构群.*grp_dev/);
    assert.match(sent.at(-1)!.text, /允许/);

    const beforePrompts = mock.sentPrompts.length;
    await bridge.onEvent({
      id: 's_sum',
      ts: Date.now() + 10,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot summary 研发架构群 20 重点看502',
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(mock.sentPrompts.length, beforePrompts + 1);
    assert.match(String(mock.sentPrompts.at(-1)!.text), /<im-context>[\s\S]*研发架构群[\s\S]*线上 502 需要确认 upstream 配置/);
    assert.match(String(mock.sentPrompts.at(-1)!.text), /重点看502/);
    assert.equal(sent.some((s) => s.chatId === 'grp_dev'), false, '跨群 summary 绝不向目标群发消息');
    assert.match(sent.at(-1)!.text, /群纪要：/);

    await bridge.onEvent({
      id: 's_bare_summary',
      ts: Date.now() + 20,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot 汇总',
    });
    assert.match(sent.at(-1)!.text, /用法：.*summary/);

    await bridge.onEvent({
      id: 's_mute',
      ts: Date.now() + 30,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot mute 研发架构群',
    });
    assert.match(sent.at(-1)!.text, /已静音「研发架构群」/);

    const promptCountBeforeMuted = mock.sentPrompts.length;
    await bridge.onEvent({
      id: 'g_muted_call',
      ts: Date.now() + 40,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot 在静音期间不要触发',
    });
    assert.equal(mock.sentPrompts.length, promptCountBeforeMuted, '静音群内 @bot 不应触发');

    await bridge.stop();
    const bridge2 = new OpenMausBotBridge({
      client: mock.client,
      transport: makeMockTransport().transport,
      dataDir: tmpDir,
      sendRetries: 0,
    });
    await bridge2.start();
    assert.equal(bridge2.getChatPolicy().muted.includes('grp_dev'), true);

    await bridge2.onEvent({
      id: 's_allow',
      ts: Date.now() + 50,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot unmute grp_dev',
    });
    assert.equal(bridge2.getChatPolicy().muted.includes('grp_dev'), false);

    await bridge2.onEvent({
      id: 's_mode_self',
      ts: Date.now() + 60,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot chats self',
    });
    assert.equal(bridge2.getChatPolicy().mode, 'self_only');
    await bridge2.onEvent({
      id: 's_mode_reset',
      ts: Date.now() + 70,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot chats reset',
    });
    assert.equal(bridge2.getChatPolicy().mode, 'owner_everywhere');
    await bridge2.stop();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('/api/debug/events 过滤、/debug UI 与 /sim 撤回渲染校验', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-att-api-'));
  let handler: ((rawMsg: unknown) => void) | null = null;
  const mockChannelPlugin = defineChannelPlugin({
    name: 'att-mock',
    capabilities: { markdown: true, files: false, images: false, history: false },
    create() {
      return {
        async start(cb) { handler = cb; },
        async send() { return 'out_1'; },
        async stop() {},
      };
    },
  });

  const kernel = new Kernel({ config: { web: { host: '127.0.0.1', port: 0 }, dataDir: tmpDir, chats: {} } as RawConfig });
  kernel.use(webPlugin);
  kernel.use(mockChannelPlugin);
  kernel.use(imContextPlugin);
  kernel.use(inspectorPlugin);
  await kernel.start();

  try {
    const web = kernel.get<WebServer>('web');
    const imContext = kernel.get<ImContextService>('imContext');
    const channel = kernel.get<ChannelAdapter>('channel');
    await channel.start((ev) => imContext.recordInbound(ev as Partial<InboundEvent>), {});
    const base = `http://127.0.0.1:${(web.server!.address() as AddressInfo).port}`;

    await handler!({
      id: 'm_log',
      ts: Date.now() - 2000,
      chat: { id: 'grp_dev', type: 'group', name: '研发群' },
      sender: { id: 'alice', name: 'Alice', isSelf: false },
      text: '附件日志见上一条',
    });
    await handler!({
      id: 'm_other',
      ts: Date.now(),
      chat: { id: 'dm_alice', type: 'direct', name: 'Alice' },
      sender: { id: 'alice', name: 'Alice', isSelf: false },
      text: '私聊消息',
    });

    const grpEv = await fetch(`${base}/api/debug/events?chatId=grp_dev&source=channel`).then((r) => r.json()) as {
      ok: boolean;
      filter: { chatId: string };
      events: Array<Record<string, unknown>>;
    };
    assert.equal(grpEv.ok, true);
    assert.equal(grpEv.filter.chatId, 'grp_dev');
    assert.ok(grpEv.events.length >= 1);
    assert.equal(grpEv.events.every((e) => e.chatId === 'grp_dev' && e.source === 'channel'), true);

    const typedEv = await fetch(`${base}/api/debug/events?type=inbound`).then((r) => r.json()) as {
      ok: boolean;
      filter: { type: string };
      events: Array<Record<string, unknown>>;
    };
    assert.equal(typedEv.ok, true);
    assert.equal(typedEv.filter.type, 'inbound');
    assert.ok(typedEv.events.length >= 2);
    assert.equal(typedEv.events.every((e) => e.type === 'inbound'), true);

    const dbgPage = await fetch(`${base}/debug`);
    assert.equal(dbgPage.status, 200);
    const dbgHtml = await dbgPage.text();
    assert.match(dbgHtml, /多会话上下文与隔离 Thread/);
    assert.doesNotMatch(dbgHtml, /定时跨群纪要/);
    assert.match(dbgHtml, /id="typeFilter"/);

    const simHtml = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/index.html'), 'utf8');
    assert.match(simHtml, /function handleRecall/);
    assert.match(simHtml, /post\('\/recall'/);
    assert.equal(typeof inQuietHours, 'function');
    assert.equal(typeof extractCardInfo, 'function');
    assert.equal(parseStartMention('@bot status')?.isDefault, true);
    assert.equal(parseInlineTriggerMention('@Alice 让 @bot 查下')?.mention, 'bot');
  } finally {
    await kernel.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
