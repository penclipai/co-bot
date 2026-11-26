import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenMausBotClient } from '../src/openmausbot/client.ts';
import { OpenMausBotBridge } from '../src/openmausbot/bridge.ts';
import type { OmbHttpError } from '../src/openmausbot/types.ts';
import type { ChannelAction } from '../src/types.ts';
import { until, startMockOmb, makeIm, type SentImItem } from './helpers/mock-omb.ts';

test('code review fixes: respond retry preserves pendingCard, picker mutual exclusion, tighter regexes, non-chief compact target, multi-bubble deliveredOmbIds', async () => {
  const omb = await startMockOmb(
    [
      {
        id: 'b1',
        name: 'MausBot',
        threadId: 't1',
        chiefOfStaff: true,
        modelSelection: { model: '' },
        tasks: [
          { threadId: 't1', title: '主任务', updatedAt: 200 },
          { threadId: 't_other', title: '备用会话', updatedAt: 100 },
        ],
      },
      {
        id: 'b2',
        name: 'Dev',
        threadId: 't2',
        chiefOfStaff: false,
        tasks: [
          { threadId: 't2', title: 'Dev任务', updatedAt: 200, usage: { turns: 3, context: { tokens: 90_000, window: 100_000 } } },
        ],
      },
    ],
    {
      respondFailCount: 1,
      instances: [
        {
          instanceId: 'opencodeGo',
          snapshot: { state: 'available' },
          models: {
            options: [
              { id: 'deepseek/deepseek-flash', label: 'Flash' },
              { id: 'deepseek/deepseek-v4-pro', label: 'Pro' },
            ],
          },
        },
      ],
    },
  );

  const sent: SentImItem[] = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-review-'));
  const bridge = new OpenMausBotBridge({ client: new OpenMausBotClient({ baseUrl: omb.baseUrl }), transport, dataDir });

  try {
    await bridge.start();

    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      setTimeout(() => {
        const card = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, card: { requestId: 'req_retry', title: '执行敏感操作' } };
        messages.push(card);
        jobs.set(threadId, { state: 'needs-input', version: 'v_r1', needsInput: [{ requestId: 'req_retry' }] });
        broadcast({ kind: 'message', threadId, message: card });
      }, 15);
    });
    await transport.emitUser('@bot 开始执行');
    await until(() => sent.some((m) => m.text.includes('执行敏感操作')));
    await transport.emitUser('ok');
    await until(() => sent.some((m) => m.text.includes('审批提交失败')));
    assert.equal(bridge.status().pendingCards, 1, '提交失败时待审批卡片必须保留以允许重试');
    await transport.emitUser('ok');
    await until(() => sent.some((m) => m.text.includes('已执行命令，结果正常')));
    assert.equal(bridge.status().pendingCards, 0);

    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      setTimeout(() => {
        const reply = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: `Agent处理：${reqMsg.text}`, turnTerminal: true };
        messages.push(reply);
        jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
        broadcast({ kind: 'message', threadId, message: reply });
      }, 10);
    });
    await transport.emitUser('@bot 找 一下项目里的 bug');
    await until(() => sent.some((m) => m.text.includes('Agent处理：找 一下项目里的 bug')));
    await transport.emitUser('@bot memory 删除第一条');
    await until(() => sent.some((m) => m.text.includes('Agent处理：memory 删除第一条')));

    const actionsLog: ChannelAction[][] = [];
    const baseSend = transport.send;
    transport.send = async (chatId, text, opts) => {
      if (opts?.actions) actionsLog.push(opts.actions);
      return baseSend.call(transport, chatId, text, opts);
    };
    await transport.emitUser('@Dev status');
    await until(() => sent.some((m) => m.text.includes('90%')));
    const devStatus = sent.findLast((m) => m.text.includes('90%'))!;
    assert.match(devStatus.text, /@Dev compact/);
    assert.equal(actionsLog.length, 0);

    const prevCount = sent.length;
    omb.setScenario(({ reqMsg, threadId, messages, jobs }) => {
      setTimeout(() => {
        const p1 = { id: 'm_multi_1', role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: '第一部分结果' };
        const p2 = { id: 'm_multi_2', role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: '第二部分结果', turnTerminal: true };
        messages.push(p1, p2);
        jobs.set(threadId, { state: 'completed', version: 'v_multi', needsInput: [] });
      }, 15);
    });
    await transport.emitUser('@Dev 同时出两段');
    await until(() => sent.some((m) => m.text.includes('第二部分结果')) && sent.some((m) => m.text.includes('上下文已达 90%')));
    assert.ok(sent.slice(prevCount).some((m) => m.text.includes('@Dev compact')));

    const countBeforePatch = sent.length;
    omb.broadcast({ kind: 'message.patch', threadId: 't2', message: { id: 'm_multi_1', role: 'bot', kind: 'text', threadId: 't2', text: '第一部分结果', turnTerminal: true } });
    await new Promise((r) => setTimeout(r, 35));
    assert.equal(sent.length, countBeforePatch);
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('runtime autoHealOmb: recovers after 2 consecutive SSE network errors (with cooldown), skips on 401/403', async () => {
  let subCalls = 0;
  let healCalls = 0;
  let nowMs = 100_000;
  const mockClient = {
    async listBots() { return { bots: [] }; },
    async subscribeEvents(_onEvent: unknown, { signal, onError }: { signal?: AbortSignal; onError?: (err: OmbHttpError) => void }) {
      while (!signal?.aborted) {
        subCalls += 1;
        onError?.(new Error('fetch failed: ECONNREFUSED'));
        await new Promise((r) => setTimeout(r, 15));
      }
    },
  } as unknown as OpenMausBotClient;
  const b1 = new OpenMausBotBridge({
    client: mockClient,
    transport: makeIm([]),
    autoHealCooldownMs: 30_000,
    autoHealOmb: async () => { healCalls += 1; },
    now: () => nowMs,
  });
  await b1.start();
  await until(() => subCalls >= 4);
  assert.equal(healCalls, 1, '连续 2 次网络异常触发 1 次自愈，冷却期内不得重复触发');
  nowMs += 31_000;
  await until(() => healCalls >= 2);
  await b1.stop();

  let authHealCalls = 0;
  const authClient = {
    async listBots() { return { bots: [] }; },
    async subscribeEvents(_onEvent: unknown, { signal, onError }: { signal?: AbortSignal; onError?: (err: OmbHttpError) => void }) {
      while (!signal?.aborted) {
        const err = new Error('unauthorized') as OmbHttpError;
        err.status = 401;
        onError?.(err);
        await new Promise((r) => setTimeout(r, 15));
      }
    },
  } as unknown as OpenMausBotClient;
  const b2 = new OpenMausBotBridge({
    client: authClient,
    transport: makeIm([]),
    autoHealCooldownMs: 0,
    autoHealOmb: async () => { authHealCalls += 1; },
  });
  await b2.start();
  await until(() => b2.status().sseAuthFailed === true);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(authHealCalls, 0, '401/403 鉴权失败不得触发进程重启自愈');
  await b2.stop();
});

