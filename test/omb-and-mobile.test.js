import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  defineChannelPlugin,
  formatLinkCardSnippet,
  isAudioAttachment,
  normalizeInboundEvent,
} from '../src/core/channel-contract.js';
import { ChatContextStore, formatImContextBlock } from '../src/core/chat-context.js';
import { Kernel } from '../src/core/kernel.js';
import { OpenMausBotBridge } from '../src/openmausbot/bridge.js';
import { openmausbotPlugin } from '../src/plugins/openmausbot.js';
import { inspectorPlugin } from '../src/plugins/inspector.js';
import { webPlugin } from '../src/plugins/web.js';

const until = (fn, ms = 3000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const check = () => {
    if (fn()) return resolve();
    if (Date.now() - t0 > ms) return reject(new Error(`timeout waiting condition: ${fn.toString()}`));
    setTimeout(check, 15);
  };
  check();
});

function makeTransport({ withDownload = false } = {}) {
  const sent = [];
  let onMsg = null;
  let seq = 0;
  return {
    sent,
    async push(ev) { await onMsg?.(ev); },
    transport: {
      selfChatId: 'chat_self',
      canFiles: true,
      capabilities: { markdown: true, files: true, images: true, replyTo: true, actions: true, history: true, maxChars: 0, multiDevice: true },
      status() { return { kind: 'mock', connected: true, selfChatId: 'chat_self' }; },
      async start(cb) { onMsg = cb; },
      async stop() {},
      async send(chatId, text, opts = {}) {
        const id = `im_${++seq}`;
        sent.push({ id, chatId, text, ...opts });
        return id;
      },
      ...(withDownload ? {
        async download(att, savePath) {
          fs.mkdirSync(path.dirname(savePath), { recursive: true });
          fs.writeFileSync(savePath, Buffer.from(`AUDIO:${att.id}`));
        },
      } : {}),
    },
  };
}

