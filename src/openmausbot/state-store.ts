/**
 * OpenMausBotBridge 状态持久化、防抖落盘、损坏自动备份与有界缓存清理器。
 */
import fs from 'node:fs';
import { writeJsonAtomic } from '../format.ts';
import type { ProjectRef } from '../types.ts';
import type { OpenMausBotBridge } from './bridge.ts';
import { rememberBounded } from './mentions.ts';
import type {
  BridgeFocus,
  ChatThreadEntry,
  InFlightTurnMeta,
  MsgRoute,
  PendingCard,
  PendingFollowUp,
  PrivateDraft,
  QuietQueueItem,
} from './types.ts';

const FILE_TTL = 10 * 60 * 1000;
const ECHO_TTL = 3 * 60 * 1000;

interface BridgeStateFile {
  selfChatId?: string;
  focus?: BridgeFocus | null;
  msgRoute?: Array<[string, MsgRoute]>;
  quietQueue?: QuietQueueItem[];
  pendingCards?: Array<[string, PendingCard]>;
  deliveredOmbIds?: string[];
  externalThreadIds?: string[];
  chatThreads?: Array<[string, ChatThreadEntry]>;
  selfThreads?: Array<[string, BridgeFocus]>;
  chatPolicy?: { mode?: string | null; muted?: string[]; allowed?: string[] };
  inFlightTurns?: Array<[string, InFlightTurnMeta]>;
  privateDrafts?: PrivateDraft[];
  lastPrivateDraftId?: string | null;
  pendingFollowUps?: PendingFollowUp[];
  chatProjects?: Array<[string, ProjectRef]>;
  delegations?: unknown;
}

