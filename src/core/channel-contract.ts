/**
 * 通用 IM 通道插件契约与托管基类（零依赖）：
 * 让 WebSim、IM IPC 或任意第三方 IM（飞书 / 企微 / 钉钉 / TG 等）通过统一接口接入 co-bot。
 */
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelCapabilityInput,
  ChannelDownloadContext,
  ChannelGetHistoryOptions,
  ChannelGetMessageOptions,
  ChannelIdPatterns,
  ChannelNotifyPayload,
  ChannelPluginSpec,
  ChannelSendFileInput,
  ChannelSendOptions,
  ChannelStatus,
  ChatType,
  InboundAttachment,
  InboundEvent,
  KernelPlugin,
  LinkCard,
  LoggerLike,
} from '../types.ts';
import {
  CHAT_TYPES,
  createInboundMessage,
  createRecallEvent,
  decodeScopedChatId,
  encodeScopedChatId,
  matchIdPattern,
  normalizeInboundEvent,
  validateConfigIdsAgainstPatterns,
  validateIdsAgainstPatterns,
  validateInboundEvent,
} from './channel-validation.ts';
import { isAudioAttachment, redactSecrets } from './chat-context.ts';

export {
  createInboundMessage,
  createRecallEvent,
  decodeScopedChatId,
  encodeScopedChatId,
  isAudioAttachment,
  normalizeInboundEvent,
  validateConfigIdsAgainstPatterns,
  validateIdsAgainstPatterns,
  validateInboundEvent,
};

type AnyRecord = Record<string, unknown>;

export interface ManagedChannelOptions {
  name?: string;
  capabilities?: ChannelCapabilityInput;
  adapter: ChannelAdapter;
  selfId?: string;
  selfChatId?: string;
  atAllCountsAsMention?: boolean;
  idPatterns?: ChannelIdPatterns;
  strictContract?: boolean;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  emitTelemetry?: ((type: string, data: Record<string, unknown>) => void) | null;
  logger?: LoggerLike;
}

/** 格式化微信/飞书等 IM 的链接卡片 / 转发摘要。 */
export function formatLinkCardSnippet(card: LinkCard | null | undefined): string {
  if (!card || typeof card !== 'object') return '';
  const title = redactSecrets(card.title || '').replace(/\s+/g, ' ').trim();
  const desc = redactSecrets(card.description || '').replace(/\s+/g, ' ').trim();
  const url = redactSecrets(card.url || '').trim();
  const source = redactSecrets(card.source || '').replace(/\s+/g, ' ').trim();
  if (!title && !url && !desc) return '';
  const parts: string[] = [];
  if (title) parts.push(`标题：${title}`);
  if (source) parts.push(`来源：${source}`);
  if (desc) parts.push(`摘要：${desc.length > 160 ? `${desc.slice(0, 160)}…` : desc}`);
  if (url) parts.push(`链接：${url}`);
  return `[转发卡片] ${parts.join(' | ')}`;
}

const DEFAULT_CAPABILITIES: Readonly<ChannelCapabilities> = Object.freeze({
  markdown: true,
  files: false,
  images: false,
  replyTo: true,
  actions: false,
  history: false,
  notify: false,
  maxChars: 0,
  multiDevice: false,
});

