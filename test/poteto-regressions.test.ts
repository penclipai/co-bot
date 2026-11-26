import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { validateConfig } from '../src/config.ts';
import { sanitizeExternalMentions } from '../src/core/chat-context.ts';
import { redactTextFileBeforeSend, scanAndRedactOutbound } from '../src/core/security.ts';
import { fileSafe, hardBreaks, mdClip, plain } from '../src/format.ts';
import { WebSimTransport } from '../src/im/sim.ts';
import { OpenMausBotBridge } from '../src/openmausbot/bridge.ts';
import { OpenMausBotClient } from '../src/openmausbot/client.ts';
import { parseDelegationTag } from '../src/openmausbot/delegation.ts';
import { emitCard } from '../src/openmausbot/delivery.ts';
import type { OmbMessage } from '../src/openmausbot/types.ts';
import { WebServer } from '../src/web/server.ts';
import { probeHostOf } from '../scripts/omb.ts';
import type { InboundEvent } from '../src/types.ts';
import { getFreePort, makeIm, type SentImItem, startMockOmb, until } from './helpers/mock-omb.ts';

function loadMdRenderer(): (md: string) => string {
  const code = fs.readFileSync(path.resolve('public/md.js'), 'utf8');
  const ctx: { window: { renderMarkdown?: (md: string) => string } } = { window: {} };
  vm.runInNewContext(code, ctx);
  assert.equal(typeof ctx.window.renderMarkdown, 'function');
  return ctx.window.renderMarkdown!;
}

test('format helpers: fileSafe traversal guard, plain code spans, hardBreaks HR, mdClip tilde', () => {
  assert.equal(fileSafe('..'), '');
  assert.equal(fileSafe('.'), '');
  assert.equal(fileSafe('../secret'), 'secret');
  assert.equal(fileSafe('---'), '');

  assert.equal(plain('`__init__.py` and `C:\\Users\\_admin`'), '__init__.py and C:\\Users\\_admin');
  assert.equal(plain('__bold__ and `C:\\Users\\a`'), 'bold and C:\\Users\\a');

  const hb = hardBreaks('Line A\n---\nLine B\r\nLine C');
  assert.equal(hb.includes('Line A  \n---'), false, 'line before --- must not become Setext H2');
  assert.equal(hb.includes('---  '), false, '--- itself must not have trailing spaces');
  assert.equal(hb.includes('Line B  \nLine C'), true);

  assert.deepEqual(mdClip('hello', 0), { text: '…', cut: true });
  const tilde = mdClip('~~~js\nconst a = 1;\nconst b = 2;\n~~~', 18);
  assert.equal(tilde.cut, true);
  assert.match(tilde.text, /\n~~~\n\n…$/);
});

