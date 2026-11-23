/**
 * OpenMausBotBridge 状态持久化、防抖落盘、损坏自动备份、运行时偏好热恢复与有界缓存清理器。
 */
import fs from 'node:fs';
import { writeJsonAtomic } from '../format.js';
import { normalizeScheduleEntry, parseHHMM, rememberBounded } from './mentions.js';

const FILE_TTL = 10 * 60 * 1000;
const ECHO_TTL = 3 * 60 * 1000;

export function applyRuntimePrefs(bridge, prefs) {
  if (!prefs || typeof prefs !== 'object') return;
  bridge.runtimePrefs = { ...prefs };
  if (prefs.quietHours && typeof prefs.quietHours === 'object') {
    bridge.quietHours = { ...(bridge.quietHours || {}), ...prefs.quietHours };
  }
  if (typeof prefs.externalAckInSelf === 'boolean') {
    bridge.chats.externalAckInSelf = prefs.externalAckInSelf;
  }
  if (['all', 'dangerous', 'none'].includes(prefs.externalSanitizeMentions)) {
    bridge.chats.externalSanitizeMentions = prefs.externalSanitizeMentions;
  }
  if (Number.isFinite(Number(prefs.turnStallMs)) && Number(prefs.turnStallMs) >= 0) {
    bridge.turnStallMs = Number(prefs.turnStallMs);
  }
}

export function loadBridgeState(bridge) {
  if (!bridge.stateFile) return;
  let rawText;
  try {
    rawText = fs.readFileSync(bridge.stateFile, 'utf8');
  } catch {
    return; // 首次启动尚无状态文件
  }
  let raw;
  try {
    raw = JSON.parse(rawText);
  } catch (e) {
    bridge.stateCorruptRecoveries += 1;
    try {
      fs.renameSync(bridge.stateFile, `${bridge.stateFile}.corrupt.${bridge.now()}`);
    } catch { /* ignore */ }
    console.error(`[omb-bridge] 状态文件损坏，已自动备份并重置：${e.message}`);
    bridge.emitTelemetry('state_corrupt', { summary: e.message });
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
          rememberBounded(bridge.deliveredCards, v.requestId || v.ombMsgId);
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
    if (Array.isArray(raw?.scheduledSummaries)) {
      const byId = new Map(bridge.scheduledSummaries.map((s) => [s.id, s]));
      for (const s of raw.scheduledSummaries.slice(-30)) {
        if (!s?.id || !s?.chatId || parseHHMM(s.time) == null) continue;
        const existing = byId.get(String(s.id));
        if (existing) {
          if (typeof s.enabled === 'boolean') existing.enabled = s.enabled;
          if (s.lastRunDate) existing.lastRunDate = String(s.lastRunDate);
          if (Number(s.lastRunTs) > 0) existing.lastRunTs = Number(s.lastRunTs);
        } else if (!s.fromConfig) {
          const entry = normalizeScheduleEntry(s, { fromConfig: false, fallbackId: String(s.id) });
          if (entry) bridge.scheduledSummaries.push(entry);
        }
      }
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
    if (raw?.runtimePrefs && typeof raw.runtimePrefs === 'object') {
      applyRuntimePrefs(bridge, raw.runtimePrefs);
    }
    // 防止早期版本遗留的外部会话 threadId 污染自聊 focus
    if (bridge.focus?.threadId && bridge.externalThreadIds.has(String(bridge.focus.threadId))) {
      const recovered = bridge.selfThreads.get(String(bridge.focus.botId));
      bridge.focus = recovered ? { ...recovered } : null;
    }
  } catch { /* 状态恢复兼容降级 */ }
}

export function writeBridgeStateNow(bridge) {
  clearTimeout(bridge.stateSaveTimer);
  bridge.stateSaveTimer = null;
  if (!bridge.stateFile) return;
  try {
    const seenDrafts = new Set();
    const draftCutoff = bridge.now() - (Number(bridge.draftTtlMs) || 30 * 60_000);
    const uniqueDrafts = [];
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
      scheduledSummaries: bridge.scheduledSummaries.slice(-30),
      inFlightTurns: [...bridge.inFlightTurns.entries()].slice(-20),
      privateDrafts: uniqueDrafts.slice(-40),
      lastPrivateDraftId: bridge.lastPrivateDraftId || null,
      ...(bridge.runtimePrefs && Object.keys(bridge.runtimePrefs).length ? { runtimePrefs: bridge.runtimePrefs } : {}),
    });
  } catch (e) {
    bridge.stateSaveErrors += 1;
    console.error('[omb-bridge] 状态持久化失败：', e?.message || e);
    bridge.emitTelemetry('state_save_error', { summary: e?.message || 'save failed' });
  }
}

export function saveBridgeState(bridge, { immediate = false } = {}) {
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

export function flushBridgeState(bridge) {
  saveBridgeState(bridge, { immediate: true });
}

export function pruneBridgeMemoryCaches(bridge) {
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
}
