import type { ChannelAction, ChannelSendFileInput } from '../types.ts';
import type { OpenMausBotBridge } from './bridge.ts';
import { fmtTokens, usageBar } from './cards.ts';
import type { BridgeChatContext, KnownChatSummary, MsgRoute, OmbTargetBot, OmbTaskSummary } from './types.ts';

export interface CommandSink {
  chatId: string;
  banner: string;
  say: (
    text: string,
    route?: MsgRoute | { targetChatId?: string | null } | null,
    replyTo?: string | null,
    actions?: ChannelAction[] | null,
  ) => Promise<string | null>;
  sendFile: (
    filePath: string,
    name: string,
    opts?: { chatId?: string; replyTo?: string; recordContext?: boolean },
  ) => Promise<string | null | undefined>;
}

/** 统一返回展示给用户的 Bot 或群聊名称。 */
export const showBotName = (bridge: OpenMausBotBridge, id: string, name?: string, isGroup = false): string => (
  typeof bridge.displayBotName === 'function'
    ? bridge.displayBotName(id, name, { isGroup })
    : (String(name ?? '').trim() || bridge.botName || 'co-bot')
);

/** 根据名称或 ID 解析目标会话；外部群缺省时回到当前外部会话。 */
export function resolveChatOrId(
  bridge: OpenMausBotBridge,
  arg: unknown,
  { isExternal = false, chatCtx = null }: { isExternal?: boolean; chatCtx?: BridgeChatContext | null } = {},
): KnownChatSummary | { id: string; name: string; type: 'group' | 'direct' | 'self' | 'system' } | null {
  const q = String(arg ?? '').trim();
  if (!q && isExternal && chatCtx) {
    return { id: chatCtx.originChatId, name: chatCtx.chatName || chatCtx.originChatId, type: chatCtx.chatType };
  }
  if (!q) return null;
  return bridge.resolveKnownChat(q) ?? (/^[\w.:-]+$/.test(q) ? { id: q, name: q, type: 'group' } : null);
}

/** 返回去除 provider 前缀后的短模型名。 */
export function shortModelName(raw: unknown): string {
  const s = String(raw ?? '').trim();
  const slash = s.lastIndexOf('/');
  return slash >= 0 ? s.slice(slash + 1) : s;
}

/** 计算单个会话的上下文占比与进度条文案；无窗口统计时返回 null。 */
export function formatContextSummary(task: OmbTaskSummary | null | undefined): { pct: number; line: string } | null {
  const ctx = task?.usage?.context;
  if (!ctx?.window) return null;
  const pct = Math.min(100, Math.round(((ctx.tokens || 0) / ctx.window) * 100));
  const turns = task?.usage?.turns;
  return {
    pct,
    line: `${pct}%（${fmtTokens(ctx.tokens || 0)}/${fmtTokens(ctx.window)}${turns != null ? ` · ${turns}轮` : ''}） \`${usageBar(pct)}\``,
  };
}

/** 格式化并回复当前或指定会话的上下文 Token 占用情况。 */
export async function replyContextUsage(
  sensSink: CommandSink,
  {
    title,
    bot,
    threadId,
    task,
    compactCmd,
    isExternal = false,
    emptyHint = '暂无统计（对话后记录）',
  }: {
    title: string;
    bot: { id: string; name: string };
    threadId: string;
    task?: OmbTaskSummary | null;
    compactCmd: string;
    isExternal?: boolean;
    emptyHint?: string;
  },
): Promise<void> {
  const summary = formatContextSummary(task);
  const compactNote = compactCmd && summary
    ? (summary.pct >= 80
      ? `\n- 建议回复 \`${compactCmd}\` 压缩上下文`
      : (summary.pct >= 50 ? `\n- 可回复 \`${compactCmd}\` 压缩上下文` : ''))
    : '';
  const hasBanner = Boolean(sensSink.banner);
  if (!summary) {
    const extHint = isExternal && compactCmd ? `（可回复 \`${compactCmd}\` 压缩）` : '';
    await sensSink.say(hasBanner ? `- **📊 ${title}**：${emptyHint}${extHint}` : `📊 ${title}：${emptyHint}${extHint}`);
    return;
  }
  const usageLine = compactNote || hasBanner
    ? `${!compactNote && hasBanner ? '- ' : ''}**📊 ${title}**：${summary.line}${compactNote}`
    : `📊 ${title}：${summary.line}`;
  await sensSink.say(
    usageLine,
    { botId: bot.id, botName: bot.name, threadId },
  );
}

/** 返回应指向指定 Bot 或群组的命令前缀（非主 Bot / 群组用 `@<名称>`，主 Bot 用触发词）。 */
export function botCommandTarget(bridge: OpenMausBotBridge, botId?: string, botName?: string, { isGroup = false }: { isGroup?: boolean } = {}): string {
  if (botName && (isGroup || (botId && bridge.chiefBotId && botId !== bridge.chiefBotId))) {
    return `@${showBotName(bridge, botId || '', botName, isGroup)}`;
  }
  return bridge.trigger;
}

