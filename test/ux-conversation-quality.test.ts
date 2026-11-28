import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OpenMausBotBridge } from '../src/openmausbot/bridge.ts';
import { formatActivity } from '../src/openmausbot/cards.ts';
import { OpenMausBotClient } from '../src/openmausbot/client.ts';
import { formatCoordinatorInboxLines, reconcilePendingCards } from '../src/openmausbot/inbox.ts';
import type { CoordinatorInboxSummary } from '../src/openmausbot/types.ts';
import { makeIm, startMockOmb, until, type SentImFileItem, type SentImItem } from './helpers/mock-omb.ts';

test('UX regression: sticky conversation resists stale pending question cards and bye exits cleanly', async () => {
  const omb = await startMockOmb([
    { id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true },
    { id: 'b2', name: 'Plum', threadId: 't2', chiefOfStaff: false },
  ]);
  const sent: SentImItem[] = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-ux-sticky-'));
  const bridge = new OpenMausBotBridge({
    client: new OpenMausBotClient({ baseUrl: omb.baseUrl }),
    transport,
    dataDir,
    followUpWindowMs: 120_000,
  });

  const receivedByOmb: string[] = [];
  try {
    await bridge.start();
    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      receivedByOmb.push(String(reqMsg.text || ''));
      const fin = {
        id: nextId(),
        role: 'bot',
        kind: 'text',
        threadId,
        requestMessageId: reqMsg.id,
        text: `已收到：${reqMsg.text}`,
        turnTerminal: true,
      };
      messages.push(fin);
      jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
      broadcast({ kind: 'message', threadId, message: fin });
    });

    await transport.emitUser('@bot 先写一个 parseDuration 助手');
    await until(() => sent.some((m) => m.text.includes('已收到：先写一个 parseDuration 助手')));

    bridge.pendingCards.set('card_q_other', {
      imMsgId: 'im_q_other',
      inboxRef: 1,
      chatId: 'self',
      cardKind: 'card',
      cardBotId: 'b2',
      requestId: 'req_q_other',
      threadId: 't2',
      botId: 'b2',
      botName: 'Plum',
      title: 'Plum 的遗留问题',
      isQuestion: true,
      options: [{ label: '选项A', description: '' }, { label: '选项B', description: '' }],
      canRememberCommand: false,
      createdAt: Date.now() - 60_000,
    });
    bridge.pendingCards.set('card_burst_old', {
      imMsgId: 'im_burst_old',
      inboxRef: 2,
      chatId: 'self',
      cardKind: 'burst',
      cardBotId: 'b1',
      requestId: 'burst_1',
      burstId: 'burst_1',
      threadId: 't1',
      botId: 'b1',
      botName: 'co-bot',
      title: '并发任务卡',
      isQuestion: false,
      options: [],
      canRememberCommand: false,
      createdAt: Date.now() - 60_000,
    });

    await transport.emitUser('再补一个对 1.5h 小数的支持');
    await until(() => receivedByOmb.some((t) => t.includes('1.5h 小数的支持')));

    await transport.emitUser('开头再精炼一半并去掉空话');
    await until(() => receivedByOmb.some((t) => t.includes('开头再精炼一半')));
    assert.equal(sent.some((m) => m.text.includes('当前有多个待处理操作')), false, '粘性续聊文本不得被多卡消歧误劫持');

    bridge.pendingCards.delete('card_burst_old');
    await transport.emitUser('顺便检查边界输入空字符串');
    await until(() => receivedByOmb.some((t) => t.includes('边界输入空字符串')));

    await transport.emitUser('bye');
    await until(() => sent.some((m) => m.text.includes('已结束连续对话')));
    assert.equal(bridge.isStickyActive(), false);

    // Explicitly typing numeric card answer outside sticky still operates on card
    await transport.emitUser('1');
    await until(() => sent.some((m) => m.text.includes('已选择') || m.text.includes('已允许')));
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('UX regression: formatActivity hides CLI noise/internal IDs and repeated tool still emits elapsed check-in', async () => {
  assert.equal(formatActivity({ tool: { name: 'run_shell', spoken: 'npm test -- --watch' } }), '⚙️ 正在执行命令…');
  assert.equal(formatActivity({ tool: { name: 'grep_search', spoken: 'src/openmausbot/inbox.ts' } }), '⚙️ 正在搜索代码…');
  assert.equal(formatActivity({ tool: { name: 'mcp__srv__lookup_item', spoken: 'analyzing.' } }), '⚙️ 正在处理中…');
  assert.equal(formatActivity({ tool: { name: 'view_file', spoken: '检查状态同步逻辑' } }), '⚙️ 正在读取文件（检查状态同步逻辑）…');

  const omb = await startMockOmb([{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }]);
  const sent: SentImItem[] = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-ux-progress-'));
  const bridge = new OpenMausBotBridge({
    client: new OpenMausBotClient({ baseUrl: omb.baseUrl }),
    transport,
    dataDir,
    progressDelayMs: 35,
    progressIntervalMs: 55,
    maxProgressUpdates: 2,
    intermediateCoalesceMs: 10,
    maxIntermediateBubbles: 1,
  });

  try {
    await bridge.start();
    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      const mid1 = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: '先看一下问题。', turnTerminal: false };
      messages.push(mid1);
      broadcast({ kind: 'message', threadId, message: mid1 });

      setTimeout(() => {
        const act1 = { id: nextId(), role: 'bot', kind: 'activity', threadId, requestMessageId: reqMsg.id, tool: { name: 'bash', spoken: 'git status && npm test' } };
        messages.push(act1);
        broadcast({ kind: 'message', threadId, message: act1 });
      }, 20);

      // An over-cap held intermediate should not reset the elapsed check-in timer
      setTimeout(() => {
        const mid2 = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: '补充一段分析。', turnTerminal: false };
        messages.push(mid2);
        broadcast({ kind: 'message', threadId, message: mid2 });
      }, 45);

      setTimeout(() => {
        const fin = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: '最终结论：已完成检查。', turnTerminal: true };
        messages.push(fin);
        jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
        broadcast({ kind: 'message', threadId, message: fin });
      }, 260);
    });

    await transport.emitUser('@bot 深查这个问题');
    await until(() => sent.some((m) => m.text.includes('最终结论：已完成检查')));

    const firstPing = sent.find((m) => m.text.includes('正在执行命令'));
    assert.ok(firstPing, '应发出首次工具进度');
    assert.equal(firstPing.text.includes('git status'), false, '进度条不得泄漏具体命令行');
    assert.ok(sent.some((m) => m.text.includes('⏳ 仍在处理中')), '同一长步骤跨间隔后应补发连续耗时心跳');
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('UX regression: inbox count summary, job-idle reconcile, persisted MausBot normalization, and clean md export', async () => {
  const inboxSummary: CoordinatorInboxSummary = {
    total: 8,
    cards: Array.from({ length: 8 }, (_, idx) => ({
      ref: idx + 1,
      imMsgId: `m_${idx}`,
      title: `任务 ${idx + 1}`,
      botName: 'co-bot',
      kind: 'card',
    })),
    sendBacks: [],
    drafts: [],
    followUps: [],
    delegations: [],
  };
  const formatted = formatCoordinatorInboxLines(inboxSummary);
  assert.equal(formatted.filter((l) => l.startsWith('- `#')).length, 6, '收件箱单类最多展示 6 条');
  assert.ok(formatted.some((l) => l.includes('另有 2 项未展开')), '截断时应明确提示未展开条数');

  const omb = await startMockOmb([{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }]);
  const sent: SentImItem[] = [];
  const filesSent: SentImFileItem[] = [];
  const transport = makeIm(sent, filesSent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-ux-reconcile-'));
  fs.writeFileSync(
    path.join(dataDir, 'bridge-state.json'),
    JSON.stringify({
      chatThreads: [['grp_dev:b1', {
        threadId: 't_ext',
        botId: 'b1',
        botName: 'MausBot',
        isGroup: false,
        chatId: 'grp_dev',
        chatName: '研发架构群',
        chatType: 'group',
      }]],
    }),
  );

  const bridge = new OpenMausBotBridge({
    client: new OpenMausBotClient({ baseUrl: omb.baseUrl }),
    transport,
    dataDir,
    resultChars: 120,
    softSplitChars: 120,
    hideChiefPrefix: false,
  });

  try {
    await bridge.start();
    const known = bridge.listKnownChats();
    const grp = known.find((c) => c.id === 'grp_dev');
    assert.equal(grp?.threads?.[0]?.botName, 'co-bot', 'listKnownChats 应把遗留 MausBot 归一为 co-bot');
    assert.equal(bridge.listChatThreads()[0]?.botName, 'co-bot', 'listChatThreads 应把遗留 MausBot 归一为 co-bot');

    omb.messages.set('t1', [{
      id: 'omb_idle_card',
      role: 'bot',
      kind: 'text',
      threadId: 't1',
      card: { requestId: 'req_idle_1', title: '未点按钮但线程已空闲' },
    }]);
    bridge.deliveredCards.add('req_idle_1');
    bridge.pendingCards.set('im_idle_card', {
      imMsgId: 'im_idle_card',
      inboxRef: 5,
      chatId: 'self',
      cardKind: 'card',
      cardBotId: 'b1',
      requestId: 'req_idle_1',
      threadId: 't1',
      botId: 'b1',
      botName: 'co-bot',
      title: '未点按钮但线程已空闲',
      isQuestion: false,
      options: [],
      canRememberCommand: false,
      createdAt: Date.now(),
    });
    const reconciled = await reconcilePendingCards(bridge);
    assert.equal(reconciled, 1);
    assert.equal(bridge.pendingCards.size, 0);
    assert.equal(bridge.deliveredCards.has('req_idle_1'), false);

    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      const longBody = `# 排查报告\n\n${'详细分析段落内容。'.repeat(18)}\n\nTOKEN=sk-proj-1234567890abcdefghijklmnop`;
      const fin = {
        id: nextId(),
        role: 'bot',
        kind: 'text',
        threadId,
        requestMessageId: reqMsg.id,
        text: longBody,
        turnTerminal: true,
      };
      messages.push(fin);
      jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
      broadcast({ kind: 'message', threadId, message: fin });
    });

    await transport.emitUser('@bot 输出完整分析');
    await until(() => filesSent.length >= 1);
    const mdText = filesSent[0].content;
    assert.match(mdText, /^# 排查报告/);
    assert.equal(mdText.includes('🤖 **[bot]**'), false, '导出 .md 附件不应包含聊天徽章抬头');
    assert.equal(mdText.includes('sk-proj-1234567890'), false, '导出 .md 附件仍必须执行脱敏');
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('UX regression: @bot summary suppresses pre-tool opening chatter and delivers only final summary bubble', async () => {
  const omb = await startMockOmb([{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }]);
  const sent: SentImItem[] = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-ux-summary-'));
  const bridge = new OpenMausBotBridge({
    client: new OpenMausBotClient({ baseUrl: omb.baseUrl }),
    transport,
    dataDir,
    intermediateCoalesceMs: 10,
  });

  const sentPrompts: string[] = [];
  try {
    await bridge.start();
    await bridge.onEvent({
      id: 'ext_1',
      ts: Date.now(),
      chat: { id: 'grp_dev', type: 'group', name: '研发架构群' },
      sender: { id: 'u_alice', name: 'Alice', isSelf: false },
      text: '我们决定用 Redis PubSub 替代轮询。',
    });

    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      sentPrompts.push(String(reqMsg.text || ''));
      const opener = {
        id: nextId(),
        role: 'bot',
        kind: 'text',
        threadId,
        requestMessageId: reqMsg.id,
        text: '我先拉取研发架构群最近的讨论记录。',
        turnTerminal: false,
      };
      messages.push(opener);
      broadcast({ kind: 'message', threadId, message: opener });

      setTimeout(() => {
        const fin = {
          id: nextId(),
          role: 'bot',
          kind: 'text',
          threadId,
          requestMessageId: reqMsg.id,
          text: '1. 核心议题：用 Redis PubSub 替代轮询。',
          turnTerminal: true,
        };
        messages.push(fin);
        jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
        broadcast({ kind: 'message', threadId, message: fin });
      }, 30);
    });

    await transport.emitUser('@bot summary grp_dev');
    await until(() => sent.some((m) => m.text.includes('核心议题：用 Redis PubSub')));
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(sent.length, 1, '@bot summary 应抑制中间拉取开场白，仅发终态纪要');
    assert.equal(sent[0].text.includes('我先拉取'), false);
    assert.match(sentPrompts[0] || '', /直接输出纪要正文/);
  } finally {
    await bridge.stop();
    await omb.close();
  }
});