test('Phase 3 UX: intermediate bubble coalescing, maxIntermediateBubbles cap, and flush before card', async () => {
  const omb = await startMockOmb([{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }]);
  const sent: SentImItem[] = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-p3-coalesce-'));
  const bridge = new OpenMausBotBridge({
    client: new OpenMausBotClient({ baseUrl: omb.baseUrl }),
    transport,
    dataDir,
    intermediateCoalesceMs: 40,
    maxIntermediateBubbles: 1,
  });

  try {
    await bridge.start();

    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      const m1 = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: '我先查代码。', turnTerminal: false };
      messages.push(m1);
      broadcast({ kind: 'message', threadId, message: m1 });

      setTimeout(() => {
        const m2 = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: '马上看配置。', turnTerminal: false };
        messages.push(m2);
        broadcast({ kind: 'message', threadId, message: m2 });
      }, 10);

      setTimeout(() => {
        const m3 = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: '准备汇总答案。', turnTerminal: false };
        messages.push(m3);
        broadcast({ kind: 'message', threadId, message: m3 });
      }, 85);

      setTimeout(() => {
        const fin = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: '最终答案：配置无误。', turnTerminal: true };
        messages.push(fin);
        jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
        broadcast({ kind: 'message', threadId, message: fin });
      }, 130);
    });

    await transport.emitUser('@bot 看一下配置');
    await until(() => sent.some((m) => m.text.includes('最终答案：配置无误')));
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(sent.length, 2, '4 条服务端消息应被去噪合成为 2 条手机气泡（1 条中间合批 + 1 条终态合并）');
    assert.match(sent[0].text, /我先查代码。[\s\S]*马上看配置。/);
    assert.match(sent[1].text, /准备汇总答案。[\s\S]*最终答案：配置无误。/);

    const beforeCard = sent.length;
    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      const m1 = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: '先检查磁盘占用。', turnTerminal: false };
      messages.push(m1);
      broadcast({ kind: 'message', threadId, message: m1 });
      setTimeout(() => {
        const pre = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: '需要执行清理命令。', turnTerminal: false };
        messages.push(pre);
        broadcast({ kind: 'message', threadId, message: pre });
      }, 60);
      setTimeout(() => {
        const card = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, card: { requestId: 'req_pre', title: '确认清理缓存' } };
        messages.push(card);
        jobs.set(threadId, { state: 'needs-input', version: 'v_pre', needsInput: [{ requestId: 'req_pre' }] });
        broadcast({ kind: 'message', threadId, message: card });
      }, 95);
    });

    await transport.emitUser('@bot 清缓存');
    await until(() => sent.some((m) => m.text.includes('确认清理缓存')));
    assert.match(sent[beforeCard].text, /先检查磁盘占用/);
    assert.match(sent[beforeCard + 1].text, /需要执行清理命令/);
    assert.match(sent[beforeCard + 2].text, /确认清理缓存/);
    await transport.emitUser('ok');
    await until(() => sent.some((m) => m.text.includes('已执行命令，结果正常')));
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('Phase 3 UX: remote skip/跳过 dismiss for secret, connector, and signIn cards with transient failure retry', async () => {
  const omb = await startMockOmb(
    [{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }],
    { dismissFailCount: 1 },
  );
  const sent: SentImItem[] = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-p3-skip-'));
  const bridge = new OpenMausBotBridge({ client: new OpenMausBotClient({ baseUrl: omb.baseUrl }), transport, dataDir });

  try {
    await bridge.start();
    await until(() => bridge.status().connected);

    const sCard = { id: 'm_sec_1', role: 'bot', kind: 'secret', threadId: 't1', secret: { target: 'openai', label: 'OPENAI_API_KEY' } };
    omb.messages.get('t1')!.push(sCard);
    omb.broadcast({ kind: 'message', threadId: 't1', message: sCard });
    await until(() => sent.some((m) => m.text.includes('OPENAI_API_KEY') && m.text.includes('skip')));
    assert.equal(bridge.status().pendingCards, 1);

    await transport.emitUser('记一条普通备忘，不是 skip');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(bridge.status().pendingCards, 1, '非 skip 文本不应误消费或清除桌面阻塞卡');

    await transport.emitUser('skip');
    await until(() => sent.some((m) => m.text.includes('跳过操作失败')));
    assert.equal(bridge.status().pendingCards, 1, '后端短暂 500 时应保留 pendingCards 以便用户重试');

    await transport.emitUser('跳过');
    await until(() => sent.some((m) => m.text.includes('已跳过该步骤，继续执行')));
    assert.equal(bridge.status().pendingCards, 0);
    assert.deepEqual(omb.cardDismissals.at(-1), { kind: 'secret', action: 'dismiss', botId: 'b1', messageId: 'm_sec_1', threadId: 't1' });

    const cCard = { id: 'm_conn_1', role: 'bot', kind: 'connector', threadId: 't1', connector: { slug: 'github', label: 'GitHub' } };
    omb.messages.get('t1')!.push(cCard);
    omb.broadcast({ kind: 'message', threadId: 't1', message: cCard });
    await until(() => sent.some((m) => m.text.includes('GitHub') && m.text.includes('skip')));
    await transport.emitUser('skip');
    await until(() => omb.cardDismissals.length === 2);
    assert.deepEqual(omb.cardDismissals[1], { kind: 'connector', action: 'dismiss', botId: 'b1', messageId: 'm_conn_1', threadId: 't1' });

    const lCard = { id: 'm_login_1', role: 'bot', kind: 'signIn', threadId: 't1', signIn: { url: 'https://example.com' } };
    omb.messages.get('t1')!.push(lCard);
    omb.broadcast({ kind: 'message', threadId: 't1', message: lCard });
    await until(() => sent.some((m) => m.text.includes('登录验证') && m.text.includes('skip')));
    await transport.emitUser('略过');
    await until(() => omb.cardDismissals.length === 3);
    assert.deepEqual(omb.cardDismissals[2], { kind: 'signIn', action: 'cancel', botId: 'b1', messageId: 'm_login_1', threadId: 't1' });
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('Phase 3 UX: Chinese spoken ordinals across question cards and @bot task', async () => {
  const omb = await startMockOmb([
    {
      id: 'b1',
      name: 'MausBot',
      threadId: 't1',
      chiefOfStaff: true,
      tasks: [
        { threadId: 't1', title: '当前开发会话', updatedAt: 200 },
        { threadId: 't_old', title: '线上回归排查', updatedAt: 100 },
      ],
    },
  ]);
  const sent: SentImItem[] = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-p3-ordinals-'));
  const bridge = new OpenMausBotBridge({ client: new OpenMausBotClient({ baseUrl: omb.baseUrl }), transport, dataDir });

  try {
    await bridge.start();

    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      setTimeout(() => {
        const qCard = {
          id: nextId(), role: 'bot', kind: 'options', threadId, requestMessageId: reqMsg.id,
          card: {
            requestId: 'req_ord',
            requestType: 'question',
            title: '选哪个方案',
            questions: [{ question: '部署方式', options: [{ label: '灰度' }, { label: '全量' }] }],
          },
        };
        messages.push(qCard);
        jobs.set(threadId, { state: 'needs-input', version: 'v_ord', needsInput: [{ requestId: 'req_ord' }] });
        broadcast({ kind: 'message', threadId, message: qCard });
      }, 15);
    });
    await transport.emitUser('@bot 开始发布');
    await until(() => sent.some((m) => m.text.includes('1. **灰度**')));
    await transport.emitUser('第二个');
    await until(() => sent.some((m) => m.text.includes('已采用方案：全量')));
    assert.equal(omb.responds[0]?.message, '全量');

    await transport.emitUser('@bot task');
    await until(() => sent.some((m) => m.text.includes('线上回归排查')));
    await transport.emitUser('1个无关备忘');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(omb.tasksSelected.length, 0);

    await transport.emitUser('选二');
    await until(() => sent.some((m) => m.text.includes('线上回归排查') && m.text.includes('已切换到')));
    assert.equal(omb.tasksSelected.at(-1)?.threadId, 't_old');
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('Phase 3 UX: multi-bot group room @<群名> dual-bot replies, quote continuation, task/new/steer/stop, and single-bot guard', async () => {
  const omb = await startMockOmb(
    [
      { id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true },
      { id: 'b2', name: 'Dev', threadId: 't2', chiefOfStaff: false },
      { id: 'b3', name: 'QA', threadId: 't3', chiefOfStaff: false },
    ],
    {
      queueWhenBusy: true,
      groups: [
        {
          id: 'g1',
          name: '架构组',
          memberIds: ['b2', 'b3'],
          threadId: 'gt1',
          tasks: [
            { threadId: 'gt1', title: '架构评审', updatedAt: 200 },
            { threadId: 'gt_old', title: '性能优化', updatedAt: 100 },
          ],
        },
      ],
    },
  );
  const sent: SentImItem[] = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-p3-group-'));
  const bridge = new OpenMausBotBridge({
    client: new OpenMausBotClient({ baseUrl: omb.baseUrl }),
    transport,
    dataDir,
    intermediateCoalesceMs: 0,
  });

  try {
    await bridge.start();

    await transport.emitUser('@bot status');
    await until(() => sent.some((m) => m.text.includes('群组（') && m.text.includes('架构组')));

    omb.setScenario(({ group, reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      if (!group) return;
      setTimeout(() => {
        const m1 = {
          id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id,
          from: { botId: 'b2', name: 'Dev' }, text: `接口分析（${reqMsg.text}）：已对齐。`, turnTerminal: true,
        };
        messages.push(m1);
        broadcast({ kind: 'message', threadId, message: m1 });
      }, 15);
      setTimeout(() => {
        const m2 = {
          id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id,
          from: { botId: 'b3', name: 'QA' }, text: `回归测试（${reqMsg.text}）：全部通过。`, turnTerminal: true,
        };
        messages.push(m2);
        jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
        broadcast({ kind: 'message', threadId, message: m2 });
      }, 55);
    });

    await transport.emitUser('@架构组 评审认证方案');
    await until(() => sent.some((m) => m.text.includes('[架构组 · Dev]')) && sent.some((m) => m.text.includes('[架构组 · QA]')));
    assert.equal(omb.sentToOmb[0]?.groupId, 'g1');
    assert.equal(omb.sentToOmb[0]?.threadId, 'gt1');

    const qaBubble = sent.find((m) => m.text.includes('[架构组 · QA]'))!;
    await transport.emitUser('并发锁再测一遍', { replyTo: qaBubble.id });
    await until(() => omb.sentToOmb.length === 2 && sent.filter((m) => m.text.includes('并发锁再测一遍')).length >= 2);
    assert.equal(omb.sentToOmb[1]?.groupId, 'g1');

    await until(() => bridge.status().activeTurns === 0);

    await transport.emitUser('@架构组 compact');
    await until(() => sent.some((m) => m.text.includes('群组「架构组」不支持该单 Bot 指令')));

    await transport.emitUser('@架构组 task');
    await until(() => sent.some((m) => m.text.includes('性能优化')));
    await transport.emitUser('第二个');
    await until(() => sent.some((m) => m.text.includes('已切换到 **架构组** 的会话「性能优化」')));
    assert.equal(omb.tasksSelected.at(-1)?.groupId, 'g1');
    assert.equal(omb.tasksSelected.at(-1)?.threadId, 'gt_old');

    await transport.emitUser('@架构组 new 登录限流评审');
    await until(() => omb.tasksCreated.at(-1)?.groupId === 'g1' && sent.some((m) => m.text.includes('回归测试（登录限流评审）')));
    await until(() => bridge.status().activeTurns === 0);

    omb.setScenario(() => {});
    await transport.emitUser('@架构组 启动长讨论');
    await until(() => omb.sentToOmb.at(-1)?.text === '启动长讨论');
    await transport.emitUser('@架构组 补充压测要求');
    await until(() => sent.some((m) => m.text.includes('已排队') && m.text.includes('@架构组 steer')));
    await transport.emitUser('@架构组 steer');
    await until(() => sent.some((m) => m.text.includes('已插队注入当前任务')));
    assert.equal(omb.steered.at(-1)?.groupId, 'g1');

    await transport.emitUser('@架构组 stop');
    await until(() => sent.some((m) => m.text.includes('已请求停止 **架构组**')));
    assert.equal(omb.interrupts.at(-1)?.groupId, 'g1');
  } finally {
    await bridge.stop();
    await omb.close();
  }
});
