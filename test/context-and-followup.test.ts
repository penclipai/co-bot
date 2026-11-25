import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { defineChannelPlugin, normalizeInboundEvent } from '../src/core/channel-contract.ts';
import { scanAndRedactOutbound } from '../src/core/security.ts';
import { Kernel } from '../src/core/kernel.ts';
import { WebSimTransport } from '../src/im/sim.ts';
import { parseAskProposal } from '../src/openmausbot/follow-up.ts';
import { WebServer } from '../src/web/server.ts';
import { imContextPlugin } from '../src/plugins/im-context.ts';
import { inspectorPlugin } from '../src/plugins/inspector.ts';
import { openmausbotPlugin } from '../src/plugins/openmausbot.ts';
import { webPlugin } from '../src/plugins/web.ts';
import type { ChannelSendOptions, RawConfig } from '../src/types.ts';

const until = async (fn: () => boolean | Promise<boolean>, ms = 5000): Promise<void> => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail('timeout waiting for condition');
};

async function startInteractiveMockOmb(responder: (req: {
  prompt: string;
  threadId: string;
  msgId: string;
  uploads: string[];
}) => { text: string }) {
  let seq = 1;
  const threadMsgs = new Map<string, Array<Record<string, unknown>>>();
  const threadJobs = new Map<string, Record<string, unknown>>();
  const prompts: Array<{ threadId: string; text: string }> = [];
  const uploads: string[] = [];

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const json = (c: number, d: unknown) => {
      res.writeHead(c, { 'content-type': 'application/json' });
      res.end(JSON.stringify(d));
    };
    if (req.method === 'GET' && u.pathname === '/api/health') return json(200, { app: 'openmausbot', version: '0.1.180-mock', box: 'off' });
    if (req.method === 'GET' && u.pathname === '/.well-known/openmausbot/environment') return json(200, { capabilities: { selfUpdate: 'operator' } });
    if (req.method === 'GET' && u.pathname === '/api/auth/session') return json(200, { kind: 'none', scopes: [] });
    if (req.method === 'GET' && u.pathname === '/api/bots') {
      return json(200, { bots: [{ id: 'b1', name: 'co-bot', threadId: 't_self', chiefOfStaff: true }], groups: [] });
    }
    if (req.method === 'GET' && u.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"kind":"hello","cursor":"1"}\n\n');
      req.on('close', () => res.end());
      return;
    }
    if (req.method === 'POST' && u.pathname === '/api/bots/b1/tasks') {
      const tid = `t_ext_${seq++}`;
      threadMsgs.set(tid, []);
      threadJobs.set(tid, { state: 'idle', version: 'v0', needsInput: [] });
      return json(201, { ok: true, task: { id: tid, threadId: tid } });
    }
    if (req.method === 'POST' && (u.pathname === '/api/files' || u.pathname === '/api/bots/b1/uploads')) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const name = u.searchParams.get('name') || 'file.bin';
      const saved = `/mock/${seq++}_${name}`;
      uploads.push(saved);
      return json(200, { path: saved });
    }
    if (req.method === 'POST' && u.pathname === '/api/bots/b1/messages') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { text: string; threadId?: string; sendId: string };
      const tid = body.threadId || 't_self';
      prompts.push({ threadId: tid, text: body.text });
      const msgId = `omb_u_${seq++}`;
      const r = responder({ prompt: body.text, threadId: tid, msgId, uploads });
      const list = threadMsgs.get(tid) ?? [];
      list.push({
        id: `omb_b_${seq++}`,
        role: 'bot',
        kind: 'text',
        threadId: tid,
        requestMessageId: msgId,
        text: r.text,
        turnTerminal: true,
      });
      threadMsgs.set(tid, list);
      threadJobs.set(tid, { state: 'completed', version: `v_${seq}`, needsInput: [] });
      return json(202, {
        ok: true,
        threadId: tid,
        message: { id: msgId, role: 'user', kind: 'text', threadId: tid, text: body.text, sendId: body.sendId },
      });
    }
    const jobM = u.pathname.match(/^\/api\/threads\/([^/]+)\/job$/);
    if (req.method === 'GET' && jobM) {
      return json(200, threadJobs.get(jobM[1]) ?? { state: 'completed', version: 'v0', needsInput: [] });
    }
    const msgM = u.pathname.match(/^\/api\/threads\/([^/]+)\/messages$/);
    if (req.method === 'GET' && msgM) {
      return json(200, { messages: [...(threadMsgs.get(msgM[1]) ?? [])] });
    }
    json(404, { error: 'not found' });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    prompts,
    uploads,
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

