/**
 * 转发消息归一化、摘要格式化与本地按需拉取上下文管理（`/api/context/history`、`/api/context/attachment`）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import type {
  ChatContextMessage,
  ForwardedBundle,
  ForwardedMessageItem,
  InboundAttachment,
  InboundEvent,
  LinkCard,
} from '../types.ts';
import { scanAndRedactOutbound } from './security.ts';

type AnyRecord = Record<string, unknown>;

const MAX_FORWARDED_ITEMS = 50;
const ARTIFACT_REF_RE = /(图|截图|图片|照片|日志|文档|文件|附件|报错|表格|pdf|docx?|xlsx?|pptx?|csv|md|txt|log|png|jpg|webp|screenshot|image|file|上面|这几张|这几个|刚发|以上|前面|前文|刚才|刚刚|转发|聊天记录|这几条|这些)/i;
const TEXT_EXT_RE = /\.(?:txt|md|log|json|csv|tsv|ya?ml|xml|ini|conf|ts|tsx|js|jsx|mjs|cjs|py|sh|sql|html?|css)$/i;
const EXT_MIME: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

function guessMimeFromName(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return EXT_MIME[ext] || 'application/octet-stream';
}

function isTextLikeAttachment(name: string, mime: string): boolean {
  const lowMime = String(mime || '').toLowerCase();
  return lowMime.startsWith('text/')
    || /^application\/(?:json|xml|javascript|x-sh|yaml)/i.test(lowMime)
    || TEXT_EXT_RE.test(name);
}

function pushMsgAttachments(
  msg: ChatContextMessage,
  out: InboundAttachment[],
  seen: Set<string>,
  srcSet: Set<string>,
  cap: number,
): void {
  const lists: Array<{ fallbackId: string; atts?: InboundAttachment[] }> = [
    { fallbackId: String(msg.id ?? ''), atts: msg.attachments },
  ];
  if (Array.isArray(msg.forwarded?.messages)) {
    for (const item of msg.forwarded.messages) {
      if (item.attachments?.length) {
        lists.push({ fallbackId: String(item.id ?? msg.id ?? ''), atts: item.attachments });
      }
    }
  }
  for (const group of lists) {
    if (!group.atts?.length || out.length >= cap) continue;
    for (const a of group.atts) {
      if (!a || a.id == null) continue;
      const msgId = String(a.msgId ?? group.fallbackId);
      const key = `${msgId}:${a.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...a, msgId });
      if (msgId) srcSet.add(msgId);
      if (out.length >= cap) return;
    }
  }
}

/** 收集单条消息及其合并转发子树中的所有附件（自动去重）。 */
export function collectAllMsgAttachments(msg: ChatContextMessage | null | undefined): InboundAttachment[] {
  if (!msg) return [];
  const out: InboundAttachment[] = [];
  pushMsgAttachments(msg, out, new Set<string>(), new Set<string>(), Number.MAX_SAFE_INTEGER);
  return out;
}

