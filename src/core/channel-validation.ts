/**
 * 入站事件归一化、ID 规范校验、引用快照/混写检测与类型安全事件构造器。
 */
import { levenshtein } from '../openmausbot/mentions.ts';
import type {
  ChannelIdPatterns,
  ChatType,
  DeviceType,
  InboundAttachment,
  InboundChat,
  InboundEvent,
  InboundMention,
  InboundQuote,
  InboundSender,
} from '../types.ts';
import { normalizeForwarded, normalizeLinkCard } from './context-pull.ts';

export const CHAT_TYPES = new Set<string>(['self', 'direct', 'group', 'system']);
const DEVICE_TYPES = new Set<string>(['mobile', 'desktop', 'pad', 'web', 'unknown']);
const SCOPED_CHAT_PREFIX: Record<ChatType, string> = {
  self: 'self:',
  direct: 'dm:',
  group: 'grp:',
  system: 'sys:',
};
const PREFIX_TO_CHAT_TYPE: Array<[string, ChatType]> = [
  ['self:', 'self'],
  ['dm:', 'direct'],
  ['grp:', 'group'],
  ['sys:', 'system'],
];
const SNOWFLAKE_WARN_THRESHOLD = 1e15;

type AnyRecord = Record<string, unknown>;

export interface NormalizeInboundOptions {
  selfId?: string;
  selfChatId?: string;
  atAllCountsAsMention?: boolean;
  idPatterns?: ChannelIdPatterns | null;
  strict?: boolean;
  onWarning?: (msg: string) => void;
}

function isPlainRecord(val: unknown): val is AnyRecord {
  return Boolean(val && typeof val === 'object' && !Array.isArray(val));
}

export function matchIdPattern(re: RegExp | undefined, val: string): boolean {
  if (!re) return true;
  if (re.global || re.sticky) re.lastIndex = 0;
  return re.test(val);
}

function coerceId(
  raw: unknown,
  field: string,
  onWarning?: (msg: string) => void,
  { required = false }: { required?: boolean } = {},
): string {
  if (raw === undefined || raw === null) {
    if (required) throw new Error(`缺少必填标识 ${field}`);
    return '';
  }
  if (typeof raw === 'object' || typeof raw === 'function' || typeof raw === 'symbol') {
    throw new Error(`${field} 必须为字符串或数字，不能是对象`);
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new Error(`${field} 数值非法（NaN/Infinity）`);
    if (!Number.isSafeInteger(raw) || Math.abs(raw) >= SNOWFLAKE_WARN_THRESHOLD) {
      onWarning?.(`${field} 传入了大整数（${String(raw)}），请直接在 JSON/SDK 层保持为 string，以免超过 JS 安全整数精度丢失尾位`);
    }
  }
  const s = String(raw).trim();
  if (!s || s === '[object Object]' || s === 'undefined' || s === 'null') {
    if (required || s === '[object Object]') {
      throw new Error(`${field} 无效或为空（${JSON.stringify(raw)}）`);
    }
    return '';
  }
  return s;
}

/** 为单聊/群聊容易撞号的 IM 平台构造带作用域前缀的 `chat.id`（例如 `dm:1001` / `grp:1001`）。 */
export function encodeScopedChatId(type: ChatType, rawId: string): string {
  if (!CHAT_TYPES.has(type)) throw new Error(`无效的 chatType：${String(type)}`);
  const clean = coerceId(rawId, 'rawId', undefined, { required: true });
  for (const [prefix] of PREFIX_TO_CHAT_TYPE) {
    if (clean.startsWith(prefix)) return clean;
  }
  return `${SCOPED_CHAT_PREFIX[type]}${clean}`;
}

/** 解析 `encodeScopedChatId` 生成的带作用域前缀会话 ID；无前缀时返回 `null`。 */
export function decodeScopedChatId(chatId: string): { type: ChatType; rawId: string } | null {
  const clean = String(chatId ?? '').trim();
  for (const [prefix, type] of PREFIX_TO_CHAT_TYPE) {
    if (clean.startsWith(prefix)) {
      return { type, rawId: clean.slice(prefix.length) };
    }
  }
  return null;
}

