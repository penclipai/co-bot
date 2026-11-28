import crypto from 'node:crypto';
import { formatLinkCardSnippet } from '../core/channel-contract.ts';
import { assemblePromptContext } from '../core/chat-context.ts';
import { formatForwardedFull, formatForwardedSummary } from '../core/context-pull.ts';
import { formatReadonlyGuardBlock } from '../core/inbound-policy.ts';
import { formatProjectContextBlock, resolveProjectBinding } from '../core/projects.ts';
import { attachBotBadge } from '../core/security.ts';
import { clip } from '../format.ts';
import type { ChatContextMessage, ChatType, InboundEvent } from '../types.ts';
import type { OpenMausBotBridge } from './bridge.ts';
import { formatOmbError } from './cards.ts';
import { formatAttachmentTag } from './client.ts';
import { botCommandTarget, formatOriginBanner } from './command-helpers.ts';
import { claimUploads } from './delivery.ts';
import { buildExternalChatCtx } from './collaborator-router.ts';
import {
  cancelLatestQueue,
  cancelThreadQueue,
  dispatchSteerSupplement,
  handleSseEvent,
  pruneExpiredQueues,
  removeQueued,
  steerLatestQueue,
  trySteerQueueItem,
} from './queue-and-sse.ts';
import { compactChatCtx, rememberBounded, trimMapCap } from './mentions.ts';
import { getCachedBotRoster, invalidateBotListCache } from './thread-manager.ts';
import type {
  BridgeChatContext,
  MsgRoute,
  OmbGroup,
  OmbHttpError,
  OmbMessage,
  OmbTargetBot,
  OmbTaskSummary,
  QueuedTurnEntry,
} from './types.ts';

export {
  cancelLatestQueue,
  cancelThreadQueue,
  dispatchSteerSupplement,
  handleSseEvent,
  pruneExpiredQueues,
  steerLatestQueue,
};

const GOAL_CMD_RE = /^\/goal(?:\s+([\s\S]*))?$/i;
const SLASH_CMD_RE = /^\/([a-zA-Z0-9][a-zA-Z0-9_-]*)(?:\s+([\s\S]*))?$/;
const BARE_SLASH_WITHOUT_CONTEXT = new Set(['learn', 'setup', 'burst']);

/**
 * 处理 OpenMausBot 原生斜杠命令（`/goal`、`/learn`、`/burst`、`/setup`、自定义 `/<skill>`）：
 * - `/goal <目标>` 剥离前缀并切换为 `mode: 'goal'`；空 `/goal` 返回提示标记；
 * - 其余斜杠命令置于句首（上下文放末尾），确保服务端 `^\/...` 正则准确命中。
 */
export function prepareSlashOutbound(
  text: string,
  contextBlock: string,
): { mode?: 'goal'; outboundText: string; emptyGoal?: boolean } {
  const raw = String(text ?? '');
  const trimmed = raw.trim();
  const goalM = GOAL_CMD_RE.exec(trimmed);
  if (goalM) {
    const goalBody = (goalM[1] ?? '').trim();
    if (!goalBody) return { mode: 'goal', outboundText: '', emptyGoal: true };
    const tail = contextBlock.trim();
    return {
      mode: 'goal',
      outboundText: tail ? `${goalBody}\n\n${tail}` : goalBody,
    };
  }
  const slashM = SLASH_CMD_RE.exec(trimmed);
  if (slashM) {
    const cmdName = slashM[1].toLowerCase();
    const cmdArg = (slashM[2] ?? '').trim();
    if (!cmdArg && BARE_SLASH_WITHOUT_CONTEXT.has(cmdName)) {
      return { outboundText: `/${cmdName}` };
    }
    const tail = contextBlock.trim();
    return {
      outboundText: tail ? `${trimmed}\n\n${tail}` : trimmed,
    };
  }
  return { outboundText: `${contextBlock}${raw}` };
}