test('security & mention sanitizer: JSON keys, redis URL, .pem file, trailing punctuation', () => {
  const jsonScan = scanAndRedactOutbound('{"token": "secret_value_12345", "url": "redis://:redispass99@127.0.0.1:6379"}');
  assert.equal(jsonScan.redacted, true);
  assert.equal(jsonScan.text.includes('secret_value_12345'), false);
  assert.equal(jsonScan.text.includes('redispass99'), false);

  const dashKey = scanAndRedactOutbound('key=sk-ant-abc1234567890-');
  assert.equal(dashKey.text.includes('abc1234567890-'), false);

  const envSample = scanAndRedactOutbound('token: process.env.OMB_TOKEN');
  assert.equal(envSample.redacted, false);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-pem-redact-'));
  try {
    const pemPath = path.join(tmpDir, 'cert.pem');
    fs.writeFileSync(pemPath, '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqh\n-----END PRIVATE KEY-----\n');
    const res = redactTextFileBeforeSend(pemPath, 'cert.pem');
    assert.equal(res.redacted, true);
    assert.equal(fs.readFileSync(res.sendPath, 'utf8').includes('MIIBVQIBADANBgkqh'), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const sanitized = sanitizeExternalMentions('请看 @所有人。和 @all. 以及 @Plum。还有 @Alice', {
    mode: 'dangerous',
    botNames: ['Plum'],
  });
  assert.equal(sanitized.includes('@\u200B所有人。'), true);
  assert.equal(sanitized.includes('@\u200Ball.'), true);
  assert.equal(sanitized.includes('@\u200BPlum。'), true);
  assert.equal(sanitized.includes('@Alice'), true);
});

test('validateConfig strict types and probeHostOf wildcard/IPv6', () => {
  assert.equal(validateConfig({ web: { port: '' as never } }).ok, false);
  assert.equal(validateConfig({ web: 'bad' as never }).ok, false);
  assert.equal(validateConfig({ projects: [{ name: '', path: '/tmp' }] }).ok, false);

  assert.equal(probeHostOf('0.0.0.0'), '127.0.0.1');
  assert.equal(probeHostOf('::'), '127.0.0.1');
  assert.equal(probeHostOf('::1'), '[::1]');
  assert.equal(probeHostOf('127.0.0.1'), '127.0.0.1');
});

test('md.js renders nested code links cleanly and leaves markdown around bare URLs intact', () => {
  const render = loadMdRenderer();
  const codeLink = render('[`foo`](https://example.com)');
  assert.equal(codeLink.includes('\u0000'), false);
  assert.match(codeLink, /<a href="https:\/\/example\.com"[^>]*><code>foo<\/code><\/a>/);

  const boldUrl = render('**https://example.com** 和「https://example.com/a」');
  assert.match(boldUrl, /<strong><a href="https:\/\/example\.com"/);
  assert.match(boldUrl, /「<a href="https:\/\/example\.com\/a"[^>]*>https:\/\/example\.com\/a<\/a>」/);
});

test('WebSimTransport /events wraps history replay in history_start and history_end', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-sim-framing-'));
  const port = await getFreePort();
  const web = new WebServer({ host: '127.0.0.1', port, publicDir: path.resolve('public') });
  const sim = new WebSimTransport({ web, filesDir: path.join(tmpDir, 'files'), historyFile: null });
  await web.start();
  await sim.start(async () => {});
  try {
    await sim.send('self', '第一条历史');
    const res = await fetch(`http://127.0.0.1:${port}/events`);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (!buf.includes('"history_end"')) {
      const next = await reader.read();
      if (next.done) break;
      buf += dec.decode(next.value);
    }
    const startIdx = buf.indexOf('"kind":"history_start"');
    const msgIdx = buf.indexOf('第一条历史');
    const endIdx = buf.indexOf('"kind":"history_end"');
    assert.ok(startIdx >= 0 && msgIdx > startIdx && endIdx > msgIdx);
    await reader.cancel();
  } finally {
    await sim.stop();
    await web.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('bridge enforces draft_first on @bot new, respects reply priority, checks collaborator projects, and cleans up resumed turns', async () => {
  const omb = await startMockOmb([{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }]);
  const sent: SentImItem[] = [];
  const baseTransport = makeIm(sent);
  let online = true;
  let inboundFn: ((ev: InboundEvent) => unknown) | null = null;
  const transport = {
    ...baseTransport,
    async start(fn: (ev: InboundEvent) => unknown) {
      inboundFn = fn;
      return baseTransport.start(fn);
    },
    async send(chatId: string, text: string, opts?: Parameters<typeof baseTransport.send>[2]) {
      if (!online) throw new Error('offline');
      return baseTransport.send(chatId, text, opts);
    },
    status: () => ({ connected: online }),
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-poteto-bridge-'));
  const hrDir = path.join(tmpDir, 'hr-secret');
  const appDir = path.join(tmpDir, 'public-app');
  fs.mkdirSync(hrDir, { recursive: true });
  fs.mkdirSync(appDir, { recursive: true });

  const bridge = new OpenMausBotBridge({
    client: new OpenMausBotClient({ baseUrl: omb.baseUrl }),
    transport,
    dataDir: tmpDir,
    chats: {
      mode: 'owner_everywhere',
      externalReplyMode: 'draft_first',
      collaborators: [{ id: 'col_1', name: 'Tom', policy: 'auto_readonly', projects: ['public-app'], chats: ['grp_1'] }],
    },
    projects: [
      { name: 'private-hr', path: hrDir, aliases: [] },
      { name: 'public-app', path: appDir, aliases: [] },
    ],
    sendRetries: 0,
    turnStallMs: 0,
  });

  try {
    await bridge.start();
    await baseTransport.emitUser('bootstrap');

    // 1. Collaborator plain @bot mention mentioning unauthorized project must be denied
    await inboundFn!({
      id: 'col_msg_1',
      ts: Date.now(),
      chat: { id: 'grp_1', type: 'group', name: '协作群' },
      sender: { id: 'col_1', name: 'Tom', isSelf: false },
      text: '@bot 请看 private-hr 的工资表',
    });
    assert.equal(omb.sentToOmb.length, 0);
    assert.equal(bridge.policyDenials >= 1, true);

    // 2. @bot new <prompt> in external chat enforces draft_first
    let extNewSawDone = false;
    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      const m: OmbMessage = {
        id: nextId(),
        role: 'bot',
        kind: 'text',
        turnTerminal: true,
        threadId,
        requestMessageId: reqMsg.id,
        text: '新线程分析结果',
      };
      messages.push(m);
      jobs.set(threadId, { state: 'completed', version: 'v2', needsInput: [] });
      broadcast({ type: 'message.created', threadId, message: m });
      broadcast({ type: 'bot.updated', bot: { id: 'b1', threadId, busy: false } });
      extNewSawDone = true;
    });
    await inboundFn!({
      id: 'ext_new_1',
      ts: Date.now(),
      chat: { id: 'grp_ext', type: 'group', name: '研发群' },
      sender: { id: 'me', name: 'Me', isSelf: true },
      text: '@bot new 总结当前进展',
    });
    await until(() => extNewSawDone && sent.some((m) => m.text.includes('新线程分析结果')));
    const draftMsg = sent.find((m) => m.text.includes('新线程分析结果'))!;
    assert.equal(draftMsg.text.includes('私密回复'), true);

    // 3. Pending card vs pendingSendBack & pendingTaskPick priority
    bridge.pendingCards.set('card_msg_1', {
      imMsgId: 'card_msg_1',
      cardKind: 'card',
      cardBotId: 'b1',
      requestId: 'req_prio_1',
      threadId: 't1',
      botId: 'b1',
      botName: 'co-bot',
      ombMsgId: 'omb_prio_1',
      title: '允许执行测试命令？',
      isQuestion: false,
      options: [],
      canRememberCommand: false,
    });
    bridge.pendingSendBack = {
      draft: {
        id: 'draft_1',
        imMsgId: 'd_1',
        originChatId: 'grp_ext',
        originChatName: '研发群',
        originChatType: 'group',
        replyToImMsgId: null,
        rawText: '草稿正文',
        addBotPrefix: true,
        createdAt: Date.now(),
      },
      text: '🤖 **[co-bot]** 草稿正文',
      expiresAt: Date.now() + 60_000,
    };
    const respondsBeforeSendBack = omb.responds.length;
    await baseTransport.emitUser('ok');
    await until(() => sent.some((m) => m.text.includes('已发回') || m.text.includes('确认')));
    assert.equal(omb.responds.length, respondsBeforeSendBack, 'sendback confirm must not trigger pending card approval');
    assert.equal(bridge.pendingCards.has('card_msg_1'), true);

    // Quote-reply to card still answers card even when taskPick is active
    bridge.pendingTaskPick = {
      botId: 'b1',
      botName: 'co-bot',
      isGroup: false,
      tasks: [{ id: 't1', threadId: 't1', title: '任务1' }, { id: 't2', threadId: 't2', title: '任务2' }],
      expiresAt: Date.now() + 60_000,
    };
    await baseTransport.emitUser('2', { replyTo: 'card_msg_1' });
    await until(() => omb.responds.some((r) => r.requestId === 'req_prio_1'));
    assert.equal(bridge.pendingCards.has('card_msg_1'), false);

    // 4. emitCard rolls back deliveredCards if transport is disconnected / fails
    online = false;
    await emitCard(bridge, 'b1', 'MausBot', 't1', {
      id: 'card_fail_omb',
      role: 'bot',
      kind: 'card',
      card: { requestId: 'req_fail_1', title: 'Offline test' },
    });
    assert.equal(bridge.deliveredCards.has('req_fail_1'), false);
    assert.equal(bridge.pendingCards.size, 0);
    online = true;
    await emitCard(bridge, 'b1', 'MausBot', 't1', {
      id: 'card_fail_omb',
      role: 'bot',
      kind: 'card',
      card: { requestId: 'req_fail_1', title: 'Offline retry test' },
    });
    assert.equal(bridge.deliveredCards.has('req_fail_1'), true);
    assert.equal(bridge.pendingCards.size, 1);

    // 5. Resumed turn awaiting card keeps inFlightTurns intact and aborts cleanly on stop
    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      const cardMsg: OmbMessage = {
        id: nextId(),
        role: 'bot',
        kind: 'card',
        threadId,
        requestMessageId: reqMsg.id,
        card: { requestId: 'req_resume_1', title: 'Need input before continuing' },
      };
      messages.push(cardMsg);
      jobs.set(threadId, { state: 'needs-input', version: 'v3', needsInput: [{ requestId: 'req_resume_1' }] });
      broadcast({ type: 'message.created', threadId, message: cardMsg });
      broadcast({ type: 'bot.updated', bot: { id: 'b1', threadId, busy: false } });
    });
    await baseTransport.emitUser('@bot 执行需要审批的动作');
    await until(() => sent.some((m) => m.text.includes('Need input before continuing')));
    assert.equal(bridge.inFlightTurns.size >= 1, true, 'inFlightTurns should stay while waiting for card response');
  } finally {
    await bridge.stop();
    await omb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('UX QA fixes: sub-bot bye clears focus/sticky, inline [cobot:req], C2C context isolation, sendback attribution, and upload traversal rejection', async () => {
  const inlineReq = parseDelegationTag('[cobot:req id=qa01 proj=happy-bot] 一句话说明脚本');
  assert.equal(inlineReq?.kind, 'req');
  if (inlineReq?.kind === 'req') {
    assert.equal(inlineReq.id, 'qa01');
    assert.equal(inlineReq.project, 'happy-bot');
    assert.equal(inlineReq.body, '一句话说明脚本');
  }
  assert.equal(parseDelegationTag('普通讨论里提到 `[cobot:req id=fake]` 不应误触发'), null);

  const omb = await startMockOmb([
    { id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true },
    { id: 'b2', name: 'Page', threadId: 't_page', chiefOfStaff: false },
  ]);
  const sent: Array<SentImItem & { chatId: string }> = [];
  let inboundFn: ((ev: InboundEvent) => unknown) | null = null;
  let seq = 0;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-ux-qa2-'));
  const appDir = path.join(tmpDir, 'happy-bot');
  const hrDir = path.join(tmpDir, 'private-hr');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(hrDir, { recursive: true });

  const bridge = new OpenMausBotBridge({
    client: new OpenMausBotClient({ baseUrl: omb.baseUrl }),
    transport: {
      selfChatId: 'self',
      canFiles: false,
      async start(fn) { inboundFn = fn; },
      async stop() {},
      async send(chatId, text, opts) {
        const id = `m_${++seq}`;
        sent.push({ id, chatId, text, replyTo: opts?.replyTo ?? null, actions: opts?.actions });
        return id;
      },
    },
    dataDir: tmpDir,
    chats: {
      mode: 'owner_everywhere',
      collaborators: [{ id: 'alice', name: 'Alice', policy: 'auto_readonly', projects: ['happy-bot'], chats: ['dm_alice'] }],
    },
    projects: [
      { name: 'happy-bot', path: appDir, aliases: [] },
      { name: 'private-hr', path: hrDir, aliases: [] },
    ],
    turnStallMs: 0,
  });

  try {
    await bridge.start();
    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      const m: OmbMessage = {
        id: nextId(),
        role: 'bot',
        kind: 'text',
        turnTerminal: true,
        threadId,
        requestMessageId: reqMsg.id,
        text: '来自机器人正文',
      };
      messages.push(m);
      jobs.set(threadId, { state: 'completed', version: 'v2', needsInput: [] });
      broadcast({ type: 'message.created', threadId, message: m });
    });

    // 1. Sub-bot @Page bye closes sticky & clears focus
    await inboundFn!({
      id: 'u_page_1',
      ts: Date.now(),
      chat: { id: 'self', type: 'self' },
      sender: { id: 'me', name: 'Me', isSelf: true },
      text: '@Page 自我介绍',
    });
    await until(() => sent.some((m) => m.text.includes('🤖 **[Page]**\n---\n来自机器人正文')));
    assert.equal(bridge.isStickyActive(), true);
    assert.equal(bridge.focus?.botId, 'b2');

    await inboundFn!({
      id: 'u_page_bye',
      ts: Date.now() + 10,
      chat: { id: 'self', type: 'self' },
      sender: { id: 'me', name: 'Me', isSelf: true },
      text: '@Page bye',
    });
    assert.equal(bridge.isStickyActive(), false);
    assert.equal(bridge.focus, null);
    const beforeNotePrompts = omb.sentToOmb.length;
    await inboundFn!({
      id: 'u_plain_note',
      ts: Date.now() + 20,
      chat: { id: 'self', type: 'self' },
      sender: { id: 'me', name: 'Me', isSelf: true },
      text: '自聊备忘：明天开会',
    });
    assert.equal(omb.sentToOmb.length, beforeNotePrompts, 'plain note after @Page bye must not dispatch');

    // 2. Denied inline [cobot:req] probe does not leak into dm_alice context, and valid inline C2C has single 🤖
    await inboundFn!({
      id: 'alice_deny_1',
      ts: Date.now() + 30,
      chat: { id: 'dm_alice', type: 'direct', name: 'Alice' },
      sender: { id: 'alice', name: 'Alice', isSelf: false },
      text: '[cobot:req id=qa_deny proj=private-hr] 读取薪资',
    });
    assert.equal(bridge.localContextStore.getRecent('dm_alice', { limit: 10 }).length, 0);

    const beforeC2cCount = sent.length;
    await inboundFn!({
      id: 'alice_ok_1',
      ts: Date.now() + 40,
      chat: { id: 'dm_alice', type: 'direct', name: 'Alice' },
      sender: { id: 'alice', name: 'Alice', isSelf: false },
      text: '[cobot:req id=qa_ok proj=happy-bot] 一句话说明脚本',
    });
    await until(() => sent.length > beforeC2cCount && sent.some((m) => m.chatId === 'dm_alice' && m.text.includes('[cobot:res re=qa_ok]')));
    const c2cReply = sent.find((m) => m.chatId === 'dm_alice' && m.text.includes('[cobot:res re=qa_ok]'))!;
    assert.equal(c2cReply.text.includes('🤖 协作答复'), false, 'must not duplicate 🤖 when Style A badge is prepended');
    assert.match(c2cReply.text, /^🤖 \*\*\[co-bot\]\*\*\n---\n协作答复：/);

    // 3. @bot! unedited sendback uses 🤖 attribution and preview labels it clearly
    const beforePriv = sent.length;
    await inboundFn!({
      id: 'owner_priv_1',
      ts: Date.now() + 50,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: 'Me', isSelf: true },
      text: '@bot! 总结当前问题',
    });
    await until(() => sent.length > beforePriv && sent.some((m) => m.chatId === 'self' && m.text.includes('私密回复')));
    await inboundFn!({
      id: 'owner_sb_1',
      ts: Date.now() + 60,
      chat: { id: 'self', type: 'self' },
      sender: { id: 'me', name: 'Me', isSelf: true },
      text: '@bot sendback',
    });
    const sbPreview = sent.at(-1)!;
    assert.match(sbPreview.text, /以 🤖 \*\*\[co-bot\]\*\* 名义/);
    await inboundFn!({
      id: 'owner_sb_ok',
      ts: Date.now() + 70,
      chat: { id: 'self', type: 'self' },
      sender: { id: 'me', name: 'Me', isSelf: true },
      text: '确认发送',
    });
    const grpSent = sent.filter((m) => m.chatId === 'grp_dev').at(-1)!;
    assert.equal(grpSent.text.startsWith('🤖 **[co-bot]**\n---\n'), true);
  } finally {
    await bridge.stop();
    await omb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 4. WebSimTransport /upload rejects path traversal segments with 400
  const simTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-sim-upload-'));
  const port = await getFreePort();
  const web = new WebServer({ host: '127.0.0.1', port, publicDir: path.resolve('public') });
  const sim = new WebSimTransport({ web, filesDir: simTmp, historyFile: null });
  await web.start();
  await sim.start(async () => {});
  try {
    const res = await fetch(`http://127.0.0.1:${port}/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'self', sender: 'me', name: '../../evil.txt', data: 'ZXZpbA==' }),
    });
    assert.equal(res.status, 400);
  } finally {
    await sim.stop();
    await web.stop();
    fs.rmSync(simTmp, { recursive: true, force: true });
  }
});
