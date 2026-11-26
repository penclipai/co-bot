import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  defineChannelPlugin,
  formatLinkCardSnippet,
  isAudioAttachment,
  normalizeInboundEvent,
} from '../src/core/channel-contract.ts';
import { ChatContextStore, formatImContextBlock } from '../src/core/chat-context.ts';
import { Kernel } from '../src/core/kernel.ts';
import { OpenMausBotBridge } from '../src/openmausbot/bridge.ts';
import type { OpenMausBotClient } from '../src/openmausbot/client.ts';
import type { BridgeTransport, OmbMessage } from '../src/openmausbot/types.ts';
import { openmausbotPlugin } from '../src/plugins/openmausbot.ts';
import { inspectorPlugin } from '../src/plugins/inspector.ts';
import { webPlugin } from '../src/plugins/web.ts';
import type { ChannelSendOptions, InboundAttachment, InboundEvent, RawConfig } from '../src/types.ts';
import type { WebServer } from '../src/web/server.ts';

const until = (fn: () => boolean, ms = 3000): Promise<void> => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const check = () => {
    if (fn()) return resolve();
    if (Date.now() - t0 > ms) return reject(new Error(`timeout waiting condition: ${fn.toString()}`));
    setTimeout(check, 15);
  };
  check();
});

function makeTransport({ withDownload = false }: { withDownload?: boolean } = {}) {
  const sent: Array<{ id: string; chatId: string; text: string } & ChannelSendOptions> = [];
  let onMsg: ((ev: InboundEvent) => unknown) | null = null;
  let seq = 0;
  const transport: BridgeTransport = {
    selfChatId: 'chat_self',
    canFiles: true,
    capabilities: { markdown: true, files: true, images: true, replyTo: true, actions: true, history: true, maxChars: 0, multiDevice: true },
    status() { return { kind: 'mock', connected: true, selfChatId: 'chat_self' }; },
    async start(cb) { onMsg = cb; },
    async stop() {},
    async send(chatId: string, text: string, opts: ChannelSendOptions = {}) {
      const id = `im_${++seq}`;
      sent.push({ id, chatId, text, ...opts });
      return id;
    },
    ...(withDownload ? {
      async download(att: InboundAttachment, savePath: string) {
        fs.mkdirSync(path.dirname(savePath), { recursive: true });
        fs.writeFileSync(savePath, Buffer.from(`AUDIO:${att.id}`));
      },
    } : {}),
  };
  return {
    sent,
    async push(ev: InboundEvent) { await onMsg?.(ev); },
    transport,
  };
}

