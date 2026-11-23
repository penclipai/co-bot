import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeInboundEvent } from '../core/channel-contract.js';

/**
 * 通用 IM IPC 传输适配器。
 * 只需在 config.json 配置 ipc.client 指向本地 client 模块并导出：
 *
 *   export async function connect(onMessage, { onDisconnect } = {})
 *   export async function send({ chatId, text, quoteMsgId })          -> { msgId }
 *   export async function sendFile({ chatId, filePath, fileName, quoteMsgId }) -> { msgId }（可选）
 *   export async function download({ msgId, fileId, savePath })       （可选）
 *   export async function close()                                     （可选）
 *
 * FlatMessage 字段约定：
 *   msgId, chatId, chatType ('self'|'single'|'group'|'system'), chatName?,
 *   fromId, fromName?, fromDevice? ({ id, type: 'mobile'|'desktop'|'pad'|'web', name? }),
 *   text, atUserIds?, atAll?, quoteMsgId?, time?, files? ([{ fileId, name, size?, mime? }])
 */
export class IpcTransport {
  constructor(opts = {}) {
    this.opts = opts;
    this.selfId = String(opts.selfId ?? '');
    this.selfChatId = opts.selfChatId ? String(opts.selfChatId) : '';
    this.client = opts.clientModule ?? null;
    this.reconnectDelayMs = Number(opts.reconnectDelayMs ?? 2000);
    this.maxReconnectDelayMs = Number(opts.maxReconnectDelayMs ?? 30_000);
    this.connected = false;
    this.lastError = null;
    this.reconnectAttempts = 0;
    this.stopped = false;
    this.reconnecting = false;
    this.reconnectTimer = null;
    this.onEvent = null;
  }

  status() {
    return {
      kind: 'ipc',
      connected: this.connected,
      selfChatId: this.selfChatId || null,
      lastError: this.lastError,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  async #connectClient() {
    if (this.stopped) return;
    await this.client.connect(
      (m) => {
        try {
          const ev = this.toEvent(m);
          if (ev.chat.type === 'self' && !this.selfChatId) this.selfChatId = ev.chat.id;
          Promise.resolve(this.onEvent?.(ev)).catch((e) => {
            console.error('[ipc] 处理入站事件异常：', e?.message || e);
          });
        } catch (e) {
          console.error('[ipc] 无法识别的消息，已跳过：', e.message);
        }
      },
      { onDisconnect: (err) => this.#handleDisconnect(err) },
    );
    if (this.stopped) {
      await this.client?.close?.().catch?.(() => {});
      return;
    }
    this.connected = true;
    this.lastError = null;
    this.reconnectAttempts = 0;
  }

  #handleDisconnect(err) {
    if (this.stopped || this.reconnecting) return;
    this.connected = false;
    this.lastError = err?.message || String(err || 'disconnected');
    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    if (this.stopped || this.reconnecting || this.reconnectTimer || !(this.reconnectDelayMs > 0)) return;
    const delay = Math.min(this.maxReconnectDelayMs, this.reconnectDelayMs * (2 ** Math.min(this.reconnectAttempts, 4)));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.reconnecting = true;
      let shouldRetry = false;
      try {
        await this.client?.close?.().catch?.(() => {});
        if (!this.stopped) await this.#connectClient();
      } catch (e) {
        if (!this.stopped) {
          this.connected = false;
          this.lastError = e?.message || String(e);
          shouldRetry = true;
        }
      } finally {
        this.reconnecting = false;
      }
      if (shouldRetry && !this.stopped) this.#scheduleReconnect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  async start(onEvent) {
    if (!this.selfId) throw new Error('config.json 的 ipc.selfId 没填（你在 IM 里的用户 id）');
    this.stopped = false;
    this.onEvent = onEvent;
    if (!this.client) {
      if (!this.opts.client) throw new Error('config.json 的 ipc.client 没填：请指向你的 ipc-client.js（见 ipc-client.example.js）');
      this.client = await import(pathToFileURL(path.resolve(this.opts.client)).href);
    }
    await this.#connectClient();
  }

  /** FlatMessage → InboundEvent */
  toEvent(m) {
    return normalizeInboundEvent(m, {
      selfId: this.selfId,
      selfChatId: this.selfChatId,
      atAllCountsAsMention: Boolean(this.opts.atAllCountsAsMention),
    });
  }

  async send(chatId, text, { replyTo } = {}) {
    if (!chatId) throw new Error('还不知道自聊会话 id：可在 config.json 的 ipc.selfChatId 填写，或先在自聊发一条消息');
    const r = await this.client.send({ chatId, text, quoteMsgId: replyTo });
    return r?.msgId != null ? String(r.msgId) : undefined;
  }

  get canFiles() { return typeof this.client?.sendFile === 'function'; }

  get canHistory() {
    return typeof this.client?.getHistory === 'function'
      || typeof this.client?.getMessage === 'function'
      || typeof this.client?.searchHistory === 'function';
  }

  get capabilities() {
    const hasFiles = this.canFiles;
    const hasHistory = this.canHistory;
    return {
      markdown: true,
      files: hasFiles,
      images: hasFiles,
      replyTo: true,
      actions: false,
      history: hasHistory,
      maxChars: 0,
      multiDevice: true,
      ...(this.opts.capabilities && typeof this.opts.capabilities === 'object' ? this.opts.capabilities : {}),
    };
  }

  async sendFile(chatId, { path: filePath, name }, { replyTo } = {}) {
    if (!this.canFiles) throw new Error('IPC client 没有实现 sendFile');
    const r = await this.client.sendFile({ chatId, filePath, fileName: name, quoteMsgId: replyTo });
    return r?.msgId != null ? String(r.msgId) : undefined;
  }

  async download(att, savePath) {
    if (typeof this.client?.download !== 'function') throw new Error('IPC client 没有实现 download');
    await this.client.download({ msgId: att.msgId, fileId: att.id, savePath });
  }

  async getMessage(chatId, msgId) {
    if (typeof this.client?.getMessage !== 'function') return null;
    const m = await this.client.getMessage({ chatId, msgId });
    return m ? this.toEvent(m) : null;
  }

  async getHistory(chatId, opts = {}) {
    if (typeof this.client?.getHistory !== 'function') return [];
    const list = await this.client.getHistory({ chatId, ...opts });
    if (!Array.isArray(list)) return [];
    return list.map((m) => {
      try { return this.toEvent(m); } catch { return null; }
    }).filter(Boolean);
  }

  async searchHistory(chatId, query, opts = {}) {
    if (typeof this.client?.searchHistory !== 'function') return [];
    const list = await this.client.searchHistory({ chatId, query, ...opts });
    if (!Array.isArray(list)) return [];
    return list.map((m) => {
      try { return this.toEvent(m); } catch { return null; }
    }).filter(Boolean);
  }

  async stop() {
    this.stopped = true;
    this.reconnecting = false;
    this.connected = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    await this.client?.close?.();
  }
}
