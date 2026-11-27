import { clip } from '../format.ts';
import type { OpenMausBotBridge } from './bridge.ts';
import { formatOmbError, parseChoiceIndex } from './cards.ts';
import {
  botCommandTarget,
  buildHelpText,
  makeCommandSink,
  replyContextUsage,
  runQueueAction,
  showBotName,
  stopTarget,
} from './command-helpers.ts';
import { handleGovernanceCommand, handleStatusCommand, replyExternalChatContext } from './commands-governance.ts';
import { buildHelpHtml, sendHelpHtmlAttachment } from './help-html.ts';
import { handleCardReplyText } from './card-actions.ts';
import { handleInboxRefAction } from './inbox.ts';
import { getCachedBotRoster, invalidateBotListCache } from './thread-manager.ts';
import type { BridgeChatContext, MsgRoute, OmbTargetBot } from './types.ts';

export { botCommandTarget, buildHelpHtml, buildHelpText };

const TASK_PICK_TTL = 2 * 60 * 1000;
const parseListChoice = (raw: unknown): number | null => {
  const s = String(raw ?? '').trim();
  return parseChoiceIndex(s) ?? (/^\d+$/.test(s) ? Number(s) : null);
};

async function handleDefaultCommand(
  bridge: OpenMausBotBridge,
  raw: string,
  low: string,
  {
    quotedRoute,
    targetBot,
    mid,
    quotedId,
    hasAttachments = false,
    chatCtx,
  }: {
    quotedRoute: MsgRoute | null | undefined;
    targetBot: OmbTargetBot;
    mid: string;
    quotedId: string | null;
    hasAttachments?: boolean;
    chatCtx: BridgeChatContext | null;
  },
): Promise<boolean> {
  const extCtx = chatCtx?.isExternal ? chatCtx : null;
  const isExternal = Boolean(extCtx);
  const replySink = makeCommandSink(bridge, chatCtx, { sensitive: false });
  const sensSink = makeCommandSink(bridge, chatCtx, { sensitive: true });

  if (!low && !quotedId && !hasAttachments) {
    await replySink.say(buildHelpText(bridge));
    return true;
  }
  if (/^(?:help|帮助|\?|？)$/i.test(raw)) {
    const sent = await sendHelpHtmlAttachment(bridge, replySink, {
      replyTo: isExternal ? chatCtx?.replyToImMsgId : null,
    });
    if (!sent) await replySink.say(buildHelpText(bridge));
    return true;
  }

  const statusM = raw.match(/^(?:status|状态)(?:\s+([\s\S]+))?$/i);
  if (statusM) {
    try {
      await handleStatusCommand(bridge, (statusM[1] ?? '').trim(), { targetBot, sensSink, extCtx });
    } catch (e) {
      await sensSink.say(`❌ 获取状态失败：${formatOmbError(e)}`);
    }
    return true;
  }

  if (/^(?:stop|停止)$/.test(low)) {
    const scoped = targetBot ? {
      botId: targetBot.id,
      botName: targetBot.name,
      threadId: targetBot.threadId,
      isGroup: Boolean(targetBot.isGroup),
      ...(extCtx ? { originChatId: extCtx.originChatId } : {}),
    } : null;
    const rawTarget = extCtx
      ? (quotedRoute ?? [...bridge.activeTurns.values()].find((t) => t.chatCtx?.originChatId === extCtx.originChatId) ?? scoped)
      : (quotedRoute ?? [...bridge.activeTurns.values()].filter((t) => !t.chatCtx?.isExternal).at(-1) ?? bridge.focus ?? scoped);
    const target = rawTarget && extCtx && !('originChatId' in rawTarget && rawTarget.originChatId)
      ? { ...rawTarget, originChatId: extCtx.originChatId }
      : rawTarget;
    if (!target) { await sensSink.say('当前没有运行中或最近对话的 Bot。'); return true; }
    try {
      await stopTarget(bridge, target, sensSink, { isExternal });
    } catch (e) {
      await sensSink.say(`❌ 操作失败：${formatOmbError(e)}`);
    }
    return true;
  }

  if (await runQueueAction(bridge, {
    raw,
    target: targetBot,
    quotedRoute,
    sensSink,
    mid,
    quotedId,
    chatCtx,
    cmdTarget: bridge.trigger,
  })) {
    return true;
  }

  if (!isExternal && /^#\d+/.test(raw)) {
    const handled = await handleInboxRefAction(bridge, raw, {
      handleCardReply: (card, isQ, txt) => handleCardReplyText(bridge, card, isQ, txt),
      explicitCommand: true,
    });
    if (handled) return true;
  }

  return handleGovernanceCommand(bridge, raw, {
    targetBot,
    mid,
    quotedId,
    chatCtx,
    sensSink,
    extCtx,
    isExternal,
  });
}

