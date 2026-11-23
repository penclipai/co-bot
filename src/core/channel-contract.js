/**
 * 通用 IM 通道插件契约与托管基类（零依赖）：
 * 让 WebSim、IM IPC 或任意第三方 IM（飞书 / 企微 / 钉钉 / TG 等）通过统一接口接入 co-bot。
 */
import { redactSecrets } from './chat-context.js';

const CHAT_TYPES = new Set(['self', 'direct', 'group', 'system']);
const DEVICE_TYPES = new Set(['mobile', 'desktop', 'pad', 'web', 'unknown']);

export const DEFAULT_CAPABILITIES = Object.freeze({
  markdown: true,
  files: false,
  images: false,
  replyTo: true,
  actions: false,
  history: false,
  maxChars: 0,
  multiDevice: false,
});

export function clipSummary(text, max = 120) {
  const s = redactSecrets(text).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 为直连型传输适配器（如 WebSimTransport / IpcTransport）挂载统一脱敏遥测埋点，不改原返回值结构。 */
export function attachTransportTelemetry(transport, emit, name = transport?.constructor?.name || 'channel') {
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
          summary: clipSummary(file?.name || file?.path),
        });
      } catch { /* ignore */ }
      return id;
    };
  }
  return transport;
}

/** 根据插件声明与底层适配器方法合并标准化通道能力。 */
export function normalizeCapabilities(raw = {}, adapter = null) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const hasSendFile = Boolean(adapter && typeof adapter.sendFile === 'function' && adapter.canFiles !== false);
  const hasHistory = Boolean(
    adapter
    && (typeof adapter.getHistory === 'function'
      || typeof adapter.getMessage === 'function'
      || typeof adapter.searchHistory === 'function'),
  );
  const files = src.files !== undefined ? Boolean(src.files) : hasSendFile;
  const images = src.images !== undefined ? Boolean(src.images) : files;
  return {
    markdown: src.markdown !== undefined ? Boolean(src.markdown) : DEFAULT_CAPABILITIES.markdown,
    files,
    images,
    replyTo: src.replyTo !== undefined ? Boolean(src.replyTo) : DEFAULT_CAPABILITIES.replyTo,
    actions: src.actions !== undefined ? Boolean(src.actions) : DEFAULT_CAPABILITIES.actions,
    history: src.history !== undefined ? Boolean(src.history) : hasHistory,
    maxChars: Math.max(0, Number(src.maxChars ?? DEFAULT_CAPABILITIES.maxChars) || 0),
    multiDevice: src.multiDevice !== undefined ? Boolean(src.multiDevice) : DEFAULT_CAPABILITIES.multiDevice,
  };
}