test('Context E2E: forwards (single & merged), oversized chunked pull, self-chat pending isolation & security boundaries', async () => {
  const omb = await startInteractiveMockOmb(({ prompt }) => {
    if (prompt.includes('追问已获')) {
      return { text: '综合 Alice 的配置说明，建议将连接池上限调整为 32。' };
    }
    if (prompt.includes('需追问触发')) {
      return {
        text: '我已分析现有日志，还需确认生产连接池配置。\n[cobot:ask chat=grp_ops to=Alice] @Alice 麻烦确认下 prod 连接池配置（别提醒 @everyone）？',
      };
    }
    return { text: '收到上下文分析完成。' };
  });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-ctx-e2e-'));
  let pushInbound: ((raw: unknown) => void) | null = null;
  const sent: Array<{ chatId: string; text: string; opts?: ChannelSendOptions }> = [];
  const remoteHistory: Array<Record<string, unknown>> = [
    {
      msgId: 'hist_1',
      chatId: 'grp_ops',
      chatType: 'group',
      chatName: '运维群',
      fromId: 'u_bob',
      fromName: 'Bob',
      text: '早上的数据库告警 ERR_POOL_900 已恢复（token=secret_db_token_999）',
      time: Date.now() - 600_000,
    },
    {
      msgId: 'hist_recalled',
      chatId: 'grp_ops',
      chatType: 'group',
      chatName: '运维群',
      fromId: 'u_bob',
      fromName: 'Bob',
      text: '这条已撤回消息不应返回',
      time: Date.now() - 550_000,
    },
  ];

  const chan = defineChannelPlugin({
    name: 'mock-full',
    capabilities: { markdown: true, files: true, images: true, replyTo: true, history: true, actions: false },
    create() {
      return {
        async start(onEvent) { pushInbound = onEvent; },
        async send(chatId, text, opts) {
          const id = `out_${sent.length + 1}`;
          sent.push({ chatId, text, opts });
          return id;
        },
        async sendFile() { return 'file_out_1'; },
        async download(_att, dest) { fs.writeFileSync(dest, 'log line\n'); },
        async getHistory(chatId) {
          return chatId === 'grp_ops' ? remoteHistory : [];
        },
        async stop() {},
      };
    },
  });

  const cfg: RawConfig = {
    openmausbot: { url: omb.baseUrl, autoStart: false, cliComputerOff: false, syncChiefIdentity: false },
    channel: { use: 'mock-full', options: { selfId: 'u_me', selfChatId: 'chat_self' } },
    web: { host: '127.0.0.1', port: 0 },
    selfChat: { trigger: '@bot', followUpWindowMs: 120_000, fileRetentionDays: 0, stateSaveDebounceMs: 0 },
    chats: { mode: 'owner_everywhere', externalReplyMode: 'inline' },
    dataDir,
  };

  const kernel = new Kernel({ config: cfg });
  kernel.use(webPlugin);
  kernel.use(chan, { selfId: 'u_me', selfChatId: 'chat_self' });
  kernel.use(imContextPlugin);
  kernel.use(openmausbotPlugin, { autoHealOmb: null });
  kernel.use(inspectorPlugin);

  try {
    await kernel.start();
    const web = kernel.get<{ server: http.Server | null }>('web');
    const baseUrl = `http://127.0.0.1:${(web.server!.address() as AddressInfo).port}`;

    // Verify normalizeInboundEvent supports forwarded & isForwarded
    const normCheck = normalizeInboundEvent({
      msgId: 'n1',
      chatId: 'grp_ops',
      chatType: 'group',
      fromId: 'u_me',
      text: '',
      forwarded: { title: '群聊记录', messages: [{ senderName: 'Bob', text: 'hello' }] },
    });
    assert.equal(normCheck.isForwarded, true);
    assert.equal(normCheck.forwarded?.messages.length, 1);

    // Scenario A: External group recall + oversized (>10KB) one-by-one forward + merged forward
    pushInbound!({ kind: 'recall', chatId: 'grp_ops', chatType: 'group', recalledMsgId: 'hist_recalled' });

    const hugeLog = `START_MARKER ${'A'.repeat(9500)} END_MARKER token=ghp_1234567890abcdefghij1234567890`;
    pushInbound!({
      msgId: 'grp_fwd_huge',
      chatId: 'grp_ops',
      chatType: 'group',
      chatName: '运维群',
      fromId: 'u_me',
      fromName: '我',
      isSelf: true,
      isForwarded: true,
      text: hugeLog,
      time: Date.now() - 20_000,
    });
    pushInbound!({
      msgId: 'grp_merged_1',
      chatId: 'grp_ops',
      chatType: 'group',
      chatName: '运维群',
      fromId: 'u_alice',
      fromName: 'Alice',
      isSelf: false,
      text: '',
      forwarded: {
        title: '故障群讨论',
        messages: [
          { id: 'm_a', senderName: 'Alice', text: '节点 1 CPU 飙高' },
          { id: 'm_b', senderName: 'Bob', text: '发现泄漏密码 password=supersecretvalue123' },
          { id: 'm_c', senderName: 'Alice', text: '已上传 heap.log', attachments: [{ id: 'att_heap', name: 'heap.log' }] },
          { id: 'm_d', senderName: 'Bob', text: '第 4 条补充上下文细节，需要一起分析' },
          { id: 'm_e', senderName: 'Alice', text: '第 5 条补充详情与堆栈特征' },
        ],
      },
      time: Date.now() - 10_000,
    });

    await pushInbound!({
      msgId: 'grp_ask_1',
      chatId: 'grp_ops',
      chatType: 'group',
      chatName: '运维群',
      fromId: 'u_me',
      fromName: '我',
      isSelf: true,
      text: '@bot 看以上内容并总结，顺便准备需追问触发',
      time: Date.now(),
    });

    await until(() => omb.prompts.length >= 1 && sent.some((s) => s.chatId === 'chat_self' && s.text.includes('确认向「运维群」追问 @Alice')));

    const grpPrompt = omb.prompts[0].text;
    assert.match(grpPrompt, /\[转发\].*\[已截断，共 \d+ 字，查全文请用 msgId=grp_fwd_huge\]/);
    assert.match(grpPrompt, /\[合并转发 · 故障群讨论，共 5 条\].*msgId=grp_merged_1/);
    assert.match(grpPrompt, /context_pull: http:\/\/127\.0\.0\.1:\d+\/api\/context\/history\?grant=g_/);
    assert.ok(omb.uploads.some((p) => p.includes('heap.log')), '合并转发中的附件 heap.log 应自动提取并上传');
    // Verify scanAndRedactOutbound never masks grant= as secret_kv!
    assert.equal(scanAndRedactOutbound(grpPrompt).text.includes('grant=g_'), true);

    // Scenario B: On-demand /api/context/history pull (detail chunking, merged forward, remote before pagination + recall filter, search, security guards)
    const pullUrlM = grpPrompt.match(/context_pull:\s*(http:\/\/127\.0\.0\.1:\d+\/api\/context\/history\?grant=([a-z0-9_]+))/);
    assert.ok(pullUrlM);
    const pullBase = pullUrlM[1];

    // 1) Chunked detail read on 10KB forwarded message (>9500 chars)
    const p1 = await fetch(`${pullBase}&msgId=grp_fwd_huge&offset=0&limit=5000`).then((r) => r.json()) as {
      ok: boolean; text: string; hasMore: boolean; nextOffset: number;
    };
    assert.equal(p1.ok, true);
    assert.equal(p1.hasMore, true);
    assert.match(p1.text, /^START_MARKER/);
    const p2 = await fetch(`${pullBase}&msgId=grp_fwd_huge&offset=${p1.nextOffset}&limit=6000`).then((r) => r.json()) as {
      ok: boolean; text: string; hasMore: boolean;
    };
    assert.equal(p2.hasMore, false);
    assert.match(p2.text, /END_MARKER/);
    assert.equal(p2.text.includes('ghp_1234567890'), false, '全文拉取接口必须执行敏感凭证脱敏');

    // 2) Full merged forward record via msgId=grp_merged_1
    const pm = await fetch(`${pullBase}&msgId=grp_merged_1`).then((r) => r.json()) as { text: string };
    assert.match(pm.text, /合并转发记录 · 故障群讨论（共 5 条）/);
    assert.match(pm.text, /第 5 条补充详情/);
    assert.equal(pm.text.includes('supersecretvalue123'), false, '合并转发详情也必须脱敏');

    // 3) History pagination merges remote channel.getHistory and filters out recalled messages
    const ph = await fetch(`${pullBase}&before=grp_fwd_huge&limit=10`).then((r) => r.json()) as {
      messages: Array<{ id: string; preview: string }>;
    };
    assert.equal(ph.messages.some((m) => m.id === 'hist_1' && !m.preview.includes('secret_db_token_999')), true);
    assert.equal(ph.messages.some((m) => m.id === 'hist_recalled'), false, '已撤回历史不得在翻页中返回');

    // 4) Keyword search within scoped chat
    const pq = await fetch(`${pullBase}&q=heap.log`).then((r) => r.json()) as {
      messages: Array<{ id: string }>;
    };
    assert.equal(pq.messages.some((m) => m.id === 'grp_merged_1'), true);

    // 5) Missing / wrong grant rejected cleanly + rate limit enforcement
    const noGrant = await fetch(`http://127.0.0.1:${(web.server!.address() as AddressInfo).port}/api/context/history`);
    assert.equal(noGrant.status, 401);
    const badGrant = await fetch(`http://127.0.0.1:${(web.server!.address() as AddressInfo).port}/api/context/history?grant=g_invalid`);
    assert.equal(badGrant.status, 403);
    let saw429 = false;
    for (let i = 0; i < 16; i += 1) {
      const r = await fetch(`${pullBase}&msgId=grp_merged_1`);
      if (r.status === 429) { saw429 = true; break; }
    }
    assert.equal(saw429, true, '超出频控阈值时应返回 429');

    // Scenario C: @colleague follow-up confirmation -> true mentions -> one-shot colleague reply resume
    const askConfirmCard = sent.find((s) => s.chatId === 'chat_self' && s.text.includes('确认向「运维群」追问 @Alice'))!;
    assert.match(askConfirmCard.text, /将真 @Alice（`u_alice`）提醒/);

    const sentLenBeforeConfirm = sent.length;
    await pushInbound!({
      msgId: 'self_confirm_ask',
      chatId: 'chat_self',
      chatType: 'self',
      fromId: 'u_me',
      isSelf: true,
      text: '确认发送',
      time: Date.now(),
    });
    await until(() => (
      sent.slice(sentLenBeforeConfirm).some((s) => s.chatId === 'grp_ops')
      && sent.slice(sentLenBeforeConfirm).some((s) => s.text.includes('已向「运维群」发送追问'))
    ));

    const sentAskToGroup = sent.slice(sentLenBeforeConfirm).find((s) => s.chatId === 'grp_ops')!;
    assert.equal(sentAskToGroup.text.includes('@Alice'), true, '经主人确认的具体同事应保留真实 @Alice');
    assert.equal(sentAskToGroup.text.includes('@\u200BAlice'), false);
    assert.equal(sentAskToGroup.text.includes('@\u200Beveryone'), true, '@everyone 等危险 @ 必须始终插零宽空格拦截');
    assert.deepEqual(sentAskToGroup.opts?.mentions, [{ id: 'u_alice', name: 'Alice' }]);

    // Alice replies -> triggers one-shot resume in selfChat only
    const selfCountBeforeReply = sent.filter((s) => s.chatId === 'chat_self').length;
    const grpCountBeforeReply = sent.filter((s) => s.chatId === 'grp_ops').length;
    await pushInbound!({
      msgId: 'alice_reply_1',
      chatId: 'grp_ops',
      chatType: 'group',
      chatName: '运维群',
      fromId: 'u_alice',
      fromName: 'Alice',
      isSelf: false,
      text: 'prod max_pool=32',
      time: Date.now(),
    });
    await until(() => sent.filter((s) => s.chatId === 'chat_self').some((s) => s.text.includes('建议将连接池上限调整为 32')));
    assert.equal(sent.filter((s) => s.chatId === 'grp_ops').length, grpCountBeforeReply, '追问回流结果只能回主人自聊，禁止公开发群');
    assert.ok(sent.filter((s) => s.chatId === 'chat_self').length > selfCountBeforeReply);

    // Second message from Alice must NOT re-trigger follow-up (one-shot consumed)
    const promptCountAfterFirst = omb.prompts.length;
    await pushInbound!({
      msgId: 'alice_reply_2',
      chatId: 'grp_ops',
      chatType: 'group',
      chatName: '运维群',
      fromId: 'u_alice',
      fromName: 'Alice',
      isSelf: false,
      text: '对了还有一条普通群聊',
      time: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(omb.prompts.length, promptCountAfterFirst);

    // Scenario D: Self-chat forwarding during active 120s sticky window + privacy isolation of # 备忘
    const promptCountBeforeSelfFwd = omb.prompts.length;
    pushInbound!({
      msgId: 'self_note_1',
      chatId: 'chat_self',
      chatType: 'self',
      fromId: 'u_me',
      isSelf: true,
      text: '# 备忘：个人银行卡密码笔记',
      time: Date.now(),
    });
    pushInbound!({
      msgId: 'self_fwd_1',
      chatId: 'chat_self',
      chatType: 'self',
      fromId: 'u_me',
      isSelf: true,
      isForwarded: true,
      text: '客户反馈：订单导出报错 504',
      time: Date.now() + 10,
    });
    pushInbound!({
      msgId: 'self_fwd_2',
      chatId: 'chat_self',
      chatType: 'self',
      fromId: 'u_me',
      isSelf: true,
      isForwarded: true,
      text: '',
      forwarded: {
        title: '研发群片段',
        messages: [{ senderName: 'Dev', text: '网关超时配置只有 5s' }],
      },
      time: Date.now() + 20,
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(omb.prompts.length, promptCountBeforeSelfFwd, '自聊粘性窗口内转发消息不得提前触发 Bot 回复');

    await pushInbound!({
      msgId: 'self_ask_above',
      chatId: 'chat_self',
      chatType: 'self',
      fromId: 'u_me',
      isSelf: true,
      text: '@bot 看以上内容分析原因',
      time: Date.now() + 30,
    });
    await until(() => omb.prompts.length > promptCountBeforeSelfFwd);
    const selfFwdPrompt = omb.prompts.at(-1)!.text;
    assert.match(selfFwdPrompt, /前文\/转发上下文（2 条/);
    assert.match(selfFwdPrompt, /订单导出报错 504/);
    assert.match(selfFwdPrompt, /网关超时配置只有 5s/);
    assert.equal(selfFwdPrompt.includes('个人银行卡密码笔记'), false, '自聊私人笔记绝不能混入转发上下文');

    // Next unrelated self-chat query must NOT re-inject already dispatched forwards
    await pushInbound!({
      msgId: 'self_unrelated',
      chatId: 'chat_self',
      chatType: 'self',
      fromId: 'u_me',
      isSelf: true,
      text: '@bot 查下磁盘',
      time: Date.now() + 40,
    });
    await until(() => omb.prompts.length > promptCountBeforeSelfFwd + 1);
    const unrelatedPrompt = omb.prompts.at(-1)!.text;
    assert.equal(unrelatedPrompt.includes('订单导出报错 504'), false, '已消费转发消息不得重复注入后续无关提问');

    // Self-chat context_pull grant (if present) must still refuse reading # 备忘 personal note!
    const selfPullM = selfFwdPrompt.match(/grant=(g_[a-z0-9_]+)/);
    if (selfPullM) {
      const noteDetail = await fetch(`${baseUrl}/api/context/history?grant=${selfPullM[1]}&msgId=self_note_1`);
      assert.equal(noteDetail.status, 404);
      const noteSearch = await fetch(`${baseUrl}/api/context/history?grant=${selfPullM[1]}&q=${encodeURIComponent('银行卡密码')}`).then((r) => r.json()) as {
        messages: Array<{ id: string }>;
      };
      assert.equal(noteSearch.messages.length, 0, '自聊搜索接口不得暴露私人 # 备忘 笔记');
      const selfHist = await fetch(`${baseUrl}/api/context/history?grant=${selfPullM[1]}&before=self_unrelated&limit=10`).then((r) => r.json()) as {
        messages: Array<{ id: string }>;
      };
      assert.equal(selfHist.messages.some((m) => m.id === 'self_note_1'), false, '自聊翻页接口不得暴露私人 # 备忘 笔记');
    }
  } finally {
    await kernel.stop();
    await omb.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('parseAskProposal tolerates markdown backticks, fenced code blocks and list bullets around tag', () => {
  const inlineTick = parseAskProposal('先核对下。\n`[cobot:ask chat=grp_ops to=Alice] @Alice max_connections 是多少？`');
  assert.equal(inlineTick.cleanText, '先核对下。');
  assert.deepEqual(inlineTick.proposal, { chatRef: 'grp_ops', toRef: 'Alice', question: '@Alice max_connections 是多少？' });

  const fenced = parseAskProposal('分析如上。\n```text\n[cobot:ask chat=grp_ops to=u_alice|Alice] @Alice 请确认主库上限？\n```');
  assert.equal(fenced.cleanText, '分析如上。');
  assert.deepEqual(fenced.proposal, { chatRef: 'grp_ops', toRef: 'u_alice|Alice', question: '@Alice 请确认主库上限？' });

  const bulleted = parseAskProposal('已排查日志。\n- [cobot:ask chat=grp_ops to=Bob] @Bob Redis 切换后恢复了吗？');
  assert.equal(bulleted.cleanText, '已排查日志。');
  assert.deepEqual(bulleted.proposal, { chatRef: 'grp_ops', toRef: 'Bob', question: '@Bob Redis 切换后恢复了吗？' });
});

test('WebSimTransport supports forwarded messages, structured outbound mentions & sim UI hooks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-sim-fwd-'));
  const web = new WebServer({ host: '127.0.0.1', port: 0, publicDir: path.resolve('public') });
  const sim = new WebSimTransport({ web, filesDir: path.join(dir, 'files'), historyFile: null });
  const inbound: Array<Record<string, unknown>> = [];
  await sim.start((ev) => { inbound.push(ev as unknown as Record<string, unknown>); });
  await web.start();
  try {
    const base = `http://127.0.0.1:${(web.server!.address() as AddressInfo).port}`;
    const rSingle = await fetch(`${base}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'grp_dev', sender: 'me', text: '日志片段', isForwarded: true }),
    });
    assert.equal(rSingle.status, 200);

    const rMerged = await fetch(`${base}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chatId: 'grp_dev',
        sender: 'me',
        text: '',
        forwarded: { title: '排障记录', messages: [{ senderName: 'Alice', text: '连接池耗尽' }] },
      }),
    });
    assert.equal(rMerged.status, 200);
    assert.equal(inbound[0].isForwarded, true);
    assert.equal(inbound[1].isForwarded, true);
    assert.equal((inbound[1].forwarded as { messages: unknown[] }).messages.length, 1);

    const botMsgId = await sim.send('grp_dev', '@Alice 请确认配置', { mentions: [{ id: 'alice', name: 'Alice' }] });
    assert.ok(botMsgId);
    const botHist = await sim.getMessage('grp_dev', botMsgId);
    assert.deepEqual(botHist?.mentions, [{ id: 'alice', name: 'Alice' }]);

    const simHtml = fs.readFileSync(path.resolve('public/index.html'), 'utf8');
    assert.match(simHtml, /fwd-card/);
    assert.match(simHtml, /fwd-tag/);
    assert.match(simHtml, /mention-pill/);
    assert.match(simHtml, /id="selectBtn"/);
    assert.match(simHtml, /id="selectBar"/);
    assert.match(simHtml, /fwdMergeSelfBtn/);
    assert.match(simHtml, /fwdSingleSelfBtn/);
  } finally {
    await sim.stop();
    await web.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