export function loadBridgeState(bridge: OpenMausBotBridge): void {
  if (!bridge.stateFile) return;
  let rawText: string;
  try {
    rawText = fs.readFileSync(bridge.stateFile, 'utf8');
  } catch {
    return; // 首次启动尚无状态文件
  }
  let raw: BridgeStateFile;
  try {
    raw = JSON.parse(rawText) as BridgeStateFile;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    bridge.stateCorruptRecoveries += 1;
    try {
      fs.renameSync(bridge.stateFile, `${bridge.stateFile}.corrupt.${bridge.now()}`);
    } catch { /* ignore */ }
    console.error(`[omb-bridge] 状态文件损坏，已自动备份并重置：${msg}`);
    bridge.emitTelemetry('state_corrupt', { summary: msg });
    return;
  }
  try {
    if (typeof raw?.selfChatId === 'string' && raw.selfChatId) {
      bridge.learnedSelfChatId = raw.selfChatId;
      if (bridge.transport && !bridge.transport.selfChatId) bridge.transport.selfChatId = raw.selfChatId;
    }
    if (raw?.focus?.botId) bridge.focus = raw.focus;
    if (Array.isArray(raw?.msgRoute)) {
      for (const [k, v] of raw.msgRoute.slice(-500)) if (k && v?.botId) bridge.msgRoute.set(String(k), v);
    }
    if (Array.isArray(raw?.quietQueue)) {
      bridge.quietQueue = raw.quietQueue.filter((it) => it && it.botId && it.threadId).slice(-100);
    }
    if (Array.isArray(raw?.pendingCards)) {
      for (const [k, v] of raw.pendingCards.slice(-20)) {
        if (k && v?.botId && v?.threadId) {
          bridge.pendingCards.set(String(k), v);
          rememberBounded(bridge.deliveredCards, v.requestId || (v.burstId ? `burst:${v.burstId}` : v.ombMsgId));
        }
      }
    }
    if (Array.isArray(raw?.deliveredOmbIds)) {
      for (const id of raw.deliveredOmbIds.slice(-200)) rememberBounded(bridge.deliveredOmbIds, id);
    }
    if (Array.isArray(raw?.externalThreadIds)) {
      for (const tid of raw.externalThreadIds.slice(-500)) rememberBounded(bridge.externalThreadIds, tid, 500);
    }
    if (Array.isArray(raw?.chatThreads)) {
      for (const [k, v] of raw.chatThreads.slice(-200)) {
        if (k && v?.botId && v?.threadId) {
          bridge.chatThreads.set(String(k), v);
          rememberBounded(bridge.externalThreadIds, v.threadId, 500);
        }
      }
    }
    if (Array.isArray(raw?.selfThreads)) {
      for (const [k, v] of raw.selfThreads.slice(-100)) {
        if (k && v?.threadId && !bridge.externalThreadIds.has(String(v.threadId))) {
          bridge.selfThreads.set(String(k), v);
        }
      }
    }
    if (raw?.chatPolicy && typeof raw.chatPolicy === 'object') {
      if (raw.chatPolicy.mode === 'self_only' || raw.chatPolicy.mode === 'owner_everywhere') {
        bridge.chatPolicyOverrides.mode = raw.chatPolicy.mode;
      }
      for (const id of raw.chatPolicy.muted ?? []) if (id) bridge.chatPolicyOverrides.muted.add(String(id));
      for (const id of raw.chatPolicy.allowed ?? []) if (id) bridge.chatPolicyOverrides.allowed.add(String(id));
    }
    const turnCutoff = bridge.now() - 30 * 60_000;
    if (Array.isArray(raw?.inFlightTurns)) {
      for (const [k, v] of raw.inFlightTurns.slice(-20)) {
        if (k && v?.botId && v?.threadId && (!v.startedAt || v.startedAt >= turnCutoff)) {
          bridge.inFlightTurns.set(String(k), v);
        }
      }
    }
    const draftCutoff = bridge.now() - (Number(bridge.draftTtlMs) || 30 * 60_000);
    if (Array.isArray(raw?.privateDrafts)) {
      for (const d of raw.privateDrafts.slice(-40)) {
        if (d?.id && d?.originChatId && (!d.createdAt || d.createdAt >= draftCutoff)) {
          bridge.privateDrafts.set(d.id, d);
          if (d.imMsgId) bridge.privateDrafts.set(d.imMsgId, d);
        }
      }
      if (raw.lastPrivateDraftId && bridge.privateDrafts.has(String(raw.lastPrivateDraftId))) {
        bridge.lastPrivateDraftId = String(raw.lastPrivateDraftId);
      }
    }
    if (Array.isArray(raw?.pendingFollowUps)) {
      const now = bridge.now();
      for (const fp of raw.pendingFollowUps.slice(-40)) {
        if (fp?.id && fp?.chatId && Number(fp.expiresAt) > now) {
          bridge.pendingFollowUps.set(String(fp.id), {
            ...fp,
            id: String(fp.id),
            chatId: String(fp.chatId),
            createdAt: Number(fp.createdAt) || now,
          });
        }
      }
    }
    if (Array.isArray(raw?.chatProjects) && bridge.chatProjects) {
      for (const [k, v] of raw.chatProjects.slice(-200)) {
        if (k && v?.path) {
          bridge.chatProjects.set(String(k), {
            name: String(v.name || v.path),
            path: String(v.path),
          });
        }
      }
    }
    if (raw?.delegations && bridge.delegations) {
      bridge.delegations.hydrate(raw.delegations);
    }
    // 防止早期版本遗留的外部会话 threadId 污染自聊 focus
    if (bridge.focus?.threadId && bridge.externalThreadIds.has(String(bridge.focus.threadId))) {
      const recovered = bridge.selfThreads.get(String(bridge.focus.botId));
      bridge.focus = recovered ? { ...recovered } : null;
    }
  } catch { /* 状态恢复兼容降级 */ }
}

