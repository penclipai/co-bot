import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { APP_ROOT } from '../src/config.ts';
import { runChannelContractTest } from '../scripts/channel-test.ts';
import {
  createInboundMessage,
  createRecallEvent,
  decodeScopedChatId,
  defineChannelPlugin,
  encodeScopedChatId,
  normalizeInboundEvent,
  validateConfigIdsAgainstPatterns,
  validateIdsAgainstPatterns,
  validateInboundEvent,
} from '../src/core/channel-contract.ts';
import { assemblePromptContext, ChatContextStore } from '../src/core/chat-context.ts';
import { Kernel } from '../src/core/kernel.ts';
import { OpenMausBotBridge } from '../src/openmausbot/bridge.ts';
import type { OmbMessage } from '../src/openmausbot/types.ts';
import { imContextPlugin } from '../src/plugins/im-context.ts';
import { inspectorPlugin } from '../src/plugins/inspector.ts';
import { webPlugin } from '../src/plugins/web.ts';
import type { ChannelDownloadContext, ChannelGetHistoryOptions, ChannelGetMessageOptions, ChannelSendOptions, InboundAttachment } from '../src/types.ts';
import { makeMockHarness } from './helpers/mock-im-context.ts';

async function until(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('until timeout');
}

test('protocol hardening: InboundQuote normalization, sync/mismatch checks, and cache-miss prompt fallback + member learning', async () => {
  const stdQuoted = normalizeInboundEvent({
    id: 'm_q_1',
    chat: { id: 'grp_100', type: 'group', name: '项目群' },
    sender: { id: 'u_me', name: 'Me', isSelf: true },
    text: '@bot 回答一下他引用的问题',
    quote: {
      msgId: 'm_orig_9',
      senderId: 'u_alice',
      senderName: 'Alice',
      text: '为什么网关返回 502？',
      ts: 1700000000000,
    },
  }, { selfId: 'u_me' });
  assert.equal(stdQuoted.replyTo, 'm_orig_9');
  assert.equal(stdQuoted.quote?.senderId, 'u_alice');
  assert.equal(stdQuoted.quote?.isSelf, false);

  const flatQuoted = normalizeInboundEvent({
    msgId: 'm_q_2',
    chatId: 'grp_100',
    chatType: 'group',
    fromId: 'u_bob',
    fromName: 'Bob',
    text: '@bot 接着看',
    quoteMsgId: 'm_orig_10',
    quoteSenderId: 'u_me',
    quoteSenderName: 'Me',
    quoteText: '我刚才发的日志片段',
  }, { selfId: 'u_me' });
  assert.equal(flatQuoted.replyTo, 'm_orig_10');
  assert.equal(flatQuoted.quote?.senderId, 'u_me');
  assert.equal(flatQuoted.quote?.isSelf, true);

  // Conflicting replyTo & quote.msgId throws
  assert.throws(() => normalizeInboundEvent({
    id: 'm_bad_q',
    chat: { id: 'grp_100', type: 'group' },
    sender: { id: 'u_me', isSelf: true },
    text: 'hi',
    replyTo: 'm_1',
    quote: { msgId: 'm_2', text: 'conflict' },
  }), /不一致/);

  // Cache + getMessage both miss -> assemblePromptContext falls back to quote snapshot & ChatContextStore learns quote.senderId
  const store = new ChatContextStore();
  const assembled = await assemblePromptContext({
    ev: stdQuoted,
    store,
    resolveMessage: async () => null,
    getHistory: async () => [],
  });
  assert.equal(assembled.quotedMsg?.id, 'm_orig_9');
  assert.equal(assembled.quotedMsg?.senderName, 'Alice');
  assert.match(assembled.header, /quoted_message:/);
  assert.match(assembled.header, /Alice.*为什么网关返回 502？/);
  assert.deepEqual(store.findMember('grp_100', 'Alice'), { id: 'u_alice', name: 'Alice' });
});

