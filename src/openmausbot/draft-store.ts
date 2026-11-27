/**
 * 统一私密草稿与确认发回状态存储（DraftStore）：
 * 以单一规范 Map 维护 `PrivateDraft`（及其可选的 `confirming` 待发回态）并索引多段气泡 ID，
 * 同时向外部提供零同步开销的 `privateDrafts` / `pendingSendBacks` 兼容视图。
 */
import type { DraftConfirmingState, PendingSendBack, PrivateDraft } from './types.ts';

function projectSendBack(draft: PrivateDraft): PendingSendBack | null {
  const c = draft.confirming;
  if (!c) return null;
  const key = c.id || draft.id;
  return {
    id: key,
    inboxRef: c.inboxRef ?? draft.inboxRef,
    imMsgId: c.imMsgId ?? null,
    draft,
    text: c.text,
    useBotPrefix: c.useBotPrefix,
    expiresAt: c.expiresAt,
  };
}

function makeDraftMapView(store: DraftStore): Map<string, PrivateDraft> {
  const snap = (): Map<string, PrivateDraft> => new Map(store.listUnique().map((d) => [d.id, d]));
  const view: Map<string, PrivateDraft> = {
    get size() { return store.uniqueSize(); },
    has(k: string) { return store.hasDraftKey(k); },
    get(k: string) { return store.getDraft(k); },
    set(k: string, d: PrivateDraft) { store.putDraft(d, k); return view; },
    delete(k: string) { return store.deleteDraftByKey(k); },
    clear() { store.clearAll(); },
    keys() { return snap().keys(); },
    values() { return snap().values(); },
    entries() { return snap().entries(); },
    forEach(fn, thisArg) {
      for (const [k, v] of snap().entries()) fn.call(thisArg, v, k, view);
    },
    [Symbol.iterator]() { return snap().entries(); },
    get [Symbol.toStringTag]() { return 'Map'; },
  };
  return view;
}

function makeSendBackMapView(store: DraftStore): Map<string, PendingSendBack> {
  const snap = (): Map<string, PendingSendBack> => new Map([...store.iterConfirmingEntries()]);
  const view: Map<string, PendingSendBack> = {
    get size() { return store.confirmingCount(); },
    has(k: string) { return Boolean(store.getConfirming(k)); },
    get(k: string) { return store.getConfirming(k) ?? undefined; },
    set(k: string, sb: PendingSendBack) { store.setConfirmingFromEntry(k, sb); return view; },
    delete(k: string) { return store.clearConfirmingByKey(k); },
    clear() { store.clearAllConfirming(); },
    keys() { return snap().keys(); },
    values() { return snap().values(); },
    entries() { return snap().entries(); },
    forEach(fn, thisArg) {
      for (const [k, v] of snap().entries()) fn.call(thisArg, v, k, view);
    },
    [Symbol.iterator]() { return snap().entries(); },
    get [Symbol.toStringTag]() { return 'Map'; },
  };
  return view;
}

