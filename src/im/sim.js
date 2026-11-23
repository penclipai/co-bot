import fs from 'node:fs';
import path from 'node:path';
import { pruneExpiredFiles, writeJsonAtomic } from '../format.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MIME = {
  '.md': 'text/markdown', '.html': 'text/html', '.txt': 'text/plain', '.log': 'text/plain', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
};
const mimeOf = (name) => MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
const DEVICES = { mobile: { id: 'iphone', type: 'mobile', name: 'iPhone' }, desktop: { id: 'pc', type: 'desktop', name: '办公电脑' } };
const SIM_CHATS = [
  { id: 'self', type: 'self', name: '自聊' },
  { id: 'grp_dev', type: 'group', name: '研发架构群' },
  { id: 'dm_alice', type: 'direct', name: 'Alice' },
];
const CHAT_META = new Map(SIM_CHATS.map((c) => [c.id, c]));
const SIM_SENDERS = {
  me: { id: 'me', name: '我', isSelf: true },
  alice: { id: 'alice', name: 'Alice', isSelf: false },
  bob: { id: 'bob', name: 'Bob', isSelf: false },
};

function chatMetaOf(chatId) {
  const id = String(chatId || 'self');
  return CHAT_META.get(id) ?? {
    id,
    type: id === 'self' ? 'self' : (id.startsWith('grp_') ? 'group' : 'direct'),
    name: id === 'self' ? '自聊' : id,
  };
}

/**
 * 网页自聊模拟器（本地浏览器访问 / 或 /sim），实现与 IpcTransport 相同的 Transport 契约。
 */
export class WebSimTransport {
  constructor({ web, filesDir, historyFile, fileRetentionDays = 7 }) {
    this.web = web;
    this.filesDir = filesDir;
    this.historyFile = historyFile === undefined ? path.join(path.dirname(filesDir), 'sim-history.json') : historyFile;
    this.fileRetentionDays = Number(fileRetentionDays ?? 7);
    this.files = new Map();
    this.selfChatId = 'self';
    this.history = [];
    this.clients = new Set();
    this.cleanupTimer = null;
    this.n = 0;
    this.boot = Date.now().toString(36);
  }

  #loadHistory() {
    if (this.fileRetentionDays > 0) {
      pruneExpiredFiles(this.filesDir, this.fileRetentionDays * DAY_MS);
    }
    if (!this.historyFile) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
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

