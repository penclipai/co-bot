import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IpcTransport } from '../src/im/ipc.js';
import { OpenMausBotBridge } from '../src/openmausbot/bridge.js';

test('IpcTransport maps flat IM messages, auto-learns selfChatId, sends text & files, and skips invalid events', async () => {
  const sent = [];
  const files = [];
  const downloads = [];
  let emit;
  let closed = false;

  const clientModule = {
    async connect(cb) { emit = cb; },
    async send(p) { sent.push(p); return { msgId: `s${sent.length}` }; },
    async sendFile(p) { files.push(p); return { msgId: `f${files.length}` }; },
    async download(p) { downloads.push(p); },
    async close() { closed = true; },
  };

  const events = [];
  const ipc = new IpcTransport({ selfId: 'u_me', atAllCountsAsMention: true, clientModule });
  await ipc.start((ev) => events.push(ev));

  // 无 msgId / chatId 的异常消息应被安全跳过，不抛异常
  emit({});
  assert.equal(events.length, 0);

  // 自聊消息自动学习 selfChatId，且正确映射设备与附件
  emit({
    msgId: 'm1',
    chatId: 'chat_self_1',
    chatType: 'self',
    fromId: 'u_me',
    fromName: 'Jack',
    fromDevice: { id: 'd1', type: 'mobile', name: 'iPhone' },
    text: '@bot 查一下',
    quoteMsgId: 'm0',
    time: 123456,
    files: [{ fileId: 'file_1', name: 'err.log', size: 120, mime: 'text/plain' }],
  });
  assert.equal(ipc.selfChatId, 'chat_self_1');
  assert.equal(events.length, 1);
  assert.equal(events[0].chat.type, 'self');
  assert.equal(events[0].sender.isSelf, true);
  assert.equal(events[0].device.type, 'mobile');
  assert.equal(events[0].replyTo, 'm0');
  assert.deepEqual(events[0].attachments, [{ id: 'file_1', msgId: 'm1', name: 'err.log', size: 120, mime: 'text/plain' }]);

  // 群消息与 @all 提及
  emit({
    msgId: 'm2',
    chatId: 'g1',
    chatType: 'group',
    chatName: '研发群',
    fromId: 'u_other',
    text: '所有人看下',
    atAll: true,
  });
  assert.equal(events[1].chat.type, 'group');
  assert.equal(events[1].sender.isSelf, false);
  assert.equal(events[1].mentionsMe, true);

  // 发送与下载透传
  assert.equal(ipc.canFiles, true);
  assert.equal(await ipc.send('chat_self_1', 'hello', { replyTo: 'm1' }), 's1');
  assert.deepEqual(sent[0], { chatId: 'chat_self_1', text: 'hello', quoteMsgId: 'm1' });

  assert.equal(await ipc.sendFile('chat_self_1', { path: '/tmp/a.md', name: 'a.md' }, { replyTo: 'm1' }), 'f1');
  assert.deepEqual(files[0], { chatId: 'chat_self_1', filePath: '/tmp/a.md', fileName: 'a.md', quoteMsgId: 'm1' });

  await ipc.download(events[0].attachments[0], '/tmp/out.log');
  assert.deepEqual(downloads[0], { msgId: 'm1', fileId: 'file_1', savePath: '/tmp/out.log' });

  await ipc.stop();
  assert.equal(closed, true);
});

test('IpcTransport: status(), onDisconnect triggers exponential reconnect, and stop cancels pending timer', async () => {
  let connectCount = 0;
  let closeCount = 0;
  let disconnectCb = null;
  const clientModule = {
    async connect(_onMsg, opts) {
      connectCount += 1;
      disconnectCb = opts?.onDisconnect;
      if (connectCount === 2) throw new Error('temporary network drop');
    },
    async send() { return { msgId: '1' }; },
    async close() { closeCount += 1; },
  };

  const ipc = new IpcTransport({
    selfId: 'u_me',
    clientModule,
    reconnectDelayMs: 25,
    maxReconnectDelayMs: 80,
  });
  await ipc.start(() => {});
  assert.deepEqual(ipc.status(), {
    kind: 'ipc',
    connected: true,
    selfChatId: null,
    lastError: null,
    reconnectAttempts: 0,
  });

  disconnectCb(new Error('socket reset'));
  assert.equal(ipc.status().connected, false);
  assert.equal(ipc.status().lastError, 'socket reset');

  await new Promise((r) => setTimeout(r, 140));
  assert.ok(connectCount >= 3, '初次重连失败后应按退避重新连接成功');
  assert.equal(ipc.status().connected, true);
  assert.equal(ipc.status().reconnectAttempts, 0);

  await ipc.stop();
  assert.equal(ipc.status().connected, false);
  assert.ok(closeCount >= 2);
});

