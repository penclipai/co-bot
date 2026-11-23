import { fmtTokens, usageBar } from './cards.js';

/** 统一返回展示给用户的 Bot 或群聊名称。 */
export const showBotName = (bridge, id, name, isGroup = false) => (
  typeof bridge.displayBotName === 'function'
    ? bridge.displayBotName(id, name, { isGroup })
    : (String(name ?? '').trim() || bridge.botName || 'co-bot')
);

/** 根据名称或 ID 解析目标会话；外部群缺省时回到当前外部会话。 */
export function resolveChatOrId(bridge, arg, { isExternal = false, chatCtx = null } = {}) {
  const q = String(arg ?? '').trim();
  if (!q && isExternal && chatCtx) {
    return { id: chatCtx.originChatId, name: chatCtx.chatName || chatCtx.originChatId, type: chatCtx.chatType };
  }
  if (!q) return null;
  return bridge.resolveKnownChat(q) ?? (/^[\w.:-]+$/.test(q) ? { id: q, name: q, type: 'group' } : null);
}

/** 格式化并回复当前或指定会话的上下文 Token 占用情况。 */
export async function replyContextUsage(sensSink, { title, bot, threadId, task, compactCmd, compactLabel, isExternal = false, emptyHint = '暂无统计（对话后记录）' }) {
  const ctx = task?.usage?.context;
  const turns = task?.usage?.turns;
  if (!ctx?.window) {
    await sensSink.say(
      `📊 **${title}**${emptyHint}`,
      null,
      null,
      isExternal && compactCmd ? [{ label: compactLabel, text: compactCmd }] : null,
    );
    return;
  }
  const pct = Math.min(100, Math.round(((ctx.tokens || 0) / ctx.window) * 100));
  await sensSink.say(
    `📊 **${title}**上下文：${pct}%（${fmtTokens(ctx.tokens || 0)} / ${fmtTokens(ctx.window)}${turns != null ? ` · 共 ${turns} 轮` : ''}）\n\`${usageBar(pct)}\``,
    { botId: bot.id, botName: bot.name, threadId },
    null,
    [{ label: compactLabel, text: compactCmd, ...(pct >= 80 ? { kind: 'primary' } : {}) }],
  );
}

/** 返回应指向指定 Bot 的命令前缀（非主 Bot 用 `@<Bot名>`，主 Bot 用触发词）。 */
export function botCommandTarget(bridge, botId, botName) {
  if (botId && bridge.chiefBotId && botId !== bridge.chiefBotId && botName) {
    return `@${showBotName(bridge, botId, botName)}`;
  }
  return bridge.trigger;
}

/** 构造 `@bot help` 简洁使用说明。 */
export function buildHelpText(bridge) {
  const t = bridge.trigger;
  const brand = bridge.botName || 'co-bot';
  return [
    `🤖 **${brand} 常用指南**`,
    `- \`${t} <问题>\` / \`@<Bot名>\` / \`@<群名>\`：找主 Bot 或协作团队（自聊回复后 ${Math.round(bridge.followUpWindowMs / 1000)}s 内可免 \`@\` 续聊，\`${t} bye\` 退出）`,
    `- \`${t}! <问题>\`（外部群）：私密起草发回自聊，可引用润色后发 \`${t} sendback\` 确认回群`,
    `- \`${t} chats\` / \`chat mute|allow|mode|reset\` / \`summary <群>\` / \`digest\`：管群、跨群纪要与免打扰汇总`,
    `- \`${t} bind [项目|unbind]\` / \`delegate <会话> [proj:<项目>] <问题>\`：项目目录绑定与 C2C 协作委托`,
    `- \`${t} new [话题]\` / \`tasks\` / \`task <序号>\` / \`context [群]\` / \`compact [群]\`：会话与上下文管理`,
    `- \`${t} bots\` / \`status\` / \`memory\` / \`记住 <内容>\` / \`approval [ask|auto|full]\`：团队成员、记忆与审批`,
    `- \`${t} steer\` / \`cancel\` / \`stop\`：插队、取消排队或停止任务；卡片支持 \`ok/always/no/skip\``,
  ].join('\n');
}

