import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_ROOT } from '../src/config.js';
import { OpenMausBotClient } from '../src/openmausbot/client.js';
import { OpenMausBotBridge } from '../src/openmausbot/bridge.js';
import { WebSimTransport } from '../src/im/sim.js';
import { WebServer } from '../src/web/server.js';
import { getFreePort, until, startMockOmb, makeIm } from './helpers/mock-omb.js';

test('UX Batch 1: immediate intermediate text without duplication, Chinese progress dedupe, soft 2-bubble split, hideChiefPrefix=false', async () => {
  const omb = await startMockOmb([
    { id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true },
    { id: 'b2', name: 'Dev', threadId: 't2', chiefOfStaff: false },
  ]);
  const sent = [];
  const filesSent = [];
  const transport = makeIm(sent, filesSent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-ux-b1-'));
  const bridge = new OpenMausBotBridge({
    client: new OpenMausBotClient({ baseUrl: omb.baseUrl }),
    transport,
    dataDir,
    resultChars: 90,
    softSplitChars: 170,
    hideChiefPrefix: false,
    progressDelayMs: 50,
    progressIntervalMs: 60,
    maxProgressUpdates: 2,
  });

  try {
    await bridge.start();

    // 1. 中间口语即时上屏 + 非通用英语进度被本地化为中文且去重 + complete() 不重复下发中间消息
    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      const midId = nextId();
      const midMsg = { id: midId, role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: '我先查一下日志再给你结论。', turnTerminal: false };
      messages.push(midMsg);
      broadcast({ kind: 'message', threadId, message: midMsg });

      setTimeout(() => {
        const act1 = { id: nextId(), role: 'bot', kind: 'activity', threadId, requestMessageId: reqMsg.id, tool: { name: 'bash', spoken: 'running a command' } };
        const act2 = { id: nextId(), role: 'bot', kind: 'activity', threadId, requestMessageId: reqMsg.id, tool: { name: 'bash', spoken: 'running a command' } };
        messages.push(act1, act2);
        broadcast({ kind: 'message', threadId, message: act1 });
        broadcast({ kind: 'message', threadId, message: act2 });
      }, 65);

      setTimeout(() => {
        const finMsg = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: '最终排查结果：一切正常。', turnTerminal: true };
        messages.push(finMsg);
        jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
        broadcast({ kind: 'message', threadId, message: finMsg });
      }, 150);
    });

    await transport.emitUser('@bot 看下状态');
    await until(() => sent.some((m) => m.text.includes('最终排查结果：一切正常')));

    const midCount = sent.filter((m) => m.text.includes('我先查一下日志再给你结论')).length;
    assert.equal(midCount, 1, '中间口语应即时发送且在 complete() 时不得重复');
    const progMsgs = sent.filter((m) => m.text.includes('正在执行命令'));
    assert.equal(progMsgs.length, 1, '相同工具活动进度不得重复刷屏');
    assert.equal(progMsgs[0].text.includes('running a command'), false, '通用英文 spoken 应被静默抑制');
    assert.match(sent.at(-1).text, /^\*\*\[co-bot\]\*\*/, 'hideChiefPrefix=false 时应保留主 Bot 前缀');

    // 2. 中等长回复（90 < len <= 170）走软拆两段，不发 .md；超过 softSplitChars 走截断+.md
    const beforeSoft = sent.length;
    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      setTimeout(() => {
        const text = reqMsg.text.includes('超长')
          ? `${'超长段落A。'.repeat(18)}\n\n${'超长段落B。'.repeat(18)}`
          : `${'第一段内容。'.repeat(9)}\n\n${'第二段内容。'.repeat(9)}`;
        const fin = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text, turnTerminal: true };
        messages.push(fin);
        jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
        broadcast({ kind: 'message', threadId, message: fin });
      }, 15);
    });

    await transport.emitUser('@bot 发中等长回答');
    await until(() => sent.length === beforeSoft + 2);
    assert.equal(filesSent.length, 0, '软拆分区间内不应生成 .md 附件');

    await transport.emitUser('@bot 发超长回答');
    await until(() => filesSent.length === 1);
    assert.match(sent.at(-1).text, /完整回复见下一条附件/);
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('UX Batch 1: options/question cards (1/2/3 selection) and permission always/rememberCommand with 403 fallback', async () => {
  const omb = await startMockOmb([{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }], {
    refuseRememberCommand: true,
  });
  const sent = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-ux-cards-'));
  const bridge = new OpenMausBotBridge({ client: new OpenMausBotClient({ baseUrl: omb.baseUrl }), transport, dataDir });

  try {
    await bridge.start();

    // 1. 选项/提问卡：渲染序号 1/2，回复数字 2 提交 chosen label
    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      setTimeout(() => {
        const qCard = {
          id: nextId(), role: 'bot', kind: 'options', threadId, requestMessageId: reqMsg.id,
          card: {
            requestId: 'req_q1',
            requestType: 'question',
            title: 'Your bot has a question',
            questions: [{
              question: '要使用哪种发布策略？',
              options: [
                { label: '灰度发布', description: '先放 10% 流量' },
                { label: '全量发布', description: '直接全量上线' },
              ],
            }],
          },
        };
        messages.push(qCard);
        jobs.set(threadId, { state: 'needs-input', version: 'v_q1', needsInput: [{ requestId: 'req_q1' }] });
        broadcast({ kind: 'message', threadId, message: qCard });
      }, 15);
    });

    await transport.emitUser('@bot 准备发布');
    await until(() => sent.some((m) => m.text.includes('1. **灰度发布**') && m.text.includes('2. **全量发布**')));
    await transport.emitUser('2');
    await until(() => sent.some((m) => m.text.includes('已采用方案：全量发布')));
    assert.equal(omb.responds[0].behavior, 'answer');
    assert.equal(omb.responds[0].message, '全量发布');

    // 2. 权限卡：回复 always 传递 always: true & rememberCommand: true（遇到 403 自动降级为仅 always: true）
    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      setTimeout(() => {
        const pCard = {
          id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id,
          card: { requestId: 'req_p1', title: '运行命令：npm test', command: 'npm test', canRememberCommand: true },
        };
        messages.push(pCard);
        jobs.set(threadId, { state: 'needs-input', version: 'v_p1', needsInput: [{ requestId: 'req_p1' }] });
        broadcast({ kind: 'message', threadId, message: pCard });
      }, 15);
    });

    await transport.emitUser('@bot 跑测试');
    await until(() => sent.some((m) => m.text.includes('always')));
    await transport.emitUser('always');
    await until(() => sent.some((m) => m.text.includes('已执行命令，结果正常')));
    assert.equal(omb.responds[1].behavior, 'allow');
    assert.equal(omb.responds[1].always, true);
    assert.equal(omb.responds[1].rememberCommand, undefined, '403 后应降级去掉 rememberCommand 重试成功');
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('UX Batch 1: followUpWindowMs stickiness, note-prefix protection, proactive isolation, and @bot bye', async () => {
  let nowMs = 1_000_000;
  const omb = await startMockOmb([{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }]);
  const sent = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-ux-sticky-'));
  const bridge = new OpenMausBotBridge({
    client: new OpenMausBotClient({ baseUrl: omb.baseUrl }),
    transport,
    dataDir,
    followUpWindowMs: 60_000,
    now: () => nowMs,
  });

  omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
    setTimeout(() => {
      const reply = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: `收到：${reqMsg.text}`, turnTerminal: true };
      messages.push(reply);
      jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
      broadcast({ kind: 'message', threadId, message: reply });
    }, 10);
  });

  try {
    await bridge.start();
    await until(() => bridge.status().connected);

    // 1. 主动推送不得误激活连续对话窗口
    omb.broadcast({
      kind: 'message',
      threadId: 't1',
      message: { id: 'pro_only', role: 'bot', kind: 'text', threadId: 't1', text: '定时汇报：一切正常', turnTerminal: true },
    });
    await until(() => sent.length === 1);
    assert.equal(bridge.status().stickyActive, false);
    await transport.emitUser('自聊随手记一笔');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sent.length, 1);

    // 2. 用户主动 @bot 后进入 60s 连续对话窗口，后续免 @bot 直接续聊；但 # / 备忘 开头仍保护不触发
    await transport.emitUser('@bot 查下磁盘');
    await until(() => sent.length === 2);
    assert.equal(bridge.status().stickyActive, true);

    nowMs += 10_000;
    await transport.emitUser('# 备忘：买牛奶');
    await transport.emitUser('记一下：明天九点开会');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sent.length, 2, '以 # 或 记一下 开头的笔记不应被连续对话拦截');

    await transport.emitUser('顺便看看内存呢');
    await until(() => sent.length === 3);
    assert.match(sent[2].text, /收到：顺便看看内存呢/);

    // 3. @bot bye 立即结束粘性；超时后同样自动过期
    await transport.emitUser('@bot bye');
    await until(() => sent.length === 4);
    assert.equal(bridge.status().stickyActive, false);
    await transport.emitUser('这句不该发给bot');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sent.length, 4);
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('UX Batch 2: busy queue awareness, @bot steer/cancel, queued SSE drain, @bot tasks switch, @bot style grok, and WebSim actions', async () => {
  const omb = await startMockOmb([
    {
      id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true,
      tasks: [
        { threadId: 't1', title: '当前主会话', updatedAt: 200 },
        { threadId: 't_old', title: '昨日排查记录', updatedAt: 100 },
      ],
    },
  ], { queueWhenBusy: true });
  const sent = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-ux-b2-'));
  const bridge = new OpenMausBotBridge({ client: new OpenMausBotClient({ baseUrl: omb.baseUrl }), transport, dataDir });

  try {
    await bridge.start();

    // 1. 忙时发送第二条收到 queued=true -> 提示排队 -> @bot cancel 取消 -> 再排一条并 @bot steer 插队 -> SSE user 落盘后跟踪完成
    omb.setScenario(() => {}); // 保持第一轮 running
    await transport.emitUser('@bot 长任务1');
    await until(() => omb.sentToOmb.length === 1);

    await transport.emitUser('@bot 顺便查一下这个');
    await until(() => sent.some((m) => m.text.includes('已排队')));
    assert.equal(bridge.status().queuedCount, 1);

    await transport.emitUser('@bot cancel');
    await until(() => sent.some((m) => m.text.includes('已取消排队消息')));
    assert.equal(omb.cancelled.length, 1);
    assert.equal(bridge.status().queuedCount, 0);

    await transport.emitUser('@bot 紧急插队任务');
    await until(() => bridge.status().queuedCount === 1);
    const queuedSendId = omb.sentToOmb.at(-1).sendId;
    await transport.emitUser('@bot steer');
    await until(() => sent.some((m) => m.text.includes('已插队注入当前任务')));
    assert.equal(omb.steered.length, 1);
    assert.equal(bridge.status().queuedCount, 0);

    // 模拟 OpenMausBot 将插队消息以 role:'user' 落盘并回复完成
    const drainedUser = { id: 'u_steered', role: 'user', kind: 'text', threadId: 't1', text: '紧急插队任务', sendId: queuedSendId };
    omb.messages.get('t1').push(drainedUser);
    omb.broadcast({ kind: 'message', threadId: 't1', message: drainedUser });
    await new Promise((r) => setTimeout(r, 25));
    const steeredReply = { id: 'm_steered', role: 'bot', kind: 'text', threadId: 't1', requestMessageId: 'u_steered', text: '插队任务已完成。', turnTerminal: true };
    omb.messages.get('t1').push(steeredReply);
    omb.broadcast({ kind: 'message', threadId: 't1', message: steeredReply });
    await until(() => sent.some((m) => m.text.includes('插队任务已完成')));

    // Stop active turn 1 before task switch
    await transport.emitUser('@bot stop');
    await until(() => sent.some((m) => m.text.includes('已请求停止')));

    // 2. @bot tasks 列出并回复数字 2 切换会话
    await transport.emitUser('@bot tasks');
    await until(() => sent.some((m) => m.text.includes('最近会话') && m.text.includes('昨日排查记录')));
    await transport.emitUser('2');
    await until(() => sent.some((m) => m.text.includes('昨日排查记录') && m.text.includes('已切换到')));
    assert.equal(omb.tasksSelected.at(-1)?.threadId, 't_old');
    assert.equal(bridge.status().focus?.threadId, 't_old');

    // 3. WebSimTransport 支持将 actions 透传到 SSE 流
    const webPort = await getFreePort();
    const web = new WebServer({ host: '127.0.0.1', port: webPort, publicDir: path.join(APP_ROOT, 'public') });
    const simDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-act-'));
    const sim = new WebSimTransport({ web, filesDir: simDir, historyFile: null });
    await web.start();
    await sim.start(async () => {});
    try {
      const sseRes = await fetch(`http://127.0.0.1:${webPort}/events`);
      const reader = sseRes.body.getReader();
      const dec = new TextDecoder();
      let sseBuf = dec.decode((await reader.read()).value); // 首帧 ': ok\n\n'
      await sim.send('self', '请确认', { actions: [{ label: '允许', text: 'ok', kind: 'primary' }] });
      while (!sseBuf.includes('"actions"')) {
        const next = await reader.read();
        if (next.done) break;
        sseBuf += dec.decode(next.value);
      }
      assert.match(sseBuf, /"actions":\[\{"label":"允许","text":"ok","kind":"primary"\}\]/);
      await reader.cancel();
    } finally {
      await sim.stop();
      await web.stop();
    }
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('P0 reliability: say() retry backoff, full state persistence (quietQueue/pendingCards/deliveredOmbIds), and sticky bare image batch', async () => {
  const quietNow = new Date(2026, 10, 19, 23, 30, 0).getTime();
  const omb = await startMockOmb([{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }]);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-p0-'));
  const client = new OpenMausBotClient({ baseUrl: omb.baseUrl });
  const downloadData = new Map([['img_a', Buffer.from('89504e470d0a1a0a', 'hex')], ['img_b', Buffer.from('89504e470d0a1a0b', 'hex')]]);

  // 1. say() 瞬时发送失败后按 sendRetries 退避重试并成功 + quietQueue / pendingCards / deliveredOmbIds 跨重启恢复
  let failOnce = true;
  const sent1 = [];
  const baseIm1 = makeIm(sent1, [], downloadData);
  const flakyIm = {
    ...baseIm1,
    async send(chatId, text, opts) {
      if (failOnce) { failOnce = false; throw new Error('temporary glitch'); }
      return baseIm1.send(chatId, text, opts);
    },
  };
  const b1 = new OpenMausBotBridge({
    client,
    transport: flakyIm,
    dataDir,
    quietHours: { enabled: true, start: '22:00', end: '08:30' },
    sendRetries: 2,
    sendRetryDelayMs: 10,
    now: () => quietNow,
  });

  omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
    setTimeout(() => {
      const card = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, card: { requestId: 'req_persist', title: '确认部署' } };
      messages.push(card);
      jobs.set(threadId, { state: 'needs-input', version: `v_${reqMsg.id}`, needsInput: [{ requestId: 'req_persist' }] });
      broadcast({ kind: 'message', threadId, message: card });
    }, 15);
  });

  try {
    await b1.start();
    await until(() => b1.status().connected);

    // 夜间主动推送写入 quietQueue
    omb.broadcast({ kind: 'message', threadId: 't1', message: { id: 'pro_keep_1', role: 'bot', kind: 'text', threadId: 't1', text: '夜间报警', turnTerminal: true } });
    await until(() => b1.status().quietPending === 1);

    // 触发审批卡（首次 send 抛错后重试成功）
    await flakyIm.emitUser('@bot 开始部署');
    await until(() => sent1.some((m) => m.text.includes('确认部署')));
    await b1.stop();

    // 重启 bridge：恢复 quietPending、pendingCards、deliveredOmbIds（不再重推 pro_keep_1），回复 ok 完成审批
    const sent2 = [];
    const im2 = makeIm(sent2, [], downloadData);
    const b2 = new OpenMausBotBridge({
      client,
      transport: im2,
      dataDir,
      imageBatchMs: 120,
      followUpWindowMs: 60_000,
    });
    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      setTimeout(() => {
        const reply = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: `收到图：${reqMsg.text}`, turnTerminal: true };
        messages.push(reply);
        jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
        broadcast({ kind: 'message', threadId, message: reply });
      }, 15);
    });

    try {
      await b2.start();
      await until(() => b2.status().connected);
      assert.equal(b2.status().quietPending, 1);
      assert.equal(b2.status().pendingCards, 1);

      // 相同主动消息 id 不得在重启后重复积压
      omb.broadcast({ kind: 'message', threadId: 't1', message: { id: 'pro_keep_1', role: 'bot', kind: 'text', threadId: 't1', text: '夜间报警', turnTerminal: true } });
      await new Promise((r) => setTimeout(r, 25));
      assert.equal(b2.status().quietPending, 1);

      await im2.emitUser('ok');
      await until(() => sent2.some((m) => m.text.includes('已执行命令，结果正常')));
      assert.equal(b2.status().stickyActive, true);

      // 连续对话期间裸发 2 张图片（不带文字）自动防抖合并为一次派发
      await im2.emitUser('', { attachments: [{ id: 'img_a', msgId: 'u_img1', name: 'a.png', mime: 'image/png' }] });
      await new Promise((r) => setTimeout(r, 20));
      await im2.emitUser('', { attachments: [{ id: 'img_b', msgId: 'u_img2', name: 'b.png', mime: 'image/png' }] });
      await until(() => sent2.some((m) => m.text.includes('收到图：')));
      const imgDispatch = omb.sentToOmb.at(-1);
      assert.match(imgDispatch.text, /<attached-image/);
      assert.equal((imgDispatch.text.match(/<attached-image/g) || []).length, 2, '两张裸图应防抖合并在同一次派发');
    } finally {
      await b2.stop();
    }
  } finally {
    await omb.close();
  }
});