async function buildPromptContext(
  bridge: OpenMausBotBridge,
  ev: InboundEvent | null | undefined,
  chatCtx: BridgeChatContext,
  {
    skipSelfQuote = false,
    injectRecent = bridge.chats.injectRecentContext === true,
    contextWindow,
    botId = '',
  }: { skipSelfQuote?: boolean; injectRecent?: boolean; contextWindow?: number; botId?: string } = {},
) {
  if (!ev?.chat?.id) {
    return {
      header: '',
      quotedMsg: null,
      recentMsgs: [] as ChatContextMessage[],
      quotedAttachments: [],
      contextAttachments: [],
      consumedSelfMsgIds: [] as string[],
    };
  }
  const common = {
    ev,
    privateReply: Boolean(chatCtx?.privateReply),
    contextWindow: contextWindow ?? bridge.chats.contextWindow,
    injectRecent,
    maxQuotedChars: bridge.chats.maxQuotedSnippetChars,
    maxRecentChars: bridge.chats.maxRecentMessageChars,
    skipSelfQuote,
    recentAttachmentWindowMs: bridge.chats.recentAttachmentWindowMs,
    maxAutoAttachments: bridge.chats.maxAutoAttachments,
    resolvePullHint: bridge.imContext?.getContextPullHint
      ? (info: {
          oldestMsgId: string | null;
          hasTruncated: boolean;
          hasOlder: boolean;
          availableCount: number;
          availableFiles: number;
          pullOnly: boolean;
        }) => (
          bridge.imContext?.getContextPullHint?.(String(ev.chat.id), {
            ...info,
            ...(botId ? { botId } : {}),
            readonly: Boolean(chatCtx?.readonly),
            allowCrossChat: Boolean(!chatCtx?.isExternal && !chatCtx?.readonly && (!bridge.chiefBotId || botId === bridge.chiefBotId)),
            triggerText: String(ev.text || ''),
          }) ?? ''
        )
      : undefined,
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
          const chatType = bridge.resolveChatType(cid);
          const remote = await bridge.transport.getMessage(cid, msgId, chatType ? { chatType } : {});
          if (remote) return bridge.localContextStore.recordInbound(remote as Partial<InboundEvent>);
        } catch { /* ignore */ }
      }
      return null;
    },
    getHistory: async (cid, { limit, excludeMsgId }: { limit?: number; excludeMsgId?: string } = {}) => bridge.localContextStore.getRecent(cid, { limit, excludeMsgId }),
  });
}

/** 获取目标 Bot 或群聊最近 5 条任务列表。 */
export async function collectBotTasks(
  bridge: OpenMausBotBridge,
  target: OmbTargetBot,
): Promise<{ fresh: OmbTargetBot | OmbGroup; top: OmbTaskSummary[] }> {
  const { bots = [], groups = [] } = await getCachedBotRoster(bridge, { force: true });
  const isGroup = Boolean(target.isGroup);
  const fresh = (isGroup ? groups.find((g) => g.id === target.id) : bots.find((b) => b.id === target.id)) ?? target;
  const list = (Array.isArray(fresh.tasks) ? [...fresh.tasks] : []).filter((t) => !t?.openedBy?.burstId);
  list.sort((a, b) => (b.updatedAt ?? b.lastThreadOrderAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.lastThreadOrderAt ?? a.createdAt ?? 0));
  const top = list.slice(0, 5);
  return { fresh, top };
}