function writeBridgeStateNow(bridge: OpenMausBotBridge): void {
  if (bridge.stateSaveTimer) {
    clearTimeout(bridge.stateSaveTimer);
    bridge.stateSaveTimer = null;
  }
  if (!bridge.stateFile) return;
  try {
    const seenDrafts = new Set<string>();
    const draftCutoff = bridge.now() - (Number(bridge.draftTtlMs) || 30 * 60_000);
    const uniqueDrafts: PrivateDraft[] = [];
    for (const d of bridge.privateDrafts.values()) {
      if (!d?.id || seenDrafts.has(d.id)) continue;
      if (d.createdAt && d.createdAt < draftCutoff) continue;
      seenDrafts.add(d.id);
      uniqueDrafts.push(d);
    }
    writeJsonAtomic(bridge.stateFile, {
      selfChatId: bridge.selfChat,
      focus: bridge.focus,
      msgRoute: [...bridge.msgRoute.entries()].slice(-500),
      quietQueue: bridge.quietQueue.slice(-100),
      pendingCards: [...bridge.pendingCards.entries()].slice(-20),
      deliveredOmbIds: [...bridge.deliveredOmbIds].slice(-200),
      chatThreads: [...bridge.chatThreads.entries()].slice(-200),
      selfThreads: [...bridge.selfThreads.entries()].slice(-100),
      externalThreadIds: [...bridge.externalThreadIds].slice(-500),
      chatPolicy: {
        mode: bridge.chatPolicyOverrides.mode,
        muted: [...bridge.chatPolicyOverrides.muted],
        allowed: [...bridge.chatPolicyOverrides.allowed],
      },
      inFlightTurns: [...bridge.inFlightTurns.entries()].slice(-20),
      privateDrafts: uniqueDrafts.slice(-40),
      lastPrivateDraftId: bridge.lastPrivateDraftId || null,
      pendingFollowUps: [...bridge.pendingFollowUps.values()]
        .filter((fp) => fp?.id && Number(fp.expiresAt) > bridge.now())
        .slice(-40),
      chatProjects: bridge.chatProjects ? [...bridge.chatProjects.entries()].slice(-200) : [],
      delegations: bridge.delegations ? bridge.delegations.snapshot() : undefined,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    bridge.stateSaveErrors += 1;
    console.error('[omb-bridge] 状态持久化失败：', msg);
    bridge.emitTelemetry('state_save_error', { summary: msg || 'save failed' });
  }
}

export function saveBridgeState(bridge: OpenMausBotBridge, { immediate = false }: { immediate?: boolean } = {}): void {
  if (!bridge.stateFile) return;
  const delay = Number(bridge.stateSaveDebounceMs);
  if (immediate || !(delay > 0)) {
    writeBridgeStateNow(bridge);
    return;
  }
  if (bridge.stateSaveTimer) return;
  bridge.stateSaveTimer = setTimeout(() => writeBridgeStateNow(bridge), delay);
  bridge.stateSaveTimer.unref?.();
}

export function flushBridgeState(bridge: OpenMausBotBridge): void {
  saveBridgeState(bridge, { immediate: true });
}

export function pruneBridgeMemoryCaches(bridge: OpenMausBotBridge): void {
  const now = bridge.now();
  for (const [k, ent] of bridge.fileMsgs) {
    if ((ent?.at || 0) + FILE_TTL < now) bridge.fileMsgs.delete(k);
  }
  for (const [k, exp] of bridge.pendingOutFiles) {
    if (exp <= now) bridge.pendingOutFiles.delete(k);
  }
  for (const [k, at] of bridge.recent) {
    if (now - at > ECHO_TTL) bridge.recent.delete(k);
  }
  const draftCutoff = now - (Number(bridge.draftTtlMs) || 30 * 60_000);
  for (const [k, v] of bridge.privateDrafts) {
    if ((v?.createdAt || 0) < draftCutoff) bridge.privateDrafts.delete(k);
  }
  for (const [k, v] of bridge.pendingFollowUps) {
    if (!v || (v.expiresAt || 0) <= now) bridge.pendingFollowUps.delete(k);
  }
  for (const [k, v] of bridge.pendingSendBacks) {
    if (!v || (v.expiresAt || 0) <= now) bridge.pendingSendBacks.delete(k);
  }
}
