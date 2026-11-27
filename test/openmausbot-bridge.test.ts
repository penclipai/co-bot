import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenMausBotClient } from '../src/openmausbot/client.ts';
import { OpenMausBotBridge } from '../src/openmausbot/bridge.ts';
import { until, startMockOmb, makeIm, type SentImItem, type SentImFileItem } from './helpers/mock-omb.ts';

test('openmausbot bridge: routes @bot to chief, skips digest & notes, supports multi-bot @name and quote reply', async () => {
  const omb = await startMockOmb([
    { id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true },
    { id: 'b2', name: 'Dev', threadId: 't2', chiefOfStaff: false },
  ]);
  const sent: SentImItem[] = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-bridge-1-'));
  const bridge = new OpenMausBotBridge({ client: new OpenMausBotClient({ baseUrl: omb.baseUrl }), transport, dataDir });

  omb.setScenario(({ bot, reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
    setTimeout(() => {
      const reply = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: `${bot?.name} 收到：${reqMsg.text}`, turnTerminal: true };
      const digest = { id: nextId(), role: 'bot', kind: 'digest', threadId, requestMessageId: reqMsg.id, text: '[digest] internal summary' };
      messages.push(reply, digest);
      jobs.set(threadId, { state: 'completed', version: 'v_done', needsInput: [] });
      broadcast({ kind: 'message', threadId, message: reply });
      broadcast({ kind: 'message', threadId, message: digest });
    }, 20);
  });

  try {
    await bridge.start();
    await transport.emitUser('记一下待办：下午开会');
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(sent.length, 0);

    await transport.emitUser('@bot 你好');
    await until(() => sent.length === 1);
    assert.equal(sent[0].text.includes('**[MausBot]**'), false);
    assert.match(sent[0].text, /MausBot 收到：你好/);
    assert.equal(sent.some((m) => m.text.includes('▶️') || m.text.includes('[digest]')), false);

    await transport.emitUser('@dev 查一下构建');
    await until(() => sent.length === 2);
    assert.match(sent[1].text, /\[Dev\] Dev 收到：查一下构建/);

    await transport.emitUser('顺便看下日志', { replyTo: sent[1].id });
    await until(() => sent.length === 3);
    assert.match(sent[2].text, /\[Dev\] Dev 收到：顺便看下日志/);
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('openmausbot bridge: throttled activity milestone, approval ok/no, bots and stop commands', async () => {
  const omb = await startMockOmb([{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }]);
  const sent: SentImItem[] = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-bridge-2-'));
  const bridge = new OpenMausBotBridge({
    client: new OpenMausBotClient({ baseUrl: omb.baseUrl }),
    transport,
    dataDir,
    progressDelayMs: 60,
    progressIntervalMs: 80,
    maxProgressUpdates: 2,
  });

  try {
    await bridge.start();

    await transport.emitUser('@bot status');
    await until(() => sent.length === 1);
    assert.match(sent[0].text, /co-bot/);
    assert.equal(/mausbot/i.test(sent[0].text), false);

    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      const act = { id: nextId(), role: 'bot', kind: 'activity', threadId, requestMessageId: reqMsg.id, tool: { name: 'bash', spoken: '运行测试' } };
      messages.push(act);
      broadcast({ kind: 'message', threadId, message: act });
      setTimeout(() => {
        const card = {
          id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id,
          card: { requestId: 'req_1', title: '运行命令：git fetch origin', answered: false, dismissed: false, expired: false },
        };
        messages.push(card);
        jobs.set(threadId, { state: 'needs-input', version: 'v_card', needsInput: [{ requestId: 'req_1' }] });
        broadcast({ kind: 'message', threadId, message: card });
      }, 110);
    });

    await transport.emitUser('@bot 帮我检查并拉取代码');
    await until(() => sent.some((m) => m.text.includes('正在执行')) && sent.some((m) => m.text.includes('运行命令：git fetch origin')));

    const cardBubble = sent.find((m) => m.text.includes('运行命令：git fetch origin'))!;
    assert.equal(cardBubble.text.includes('**[MausBot]**'), false);
    assert.ok(cardBubble.text.includes('允许'));

    await transport.emitUser('ok');
    await until(() => sent.some((m) => m.text.includes('已执行命令，结果正常')));
    assert.equal(omb.responds[0]?.behavior, 'allow');
    assert.equal(omb.responds[0]?.requestId, 'req_1');

    omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
      setTimeout(() => {
        const card2 = {
          id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id,
          card: { requestId: 'req_2', title: '危险命令：rm -rf dist', answered: false, dismissed: false, expired: false },
        };
        messages.push(card2);
        jobs.set(threadId, { state: 'needs-input', version: 'v_card2', needsInput: [{ requestId: 'req_2' }] });
        broadcast({ kind: 'message', threadId, message: card2 });
      }, 20);
    });
    await transport.emitUser('@bot 清理一下产物');
    await until(() => sent.some((m) => m.text.includes('危险命令')));
    await transport.emitUser('no');
    await until(() => sent.some((m) => m.text.includes('已按你的要求取消执行')));
    assert.equal(omb.responds[1]?.behavior, 'deny');
    assert.equal(omb.responds[1]?.requestId, 'req_2');

    omb.setScenario(() => {});
    await transport.emitUser('@bot 跑一个很长的任务');
    await new Promise((r) => setTimeout(r, 30));
    await transport.emitUser('@bot stop');
    await until(() => sent.some((m) => m.text.includes('已请求停止')));
    assert.equal(omb.interrupts.length, 1);
    assert.equal(omb.interrupts[0].botId, 'b1');
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('openmausbot bridge: commandDevices allowlist, state persistence, .md attachment clipping, and file/image uploads', async () => {
  const omb = await startMockOmb([
    { id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true },
    { id: 'b2', name: 'Dev', threadId: 't2', chiefOfStaff: false },
  ]);
  const sent: SentImItem[] = [];
  const filesSent: SentImFileItem[] = [];
  const downloadData = new Map<string, string | Buffer>([
    ['att_img', Buffer.from('89504e470d0a1a0a', 'hex')],
    ['att_log', Buffer.from('ERROR timeout on line 12\n')],
  ]);
  const transport = makeIm(sent, filesSent, downloadData);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-bridge-3-'));
  const client = new OpenMausBotClient({ baseUrl: omb.baseUrl });
  const bridge1 = new OpenMausBotBridge({
    client,
    transport,
    dataDir,
    commandDevices: ['mobile'],
    resultChars: 40,
  });

  omb.setScenario(({ bot, reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
    setTimeout(() => {
      const replyText = String(reqMsg.text || '').includes('长结果')
        ? '这是一个非常长的回答第一行\n这是第二行，用来触发resultChars截断并通过sendFile发送完整Markdown附件'
        : `${bot?.name} 收到：${reqMsg.text}`;
      const reply = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: replyText, turnTerminal: true };
      messages.push(reply);
      jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
      broadcast({ kind: 'message', threadId, message: reply });
    }, 15);
  });

  try {
    await bridge1.start();

    await transport.emitUser('@bot 来自电脑', { device: { id: 'pc', type: 'desktop' } });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(sent.length, 0);

    await transport.emitUser('', {
      device: { id: 'iphone', type: 'mobile' },
      attachments: [
        { id: 'att_img', msgId: 'u_img', name: 'shot.png', mime: 'image/png' },
        { id: 'att_log', msgId: 'u_log', name: 'app.log', mime: 'text/plain' },
      ],
    });
    await transport.emitUser('@dev 看下长结果和附件', { device: { id: 'iphone', type: 'mobile' } });
    await until(() => sent.length === 1 && filesSent.length === 1);

    assert.equal(omb.uploads.length, 2);
    assert.equal(omb.uploads[0].kind, 'image');
    assert.equal(omb.uploads[1].kind, 'file');
    assert.match(String(omb.sentToOmb[0].text), /<attached-image path="C:\\tmp\\\d+\.png" \/>/);
    assert.match(String(omb.sentToOmb[0].text), /<attached-file path="C:\\tmp\\app\.log" name="app\.log" \/>/);
    assert.match(sent[0].text, /完整回复见下一条附件/);
    assert.equal(filesSent[0].name, 'Dev.md');
    assert.match(filesSent[0].content, /触发resultChars截断并通过sendFile发送完整Markdown附件/);

    const savedReplyId = sent[0].id;
    await bridge1.stop();

    const sentAfter: SentImItem[] = [];
    const transport2 = makeIm(sentAfter);
    const bridge2 = new OpenMausBotBridge({ client, transport: transport2, dataDir });
    try {
      await bridge2.start();
      await transport2.emitUser('重启后继续问 Dev', { replyTo: savedReplyId });
      await until(() => sentAfter.length === 1);
      assert.match(sentAfter[0].text, /\*\*\[Dev\]\*\*[\s\S]*Dev 收到：重启后继续问 Dev/);
    } finally {
      await bridge2.stop();
    }
  } finally {
    await omb.close();
  }
});

test('openmausbot bridge: proactive routine forwarding, dedupe, quietHours + @bot status/flushQuietDigest, and card bypass', async () => {
  const omb = await startMockOmb([
    { id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true },
    { id: 'b2', name: 'Ops', threadId: 't2', chiefOfStaff: false },
  ]);
  const sent: SentImItem[] = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-bridge-4-'));
  const quietNow = new Date(2026, 10, 19, 23, 30, 0).getTime();
  let curNow = quietNow;
  const bridge = new OpenMausBotBridge({
    client: new OpenMausBotClient({ baseUrl: omb.baseUrl }),
    transport,
    dataDir,
    quietHours: { enabled: true, start: '22:00', end: '08:30' },
    now: () => curNow,
  });

  omb.setScenario(({ bot, reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
    setTimeout(() => {
      const reply = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: `${bot?.name}: ${reqMsg.text}`, turnTerminal: true };
      messages.push(reply);
      jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
      broadcast({ kind: 'message', threadId, message: reply });
    }, 15);
  });

  try {
    await bridge.start();

    const p1 = { id: 'pro_1', role: 'bot', kind: 'text', threadId: 't2', text: '巡检完成：今日 0 异常', turnTerminal: true };
    omb.broadcast({ kind: 'message', threadId: 't2', message: p1 });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(sent.length, 0);
    assert.equal(bridge.status().quietPending, 1);

    const pCard = { id: 'pro_c1', role: 'bot', kind: 'text', threadId: 't2', card: { requestId: 'req_pro', title: '确认重启服务' } };
    omb.broadcast({ kind: 'message', threadId: 't2', message: pCard });
    await until(() => sent.length === 1);
    assert.match(sent[0].text, /确认重启服务/);

    await transport.emitUser('@bot status');
    await until(() => sent.length === 2);
    assert.match(sent[1].text, /待汇总 1/);

    curNow = new Date(2026, 10, 19, 10, 0, 0).getTime();
    const flushed = await bridge.flushQuietDigest();
    assert.equal(flushed, 1);
    await until(() => sent.length === 3);
    assert.match(sent[2].text, /免打扰期间汇总（1 条）[\s\S]*Ops[\s\S]*巡检完成/);
    assert.equal(bridge.status().quietPending, 0);

    const p2 = { id: 'pro_2', role: 'bot', kind: 'text', threadId: 't2', text: 'CI 构建已修复通过', turnTerminal: true };
    omb.broadcast({ kind: 'message', threadId: 't2', message: p2 });
    omb.broadcast({ kind: 'message.patch', threadId: 't2', message: p2 });
    await until(() => sent.length === 4);
    assert.match(sent[3].text, /^🔔 \*\*Ops 通知\*\*[\s\S]*CI 构建已修复通过/);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(sent.length, 4, '同一主动消息 id 不得重复推送');

    await transport.emitUser('帮我看下耗时', { replyTo: sent[3].id });
    await until(() => sent.length === 5);
    assert.match(sent[4].text, /\[Ops\] Ops: 帮我看下耗时/);
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('openmausbot bridge: @bot new, @bot compact, and returning bot-generated images & files to IM', async () => {
  const omb = await startMockOmb([
    { id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true },
  ]);
  const sent: SentImItem[] = [];
  const filesSent: SentImFileItem[] = [];
  const transport = makeIm(sent, filesSent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-bridge-5-'));
  const bridge = new OpenMausBotBridge({ client: new OpenMausBotClient({ baseUrl: omb.baseUrl }), transport, dataDir });

  const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const csvBytes = Buffer.from('id,status\n1,ok\n', 'utf8');

  omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
    setTimeout(() => {
      const mImgId = nextId();
      omb.setMedia(mImgId, 'image', { buf: pngBytes, mime: 'image/png' });
      const mFileId = nextId();
      omb.setMedia(mFileId, 'C:\\out\\report.csv', { buf: csvBytes, mime: 'text/csv', name: 'report.csv' });

      const screenMsg = { id: mImgId, role: 'bot', kind: 'screen', threadId, requestMessageId: reqMsg.id, hasImage: true };
      const textMsg = {
        id: mFileId, role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id,
        text: `已在新线程处理：${reqMsg.text}`,
        attachments: [{ path: 'C:\\out\\report.csv', name: 'report.csv' }],
        turnTerminal: true,
      };
      messages.push(screenMsg, textMsg);
      jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
      broadcast({ kind: 'message', threadId, message: textMsg });
    }, 15);
  });

  try {
    await bridge.start();

    await transport.emitUser('@bot new');
    await until(() => sent.length === 1);
    assert.equal(omb.tasksCreated.length, 1);
    assert.match(sent[0].text, /开启新会话/);

    await transport.emitUser('@bot new 生成日报和截图');
    await until(() => sent.length === 2 && filesSent.length === 2);
    assert.equal(omb.tasksCreated.length, 2);
    assert.match(sent[1].text, /已在新线程处理：生成日报和截图/);
    assert.equal(omb.sentToOmb[0].threadId, 'b1_task_2');
    assert.ok(filesSent.some((f) => f.buf.equals(pngBytes) && f.name.endsWith('.png')));
    assert.ok(filesSent.some((f) => f.name === 'report.csv' && f.content.includes('1,ok')));

    await transport.emitUser('@bot compact');
    await until(() => sent.length === 3);
    assert.equal(omb.compacts.length, 1);
    assert.equal(omb.compacts[0].threadId, 'b1_task_2');
    assert.match(sent[2].text, /压缩当前会话上下文/);
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('openmausbot bridge: desktop pairing flow and bearer authorization header on HTTP & SSE', async () => {
  const validToken = 'omb_sess_testtoken123';
  const pairCode = '7KQ2-M9XD-H4TP';
  const omb = await startMockOmb(
    [{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }],
    { desktopManaged: true, validToken, pairCode },
  );
  const sent: SentImItem[] = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-bridge-pair-'));
  const client = new OpenMausBotClient({ baseUrl: omb.baseUrl, token: 'omb_sess_old' });
  const bridge = new OpenMausBotBridge({ client, transport, dataDir });

  omb.setScenario(({ bot, reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
    setTimeout(() => {
      const reply = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: `${bot?.name}: ${reqMsg.text}`, turnTerminal: true };
      messages.push(reply);
      jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
      broadcast({ kind: 'message', threadId, message: reply });
    }, 15);
  });

  try {
    const paired = await client.pair({ code: pairCode, label: 'co-bot' });
    assert.equal(paired.token, validToken);
    const pairReq = omb.authHeaders.find((h) => h.path === '/api/auth/pair');
    assert.equal(pairReq?.auth, null, 'pair 请求不应携带旧的失效 Authorization 头');

    client.setToken(paired.token!);
    const sess = await client.authSession();
    assert.equal(sess.kind, 'session');

    await bridge.start();
    await transport.emitUser('@bot hello');
    await until(() => sent.length === 1);
    assert.match(sent[0].text, /MausBot: hello/);

    await until(() => omb.authHeaders.some((h) => h.path === '/api/events'));
    const eventsReq = omb.authHeaders.find((h) => h.path === '/api/events');
    const postMsgReq = omb.authHeaders.find((h) => h.method === 'POST' && h.path === '/api/bots/b1/messages');
    assert.equal(eventsReq?.auth, `Bearer ${validToken}`);
    assert.equal(postMsgReq?.auth, `Bearer ${validToken}`);
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('openmausbot bridge: unpaired desktop mode surfaces helpful Chinese pairing prompt on 403', async () => {
  const omb = await startMockOmb(
    [{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }],
    { desktopManaged: true, validToken: 'omb_sess_testtoken123', pairCode: '7KQ2-M9XD-H4TP' },
  );
  const sent: SentImItem[] = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-bridge-unpaired-'));
  const bridge = new OpenMausBotBridge({ client: new OpenMausBotClient({ baseUrl: omb.baseUrl }), transport, dataDir });

  try {
    await bridge.start();
    await transport.emitUser('@bot hello');
    await until(() => sent.length === 1);
    assert.match(sent[0].text, /发送给 \*\*co-bot\*\* 失败/);
    assert.match(sent[0].text, /npm run pair --/);
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('openmausbot client: one-click CLI login flow (waiting -> allowed -> authSession) without leaking old auth', async () => {
  const validToken = 'omb_sess_clilogin123';
  const omb = await startMockOmb(
    [{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }],
    { desktopManaged: true, validToken },
  );
  const client = new OpenMausBotClient({ baseUrl: omb.baseUrl, token: 'omb_sess_stale' });

  try {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const verifierHash = crypto.createHash('sha256').update(verifier).digest('base64url');

    const started = await client.startCliLogin({ label: 'co-bot', scope: 'admin', verifierHash });
    assert.equal(started.code, 'ABCD-2345');

    const firstPoll = await client.pollCliLogin(started.id!, { verifier });
    assert.equal(firstPoll.state, 'waiting');

    omb.approveCliLogin(started.id!);
    const secondPoll = await client.pollCliLogin(started.id!, { verifier });
    assert.equal(secondPoll.state, 'allowed');
    assert.equal(secondPoll.token, validToken);

    client.setToken(secondPoll.token!);
    const sess = await client.authSession();
    assert.equal(sess.kind, 'session');

    const loginReqs = omb.authHeaders.filter((h) => h.path.startsWith('/api/auth/cli-login'));
    assert.equal(loginReqs.length, 3);
    assert.ok(loginReqs.every((h) => h.auth === null), 'cli-login 端点不应携带旧 Authorization 头');
  } finally {
    await omb.close();
  }
});

test('openmausbot bridge: SSE 401 sets sseAuthFailed without tight loop, and upload 403 surfaces pairing prompt', async () => {
  const omb = await startMockOmb(
    [{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }],
    { desktopManaged: true, validToken: 'omb_sess_testtoken123', rejectSseStatus: 401 },
  );
  const sent: SentImItem[] = [];
  const filesSent: SentImFileItem[] = [];
  const downloadData = new Map<string, string | Buffer>([['att_up', Buffer.from('log line\n')]]);
  const transport = makeIm(sent, filesSent, downloadData);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-bridge-sse-401-'));
  const bridge = new OpenMausBotBridge({ client: new OpenMausBotClient({ baseUrl: omb.baseUrl }), transport, dataDir });

  try {
    await bridge.start();
    await until(() => bridge.status().sseAuthFailed === true);
    assert.equal(bridge.status().connected, false);
    await new Promise((r) => setTimeout(r, 120));
    const sseReqs = omb.authHeaders.filter((h) => h.path === '/api/events');
    assert.equal(sseReqs.length, 1, 'SSE 遇到 401 应退避重连，避免 1 秒紧循环刷接口');

    await transport.emitUser('', {
      attachments: [{ id: 'att_up', msgId: 'u_up', name: 'debug.log', mime: 'text/plain' }],
    });
    await transport.emitUser('@bot 分析附件');
    await until(() => sent.some((m) => m.text.includes('附件 debug.log 上传失败')));
    const upErr = sent.find((m) => m.text.includes('附件 debug.log 上传失败'))!;
    assert.match(upErr.text, /npm run pair --/);
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('openmausbot bridge: forwards standalone agents_attach_file messages (sentInTurn without requestMessageId) and proactive attachments', async () => {
  const omb = await startMockOmb([
    { id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true },
  ]);
  const sent: SentImItem[] = [];
  const filesSent: SentImFileItem[] = [];
  const transport = makeIm(sent, filesSent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-bridge-sentinturn-'));
  const bridge = new OpenMausBotBridge({ client: new OpenMausBotClient({ baseUrl: omb.baseUrl }), transport, dataDir });

  const zipBytes = Buffer.from('504b0304140000000000', 'hex');
  const attPath = 'C:\\Users\\chenj\\.openmausbot\\attachments\\test-archive.zip';

  omb.setScenario(({ reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
    const turnId = 'turn_zip_1';
    const midMsg = {
      id: nextId(),
      role: 'bot',
      kind: 'text',
      threadId,
      turnId,
      requestMessageId: reqMsg.id,
      text: '正在打包测试文件。',
    };
    messages.push(midMsg);
    broadcast({ kind: 'message', threadId, message: midMsg });

    setTimeout(() => {
      const attMsgId = nextId();
      omb.setMedia(attMsgId, attPath, { buf: zipBytes, mime: 'application/zip', name: 'test-archive.zip' });
      const attMsg = {
        id: attMsgId,
        role: 'bot',
        kind: 'text',
        threadId,
        text: '',
        attachments: [{ kind: 'file', path: attPath, mime: 'application/zip', name: 'test-archive.zip' }],
        sentInTurn: turnId,
      };
      const finMsg = {
        id: nextId(),
        role: 'bot',
        kind: 'text',
        threadId,
        turnId,
        requestMessageId: reqMsg.id,
        text: 'zip 包发好了，叫 test-archive.zip。',
        turnTerminal: true,
      };
      messages.push(attMsg, finMsg);
      jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
      broadcast({ kind: 'message', threadId, message: attMsg });
      broadcast({ kind: 'message', threadId, message: finMsg });
    }, 20);
  });

  try {
    await bridge.start();
    await transport.emitUser('@bot 测试一下给我发一个zip文件');
    await until(() => sent.some((m) => m.text.includes('zip 包发好了')) && filesSent.length === 1);
    assert.equal(filesSent[0].name, 'test-archive.zip');
    assert.equal(filesSent[0].buf.equals(zipBytes), true);

    const proPath = 'C:\\tmp\\proactive-report.zip';
    omb.setMedia('pro_att_1', proPath, { buf: zipBytes, mime: 'application/zip', name: 'proactive-report.zip' });
    omb.broadcast({
      kind: 'message',
      threadId: 't1',
      message: {
        id: 'pro_att_1',
        role: 'bot',
        kind: 'text',
        threadId: 't1',
        text: '',
        attachments: [{ kind: 'file', path: proPath, mime: 'application/zip', name: 'proactive-report.zip' }],
        sentInTurn: 'pro_turn_1',
      },
    });
    await until(() => filesSent.length === 2);
    assert.equal(filesSent[1].name, 'proactive-report.zip');
    assert.equal(filesSent[1].buf.equals(zipBytes), true);
  } finally {
    await bridge.stop();
    await omb.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