test('Track D1: voice transcript hook, audio fallback, and linkCard normalization + sticky bare card dispatch', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-media-'));
  try {
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

    const store = new ChatContextStore();
    store.recordInbound(stdEv);
    const recent = store.getRecent('grp_1', { limit: 5 });
    const ctxText = formatImContextBlock({
      triggerEvent: { id: 'trig_1', chat: { id: 'grp_1', type: 'group', name: '产研群' }, sender: { id: 'me', isSelf: true } },
      recentMsgs: recent,
    });
    assert.match(ctxText, /\[卡片: 发布周报 \(https:\/\/example\.com\/weekly\)\]/);
    assert.match(ctxText, /\[附件: 语音 12s: 今晚八点灰度和压测\]/);

    const sentPrompts: Array<Record<string, unknown>> = [];
    const uploadedFiles: string[] = [];
    const threadMsgs = new Map<string, OmbMessage[]>();
    const tr = makeTransport({ withDownload: true });
    let transcribeCalls = 0;
    const mockClient = {
      async listBots() { return { bots: [{ id: 'b1', name: 'MausBot', threadId: 't_self', chiefOfStaff: true }], groups: [] }; },
      async resolveBot() { return { id: 'b1', name: 'MausBot', threadId: 't_self', chiefOfStaff: true }; },
      async uploadFile(name: string) { uploadedFiles.push(name); return { path: `/tmp/${name}` }; },
      async sendMessage(botId: string, payload: { threadId: string; text: string; sendId?: string }) {
        sentPrompts.push({ botId, ...payload });
        const reqId = `req_${sentPrompts.length}`;
        threadMsgs.set(payload.threadId, [
          { id: reqId, role: 'user', sendId: payload.sendId },
          { id: `bot_${reqId}`, role: 'bot', requestMessageId: reqId, kind: 'text', turnTerminal: true, text: '收到语音和卡片分析。' },
        ]);
        return { ok: true, threadId: payload.threadId, message: { id: reqId, role: 'user', sendId: payload.sendId } };
      },
      async getJob() { return { state: 'completed', version: 'v1' }; },
      async getMessages(tid: string) { return { messages: threadMsgs.get(tid) ?? [] }; },
      async subscribeEvents(_cb: unknown, { signal }: { signal?: AbortSignal }) {
        await new Promise<void>((r) => signal?.addEventListener('abort', () => r(), { once: true }));
      },
    } as unknown as OpenMausBotClient;

    const bridge = new OpenMausBotBridge({
      client: mockClient,
      transport: tr.transport,
      dataDir: tmpDir,
      turnStallMs: 0,
      async transcribeAudio(filePath: string, att: InboundAttachment) {
        transcribeCalls += 1;
        if (att.id === 'aud_fail') throw new Error('whisper timeout');
        assert.ok(fs.existsSync(filePath));
        return '这是本地转写出的语音正文';
      },
    });
    await bridge.start();

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
    assert.match(String(sentPrompts[0].text), /\[转发卡片\] 标题：线上排障单 \| 链接：https:\/\/example\.com\/issue\/42/);
    assert.match(String(sentPrompts[0].text), /\[语音转写 · note\.ogg（9秒）\] 这是本地转写出的语音正文/);

    await tr.push({
      id: 'u_card_only',
      ts: Date.now() + 100,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', isSelf: true },
      text: '',
      linkCard: { title: '数据库慢查询报告', description: 'QPS 峰值告警', url: 'https://example.com/db' },
    });
    await until(() => sentPrompts.length === 2);
    assert.match(String(sentPrompts[1].text), /数据库慢查询报告/);

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
  let doctorProblems: string[] = [];
  const ombServer = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (u.pathname === '/api/health') {
        return res.end(JSON.stringify({
          ok: true,
          version: '0.1.177',
          box: 'off',
          doctor: { version: '0.1.177', checked: 9, fixed: [], problems: doctorProblems },
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
            approvalMode: 'auto',
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
  await new Promise<void>((r) => ombServer.listen(0, '127.0.0.1', r));
  const ombPort = (ombServer.address() as AddressInfo).port;

  let pushMsg: ((rawMsg: unknown) => void) | null = null;
  const sentOut: Array<{ chatId: string; text: string } & ChannelSendOptions> = [];
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

  const makeCfg = (): RawConfig => ({
    openmausbot: { url: `http://127.0.0.1:${ombPort}`, timeoutMs: 3000, token: '', autoStart: false },
    channel: { use: 'mock-0177', options: {} },
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
    const port1 = (k1.get<WebServer>('web').server!.address() as AddressInfo).port;

    const st1 = await fetch(`http://127.0.0.1:${port1}/api/status`).then((r) => r.json()) as {
      openmausbot: { doctor: { checked: number }; bots: Array<{ approvalMode: string; waitingForTeammates: boolean }> };
    };
    assert.equal(st1.openmausbot.doctor.checked, 9);
    assert.equal(st1.openmausbot.bots[0].approvalMode, 'auto');
    assert.equal(st1.openmausbot.bots[0].waitingForTeammates, true);

    await pushMsg!({ id: 'cmd_status', ts: Date.now(), chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot status' });
    await until(() => sentOut.some((m) => m.text.includes('· auto') && m.text.includes('等待队友')));
    const cleanStatus = sentOut.findLast((m) => m.text.includes('· auto'))!;
    assert.equal(cleanStatus.text.includes('Doctor'), false);
    assert.equal(cleanStatus.text.includes('🤖 团队'), false);

    doctorProblems = ['sandbox_missing'];
    await pushMsg!({ id: 'cmd_status_warn', ts: Date.now(), chat: { id: 'chat_self', type: 'self' }, sender: { id: 'me', isSelf: true }, text: '@bot status' });
    await until(() => sentOut.some((m) => m.text.includes('⚠️ Doctor 1 项异常') && m.text.includes('· auto') && m.text.includes('等待队友')));
  } finally {
    await k1.stop().catch(() => {});
    ombServer.closeAllConnections?.();
    await new Promise<void>((r) => ombServer.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
