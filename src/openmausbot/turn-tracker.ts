/**
 * OpenMausBot 单轮执行追踪器：监听 SSE 消息与 /job 轮询，合并中间气泡、推送去噪进度并在轮次完成时收口交付。
 */
import type { OpenMausBotBridge } from './bridge.ts';
import { formatActivity, formatGoalProgress, formatOmbError } from './cards.ts';
import { messageNeedsInput } from './client.ts';
import { botCommandTarget } from './command-helpers.ts';
import { compactChatCtx, rememberBounded, trimMapCap } from './mentions.ts';
import type {
  BridgeChatContext,
  CompactChatContext,
  OmbMessage,
  TurnTrackerHandle,
} from './types.ts';

const FINAL_JOB_STATES = new Set(['completed', 'idle', 'failed', 'stalled']);

/** 收集属于本轮次的全部 Bot 消息（包含缺少 requestMessageId 但通过 sentInTurn / 位置窗口关联的独立附件消息）。 */
function collectTurnMessages(messages: OmbMessage[], reqMsgId: string | null, sendId: string | null): OmbMessage[] {
  const uIdx = messages.findLastIndex(
    (m) => m.role === 'user' && Boolean((reqMsgId && m.id === reqMsgId) || (sendId && m.sendId === sendId)),
  );
  let endIdx = messages.length;
  if (uIdx >= 0) {
    const nextUserIdx = messages.findIndex((m, idx) => idx > uIdx && m.role === 'user');
    if (nextUserIdx >= 0) endIdx = nextUserIdx;
  }
  const windowBots = uIdx >= 0 ? messages.slice(uIdx + 1, endIdx).filter((m) => m.role === 'bot') : [];
  const direct = reqMsgId ? messages.filter((m) => m.role === 'bot' && m.requestMessageId === reqMsgId) : [];
  if (!direct.length) return windowBots;

  const turnIds = new Set<string>();
  for (const m of direct) {
    if (m.turnId) turnIds.add(String(m.turnId));
    if (m.sentInTurn) turnIds.add(String(m.sentInTurn));
  }
  const seen = new Set<OmbMessage>(direct);
  for (const m of messages) {
    if (m.role !== 'bot' || seen.has(m)) continue;
    if (m.requestMessageId && reqMsgId && m.requestMessageId !== reqMsgId) continue;
    if ((m.sentInTurn && turnIds.has(String(m.sentInTurn))) || (m.turnId && turnIds.has(String(m.turnId)))) {
      seen.add(m);
    }
  }
  for (const m of windowBots) {
    if (seen.has(m) || m.requestMessageId) continue;
    if (m.kind === 'screen' || m.kind === 'burst' || m.kind === 'goal.run' || m.hasImage || (Array.isArray(m.attachments) && m.attachments.length > 0)) {
      seen.add(m);
    }
  }
  return messages.filter((m) => seen.has(m));
}

export interface TurnTrackerDeps {
  deliverBotReply: (args: {
    botId: string;
    botName: string;
    threadId: string;
    text: string;
    finalMsg?: OmbMessage;
    mediaMessages?: OmbMessage[];
    proactive?: boolean;
    isGroup?: boolean;
    speakerName?: string;
    turnStartedAt?: number;
    chatCtx?: CompactChatContext | BridgeChatContext | null;
  }) => Promise<void>;
  emitCard: (
    botId: string,
    botName: string,
    threadId: string,
    msg: OmbMessage,
    opts?: { isGroup?: boolean; chatCtx?: CompactChatContext | BridgeChatContext | null },
  ) => Promise<void>;
  forwardBotMedia: (
    threadId: string,
    msgs: OmbMessage[],
    opts?: { chatId?: string | null; replyTo?: string | null },
  ) => Promise<number>;
  maybeWarnHighContext: (
    botId: string,
    threadId: string,
    chatCtx?: CompactChatContext | BridgeChatContext | null,
  ) => Promise<void>;
}

