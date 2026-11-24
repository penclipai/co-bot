import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

export async function getFreePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

export const until = async (fn, ms = 4000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail('timeout waiting for condition');
};

/** 本地模拟 OpenMausBot Harness（HTTP + SSE + Card 审批 + Activity + 桌面端配对鉴权），不依赖外部服务。 */
export async function startMockOmb(botsSpec, opts = {}) {
  const bots = botsSpec.map((b) => ({
    hidden: false, busy: false, activity: 'idle',
    modelSelection: { instanceId: 'deepseek', model: 'deepseek/deepseek-flash' },
    ...b,
  }));
  const groups = Array.isArray(opts.groups)
    ? opts.groups.map((g) => ({ hidden: false, dm: false, busy: false, ...g }))
    : [];
  const messages = new Map();
  const jobs = new Map();
  const initThread = (tid) => {
    if (!tid) return;
    if (!messages.has(tid)) messages.set(tid, []);
    if (!jobs.has(tid)) jobs.set(tid, { state: 'idle', version: 'v0', needsInput: [] });
  };
  for (const b of bots) {
    initThread(b.threadId);
    for (const t of b.tasks ?? []) initThread(t.threadId ?? t.id);
  }
  for (const g of groups) {
    initThread(g.threadId);
    for (const t of g.tasks ?? []) initThread(t.threadId ?? t.id);
  }
  const sseClients = new Set();
  const responds = [];
  const cardDismissals = [];
  const interrupts = [];
  const uploads = [];
  const sentToOmb = [];
  const tasksCreated = [];
  const tasksSelected = [];
  const steered = [];
  const cancelled = [];
  const compacts = [];
  let respondFailuresLeft = Number(opts.respondFailCount ?? 0);
  let dismissFailuresLeft = Number(opts.dismissFailCount ?? 0);
  const authHeaders = [];
  const cliLogins = new Map();
  const mediaFiles = new Map();
  let seq = 0;
  let msgSeq = 0;

  const broadcast = (payload) => {
    seq += 1;
    const frame = `id: mock:${seq}\ndata: ${JSON.stringify({ ...payload, seq })}\n\n`;
    for (const res of sseClients) res.write(frame);
  };

  let scenario = null;
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    authHeaders.push({ method: req.method, path: u.pathname, auth: req.headers.authorization ?? null });
    const json = (code, data) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const readBuf = async () => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      return Buffer.concat(chunks);
    };
    const readJson = async () => {
      const raw = (await readBuf()).toString('utf8');
      return raw ? JSON.parse(raw) : {};
    };

    if (req.method === 'GET' && u.pathname === '/api/health') {
      return json(200, { app: 'openmausbot', version: '0.1.170-mock', box: 'off' });
    }
    if (req.method === 'GET' && u.pathname === '/.well-known/openmausbot/environment') {
      return json(200, {
        version: '0.1.173-mock',
        capabilities: { selfUpdate: opts.desktopManaged ? 'desktop-managed' : 'operator' },
      });
    }
    if (req.method === 'GET' && u.pathname === '/api/auth/session') {
      const mAuth = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
      const bearer = mAuth ? mAuth[1].trim() : '';
      if (opts.validToken && bearer === opts.validToken) {
        return json(200, { kind: 'session', id: 's1', label: 'co-bot', scopes: ['admin', 'client'], via: 'bearer' });
      }
      if (bearer) {
        return json(401, { error: 'unauthorized: this session has expired or was revoked' });
      }
      return json(200, { kind: 'loopback', scopes: ['admin', 'client'] });
    }
    if (req.method === 'POST' && u.pathname === '/api/auth/pair') {
      const body = await readJson();
      if (opts.pairCode && body.code === opts.pairCode) {
        return json(200, {
          token: opts.validToken,
          session: { id: 's1', label: body.label || 'co-bot', scopes: ['admin', 'client'] },
        });
      }
      return json(401, { error: 'pairing code is wrong or has expired' });
    }
    if (req.method === 'POST' && u.pathname === '/api/auth/cli-login') {
      const body = await readJson();
      if (typeof body.verifierHash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.verifierHash)) {
        return json(400, { error: 'invalid verifierHash' });
      }
      const id = `cli_${cliLogins.size + 1}`;
      cliLogins.set(id, { id, code: 'ABCD-2345', label: body.label || 'co-bot', verifierHash: body.verifierHash, state: 'waiting' });
      return json(201, { id, code: 'ABCD-2345', expiresAt: Date.now() + 60_000, intervalMs: 50 });
    }
    let mLogin;
    if (req.method === 'POST' && (mLogin = /^\/api\/auth\/cli-login\/([^/]+)$/.exec(u.pathname))) {
      const body = await readJson();
      const entry = cliLogins.get(mLogin[1]);
      const digest = crypto.createHash('sha256').update(String(body.verifier || '')).digest('base64url');
      if (!entry || digest !== entry.verifierHash) {
        return json(404, { state: 'gone', error: 'no such sign-in request' });
      }
      if (entry.state === 'waiting') {
        return json(202, { state: 'waiting', expiresAt: Date.now() + 60_000 });
      }
      cliLogins.delete(entry.id);
      return json(200, {
        state: 'allowed',
        token: opts.validToken,
        session: { id: 's1', label: entry.label, scopes: ['admin', 'client'] },
        environment: { capabilities: { selfUpdate: 'desktop-managed' } },
      });
    }
    if (opts.desktopManaged && req.method === 'POST') {
      if (req.headers.authorization !== `Bearer ${opts.validToken}`) {
        return json(403, { error: 'forbidden: this change must come from the desktop app or a paired device' });
      }
    }
    if (req.method === 'GET' && u.pathname === '/api/bots') {
      return json(200, { bots, groups });
    }
    if (req.method === 'GET' && u.pathname === '/api/events') {
      if (opts.rejectSseStatus) {
        return json(opts.rejectSseStatus, { error: 'unauthorized: token expired' });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ kind: 'hello', cursor: `mock:${seq}`, resumed: false })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    let m;
    if (req.method === 'GET' && (m = /^\/api\/threads\/([^/]+)\/messages$/.exec(u.pathname))) {
      return json(200, { messages: messages.get(m[1]) ?? [], hasMore: false });
    }
    if (req.method === 'GET' && (m = /^\/api\/threads\/([^/]+)\/job$/.exec(u.pathname))) {
      const st = jobs.get(m[1]) ?? { state: 'idle', version: 'v0', needsInput: [] };
      return json(200, { threadId: m[1], since: Date.now(), ...st });
    }
    if (req.method === 'POST' && (m = /^\/api\/bots\/([^/]+)\/interrupt$/.exec(u.pathname))) {
      const body = await readJson();
      interrupts.push({ botId: m[1], threadId: body.threadId });
      const b = bots.find((x) => x.id === m[1]);
      if (b) {
        b.busy = false;
        jobs.set(b.threadId, { state: 'completed', version: `v${++seq}`, needsInput: [] });
      }
      return json(200, { ok: true });
    }
    if (req.method === 'POST' && (m = /^\/api\/bots\/([^/]+)\/(secret-cards|connector-cards|sign-in-cards)\/([^/]+)\/(dismiss|cancel)$/.exec(u.pathname))) {
      const body = await readJson();
      if (dismissFailuresLeft > 0) {
        dismissFailuresLeft -= 1;
        return json(500, { error: 'transient dismiss error' });
      }
      const kindMap = { 'secret-cards': 'secret', 'connector-cards': 'connector', 'sign-in-cards': 'signIn' };
      const kind = kindMap[m[2]];
      cardDismissals.push({ kind, action: m[4], botId: m[1], messageId: m[3], threadId: body.threadId });
      const threadId = body.threadId;
      const arr = messages.get(threadId) ?? [];
      const cardMsg = arr.find((x) => x.id === m[3]);
      if (cardMsg?.secret) cardMsg.secret.dismissed = true;
      if (cardMsg?.connector) cardMsg.connector.dismissed = true;
      if (cardMsg?.signIn) cardMsg.signIn.cancelled = true;
      return json(200, { ok: true });
    }
    if (req.method === 'POST' && (m = /^\/api\/threads\/([^/]+)\/respond$/.exec(u.pathname))) {
      const body = await readJson();
      if (respondFailuresLeft > 0) {
        respondFailuresLeft -= 1;
        return json(500, { error: 'transient respond error' });
      }
      if (body.rememberCommand && opts.refuseRememberCommand) {
        return json(403, { error: 'command remembering requires admin' });
      }
      const threadId = m[1];
      responds.push({ threadId, ...body });
      const arr = messages.get(threadId) ?? [];
      const cardMsg = arr.find((x) => x.card?.requestId === body.requestId);
      if (cardMsg) cardMsg.card.answered = true;
      const reqId = cardMsg?.requestMessageId;
      const finalMsg = {
        id: `m${++msgSeq}`, role: 'bot', kind: 'text', threadId, requestMessageId: reqId,
        text: body.behavior === 'allow'
          ? '已执行命令，结果正常。'
          : (body.behavior === 'answer' && body.message ? `已采用方案：${body.message}` : '已按你的要求取消执行。'),
        turnTerminal: true,
      };
      arr.push(finalMsg);
      jobs.set(threadId, { state: 'completed', version: `v${++seq}`, needsInput: [] });
      broadcast({ kind: 'message', threadId, message: finalMsg });
      return json(200, { ok: true });
    }
    if (req.method === 'POST' && (m = /^\/api\/bots\/([^/]+)\/tasks\/([^/]+)$/.exec(u.pathname))) {
      const bot = bots.find((x) => x.id === m[1]);
      if (!bot) return json(404, { error: 'no such bot' });
      const task = (bot.tasks ?? []).find((t) => (t.threadId ?? t.id) === m[2]);
      if (!task && m[2] !== bot.threadId) return json(404, { error: 'no such task' });
      bot.threadId = m[2];
      if (!messages.has(m[2])) messages.set(m[2], []);
      if (!jobs.has(m[2])) jobs.set(m[2], { state: 'idle', version: `v${++seq}`, needsInput: [] });
      tasksSelected.push({ botId: bot.id, threadId: m[2] });
      return json(200, { bot });
    }
    if (req.method === 'POST' && (m = /^\/api\/bots\/([^/]+)\/queue\/([^/]+)\/steer$/.exec(u.pathname))) {
      const body = await readJson();
      steered.push({ botId: m[1], queueId: m[2], threadId: body.threadId });
      if (opts.steerBlockedBy) {
        return json(200, { ok: true, queued: true, threadId: body.threadId, blockedBy: opts.steerBlockedBy });
      }
      return json(200, { ok: true });
    }
    if (req.method === 'DELETE' && (m = /^\/api\/bots\/([^/]+)\/queue\/([^/]+)$/.exec(u.pathname))) {
      const body = await readJson();
      cancelled.push({ botId: m[1], queueId: m[2], threadId: body.threadId });
      return json(200, { ok: true });
    }
    if (req.method === 'PATCH' && (m = /^\/api\/bots\/([^/]+)$/.exec(u.pathname))) {
      const bot = bots.find((x) => x.id === m[1]);
      if (!bot) return json(404, { error: 'no such bot' });
      const body = await readJson();
      Object.assign(bot, body);
      return json(200, { bot });
    }
    if (req.method === 'POST' && (m = /^\/api\/bots\/([^/]+)\/tasks$/.exec(u.pathname))) {
      const bot = bots.find((x) => x.id === m[1]);
      if (!bot) return json(404, { error: 'no such bot' });
      const body = await readJson();
      const tid = `${bot.id}_task_${tasksCreated.length + 1}`;
      messages.set(tid, []);
      jobs.set(tid, { state: 'idle', version: `v${++seq}`, needsInput: [] });
      if (body.select !== false) bot.threadId = tid;
      const task = { id: tid, threadId: tid, title: body.title || 'New task' };
      tasksCreated.push({ botId: bot.id, ...task });
      return json(201, { bot, task });
    }
    if (req.method === 'POST' && (m = /^\/api\/bots\/([^/]+)\/compact$/.exec(u.pathname))) {
      const body = await readJson();
      compacts.push({ botId: m[1], threadId: body.threadId });
      return json(202, { ok: true, threadId: body.threadId });
    }
    if (req.method === 'GET' && (m = /^\/api\/threads\/([^/]+)\/messages\/([^/]+)\/image$/.exec(u.pathname))) {
      const item = mediaFiles.get(`${m[2]}:image`);
      if (!item) return json(404, { error: 'no image' });
      res.writeHead(200, { 'content-type': item.mime || 'image/png', 'content-length': String(item.buf.byteLength) });
      return res.end(item.buf);
    }
    if (req.method === 'POST' && (m = /^\/api\/threads\/([^/]+)\/messages\/([^/]+)\/file$/.exec(u.pathname))) {
      const body = await readJson();
      const item = mediaFiles.get(`${m[2]}:${body.path}`);
      if (!item) return json(404, { error: 'no file' });
      res.writeHead(200, {
        'content-type': item.mime || 'text/plain',
        ...(item.name ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}` } : {}),
      });
      return res.end(item.buf);
    }
    if (req.method === 'POST' && (m = /^\/api\/bots\/([^/]+)\/messages$/.exec(u.pathname))) {
      const bot = bots.find((x) => x.id === m[1]);
      if (!bot) return json(404, { error: 'no such bot' });
      const body = await readJson();
      const threadId = body.threadId || bot.threadId;
      sentToOmb.push({ botId: bot.id, threadId, text: body.text, sendId: body.sendId });
      if (opts.queueWhenBusy && jobs.get(threadId)?.state === 'running') {
        const queueId = `q_${++msgSeq}`;
        return json(202, { ok: true, queued: true, queueId, threadId });
      }
      const reqMsg = {
        id: `u${++msgSeq}`, role: 'user', kind: 'text', threadId,
        text: body.text, sendId: body.sendId, replyToId: body.replyToId ?? null,
      };
      if (!messages.has(threadId)) messages.set(threadId, []);
      messages.get(threadId).push(reqMsg);
      jobs.set(threadId, { state: 'running', version: `v${++seq}`, needsInput: [] });
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, threadId, message: reqMsg }));
      if (scenario) scenario({ bot, reqMsg, threadId, messages: messages.get(threadId), jobs, broadcast, nextId: () => `m${++msgSeq}` });
      return;
    }
    if (req.method === 'POST' && (m = /^\/api\/groups\/([^/]+)\/messages$/.exec(u.pathname))) {
      const group = groups.find((g) => g.id === m[1]);
      if (!group) return json(404, { error: 'no such group' });
      const body = await readJson();
      const threadId = body.threadId || group.threadId;
      sentToOmb.push({ groupId: group.id, threadId, text: body.text, sendId: body.sendId, replyToId: body.replyToId ?? null });
      if (opts.queueWhenBusy && jobs.get(threadId)?.state === 'running') {
        const queueId = `gq_${++msgSeq}`;
        return json(202, { ok: true, queued: true, queueId, threadId });
      }
      const reqMsg = {
        id: `u${++msgSeq}`, role: 'user', kind: 'text', threadId,
        text: body.text, sendId: body.sendId, replyToId: body.replyToId ?? null,
      };
      if (!messages.has(threadId)) messages.set(threadId, []);
      messages.get(threadId).push(reqMsg);
      jobs.set(threadId, { state: 'running', version: `v${++seq}`, needsInput: [] });
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, threadId, message: reqMsg }));
      if (scenario) scenario({ group, reqMsg, threadId, messages: messages.get(threadId), jobs, broadcast, nextId: () => `m${++msgSeq}` });
      return;
    }
    if (req.method === 'POST' && (m = /^\/api\/groups\/([^/]+)\/interrupt$/.exec(u.pathname))) {
      const group = groups.find((g) => g.id === m[1]);
      if (!group) return json(404, { error: 'no such room' });
      const body = await readJson();
      const tid = body.threadId || group.threadId;
      interrupts.push({ groupId: group.id, threadId: tid });
      group.busy = false;
      jobs.set(tid, { state: 'completed', version: `v${++seq}`, needsInput: [] });
      return json(200, { ok: true });
    }
    if (req.method === 'POST' && (m = /^\/api\/groups\/([^/]+)\/queue\/([^/]+)\/steer$/.exec(u.pathname))) {
      const body = await readJson();
      steered.push({ groupId: m[1], queueId: m[2], threadId: body.threadId });
      return json(200, { ok: true });
    }
    if (req.method === 'DELETE' && (m = /^\/api\/groups\/([^/]+)\/queue\/([^/]+)$/.exec(u.pathname))) {
      cancelled.push({ groupId: m[1], queueId: m[2] });
      return json(200, { ok: true });
    }
    if (req.method === 'POST' && (m = /^\/api\/groups\/([^/]+)\/tasks$/.exec(u.pathname))) {
      const group = groups.find((g) => g.id === m[1]);
      if (!group) return json(404, { error: 'no such channel' });
      const body = await readJson();
      const tid = `${group.id}_task_${tasksCreated.length + 1}`;
      messages.set(tid, []);
      jobs.set(tid, { state: 'idle', version: `v${++seq}`, needsInput: [] });
      group.threadId = tid;
      const task = { id: tid, threadId: tid, title: body.title || 'New group task' };
      group.tasks = [...(group.tasks ?? []), task];
      tasksCreated.push({ groupId: group.id, ...task });
      return json(201, { group, task });
    }
    if (req.method === 'POST' && (m = /^\/api\/groups\/([^/]+)\/tasks\/([^/]+)$/.exec(u.pathname))) {
      const group = groups.find((g) => g.id === m[1]);
      if (!group) return json(404, { error: 'no such channel' });
      group.threadId = m[2];
      initThread(m[2]);
      tasksSelected.push({ groupId: group.id, threadId: m[2] });
      return json(200, { group });
    }
    if (req.method === 'POST' && u.pathname === '/api/attachments') {
      const buf = await readBuf();
      const item = { kind: 'image', mime: req.headers['content-type'], size: buf.length, url: `/api/attachments/up-${++msgSeq}.png` };
      uploads.push(item);
      return json(201, { url: item.url, path: `C:\\tmp\\${msgSeq}.png` });
    }
    if (req.method === 'POST' && u.pathname === '/api/files') {
      const buf = await readBuf();
      const name = u.searchParams.get('name') || 'file';
      const item = { kind: 'file', name, mime: req.headers['content-type'], size: buf.length, url: `/api/files/f-${++msgSeq}-${name}` };
      uploads.push(item);
      return json(201, { url: item.url, path: `C:\\tmp\\${name}` });
    }
    json(404, { error: `unhandled ${req.method} ${u.pathname}` });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    responds,
    cardDismissals,
    interrupts,
    uploads,
    sentToOmb,
    tasksCreated,
    tasksSelected,
    steered,
    cancelled,
    compacts,
    bots,
    groups,
    authHeaders,
    broadcast,
    messages,
    approveCliLogin(id) {
      const entry = cliLogins.get(id);
      if (entry) entry.state = 'allowed';
    },
    setMedia(msgId, key, val) { mediaFiles.set(`${msgId}:${key}`, val); },
    setScenario(fn) { scenario = fn; },
    close: async () => {
      for (const c of sseClients) c.end();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

export function makeIm(sentList, filesSent = [], downloadData = new Map()) {
  let handler = null;
  let seq = 0;
  return {
    selfChatId: 'self',
    canFiles: true,
    async start(fn) { handler = fn; },
    async stop() {},
    async send(_chatId, text, opts) {
      const id = `im${++seq}`;
      sentList.push({ id, text, replyTo: opts?.replyTo ?? null });
      return id;
    },
    async sendFile(_chatId, file, opts) {
      const id = `imf${++seq}`;
      const buf = fs.readFileSync(file.path);
      filesSent.push({ id, name: file.name, buf, content: buf.toString('utf8'), replyTo: opts?.replyTo ?? null });
      return id;
    },
    async download(att, savePath) {
      const data = downloadData.get(att.id);
      if (!data) throw new Error('missing file');
      fs.mkdirSync(path.dirname(savePath), { recursive: true });
      fs.writeFileSync(savePath, data);
    },
    async emitUser(text, opts = {}) {
      await handler({
        id: `user${++seq}`,
        ts: Date.now(),
        chat: { id: 'self', type: 'self' },
        sender: { id: 'me', name: '我', isSelf: true },
        device: opts.device,
        text,
        replyTo: opts.replyTo,
        attachments: opts.attachments,
      });
    },
  };
}
