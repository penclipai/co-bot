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
import { formatAttachmentTag, messageNeedsInput } from './client.ts';
import { botCommandTarget, formatOriginBanner } from './command-helpers.ts';
import { claimUploads, deliverBotReply, emitCard, forwardBotMedia } from './delivery.ts';
import { buildExternalChatCtx } from './inbound-router.ts';
import { compactChatCtx, inQuietHours, rememberBounded, trimMapCap } from './mentions.ts';
import type {
  BridgeChatContext,
  MsgRoute,
  OmbGroup,
  OmbHttpError,
  OmbMessage,
  OmbSseEvent,
  OmbTargetBot,
  OmbTaskSummary,
  QueuedTurnEntry,
} from './types.ts';

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
    if (watch.doneSeen && watch.deliveredText) {
      bridge.activeBursts.delete(watch.burstId);
    }
    return true;
  }

  if (msg.kind === 'burst' && msg.burst?.burstId === watch.burstId) {
    const phase = String(msg.burst.phase || '');
    if (phase === 'failed' || phase === 'cancelled') {
      bridge.activeBursts.delete(watch.burstId);
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
    } else if (phase === 'done') {
      watch.doneSeen = true;
      if (watch.deliveredText) {
        bridge.activeBursts.delete(watch.burstId);
      } else {
        // 等待紧随其后的合并文本到达，超时后自动清理防止悬挂
        const timer = setTimeout(() => {
          const cur = bridge.activeBursts.get(watch.burstId);
          if (cur === watch) bridge.activeBursts.delete(watch.burstId);
        }, 10_000);
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

function removeQueued(bridge: OpenMausBotBridge, threadId: string, queueId: string): QueuedTurnEntry | null {
  const list = bridge.queuedByThread.get(threadId);
  if (!list) return null;
  const idx = list.findIndex((q) => q.queueId === queueId);
  if (idx < 0) return null;
  const [removed] = list.splice(idx, 1);
  if (!list.length) bridge.queuedByThread.delete(threadId);
  return removed;
}

async function buildPromptContext(
  bridge: OpenMausBotBridge,
  ev: InboundEvent | null | undefined,
  chatCtx: BridgeChatContext,
  { skipSelfQuote = false, injectRecent = bridge.chats.injectRecentContext === true }: { skipSelfQuote?: boolean; injectRecent?: boolean } = {},
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
    contextWindow: bridge.chats.contextWindow,
    injectRecent,
    maxQuotedChars: bridge.chats.maxQuotedSnippetChars,
    maxRecentChars: bridge.chats.maxRecentMessageChars,
    skipSelfQuote,
    recentAttachmentWindowMs: bridge.chats.recentAttachmentWindowMs,
    maxAutoAttachments: bridge.chats.maxAutoAttachments,
    allowAskColleagueHint: !chatCtx?.readonly,
    resolvePullHint: bridge.imContext?.getContextPullHint
      ? (info: {
          oldestMsgId: string | null;
          hasTruncated: boolean;
          hasOlder: boolean;
          availableCount: number;
          availableFiles: number;
          pullOnly: boolean;
        }) => (
          bridge.imContext?.getContextPullHint?.(String(ev.chat.id), { ...info, readonly: Boolean(chatCtx?.readonly) }) ?? ''
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
          const remote = await bridge.transport.getMessage(cid, msgId);
          if (remote) return bridge.localContextStore.recordInbound(remote as Partial<InboundEvent>);
        } catch { /* ignore */ }
      }
      return null;
    },
    getHistory: async (cid, { limit, excludeMsgId }: { limit?: number; excludeMsgId?: string } = {}) => bridge.localContextStore.getRecent(cid, { limit, excludeMsgId }),
  });
}

async function handleProactiveMessage(bridge: OpenMausBotBridge, threadId: string, msg: OmbMessage): Promise<void> {
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
    if (!text && !hasMedia) return;
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

async function trySteerQueueItem(
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
        ? `\n回复 \`${cmdTarget} steer\` 立即插队，或 \`${cmdTarget} cancel\` 取消排队。`
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
    await bridge.say(`${banner}❌ 取消排队失败：${formatOmbError(e)}`, outChatId ? { targetChatId: outChatId } : null);
  }
}

/** 获取目标 Bot 或群聊最近 5 条任务列表。 */
export async function collectBotTasks(
  bridge: OpenMausBotBridge,
  target: OmbTargetBot,
): Promise<{ fresh: OmbTargetBot | OmbGroup; top: OmbTaskSummary[] }> {
  const { bots = [], groups = [] } = await bridge.client.listBots();
  const isGroup = Boolean(target.isGroup);
  const fresh = (isGroup ? groups.find((g) => g.id === target.id) : bots.find((b) => b.id === target.id)) ?? target;
  const list = Array.isArray(fresh.tasks) ? [...fresh.tasks] : [];
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

  const promptCtx = ctxInfo.preformattedHeader !== undefined
    ? { header: ctxInfo.preformattedHeader, quotedMsg: null, recentMsgs: [], quotedAttachments: [], contextAttachments: [] }
    : await buildPromptContext(bridge, ctxInfo.ev, ctxInfo, {
        skipSelfQuote: Boolean(!isExternal && replyToOmbId),
        injectRecent: bridge.chats.injectRecentContext === true && !ctxInfo.delegationReq,
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
  bridge.pendingThreads.add(threadId);
  try {
    try {
      receipt = await sendReq(threadId, prepared);
    } catch (e) {
      const err = e as OmbHttpError;
      if (isExternal && err?.status === 404 && ctxInfo.originChatId) {
        bridge.pendingThreads.delete(threadId);
        bridge.threadInjectedScope.delete(threadId);
        bridge.chatThreads.delete(`${ctxInfo.originChatId}:${bot.id}`);
        const refreshed = await bridge.ensureChatThread(ctxInfo.originChatId, ctxInfo.chatType, ctxInfo.chatName || '', bot);
        threadId = refreshed.threadId;
        if (!skipScope && !includeScope) prepared = buildOutbound(true);
        bridge.pendingThreads.add(threadId);
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
    bridge.pendingThreads.delete(threadId);
  }

  if (!skipScope) {
    bridge.threadInjectedScope.set(threadId, scopeSig);
    trimMapCap(bridge.threadInjectedScope, 200);
  }
  const ctxStore = bridge.imContext?.store ?? bridge.localContextStore;
  ctxStore.markDispatched(ctxInfo.originChatId, [imMsgId, ...(promptCtx.consumedSelfMsgIds ?? [])]);

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

/** 消费来自 OpenMausBot `/api/events` SSE 推送的消息与状态变更事件。 */
export async function handleSseEvent(bridge: OpenMausBotBridge, evt: OmbSseEvent): Promise<void> {
  if (!evt || typeof evt !== 'object') return;
  bridge.sseConnected = true;
  bridge.sseAuthError = null;
  bridge.consecutiveSseErrors = 0;
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
