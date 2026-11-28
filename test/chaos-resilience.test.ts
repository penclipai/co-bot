import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OpenMausBotBridge } from '../src/openmausbot/bridge.ts';
import { formatActivity } from '../src/openmausbot/cards.ts';
import { OpenMausBotClient } from '../src/openmausbot/client.ts';
import { trySteerQueueItem } from '../src/openmausbot/queue-and-sse.ts';
import type { OmbMessage } from '../src/openmausbot/types.ts';
import { WebServer } from '../src/web/server.ts';
import { getFreePort, makeIm, type SentImItem, startMockOmb, until } from './helpers/mock-omb.ts';

test('Chaos regression: /burst child threads suppress proactive spam, pass cards, exclude task list, and survive restart', async () => {
  const omb = await startMockOmb([
    {
      id: 'b1',
      name: 'MausBot',
      threadId: 't_parent',
      chiefOfStaff: true,
      tasks: [
        { threadId: 't_parent', title: '主协调线程', updatedAt: 1000 },
        {
          threadId: 't_child_1',
          title: '子任务1：审计 core',
          updatedAt: 2000,
          openedBy: { botId: 'b1', name: 'co-bot', threadId: 't_parent', burstId: 'burst_r2_1', at: 2000 },
        },
      ],
    },
  ]);

  const sent: SentImItem[] = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-burst-chaos-'));
  const makeBridge = () => new OpenMausBotBridge({
    client: new OpenMausBotClient({ baseUrl: omb.baseUrl }),
    transport: makeIm(sent),
    dataDir,
    progressDelayMs: 10,
    progressIntervalMs: 10,
    turnStallMs: 0,
  });

  let bridge = makeBridge();
  try {
    await bridge.start();
    const { top } = await bridge.collectBotTasks({ id: 'b1', name: 'co-bot', threadId: 't_parent' });
    assert.equal(top.some((t) => t.threadId === 't_child_1'), false, 'collectBotTasks 应过滤 /burst 子任务线程');

    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      const burstMsg: OmbMessage = {
        id: nextId(),
        role: 'bot',
        kind: 'burst',
        threadId,
        requestMessageId: reqMsg.id,
        burst: {
          burstId: 'burst_r2_1',
          task: '并行审计三个模块',
          phase: 'preview',
          total: 2,
          parallel: 2,
          sample: ['检查 core', '检查 plugins'],
        },
      };
      messages.push(burstMsg);
      jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
      broadcast({ kind: 'message', threadId, message: burstMsg });
    });
    omb.setBurstHandler(({ burstId, action }) => ({ ok: true, burstId, phase: action === 'run' ? 'running' : 'cancelled' }));

    await bridge.onEvent({ id: 'u_burst', ts: Date.now(), chat: { id: 'self', type: 'self', name: '自聊' }, sender: { id: 'me', name: '我', isSelf: true }, text: '@bot /burst 并行审计三个模块' });
    await until(() => sent.some((m) => m.text.includes('并发任务待确认')));
    await bridge.onEvent({ id: 'u_go', ts: Date.now() + 1, chat: { id: 'self', type: 'self', name: '自聊' }, sender: { id: 'me', name: '我', isSelf: true }, text: '1' });
    await until(() => sent.some((m) => m.text.includes('已启动并发拆分任务')));

    assert.equal(bridge.status().activeBursts, 1);

    // Child worker proactive terminal report must be suppressed silently
    const countBeforeChild = sent.length;
    omb.broadcast({
      kind: 'message',
      threadId: 't_child_1',
      message: { id: 'child_txt_1', role: 'bot', kind: 'text', threadId: 't_child_1', text: '子任务1完整 verbose 报告', turnTerminal: true },
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(sent.length, countBeforeChild, 'burst 子线程普通输出不得当成主动通知刷入自聊');

    // Child worker approval card must still pass through
    omb.broadcast({
      kind: 'message',
      threadId: 't_child_1',
      message: {
        id: 'child_card_1',
        role: 'bot',
        kind: 'card',
        threadId: 't_child_1',
        card: { requestId: 'req_child_1', requestType: 'permission', title: '子任务需要允许读取' },
      },
    });
    await until(() => sent.some((m) => m.text.includes('子任务需要允许读取')));

    // Restart bridge while burst is still active
    await bridge.stop();
    bridge = makeBridge();
    await bridge.start();
    assert.equal(bridge.status().activeBursts, 1, '重启后应恢复 activeBursts 追踪');

    omb.broadcast({
      kind: 'message',
      threadId: 't_parent',
      message: { id: 'b_done_1', role: 'bot', kind: 'burst', threadId: 't_parent', burst: { burstId: 'burst_r2_1', phase: 'done', total: 2 } },
    });
    omb.broadcast({
      kind: 'message',
      threadId: 't_parent',
      message: { id: 'b_merge_1', role: 'bot', kind: 'text', threadId: 't_parent', text: '三个模块并发汇总完毕。', turnTerminal: true },
    });
    await until(() => sent.some((m) => m.text.includes('三个模块并发汇总完毕')));
    assert.equal(bridge.status().activeBursts, 0);
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('Chaos regression: steered turn tracking collects steered reply & pendingThreads ref-counting resists overlap', async () => {
  const omb = await startMockOmb([{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }]);
  const sent: SentImItem[] = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-steer-chaos-'));
  const bridge = new OpenMausBotBridge({
    client: new OpenMausBotClient({ baseUrl: omb.baseUrl }),
    transport: makeIm(sent),
    dataDir,
    turnStallMs: 0,
  });

  try {
    await bridge.start();

    bridge.acquirePendingThread('t_overlap');
    bridge.acquirePendingThread('t_overlap');
    assert.equal(bridge.pendingThreads.has('t_overlap'), true);
    bridge.releasePendingThread('t_overlap');
    assert.equal(bridge.pendingThreads.has('t_overlap'), true, '计数为 1 时不得提前移除 pendingThreads');
    bridge.releasePendingThread('t_overlap');
    assert.equal(bridge.pendingThreads.has('t_overlap'), false);

    // Seed thread messages with initial user msg (req_1), steered user msg (req_2), and final bot reply linked to req_2
    const origGetMessages = bridge.client.getMessages.bind(bridge.client);
    bridge.client.getMessages = async (tid: string, limit = 20) => {
      if (tid === 't1') {
        return {
          messages: [
            { id: 'req_1', role: 'user', kind: 'text', threadId: 't1', sendId: 'send_1', text: '初始问题' },
            { id: 'req_2', role: 'user', kind: 'text', threadId: 't1', sendId: 'send_2', text: '补充插队要求' },
            { id: 'bot_final_steered', role: 'bot', kind: 'text', threadId: 't1', requestMessageId: 'req_2', text: '已按补充要求输出最终答案', turnTerminal: true },
          ],
        };
      }
      return origGetMessages(tid, limit);
    };

    const turn = bridge.trackTurn({
      key: 'req_1',
      botId: 'b1',
      botName: 'co-bot',
      threadId: 't1',
      reqMsgId: 'req_1',
      sendId: 'send_1',
    });
    turn.addSteeredRequest?.('req_2', 'send_2');
    await turn.complete('completed');

    assert.ok(sent.some((m) => m.text.includes('已按补充要求输出最终答案')), '被 steer 后的终态回复应成功收回并交付');
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('Chaos regression: internal snake_case activity sanitization, unquoted confirm/disambiguate, #999 cancel feedback, and favicon 204', async () => {
  assert.equal(
    formatActivity({ tool: { name: 'agents_session_search', spoken: 'running agents_session_search' } }),
    '⚙️ 正在处理中…',
  );
  assert.equal(
    formatActivity({ tool: { name: 'bash', spoken: 'calling my_internal_tool' } }),
    '⚙️ 正在执行命令…',
  );

  const omb = await startMockOmb(
    [{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }],
    { steerBlockedBy: 'bash' },
  );
  const sent: SentImItem[] = [];
  const sentByChat: Array<{ chatId: string; text: string }> = [];
  const transport = makeIm(sent);
  const origSend = transport.send.bind(transport);
  transport.send = async (chatId, text, opts) => {
    sentByChat.push({ chatId, text });
    return origSend(chatId, text, opts);
  };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-draft-ux-chaos-'));
  const bridge = new OpenMausBotBridge({
    client: new OpenMausBotClient({ baseUrl: omb.baseUrl }),
    transport,
    dataDir,
    followUpWindowMs: 120_000,
    turnStallMs: 0,
  });

  const srv = new WebServer({ host: '127.0.0.1', port: await getFreePort() });
  try {
    await srv.start();
    const favRes = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${srv.port}/favicon.ico`, (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0 });
      });
      req.on('error', reject);
    });
    assert.equal(favRes.status, 204);

    await bridge.start();

    // Verify trySteerQueueItem with custom onQueuedText omits duplicate steer hint
    const steerRes = await trySteerQueueItem(
      bridge,
      { queueId: 'q1', botId: 'b1', botName: 'co-bot', threadId: 't1', isGroup: false, text: '补充', sendId: 's1', at: Date.now(), chatCtx: null },
      { targetChatId: 'chat_self', onQueuedText: () => '⏳ 工具执行中，已加入队列。' },
    );
    assert.equal(steerRes.steered, false);
    const queuedMsg = sent.at(-1)!.text;
    assert.equal(queuedMsg.includes('cancel'), true);
    assert.equal(queuedMsg.includes('@bot steer'), false);

    // Create 2 private drafts via grp_dev
    let n = 0;
    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      n += 1;
      const fin = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: `草稿内容${n}`, turnTerminal: true };
      messages.push(fin);
      jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
      broadcast({ kind: 'message', threadId, message: fin });
    });

    await bridge.onEvent({ id: 'g_m1', ts: Date.now(), chat: { id: 'grp_dev', type: 'group', name: '研发群' }, sender: { id: 'me', name: '我', isSelf: true }, text: '@bot! 草稿一' });
    await until(() => sent.some((m) => m.text.includes('草稿内容1')));
    await bridge.onEvent({ id: 'g_m2', ts: Date.now() + 1, chat: { id: 'grp_dev', type: 'group', name: '研发群' }, sender: { id: 'me', name: '我', isSelf: true }, text: '@bot! 草稿二' });
    await until(() => sent.some((m) => m.text.includes('草稿内容2')));

    // Enable sticky explicitly and verify bare `确认发送` disambiguates 2 drafts without hitting OMB
    bridge.lastBotReplyAt = bridge.now();
    bridge.focus = { botId: 'b1', botName: 'co-bot', threadId: 't1' };
    const ombBefore = omb.sentToOmb.length;
    await transport.emitUser('确认发送');
    assert.equal(omb.sentToOmb.length, ombBefore, '有多个私密草稿时裸 `确认发送` 不应误送往 OMB');
    assert.match(sent.at(-1)!.text, /有多条待发私密草稿[\s\S]*#1[\s\S]*#2/);

    // Cancel #1, then bare `确认发送` sends remaining #2 directly to grp_dev
    await transport.emitUser('#1 取消');
    await transport.emitUser('确认发送');
    assert.equal(omb.sentToOmb.length, ombBefore, '单草稿时裸 `确认发送` 应直接回发原群而不送往 OMB');
    assert.ok(sentByChat.some((m) => m.chatId === 'grp_dev' && m.text.includes('草稿内容2')));

    // Invalid ref cancel gives explicit not-found error
    await transport.emitUser('@bot sendback cancel #999');
    assert.match(sent.at(-1)!.text, /未找到或已过期的草稿或发回确认 `#999`/);
  } finally {
    await srv.stop().catch(() => {});
    await bridge.stop();
    await omb.close();
  }
});
