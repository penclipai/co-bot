import { attachBotBadge } from '../core/security.ts';
import { clip } from '../format.ts';
import type { OpenMausBotBridge } from './bridge.ts';
import { extractWidgetFallbackText, formatOmbError } from './cards.ts';
import { messageNeedsInput } from './client.ts';
import { botCommandTarget } from './command-helpers.ts';
import { deliverBotReply, emitCard, forwardBotMedia } from './delivery.ts';
import { buildExternalChatCtx } from './collaborator-router.ts';
import { dispatchToBot } from './dispatch.ts';
import { reconcilePendingCards } from './inbox.ts';
import { inQuietHours, rememberBounded, trimMapCap } from './mentions.ts';
import { invalidateBotListCache, isBurstChildThread } from './thread-manager.ts';
import type {
  BridgeChatContext,
  MsgRoute,
  OmbHttpError,
  OmbMessage,
  OmbSseEvent,
  OmbTargetBot,
  QueuedTurnEntry,
} from './types.ts';

async function handleActiveBurstMessage(bridge: OpenMausBotBridge, threadId: string, msg: OmbMessage): Promise<boolean> {
  const watches = [...bridge.activeBursts.values()].filter((w) => w.threadId === threadId);
  if (!watches.length) return false;
  const watch = watches[watches.length - 1];
  const mid = msg.id ? String(msg.id) : null;

  if (msg.kind === 'text') {
    const trimmed = String(msg.text ?? '').trim();
    if (!trimmed) return false;
    if (mid && bridge.deliveredOmbIds.has(mid)) return true;
    if (mid) rememberBounded(bridge.deliveredOmbIds, mid);
    if (msg.turnTerminal !== false || watch.doneSeen) watch.deliveredText = true;
    if (watch.doneSeen && watch.deliveredText) {
      bridge.activeBursts.delete(watch.burstId);
      bridge.saveState();
    }
    await deliverBotReply(bridge, {
      botId: watch.botId,
      botName: watch.botName,
      threadId,
      text: trimmed,
      finalMsg: msg,
      mediaMessages: [msg],
      proactive: false,
      isGroup: Boolean(watch.isGroup),
      speakerName: watch.isGroup ? (msg.from?.name || '') : '',
      chatCtx: watch.chatCtx ?? null,
    });
    return true;
  }

  if (msg.kind === 'burst' && msg.burst?.burstId === watch.burstId) {
    const phase = String(msg.burst.phase || '');
    if (phase === 'failed' || phase === 'cancelled') {
      bridge.activeBursts.delete(watch.burstId);
      bridge.saveState();
      if (!watch.deliveredText) {
        const failLines = Array.isArray(msg.burst.failed)
          ? msg.burst.failed.slice(0, 5).map((f) => `- ${f.title || '子任务'}：${f.reason || '失败'}`)
          : [];
        const body = phase === 'cancelled'
          ? '⏹️ 并发拆分任务已取消。'
          : `❌ 并发拆分任务执行失败${failLines.length ? `：\n${failLines.join('\n')}` : '。'}`;
        await deliverBotReply(bridge, {
          botId: watch.botId,
          botName: watch.botName,
          threadId,
          text: body,
          finalMsg: msg,
          proactive: false,
          isGroup: Boolean(watch.isGroup),
          chatCtx: watch.chatCtx ?? null,
        });
      }
    } else if (phase === 'running' || phase === 'merging') {
      const now = bridge.now();
      const maxUpdates = Math.max(1, Number(bridge.maxProgressUpdates) || 2);
      const sentCount = Number(watch.progressSent) || 0;
      const delayOk = (now - (watch.startedAt || now)) >= (Number(bridge.progressDelayMs) || 12_000);
      const intervalOk = !watch.lastProgressAt || (now - watch.lastProgressAt) >= (Number(bridge.progressIntervalMs) || 25_000);
      if (!watch.chatCtx?.silentProgress && sentCount < maxUpdates && delayOk && intervalOk) {
        watch.progressSent = sentCount + 1;
        watch.lastProgressAt = now;
        const doneCount = Number(msg.burst.counts?.done ?? 0);
        const totalCount = Number(msg.burst.total ?? msg.burst.requested ?? 0);
        const progressBody = phase === 'merging'
          ? '⏳ 并发子任务已完成，正在汇总结果…'
          : (totalCount > 0
            ? `⏳ 并发任务进度：已完成 ${doneCount}/${totalCount} 项…`
            : '⏳ 并发任务执行中…');
        const who = bridge.botPrefix(watch.botId, watch.botName, { isGroup: Boolean(watch.isGroup) });
        const targetChatId = watch.chatCtx?.replyChatId || bridge.selfChat;
        await bridge.say(who ? attachBotBadge(who, progressBody) : progressBody, {
          botId: watch.botId,
          botName: watch.botName,
          threadId,
          ...(watch.isGroup ? { isGroup: true } : {}),
          ...(targetChatId ? { targetChatId } : {}),
        });
      }
    } else if (phase === 'done') {
      watch.doneSeen = true;
      if (watch.deliveredText) {
        bridge.activeBursts.delete(watch.burstId);
        bridge.saveState();
      } else {
        // 等待紧随其后的合并文本到达，超时后自动清理防止悬挂
        const timer = setTimeout(() => {
          const cur = bridge.activeBursts.get(watch.burstId);
          if (cur === watch) {
            bridge.activeBursts.delete(watch.burstId);
            bridge.saveState();
          }
        }, 120_000);
        timer.unref?.();
      }
    }
    return true;
  }
  return false;
}

