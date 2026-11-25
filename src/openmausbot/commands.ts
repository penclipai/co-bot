import { matchProjectSpec } from '../core/projects.ts';
import { clip } from '../format.ts';
import type { OpenMausBotBridge } from './bridge.ts';
import { formatOmbError, parseChoiceIndex } from './cards.ts';
import {
  botCommandTarget,
  buildHelpText,
  type CommandSink,
  formatContextSummary,
  makeCommandSink,
  replyContextUsage,
  resolveChatOrId,
  runQueueAction,
  showBotName,
  stopTarget,
} from './command-helpers.ts';
import type { BridgeChatContext, MsgRoute, OmbBot, OmbTargetBot } from './types.ts';

export { botCommandTarget, buildHelpText };

const TASK_PICK_TTL = 2 * 60 * 1000;
const parseListChoice = (raw: unknown): number | null => {
  const s = String(raw ?? '').trim();
  return parseChoiceIndex(s) ?? (/^\d+$/.test(s) ? Number(s) : null);
};

async function replyExternalChatContext(
  bridge: OpenMausBotBridge,
  sensSink: CommandSink,
  { extArg, bots, targetBot, cmdTarget }: { extArg: string; bots: OmbBot[]; targetBot: OmbTargetBot; cmdTarget: string },
): Promise<void> {
  const extChat = bridge.resolveKnownChat(extArg);
  if (!extChat) {
    await sensSink.say(`未找到匹配会话「${extArg}」，发 \`${bridge.trigger} chats\` 查看已知会话。`);
    return;
  }
  const entries = [...bridge.chatThreads.values()].filter((v) => v && v.chatId === extChat.id && !v.isGroup);
  const entry = entries.find((v) => v.botId === targetBot.id) ?? entries[0];
  if (!entry) {
    await sensSink.say(`会话「${extChat.name || extChat.id}」尚未建立隔离上下文。`);
    return;
  }
  const fresh = bots.find((b) => b.id === entry.botId) ?? targetBot;
  const freshName = showBotName(bridge, fresh.id, fresh.name);
  const task = (fresh.tasks ?? []).find((t) => (t.threadId ?? t.id) === entry.threadId);
  await replyContextUsage(sensSink, {
    title: `${extChat.name || extChat.id}（${freshName}）隔离`,
    bot: { id: fresh.id, name: freshName },
    threadId: entry.threadId,
    task,
    compactCmd: `${cmdTarget} compact ${extChat.id}`,
    isExternal: true,
    emptyHint: '上下文暂无统计（对话后记录）。',
  });
}

