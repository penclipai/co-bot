import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_ROOT } from '../src/config.ts';
import { OpenMausBotClient } from '../src/openmausbot/client.ts';
import { OpenMausBotBridge } from '../src/openmausbot/bridge.ts';
import { WebSimTransport } from '../src/im/sim.ts';
import { WebServer } from '../src/web/server.ts';
import type { ChannelSendOptions } from '../src/types.ts';
import { getFreePort, until, startMockOmb, makeIm, type SentImItem, type SentImFileItem } from './helpers/mock-omb.ts';

test('UX Batch 1: immediate intermediate text without duplication, Chinese progress dedupe, soft 2-bubble split, hideChiefPrefix=false', async () => {
  const omb = await startMockOmb([
    { id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true },
    { id: 'b2', name: 'Dev', threadId: 't2', chiefOfStaff: false },
  ]);
  const sent: SentImItem[] = [];
  const filesSent: SentImFileItem[] = [];
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
    assert.match(sent.at(-1)!.text, /^🤖 \*\*\[co-bot\]\*\*/, 'hideChiefPrefix=false 时应保留样式 A Bot 徽章');

    const beforeSoft = sent.length;
    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      setTimeout(() => {
        const text = String(reqMsg.text || '').includes('超长')
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
    assert.match(sent[beforeSoft].text, /^🤖 \*\*\[co-bot\]\*\* \(1\/2\)/, '软拆分首条应携带 (1/2) Bot 徽章');
    assert.match(sent[beforeSoft + 1].text, /^🤖 \*\*\[co-bot\]\*\* \(2\/2\)/, '软拆分次条应携带 (2/2) Bot 徽章');
    assert.equal(filesSent.length, 0, '软拆分区间内不应生成 .md 附件');

    await transport.emitUser('@bot 发超长回答');
    await until(() => filesSent.length === 1);
    assert.match(sent.at(-1)!.text, /完整回复见下一条附件/);
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('UX Batch 1: options/question cards (1/2/3 selection) and permission always/rememberCommand with 403 fallback', async () => {
  const omb = await startMockOmb([{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }], {
    refuseRememberCommand: true,
  });
  const sent: SentImItem[] = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-ux-cards-'));
  const bridge = new OpenMausBotBridge({ client: new OpenMausBotClient({ baseUrl: omb.baseUrl }), transport, dataDir });

  try {
    await bridge.start();

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
  const sent: SentImItem[] = [];
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

test('UX Batch 2: busy queue awareness, @bot steer/cancel, queued SSE drain, @bot task switch, and WebSim actions', async () => {
  const omb = await startMockOmb([
    {
      id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true,
      tasks: [
        { threadId: 't1', title: '当前主会话', updatedAt: 200 },
        { threadId: 't_old', title: '昨日排查记录', updatedAt: 100 },
      ],
    },
  ], { queueWhenBusy: true });
  const sent: SentImItem[] = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-ux-b2-'));
  const bridge = new OpenMausBotBridge({ client: new OpenMausBotClient({ baseUrl: omb.baseUrl }), transport, dataDir });

  try {
    await bridge.start();

    omb.setScenario(() => {});
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
    const queuedSendId = String(omb.sentToOmb.at(-1)!.sendId);
    await transport.emitUser('@bot steer');
    await until(() => sent.some((m) => m.text.includes('已插队注入当前任务')));
    assert.equal(omb.steered.length, 1);
    assert.equal(bridge.status().queuedCount, 0);

    const drainedUser = { id: 'u_steered', role: 'user', kind: 'text', threadId: 't1', text: '紧急插队任务', sendId: queuedSendId };
    omb.messages.get('t1')!.push(drainedUser);
    omb.broadcast({ kind: 'message', threadId: 't1', message: drainedUser });
    await new Promise((r) => setTimeout(r, 25));
    const steeredReply = { id: 'm_steered', role: 'bot', kind: 'text', threadId: 't1', requestMessageId: 'u_steered', text: '插队任务已完成。', turnTerminal: true };
    omb.messages.get('t1')!.push(steeredReply);
    omb.broadcast({ kind: 'message', threadId: 't1', message: steeredReply });
    await until(() => sent.some((m) => m.text.includes('插队任务已完成')));

    await transport.emitUser('@bot stop');
    await until(() => sent.some((m) => m.text.includes('已请求停止')));

    await transport.emitUser('@bot task');
    await until(() => sent.some((m) => m.text.includes('最近会话') && m.text.includes('昨日排查记录')));
    await transport.emitUser('2');
    await until(() => sent.some((m) => m.text.includes('昨日排查记录') && m.text.includes('已切换到')));
    assert.equal(omb.tasksSelected.at(-1)?.threadId, 't_old');
    assert.equal(bridge.status().focus?.threadId, 't_old');

    const webPort = await getFreePort();
    const web = new WebServer({ host: '127.0.0.1', port: webPort, publicDir: path.join(APP_ROOT, 'public') });
    const simDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-act-'));
    const sim = new WebSimTransport({ web, filesDir: simDir, historyFile: null });
    await web.start();
    await sim.start(async () => {});
    try {
      const sseRes = await fetch(`http://127.0.0.1:${webPort}/events`);
      const reader = sseRes.body!.getReader();
      const dec = new TextDecoder();
      let sseBuf = dec.decode((await reader.read()).value);
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
  const downloadData = new Map<string, string | Buffer>([['img_a', Buffer.from('89504e470d0a1a0a', 'hex')], ['img_b', Buffer.from('89504e470d0a1a0b', 'hex')]]);

  let failOnce = true;
  const sent1: SentImItem[] = [];
  const baseIm1 = makeIm(sent1, [], downloadData);
  const flakyIm = {
    ...baseIm1,
    async send(chatId: string, text: string, opts?: ChannelSendOptions) {
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

    omb.broadcast({ kind: 'message', threadId: 't1', message: { id: 'pro_keep_1', role: 'bot', kind: 'text', threadId: 't1', text: '夜间报警', turnTerminal: true } });
    await until(() => b1.status().quietPending === 1);

    await flakyIm.emitUser('@bot 开始部署');
    await until(() => sent1.some((m) => m.text.includes('确认部署')));
    await b1.stop();

    const sent2: SentImItem[] = [];
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

      omb.broadcast({ kind: 'message', threadId: 't1', message: { id: 'pro_keep_1', role: 'bot', kind: 'text', threadId: 't1', text: '夜间报警', turnTerminal: true } });
      await new Promise((r) => setTimeout(r, 25));
      assert.equal(b2.status().quietPending, 1);

      await im2.emitUser('ok');
      await until(() => sent2.some((m) => m.text.includes('已执行命令，结果正常')));
      assert.equal(b2.status().stickyActive, true);

      await im2.emitUser('', { attachments: [{ id: 'img_a', msgId: 'u_img1', name: 'a.png', mime: 'image/png' }] });
      await new Promise((r) => setTimeout(r, 20));
      await im2.emitUser('', { attachments: [{ id: 'img_b', msgId: 'u_img2', name: 'b.png', mime: 'image/png' }] });
      await until(() => sent2.some((m) => m.text.includes('收到图：')));
      const imgDispatch = omb.sentToOmb.at(-1)!;
      assert.match(String(imgDispatch.text), /<attached-image/);
      assert.equal((String(imgDispatch.text).match(/<attached-image/g) || []).length, 2, '两张裸图应防抖合并在同一次派发');
    } finally {
      await b2.stop();
    }
  } finally {
    await omb.close();
  }
});

test('P1 commands: @bot status context & >80% warning, @bot compact, help scoping, and retired command passthrough', async () => {
  const omb = await startMockOmb([
    {
      id: 'b1',
      name: 'MausBot',
      threadId: 't1',
      chiefOfStaff: true,
      tasks: [
        { threadId: 't1', title: '主研发任务', updatedAt: 200, usage: { turns: 5, context: { tokens: 85_000, window: 100_000 } } },
      ],
    },
  ]);

  const sent: SentImItem[] = [];
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

    await transport.emitUser('@bot status');
    await until(() => sent.some((m) => m.text.includes('85%') && m.text.includes('85K / 100K')));

    await transport.emitUser('@bot 看下日志');
    await until(() => sent.some((m) => m.text.includes('完成：看下日志')) && sent.some((m) => m.text.includes('上下文已达 85%')));
    const warnCountBefore = sent.filter((m) => m.text.includes('上下文已达 85%')).length;
    assert.equal(warnCountBefore, 1);

    await transport.emitUser('@bot compact');
    await until(() => sent.some((m) => m.text.includes('压缩当前会话上下文')));

    await transport.emitUser('@bot help');
    await until(() => sent.some((m) => m.text.includes('常用指南')));

    for (const cmd of ['@bot help me debug', '@bot memory', '@bot 记住 用中文总结代码变更', '@bot approval auto', '@bot digest', '@bot bots', '@bot tasks', '@bot context']) {
      const stripped = cmd.replace(/^@bot\s+/, '');
      await transport.emitUser(cmd);
      await until(() => sent.some((m) => m.text.includes(`完成：${stripped}`)));
    }
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('P2 /sim persistence: WebSimTransport saves and restores history & files across restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-persist-'));
  const filesDir = path.join(root, 'sim-files');
  const historyFile = path.join(root, 'sim-history.json');

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

  const p2 = await getFreePort();
  const w2 = new WebServer({ host: '127.0.0.1', port: p2, publicDir: path.join(APP_ROOT, 'public') });
  const s2 = new WebSimTransport({ web: w2, filesDir, historyFile });
  await w2.start();
  await s2.start(async () => {});
  try {
    const sseRes = await fetch(`http://127.0.0.1:${p2}/events`);
    const reader = sseRes.body!.getReader();
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

test('P2 status UX: normal state omits noisy ops fields, duplicate counts, busy/ask defaults, and <50% compact hint', async () => {
  const omb = await startMockOmb([
    {
      id: 'b1',
      name: 'MausBot',
      threadId: 't1',
      chiefOfStaff: true,
      approvalMode: 'ask',
      tasks: [
        { threadId: 't1', title: '日常任务', updatedAt: 200, usage: { turns: 3, context: { tokens: 20_000, window: 100_000 } } },
      ],
    },
    {
      id: 'b2',
      name: 'Dev',
      threadId: 't2',
      busy: true,
      activity: 'busy',
      approvalMode: 'auto',
    },
  ]);

  const sent: SentImItem[] = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-status-ux-'));
  const bridge = new OpenMausBotBridge({ client: new OpenMausBotClient({ baseUrl: omb.baseUrl }), transport, dataDir });

  try {
    await bridge.start();
    await transport.emitUser('@bot status');
    await until(() => sent.some((m) => m.text.includes('协作团队')));
    const statusText = sent.findLast((m) => m.text.includes('协作团队'))!.text;

    assert.match(statusText, /^🟢 \*\*co-bot 在线\*\*/);
    assert.match(statusText, /📊 \*\*co-bot 当前会话\*\* 上下文：20%（20K \/ 100K · 3 轮） `[█░]+`/);
    assert.match(statusText, /\*\*Dev\*\* · 运行中 · `deepseek\/deepseek-flash` · 审批:auto/);
    for (const noise of ['隔离模式', '本地免配对', 'Doctor', '引擎 v', '协作 Bot：', '活跃轮次：0', '审批:ask', '运行中 · busy', '@bot compact']) {
      assert.equal(statusText.includes(noise), false, `精简后的 status 不应包含冗余文案「${noise}」`);
    }
  } finally {
    await bridge.stop();
    await omb.close();
  }
});
