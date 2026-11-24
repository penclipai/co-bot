import crypto from 'node:crypto';
import { formatLinkCardSnippet } from '../core/channel-contract.js';
import { assemblePromptContext } from '../core/chat-context.js';
import { formatReadonlyGuardBlock } from '../core/inbound-policy.js';
import { formatProjectContextBlock, resolveProjectBinding } from '../core/projects.js';
import { clip } from '../format.js';
import { formatOmbError } from './cards.js';
import { formatAttachmentTag, messageNeedsInput } from './client.js';
import { botCommandTarget } from './command-helpers.js';
import { claimUploads, deliverBotReply, emitCard, forwardBotMedia } from './delivery.js';
import { buildExternalChatCtx } from './inbound-router.js';
import { compactChatCtx, inQuietHours, rememberBounded } from './mentions.js';

function pickQueuedEntry(bridge, preferredThreadId) {
  if (preferredThreadId && bridge.queuedByThread.get(preferredThreadId)?.length) {
    return { threadId: preferredThreadId, list: bridge.queuedByThread.get(preferredThreadId) };
  }
  for (const [tid, list] of bridge.queuedByThread) {
    if (list.length) return { threadId: tid, list };
  }
  return null;
}

function removeQueued(bridge, threadId, queueId) {
  const list = bridge.queuedByThread.get(threadId);
  if (!list) return null;
  const idx = list.findIndex((q) => q.queueId === queueId);
  if (idx < 0) return null;
  const [removed] = list.splice(idx, 1);
  if (!list.length) bridge.queuedByThread.delete(threadId);
  return removed;
}

async function buildPromptContext(bridge, ev, chatCtx, { skipSelfQuote = false } = {}) {
  if (!ev?.chat?.id) return { header: '', quotedMsg: null, recentMsgs: [], quotedAttachments: [], contextAttachments: [] };
  const common = {
    ev,
    privateReply: Boolean(chatCtx?.privateReply),
    contextWindow: bridge.chats.contextWindow,
    injectRecent: bridge.chats.injectRecentContext !== false,
    maxQuotedChars: bridge.chats.maxQuotedSnippetChars,
    maxRecentChars: bridge.chats.maxRecentMessageChars,
    skipSelfQuote,
    recentAttachmentWindowMs: bridge.chats.recentAttachmentWindowMs,
    maxAutoAttachments: bridge.chats.maxAutoAttachments,
  };
  if (bridge.imContext) return bridge.imContext.buildPromptContext(common);
  return assemblePromptContext({
    ...common,
    store: bridge.localContextStore,
    resolveMessage: async (cid, msgId) => {
      const cached = bridge.localContextStore.getMessage(cid, msgId);
      if (cached) return cached;
      if (typeof bridge.transport?.getMessage === 'function') {
        try {
          const remote = await bridge.transport.getMessage(cid, msgId);
          if (remote) return bridge.localContextStore.recordInbound(remote);
        } catch { /* ignore */ }
      }
      return null;
    },
    getHistory: async (cid, { limit, excludeMsgId } = {}) => bridge.localContextStore.getRecent(cid, { limit, excludeMsgId }),
  });
}

