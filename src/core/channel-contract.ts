/**
 * 通用 IM 通道插件契约与托管基类（零依赖）：
 * 让 WebSim、IM IPC 或任意第三方 IM（飞书 / 企微 / 钉钉 / TG 等）通过统一接口接入 co-bot。
 */
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelCapabilityInput,
  ChannelGetHistoryOptions,
  ChannelNotifyPayload,
  ChannelPluginSpec,
  ChannelSendFileInput,
  ChannelSendOptions,
  ChannelStatus,
  ChatType,
  DeviceType,
  InboundAttachment,
  InboundEvent,
  InboundMention,
  KernelPlugin,
  LinkCard,
  LoggerLike,
} from '../types.ts';
import { isAudioAttachment, redactSecrets } from './chat-context.ts';
import { normalizeForwarded } from './context-pull.ts';

export { isAudioAttachment };

const CHAT_TYPES = new Set<string>(['self', 'direct', 'group', 'system']);
const DEVICE_TYPES = new Set<string>(['mobile', 'desktop', 'pad', 'web', 'unknown']);

type AnyRecord = Record<string, unknown>;

export interface ManagedChannelOptions {
  name?: string;
  capabilities?: ChannelCapabilityInput;
  adapter: ChannelAdapter;
  selfId?: string;
  selfChatId?: string;
  atAllCountsAsMention?: boolean;
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

function normalizeLinkCard(rawCard: unknown): LinkCard | null {
  if (!rawCard || typeof rawCard !== 'object') return null;
  const c = rawCard as AnyRecord;
  const title = c.title ? String(c.title).trim() : '';
  const url = c.url || c.href ? String(c.url || c.href).trim() : '';
  const description = c.description || c.summary || c.digest
    ? String(c.description || c.summary || c.digest).trim()
    : '';
  const source = c.source || c.appName ? String(c.source || c.appName).trim() : '';
  if (!title && !url) return null;
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(url ? { url } : {}),
    ...(source ? { source } : {}),
  };
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

/** 将各家 IM 的结构化 `@提及` 列表归一化为 `[{ id, name?, isAll?, isSelf? }]`。 */
function normalizeMentions(
  rawMentions: unknown,
  { atUserIds, atAll = false, selfId = '' }: { atUserIds?: unknown[]; atAll?: boolean; selfId?: string } = {},
): InboundMention[] {
  const selfStr = String(selfId ?? '');
  const list: InboundMention[] = [];
  const byKey = new Map<string, InboundMention>();
  const push = (item: { id?: unknown; name?: unknown; isAll?: boolean; isSelf?: unknown }): void => {
    const isAll = Boolean(item.isAll);
    const id = String(item.id || (isAll ? '__all__' : (item.name || ''))).trim();
    if (!id) return;
    const name = item.name ? String(item.name).replace(/^@/, '').trim() : undefined;
    const isSelf = typeof item.isSelf === 'boolean' ? item.isSelf : Boolean(selfStr && id === selfStr);
    const key = isAll ? '__all__' : id;
    const prev = byKey.get(key);
    if (prev) {
      if (name && !prev.name) prev.name = name;
      if (isSelf) prev.isSelf = true;
      return;
    }
    const entry: InboundMention = {
      id,
      ...(name ? { name } : {}),
      ...(isAll ? { isAll: true } : {}),
      ...(isSelf ? { isSelf: true } : {}),
    };
    byKey.set(key, entry);
    list.push(entry);
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
        const rec = m as AnyRecord;
        push({
          id: rec.id ?? rec.userId ?? rec.uid ?? rec.name ?? '',
          name: rec.name ?? rec.nick ?? rec.displayName,
          isAll: Boolean(rec.isAll),
          isSelf: rec.isSelf,
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
export function validateInboundEvent(ev: unknown): { ok: boolean; errors: string[]; event: InboundEvent | null } {
  const errors: string[] = [];
  if (!ev || typeof ev !== 'object') {
    return { ok: false, errors: ['事件必须为非空对象'], event: null };
  }
  const rec = ev as AnyRecord;
  const isRecall = rec.kind === 'recall';
  if (!rec.id || typeof rec.id !== 'string') errors.push('缺少字符串类型的 id');
  const chat = rec.chat as AnyRecord | undefined;
  if (!chat || typeof chat !== 'object') {
    errors.push('缺少 chat 对象');
  } else {
    if (!chat.id || typeof chat.id !== 'string') errors.push('chat.id 必须为非空字符串');
    if (!CHAT_TYPES.has(String(chat.type))) errors.push(`chat.type 非法：${String(chat.type)}（应为 self|direct|group|system）`);
  }
  const sender = rec.sender as AnyRecord | undefined;
  if (isRecall) {
    if (!rec.recalledMsgId || typeof rec.recalledMsgId !== 'string') errors.push('撤回事件缺少字符串类型的 recalledMsgId');
    if (rec.sender != null && typeof rec.sender !== 'object') errors.push('sender 必须为对象');
  } else {
    if (!sender || typeof sender !== 'object') {
      errors.push('缺少 sender 对象');
    } else {
      if (typeof sender.id !== 'string') errors.push('sender.id 必须为字符串');
      if (typeof sender.isSelf !== 'boolean') errors.push('sender.isSelf 必须为布尔值');
    }
    if (typeof rec.text !== 'string') errors.push('text 必须为字符串');
  }
  if (rec.mentions !== undefined && !Array.isArray(rec.mentions)) {
    errors.push('mentions 若存在必须为数组');
  }
  if (rec.attachments !== undefined) {
    if (!Array.isArray(rec.attachments)) {
      errors.push('attachments 若存在必须为数组');
    } else {
      for (let i = 0; i < rec.attachments.length; i++) {
        const a = rec.attachments[i] as AnyRecord | null;
        if (!a || !a.id || !a.name) errors.push(`attachments[${i}] 缺少 id 或 name`);
      }
    }
  }
  return { ok: errors.length === 0, errors, event: ev as InboundEvent };
}

/**
 * 将标准 InboundEvent 或通用扁平 IM 消息（FlatMessage）归一化为标准 InboundEvent。
 */
export function normalizeInboundEvent(
  raw: unknown,
  { selfId = '', selfChatId = '', atAllCountsAsMention = false }: {
    selfId?: string;
    selfChatId?: string;
    atAllCountsAsMention?: boolean;
  } = {},
): InboundEvent {
  if (!raw || typeof raw !== 'object') {
    throw new Error('消息体必须为对象');
  }
  const r = raw as AnyRecord;
  const rawChat = r.chat && typeof r.chat === 'object' ? (r.chat as AnyRecord) : null;
  const rawSender = r.sender && typeof r.sender === 'object' ? (r.sender as AnyRecord) : null;

  const selfStr = String(selfId ?? '');
  const isRecall = r.kind === 'recall' || r.type === 'recall' || r.eventType === 'recall';

  // 0. 消息撤回事件（兼容标准结构与扁平结构）
  if (isRecall) {
    const chatId = rawChat?.id ?? r.chatId;
    const recalledMsgId = r.recalledMsgId ?? r.targetMsgId ?? r.revokedMsgId;
    if (chatId == null || recalledMsgId == null) throw new Error('撤回事件缺少 chatId 或 recalledMsgId');
    const cid = String(chatId);
    const rawType = String(rawChat?.type ?? r.chatType ?? '');
    const chatType: ChatType = rawType === 'self' || (selfChatId && cid === selfChatId)
      ? 'self'
      : (CHAT_TYPES.has(rawType) ? (rawType as ChatType) : 'direct');
    const senderId = String(rawSender?.id ?? r.fromId ?? '');
    const senderName = rawSender?.name ?? r.fromName;
    const isSelf = typeof rawSender?.isSelf === 'boolean'
      ? rawSender.isSelf
      : (typeof r.isSelf === 'boolean' ? r.isSelf : Boolean(selfStr && senderId === selfStr));
    const ev: InboundEvent = {
      id: String(r.id ?? r.msgId ?? `recall_${String(recalledMsgId)}`),
      kind: 'recall',
      ts: Number(r.ts ?? r.time) || Date.now(),
      chat: {
        id: cid,
        type: chatType,
        ...((rawChat?.name || r.chatName) ? { name: String(rawChat?.name || r.chatName) } : {}),
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
  if (rawChat && rawSender) {
    if (r.id == null || rawChat.id == null) throw new Error('缺少 id 或 chat.id');
    const chatId = String(rawChat.id);
    const rawChatType = String(rawChat.type ?? '');
    const chatType: ChatType = rawChatType === 'self' || (selfChatId && chatId === selfChatId)
      ? 'self'
      : (CHAT_TYPES.has(rawChatType) ? (rawChatType as ChatType) : 'direct');
    const senderId = String(rawSender.id ?? '');
    const isSelf = typeof rawSender.isSelf === 'boolean'
      ? rawSender.isSelf
      : Boolean(selfId && senderId === String(selfId));
    const dev = r.device && typeof r.device === 'object' ? (r.device as AnyRecord) : null;
    const mentions = normalizeMentions(r.mentions, { selfId });
    const derivedMentionMe = mentions.some((m) => m.isSelf || (selfStr && m.id === selfStr) || (m.isAll && atAllCountsAsMention));
    const linkCard = normalizeLinkCard(r.linkCard ?? r.card);
    const forwarded = normalizeForwarded(r.forwarded ?? r.mergedForward ?? r.forwardMessages, String(r.id), normalizeLinkCard);
    const isForwarded = Boolean(r.isForwarded || r.forwardedFrom || forwarded);
    const ev: InboundEvent = {
      id: String(r.id),
      ts: Number(r.ts) || Date.now(),
      chat: {
        id: chatId,
        type: chatType,
        ...(rawChat.name ? { name: String(rawChat.name) } : {}),
      },
      sender: {
        id: senderId,
        ...(rawSender.name ? { name: String(rawSender.name) } : {}),
        isSelf,
      },
      ...(dev ? {
        device: {
          id: String(dev.id ?? ''),
          type: DEVICE_TYPES.has(String(dev.type)) ? (String(dev.type) as DeviceType) : 'unknown',
          ...(dev.name ? { name: String(dev.name) } : {}),
        },
      } : {}),
      text: String(r.text ?? ''),
      ...(linkCard ? { linkCard } : {}),
      ...(isForwarded ? { isForwarded: true } : {}),
      ...(forwarded ? { forwarded } : {}),
      ...(r.mentionsMe !== undefined ? { mentionsMe: Boolean(r.mentionsMe) } : (derivedMentionMe ? { mentionsMe: true } : {})),
      ...(mentions.length ? { mentions } : {}),
      ...(r.replyTo != null ? { replyTo: String(r.replyTo) } : {}),
      ...(Array.isArray(r.attachments) && r.attachments.length ? {
        attachments: (r.attachments as AnyRecord[])
          .filter((a) => a && a.id != null)
          .map((a) => ({
            id: String(a.id),
            msgId: String(a.msgId ?? r.id),
            name: String(a.name || a.id),
            ...(Number(a.size) ? { size: Number(a.size) } : {}),
            ...(a.mime ? { mime: String(a.mime) } : {}),
            ...(a.kind ? { kind: String(a.kind) } : {}),
            ...(Number(a.durationSec) > 0 ? { durationSec: Number(a.durationSec) } : {}),
            ...(a.transcript ? { transcript: String(a.transcript) } : {}),
          })),
      } : {}),
    };
    const checked = validateInboundEvent(ev);
    if (!checked.ok) throw new Error(checked.errors.join('；'));
    return ev;
  }

  // 2. 扁平结构（FlatMessage 快捷映射）
  if (r.msgId == null || r.chatId == null) throw new Error('缺少 msgId 或 chatId');
  const chatId = String(r.chatId);
  const type: ChatType = r.chatType === 'self' || (selfChatId && chatId === selfChatId)
    ? 'self'
    : (r.chatType === 'group' ? 'group' : (r.chatType === 'system' ? 'system' : 'direct'));
  const at = Array.isArray(r.atUserIds) ? r.atUserIds.map(String) : [];
  const d = r.fromDevice && typeof r.fromDevice === 'object' ? (r.fromDevice as AnyRecord) : null;
  const senderId = String(r.fromId ?? '');
  const mentions = normalizeMentions(r.mentions, { atUserIds: at, atAll: Boolean(r.atAll), selfId });
  const linkCard = normalizeLinkCard(r.linkCard ?? r.card);
  const forwarded = normalizeForwarded(r.forwarded ?? r.mergedForward ?? r.forwardMessages, String(r.msgId), normalizeLinkCard);
  const isForwarded = Boolean(r.isForwarded || r.forwardedFrom || forwarded);
  const ev: InboundEvent = {
    id: String(r.msgId),
    ts: Number(r.time) || Date.now(),
    chat: { id: chatId, type, name: r.chatName ? String(r.chatName) : undefined },
    sender: {
      id: senderId,
      name: r.fromName ? String(r.fromName) : undefined,
      isSelf: typeof r.isSelf === 'boolean' ? r.isSelf : Boolean(selfStr && senderId === selfStr),
    },
    device: d
      ? {
          id: String(d.id ?? ''),
          type: DEVICE_TYPES.has(String(d.type)) ? (String(d.type) as DeviceType) : 'unknown',
          name: d.name ? String(d.name) : undefined,
        }
      : undefined,
    text: String(r.text ?? ''),
    ...(linkCard ? { linkCard } : {}),
    ...(isForwarded ? { isForwarded: true } : {}),
    ...(forwarded ? { forwarded } : {}),
    mentionsMe: Boolean((r.mentionsMe !== undefined ? r.mentionsMe : false) || (selfStr && at.includes(selfStr)) || (r.atAll && atAllCountsAsMention) || mentions.some((m) => m.isSelf)),
    ...(mentions.length ? { mentions } : {}),
    replyTo: r.quoteMsgId != null ? String(r.quoteMsgId) : undefined,
    ...(Array.isArray(r.files) && r.files.length ? {
      attachments: (r.files as AnyRecord[])
        .filter((f) => f && f.fileId != null)
        .map((f) => ({
          id: String(f.fileId),
          msgId: String(r.msgId),
          name: String(f.name || f.fileId),
          size: Number(f.size) || undefined,
          mime: f.mime ? String(f.mime) : undefined,
          ...(f.kind ? { kind: String(f.kind) } : {}),
          ...(Number(f.durationSec) > 0 ? { durationSec: Number(f.durationSec) } : {}),
          ...(f.transcript ? { transcript: String(f.transcript) } : {}),
        })),
    } : {}),
  };
  const checked = validateInboundEvent(ev);
  if (!checked.ok) throw new Error(checked.errors.join('；'));
  return ev;
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
  }: ManagedChannelOptions) {
    this.name = name;
    this.adapter = adapter;
    this.capabilities = normalizeCapabilities(capabilities, adapter);
    this.selfId = String(selfId ?? '');
    this.selfChatId = selfChatId ? String(selfChatId) : '';
    this.atAllCountsAsMention = Boolean(atAllCountsAsMention);
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

  async #connectAdapter(): Promise<void> {
    if (this.stopped) return;
    let disconnectedDuringConnect = false;
    let connectPending = true;
    await this.adapter.start(
      (rawMsg) => {
        let ev: InboundEvent;
        try {
          ev = normalizeInboundEvent(rawMsg, {
            selfId: this.selfId,
            selfChatId: this.selfChatId,
            atAllCountsAsMention: this.atAllCountsAsMention,
          });
        } catch (e) {
          this.logger.error?.(`[channel:${this.name}] 无法识别的消息，已跳过：`, e instanceof Error ? e.message : e);
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
            ? `recall:${ev.recalledMsgId ?? ''}`
            : clipSummary(ev.text || (ev.attachments?.length ? `[附件 x${ev.attachments.length}]` : '')),
        });
        Promise.resolve(this.onEvent?.(ev)).catch((e) => {
          this.logger.error?.(`[channel:${this.name}] 处理入站事件异常：`, e instanceof Error ? e.message : e);
        });
      },
      {
        onDisconnect: (err) => {
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
    if (this.stopped) {
      await Promise.resolve(this.adapter.stop?.()).catch(() => {});
      return;
    }
    if (disconnectedDuringConnect) {
      this.#handleDisconnect(this.lastError || 'disconnected');
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

  async sendFile(chatId: string, file: ChannelSendFileInput, opts: ChannelSendOptions = {}): Promise<string | undefined> {
    if (!chatId) throw new Error('尚未获知目标会话 ID（selfChatId）');
    if (!this.canFiles || !this.adapter.sendFile) throw new Error(`通道「${this.name}」不支持发送文件`);
    const id = await this.adapter.sendFile(chatId, file, opts);
    this.#emit('channel:outbound', {
      kind: 'file',
      chatId: String(chatId),
      msgId: id ? String(id) : null,
      summary: clipSummary(file?.name || pathBasename(file?.path)),
    });
    return id != null ? String(id) : undefined;
  }

  async download(att: InboundAttachment, savePath: string): Promise<void> {
    if (typeof this.adapter?.download !== 'function') {
      throw new Error(`通道「${this.name}」未实现 download`);
    }
    await this.adapter.download(att, savePath);
  }

  #normalizeMaybeEvent(raw: unknown): InboundEvent | null {
    if (!raw || typeof raw !== 'object') return null;
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

  async getMessage(chatId: string, msgId: string): Promise<InboundEvent | null> {
    if (typeof this.adapter?.getMessage !== 'function') return null;
    const raw = await this.adapter.getMessage(chatId, msgId);
    return this.#normalizeMaybeEvent(raw);
  }

  async getHistory(chatId: string, opts: ChannelGetHistoryOptions = {}): Promise<InboundEvent[]> {
    if (typeof this.adapter?.getHistory !== 'function') return [];
    const list = await this.adapter.getHistory(chatId, opts);
    return Array.isArray(list)
      ? list.map((m) => this.#normalizeMaybeEvent(m)).filter((x): x is InboundEvent => x !== null)
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
  return {
    name,
    kind: 'channel',
    version: spec.version || '1.0.0',
    provides: ['channel'],
    capabilities: spec.capabilities,
    apply(ctx, opts = {} as TOptions) {
      const adapter = createFn(opts, ctx);
      const check = validateChannelAdapter(adapter, spec.capabilities);
      if (!check.ok) {
        throw new Error(`通道插件「${name}」不符合契约：${check.errors.join('；')}`);
      }
      const o = opts as AnyRecord;
      const managed = new ManagedChannel({
        name,
        capabilities: check.capabilities,
        adapter,
        selfId: typeof o.selfId === 'string' ? o.selfId : String(o.selfId ?? ''),
        selfChatId: typeof o.selfChatId === 'string' ? o.selfChatId : String(o.selfChatId ?? ''),
        atAllCountsAsMention: Boolean(o.atAllCountsAsMention ?? false),
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