  #saveHistory() {
    if (!this.historyFile) return;
    try {
      writeJsonAtomic(this.historyFile, {
        history: this.history.slice(-300),
        files: [...this.files.values()],
      });
    } catch { /* 历史保存失败不影响实时收发 */ }
  }

  async start(onEvent) {
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
      const chat = chatMetaOf(body.chatId);
      const sender = chat.type === 'self' ? SIM_SENDERS.me : (SIM_SENDERS[body.sender] ?? SIM_SENDERS.me);
      const device = DEVICES[body.device] ?? DEVICES.mobile;
      const mentions = Array.isArray(body.mentions) ? body.mentions.filter(Boolean) : [];
      const msg = {
        id: `${this.boot}u${++this.n}`,
        chatId: chat.id,
        chatType: chat.type,
        chatName: chat.name,
        from: sender.isSelf ? 'me' : 'other',
        senderId: sender.id,
        senderName: sender.name,
        isSelf: sender.isSelf,
        text,
        ts: Date.now(),
        replyTo: body.replyTo ?? null,
        device: sender.isSelf ? device.name : sender.name,
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
      const chat = chatMetaOf(body.chatId);
      const sender = chat.type === 'self' ? SIM_SENDERS.me : (SIM_SENDERS[body.sender] ?? SIM_SENDERS.me);
      const idx = this.history.findIndex((m) => String(m.chatId || 'self') === chat.id && String(m.id) === recalledMsgId);
      let removed = false;
      if (idx >= 0) {
        const [dropped] = this.history.splice(idx, 1);
        removed = true;
        if (dropped?.file?.id && !this.history.some((m) => m.file?.id === dropped.file.id)) {
          const gone = this.files.get(dropped.file.id);
          this.files.delete(dropped.file.id);
          if (gone?.path) {
            try { fs.rmSync(gone.path, { force: true }); } catch { /* ignore */ }
          }
        }
        this.#saveHistory();
      }
      const ts = Date.now();
      const notice = { kind: 'recall', chatId: chat.id, recalledMsgId, ts };
      for (const c of this.clients) c.write(`data: ${JSON.stringify(notice)}\n\n`);
      onEvent({
        id: `${this.boot}r${++this.n}`,
        kind: 'recall',
        ts,
        chat: { id: chat.id, type: chat.type, name: chat.name },
        sender,
        recalledMsgId,
        text: '',
      });
      return { ok: true, chatId: chat.id, recalledMsgId, removed };
    });

    web.route('POST', '/upload', ({ body }) => {
      const name = path.basename(String(body.name ?? '')).replace(/[\x00-\x1f]/g, '') || 'file';
      const rawB64 = String(body.data ?? '').replace(/^data:[^;]*;base64,/i, '');
      const buf = Buffer.from(rawB64, 'base64');
      if (!buf.length) throw new Error('空文件');
      const chat = chatMetaOf(body.chatId);
      const sender = chat.type === 'self' ? SIM_SENDERS.me : (SIM_SENDERS[body.sender] ?? SIM_SENDERS.me);
      const device = DEVICES[body.device] ?? DEVICES.mobile;
      const id = `${this.boot}u${++this.n}`;
      const file = this.#store(id, name, buf);
      const msg = {
        id,
        chatId: chat.id,
        chatType: chat.type,
        chatName: chat.name,
        from: sender.isSelf ? 'me' : 'other',
        senderId: sender.id,
        senderName: sender.name,
        isSelf: sender.isSelf,
        text: '',
        file: this.#card(file),
        ts: Date.now(),
        replyTo: body.replyTo ?? null,
        device: sender.isSelf ? device.name : sender.name,
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
      const f = this.files.get(params[1]);
      if (!f || !fs.existsSync(f.path)) { res.writeHead(404); return res.end('not found'); }
      if (f.mime === 'text/markdown' && url.searchParams.get('raw') !== '1') {
        res.writeHead(302, { location: `/view?f=${encodeURIComponent(f.id)}` });
        return res.end();
      }
      res.writeHead(200, {
        'content-type': `${f.mime}${f.mime.startsWith('text/') ? '; charset=utf-8' : ''}`,
        'cache-control': 'no-store',
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        ...(f.mime === 'text/html' ? { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:" } : {}),
      });
      fs.createReadStream(f.path).pipe(res);
    });
  }

  async send(chatId, text, { replyTo, actions } = {}) {
    const chat = chatMetaOf(chatId);
    const msg = {
      id: `${this.boot}b${++this.n}`,
      chatId: chat.id,
      chatType: chat.type,
      chatName: chat.name,
      from: 'bot',
      senderId: 'bot',
      senderName: 'MausBot',
      isSelf: true,
      text,
      ts: Date.now(),
      replyTo: replyTo ?? null,
      device: DEVICES.desktop.name,
      ...(Array.isArray(actions) && actions.length ? { actions } : {}),
    };
    this.#push(msg);
    return msg.id;
  }

  get canFiles() { return true; }

  get capabilities() {
    return {
      markdown: true,
      files: true,
      images: true,
      replyTo: true,
      actions: true,
      history: true,
      maxChars: 0,
      multiDevice: true,
    };
  }

  async sendFile(chatId, { path: src, name }, { replyTo } = {}) {
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
      senderName: 'MausBot',
      isSelf: true,
      text: '',
      file: this.#card(file),
      ts: Date.now(),
      replyTo: replyTo ?? null,
      device: DEVICES.desktop.name,
    });
    return id;
  }

  #toInboundEvent(m) {
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

  async getMessage(chatId, msgId) {
    const cid = String(chatId || 'self');
    const mid = String(msgId || '');
    const hit = this.history.find((m) => (m.chatId || 'self') === cid && String(m.id) === mid);
    return this.#toInboundEvent(hit);
  }

  async getHistory(chatId, { limit = 30, beforeMsgId = null } = {}) {
    const cid = String(chatId || 'self');
    const scoped = this.history.filter((m) => (m.chatId || 'self') === cid);
    let end = scoped.length;
    if (beforeMsgId) {
      const idx = scoped.findIndex((m) => String(m.id) === String(beforeMsgId));
      if (idx >= 0) end = idx;
    }
    const max = Math.max(1, Math.min(100, Number(limit) || 30));
    return scoped.slice(Math.max(0, end - max), end).map((m) => this.#toInboundEvent(m)).filter(Boolean);
  }

  async searchHistory(chatId, query, { limit = 10 } = {}) {
    const cid = String(chatId || 'self');
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return [];
    const max = Math.max(1, Math.min(50, Number(limit) || 10));
    const hits = [];
    for (let i = this.history.length - 1; i >= 0 && hits.length < max; i -= 1) {
      const m = this.history[i];
      if ((m.chatId || 'self') !== cid) continue;
      const hay = [m.text, m.senderName, m.file?.name].filter(Boolean).join('\n').toLowerCase();
      if (hay.includes(q)) {
        const ev = this.#toInboundEvent(m);
        if (ev) hits.push(ev);
      }
    }
    return hits;
  }

  async download(att, savePath) {
    const f = this.files.get(att.id);
    if (!f || !fs.existsSync(f.path)) throw new Error(`文件已过期：${att.name}`);
    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    fs.copyFileSync(f.path, savePath);
  }

  async stop() {
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
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

  #store(id, name, buf) {
    fs.mkdirSync(this.filesDir, { recursive: true });
    const fid = 'f' + id;
    const p = path.join(this.filesDir, fid + path.extname(name).toLowerCase().replace(/[^\w.]/g, ''));
    fs.writeFileSync(p, buf);
    const f = { id: fid, path: p, name, size: buf.length, mime: mimeOf(name) };
    this.files.set(fid, f);
    return f;
  }

  #card(f) { return { id: f.id, name: f.name, size: f.size, mime: f.mime, url: `/files/${f.id}` }; }

  #push(msg) {
    this.history.push(msg);
    if (this.history.length > 300) {
      const dropped = this.history.shift();
      if (dropped?.file?.id && !this.history.some((m) => m.file?.id === dropped.file.id)) {
        const gone = this.files.get(dropped.file.id);
        this.files.delete(dropped.file.id);
        if (gone?.path) {
          try { fs.rmSync(gone.path, { force: true }); } catch { /* ignore */ }
        }
      }
    }
    this.#saveHistory();
    for (const c of this.clients) c.write(`data: ${JSON.stringify(msg)}\n\n`);
  }
}