export function clipSummary(text: unknown, max = 120): string {
  const s = redactSecrets(text).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export interface TelemetryTransportLike {
  start?: (onEvent: (ev: InboundEvent) => unknown) => unknown;
  send?: (chatId: string, text: string, opts?: ChannelSendOptions) => Promise<string | undefined>;
  sendFile?: (chatId: string, file: ChannelSendFileInput, opts?: ChannelSendOptions) => Promise<string | undefined>;
}

/** 为直连型传输适配器（如 WebSimTransport / 第三方通道插件）挂载统一脱敏遥测埋点，不改原返回值结构。 */
export function attachTransportTelemetry<T extends TelemetryTransportLike>(
  transport: T,
  emit: (type: string, data: Record<string, unknown>) => void,
  name = transport?.constructor?.name || 'channel',
): T {
  if (!transport || typeof emit !== 'function') return transport;
  const origStart = transport.start?.bind(transport);
  const origSend = transport.send?.bind(transport);
  const origSendFile = transport.sendFile?.bind(transport);

  if (origStart) {
    transport.start = (onEvent) => origStart(async (ev) => {
      try {
        emit('channel:inbound', {
          channel: name,
          ts: Date.now(),
          msgId: ev?.id ?? null,
          chatId: ev?.chat?.id ?? null,
          chatType: ev?.chat?.type ?? null,
          isSelf: Boolean(ev?.sender?.isSelf),
          device: ev?.device?.type ?? null,
          hasAttachments: Boolean(ev?.attachments?.length),
          summary: ev?.kind === 'recall'
            ? `recall:${ev?.recalledMsgId || ''}`
            : clipSummary(ev?.text || (ev?.attachments?.length ? `[附件 x${ev.attachments.length}]` : '')),
        });
      } catch { /* ignore */ }
      return onEvent?.(ev);
    });
  }
  if (origSend) {
    transport.send = async (chatId, text, opts) => {
      const id = await origSend(chatId, text, opts);
      try {
        emit('channel:outbound', {
          channel: name,
          ts: Date.now(),
          kind: 'text',
          chatId: chatId ? String(chatId) : null,
          msgId: id ? String(id) : null,
          chars: String(text ?? '').length,
          summary: clipSummary(text),
        });
      } catch { /* ignore */ }
      return id;
    };
  }
  if (origSendFile) {
    transport.sendFile = async (chatId, file, opts) => {
      const id = await origSendFile(chatId, file, opts);
      try {
        emit('channel:outbound', {
          channel: name,
          ts: Date.now(),
          kind: 'file',
          chatId: chatId ? String(chatId) : null,
          msgId: id ? String(id) : null,
          summary: clipSummary(file?.name || pathBasename(file?.path)),
        });
      } catch { /* ignore */ }
      return id;
    };
  }
  return transport;
}

/** 根据插件声明与底层适配器方法合并标准化通道能力。 */
export function normalizeCapabilities(
  raw: ChannelCapabilityInput | null | undefined = {},
  adapter: Partial<ChannelAdapter> | null = null,
): ChannelCapabilities {
  const src = raw && typeof raw === 'object' ? raw : {};
  const hasSendFile = Boolean(adapter && typeof adapter.sendFile === 'function' && adapter.canFiles !== false);
  const hasHistory = Boolean(
    adapter
    && (typeof adapter.getHistory === 'function'
      || typeof adapter.getMessage === 'function'),
  );
  const hasNotify = Boolean(adapter && typeof adapter.notify === 'function');
  const files = src.files !== undefined ? Boolean(src.files) : hasSendFile;
  const images = src.images !== undefined ? Boolean(src.images) : files;
  return {
    markdown: src.markdown !== undefined ? Boolean(src.markdown) : DEFAULT_CAPABILITIES.markdown,
    files,
    images,
    replyTo: src.replyTo !== undefined ? Boolean(src.replyTo) : DEFAULT_CAPABILITIES.replyTo,
    actions: src.actions !== undefined ? Boolean(src.actions) : DEFAULT_CAPABILITIES.actions,
    history: src.history !== undefined ? Boolean(src.history) : hasHistory,
    notify: src.notify !== undefined ? Boolean(src.notify) : hasNotify,
    maxChars: Math.max(0, Number(src.maxChars ?? DEFAULT_CAPABILITIES.maxChars) || 0),
    multiDevice: src.multiDevice !== undefined ? Boolean(src.multiDevice) : DEFAULT_CAPABILITIES.multiDevice,
  };
}

/** 静态校验通道适配器实现与 capabilities 一致性。 */
export function validateChannelAdapter(
  adapter: Partial<ChannelAdapter> | null | undefined,
  declaredCaps: ChannelCapabilityInput | null = null,
): { ok: boolean; errors: string[]; warnings: string[]; capabilities: ChannelCapabilities } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!adapter || typeof adapter !== 'object') {
    return { ok: false, errors: ['通道适配器必须返回对象'], warnings, capabilities: normalizeCapabilities(declaredCaps) };
  }
  if (typeof adapter.start !== 'function') errors.push('缺少 start(onEvent, ctx) 方法');
  if (typeof adapter.send !== 'function') errors.push('缺少 send(chatId, text, opts) 方法');
  if (typeof adapter.stop !== 'function') errors.push('缺少 stop() 方法');

  const caps = normalizeCapabilities(declaredCaps ?? adapter.capabilities, adapter);
  if (caps.files && typeof adapter.sendFile !== 'function') {
    errors.push('声明了 capabilities.files=true 但未实现 sendFile(chatId, file, opts)');
  }
  if (caps.notify && typeof adapter.notify !== 'function') {
    errors.push('声明了 capabilities.notify=true 但未实现 notify(payload)');
  }
  if (typeof adapter.sendFile === 'function' && typeof adapter.download !== 'function') {
    warnings.push('已实现 sendFile 但未实现 download(att, savePath)，入站附件将无法拉取');
  }
  if (typeof adapter.status !== 'function') {
    warnings.push('建议实现 status() 以在 /api/status 与调试面板中展示连接状态');
  }
  return { ok: errors.length === 0, errors, warnings, capabilities: caps };
}