export class DraftStore {
  #byId = new Map<string, PrivateDraft>();
  #aliases = new Map<string, string>();
  #confirmOnly = new WeakSet<PrivateDraft>();
  #now: () => number;
  readonly draftsView: Map<string, PrivateDraft>;
  readonly sendBacksView: Map<string, PendingSendBack>;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
    this.draftsView = makeDraftMapView(this);
    this.sendBacksView = makeSendBackMapView(this);
  }

  #indexDraft(d: PrivateDraft, extraKey?: string): void {
    const id = d.id;
    this.#aliases.set(id, id);
    if (extraKey) this.#aliases.set(extraKey, id);
    if (d.imMsgId) this.#aliases.set(d.imMsgId, id);
    if (Array.isArray(d.imMsgIds)) {
      for (const sid of d.imMsgIds) if (sid) this.#aliases.set(String(sid), id);
    }
    if (d.confirming?.id) this.#aliases.set(d.confirming.id, id);
    if (d.confirming?.imMsgId) this.#aliases.set(d.confirming.imMsgId, id);
  }

  #unindexDraft(d: PrivateDraft): void {
    for (const [k, targetId] of this.#aliases) {
      if (targetId === d.id) this.#aliases.delete(k);
    }
  }

  uniqueSize(): number {
    let count = 0;
    for (const d of this.#byId.values()) {
      if (!this.#confirmOnly.has(d)) count += 1;
    }
    return count;
  }

  confirmingCount(): number {
    const now = this.#now();
    let count = 0;
    for (const d of this.#byId.values()) {
      if (d.confirming && d.confirming.expiresAt > now) count += 1;
    }
    return count;
  }

  hasDraftKey(key: string): boolean {
    return Boolean(this.getDraft(key));
  }

  getDraft(key: string): PrivateDraft | undefined {
    const k = String(key ?? '');
    const id = this.#byId.has(k) ? k : this.#aliases.get(k);
    if (!id) return undefined;
    const d = this.#byId.get(id);
    return d && !this.#confirmOnly.has(d) ? d : undefined;
  }

  putDraft(draft: PrivateDraft, aliasKey?: string): void {
    if (!draft?.id && aliasKey) draft.id = aliasKey;
    if (!draft?.id) return;
    this.#confirmOnly.delete(draft);
    this.#byId.set(draft.id, draft);
    this.#indexDraft(draft, aliasKey);
    while (this.#byId.size > 40) {
      const oldest = this.#byId.keys().next().value;
      if (!oldest) break;
      this.purge(oldest);
    }
  }

  purge(idOrKey: string): boolean {
    const k = String(idOrKey ?? '');
    const id = this.#byId.has(k) ? k : this.#aliases.get(k);
    if (!id) return false;
    const d = this.#byId.get(id);
    if (!d) return false;
    this.#byId.delete(id);
    this.#confirmOnly.delete(d);
    this.#unindexDraft(d);
    return true;
  }

  deleteDraftByKey(key: string): boolean {
    const k = String(key ?? '');
    const id = this.#byId.has(k) ? k : this.#aliases.get(k);
    if (!id) return false;
    const d = this.#byId.get(id);
    if (!d) return false;
    if (d.id === k || d.imMsgId === k) {
      return this.purge(id);
    }
    if (this.#aliases.get(k) === id) {
      this.#aliases.delete(k);
      return true;
    }
    return false;
  }

  clearAll(): void {
    this.#byId.clear();
    this.#aliases.clear();
  }

  setConfirmingFromEntry(key: string, sb: PendingSendBack): void {
    if (!sb?.draft) return;
    const k = String(key || sb.id || sb.draft.id || 'default');
    const draftId = sb.draft.id || k;
    const existing = this.#byId.get(draftId);
    const targetDraft = existing ?? { ...sb.draft, id: draftId };
    if (!existing) {
      this.#byId.set(draftId, targetDraft);
      this.#confirmOnly.add(targetDraft);
    } else if (sb.draft !== existing && sb.inboxRef && !existing.inboxRef) {
      existing.inboxRef = sb.inboxRef;
    }
    const conf: DraftConfirmingState = {
      id: sb.id || k,
      inboxRef: sb.inboxRef ?? targetDraft.inboxRef,
      imMsgId: sb.imMsgId ?? null,
      text: sb.text,
      useBotPrefix: sb.useBotPrefix,
      expiresAt: sb.expiresAt,
    };
    targetDraft.confirming = conf;
    this.#indexDraft(targetDraft, k);
  }

  getConfirming(key: string): PendingSendBack | null {
    const k = String(key ?? '');
    const id = this.#byId.has(k) ? k : this.#aliases.get(k);
    if (id) {
      const d = this.#byId.get(id);
      if (d?.confirming && (d.confirming.id === k || d.id === k || d.confirming.imMsgId === k)) {
        return d.confirming.expiresAt > this.#now() ? projectSendBack(d) : null;
      }
    }
    for (const d of this.#byId.values()) {
      if (d.confirming && (d.confirming.id === k || d.id === k || d.confirming.imMsgId === k)) {
        return d.confirming.expiresAt > this.#now() ? projectSendBack(d) : null;
      }
    }
    return null;
  }

  clearConfirmingByKey(key: string): boolean {
    const k = String(key ?? '');
    const id = this.#byId.has(k) ? k : this.#aliases.get(k);
    const d = id ? this.#byId.get(id) : [...this.#byId.values()].find((x) => x.confirming?.id === k || x.confirming?.imMsgId === k);
    if (!d?.confirming) return false;
    if (this.#confirmOnly.has(d)) {
      return this.purge(d.id);
    }
    if (d.confirming.imMsgId && d.confirming.imMsgId !== d.imMsgId) {
      this.#aliases.delete(d.confirming.imMsgId);
    }
    if (d.confirming.id && d.confirming.id !== d.id) {
      this.#aliases.delete(d.confirming.id);
    }
    d.confirming = undefined;
    return true;
  }

  setConfirmingImMsgId(idOrKey: string, imMsgId: string | null): void {
    if (!imMsgId) return;
    const k = String(idOrKey ?? '');
    const id = this.#byId.has(k) ? k : this.#aliases.get(k);
    const d = id ? this.#byId.get(id) : [...this.#byId.values()].find((x) => x.confirming?.id === k);
    if (!d?.confirming) return;
    d.confirming.imMsgId = imMsgId;
    this.#aliases.set(imMsgId, d.id);
  }

  extendConfirming(idOrKey: string, expiresAt: number): void {
    const k = String(idOrKey ?? '');
    const id = this.#byId.has(k) ? k : this.#aliases.get(k);
    const d = id ? this.#byId.get(id) : [...this.#byId.values()].find((x) => x.confirming?.id === k);
    if (d?.confirming) d.confirming.expiresAt = Math.max(d.confirming.expiresAt, expiresAt);
  }

  pruneExpired(
    now: number,
    draftTtlMs: number,
    { onConfirmExpired, onDraftExpired }: {
      onConfirmExpired?: (draft: PrivateDraft, conf: DraftConfirmingState) => void;
      onDraftExpired?: (draft: PrivateDraft) => void;
    } = {},
  ): boolean {
    let changed = false;
    const cutoff = now - draftTtlMs;
    for (const d of [...this.#byId.values()]) {
      if (d.confirming && d.confirming.expiresAt <= now) {
        const conf = d.confirming;
        onConfirmExpired?.(d, conf);
        if (this.#confirmOnly.has(d)) {
          this.purge(d.id);
          changed = true;
          continue;
        }
        if (conf.imMsgId && conf.imMsgId !== d.imMsgId) this.#aliases.delete(conf.imMsgId);
        if (conf.id && conf.id !== d.id) this.#aliases.delete(conf.id);
        d.confirming = undefined;
        changed = true;
      }
      if (!this.#confirmOnly.has(d) && (d.createdAt || 0) < cutoff && !d.confirming) {
        onDraftExpired?.(d);
        this.purge(d.id);
        changed = true;
      }
    }
    return changed;
  }

  clearAllConfirming(): void {
    for (const d of [...this.#byId.values()]) {
      if (d.confirming) this.clearConfirmingByKey(d.confirming.id || d.id);
    }
  }

  latestConfirming(): PendingSendBack | null {
    const now = this.#now();
    let last: PendingSendBack | null = null;
    for (const d of this.#byId.values()) {
      if (!d.confirming || d.confirming.expiresAt <= now) continue;
      last = projectSendBack(d);
    }
    return last;
  }

  listUnique(): PrivateDraft[] {
    const out: PrivateDraft[] = [];
    for (const d of this.#byId.values()) {
      if (!this.#confirmOnly.has(d)) out.push(d);
    }
    return out;
  }

  listAllRaw(): PrivateDraft[] {
    return [...this.#byId.values()];
  }

  *draftKeys(): IterableIterator<string> {
    for (const d of this.#byId.values()) {
      if (!this.#confirmOnly.has(d)) yield d.id;
    }
  }

  *draftValues(): IterableIterator<PrivateDraft> {
    for (const d of this.#byId.values()) {
      if (!this.#confirmOnly.has(d)) yield d;
    }
  }

  *iterDraftEntries(): IterableIterator<[string, PrivateDraft]> {
    for (const d of this.#byId.values()) {
      if (!this.#confirmOnly.has(d)) yield [d.id, d];
    }
  }

  *confirmingKeys(): IterableIterator<string> {
    const now = this.#now();
    for (const d of this.#byId.values()) {
      if (d.confirming && d.confirming.expiresAt > now) yield d.confirming.id || d.id;
    }
  }

  *confirmingValues(): IterableIterator<PendingSendBack> {
    const now = this.#now();
    for (const d of this.#byId.values()) {
      if (d.confirming && d.confirming.expiresAt > now) {
        const sb = projectSendBack(d);
        if (sb) yield sb;
      }
    }
  }

  *iterConfirmingEntries(): IterableIterator<[string, PendingSendBack]> {
    const now = this.#now();
    for (const d of this.#byId.values()) {
      if (d.confirming && d.confirming.expiresAt > now) {
        const sb = projectSendBack(d);
        if (sb) yield [sb.id || d.id, sb];
      }
    }
  }

  exportSnapshot(now: number, draftTtlMs: number): PrivateDraft[] {
    const cutoff = now - draftTtlMs;
    const out: PrivateDraft[] = [];
    for (const d of this.#byId.values()) {
      if (!d?.id) continue;
      if (d.createdAt && d.createdAt < cutoff && !(d.confirming && d.confirming.expiresAt > now)) continue;
      const confirming = d.confirming && d.confirming.expiresAt > now ? d.confirming : undefined;
      out.push({
        ...d,
        ...(confirming ? { confirming } : { confirming: undefined }),
      });
    }
    return out.slice(-40);
  }

  hydrateSnapshot(
    rawDrafts: PrivateDraft[] | undefined,
    rawLegacySendBacks: Array<[string, PendingSendBack]> | undefined,
    now: number,
    draftTtlMs: number,
  ): void {
    const cutoff = now - draftTtlMs;
    if (Array.isArray(rawDrafts)) {
      for (const raw of rawDrafts.slice(-40)) {
        if (!raw?.id || !raw.originChatId) continue;
        const confirming = raw.confirming && Number(raw.confirming.expiresAt) > now ? raw.confirming : undefined;
        if (raw.createdAt && raw.createdAt < cutoff && !confirming) continue;
        const entry: PrivateDraft = confirming ? { ...raw, confirming } : { ...raw, confirming: undefined };
        this.putDraft(entry);
      }
    }
    if (Array.isArray(rawLegacySendBacks)) {
      for (const [k, sb] of rawLegacySendBacks.slice(-10)) {
        if (k && sb?.draft?.originChatId && Number(sb.expiresAt) > now) {
          this.setConfirmingFromEntry(String(k), sb);
        }
      }
    }
  }
}
