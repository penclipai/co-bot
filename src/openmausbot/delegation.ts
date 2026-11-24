/**
 * 极简 2 态 C2C 委托协议：仅 `[cobot:req ...]` 与 `[cobot:res ...]`（无中间态噪声），带防回环幂等追踪。
 */
import crypto from 'node:crypto';
import type { ParsedDelegationTag, PendingOutboundDelegation } from './types.ts';
import { trimMapCap } from './mentions.ts';

const TAG_LINE_RE = /^\[cobot:(req|res)\s+([^\]]+)\]$/i;
const INLINE_START_TAG_RE = /^\[cobot:(req|res)\s+([^\]]+)\](?:\s+([\s\S]*)|\s*)$/i;
const VALID_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_VAL_RE = /[\s\]]+/g;

export interface DelegationSnapshot {
  processedReqIds: string[];
  pendingOutbound: PendingOutboundDelegation[];
}

export interface DelegationStats {
  pendingOutbound: number;
  processedInbound: number;
  sentCount: number;
  receivedCount: number;
  completedCount: number;
}

export function generateDelegationId(now = Date.now()): string {
  const rand = crypto.randomBytes(3).toString('hex');
  return `d_${Number(now || Date.now()).toString(36)}_${rand}`;
}

export function formatDelegationRequest({ id, project = '', text = '' }: { id?: string; project?: string; text?: string }): string {
  const safeId = String(id || generateDelegationId()).replace(SAFE_VAL_RE, '_');
  const safeProj = String(project || '').trim().replace(SAFE_VAL_RE, '_');
  const rawBody = String(text ?? '').trim();
  const headerBody = rawBody.startsWith('🤖') ? rawBody : `🤖 协作请求：${rawBody}`;
  const tag = `[cobot:req id=${safeId}${safeProj ? ` proj=${safeProj}` : ''}]`;
  return `${headerBody}\n${tag}`;
}

export function formatDelegationResponse({ re, text = '' }: { re?: string; text?: string }): string {
  const safeRe = String(re || '').replace(SAFE_VAL_RE, '_');
  const rawBody = String(text ?? '').trim();
  const headerBody = rawBody.startsWith('🤖') ? rawBody : `🤖 协作答复：${rawBody}`;
  const tag = `[cobot:res re=${safeRe}]`;
  return `${headerBody}\n${tag}`;
}

/** 解析句末独立行或句首的 `[cobot:req ...]` / `[cobot:res ...]` 元数据标签（忽略正文内引用的反引号提及）。 */
export function parseDelegationTag(text: unknown): ParsedDelegationTag | null {
  const s = String(text ?? '').trim();
  if (!s) return null;

  const lines = s.split(/\r?\n/);
  let lastIdx = lines.length - 1;
  while (lastIdx >= 0 && !lines[lastIdx].trim()) lastIdx -= 1;
  const tailMatch = lastIdx >= 0 ? lines[lastIdx].trim().match(TAG_LINE_RE) : null;
  const startMatch = tailMatch ? null : s.match(INLINE_START_TAG_RE);
  const tagMatch = tailMatch || startMatch;
  if (!tagMatch) return null;

  const kind = tagMatch[1].toLowerCase();
  const attrStr = tagMatch[2];
  const rawBody = tailMatch
    ? lines.slice(0, lastIdx).join('\n').trim()
    : String(tagMatch[3] ?? '').trim();

  const attrs: Record<string, string> = {};
  for (const tok of attrStr.trim().split(/\s+/)) {
    const eq = tok.indexOf('=');
    if (eq <= 0) continue;
    const k = tok.slice(0, eq).toLowerCase();
    const v = tok.slice(eq + 1).trim();
    if (k && v) attrs[k] = v;
  }

  const body = rawBody
    .replace(/^🤖\s*(?:协作请求|协作答复)[:：\s]*/u, '')
    .trim();

  if (kind === 'req') {
    if (!attrs.id || !VALID_ID_RE.test(attrs.id)) return null;
    return {
      kind: 'req',
      id: attrs.id,
      project: attrs.proj || '',
      body,
      rawBody,
    };
  }
  if (kind === 'res') {
    if (!attrs.re || !VALID_ID_RE.test(attrs.re)) return null;
    return {
      kind: 'res',
      re: attrs.re,
      body,
      rawBody,
    };
  }
  return null;
}

/** C2C 委托状态与防回环幂等去重追踪器。 */
export class DelegationTracker {
  now: () => number;
  maxProcessed: number;
  maxPending: number;
  processedReqIds: Set<string>;
  pendingOutbound: Map<string, PendingOutboundDelegation>;
  receivedCount: number;
  sentCount: number;
  completedCount: number;

  constructor({
    now = () => Date.now(),
    maxProcessed = 500,
    maxPending = 100,
  }: { now?: () => number; maxProcessed?: number; maxPending?: number } = {}) {
    this.now = now;
    this.maxProcessed = Math.max(20, Number(maxProcessed) || 500);
    this.maxPending = Math.max(10, Number(maxPending) || 100);
    this.processedReqIds = new Set();
    this.pendingOutbound = new Map();
    this.receivedCount = 0;
    this.sentCount = 0;
    this.completedCount = 0;
  }

  hasProcessed(id: unknown): boolean {
    return Boolean(id && this.processedReqIds.has(String(id)));
  }

  markProcessed(id: unknown): void {
    if (!id) return;
    const key = String(id);
    if (!this.processedReqIds.has(key)) {
      this.receivedCount += 1;
      this.processedReqIds.add(key);
      while (this.processedReqIds.size > this.maxProcessed) {
        const first = this.processedReqIds.values().next().value;
        if (first === undefined) break;
        this.processedReqIds.delete(first);
      }
    }
  }

  trackOutbound(entry: PendingOutboundDelegation): void {
    if (!entry?.id) return;
    const key = String(entry.id);
    this.pendingOutbound.set(key, {
      ...entry,
      id: key,
      createdAt: entry.createdAt ?? this.now(),
    });
    this.sentCount += 1;
    trimMapCap(this.pendingOutbound, this.maxPending);
  }

  completeOutbound(re: unknown): PendingOutboundDelegation | null {
    if (!re) return null;
    const key = String(re);
    const hit = this.pendingOutbound.get(key) ?? null;
    if (hit) {
      this.pendingOutbound.delete(key);
      this.completedCount += 1;
    }
    return hit;
  }

  hydrate(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const r = raw as Partial<DelegationSnapshot>;
    if (Array.isArray(r.processedReqIds)) {
      for (const id of r.processedReqIds.slice(-this.maxProcessed)) {
        if (id) this.processedReqIds.add(String(id));
      }
    }
    const cutoff = this.now() - 24 * 60 * 60_000;
    if (Array.isArray(r.pendingOutbound)) {
      for (const item of r.pendingOutbound.slice(-this.maxPending)) {
        if (item?.id && (!item.createdAt || item.createdAt >= cutoff)) {
          this.pendingOutbound.set(String(item.id), item);
        }
      }
    }
  }

  snapshot(): DelegationSnapshot {
    return {
      processedReqIds: [...this.processedReqIds].slice(-this.maxProcessed),
      pendingOutbound: [...this.pendingOutbound.values()].slice(-this.maxPending),
    };
  }

  stats(): DelegationStats {
    return {
      pendingOutbound: this.pendingOutbound.size,
      processedInbound: this.processedReqIds.size,
      sentCount: this.sentCount,
      receivedCount: this.receivedCount,
      completedCount: this.completedCount,
    };
  }
}
