import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { pruneExpiredFiles, safeAttachmentName, writeJsonAtomic } from '../format.ts';
import type {
  ChannelAction,
  ChannelCapabilities,
  ChannelSendFileInput,
  ChannelSendOptions,
  ChatType,
  InboundAttachment,
  InboundDevice,
  InboundEvent,
  InboundMention,
  InboundSender,
} from '../types.ts';
import type { WebServer } from '../web/server.ts';

interface SimChatMeta {
  id: string;
  type: ChatType;
  name: string;
}

interface SimStoredFile {
  id: string;
  path: string;
  name: string;
  size: number;
  mime: string;
}

interface SimFileCard {
  id: string;
  name: string;
  size: number;
  mime: string;
  url: string;
}

interface SimHistoryItem {
  id: string;
  chatId: string;
  chatType: ChatType;
  chatName: string;
  from: 'me' | 'other' | 'bot';
  senderId: string;
  senderName: string;
  isSelf: boolean;
  text: string;
  file?: SimFileCard;
  ts: number;
  replyTo: string | null;
  device: string;
  mentions?: InboundMention[];
  actions?: ChannelAction[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MIME: Record<string, string> = {
  '.md': 'text/markdown', '.html': 'text/html', '.txt': 'text/plain', '.log': 'text/plain', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.csv': 'text/csv', '.gz': 'application/gzip', '.tar': 'application/x-tar',
};
const mimeOf = (name: string): string => MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
const DEVICES: Record<string, InboundDevice> = {
  mobile: { id: 'iphone', type: 'mobile', name: 'iPhone' },
  desktop: { id: 'pc', type: 'desktop', name: '办公电脑' },
};
const SIM_CHATS: SimChatMeta[] = [
  { id: 'self', type: 'self', name: '自聊' },
  { id: 'grp_dev', type: 'group', name: '研发架构群' },
  { id: 'dm_alice', type: 'direct', name: 'Alice' },
];
const CHAT_META = new Map(SIM_CHATS.map((c) => [c.id, c]));
const SIM_SENDERS: Record<string, InboundSender> = Object.assign(Object.create(null) as Record<string, InboundSender>, {
  me: { id: 'me', name: '我', isSelf: true },
  alice: { id: 'alice', name: 'Alice', isSelf: false },
  bob: { id: 'bob', name: 'Bob', isSelf: false },
});

function chatMetaOf(chatId: string): SimChatMeta {
  const id = String(chatId || 'self');
  return CHAT_META.get(id) ?? {
    id,
    type: id === 'self' ? 'self' : (id.startsWith('grp_') ? 'group' : 'direct'),
    name: id === 'self' ? '自聊' : id,
  };
}

function resolveSimChat(rawChatId: unknown): SimChatMeta {
  if (rawChatId === undefined) return chatMetaOf('self');
  if (typeof rawChatId !== 'string' || !rawChatId.trim()) {
    throw new Error('chatId 必须为非空字符串');
  }
  const clean = rawChatId.trim();
  if (clean === '__proto__' || clean === 'constructor' || clean === 'prototype') {
    throw new Error('非法 chatId');
  }
  return chatMetaOf(clean);
}

function resolveSimSender(rawSender: unknown, chat: SimChatMeta): InboundSender {
  let id: string;
  if (rawSender === undefined) {
    id = 'me';
  } else {
    if (typeof rawSender !== 'string' || !rawSender.trim()) {
      throw new Error('sender 必须为非空字符串');
    }
    id = rawSender.trim();
    if (id === '__proto__' || id === 'constructor' || id === 'prototype') {
      throw new Error('非法 sender');
    }
  }
  const sender: InboundSender = Object.hasOwn(SIM_SENDERS, id)
    ? SIM_SENDERS[id]
    : { id, name: id, isSelf: false };
  if (chat.type === 'self' && !sender.isSelf) {
    throw Object.assign(new Error('自聊会话仅允许本人(me)发送'), { status: 403 });
  }
  return sender;
}

/**
 * 网页自聊模拟器（本地浏览器访问 / 或 /sim），实现标准 IM 通道传输契约。
 */
export class WebSimTransport {
  web: WebServer;
  filesDir: string;
  historyFile: string | null;
  fileRetentionDays: number;
  botName: string;
  files: Map<string, SimStoredFile>;
  selfChatId: string;
  history: SimHistoryItem[];
  clients: Set<http.ServerResponse>;
  cleanupTimer: ReturnType<typeof setInterval> | null;
  n: number;
  boot: string;

  constructor({
    web,
    filesDir,
    historyFile,
    fileRetentionDays = 7,
    botName = 'co-bot',
  }: {
    web: WebServer;
    filesDir: string;
    historyFile?: string | null;
    fileRetentionDays?: number;
    botName?: string;
  }) {
    this.web = web;
    this.filesDir = filesDir;
    this.historyFile = historyFile === undefined ? path.join(path.dirname(filesDir), 'sim-history.json') : historyFile;
    this.fileRetentionDays = Number(fileRetentionDays ?? 7);
    this.botName = String(botName || 'co-bot').trim() || 'co-bot';
    this.files = new Map();
    this.selfChatId = 'self';
    this.history = [];
    this.clients = new Set();
    this.cleanupTimer = null;
    this.n = 0;
    this.boot = Date.now().toString(36);
  }

  #loadHistory(): void {
    if (this.fileRetentionDays > 0) {
      pruneExpiredFiles(this.filesDir, this.fileRetentionDays * DAY_MS);
    }
    if (!this.historyFile) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.historyFile, 'utf8')) as {
        files?: SimStoredFile[];
        history?: SimHistoryItem[];
      };
      if (Array.isArray(raw?.files)) {
        for (const f of raw.files) {
          if (f?.id && f?.path && fs.existsSync(f.path)) this.files.set(String(f.id), f);
        }
      }
      if (Array.isArray(raw?.history)) {
        this.history = raw.history
          .filter((m) => m && (!m.file || this.files.has(String(m.file.id))))
          .slice(-300);
      }
    } catch { /* 首次启动尚无历史文件 */ }
  }

  #saveHistory(): void {
    if (!this.historyFile) return;
    try {
      writeJsonAtomic(this.historyFile, {
        history: this.history.slice(-300),
        files: [...this.files.values()],
      });
    } catch { /* 历史保存失败不影响实时收发 */ }
  }

  async start(onEvent: (ev: InboundEvent) => unknown): Promise<void> {
    this.#loadHistory();
    if (this.fileRetentionDays > 0) {
      const ttlMs = this.fileRetentionDays * DAY_MS;
      this.cleanupTimer = setInterval(() => pruneExpiredFiles(this.filesDir, ttlMs), DAY_MS);
      this.cleanupTimer.unref?.();
    }
    const { web } = this;
    web.route('GET', '/api/sim/chats', () => ({ ok: true, chats: SIM_CHATS }));

    web.route('GET', '/events', ({ req, res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': ok\n\n'); // 历史为空时也立即冲刷响应头，避免 fetch/EventSource 首包等待心跳
      for (const m of this.history) res.write(`data: ${JSON.stringify(m)}\n\n`);
      this.clients.add(res);
      const hb = setInterval(() => res.write(': hb\n\n'), 20_000);
      req.on('close', () => { clearInterval(hb); this.clients.delete(res); });
    });

    web.route('POST', '/send', ({ body }) => {
      const text = String(body.text ?? '').trim();
      if (!text) throw new Error('空消息');
      const chat = resolveSimChat(body.chatId);
      const sender = resolveSimSender(body.sender, chat);
      const devKey = typeof body.device === 'string' && Object.hasOwn(DEVICES, body.device) ? body.device : 'mobile';
      const device = DEVICES[devKey];
      const mentions = Array.isArray(body.mentions) ? (body.mentions.filter(Boolean) as InboundMention[]) : [];
      const replyTo = body.replyTo != null ? String(body.replyTo) : null;
      const msg: SimHistoryItem = {
        id: `${this.boot}u${++this.n}`,
        chatId: chat.id,
        chatType: chat.type,
        chatName: chat.name,
        from: sender.isSelf ? 'me' : 'other',
        senderId: sender.id,
        senderName: sender.name ?? sender.id,
        isSelf: sender.isSelf,
        text,
        ts: Date.now(),
        replyTo,
        device: sender.isSelf ? (device.name ?? device.id) : (sender.name ?? sender.id),
        ...(mentions.length ? { mentions } : {}),
      };
      this.#push(msg);
      onEvent({
        id: msg.id,
        ts: msg.ts,
        chat: { id: chat.id, type: chat.type, name: chat.name },
        sender,
        device: sender.isSelf ? device : undefined,
        text,
        replyTo: msg.replyTo ?? undefined,
        ...(mentions.length ? { mentions } : {}),
      });
      return { ok: true, id: msg.id, chatId: chat.id };
    });

    web.route('POST', '/recall', ({ body }) => {
      const recalledMsgId = String(body.msgId ?? body.recalledMsgId ?? '').trim();
      if (!recalledMsgId) throw new Error('缺少撤回消息 ID（msgId）');
      const chat = resolveSimChat(body.chatId);
      const sender = resolveSimSender(body.sender, chat);
      const idx = this.history.findIndex((m) => String(m.chatId || 'self') === chat.id && String(m.id) === recalledMsgId);
      if (idx < 0) throw Object.assign(new Error('未找到待撤回消息'), { status: 404 });
      const target = this.history[idx];
      if (target.from === 'bot' || target.senderId !== sender.id) {
        throw Object.assign(new Error('无权撤回他人或助手消息'), { status: 403 });
      }
      const [dropped] = this.history.splice(idx, 1);
      this.#cleanupOrphanFile(dropped);
      this.#saveHistory();
      const ts = Date.now();
      const notice = { kind: 'recall', chatId: chat.id, recalledMsgId, ts };
      this.#broadcastSse(notice);
      onEvent({
        id: `${this.boot}r${++this.n}`,
        kind: 'recall',
        ts,
        chat: { id: chat.id, type: chat.type, name: chat.name },
        sender,
        recalledMsgId,
        text: '',
      });
      return { ok: true, chatId: chat.id, recalledMsgId, removed: true };
    });

    web.route('POST', '/upload', ({ body }) => {
      const rawBase = path.posix.basename(String(body.name ?? '').replace(/\\/g, '/').trim());
      if (!rawBase || rawBase === '.' || rawBase === '..') throw new Error('非法文件名');
      const name = safeAttachmentName(rawBase, 'file');
      const rawB64 = String(body.data ?? '')
        .replace(/^data:[^;]*;base64,/i, '')
        .replace(/\s+/g, '')
        .replace(/-/g, '+')
        .replace(/_/g, '/');
      if (!rawB64 || rawB64.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(rawB64)) {
        throw new Error('文件内容不是合法的 base64 编码');
      }
      const buf = Buffer.from(rawB64, 'base64');
      if (!buf.length) throw new Error('空文件');
      const chat = resolveSimChat(body.chatId);
      const sender = resolveSimSender(body.sender, chat);
      const devKey = typeof body.device === 'string' && Object.hasOwn(DEVICES, body.device) ? body.device : 'mobile';
      const device = DEVICES[devKey];
      const id = `${this.boot}u${++this.n}`;
      const file = this.#store(id, name, buf);
      const replyTo = body.replyTo != null ? String(body.replyTo) : null;
      const msg: SimHistoryItem = {
        id,
        chatId: chat.id,
        chatType: chat.type,
        chatName: chat.name,
        from: sender.isSelf ? 'me' : 'other',
        senderId: sender.id,
        senderName: sender.name ?? sender.id,
        isSelf: sender.isSelf,
        text: '',
        file: this.#card(file),
        ts: Date.now(),
        replyTo,
        device: sender.isSelf ? (device.name ?? device.id) : (sender.name ?? sender.id),
      };
      this.#push(msg);
      onEvent({
        id,
        ts: msg.ts,
        chat: { id: chat.id, type: chat.type, name: chat.name },
        sender,
        device: sender.isSelf ? device : undefined,
        text: '',
        replyTo: msg.replyTo ?? undefined,
        attachments: [{ id: file.id, msgId: id, name, size: buf.length, mime: file.mime }],
      });
      return { ok: true, id, chatId: chat.id, file: this.#card(file) };
    }, { limit: 12 * 1024 * 1024 });

    web.route('GET', /^\/files\/([\w-]+)$/, ({ res, params, url }) => {
      const fid = params?.[1] ?? '';
      const f = this.files.get(fid);
      if (!f || !fs.existsSync(f.path)) throw Object.assign(new Error('not found'), { status: 404 });
      if (f.mime === 'text/markdown' && url.searchParams.get('raw') !== '1') {
        res.writeHead(302, { location: `/view?f=${encodeURIComponent(f.id)}` });
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': `${f.mime}${f.mime.startsWith('text/') ? '; charset=utf-8' : ''}`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        ...(f.mime === 'text/html' ? { 'content-security-policy': "default-src 'none'; sandbox; script-src 'none'; style-src 'unsafe-inline'; img-src data:" } : {}),
      });
      fs.createReadStream(f.path).pipe(res);
    });
  }

  async send(chatId: string, text: string, { replyTo, actions }: ChannelSendOptions = {}): Promise<string> {
    const chat = chatMetaOf(chatId);
    const msg: SimHistoryItem = {
      id: `${this.boot}b${++this.n}`,
      chatId: chat.id,
      chatType: chat.type,
      chatName: chat.name,
      from: 'bot',
      senderId: 'bot',
      senderName: this.botName,
      isSelf: true,
      text,
      ts: Date.now(),
      replyTo: replyTo ?? null,
      device: DEVICES.desktop.name ?? '办公电脑',
      ...(Array.isArray(actions) && actions.length ? { actions } : {}),
    };
    this.#push(msg);
    return msg.id;
  }

  get canFiles(): boolean { return true; }

  get capabilities(): ChannelCapabilities {
    return {
      markdown: true,
      files: true,
      images: true,
      replyTo: true,
      actions: true,
      history: true,
      notify: false,
      maxChars: 0,
      multiDevice: true,
    };
  }

  async sendFile(chatId: string, { path: src, name }: ChannelSendFileInput, { replyTo }: ChannelSendOptions = {}): Promise<string> {
    const chat = chatMetaOf(chatId);
    const id = `${this.boot}b${++this.n}`;
    const file = this.#store(id, name, fs.readFileSync(src));
    this.#push({
      id,
      chatId: chat.id,
      chatType: chat.type,
      chatName: chat.name,
      from: 'bot',
      senderId: 'bot',
      senderName: this.botName,
      isSelf: true,
      text: '',
      file: this.#card(file),
      ts: Date.now(),
      replyTo: replyTo ?? null,
      device: DEVICES.desktop.name ?? '办公电脑',
    });
    return id;
  }

  #toInboundEvent(m: SimHistoryItem | undefined): InboundEvent | null {
    if (!m || !m.id) return null;
    const chat = chatMetaOf(m.chatId || 'self');
    const isBot = m.from === 'bot';
    const isSelf = isBot ? true : Boolean(m.isSelf ?? (m.from === 'me'));
    return {
      id: String(m.id),
      ts: Number(m.ts) || Date.now(),
      chat: { id: chat.id, type: chat.type, name: chat.name },
      sender: {
        id: isBot ? '__bot__' : String(m.senderId || m.from || (isSelf ? 'me' : 'other')),
        name: m.senderName || (isBot ? 'bot' : (isSelf ? '我' : '成员')),
        isSelf,
      },
      text: String(m.text ?? ''),
      replyTo: m.replyTo != null ? String(m.replyTo) : undefined,
      ...(m.file ? {
        attachments: [{
          id: String(m.file.id),
          msgId: String(m.id),
          name: String(m.file.name || 'file'),
          size: Number(m.file.size) || undefined,
          mime: m.file.mime,
        }],
      } : {}),
    };
  }

  async getMessage(chatId: string, msgId: string): Promise<InboundEvent | null> {
    const cid = String(chatId || 'self');
    const mid = String(msgId || '');
    const hit = this.history.find((m) => (m.chatId || 'self') === cid && String(m.id) === mid);
    return this.#toInboundEvent(hit);
  }

  async getHistory(chatId: string, { limit = 30, beforeMsgId = null }: { limit?: number; beforeMsgId?: string | null } = {}): Promise<InboundEvent[]> {
    const cid = String(chatId || 'self');
    const scoped = this.history.filter((m) => (m.chatId || 'self') === cid);
    let end = scoped.length;
    if (beforeMsgId) {
      const idx = scoped.findIndex((m) => String(m.id) === String(beforeMsgId));
      if (idx >= 0) end = idx;
    }
    const max = Math.max(1, Math.min(100, Number(limit) || 30));
    return scoped.slice(Math.max(0, end - max), end).map((m) => this.#toInboundEvent(m)).filter((x): x is InboundEvent => x !== null);
  }

  async download(att: InboundAttachment, savePath: string): Promise<void> {
    const f = this.files.get(att.id);
    if (!f || !fs.existsSync(f.path)) throw new Error(`文件已过期：${att.name}`);
    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    fs.copyFileSync(f.path, savePath);
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.#saveHistory();
    for (const c of this.clients) c.end();
  }

  status() {
    return {
      kind: 'sim',
      connected: true,
      selfChatId: this.selfChatId,
      clients: this.clients.size,
    };
  }

  #store(id: string, name: string, buf: Buffer): SimStoredFile {
    fs.mkdirSync(this.filesDir, { recursive: true });
    const fid = 'f' + id;
    const p = path.join(this.filesDir, fid + path.extname(name).toLowerCase().replace(/[^\w.]/g, ''));
    fs.writeFileSync(p, buf);
    const f: SimStoredFile = { id: fid, path: p, name, size: buf.length, mime: mimeOf(name) };
    this.files.set(fid, f);
    return f;
  }

  #card(f: SimStoredFile): SimFileCard {
    return { id: f.id, name: f.name, size: f.size, mime: f.mime, url: `/files/${f.id}` };
  }

  #cleanupOrphanFile(msg: SimHistoryItem | undefined): void {
    const fileId = msg?.file?.id;
    if (!fileId || this.history.some((m) => m.file?.id === fileId)) return;
    const gone = this.files.get(fileId);
    this.files.delete(fileId);
    if (gone?.path) {
      try { fs.rmSync(gone.path, { force: true }); } catch { /* ignore */ }
    }
  }

  #broadcastSse(payload: unknown): void {
    const chunk = `data: ${JSON.stringify(payload)}\n\n`;
    for (const c of [...this.clients]) {
      try {
        if (c.writableEnded || c.destroyed) {
          this.clients.delete(c);
          continue;
        }
        c.write(chunk);
      } catch {
        this.clients.delete(c);
      }
    }
  }

  #push(msg: SimHistoryItem): void {
    this.history.push(msg);
    if (this.history.length > 300) {
      this.#cleanupOrphanFile(this.history.shift());
    }
    this.#saveHistory();
    this.#broadcastSse(msg);
  }
}
