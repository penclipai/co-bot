import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OpenMausBotBridge } from '../src/openmausbot/bridge.ts';
import { OpenMausBotClient } from '../src/openmausbot/client.ts';
import { prepareSlashOutbound } from '../src/openmausbot/dispatch.ts';
import type { BridgeTransport, OmbMessage } from '../src/openmausbot/types.ts';
import type { InboundEvent } from '../src/types.ts';
import { makeIm, type SentImItem, startMockOmb, until } from './helpers/mock-omb.ts';

test('prepareSlashOutbound keeps slash commands at start and switches /goal to mode=goal', () => {
  const ctx = '[当前绑定项目：app | 路径：/repo/app]\n\n';
  assert.deepEqual(prepareSlashOutbound('普通问题', ctx), { outboundText: `${ctx}普通问题` });
  assert.deepEqual(prepareSlashOutbound('/goal 梳理本周发布风险', ctx), {
    mode: 'goal',
    outboundText: '梳理本周发布风险\n\n[当前绑定项目：app | 路径：/repo/app]',
  });
  assert.deepEqual(prepareSlashOutbound('  /goal   ', ctx), {
    mode: 'goal',
    outboundText: '',
    emptyGoal: true,
  });
  assert.deepEqual(prepareSlashOutbound('/learn 总结排查步骤', ctx), {
    outboundText: '/learn 总结排查步骤\n\n[当前绑定项目：app | 路径：/repo/app]',
  });
  assert.deepEqual(prepareSlashOutbound('/learn', ctx), { outboundText: '/learn' });
  assert.deepEqual(prepareSlashOutbound('/setup 作为值班工程师', ctx), {
    outboundText: '/setup 作为值班工程师\n\n[当前绑定项目：app | 路径：/repo/app]',
  });
  assert.deepEqual(prepareSlashOutbound('/setup', ctx), { outboundText: '/setup' });
  assert.deepEqual(prepareSlashOutbound('/burst 分别检查 A、B', ctx), {
    outboundText: '/burst 分别检查 A、B\n\n[当前绑定项目：app | 路径：/repo/app]',
  });
  assert.deepEqual(prepareSlashOutbound('/burst', ctx), { outboundText: '/burst' });
  assert.deepEqual(prepareSlashOutbound('/deploy-check --env=prod', ctx), {
    outboundText: '/deploy-check --env=prod\n\n[当前绑定项目：app | 路径：/repo/app]',
  });
});