test('protocol hardening: fail-fast ID/type checks, mixed keys, snowflake numbers, identity mismatch, name_fallback mentions, and builders', () => {
  // Empty non-recall sender.id throws
  assert.throws(() => normalizeInboundEvent({
    id: 'm1',
    chat: { id: 'c1', type: 'direct' },
    sender: { id: '   ', isSelf: false },
    text: 'hi',
  }), /sender\.id/);
  assert.equal(validateInboundEvent({
    id: 'm1',
    chat: { id: 'c1', type: 'direct' },
    sender: { id: '', isSelf: false },
    text: 'hi',
  }).ok, false);

  // Invalid explicit chat.type throws instead of silently becoming direct
  assert.throws(() => normalizeInboundEvent({
    msgId: 'm2',
    chatId: 'c2',
    chatType: 'ROOM',
    fromId: 'u1',
    text: 'hi',
  }), /chat\.type 非法/);

  // Explicit isSelf=false in self chat throws
  assert.throws(() => normalizeInboundEvent({
    id: 'm3',
    chat: { id: 'self_1', type: 'self' },
    sender: { id: 'u_other', isSelf: false },
    text: 'hi',
  }), /非本人消息/);

  // Warnings capture: snowflake number, mixed fields, selfId contradiction, name_fallback mention
  const warnings: string[] = [];
  const ev = normalizeInboundEvent({
    msgId: 'm4',
    chatId: 'grp_1',
    chatType: 'group',
    fromId: 'u_wrong',
    isSelf: true,
    replyTo: 'should_not_mix',
    time: 1700000001000,
    quoteMsgId: '   ',
    mentions: ['Alice', { id: 'u_bob', name: 'Bob' }],
    text: 'hello',
  }, {
    selfId: 'u_real_me',
    onWarning: (w) => warnings.push(w),
  });
  assert.equal(ev.replyTo, undefined);
  assert.equal(ev.mentions?.[0]?.idKind, 'name_fallback');
  assert.equal(ev.mentions?.[1]?.idKind, 'platform');
  assert.ok(warnings.some((w) => w.includes('混写') && w.includes('replyTo')));
  assert.ok(warnings.some((w) => w.includes('身份一致性异常')));
  assert.ok(warnings.some((w) => w.includes('name_fallback')));

  // Mention name_fallback is NOT stored as real userId in ChatContextStore
  const store = new ChatContextStore();
  store.recordInbound(ev);
  assert.equal(store.findMember('grp_1', 'Alice'), null);
  assert.deepEqual(store.findMember('grp_1', 'Bob'), { id: 'u_bob', name: 'Bob' });

  // Snowflake numeric ID triggers warning
  const sfWarnings: string[] = [];
  normalizeInboundEvent({
    id: 1234567890123456,
    chat: { id: 'grp_sf', type: 'group' },
    sender: { id: 'u1', isSelf: false },
    text: 'hi',
  }, { onWarning: (w) => sfWarnings.push(w) });
  assert.ok(sfWarnings.some((w) => w.includes('大整数')));

  // Scoped chatId encode/decode + typed builders
  const scoped = encodeScopedChatId('group', '10001');
  assert.equal(scoped, 'grp:10001');
  assert.deepEqual(decodeScopedChatId(scoped), { type: 'group', rawId: '10001' });

  const built = createInboundMessage({
    id: 'b_1',
    chat: { id: scoped, type: 'group', name: '数字群' },
    sender: { id: 'u_me', isSelf: true },
    text: 'ok',
  }, { selfId: 'u_me' });
  assert.equal(built.chat.id, 'grp:10001');

  const recallBuilt = createRecallEvent({
    chat: { id: scoped, type: 'group' },
    recalledMsgId: 'b_1',
  });
  assert.equal(recallBuilt.kind, 'recall');
  assert.equal(recallBuilt.recalledMsgId, 'b_1');

  // Pattern enforcement
  const patterns = {
    userId: /^u_/,
    groupChatId: /^grp:/,
    directChatId: /^dm:/,
    msgId: /^m_/,
  };
  const patErrs = validateIdsAgainstPatterns({
    id: 'bad_id',
    chat: { id: 'dm:1', type: 'group' },
    sender: { id: 'alice', isSelf: false },
    text: 'x',
  }, patterns);
  assert.equal(patErrs.length, 3);
  const cfgErrs = validateConfigIdsAgainstPatterns({
    selfId: 'wrong_self',
    collaborators: [{ id: 'ok_u' }].map((c) => ({ id: c.id === 'ok_u' ? 'bad_col' : c.id })),
    allowChatIds: ['grp:10'],
  }, patterns);
  assert.equal(cfgErrs.length, 2);
});