function pickQueuedEntry(
  bridge: OpenMausBotBridge,
  preferredThreadId?: string | null,
): { threadId: string; list: QueuedTurnEntry[] } | null {
  if (preferredThreadId) {
    const preferred = bridge.queuedByThread.get(preferredThreadId);
    if (preferred?.length) return { threadId: preferredThreadId, list: preferred };
  }
  for (const [tid, list] of bridge.queuedByThread) {
    if (list.length) return { threadId: tid, list };
  }
  return null;
}

export function removeQueued(bridge: OpenMausBotBridge, threadId: string, queueId: string): QueuedTurnEntry | null {
  const list = bridge.queuedByThread.get(threadId);
  if (!list) return null;
  const idx = list.findIndex((q) => q.queueId === queueId);
  if (idx < 0) return null;
  const [removed] = list.splice(idx, 1);
  if (!list.length) bridge.queuedByThread.delete(threadId);
  return removed;
}

/** 清理超时的本地排队记录与 stale steeredQueue 条目，返回被清理总数。 */
export function pruneExpiredQueues(bridge: OpenMausBotBridge): number {
  const ttl = Number(bridge.queueTtlMs) || 0;
  if (!(ttl > 0)) return 0;
  const now = bridge.now();
  let removed = 0;
  for (const [tid, list] of [...bridge.queuedByThread.entries()]) {
    const kept = list.filter((q) => (q?.at ? (now - q.at) < ttl : true));
    const delta = list.length - kept.length;
    if (delta > 0) {
      removed += delta;
      if (kept.length) bridge.queuedByThread.set(tid, kept);
      else bridge.queuedByThread.delete(tid);
    }
  }
  for (const [sid, q] of [...bridge.steeredQueue.entries()]) {
    if (q?.at && (now - q.at) >= ttl) {
      bridge.steeredQueue.delete(sid);
      removed += 1;
    }
  }
  if (removed > 0) {
    bridge.emitTelemetry('queued_expired', { summary: `pruned=${removed}` });
  }
  return removed;
}