async function handleProactiveMessage(bridge, threadId, msg) {
  if (!msg || msg.role !== 'bot' || bridge.proactive === false) return;
  if (msg.kind === 'digest' || msg.kind === 'activity') return;
  if (msg.id && bridge.deliveredOmbIds.has(String(msg.id))) return;
  if (msg.requestMessageId && bridge.ownReqIds.has(String(msg.requestMessageId))) return;
  if (bridge.pendingThreads.has(threadId)) return;

  const owner = await bridge.resolveOwnerByThread(threadId);
  const botId = owner?.id ?? threadId;
  const isGroup = Boolean(owner?.isGroup);
  const botName = bridge.displayBotName(botId, owner?.name, { isGroup });
  const speakerName = isGroup ? (msg.from?.name || '') : '';
  const speakerBotId = isGroup ? (msg.from?.botId || null) : null;
  const extChat = [...bridge.chatThreads.values()].find((v) => v.threadId === threadId) ?? null;
  const proChatCtx = extChat
    ? {
        isExternal: true,
        originChatId: extChat.chatId,
        chatType: extChat.chatType,
        chatName: extChat.chatName,
        replyChatId: bridge.selfChat || extChat.chatId,
        controlChatId: bridge.selfChat || extChat.chatId,
        privateReply: Boolean(bridge.selfChat),
        silentProgress: true,
      }
    : null;

  if (messageNeedsInput(msg)) {
    await emitCard(bridge, botId, botName, threadId, msg, { isGroup, chatCtx: proChatCtx });
    return;
  }

  if (msg.kind === 'screen' && msg.hasImage) {
    rememberBounded(bridge.deliveredOmbIds, msg.id);
    bridge.saveState();
    if (extChat) return; // 外部会话后台异常或重试产生的无文字截图不再误发自聊
    await forwardBotMedia(bridge, threadId, [msg], { chatId: proChatCtx?.replyChatId || bridge.selfChat });
    return;
  }

  if (msg.kind === 'text' && msg.turnTerminal) {
    const text = String(msg.text ?? '').trim();
    if (!text && !msg.hasImage && !(msg.attachments?.length)) return;
    rememberBounded(bridge.deliveredOmbIds, msg.id);
    if (inQuietHours(bridge.now(), bridge.quietHours)) {
      bridge.quietQueue.push({ botId, botName, threadId, isGroup, speakerName, speakerBotId, text: text || '（附件通知）', finalMsg: msg });
      bridge.saveState();
      return;
    }
    await deliverBotReply(bridge, {
      botId,
      botName,
      threadId,
      text: text || '（附件通知）',
      finalMsg: msg,
      mediaMessages: [msg],
      proactive: true,
      isGroup,
      speakerName,
      chatCtx: proChatCtx,
    });
  }
}

