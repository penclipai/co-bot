import path from 'node:path';
import { clip, pruneExpiredFiles } from '../format.ts';
import type { OpenMausBotBridge } from './bridge.ts';
import { formatOmbError } from './cards.ts';
import { reconcilePendingCards } from './inbox.ts';
import { inQuietHours } from './mentions.ts';
import { handleSseEvent, pruneExpiredQueues } from './queue-and-sse.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 同步免打扰定时汇总轮询计时器。 */
export function syncBridgeQuietTimer(bridge: OpenMausBotBridge): void {
  if (bridge.quietTimer) {
    clearInterval(bridge.quietTimer);
    bridge.quietTimer = null;
  }
  if (bridge.quietHours?.enabled) {
    bridge.quietTimer = setInterval(() => {
      if (bridge.quietQueue.length && !inQuietHours(bridge.now(), bridge.quietHours)) {
        bridge.flushQuietDigest().catch(() => {});
      }
    }, 60_000);
    bridge.quietTimer.unref?.();
  }
}

/** 构造 OpenMausBotBridge 运行态聚合状态快照（供 `/api/status` 与 CLI 探针使用）。 */
export function buildBridgeStatus(bridge: OpenMausBotBridge) {
  pruneExpiredQueues(bridge);
  let queuedCount = 0;
  const queuedItems: Array<{
    queueId: string;
    botId: string;
    botName: string;
    threadId: string;
    text: string;
    at: number;
  }> = [];
  for (const arr of bridge.queuedByThread.values()) {
    queuedCount += arr.length;
    for (const q of arr) {
      queuedItems.push({
        queueId: q.queueId,
        botId: q.botId,
        botName: bridge.displayBotName(q.botId, q.botName, { isGroup: Boolean(q.isGroup) }),
        threadId: q.threadId,
        text: clip(q.text, 60),
        at: q.at,
      });
    }
  }
  const activeTurnsList = [...bridge.activeTurns.entries()].map(([key, t]) => ({
    key,
    botId: t.botId,
    botName: bridge.displayBotName(t.botId, t.botName, { isGroup: Boolean(t.isGroup) }),
    threadId: t.threadId,
    chatId: t.chatCtx?.originChatId || bridge.selfChat || '',
    startedAt: bridge.inFlightTurns.get(key)?.startedAt ?? null,
  }));
  const activeBurstsList = [...bridge.activeBursts.values()].map((b) => ({
    burstId: b.burstId,
    botId: b.botId,
    botName: bridge.displayBotName(b.botId, b.botName, { isGroup: Boolean(b.isGroup) }),
    threadId: b.threadId,
    startedAt: b.startedAt,
  }));
  const inbox = bridge.getCoordinatorInbox();
  const uniqueDrafts = new Set<string>();
  for (const d of bridge.privateDrafts.values()) if (d?.id) uniqueDrafts.add(d.id);
  return {
    connected: bridge.sseConnected,
    sseAuthFailed: Boolean(bridge.sseAuthError),
    proactive: bridge.proactive !== false,
    quietPending: bridge.quietQueue.length,
    quietHours: {
      enabled: Boolean(bridge.quietHours?.enabled),
      start: bridge.quietHours?.start || '22:00',
      end: bridge.quietHours?.end || '08:30',
      activeNow: inQuietHours(bridge.now(), bridge.quietHours),
    },
    passiveMentionAlert: Boolean(bridge.chats.passiveMentionAlert),
    collaboratorBot: String(bridge.chats.collaboratorBot || ''),
    activeTurns: bridge.activeTurns.size,
    activeTurnsList,
    activeBursts: bridge.activeBursts.size,
    activeBurstsList,
    inFlightTurns: bridge.inFlightTurns.size,
    queuedCount,
    queuedItems,
    pendingCards: bridge.pendingCards.size,
    stickyActive: bridge.isStickyActive(),
    botName: bridge.botName,
    focus: bridge.focus
      ? { ...bridge.focus, botName: bridge.displayBotName(bridge.focus.botId, bridge.focus.botName, { isGroup: Boolean(bridge.focus.isGroup) }) }
      : null,
    multiBot: bridge.multiBotCache,
    chatThreads: bridge.chatThreads.size,
    chatPolicy: bridge.getChatPolicy(),
    pendingSendBack: Boolean(bridge.pendingSendBack),
    pendingSendBacksCount: inbox.sendBacks.length,
    pendingFollowUpsCount: inbox.followUps.length,
    privateDraftsCount: uniqueDrafts.size,
    inbox,
    securityRedactions: bridge.securityRedactions,
    policyDenials: bridge.policyDenials,
    boundProjectsCount: bridge.chatProjects.size,
    sharedContext: bridge.sharedContext.status(),
    delegations: bridge.delegations.stats(),
    outboundBuffered: bridge.disconnectedBuffer.length,
    outboundFailures: bridge.outboundFailures,
    outboundReplayed: bridge.outboundReplayed,
    sseReconnects: bridge.sseReconnects,
    stateSaveErrors: bridge.stateSaveErrors,
    stateCorruptRecoveries: bridge.stateCorruptRecoveries,
    uptimeSec: Math.max(0, Math.round((bridge.now() - bridge.startedAt) / 1000)),
    context: bridge.imContext?.stats?.() ?? bridge.localContextStore.stats(),
  };
}