/** 收集会话上下文中待随提问提交的多附件（支持被引用消息、合并转发内附件、连发批次及最近转发消息）。 */
export function collectContextAttachments({
  triggerEvent,
  quotedMsg = null,
  recentMsgs = [],
  windowMs = 120_000,
  maxAttachments = 4,
  allowSelf = false,
}: {
  triggerEvent?: Partial<InboundEvent> | null;
  quotedMsg?: ChatContextMessage | null;
  recentMsgs?: ChatContextMessage[];
  windowMs?: number;
  maxAttachments?: number;
  allowSelf?: boolean;
} = {}): { attachments: InboundAttachment[]; sourceMsgIds: string[] } {
  const empty = { attachments: [] as InboundAttachment[], sourceMsgIds: [] as string[] };
  if (!triggerEvent || (!allowSelf && triggerEvent?.chat?.type === 'self')) return empty;
  const cap = Math.max(0, Number(maxAttachments) || 0);
  const winMs = Math.max(0, Number(windowMs) || 0);
  if (!cap) return empty;

  const out: InboundAttachment[] = [];
  const seen = new Set<string>();
  const srcSet = new Set<string>();
  const pushFrom = (msg: ChatContextMessage): void => {
    if (!msg) return;
    pushMsgAttachments(msg, out, seen, srcSet, cap);
  };

  if (quotedMsg?.attachments?.length || quotedMsg?.forwarded?.messages?.some((x) => x.attachments?.length)) {
    pushFrom(quotedMsg);
    if (winMs > 0 && Array.isArray(recentMsgs) && recentMsgs.length && out.length < cap) {
      const qTs = Number(quotedMsg.ts) || 0;
      const qSender = String(quotedMsg.senderId ?? '');
      const burst: ChatContextMessage[] = [];
      let qIdx = recentMsgs.findIndex((m) => m?.id === quotedMsg.id);
      if (qIdx < 0) {
        qIdx = recentMsgs.findIndex((m) => (Number(m?.ts) || 0) >= qTs);
        if (qIdx < 0) qIdx = recentMsgs.length;
      }
      for (let i = qIdx - 1, gap = 0; i >= 0; i -= 1) {
        const m = recentMsgs[i];
        if (!m) continue;
        if (qTs && m.ts && Math.abs(qTs - m.ts) > winMs) break;
        if (m.attachments?.length) {
          if (String(m.senderId ?? '') !== qSender) break;
          burst.unshift(m);
          gap = 0;
        } else {
          gap += 1;
          if (gap > 2) break;
        }
      }
      const startFwd = recentMsgs[qIdx]?.id === quotedMsg.id ? qIdx + 1 : qIdx;
      for (let i = startFwd, gap = 0; i < recentMsgs.length; i += 1) {
        const m = recentMsgs[i];
        if (!m) continue;
        if (qTs && m.ts && Math.abs(m.ts - qTs) > winMs) break;
        if (m.attachments?.length) {
          if (String(m.senderId ?? '') !== qSender) break;
          burst.push(m);
          gap = 0;
        } else {
          gap += 1;
          if (gap > 2) break;
        }
      }
      for (const m of burst) pushFrom(m);
    }
    return { attachments: out, sourceMsgIds: [...srcSet] };
  }

  if (!quotedMsg && !(triggerEvent?.attachments?.length) && Array.isArray(recentMsgs) && recentMsgs.length) {
    for (const m of recentMsgs) {
      if (m && (m.isForwarded || m.forwarded)) pushFrom(m);
    }
  }

  if (
    !quotedMsg
    && !(triggerEvent?.attachments?.length)
    && winMs > 0
    && Array.isArray(recentMsgs)
    && recentMsgs.length
    && ARTIFACT_REF_RE.test(String(triggerEvent?.text ?? ''))
  ) {
    const trigTs = Number(triggerEvent?.ts) || Date.now();
    let anchorIdx = -1;
    for (let i = recentMsgs.length - 1, skipped = 0; i >= 0 && skipped <= 4; i -= 1) {
      const m = recentMsgs[i];
      if (!m) continue;
      if (m.ts && (trigTs - m.ts) > winMs) break;
      if (m.attachments?.length && !m.isBotReply) {
        anchorIdx = i;
        break;
      }
      skipped += 1;
    }
    if (anchorIdx >= 0) {
      const anchor = recentMsgs[anchorIdx];
      const anchorSender = String(anchor.senderId ?? '');
      const anchorTs = Number(anchor.ts) || trigTs;
      const burst: ChatContextMessage[] = [anchor];
      for (let i = anchorIdx - 1, gap = 0; i >= 0; i -= 1) {
        const m = recentMsgs[i];
        if (!m) continue;
        if (m.ts && (anchorTs - m.ts) > winMs) break;
        if (m.attachments?.length && !m.isBotReply) {
          if (String(m.senderId ?? '') !== anchorSender) break;
          burst.unshift(m);
          gap = 0;
        } else {
          gap += 1;
          if (gap > 2) break;
        }
      }
      for (const m of burst) pushFrom(m);
    }
  }
  return { attachments: out, sourceMsgIds: [...srcSet] };
}