/**
 * 托管 IM 通道运行时：统一处理断线指数重连、selfChatId 自动学习、消息归一化与遥测事件。
 */
export class ManagedChannel {
  name: string;
  adapter: ChannelAdapter;
  capabilities: ChannelCapabilities;
  selfId: string;
  selfChatId: string;
  atAllCountsAsMention: boolean;
  idPatterns: ChannelIdPatterns | null;
  strictContract: boolean;
  reconnectDelayMs: number;
  maxReconnectDelayMs: number;
  emitTelemetry: ((type: string, data: Record<string, unknown>) => void) | null;
  logger: LoggerLike;
  connected: boolean;
  lastError: string | null;
  reconnectAttempts: number;
  stopped: boolean;
  reconnecting: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  onEvent: ((ev: InboundEvent) => unknown) | null;
  #connGen = 0;
  #chatTypes = new Map<string, ChatType>();

  constructor({
    name = 'channel',
    capabilities = {},
    adapter,
    selfId = '',
    selfChatId = '',
    atAllCountsAsMention = false,
    idPatterns,
    strictContract = false,
    reconnectDelayMs = 2000,
    maxReconnectDelayMs = 30_000,
    emitTelemetry = null,
    logger = console,
  }: ManagedChannelOptions) {
    this.name = name;
    this.adapter = adapter;
    this.capabilities = normalizeCapabilities(capabilities, adapter);
    this.selfId = String(selfId ?? '');
    this.selfChatId = selfChatId ? String(selfChatId) : '';
    this.atAllCountsAsMention = Boolean(atAllCountsAsMention);
    this.idPatterns = idPatterns ?? adapter.idPatterns ?? null;
    this.strictContract = Boolean(strictContract);
    this.reconnectDelayMs = Number(reconnectDelayMs ?? 2000);
    this.maxReconnectDelayMs = Math.max(this.reconnectDelayMs, Number(maxReconnectDelayMs ?? 30_000));
    this.emitTelemetry = emitTelemetry;
    this.logger = logger;
    this.connected = false;
    this.lastError = null;
    this.reconnectAttempts = 0;
    this.stopped = false;
    this.reconnecting = false;
    this.reconnectTimer = null;
    this.onEvent = null;
    if (this.selfChatId) this.#chatTypes.set(this.selfChatId, 'self');
  }

  get canFiles(): boolean {
    return Boolean(this.capabilities.files && typeof this.adapter?.sendFile === 'function');
  }

  status(): ChannelStatus {
    const inner = typeof this.adapter?.status === 'function' ? this.adapter.status() : null;
    return {
      kind: this.name,
      connected: Boolean(this.connected && inner?.connected !== false),
      selfChatId: (inner?.selfChatId ?? this.selfChatId) || null,
      lastError: inner?.lastError !== undefined ? (inner.lastError ?? null) : this.lastError,
      reconnectAttempts: inner?.reconnectAttempts ?? this.reconnectAttempts,
      capabilities: this.capabilities,
    };
  }

