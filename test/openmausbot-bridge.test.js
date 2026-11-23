import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { APP_ROOT } from '../src/config.js';
import { OpenMausBotClient } from '../src/openmausbot/client.js';
import { OpenMausBotBridge } from '../src/openmausbot/bridge.js';
import { WebSimTransport } from '../src/im/sim.js';
import { WebServer } from '../src/web/server.js';
import { isLoopbackUrl, findOpenMausBotServer, ensureOpenMausBot } from '../scripts/omb.js';

const execFileAsync = promisify(execFile);

async function getFreePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

const until = async (fn, ms = 4000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail('timeout waiting for condition');
};

/** 本地模拟 OpenMausBot Harness（HTTP + SSE + Card 审批 + Activity + 桌面端配对鉴权），不依赖外部服务。 */
async function startMockOmb(botsSpec, opts = {}) {
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
  const routineRuns = [];
  const routinePatches = [];
  const taskPatches = [];
  const memoryState = new Map(bots.map((b) => [b.id, { text: opts.initialMemory ?? '', topics: opts.memoryTopics ?? [] }]));
  const routines = Array.isArray(opts.routines) ? opts.routines.map((r) => ({ ...r })) : [];
  const instances = Array.isArray(opts.instances) ? opts.instances : [];
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
    if (req.method === 'PATCH' && (m = /^\/api\/bots\/([^/]+)\/tasks\/([^/]+)$/.exec(u.pathname))) {
      const bot = bots.find((x) => x.id === m[1]);
      if (!bot) return json(404, { error: 'no such bot' });
      const body = await readJson();
      const task = (bot.tasks ?? []).find((t) => (t.threadId ?? t.id) === m[2]);
      if (task) Object.assign(task, body);
      if (body.modelSelection && bot.threadId === m[2]) bot.modelSelection = body.modelSelection;
      taskPatches.push({ botId: bot.id, threadId: m[2], body });
      return json(200, { bot, task });
    }
    if (req.method === 'GET' && u.pathname === '/api/instances') {
      return json(200, instances);
    }
    if (req.method === 'GET' && u.pathname === '/api/search') {
      const q = String(u.searchParams.get('q') ?? '').toLowerCase();
      const hits = [];
      for (const [tid, arr] of messages.entries()) {
        const b = bots.find((x) => x.threadId === tid || (x.tasks ?? []).some((t) => (t.threadId ?? t.id) === tid));
        const taskTitle = b?.tasks?.find((t) => (t.threadId ?? t.id) === tid)?.title || b?.name || '会话';
        for (const msg of arr) {
          if (String(msg.text || '').toLowerCase().includes(q)) {
            hits.push({
              threadId: tid, messageId: msg.id, at: msg.at || Date.now(), role: msg.role,
              kind: msg.kind, snippet: msg.text, botId: b?.id || 'b1', name: b?.name || 'MausBot', task: taskTitle,
            });
          }
        }
      }
      return json(200, { hits });
    }
    if (req.method === 'GET' && (m = /^\/api\/threads\/([^/]+)\/export$/.exec(u.pathname))) {
      const tid = m[1];
      const arr = messages.get(tid) ?? [];
      const md = ['# 导出会话', '', ...arr.filter((x) => x.text).map((x) => `**${x.role}**: ${x.text}`)].join('\n');
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="session-${tid}.md"`,
      });
      return res.end(md);
    }
    if (req.method === 'GET' && u.pathname === '/api/routines') {
      return json(200, { routines });
    }
    if (req.method === 'POST' && (m = /^\/api\/routines\/([^/]+)\/run$/.exec(u.pathname))) {
      const r = routines.find((x) => x.id === m[1]);
      if (!r) return json(404, { error: 'no such routine' });
      routineRuns.push(r.id);
      return json(201, { run: { id: `run_${routineRuns.length}`, routineId: r.id } });
    }
    if (req.method === 'PATCH' && (m = /^\/api\/routines\/([^/]+)$/.exec(u.pathname))) {
      const r = routines.find((x) => x.id === m[1]);
      if (!r) return json(404, { error: 'no such routine' });
      const body = await readJson();
      Object.assign(r, body);
      routinePatches.push({ id: r.id, body });
      return json(200, { routine: r });
    }
    if (req.method === 'GET' && (m = /^\/api\/bots\/([^/]+)\/memory$/.exec(u.pathname))) {
      const mem = memoryState.get(m[1]) ?? { text: '', topics: [] };
      return json(200, { botId: m[1], ...mem });
    }
    if (req.method === 'PUT' && (m = /^\/api\/bots\/([^/]+)\/memory$/.exec(u.pathname))) {
      const body = await readJson();
      const mem = memoryState.get(m[1]) ?? { text: '', topics: [] };
      mem.text = String(body.text ?? '');
      memoryState.set(m[1], mem);
      return json(200, { ok: true, hash: 'h1' });
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
    routineRuns,
    routinePatches,
    taskPatches,
    memoryState,
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

function makeIm(sentList, filesSent = [], downloadData = new Map()) {
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

test('openmausbot bridge: routes @bot to chief, skips digest & notes, supports multi-bot @name and quote reply', async () => {
  const omb = await startMockOmb([
    { id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true },
    { id: 'b2', name: 'Dev', threadId: 't2', chiefOfStaff: false },
  ]);
  const sent = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-bridge-1-'));
  const bridge = new OpenMausBotBridge({ client: new OpenMausBotClient({ baseUrl: omb.baseUrl }), transport, dataDir });

  omb.setScenario(({ bot, reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
    setTimeout(() => {
      const reply = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: `${bot.name} 收到：${reqMsg.text}`, turnTerminal: true };
      const digest = { id: nextId(), role: 'bot', kind: 'digest', threadId, requestMessageId: reqMsg.id, text: '[digest] internal summary' };
      messages.push(reply, digest);
      jobs.set(threadId, { state: 'completed', version: 'v_done', needsInput: [] });
      broadcast({ kind: 'message', threadId, message: reply });
      broadcast({ kind: 'message', threadId, message: digest });
    }, 20);
  });

  try {
    await bridge.start();
    // 1. 普通不带 @ 的自聊笔记：静默不回
    await transport.emitUser('记一下待办：下午开会');
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(sent.length, 0);

    // 2. @bot 默认走主 Bot（MausBot）：默认隐藏主 Bot 前缀（hideChiefPrefix: true），不含 ▶️ 开始、不泄露 digest
    await transport.emitUser('@bot 你好');
    await until(() => sent.length === 1);
    assert.equal(sent[0].text.includes('**[MausBot]**'), false);
    assert.match(sent[0].text, /MausBot 收到：你好/);
    assert.equal(sent.some((m) => m.text.includes('▶️') || m.text.includes('[digest]')), false);

    // 3. @Dev 直达 Dev Bot，然后引用该回复不带 @ 继续跟 Dev 对话
    await transport.emitUser('@dev 查一下构建');
    await until(() => sent.length === 2);
    assert.match(sent[1].text, /\*\*\[Dev\]\*\*[\s\S]*Dev 收到：查一下构建/);

    await transport.emitUser('顺便看下日志', { replyTo: sent[1].id });
    await until(() => sent.length === 3);
    assert.match(sent[2].text, /\*\*\[Dev\]\*\*[\s\S]*Dev 收到：顺便看下日志/);
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('openmausbot bridge: throttled activity milestone, approval ok/no, bots and stop commands', async () => {
  const omb = await startMockOmb([{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }]);
  const sent = [];
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

    // 1. @bot bots
    await transport.emitUser('@bot bots');
    await until(() => sent.length === 1);
    assert.match(sent[0].text, /MausBot/);

    // 2. 长任务期间先推 activity 进展，再推审批卡片，手机回复 ok 放行并拿到结果（单 Bot 不加 [MausBot] 前缀）
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
    await until(() => sent.some((m) => m.text.includes('正在执行')) && sent.some((m) => m.text.includes('回复 `ok` 允许')));

    // 单 Bot 模式干净极简，不带 **[MausBot]** 前缀
    const cardBubble = sent.find((m) => m.text.includes('回复 `ok` 允许'));
    assert.equal(cardBubble.text.includes('**[MausBot]**'), false);

    // 手机只回 ok -> 调 OpenMausBot /respond allow 并收到最终结果
    await transport.emitUser('ok');
    await until(() => sent.some((m) => m.text.includes('已执行命令，结果正常')));
    assert.equal(omb.responds[0]?.behavior, 'allow');
    assert.equal(omb.responds[0]?.requestId, 'req_1');

    // 2b. 再测一次审批拒绝（no -> behavior: 'deny'）
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

    // 3. @bot stop 调 interrupt
    omb.setScenario(() => {}); // 保持 running
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
  const sent = [];
  const filesSent = [];
  const downloadData = new Map([
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
      const replyText = reqMsg.text.includes('长结果')
        ? '这是一个非常长的回答第一行\n这是第二行，用来触发resultChars截断并通过sendFile发送完整Markdown附件'
        : `${bot.name} 收到：${reqMsg.text}`;
      const reply = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: replyText, turnTerminal: true };
      messages.push(reply);
      jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
      broadcast({ kind: 'message', threadId, message: reply });
    }, 15);
  });

  try {
    await bridge1.start();

    // 1. commandDevices = ['mobile'] 时忽略 desktop 消息，放行 mobile 消息
    await transport.emitUser('@bot 来自电脑', { device: { id: 'pc', type: 'desktop' } });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(sent.length, 0);

    // 2. 上传图片 + 日志文件，先发文件、紧接着发 @dev 指令，并触发长结果截断 + .md 附件
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
    assert.match(omb.sentToOmb[0].text, /<attached-image path="C:\\tmp\\\d+\.png" \/>/);
    assert.match(omb.sentToOmb[0].text, /<attached-file path="C:\\tmp\\app\.log" name="app\.log" \/>/);
    assert.match(sent[0].text, /完整回复见下一条附件/);
    assert.equal(filesSent[0].name, 'Dev.md');
    assert.match(filesSent[0].content, /触发resultChars截断并通过sendFile发送完整Markdown附件/);

    const savedReplyId = sent[0].id;
    await bridge1.stop();

    // 3. 重启 bridge 后，从 dataDir/bridge-state.json 恢复 msgRoute：直接引用重启前的气泡也能续聊到 Dev
    const sentAfter = [];
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

test('openmausbot bridge: proactive routine forwarding, dedupe, quietHours + @bot digest, and card bypass', async () => {
  const omb = await startMockOmb([
    { id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true },
    { id: 'b2', name: 'Ops', threadId: 't2', chiefOfStaff: false },
  ]);
  const sent = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-bridge-4-'));
  // 设定固定时刻 23:30，处于 quietHours (22:00 ~ 08:30)
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
      const reply = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: `${bot.name}: ${reqMsg.text}`, turnTerminal: true };
      messages.push(reply);
      jobs.set(threadId, { state: 'completed', version: `v_${reqMsg.id}`, needsInput: [] });
      broadcast({ kind: 'message', threadId, message: reply });
    }, 15);
  });

  try {
    await bridge.start();

    // 1. 夜间静默时段内：主动 Routine 通知先排队暂存（不立即打扰）
    const p1 = { id: 'pro_1', role: 'bot', kind: 'text', threadId: 't2', text: '巡检完成：今日 0 异常', turnTerminal: true };
    omb.broadcast({ kind: 'message', threadId: 't2', message: p1 });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(sent.length, 0);
    assert.equal(bridge.status().quietPending, 1);

    // 2. 但审批卡片即便在夜间也必须穿透直达手机
    const pCard = { id: 'pro_c1', role: 'bot', kind: 'text', threadId: 't2', card: { requestId: 'req_pro', title: '确认重启服务' } };
    omb.broadcast({ kind: 'message', threadId: 't2', message: pCard });
    await until(() => sent.length === 1);
    assert.match(sent[0].text, /确认重启服务/);

    // 3. @bot digest 立即汇总静默积压
    await transport.emitUser('@bot digest');
    await until(() => sent.length === 2);
    assert.match(sent[1].text, /免打扰期间汇总（1 条）[\s\S]*Ops[\s\S]*巡检完成/);
    assert.equal(bridge.status().quietPending, 0);

    // 4. 切到白天 10:00：主动通知直接带 🔔 推到手机，同一 msg.id 的 patch 不重复推，且可直接引用回复
    curNow = new Date(2026, 10, 19, 10, 0, 0).getTime();
    const p2 = { id: 'pro_2', role: 'bot', kind: 'text', threadId: 't2', text: 'CI 构建已修复通过', turnTerminal: true };
    omb.broadcast({ kind: 'message', threadId: 't2', message: p2 });
    omb.broadcast({ kind: 'message.patch', threadId: 't2', message: p2 });
    await until(() => sent.length === 3);
    assert.match(sent[2].text, /^🔔 \*\*\[Ops\]\*\*[\s\S]*CI 构建已修复通过/);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(sent.length, 3, '同一主动消息 id 不得重复推送');

    // 直接引用主动通知气泡，顺着发给 Ops Bot
    await transport.emitUser('帮我看下耗时', { replyTo: sent[2].id });
    await until(() => sent.length === 4);
    assert.match(sent[3].text, /\*\*\[Ops\]\*\*[\s\S]*Ops: 帮我看下耗时/);
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('openmausbot bridge: @bot new, @bot compact, and returning bot-generated images & files to IM', async () => {
  const omb = await startMockOmb([
    { id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true },
  ]);
  const sent = [];
  const filesSent = [];
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

    // 1. @bot new（无参数）开启空白新线程
    await transport.emitUser('@bot new');
    await until(() => sent.length === 1);
    assert.equal(omb.tasksCreated.length, 1);
    assert.match(sent[0].text, /开启新会话/);

    // 2. @bot new 带需求：开新线程并立刻发送该需求，同时检验 Bot 生成截图 + CSV 文件回传
    await transport.emitUser('@bot new 生成日报和截图');
    await until(() => sent.length === 2 && filesSent.length === 2);
    assert.equal(omb.tasksCreated.length, 2);
    assert.match(sent[1].text, /已在新线程处理：生成日报和截图/);
    assert.equal(omb.sentToOmb[0].threadId, 'b1_task_2');
    assert.ok(filesSent.some((f) => f.buf.equals(pngBytes) && f.name.endsWith('.png')));
    assert.ok(filesSent.some((f) => f.name === 'report.csv' && f.content.includes('1,ok')));

    // 3. @bot compact 压缩当前线程上下文
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
  const sent = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-bridge-pair-'));
  const client = new OpenMausBotClient({ baseUrl: omb.baseUrl, token: 'omb_sess_old' });
  const bridge = new OpenMausBotBridge({ client, transport, dataDir });

  omb.setScenario(({ bot, reqMsg, threadId, messages, jobs, broadcast, nextId }) => {
    setTimeout(() => {
      const reply = { id: nextId(), role: 'bot', kind: 'text', threadId, requestMessageId: reqMsg.id, text: `${bot.name}: ${reqMsg.text}`, turnTerminal: true };
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

    client.setToken(paired.token);
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
  const sent = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-bridge-unpaired-'));
  const bridge = new OpenMausBotBridge({ client: new OpenMausBotClient({ baseUrl: omb.baseUrl }), transport, dataDir });

  try {
    await bridge.start();
    await transport.emitUser('@bot hello');
    await until(() => sent.length === 1);
    assert.match(sent[0].text, /发送给 \*\*MausBot\*\* 失败/);
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

    const firstPoll = await client.pollCliLogin(started.id, { verifier });
    assert.equal(firstPoll.state, 'waiting');

    omb.approveCliLogin(started.id);
    const secondPoll = await client.pollCliLogin(started.id, { verifier });
    assert.equal(secondPoll.state, 'allowed');
    assert.equal(secondPoll.token, validToken);

    client.setToken(secondPoll.token);
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
  const sent = [];
  const filesSent = [];
  const downloadData = new Map([['att_up', Buffer.from('log line\n')]]);
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
    const upErr = sent.find((m) => m.text.includes('附件 debug.log 上传失败'));
    assert.match(upErr.text, /npm run pair --/);
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('cross-platform: patchBot, downloadMessageFile path basename on Windows/POSIX, check --fix-cli', async () => {
  const omb = await startMockOmb(
    [{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true, computer: 'local' }],
    { desktopManaged: false },
  );
  const csv = Buffer.from('a,b\n1,2\n', 'utf8');
  omb.setMedia('m1', 'C:\\out\\report.csv', { buf: csv, mime: 'text/csv' });
  omb.setMedia('m1', '/tmp/out/report.csv', { buf: csv, mime: 'text/csv' });

  const client = new OpenMausBotClient({ baseUrl: omb.baseUrl });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-check-cli-'));
  const tmpCfg = path.join(tmpDir, 'config.json');
  fs.writeFileSync(tmpCfg, JSON.stringify({ transport: 'sim', openmausbot: { url: omb.baseUrl }, dataDir: path.join(tmpDir, 'data') }));

  try {
    const winRes = await client.downloadMessageFile('t1', 'm1', 'C:\\out\\report.csv');
    const posixRes = await client.downloadMessageFile('t1', 'm1', '/tmp/out/report.csv');
    assert.equal(winRes.name, 'report.csv');
    assert.equal(posixRes.name, 'report.csv');

    const p1 = await client.patchBot('b1', { computer: 'off' });
    assert.equal(p1.bot.computer, 'off');
    await client.patchBot('b1', { computer: 'local' });

    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(APP_ROOT, 'scripts', 'check.js'), '--fix-cli', '--omb', omb.baseUrl, '--config', tmpCfg],
      { cwd: os.tmpdir() },
    );
    assert.match(stdout, /CLI 模式/);
    assert.match(stdout, /computer 设为 off/);

    const after = await client.listBots();
    assert.equal(after.bots[0].computer, 'off');
  } finally {
    await omb.close();
  }
});

test('scripts/daemon.js: cross-platform start, status, and stop lifecycle', async () => {
  const omb = await startMockOmb([{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true }]);
  const port = await getFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-daemon-'));
  const tmpCfg = path.join(tmpDir, 'config.json');
  const dataDir = path.join(tmpDir, 'data');
  fs.writeFileSync(tmpCfg, JSON.stringify({
    openmausbot: { url: omb.baseUrl },
    transport: 'sim',
    web: { host: '127.0.0.1', port },
    dataDir,
  }));

  const daemonScript = path.join(APP_ROOT, 'scripts', 'daemon.js');
  try {
    const startRes = await execFileAsync(process.execPath, [daemonScript, 'start', '--config', tmpCfg], { cwd: os.tmpdir() });
    assert.match(startRes.stdout, /已启动/);

    const h = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json());
    assert.equal(h.ok, true);

    const statusRes = await execFileAsync(process.execPath, [daemonScript, 'status', '--config', tmpCfg], { cwd: os.tmpdir() });
    assert.match(statusRes.stdout, /运行中/);
  } finally {
    await execFileAsync(process.execPath, [daemonScript, 'stop', '--config', tmpCfg], { cwd: os.tmpdir() }).catch(() => {});
    assert.equal(fs.existsSync(path.join(dataDir, 'cobot.pid')), false);
    await omb.close();
  }
});

test('scripts/omb.js: isLoopbackUrl, bundled node_modules discovery, and ensureOpenMausBot CLI computer=off alignment', async () => {
  assert.equal(isLoopbackUrl('http://127.0.0.1:8799'), true);
  assert.equal(isLoopbackUrl('http://localhost:8799'), true);
  assert.equal(isLoopbackUrl('http://10.0.0.5:8799'), false);

  const found = findOpenMausBotServer();
  assert.equal(found?.kind, 'node');
  assert.ok(fs.existsSync(found.entry));
  assert.ok(found.staticDir && fs.existsSync(path.join(found.staticDir, 'index.html')));
  assert.ok(found.skillsDir && fs.existsSync(found.skillsDir));

  const omb = await startMockOmb(
    [{ id: 'b1', name: 'MausBot', threadId: 't1', chiefOfStaff: true, computer: 'local' }],
    { desktopManaged: false },
  );
  const client = new OpenMausBotClient({ baseUrl: omb.baseUrl });
  const logs = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-ensure-'));

  try {
    // 1. cliComputerOff: false 时不修改 computer
    const res1 = await ensureOpenMausBot(
      { openmausbot: { url: omb.baseUrl, autoStart: true, cliComputerOff: false }, dataDir },
      { log: (s) => logs.push(s) },
    );
    assert.deepEqual(res1, { running: true, started: false });
    assert.equal((await client.listBots()).bots[0].computer, 'local');

    // 2. 默认 cliComputerOff: true 自动将 CLI 模式主 Bot 设为 off
    const res2 = await ensureOpenMausBot(
      { openmausbot: { url: omb.baseUrl, autoStart: true, cliComputerOff: true }, dataDir },
      { log: (s) => logs.push(s) },
    );
    assert.deepEqual(res2, { running: true, started: false });
    assert.equal((await client.listBots()).bots[0].computer, 'off');
    assert.ok(logs.some((l) => l.includes('computer 设为 off')));
  } finally {
    await omb.close();
  }
});

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
    assert.match(sent.at(-1).text, /^\*\*\[MausBot\]\*\*/, 'hideChiefPrefix=false 时应保留主 Bot 前缀');

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

    // 3. @bot style grok / default 调 patchBot 更新 replyStyle + soul
    await transport.emitUser('@bot style grok');
    await until(() => sent.some((m) => m.text.includes('已为 **MausBot** 应用手机私聊风格')));
    assert.equal(omb.bots[0].replyStyle, 'conversational');
    assert.ok(omb.bots[0].soul.includes('Grok Bot'));

    await transport.emitUser('@bot style default');
    await until(() => sent.some((m) => m.text.includes('恢复为 OpenMausBot 默认风格')));
    assert.equal(omb.bots[0].replyStyle, 'default');
    assert.equal(omb.bots[0].soul, '');

    // 4. WebSimTransport 支持将 actions 透传到 SSE 流
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

test('P1 commands: @bot context & >80% warning, @bot search jump, @bot export, @bot model, @bot routines, @bot memory', async () => {
  const omb = await startMockOmb(
    [
      {
        id: 'b1',
        name: 'MausBot',
        threadId: 't1',
        chiefOfStaff: true,
        modelSelection: { instanceId: 'opencodeGo', model: 'deepseek/deepseek-flash' },
        tasks: [
          { threadId: 't1', title: '主研发任务', updatedAt: 200, usage: { turns: 5, context: { tokens: 85_000, window: 100_000 } } },
          { threadId: 't_hist', title: '支付排障历史', updatedAt: 100, usage: { turns: 2, context: { tokens: 10_000, window: 100_000 } } },
        ],
      },
    ],
    {
      instances: [
        {
          instanceId: 'opencodeGo',
          snapshot: { state: 'available' },
          models: {
            options: [
              { id: 'deepseek/deepseek-flash', label: 'DeepSeek Flash', variants: [{ id: 'low' }, { id: 'high' }] },
              { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', variants: [{ id: 'low' }, { id: 'high' }] },
            ],
          },
        },
      ],
      routines: [
        { id: 'r1', name: '晨间巡检', enabled: true, schedule: { type: 'interval', everyMinutes: 30 } },
      ],
      initialMemory: '- 回复简短优先\n',
      memoryTopics: [{ name: 'projects.md', path: 'memory/projects.md' }],
    },
  );
  omb.messages.set('t_hist', [{ id: 'm_h1', role: 'bot', kind: 'text', threadId: 't_hist', text: '支付回调超时排查结论' }]);

  const sent = [];
  const filesSent = [];
  const transport = makeIm(sent, filesSent);
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

    // 3. @bot model 列模型 + 数字切换 + 深度切换 high
    await transport.emitUser('@bot model');
    await until(() => sent.some((m) => m.text.includes('deepseek/deepseek-v4-pro')));
    await transport.emitUser('2');
    await until(() => sent.some((m) => m.text.includes('切换为 `deepseek/deepseek-v4-pro`')));
    assert.equal(omb.taskPatches.at(-1)?.body?.modelSelection?.model, 'deepseek/deepseek-v4-pro');

    await transport.emitUser('@bot model high');
    await until(() => sent.some((m) => m.text.includes('deepseek/deepseek-v4-pro · high')));
    assert.equal(omb.taskPatches.at(-1)?.body?.modelSelection?.variant, 'high');

    // 4. @bot routines 列定时任务 + run + off
    await transport.emitUser('@bot routines');
    await until(() => sent.some((m) => m.text.includes('晨间巡检') && m.text.includes('每 30 分钟')));
    await transport.emitUser('@bot routines run 1');
    await until(() => sent.some((m) => m.text.includes('已触发定时任务')));
    assert.deepEqual(omb.routineRuns, ['r1']);
    await transport.emitUser('@bot routines off 1');
    await until(() => sent.some((m) => m.text.includes('已暂停定时任务')));
    assert.equal(omb.routinePatches[0]?.body?.enabled, false);

    // 5. @bot memory 查看 + @bot 记住 写入长期记忆
    await transport.emitUser('@bot memory');
    await until(() => sent.some((m) => m.text.includes('回复简短优先') && m.text.includes('projects.md')));
    await transport.emitUser('@bot 记住 用中文总结代码变更');
    await until(() => sent.some((m) => m.text.includes('已记入 **MausBot** 的长期记忆')));
    assert.match(omb.memoryState.get('b1').text, /用中文总结代码变更/);

    // 6. @bot export 导出当前会话为 .md 附件
    await transport.emitUser('@bot export');
    await until(() => filesSent.length === 1 && sent.some((m) => m.text.includes('已导出')));
    assert.match(filesSent[0].content, /# 导出会话/);

    // 7. @bot search 搜索并按数字直跳目标会话
    await transport.emitUser('@bot search 支付回调');
    await until(() => sent.some((m) => m.text.includes('支付排障历史')));
    await transport.emitUser('1');
    await until(() => sent.some((m) => m.text.includes('已切换到 **MausBot** 的会话「支付排障历史」')));
    assert.equal(omb.tasksSelected.at(-1)?.threadId, 't_hist');
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

test('code review fixes: respond retry preserves pendingCard, picker mutual exclusion, tighter regexes, non-chief compact target, multi-bubble deliveredOmbIds', async () => {
  const omb = await startMockOmb(
    [
      {
        id: 'b1',
        name: 'MausBot',
        threadId: 't1',
        chiefOfStaff: true,
        modelSelection: { instanceId: 'opencodeGo', model: '' },
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

  const sent = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-review-'));
  const bridge = new OpenMausBotBridge({ client: new OpenMausBotClient({ baseUrl: omb.baseUrl }), transport, dataDir });

  try {
    await bridge.start();

    // 1. 审批卡提交遇到瞬时 500 时不得清空 pendingCards，再次回复 ok 仍可放行
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

    // 2. tasks 与 model 选择器互斥：先 @bot tasks 再 @bot model，回复 2 应切换模型而非切回旧会话
    await transport.emitUser('@bot model high');
    await until(() => sent.some((m) => m.text.includes('尚未选定模型')));
    await transport.emitUser('@bot tasks');
    await until(() => sent.some((m) => m.text.includes('备用会话')));
    await transport.emitUser('@bot model');
    await until(() => sent.some((m) => m.text.includes('deepseek/deepseek-v4-pro')));
    await transport.emitUser('2');
    await until(() => sent.some((m) => m.text.includes('切换为 `deepseek/deepseek-v4-pro`')));
    assert.equal(omb.tasksSelected.length, 0, 'model 命令激活后，输入数字不得误触之前的 tasks 选择器');

    // 3. 收紧中文正则：@bot 找 一下项目 bug 正常发给 Agent；@bot memory 删除 不静默回列表
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
    await until(() => sent.some((m) => m.text.includes('memory add <内容>')));

    // 4. 非主 Bot @Dev 的上下文提醒及按钮应指向 @Dev compact，且多段未下发回复全部记入 deliveredOmbIds
    const actionsLog = [];
    const baseSend = transport.send;
    transport.send = async (chatId, text, opts) => {
      if (opts?.actions) actionsLog.push(opts.actions);
      return baseSend.call(transport, chatId, text, opts);
    };
    await transport.emitUser('@Dev context');
    await until(() => sent.some((m) => m.text.includes('90%')));
    assert.equal(actionsLog.at(-1)?.[0]?.text, '@Dev compact');

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

    // 模拟未带 requestMessageId 的迟到 message.patch：m_multi_1 已被登记进 deliveredOmbIds，不得作为主动推送重发
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
  // 1. 连续 SSE 网络异常触发 autoHealOmb 且受冷却窗口约束
  let subCalls = 0;
  let healCalls = 0;
  let nowMs = 100_000;
  const mockClient = {
    async listBots() { return { bots: [] }; },
    async subscribeEvents(_onEvent, { signal, onError }) {
      while (!signal?.aborted) {
        subCalls += 1;
        onError?.(new Error('fetch failed: ECONNREFUSED'));
        await new Promise((r) => setTimeout(r, 15));
      }
    },
  };
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

  // 2. 401/403 认证失败绝不误触发 autoHealOmb
  let authHealCalls = 0;
  const authClient = {
    async listBots() { return { bots: [] }; },
    async subscribeEvents(_onEvent, { signal, onError }) {
      while (!signal?.aborted) {
        const err = new Error('unauthorized');
        err.status = 401;
        onError?.(err);
        await new Promise((r) => setTimeout(r, 15));
      }
    },
  };
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
  const sent = [];
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

    // 1. 两条快速中间口语合并为 1 条气泡；第 3 条触及 maxIntermediateBubbles=1 后暂存并于终态并入同一条最终回复
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

    // 2. 卡在审批卡片之前的中间消息（即使已触发 maxIntermediateBubbles 上限暂存），也应在卡片发出前冲刷上屏
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
  const sent = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-p3-skip-'));
  const bridge = new OpenMausBotBridge({ client: new OpenMausBotClient({ baseUrl: omb.baseUrl }), transport, dataDir });

  try {
    await bridge.start();
    await until(() => bridge.status().connected);

    // 1. Secret card -> 提示 skip/跳过；普通自聊不被吞；首跳 500 保留 pendingCards；二次 跳过 成功
    const sCard = { id: 'm_sec_1', role: 'bot', kind: 'secret', threadId: 't1', secret: { target: 'openai', label: 'OPENAI_API_KEY' } };
    omb.messages.get('t1').push(sCard);
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

    // 2. Connector card -> skip
    const cCard = { id: 'm_conn_1', role: 'bot', kind: 'connector', threadId: 't1', connector: { slug: 'github', label: 'GitHub' } };
    omb.messages.get('t1').push(cCard);
    omb.broadcast({ kind: 'message', threadId: 't1', message: cCard });
    await until(() => sent.some((m) => m.text.includes('GitHub') && m.text.includes('skip')));
    await transport.emitUser('skip');
    await until(() => omb.cardDismissals.length === 2);
    assert.deepEqual(omb.cardDismissals[1], { kind: 'connector', action: 'dismiss', botId: 'b1', messageId: 'm_conn_1', threadId: 't1' });

    // 3. SignIn card -> cancel
    const lCard = { id: 'm_login_1', role: 'bot', kind: 'signIn', threadId: 't1', signIn: { url: 'https://example.com' } };
    omb.messages.get('t1').push(lCard);
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

test('Phase 3 UX: Chinese spoken ordinals across question cards, @bot tasks, and @bot model', async () => {
  const omb = await startMockOmb(
    [
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
    ],
    {
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
  const sent = [];
  const transport = makeIm(sent);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-p3-ordinals-'));
  const bridge = new OpenMausBotBridge({ client: new OpenMausBotClient({ baseUrl: omb.baseUrl }), transport, dataDir });

  try {
    await bridge.start();

    // 1. 提问卡片回复 "第二个"
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

    // 2. @bot tasks 回复 "1个无关备忘" 不误触发；回复 "选二" 切换到第二个会话
    await transport.emitUser('@bot tasks');
    await until(() => sent.some((m) => m.text.includes('线上回归排查')));
    await transport.emitUser('1个无关备忘');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(omb.tasksSelected.length, 0);

    await transport.emitUser('选二');
    await until(() => sent.some((m) => m.text.includes('线上回归排查') && m.text.includes('已切换到')));
    assert.equal(omb.tasksSelected.at(-1)?.threadId, 't_old');

    // 3. @bot model 回复 "第 2 个" 切换模型
    await transport.emitUser('@bot model');
    await until(() => sent.some((m) => m.text.includes('deepseek/deepseek-v4-pro')));
    await transport.emitUser('第 2 个');
    await until(() => sent.some((m) => m.text.includes('切换为 `deepseek/deepseek-v4-pro`')));
    assert.equal(omb.taskPatches.at(-1)?.body?.modelSelection?.model, 'deepseek/deepseek-v4-pro');
  } finally {
    await bridge.stop();
    await omb.close();
  }
});

test('Phase 3 UX: multi-bot group room @<群名> dual-bot replies, quote continuation, tasks/new/steer/stop, and single-bot guard', async () => {
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
  const sent = [];
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

    // 1. @bot bots 同时列出可见 Bot 与协作群组
    await transport.emitUser('@bot bots');
    await until(() => sent.some((m) => m.text.includes('协作群组') && m.text.includes('架构组')));

    // 2. @架构组 对话：两个 Bot 在同一轮依次发言（turnTerminal: true 后第二个 Bot 仍能完整送达），且带上 [群名 · 发言Bot] 标签
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

    // 3. 引用群消息气泡续聊，继续路由到 /api/groups/g1/messages
    const qaBubble = sent.find((m) => m.text.includes('[架构组 · QA]'));
    await transport.emitUser('并发锁再测一遍', { replyTo: qaBubble.id });
    await until(() => omb.sentToOmb.length === 2 && sent.filter((m) => m.text.includes('并发锁再测一遍')).length >= 2);
    assert.equal(omb.sentToOmb[1]?.groupId, 'g1');

    // 等上一轮 watcher 彻底完成，再测群命令
    await until(() => bridge.status().activeTurns === 0);

    // 4. 单 Bot 专属指令对群返回清晰提示，不调错接口
    await transport.emitUser('@架构组 model');
    await until(() => sent.some((m) => m.text.includes('群组「架构组」不支持该单 Bot 指令')));

    // 5. @架构组 tasks + 中文序数切换，以及 @架构组 new <话题>
    await transport.emitUser('@架构组 tasks');
    await until(() => sent.some((m) => m.text.includes('性能优化')));
    await transport.emitUser('第二个');
    await until(() => sent.some((m) => m.text.includes('已切换到 **架构组** 的会话「性能优化」')));
    assert.equal(omb.tasksSelected.at(-1)?.groupId, 'g1');
    assert.equal(omb.tasksSelected.at(-1)?.threadId, 'gt_old');

    await transport.emitUser('@架构组 new 登录限流评审');
    await until(() => omb.tasksCreated.at(-1)?.groupId === 'g1' && sent.some((m) => m.text.includes('回归测试（登录限流评审）')));
    await until(() => bridge.status().activeTurns === 0);

    // 6. 忙时排队 -> @架构组 steer 与 @架构组 stop
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