async function handleProactiveMessage(bridge: OpenMausBotBridge, threadId: string, msg: OmbMessage): Promise<void> {
  if (!msg || msg.role !== 'bot' || bridge.proactive === false) return;
  if (msg.kind === 'digest' || msg.kind === 'activity') return;
  if (msg.id && bridge.deliveredOmbIds.has(String(msg.id))) return;
  if (msg.requestMessageId && bridge.ownReqIds.has(String(msg.requestMessageId))) return;
  if (bridge.pendingThreads.has(threadId)) return;

  const owner = await bridge.resolveOwnerByThread(threadId);
  if (isBurstChildThread(bridge, threadId)) {
    if (messageNeedsInput(msg)) {
      const cardBotId = owner?.id ?? threadId;
      const cardIsGroup = Boolean(owner?.isGroup);
      const cardBotName = bridge.displayBotName(cardBotId, owner?.name, { isGroup: cardIsGroup });
      await emitCard(bridge, cardBotId, cardBotName, threadId, msg, { isGroup: cardIsGroup, chatCtx: null });
      return;
    }
    if (msg.id) rememberBounded(bridge.deliveredOmbIds, msg.id);
    return;
  }
  const botId = owner?.id ?? threadId;
  const isGroup = Boolean(owner?.isGroup);
  const botName = bridge.displayBotName(botId, owner?.name, { isGroup });
  const speakerName = isGroup ? (msg.from?.name || '') : '';
  const speakerBotId = isGroup ? (msg.from?.botId || null) : null;
  const extChat = [...bridge.chatThreads.values()].find((v) => v.threadId === threadId) ?? null;
  const proChatCtx: BridgeChatContext | null = extChat
    ? {
        isExternal: true,
        originChatId: extChat.chatId,
        chatType: extChat.chatType,
        chatName: extChat.chatName,
        replyChatId: bridge.selfChat || extChat.chatId,
        controlChatId: bridge.selfChat || extChat.chatId,
        replyToImMsgId: null,
        originQuoteId: null,
        privateReply: Boolean(bridge.selfChat),
        silentProgress: true,
      }
    : null;

  if (messageNeedsInput(msg)) {
    await emitCard(bridge, botId, botName, threadId, msg, { isGroup, chatCtx: proChatCtx });
    return;
  }
  if (msg.kind === 'burst') return;
  if (msg.kind === 'goal.run') {
    if (!msg.goalRun?.status || msg.goalRun.status === 'working') return;
    const goalText = String(msg.text || msg.goalRun.detail || '').trim();
    if (!goalText) return;
    rememberBounded(bridge.deliveredOmbIds, msg.id);
    if (inQuietHours(bridge.now(), bridge.quietHours)) {
      bridge.quietQueue.push({ botId, botName, threadId, isGroup, speakerName, speakerBotId, text: goalText, finalMsg: msg });
      bridge.saveState();
      return;
    }
    await deliverBotReply(bridge, {
      botId,
      botName,
      threadId,
      text: goalText,
      finalMsg: msg,
      proactive: true,
      isGroup,
      speakerName,
      chatCtx: proChatCtx,
    });
    return;
  }

  if (msg.kind === 'screen' && msg.hasImage) {
    rememberBounded(bridge.deliveredOmbIds, msg.id);
    if (extChat) {
      bridge.saveState();
      return; // 外部会话后台异常或重试产生的无文字截图不再误发自聊
    }
    if (inQuietHours(bridge.now(), bridge.quietHours)) {
      bridge.quietQueue.push({ botId, botName, threadId, isGroup, speakerName, speakerBotId, text: '（截图通知）', finalMsg: msg });
      bridge.saveState();
      return;
    }
    bridge.saveState();
    await forwardBotMedia(bridge, threadId, [msg], { chatId: bridge.selfChat });
    return;
  }

  const text = String(msg.text ?? '').trim();
  const hasMedia = Boolean(msg.hasImage || (Array.isArray(msg.attachments) && msg.attachments.length > 0));
  if (msg.kind === 'text' && !msg.turnTerminal && !text && hasMedia) {
    rememberBounded(bridge.deliveredOmbIds, msg.id);
    if (extChat) {
      bridge.saveState();
      return;
    }
    if (inQuietHours(bridge.now(), bridge.quietHours)) {
      bridge.quietQueue.push({ botId, botName, threadId, isGroup, speakerName, speakerBotId, text: '（附件通知）', finalMsg: msg });
      bridge.saveState();
      return;
    }
    bridge.saveState();
    await forwardBotMedia(bridge, threadId, [msg], { chatId: bridge.selfChat });
    return;
  }

  if ((msg.kind === 'text' || msg.kind === 'widget') && (msg.turnTerminal || msg.kind === 'widget')) {
    const effText = msg.kind === 'widget' ? extractWidgetFallbackText(msg) : text;
    if (!effText && !hasMedia) return;
    rememberBounded(bridge.deliveredOmbIds, msg.id);
    if (inQuietHours(bridge.now(), bridge.quietHours)) {
      bridge.quietQueue.push({ botId, botName, threadId, isGroup, speakerName, speakerBotId, text: effText || '（附件通知）', finalMsg: msg });
      bridge.saveState();
      return;
    }
    await deliverBotReply(bridge, {
      botId,
      botName,
      threadId,
      text: effText || '（附件通知）',
      finalMsg: msg,
      mediaMessages: [msg],
      widgetMessages: msg.kind === 'widget' ? [msg] : [],
      proactive: true,
      isGroup,
      speakerName,
      chatCtx: proChatCtx,
    });
  }
}