  #emit(type: string, data: Record<string, unknown> = {}): void {
    try {
      this.emitTelemetry?.(type, { channel: this.name, ts: Date.now(), ...data });
    } catch { /* ignore telemetry errors */ }
  }

  #warnContract(message: string): void {
    this.logger.warn?.(`[channel:${this.name}] ${message}`);
    this.#emit('channel:contract_warning', { summary: clipSummary(message, 160) });
  }

  #rememberChatType(chatId: string, chatType: ChatType): void {
    if (!chatId || !chatType) return;
    if (this.#chatTypes.has(chatId)) this.#chatTypes.delete(chatId);
    this.#chatTypes.set(chatId, chatType);
    while (this.#chatTypes.size > 500) {
      const oldest = this.#chatTypes.keys().next().value;
      if (oldest === undefined) break;
      this.#chatTypes.delete(oldest);
    }
  }

  #resolveChatType(chatId: string, explicitType?: ChatType): ChatType | undefined {
    if (explicitType && CHAT_TYPES.has(explicitType)) return explicitType;
    if (this.selfChatId && chatId === this.selfChatId) return 'self';
    return this.#chatTypes.get(chatId) ?? decodeScopedChatId(chatId)?.type;
  }

  #validateOutboundOpts(chatId: string, chatType: ChatType | undefined, opts: ChannelSendOptions): void {
    const p = this.idPatterns;
    if (!p) return;
    const errs: string[] = [];
    if (p.chatId && !matchIdPattern(p.chatId, chatId)) {
      errs.push(`出站 chatId=${JSON.stringify(chatId)} 不符合 chatId 规范 ${p.chatId}`);
    }
    if (chatType === 'group' && p.groupChatId && !matchIdPattern(p.groupChatId, chatId)) {
      errs.push(`出站群 chatId=${JSON.stringify(chatId)} 不符合 groupChatId 规范 ${p.groupChatId}`);
    }
    if (chatType === 'direct' && p.directChatId && !matchIdPattern(p.directChatId, chatId)) {
      errs.push(`出站私聊 chatId=${JSON.stringify(chatId)} 不符合 directChatId 规范 ${p.directChatId}`);
    }
    if (opts.replyTo && p.msgId && !matchIdPattern(p.msgId, String(opts.replyTo))) {
      errs.push(`出站 opts.replyTo=${JSON.stringify(opts.replyTo)} 不符合 msgId 规范 ${p.msgId}`);
    }
    if (Array.isArray(opts.mentions) && p.userId) {
      for (const m of opts.mentions) {
        if (m?.id && !matchIdPattern(p.userId, String(m.id))) {
          errs.push(`出站 opts.mentions[].id=${JSON.stringify(m.id)} 不符合 userId 规范 ${p.userId}`);
        }
      }
    }
    if (!errs.length) return;
    for (const err of errs) this.#warnContract(err);
    if (this.strictContract) {
      throw new Error(errs.join('；'));
    }
  }

  async #connectAdapter(): Promise<void> {
    if (this.stopped) return;
    const gen = ++this.#connGen;
    let disconnectedDuringConnect = false;
    let connectPending = true;
    await this.adapter.start(
      (rawMsg) => {
        if (this.stopped || gen !== this.#connGen) return;
        let ev: InboundEvent;
        try {
          ev = normalizeInboundEvent(rawMsg, {
            selfId: this.selfId,
            selfChatId: this.selfChatId,
            atAllCountsAsMention: this.atAllCountsAsMention,
            idPatterns: this.idPatterns,
            strict: this.strictContract,
            onWarning: (w) => this.#warnContract(w),
          });
        } catch (e) {
          this.logger.error?.(`[channel:${this.name}] 无法识别的消息，已跳过：`, e instanceof Error ? e.message : e);
          return;
        }
        this.#rememberChatType(ev.chat.id, ev.chat.type);
        if (ev.chat.type === 'self' && !this.selfChatId) {
          this.selfChatId = ev.chat.id;
        }
        this.#emit('channel:inbound', {
          msgId: ev.id,
          chatId: ev.chat.id,
          chatType: ev.chat.type,
          isSelf: ev.sender.isSelf,
          device: ev.device?.type ?? null,
          hasAttachments: Boolean(ev.attachments?.length),
          summary: ev.kind === 'recall'
            ? `recall:${ev.recalledMsgId ?? ''}`
            : clipSummary(ev.text || (ev.attachments?.length ? `[附件 x${ev.attachments.length}]` : '')),
        });
        Promise.resolve(this.onEvent?.(ev)).catch((e) => {
          this.logger.error?.(`[channel:${this.name}] 处理入站事件异常：`, e instanceof Error ? e.message : e);
        });
      },
      {
        onDisconnect: (err) => {
          if (this.stopped || gen !== this.#connGen) return;
          if (connectPending) {
            disconnectedDuringConnect = true;
            this.lastError = err instanceof Error ? err.message : String(err || 'disconnected');
            return;
          }
          this.#handleDisconnect(err);
        },
      },
    );
    connectPending = false;
    if (this.stopped || gen !== this.#connGen) {
      if (this.stopped) await Promise.resolve(this.adapter.stop?.()).catch(() => {});
      return;
    }
    if (disconnectedDuringConnect) {
      const msg = this.lastError || 'disconnected';
      if (this.reconnecting) {
        this.connected = false;
        this.#emit('channel:state', { connected: false, error: msg, reconnectAttempts: this.reconnectAttempts });
        throw new Error(msg);
      }
      this.#handleDisconnect(msg);
      return;
    }
    this.connected = true;
    this.lastError = null;
    this.reconnectAttempts = 0;
    this.#emit('channel:state', { connected: true, reconnectAttempts: 0 });
  }

  #handleDisconnect(err?: unknown): void {
    if (this.stopped || this.reconnecting) return;
    this.connected = false;
    this.lastError = err instanceof Error ? err.message : String(err || 'disconnected');
    this.#emit('channel:state', { connected: false, error: this.lastError, reconnectAttempts: this.reconnectAttempts });
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.stopped || this.reconnecting || this.reconnectTimer || !(this.reconnectDelayMs > 0)) return;
    const delay = Math.min(this.maxReconnectDelayMs, this.reconnectDelayMs * (2 ** Math.min(this.reconnectAttempts, 4)));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.reconnecting = true;
      let shouldRetry = false;
      try {
        await Promise.resolve(this.adapter.stop?.()).catch(() => {});
        if (!this.stopped) await this.#connectAdapter();
      } catch (e) {
        if (!this.stopped) {
          this.connected = false;
          this.lastError = e instanceof Error ? e.message : String(e);
          shouldRetry = true;
        }
      } finally {
        this.reconnecting = false;
      }
      if (shouldRetry && !this.stopped) this.#scheduleReconnect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  async start(onEvent: (ev: InboundEvent) => unknown): Promise<void> {
    this.stopped = false;
    this.onEvent = onEvent;
    await this.#connectAdapter();
  }

  async send(chatId: string, text: string, opts: ChannelSendOptions = {}): Promise<string | undefined> {
    if (!chatId) throw new Error('尚未获知目标会话 ID（selfChatId）');
    const cid = String(chatId);
    const chatType = this.#resolveChatType(cid, opts.chatType);
    const outOpts: ChannelSendOptions = chatType && opts.chatType !== chatType ? { ...opts, chatType } : opts;
    this.#validateOutboundOpts(cid, chatType, outOpts);
    const id = await this.adapter.send(cid, text, outOpts);
    const idStr = id != null ? String(id).trim() : '';
    if (!idStr) {
      this.#warnContract('adapter.send() 未返回非空 msgId，引用路由与回声去重可能失效');
    } else if (this.idPatterns?.msgId && !matchIdPattern(this.idPatterns.msgId, idStr)) {
      this.#warnContract(`adapter.send() 返回的 msgId=${JSON.stringify(idStr)} 不符合 msgId 规范 ${this.idPatterns.msgId}`);
    }
    this.#emit('channel:outbound', {
      kind: 'text',
      chatId: cid,
      msgId: idStr || null,
      chars: String(text ?? '').length,
      summary: clipSummary(text),
    });
    return idStr || undefined;
  }

  async sendFile(chatId: string, file: ChannelSendFileInput, opts: ChannelSendOptions = {}): Promise<string | undefined> {
    if (!chatId) throw new Error('尚未获知目标会话 ID（selfChatId）');
    if (!this.canFiles || !this.adapter.sendFile) throw new Error(`通道「${this.name}」不支持发送文件`);
    const cid = String(chatId);
    const chatType = this.#resolveChatType(cid, opts.chatType);
    const outOpts: ChannelSendOptions = chatType && opts.chatType !== chatType ? { ...opts, chatType } : opts;
    this.#validateOutboundOpts(cid, chatType, outOpts);
    const id = await this.adapter.sendFile(cid, file, outOpts);
    const idStr = id != null ? String(id).trim() : '';
    if (!idStr) {
      this.#warnContract('adapter.sendFile() 未返回非空 msgId，文件回声防环可能失效');
    }
    this.#emit('channel:outbound', {
      kind: 'file',
      chatId: cid,
      msgId: idStr || null,
      summary: clipSummary(file?.name || pathBasename(file?.path)),
    });
    return idStr || undefined;
  }

  async download(att: InboundAttachment, savePath: string, ctx?: ChannelDownloadContext): Promise<void> {
    if (typeof this.adapter?.download !== 'function') {
      throw new Error(`通道「${this.name}」未实现 download`);
    }
    const chatId = ctx?.chatId ?? att?.chatId;
    const chatType = ctx?.chatType ?? (chatId ? this.#resolveChatType(String(chatId)) : undefined);
    const dlCtx: ChannelDownloadContext = {
      ...(chatId ? { chatId: String(chatId) } : {}),
      ...(chatType ? { chatType } : {}),
    };
    await this.adapter.download(att, savePath, dlCtx);
  }

  #normalizeMaybeEvent(raw: unknown, source = 'history'): InboundEvent | null {
    if (!raw || typeof raw !== 'object') return null;
    try {
      const ev = normalizeInboundEvent(raw, {
        selfId: this.selfId,
        selfChatId: this.selfChatId,
        atAllCountsAsMention: this.atAllCountsAsMention,
        idPatterns: this.idPatterns,
        strict: this.strictContract,
        onWarning: (w) => this.#warnContract(`[${source}] ${w}`),
      });
      this.#rememberChatType(ev.chat.id, ev.chat.type);
      return ev;
    } catch (e) {
      this.logger.warn?.(`[channel:${this.name}] ${source} 消息归一化失败，已跳过：`, e instanceof Error ? e.message : e);
      return null;
    }
  }

  async getMessage(chatId: string, msgId: string, opts: ChannelGetMessageOptions = {}): Promise<InboundEvent | null> {
    if (typeof this.adapter?.getMessage !== 'function') return null;
    const cid = String(chatId);
    const chatType = this.#resolveChatType(cid, opts.chatType);
    const raw = await this.adapter.getMessage(cid, msgId, chatType ? { ...opts, chatType } : opts);
    return this.#normalizeMaybeEvent(raw, 'getMessage');
  }

  async getHistory(chatId: string, opts: ChannelGetHistoryOptions = {}): Promise<InboundEvent[]> {
    if (typeof this.adapter?.getHistory !== 'function') return [];
    const cid = String(chatId);
    const chatType = this.#resolveChatType(cid, opts.chatType);
    const passOpts: ChannelGetHistoryOptions = chatType && opts.chatType !== chatType ? { ...opts, chatType } : opts;
    const list = await this.adapter.getHistory(cid, passOpts);
    return Array.isArray(list)
      ? list.map((m) => this.#normalizeMaybeEvent(m, 'getHistory')).filter((x): x is InboundEvent => x !== null)
      : [];
  }

  async notify(payload: ChannelNotifyPayload = {}): Promise<boolean> {
    if (typeof this.adapter?.notify !== 'function') return false;
    try {
      await this.adapter.notify(payload);
      this.#emit('channel:notify', {
        chatId: payload?.chatId ? String(payload.chatId) : null,
        urgent: Boolean(payload?.urgent),
        summary: clipSummary(payload?.title || payload?.body || 'notify'),
      });
      return true;
    } catch (e) {
      this.logger.warn?.(`[channel:${this.name}] notify 失败：`, e instanceof Error ? e.message : e);
      return false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.#connGen += 1;
    this.reconnecting = false;
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.adapter?.stop?.();
  }
}

