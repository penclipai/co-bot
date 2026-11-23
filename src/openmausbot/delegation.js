/**
 * 极简 2 态 C2C 委托协议：仅 `[cobot:req ...]` 与 `[cobot:res ...]`（无中间态噪声），带防回环幂等追踪。
 */
import crypto from 'node:crypto';

const TAG_LINE_RE = /^\[cobot:(req|res)\s+([^\]]+)\]$/i;
const VALID_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_VAL_RE = /[\s\]]+/g;

export function generateDelegationId(now = Date.now()) {
  const rand = crypto.randomBytes(3).toString('hex');
  return `d_${Number(now || Date.now()).toString(36)}_${rand}`;
}

export function formatDelegationRequest({ id, project = '', text = '' }) {
  const safeId = String(id || generateDelegationId()).replace(SAFE_VAL_RE, '_');
  const safeProj = String(project || '').trim().replace(SAFE_VAL_RE, '_');
  const rawBody = String(text ?? '').trim();
  const headerBody = rawBody.startsWith('🤖') ? rawBody : `🤖 协作请求：${rawBody}`;
  const tag = `[cobot:req id=${safeId}${safeProj ? ` proj=${safeProj}` : ''}]`;
  return `${headerBody}\n${tag}`;
}

export function formatDelegationResponse({ re, text = '' }) {
  const safeRe = String(re || '').replace(SAFE_VAL_RE, '_');
  const rawBody = String(text ?? '').trim();
  const headerBody = rawBody.startsWith('🤖') ? rawBody : `🤖 协作答复：${rawBody}`;
  const tag = `[cobot:res re=${safeRe}]`;
  return `${headerBody}\n${tag}`;
}

/** 仅解析消息末尾独立一行的 `[cobot:req ...]` / `[cobot:res ...]` 元数据标签。 */
export function parseDelegationTag(text) {
  const s = String(text ?? '');
  if (!s.trim()) return null;
  const lines = s.split(/\r?\n/);
  let lastIdx = lines.length - 1;
  while (lastIdx >= 0 && !lines[lastIdx].trim()) lastIdx -= 1;
  if (lastIdx < 0) return null;

  const m = lines[lastIdx].trim().match(TAG_LINE_RE);
  if (!m) return null;

  const kind = m[1].toLowerCase();
  const attrs = {};
  for (const tok of m[2].trim().split(/\s+/)) {
    const eq = tok.indexOf('=');
    if (eq <= 0) continue;
    const k = tok.slice(0, eq).toLowerCase();
    const v = tok.slice(eq + 1).trim();
    if (k && v) attrs[k] = v;
  }

  const rawBody = lines.slice(0, lastIdx).join('\n').trim();
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
  constructor({ now = () => Date.now(), maxProcessed = 500, maxPending = 100 } = {}) {
    this.now = now;
    this.maxProcessed = Math.max(20, Number(maxProcessed) || 500);
    this.maxPending = Math.max(10, Number(maxPending) || 100);
    this.processedReqIds = new Set();
    this.pendingOutbound = new Map();
    this.receivedCount = 0;
    this.sentCount = 0;
    this.completedCount = 0;
  }

  hasProcessed(id) {
    return Boolean(id && this.processedReqIds.has(String(id)));
  }

  markProcessed(id) {
    if (!id) return;
    const key = String(id);
    if (!this.processedReqIds.has(key)) {
      this.receivedCount += 1;
      this.processedReqIds.add(key);
      while (this.processedReqIds.size > this.maxProcessed) {
        this.processedReqIds.delete(this.processedReqIds.values().next().value);
      }
    }
  }

  trackOutbound(entry) {
    if (!entry?.id) return;
    const key = String(entry.id);
    this.pendingOutbound.set(key, {
      ...entry,
      id: key,
      createdAt: entry.createdAt ?? this.now(),
    });
    this.sentCount += 1;
    while (this.pendingOutbound.size > this.maxPending) {
      this.pendingOutbound.delete(this.pendingOutbound.keys().next().value);
    }
  }

  completeOutbound(re) {
    if (!re) return null;
    const key = String(re);
    const hit = this.pendingOutbound.get(key) ?? null;
    if (hit) {
      this.pendingOutbound.delete(key);
      this.completedCount += 1;
    }
    return hit;
  }

  hydrate(raw) {
    if (!raw || typeof raw !== 'object') return;
    if (Array.isArray(raw.processedReqIds)) {
      for (const id of raw.processedReqIds.slice(-this.maxProcessed)) {
        if (id) this.processedReqIds.add(String(id));
      }
    }
    const cutoff = this.now() - 24 * 60 * 60_000;
    if (Array.isArray(raw.pendingOutbound)) {
      for (const item of raw.pendingOutbound.slice(-this.maxPending)) {
        if (item?.id && (!item.createdAt || item.createdAt >= cutoff)) {
          this.pendingOutbound.set(String(item.id), item);
        }
      }
    }
  }

  snapshot() {
    return {
      processedReqIds: [...this.processedReqIds].slice(-this.maxProcessed),
      pendingOutbound: [...this.pendingOutbound.values()].slice(-this.maxPending),
    };
  }

  stats() {
    return {
      pendingOutbound: this.pendingOutbound.size,
      processedInbound: this.processedReqIds.size,
      sentCount: this.sentCount,
      receivedCount: this.receivedCount,
      completedCount: this.completedCount,
    };
  }
}