/** 将各家 IM 的结构化 `@提及` 列表归一化为 `[{ id, name?, isAll?, isSelf? }]`。 */
export function normalizeMentions(rawMentions, { atUserIds, atAll = false, selfId = '' } = {}) {
  const selfStr = String(selfId ?? '');
  const list = [];
  const seen = new Set();
  const push = (item) => {
    const isAll = Boolean(item.isAll);
    const id = String(item.id || (isAll ? '__all__' : (item.name || ''))).trim();
    if (!id) return;
    const name = item.name ? String(item.name).replace(/^@/, '').trim() : undefined;
    const isSelf = typeof item.isSelf === 'boolean' ? item.isSelf : Boolean(selfStr && id === selfStr);
    const key = isAll ? '__all__' : `${id}:${name || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({
      id,
      ...(name ? { name } : {}),
      ...(isAll ? { isAll: true } : {}),
      ...(isSelf ? { isSelf: true } : {}),
    });
  };
  if (Array.isArray(rawMentions)) {
    for (const m of rawMentions) {
      if (!m) continue;
      if (typeof m === 'string') {
        const clean = m.replace(/^@/, '').trim();
        if (clean) push({ id: clean, name: clean });
        continue;
      }
      if (typeof m === 'object') {
        push({
          id: m.id ?? m.userId ?? m.uid ?? m.name ?? '',
          name: m.name ?? m.nick ?? m.displayName,
          isAll: Boolean(m.isAll),
          isSelf: m.isSelf,
        });
      }
    }
  }
  if (Array.isArray(atUserIds)) {
    for (const uid of atUserIds) {
      if (uid != null && String(uid).trim()) push({ id: String(uid).trim() });
    }
  }
  if (atAll) {
    push({ id: '__all__', name: '所有人', isAll: true });
  }
  return list;
}

/** 校验标准 InboundEvent 结构是否满足网关分发契约。 */
export function validateInboundEvent(ev) {
  const errors = [];
  if (!ev || typeof ev !== 'object') {
    return { ok: false, errors: ['事件必须为非空对象'], event: null };
  }
  const isRecall = ev.kind === 'recall';
  if (!ev.id || typeof ev.id !== 'string') errors.push('缺少字符串类型的 id');
  if (!ev.chat || typeof ev.chat !== 'object') {
    errors.push('缺少 chat 对象');
  } else {
    if (!ev.chat.id || typeof ev.chat.id !== 'string') errors.push('chat.id 必须为非空字符串');
    if (!CHAT_TYPES.has(ev.chat.type)) errors.push(`chat.type 非法：${ev.chat.type}（应为 self|direct|group|system）`);
  }
  if (isRecall) {
    if (!ev.recalledMsgId || typeof ev.recalledMsgId !== 'string') errors.push('撤回事件缺少字符串类型的 recalledMsgId');
    if (ev.sender != null && typeof ev.sender !== 'object') errors.push('sender 必须为对象');
  } else {
    if (!ev.sender || typeof ev.sender !== 'object') {
      errors.push('缺少 sender 对象');
    } else {
      if (typeof ev.sender.id !== 'string') errors.push('sender.id 必须为字符串');
      if (typeof ev.sender.isSelf !== 'boolean') errors.push('sender.isSelf 必须为布尔值');
    }
    if (typeof ev.text !== 'string') errors.push('text 必须为字符串');
  }
  if (ev.mentions !== undefined && !Array.isArray(ev.mentions)) {
    errors.push('mentions 若存在必须为数组');
  }
  if (ev.attachments !== undefined) {
    if (!Array.isArray(ev.attachments)) {
      errors.push('attachments 若存在必须为数组');
    } else {
      for (let i = 0; i < ev.attachments.length; i++) {
        const a = ev.attachments[i];
        if (!a || !a.id || !a.name) errors.push(`attachments[${i}] 缺少 id 或 name`);
      }
    }
  }
  return { ok: errors.length === 0, errors, event: ev };
}

/**
 * 将标准 InboundEvent 或通用扁平 IM 消息（FlatMessage）归一化为标准 InboundEvent。
 */
export function normalizeInboundEvent(raw, { selfId = '', selfChatId = '', atAllCountsAsMention = false } = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('消息体必须为对象');
  }

  const selfStr = String(selfId ?? '');
  const isRecall = raw.kind === 'recall' || raw.type === 'recall' || raw.eventType === 'recall';

  // 0. 消息撤回事件（兼容标准结构与扁平结构）
  if (isRecall) {
    const chatId = raw.chat?.id ?? raw.chatId;
    const recalledMsgId = raw.recalledMsgId ?? raw.targetMsgId ?? raw.revokedMsgId;
    if (chatId == null || recalledMsgId == null) throw new Error('撤回事件缺少 chatId 或 recalledMsgId');
    const cid = String(chatId);
    const rawType = raw.chat?.type ?? raw.chatType;
    const chatType = rawType === 'self' || (selfChatId && cid === selfChatId)
      ? 'self'
      : (CHAT_TYPES.has(rawType) ? rawType : 'direct');
    const senderId = String(raw.sender?.id ?? raw.fromId ?? '');
    const senderName = raw.sender?.name ?? raw.fromName;
    const isSelf = typeof raw.sender?.isSelf === 'boolean'
      ? raw.sender.isSelf
      : (typeof raw.isSelf === 'boolean' ? raw.isSelf : Boolean(selfStr && senderId === selfStr));
    const ev = {
      id: String(raw.id ?? raw.msgId ?? `recall_${recalledMsgId}`),
      kind: 'recall',
      ts: Number(raw.ts ?? raw.time) || Date.now(),
      chat: {
        id: cid,
        type: chatType,
        ...((raw.chat?.name || raw.chatName) ? { name: String(raw.chat?.name || raw.chatName) } : {}),
      },
      sender: {
        id: senderId,
        ...(senderName ? { name: String(senderName) } : {}),
        isSelf,
      },
      recalledMsgId: String(recalledMsgId),
      text: '',
    };
    const checked = validateInboundEvent(ev);
    if (!checked.ok) throw new Error(checked.errors.join('；'));
    return ev;
  }

  // 1. 若已经是标准结构（存在 chat.id 与 sender）
  if (raw.chat && typeof raw.chat === 'object' && raw.sender && typeof raw.sender === 'object') {
    if (raw.id == null || raw.chat.id == null) throw new Error('缺少 id 或 chat.id');
    const chatId = String(raw.chat.id);
    const chatType = raw.chat.type === 'self' || (selfChatId && chatId === selfChatId)
      ? 'self'
      : (CHAT_TYPES.has(raw.chat.type) ? raw.chat.type : 'direct');
    const senderId = String(raw.sender.id ?? '');
    const isSelf = typeof raw.sender.isSelf === 'boolean'
      ? raw.sender.isSelf
      : Boolean(selfId && senderId === String(selfId));
    const dev = raw.device;
    const mentions = normalizeMentions(raw.mentions, { selfId });
    const derivedMentionMe = mentions.some((m) => m.isSelf || (selfStr && m.id === selfStr) || (m.isAll && atAllCountsAsMention));
    const ev = {
      id: String(raw.id),
      ts: Number(raw.ts) || Date.now(),
      chat: {
        id: chatId,
        type: chatType,
        ...(raw.chat.name ? { name: String(raw.chat.name) } : {}),
      },
      sender: {
        id: senderId,
        ...(raw.sender.name ? { name: String(raw.sender.name) } : {}),
        isSelf,
      },
      ...(dev ? {
        device: {
          id: String(dev.id ?? ''),
          type: DEVICE_TYPES.has(dev.type) ? dev.type : 'unknown',
          ...(dev.name ? { name: String(dev.name) } : {}),
        },
      } : {}),
      text: String(raw.text ?? ''),
      ...(raw.mentionsMe !== undefined ? { mentionsMe: Boolean(raw.mentionsMe) } : (derivedMentionMe ? { mentionsMe: true } : {})),
      ...(mentions.length ? { mentions } : {}),
      ...(raw.replyTo != null ? { replyTo: String(raw.replyTo) } : {}),
      ...(Array.isArray(raw.attachments) && raw.attachments.length ? {
        attachments: raw.attachments
          .filter((a) => a && a.id != null)
          .map((a) => ({
            id: String(a.id),
            msgId: String(a.msgId ?? raw.id),
            name: String(a.name ?? a.id),
            ...(Number(a.size) ? { size: Number(a.size) } : {}),
            ...(a.mime ? { mime: String(a.mime) } : {}),
          })),
      } : {}),
    };
    const checked = validateInboundEvent(ev);
    if (!checked.ok) throw new Error(checked.errors.join('；'));
    return ev;
  }

  // 2. 扁平结构（兼容旧版 FlatMessage）
  if (raw.msgId == null || raw.chatId == null) throw new Error('缺少 msgId 或 chatId');
  const chatId = String(raw.chatId);
  const type = raw.chatType === 'self' || (selfChatId && chatId === selfChatId)
    ? 'self'
    : (raw.chatType === 'group' ? 'group' : (raw.chatType === 'system' ? 'system' : 'direct'));
  const at = Array.isArray(raw.atUserIds) ? raw.atUserIds.map(String) : [];
  const d = raw.fromDevice;
  const senderId = String(raw.fromId ?? '');
  const mentions = normalizeMentions(raw.mentions, { atUserIds: at, atAll: Boolean(raw.atAll), selfId });
  const ev = {
    id: String(raw.msgId),
    ts: Number(raw.time) || Date.now(),
    chat: { id: chatId, type, name: raw.chatName ? String(raw.chatName) : undefined },
    sender: {
      id: senderId,
      name: raw.fromName ? String(raw.fromName) : undefined,
      isSelf: typeof raw.isSelf === 'boolean' ? raw.isSelf : Boolean(selfStr && senderId === selfStr),
    },
    device: d
      ? { id: String(d.id ?? ''), type: DEVICE_TYPES.has(d.type) ? d.type : 'unknown', name: d.name ? String(d.name) : undefined }
      : undefined,
    text: String(raw.text ?? ''),
    mentionsMe: Boolean((selfStr && at.includes(selfStr)) || (raw.atAll && atAllCountsAsMention) || mentions.some((m) => m.isSelf)),
    ...(mentions.length ? { mentions } : {}),
    replyTo: raw.quoteMsgId != null ? String(raw.quoteMsgId) : undefined,
    ...(Array.isArray(raw.files) && raw.files.length ? {
      attachments: raw.files.filter((f) => f && f.fileId != null).map((f) => ({
        id: String(f.fileId),
        msgId: String(raw.msgId),
        name: String(f.name ?? f.fileId),
        size: Number(f.size) || undefined,
        mime: f.mime ? String(f.mime) : undefined,
      })),
    } : {}),
  };
  return ev;
}

/** 静态校验通道适配器实现与 capabilities 一致性。 */
export function validateChannelAdapter(adapter, declaredCaps = null) {
  const errors = [];
  const warnings = [];
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
  constructor({
    name = 'channel',
    capabilities = {},
    adapter,
    selfId = '',
    selfChatId = '',
    atAllCountsAsMention = false,
    reconnectDelayMs = 2000,
    maxReconnectDelayMs = 30_000,
    emitTelemetry = null,
    logger = console,
  } = {}) {
    this.name = name;
    this.adapter = adapter;
    this.capabilities = normalizeCapabilities(capabilities, adapter);
    this.selfId = String(selfId ?? '');
    this.selfChatId = selfChatId ? String(selfChatId) : '';
    this.atAllCountsAsMention = Boolean(atAllCountsAsMention);
    this.reconnectDelayMs = Number(reconnectDelayMs ?? 2000);
    this.maxReconnectDelayMs = Number(maxReconnectDelayMs ?? 30_000);
    this.emitTelemetry = emitTelemetry;
    this.logger = logger;
    this.connected = false;
    this.lastError = null;
    this.reconnectAttempts = 0;
    this.stopped = false;
    this.reconnecting = false;
    this.reconnectTimer = null;
    this.onEvent = null;
  }

  get canFiles() {
    return Boolean(this.capabilities.files && typeof this.adapter?.sendFile === 'function');
  }

  status() {
    const inner = typeof this.adapter?.status === 'function' ? this.adapter.status() : null;
    return {
      kind: this.name,
      connected: Boolean(this.connected && inner?.connected !== false),
      selfChatId: (inner?.selfChatId ?? this.selfChatId) || null,
      lastError: inner?.lastError !== undefined ? inner.lastError : this.lastError,
      reconnectAttempts: inner?.reconnectAttempts ?? this.reconnectAttempts,
      capabilities: this.capabilities,
    };
  }

  #emit(type, data = {}) {
    try {
      this.emitTelemetry?.(type, { channel: this.name, ts: Date.now(), ...data });
    } catch { /* ignore telemetry errors */ }
  }

  async #connectAdapter() {
    if (this.stopped) return;
    await this.adapter.start(
      (rawMsg) => {
        let ev;
        try {
          ev = normalizeInboundEvent(rawMsg, {
            selfId: this.selfId,
            selfChatId: this.selfChatId,
            atAllCountsAsMention: this.atAllCountsAsMention,
          });
        } catch (e) {
          this.logger.error?.(`[channel:${this.name}] 无法识别的消息，已跳过：`, e?.message || e);
          return;
        }
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
            ? `recall:${ev.recalledMsgId}`
            : clipSummary(ev.text || (ev.attachments?.length ? `[附件 x${ev.attachments.length}]` : '')),
        });
        Promise.resolve(this.onEvent?.(ev)).catch((e) => {
          this.logger.error?.(`[channel:${this.name}] 处理入站事件异常：`, e?.message || e);
        });
      },
      { onDisconnect: (err) => this.#handleDisconnect(err) },
    );
    if (this.stopped) {
      await this.adapter.stop?.().catch?.(() => {});
      return;
    }
    this.connected = true;
    this.lastError = null;
    this.reconnectAttempts = 0;
    this.#emit('channel:state', { connected: true, reconnectAttempts: 0 });
  }

  #handleDisconnect(err) {
    if (this.stopped || this.reconnecting) return;
    this.connected = false;
    this.lastError = err?.message || String(err || 'disconnected');
    this.#emit('channel:state', { connected: false, error: this.lastError, reconnectAttempts: this.reconnectAttempts });
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
        await this.adapter.stop?.().catch?.(() => {});
        if (!this.stopped) await this.#connectAdapter();
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
    this.stopped = false;
    this.onEvent = onEvent;
    await this.#connectAdapter();
  }

  async send(chatId, text, opts = {}) {
    if (!chatId) throw new Error('尚未获知目标会话 ID（selfChatId）');
    const id = await this.adapter.send(chatId, text, opts);
    this.#emit('channel:outbound', {
      kind: 'text',
      chatId: String(chatId),
      msgId: id ? String(id) : null,
      chars: String(text ?? '').length,
      summary: clipSummary(text),
    });
    return id != null ? String(id) : undefined;
  }

  async sendFile(chatId, file, opts = {}) {
    if (!this.canFiles) throw new Error(`通道「${this.name}」不支持发送文件`);
    const id = await this.adapter.sendFile(chatId, file, opts);
    this.#emit('channel:outbound', {
      kind: 'file',
      chatId: String(chatId),
      msgId: id ? String(id) : null,
      summary: clipSummary(file?.name || pathBasename(file?.path)),
    });
    return id != null ? String(id) : undefined;
  }

  async download(att, savePath) {
    if (typeof this.adapter?.download !== 'function') {
      throw new Error(`通道「${this.name}」未实现 download`);
    }
    await this.adapter.download(att, savePath);
  }

  #normalizeMaybeEvent(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.id && raw.chat?.id && raw.sender) return raw;
    try {
      return normalizeInboundEvent(raw, {
        selfId: this.selfId,
        selfChatId: this.selfChatId,
        atAllCountsAsMention: this.atAllCountsAsMention,
      });
    } catch {
      return null;
    }
  }

  async getMessage(chatId, msgId) {
    if (typeof this.adapter?.getMessage !== 'function') return null;
    const raw = await this.adapter.getMessage(chatId, msgId);
    return this.#normalizeMaybeEvent(raw);
  }

  async getHistory(chatId, opts = {}) {
    if (typeof this.adapter?.getHistory !== 'function') return [];
    const list = await this.adapter.getHistory(chatId, opts);
    return Array.isArray(list) ? list.map((m) => this.#normalizeMaybeEvent(m)).filter(Boolean) : [];
  }

  async searchHistory(chatId, query, opts = {}) {
    if (typeof this.adapter?.searchHistory !== 'function') return [];
    const list = await this.adapter.searchHistory(chatId, query, opts);
    return Array.isArray(list) ? list.map((m) => this.#normalizeMaybeEvent(m)).filter(Boolean) : [];
  }

  async stop() {
    this.stopped = true;
    this.reconnecting = false;
    this.connected = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    await this.adapter?.stop?.();
  }
}

function pathBasename(p) {
  return String(p || 'file').split(/[\\/]/).pop() || 'file';
}

/** 将 `{ name, capabilities, create(options, ctx) }` 声明封装为标准 Kernel ChannelPlugin。 */
export function createManagedChannelPlugin(spec) {
  if (!spec || typeof spec.create !== 'function') {
    throw new Error('createManagedChannelPlugin 需要提供 create(options, ctx) 方法');
  }
  const name = String(spec.name || 'custom-channel');
  return {
    name,
    kind: 'channel',
    version: spec.version || '1.0.0',
    provides: ['channel'],
    capabilities: spec.capabilities,
    create: spec.create,
    apply(ctx, opts = {}) {
      const adapter = spec.create(opts, ctx);
      const check = validateChannelAdapter(adapter, spec.capabilities);
      if (!check.ok) {
        throw new Error(`通道插件「${name}」不符合契约：${check.errors.join('；')}`);
      }
      const managed = new ManagedChannel({
        name,
        capabilities: check.capabilities,
        adapter,
        selfId: opts.selfId ?? '',
        selfChatId: opts.selfChatId ?? '',
        atAllCountsAsMention: opts.atAllCountsAsMention ?? false,
        reconnectDelayMs: opts.reconnectDelayMs ?? spec.reconnectDelayMs,
        maxReconnectDelayMs: opts.maxReconnectDelayMs ?? spec.maxReconnectDelayMs,
        emitTelemetry: (evName, payload) => ctx.emit(evName, payload),
        logger: ctx.logger,
      });
      ctx.provide('channel', managed);
      ctx.effect(() => managed.stop());
      ctx.status(() => managed.status());
    },
  };
}

/** 供外部 IM 适配器（如 im-plugin.js）导出的声明式定义辅助函数。 */
export function defineChannelPlugin(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('defineChannelPlugin 需要传入配置对象');
  }
  if (typeof spec.apply === 'function') {
    return {
      kind: 'channel',
      version: '1.0.0',
      provides: ['channel'],
      ...spec,
    };
  }
  return createManagedChannelPlugin(spec);
}