/** 按适配器声明的 `idPatterns` 校验单条事件中的用户/会话/消息 ID 格式。 */
export function validateIdsAgainstPatterns(
  ev: Partial<InboundEvent> | null | undefined,
  patterns?: ChannelIdPatterns | null,
): string[] {
  if (!ev || !patterns) return [];
  const errs: string[] = [];
  if (ev.id && patterns.msgId && !matchIdPattern(patterns.msgId, ev.id)) {
    errs.push(`id=${JSON.stringify(ev.id)} 不符合 msgId 规范 ${patterns.msgId}`);
  }
  const cid = ev.chat?.id || '';
  const ctype = ev.chat?.type;
  if (cid) {
    if (patterns.chatId && !matchIdPattern(patterns.chatId, cid)) {
      errs.push(`chat.id=${JSON.stringify(cid)} 不符合 chatId 规范 ${patterns.chatId}`);
    }
    if (ctype === 'group' && patterns.groupChatId && !matchIdPattern(patterns.groupChatId, cid)) {
      errs.push(`群会话 chat.id=${JSON.stringify(cid)} 不符合 groupChatId 规范 ${patterns.groupChatId}`);
    }
    if (ctype === 'direct' && patterns.directChatId && !matchIdPattern(patterns.directChatId, cid)) {
      errs.push(`私聊会话 chat.id=${JSON.stringify(cid)} 不符合 directChatId 规范 ${patterns.directChatId}`);
    }
  }
  if (ev.kind !== 'recall' && ev.sender?.id && patterns.userId && !matchIdPattern(patterns.userId, ev.sender.id)) {
    errs.push(`sender.id=${JSON.stringify(ev.sender.id)} 不符合 userId 规范 ${patterns.userId}`);
  }
  if (ev.replyTo && patterns.msgId && !matchIdPattern(patterns.msgId, ev.replyTo)) {
    errs.push(`replyTo=${JSON.stringify(ev.replyTo)} 不符合 msgId 规范 ${patterns.msgId}`);
  }
  if (ev.quote?.senderId && patterns.userId && !matchIdPattern(patterns.userId, ev.quote.senderId)) {
    errs.push(`quote.senderId=${JSON.stringify(ev.quote.senderId)} 不符合 userId 规范 ${patterns.userId}`);
  }
  if (ev.recalledMsgId && patterns.msgId && !matchIdPattern(patterns.msgId, ev.recalledMsgId)) {
    errs.push(`recalledMsgId=${JSON.stringify(ev.recalledMsgId)} 不符合 msgId 规范 ${patterns.msgId}`);
  }
  if (Array.isArray(ev.mentions) && patterns.userId) {
    for (const m of ev.mentions) {
      if (!m || m.isAll || m.idKind === 'name_fallback' || !m.id) continue;
      if (!matchIdPattern(patterns.userId, m.id)) {
        errs.push(`mentions[].id=${JSON.stringify(m.id)} 不符合 userId 规范 ${patterns.userId}`);
      }
    }
  }
  return errs;
}