/** 处理 @bot / @<BotName> / @<GroupName> 后的内建控制命令，命中返回 true。 */
export async function handleCommand(
  bridge: OpenMausBotBridge,
  cmdText: string,
  {
    isDefault,
    targetBot,
    quotedRoute,
    mid,
    quotedId,
    hasAttachments = false,
    chatCtx = null,
  }: {
    isDefault: boolean;
    targetBot: OmbTargetBot;
    quotedRoute: MsgRoute | null | undefined;
    mid: string;
    quotedId: string | null;
    hasAttachments?: boolean;
    chatCtx?: BridgeChatContext | null;
  },
): Promise<boolean> {
  const raw = cmdText.trim();
  const low = raw.toLowerCase();
  const extCtx = chatCtx?.isExternal ? chatCtx : null;
  const isExternal = Boolean(extCtx);
  const sensSink = makeCommandSink(bridge, chatCtx, { sensitive: true });
  const replySink = makeCommandSink(bridge, chatCtx, { sensitive: false });

  if (/^(?:bye|退下|结束对话|退出对话)$/i.test(raw)) {
    if (isExternal) {
      await sensSink.say('👋 外部群/私聊仅在 `@bot` 或引用 Bot 回复时触发，不会开启免 `@` 粘性。');
      return true;
    }
    bridge.clearSticky();
    await replySink.say('👋 已结束连续对话，之后普通消息将作为自聊笔记不再打扰。');
    return true;
  }

  if (isDefault && await handleDefaultCommand(bridge, raw, low, { quotedRoute, targetBot, mid, quotedId, hasAttachments, chatCtx })) return true;

  const activeTarget: OmbTargetBot = !isDefault
    ? targetBot
    : (quotedRoute
      ? { id: quotedRoute.botId, name: quotedRoute.botName, threadId: quotedRoute.threadId, isGroup: Boolean(quotedRoute.isGroup) }
      : targetBot);
  const isGroup = Boolean(activeTarget.isGroup);
  const shownTargetName = showBotName(bridge, activeTarget.id, activeTarget.name, isGroup);
  const cmdTarget = botCommandTarget(bridge, activeTarget.id, activeTarget.name, { isGroup });

  const singleBotOnlyHint = async (): Promise<boolean> => {
    await sensSink.say(`ℹ️ 群组「${activeTarget.name}」不支持该单 Bot 指令，请直接 \`@具体Bot名\` 操作。`);
    return true;
  };

  if (!isDefault) {
    if (/^(?:stop|停止)$/i.test(raw)) {
      try {
        await stopTarget(bridge, {
          botId: activeTarget.id,
          botName: activeTarget.name,
          threadId: activeTarget.threadId,
          isGroup,
        }, sensSink, { isExternal });
      } catch (e) {
        await sensSink.say(`❌ 操作失败：${formatOmbError(e)}`);
      }
      return true;
    }
    if (await runQueueAction(bridge, {
      raw,
      target: activeTarget,
      quotedRoute,
      sensSink,
      mid,
      quotedId,
      chatCtx,
      cmdTarget,
    })) {
      return true;
    }
    const botStatusM = raw.match(/^(?:status|状态)(?:\s+([\s\S]+))?$/i);
    if (botStatusM) {
      if (isGroup) return singleBotOnlyHint();
      const statusArg = (botStatusM[1] ?? '').trim();
      try {
        const { bots = [] } = await getCachedBotRoster(bridge, { force: true });
        if (statusArg) {
          await replyExternalChatContext(bridge, sensSink, { extArg: statusArg, bots, targetBot: activeTarget, cmdTarget });
          return true;
        }
        if (extCtx && !bridge.chatThreads.has(`${extCtx.originChatId}:${activeTarget.id}`)) {
          await sensSink.say(`会话「${extCtx.chatName || extCtx.originChatId}」尚未建立独立隔离上下文（发送对话后自动创建）。`);
          return true;
        }
        const fresh = bots.find((b) => b.id === activeTarget.id) ?? activeTarget;
        const freshName = showBotName(bridge, fresh.id, fresh.name);
        const task = (fresh.tasks ?? []).find((t) => (t.threadId ?? t.id) === activeTarget.threadId) ?? fresh.tasks?.[0];
        await replyContextUsage(sensSink, {
          title: freshName,
          bot: { id: fresh.id, name: freshName },
          threadId: activeTarget.threadId,
          task,
          compactCmd: extCtx ? `${cmdTarget} compact ${extCtx.originChatId}` : `${cmdTarget} compact`,
          emptyHint: '当前会话上下文暂无统计（发送对话后会自动记录）。',
        });
      } catch (e) {
        await sensSink.say(`❌ 获取状态失败：${formatOmbError(e)}`);
      }
      return true;
    }
  }

  // 会话列表与切换：@bot task（列出最近 5 条） / @bot task <序号>（切换）
  const taskM = raw.match(/^(?:task|会话)(?:\s+([\s\S]*))?$/i);
  if (taskM) {
    const taskArg = (taskM[1] ?? '').trim();
    if (!taskArg) {
      try {
        const { fresh, top } = await bridge.collectBotTasks(activeTarget);
        const freshName = showBotName(bridge, fresh.id, fresh.name, isGroup);
        if (!top.length) {
          await sensSink.say(`${freshName} 暂无可切换的历史会话，可发 \`${cmdTarget} new\` 创建新会话。`);
          return true;
        }
        const activeTid = activeTarget.threadId || fresh.threadId;
        const route: MsgRoute = { botId: fresh.id, botName: freshName, threadId: activeTid, ...(isGroup ? { isGroup: true } : {}) };
        const lines = top.map((t, i) => {
          const cur = (t.threadId ?? t.id) === activeTid ? '（当前）' : '';
          const busy = t.busy ? ' · 运行中' : '';
          return `${i + 1}. **${clip(t.title || '未命名会话', 36)}**${cur}${busy}`;
        });
        const sentId = await sensSink.say(
          `**🗂 ${freshName} 最近会话**\n${lines.join('\n')}\n\n回复序号 \`1\`～\`${top.length}\` 切换，或发 \`${cmdTarget} new\` 新建会话`,
          route,
        );
        bridge.clearPickers();
        bridge.pendingTaskPick = {
          botId: fresh.id,
          botName: freshName,
          isGroup,
          tasks: top,
          expiresAt: bridge.now() + TASK_PICK_TTL,
          imMsgId: sentId,
          isExternal,
          originChatId: extCtx?.originChatId ?? null,
          chatId: sensSink.chatId,
          banner: sensSink.banner,
        };
      } catch (e) {
        await sensSink.say(`❌ 获取会话列表失败：${formatOmbError(e)}`);
      }
      return true;
    }
    const taskChoice = parseListChoice(taskArg);
    if (!taskChoice || taskChoice < 1) {
      await sensSink.say(`用法：\`${cmdTarget} task [正整数序号]\`，不带序号可查看最近会话编号。`);
      return true;
    }
    const idx = taskChoice - 1;
    try {
      let tasks = bridge.pendingTaskPick?.botId === activeTarget.id && bridge.now() < bridge.pendingTaskPick.expiresAt
        ? bridge.pendingTaskPick.tasks
        : null;
      if (!tasks) tasks = (await bridge.collectBotTasks(activeTarget)).top;
      const picked = tasks[idx];
      if (!picked) {
        await sensSink.say(`未找到第 ${idx + 1} 号会话（当前共有 ${tasks.length} 条可用会话）。`);
        return true;
      }
      await bridge.switchTask(activeTarget.id, activeTarget.name, picked, {
        isGroup,
        chatId: sensSink.chatId,
        isExternal,
        originChatId: extCtx?.originChatId ?? null,
        banner: sensSink.banner,
      });
    } catch (e) {
      await sensSink.say(`❌ 切换会话失败：${formatOmbError(e)}`);
    }
    return true;
  }

  const newM = raw.match(/^(?:new|新会话)(?:\s+([\s\S]+))?$/i);
  if (newM) {
    const prompt = (newM[1] ?? '').trim();
    const titleArg = prompt
      ? { title: clip(prompt, 40) }
      : (extCtx ? { title: clip(`${extCtx.chatType === 'group' ? '群聊' : '私聊'} · ${extCtx.chatName || extCtx.originChatId}`, 40) } : {});
    let created;
    try {
      created = isGroup
        ? await bridge.client.createGroupTask(activeTarget.id, { ...titleArg, ...(isExternal ? { select: false } : {}) } as { title?: string })
        : await bridge.client.createTask(activeTarget.id, { ...titleArg, select: !isExternal });
      invalidateBotListCache(bridge);
    } catch (e) {
      await sensSink.say(`❌ 操作失败：${formatOmbError(e)}`);
      return true;
    }
    const newThreadId = created?.task?.threadId ?? created?.bot?.threadId ?? created?.group?.threadId ?? activeTarget.threadId;
    bridge.contextWarnedThreads.delete(newThreadId);
    bridge.threadInjectedScope.delete(newThreadId);
    const nextTarget: OmbTargetBot = { ...activeTarget, threadId: newThreadId, ...(isGroup ? { isGroup: true } : {}) };
    const shownNext = showBotName(bridge, nextTarget.id, nextTarget.name, isGroup);
    if (isGroup) {
      bridge.groupByThread.set(newThreadId, { id: nextTarget.id, name: nextTarget.name, threadId: newThreadId, isGroup: true });
    } else {
      bridge.botByThread.set(newThreadId, { id: nextTarget.id, name: nextTarget.name, threadId: newThreadId });
    }
    if (extCtx) {
      bridge.setChatThread(extCtx.originChatId, nextTarget);
    } else {
      bridge.pendingTaskPick = null;
      bridge.setSelfThread?.(nextTarget);
      bridge.focus = { botId: nextTarget.id, botName: nextTarget.name, threadId: newThreadId, ...(isGroup ? { isGroup: true } : {}) };
      if (!prompt) bridge.lastBotReplyAt = bridge.now();
      bridge.saveState();
    }
    if (!prompt) {
      const hintTarget = !isGroup && (isDefault || (bridge.chiefBotId && nextTarget.id === bridge.chiefBotId))
        ? bridge.trigger
        : `@${shownNext}`;
      const msgText = isExternal
        ? `🆕 已为当前会话的 **${shownNext}** 开启新会话上下文。`
        : `🆕 已为 **${shownNext}** 开启新会话，直接发消息或 \`${hintTarget}\` 对话即可。`;
      await replySink.say(msgText, {
        botId: nextTarget.id, botName: shownNext, threadId: newThreadId, ...(isGroup ? { isGroup: true } : {}),
      });
    } else {
      await bridge.dispatchToBot(nextTarget, prompt, mid, quotedId, null, chatCtx);
    }
    return true;
  }

  const compactM = raw.match(/^(?:compact|压缩)(?:\s+([\s\S]+))?$/i);
  if (compactM) {
    if (isGroup) return singleBotOnlyHint();
    const compArg = (compactM[1] ?? '').trim();
    try {
      if (compArg) {
        const extChat = bridge.resolveKnownChat(compArg);
        if (!extChat) {
          await sensSink.say(`未找到匹配会话「${compArg}」，发 \`${bridge.trigger} chats\` 查看已知会话。`);
          return true;
        }
        const done = await bridge.compactExternalChat(extChat, isDefault ? null : activeTarget);
        if (!done.length) {
          await sensSink.say(`会话「${extChat.name || extChat.id}」尚未建立外部隔离上下文。`);
          return true;
        }
        await sensSink.say(
          `🗜️ 已触发压缩「${extChat.name || extChat.id}」的隔离上下文（${done.map((d) => showBotName(bridge, d.botId, d.botName)).join('、')}）。`,
          { botId: done[0].botId, botName: showBotName(bridge, done[0].botId, done[0].botName), threadId: done[0].threadId },
        );
        return true;
      }
      if (extCtx && !bridge.chatThreads.has(`${extCtx.originChatId}:${activeTarget.id}`)) {
        await sensSink.say(`会话「${extCtx.chatName || extCtx.originChatId}」尚未建立独立隔离上下文（发送对话后自动创建）。`);
        return true;
      }
      await bridge.client.compact(activeTarget.id, activeTarget.threadId);
      invalidateBotListCache(bridge);
      bridge.contextWarnedThreads.delete(activeTarget.threadId);
      bridge.threadInjectedScope.delete(activeTarget.threadId);
      await sensSink.say(`🗜️ 已触发 **${shownTargetName}** 压缩当前会话上下文。`, {
        botId: activeTarget.id, botName: shownTargetName, threadId: activeTarget.threadId,
      });
    } catch (e) {
      await sensSink.say(`❌ 操作失败：${formatOmbError(e)}`);
    }
    return true;
  }

  const extCmd = bridge.commandRegistry?.match(raw);
  if (extCmd) {
    try {
      await extCmd.def.handler({
        args: extCmd.args,
        raw,
        isExternal,
        chatId: extCtx?.originChatId || bridge.selfChat,
        chatType: extCtx?.chatType ?? 'self',
        chatName: extCtx?.chatName ?? '',
        targetBot: {
          id: activeTarget.id,
          name: activeTarget.name,
          threadId: activeTarget.threadId,
          ...(isGroup ? { isGroup: true } : {}),
        },
        reply: (text) => replySink.say(text),
        replySensitive: (text) => sensSink.say(text),
      });
    } catch (e) {
      await sensSink.say(`❌ 指令「${extCmd.def.name}」执行失败：${formatOmbError(e)}`);
    }
    return true;
  }

  return false;
}