async function handleStatusCommand(
  bridge: OpenMausBotBridge,
  statusArg: string,
  { targetBot, sensSink, extCtx }: { targetBot: OmbTargetBot; sensSink: CommandSink; extCtx: BridgeChatContext | null },
): Promise<void> {
  const isExternal = Boolean(extCtx);
  const [h, { bots = [], groups = [] }, env, sess] = await Promise.all([
    bridge.client.health(),
    bridge.client.listBots(),
    typeof bridge.client.environment === 'function' ? bridge.client.environment().catch(() => null) : null,
    typeof bridge.client.authSession === 'function' ? bridge.client.authSession().catch(() => null) : null,
  ]);
  const visible = bots.filter((b) => !b.hidden);
  const visibleGroups = groups.filter((g) => !g.hidden && !g.dm);
  const chief = visible.find((b) => b.chiefOfStaff) ?? visible[0];
  const activeBot = bots.find((b) => b.id === targetBot?.id) ?? chief;
  const cmdTarget = activeBot ? botCommandTarget(bridge, activeBot.id, activeBot.name) : bridge.trigger;

  if (statusArg) {
    await replyExternalChatContext(bridge, sensSink, {
      extArg: statusArg,
      bots,
      targetBot: activeBot ?? targetBot,
      cmdTarget,
    });
    return;
  }

  const desktopManaged = env?.capabilities?.selfUpdate === 'desktop-managed';
  const doc = h?.doctor;
  const brand = bridge.botName || 'co-bot';
  const deadBots = visible.filter((b) => b.activity === 'dead');
  const headState = chief?.activity === 'dead'
    ? `**🔴 ${brand} 异常（主协调 dead）**`
    : (deadBots.length ? `**🟡 ${brand} 部分异常（${deadBots.length} 个 Bot 离线）**` : `**🟢 ${brand} 在线**`);

  const headerParts = [headState];
  if (desktopManaged && sess?.kind !== 'session') headerParts.push('⚠️ 桌面端未配对');
  if (doc?.problems?.length) headerParts.push(`⚠️ Doctor ${doc.problems.length} 项异常`);
  if (h.box && h.box !== 'off') headerParts.push(`隔离：${h.box}`);
  if (bridge.activeTurns.size > 0) headerParts.push(`活跃轮次：${bridge.activeTurns.size}`);
  if (bridge.isStickyActive()) headerParts.push('连续对话激活中');
  if (bridge.quietQueue.length > 0) headerParts.push(`静默待汇总：${bridge.quietQueue.length} 条`);
  const headerLine = headerParts.join(' · ');

  let ctxBot: OmbBot | OmbTargetBot | undefined = activeBot ?? chief;
  let ctxThreadId = targetBot?.threadId ?? ctxBot?.threadId ?? '';
  let ctxTitle = ctxBot ? `${showBotName(bridge, ctxBot.id, ctxBot.name)} 当前会话` : '当前会话';
  let compactCmd = `${cmdTarget} compact`;
  let missingExt = false;
  if (extCtx) {
    const extEntry = bridge.chatThreads.get(`${extCtx.originChatId}:${targetBot.id}`);
    if (!extEntry) {
      missingExt = true;
    } else {
      ctxBot = bots.find((b) => b.id === extEntry.botId) ?? ctxBot;
      ctxThreadId = extEntry.threadId;
      const ctxBotShown = ctxBot ? showBotName(bridge, ctxBot.id, ctxBot.name) : 'co-bot';
      ctxTitle = `${extCtx.chatName || extCtx.originChatId}（${ctxBotShown}）隔离`;
      compactCmd = `${botCommandTarget(bridge, ctxBot?.id, ctxBot?.name)} compact ${extCtx.originChatId}`;
    }
  }

  const ctxTask = !missingExt && ctxBot
    ? ((ctxBot.tasks ?? []).find((t) => (t.threadId ?? t.id) === ctxThreadId) ?? (isExternal ? null : ctxBot.tasks?.[0]))
    : null;
  const ctxSummary = formatContextSummary(ctxTask);
  const compactHint = ctxSummary
    ? (ctxSummary.pct >= 80
      ? `\n建议回复 \`${compactCmd}\` 压缩上下文`
      : (ctxSummary.pct >= 50 ? `\n可回复 \`${compactCmd}\` 压缩上下文` : ''))
    : '';
  const ctxLine = missingExt && extCtx
    ? `- **${extCtx.chatName || extCtx.originChatId}**：尚未建立独立隔离上下文（发送对话后自动创建）。`
    : (ctxSummary
      ? `- **${ctxTitle}** 上下文：${ctxSummary.line}${compactHint}`
      : `- **${ctxTitle}** 暂无上下文统计（对话后记录）`);

  const sections = [`${headerLine}\n${ctxLine}`];
  if (visible.length) {
    const botLines = visible.map((b) => {
      const role = b.chiefOfStaff ? '（主协调）' : '';
      const act = String(b.activity ?? '').trim();
      const st = act === 'dead'
        ? '🔴 异常(dead)'
        : (b.busy
          ? (act && act.toLowerCase() !== 'busy' ? `运行中 · ${act}` : '运行中')
          : '空闲');
      const mod = b.modelSelection?.model ? ` · \`${b.modelSelection.model}\`` : '';
      const apv = b.approvalMode && b.approvalMode !== 'ask' ? ` · 审批:${b.approvalMode}` : '';
      const waitTm = b.waitingForTeammates ? ' · 等待队友' : '';
      return `- **${showBotName(bridge, b.id, b.name)}**${role} · ${st}${mod}${apv}${waitTm}`;
    });
    sections.push(`**🤖 协作团队（${visible.length}）**\n${botLines.join('\n')}`);
  }
  if (visibleGroups.length) {
    const gLines = visibleGroups.map((g) => {
      const count = Array.isArray(g.memberIds) ? `${g.memberIds.length} 成员` : '协作群';
      return `- **${g.name}**（${count} · ${g.busy ? '讨论中' : '空闲'}）`;
    });
    sections.push(`**👥 协作群组（${visibleGroups.length}，用 \`@群名\` 发起协作）**\n${gLines.join('\n')}`);
  }

  const route = ctxSummary && ctxBot
    ? { botId: ctxBot.id, botName: showBotName(bridge, ctxBot.id, ctxBot.name), threadId: ctxThreadId }
    : null;
  await sensSink.say(sections.join('\n\n'), route);
}

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

  if ((!low && !quotedId && !hasAttachments) || /^(?:help|帮助|\?|？)$/i.test(raw)) {
    await replySink.say(buildHelpText(bridge));
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
      : (quotedRoute ?? [...bridge.activeTurns.values()].at(-1) ?? bridge.focus);
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

  // 静音 / 解除静音：@bot mute|静音 [群] / @bot unmute|解除静音 [群]
  const muteM = raw.match(/^(mute|静音|unmute|解除静音)(?:\s+([\s\S]+))?$/i);
  if (muteM) {
    const isMute = /^(?:mute|静音)$/i.test(muteM[1]);
    const arg = (muteM[2] ?? '').trim();
    if (!arg && !isExternal) {
      await sensSink.say(`用法：\`${bridge.trigger} ${isMute ? 'mute' : 'unmute'} <群名|chatId>\`，发 \`${bridge.trigger} chats\` 查看已知会话。`);
      return true;
    }
    const target = resolveChatOrId(bridge, arg, { isExternal, chatCtx });
    if (!target) {
      await sensSink.say(`未找到匹配会话「${arg}」，发 \`${bridge.trigger} chats\` 查看已知会话。`);
      return true;
    }
    if (isMute) {
      if (target.id === 'self' || target.id === bridge.selfChat) {
        await sensSink.say('⚠️ 不能静音自聊控制会话。');
        return true;
      }
      bridge.setChatMuted(target.id, true);
      await sensSink.say(`🔇 已静音「${target.name}」（\`${target.id}\`），此后在该会话发 \`@bot\` 将不再触发，发 \`${bridge.trigger} unmute ${target.id}\` 可恢复。`);
    } else {
      bridge.setChatAllowed(target.id);
      await sensSink.say(`✅ 已解除「${target.name}」（\`${target.id}\`）的静音，可正常使用 \`@bot\`。`);
    }
    return true;
  }

  // 多会话查看与模式切换：@bot chats [self|all|reset]
  const chatsCmdM = raw.match(/^chats(?:\s+([\s\S]+))?$/i);
  if (chatsCmdM) {
    const sub = (chatsCmdM[1] ?? '').trim().toLowerCase();
    if (!sub) {
      const pol = bridge.getChatPolicy();
      const known = bridge.listKnownChats().filter((c) => c.type !== 'self');
      const modeLabel = pol.mode === 'self_only' ? '仅自聊（self_only）' : '本人任意群/私聊（owner_everywhere）';
      if (!known.length) {
        await sensSink.say(
          `**💬 多会话触发策略**：${modeLabel}\n- 当前暂无外部群/私聊记录；在群聊发消息后即可在此查看或 \`${bridge.trigger} mute/unmute <群名|chatId>\`。`,
        );
        return true;
      }
      const lines = known.map((c) => {
        const flag = !c.allowed ? (c.muted ? '🔇 已静音' : '⛔ 策略禁止') : '✅ 允许';
        const kind = c.type === 'group' ? '群' : '私聊';
        const thr = c.threadCount ? ` · ${c.threadCount} 隔离会话` : '';
        return `- **${c.name}**（\`${c.id}\` · ${kind}）· ${flag} · 缓存 ${c.cachedMessages} 条${thr}`;
      });
      await sensSink.say(
        `**💬 多会话管理**（当前模式：${modeLabel}）\n${lines.join('\n')}\n\n指令：\`${bridge.trigger} mute|unmute <群名|id>\`、\`${bridge.trigger} chats self|all|reset\``,
      );
      return true;
    }
    if (sub === 'reset') {
      bridge.resetChatPolicy();
      await sensSink.say('🔄 已重置运行期会话静音与模式覆盖，恢复 `config.json` 配置。');
      return true;
    }
    if (sub === 'self') {
      bridge.setChatMode('self_only');
      await sensSink.say('🔒 已切换为**仅自聊模式**（外部群/私聊仍保留内存上下文但暂停响应 `@bot`，发 `chats all` 恢复）。');
      return true;
    }
    if (sub === 'all') {
      bridge.setChatMode('owner_everywhere');
      await sensSink.say('🌐 已切换为**本人全局可用模式**（外部群/私聊按黑白名单与静音状态响应）。');
      return true;
    }
    await sensSink.say(`用法：\`${bridge.trigger} chats [self|all|reset]\` 或 \`${bridge.trigger} mute|unmute <群名|id>\``);
    return true;
  }

  // 跨群只读纪要：@bot summary <群名|id> [条数] [关注问题]
  const sumM = raw.match(/^(?:summary|汇总|纪要)(?:\s+([\s\S]+))?$/i);
  if (sumM) {
    const restRaw = (sumM[1] ?? '').trim();
    const known = bridge.listKnownChats().filter((c) => c.type !== 'self');
    let targetChat: { id: string; type: 'group' | 'direct' | 'self' | 'system'; name: string } | null = null;
    let tail = restRaw;

    if (restRaw) {
      const byNameLen = [...known].sort((a, b) => String(b.name || '').length - String(a.name || '').length);
      for (const c of byNameLen) {
        for (const cand of [c.name, c.id].filter(Boolean)) {
          const esc = String(cand).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const m = restRaw.match(new RegExp(`^${esc}(?:\\s+([\\s\\S]*))?$`, 'i'));
          if (m) {
            targetChat = c;
            tail = (m[1] ?? '').trim();
            break;
          }
        }
        if (targetChat) break;
      }
      if (!targetChat && !(extCtx && /^-?\d+(?:\s|$)/.test(restRaw))) {
        const sp = restRaw.match(/^(\S+)(?:\s+([\s\S]*))?$/);
        const fuzzy = sp ? bridge.resolveKnownChat(sp[1]) : null;
        if (fuzzy) {
          targetChat = fuzzy;
          tail = (sp?.[2] ?? '').trim();
        }
      }
    }

    if (!targetChat && extCtx) {
      targetChat = {
        id: extCtx.originChatId,
        type: extCtx.chatType || 'group',
        name: extCtx.chatName || extCtx.originChatId,
      };
      tail = restRaw;
    }

    if (!targetChat) {
      const avail = known.slice(0, 6).map((c) => `「${c.name}」(\`${c.id}\`)`).join('、') || '暂无';
      await sensSink.say(`用法：\`${bridge.trigger} summary <群名|chatId> [消息条数] [关注重点]\`\n当前已有上下文会话：${avail}`);
      return true;
    }

    let limit = 30;
    let focusQuestion = tail;
    const limM = tail.match(/^(-?\d+)(?:\s+([\s\S]*))?$/);
    if (limM) {
      const parsedLimit = Number(limM[1]);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
        await sensSink.say(`⚠️ 汇总条数需为 1～200 之间的整数（收到 \`${limM[1]}\`）。`);
        return true;
      }
      limit = parsedLimit;
      focusQuestion = (limM[2] ?? '').trim();
    }

    const built = await bridge.buildExternalSummaryPrompt(targetChat, { limit, focusQuestion });
    if (!built.count) {
      await sensSink.say(`会话「${targetChat.name || targetChat.id}」暂时没有可汇总的对话记录。`);
      return true;
    }
    if (isExternal && !bridge.selfChat) {
      return true;
    }
    const selfBot = await bridge.resolveSelfBotThread(targetBot);
    await bridge.dispatchToBot(
      selfBot,
      built.text,
      mid,
      null,
      null,
      {
        isExternal: false,
        originChatId: bridge.selfChat,
        chatType: 'self',
        replyChatId: bridge.selfChat,
        controlChatId: bridge.selfChat,
        replyToImMsgId: null,
        originQuoteId: null,
        privateReply: false,
        silentProgress: false,
        preformattedHeader: built.header,
        ev: null,
      },
    );
    return true;
  }

  // 自聊私密草稿确认回发：@bot sendback [draftId | 改写内容 | confirm]
  const sendbackM = raw.match(/^(?:sendback|发回)(?:\s+([\s\S]+))?$/i);
  if (sendbackM) {
    if (isExternal) {
      await sensSink.say(`ℹ️ 请在**自聊**中引用或回复 \`${bridge.trigger} sendback\` 预览确认后再发回当前会话，避免误发。`);
      return true;
    }
    const arg = (sendbackM[1] ?? '').trim();
    if (/^(confirm|确认|发送|send)$/i.test(arg)) {
      if (!bridge.pendingSendBack) {
        await sensSink.say(`当前没有待确认发回的草稿（请先使用 \`${bridge.trigger} sendback\` 选择草稿，或可能已发回）。`);
        return true;
      }
      await bridge.confirmSendBack();
      return true;
    }
    let draftId: string | null = null;
    let overrideText = arg;
    const tokM = arg.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    if (tokM) {
      const first = tokM[1];
      if (bridge.privateDrafts.has(first)) {
        draftId = first;
        overrideText = (tokM[2] ?? '').trim();
      } else if (/^draft_[A-Za-z0-9_-]+$/i.test(first)) {
        await sensSink.say(`⚠️ 未找到或已过期的草稿 \`${first}\`，请引用最新草稿回复 \`${bridge.trigger} sendback\`。`);
        return true;
      }
    }
    const draft = bridge.resolvePrivateDraft({ quotedId, draftId });
    if (!draft) {
      const msg = draftId
        ? `⚠️ 未找到或已过期的草稿 \`${draftId}\`，请引用最新草稿回复 \`${bridge.trigger} sendback\`。`
        : `暂无待发回的私密草稿（需先在外部群/私聊用 \`${bridge.trigger}!\` 起草）。`;
      await sensSink.say(msg);
      return true;
    }
    await bridge.requestSendBack(draft, overrideText);
    return true;
  }

  // 项目目录绑定：@bot bind [项目名|路径 | unbind [群]]
  const bindM = raw.match(/^(?:bind|绑定)(?:\s+([\s\S]+))?$/i);
  if (bindM) {
    const sub = (bindM[1] ?? '').trim();
    const curChatId = extCtx ? extCtx.originChatId : bridge.selfChat;
    const curChatName = extCtx ? (extCtx.chatName || curChatId) : '自聊';
    if (!sub || /^(show|list|ls|查看|列表)$/i.test(sub)) {
      const bindings = bridge.listProjectBindings();
      const cur = bindings.find((b) => b.chatId === curChatId);
      const cfgList = Array.isArray(bridge.projects) ? bridge.projects : [];
      const cfgText = cfgList.length
        ? cfgList.map((p) => `- \`${p.name}\` → \`${p.path}\`${p.aliases?.length ? `（别名：${p.aliases.join('、')}）` : ''}`).join('\n')
        : '（未在 config.json 配置 projects 白名单，可直接绑定本地目录路径）';
      const bindLines = bindings.length
        ? bindings.map((b) => `- \`${b.chatId}\` → **${b.name}**（\`${b.path}\`）`).join('\n')
        : '暂无会话绑定记录';
      await sensSink.say(
        `**📂 项目绑定（${curChatName}）**\n` +
        `- 当前会话：${cur ? `**${cur.name}**（\`${cur.path}\`）` : '未绑定'}\n\n` +
        `**已绑定会话（${bindings.length}）**\n${bindLines}\n\n` +
        `**可选项目列表**\n${cfgText}\n\n` +
        `用法：\`${bridge.trigger} bind <项目|路径>\`、\`bind <会话> <项目|路径>\` 或 \`bind unbind\``,
      );
      return true;
    }
    const unbindM = sub.match(/^(?:unbind|clear|off|del|remove|解绑|清除)(?:\s+([\s\S]+))?$/i);
    if (unbindM) {
      const who = (unbindM[1] ?? '').trim();
      const targetChat = who
        ? resolveChatOrId(bridge, who, { isExternal, chatCtx })
        : { id: curChatId, name: curChatName };
      if (!targetChat?.id) {
        await sensSink.say(`未找到匹配会话「${who}」，发 \`${bridge.trigger} chats\` 查看已知会话。`);
        return true;
      }
      const removed = bridge.unbindChatProject(targetChat.id);
      await sensSink.say(removed
        ? `🔓 已解除「${targetChat.name || targetChat.id}」的项目绑定。`
        : `会话「${targetChat.name || targetChat.id}」当前未绑定项目。`);
      return true;
    }
    let targetChat: { id: string; name: string } = { id: curChatId, name: curChatName };
    let spec = sub;
    let hasTwoArgs = false;
    const twoM = sub.match(/^(\S+)\s+([\s\S]+)$/);
    if (twoM) {
      const maybeChat = resolveChatOrId(bridge, twoM[1]);
      if (maybeChat && (!isExternal || maybeChat.id === curChatId)) {
        targetChat = maybeChat;
        spec = twoM[2].trim();
        hasTwoArgs = true;
      }
    }
    if (hasTwoArgs && /^(?:unbind|clear|off|del|remove|解绑|清除)$/i.test(spec)) {
      const removed = bridge.unbindChatProject(targetChat.id);
      await sensSink.say(removed
        ? `🔓 已解除「${targetChat.name || targetChat.id}」的项目绑定。`
        : `会话「${targetChat.name || targetChat.id}」当前未绑定项目。`);
      return true;
    }
    const matched = matchProjectSpec(spec, bridge.projects);
    if (!matched.ok || !matched.project) {
      if (!isExternal && !hasTwoArgs && bridge.resolveKnownChat(sub)) {
        await sensSink.say(`用法：\`${bridge.trigger} bind ${sub} <项目|路径>\` 或 \`${bridge.trigger} bind ${sub} unbind\``);
        return true;
      }
      await sensSink.say(`⚠️ 绑定失败：${matched.error ?? '未知错误'}`);
      return true;
    }
    if (!targetChat?.id) {
      await sensSink.say('尚未获知目标会话 ID，请先发一条消息或显式指定会话。');
      return true;
    }
    bridge.bindChatProject(targetChat.id, matched.project);
    await sensSink.say(`🔗 已将「${targetChat.name || targetChat.id}」绑定到项目 **${matched.project.name}**（\`${matched.project.path}\`）。`);
    return true;
  }

  // 极简 2 态 C2C 委托：@bot delegate <会话名|chatId> [proj:<项目>] <问题>
  const delM = raw.match(/^(?:delegate|委托)(?:\s+([\s\S]+))?$/i);
  if (delM) {
    const rest = (delM[1] ?? '').trim();
    const m = rest.match(/^(\S+)\s+([\s\S]+)$/);
    if (!m) {
      await sensSink.say(`用法：\`${bridge.trigger} delegate <会话名|chatId> [proj:<项目>] <问题>\``);
      return true;
    }
    const targetChat = bridge.resolveKnownChat(m[1]);
    if (!targetChat?.id || targetChat.id === bridge.selfChat) {
      await sensSink.say(`未找到可委托的外部群/联系人「${m[1]}」，发 \`${bridge.trigger} chats\` 查看已知会话。`);
      return true;
    }
    let qRest = m[2].trim();
    let project = '';
    const projM = qRest.match(/^proj:(\S+)\s+([\s\S]+)$/i);
    if (projM) {
      project = projM[1].trim();
      qRest = projM[2].trim();
    }
    if (!qRest) {
      await sensSink.say(`请提供具体的协作问题，例如：\`${bridge.trigger} delegate ${targetChat.id} 帮忙看下 order 项目的超时原因\``);
      return true;
    }
    const sentRes = await bridge.sendDelegation(targetChat, qRest, { project });
    if (!sentRes?.ok) {
      await sensSink.say(`❌ 发起委托失败：${sentRes?.error || '发送失败'}`);
      return true;
    }
    await sensSink.say(
      `🤝 已向「${targetChat.name || targetChat.id}」发起协作委托 \`${sentRes.id}\`${project ? `（项目：\`${project}\`）` : ''}；对方如启用协作者响应将自动回传结果，否则将保留为普通 IM 消息。`,
    );
    return true;
  }

  return false;
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
        const { bots = [] } = await bridge.client.listBots();
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
          title: `${freshName} 当前会话`,
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
    } catch (e) {
      await sensSink.say(`❌ 操作失败：${formatOmbError(e)}`);
      return true;
    }
    const newThreadId = created?.task?.threadId ?? created?.bot?.threadId ?? created?.group?.threadId ?? activeTarget.threadId;
    bridge.contextWarnedThreads.delete(newThreadId);
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
      bridge.contextWarnedThreads.delete(activeTarget.threadId);
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
