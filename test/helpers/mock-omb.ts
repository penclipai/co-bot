import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import type { BridgeTransport, OmbBot, OmbGroup, OmbMessage } from '../../src/openmausbot/types.ts';
import type { ChannelSendFileInput, ChannelSendOptions, InboundAttachment, InboundDevice, InboundEvent } from '../../src/types.ts';

export async function getFreePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

export const until = async (fn: () => boolean | Promise<boolean>, ms = 4000): Promise<void> => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail('timeout waiting for condition');
};

export interface MockJobState {
  state: string;
  version: string;
  needsInput: Array<{ requestId?: string }>;
}

export interface MockScenarioContext {
  bot?: OmbBot;
  group?: OmbGroup;
  reqMsg: OmbMessage;
  threadId: string;
  messages: OmbMessage[];
  jobs: Map<string, MockJobState>;
  broadcast: (payload: Record<string, unknown>) => void;
  nextId: () => string;
}

export interface StartMockOmbOpts {
  groups?: Array<Partial<OmbGroup> & { id: string; name: string; threadId: string }>;
  instances?: unknown[];
  respondFailCount?: number;
  dismissFailCount?: number;
  refuseRememberCommand?: boolean;
  desktopManaged?: boolean;
  validToken?: string;
  pairCode?: string;
  rejectSseStatus?: number;
  queueWhenBusy?: boolean;
  steerBlockedBy?: unknown;
}

export interface SentImItem {
  id: string;
  text: string;
  replyTo: string | null;
}

export interface SentImFileItem {
  id: string;
  name: string;
  buf: Buffer;
  content: string;
  replyTo: string | null;
}