/** 构造命令结果投递器，外部群敏感操作结果自动路由回自聊并携带来源标题。 */
export function makeCommandSink(bridge, chatCtx, { sensitive = true } = {}) {
  if (!chatCtx?.isExternal) {
    return {
      chatId: bridge.selfChat,
      banner: '',
      say: (text, route = null, replyTo = null, actions = null) => bridge.say(text, route, replyTo, actions),
      sendFile: (filePath, name, opts = {}) => bridge.sendOutboundFile(filePath, name, opts),
    };
  }
  const ctrlId = typeof bridge.resolveControlChatId === 'function'
    ? bridge.resolveControlChatId(chatCtx)
    : bridge.selfChat;
  const targetId = sensitive ? ctrlId : chatCtx.replyChatId;
  const label = chatCtx.chatName || chatCtx.originChatId;
  const originBanner = sensitive && ctrlId && ctrlId === bridge.selfChat ? `📍 **来自「${label}」的指令结果**\n` : '';
  let bannerSent = false;
  return {
    chatId: targetId,
    banner: originBanner,
    say: async (text, route = null, replyTo = null, actions = null) => {
      if (!targetId) return null;
      const head = !bannerSent ? originBanner : '';
      bannerSent = true;
      const mergedRoute = route ? { ...route, targetChatId: targetId } : { targetChatId: targetId };
      const rt = sensitive ? null : (replyTo ?? chatCtx.replyToImMsgId);
      return bridge.say(`${head}${text}`, mergedRoute, rt, actions);
    },
    sendFile: (filePath, name, opts = {}) => {
      if (!targetId) return null;
      return bridge.sendOutboundFile(filePath, name, { ...opts, chatId: targetId });
    },
  };
}

/** 停止运行中轮次、清空该 Thread 排队消息并向 OpenMausBot 发送中断请求。 */
export async function stopTarget(bridge, target, sink = null, { isExternal = false } = {}) {
  const say = sink?.say ?? ((t, r, rt, a) => bridge.say(t, r, rt, a));
  const matches = [...bridge.activeTurns.values()].filter((t) => {
    if (isExternal && target.originChatId && t.chatCtx?.originChatId && t.chatCtx.originChatId !== target.originChatId) {
      return false;
    }
    return t.threadId === target.threadId || (!isExternal && t.botId === target.botId);
  });
  if (!matches.length && !isExternal) {
    const fallback = [...bridge.activeTurns.values()].at(-1);
    if (fallback) matches.push(fallback);
  }
  for (const active of matches) {
    if (typeof active.markStopped === 'function') active.markStopped();
    else {
      active.dispose();
      bridge.activeTurns.delete(active.key);
      bridge.inFlightTurns?.delete(active.key);
      bridge.saveState();
    }
  }
  const cancelledQ = target.threadId && typeof bridge.cancelThreadQueue === 'function'
    ? await bridge.cancelThreadQueue(target.threadId)
    : 0;
  if (target.isGroup && typeof bridge.client.interruptGroup === 'function') {
    await bridge.client.interruptGroup(target.botId, target.threadId);
  } else {
    await bridge.client.interrupt(target.botId, target.threadId);
  }
  if (!isExternal) {
    bridge.lastBotReplyAt = 0;
    bridge.clearPickers?.();
  }
  const qNote = cancelledQ > 0 ? `（已同时取消 ${cancelledQ} 条排队消息）` : '';
  await say(`⏹ 已请求停止 **${showBotName(bridge, target.botId, target.botName, Boolean(target.isGroup))}**${qNote}`);
}

/** 统一处理 `@bot steer [补充内容]` 与 `@bot cancel` 队列控制指令。 */
export async function runQueueAction(bridge, { raw, target, quotedRoute, sensSink, mid, quotedId, chatCtx, cmdTarget }) {
  const steerM = raw.match(/^(?:steer|插队)(?:\s+([\s\S]+))?$/i);
  if (steerM) {
    const supplement = (steerM[1] ?? '').trim();
    const tid = quotedRoute?.threadId ?? target?.threadId ?? (chatCtx?.isExternal ? null : bridge.focus?.threadId);
    if (supplement && typeof bridge.dispatchSteerSupplement === 'function') {
      await bridge.dispatchSteerSupplement(
        quotedRoute
          ? { id: quotedRoute.botId, name: quotedRoute.botName, threadId: quotedRoute.threadId, isGroup: Boolean(quotedRoute.isGroup) }
          : target,
        supplement,
        mid,
        quotedId,
        chatCtx,
        { banner: sensSink.banner, cmdTarget },
      );
      return true;
    }
    await bridge.steerLatestQueue(tid, sensSink.chatId, { banner: sensSink.banner });
    return true;
  }
  if (/^(cancel|取消排队)$/i.test(raw)) {
    const tid = quotedRoute?.threadId ?? target?.threadId ?? (chatCtx?.isExternal ? null : bridge.focus?.threadId);
    await bridge.cancelLatestQueue(tid, sensSink.chatId, { banner: sensSink.banner });
    return true;
  }
  return false;
}