test('protocol hardening: ManagedChannel passthroughs (chatType, download ctx, att.extra) without HTTP extra leak', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-proto-mc-'));
  const observedSend: Array<{ chatId: string; opts?: ChannelSendOptions }> = [];
  const observedSendFile: Array<{ chatId: string; opts?: ChannelSendOptions }> = [];
  const observedHist: Array<{ chatId: string; opts?: ChannelGetHistoryOptions }> = [];
  const observedGetMsg: Array<{ chatId: string; msgId: string; opts?: ChannelGetMessageOptions }> = [];
  const observedDownload: Array<{ att: InboundAttachment; ctx?: ChannelDownloadContext }> = [];
  let push: ((raw: unknown) => void) | null = null;

  const plugin = defineChannelPlugin({
    name: 'proto-im',
    capabilities: { markdown: true, files: true, images: true, history: true, replyTo: true },
    idPatterns: { userId: /^u_/, chatId: /^(?:self|dm|grp):/ },
    create() {
      return {
        async start(onEvent) { push = onEvent; },
        async send(chatId, _text, opts) {
          observedSend.push({ chatId, opts });
          return 'out_1';
        },
        async sendFile(chatId, _file, opts) {
          observedSendFile.push({ chatId, opts });
          return 'file_1';
        },
        async download(att, savePath, ctx) {
          observedDownload.push({ att, ctx });
          fs.mkdirSync(path.dirname(savePath), { recursive: true });
          fs.writeFileSync(savePath, 'payload ok');
        },
        async getMessage(chatId, msgId, opts) {
          observedGetMsg.push({ chatId, msgId, opts });
          return null;
        },
        async getHistory(chatId, opts) {
          observedHist.push({ chatId, opts });
          return [];
        },
        async stop() {},
      };
    },
  });

  const kernel = new Kernel({
    config: {
      channel: { use: 'proto-im', options: { selfId: 'u_me', selfChatId: 'self:me' } },
      web: { host: '127.0.0.1', port: 0 },
      dataDir: tmpDir,
      chats: { collaborators: [] },
    },
  });
  kernel.use(webPlugin);
  kernel.use(plugin, { selfId: 'u_me', selfChatId: 'self:me' });
  kernel.use(imContextPlugin);

  try {
    await kernel.start();
    const channel = kernel.get<{
      start: (fn: (ev: unknown) => void) => Promise<void>;
      send: (chatId: string, text: string, opts?: ChannelSendOptions) => Promise<string | undefined>;
      sendFile: (chatId: string, file: { path: string; name: string }, opts?: ChannelSendOptions) => Promise<string | undefined>;
    }>('channel');
    const imCtx = kernel.get<{
      recordInbound: (ev: unknown) => void;
      pullManager: {
        getGrant: (cid: string, botId?: string | null) => string;
        handleAttachmentRequest: (url: URL, addr?: string) => Promise<Record<string, unknown> | undefined>;
        handleRequest: (url: URL, addr?: string) => Promise<Record<string, unknown>>;
      };
    }>('imContext');

    await channel.start((ev) => {
      imCtx.recordInbound(ev);
    });

    push!(createInboundMessage({
      id: 'm_grp_1',
      chat: { id: 'grp:42', type: 'group', name: '设计群' },
      sender: { id: 'u_me', name: 'Me', isSelf: true },
      text: '请看加密文件',
      attachments: [{
        id: 'att_secret_1',
        name: 'spec.txt',
        mime: 'text/plain',
        extra: { fileKey: 'fk_999', aesKey: 'secret_aes_123' },
      }],
    }, { selfId: 'u_me' }));

    await until(() => imCtx.pullManager !== undefined);
    await channel.send('grp:42', 'hi');
    assert.equal(observedSend[0]?.opts?.chatType, 'group');

    const tmpFile = path.join(tmpDir, 'out.txt');
    fs.writeFileSync(tmpFile, 'hello');
    await channel.sendFile('grp:42', { path: tmpFile, name: 'out.txt' });
    assert.equal(observedSendFile[0]?.opts?.chatType, 'group');

    const grant = imCtx.pullManager.getGrant('grp:42', 'bot_1');
    const attRes = await imCtx.pullManager.handleAttachmentRequest(
      new URL(`http://127.0.0.1/api/context/attachment?grant=${grant}&msgId=m_grp_1&attId=att_secret_1`),
      '127.0.0.1',
    );
    assert.equal(attRes?.ok, true);
    assert.equal(observedDownload[0]?.att.extra?.fileKey, 'fk_999');
    assert.equal(observedDownload[0]?.ctx?.chatId, 'grp:42');
    assert.equal(observedDownload[0]?.ctx?.chatType, 'group');

    // extra must NEVER leak over /api/context/history
    const histRes = await imCtx.pullManager.handleRequest(
      new URL(`http://127.0.0.1/api/context/history?grant=${grant}&msgId=m_grp_1`),
      '127.0.0.1',
    );
    assert.equal(JSON.stringify(histRes).includes('secret_aes_123'), false);
    assert.equal(JSON.stringify(histRes).includes('fk_999'), false);
  } finally {
    await kernel.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('protocol hardening: bridge isolates identical numeric msgId across two groups for seen/ownIds/msgRoute/fileMsgs/recall', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-proto-scope-'));
  const sent: Array<{ chatId: string; text: string; opts?: ChannelSendOptions }> = [];
  const uploadedFromDownload: Array<{ chatId?: string; attId: string }> = [];
  let seq = 0;

  const mock = makeMockHarness({
    onSendMessage(entry) {
      const reqId = `req_${++seq}`;
      const tid = String(entry.threadId || '');
      threadMsgs[tid] = [
        { id: reqId, role: 'user', text: String(entry.text || '') },
        { id: `bot_${reqId}`, role: 'bot', requestMessageId: reqId, kind: 'text', turnTerminal: true, text: `reply:${tid}` },
      ];
      return { message: { id: reqId } };
    },
  });
  const threadMsgs: Record<string, OmbMessage[]> = {};
  mock.client.getMessages = async (tid: string) => ({ messages: threadMsgs[tid] ?? [] });

  const bridge = new OpenMausBotBridge({
    client: mock.client,
    dataDir: tmpDir,
    sendRetries: 0,
    transport: {
      selfId: 'u_me',
      selfChatId: 'self_0',
      capabilities: { markdown: true, files: true, replyTo: true, history: false },
      async start() {},
      async send(chatId, text, opts) {
        sent.push({ chatId, text, opts });
        // Intentionally return the SAME numeric seq msgId "900" in different chats!
        return '900';
      },
      async download(att, savePath, ctx) {
        uploadedFromDownload.push({ chatId: ctx?.chatId, attId: att.id });
        fs.mkdirSync(path.dirname(savePath), { recursive: true });
        fs.writeFileSync(savePath, `content-${att.id}`);
      },
      async stop() {},
    },
  });
  await bridge.start();

  try {
    // 1. Two groups both send inbound msg id="101" with attachments — must NOT dedupe or collide!
    await bridge.onEvent({
      id: '101',
      ts: Date.now(),
      chat: { id: 'grp_A', type: 'group', name: 'A群' },
      sender: { id: 'u_me', name: 'Me', isSelf: true },
      text: '@bot 分析 A 群文件',
      attachments: [{ id: 'att_A', name: 'a.txt', chatId: 'grp_A' }],
    });
    await bridge.onEvent({
      id: '101',
      ts: Date.now() + 10,
      chat: { id: 'grp_B', type: 'group', name: 'B群' },
      sender: { id: 'u_me', name: 'Me', isSelf: true },
      text: '@bot 分析 B 群文件',
      attachments: [{ id: 'att_B', name: 'b.txt', chatId: 'grp_B' }],
    });

    await until(() => sent.filter((s) => s.chatId === 'grp_A' || s.chatId === 'grp_B').length === 2);
    assert.equal(mock.sentPrompts.length, 2, '不同群相同 msgId=101 不得被 seen 误去重');
    assert.ok(uploadedFromDownload.some((u) => u.chatId === 'grp_A' && u.attId === 'att_A'));
    assert.ok(uploadedFromDownload.some((u) => u.chatId === 'grp_B' && u.attId === 'att_B'));
    assert.equal(sent.find((s) => s.chatId === 'grp_A')?.opts?.chatType, 'group');
    assert.equal(sent.find((s) => s.chatId === 'grp_B')?.opts?.chatType, 'group');

    // 2. Recall msg "900" in grp_A must NOT delete grp_B's msgRoute for "900"!
    await bridge.onEvent({
      id: 'rec_A',
      kind: 'recall',
      ts: Date.now() + 20,
      chat: { id: 'grp_A', type: 'group' },
      sender: { id: 'u_me', isSelf: true },
      recalledMsgId: '900',
      text: '',
    });
    assert.equal(bridge.getMsgRoute('grp_A', '900'), null);
    assert.ok(bridge.getMsgRoute('grp_B', '900'), 'grp_A 撤回 id=900 不得影响 grp_B 同号路由');
  } finally {
    await bridge.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('protocol hardening: runChannelContractTest --strict & --check-history catch bad IDs and verify history/quote/mentions', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-proto-test-'));
  const contractUrl = pathToFileURL(path.join(APP_ROOT, 'src', 'core', 'channel-contract.ts')).href;
  const pluginPath = path.join(tmpDir, 'strict-im.mjs');
  const now = Date.now();
  fs.writeFileSync(pluginPath, `
    import { defineChannelPlugin, createInboundMessage } from ${JSON.stringify(contractUrl)};
    export default defineChannelPlugin({
      name: 'strict-im',
      capabilities: { markdown: true, files: false, history: true },
      idPatterns: { userId: /^u_/, chatId: /^(?:self|dm|grp)_/ },
      create() {
        return {
          async start(onMsg) {
            setTimeout(() => {
              onMsg(createInboundMessage({
                id: 'm_1',
                ts: ${now - 2000},
                chat: { id: 'self_main', type: 'self', name: '自聊' },
                sender: { id: 'u_me', name: 'Me', isSelf: true },
                quote: { msgId: 'm_0', senderId: 'u_alice', senderName: 'Alice', text: '原问题' },
                mentions: [{ id: 'u_bob', name: 'Bob' }],
                text: 'hi',
              }, { selfId: 'u_me', selfChatId: 'self_main' }));
            }, 15);
          },
          async send() { return 'out_strict_1'; },
          async getHistory(chatId) {
            return [
              { id: 'm_0', ts: ${now - 5000}, chat: { id: chatId, type: 'self' }, sender: { id: 'u_me', isSelf: true }, text: 'old' },
              { id: 'm_1', ts: ${now - 2000}, chat: { id: chatId, type: 'self' }, sender: { id: 'u_me', isSelf: true }, text: 'hi' },
            ];
          },
          async getMessage(chatId, msgId) {
            return { id: msgId, ts: ${now - 2000}, chat: { id: chatId, type: 'self' }, sender: { id: 'u_me', isSelf: true }, text: 'hi' };
          },
          async stop() {},
        };
      },
    });
  `);

  try {
    const okRes = await runChannelContractTest(
      { channel: { use: pluginPath, options: { selfId: 'u_me', selfChatId: 'self_main' } }, web: { host: '127.0.0.1', port: 0 }, dataDir: tmpDir },
      { dry: false, strict: true, checkHistory: true, waitSec: 2, waitExplicit: true, sendText: 'ping', log: () => {} },
    );
    assert.equal(okRes.ok, true);
    assert.equal(okRes.observations?.historyChecked, true);
    assert.equal(okRes.observations?.idSamples[0]?.quoteSenderId, 'u_alice');

    const badCfgRes = await runChannelContractTest(
      {
        channel: { use: pluginPath, options: { selfId: 'wrong_no_prefix', selfChatId: 'self_main' } },
        chats: { collaborators: [{ id: 'bad_col_id', name: 'Col', policy: 'confirm_in_self', projects: [], chats: [] }] },
        web: { host: '127.0.0.1', port: 0 },
        dataDir: tmpDir,
      },
      { dry: true, strict: true, log: () => {} },
    );
    assert.equal(badCfgRes.ok, false);
    assert.ok(badCfgRes.errors.some((e) => e.includes('selfId')));
    assert.ok(badCfgRes.errors.some((e) => e.includes('collaborators')));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('protocol hardening: inspector captures channel:contract_warning with chatId, idPatterns metadata, and /debug exposes it', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-proto-insp-'));
  let push: ((raw: unknown) => void) | null = null;
  const plugin = defineChannelPlugin({
    name: 'warn-im',
    capabilities: { markdown: true, files: false },
    idPatterns: { userId: /^u_/, chatId: /^(?:self|dm|grp)_/ },
    create() {
      return {
        async start(onEvent) { push = onEvent; },
        async send() { return 'out_w1'; },
        async stop() {},
      };
    },
  });

  const kernel = new Kernel({
    config: {
      channel: { use: 'warn-im', options: { selfId: 'u_me', selfChatId: 'self_main' } },
      web: { host: '127.0.0.1', port: 0 },
      dataDir: tmpDir,
      chats: { collaborators: [] },
    },
    logger: { warn: () => {}, error: () => {} },
  });
  kernel.use(webPlugin);
  kernel.use(plugin, { selfId: 'u_me', selfChatId: 'self_main' });
  kernel.use(inspectorPlugin);

  try {
    await kernel.start();
    const channel = kernel.get<{ start: (fn: (ev: unknown) => void) => Promise<void> }>('channel');
    const web = kernel.get<{ server: http.Server | null }>('web');
    const baseUrl = `http://127.0.0.1:${(web.server!.address() as AddressInfo).port}`;

    await channel.start(() => {});
    // Emit non-strict inbound message that violates userId pattern and uses name_fallback mention
    push!({
      id: 'm_warn_1',
      chat: { id: 'grp_warn', type: 'group', name: '告警测试群' },
      sender: { id: 'bad_user_no_prefix', name: 'BadUser', isSelf: false },
      mentions: ['Alice'],
      text: 'hi',
    });

    const stRes = await fetch(`${baseUrl}/api/status`).then((r) => r.json()) as {
      channel?: { contractWarnings?: number; idPatterns?: string[]; strictContract?: boolean };
    };
    assert.equal((stRes.channel?.contractWarnings ?? 0) >= 2, true);
    assert.deepEqual(stRes.channel?.idPatterns, ['userId', 'chatId']);
    assert.equal(stRes.channel?.strictContract, false);

    const evRes = await fetch(`${baseUrl}/api/debug/events?type=contract_warning&chatId=grp_warn`).then((r) => r.json()) as {
      events: Array<{ source: string; type: string; chatId?: string; summary: string }>;
    };
    assert.equal(evRes.events.length >= 2, true);
    assert.equal(evRes.events[0].source, 'channel');
    assert.equal(evRes.events[0].type, 'contract_warning');
    assert.equal(evRes.events[0].chatId, 'grp_warn');
    assert.ok(evRes.events.some((e) => e.summary.includes('userId')));

    const bundleRes = await fetch(`${baseUrl}/api/debug/bundle`).then((r) => r.json()) as {
      events: Array<{ type: string }>;
    };
    assert.ok(bundleRes.events.some((e) => e.type === 'contract_warning'));

    const debugHtml = fs.readFileSync(path.join(APP_ROOT, 'public', 'debug.html'), 'utf8');
    assert.match(debugHtml, /<option value="contract_warning">contract_warning<\/option>/);
    assert.match(debugHtml, /契约告警/);
    assert.match(debugHtml, /ID 格式护栏/);
    assert.match(debugHtml, /协调收件箱/);
  } finally {
    await kernel.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