export function redactSecrets(text: unknown): string {
  const preMasked = String(text ?? '')
    .replace(/\bomb_sess_[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\bctx_[A-Za-z0-9._-]{12,}/g, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
  return scanAndRedactOutbound(preMasked).text;
}

export function normalizeLinkCard(rawCard: unknown): LinkCard | null {
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

export function formatClock(ts: number | undefined): string {
  const d = new Date(Number(ts) || Date.now());
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function redactAndClip(text: unknown, max: number): string {
  const s = redactSecrets(text).replace(/\r\n/g, '\n').trim();
  if (!s) return '';
  return max > 0 && s.length > max ? `${s.slice(0, max)}…` : s;
}

function normalizeAttList(rawAtts: unknown, fallbackMsgId: string): InboundAttachment[] {
  if (!Array.isArray(rawAtts) || !rawAtts.length) return [];
  const out: InboundAttachment[] = [];
  for (const item of rawAtts) {
    if (!item || typeof item !== 'object') continue;
    const a = item as AnyRecord;
    const id = a.id ?? a.fileId;
    if (id == null) continue;
    out.push({
      id: String(id),
      msgId: String(a.msgId ?? fallbackMsgId),
      name: String(a.name || id),
      ...(Number(a.size) > 0 ? { size: Number(a.size) } : {}),
      ...(a.mime ? { mime: String(a.mime) } : {}),
      ...(a.kind ? { kind: String(a.kind) } : {}),
      ...(Number(a.durationSec) > 0 ? { durationSec: Number(a.durationSec) } : {}),
      ...(a.transcript ? { transcript: String(a.transcript) } : {}),
    });
  }
  return out;
}

/** 将不同 IM 插件上报的合并转发载荷归一化为标准 `ForwardedBundle`。 */
export function normalizeForwarded(
  rawForwarded: unknown,
  parentMsgId: string,
  normalizeLinkCardFn?: (raw: unknown) => LinkCard | null,
): ForwardedBundle | null {
  if (!rawForwarded || typeof rawForwarded !== 'object') return null;
  const rawArr = Array.isArray(rawForwarded)
    ? rawForwarded
    : (() => {
        const rec = rawForwarded as AnyRecord;
        const candidate = rec.messages ?? rec.items ?? rec.records ?? rec.list;
        return Array.isArray(candidate) ? candidate : [];
      })();
  const title = !Array.isArray(rawForwarded) && (rawForwarded as AnyRecord).title
    ? String((rawForwarded as AnyRecord).title).trim()
    : '';

  const messages: ForwardedMessageItem[] = [];
  for (const entry of rawArr.slice(0, MAX_FORWARDED_ITEMS)) {
    if (!entry || typeof entry !== 'object') continue;
    const m = entry as AnyRecord;
    const senderObj = m.sender && typeof m.sender === 'object' ? (m.sender as AnyRecord) : null;
    const itemId = m.id ?? m.msgId;
    const idStr = itemId != null ? String(itemId) : undefined;
    const senderName = m.senderName ?? m.fromName ?? senderObj?.name;
    const senderId = m.senderId ?? m.fromId ?? senderObj?.id;
    const ts = Number(m.ts ?? m.time);
    const text = m.text ?? m.content;
    const linkCard = (normalizeLinkCardFn ?? normalizeLinkCard)(m.linkCard ?? m.card);
    const attachments = normalizeAttList(m.attachments ?? m.files, idStr || parentMsgId);
    if (!text && !linkCard && !attachments.length) continue;
    messages.push({
      ...(idStr ? { id: idStr } : {}),
      ...(senderName ? { senderName: String(senderName) } : {}),
      ...(senderId != null && String(senderId) ? { senderId: String(senderId) } : {}),
      ...(Number.isFinite(ts) && ts > 0 ? { ts } : {}),
      ...(text != null && String(text).trim() ? { text: String(text) } : {}),
      ...(linkCard ? { linkCard } : {}),
      ...(attachments.length ? { attachments } : {}),
    });
  }
  if (!title && !messages.length) return null;
  return {
    ...(title ? { title } : {}),
    messages,
  };
}

/** 将合并转发收敛为单行脱敏摘要（用于 prompt 中快速索引，完整记录由按需拉取接口读取）。 */
export function formatForwardedSummary(
  bundle: ForwardedBundle | null | undefined,
  maxPreviewChars = 160,
): string {
  if (!bundle || (!bundle.title && !bundle.messages?.length)) return '';
  const title = bundle.title ? redactAndClip(bundle.title, 80) : '聊天记录';
  const list = Array.isArray(bundle.messages) ? bundle.messages : [];
  const head = `[合并转发 · ${title}，共 ${list.length} 条]`;
  if (!list.length) return head;
  const snippets: string[] = [];
  let used = 0;
  for (const item of list.slice(0, 3)) {
    const who = redactAndClip(item.senderName || item.senderId || '成员', 24);
    const body = item.text
      ? redactAndClip(item.text, 60)
      : (item.attachments?.length ? `[附件:${item.attachments.map((a) => a.name).join(',')}]` : (item.linkCard?.title ? `[卡片:${item.linkCard.title}]` : ''));
    if (!body) continue;
    const seg = `${who}: ${body}`;
    if (used + seg.length > maxPreviewChars && snippets.length > 0) break;
    snippets.push(seg);
    used += seg.length;
  }
  return snippets.length ? `${head} 预览: ${snippets.join(' | ')}` : head;
}

/** 将单条合并转发展开为完整可读对话记录（强制脱敏，供 `/api/context/history?msgId=` 返回）。 */
export function formatForwardedFull(bundle: ForwardedBundle | null | undefined): string {
  if (!bundle || (!bundle.title && !bundle.messages?.length)) return '';
  const title = bundle.title ? redactAndClip(bundle.title, 120) : '聊天记录';
  const list = Array.isArray(bundle.messages) ? bundle.messages : [];
  const lines = [`[合并转发记录 · ${title}（共 ${list.length} 条）]`];
  for (let i = 0; i < list.length; i += 1) {
    const m = list[i];
    const who = redactAndClip(m.senderName || m.senderId || '成员', 40);
    const clock = m.ts ? `[${formatClock(m.ts)}] ` : '';
    const idTag = m.id ? ` (id:${m.id})` : '';
    const parts: string[] = [];
    if (m.text) parts.push(redactSecrets(m.text).replace(/\r\n/g, '\n').trim());
    if (m.linkCard) {
      const cTitle = redactAndClip(m.linkCard.title || m.linkCard.description || '卡片', 160);
      const cUrl = m.linkCard.url ? ` (${redactAndClip(m.linkCard.url, 200)})` : '';
      parts.push(`[卡片: ${cTitle}${cUrl}]`);
    }
    if (m.attachments?.length) {
      parts.push(`[附件: ${m.attachments.map((a) => a.transcript ? `语音:${redactAndClip(a.transcript, 200)}` : a.name).join(', ')}]`);
    }
    lines.push(`${i + 1}. ${clock}${who}${idTag}: ${parts.join(' ') || '[空消息]'}`);
  }
  return lines.join('\n');
}

/** 校验远程连接地址是否为本机回环地址，防止配置非 127.0.0.1 时上下文拉取接口暴露到局域网。 */
export function isLoopbackRemoteAddress(addr: string | undefined): boolean {
  const s = String(addr ?? '').trim().toLowerCase();
  return s === '127.0.0.1' || s === '::1' || s === '::ffff:127.0.0.1';
}

function makeHttpError(message: string, status: number): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

export interface ContextPullManagerOptions {
  resolveMessage: (chatId: string, msgId: string) => Promise<ChatContextMessage | null>;
  getHistory: (chatId: string, opts: { limit: number; before?: string | null }) => Promise<ChatContextMessage[]>;
  downloadAttachment?: (chatId: string, msg: ChatContextMessage, att: InboundAttachment) => Promise<{
    localPath: string;
    size?: number;
    mime?: string;
  }>;
  isSelfMessageReadable?: (chatId: string, msg: ChatContextMessage) => boolean;
  isRecalled?: (chatId: string, msgId: string) => boolean;
  searchCached?: (chatId: string, query: string, limit: number) => ChatContextMessage[];
  getChatType?: (chatId: string) => string;
  onTelemetry?: (data: Record<string, unknown>) => void;
  now?: () => number;
  maxPerMinute?: number;
}

/** 本地只读上下文按需探索管理器：为单会话颁发隔离句柄 `grant` 并服务全文、向前翻页与搜索。 */
export class ContextPullManager {
  #opts: Required<Pick<ContextPullManagerOptions, 'resolveMessage' | 'getHistory' | 'now' | 'maxPerMinute'>> & ContextPullManagerOptions;
  #grantsByChat = new Map<string, string>();
  #grantMeta = new Map<string, { chatId: string; hits: number[] }>();

  constructor(opts: ContextPullManagerOptions) {
    this.#opts = {
      ...opts,
      now: opts.now ?? (() => Date.now()),
      maxPerMinute: Math.max(1, Number(opts.maxPerMinute) || 15),
    };
  }

  /** 为指定会话返回进程期可复用的短句柄（避免触发 `token=` 脱敏规则与重复审批）。 */
  getGrant(chatId: string): string {
    const cid = String(chatId || '').trim();
    if (!cid) throw new Error('chatId 不能为空');
    const existing = this.#grantsByChat.get(cid);
    if (existing) return existing;
    while (this.#grantsByChat.size >= 200) {
      const oldestChat = this.#grantsByChat.keys().next().value;
      if (oldestChat === undefined) break;
      const oldGrant = this.#grantsByChat.get(oldestChat);
      this.#grantsByChat.delete(oldestChat);
      if (oldGrant) this.#grantMeta.delete(oldGrant);
    }
    const grant = `g_${crypto.randomBytes(5).toString('hex')}`;
    this.#grantsByChat.set(cid, grant);
    this.#grantMeta.set(grant, { chatId: cid, hits: [] });
    return grant;
  }

  #canRead(chatId: string, msg: ChatContextMessage): boolean {
    if (!msg) return false;
    if (this.#opts.isRecalled?.(chatId, msg.id)) return false;
    if (this.#opts.getChatType?.(chatId) === 'self') {
      return this.#opts.isSelfMessageReadable ? this.#opts.isSelfMessageReadable(chatId, msg) : false;
    }
    return true;
  }

  #composeFullText(msg: ChatContextMessage): string {
    const chunks: string[] = [];
    if (msg.text) chunks.push(redactSecrets(msg.text).replace(/\r\n/g, '\n').trim());
    if (msg.forwarded) chunks.push(formatForwardedFull(msg.forwarded));
    if (msg.linkCard) {
      const cardParts = [msg.linkCard.title, msg.linkCard.description, msg.linkCard.url]
        .filter(Boolean)
        .map((x) => redactSecrets(x).trim());
      if (cardParts.length) chunks.push(`[卡片]\n${cardParts.join('\n')}`);
    }
    if (msg.attachments?.length) {
      chunks.push(`[附件: ${msg.attachments.map((a) => (a.transcript ? `${a.name} (语音转写: ${redactAndClip(a.transcript, 500)})` : a.name)).join(', ')}]`);
    }
    return chunks.filter(Boolean).join('\n\n') || '[空消息]';
  }

  #formatAttachmentsMeta(msg: ChatContextMessage): Array<{ id: string; name: string; size?: number; mime?: string }> {
    return collectAllMsgAttachments(msg).map((a) => ({
      id: a.id,
      name: a.name,
      ...(a.size ? { size: a.size } : {}),
      ...(a.mime ? { mime: a.mime } : {}),
    }));
  }

  #authenticate(url: URL, remoteAddress: string | undefined): string {
    if (!isLoopbackRemoteAddress(remoteAddress)) {
      throw makeHttpError('仅允许本机回环访问上下文探索接口', 403);
    }
    const grant = String(url.searchParams.get('grant') || '').trim();
    if (!grant) {
      throw makeHttpError('缺少 grant 参数', 401);
    }
    const meta = this.#grantMeta.get(grant);
    if (!meta) {
      throw makeHttpError('无效或已过期的 grant 句柄', 403);
    }
    const nowTs = this.#opts.now();
    meta.hits = meta.hits.filter((t) => (nowTs - t) < 60_000);
    if (meta.hits.length >= this.#opts.maxPerMinute) {
      throw makeHttpError('上下文拉取过于频繁，请稍后重试', 429);
    }
    meta.hits.push(nowTs);
    return meta.chatId;
  }

  #summarize(msg: ChatContextMessage, previewMax = 240): Record<string, unknown> {
    const full = this.#composeFullText(msg);
    const preview = full.length > previewMax ? `${full.slice(0, previewMax)}…` : full;
    const attachments = this.#formatAttachmentsMeta(msg);
    return {
      id: msg.id,
      ts: msg.ts,
      time: formatClock(msg.ts),
      sender: redactAndClip(msg.senderName || msg.senderId || (msg.isSelf ? 'me' : 'member'), 40),
      ...(msg.isBotReply ? { isBotReply: true } : {}),
      ...(msg.isForwarded ? { isForwarded: true } : {}),
      ...(msg.forwarded ? { forwardedCount: msg.forwarded.messages.length } : {}),
      preview,
      totalChars: full.length,
      truncated: full.length > previewMax,
      ...(attachments.length ? { attachments } : {}),
    };
  }

  /** 生成注入 prompt 的单行按需拉取入口指针；非本机可达、协作者只读或无扩展历史时返回空字符串。 */
  formatPullHint(
    chatId: string,
    {
      baseUrl,
      oldestMsgId,
      hasTruncated = false,
      hasOlder = false,
      channelHasHistory = false,
      availableCount = 0,
      availableFiles = 0,
      pullOnly = false,
      readonly = false,
    }: {
      baseUrl?: string | null;
      oldestMsgId?: string | null;
      hasTruncated?: boolean;
      hasOlder?: boolean;
      channelHasHistory?: boolean;
      availableCount?: number;
      availableFiles?: number;
      pullOnly?: boolean;
      readonly?: boolean;
    },
  ): string {
    if (!baseUrl || readonly) return '';
    const hasPullable = pullOnly
      ? (availableCount > 0 || hasTruncated || hasOlder || channelHasHistory)
      : (hasTruncated || hasOlder || channelHasHistory);
    if (!hasPullable) return '';
    const grant = this.getGrant(chatId);
    const endpoint = `${baseUrl.replace(/\/+$/, '')}/api/context/history?grant=${grant}`;
    const meta: string[] = [];
    if (availableCount > 0) meta.push(`available=${availableCount}`);
    if (availableFiles > 0) meta.push(`files=${availableFiles}`);
    if (hasTruncated) meta.push('truncated');
    if (!pullOnly && hasOlder && oldestMsgId) meta.push(`before=${oldestMsgId}`);
    if (availableCount === 0 && !hasOlder && channelHasHistory) meta.push('remote_history');
    return meta.length ? `context_pull: ${endpoint} (${meta.join(', ')})` : `context_pull: ${endpoint}`;
  }

  /** 处理 `GET /api/context/history` 请求，返回脱敏后的详情或分页摘要。 */
  async handleRequest(url: URL, remoteAddress: string | undefined): Promise<Record<string, unknown>> {
    const chatId = this.#authenticate(url, remoteAddress);
    const msgId = String(url.searchParams.get('msgId') || '').trim();
    if (msgId) {
      const msg = await this.#opts.resolveMessage(chatId, msgId);
      if (!msg || !this.#canRead(chatId, msg)) {
        throw makeHttpError(`未找到消息「${msgId}」或无权限读取`, 404);
      }
      const full = this.#composeFullText(msg);
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const rawLim = Number(url.searchParams.get('limit')) || 4000;
      const limit = Math.max(200, Math.min(12_000, rawLim));
      const chunk = full.slice(offset, offset + limit);
      const nextOffset = (offset + chunk.length) < full.length ? (offset + chunk.length) : null;
      const attachments = this.#formatAttachmentsMeta(msg);
      this.#opts.onTelemetry?.({ chatId, summary: `mode=detail msgId=${msgId} chars=${chunk.length}` });
      return {
        ok: true,
        mode: 'detail',
        msgId: msg.id,
        ts: msg.ts,
        sender: redactAndClip(msg.senderName || msg.senderId || (msg.isSelf ? 'me' : 'member'), 40),
        text: chunk,
        totalChars: full.length,
        offset,
        hasMore: nextOffset !== null,
        nextOffset,
        ...(attachments.length ? { attachments } : {}),
      };
    }

    const query = String(url.searchParams.get('q') || '').trim();
    const limit = Math.max(1, Math.min(20, Number(url.searchParams.get('limit')) || 20));
    if (query) {
      const rawMatches = this.#opts.searchCached ? this.#opts.searchCached(chatId, query, Math.max(limit * 4, 80)) : [];
      const readable = rawMatches.filter((m) => this.#canRead(chatId, m)).slice(-limit);
      this.#opts.onTelemetry?.({ chatId, summary: `mode=search hits=${readable.length}` });
      return {
        ok: true,
        mode: 'search',
        query,
        messages: readable.map((m) => this.#summarize(m)),
      };
    }

    const before = String(url.searchParams.get('before') || '').trim() || null;
    const rawHist = await this.#opts.getHistory(chatId, { limit: limit + 1, before });
    const readable = rawHist.filter((m) => this.#canRead(chatId, m));
    const hasMore = readable.length > limit;
    const page = hasMore ? readable.slice(-limit) : readable;
    const nextBefore = hasMore && page.length ? page[0].id : null;
    this.#opts.onTelemetry?.({ chatId, summary: `mode=history count=${page.length} hasMore=${hasMore}` });
    return {
      ok: true,
      mode: 'history',
      messages: page.map((m) => this.#summarize(m)),
      hasMore,
      nextBefore,
    };
  }

  /** 处理 `GET /api/context/attachment` 请求，按需下载并缓存消息/合并转发内附件，返回本地路径与文本预览。 */
  async handleAttachmentRequest(
    url: URL,
    remoteAddress: string | undefined,
    res?: http.ServerResponse,
  ): Promise<Record<string, unknown> | undefined> {
    const chatId = this.#authenticate(url, remoteAddress);
    const msgId = String(url.searchParams.get('msgId') || '').trim();
    if (!msgId) throw makeHttpError('缺少 msgId 参数', 400);

    const msg = await this.#opts.resolveMessage(chatId, msgId);
    if (!msg || !this.#canRead(chatId, msg)) {
      throw makeHttpError(`未找到消息「${msgId}」或无权限读取`, 404);
    }
    const allAtts = collectAllMsgAttachments(msg);
    if (!allAtts.length) {
      throw makeHttpError(`消息「${msgId}」不包含附件`, 404);
    }

    const attId = String(url.searchParams.get('attId') || '').trim();
    let att: InboundAttachment | undefined;
    if (attId) {
      att = allAtts.find((a) => a.id === attId || a.name === attId);
      if (!att) throw makeHttpError(`未找到附件「${attId}」`, 404);
    } else if (allAtts.length === 1) {
      att = allAtts[0];
    } else {
      throw makeHttpError('该消息包含多个附件，请指定 attId 参数', 400);
    }

    if (!this.#opts.downloadAttachment) {
      throw makeHttpError('当前通道不支持按需下载附件', 501);
    }
    const dl = await this.#opts.downloadAttachment(chatId, msg, att);
    const size = dl.size ?? fs.statSync(dl.localPath).size;
    const mime = dl.mime || att.mime || guessMimeFromName(att.name);
    this.#opts.onTelemetry?.({ chatId, summary: `mode=attachment msgId=${msg.id} attId=${att.id} name=${att.name}` });

    const rawParam = url.searchParams.get('raw');
    if ((rawParam === '1' || rawParam === 'true') && res) {
      if (size > 50 * 1024 * 1024) {
        throw makeHttpError('附件超过 50MB 限制', 413);
      }
      const buf = fs.readFileSync(dl.localPath);
      const asciiName = att.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      res.writeHead(200, {
        'content-type': mime,
        'content-length': buf.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-disposition': `attachment; filename="${asciiName}"`,
      });
      res.end(buf);
      return undefined;
    }

    const result: Record<string, unknown> = {
      ok: true,
      mode: 'attachment',
      msgId: msg.id,
      attId: att.id,
      name: att.name,
      size,
      mime,
      localPath: dl.localPath,
      ...(att.transcript ? { transcript: redactSecrets(att.transcript) } : {}),
    };

    if (isTextLikeAttachment(att.name, mime) && size <= 512 * 1024) {
      const buf = fs.readFileSync(dl.localPath);
      const sample = buf.subarray(0, Math.min(buf.length, 4096));
      if (!sample.includes(0)) {
        const full = redactSecrets(buf.toString('utf8'));
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        const rawLim = Number(url.searchParams.get('limit')) || 4000;
        const limit = Math.max(200, Math.min(12_000, rawLim));
        const chunk = full.slice(offset, offset + limit);
        const nextOffset = (offset + chunk.length) < full.length ? (offset + chunk.length) : null;
        result.text = chunk;
        result.totalChars = full.length;
        result.offset = offset;
        result.hasMore = nextOffset !== null;
        result.nextOffset = nextOffset;
      }
    }
    return result;
  }
}