export function createTurnTracker(
  bridge: OpenMausBotBridge,
  {
    key,
    botId,
    botName,
    threadId,
    reqMsgId,
    sendId,
    isGroup = false,
    chatCtx = null,
    startedAt: initStartedAt,
  }: {
    key: string;
    botId: string;
    botName: string;
    threadId: string;
    reqMsgId: string | null;
    sendId: string | null;
    isGroup?: boolean;
    chatCtx?: CompactChatContext | BridgeChatContext | null;
    startedAt?: number;
  },
  { deliverBotReply, emitCard, forwardBotMedia, maybeWarnHighContext }: TurnTrackerDeps,
): TurnTrackerHandle {
  const startedAt = Number(initStartedAt) > 0 ? Number(initStartedAt) : bridge.now();
  const ac = new AbortController();
  const isExternal = Boolean(chatCtx?.isExternal);
  const silentProgress = Boolean(chatCtx?.silentProgress);
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  let intermediateTimer: ReturnType<typeof setTimeout> | null = null;
  let stallTimer: ReturnType<typeof setInterval> | null = null;
  let resumedWatchAc: AbortController | null = null;
  let progressCount = 0;
  let intermediateBubbleCount = 0;
  let lastProgressAt = 0;
  let latestActivity = '';
  let lastSentActivity = '';
  let lastHumanTextAt = 0;
  let lastActivityAt = bridge.now();
  let stallNotified = false;
  let waitingForInput = false;
  let settled = false;
  let stoppedByUser = false;
  let completing = false;
  let emitChain: Promise<unknown> = Promise.resolve();
  const deliveredIntermediateIds = new Set<string>();
  const pendingIntermediates: OmbMessage[] = [];
  const heldIntermediates: OmbMessage[] = [];
  const compactCtx = compactChatCtx(chatCtx);

  if (bridge.inFlightTurns) {
    bridge.inFlightTurns.set(key, {
      key,
      botId,
      botName,
      threadId,
      reqMsgId: reqMsgId ?? null,
      sendId: sendId ?? null,
      isGroup: Boolean(isGroup),
      chatCtx: compactCtx,
      startedAt,
    });
    trimMapCap(bridge.inFlightTurns, 20);
    bridge.saveState({ immediate: true });
  }

  const touchActivity = (): void => {
    lastActivityAt = bridge.now();
    stallNotified = false;
  };

  const enqueueEmit = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = emitChain.then(fn, fn);
    emitChain = next.catch(() => {});
    return next;
  };

  const groupBySpeaker = (msgs: OmbMessage[]): Array<{ speakerName: string; msgs: OmbMessage[]; texts: string[] }> => {
    const buckets: Array<{ speakerName: string; msgs: OmbMessage[]; texts: string[] }> = [];
    for (const m of msgs) {
      const speakerName = isGroup ? (m.from?.name || '') : '';
      const text = String(m.text ?? '').trim();
      if (!text) continue;
      const prev = buckets.at(-1);
      if (prev && prev.speakerName === speakerName) {
        prev.msgs.push(m);
        prev.texts.push(text);
      } else {
        buckets.push({ speakerName, msgs: [m], texts: [text] });
      }
    }
    return buckets;
  };

  const flushIntermediates = ({ allowOverCap = false }: { allowOverCap?: boolean } = {}): void => {
    if (intermediateTimer) {
      clearTimeout(intermediateTimer);
      intermediateTimer = null;
    }
    const queued = allowOverCap
      ? [...heldIntermediates.splice(0), ...pendingIntermediates.splice(0)]
      : pendingIntermediates.splice(0);
    if (!queued.length) return;
    if (!allowOverCap && bridge.maxIntermediateBubbles > 0 && intermediateBubbleCount >= bridge.maxIntermediateBubbles) {
      heldIntermediates.push(...queued);
      return;
    }
    const buckets = groupBySpeaker(queued);
    if (!buckets.length) return;
    if (progressTimer) {
      clearTimeout(progressTimer);
      progressTimer = null;
    }
    for (const b of buckets) {
      if (!allowOverCap && bridge.maxIntermediateBubbles > 0 && intermediateBubbleCount >= bridge.maxIntermediateBubbles) {
        heldIntermediates.push(...b.msgs);
        continue;
      }
      intermediateBubbleCount += 1;
      for (const m of b.msgs) {
        if (m.id) {
          const sid = String(m.id);
          rememberBounded(bridge.deliveredOmbIds, sid);
          deliveredIntermediateIds.add(sid);
        }
      }
      const combined = b.texts.join('\n\n');
      enqueueEmit(() => deliverBotReply({
        botId,
        botName,
        threadId,
        text: combined,
        finalMsg: b.msgs.at(-1),
        mediaMessages: b.msgs,
        proactive: false,
        isGroup,
        speakerName: b.speakerName,
        turnStartedAt: startedAt,
        chatCtx,
      })).catch(() => {});
    }
  };

  const pushProgress = async (force = false): Promise<void> => {
    if (silentProgress) return;
    if (settled || !latestActivity || latestActivity === lastSentActivity || progressCount >= bridge.maxProgressUpdates) return;
    const now = bridge.now();
    if (!force && now - startedAt < bridge.progressDelayMs) return;
    if (lastProgressAt && now - lastProgressAt < bridge.progressIntervalMs) return;
    if (lastHumanTextAt && now - lastHumanTextAt < bridge.progressDelayMs) return;
    lastProgressAt = now;
    lastSentActivity = latestActivity;
    progressCount += 1;
    const elapsed = Math.max(1, Math.round((now - startedAt) / 1000));
    const who = bridge.botPrefix(botId, botName, { isGroup });
    const head = who ? `${who} ` : '';
    const targetChatId = chatCtx?.replyChatId || bridge.selfChat;
    await enqueueEmit(() => bridge.say(`${head}${latestActivity}（已 ${elapsed}秒）`, {
      botId, botName, threadId, ...(isGroup ? { isGroup: true } : {}), ...(targetChatId ? { targetChatId } : {}),
    }));
  };

  const scheduleProgress = (): void => {
    if (silentProgress) return;
    if (settled || progressTimer || progressCount >= bridge.maxProgressUpdates || bridge.progressDelayMs <= 0) return;
    if (!latestActivity || latestActivity === lastSentActivity) return;
    const now = bridge.now();
    const untilDelay = Math.max(0, startedAt + bridge.progressDelayMs - now);
    const untilInterval = lastProgressAt ? Math.max(0, lastProgressAt + bridge.progressIntervalMs - now) : 0;
    const untilHuman = lastHumanTextAt ? Math.max(0, lastHumanTextAt + bridge.progressDelayMs - now) : 0;
    const wait = Math.max(untilDelay, untilInterval, untilHuman);
    progressTimer = setTimeout(() => {
      progressTimer = null;
      pushProgress(true).catch(() => {});
    }, wait);
    progressTimer.unref?.();
  };

  const dispose = (): void => {
    ac.abort();
    resumedWatchAc?.abort();
    resumedWatchAc = null;
    if (progressTimer) {
      clearTimeout(progressTimer);
      progressTimer = null;
    }
    if (intermediateTimer) {
      clearTimeout(intermediateTimer);
      intermediateTimer = null;
    }
    if (stallTimer) {
      clearInterval(stallTimer);
      stallTimer = null;
    }
  };

  const markStopped = (): void => {
    stoppedByUser = true;
    settled = true;
    pendingIntermediates.length = 0;
    heldIntermediates.length = 0;
    dispose();
    bridge.activeTurns.delete(key);
    bridge.inFlightTurns?.delete(key);
    bridge.saveState();
  };

  const ensureStallWatchdog = (): void => {
    const threshold = Number(bridge.turnStallMs) || 0;
    if (!(threshold > 0) || stallTimer) return;
    const pollMs = Math.min(Math.max(40, Math.floor(threshold / 3)), 15_000);
    stallTimer = setInterval(() => {
      if (settled || ac.signal.aborted || waitingForInput || stallNotified) return;
      if ((bridge.now() - lastActivityAt) < threshold) return;
      stallNotified = true;
      const elapsedSec = Math.max(1, Math.round((bridge.now() - startedAt) / 1000));
      const ctrlChat = bridge.resolveControlChatId(chatCtx);
      const extLabel = chatCtx?.chatName || chatCtx?.originChatId || '';
      const ctrlBanner = isExternal && ctrlChat === bridge.selfChat
        ? `📍 **来自「${extLabel}」**\n`
        : '';
      const shownName = bridge.displayBotName(botId, botName, { isGroup });
      const cmdTarget = botCommandTarget(bridge, botId, botName, { isGroup });
      bridge.emitTelemetry?.('turn_stalled', {
        botName: shownName,
        chatId: ctrlChat || null,
        summary: `elapsed=${elapsedSec}s thread=${threadId}`,
      });
      enqueueEmit(() => bridge.say(
        `${ctrlBanner}⏳ **${shownName}** 已持续无新进展 ${elapsedSec} 秒（仍在后台运行），如需中断可回复 \`${cmdTarget} stop\`。`,
        { botId, botName, threadId, ...(isGroup ? { isGroup: true } : {}), ...(ctrlChat ? { targetChatId: ctrlChat } : {}) },
      )).catch(() => {});
    }, pollMs);
    stallTimer.unref?.();
  };

  const startWatcher = (afterInput = false): void => {
    ensureStallWatchdog();
    let watchAc: AbortController;
    if (afterInput) {
      resumedWatchAc?.abort();
      resumedWatchAc = new AbortController();
      watchAc = resumedWatchAc;
      ac.signal.addEventListener('abort', () => watchAc.abort(), { once: true });
    } else {
      watchAc = ac;
    }
    (async () => {
      let since: unknown;
      let version: unknown;
      let prevState: string | undefined;
      while (!settled && !watchAc.signal.aborted) {
        try {
          const job = await bridge.client.getJob(threadId, {
            scope: 'turn',
            since,
            wait: version === undefined ? 0 : 10_000,
            version,
            signal: watchAc.signal,
          });
          if (job?.version !== version || job?.state !== prevState) {
            touchActivity();
          }
          prevState = job?.state;
          since = job?.since;
          version = job?.version;
          waitingForInput = job?.state === 'needs-input';
          if (Array.isArray(job?.needsInput) && job.needsInput.length) {
            const res = await bridge.client.getMessages(threadId, 10);
            for (const m of res.messages ?? []) {
              if (messageNeedsInput(m)) await emitCard(botId, botName, threadId, m, { isGroup, chatCtx });
            }
          }
          if (job?.state === 'needs-input') {
            await new Promise((r) => setTimeout(r, 150));
            continue;
          }
          if (job?.state && FINAL_JOB_STATES.has(job.state) && job.state !== 'needs-input') {
            if (job.state === 'idle' && (bridge.now() - startedAt) < 2500) {
              const res = await bridge.client.getMessages(threadId, 10);
              const msgs = res.messages ?? [];
              const hasReply = msgs.some((m) => m.role === 'bot' && m.kind === 'text' && (!reqMsgId || m.requestMessageId === reqMsgId));
              if (!hasReply) {
                await new Promise((r) => setTimeout(r, 400));
                continue;
              }
            }
            await complete(job.state);
            return;
          }
          await new Promise((r) => setTimeout(r, 50));
        } catch (e) {
          const err = e as Error | null | undefined;
          if (settled || watchAc.signal.aborted || err?.name === 'AbortError') return;
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    })().catch(() => {});
  };

  const complete = async (jobState: string | null = null): Promise<void> => {
    if (settled || stoppedByUser || completing) return;
    completing = true;
    try {
      const ctrlChat = bridge.resolveControlChatId(chatCtx);
      const extLabel = chatCtx?.chatName || chatCtx?.originChatId || '';
      const ctrlBanner = isExternal && ctrlChat === bridge.selfChat
        ? `📍 **来自「${extLabel}」**\n`
        : '';

      let messages: OmbMessage[];
      try {
        const res = await bridge.client.getMessages(threadId, 25);
        messages = Array.isArray(res.messages) ? res.messages : [];
      } catch (e) {
        if (settled || stoppedByUser) return;
        settled = true;
        pendingIntermediates.length = 0;
        heldIntermediates.length = 0;
        dispose();
        bridge.activeTurns.delete(key);
        bridge.inFlightTurns?.delete(key);
        bridge.saveState();
        const shownName = bridge.displayBotName(botId, botName, { isGroup });
        await bridge.say(`${ctrlBanner}⚠️ 获取 **${shownName}** 回复失败：${formatOmbError(e)}`, ctrlChat ? { targetChatId: ctrlChat } : null);
        return;
      }

      if (settled || stoppedByUser) return;

      const matched = collectTurnMessages(messages, reqMsgId, sendId);

      const pendingMsg = matched.find((m) => messageNeedsInput(m));
      const earlyTexts = matched.filter((m) => m.kind === 'text');
      const hasEarlyContent = Boolean(
        pendingMsg
        || deliveredIntermediateIds.size > 0
        || pendingIntermediates.length > 0
        || heldIntermediates.length > 0
        || earlyTexts.some((m) => String(m.text ?? '').trim())
        || matched.some((m) => m.turnFailed || m.error || m.kind === 'screen' || m.kind === 'burst' || m.kind === 'goal.run' || m.hasImage || (Array.isArray(m.attachments) && m.attachments.length > 0)),
      );

      // `!evt.bot.busy` SSE 事件可能在新轮次尚未落库或上一轮尾波瞬间到达，避免过早判定空转
      if (!hasEarlyContent && jobState === null && (bridge.now() - startedAt) < 3000) {
        return;
      }

      const awaitsTurnResume = Boolean(
        pendingMsg
        && (pendingMsg.card || pendingMsg.secret || pendingMsg.connector || pendingMsg.signIn)
        && !matched.some((m) => m.kind === 'text' && m.turnTerminal),
      );
      if (pendingMsg && awaitsTurnResume) {
        waitingForInput = true;
        await emitChain.catch(() => {});
        if (stoppedByUser) return;
        await emitCard(botId, botName, threadId, pendingMsg, { isGroup, chatCtx });
        if (!settled && !stoppedByUser) {
          bridge.activeTurns.set(key, turn);
          startWatcher(true);
        }
        return;
      }

      settled = true;
      const droppedIntermediates = [...pendingIntermediates.splice(0), ...heldIntermediates.splice(0)];
      dispose();
      bridge.activeTurns.delete(key);
      bridge.inFlightTurns?.delete(key);
      bridge.saveState();

      await emitChain.catch(() => {});
      if (stoppedByUser) return;

      if (pendingMsg) {
        await emitCard(botId, botName, threadId, pendingMsg, { isGroup, chatCtx });
      }

      const seenInMatched = new Set(matched.map((m) => m?.id).filter((x): x is string => Boolean(x)).map(String));
      const missingIntermediates = droppedIntermediates.filter((m) => !m?.id || !seenInMatched.has(String(m.id)));
      const texts = matched.filter((m) => m.kind === 'text');
      const rawUndelivered = texts.filter((m) => {
        if (!m.id) return deliveredIntermediateIds.size === 0;
        const mid = String(m.id);
        return !deliveredIntermediateIds.has(mid) && !bridge.deliveredOmbIds.has(mid);
      });
      let undeliveredTexts = missingIntermediates.length
        ? [...missingIntermediates, ...rawUndelivered]
        : rawUndelivered;
      if (silentProgress) {
        const terminalOnly = undeliveredTexts.filter((m) => m.turnTerminal && String(m.text ?? '').trim());
        if (terminalOnly.length) undeliveredTexts = terminalOnly;
      }
      const hasAnyText = undeliveredTexts.some((m) => String(m.text ?? '').trim());

      if (!hasAnyText) {
        const terminalGoal = matched.findLast((m) => m.kind === 'goal.run' && m.goalRun?.status && m.goalRun.status !== 'working');
        if (terminalGoal) {
          const goalBody = String(terminalGoal.text || terminalGoal.goalRun?.detail || '').trim();
          if (goalBody && deliveredIntermediateIds.size === 0 && (!terminalGoal.id || !bridge.deliveredOmbIds.has(String(terminalGoal.id)))) {
            if (terminalGoal.id) rememberBounded(bridge.deliveredOmbIds, terminalGoal.id);
            await deliverBotReply({
              botId,
              botName,
              threadId,
              text: goalBody,
              finalMsg: terminalGoal,
              mediaMessages: matched,
              proactive: false,
              isGroup,
              speakerName: isGroup ? (terminalGoal.from?.name || '') : '',
              turnStartedAt: startedAt,
              chatCtx,
            });
            await maybeWarnHighContext(botId, threadId, chatCtx);
            return;
          }
        }
        if (deliveredIntermediateIds.size > 0) {
          if (!isExternal && startedAt >= bridge.lastByeAt) bridge.lastBotReplyAt = bridge.now();
          bridge.saveState();
          await forwardBotMedia(threadId, matched, { chatId: chatCtx?.replyChatId || bridge.selfChat });
          if (!isGroup) await maybeWarnHighContext(botId, threadId, chatCtx);
          return;
        }
        const failed = matched.find((m) => m.turnFailed || m.error);
        if (failed) {
          const who = bridge.botPrefix(botId, botName, {
            isGroup,
            speakerName: isGroup ? (failed.from?.name || '') : '',
            speakerBotId: isGroup ? (failed.from?.botId || null) : null,
          });
          await bridge.say(`${ctrlBanner}${who ? `${who} ` : ''}❌ ${failed.error || '本轮执行失败'}`, {
            botId, botName, threadId, ...(isGroup ? { isGroup: true } : {}), ...(ctrlChat ? { targetChatId: ctrlChat } : {}),
          });
        } else {
          const forwardedMedia = await forwardBotMedia(threadId, matched, { chatId: chatCtx?.replyChatId || bridge.selfChat });
          const hasMediaMsg = matched.some((m) => m.kind === 'screen' || m.hasImage || (Array.isArray(m.attachments) && m.attachments.length > 0));
          const hasBurstCard = matched.some((m) => m.kind === 'burst');
          if (!forwardedMedia && !hasMediaMsg && !hasBurstCard && !stoppedByUser) {
            const listed = typeof bridge.client.listBots === 'function' ? await bridge.client.listBots().catch(() => null) : null;
            const curBot = (listed?.bots ?? []).find((b) => b.id === botId);
            const isDead = curBot?.activity === 'dead';
            const shownName = bridge.displayBotName(botId, botName, { isGroup });
            bridge.emitTelemetry?.('turn_failed', {
              botName: shownName,
              chatId: ctrlChat || null,
              summary: isDead ? 'bot_dead' : `empty_turn:${jobState || 'unknown'}`,
            });
            let reasonMsg = `${ctrlBanner}❌ **${shownName}** 本轮未返回有效回复（引擎空闲退出），请检查引擎状态或重试。`;
            if (isDead) {
              reasonMsg = `${ctrlBanner}❌ **${shownName}** 当前处于异常/停止状态（dead），未能完成本轮回复，请检查或重启 OpenMausBot 引擎。`;
            } else if (jobState && jobState !== 'idle') {
              reasonMsg = `${ctrlBanner}❌ **${shownName}** 本轮未返回有效回复（任务状态：\`${jobState}\`），请稍后重试。`;
            }
            await bridge.say(reasonMsg, {
              botId,
              botName,
              threadId,
              ...(isGroup ? { isGroup: true } : {}),
              ...(ctrlChat ? { targetChatId: ctrlChat } : {}),
            });
          }
        }
        return;
      }

      for (const m of undeliveredTexts) {
        if (m.id) rememberBounded(bridge.deliveredOmbIds, m.id);
      }
      if (isGroup) {
        const buckets = groupBySpeaker(undeliveredTexts);
        for (const b of buckets) {
          await deliverBotReply({
            botId,
            botName,
            threadId,
            text: b.texts.join('\n\n'),
            finalMsg: b.msgs.at(-1),
            mediaMessages: b.msgs,
            proactive: false,
            isGroup: true,
            speakerName: b.speakerName,
            turnStartedAt: startedAt,
            chatCtx,
          });
        }
        await forwardBotMedia(threadId, matched, { chatId: chatCtx?.replyChatId || bridge.selfChat });
        return;
      }

      const combined = undeliveredTexts.map((m) => String(m.text ?? '').trim()).filter(Boolean).join('\n\n');
      await deliverBotReply({
        botId,
        botName,
        threadId,
        text: combined,
        finalMsg: undeliveredTexts.at(-1) ?? texts.at(-1),
        mediaMessages: matched,
        proactive: false,
        turnStartedAt: startedAt,
        chatCtx,
      });
      await maybeWarnHighContext(botId, threadId, chatCtx);
    } finally {
      completing = false;
    }
  };

  const turn: TurnTrackerHandle = {
    key,
    botId,
    botName,
    threadId,
    reqMsgId,
    sendId,
    isGroup,
    chatCtx: compactCtx,
    sawBusy: false,
    onMessage: (msg: OmbMessage) => {
      if (settled || !msg || msg.role !== 'bot') return;
      if (msg.requestMessageId && reqMsgId && msg.requestMessageId !== reqMsgId) return;
      touchActivity();
      waitingForInput = false;
      if (msg.kind === 'digest') return;
      if (msg.kind === 'activity') {
        latestActivity = formatActivity(msg);
        scheduleProgress();
        return;
      }
      if (msg.kind === 'goal.run') {
        if (!msg.goalRun?.status || msg.goalRun.status === 'working') {
          latestActivity = formatGoalProgress(msg);
          scheduleProgress();
          return;
        }
        complete().catch(() => {});
        return;
      }
      if (messageNeedsInput(msg)) {
        flushIntermediates({ allowOverCap: true });
        enqueueEmit(() => emitCard(botId, botName, threadId, msg, { isGroup, chatCtx })).catch(() => {});
        return;
      }
      if (msg.kind === 'text' && !msg.turnTerminal) {
        const trimmed = String(msg.text ?? '').trim();
        const mid = msg.id ? String(msg.id) : null;
        if (!trimmed || (mid && (bridge.deliveredOmbIds.has(mid) || deliveredIntermediateIds.has(mid)))) return;
        if (pendingIntermediates.some((m) => mid && String(m.id) === mid) || heldIntermediates.some((m) => mid && String(m.id) === mid)) return;
        lastHumanTextAt = bridge.now();
        if (progressTimer) {
          clearTimeout(progressTimer);
          progressTimer = null;
        }
        if (silentProgress || (bridge.maxIntermediateBubbles > 0 && intermediateBubbleCount >= bridge.maxIntermediateBubbles)) {
          heldIntermediates.push(msg);
          return;
        }
        pendingIntermediates.push(msg);
        const delayMs = Number(bridge.intermediateCoalesceMs) || 0;
        if (delayMs <= 0) {
          flushIntermediates();
        } else if (!intermediateTimer) {
          intermediateTimer = setTimeout(() => {
            intermediateTimer = null;
            if (!settled) flushIntermediates();
          }, delayMs);
          intermediateTimer.unref?.();
        }
        return;
      }
      if (msg.kind === 'text' && msg.turnTerminal) {
        if (isGroup) {
          const trimmed = String(msg.text ?? '').trim();
          const mid = msg.id ? String(msg.id) : null;
          if (!trimmed || (mid && (bridge.deliveredOmbIds.has(mid) || deliveredIntermediateIds.has(mid)))) return;
          const speakerName = msg.from?.name || '';
          const sameSpeakerParts: string[] = [];
          const sameSpeakerMsgs: OmbMessage[] = [];
          const restPending: OmbMessage[] = [];
          for (const m of pendingIntermediates.splice(0)) {
            if ((m.from?.name || '') === speakerName) {
              sameSpeakerParts.push(String(m.text ?? '').trim());
              sameSpeakerMsgs.push(m);
            } else {
              restPending.push(m);
            }
          }
          if (restPending.length) {
            pendingIntermediates.push(...restPending);
            flushIntermediates({ allowOverCap: true });
          } else if (intermediateTimer) {
            clearTimeout(intermediateTimer);
            intermediateTimer = null;
          }
          for (let i = heldIntermediates.length - 1; i >= 0; i--) {
            if ((heldIntermediates[i].from?.name || '') === speakerName) {
              const [hm] = heldIntermediates.splice(i, 1);
              sameSpeakerParts.unshift(String(hm.text ?? '').trim());
              sameSpeakerMsgs.unshift(hm);
            }
          }
          for (const m of [...sameSpeakerMsgs, msg]) {
            if (m.id) {
              const sid = String(m.id);
              rememberBounded(bridge.deliveredOmbIds, sid);
              deliveredIntermediateIds.add(sid);
            }
          }
          sameSpeakerParts.push(trimmed);
          lastHumanTextAt = bridge.now();
          if (progressTimer) {
            clearTimeout(progressTimer);
            progressTimer = null;
          }
          enqueueEmit(() => deliverBotReply({
            botId,
            botName,
            threadId,
            text: sameSpeakerParts.filter(Boolean).join('\n\n'),
            finalMsg: msg,
            mediaMessages: [...sameSpeakerMsgs, msg],
            proactive: false,
            isGroup: true,
            speakerName,
            turnStartedAt: startedAt,
            chatCtx,
          })).catch(() => {});
          return;
        }
        complete().catch(() => {});
      }
    },
    complete,
    dispose,
    markStopped,
    startWatcher,
  };

  bridge.activeTurns.set(key, turn);
  return turn;
}
