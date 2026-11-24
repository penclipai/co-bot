import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OpenMausBotBridge } from '../src/openmausbot/bridge.ts';
import type { OmbMessage } from '../src/openmausbot/types.ts';
import { makeMockHarness, makeMockTransport } from './helpers/mock-im-context.ts';

test('复杂 @mention 与引用组合：裸 @bot+引用、句中触发、反引号忽略、引用后@同事不重触、出站 @ 脱敏与多 Bot 复核', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-mention-'));
  const threadMsgs: Record<string, OmbMessage[]> = {};
  const mock = makeMockHarness({
    onSendMessage(entry) {
      const reqId = `req_${mock.sentPrompts.length}`;
      threadMsgs[String(entry.threadId || '')] = [
        { id: reqId, role: 'user', text: String(entry.text || ''), sendId: entry.sendId ? String(entry.sendId) : undefined },
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
  mock.client.resolveBot = async (name = '') => {
    const low = String(name || '').toLowerCase();
    if (!low || low === 'mausbot') return { id: 'bot_main', name: 'MausBot', threadId: 'th_self_main' };
    if (low === 'plum') return { id: 'bot_plum', name: 'Plum', threadId: 'th_plum_main' };
    return null;
  };
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
    assert.match(String(mock.sentPrompts[0].text), /nginx 报 499 是客户端断连吗/);
    assert.match(String(mock.sentPrompts[0].text), /reply_policy:/);

    const grpReply = sent.find((s) => s.chatId === 'grp_dev')!;
    assert.ok(grpReply);
    assert.match(grpReply.text, /@\u200BAlice/);
    assert.match(grpReply.text, /@\u200B所有人/);
    assert.match(grpReply.text, /@\u200BPlum/);
    assert.match(grpReply.text, /dev@example\.com/);
    assert.match(grpReply.text, /`@bot`/);
    await bridge.onEvent({
      id: 'm_replay_sanitized',
      ts: Date.now() + 10,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@\u200Bbot 不应被零宽字符假触发',
    });
    assert.equal(mock.sentPrompts.length, 1);

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
    assert.match(String(mock.sentPrompts[2].text), /@Alice 别急，我让 帮我们核对一下日志/);

    await bridge.onEvent({
      id: 'm_quote_to_alice',
      ts: Date.now() + 50,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'me', name: '我', isSelf: true },
      replyTo: grpReply.id,
      text: '辛苦 @Alice 按上面说的改下超时',
    });
    assert.equal(mock.sentPrompts.length, 3, '引用 Bot 回复但显式 @同事时不应再重触 Bot');

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
    assert.match(String(mock.sentPrompts[3].text), /quoted_message:/);
    assert.match(String(mock.sentPrompts[3].text), /18:00 封板/);

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
  const uploads: Array<{ name: string; content: string; mime?: string }> = [];
  const compacts: Array<{ botId: string; threadId: string }> = [];
  const threadMsgs: Record<string, OmbMessage[]> = {};
  let extUsageRatio = 0.85;

  const mock = makeMockHarness({
    onSendMessage(entry) {
      const reqId = `req_${mock.sentPrompts.length}`;
      threadMsgs[String(entry.threadId || '')] = [
        { id: reqId, role: 'user', text: String(entry.text || ''), sendId: entry.sendId ? String(entry.sendId) : undefined },
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
          title: String(t.opts?.title || '外部群'),
          usage: { context: { tokens: Math.round(extUsageRatio * 100_000), window: 100_000 }, turns: 28 },
        })),
      ],
    }],
    groups: [],
  });
  mock.client.uploadFile = async (name: string, buf: Uint8Array, mime?: string) => {
    uploads.push({ name, content: Buffer.from(buf).toString('utf8'), mime });
    return { path: `/tmp/omb/${name}`, size: buf.length, mime };
  };
  mock.client.compact = async (botId: string, threadId: string) => {
    compacts.push({ botId, threadId });
    return { ok: true };
  };
  mock.client.getMessages = async (tid: string) => ({ messages: threadMsgs[tid] ?? [] });

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
    assert.doesNotMatch(String(mock.sentPrompts[0].text), /temp_pass_999/);
    assert.match(String(mock.sentPrompts[0].text), /auto_attached_files:.*node2\.log/);
    assert.match(String(mock.sentPrompts[0].text), /auto_attached_files:.*node1\.log/);

    const botReply = sent.find((s) => s.chatId === 'grp_dev' && s.text.includes('已分析日志'))!;
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

    const warnMsg = sent.find((s) => s.chatId === 'chat_self' && s.text.includes('85%'))!;
    assert.ok(warnMsg, '外部群达到 85% 应在自聊收到提示');
    assert.match(String(warnMsg.opts.actions![0].text), /^@bot compact grp_dev$/);

    await bridge.onEvent({
      id: 'm_ctx_grp',
      ts: t0 + 5000,
      chat: { id: 'chat_self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot status grp_dev',
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

test('C2 跨群效率助手：外部群 @bot! 私密起草、改写与确认回发（防误艾特）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-trackc-'));
  const fakeNow = new Date(2026, 10, 22, 17, 55, 0).getTime();
  const threadMsgs: Record<string, OmbMessage[]> = {};
  const mock = makeMockHarness({
    onSendMessage(entry) {
      const reqId = `req_${mock.sentPrompts.length}`;
      const isPrivDraftReq = String(entry.text || '').includes('起草');
      const reply = isPrivDraftReq
        ? '请 @Alice 今天 18:00 前确认发布窗口。'
        : '汇总完成：今日讨论聚焦 nginx 499 与封板。';
      threadMsgs[String(entry.threadId || '')] = [
        { id: reqId, role: 'user', text: String(entry.text || ''), sendId: entry.sendId ? String(entry.sendId) : undefined },
        { id: `bot_${reqId}`, role: 'bot', requestMessageId: reqId, kind: 'text', turnTerminal: true, text: reply },
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
    now: () => fakeNow,
  });
  await bridge.start();

  try {
    await bridge.onEvent({
      id: 'g_msg_1',
      ts: fakeNow - 60_000,
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'alice', name: 'Alice', isSelf: false },
      text: 'nginx 499 连接池待确认',
    });

    await bridge.stop();
    const bridge2 = new OpenMausBotBridge({ client: mock.client, transport, dataDir: tmpDir, sendRetries: 0, now: () => fakeNow });

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
    const privDraft = sent.find((s) => s.chatId === 'chat_self' && s.text.includes('私密回复') && s.text.includes('@Alice'))!;
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
    const backMsg = sent.find((s) => s.chatId === 'grp_dev')!;
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