function claimQueuedUserMessage(bridge: OpenMausBotBridge, threadId: string, msg: OmbMessage): boolean {
  const list = bridge.queuedByThread.get(threadId);
  let hit: QueuedTurnEntry | null = null;
  if (list?.length) {
    const idx = list.findIndex((q) => (msg.sendId && q.sendId === msg.sendId) || (msg.queueId && q.queueId === msg.queueId));
    if (idx >= 0) {
      [hit] = list.splice(idx, 1);
      if (!list.length) bridge.queuedByThread.delete(threadId);
    }
  }
  if (!hit && msg.sendId && bridge.steeredQueue.has(msg.sendId)) {
    hit = bridge.steeredQueue.get(msg.sendId) ?? null;
    bridge.steeredQueue.delete(msg.sendId);
  }
  if (!hit) return false;

  const reqMsgId = msg.id ?? null;
  if (reqMsgId) rememberBounded(bridge.ownReqIds, reqMsgId);
  const key = reqMsgId || `${threadId}:${hit.sendId}`;
  if (!bridge.activeTurns.has(key)) {
    const turn = bridge.trackTurn({
      key,
      botId: hit.botId,
      botName: hit.botName,
      threadId,
      reqMsgId,
      sendId: hit.sendId,
      isGroup: Boolean(hit.isGroup),
      chatCtx: hit.chatCtx ?? null,
    });
    turn.startWatcher();
  }
  return true;
}

export async function trySteerQueueItem(
  bridge: OpenMausBotBridge,
  { botId, botName, threadId, isGroup, queueId, text, sendId, chatCtx }: QueuedTurnEntry,
  {
    targetChatId,
    banner = '',
    onQueuedText,
  }: {
    targetChatId?: string | null;
    banner?: string;
    onQueuedText?: (res: { queued?: boolean; blockedBy?: string }) => string;
  } = {},
): Promise<{ steered: boolean; res?: { queued?: boolean; blockedBy?: string }; error?: unknown }> {
  const outChatId = targetChatId || chatCtx?.controlChatId || bridge.selfChat;
  const route: MsgRoute = {
    botId,
    botName,
    threadId,
    ...(isGroup ? { isGroup: true } : {}),
    ...(outChatId ? { targetChatId: outChatId } : {}),
  };
  try {
    const res = isGroup && typeof bridge.client.steerGroupQueued === 'function'
      ? await bridge.client.steerGroupQueued(botId, queueId, threadId)
      : await bridge.client.steerQueued(botId, queueId, threadId);
    if (res?.queued) {
      const cmdTarget = botCommandTarget(bridge, botId, botName, { isGroup });
      const queueHint = typeof onQueuedText === 'function'
        ? `\n回复 \`${cmdTarget} cancel\` 可取消排队。`
        : '';
      const msg = (typeof onQueuedText === 'function'
        ? onQueuedText(res)
        : `${banner}⏳ 当前工具执行暂不支持直接插队${res.blockedBy ? `（${res.blockedBy}）` : ''}，已保留在队列等待上一轮完成。`) + queueHint;
      await bridge.say(msg, route);
      return { steered: false, res };
    }
    bridge.steeredQueue.set(sendId, { queueId, botId, botName, threadId, isGroup, text, sendId, at: bridge.now(), chatCtx });
    trimMapCap(bridge.steeredQueue, 50);
    await bridge.say(`${banner}⚡ 已插队注入当前任务：「${clip(text, 50)}」`, route);
    return { steered: true, res };
  } catch (e) {
    await bridge.say(`${banner}❌ 插队失败：${formatOmbError(e)}`, outChatId ? { targetChatId: outChatId } : null);
    return { steered: false, error: e };
  }
}

