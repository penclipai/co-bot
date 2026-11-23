import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Kernel } from '../src/core/kernel.js';
import { defineChannelPlugin } from '../src/core/channel-contract.js';
import { webPlugin } from '../src/plugins/web.js';
import { imContextPlugin } from '../src/plugins/im-context.js';
import { inspectorPlugin } from '../src/plugins/inspector.js';
import { extractCardInfo, inQuietHours, OpenMausBotBridge } from '../src/openmausbot/bridge.js';
import { parseInlineTriggerMention, parseStartMention } from '../src/openmausbot/mentions.js';
import { WebSimTransport } from '../src/im/sim.js';
import { WebServer } from '../src/web/server.js';

function makeMockHarness({ onCreateTask, onSendMessage, onRespond, onExport } = {}) {
  const sentPrompts = [];
  const createdTasks = [];
  const responds = [];
  let seq = 0;

  return {
    sentPrompts,
    createdTasks,
    responds,
    client: {
      baseUrl: 'http://127.0.0.1:8799',
      async health() { return { ok: true, version: '0.1.173', box: 'off' }; },
      async listBots() {
        return {
          bots: [{
            id: 'bot_main',
            name: 'MausBot',
            chiefOfStaff: true,
            threadId: 'th_self_main',
            mainThreadId: 'th_self_main',
            tasks: [{ id: 'th_self_main', threadId: 'th_self_main', title: '自聊主线' }],
          }],
          groups: [],
        };
      },
      async resolveBot(name) {
        if (!name || name.toLowerCase() === 'mausbot') {
          return { id: 'bot_main', name: 'MausBot', threadId: 'th_self_main' };
        }
        return null;
      },
      async createTask(botId, opts = {}) {
        const tid = `th_ext_${++seq}`;
        createdTasks.push({ botId, threadId: tid, opts });
        onCreateTask?.({ botId, threadId: tid, opts });
        return {
          bot: { id: botId, name: 'MausBot', threadId: 'th_self_main' },
          task: { id: tid, threadId: tid, title: opts.title || '会话' },
        };
      },
      async uploadFile(name, buf, mime) {
        return { path: `/tmp/omb/${name}`, size: buf.length, mime };
      },
      async uploadImage(buf, mime) {
        return { path: `/tmp/omb/img.png`, size: buf.length, mime };
      },
      async sendMessage(botId, payload) {
        const entry = { botId, ...payload };
        sentPrompts.push(entry);
        if (onSendMessage) return onSendMessage(entry);
        return { message: { id: `req_${++seq}` } };
      },
      async getMessages() {
        return { messages: [] };
      },
      async getJob() {
        return { state: 'idle', since: 1, version: 1 };
      },
      async respond(threadId, payload) {
        responds.push({ threadId, ...payload });
        return onRespond ? onRespond({ threadId, ...payload }) : { ok: true };
      },
      async exportThread(threadId) {
        return onExport ? onExport(threadId) : { name: 'ext.md', text: '# Exported thread' };
      },
      async subscribeEvents(_cb, { signal } = {}) {
        if (!signal) return new Promise(() => {});
        if (signal.aborted) return;
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    },
  };
}

function makeMockTransport(downloads = {}) {
  const sent = [];
  const sentFiles = [];
  let n = 0;
  let handler = null;
  return {
    sent,
    sentFiles,
    transport: {
      selfChatId: 'chat_self',
      capabilities: {
        markdown: true,
        files: true,
        images: true,
        replyTo: true,
        actions: true,
        history: false,
      },
      async start(fn) { handler = fn; },
      async send(chatId, text, opts = {}) {
        const id = `im_out_${++n}`;
        sent.push({ id, chatId, text, opts });
        return id;
      },
      async sendFile(chatId, file, opts = {}) {
        const id = `im_file_${++n}`;
        sentFiles.push({ id, chatId, file, opts });
        return id;
      },
      async download(att, savePath) {
        const content = downloads[att.id] ?? `mock:${att.name}`;
        fs.mkdirSync(path.dirname(savePath), { recursive: true });
        fs.writeFileSync(savePath, content);
      },
      async stop() {},
      emit(ev) { return handler?.(ev); },
    },
  };
}

test('任何群/私聊仅本人触发、携带引用+附件+历史并隔离 Thread 与卡片隐私', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-multichat-'));
  const messagesByThread = {};
  let permApproved = false;
  let permThreadId = null;
  let notifyApproved = null;
  const mock = makeMockHarness({
    onSendMessage(entry) {
      const reqId = `req_${mock.sentPrompts.length}`;
      const tid = entry.threadId;
      if (entry.text.includes('触发审批')) {
        permThreadId = tid;
        messagesByThread[tid] = [
          { id: reqId, role: 'user', text: entry.text, sendId: entry.sendId },
          {
            id: `omb_card_${reqId}`,
            role: 'bot',
            requestMessageId: reqId,
            kind: 'text',
            card: { requestId: 'perm_1', kind: 'permission', title: '执行检查', toolName: 'bash', detail: 'cat /tmp/app.log' },
          },
        ];
      } else {
        messagesByThread[tid] = [
          { id: reqId, role: 'user', text: entry.text, sendId: entry.sendId },
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
      const list = messagesByThread[threadId] ?? [];
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
  mock.client.getMessages = async (threadId) => ({ messages: messagesByThread[threadId] ?? [] });
  mock.client.getJob = async (threadId, { wait = 0, signal } = {}) => {
    if (threadId === permThreadId && !permApproved) {
      if (wait > 0 && !signal?.aborted) {
        await new Promise((resolve) => {
          notifyApproved = resolve;
          signal?.addEventListener('abort', resolve, { once: true });
        });
      }
      if (!permApproved) {
        return { state: 'needs-input', needsInput: ['perm_1'], since: 1, version: 1 };
      }
    }
    return { state: 'idle', since: 2, version: 2 };
  };

  const { sent, sentFiles, transport } = makeMockTransport({
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
    // 1. 其他群成员先发 @bot 与带附件消息：只能入缓存，绝不能触发 Bot
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

    // 2. 本人引用 Alice 消息触发 @bot：应创建独立 thread (select:false)、带 <im-context>+quoted+附件、静音中间进度、原地回复
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
    assert.match(p1.text, /<im-context>/);
    assert.match(p1.text, /chat_name: 研发架构群/);
    assert.match(p1.text, /reply_destination: current_chat/);
    assert.match(p1.text, /quoted_message:/);
    assert.match(p1.text, /Alice \(id:m_alice_1\): @bot 帮我看看线上 502 报错/);
    assert.match(p1.text, /Bob \(id:m_bob_2\): 我也复现了这个 timeout 问题/);
    assert.match(p1.text, /<attached-file/);
    assert.match(p1.text, /err\.log/);

    // 群内原地仅一条清晰终稿（中间 bubble 已静音），且引用本人触发消息 m_me_3
    const grpReplies = sent.filter((s) => s.chatId === 'grp_dev');
    assert.equal(grpReplies.length, 1);
    assert.match(grpReplies[0].text, /nginx upstream 超时/);
    assert.equal(grpReplies[0].opts.replyTo, 'm_me_3');

    // 自聊焦点与粘性完全未受外部群影响
    assert.equal(bridge.focus, null);
    assert.equal(bridge.isStickyActive(), false);

    // 3. 在群里引用 Bot 回复追问（无需重复打 @bot），应沿用同一个群隔离 thread
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

    // 4. @bot! 私密模式：回复只进自聊，绝不发到群里
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
    assert.match(mock.sentPrompts[2].text, /reply_destination: self_chat_private/);

    // 5. 敏感指令（@bot bots / @bot export）从群里触发时重定向到自聊，不泄露到群里
    await bridge.onEvent({
      id: 'm_me_6',
      ts: Date.now() + 3000,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot export',
    });
    assert.equal(sent.filter((s) => s.chatId === 'grp_dev').length, beforeGrpCount);
    assert.ok(sentFiles.every((f) => f.chatId === 'chat_self'), '敏感 export 文件应发往自聊而非群聊');
    assert.ok(sent.some((s) => s.chatId === 'chat_self' && s.text.includes('来自「研发架构群」的指令结果')));

    // 6. 审批卡路由到自聊，自聊输入 ok 批准后结果按约定回到原群
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

    // 在自聊回复 ok 批准
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

test('imContextPlugin 提供按 chatId 强隔离的只读 HTTP 接口并支持通道历史回溯', async () => {
  const remoteHistory = {
    grp_dev: [
      { id: 'r_1', ts: 1000, chat: { id: 'grp_dev', type: 'group', name: '研发群' }, sender: { id: 'alice', name: 'Alice', isSelf: false }, text: '老消息：Redis 池配置为 64' },
      { id: 'r_2', ts: 2000, chat: { id: 'grp_dev', type: 'group', name: '研发群' }, sender: { id: 'bob', name: 'Bob', isSelf: false }, text: '收到，准备压测' },
    ],
    dm_secret: [
      { id: 's_1', ts: 1500, chat: { id: 'dm_secret', type: 'direct', name: 'SecretDM' }, sender: { id: 'other', name: 'Other', isSelf: false }, text: '绝密私聊内容 Redis_Secret_XYZ' },
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
        async getMessage(chatId, msgId) {
          return (remoteHistory[chatId] ?? []).find((m) => m.id === msgId) ?? null;
        },
        async getHistory(chatId, { limit = 30, beforeMsgId } = {}) {
          const arr = remoteHistory[chatId] ?? [];
          if (!beforeMsgId) return arr.slice(-limit);
          const idx = arr.findIndex((m) => m.id === beforeMsgId);
          return idx >= 0 ? arr.slice(Math.max(0, idx - limit), idx) : [];
        },
        async searchHistory(chatId, query, { limit = 10 } = {}) {
          const q = String(query || '').toLowerCase();
          return (remoteHistory[chatId] ?? []).filter((m) => m.text.toLowerCase().includes(q)).slice(-limit);
        },
      };
    },
  });

  const kernel = new Kernel({ config: { web: { host: '127.0.0.1', port: 0 }, chats: {} } });
  kernel.use(webPlugin);
  kernel.use(mockChannel);
  kernel.use(imContextPlugin);
  kernel.use(inspectorPlugin);
  await kernel.start();

  try {
    const web = kernel.get('web');
    const imContext = kernel.get('imContext');
    const port = web.server.address().port;
    const base = `http://127.0.0.1:${port}`;

    // 先写入实时消息到内存（不含 r_1 / r_2，模拟内存尚未看到的更早历史）
    imContext.recordInbound({
      id: 'live_3',
      ts: 3000,
      chat: { id: 'grp_dev', type: 'group', name: '研发群' },
      sender: { id: 'me', name: '我', isSelf: true },
      replyTo: 'r_1',
      text: '@bot 之前 Redis 池设的多少？',
    });

    const ctx = await imContext.buildPromptContext({
      ev: {
        id: 'live_3',
        ts: 3000,
        chat: { id: 'grp_dev', type: 'group', name: '研发群' },
        sender: { id: 'me', name: '我', isSelf: true },
        replyTo: 'r_1',
        text: '@bot 之前 Redis 池设的多少？',
      },
      contextWindow: 15,
    });
    assert.match(ctx.header, /老消息：Redis 池配置为 64/, '应通过 channel.getMessage 自动补全引用消息');
    assert.match(ctx.header, /http:\/\/127\.0\.0\.1:\d+\/api\/im-context\/messages\?token=/);

    const token = imContext.issueScopeToken('grp_dev');

    // 即使攻击者在 query 中传入 chatId=dm_secret，仍只能读到 token 绑定的 grp_dev
    const msgRes = await fetch(`${base}/api/im-context/messages?token=${encodeURIComponent(token)}&chatId=dm_secret&limit=10`).then((r) => r.json());
    assert.equal(msgRes.ok, true);
    assert.equal(msgRes.chatId, 'grp_dev');
    assert.equal(msgRes.items.some((m) => m.text.includes('Redis_Secret_XYZ')), false, '绝不可越权访问 dm_secret');

    const searchRes = await fetch(`${base}/api/im-context/search?token=${encodeURIComponent(token)}&q=Redis`).then((r) => r.json());
    assert.equal(searchRes.ok, true);
    assert.equal(searchRes.chatId, 'grp_dev');
    assert.ok(searchRes.items.some((m) => m.id === 'r_1'));
    assert.equal(searchRes.items.some((m) => m.text.includes('Secret')), false);

    // 单个消息检索与跨会话屏蔽
    const crossMsg = await fetch(`${base}/api/im-context/message?token=${encodeURIComponent(token)}&msgId=s_1`);
    const crossBody = await crossMsg.json();
    assert.equal(crossMsg.status, 404);
    assert.equal(crossBody.ok, false);

    // 非法 token 拒绝访问
    const badRes = await fetch(`${base}/api/im-context/messages?token=ctx_invalid.sig`);
    assert.equal(badRes.status, 401);
    assert.equal((await badRes.json()).ok, false);

    // HEAD 探测应返回 200 与正确 Content-Type / Content-Length（兼容 DuckDB data_load）
    const headOk = await fetch(`${base}/api/im-context/messages?token=${encodeURIComponent(token)}&limit=5`, { method: 'HEAD' });
    assert.equal(headOk.status, 200);
    assert.match(headOk.headers.get('content-type') || '', /application\/json/);
    assert.ok(Number(headOk.headers.get('content-length')) > 0);
    assert.equal(await headOk.text(), '');

    const headBad = await fetch(`${base}/api/im-context/messages?token=bad`, { method: 'HEAD' });
    assert.equal(headBad.status, 401);

    // 验证 /api/debug/events 保留 chatId
    await kernel.get('channel').send('grp_dev', 'telemetry probe');
    const dbg = await fetch(`${base}/api/debug/events`).then((r) => r.json());
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

  // WebSimTransport 多会话收发与 history API 验证
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-sim-multi-'));
  const web = new WebServer({ host: '127.0.0.1', port: 0 });
  const sim = new WebSimTransport({
    web,
    filesDir: path.join(tmpDir, 'files'),
    historyFile: path.join(tmpDir, 'history.json'),
  });
  const inbound = [];
  await sim.start((ev) => inbound.push(ev));
  await web.start();

  try {
    const base = `http://127.0.0.1:${web.server.address().port}`;
    assert.equal(sim.capabilities.history, true);

    const chatsRes = await fetch(`${base}/api/sim/chats`).then((r) => r.json());
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
    const hits = await sim.searchHistory('grp_dev', '504');
    assert.equal(hits.length, 1);
  } finally {
    await sim.stop();
    await web.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('自聊 Thread 防串台修复：resolveBot 漂移到外部群 thread 时自动保底自聊主线且隔离后台通知', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-drift-'));
  const threadMsgs = {};
  const mock = makeMockHarness({
    onSendMessage(entry) {
      const reqId = `req_${mock.sentPrompts.length}`;
      threadMsgs[entry.threadId] = [
        { id: reqId, role: 'user', text: entry.text, sendId: entry.sendId },
        { id: `bot_${reqId}`, role: 'bot', requestMessageId: reqId, kind: 'text', turnTerminal: true, text: 'done' },
      ];
      return { message: { id: reqId } };
    },
  });
  mock.client.getMessages = async (tid) => ({ messages: threadMsgs[tid] ?? [] });
  let serverBotThreadId = 'th_self_main';
  let emitSse = null;
  mock.client.resolveBot = async () => ({ id: 'bot_main', name: 'MausBot', threadId: serverBotThreadId });
  mock.client.subscribeEvents = (cb, { signal } = {}) => {
    emitSse = cb;
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', resolve, { once: true });
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
    // 1. 先在自聊建立自聊主线
    await bridge.onEvent({
      id: 'self_1',
      ts: Date.now(),
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot 自聊测试',
    });
    assert.equal(mock.sentPrompts.at(-1).threadId, 'th_self_main');
    assert.equal(bridge.focus.threadId, 'th_self_main');

    // 2. 在外部群触发并执行 @bot new（产生 th_ext_1 与 th_ext_2 两个外部 thread）
    await bridge.onEvent({
      id: 'grp_1',
      ts: Date.now() + 100,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot 群内问题',
    });
    const firstExtTid = mock.sentPrompts.at(-1).threadId;
    assert.match(firstExtTid, /^th_ext_/);

    await bridge.onEvent({
      id: 'grp_2',
      ts: Date.now() + 200,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot new 另一个群话题',
    });
    const secondExtTid = mock.sentPrompts.at(-1).threadId;
    assert.match(secondExtTid, /^th_ext_/);
    assert.notEqual(secondExtTid, firstExtTid);

    // 3. 模拟 OpenMausBot 服务端 resolveBot 意外漂移返回了旧外部群 thread (th_ext_1)
    serverBotThreadId = firstExtTid;
    await bridge.onEvent({
      id: 'self_2',
      ts: Date.now() + 300,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot 回到自聊',
    });
    assert.equal(mock.sentPrompts.at(-1).threadId, 'th_self_main', '自聊绝不应误入外部群 thread');
    assert.equal(bridge.focus.threadId, 'th_self_main');

    // 等待活跃轮次自动收口后再注入非用户触发的后台主动消息（#handleProactiveMessage）
    await new Promise((r) => setTimeout(r, 40));

    // 4. 外部群后台主动消息：截图不乱发自聊，文字只标「🔔 ...（来自「研发架构群」）」不带误导性的「私密回复」
    await emitSse({
      kind: 'message',
      threadId: secondExtTid,
      message: { id: 'pro_img', role: 'bot', kind: 'screen', hasImage: true },
    });
    assert.equal(sentFiles.length, 0, '外部群后台异常截图不应误发自聊');

    await emitSse({
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

    // 重启恢复自检：即使磁盘 focus 被外部 thread 污染，重启后也能自动清洗
    await bridge.stop();
    const stateFile = path.join(tmpDir, 'bridge-state.json');
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
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
  const threadMsgs = {};
  const mock = makeMockHarness({
    onSendMessage(entry) {
      const reqId = `req_${mock.sentPrompts.length}`;
      threadMsgs[entry.threadId] = [
        { id: reqId, role: 'user', text: entry.text, sendId: entry.sendId },
        { id: `bot_${reqId}`, role: 'bot', requestMessageId: reqId, kind: 'text', turnTerminal: true, text: '群纪要：1. 定位 502 超时；2. 需扩大连接池。' },
      ];
      return { message: { id: reqId } };
    },
  });
  mock.client.getMessages = async (tid) => ({ messages: threadMsgs[tid] ?? [] });
  const { sent, transport } = makeMockTransport();

  const bridge = new OpenMausBotBridge({
    client: mock.client,
    transport,
    dataDir: tmpDir,
    sendRetries: 0,
  });
  await bridge.start();

  try {
    // 先由 Alice 在研发架构群发言写入上下文
    await bridge.onEvent({
      id: 'g_a1',
      ts: Date.now() - 5000,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'alice', name: 'Alice', isSelf: false },
      text: '线上 502 需要确认 upstream 配置与连接池大小',
    });

    // 1. 自聊查看群列表
    await bridge.onEvent({
      id: 's_chats',
      ts: Date.now(),
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot chats',
    });
    assert.match(sent.at(-1).text, /研发架构群.*grp_dev/);
    assert.match(sent.at(-1).text, /允许/);

    // 2. 跨群只读汇总：零打扰（grp_dev 无任何发送）、摘要回到自聊，且裸 @bot 汇总仍触发 quietQueue 汇总
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
    assert.match(mock.sentPrompts.at(-1).text, /<im-context>[\s\S]*研发架构群[\s\S]*线上 502 需要确认 upstream 配置/);
    assert.match(mock.sentPrompts.at(-1).text, /重点看502/);
    assert.equal(sent.some((s) => s.chatId === 'grp_dev'), false, '跨群 summary 绝不向目标群发消息');
    assert.match(sent.at(-1).text, /群纪要：/);

    // 别名 `@bot 汇总 研发架构群` 走跨群汇总，而裸 `@bot 汇总` 仍走静默消息汇总
    await bridge.onEvent({
      id: 's_bare_digest',
      ts: Date.now() + 20,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot 汇总',
    });
    assert.match(sent.at(-1).text, /当前没有静默积压消息/);

    // 3. 动态静音 & 重启持久化 & 解除静音 & self_only 模式切换
    await bridge.onEvent({
      id: 's_mute',
      ts: Date.now() + 30,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot chat mute 研发架构群',
    });
    assert.match(sent.at(-1).text, /已静音「研发架构群」/);

    const promptCountBeforeMuted = mock.sentPrompts.length;
    await bridge.onEvent({
      id: 'g_muted_call',
      ts: Date.now() + 40,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot 在静音期间不要触发',
    });
    assert.equal(mock.sentPrompts.length, promptCountBeforeMuted, '静音群内 @bot 不应触发');

    // 验证静音规则持久化到磁盘、重启后依然生效
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
      text: '@bot chat allow grp_dev',
    });
    assert.equal(bridge2.getChatPolicy().muted.includes('grp_dev'), false);

    // 切为 self_only 再重置
    await bridge2.onEvent({
      id: 's_mode_self',
      ts: Date.now() + 60,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot chat mode self_only',
    });
    assert.equal(bridge2.getChatPolicy().mode, 'self_only');
    await bridge2.onEvent({
      id: 's_mode_reset',
      ts: Date.now() + 70,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot chat reset',
    });
    assert.equal(bridge2.getChatPolicy().mode, 'owner_everywhere');
    await bridge2.stop();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('scoped /api/im-context/attachment 文本脱敏与二进制下载 + /api/status 多会话字段与 /api/debug/events 过滤', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-att-api-'));
  const filesByAttId = {
    att_txt_1: Buffer.from('ERROR token=sk-secretkey1234567890 upstream timed out\n', 'utf8'),
    att_png_1: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    att_other_1: Buffer.from('secret from other chat', 'utf8'),
  };
  let handler = null;
  const mockChannelPlugin = defineChannelPlugin({
    name: 'att-mock',
    capabilities: { files: true, images: true, history: true },
    create() {
      return {
        async start(cb) { handler = cb; },
        async send() { return 'out_1'; },
        async sendFile() { return 'f_1'; },
        async download(att, savePath) {
          const buf = filesByAttId[att.id];
          if (!buf) throw new Error('not found');
          fs.mkdirSync(path.dirname(savePath), { recursive: true });
          fs.writeFileSync(savePath, buf);
        },
        async stop() {},
      };
    },
  });

  const kernel = new Kernel({ config: { web: { host: '127.0.0.1', port: 0 }, dataDir: tmpDir, chats: {} } });
  kernel.use(webPlugin);
  kernel.use(mockChannelPlugin);
  kernel.use(imContextPlugin);
  kernel.use(inspectorPlugin);
  await kernel.start();

  try {
    const web = kernel.get('web');
    const imContext = kernel.get('imContext');
    const channel = kernel.get('channel');
    await channel.start((ev) => imContext.recordInbound(ev));
    const base = `http://127.0.0.1:${web.server.address().port}`;

    await handler({
      id: 'm_log',
      ts: Date.now() - 2000,
      chat: { id: 'grp_dev', type: 'group', name: '研发群' },
      sender: { id: 'alice', name: 'Alice', isSelf: false },
      text: '附件日志见上一条',
      attachments: [{ id: 'att_txt_1', msgId: 'm_log', name: 'err.log', mime: 'text/plain', size: filesByAttId.att_txt_1.length }],
    });
    await handler({
      id: 'm_png',
      ts: Date.now() - 1000,
      chat: { id: 'grp_dev', type: 'group', name: '研发群' },
      sender: { id: 'bob', name: 'Bob', isSelf: false },
      text: '',
      attachments: [{ id: 'att_png_1', msgId: 'm_png', name: 'shot.png', mime: 'image/png', size: filesByAttId.att_png_1.length }],
    });
    await handler({
      id: 'm_other',
      ts: Date.now(),
      chat: { id: 'dm_alice', type: 'direct', name: 'Alice' },
      sender: { id: 'alice', name: 'Alice', isSelf: false },
      text: '私聊文件',
      attachments: [{ id: 'att_other_1', msgId: 'm_other', name: 'secret.txt', mime: 'text/plain', size: filesByAttId.att_other_1.length }],
    });

    const urls = imContext.issueContextApiUrls('grp_dev');
    assert.ok(urls.attachmentUrl.includes('/api/im-context/attachment?token='));

    // 1. 文本附件：返回内容、路径且敏感 token 已脱敏
    const txtRes = await fetch(`${urls.attachmentUrl}&msgId=m_log`).then((r) => r.json());
    assert.equal(txtRes.ok, true);
    assert.equal(txtRes.kind, 'text');
    assert.match(txtRes.text, /upstream timed out/);
    assert.doesNotMatch(txtRes.text, /sk-secretkey1234567890/);
    assert.match(txtRes.text, /\[REDACTED\]/);
    assert.ok(fs.existsSync(txtRes.savedPath));

    // 2. 二进制图片附件：落盘并返回 savedPath + kind: 'binary'
    const pngRes = await fetch(`${urls.attachmentUrl}&msgId=m_png`).then((r) => r.json());
    assert.equal(pngRes.ok, true);
    assert.equal(pngRes.kind, 'binary');
    assert.equal(pngRes.attachment.name, 'shot.png');
    assert.ok(fs.existsSync(pngRes.savedPath));

    // 3. 跨会话拒绝与非法令牌拒绝
    const cross = await fetch(`${urls.attachmentUrl}&msgId=m_other`);
    assert.equal(cross.status, 404);
    const bad = await fetch(`${base}/api/im-context/attachment?token=invalid&msgId=m_log`);
    assert.equal(bad.status, 401);

    // 4. HEAD 探测支持
    const headAtt = await fetch(`${urls.attachmentUrl}&msgId=m_log`, { method: 'HEAD' });
    assert.equal(headAtt.status, 200);

    // 5. /api/debug/events?chatId=...&source=...&type=... 过滤与 /debug、/sim UI 校验
    const grpEv = await fetch(`${base}/api/debug/events?chatId=grp_dev&source=channel`).then((r) => r.json());
    assert.equal(grpEv.ok, true);
    assert.equal(grpEv.filter.chatId, 'grp_dev');
    assert.ok(grpEv.events.length >= 2);
    assert.equal(grpEv.events.every((e) => e.chatId === 'grp_dev' && e.source === 'channel'), true);

    const typedEv = await fetch(`${base}/api/debug/events?type=inbound`).then((r) => r.json());
    assert.equal(typedEv.ok, true);
    assert.equal(typedEv.filter.type, 'inbound');
    assert.ok(typedEv.events.length >= 2);
    assert.equal(typedEv.events.every((e) => e.type === 'inbound'), true);

    const dbgPage = await fetch(`${base}/debug`);
    assert.equal(dbgPage.status, 200);
    const dbgHtml = await dbgPage.text();
    assert.match(dbgHtml, /多会话上下文与隔离 Thread/);
    assert.match(dbgHtml, /定时跨群纪要/);
    assert.match(dbgHtml, /id="typeFilter"/);

    // 验证 /sim 前端页面撤回渲染逻辑与 bridge 模块重导出兼容
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

test('复杂 @mention 与引用组合：裸 @bot+引用、句中触发、反引号忽略、引用后@同事不重触、出站 @ 脱敏与多 Bot 复核', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-mention-'));
  const threadMsgs = {};
  const mock = makeMockHarness({
    onSendMessage(entry) {
      const reqId = `req_${mock.sentPrompts.length}`;
      threadMsgs[entry.threadId] = [
        { id: reqId, role: 'user', text: entry.text, sendId: entry.sendId },
        {
          id: `bot_${reqId}`,
          role: 'bot',
          requestMessageId: reqId,
          kind: 'text',
          turnTerminal: true,
          text: entry.botId === 'bot_plum'
            ? 'Plum复核：建议顺便检查 keepalive_timeout。'
            : '请通知 @Alice 与 @所有人 今天 18:00 封板，也可找 @Plum，邮箱 dev@example.com，示例 `@bot`。',
        },
      ];
      return { message: { id: reqId } };
    },
  });
  mock.client.listBots = async () => ({
    bots: [
      { id: 'bot_main', name: 'MausBot', chiefOfStaff: true, threadId: 'th_self_main', tasks: [] },
      { id: 'bot_plum', name: 'Plum', chiefOfStaff: false, threadId: 'th_plum_main', tasks: [] },
    ],
    groups: [],
  });
  mock.client.resolveBot = async (name) => {
    const low = String(name || '').toLowerCase();
    if (!low || low === 'mausbot') return { id: 'bot_main', name: 'MausBot', threadId: 'th_self_main' };
    if (low === 'plum') return { id: 'bot_plum', name: 'Plum', threadId: 'th_plum_main' };
    return null;
  };
  mock.client.getMessages = async (tid) => ({ messages: threadMsgs[tid] ?? [] });

  const { sent, transport } = makeMockTransport();
  const bridge = new OpenMausBotBridge({
    client: mock.client,
    transport,
    dataDir: tmpDir,
    sendRetries: 0,
  });
  await bridge.start();

  try {
    // 1. 同事发 `@bot 提问` 不触发；本人仅发裸 `@bot` 引用同事该条消息 -> 直接转给 Bot 处理（不弹出 help）
    await bridge.onEvent({
      id: 'm_col_499',
      ts: Date.now() - 5000,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'alice', name: 'Alice', isSelf: false },
      text: '@bot nginx 报 499 是客户端断连吗？',
    });
    assert.equal(mock.sentPrompts.length, 0);

    await bridge.onEvent({
      id: 'm_me_bare_quote',
      ts: Date.now(),
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: '我', isSelf: true },
      replyTo: 'm_col_499',
      text: '@bot',
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(mock.sentPrompts.length, 1, '裸 @bot 引用同事消息应触发 OpenMausBot 而非返回 help');
    assert.match(mock.sentPrompts[0].text, /nginx 报 499 是客户端断连吗/);
    assert.match(mock.sentPrompts[0].text, /reply_policy:/);

    // 5. 验证外部群出站文本已将 @Alice/@所有人/@Plum 插 \u200B 防误触，保留 dev@example.com 与 `@bot`
    const grpReply = sent.find((s) => s.chatId === 'grp_dev');
    assert.ok(grpReply);
    assert.match(grpReply.text, /@\u200BAlice/);
    assert.match(grpReply.text, /@\u200B所有人/);
    assert.match(grpReply.text, /@\u200BPlum/);
    assert.match(grpReply.text, /dev@example\.com/);
    assert.match(grpReply.text, /`@bot`/);
    // 即使将该脱敏后的群回复当做入站引用/文本回放，也不会把 @\u200Bbot 当触发词重触
    await bridge.onEvent({
      id: 'm_replay_sanitized',
      ts: Date.now() + 10,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@\u200Bbot 不应被零宽字符假触发',
    });
    assert.equal(mock.sentPrompts.length, 1);

    // 2. 反引号 / 句中元讨论不误触；句首 `@Alice` + 句中 `@bot` 正常触发；句中 `@bot status` 不当作控制指令
    await bridge.onEvent({
      id: 'm_backtick',
      ts: Date.now() + 20,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '我们刚修完 `@bot` 的逻辑，也顺便提了「@bot」',
    });
    assert.equal(mock.sentPrompts.length, 1, '反引号与引号内的 @bot 不应误触');

    await bridge.onEvent({
      id: 'm_inline_status',
      ts: Date.now() + 30,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '我觉得 @bot status 这个功能在移动端挺好用的',
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mock.sentPrompts.length, 2, '句中提到 @bot 应作为普通对话而不是误执行 status 控制指令');

    await bridge.onEvent({
      id: 'm_inline_alice',
      ts: Date.now() + 40,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@Alice 别急，我让 @bot 帮我们核对一下日志',
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mock.sentPrompts.length, 3);
    assert.match(mock.sentPrompts[2].text, /@Alice 别急，我让 帮我们核对一下日志/);

    // 3. 引用 Bot 回复但改口 `@Alice` 叮嘱同事 -> 绝不重触 Bot
    await bridge.onEvent({
      id: 'm_quote_to_alice',
      ts: Date.now() + 50,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: '我', isSelf: true },
      replyTo: grpReply.id,
      text: '辛苦 @Alice 按上面说的改下超时',
    });
    assert.equal(mock.sentPrompts.length, 3, '引用 Bot 回复但显式 @同事时不应再重触 Bot');

    // 4. 引用 MausBot 回复并发 `@Plum 复核一下` -> 切到 Plum 且附带 MausBot 回复上下文
    await bridge.onEvent({
      id: 'm_handoff_plum',
      ts: Date.now() + 60,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: '我', isSelf: true },
      replyTo: grpReply.id,
      text: '@Plum 复核一下这条分析',
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mock.sentPrompts.length, 4);
    assert.equal(mock.sentPrompts[3].botId, 'bot_plum');
    assert.match(mock.sentPrompts[3].text, /quoted_message:/);
    assert.match(mock.sentPrompts[3].text, /18:00 封板/);

    // 6. `@bot!` 私密发回自聊时保留原始清晰 `@Alice`（不插 \u200B）
    await bridge.onEvent({
      id: 'm_priv_raw',
      ts: Date.now() + 70,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot! 帮我起草一句给 Alice 的提醒',
    });
    await new Promise((r) => setTimeout(r, 30));
    const privReply = sent.find((s) => s.chatId === 'chat_self' && s.text.includes('私密回复'));
    assert.ok(privReply);
    assert.match(privReply.text, /@Alice/);
    assert.doesNotMatch(privReply.text, /@\u200BAlice/);
  } finally {
    await bridge.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('B1+B2+B3 群聊深水区：结构化 mentions 与撤回擦除、连发多附件合批、外部群隔离 Thread 上下文监测与自动压缩', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-trackb-'));
  const uploads = [];
  const compacts = [];
  const threadMsgs = {};
  let extUsageRatio = 0.85;

  const mock = makeMockHarness({
    onSendMessage(entry) {
      const reqId = `req_${mock.sentPrompts.length}`;
      threadMsgs[entry.threadId] = [
        { id: reqId, role: 'user', text: entry.text, sendId: entry.sendId },
        { id: `bot_${reqId}`, role: 'bot', requestMessageId: reqId, kind: 'text', turnTerminal: true, text: '已分析日志。' },
      ];
      return { message: { id: reqId } };
    },
  });
  mock.client.listBots = async () => ({
    bots: [{
      id: 'bot_main',
      name: 'MausBot',
      chiefOfStaff: true,
      threadId: 'th_self_main',
      tasks: [
        { id: 'th_self_main', threadId: 'th_self_main', title: '自聊主线', usage: { context: { tokens: 1000, window: 100_000 }, turns: 2 } },
        ...mock.createdTasks.map((t) => ({
          id: t.threadId,
          threadId: t.threadId,
          title: t.opts?.title || '外部群',
          usage: { context: { tokens: Math.round(extUsageRatio * 100_000), window: 100_000 }, turns: 28 },
        })),
      ],
    }],
    groups: [],
  });
  mock.client.uploadFile = async (name, buf, mime) => {
    uploads.push({ name, content: buf.toString('utf8'), mime });
    return { path: `/tmp/omb/${name}`, size: buf.length, mime };
  };
  mock.client.compact = async (botId, threadId) => {
    compacts.push({ botId, threadId });
    return { ok: true };
  };
  mock.client.getMessages = async (tid) => ({ messages: threadMsgs[tid] ?? [] });

  const { sent, transport } = makeMockTransport({
    att_log1: 'node1 timeout ERR_504',
    att_log2: 'node2 reset ERR_499',
    att_secret: 'temp_pass_999',
  });
  const bridge = new OpenMausBotBridge({
    client: mock.client,
    transport,
    dataDir: tmpDir,
    sendRetries: 0,
    chats: { autoCompactThreshold: 0.92 },
  });
  await bridge.start();

  try {
    const t0 = Date.now();
    // 1. Alice 误发一条含密文日志并立即撤回
    await bridge.onEvent({
      id: 'm_secret',
      ts: t0,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'alice', name: 'Alice', isSelf: false },
      text: '密码 temp_pass_999',
      attachments: [{ id: 'att_secret', msgId: 'm_secret', name: 'secret.log' }],
    });
    await bridge.onEvent({
      id: 'm_recall_1',
      kind: 'recall',
      ts: t0 + 100,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'alice', name: 'Alice', isSelf: false },
      recalledMsgId: 'm_secret',
      text: '',
    });
    assert.equal(bridge.localContextStore.getMessage('grp_dev', 'm_secret'), null, '撤回消息应立即从上下文删除');

    // 2. Alice 连发两份日志，本人只引用第 2 份或直接不引用说「对比上面两个日志」 -> 两份一并上传且不含已撤回的 secret.log
    await bridge.onEvent({
      id: 'm_log1',
      ts: t0 + 1000,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'alice', name: 'Alice', isSelf: false },
      text: 'node1',
      attachments: [{ id: 'att_log1', msgId: 'm_log1', name: 'node1.log' }],
    });
    await bridge.onEvent({
      id: 'm_log2',
      ts: t0 + 2000,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'alice', name: 'Alice', isSelf: false },
      text: 'node2',
      attachments: [{ id: 'att_log2', msgId: 'm_log2', name: 'node2.log' }],
    });
    await bridge.onEvent({
      id: 'm_ask_logs',
      ts: t0 + 3000,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: '我', isSelf: true },
      replyTo: 'm_log2',
      text: '@bot 帮看下这批日志',
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(uploads.map((u) => u.name).sort(), ['node1.log', 'node2.log'], '连发多附件应自动合批且不包含已撤回附件');
    assert.doesNotMatch(mock.sentPrompts[0].text, /temp_pass_999/);
    assert.match(mock.sentPrompts[0].text, /auto_attached_files:.*node2\.log/);
    assert.match(mock.sentPrompts[0].text, /auto_attached_files:.*node1\.log/);

    // 3. 结构化 mentions（正文中未出现 @Bob 字样但 mentions=[Bob]）引用 Bot 回复 -> 不重触 Bot
    const botReply = sent.find((s) => s.chatId === 'grp_dev' && s.text.includes('已分析日志'));
    assert.ok(botReply);
    await bridge.onEvent({
      id: 'm_struct_handoff',
      ts: t0 + 4000,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: '我', isSelf: true },
      replyTo: botReply.id,
      mentions: [{ id: 'bob', name: 'Bob' }],
      text: '按上面处理下',
    });
    assert.equal(mock.sentPrompts.length, 1, '结构化 @同事 时引用 Bot 回复不应重触 Bot');

    // 4. B3: 85% 警告发往自聊且附 `@bot compact grp_dev` 按钮；自聊可执行 `@bot context grp_dev` 与 `@bot compact grp_dev`
    const warnMsg = sent.find((s) => s.chatId === 'chat_self' && s.text.includes('85%'));
    assert.ok(warnMsg, '外部群达到 85% 应在自聊收到提示');
    assert.match(warnMsg.opts.actions[0].text, /^@bot compact grp_dev$/);

    await bridge.onEvent({
      id: 'm_ctx_grp',
      ts: t0 + 5000,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot context grp_dev',
    });
    const ctxResp = sent.find((s) => s.chatId === 'chat_self' && s.text.includes('研发架构群') && s.text.includes('85%'));
    assert.ok(ctxResp);

    await bridge.onEvent({
      id: 'm_cmp_grp',
      ts: t0 + 5100,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot compact grp_dev',
    });
    assert.equal(compacts.length, 1);
    assert.equal(compacts[0].threadId, mock.createdTasks[0].threadId, 'compact 必须作用于外部群隔离 Thread 而非自聊主线');

    // 5. B3: 当外部群达到 92% 时自动静默压缩外部群 Thread 并向自聊报告
    extUsageRatio = 0.94;
    await bridge.onEvent({
      id: 'm_ask_auto_cmp',
      ts: t0 + 6000,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot 今天天气不错',
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(uploads.length, 2, '无关提问不应再次上传上面的日志附件');
    assert.equal(compacts.length, 2, '达到 92% 阈值应自动后台压缩外部群 Thread');
    assert.ok(sent.some((s) => s.chatId === 'chat_self' && s.text.includes('已自动后台压缩')));
  } finally {
    await bridge.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('C1+C2+C3 跨群效率助手：定时汇总持久化与防重触、私密草稿改写与确认回发（防误艾特）、跨群关键词检索', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-trackc-'));
  let fakeNow = new Date(2026, 10, 22, 17, 55, 0).getTime();
  const threadMsgs = {};
  const mock = makeMockHarness({
    onSendMessage(entry) {
      const reqId = `req_${mock.sentPrompts.length}`;
      const isPrivDraftReq = entry.text.includes('起草');
      const reply = isPrivDraftReq
        ? '请 @Alice 今天 18:00 前确认发布窗口。'
        : '汇总完成：今日讨论聚焦 nginx 499 与封板。';
      threadMsgs[entry.threadId] = [
        { id: reqId, role: 'user', text: entry.text, sendId: entry.sendId },
        { id: `bot_${reqId}`, role: 'bot', requestMessageId: reqId, kind: 'text', turnTerminal: true, text: reply },
      ];
      return { message: { id: reqId } };
    },
  });
  mock.client.getMessages = async (tid) => ({ messages: threadMsgs[tid] ?? [] });

  const { sent, transport } = makeMockTransport();
  const bridge = new OpenMausBotBridge({
    client: mock.client,
    transport,
    dataDir: tmpDir,
    sendRetries: 0,
    now: () => fakeNow,
  });
  await bridge.start();

  try {
    // Seed 外部群与私聊上下文
    await bridge.onEvent({
      id: 'g_msg_1',
      ts: fakeNow - 60_000,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'alice', name: 'Alice', isSelf: false },
      text: 'nginx 499 连接池待确认',
    });
    await bridge.onEvent({
      id: 'd_msg_1',
      ts: fakeNow - 30_000,
      chat: { id: 'dm_bob', type: 'direct', name: 'Bob' },
      sender: { id: 'bob', name: 'Bob', isSelf: false },
      text: 'nginx 灰度配置发你了',
    });

    // C3: 跨群检索（支持全群多词与 in:群名 限定），在外部群调用也私密发回自聊
    await bridge.onEvent({
      id: 'c3_find_all',
      ts: fakeNow + 1000,
      chat: { id: 'dm_bob', type: 'direct', name: 'Bob' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot find nginx',
    });
    const findAllMsg = sent.find((s) => s.chatId === 'chat_self' && s.text.includes('跨群检索') && s.text.includes('研发架构群') && s.text.includes('Bob'));
    assert.ok(findAllMsg, 'find 结果必须私密路由至自聊且包含跨会话命中');
    assert.equal(sent.some((s) => s.chatId === 'dm_bob'), false);

    await bridge.onEvent({
      id: 'c3_find_scoped',
      ts: fakeNow + 2000,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot find in:研发架构群 499',
    });
    const findScopedMsg = sent.find((s) => s.chatId === 'chat_self' && s.text.includes('命中 1 条') && s.text.includes('499'));
    assert.ok(findScopedMsg);

    // C1: 添加每日 18:00 定时汇总 -> 到点仅触发一次，不打扰原群，无新消息不重复触发
    await bridge.onEvent({
      id: 'c1_add',
      ts: fakeNow + 3000,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot schedule add grp_dev 18:00 关注发布风险',
    });
    assert.equal(bridge.listScheduledSummaries().length, 1);

    fakeNow = new Date(2026, 10, 22, 18, 0, 10).getTime();
    const ran1 = await bridge.tickScheduledSummaries(fakeNow);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(ran1.length, 1);
    assert.ok(sent.some((s) => s.chatId === 'chat_self' && s.text.includes('汇总完成')));
    assert.equal(sent.some((s) => s.chatId === 'grp_dev'), false, '定时汇总绝不可打扰原群');

    fakeNow = new Date(2026, 10, 22, 18, 2, 0).getTime();
    const ran2 = await bridge.tickScheduledSummaries(fakeNow);
    assert.equal(ran2.length, 0, '同一天同一规则不得重复触发');

    // 次日有新消息才再次触发；若无新消息则静默跳过
    fakeNow = new Date(2026, 10, 23, 18, 1, 0).getTime();
    assert.equal((await bridge.tickScheduledSummaries(fakeNow)).length, 0, '无新消息应跳过定时汇总');

    // 重启恢复定时汇总配置
    await bridge.stop();
    const bridge2 = new OpenMausBotBridge({ client: mock.client, transport, dataDir: tmpDir, sendRetries: 0, now: () => fakeNow });
    assert.equal(bridge2.listScheduledSummaries().length, 1);

    // C2: 外部群 `@bot!` 私密起草 -> 自聊 `@bot sendback` 预览 -> `改：...` 改写 -> `确认发送` 自动插 \u200B 防误艾特发回原群
    await bridge2.start();
    await bridge2.onEvent({
      id: 'c2_draft_req',
      ts: fakeNow + 1000,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: '我', isSelf: true },
      replyTo: 'g_msg_1',
      text: '@bot! 帮我起草一句回复',
    });
    await new Promise((r) => setTimeout(r, 40));
    const privDraft = sent.find((s) => s.chatId === 'chat_self' && s.text.includes('私密回复') && s.text.includes('@Alice'));
    assert.ok(privDraft);
    assert.doesNotMatch(privDraft.text, /@\u200BAlice/);

    await bridge2.onEvent({
      id: 'c2_sb_req',
      ts: fakeNow + 2000,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      replyTo: privDraft.id,
      text: '@bot sendback',
    });
    assert.ok(sent.some((s) => s.chatId === 'chat_self' && s.text.includes('确认发回到「研发架构群」')));

    await bridge2.onEvent({
      id: 'c2_sb_edit',
      ts: fakeNow + 2500,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '改：请 @Alice 今晚 19:00 前再确认下',
    });
    assert.ok(sent.some((s) => s.chatId === 'chat_self' && s.text.includes('19:00 前再确认下')));

    await bridge2.onEvent({
      id: 'c2_sb_confirm',
      ts: fakeNow + 3000,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '确认发送',
    });
    const backMsg = sent.find((s) => s.chatId === 'grp_dev');
    assert.ok(backMsg, '确认后应实际发回原群');
    assert.equal(backMsg.opts.replyTo, 'g_msg_1', '应保留原触发引用的群消息气泡');
    assert.match(backMsg.text, /@\u200BAlice/);
    assert.match(backMsg.text, /19:00 前再确认下/);
    await bridge2.stop();
  } finally {
    await bridge.stop().catch(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