function claimQueuedUserMessage(bridge, threadId, msg) {
  const list = bridge.queuedByThread.get(threadId);
  let hit = null;
  if (list?.length) {
    const idx = list.findIndex((q) => (msg.sendId && q.sendId === msg.sendId) || (msg.queueId && q.queueId === msg.queueId));
    if (idx >= 0) {
      [hit] = list.splice(idx, 1);
      if (!list.length) bridge.queuedByThread.delete(threadId);
    }
  }
  if (!hit && msg.sendId && bridge.steeredQueue.has(msg.sendId)) {
    hit = bridge.steeredQueue.get(msg.sendId);
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

async function trySteerQueueItem(bridge, { botId, botName, threadId, isGroup, queueId, text, sendId, chatCtx }, { targetChatId, banner = '', onQueuedText } = {}) {
  const outChatId = targetChatId || chatCtx?.controlChatId || bridge.selfChat;
  const route = {
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
      const msg = typeof onQueuedText === 'function'
        ? onQueuedText(res)
        : `${banner}⏳ 当前工具执行暂不支持直接插队${res.blockedBy ? `（${res.blockedBy}）` : ''}，已保留在队列等待上一轮完成。`;
      const cmdTarget = botCommandTarget(bridge, botId, botName, { isGroup });
      await bridge.say(msg, route, null, typeof onQueuedText === 'function'
        ? [
            { label: '立即插队', text: `${cmdTarget} steer`, kind: 'primary' },
            { label: '取消排队', text: `${cmdTarget} cancel`, kind: 'danger' },
          ]
        : null);
      return { steered: false, res };
    }
    bridge.steeredQueue.set(sendId, { queueId, botId, botName, threadId, isGroup, text, sendId, chatCtx });
    if (bridge.steeredQueue.size > 50) bridge.steeredQueue.delete(bridge.steeredQueue.keys().next().value);
    await bridge.say(`${banner}⚡ 已插队注入当前任务：「${clip(text, 50)}」`, route);
    return { steered: true, res };
  } catch (e) {
    await bridge.say(`${banner}❌ 插队失败：${formatOmbError(e)}`, outChatId ? { targetChatId: outChatId } : null);
    return { steered: false, error: e };
  }
}

/** 取消并清空指定 Thread 中尚未执行的全部排队消息（例如 @bot stop 时调用）。 */
export async function cancelThreadQueue(bridge, threadId) {
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
export async function steerLatestQueue(bridge, preferredThreadId, targetChatId = null, { banner = '' } = {}) {
  const hit = pickQueuedEntry(bridge, preferredThreadId);
  if (!hit) {
    await bridge.say(`${banner}当前没有排队中的消息。`, targetChatId ? { targetChatId } : null);
    return;
  }
  const q = hit.list.at(-1);
  const res = await trySteerQueueItem(bridge, q, { targetChatId, banner });
  if (res.steered) removeQueued(bridge, q.threadId, q.queueId);
}

/** 对运行中的任务追加补充插队指令（@bot steer <补充要求>）。 */
export async function dispatchSteerSupplement(bridge, target, text, imMsgId, quotedId, chatCtx = null, { banner = '', cmdTarget = bridge.trigger } = {}) {
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
  return dispatchToBot(bridge, target, text, imMsgId, quotedId, null, {
    ...(chatCtx || {}),
    autoSteer: true,
    steerBanner: banner,
  });
}

/** 取消最近一条排队等待的消息。 */
export async function cancelLatestQueue(bridge, preferredThreadId, targetChatId = null, { banner = '' } = {}) {
  const hit = pickQueuedEntry(bridge, preferredThreadId);
  if (!hit) {
    await bridge.say(`${banner}当前没有排队中的消息。`, targetChatId ? { targetChatId } : null);
    return;
  }
  const q = hit.list.at(-1);
  const outChatId = targetChatId || q.chatCtx?.controlChatId || bridge.selfChat;
  const route = {
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
    await bridge.say(`${banner}❌ 取消排队失败：${formatOmbError(e)}`, outChatId ? { targetChatId: outChatId } : null);
  }
}

/** 获取目标 Bot 或群聊最近 5 条任务列表。 */
export async function collectBotTasks(bridge, target) {
  const { bots = [], groups = [] } = await bridge.client.listBots();
  const isGroup = Boolean(target.isGroup);
  const fresh = (isGroup ? groups.find((g) => g.id === target.id) : bots.find((b) => b.id === target.id)) ?? target;
  const list = Array.isArray(fresh.tasks) ? [...fresh.tasks] : [];
  list.sort((a, b) => (b.updatedAt ?? b.lastThreadOrderAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.lastThreadOrderAt ?? a.createdAt ?? 0));
  const top = list.slice(0, 5);
  return { fresh, top };
}

/** 将焦点切换到选定的历史或新建任务 Thread。 */
export async function switchTask(bridge, defaultBotId, defaultBotName, task, { isGroup = false, chatId = null, isExternal = false, originChatId = null, banner = '' } = {}) {
  const botId = task.botId ?? defaultBotId;
  const botName = task.botName ?? defaultBotName;
  const tid = task.threadId ?? task.id;
  bridge.clearPickers();
  const route = { botId, botName, threadId: tid, ...(isGroup ? { isGroup: true } : {}), ...(chatId ? { targetChatId: chatId } : {}) };
  try {
    if (isExternal && originChatId) {
      bridge.setChatThread(originChatId, { id: botId, name: botName, threadId: tid, isGroup });
    } else {
      if (isGroup && typeof bridge.client.selectGroupTask === 'function') {
        await bridge.client.selectGroupTask(botId, tid);
        bridge.groupByThread.set(tid, { id: botId, name: botName, threadId: tid, isGroup: true });
      } else {
        await bridge.client.selectTask(botId, tid);
        bridge.botByThread.set(tid, { id: botId, name: botName, threadId: tid });
      }
      bridge.focus = { botId, botName, threadId: tid, ...(isGroup ? { isGroup: true } : {}) };
      bridge.setSelfThread({ id: botId, name: botName, threadId: tid, isGroup });
      bridge.lastBotReplyAt = bridge.now();
      bridge.saveState();
    }
    const title = clip(task.title || '未命名会话', 50);
    const shownName = bridge.displayBotName(botId, botName, { isGroup });
    const hint = isExternal ? `已在当前会话切换 **${shownName}** 上下文` : `已切换到 **${shownName}** 的会话`;
    await bridge.say(`${banner}🔀 ${hint}「${title}」${isExternal ? '。' : '，直接发消息即可续聊。'}`, route);
  } catch (e) {
    await bridge.say(`${banner}❌ 切换会话失败：${formatOmbError(e)}`, chatId ? { targetChatId: chatId } : null);
  }
}

/** 将拼装好上下文、项目边界与附件的用户消息派发给 OpenMausBot 并启动轮次追踪。 */
export async function dispatchToBot(bridge, bot, text, imMsgId, quotedId, replyToOmbId, chatCtx = null) {
  const ctxInfo = chatCtx ?? buildExternalChatCtx(bridge, {
    isSelfChat: true,
    chatId: bridge.selfChat,
    chatType: 'self',
    mid: null,
    privateReply: false,
    ev: null,
  });
  const isExternal = Boolean(ctxInfo.isExternal);
  const isGroup = Boolean(bot.isGroup);
  let threadId = bot.threadId;

  const promptCtx = ctxInfo.preformattedHeader !== undefined
    ? { header: ctxInfo.preformattedHeader, quotedMsg: null, recentMsgs: [], quotedAttachments: [], contextAttachments: [] }
    : await buildPromptContext(bridge, ctxInfo.ev, ctxInfo, {
        skipSelfQuote: Boolean(!isExternal && replyToOmbId),
      });
  const { uploads, transcripts } = await claimUploads(
    bridge,
    imMsgId,
    quotedId,
    ctxInfo.originChatId,
    promptCtx.contextAttachments ?? promptCtx.quotedAttachments,
    ctxInfo.controlChatId,
  );
  const extras = [];
  const linkSnippet = formatLinkCardSnippet(ctxInfo.ev?.linkCard);
  if (linkSnippet) extras.push(linkSnippet);
  if (transcripts.length) {
    for (const tr of transcripts) {
      const dur = tr.durationSec ? `（${tr.durationSec}秒）` : '';
      extras.push(`[语音转写 · ${tr.name}${dur}] ${tr.text}`);
    }
  }
  const skipScope = ctxInfo.preformattedHeader !== undefined;
  if (!skipScope) bridge.sharedContext.triggerRefresh();
  const projectAsk = ctxInfo.explicitProject ? `${ctxInfo.explicitProject} ${text}` : text;
  const { project, source } = skipScope
    ? { project: null, source: 'none' }
    : resolveProjectBinding({
        text: projectAsk,
        chatId: ctxInfo.originChatId || bridge.selfChat,
        chatProjects: bridge.chatProjects,
        projects: bridge.projects,
        allowedProjects: ctxInfo.allowedProjects ?? null,
      });
  const guardBlock = ctxInfo.readonly
    ? formatReadonlyGuardBlock({ collaborator: ctxInfo.collaborator, allowedProjects: ctxInfo.allowedProjects })
    : '';
  const projectBlock = skipScope
    ? ''
    : formatProjectContextBlock({ project, source, isExternal, isReadonly: Boolean(ctxInfo.readonly) });
  const sharedBlock = skipScope ? '' : bridge.sharedContext.formatPromptPointer();
  let outboundText = `${guardBlock}${projectBlock}${sharedBlock}${promptCtx.header || ''}${extras.length ? `${extras.join('\n')}\n\n` : ''}${text}`;
  if (uploads.length) {
    const tags = uploads.map((u) => formatAttachmentTag(u));
    outboundText = `${outboundText}\n\n${tags.join('\n')}`;
  }

  const sendId = `cobot_${crypto.randomUUID().replace(/-/g, '')}`;
  const shownName = bridge.displayBotName(bot.id, bot.name, { isGroup });
  if (!isExternal) {
    bridge.focus = { botId: bot.id, botName: bot.name, threadId, ...(isGroup ? { isGroup: true } : {}) };
    bridge.setSelfThread({ ...bot, threadId });
    bridge.saveState();
  }
  await bridge.refreshMultiBot();
  bridge.emitTelemetry('dispatch', {
    botName: shownName,
    isGroup,
    chatId: ctxInfo.originChatId || null,
    chatType: ctxInfo.chatType || 'self',
    privateReply: Boolean(ctxInfo.privateReply),
    summary: text,
  });

  const sendReq = (tid) => (isGroup && typeof bridge.client.sendGroupMessage === 'function'
    ? bridge.client.sendGroupMessage(bot.id, { text: outboundText, threadId: tid, sendId, replyToId: replyToOmbId })
    : bridge.client.sendMessage(bot.id, { text: outboundText, threadId: tid, sendId, replyToId: replyToOmbId }));

  let receipt;
  bridge.pendingThreads.add(threadId);
  try {
    try {
      receipt = await sendReq(threadId);
    } catch (e) {
      if (isExternal && e?.status === 404 && ctxInfo.originChatId) {
        bridge.pendingThreads.delete(threadId);
        bridge.chatThreads.delete(`${ctxInfo.originChatId}:${bot.id}`);
        const refreshed = await bridge.ensureChatThread(ctxInfo.originChatId, ctxInfo.chatType, ctxInfo.chatName, bot);
        threadId = refreshed.threadId;
        bridge.pendingThreads.add(threadId);
        receipt = await sendReq(threadId);
      } else {
        throw e;
      }
    }
  } catch (e) {
    const errTarget = ctxInfo.controlChatId || ctxInfo.replyChatId || bridge.selfChat;
    const errBanner = isExternal && errTarget === bridge.selfChat
      ? `📍 **来自「${ctxInfo.chatName || ctxInfo.originChatId}」**\n`
      : '';
    return bridge.say(`${errBanner}❌ 发送给 **${shownName}** 失败：${formatOmbError(e)}`, errTarget ? { targetChatId: errTarget } : null);
  } finally {
    bridge.pendingThreads.delete(threadId);
  }

  const alreadyTracking = [...bridge.activeTurns.values()].some((t) => t.threadId === threadId);
  const compactCtx = compactChatCtx(ctxInfo);
  const route = {
    botId: bot.id,
    botName: bot.name,
    threadId,
    ...(isGroup ? { isGroup: true } : {}),
    ...(ctxInfo.replyChatId ? { targetChatId: ctxInfo.replyChatId } : {}),
    ...(compactCtx ? {
      originChatId: compactCtx.originChatId,
      originChatName: compactCtx.chatName,
      originChatType: compactCtx.chatType,
      privateReply: compactCtx.privateReply,
    } : {}),
  };

  if (receipt?.queued === true) {
    const queueId = receipt.queueId || sendId;
    const list = bridge.queuedByThread.get(threadId) ?? [];
    const entry = { queueId, botId: bot.id, botName: bot.name, threadId, isGroup, text, sendId, at: bridge.now(), chatCtx: compactCtx };
    const ctrlChat = bridge.resolveControlChatId(ctxInfo);
    const ctrlBanner = ctxInfo.steerBanner
      || (isExternal && ctrlChat === bridge.selfChat ? `📍 **来自「${ctxInfo.chatName || ctxInfo.originChatId}」**\n` : '');
    if (ctxInfo.autoSteer && receipt.queueId) {
      const steerRes = await trySteerQueueItem(bridge, entry, {
        targetChatId: ctrlChat,
        banner: ctrlBanner,
        onQueuedText: (res) => `${ctrlBanner}⏳ 当前工具执行暂不支持直接插队${res.blockedBy ? `（${res.blockedBy}）` : ''}，已加入队列等待上一轮完成。`,
      });
      if (!steerRes.steered) {
        list.push(entry);
        bridge.queuedByThread.set(threadId, list);
      }
      return receipt;
    }
    list.push(entry);
    bridge.queuedByThread.set(threadId, list);
    const who = bridge.botPrefix(bot.id, bot.name, { isGroup });
    const cmdTarget = botCommandTarget(bridge, bot.id, bot.name, { isGroup });
    await bridge.say(
      `${ctrlBanner}📥 ${who ? `${who} ` : ''}已排队，等当前任务完成后自动继续。\n回复 \`${cmdTarget} steer\` 立即插队，或 \`${cmdTarget} cancel\` 取消排队。`,
      { ...route, ...(ctrlChat ? { targetChatId: ctrlChat } : {}) },
      null,
      [
        { label: '立即插队', text: `${cmdTarget} steer`, kind: 'primary' },
        { label: '取消排队', text: `${cmdTarget} cancel`, kind: 'danger' },
      ],
    );
    return receipt;
  }

  const reqMsgId = receipt?.message?.id ?? null;
  if (reqMsgId) rememberBounded(bridge.ownReqIds, reqMsgId);

  if (receipt?.steered === true && alreadyTracking) {
    if (!isExternal || ctxInfo.controlChatId === bridge.selfChat) {
      const ctrlChat = bridge.resolveControlChatId(ctxInfo);
      await bridge.say('⚡ 已将补充信息插入当前任务。', { ...route, ...(ctrlChat ? { targetChatId: ctrlChat } : {}) });
    }
    return receipt;
  }

  const turn = bridge.trackTurn({
    key: reqMsgId || `${threadId}:${sendId}`,
    botId: bot.id,
    botName: bot.name,
    threadId,
    reqMsgId,
    sendId,
    isGroup,
    chatCtx: compactCtx,
  });
  turn.startWatcher();
  if (isExternal && ctxInfo.silentProgress && bridge.chats.externalAckInSelf && bridge.selfChat) {
    const cmdTarget = botCommandTarget(bridge, bot.id, bot.name, { isGroup });
    bridge.say(
      `⏳ 已收到来自「${ctxInfo.chatName || ctxInfo.originChatId}」的提问，正在后台处理…`,
      { botId: bot.id, botName: bot.name, threadId, ...(isGroup ? { isGroup: true } : {}), targetChatId: bridge.selfChat },
      null,
      [{ label: '停止', text: `${cmdTarget} stop`, kind: 'danger' }],
    ).catch(() => {});
  }
  return receipt;
}

/** 消费来自 OpenMausBot `/api/events` SSE 推送的消息与状态变更事件。 */
export async function handleSseEvent(bridge, evt) {
  if (!evt || typeof evt !== 'object') return;
  bridge.sseConnected = true;
  bridge.sseAuthError = null;
  bridge.consecutiveSseErrors = 0;
  if ((evt.kind === 'message' || evt.kind === 'message.patch') && evt.message) {
    const threadId = evt.threadId ?? evt.message.threadId;
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
    if (!handled) await handleProactiveMessage(bridge, threadId, evt.message);
    return;
  }
  if (evt.kind === 'bot' && evt.bot) {
    if (!evt.bot.hidden) await bridge.refreshMultiBot();
    for (const turn of bridge.activeTurns.values()) {
      if (turn.botId !== evt.bot.id || turn.isGroup) continue;
      if (evt.bot.busy) turn.sawBusy = true;
      else if (turn.sawBusy && !evt.bot.busy) turn.complete().catch(() => {});
    }
    return;
  }
  if (evt.kind === 'group' && evt.group) {
    if (!evt.group.hidden) await bridge.refreshMultiBot();
    for (const turn of bridge.activeTurns.values()) {
      if (!turn.isGroup || turn.botId !== evt.group.id) continue;
      if (evt.group.busy) turn.sawBusy = true;
      else if (turn.sawBusy && !evt.group.busy) turn.complete().catch(() => {});
    }
  }
}