function resumeInFlightTurns(bridge: OpenMausBotBridge): void {
  if (!bridge.inFlightTurns.size) return;
  const maxTurnResumeMs = Math.min(30 * 60_000, Math.max(60_000, Number(bridge.turnTimeoutMs) || 600_000));
  const cutoff = bridge.now() - maxTurnResumeMs;
  for (const [key, meta] of [...bridge.inFlightTurns.entries()]) {
    if (!meta?.botId || !meta?.threadId || (meta.startedAt && meta.startedAt < cutoff)) {
      bridge.inFlightTurns.delete(key);
      continue;
    }
    if (bridge.activeTurns.has(key)) continue;
    const turn = bridge.trackTurn(meta);
    turn.startWatcher();
    bridge.emitTelemetry('turn_resumed', {
      botName: bridge.displayBotName(meta.botId, meta.botName, { isGroup: Boolean(meta.isGroup) }),
      chatId: meta.chatCtx?.originChatId || bridge.selfChat || null,
      summary: `thread=${meta.threadId}`,
    });
  }
}

/** 启动桥接器：文件清理、提醒定时器、IM 通道、OMB SSE、卡片对账与中断恢复。 */
export async function startBridgeLifecycle(bridge: OpenMausBotBridge): Promise<void> {
  const ttlMs = bridge.fileRetentionDays > 0 ? bridge.fileRetentionDays * DAY_MS : 0;
  const pullCacheDir = bridge.dataDir ? path.join(bridge.dataDir, 'in', 'pull') : '';
  if (ttlMs > 0) {
    pruneExpiredFiles(bridge.inDir, ttlMs, { now: bridge.now() });
    if (pullCacheDir) pruneExpiredFiles(pullCacheDir, ttlMs, { now: bridge.now() });
  }
  bridge.cleanupTimer = setInterval(() => {
    if (ttlMs > 0) {
      pruneExpiredFiles(bridge.inDir, ttlMs, { now: bridge.now() });
      if (pullCacheDir) pruneExpiredFiles(pullCacheDir, ttlMs, { now: bridge.now() });
    }
    bridge.pruneMemoryCaches();
  }, DAY_MS);
  bridge.cleanupTimer.unref?.();
  if (bridge.reminderTimer) {
    clearInterval(bridge.reminderTimer);
    bridge.reminderTimer = null;
  }
  bridge.reminderTimer = setInterval(() => {
    bridge.checkPendingReminders().catch(() => {});
  }, 60_000);
  bridge.reminderTimer.unref?.();
  await bridge.transport.start((ev) => Promise.resolve(bridge.onEvent(ev)).catch((e) => console.error('[omb-bridge]', e)));
  bridge.sseAc = new AbortController();
  bridge.sseTask = bridge.client.subscribeEvents((evt) => handleSseEvent(bridge, evt), {
    signal: bridge.sseAc.signal,
    onError: (e) => {
      if (bridge.sseConnected) bridge.sseReconnects += 1;
      bridge.sseConnected = false;
      if (e?.status === 401 || e?.status === 403) {
        bridge.consecutiveSseErrors = 0;
        if (!bridge.sseAuthError) console.error(`[omb-sse] 认证失败（${e.status}）：${formatOmbError(e)}`);
        bridge.sseAuthError = e.message || `HTTP ${e.status}`;
        return;
      }
      bridge.consecutiveSseErrors += 1;
      if (
        bridge.consecutiveSseErrors >= 2
        && typeof bridge.autoHealOmb === 'function'
        && (bridge.now() - bridge.lastAutoHealAt) >= bridge.autoHealCooldownMs
      ) {
        bridge.lastAutoHealAt = bridge.now();
        const heal = bridge.autoHealOmb;
        Promise.resolve().then(() => heal()).catch((err) => {
          console.warn('[omb-autoheal]', err instanceof Error ? err.message : err);
        });
      }
    },
  }).catch((e) => { if (!bridge.sseAc?.signal.aborted) console.error('[omb-sse]', e); });
  syncBridgeQuietTimer(bridge);
  await bridge.refreshMultiBot({ force: true });
  reconcilePendingCards(bridge).catch(() => {});
  resumeInFlightTurns(bridge);
  if (!bridge.isTransportDisconnected() && bridge.disconnectedBuffer.length) {
    bridge.flushOutboundBuffer().catch(() => {});
  }
}

/** 优雅停止桥接器：排空出站、取消定时器、终止 SSE 并刷盘持久化状态。 */
export async function stopBridgeLifecycle(bridge: OpenMausBotBridge): Promise<void> {
  bridge.sseConnected = false;
  bridge.sseAuthError = null;
  if (bridge.quietTimer) {
    clearInterval(bridge.quietTimer);
    bridge.quietTimer = null;
  }
  if (bridge.cleanupTimer) {
    clearInterval(bridge.cleanupTimer);
    bridge.cleanupTimer = null;
  }
  if (bridge.reminderTimer) {
    clearInterval(bridge.reminderTimer);
    bridge.reminderTimer = null;
  }
  bridge.clearPendingMedia();
  bridge.sseAc?.abort();
  await bridge.drainOutbound(2000).catch(() => {});
  for (const turn of [...bridge.activeTurns.values()]) turn.dispose();
  bridge.activeTurns.clear();
  bridge.flushState();
  await bridge.sseTask?.catch(() => {});
  await bridge.transport.stop?.();
}