function pathBasename(p: unknown): string {
  return String(p || 'file').split(/[\\/]/).pop() || 'file';
}

/** 将 `{ name, capabilities, create(options, ctx) }` 声明封装为标准 Kernel ChannelPlugin。 */
function createManagedChannelPlugin<TOptions extends Record<string, unknown>>(
  spec: ChannelPluginSpec<TOptions>,
): KernelPlugin<TOptions> {
  if (!spec || typeof spec.create !== 'function') {
    throw new Error('createManagedChannelPlugin 需要提供 create(options, ctx) 方法');
  }
  const createFn = spec.create;
  const name = String(spec.name || 'custom-channel');
  const extraProvides = Array.isArray(spec.provides)
    ? spec.provides.filter((p) => p && p !== 'channel')
    : [];
  return {
    name,
    kind: 'channel',
    version: spec.version || '1.0.0',
    ...(spec.source ? { source: spec.source } : {}),
    ...(spec.inject ? { inject: spec.inject } : {}),
    provides: ['channel', ...extraProvides],
    capabilities: spec.capabilities,
    apply(ctx, opts = {} as TOptions) {
      const adapter = createFn(opts, ctx);
      const check = validateChannelAdapter(adapter, spec.capabilities);
      if (!check.ok) {
        throw new Error(`通道插件「${name}」不符合契约：${check.errors.join('；')}`);
      }
      const o = opts as AnyRecord;
      const selfId = typeof o.selfId === 'string' ? o.selfId : String(o.selfId ?? '');
      const selfChatId = typeof o.selfChatId === 'string' ? o.selfChatId : String(o.selfChatId ?? '');
      const idPatterns = spec.idPatterns ?? adapter.idPatterns;
      const strictContract = Boolean(o.strictContract ?? spec.strictContract ?? false);
      const cfgIdErrs = validateConfigIdsAgainstPatterns(
        {
          selfId,
          selfChatId,
          collaborators: ctx.config?.chats?.collaborators,
          allowChatIds: ctx.config?.chats?.allowChatIds,
          denyChatIds: ctx.config?.chats?.denyChatIds,
        },
        idPatterns,
      );
      if (cfgIdErrs.length) {
        for (const err of cfgIdErrs) ctx.logger?.warn?.(`[channel:${name}] 配置 ID 契约告警：${err}`);
        if (strictContract) {
          throw new Error(`通道插件「${name}」配置 ID 不符合 idPatterns：${cfgIdErrs.join('；')}`);
        }
      }
      const managed = new ManagedChannel({
        name,
        capabilities: check.capabilities,
        adapter,
        selfId,
        selfChatId,
        atAllCountsAsMention: Boolean(o.atAllCountsAsMention ?? false),
        idPatterns,
        strictContract,
        reconnectDelayMs: o.reconnectDelayMs != null ? Number(o.reconnectDelayMs) : spec.reconnectDelayMs,
        maxReconnectDelayMs: o.maxReconnectDelayMs != null ? Number(o.maxReconnectDelayMs) : spec.maxReconnectDelayMs,
        emitTelemetry: (evName, payload) => ctx.emit(evName, payload),
        logger: ctx.logger,
      });
      ctx.provide('channel', managed);
      ctx.effect(() => managed.stop());
      ctx.status(() => managed.status());
    },
  };
}

/** 供外部 IM 适配器（如 im-plugin.ts）导出的声明式定义辅助函数。 */
export function defineChannelPlugin<TOptions extends Record<string, unknown> = Record<string, unknown>>(
  spec: ChannelPluginSpec<TOptions>,
): KernelPlugin<TOptions> {
  if (!spec || typeof spec !== 'object') {
    throw new Error('defineChannelPlugin 需要传入配置对象');
  }
  if (typeof spec.apply === 'function') {
    return {
      kind: 'channel',
      version: '1.0.0',
      provides: ['channel'],
      ...spec,
      apply: spec.apply,
    };
  }
  return createManagedChannelPlugin(spec);
}