test('E2E: /goal mode, goal.run progress & completion across single bot and group', async () => {
  const omb = await startMockOmb(
    [
      { id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true },
      { id: 'b2', name: 'Dev', threadId: 't2', chiefOfStaff: false },
    ],
    {
      groups: [{ id: 'g1', name: '研发组', threadId: 'tg1', memberIds: ['b1', 'b2'] }],
    },
  );
  const sent: SentImItem[] = [];
  const transport = makeIm(sent);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-slash-goal-'));
  const repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  const bridge = new OpenMausBotBridge({
    client: new OpenMausBotClient({ baseUrl: omb.baseUrl }),
    transport,
    dataDir: tmpDir,
    projects: [{ name: 'app', path: repoDir, aliases: [] }],
    progressDelayMs: 10,
    progressIntervalMs: 10,
    turnStallMs: 0,
  });

  try {
    await bridge.start();
    await transport.emitUser(`@bot bind ${repoDir}`);
    await until(() => sent.some((m) => m.text.includes('已将「自聊」绑定到项目')));

    // 1. 空 /goal 返回引导提示且不发往 OpenMausBot
    const beforeEmpty = omb.sentToOmb.length;
    await transport.emitUser('@bot /goal');
    await until(() => sent.some((m) => m.text.includes('请在 `/goal` 后写明要达成的目标')));
    assert.equal(omb.sentToOmb.length, beforeEmpty);

    // 2. 单 Bot @bot /goal：校验 mode="goal" 与 goal.run 推进 + 终态交付
    omb.setScenario(({ reqMsg, mode, threadId, messages, jobs, broadcast, nextId }) => {
      assert.equal(mode, 'goal');
      assert.equal(String(reqMsg.text).startsWith('梳理本周发布风险'), true);
      assert.equal(String(reqMsg.text).includes('app'), true, '上下文块应附在目标正文后方');

      const workingMsg: OmbMessage = {
        id: nextId(),
        role: 'bot',
        kind: 'goal.run',
        threadId,
        requestMessageId: reqMsg.id,
        text: '正在推进目标',
        goalRun: { runId: 'gr_1', goal: '梳理本周发布风险', status: 'working', turnCount: 1, maxTurns: 6, detail: '检查核心依赖与单测覆盖' },
      };
      messages.push(workingMsg);
      broadcast({ kind: 'message', threadId, message: workingMsg });

      setTimeout(() => {
        const doneMsg: OmbMessage = {
          id: nextId(),
          role: 'bot',
          kind: 'goal.run',
          threadId,
          requestMessageId: reqMsg.id,
          text: 'Goal完成：无高危阻断项，建议执行全量回归。',
          goalRun: { runId: 'gr_1', goal: '梳理本周发布风险', status: 'completed', turnCount: 2, maxTurns: 6, detail: '检查完成' },
        };
        messages.push(doneMsg);
        jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
        broadcast({ kind: 'message', threadId, message: doneMsg });
      }, 45);
    });

    await transport.emitUser('@bot /goal 梳理本周发布风险');
    await until(() => sent.some((m) => m.text.includes('Goal完成：无高危阻断项')));
    assert.ok(sent.some((m) => m.text.includes('目标推进中（第 1/6 步）')));
    assert.match(sent.at(-1)!.text, /^🤖 \*\*\[bot\]\*\*/);

    // 3. 多 Bot 群组 @研发组 /goal：走 sendGroupMessage 且带 mode="goal"
    omb.setScenario(({ reqMsg, mode, threadId, messages, jobs, broadcast, nextId }) => {
      assert.equal(mode, 'goal');
      assert.equal(String(reqMsg.text).startsWith('完成前后端联调'), true);
      const fin: OmbMessage = {
        id: nextId(),
        role: 'bot',
        kind: 'text',
        threadId,
        requestMessageId: reqMsg.id,
        from: { botId: 'b1', name: 'co-bot' },
        text: '联调方案已对齐。',
        turnTerminal: true,
      };
      messages.push(fin);
      jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
      broadcast({ kind: 'message', threadId, message: fin });
    });

    await transport.emitUser('@研发组 /goal 完成前后端联调');
    await until(() => sent.some((m) => m.text.includes('联调方案已对齐')));
    const lastGrpReq = omb.sentToOmb.at(-1)!;
    assert.equal(lastGrpReq.groupId, 'g1');
    assert.equal(lastGrpReq.mode, 'goal');
  } finally {
    await bridge.stop();
    await omb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('E2E: /learn and /setup keep slash command first despite bound context and support review card ok/no', async () => {
  const omb = await startMockOmb([{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }]);
  const sent: SentImItem[] = [];
  const transport = makeIm(sent);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-slash-learn-setup-'));
  const repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  const bridge = new OpenMausBotBridge({
    client: new OpenMausBotClient({ baseUrl: omb.baseUrl }),
    transport,
    dataDir: tmpDir,
    projects: [{ name: 'portal', path: repoDir, aliases: [] }],
    turnStallMs: 0,
  });

  try {
    await bridge.start();
    await transport.emitUser(`@bot bind ${repoDir}`);
    await until(() => sent.some((m) => m.text.includes('已将「自聊」绑定到项目')));

    // 1. /learn 带参数 + 裸 /learn
    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      const fin: OmbMessage = {
        id: nextId(),
        role: 'bot',
        kind: 'text',
        threadId,
        requestMessageId: reqMsg.id,
        text: `已保存技能：${String(reqMsg.text).startsWith('/learn ') ? 'deploy-skill' : 'recent-run'}`,
        turnTerminal: true,
      };
      messages.push(fin);
      jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
      broadcast({ kind: 'message', threadId, message: fin });
    });

    await transport.emitUser('@bot /learn 将发布步骤沉淀为技能');
    await until(() => sent.some((m) => m.text.includes('已保存技能：deploy-skill')));
    const learnWire = String(omb.sentToOmb.at(-1)!.text);
    assert.equal(learnWire.startsWith('/learn 将发布步骤沉淀为技能'), true, '项目绑定上下文不得破坏 /learn 句首位置');
    assert.equal(learnWire.includes('portal'), true);

    await transport.emitUser('@bot /learn');
    await until(() => sent.some((m) => m.text.includes('已保存技能：recent-run')));
    assert.equal(omb.sentToOmb.at(-1)!.text, '/learn', '裸 /learn 应保持纯净，不拼接前置/后置上下文');

    // 2. /setup 提案卡片（含 Apply/Cancel + teamSetupRequest）-> 走审批而非序号提问 -> 回复 ok 允许
    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      const setupReqText = String(reqMsg.text);
      assert.equal(setupReqText.startsWith('/setup 作为发布值班助手'), true);
      const cardMsg: OmbMessage = {
        id: nextId(),
        role: 'bot',
        kind: 'card',
        threadId,
        requestMessageId: reqMsg.id,
        card: {
          requestId: 'req_setup_1',
          title: '应用团队角色方案',
          subtitle: '设置主 Bot 职责为发布值班助手',
          options: ['Apply', 'Cancel'],
          teamSetupRequest: { id: 'tsr_1', state: 'pending' },
        },
      };
      messages.push(cardMsg);
      jobs.set(threadId, { state: 'needs-input', version: `v_${reqMsg.id}`, needsInput: [{ requestId: 'req_setup_1' }] });
      broadcast({ kind: 'message', threadId, message: cardMsg });
    });

    await transport.emitUser('@bot /setup 作为发布值班助手');
    await until(() => sent.some((m) => m.text.includes('⏸️ **需要确认 · 应用团队角色方案**')));
    const setupCardMsg = sent.at(-1)!;
    assert.equal(setupCardMsg.actions?.length ?? 0, 0, '已去掉真卡片按钮');
    assert.ok(setupCardMsg.text.includes('> 设置主 Bot 职责为发布值班助手'));
    assert.ok(setupCardMsg.text.includes('---'));
    assert.equal(sent.some((m) => m.text.includes('回复序号')), false, 'teamSetupRequest 评审卡应渲染为 1/0 审批伪卡片');

    await transport.emitUser('ok');
    await until(() => omb.responds.length === 1 && sent.some((m) => m.text.includes('已执行命令，结果正常')));
    assert.equal(omb.responds[0].behavior, 'allow');
    assert.equal(omb.responds[0].requestId, 'req_setup_1');
  } finally {
    await bridge.stop();
    await omb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('E2E: /burst preview card -> IM ok/no dispatch, merged reply delivery (even proactive=false), and cancel', async () => {
  const omb = await startMockOmb([{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }]);
  const sent: SentImItem[] = [];
  const transport = makeIm(sent);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-slash-burst-'));
  const bridge = new OpenMausBotBridge({
    client: new OpenMausBotClient({ baseUrl: omb.baseUrl }),
    transport,
    dataDir: tmpDir,
    proactive: false,
    turnStallMs: 0,
  });

  try {
    await bridge.start();

    // Case A: /burst 提案卡片 -> 用户回复 ok -> 启动并在完成后下发合并回复
    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      assert.equal(String(reqMsg.text), '/burst 并行巡检 core、web、scripts');
      const burstMsg: OmbMessage = {
        id: nextId(),
        role: 'bot',
        kind: 'burst',
        threadId,
        requestMessageId: reqMsg.id,
        burst: {
          burstId: 'burst_1',
          task: '并行巡检 3 个目录',
          phase: 'preview',
          total: 3,
          parallel: 3,
          estimateMinutes: 1,
          sample: ['检查 src/core', '检查 src/web', '检查 scripts'],
        },
      };
      messages.push(burstMsg);
      jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
      broadcast({ kind: 'message', threadId, message: burstMsg });
    });

    omb.setBurstHandler(({ burstId, action, broadcast, messages, nextId }) => {
      if (action === 'run') {
        const arr = messages.get('t1') ?? [];
        setTimeout(() => {
          const mergedMsg: OmbMessage = {
            id: nextId(),
            role: 'bot',
            kind: 'text',
            threadId: 't1',
            text: '三个目录巡检完毕，未发现阻塞问题。',
            turnTerminal: true,
          };
          const doneBurst: OmbMessage = {
            id: nextId(),
            role: 'bot',
            kind: 'burst',
            threadId: 't1',
            burst: { burstId, task: '并行巡检 3 个目录', phase: 'done', total: 3 },
          };
          arr.push(doneBurst, mergedMsg);
          broadcast({ kind: 'message', threadId: 't1', message: doneBurst });
          broadcast({ kind: 'message', threadId: 't1', message: mergedMsg });
        }, 30);
      }
      return { ok: true, burstId, phase: action === 'run' ? 'running' : 'cancelled' };
    });

    await transport.emitUser('@bot /burst 并行巡检 core、web、scripts');
    await until(() => sent.some((m) => m.text.includes('⚡ **并发任务待确认 · 并行巡检 3 个目录**')));
    const burst1Card = sent.at(-1)!;
    assert.equal(burst1Card.actions?.length ?? 0, 0, 'burst 伪卡片不生成真卡片按钮');
    assert.ok(burst1Card.text.includes('> 共 3 项 · 并发 3 · 预计约 1 分钟'));
    assert.ok(burst1Card.text.includes('👉 回复 **`1` 开始执行** · **`0` 取消**'));
    assert.equal(sent.some((m) => m.text.includes('未返回有效回复')), false, '仅返回 burst 预览卡时不得误报空转');

    await transport.emitUser('1');
    await until(() => sent.some((m) => m.text.includes('三个目录巡检完毕，未发现阻塞问题')));
    assert.equal(bridge.activeBursts.size, 0, 'done 与汇总文本均到达后应立即清理 activeBursts');
    assert.deepEqual(omb.burstActions[0], { burstId: 'burst_1', action: 'run' });
    assert.ok(sent.some((m) => m.text.includes('已启动并发拆分任务')));
    assert.match(sent.at(-1)!.text, /^🤖 \*\*\[bot\]\*\*/);

    // Case B: 第二个 burst 提案 -> 用户回复 0 -> 调用 /cancel
    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      const burstMsg: OmbMessage = {
        id: nextId(),
        role: 'bot',
        kind: 'burst',
        threadId,
        requestMessageId: reqMsg.id,
        burst: {
          burstId: 'burst_2',
          task: '批量清理日志',
          phase: 'preview',
          total: 2,
          sample: ['log1', 'log2'],
        },
      };
      messages.push(burstMsg);
      jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
      broadcast({ kind: 'message', threadId, message: burstMsg });
    });

    await transport.emitUser('@bot /burst 批量清理日志');
    await until(() => sent.some((m) => m.text.includes('⚡ **并发任务待确认 · 批量清理日志**')));
    await transport.emitUser('0');
    await until(() => sent.some((m) => m.text.includes('已取消该并发拆分任务')));
    assert.deepEqual(omb.burstActions[1], { burstId: 'burst_2', action: 'cancel' });
  } finally {
    await bridge.stop();
    await omb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('E2E: external collaborators cannot invoke /goal, /learn, /burst, or /setup', async () => {
  const omb = await startMockOmb([{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }]);
  let handler: ((ev: InboundEvent) => unknown) | undefined;
  const sent: SentImItem[] = [];
  const transport: BridgeTransport = {
    selfChatId: 'self',
    async start(fn) { handler = fn; },
    async stop() {},
    async send(_chatId, text) {
      sent.push({ id: `im_${sent.length + 1}`, text, replyTo: null });
      return `im_${sent.length}`;
    },
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-slash-sec-'));
  const bridge = new OpenMausBotBridge({
    client: new OpenMausBotClient({ baseUrl: omb.baseUrl }),
    transport,
    dataDir: tmpDir,
    chats: {
      mode: 'owner_everywhere',
      collaborators: [{ id: 'col_1', name: '同事A', policy: 'auto_readonly', projects: [], chats: [] }],
    },
    turnStallMs: 0,
  });

  try {
    await bridge.start();
    const emit = handler;
    assert.ok(emit);
    for (const cmd of ['@bot /goal 越权', '@bot /learn 越权', '@bot /burst a,b', '@bot /setup 越权']) {
      await emit({
        id: `ext_${Math.random()}`,
        ts: Date.now(),
        chat: { id: 'grp_ext_1', type: 'group', name: '外部群' },
        sender: { id: 'col_1', name: '同事A', isSelf: false },
        text: cmd,
      });
    }
    await emit({
      id: `ext_${Math.random()}`,
      ts: Date.now(),
      chat: { id: 'grp_ext_1', type: 'group', name: '外部群' },
      sender: { id: 'col_1', name: '同事A', isSelf: false },
      mentionsMe: true,
      text: '/setup',
    });
    await emit({
      id: `ext_${Math.random()}`,
      ts: Date.now(),
      chat: { id: 'grp_ext_1', type: 'group', name: '外部群' },
      sender: { id: 'col_1', name: '同事A', isSelf: false },
      text: '@bot /learn 委托越权\n[cobot:req id=del_sec_1]',
    });
    assert.equal(bridge.policyDenials, 6);
    assert.equal(omb.sentToOmb.length, 0);

    // 纵深防御：只读协作者消息即使以斜杠内容到达 dispatchToBot，也不得开启 goal 模式或剥离只读护栏
    omb.setScenario(({ reqMsg, mode, threadId, messages, jobs, broadcast, nextId }) => {
      assert.equal(mode, null);
      assert.equal(String(reqMsg.text).startsWith('/learn'), false);
      const fin: OmbMessage = {
        id: nextId(),
        role: 'bot',
        kind: 'text',
        threadId,
        requestMessageId: reqMsg.id,
        text: '只读回复。',
        turnTerminal: true,
      };
      messages.push(fin);
      jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
      broadcast({ kind: 'message', threadId, message: fin });
    });
    await emit({
      id: `ext_${Math.random()}`,
      ts: Date.now(),
      chat: { id: 'grp_ext_1', type: 'group', name: '外部群' },
      sender: { id: 'col_1', name: '同事A', isSelf: false },
      mentionsMe: true,
      text: '/learn 即使触发也应保留只读护栏',
    });
    assert.equal(bridge.policyDenials, 7);
    assert.equal(omb.sentToOmb.length, 0);

    const readonlyDispatched = await bridge.dispatchToBot(
      { id: 'b1', name: 'MausBot', threadId: 't1' },
      '/goal 即使直调也禁用',
      null,
      null,
      null,
      {
        isExternal: true,
        originChatId: 'grp_ext_1',
        chatType: 'group',
        replyChatId: 'grp_ext_1',
        controlChatId: 'self',
        replyToImMsgId: null,
        originQuoteId: null,
        privateReply: false,
        silentProgress: true,
        readonly: true,
      },
    );
    assert.ok(readonlyDispatched);
    assert.equal(omb.sentToOmb.length, 1);
    assert.equal(omb.sentToOmb[0].mode, null);
  } finally {
    await bridge.stop();
    await omb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('E2E: nested card.questionRequest multi-question onboarding card & profileRequest review card render Markdown pseudo-cards without button actions', async () => {
  const omb = await startMockOmb([{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }]);
  const sent: SentImItem[] = [];
  const transport = makeIm(sent);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-question-req-'));
  const bridge = new OpenMausBotBridge({
    client: new OpenMausBotClient({ baseUrl: omb.baseUrl }),
    transport,
    dataDir: tmpDir,
    turnStallMs: 0,
  });

  try {
    await bridge.start();

    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      if (String(reqMsg.text).startsWith('/setup')) {
        const qCard: OmbMessage = {
          id: nextId(),
          role: 'bot',
          kind: 'options',
          threadId,
          requestMessageId: reqMsg.id,
          card: {
            title: 'Your bot has a question',
            subtitle: 'What should I mainly do for you? (+1 more question)',
            options: [],
            requestId: 'req_q_multi',
            requestType: 'question',
            questionRequest: {
              version: 1,
              questions: [
                {
                  question: 'What should I mainly do for you?',
                  header: 'The job',
                  multiSelect: true,
                  options: [
                    { label: 'Coding partner', description: 'Read code and run tests' },
                    { label: 'Research and writing', description: 'Summarize docs' },
                  ],
                },
                {
                  question: 'When should I work?',
                  header: 'When',
                  options: [
                    { label: 'Only when you ask', description: 'On demand in chat' },
                    { label: 'On a schedule', description: 'Daily or weekly' },
                  ],
                },
              ],
            },
          },
        };
        messages.push(qCard);
        jobs.set(threadId, { state: 'needs-input', version: `v_${reqMsg.id}`, needsInput: [{ requestId: 'req_q_multi' }] });
        broadcast({ kind: 'message', threadId, message: qCard });
        return;
      }
      const reviewCard: OmbMessage = {
        id: nextId(),
        role: 'bot',
        kind: 'options',
        threadId,
        requestMessageId: reqMsg.id,
        card: {
          title: 'Set up co-bot?',
          subtitle: 'Title: Coding partner',
          options: [],
          requestId: 'req_profile_1',
          profileRequest: { version: 1, targetBotId: 'b1' },
        },
      };
      messages.push(reviewCard);
      jobs.set(threadId, { state: 'needs-input', version: `v_${reqMsg.id}`, needsInput: [{ requestId: 'req_profile_1' }] });
      broadcast({ kind: 'message', threadId, message: reviewCard });
    });

    await transport.emitUser('@bot /setup');
    await until(() => sent.some((m) => m.text.includes('1/2 · The job · 可多选')));
    const q1Msg = sent.at(-1)!;
    assert.equal(q1Msg.actions?.length ?? 0, 0, '提问卡不生成真卡片按钮');
    assert.ok(q1Msg.text.includes('> What should I mainly do for you?'));
    assert.ok(q1Msg.text.includes('1. **Coding partner**'));
    assert.ok(q1Msg.text.includes('2. **Research and writing**'));
    assert.ok(q1Msg.text.includes('`0` 取消'));

    // 第一题支持多选 1,2，先进入第 2/2 题而不立即提交 respond
    await transport.emitUser('1,2');
    await until(() => sent.some((m) => m.text.includes('2/2 · When')));
    assert.equal(omb.responds.length, 0);
    const q2Msg = sent.at(-1)!;
    assert.equal(q2Msg.actions?.length ?? 0, 0, '第 2 题不生成真卡片按钮');
    assert.ok(q2Msg.text.includes('1. **Only when you ask**'));

    // 回答第 2/2 题后合并全部问答提交给 OpenMausBot
    await transport.emitUser('2');
    await until(() => omb.responds.length === 1 && sent.some((m) => m.text.includes('已采用方案')));
    assert.equal(omb.responds[0].behavior, 'answer');
    const submitted = String(omb.responds[0].message);
    assert.ok(submitted.includes('Coding partner, Research and writing'));
    assert.ok(submitted.includes('On a schedule'));

    // profileRequest 渲染为 Markdown 伪审批卡（无真卡片按钮，且 2 / always 不触发 always），回复 1 提交 allow
    await transport.emitUser('@bot 保存角色配置');
    await until(() => sent.some((m) => m.text.includes('⏸️ **需要确认 · Set up co-bot?**')));
    const revMsg = sent.at(-1)!;
    assert.equal(revMsg.actions?.length ?? 0, 0);
    assert.ok(revMsg.text.includes('👉 回复 **`1` 允许** · **`0` 拒绝**'));
    await transport.emitUser('2');
    await transport.emitUser('always');
    assert.equal(omb.responds.length, 1, '评审提案卡不得响应数字 2 或 always');
    await transport.emitUser('1');
    await until(() => omb.responds.length === 2);
    assert.equal(omb.responds[1].behavior, 'allow');
    assert.match(sent.at(-1)!.text, /^🤖 \[bot\] ✅ /);
  } finally {
    await bridge.stop();
    await omb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('E2E: Markdown pseudo-cards support 1/2/0 shortcuts and multi-card disambiguation via quote reply', async () => {
  const omb = await startMockOmb([
    { id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true },
    { id: 'b2', name: 'Dev', threadId: 't2', chiefOfStaff: false },
  ]);
  const sent: SentImItem[] = [];
  const transport = makeIm(sent);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-pseudo-card-'));
  const bridge = new OpenMausBotBridge({
    client: new OpenMausBotClient({ baseUrl: omb.baseUrl }),
    transport,
    dataDir: tmpDir,
    turnStallMs: 0,
  });

  try {
    await bridge.start();

    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      if (String(reqMsg.text).includes('提问取消')) {
        const qCard: OmbMessage = {
          id: nextId(),
          role: 'bot',
          kind: 'options',
          threadId,
          requestMessageId: reqMsg.id,
          card: {
            title: 'Your bot has a question',
            requestId: `req_q_${threadId}`,
            requestType: 'question',
            questionRequest: {
              questions: [{ question: '选一个环境', options: [{ label: 'staging' }, { label: 'prod' }] }],
            },
          },
        };
        messages.push(qCard);
        jobs.set(threadId, { state: 'needs-input', version: `v_${reqMsg.id}`, needsInput: [{ requestId: `req_q_${threadId}` }] });
        broadcast({ kind: 'message', threadId, message: qCard });
        return;
      }
      const permCard: OmbMessage = {
        id: nextId(),
        role: 'bot',
        kind: 'card',
        threadId,
        requestMessageId: reqMsg.id,
        card: {
          requestId: `req_perm_${nextId()}`,
          title: '运行测试命令',
          subtitle: '执行项目测试',
          command: 'npm test',
        },
      };
      messages.push(permCard);
      jobs.set(threadId, { state: 'needs-input', version: `v_${reqMsg.id}`, needsInput: [{ requestId: permCard.card!.requestId }] });
      broadcast({ kind: 'message', threadId, message: permCard });
    });

    // 1. 权限伪卡片带 ```sh 代码块与 1/2/0 提示，且无真卡片按钮；回复 2 -> always: true
    await transport.emitUser('@bot 执行单测');
    await until(() => sent.some((m) => m.text.includes('⏸️ **需要确认 · 运行测试命令**')));
    const permMsg = sent.at(-1)!;
    assert.equal(permMsg.actions?.length ?? 0, 0);
    assert.ok(permMsg.text.includes('```sh\nnpm test\n```'));
    assert.ok(permMsg.text.includes('👉 回复 **`1` 允许** · **`2` 总是允许** · **`0` 拒绝**'));
    await transport.emitUser('2');
    await until(() => omb.responds.length === 1);
    assert.equal(omb.responds[0].behavior, 'allow');
    assert.equal(omb.responds[0].always, true);

    // 2. 提问伪卡片回复 0 -> deny
    await transport.emitUser('@bot 提问取消');
    await until(() => sent.some((m) => m.text.includes('1. **staging**')));
    await transport.emitUser('0');
    await until(() => omb.responds.length === 2);
    assert.equal(omb.responds[1].behavior, 'deny');

    // 3. 多卡并存防混淆：co-bot 与 Dev 同时待确认 -> 裸发 1 返回提示 -> 引用第二张卡回 1 只批第二张
    await transport.emitUser('@bot 执行构建A');
    await until(() => sent.filter((m) => m.text.includes('⏸️ **需要确认 · 运行测试命令**')).length === 2);
    await transport.emitUser('@Dev 执行构建B');
    await until(() => sent.filter((m) => m.text.includes('⏸️ **需要确认 · 运行测试命令**')).length === 3);
    const devCardMsg = sent.at(-1)!;
    assert.ok(devCardMsg.text.includes('当前有多条待确认，请**引用本条消息**回复'));

    await transport.emitUser('1');
    await until(() => sent.some((m) => m.text.includes('当前有 **2** 条待确认请求')));
    const beforeMulti = omb.sentToOmb.length;
    await transport.emitUser('3');
    await until(() => sent.filter((m) => m.text.includes('当前有 **2** 条待确认请求')).length === 2);
    await transport.emitUser('1,2');
    await until(() => sent.filter((m) => m.text.includes('当前有 **2** 条待确认请求')).length === 3);
    assert.equal(omb.sentToOmb.length, beforeMulti, '多卡并存时 3 / 1,2 不得穿透为普通对话');
    assert.equal(omb.responds.length, 2, '多卡并存时裸回复 1 / 3 / 1,2 不得误批任意卡片');

    await transport.emitUser('1', { replyTo: devCardMsg.id });
    await until(() => omb.responds.length === 3);
    assert.equal(omb.responds[2].threadId, 't2');
    assert.equal(omb.responds[2].behavior, 'allow');
  } finally {
    await bridge.stop();
    await omb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('E2E: advanceQuestionCard retains pending card on send failure and keeps external originBanner on step 2', async () => {
  const omb = await startMockOmb([{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }]);
  let handler: ((ev: InboundEvent) => unknown) | undefined;
  let failNextSend = false;
  const sent: SentImItem[] = [];
  const transport: BridgeTransport = {
    selfChatId: 'self',
    async start(fn) { handler = fn; },
    async stop() {},
    async send(_chatId, text, opts) {
      if (failNextSend) {
        failNextSend = false;
        return undefined;
      }
      const id = `im_${sent.length + 1}`;
      sent.push({ id, text, replyTo: opts?.replyTo ?? null });
      return id;
    },
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-adv-q-'));
  const bridge = new OpenMausBotBridge({
    client: new OpenMausBotClient({ baseUrl: omb.baseUrl }),
    transport,
    dataDir: tmpDir,
    sendRetries: 0,
    turnStallMs: 0,
  });

  try {
    await bridge.start();
    const emit = handler!;
    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      const qCard: OmbMessage = {
        id: nextId(),
        role: 'bot',
        kind: 'options',
        threadId,
        requestMessageId: reqMsg.id,
        card: {
          title: 'Your bot has a question',
          requestId: 'req_ext_q',
          requestType: 'question',
          questionRequest: {
            questions: [
              { question: '选部署方式', header: '方式', options: [{ label: 'Docker' }, { label: 'Native' }] },
              { question: '选环境', header: '环境', options: [{ label: 'Staging' }, { label: 'Prod' }] },
            ],
          },
        },
      };
      messages.push(qCard);
      jobs.set(threadId, { state: 'needs-input', version: `v_${reqMsg.id}`, needsInput: [{ requestId: 'req_ext_q' }] });
      broadcast({ kind: 'message', threadId, message: qCard });
    });

    await emit({
      id: 'ext_q_trigger',
      ts: Date.now(),
      chat: { id: 'grp_ext_q', type: 'group', name: '外部测试群' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '@bot 帮忙部署',
    });
    await until(() => sent.some((m) => m.text.includes('1/2 · 方式')));
    const cardBefore = [...bridge.pendingCards.values()][0];
    assert.ok(cardBefore);

    // 模拟发送第 2 题失败时保留第 1 题 pendingCard 不丢失
    failNextSend = true;
    await emit({
      id: 'self_retry_fail',
      ts: Date.now(),
      chat: { id: 'self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '1',
    });
    await until(() => sent.some((m) => m.text.includes('下一题发送失败')));
    assert.equal(bridge.pendingCards.has(cardBefore.imMsgId), true, '发送第 2 题失败后不得删除原待处理卡片');

    // 重试成功，第 2 题保留外部群来源横幅
    await emit({
      id: 'self_retry_ok',
      ts: Date.now(),
      chat: { id: 'self', type: 'self' },
      sender: { id: 'me', name: '我', isSelf: true },
      text: '1',
    });
    await until(() => sent.some((m) => m.text.includes('2/2 · 环境')));
    const step2Msg = sent.at(-1)!;
    assert.ok(step2Msg.text.includes('来自「外部测试群」的审批 / 确认'));
    assert.equal(bridge.pendingCards.has(cardBefore.imMsgId), false);
  } finally {
    await bridge.stop();
    await omb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
