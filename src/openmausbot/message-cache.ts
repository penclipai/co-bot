import { hasBotBadgePrefix } from '../core/security.ts';
import { safeAttachmentName } from '../format.ts';
import type { InboundAttachment } from '../types.ts';
import { rememberBounded, scopedMsgKey, trimMapCap } from './mentions.ts';
import type { FileMsgEntry, MsgRoute } from './types.ts';

const ECHO_TTL_MS = 3 * 60 * 1000;
const normText = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * 桥接器消息去重、回声防环、路由映射与文件消息短期缓存（从 `bridge.ts` 拆分）。
 */
export class BridgeMessageCache {
  ownIds = new Set<string>();
  ownReqIds = new Set<string>();
  deliveredOmbIds = new Set<string>();
  deliveredCards = new Set<string>();
  deliveredMedia = new Set<string>();
  pendingOutFiles = new Map<string, number>();
  recent = new Map<string, number>();
  seen = new Set<string>();
  fileMsgs = new Map<string, FileMsgEntry>();
  msgRoute = new Map<string, MsgRoute>();
  #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  rememberOwnId(id: unknown, chatId?: string | null): void {
    if (id == null) return;
    const mid = String(id).trim();
    if (!mid) return;
    const key = scopedMsgKey(chatId, mid);
    rememberBounded(this.ownIds, key, 2000);
  }

  isOwnId(chatId: string | null | undefined, msgId: string | null | undefined): boolean {
    const mid = String(msgId ?? '').trim();
    if (!mid) return false;
    const scoped = scopedMsgKey(chatId, mid);
    return Boolean((scoped && this.ownIds.has(scoped)) || this.ownIds.has(mid));
  }

  hasSeenMsg(chatId: string | null | undefined, msgId: string | null | undefined): boolean {
    const mid = String(msgId ?? '').trim();
    if (!mid) return false;
    const scoped = scopedMsgKey(chatId, mid);
    return Boolean((scoped && this.seen.has(scoped)) || this.seen.has(mid));
  }

  markSeenMsg(chatId: string | null | undefined, msgId: string | null | undefined): void {
    const mid = String(msgId ?? '').trim();
    if (!mid) return;
    const scoped = scopedMsgKey(chatId, mid);
    rememberBounded(this.seen, scoped || mid, 5000);
  }

  setMsgRoute(chatId: string | null | undefined, msgId: string | null | undefined, route: MsgRoute): void {
    const mid = String(msgId ?? '').trim();
    if (!mid || !route?.botId) return;
    const cid = String(chatId || route.targetChatId || '').trim();
    const key = scopedMsgKey(cid, mid);
    this.msgRoute.set(key, route);
    trimMapCap(this.msgRoute, 500);
  }

  getMsgRoute(chatId: string | null | undefined, msgId: string | null | undefined): MsgRoute | null {
    const mid = String(msgId ?? '').trim();
    if (!mid) return null;
    const cid = String(chatId ?? '').trim();
    if (cid) {
      const hit = this.msgRoute.get(scopedMsgKey(cid, mid));
      if (hit) return hit;
    }
    const legacy = this.msgRoute.get(mid) ?? null;
    if (!legacy) return null;
    const routeChat = legacy.targetChatId || legacy.originChatId || '';
    if (cid && routeChat && routeChat !== cid) return null;
    return legacy;
  }

  deleteMsgRoute(chatId: string | null | undefined, msgId: string | null | undefined): void {
    const mid = String(msgId ?? '').trim();
    if (!mid) return;
    const cid = String(chatId ?? '').trim();
    if (cid) this.msgRoute.delete(scopedMsgKey(cid, mid));
    const legacy = this.msgRoute.get(mid);
    if (legacy) {
      const routeChat = legacy.targetChatId || legacy.originChatId || '';
      if (!cid || !routeChat || routeChat === cid) this.msgRoute.delete(mid);
    }
  }

  setFileMsg(chatId: string, msgId: string, atts: InboundAttachment[]): void {
    const mid = String(msgId ?? '').trim();
    const cid = String(chatId ?? '').trim();
    if (!mid) return;
    const key = scopedMsgKey(cid, mid);
    this.fileMsgs.set(key, { chatId: cid, atts, at: this.#now(), used: false });
    trimMapCap(this.fileMsgs, 50);
  }

  getFileMsg(chatId: string | null | undefined, msgId: string | null | undefined): { key: string; entry: FileMsgEntry } | null {
    const mid = String(msgId ?? '').trim();
    if (!mid) return null;
    const cid = String(chatId ?? '').trim();
    if (cid) {
      const sk = scopedMsgKey(cid, mid);
      const hit = this.fileMsgs.get(sk);
      if (hit) return { key: sk, entry: hit };
    }
    const legacy = this.fileMsgs.get(mid);
    if (!legacy) return null;
    if (cid && legacy.chatId && legacy.chatId !== cid) return null;
    return { key: mid, entry: legacy };
  }

  deleteFileMsg(chatId: string | null | undefined, msgId: string | null | undefined): void {
    const mid = String(msgId ?? '').trim();
    if (!mid) return;
    const cid = String(chatId ?? '').trim();
    if (cid) this.fileMsgs.delete(scopedMsgKey(cid, mid));
    const legacy = this.fileMsgs.get(mid);
    if (legacy && (!cid || !legacy.chatId || legacy.chatId === cid)) {
      this.fileMsgs.delete(mid);
    }
  }

  rememberEcho(text: string): void {
    const key = normText(text);
    if (!key) return;
    const now = this.#now();
    this.recent.set(key, now);
    for (const [k, at] of this.recent) if (now - at > ECHO_TTL_MS) this.recent.delete(k);
  }

  isEcho(text: string, outPrefix = ''): boolean {
    if (outPrefix && text.startsWith(outPrefix.trim())) return true;
    if (hasBotBadgePrefix(text)) return true;
    const now = this.#now();
    for (const [k, at] of this.recent) if (now - at > ECHO_TTL_MS) this.recent.delete(k);
    return this.recent.has(normText(text));
  }

  isPendingOutFile(att: Partial<InboundAttachment> | null | undefined): boolean {
    if (!this.pendingOutFiles.size) return false;
    const now = this.#now();
    for (const [k, exp] of this.pendingOutFiles) {
      if (exp <= now) this.pendingOutFiles.delete(k);
    }
    const safe = safeAttachmentName(att?.name, '');
    if (!safe) return false;
    const keys = att?.size ? [`${safe}:${att.size}`, safe] : [safe];
    const hit = keys.find((k) => this.pendingOutFiles.has(k));
    if (!hit) return false;
    for (const k of keys) this.pendingOutFiles.delete(k);
    return true;
  }
}