test('IpcTransport + OpenMausBotBridge: learns and persists empty selfChatId, and suppresses synchronous sendFile echo loop', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-bridge-'));
  let emit = null;
  let sendSeq = 0;
  const sentTexts = [];
  const sentFiles = [];
  const uploadedFiles = [];
  let ssePush = null;

  const storedMsgs = [];
  const makeMockClient = () => ({
    async listBots() { return { bots: [{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }] }; },
    async resolveBot() { return { id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }; },
    async sendMessage(_botId, { text, threadId, sendId }) {
      const reqMsg = { id: `u_${sendId}`, role: 'user', kind: 'text', threadId, text, sendId };
      const botMsg = { id: `b_${sendId}`, role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: '这是一段超过二十字的回复用来触发发送附件防回环检查。', turnTerminal: true };
      storedMsgs.push(reqMsg, botMsg);
      setTimeout(() => {
        ssePush?.({ kind: 'message', threadId, message: botMsg });
      }, 10);
      return { ok: true, threadId, message: reqMsg };
    },
    async getMessages() {
      return { messages: [...storedMsgs] };
    },
    async getJob(_tid, { signal }) {
      await new Promise((r) => {
        if (signal?.aborted) return r();
        signal?.addEventListener('abort', r, { once: true });
      });
      return { state: 'running', version: 'v1' };
    },
    async uploadFile(name) { uploadedFiles.push(name); return { path: `/tmp/${name}` }; },
    async subscribeEvents(onEvent, { signal }) {
      ssePush = onEvent;
      await onEvent({ kind: 'hello', cursor: '1' });
      await new Promise((r) => {
        if (signal?.aborted) return r();
        signal?.addEventListener('abort', r, { once: true });
      });
    },
  });

  const makeClientModule = () => ({
    async connect(cb) { emit = cb; },
    async send(p) { sentTexts.push(p); return { msgId: `st_${++sendSeq}` }; },
    async sendFile({ chatId, filePath, fileName }) {
      sentFiles.push({ chatId, fileName });
      // 模拟真实 IPC 在 sendFile Promise 返回前先同步推回一条自己发出的文件消息
      const sz = fs.statSync(filePath).size;
      emit({
        msgId: `echo_sync_${++sendSeq}`,
        chatId,
        chatType: 'self',
        fromId: 'u_me',
        text: '',
        files: [{ fileId: `f_${sendSeq}`, name: fileName, size: sz }],
      });
      return { msgId: `sf_${sendSeq}` };
    },
    async download() {},
    async close() {},
  });

  // 1. 首次启动 selfChatId 为空：主动消息安全跳过；用户首条自聊学习并持久化 selfChatId；出站 sendFile 回声不二次上传
  const ipc1 = new IpcTransport({ selfId: 'u_me', selfChatId: '', clientModule: makeClientModule() });
  const b1 = new OpenMausBotBridge({ client: makeMockClient(), transport: ipc1, dataDir, resultChars: 20, softSplitChars: 20, imageBatchMs: 30 });
  await b1.start();
  await ssePush({ kind: 'message', threadId: 't1', message: { id: 'pro_early', role: 'bot', kind: 'text', threadId: 't1', text: '过早主动推送', turnTerminal: true } });
  assert.equal(sentTexts.length, 0);

  emit({ msgId: 'u_hi', chatId: 'chat_self_1', chatType: 'self', fromId: 'u_me', text: '@bot 你好' });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(b1.selfChat, 'chat_self_1');
  assert.equal(sentTexts[0]?.chatId, 'chat_self_1');
  assert.equal(sentFiles[0]?.chatId, 'chat_self_1');
  assert.equal(uploadedFiles.length, 0, '同步回推的出站附件不得被当作用户新传图片回流 OpenMausBot');
  await b1.stop();

  // 2. 重启时 selfChatId 仍配置为空：从 bridge-state.json 自动恢复，立刻能发出主动推送
  const ipc2 = new IpcTransport({ selfId: 'u_me', selfChatId: '', clientModule: makeClientModule() });
  const b2 = new OpenMausBotBridge({ client: makeMockClient(), transport: ipc2, dataDir });
  await b2.start();
  assert.equal(b2.selfChat, 'chat_self_1');
  assert.equal(ipc2.selfChatId, 'chat_self_1');
  await ssePush({ kind: 'message', threadId: 't1', message: { id: 'pro_after_restart', role: 'bot', kind: 'text', threadId: 't1', text: '重启后主动推送', turnTerminal: true } });
  assert.match(sentTexts.at(-1).text, /重启后主动推送/);
  assert.equal(sentTexts.at(-1).chatId, 'chat_self_1');
  await b2.stop();
});