test('Track D1: voice transcript hook, audio fallback, and linkCard normalization + sticky bare card dispatch', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-media-'));
  try {
    // 1. 语音判定与卡片标准化（标准结构 + 扁平 FlatMessage）
    assert.equal(isAudioAttachment({ id: 'a1', name: 'msg.ogg', mime: 'audio/ogg' }), true);
    assert.equal(isAudioAttachment({ id: 'a2', name: 'voice.amr', kind: 'voice' }), true);
    assert.equal(isAudioAttachment({ id: 'a3', name: 'report.pdf', mime: 'application/pdf' }), false);

    const stdEv = normalizeInboundEvent({
      id: 'm_card_1',
      chat: { id: 'grp_1', type: 'group', name: '产研群' },
      sender: { id: 'u1', name: 'Alice', isSelf: false },
      text: '',
      linkCard: { title: '发布周报', description: '网关延迟下降 30%', url: 'https://example.com/weekly', source: 'FeishuDoc' },
      attachments: [{ id: 'aud_1', name: 'voice.m4a', kind: 'voice', durationSec: 12, transcript: '今晚八点灰度和压测' }],
    });
    assert.equal(stdEv.linkCard?.title, '发布周报');
    assert.equal(stdEv.attachments?.[0]?.transcript, '今晚八点灰度和压测');
    assert.match(formatLinkCardSnippet(stdEv.linkCard), /\[转发卡片\].*发布周报.*FeishuDoc/);

    const flatEv = normalizeInboundEvent({
      msgId: 'flat_1',
      chatId: 'chat_self',
      chatType: 'self',
      fromId: 'me',
      text: '',
      card: { title: '事故复盘', url: 'https://example.com/postmortem' },
      files: [{ fileId: 'aud_2', name: 'clip.ogg', mime: 'audio/ogg', durationSec: 8, transcript: '连接池已扩容' }],
    }, { selfId: 'me', selfChatId: 'chat_self' });
    assert.equal(flatEv.linkCard?.title, '事故复盘');
    assert.equal(flatEv.attachments?.[0]?.durationSec, 8);

    // 2. ChatContextStore 存储并在 <im-context> 中紧凑展示语音与卡片
    const store = new ChatContextStore();
    store.recordInbound(stdEv);
    const recent = store.getRecent('grp_1', { limit: 5 });
    const ctxText = formatImContextBlock({
      triggerEvent: { id: 'trig_1', chat: { id: 'grp_1', type: 'group', name: '产研群' }, sender: { id: 'me', isSelf: true } },
      recentMsgs: recent,
    });
    assert.match(ctxText, /\[卡片: 发布周报 \(https:\/\/example\.com\/weekly\)\]/);
    assert.match(ctxText, /\[附件: 语音 12s: 今晚八点灰度和压测\]/);

    // 3. Bridge 集成：transcribeAudio 钩子、转写失败降级、以及自聊粘性裸卡片直发
    const sentPrompts = [];
    const uploadedFiles = [];
    const threadMsgs = new Map();
    const tr = makeTransport({ withDownload: true });
    let transcribeCalls = 0;
    const mockClient = {
      async listBots() { return { bots: [{ id: 'b1', name: 'MausBot', threadId: 't_self', chiefOfStaff: true }], groups: [] }; },
      async resolveBot() { return { id: 'b1', name: 'MausBot', threadId: 't_self', chiefOfStaff: true }; },
      async uploadFile(name) { uploadedFiles.push(name); return { path: `/tmp/${name}` }; },
      async sendMessage(botId, payload) {
        sentPrompts.push({ botId, ...payload });
        const reqId = `req_${sentPrompts.length}`;
        threadMsgs.set(payload.threadId, [
          { id: reqId, role: 'user', sendId: payload.sendId },
          { id: `bot_${reqId}`, role: 'bot', requestMessageId: reqId, kind: 'text', turnTerminal: true, text: '收到语音和卡片分析。' },
        ]);
        return { ok: true, threadId: payload.threadId, message: { id: reqId, role: 'user', sendId: payload.sendId } };
      },
      async getJob() { return { state: 'completed', version: 'v1' }; },
      async getMessages(tid) { return { messages: threadMsgs.get(tid) ?? [] }; },
      async subscribeEvents(_cb, { signal }) {
        await new Promise((r) => signal?.addEventListener('abort', r, { once: true }));
      },
    };

    const bridge = new OpenMausBotBridge({
      client: mockClient,
      transport: tr.transport,
      dataDir: tmpDir,
      turnStallMs: 0,
      async transcribeAudio(filePath, att) {
        transcribeCalls += 1;
        if (att.id === 'aud_fail') throw new Error('whisper timeout');
        assert.ok(fs.existsSync(filePath));
        return '这是本地转写出的语音正文';
      },
    });
    await bridge.start();

    // 语音附件（无直接 transcript）走 transcribeAudio 钩子 -> 注入 [语音转写] + 附带原文件
    await tr.push({
      id: 'u_voice_1',
      ts: Date.now(),
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', isSelf: true },
      text: '@bot 总结一下语音并附原链接',
      linkCard: { title: '线上排障单', url: 'https://example.com/issue/42' },
      attachments: [{ id: 'aud_hook', name: 'note.ogg', mime: 'audio/ogg', durationSec: 9 }],
    });
    await until(() => tr.sent.some((m) => m.text.includes('收到语音和卡片分析')));
    assert.equal(transcribeCalls, 1);
    assert.equal(uploadedFiles.includes('note.ogg'), true);
    assert.match(sentPrompts[0].text, /\[转发卡片\] 标题：线上排障单 \| 链接：https:\/\/example\.com\/issue\/42/);
    assert.match(sentPrompts[0].text, /\[语音转写 · note\.ogg（9秒）\] 这是本地转写出的语音正文/);

    // 粘性窗口内裸转发卡片（无文字）自动触发，且语音转写抛错不阻断附件上传
    await tr.push({
      id: 'u_card_only',
      ts: Date.now() + 100,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', isSelf: true },
      text: '',
      linkCard: { title: '数据库慢查询报告', description: 'QPS 峰值告警', url: 'https://example.com/db' },
    });
    await until(() => sentPrompts.length === 2);
    assert.match(sentPrompts[1].text, /数据库慢查询报告/);

    await tr.push({
      id: 'u_voice_fail',
      ts: Date.now() + 200,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', isSelf: true },
      text: '@bot 听下这段语音',
      attachments: [{ id: 'aud_fail', name: 'broken.mp3', mime: 'audio/mpeg' }],
    });
    await until(() => sentPrompts.length === 3);
    assert.equal(uploadedFiles.includes('broken.mp3'), true);
    await bridge.stop();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Track D2: 0.1.177 doctor, approvalMode & waitingForTeammates across status and commands', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-0177-prefs-'));
  const ombServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (u.pathname === '/api/health') {
        return res.end(JSON.stringify({
          ok: true,
          version: '0.1.177',
          box: 'off',
          doctor: { version: '0.1.177', checked: 9, fixed: [], problems: [] },
        }));
      }
      if (u.pathname === '/api/environment') return res.end(JSON.stringify({ capabilities: {} }));
      if (u.pathname === '/api/auth/session') return res.end(JSON.stringify({ kind: 'none' }));
      if (u.pathname === '/api/bots' && req.method === 'GET') {
        return res.end(JSON.stringify({
          bots: [{
            id: 'b1',
            name: 'MausBot',
            threadId: 't1',
            chiefOfStaff: true,
            replyStyle: 'conversational',
            approvalMode: 'ask',
            waitingForTeammates: true,
            tasks: [{ threadId: 't1', title: '自聊主线' }],
          }],
          groups: [],
        }));
      }
      if (u.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"kind":"hello"}\n\n');
        req.on('close', () => res.end());
        return;
      }
      res.end('{}');
    });
  });
  await new Promise((r) => ombServer.listen(0, '127.0.0.1', r));
  const ombPort = ombServer.address().port;

  let pushMsg = null;
  const sentOut = [];
  const makeChanPlugin = () => defineChannelPlugin({
    name: 'mock-0177',
    capabilities: { markdown: true, files: false, actions: true },
    create() {
      return {
        async start(onMsg) { pushMsg = onMsg; },
        async send(chatId, text, opts) { sentOut.push({ chatId, text, ...opts }); return `m_${sentOut.length}`; },
        async stop() {},
      };
    },
  });

  const makeCfg = () => ({
    openmausbot: { url: `http://127.0.0.1:${ombPort}`, timeoutMs: 3000, token: '', autoStart: false },
    transport: 'sim',
    channel: { use: 'mock-0177', options: {} },
    ipc: {},
    web: { host: '127.0.0.1', port: 0 },
    selfChat: { trigger: '@bot', fileRetentionDays: 0, stateSaveDebounceMs: 0 },
    chats: { mode: 'owner_everywhere', externalAckInSelf: false },
    dataDir: tmpDir,
  });

  const k1 = new Kernel({ config: makeCfg() });
  k1.use(webPlugin);
  k1.use(makeChanPlugin(), { selfId: 'me', selfChatId: 'chat_self' });
  k1.use(openmausbotPlugin, { autoHealOmb: null });
  k1.use(inspectorPlugin);

  try {
    await k1.start();
    const port1 = k1.get('web').server.address().port;

    // 1. /api/status 暴露 0.1.177 doctor + approvalMode + waitingForTeammates
    const st1 = await fetch(`http://127.0.0.1:${port1}/api/status`).then((r) => r.json());
    assert.equal(st1.openmausbot.doctor.checked, 9);
    assert.equal(st1.openmausbot.bots[0].approvalMode, 'ask');
    assert.equal(st1.openmausbot.bots[0].waitingForTeammates, true);

    // 2. @bot status 统一展示审批状态、等待队友与 Doctor 诊断
    await pushMsg({ id: 'cmd_status', ts: Date.now(), chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot status' });
    await until(() => sentOut.some((m) => m.text.includes('审批:ask') && m.text.includes('等待队友') && m.text.includes('Doctor：正常（9项）')));

    await k1.stop();
  } finally {
    ombServer.closeAllConnections?.();
    await new Promise((r) => ombServer.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