/** 统一生成外部会话转入自聊时的来源横幅。 */
export function formatOriginBanner(
  chatCtx: { isExternal?: boolean; chatName?: string; originChatId?: string } | null | undefined,
  ctrlChat: string | null | undefined,
  selfChat: string | null | undefined,
  suffix = '',
): string {
  if (!chatCtx?.isExternal || !ctrlChat || ctrlChat !== selfChat) return '';
  const label = chatCtx.chatName || chatCtx.originChatId || '';
  return `**📍 来自「${label}」${suffix}**\n`;
}

/** 构造 `@bot help` 简洁使用说明。 */
export function buildHelpText(bridge: OpenMausBotBridge): string {
  const t = bridge.trigger;
  const brand = bridge.botName || 'co-bot';
  const followUpSec = Math.round(bridge.followUpWindowMs / 1000);
  const generalLines = [
    `**通用（\`${t}\` / \`@Bot名\` / \`@群名\`）**`,
    `- \`${t} <问题>\` / \`${t}!\`：提问 / 外群私密起草`,
    '- `new [话题]` / `task [号]` / `stop`：会话与停止',
    '- `status [群]`：查看状态、上下文与待处理事项（仅单Bot）',
    '- `compact [群]`：压缩上下文（仅单Bot）',
    `- \`bye\`：退出自聊 ${followUpSec}s 免 \`@\` 续聊`,
  ];
  const extCmds = bridge.commandRegistry?.list() ?? [];
  if (extCmds.length) {
    const extList = extCmds.map((c) => `\`${t} ${c.name}\`${c.description ? `（${c.description}）` : ''}`).join('、');
    generalLines.push(`- 扩展指令：${extList}`);
  }
  const ownerLines = [
    `**仅 \`${t}\` 可用**`,
    '- `sendback [ID]`：草稿发回（或引用草稿回 `确认发送`）',
    '- `chats` / `mute|unmute`：管群与静音',
    '- `summary <群>`：跨群纪要',
    '- `bind [项目]`：绑定项目目录',
    '- `delegate <私聊> <问题>`：私聊委托',
  ];
  return [
    `**🤖 ${brand} 常用指南**`,
    ...generalLines,
    '',
    ...ownerLines,
    '',
    '💡 卡片回 `1/2/0` 或 `ok/always/no/skip`',
    `📄 发 \`${t} help\` 获取完整图文指南`,
  ].join('\n');
}

/** 构造命令结果投递器，外部群敏感操作结果自动路由回自聊并携带来源标题。 */
export function makeCommandSink(
  bridge: OpenMausBotBridge,
  chatCtx: BridgeChatContext | null | undefined,
  { sensitive = true }: { sensitive?: boolean } = {},
): CommandSink {
  if (!chatCtx?.isExternal) {
    return {
      chatId: bridge.selfChat,
      banner: '',
      say: (text, route = null, replyTo = null, actions = null) => bridge.say(text, route, replyTo, actions),
      sendFile: (filePath, name, opts = {}) => bridge.sendOutboundFile(filePath, name, opts as Partial<ChannelSendFileInput> & { chatId?: string; replyTo?: string }),
    };
  }
  const ctrlId = typeof bridge.resolveControlChatId === 'function'
    ? bridge.resolveControlChatId(chatCtx)
    : bridge.selfChat;
  const targetId = sensitive ? ctrlId : chatCtx.replyChatId;
  const originBanner = sensitive ? formatOriginBanner(chatCtx, ctrlId, bridge.selfChat, '的指令结果') : '';
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
    sendFile: async (filePath, name, opts = {}) => {
      if (!targetId) return null;
      return bridge.sendOutboundFile(filePath, name, { ...opts, chatId: targetId });
    },
  };
}

/** 停止运行中轮次、清空该 Thread 排队消息并向 OpenMausBot 发送中断请求。 */
export async function stopTarget(
  bridge: OpenMausBotBridge,
  target: { botId: string; botName: string; threadId: string; isGroup?: boolean; originChatId?: string },
  sink: CommandSink | null = null,
  { isExternal = false }: { isExternal?: boolean } = {},
): Promise<void> {
  const say = sink?.say ?? ((t: string, r?: MsgRoute | { targetChatId?: string | null } | null, rt?: string | null, a?: ChannelAction[] | null) => bridge.say(t, r, rt, a));
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
export async function runQueueAction(
  bridge: OpenMausBotBridge,
  {
    raw,
    target,
    quotedRoute,
    sensSink,
    mid,
    quotedId,
    chatCtx,
    cmdTarget,
  }: {
    raw: string;
    target: OmbTargetBot;
    quotedRoute: MsgRoute | null | undefined;
    sensSink: CommandSink;
    mid: string | null;
    quotedId: string | null;
    chatCtx: BridgeChatContext | null;
    cmdTarget: string;
  },
): Promise<boolean> {
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
    await bridge.steerLatestQueue(tid ?? null, sensSink.chatId, { banner: sensSink.banner });
    return true;
  }
  if (/^(cancel|取消排队)$/i.test(raw)) {
    const tid = quotedRoute?.threadId ?? target?.threadId ?? (chatCtx?.isExternal ? null : bridge.focus?.threadId);
    await bridge.cancelLatestQueue(tid ?? null, sensSink.chatId, { banner: sensSink.banner });
    return true;
  }
  return false;
}