/** 取消并清空指定 Thread 中尚未执行的全部排队消息（例如 @bot stop 时调用）。 */
export async function cancelThreadQueue(bridge: OpenMausBotBridge, threadId: string): Promise<number> {
  if (!threadId) return 0;
  const list = bridge.queuedByThread.get(threadId);
  if (!list?.length) return 0;
  bridge.queuedByThread.delete(threadId);
  let cancelled = 0;
  for (const q of list) {
    cancelled += 1;
    try {
      if (q.isGroup && typeof bridge.client.cancelGroupQueued === 'function') {
        await bridge.client.cancelGroupQueued(q.botId, q.queueId);
      } else if (typeof bridge.client.cancelQueued === 'function') {
        await bridge.client.cancelQueued(q.botId, q.queueId, q.threadId);
      }
    } catch { /* ignore stale queue item */ }
  }
  return cancelled;
}

/** 将最新一条排队消息插队注入正在执行的任务。 */
export async function steerLatestQueue(
  bridge: OpenMausBotBridge,
  preferredThreadId?: string | null,
  targetChatId: string | null = null,
  { banner = '' }: { banner?: string } = {},
): Promise<void> {
  pruneExpiredQueues(bridge);
  const hit = pickQueuedEntry(bridge, preferredThreadId);
  if (!hit) {
    await bridge.say(`${banner}当前没有排队中的消息。`, targetChatId ? { targetChatId } : null);
    return;
  }
  const q = hit.list[hit.list.length - 1];
  const res = await trySteerQueueItem(bridge, q, { targetChatId, banner });
  if (res.steered) removeQueued(bridge, q.threadId, q.queueId);
}

/** 对运行中的任务追加补充插队指令（@bot steer <补充要求>）。 */
export async function dispatchSteerSupplement(
  bridge: OpenMausBotBridge,
  target: OmbTargetBot,
  text: string,
  imMsgId: string | null,
  quotedId: string | null,
  chatCtx: BridgeChatContext | null = null,
  { banner = '', cmdTarget = bridge.trigger }: { banner?: string; cmdTarget?: string } = {},
) {
  const tid = target?.threadId;
  const hasRunning = Boolean(tid && [...bridge.activeTurns.values()].some((t) => t.threadId === tid));
  const hasQueued = Boolean(tid && bridge.queuedByThread.get(tid)?.length);
  const outChatId = chatCtx?.controlChatId || chatCtx?.replyChatId || bridge.selfChat;
  if (!hasRunning && !hasQueued) {
    await bridge.say(
      `${banner}ℹ️ 当前没有运行中或排队中的任务，如需提问请直接发送 \`${cmdTarget} ${text}\`。`,
      outChatId ? { targetChatId: outChatId } : null,
    );
    return null;
  }
  const baseCtx = chatCtx ?? buildExternalChatCtx(bridge, {
    isSelfChat: true,
    chatId: bridge.selfChat,
    chatType: 'self',
    chatName: '',
    mid: imMsgId,
    privateReply: false,
    ev: null,
  });
  return dispatchToBot(bridge, target, text, imMsgId, quotedId, null, {
    ...baseCtx,
    autoSteer: true,
    steerBanner: banner,
  });
}

