/**
 * OpenMausBot 单轮执行追踪器：监听 SSE 消息与 /job 轮询，合并中间气泡、推送去噪进度并在轮次完成时收口交付。
 */
import { formatActivity, formatOmbError } from './cards.js';
import { messageNeedsInput } from './client.js';
import { compactChatCtx, rememberBounded } from './mentions.js';

const FINAL_JOB_STATES = new Set(['completed', 'idle', 'failed', 'stalled']);

export function createTurnTracker(
  bridge,
  { key, botId, botName, threadId, reqMsgId, sendId, isGroup = false, chatCtx = null, startedAt: initStartedAt },
  { deliverBotReply, emitCard, forwardBotMedia, maybeWarnHighContext },
) {
  const startedAt = Number(initStartedAt) > 0 ? Number(initStartedAt) : bridge.now();
  const ac = new AbortController();
  const isExternal = Boolean(chatCtx?.isExternal);
  const silentProgress = Boolean(chatCtx?.silentProgress);
  let progressTimer = null;
  let intermediateTimer = null;
  let stallTimer = null;
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
  let emitChain = Promise.resolve();
  const deliveredIntermediateIds = new Set();
  const pendingIntermediates = [];
  const heldIntermediates = [];

  if (bridge.inFlightTurns) {
    bridge.inFlightTurns.set(key, {
      key,
      botId,
      botName,
      threadId,
      reqMsgId: reqMsgId ?? null,
      sendId: sendId ?? null,
      isGroup: Boolean(isGroup),
      chatCtx: compactChatCtx(chatCtx),
      startedAt,
    });
    if (bridge.inFlightTurns.size > 20) bridge.inFlightTurns.delete(bridge.inFlightTurns.keys().next().value);
    bridge.saveState({ immediate: true });
  }

  const touchActivity = () => {
    lastActivityAt = bridge.now();
    stallNotified = false;
  };

  const enqueueEmit = (fn) => {
    emitChain = emitChain.then(fn, fn);
    return emitChain;
  };

  const groupBySpeaker = (msgs) => {
    const buckets = [];
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

  const flushIntermediates = ({ allowOverCap = false } = {}) => {
    clearTimeout(intermediateTimer);
    intermediateTimer = null;
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
    clearTimeout(progressTimer);
    progressTimer = null;
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
        chatCtx,
      })).catch(() => {});
    }
  };

  const pushProgress = async (force = false) => {
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
    await enqueueEmit(() => bridge.say(`${head}${latestActivity}（已 ${elapsed}秒）`, {
      botId, botName, threadId, ...(isGroup ? { isGroup: true } : {}),
    }));
  };

  const scheduleProgress = () => {
    if (silentProgress) return;
    if (settled || progressTimer || progressCount >= bridge.maxProgressUpdates || bridge.progressDelayMs <= 0) return;
    if (!latestActivity || latestActivity === lastSentActivity) return;
    const now = bridge.now();
    const untilDelay = Math.max(0, startedAt + bridge.progressDelayMs - now);
    const untilInterval = lastProgressAt ? Math.max(0, lastProgressAt + bridge.progressIntervalMs - now) : 0;
    const wait = Math.max(untilDelay, untilInterval);
    progressTimer = setTimeout(() => {
      progressTimer = null;
      pushProgress(true).catch(() => {});
    }, wait);
    progressTimer.unref?.();
  };

  const dispose = () => {
    ac.abort();
    clearTimeout(progressTimer);
    progressTimer = null;
    clearTimeout(intermediateTimer);
    intermediateTimer = null;
    clearInterval(stallTimer);
    stallTimer = null;
  };

  const ensureStallWatchdog = () => {
    const threshold = Number(bridge.turnStallMs) || 0;
    if (!(threshold > 0) || stallTimer) return;
    const pollMs = Math.min(Math.max(40, Math.floor(threshold / 3)), 15_000);
    stallTimer = setInterval(() => {
      if (settled || ac.signal.aborted || waitingForInput || stallNotified) return;
      if ((bridge.now() - lastActivityAt) < threshold) return;
      stallNotified = true;
      const elapsedSec = Math.max(1, Math.round((bridge.now() - startedAt) / 1000));
      const ctrlChat = bridge.resolveControlChatId(chatCtx);
      const ctrlBanner = isExternal && ctrlChat === bridge.selfChat
        ? `📍 **来自「${chatCtx.chatName || chatCtx.originChatId}」**\n`
        : '';
      const cmdTarget = isGroup || (bridge.chiefBotId && botId !== bridge.chiefBotId) ? `@${botName}` : bridge.trigger;
      bridge.emitTelemetry?.('turn_stalled', {
        botName,
        chatId: ctrlChat || null,
        summary: `elapsed=${elapsedSec}s thread=${threadId}`,
      });
      enqueueEmit(() => bridge.say(
        `${ctrlBanner}⏳ **${botName}** 已持续无新进展 ${elapsedSec} 秒（仍在后台运行），如需中断可回复 \`${cmdTarget} stop\`。`,
        { botId, botName, threadId, ...(isGroup ? { isGroup: true } : {}), ...(ctrlChat ? { targetChatId: ctrlChat } : {}) },
        null,
        [{ label: '停止任务', text: `${cmdTarget} stop`, kind: 'danger' }],
      )).catch(() => {});
    }, pollMs);
    stallTimer.unref?.();
  };

  const startWatcher = (afterInput = false) => {
    ensureStallWatchdog();
    const watchAc = afterInput ? new AbortController() : ac;
    if (afterInput) ac.signal.addEventListener('abort', () => watchAc.abort(), { once: true });
    (async () => {
      let since;
      let version;
      let prevState;
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
          if (FINAL_JOB_STATES.has(job?.state) && job.state !== 'needs-input') {
            if (job.state === 'idle' && (bridge.now() - startedAt) < 2500) {
              const res = await bridge.client.getMessages(threadId, 10);
              const msgs = res.messages ?? [];
              const hasReply = msgs.some((m) => m.role === 'bot' && m.kind === 'text' && (!reqMsgId || m.requestMessageId === reqMsgId));
              if (!hasReply) {
                await new Promise((r) => setTimeout(r, 400));
                continue;
              }
            }
            await complete();
            return;
          }
          await new Promise((r) => setTimeout(r, 50));
        } catch (e) {
          if (settled || watchAc.signal.aborted || e?.name === 'AbortError') return;
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    })().catch(() => {});
  };

  const complete = async () => {
    if (settled) return;
    settled = true;
    const droppedIntermediates = [...pendingIntermediates.splice(0), ...heldIntermediates.splice(0)];
    dispose();
    bridge.activeTurns.delete(key);
    bridge.inFlightTurns?.delete(key);
    bridge.saveState();

    await emitChain.catch(() => {});

    const ctrlChat = bridge.resolveControlChatId(chatCtx);
    const ctrlBanner = isExternal && ctrlChat === bridge.selfChat
      ? `📍 **来自「${chatCtx.chatName || chatCtx.originChatId}」**\n`
      : '';

    let messages = [];
    try {
      const res = await bridge.client.getMessages(threadId, 25);
      messages = Array.isArray(res.messages) ? res.messages : [];
    } catch (e) {
      await bridge.say(`${ctrlBanner}⚠️ 获取 **${botName}** 回复失败：${formatOmbError(e)}`, ctrlChat ? { targetChatId: ctrlChat } : null);
      return;
    }

    let matched = reqMsgId
      ? messages.filter((m) => m.role === 'bot' && m.requestMessageId === reqMsgId)
      : [];
    if (!matched.length) {
      const uIdx = messages.findLastIndex((m) => m.role === 'user' && (m.id === reqMsgId || m.sendId === sendId));
      if (uIdx >= 0) matched = messages.slice(uIdx + 1).filter((m) => m.role === 'bot');
    }

    const pendingMsg = matched.find((m) => messageNeedsInput(m));
    if (pendingMsg) {
      await emitCard(botId, botName, threadId, pendingMsg, { isGroup, chatCtx });
      if (!matched.some((m) => m.kind === 'text' && m.turnTerminal)) {
        settled = false;
        bridge.activeTurns.set(key, turn);
        startWatcher(true);
        return;
      }
    }

    const seenInMatched = new Set(matched.map((m) => m?.id).filter(Boolean).map(String));
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
      if (deliveredIntermediateIds.size > 0) {
        if (!isExternal) bridge.lastBotReplyAt = bridge.now();
        bridge.saveState();
        await forwardBotMedia(threadId, matched, { chatId: chatCtx?.replyChatId || bridge.selfChat });
        if (!isGroup) await maybeWarnHighContext(botId, threadId, chatCtx);
        return;
      }
      const failed = matched.find((m) => m.turnFailed || m.error);
      if (failed) {
        const who = bridge.botPrefix(botId, botName, { isGroup, speakerName: isGroup ? (failed.from?.name || '') : '' });
        await bridge.say(`${ctrlBanner}❌ ${who ? `${who} ` : ''}${failed.error || '本轮执行失败'}`, {
          botId, botName, threadId, ...(isGroup ? { isGroup: true } : {}), ...(ctrlChat ? { targetChatId: ctrlChat } : {}),
        });
      } else {
        await forwardBotMedia(threadId, matched, { chatId: chatCtx?.replyChatId || bridge.selfChat });
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
      chatCtx,
    });
    await maybeWarnHighContext(botId, threadId, chatCtx);
  };

  const turn = {
    key,
    botId,
    botName,
    threadId,
    reqMsgId,
    sendId,
    isGroup,
    chatCtx,
    sawBusy: false,
    onMessage: (msg) => {
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
        clearTimeout(progressTimer);
        progressTimer = null;
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
          const sameSpeakerParts = [];
          const sameSpeakerMsgs = [];
          const restPending = [];
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
          } else {
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
          clearTimeout(progressTimer);
          progressTimer = null;
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
            chatCtx,
          })).catch(() => {});
          return;
        }
        complete().catch(() => {});
      }
    },
    complete,
    dispose,
    startWatcher,
  };

  bridge.activeTurns.set(key, turn);
  return turn;
}