/** 启动/契约检查时校验配置中的 `selfId` / `selfChatId` / `collaborators` / `allowChatIds` / `denyChatIds` 是否符合 `idPatterns`。 */
export function validateConfigIdsAgainstPatterns(
  cfg: {
    selfId?: string;
    selfChatId?: string;
    collaborators?: Array<{ id?: string }>;
    allowChatIds?: string[];
    denyChatIds?: string[];
  },
  patterns?: ChannelIdPatterns | null,
): string[] {
  if (!patterns) return [];
  const errs: string[] = [];
  if (cfg.selfId && patterns.userId && !matchIdPattern(patterns.userId, cfg.selfId)) {
    errs.push(`channel.options.selfId=${JSON.stringify(cfg.selfId)} 不符合 userId 规范 ${patterns.userId}`);
  }
  if (cfg.selfChatId && patterns.chatId && !matchIdPattern(patterns.chatId, cfg.selfChatId)) {
    errs.push(`channel.options.selfChatId=${JSON.stringify(cfg.selfChatId)} 不符合 chatId 规范 ${patterns.chatId}`);
  }
  for (const col of cfg.collaborators ?? []) {
    const uid = String(col?.id ?? '').trim();
    if (uid && patterns.userId && !matchIdPattern(patterns.userId, uid)) {
      errs.push(`chats.collaborators[].id=${JSON.stringify(uid)} 不符合 userId 规范 ${patterns.userId}`);
    }
  }
  for (const [label, list] of [['allowChatIds', cfg.allowChatIds], ['denyChatIds', cfg.denyChatIds]] as const) {
    for (const rawCid of list ?? []) {
      const cid = String(rawCid ?? '').trim();
      if (!cid) continue;
      const scoped = decodeScopedChatId(cid);
      if (patterns.chatId && !matchIdPattern(patterns.chatId, cid)) {
        errs.push(`chats.${label} 中的 ${JSON.stringify(cid)} 不符合 chatId 规范 ${patterns.chatId}`);
      } else if (scoped?.type === 'group' && patterns.groupChatId && !matchIdPattern(patterns.groupChatId, cid)) {
        errs.push(`chats.${label} 中的 ${JSON.stringify(cid)} 不符合 groupChatId 规范 ${patterns.groupChatId}`);
      } else if (scoped?.type === 'direct' && patterns.directChatId && !matchIdPattern(patterns.directChatId, cid)) {
        errs.push(`chats.${label} 中的 ${JSON.stringify(cid)} 不符合 directChatId 规范 ${patterns.directChatId}`);
      }
    }
  }
  return errs;
}