test('P1 commands: @bot context & >80% warning, @bot compact, @bot memory', async () => {
  const omb = await startMockOmb(
    [
      {
        id: 'b1',
        name: 'MausBot',
        threadId: 't1',
        chiefOfStaff: true,
        tasks: [
          { threadId: 't1', title: '主研发任务', updatedAt: 200, usage: { turns: 5, context: { tokens: 85_000, window: 100_000 } } },
        ],
      },
    ],
    {
      initialMemory: '- 回复简短优先\n',
      memoryTopics: [{ name: 'projects.md', path: 'memory/projects.md' }],
    },
  );

  const sent = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-p1-'));
  const bridge = new OpenMausBotBridge({ client: new OpenMausBotClient({ baseUrl: omb.baseUrl }), transport, dataDir });

  omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
    setTimeout(() => {
      const reply = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: `完成：${reqMsg.text}`, turnTerminal: true };
      messages.push(reply);
      jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
      broadcast({ kind: 'message', threadId, message: reply });
    }, 10);
  });

  try {
    await bridge.start();

    // 1. @bot context 查看上下文仪表盘 + 普通对话后自动触发一次 >80% 提醒
    await transport.emitUser('@bot context');
    await until(() => sent.some((m) => m.text.includes('85%') && m.text.includes('85K / 100K')));

    await transport.emitUser('@bot 看下日志');
    await until(() => sent.some((m) => m.text.includes('完成：看下日志')) && sent.some((m) => m.text.includes('上下文已达 85%')));
    const warnCountBefore = sent.filter((m) => m.text.includes('上下文已达 85%')).length;
    assert.equal(warnCountBefore, 1);

    // 2. @bot compact 清除警告标记
    await transport.emitUser('@bot compact');
    await until(() => sent.some((m) => m.text.includes('压缩当前会话上下文')));

    // 3. @bot memory 查看 + @bot 记住 写入长期记忆
    await transport.emitUser('@bot memory');
    await until(() => sent.some((m) => m.text.includes('回复简短优先') && m.text.includes('projects.md')));
    await transport.emitUser('@bot 记住 用中文总结代码变更');
    await until(() => sent.some((m) => m.text.includes('已记入 **co-bot** 的长期记忆')));
    assert.match(omb.memoryState.get('b1').text, /用中文总结代码变更/);
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('P2 /sim persistence: WebSimTransport saves and restores history & files across restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-persist-'));
  const filesDir = path.join(root, 'sim-files');
  const historyFile = path.join(root, 'sim-history.json');

  // 1. 第一次启动写入消息与图片，随后停止
  const p1 = await getFreePort();
  const w1 = new WebServer({ host: '127.0.0.1', port: p1, publicDir: path.join(APP_ROOT, 'public') });
  const s1 = new WebSimTransport({ web: w1, filesDir, historyFile });
  await w1.start();
  await s1.start(async () => {});
  const imgSrc = path.join(root, 'src.png');
  fs.writeFileSync(imgSrc, Buffer.from('89504e470d0a1a0a', 'hex'));
  await s1.send('self', '历史文本消息');
  await s1.sendFile('self', { path: imgSrc, name: 'shot.png' }, {});
  await s1.stop();
  await w1.stop();
  assert.equal(fs.existsSync(historyFile), true);

  // 2. 第二次重启同一目录：SSE 回放两条历史消息且 /files/:id 仍可读取图片字节
  const p2 = await getFreePort();
  const w2 = new WebServer({ host: '127.0.0.1', port: p2, publicDir: path.join(APP_ROOT, 'public') });
  const s2 = new WebSimTransport({ web: w2, filesDir, historyFile });
  await w2.start();
  await s2.start(async () => {});
  try {
    const sseRes = await fetch(`http://127.0.0.1:${p2}/events`);
    const reader = sseRes.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (!buf.includes('shot.png')) {
      const next = await reader.read();
      if (next.done) break;
      buf += dec.decode(next.value);
    }
    assert.match(buf, /历史文本消息/);
    assert.match(buf, /shot\.png/);
    const urlM = /"url":"(\/files\/[^"]+)"/.exec(buf);
    assert.ok(urlM);
    const imgRes = await fetch(`http://127.0.0.1:${p2}${urlM[1]}`);
    assert.equal(imgRes.status, 200);
    assert.equal(Buffer.from(await imgRes.arrayBuffer()).toString('hex'), '89504e470d0a1a0a');
    await reader.cancel();
  } finally {
    await s2.stop();
    await w2.stop();
  }
});
