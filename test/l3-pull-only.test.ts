import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ContextPullManager } from '../src/core/context-pull.ts';
import { Kernel } from '../src/core/kernel.ts';
import { defineChannelPlugin } from '../src/core/channel-contract.ts';
import { OpenMausBotBridge } from '../src/openmausbot/bridge.ts';
import { COBOT_COORDINATOR_SOUL, isManagedCobotSoul } from '../src/openmausbot/persona.ts';
import { imContextPlugin } from '../src/plugins/im-context.ts';
import { webPlugin } from '../src/plugins/web.ts';
import type { RawConfig } from '../src/types.ts';
import { makeMockHarness, makeMockTransport } from './helpers/mock-im-context.ts';

const until = async (fn: () => boolean | Promise<boolean>, ms = 4000): Promise<void> => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail('timeout waiting for condition');
};

test('L3 Soul contains moved protocol rules and remains managed', () => {
  assert.equal(isManagedCobotSoul(COBOT_COORDINATOR_SOUL), true);
  assert.match(COBOT_COORDINATOR_SOUL, /context_pull/);
  assert.match(COBOT_COORDINATOR_SOUL, /\/api\/context\/attachment/);
  assert.match(COBOT_COORDINATOR_SOUL, /\[cobot:ask chat=/);
  assert.match(COBOT_COORDINATOR_SOUL, /严禁主动 @all/);
});

test('L3 default pull-only: omits unquoted recent messages & unquoted fileMsgs, keeps explicit quote + burst attachments', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-l3-quote-'));
  const uploads: string[] = [];
  const mock = makeMockHarness();
  (mock.client as unknown as { uploadFile: (n: string) => Promise<{ path: string }> }).uploadFile = async (n) => {
    uploads.push(n);
    return { path: `/tmp/omb/${n}` };
  };
  const { transport } = makeMockTransport({
    att_1: 'node1 error\n',
    att_2: 'node2 error\n',
    att_unquoted: 'unrelated doc\n',
  });
  const bridge = new OpenMausBotBridge({
    client: mock.client,
    transport,
    dataDir: tmpDir,
    sendRetries: 0,
    turnStallMs: 0,
    stateSaveDebounceMs: 0,
  });
  await bridge.start();
  try {
    const t0 = Date.now() - 10_000;
    await bridge.onEvent({
      id: 'm_bob_noise',
      ts: t0,
      chat: { id: 'grp_l3', type: 'group', name: 'L3群' },
      sender: { id: 'bob', name: 'Bob', isSelf: false },
      text: 'NOISE_UNQUOTED_LINE 这行不应预注入',
    });
    await bridge.onEvent({
      id: 'm_unquoted_doc',
      ts: t0 + 500,
      chat: { id: 'grp_l3', type: 'group', name: 'L3群' },
      sender: { id: 'bob', name: 'Bob', isSelf: false },
      text: 'spec.txt',
      attachments: [{ id: 'att_unquoted', msgId: 'm_unquoted_doc', name: 'spec.txt' }],
    });
    await bridge.onEvent({
      id: 'm_alice_1',
      ts: t0 + 1000,
      chat: { id: 'grp_l3', type: 'group', name: 'L3群' },
      sender: { id: 'alice', name: 'Alice', isSelf: false },
      text: 'log1',
      attachments: [{ id: 'att_1', msgId: 'm_alice_1', name: 'node1.log' }],
    });
    await bridge.onEvent({
      id: 'm_alice_2',
      ts: t0 + 2000,
      chat: { id: 'grp_l3', type: 'group', name: 'L3群' },
      sender: { id: 'alice', name: 'Alice', isSelf: false },
      text: 'log2',
      attachments: [{ id: 'att_2', msgId: 'm_alice_2', name: 'node2.log' }],
    });
    await bridge.onEvent({
      id: 'm_me_ask_unquoted',
      ts: t0 + 3000,
      chat: { id: 'grp_l3', type: 'group', name: 'L3群' },
      sender: { id: 'me', isSelf: true },
      text: '@bot 你好',
    });
    await until(() => mock.sentPrompts.length === 1);
    const p1 = String(mock.sentPrompts[0].text);
    assert.equal(p1.includes('NOISE_UNQUOTED_LINE'), false, '外部群未引用历史不应预注入');
    assert.doesNotMatch(p1, /reply_policy:|ask_colleague_hint:/);
    assert.match(p1, /security_fence: UNTRUSTED external data/);
    assert.equal(uploads.length, 0, '外部群未引用时不得拖入历史 fileMsgs 自动上传');

    await bridge.onEvent({
      id: 'm_me_ask_quoted',
      ts: t0 + 4000,
      chat: { id: 'grp_l3', type: 'group', name: 'L3群' },
      sender: { id: 'me', isSelf: true },
      replyTo: 'm_alice_2',
      text: '@bot 帮我看这批日志',
    });
    await until(() => mock.sentPrompts.length === 2);
    const p2 = String(mock.sentPrompts[1].text);
    assert.equal(p2.includes('NOISE_UNQUOTED_LINE'), false, '引用提问时仍不注入无关未引用历史');
    assert.match(p2, /quoted_message:[\s\S]*m_alice_2/);
    assert.deepEqual(uploads.sort(), ['node1.log', 'node2.log'], '显式引用仍应自动合批同发送者连发附件');

    // Self-chat bare file upload followed by @bot still auto-claims fileMsgs
    await bridge.onEvent({
      id: 'm_self_doc',
      ts: t0 + 5000,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', isSelf: true },
      text: '',
      attachments: [{ id: 'att_unquoted', msgId: 'm_self_doc', name: 'self_note.txt' }],
    });
    await bridge.onEvent({
      id: 'm_self_followup',
      ts: t0 + 6000,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', isSelf: true },
      text: '@bot 总结刚才的文件',
    });
    await until(() => mock.sentPrompts.length === 3);
    assert.equal(uploads.includes('self_note.txt'), true, '自聊发文件后追问应仍自动认领附件');
  } finally {
    await bridge.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('L3 per-thread scope dedup: injects once, keeps readonly-guard, re-injects on bind/compact', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-l3-dedup-'));
  const orderDir = path.join(tmpDir, 'order');
  const payDir = path.join(tmpDir, 'pay');
  const sharedDir = path.join(tmpDir, 'shared');
  fs.mkdirSync(orderDir, { recursive: true });
  fs.mkdirSync(payDir, { recursive: true });
  fs.mkdirSync(sharedDir, { recursive: true });

  const mock = makeMockHarness();
  let compactCount = 0;
  (mock.client as unknown as { compact: () => Promise<void> }).compact = async () => { compactCount += 1; };
  const { transport } = makeMockTransport();

  const bridge = new OpenMausBotBridge({
    client: mock.client,
    transport,
    dataDir: path.join(tmpDir, 'data'),
    projects: [
      { name: 'order', path: orderDir, aliases: [] },
      { name: 'pay', path: payDir, aliases: [] },
    ],
    sharedContextDir: sharedDir,
    chats: {
      collaborators: [{ id: 'u_bob', name: 'Bob', policy: 'auto_readonly', projects: ['order'], chats: [] }],
    },
    sendRetries: 0,
    turnStallMs: 0,
    stateSaveDebounceMs: 0,
  });
  await bridge.start();
  try {
    await bridge.onEvent({
      id: 'd1',
      ts: Date.now(),
      chat: { id: 'grp_s', type: 'group', name: 'Scope群' },
      sender: { id: 'u_bob', name: 'Bob', isSelf: false },
      text: '@bot 查 order 报错',
    });
    await until(() => mock.sentPrompts.length === 1);
    const first = String(mock.sentPrompts[0].text);
    assert.match(first, /<readonly-guard>/);
    assert.match(first, /<workspace-scope>/);
    assert.match(first, /<shared-context>/);

    // Same thread, same scope -> dedup workspace-scope & shared-context, KEEP readonly-guard
    await bridge.onEvent({
      id: 'd2',
      ts: Date.now() + 10,
      chat: { id: 'grp_s', type: 'group', name: 'Scope群' },
      sender: { id: 'u_bob', name: 'Bob', isSelf: false },
      text: '@bot 再查 order 连接池',
    });
    await until(() => mock.sentPrompts.length === 2);
    const second = String(mock.sentPrompts[1].text);
    assert.match(second, /<readonly-guard>/, '只读护栏必须在同事每轮提问中始终保留');
    assert.doesNotMatch(second, /<workspace-scope>/, '同 thread 未变作用域时应去重跳过 workspace-scope');
    assert.doesNotMatch(second, /<shared-context>/, '同 thread 未变共享目录时应去重跳过 shared-context');

    // Explicit scope change -> re-injects workspace-scope & shared-context
    await bridge.onEvent({
      id: 'd3_bind',
      ts: Date.now() + 20,
      chat: { id: 'grp_s', type: 'group', name: 'Scope群' },
      sender: { id: 'me', isSelf: true },
      text: '@bot bind pay',
    });
    await bridge.onEvent({
      id: 'd3',
      ts: Date.now() + 30,
      chat: { id: 'grp_s', type: 'group', name: 'Scope群' },
      sender: { id: 'me', isSelf: true },
      text: '@bot 看下状态',
    });
    await until(() => mock.sentPrompts.length === 3);
    const third = String(mock.sentPrompts[2].text);
    assert.match(third, /<workspace-scope>[\s\S]*bound_project: pay/);
    assert.match(third, /<shared-context>/);

    // Compact clears threadInjectedScope so next turn re-injects
    await bridge.onEvent({
      id: 'd4_cmp',
      ts: Date.now() + 40,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', isSelf: true },
      text: '@bot compact grp_s',
    });
    assert.equal(compactCount, 1);
    await bridge.onEvent({
      id: 'd4',
      ts: Date.now() + 50,
      chat: { id: 'grp_s', type: 'group', name: 'Scope群' },
      sender: { id: 'me', isSelf: true },
      text: '@bot 压缩后再看下',
    });
    await until(() => mock.sentPrompts.length === 4);
    const fourth = String(mock.sentPrompts[3].text);
    assert.match(fourth, /<workspace-scope>[\s\S]*bound_project: pay/);
    assert.match(fourth, /<shared-context>/);
  } finally {
    await bridge.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('L3 /api/context/attachment caches downloads, redacts secrets, checks multi-att & missing download 501', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-l3-att-'));
  let downloadCalls = 0;
  const chanWithDl = defineChannelPlugin({
    name: 'mock-dl',
    capabilities: { files: true, history: false },
    create() {
      return {
        async start() {},
        async send() { return 'ok'; },
        async sendFile() { return 'ok'; },
        async download(att, dest) {
          downloadCalls += 1;
          fs.writeFileSync(dest, `content of ${att.name} token=sk-secretkey1234567890`);
        },
        async stop() {},
      };
    },
  });

  const kernel = new Kernel({
    config: { web: { host: '127.0.0.1', port: 0 }, openmausbot: { url: 'http://127.0.0.1:8799' }, dataDir: tmpDir } as RawConfig,
  });
  kernel.use(webPlugin);
  kernel.use(chanWithDl);
  kernel.use(imContextPlugin);
  await kernel.start();
  try {
    const web = kernel.get<{ server: http.Server | null }>('web');
    const port = (web.server!.address() as AddressInfo).port;
    const imCtx = kernel.get<import('../src/openmausbot/types.ts').ImContextService>('imContext');
    const now = Date.now();
    imCtx.recordInbound({
      id: 'msg_single',
      ts: now - 2000,
      chat: { id: 'grp_doc', type: 'group', name: '文档群' },
      sender: { id: 'alice', name: 'Alice', isSelf: false },
      text: '报告',
      attachments: [{ id: 'a1', msgId: 'msg_single', name: 'report.md' }],
    });
    imCtx.recordInbound({
      id: 'msg_multi',
      ts: now - 1000,
      chat: { id: 'grp_doc', type: 'group', name: '文档群' },
      sender: { id: 'alice', name: 'Alice', isSelf: false },
      text: '两个附件',
      attachments: [
        { id: 'a2', msgId: 'msg_multi', name: 'first.txt' },
        { id: 'a3', msgId: 'msg_multi', name: 'second.txt' },
      ],
    });
    const hint = imCtx.getContextPullHint!('grp_doc', { availableCount: 2, availableFiles: 3, pullOnly: true });
    const m = hint.match(/grant=(g_[a-z0-9_]+)/)!;
    assert.ok(m);

    // Single attachment omits attId + caches + redacts secrets
    const r1 = await fetch(`http://127.0.0.1:${port}/api/context/attachment?grant=${m[1]}&msgId=msg_single`).then((r) => r.json()) as {
      ok: boolean; text: string; name: string;
    };
    const r2 = await fetch(`http://127.0.0.1:${port}/api/context/attachment?grant=${m[1]}&msgId=msg_single`).then((r) => r.json()) as {
      ok: boolean; text: string;
    };
    assert.equal(r1.ok, true);
    assert.equal(r1.name, 'report.md');
    assert.equal(r1.text.includes('sk-secretkey1234567890'), false);
    assert.match(r1.text, /\[REDACTED\]/);
    assert.equal(r2.ok, true);
    assert.equal(downloadCalls, 1, '重复拉取同附件应命中本地缓存不重复下载');

    // Multi-attachment requires attId
    const multiMissing = await fetch(`http://127.0.0.1:${port}/api/context/attachment?grant=${m[1]}&msgId=msg_multi`);
    assert.equal(multiMissing.status, 400);

    // ContextPullManager without downloadAttachment returns 501
    const pmNoDl = new ContextPullManager({
      resolveMessage: async () => ({
        id: 'm1',
        chatId: 'grp_x',
        chatType: 'group',
        ts: 1000,
        senderId: 'alice',
        isSelf: false,
        isBotReply: false,
        mentionsMe: false,
        text: '',
        attachments: [{ id: 'a1', msgId: 'm1', name: 'doc.txt' }],
      }),
      getHistory: async () => [],
    });
    const g = pmNoDl.getGrant('grp_x');
    await assert.rejects(
      () => pmNoDl.handleAttachmentRequest(new URL(`http://127.0.0.1/api/context/attachment?grant=${g}&msgId=m1`), '127.0.0.1'),
      (e: { status?: number }) => e.status === 501,
    );
  } finally {
    await kernel.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