/** 将各家 IM 的结构化 `@提及` 列表归一化为 `[{ id, name?, isAll?, isSelf?, idKind? }]`。 */
function normalizeMentions(
  rawMentions: unknown,
  {
    atUserIds,
    atAll = false,
    selfId = '',
    onWarning,
  }: { atUserIds?: unknown[]; atAll?: boolean; selfId?: string; onWarning?: (msg: string) => void } = {},
): InboundMention[] {
  const selfStr = String(selfId ?? '');
  const list: InboundMention[] = [];
  const byKey = new Map<string, InboundMention>();
  const push = (item: { id?: unknown; name?: unknown; isAll?: boolean; isSelf?: unknown; idKind?: unknown }): void => {
    const isAll = Boolean(item.isAll);
    const explicitId = isAll ? '__all__' : coerceId(item.id, 'mentions[].id', onWarning);
    const name = item.name ? String(item.name).replace(/^@/, '').trim() : undefined;
    const isFallback = !isAll && !explicitId && Boolean(name);
    const id = explicitId || name || '';
    if (!id) return;
    if (isFallback) {
      onWarning?.(`mentions 中「@${name}」缺少真实用户 id，已标记为 idKind="name_fallback"（仅作展示，不会作为可追踪的真实用户 ID 写入成员表）`);
    }
    const idKind: 'platform' | 'name_fallback' | undefined = isAll
      ? undefined
      : (item.idKind === 'name_fallback' || isFallback ? 'name_fallback' : 'platform');
    const isSelf = typeof item.isSelf === 'boolean'
      ? item.isSelf
      : Boolean(selfStr && !isFallback && id === selfStr);
    const key = isAll ? '__all__' : (isFallback ? `name:${id.toLowerCase()}` : id);
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
      ...(idKind ? { idKind } : {}),
    };
    byKey.set(key, entry);
    list.push(entry);
  };
  if (Array.isArray(rawMentions)) {
    for (const m of rawMentions) {
      if (!m) continue;
      if (typeof m === 'string') {
        const clean = m.replace(/^@/, '').trim();
        if (clean) push({ name: clean, idKind: 'name_fallback' });
        continue;
      }
      if (typeof m === 'object') {
        const rec = m as AnyRecord;
        push({
          id: rec.id ?? rec.userId ?? rec.uid,
          name: rec.name ?? rec.nick ?? rec.displayName,
          isAll: Boolean(rec.isAll),
          isSelf: rec.isSelf,
          idKind: rec.idKind,
        });
      }
    }
  }
  if (Array.isArray(atUserIds)) {
    for (const uid of atUserIds) {
      const cleanUid = coerceId(uid, 'atUserIds[]', onWarning);
      if (cleanUid) push({ id: cleanUid, idKind: 'platform' });
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
  if (typeof rec.id !== 'string' || !rec.id.trim() || rec.id === '[object Object]') {
    errors.push('缺少非空字符串类型的 id');
  }
  const chat = rec.chat as AnyRecord | undefined;
  if (!chat || typeof chat !== 'object') {
    errors.push('缺少 chat 对象');
  } else {
    if (typeof chat.id !== 'string' || !chat.id.trim() || chat.id === '[object Object]') {
      errors.push('chat.id 必须为非空字符串');
    }
    if (!CHAT_TYPES.has(String(chat.type))) errors.push(`chat.type 非法：${String(chat.type)}（应为 self|direct|group|system）`);
  }
  const sender = rec.sender as AnyRecord | undefined;
  if (isRecall) {
    if (typeof rec.recalledMsgId !== 'string' || !rec.recalledMsgId.trim()) {
      errors.push('撤回事件缺少非空字符串类型的 recalledMsgId');
    }
    if (rec.sender != null && typeof rec.sender !== 'object') errors.push('sender 必须为对象');
  } else {
    if (!sender || typeof sender !== 'object') {
      errors.push('缺少 sender 对象');
    } else {
      if (typeof sender.id !== 'string' || !sender.id.trim() || sender.id === '[object Object]') {
        errors.push('sender.id 必须为非空字符串');
      }
      if (typeof sender.isSelf !== 'boolean') errors.push('sender.isSelf 必须为布尔值');
    }
    if (typeof rec.text !== 'string') errors.push('text 必须为字符串');
  }
  if (rec.replyTo !== undefined && (typeof rec.replyTo !== 'string' || !rec.replyTo.trim())) {
    errors.push('replyTo 若存在必须为非空字符串');
  }
  if (rec.quote !== undefined) {
    if (!isPlainRecord(rec.quote) || typeof rec.quote.msgId !== 'string' || !rec.quote.msgId.trim()) {
      errors.push('quote 若存在必须为包含非空 msgId 的对象');
    } else if (typeof rec.replyTo === 'string' && rec.replyTo.trim() && rec.replyTo !== rec.quote.msgId) {
      errors.push(`replyTo (${rec.replyTo}) 与 quote.msgId (${rec.quote.msgId}) 不一致`);
    }
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
        if (!a || typeof a.id !== 'string' || !a.id.trim() || typeof a.name !== 'string' || !a.name.trim()) {
          errors.push(`attachments[${i}] 缺少非空 id 或 name`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors, event: ev as InboundEvent };
}

const STANDARD_KEYS = new Set([
  'id', 'kind', 'ts', 'chat', 'sender', 'device', 'text',
  'linkCard', 'card', 'isForwarded', 'forwardedFrom', 'forwarded', 'mergedForward', 'forwardMessages',
  'mentionsMe', 'mentions', 'replyTo', 'quote', 'recalledMsgId', 'attachments',
]);
const FLAT_ONLY_KEYS_IN_STD = new Map<string, string>([
  ['msgId', 'id'],
  ['chatId', 'chat.id'],
  ['chatType', 'chat.type'],
  ['chatName', 'chat.name'],
  ['fromId', 'sender.id'],
  ['fromName', 'sender.name'],
  ['fromDevice', 'device'],
  ['quoteMsgId', 'replyTo / quote.msgId'],
  ['quoteSenderId', 'quote.senderId'],
  ['quoteSenderName', 'quote.senderName'],
  ['quoteText', 'quote.text'],
  ['atUserIds', 'mentions'],
  ['atAll', 'mentions'],
  ['files', 'attachments'],
  ['time', 'ts'],
]);
const STD_ONLY_KEYS_IN_FLAT = new Map<string, string>([
  ['id', 'msgId'],
  ['senderId', 'fromId'],
  ['senderName', 'fromName'],
  ['sender', 'fromId/fromName/isSelf'],
  ['chat', 'chatId/chatType/chatName'],
  ['replyTo', 'quoteMsgId'],
  ['attachments', 'files'],
  ['device', 'fromDevice'],
  ['ts', 'time'],
]);
const FLAT_KEYS = new Set([
  'msgId', 'kind', 'type', 'eventType', 'time', 'chatId', 'chatType', 'chatName',
  'fromId', 'fromName', 'isSelf', 'fromDevice', 'text',
  'linkCard', 'card', 'isForwarded', 'forwardedFrom', 'forwarded', 'mergedForward', 'forwardMessages',
  'mentionsMe', 'mentions', 'atUserIds', 'atAll',
  'quoteMsgId', 'quote', 'quoteSenderId', 'quoteSenderName', 'quoteIsSelf', 'quoteText', 'quoteTs', 'quoteChatId',
  'files', 'recalledMsgId', 'targetMsgId', 'revokedMsgId',
]);

function warnUnknownOrMixedKeys(
  r: AnyRecord,
  mode: 'standard' | 'flat' | 'recall',
  onWarning: (msg: string) => void,
): void {
  if (mode === 'recall') return;
  const allowed = mode === 'standard' ? STANDARD_KEYS : FLAT_KEYS;
  const mixedMap = mode === 'standard' ? FLAT_ONLY_KEYS_IN_STD : STD_ONLY_KEYS_IN_FLAT;
  const allowedList = [...allowed];
  for (const key of Object.keys(r)) {
    if (allowed.has(key)) continue;
    const alt = mixedMap.get(key);
    if (alt) {
      onWarning(`混写了字段「${key}」：在${mode === 'standard' ? '标准 InboundEvent' : '扁平 FlatMessage'}中应使用「${alt}」，避免被忽略`);
      continue;
    }
    let best = '';
    let bestDist = Infinity;
    const low = key.toLowerCase();
    for (const k of allowedList) {
      const d = levenshtein(low, k.toLowerCase());
      if (d < bestDist) { bestDist = d; best = k; }
    }
    onWarning(
      bestDist <= 2 && best
        ? `未知入站字段「${key}」，你是不是想写「${best}」？`
        : `未知入站字段「${key}」（将被忽略）`,
    );
  }
}

function resolveChatTypeStrict(
  rawTypeRaw: unknown,
  chatId: string,
  selfChatId: string,
  onWarning: (msg: string) => void,
): ChatType {
  const rawType = rawTypeRaw == null ? '' : String(rawTypeRaw).trim();
  if (rawType && !CHAT_TYPES.has(rawType)) {
    throw new Error(`chat.type 非法：${JSON.stringify(rawType)}（必须为 self | direct | group | system）`);
  }
  if (rawType === 'self' || (selfChatId && chatId === selfChatId)) {
    if (rawType && rawType !== 'self') {
      onWarning(`会话 ${chatId} 命中 selfChatId，已将 chat.type 从 ${rawType} 修正为 self`);
    }
    return 'self';
  }
  if (!rawType) {
    const inferred = decodeScopedChatId(chatId);
    if (inferred) return inferred.type;
    onWarning(`会话 ${chatId} 缺少 chat.type，已默认按 direct 处理（建议显式传入 self|direct|group|system）`);
    return 'direct';
  }
  return rawType as ChatType;
}

function normalizeQuoteField(
  r: AnyRecord,
  rawReplyTo: unknown,
  selfId: string,
  onWarning: (msg: string) => void,
): { replyTo?: string; quote?: InboundQuote } {
  const replyToStr = coerceId(rawReplyTo, 'replyTo', onWarning);
  const rawQuote = isPlainRecord(r.quote) ? r.quote : null;
  const qMsgIdFromObj = rawQuote ? coerceId(rawQuote.msgId ?? rawQuote.id, 'quote.msgId', onWarning) : '';
  const qSenderRaw = rawQuote ? (rawQuote.senderId ?? rawQuote.fromId) : r.quoteSenderId;
  const qSenderId = coerceId(qSenderRaw, 'quote.senderId', onWarning);
  const qSenderNameRaw = rawQuote ? (rawQuote.senderName ?? rawQuote.fromName) : r.quoteSenderName;
  const qSenderName = qSenderNameRaw != null ? String(qSenderNameRaw).trim() : '';
  const qIsSelfRaw = rawQuote ? rawQuote.isSelf : r.quoteIsSelf;
  const qTextRaw = rawQuote ? (rawQuote.text ?? rawQuote.content) : r.quoteText;
  const qText = qTextRaw != null ? String(qTextRaw) : '';
  const qTs = Number(rawQuote ? (rawQuote.ts ?? rawQuote.time) : r.quoteTs);
  const qChatId = coerceId(rawQuote ? rawQuote.chatId : r.quoteChatId, 'quote.chatId', onWarning);

  const msgId = qMsgIdFromObj || replyToStr;
  if (qMsgIdFromObj && replyToStr && qMsgIdFromObj !== replyToStr) {
    throw new Error(`replyTo (${replyToStr}) 与 quote.msgId (${qMsgIdFromObj}) 不一致`);
  }
  if (!msgId) {
    if (rawQuote || qSenderId || qText) {
      throw new Error('传入了 quote 上下文但缺少 msgId / replyTo / quoteMsgId');
    }
    return {};
  }

  const hasQuotePayload = Boolean(rawQuote || qSenderId || qSenderName || qText || qChatId || (Number.isFinite(qTs) && qTs > 0));
  if (!hasQuotePayload) {
    return { replyTo: msgId };
  }
  const isSelf = typeof qIsSelfRaw === 'boolean'
    ? qIsSelfRaw
    : (selfId && qSenderId ? qSenderId === selfId : undefined);
  return {
    replyTo: msgId,
    quote: {
      msgId,
      ...(qSenderId ? { senderId: qSenderId } : {}),
      ...(qSenderName ? { senderName: qSenderName } : {}),
      ...(isSelf !== undefined ? { isSelf } : {}),
      ...(qText ? { text: qText } : {}),
      ...(Number.isFinite(qTs) && qTs > 0 ? { ts: qTs } : {}),
      ...(qChatId ? { chatId: qChatId } : {}),
    },
  };
}

function normalizeAttachmentsField(
  rawList: unknown,
  idKey: 'id' | 'fileId',
  parentMsgId: string,
  chatId: string,
  onWarning: (msg: string) => void,
): InboundAttachment[] | undefined {
  if (!Array.isArray(rawList) || !rawList.length) return undefined;
  const out: InboundAttachment[] = [];
  for (const rawItem of rawList) {
    if (!rawItem || typeof rawItem !== 'object') continue;
    const a = rawItem as AnyRecord;
    const rawAid = idKey === 'fileId' ? (a.fileId ?? a.id) : (a.id ?? a.fileId);
    const aid = coerceId(rawAid, `attachments[].${idKey}`, onWarning);
    if (!aid) continue;
    const attMsgId = coerceId(a.msgId, 'attachments[].msgId', onWarning) || parentMsgId;
    const attChatId = coerceId(a.chatId, 'attachments[].chatId', onWarning) || chatId;
    const extra = isPlainRecord(a.extra) ? { ...a.extra } : undefined;
    out.push({
      id: aid,
      msgId: attMsgId,
      ...(attChatId ? { chatId: attChatId } : {}),
      name: String(a.name || aid),
      ...(Number(a.size) ? { size: Number(a.size) } : {}),
      ...(a.mime ? { mime: String(a.mime) } : {}),
      ...(a.kind ? { kind: String(a.kind) } : {}),
      ...(Number(a.durationSec) > 0 ? { durationSec: Number(a.durationSec) } : {}),
      ...(a.transcript ? { transcript: String(a.transcript) } : {}),
      ...(extra && Object.keys(extra).length ? { extra } : {}),
    });
  }
  return out.length ? out : undefined;
}

/** 将标准 InboundEvent 或通用扁平 IM 消息（FlatMessage）归一化为标准 InboundEvent。 */
export function normalizeInboundEvent(
  raw: unknown,
  {
    selfId = '',
    selfChatId = '',
    atAllCountsAsMention = false,
    idPatterns = null,
    strict = false,
    onWarning,
  }: NormalizeInboundOptions = {},
): InboundEvent {
  if (!raw || typeof raw !== 'object') {
    throw new Error('消息体必须为对象');
  }
  const warnings: string[] = [];
  const warn = (msg: string): void => {
    warnings.push(msg);
    onWarning?.(msg);
  };

  const r = raw as AnyRecord;
  const rawChat = r.chat && typeof r.chat === 'object' ? (r.chat as AnyRecord) : null;
  const rawSender = r.sender && typeof r.sender === 'object' ? (r.sender as AnyRecord) : null;

  const selfStr = coerceId(selfId, 'options.selfId', warn);
  const selfChatStr = coerceId(selfChatId, 'options.selfChatId', warn);
  const isRecall = r.kind === 'recall' || r.type === 'recall' || r.eventType === 'recall';

  const finalize = (ev: InboundEvent, { explicitIsSelf }: { explicitIsSelf: boolean }): InboundEvent => {
    const checked = validateInboundEvent(ev);
    if (!checked.ok) throw new Error(checked.errors.join('；'));

    if (ev.kind !== 'recall') {
      if (selfStr) {
        if (ev.sender.isSelf && ev.sender.id !== selfStr) {
          warn(`身份一致性异常：sender.isSelf=true 但 sender.id=${JSON.stringify(ev.sender.id)} != options.selfId=${JSON.stringify(selfStr)}（疑似把 open_id/user_id/昵称传混）`);
        } else if (!ev.sender.isSelf && ev.sender.id === selfStr) {
          warn(`身份一致性异常：sender.id=${JSON.stringify(ev.sender.id)} 等于 options.selfId，但 sender.isSelf=false`);
        }
      }
      if (ev.chat.type === 'self' && !ev.sender.isSelf) {
        if (explicitIsSelf) {
          throw new Error('自聊会话（chat.type="self"）收到明确标记 sender.isSelf=false 的非本人消息');
        }
        warn('自聊会话（chat.type="self"）推导得到 sender.isSelf=false，请确认是否漏传了 options.selfId 或 sender.isSelf');
      }
    }

    for (const err of validateIdsAgainstPatterns(ev, idPatterns)) {
      warn(err);
    }

    if (strict && warnings.length > 0) {
      throw new Error(warnings.join('；'));
    }
    return ev;
  };

  if (isRecall) {
    const cid = coerceId(rawChat?.id ?? r.chatId, 'chat.id', warn, { required: true });
    const recalledMsgId = coerceId(r.recalledMsgId ?? r.targetMsgId ?? r.revokedMsgId, 'recalledMsgId', warn, { required: true });
    const chatType = resolveChatTypeStrict(rawChat?.type ?? r.chatType, cid, selfChatStr, warn);
    const senderId = coerceId(rawSender?.id ?? r.fromId, 'sender.id', warn);
    const senderName = rawSender?.name ?? r.fromName;
    const explicitIsSelf = typeof rawSender?.isSelf === 'boolean' || typeof r.isSelf === 'boolean';
    const isSelf = typeof rawSender?.isSelf === 'boolean'
      ? rawSender.isSelf
      : (typeof r.isSelf === 'boolean' ? r.isSelf : Boolean(selfStr && senderId === selfStr));
    const evId = coerceId(r.id ?? r.msgId, 'id', warn) || `recall_${recalledMsgId}`;
    const ev: InboundEvent = {
      id: evId,
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
      recalledMsgId,
      text: '',
    };
    return finalize(ev, { explicitIsSelf });
  }

  if (rawChat && rawSender) {
    warnUnknownOrMixedKeys(r, 'standard', warn);
    const evId = coerceId(r.id, 'id', warn, { required: true });
    const chatId = coerceId(rawChat.id, 'chat.id', warn, { required: true });
    const chatType = resolveChatTypeStrict(rawChat.type, chatId, selfChatStr, warn);
    const senderId = coerceId(rawSender.id, 'sender.id', warn, { required: true });
    const explicitIsSelf = typeof rawSender.isSelf === 'boolean';
    const isSelf = explicitIsSelf ? (rawSender.isSelf as boolean) : Boolean(selfStr && senderId === selfStr);
    const dev = r.device && typeof r.device === 'object' ? (r.device as AnyRecord) : null;
    const mentions = normalizeMentions(r.mentions, { selfId: selfStr, onWarning: warn });
    const derivedMentionMe = mentions.some((m) => m.isSelf || (selfStr && m.idKind !== 'name_fallback' && m.id === selfStr) || (m.isAll && atAllCountsAsMention));
    const linkCard = normalizeLinkCard(r.linkCard ?? r.card);
    const forwarded = normalizeForwarded(r.forwarded ?? r.mergedForward ?? r.forwardMessages, evId, normalizeLinkCard);
    const isForwarded = Boolean(r.isForwarded || r.forwardedFrom || forwarded);
    const quoteNorm = normalizeQuoteField(r, r.replyTo, selfStr, warn);
    const attachments = normalizeAttachmentsField(r.attachments, 'id', evId, chatId, warn);
    const ev: InboundEvent = {
      id: evId,
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
      ...(quoteNorm.replyTo ? { replyTo: quoteNorm.replyTo } : {}),
      ...(quoteNorm.quote ? { quote: quoteNorm.quote } : {}),
      ...(attachments ? { attachments } : {}),
    };
    return finalize(ev, { explicitIsSelf });
  }

  warnUnknownOrMixedKeys(r, 'flat', warn);
  const evId = coerceId(r.msgId, 'msgId', warn, { required: true });
  const chatId = coerceId(r.chatId, 'chatId', warn, { required: true });
  const type = resolveChatTypeStrict(r.chatType, chatId, selfChatStr, warn);
  const at = Array.isArray(r.atUserIds) ? r.atUserIds.map((x) => coerceId(x, 'atUserIds[]', warn)).filter(Boolean) : [];
  const d = r.fromDevice && typeof r.fromDevice === 'object' ? (r.fromDevice as AnyRecord) : null;
  const senderId = coerceId(r.fromId, 'fromId', warn, { required: true });
  const explicitIsSelf = typeof r.isSelf === 'boolean';
  const mentions = normalizeMentions(r.mentions, { atUserIds: at, atAll: Boolean(r.atAll), selfId: selfStr, onWarning: warn });
  const linkCard = normalizeLinkCard(r.linkCard ?? r.card);
  const forwarded = normalizeForwarded(r.forwarded ?? r.mergedForward ?? r.forwardMessages, evId, normalizeLinkCard);
  const isForwarded = Boolean(r.isForwarded || r.forwardedFrom || forwarded);
  const quoteNorm = normalizeQuoteField(r, r.quoteMsgId, selfStr, warn);
  const attachments = normalizeAttachmentsField(r.files, 'fileId', evId, chatId, warn);
  const ev: InboundEvent = {
    id: evId,
    ts: Number(r.time) || Date.now(),
    chat: { id: chatId, type, name: r.chatName ? String(r.chatName) : undefined },
    sender: {
      id: senderId,
      name: r.fromName ? String(r.fromName) : undefined,
      isSelf: explicitIsSelf ? (r.isSelf as boolean) : Boolean(selfStr && senderId === selfStr),
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
    ...(quoteNorm.replyTo ? { replyTo: quoteNorm.replyTo } : {}),
    ...(quoteNorm.quote ? { quote: quoteNorm.quote } : {}),
    ...(attachments ? { attachments } : {}),
  };
  return finalize(ev, { explicitIsSelf });
}

/** 类型安全的标准入站消息构造器（推荐第三方 IM 插件使用，自动执行归一化与严格契约校验）。 */
export function createInboundMessage(
  input: Omit<InboundEvent, 'kind' | 'ts' | 'recalledMsgId'> & { ts?: number },
  opts: NormalizeInboundOptions = {},
): InboundEvent {
  return normalizeInboundEvent({ ...input, ts: input.ts ?? Date.now() }, { strict: true, ...opts });
}

/** 类型安全的撤回事件构造器。 */
export function createRecallEvent(
  input: {
    id?: string;
    ts?: number;
    chat: InboundChat;
    sender?: Partial<InboundSender>;
    recalledMsgId: string;
  },
  opts: NormalizeInboundOptions = {},
): InboundEvent {
  return normalizeInboundEvent(
    {
      kind: 'recall',
      id: input.id || `recall_${input.recalledMsgId}`,
      ts: input.ts ?? Date.now(),
      chat: input.chat,
      ...(input.sender ? { sender: input.sender } : {}),
      recalledMsgId: input.recalledMsgId,
    },
    { strict: true, ...opts },
  );
}