/** 将焦点切换到选定的历史或新建任务 Thread。 */
export async function switchTask(
  bridge: OpenMausBotBridge,
  defaultBotId: string,
  defaultBotName: string,
  task: OmbTaskSummary,
  {
    isGroup = false,
    chatId = null,
    isExternal = false,
    originChatId = null,
    banner = '',
  }: {
    isGroup?: boolean;
    chatId?: string | null;
    isExternal?: boolean;
    originChatId?: string | null;
    banner?: string;
  } = {},
): Promise<void> {
  const botId = task.botId ?? defaultBotId;
  const botName = task.botName ?? defaultBotName;
  const tid = task.threadId ?? task.id ?? '';
  bridge.clearPickers();
  const route: MsgRoute = { botId, botName, threadId: tid, ...(isGroup ? { isGroup: true } : {}), ...(chatId ? { targetChatId: chatId } : {}) };
  try {
    if (isExternal && originChatId) {
      bridge.setChatThread(originChatId, { id: botId, name: botName, threadId: tid, isGroup });
    } else {
      if (isGroup && typeof bridge.client.selectGroupTask === 'function') {
        await bridge.client.selectGroupTask(botId, tid);
        invalidateBotListCache(bridge);
        bridge.groupByThread.set(tid, { id: botId, name: botName, threadId: tid, isGroup: true });
      } else {
        await bridge.client.selectTask(botId, tid);
        invalidateBotListCache(bridge);
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
export async function dispatchToBot(
  bridge: OpenMausBotBridge,
  bot: OmbTargetBot,
  text: string,
  imMsgId: string | null,
  quotedId: string | null,
  replyToOmbId: string | null,
  chatCtx: BridgeChatContext | null = null,
): Promise<unknown> {
  const ctxInfo: BridgeChatContext = chatCtx
    ? { ...chatCtx }
    : buildExternalChatCtx(bridge, {
        isSelfChat: true,
        chatId: bridge.selfChat,
        chatType: 'self' as ChatType,
        chatName: '',
        mid: null,
        privateReply: false,
        ev: null,
      });
  const isExternal = Boolean(ctxInfo.isExternal);
  if (
    isExternal
    && !ctxInfo.privateReply
    && !ctxInfo.readonly
    && ctxInfo.preformattedHeader === undefined
    && bridge.chats.externalReplyMode === 'draft_first'
    && bridge.selfChat
  ) {
    ctxInfo.privateReply = true;
    ctxInfo.replyChatId = bridge.selfChat;
    ctxInfo.replyToImMsgId = null;
    ctxInfo.draftFirst = true;
  }
  const isGroup = Boolean(bot.isGroup);
  let threadId = bot.threadId;

  const noLoopbackPull = Boolean(
    isExternal
    && !ctxInfo.delegationReq
    && bridge.chats.injectRecentContext !== true
    && typeof bridge.imContext?.hasLoopbackPull === 'function'
    && !bridge.imContext.hasLoopbackPull(),
  );
  const promptCtx = ctxInfo.preformattedHeader !== undefined
    ? { header: ctxInfo.preformattedHeader, quotedMsg: null, recentMsgs: [], quotedAttachments: [], contextAttachments: [] }
    : await buildPromptContext(bridge, ctxInfo.ev, ctxInfo, {
        skipSelfQuote: Boolean(!isExternal && replyToOmbId),
        injectRecent: !ctxInfo.delegationReq && (bridge.chats.injectRecentContext === true || noLoopbackPull),
        contextWindow: noLoopbackPull ? Math.min(6, Number(bridge.chats.contextWindow) || 6) : bridge.chats.contextWindow,
        botId: bot.id,
      });
  const { uploads, transcripts } = await claimUploads(
    bridge,
    imMsgId,
    quotedId,
    ctxInfo.originChatId,
    promptCtx.contextAttachments ?? promptCtx.quotedAttachments,
    ctxInfo.controlChatId,
    { allowPendingFileMsgs: !isExternal },
  );
  const extras: string[] = [];
  const linkSnippet = formatLinkCardSnippet(ctxInfo.ev?.linkCard);
  if (linkSnippet) extras.push(linkSnippet);
  if (ctxInfo.ev?.forwarded) {
    const fwd = ctxInfo.ev.forwarded;
    const fullFwd = formatForwardedFull(fwd);
    if (fwd.messages.length <= 4 && fullFwd.length <= 360) {
      extras.push(fullFwd);
    } else {
      extras.push(`${formatForwardedSummary(fwd)}（查完整记录请用 msgId=${ctxInfo.ev.id}）`);
    }
  }
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
  const scopeSig = skipScope
    ? ''
    : JSON.stringify({
        project: project?.path ?? '',
        source,
        isExternal,
        isReadonly: Boolean(ctxInfo.readonly),
        sharedDir: bridge.sharedContext.isAvailable() ? bridge.sharedContext.dir : '',
      });
  const includeScope = !skipScope && bridge.threadInjectedScope.get(threadId) !== scopeSig;
  const buildOutbound = (withScope: boolean): { mode?: 'goal'; outboundText: string; emptyGoal?: boolean } => {
    const scopeText = withScope ? `${projectBlock}${sharedBlock}` : '';
    const contextBlock = `${guardBlock}${scopeText}${promptCtx.header || ''}${extras.length ? `${extras.join('\n')}\n\n` : ''}`;
    const res = ctxInfo.readonly
      ? { outboundText: `${contextBlock}${text}` }
      : prepareSlashOutbound(text, contextBlock);
    if (!res.emptyGoal && uploads.length) {
      const tags = uploads.map((u) => formatAttachmentTag(u));
      return { ...res, outboundText: `${res.outboundText}\n\n${tags.join('\n')}` };
    }
    return res;
  };
  let prepared = buildOutbound(includeScope);
  if (prepared.emptyGoal) {
    const who = bridge.botPrefix(bot.id, bot.name, { isGroup });
    const goalHint = `🎯 请在 \`/goal\` 后写明要达成的目标，例如：\`${bridge.trigger} /goal 梳理本周发布风险并给出检查清单\``;
    const replyChat = ctxInfo.replyChatId || bridge.selfChat;
    await bridge.say(
      who ? attachBotBadge(who, goalHint) : goalHint,
      replyChat ? { botId: bot.id, botName: bot.name, threadId, ...(isGroup ? { isGroup: true } : {}), targetChatId: replyChat } : null,
    );
    return null;
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

  const sendReq = (tid: string, out: { mode?: 'goal'; outboundText: string }) => {
    const sendOpts = {
      text: out.outboundText,
      sendId,
      replyToId: replyToOmbId,
      ...(out.mode ? { mode: out.mode } : {}),
    };
    return isGroup && typeof bridge.client.sendGroupMessage === 'function'
      ? bridge.client.sendGroupMessage(bot.id, { ...sendOpts, threadId: tid })
      : bridge.client.sendMessage(bot.id, { ...sendOpts, threadId: tid });
  };

  let receipt: { queued?: boolean; queueId?: string; blockedBy?: string; steered?: boolean; message?: OmbMessage };
  let acquiredThreadId = threadId;
  bridge.acquirePendingThread(acquiredThreadId);
  try {
    try {
      receipt = await sendReq(threadId, prepared);
    } catch (e) {
      const err = e as OmbHttpError;
      if (isExternal && err?.status === 404 && ctxInfo.originChatId) {
        bridge.releasePendingThread(acquiredThreadId);
        bridge.threadInjectedScope.delete(threadId);
        bridge.chatThreads.delete(`${ctxInfo.originChatId}:${bot.id}`);
        const refreshed = await bridge.ensureChatThread(ctxInfo.originChatId, ctxInfo.chatType, ctxInfo.chatName || '', bot);
        threadId = refreshed.threadId;
        if (!skipScope && !includeScope) prepared = buildOutbound(true);
        acquiredThreadId = threadId;
        bridge.acquirePendingThread(acquiredThreadId);
        receipt = await sendReq(threadId, prepared);
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
    bridge.releasePendingThread(acquiredThreadId);
  }

  if (!skipScope) {
    bridge.threadInjectedScope.set(threadId, scopeSig);
    trimMapCap(bridge.threadInjectedScope, 200);
  }
  const ctxStore = bridge.imContext?.store ?? bridge.localContextStore;
  if (imMsgId) ctxStore.markDispatched(ctxInfo.originChatId, [imMsgId], { botId: bot.id, botName: shownName });
  if (promptCtx.consumedSelfMsgIds?.length) ctxStore.markDispatched(ctxInfo.originChatId, promptCtx.consumedSelfMsgIds);

  const alreadyTracking = [...bridge.activeTurns.values()].some((t) => t.threadId === threadId);
  const compactCtx = compactChatCtx(ctxInfo);
  const route: MsgRoute = {
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
    const entry: QueuedTurnEntry = { queueId, botId: bot.id, botName: bot.name, threadId, isGroup, text, sendId, at: bridge.now(), chatCtx: compactCtx };
    const ctrlChat = bridge.resolveControlChatId(ctxInfo);
    const ctrlBanner = ctxInfo.steerBanner || formatOriginBanner(ctxInfo, ctrlChat, bridge.selfChat);
    if (ctxInfo.autoSteer && receipt.queueId) {
      list.push(entry);
      bridge.queuedByThread.set(threadId, list);
      const steerRes = await trySteerQueueItem(bridge, entry, {
        targetChatId: ctrlChat,
        banner: ctrlBanner,
        onQueuedText: (res) => `${ctrlBanner}⏳ 当前工具执行暂不支持直接插队${res.blockedBy ? `（${res.blockedBy}）` : ''}，已加入队列等待上一轮完成。`,
      });
      if (steerRes.steered) removeQueued(bridge, threadId, entry.queueId);
      return receipt;
    }
    list.push(entry);
    bridge.queuedByThread.set(threadId, list);
    const who = bridge.botPrefix(bot.id, bot.name, { isGroup });
    const cmdTarget = botCommandTarget(bridge, bot.id, bot.name, { isGroup });
    const queueNotice = `📥 已排队，等当前任务完成后自动继续。\n回复 \`${cmdTarget} steer\` 立即插队，或 \`${cmdTarget} cancel\` 取消排队。`;
    await bridge.say(
      `${ctrlBanner}${who ? attachBotBadge(who, queueNotice) : queueNotice}`,
      { ...route, ...(ctrlChat ? { targetChatId: ctrlChat } : {}) },
    );
    return receipt;
  }

  const reqMsgId = receipt?.message?.id ?? null;
  if (reqMsgId) rememberBounded(bridge.ownReqIds, reqMsgId);

  if (receipt?.steered === true && alreadyTracking) {
    for (const activeTurn of bridge.activeTurns.values()) {
      if (activeTurn.threadId === threadId) {
        activeTurn.addSteeredRequest?.(reqMsgId, sendId);
      }
    }
    if (!isExternal || ctxInfo.controlChatId === bridge.selfChat) {
      const ctrlChat = bridge.resolveControlChatId(ctxInfo);
      const ctrlBanner = ctxInfo.steerBanner || formatOriginBanner(ctxInfo, ctrlChat, bridge.selfChat);
      await bridge.say(`${ctrlBanner}⚡ 已将补充信息插入当前任务。`, { ...route, ...(ctrlChat ? { targetChatId: ctrlChat } : {}) });
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
      `⏳ 已收到来自「${ctxInfo.chatName || ctxInfo.originChatId}」的提问，正在后台处理…（如需中断可回复 \`${cmdTarget} stop\`）`,
      { botId: bot.id, botName: bot.name, threadId, ...(isGroup ? { isGroup: true } : {}), targetChatId: bridge.selfChat },
    ).catch(() => {});
  }
  return receipt;
}