/** 取消最近一条排队等待的消息。 */
export async function cancelLatestQueue(
  bridge: OpenMausBotBridge,
  preferredThreadId?: string | null,
  targetChatId: string | null = null,
  { banner = '' }: { banner?: string } = {},
): Promise<void> {
  pruneExpiredQueues(bridge);
  const hit = pickQueuedEntry(bridge, preferredThreadId);
  if (!hit) {
    await bridge.say(`${banner}当前没有排队中的消息。`, targetChatId ? { targetChatId } : null);
    return;
  }
  const q = hit.list[hit.list.length - 1];
  const outChatId = targetChatId || q.chatCtx?.controlChatId || bridge.selfChat;
  const route: MsgRoute = {
    botId: q.botId,
    botName: q.botName,
    threadId: q.threadId,
    ...(q.isGroup ? { isGroup: true } : {}),
    ...(outChatId ? { targetChatId: outChatId } : {}),
  };
  try {
    if (q.isGroup && typeof bridge.client.cancelGroupQueued === 'function') {
      await bridge.client.cancelGroupQueued(q.botId, q.queueId);
    } else {
      await bridge.client.cancelQueued(q.botId, q.queueId, q.threadId);
    }
    removeQueued(bridge, q.threadId, q.queueId);
    await bridge.say(`${banner}🗑 已取消排队消息：「${clip(q.text, 50)}」`, route);
  } catch (e) {
    const status = (e as OmbHttpError | null | undefined)?.status;
    if (status === 404 || status === 409 || status === 410) {
      removeQueued(bridge, q.threadId, q.queueId);
      await bridge.say(`${banner}🗑 队列消息已不在待办队列，已清理本地记录。`, route);
      return;
    }
    await bridge.say(`${banner}❌ 取消排队失败：${formatOmbError(e)}`, outChatId ? { targetChatId: outChatId } : null);
  }
}

/** 消费来自 OpenMausBot `/api/events` SSE 推送的消息与状态变更事件。 */
export async function handleSseEvent(bridge: OpenMausBotBridge, evt: OmbSseEvent): Promise<void> {
  if (!evt || typeof evt !== 'object') return;
  const wasConnected = bridge.sseConnected;
  bridge.sseConnected = true;
  bridge.sseAuthError = null;
  bridge.consecutiveSseErrors = 0;
  if (!wasConnected && bridge.pendingCards.size > 0) {
    void reconcilePendingCards(bridge).catch(() => {});
  }
  if ((evt.kind === 'message' || evt.kind === 'message.patch') && evt.message) {
    const threadId = evt.threadId ?? evt.message.threadId;
    if (!threadId) return;
    if (evt.message.role === 'user') {
      claimQueuedUserMessage(bridge, threadId, evt.message);
      return;
    }
    let handled = false;
    for (const turn of bridge.activeTurns.values()) {
      if (turn.threadId === threadId) {
        turn.onMessage(evt.message);
        handled = true;
      }
    }
    if (!handled) {
      const burstHandled = await handleActiveBurstMessage(bridge, threadId, evt.message);
      if (!burstHandled) await handleProactiveMessage(bridge, threadId, evt.message);
    }
    return;
  }
  if (evt.kind === 'bot' && evt.bot) {
    invalidateBotListCache(bridge);
    for (const turn of bridge.activeTurns.values()) {
      if (turn.botId !== evt.bot.id || turn.isGroup) continue;
      if (evt.bot.busy) turn.sawBusy = true;
      else if (turn.sawBusy && !evt.bot.busy) turn.complete().catch(() => {});
    }
    const prev = bridge.botById.get(evt.bot.id);
    if (!evt.bot.hidden && (!prev || (evt.bot.name && prev.name !== evt.bot.name))) {
      bridge.refreshMultiBot().catch(() => {});
    }
    return;
  }
  if (evt.kind === 'group' && evt.group) {
    invalidateBotListCache(bridge);
    for (const turn of bridge.activeTurns.values()) {
      if (!turn.isGroup || turn.botId !== evt.group.id) continue;
      if (evt.group.busy) turn.sawBusy = true;
      else if (turn.sawBusy && !evt.group.busy) turn.complete().catch(() => {});
    }
    const prev = bridge.groupById.get(evt.group.id);
    if (!evt.group.hidden && (!prev || (evt.group.name && prev.name !== evt.group.name))) {
      bridge.refreshMultiBot().catch(() => {});
    }
  }
}