/** 本地模拟 OpenMausBot Harness（HTTP + SSE + Card 审批 + Activity + 桌面端配对鉴权），不依赖外部服务。 */
export async function startMockOmb(
  botsSpec: Array<Partial<OmbBot> & { id: string; name: string; threadId: string }>,
  opts: StartMockOmbOpts = {},
) {
  const bots: OmbBot[] = botsSpec.map((b) => ({
    hidden: false, busy: false, activity: 'idle',
    modelSelection: { model: 'deepseek/deepseek-flash' },
    ...b,
  }));
  const groups: OmbGroup[] = Array.isArray(opts.groups)
    ? opts.groups.map((g) => ({ hidden: false, dm: false, busy: false, ...g }))
    : [];
  const messages = new Map<string, OmbMessage[]>();
  const jobs = new Map<string, MockJobState>();
  const initThread = (tid?: string): void => {
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
  const sseClients = new Set<http.ServerResponse>();
  const responds: Array<Record<string, unknown>> = [];
  const cardDismissals: Array<Record<string, unknown>> = [];
  const interrupts: Array<Record<string, unknown>> = [];
  const uploads: Array<Record<string, unknown>> = [];
  const sentToOmb: Array<Record<string, unknown>> = [];
  const tasksCreated: Array<Record<string, unknown>> = [];
  const tasksSelected: Array<Record<string, unknown>> = [];
  const steered: Array<Record<string, unknown>> = [];
  const cancelled: Array<Record<string, unknown>> = [];
  const compacts: Array<Record<string, unknown>> = [];
  let respondFailuresLeft = Number(opts.respondFailCount ?? 0);
  let dismissFailuresLeft = Number(opts.dismissFailCount ?? 0);
  const authHeaders: Array<{ method?: string; path: string; auth: string | null }> = [];
  const cliLogins = new Map<string, { id: string; code: string; label: string; verifierHash: string; state: string }>();
  const mediaFiles = new Map<string, { mime?: string; name?: string; buf: Buffer }>();
  let seq = 0;
  let msgSeq = 0;

  const broadcast = (payload: Record<string, unknown>): void => {
    seq += 1;
    const frame = `id: mock:${seq}\ndata: ${JSON.stringify({ ...payload, seq })}\n\n`;
    for (const res of sseClients) res.write(frame);
  };

  let scenario: ((ctx: MockScenarioContext) => void) | null = null;
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    authHeaders.push({ method: req.method, path: u.pathname, auth: req.headers.authorization ?? null });
    const json = (code: number, data: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const readBuf = async (): Promise<Buffer> => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      return Buffer.concat(chunks);
    };
    const readJson = async (): Promise<Record<string, unknown>> => {
      const raw = (await readBuf()).toString('utf8');
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
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
      cliLogins.set(id, { id, code: 'ABCD-2345', label: String(body.label || 'co-bot'), verifierHash: body.verifierHash, state: 'waiting' });
      return json(201, { id, code: 'ABCD-2345', expiresAt: Date.now() + 60_000, intervalMs: 50 });
    }
    let mLogin: RegExpExecArray | null;
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

    let m: RegExpExecArray | null;
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
      const b = bots.find((x) => x.id === m![1]);
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
      const kindMap: Record<string, string> = { 'secret-cards': 'secret', 'connector-cards': 'connector', 'sign-in-cards': 'signIn' };
      const kind = kindMap[m[2]];
      cardDismissals.push({ kind, action: m[4], botId: m[1], messageId: m[3], threadId: body.threadId });
      const threadId = String(body.threadId || '');
      const arr = messages.get(threadId) ?? [];
      const cardMsg = arr.find((x) => x.id === m![3]);
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
      if (cardMsg?.card) cardMsg.card.answered = true;
      const reqId = cardMsg?.requestMessageId;
      const finalMsg: OmbMessage = {
        id: `m${++msgSeq}`, role: 'bot', kind: 'text', threadId, requestMessageId: reqId,
        text: body.behavior === 'allow'
          ? '已执行命令，结果正常。'
          : (body.behavior === 'answer' && typeof body.message === 'string' && body.message
            ? `已采用方案：${body.message}`
            : '已按你的要求取消执行。'),
        turnTerminal: true,
      };
      arr.push(finalMsg);
      jobs.set(threadId, { state: 'completed', version: `v${++seq}`, needsInput: [] });
      broadcast({ kind: 'message', threadId, message: finalMsg });
      return json(200, { ok: true });
    }
    if (req.method === 'POST' && (m = /^\/api\/bots\/([^/]+)\/tasks\/([^/]+)$/.exec(u.pathname))) {
      const bot = bots.find((x) => x.id === m![1]);
      if (!bot) return json(404, { error: 'no such bot' });
      const task = (bot.tasks ?? []).find((t) => (t.threadId ?? t.id) === m![2]);
      if (!task && m[2] !== bot.threadId) return json(404, { error: 'no such task' });
      bot.threadId = m[2];
      initThread(m[2]);
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
      const bot = bots.find((x) => x.id === m![1]);
      if (!bot) return json(404, { error: 'no such bot' });
      const body = await readJson();
      Object.assign(bot, body);
      return json(200, { bot });
    }
    if (req.method === 'POST' && (m = /^\/api\/bots\/([^/]+)\/tasks$/.exec(u.pathname))) {
      const bot = bots.find((x) => x.id === m![1]);
      if (!bot) return json(404, { error: 'no such bot' });
      const body = await readJson();
      const tid = `${bot.id}_task_${tasksCreated.length + 1}`;
      messages.set(tid, []);
      jobs.set(tid, { state: 'idle', version: `v${++seq}`, needsInput: [] });
      if (body.select !== false) bot.threadId = tid;
      const task = { id: tid, threadId: tid, title: String(body.title || 'New task') };
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
      res.end(item.buf);
      return;
    }
    if (req.method === 'POST' && (m = /^\/api\/threads\/([^/]+)\/messages\/([^/]+)\/file$/.exec(u.pathname))) {
      const body = await readJson();
      const item = mediaFiles.get(`${m[2]}:${String(body.path || '')}`);
      if (!item) return json(404, { error: 'no file' });
      res.writeHead(200, {
        'content-type': item.mime || 'text/plain',
        ...(item.name ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}` } : {}),
      });
      res.end(item.buf);
      return;
    }
    if (req.method === 'POST' && (m = /^\/api\/bots\/([^/]+)\/messages$/.exec(u.pathname))) {
      const bot = bots.find((x) => x.id === m![1]);
      if (!bot) return json(404, { error: 'no such bot' });
      const body = await readJson();
      const threadId = String(body.threadId || bot.threadId);
      sentToOmb.push({ botId: bot.id, threadId, text: body.text, sendId: body.sendId });
      if (opts.queueWhenBusy && jobs.get(threadId)?.state === 'running') {
        const queueId = `q_${++msgSeq}`;
        return json(202, { ok: true, queued: true, queueId, threadId });
      }
      const reqMsg: OmbMessage & { replyToId?: unknown } = {
        id: `u${++msgSeq}`, role: 'user', kind: 'text', threadId,
        text: String(body.text || ''), sendId: body.sendId ? String(body.sendId) : undefined, replyToId: body.replyToId ?? null,
      };
      if (!messages.has(threadId)) messages.set(threadId, []);
      messages.get(threadId)!.push(reqMsg);
      jobs.set(threadId, { state: 'running', version: `v${++seq}`, needsInput: [] });
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, threadId, message: reqMsg }));
      if (scenario) scenario({ bot, reqMsg, threadId, messages: messages.get(threadId)!, jobs, broadcast, nextId: () => `m${++msgSeq}` });
      return;
    }
    if (req.method === 'POST' && (m = /^\/api\/groups\/([^/]+)\/messages$/.exec(u.pathname))) {
      const group = groups.find((g) => g.id === m![1]);
      if (!group) return json(404, { error: 'no such group' });
      const body = await readJson();
      const threadId = String(body.threadId || group.threadId);
      sentToOmb.push({ groupId: group.id, threadId, text: body.text, sendId: body.sendId, replyToId: body.replyToId ?? null });
      if (opts.queueWhenBusy && jobs.get(threadId)?.state === 'running') {
        const queueId = `gq_${++msgSeq}`;
        return json(202, { ok: true, queued: true, queueId, threadId });
      }
      const reqMsg: OmbMessage & { replyToId?: unknown } = {
        id: `u${++msgSeq}`, role: 'user', kind: 'text', threadId,
        text: String(body.text || ''), sendId: body.sendId ? String(body.sendId) : undefined, replyToId: body.replyToId ?? null,
      };
      if (!messages.has(threadId)) messages.set(threadId, []);
      messages.get(threadId)!.push(reqMsg);
      jobs.set(threadId, { state: 'running', version: `v${++seq}`, needsInput: [] });
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, threadId, message: reqMsg }));
      if (scenario) scenario({ group, reqMsg, threadId, messages: messages.get(threadId)!, jobs, broadcast, nextId: () => `m${++msgSeq}` });
      return;
    }
    if (req.method === 'POST' && (m = /^\/api\/groups\/([^/]+)\/interrupt$/.exec(u.pathname))) {
      const group = groups.find((g) => g.id === m![1]);
      if (!group) return json(404, { error: 'no such room' });
      const body = await readJson();
      const tid = String(body.threadId || group.threadId);
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
      const group = groups.find((g) => g.id === m![1]);
      if (!group) return json(404, { error: 'no such channel' });
      const body = await readJson();
      const tid = `${group.id}_task_${tasksCreated.length + 1}`;
      messages.set(tid, []);
      jobs.set(tid, { state: 'idle', version: `v${++seq}`, needsInput: [] });
      group.threadId = tid;
      const task = { id: tid, threadId: tid, title: String(body.title || 'New group task') };
      group.tasks = [...(group.tasks ?? []), task];
      tasksCreated.push({ groupId: group.id, ...task });
      return json(201, { group, task });
    }
    if (req.method === 'POST' && (m = /^\/api\/groups\/([^/]+)\/tasks\/([^/]+)$/.exec(u.pathname))) {
      const group = groups.find((g) => g.id === m![1]);
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

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
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
    approveCliLogin(id: string) {
      const entry = cliLogins.get(id);
      if (entry) entry.state = 'allowed';
    },
    setMedia(msgId: string, key: string, val: { mime?: string; name?: string; buf: Buffer }) {
      mediaFiles.set(`${msgId}:${key}`, val);
    },
    setScenario(fn: ((ctx: MockScenarioContext) => void) | null) { scenario = fn; },
    close: async () => {
      for (const c of sseClients) c.end();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export interface MakeImOpts {
  device?: InboundDevice;
  replyTo?: string;
  attachments?: InboundAttachment[];
}

export type MockImTransport = BridgeTransport & {
  emitUser: (text: string, opts?: MakeImOpts) => Promise<void>;
};

export function makeIm(
  sentList: SentImItem[],
  filesSent: SentImFileItem[] = [],
  downloadData: Map<string, string | Buffer> = new Map(),
): MockImTransport {
  let handler: ((ev: InboundEvent) => unknown) | null = null;
  let seq = 0;
  return {
    selfChatId: 'self',
    canFiles: true,
    async start(fn) { handler = fn; },
    async stop() {},
    async send(_chatId: string, text: string, opts?: ChannelSendOptions) {
      const id = `im${++seq}`;
      sentList.push({ id, text, replyTo: opts?.replyTo ?? null });
      return id;
    },
    async sendFile(_chatId: string, file: ChannelSendFileInput, opts?: ChannelSendOptions) {
      const id = `imf${++seq}`;
      const buf = fs.readFileSync(file.path);
      filesSent.push({ id, name: file.name, buf, content: buf.toString('utf8'), replyTo: opts?.replyTo ?? null });
      return id;
    },
    async download(att: InboundAttachment, savePath: string) {
      const data = downloadData.get(att.id);
      if (!data) throw new Error('missing file');
      fs.mkdirSync(path.dirname(savePath), { recursive: true });
      fs.writeFileSync(savePath, data);
    },
    async emitUser(text: string, opts: MakeImOpts = {}) {
      await handler?.({
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
