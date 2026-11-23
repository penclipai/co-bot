import { clip } from '../format.js';
import { matchProjectSpec } from '../core/projects.js';
import { formatOmbError, parseChoiceIndex } from './cards.js';
import {
  botCommandTarget,
  buildHelpText,
  makeCommandSink,
  replyContextUsage,
  resolveChatOrId,
  runQueueAction,
  showBotName,
  stopTarget,
} from './command-helpers.js';

export { botCommandTarget, buildHelpText };

const TASK_PICK_TTL = 2 * 60 * 1000;
const parseListChoice = (raw) => {
  const s = String(raw ?? '').trim();
  return parseChoiceIndex(s) ?? (/^\d+$/.test(s) ? Number(s) : null);
};

async function handleDefaultCommand(bridge, raw, low, { quotedRoute, targetBot, mid, quotedId, hasAttachments = false, chatCtx }) {
  const isExternal = Boolean(chatCtx?.isExternal);
  const replySink = makeCommandSink(bridge, chatCtx, { sensitive: false });
  const sensSink = makeCommandSink(bridge, chatCtx, { sensitive: true });

  const helpM = raw.match(/^(?:help|帮助|\?|？)(?:\s+([\s\S]+))?$/i);
  if ((!low && !quotedId && !hasAttachments) || helpM) {
    await replySink.say(buildHelpText(bridge, helpM?.[1] ?? ''));
    return true;
  }

  if (/^(bots?|成员|列表|groups?|群组)$/.test(low)) {
    const { bots = [], groups = [] } = await bridge.client.listBots();
    const visible = bots.filter((b) => !b.hidden);
    const visibleGroups = groups.filter((g) => !g.hidden && !g.dm);
    if (!visible.length && !visibleGroups.length) {
      await sensSink.say('当前暂无可用协作 Bot。');
      return true;
    }
    const parts = [];
    if (visible.length) {
      const lines = visible.map((b) => {
        const role = b.chiefOfStaff ? '（主协调）' : '';
        const st = b.activity === 'dead'
          ? '🔴 异常(dead)'
          : (b.busy ? `运行中 · ${b.activity || 'busy'}` : '空闲');
        const mod = b.modelSelection?.model ? ` · \`${b.modelSelection.model}\`` : '';
        const apv = b.approvalMode ? ` · 审批:${b.approvalMode}` : '';
        const waitTm = b.waitingForTeammates ? ' · 等待队友' : '';
        return `- **${showBotName(bridge, b.id, b.name)}**${role} · ${st}${mod}${apv}${waitTm}`;
      });
      parts.push(`🤖 **${bridge.botName || 'co-bot'} 协作团队（${visible.length}）**\n${lines.join('\n')}`);
    }
    if (visibleGroups.length) {
      const gLines = visibleGroups.map((g) => {
        const count = Array.isArray(g.memberIds) ? `${g.memberIds.length} 成员` : '协作群';
        const st = g.busy ? '讨论中' : '空闲';
        return `- **${g.name}**（${count} · ${st}）`;
      });
      parts.push(`👥 **协作群组（${visibleGroups.length}，用 \`@群名\` 发起协作）**\n${gLines.join('\n')}`);
    }
    await sensSink.say(parts.join('\n\n'));
    return true;
  }

  if (/^(status|状态)$/.test(low)) {
    const [h, { bots = [], groups = [] }, env, sess] = await Promise.all([
      bridge.client.health(),
      bridge.client.listBots(),
      typeof bridge.client.environment === 'function' ? bridge.client.environment().catch(() => null) : null,
      typeof bridge.client.authSession === 'function' ? bridge.client.authSession().catch(() => null) : null,
    ]);
    const visible = bots.filter((b) => !b.hidden);
    const visibleGroups = groups.filter((g) => !g.hidden && !g.dm);
    const chief = visible.find((b) => b.chiefOfStaff) ?? visible[0];
    const desktopManaged = env?.capabilities?.selfUpdate === 'desktop-managed';
    const authState = desktopManaged
      ? (sess?.kind === 'session' ? '桌面端（已配对）' : '桌面端（⚠️ 未配对）')
      : (sess?.kind === 'session' ? 'CLI 模式（已配对）' : 'CLI 模式（本地免配对）');
    const stickyNote = bridge.isStickyActive() ? ' · 连续对话激活中' : '';
    const groupNote = visibleGroups.length ? ` · 协作群组：${visibleGroups.length} 个` : '';
    const doc = h?.doctor;
    const docNote = doc ? ` · Doctor：${doc.problems?.length ? `⚠️ ${doc.problems.length} 个异常` : `正常（${doc.checked ?? 0}项）`}` : '';
    const brand = bridge.botName || 'co-bot';
    const chiefShown = chief ? showBotName(bridge, chief.id, chief.name) : '无';
    const deadBots = visible.filter((b) => b.activity === 'dead');
    const chiefDead = chief?.activity === 'dead';
    const headState = chiefDead
      ? `🔴 **${brand} 异常（主协调 dead）**`
      : (deadBots.length ? `🟡 **${brand} 部分异常（${deadBots.length} 个 Bot 离线）**` : `🟢 **${brand} 在线**`);
    await sensSink.say(
      `${headState} · 隔离模式：${h.box ?? 'off'} · 认证：${authState}${docNote}\n` +
      `协作 Bot：${visible.length} 个${groupNote} · 主协调：**${chiefShown}**（风格：${chief?.replyStyle ?? 'default'}，审批：${chief?.approvalMode ?? 'ask'}）· 活跃轮次：${bridge.activeTurns.size}${stickyNote} · 引擎 v${h.version ?? '?'}` +
      (bridge.quietQueue.length ? ` · 静默待汇总：${bridge.quietQueue.length} 条` : ''),
    );
    return true;
  }

  if (/^(stop|停止|停|interrupt)$/.test(low)) {
    const scoped = targetBot ? {
      botId: targetBot.id,
      botName: targetBot.name,
      threadId: targetBot.threadId,
      isGroup: Boolean(targetBot.isGroup),
      ...(isExternal ? { originChatId: chatCtx.originChatId } : {}),
    } : null;
    const rawTarget = isExternal
      ? (quotedRoute ?? [...bridge.activeTurns.values()].find((t) => t.chatCtx?.originChatId === chatCtx.originChatId) ?? scoped)
      : (quotedRoute ?? [...bridge.activeTurns.values()].at(-1) ?? bridge.focus);
    const target = rawTarget && isExternal && !rawTarget.originChatId
      ? { ...rawTarget, originChatId: chatCtx.originChatId }
      : rawTarget;
    if (!target) { await sensSink.say('当前没有运行中或最近对话的 Bot。'); return true; }
    try {
      await stopTarget(bridge, target, sensSink, { isExternal });
    } catch (e) {
      await sensSink.say(`❌ 操作失败：${formatOmbError(e)}`);
    }
    return true;
  }

  if (/^(bye|退下|结束对话|退出对话)$/.test(low)) {
    if (isExternal) {
      await sensSink.say('👋 外部群/私聊仅在 `@bot` 或引用 Bot 回复时触发，不会开启免 `@` 粘性。');
      return true;
    }
    bridge.lastBotReplyAt = 0;
    await replySink.say('👋 已结束连续对话，之后普通消息将作为自聊笔记不再打扰。');
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

  if (/^(digest|汇总)$/i.test(low)) {
    if (isExternal) {
      await sensSink.say('🔕 静默汇总仅可在自聊查看。');
      return true;
    }
    const n = await bridge.flushQuietDigest();
    if (!n) await replySink.say('当前没有静默积压消息。');
    return true;
  }

  // 动态管群与策略切换：@bot chats / @bot chat mute|allow|mode <...> / @bot 静音 <群>
  const chatShortM = raw.match(/^(静音|取消静音|解除静音)(?:\s+([\s\S]+))?$/i);
  const chatsCmdM = !chatShortM ? raw.match(/^(?:chats?|群列表|会话策略)(?:\s+([\s\S]+))?$/i) : null;
  if (chatShortM || chatsCmdM) {
    if (chatShortM) {
      const isMute = chatShortM[1] === '静音';
      const target = resolveChatOrId(bridge, chatShortM[2], { isExternal, chatCtx });
      if (!target) {
        await sensSink.say(`未找到匹配会话「${chatShortM[2] ?? ''}」，发 \`${bridge.trigger} chats\` 查看已知会话。`);
        return true;
      }
      if (isMute) {
        if (target.id === 'self' || target.id === bridge.selfChat) {
          await sensSink.say('⚠️ 不能静音自聊控制会话。');
          return true;
        }
        bridge.setChatMuted(target.id, true);
        await sensSink.say(`🔇 已静音「${target.name}」（\`${target.id}\`），此后在该会话发 \`@bot\` 将不再触发，发 \`${bridge.trigger} chat allow ${target.id}\` 可恢复。`);
      } else {
        bridge.setChatAllowed(target.id);
        await sensSink.say(`✅ 已允许「${target.name}」（\`${target.id}\`）使用 \`@bot\`。`);
      }
      return true;
    }

    const sub = (chatsCmdM[1] ?? '').trim();
    if (!sub || /^(list|ls|查看|列表)$/i.test(sub)) {
      const pol = bridge.getChatPolicy();
      const known = bridge.listKnownChats().filter((c) => c.type !== 'self');
      const modeLabel = pol.mode === 'self_only' ? '仅自聊（self_only）' : '本人任意群/私聊（owner_everywhere）';
      if (!known.length) {
        await sensSink.say(
          `💬 **多会话触发策略**：${modeLabel}\n当前暂无外部群/私聊记录；在群聊发消息后即可在此查看或 \`${bridge.trigger} chat mute/allow <群名|chatId>\`。`,
        );
        return true;
      }
      const lines = known.map((c) => {
        const flag = !c.allowed ? (c.muted ? '🔇 已静音' : '⛔ 策略禁止') : '✅ 允许';
        const kind = c.type === 'group' ? '群' : '私聊';
        const thr = c.threadCount ? ` · ${c.threadCount} 隔离会话` : '';
        return `- **${c.name}**（\`${c.id}\` · ${kind}）· ${flag} · 缓存 ${c.cachedMessages} 条${thr}`;
      });
      const firstExt = known[0];
      const actions = firstExt
        ? [
            firstExt.allowed
              ? { label: `静音 ${clip(firstExt.name, 10)}`, text: `${bridge.trigger} chat mute ${firstExt.id}` }
              : { label: `恢复 ${clip(firstExt.name, 10)}`, text: `${bridge.trigger} chat allow ${firstExt.id}`, kind: 'primary' },
            pol.mode === 'self_only'
              ? { label: '切回全局', text: `${bridge.trigger} chat mode owner_everywhere` }
              : { label: '仅自聊模式', text: `${bridge.trigger} chat mode self_only` },
          ]
        : [];
      await sensSink.say(
        `💬 **多会话管理**（当前模式：${modeLabel}）\n${lines.join('\n')}\n\n指令：\`${bridge.trigger} chat mute|allow <群名|id>\`、\`chat mode self_only|everywhere|reset\``,
        null,
        null,
        actions,
      );
      return true;
    }

    const opM = sub.match(/^(mute|off|disable|静音|关闭|allow|unmute|on|enable|开启|允许|解除静音|mode|模式|reset|重置)(?:\s+([\s\S]+))?$/i);
    if (!opM) {
      await sensSink.say(`用法：\`${bridge.trigger} chats\`、\`${bridge.trigger} chat mute|allow <群名|id>\` 或 \`${bridge.trigger} chat mode self_only|everywhere|reset\``);
      return true;
    }
    const op = opM[1].toLowerCase();
    const arg = (opM[2] ?? '').trim();
    if (/^(reset|重置)$/.test(op)) {
      bridge.resetChatPolicy();
      await sensSink.say('🔄 已重置运行期会话静音与模式覆盖，恢复 `config.json` 配置。');
      return true;
    }
    if (/^(mode|模式)$/.test(op)) {
      if (!arg || /^(reset|重置)$/.test(arg)) {
        bridge.setChatMode(null);
        await sensSink.say(`🔄 已恢复全局触发模式为配置默认值（\`${bridge.chats.mode}\`）。`);
        return true;
      }
      if (/^(self_only|self|仅自聊|仅自己)$/i.test(arg)) {
        bridge.setChatMode('self_only');
        await sensSink.say('🔒 已切换为**仅自聊模式**（外部群/私聊仍保留内存上下文但暂停响应 `@bot`，发 `chat mode everywhere` 恢复）。');
        return true;
      }
      if (/^(owner_everywhere|everywhere|all|全局|全部|开启)$/i.test(arg)) {
        bridge.setChatMode('owner_everywhere');
        await sensSink.say('🌐 已切换为**本人全局可用模式**（外部群/私聊按黑白名单与静音状态响应）。');
        return true;
      }
      await sensSink.say('可用模式：`owner_everywhere`（全局）、`self_only`（仅自聊）或 `reset`。');
      return true;
    }

    const target = resolveChatOrId(bridge, arg, { isExternal, chatCtx });
    if (!target) {
      await sensSink.say(`未找到匹配会话「${arg}」，发 \`${bridge.trigger} chats\` 查看已知会话 ID。`);
      return true;
    }
    if (/^(mute|off|disable|静音|关闭)$/.test(op)) {
      if (target.id === 'self' || target.id === bridge.selfChat) {
        await sensSink.say('⚠️ 不能静音自聊控制会话。');
        return true;
      }
      bridge.setChatMuted(target.id, true);
      await sensSink.say(`🔇 已静音「${target.name}」（\`${target.id}\`），发 \`${bridge.trigger} chat allow ${target.id}\` 可恢复。`);
    } else {
      bridge.setChatAllowed(target.id);
      await sensSink.say(`✅ 已允许「${target.name}」（\`${target.id}\`）使用 \`@bot\`。`);
    }
    return true;
  }

  // 跨群只读纪要：@bot summary <群名|id> [条数] [关注问题] / @bot 汇总|纪要 <群名>
  const sumM = raw.match(/^(?:summary|recap|群汇总|总结群|汇总|纪要)(?:\s+([\s\S]+))?$/i);
  if (sumM) {
    const restRaw = (sumM[1] ?? '').trim();
    const known = bridge.listKnownChats().filter((c) => c.type !== 'self');
    let targetChat = null;
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
      if (!targetChat) {
        const sp = restRaw.match(/^(\S+)(?:\s+([\s\S]*))?$/);
        const fuzzy = sp ? bridge.resolveKnownChat(sp[1]) : null;
        if (fuzzy) {
          targetChat = fuzzy;
          tail = (sp[2] ?? '').trim();
        }
      }
    }

    if (!targetChat && isExternal) {
      targetChat = {
        id: chatCtx.originChatId,
        type: chatCtx.chatType || 'group',
        name: chatCtx.chatName || chatCtx.originChatId,
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
        preformattedHeader: built.header,
        ev: null,
      },
    );
    return true;
  }

  // 自聊私密草稿确认回发：@bot sendback [draftId | 改写内容 | confirm]
  const sendbackM = raw.match(/^(?:sendback|发回原群|发回)(?:\s+([\s\S]+))?$/i);
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
    let draftId = null;
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
    const curChatId = isExternal ? chatCtx.originChatId : bridge.selfChat;
    const curChatName = isExternal ? (chatCtx.chatName || curChatId) : '自聊';
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
        `📂 **当前会话（${curChatName}）项目绑定**：${cur ? `**${cur.name}**（\`${cur.path}\`）` : '未绑定'}\n\n` +
        `**已绑定会话（${bindings.length}）**：\n${bindLines}\n\n` +
        `**可选项目列表**：\n${cfgText}\n\n` +
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
    let targetChat = { id: curChatId, name: curChatName };
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
    if (!matched.ok) {
      if (!isExternal && !hasTwoArgs && bridge.resolveKnownChat(sub)) {
        await sensSink.say(`用法：\`${bridge.trigger} bind ${sub} <项目|路径>\` 或 \`${bridge.trigger} bind ${sub} unbind\``);
        return true;
      }
      await sensSink.say(`⚠️ 绑定失败：${matched.error}`);
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
  const delM = raw.match(/^(?:delegate|委托|协作)(?:\s+([\s\S]+))?$/i);
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
export async function handleCommand(bridge, cmdText, { isDefault, targetBot, quotedRoute, mid, quotedId, hasAttachments = false, chatCtx = null }) {
  const raw = cmdText.trim();
  const low = raw.toLowerCase();
  const isExternal = Boolean(chatCtx?.isExternal);
  const sensSink = makeCommandSink(bridge, chatCtx, { sensitive: true });
  const replySink = makeCommandSink(bridge, chatCtx, { sensitive: false });

  if (isDefault && await handleDefaultCommand(bridge, raw, low, { quotedRoute, targetBot, mid, quotedId, hasAttachments, chatCtx })) return true;

  const activeTarget = !isDefault
    ? targetBot
    : (quotedRoute
      ? { id: quotedRoute.botId, name: quotedRoute.botName, threadId: quotedRoute.threadId, isGroup: Boolean(quotedRoute.isGroup) }
      : targetBot);
  const isGroup = Boolean(activeTarget.isGroup);
  const shownTargetName = showBotName(bridge, activeTarget.id, activeTarget.name, isGroup);
  const cmdTarget = isGroup ? `@${shownTargetName}` : botCommandTarget(bridge, activeTarget.id, activeTarget.name);

  if (!isDefault) {
    if (/^(stop|停止|停|interrupt)$/i.test(raw)) {
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
  }

  const singleBotOnlyHint = async () => {
    await sensSink.say(`ℹ️ 群组「${activeTarget.name}」不支持该单 Bot 指令，请直接 \`@具体Bot名\` 操作。`);
    return true;
  };

  const ctxCmdM = raw.match(/^(?:context|ctx|usage|上下文)(?:\s+([\s\S]+))?$/i);
  if (ctxCmdM) {
    if (isGroup) return singleBotOnlyHint();
    const ctxArg = (ctxCmdM[1] ?? '').trim();
    try {
      const { bots } = await bridge.client.listBots();
      if (ctxArg) {
        const extChat = bridge.resolveKnownChat(ctxArg);
        if (!extChat) {
          await sensSink.say(`未找到匹配会话「${ctxArg}」，发 \`${bridge.trigger} chats\` 查看已知会话。`);
          return true;
        }
        const entries = [...bridge.chatThreads.values()].filter((v) => v && v.chatId === extChat.id && !v.isGroup);
        const entry = entries.find((v) => v.botId === activeTarget.id) ?? entries[0];
        if (!entry) {
          await sensSink.say(`会话「${extChat.name || extChat.id}」尚未建立隔离上下文。`);
          return true;
        }
        const fresh = bots.find((b) => b.id === entry.botId) ?? activeTarget;
        const freshName = showBotName(bridge, fresh.id, fresh.name);
        const task = (fresh.tasks ?? []).find((t) => (t.threadId ?? t.id) === entry.threadId);
        await replyContextUsage(sensSink, {
          title: `${extChat.name || extChat.id}（${freshName}）隔离`,
          bot: { ...fresh, name: freshName },
          threadId: entry.threadId,
          task,
          compactCmd: `${cmdTarget} compact ${extChat.id}`,
          compactLabel: '压缩该群会话',
          isExternal: true,
          emptyHint: '上下文暂无统计（对话后记录）。',
        });
        return true;
      }
      if (isExternal && !bridge.chatThreads.has(`${chatCtx.originChatId}:${activeTarget.id}`)) {
        await sensSink.say(`会话「${chatCtx.chatName || chatCtx.originChatId}」尚未建立独立隔离上下文（发送对话后自动创建）。`);
        return true;
      }
      const fresh = bots.find((b) => b.id === activeTarget.id) ?? activeTarget;
      const freshName = showBotName(bridge, fresh.id, fresh.name);
      const task = (fresh.tasks ?? []).find((t) => (t.threadId ?? t.id) === activeTarget.threadId) ?? fresh.tasks?.[0];
      const compactTarget = botCommandTarget(bridge, fresh.id, fresh.name);
      await replyContextUsage(sensSink, {
        title: `${freshName} 当前会话`,
        bot: { ...fresh, name: freshName },
        threadId: activeTarget.threadId,
        task,
        compactCmd: isExternal ? `${compactTarget} compact ${chatCtx.originChatId}` : `${compactTarget} compact`,
        compactLabel: isExternal ? '压缩该群会话' : '压缩上下文',
        emptyHint: '当前会话上下文暂无统计（发送对话后会自动记录）。',
      });
    } catch (e) {
      await sensSink.say(`❌ 查询上下文失败：${formatOmbError(e)}`);
    }
    return true;
  }

  const apvM = raw.match(/^(?:approval|审批模式|审批)(?:\s+([\s\S]+))?$/i);
  if (apvM) {
    if (isGroup) return singleBotOnlyHint();
    const arg = (apvM[1] ?? '').trim().toLowerCase();
    try {
      const { bots = [] } = await bridge.client.listBots();
      if (isExternal && !bridge.chatThreads.has(`${chatCtx.originChatId}:${activeTarget.id}`)) {
        await sensSink.say(`会话「${chatCtx.chatName || chatCtx.originChatId}」尚未建立独立隔离上下文（发送对话后自动创建）。`);
        return true;
      }
      const fresh = bots.find((b) => b.id === activeTarget.id) ?? activeTarget;
      const freshName = showBotName(bridge, fresh.id, fresh.name);
      const curMode = fresh.approvalMode ?? (fresh.autoApprove ? 'auto' : 'ask');
      if (!arg || /^(show|查看|list)$/.test(arg)) {
        await sensSink.say(
          `🛡 **${freshName}** 当前审批模式：\`${curMode}\`（可选 \`ask\` 逐次询问 / \`auto\` 安全自动 / \`full\` 全自动）\n` +
          `发送 \`${cmdTarget} approval ask | auto | full\` 即可切换。`,
          { botId: fresh.id, botName: freshName, threadId: activeTarget.threadId },
          null,
          [
            { label: 'ask（询问）', text: `${cmdTarget} approval ask`, ...(curMode === 'ask' ? { kind: 'primary' } : {}) },
            { label: 'auto（自动）', text: `${cmdTarget} approval auto`, ...(curMode === 'auto' ? { kind: 'primary' } : {}) },
            { label: 'full（放行）', text: `${cmdTarget} approval full`, ...(curMode === 'full' ? { kind: 'primary' } : {}) },
          ],
        );
        return true;
      }
      const modeMap = { ask: 'ask', 询问: 'ask', auto: 'auto', 自动: 'auto', full: 'full', 放行: 'full', 全自动: 'full' };
      const nextMode = modeMap[arg];
      if (!nextMode) {
        await sensSink.say(`不支持的审批模式「${arg}」，可选：\`ask\`、\`auto\` 或 \`full\`。`);
        return true;
      }
      await bridge.withCliLoopbackFallback((c) => c.patchBot(fresh.id, { approvalMode: nextMode }));
      await bridge.refreshMultiBot();
      await sensSink.say(`🛡 已将 **${freshName}** 的审批模式设为 \`${nextMode}\`。`);
    } catch (e) {
      await sensSink.say(`❌ 切换审批模式失败：${formatOmbError(e)}`);
    }
    return true;
  }

  const memDirectM = raw.match(/^记住[\s:：]+([\s\S]+)$/);
  const memCmdM = !memDirectM ? raw.match(/^(?:memory|记忆)(?:\s+([\s\S]+))?$/i) : null;
  if (memDirectM || memCmdM) {
    if (isGroup) return singleBotOnlyHint();
    const rest = (memCmdM?.[1] ?? '').trim();
    let addText = (memDirectM?.[1] ?? '').trim();
    if (!addText && rest && !/^(?:show|查看|list)$/i.test(rest)) {
      const addM = rest.match(/^(?:add|添加|记录)(?:\s+([\s\S]+))?$/i);
      if (!addM || !addM[1]?.trim()) {
        await sensSink.say(`用法：\`${cmdTarget} memory\` 查看记忆，或 \`${cmdTarget} memory add <内容>\` / \`${cmdTarget} 记住 <内容>\``);
        return true;
      }
      addText = addM[1].trim();
    }
    try {
      const mem = await bridge.client.getMemory(activeTarget.id);
      const curText = String(mem?.text ?? '').trimEnd();
      if (addText) {
        const line = addText.startsWith('- ') ? addText : `- ${addText}`;
        const nextText = curText ? `${curText}\n${line}\n` : `${line}\n`;
        await bridge.client.putMemory(activeTarget.id, nextText);
        await sensSink.say(`🧠 已记入 **${shownTargetName}** 的长期记忆：\n${line}`);
      } else {
        const topics = Array.isArray(mem?.topics) && mem.topics.length
          ? `\n\n📁 专题记忆：${mem.topics.map((t) => `\`${t.name || t.path}\``).join('、')}`
          : '';
        const body = curText ? clip(curText, 800) : `（暂无长期记忆，发 \`${cmdTarget} 记住 <一条规则>\` 可直接写入）`;
        await sensSink.say(`🧠 **${shownTargetName} 长期记忆**\n${body}${topics}`);
      }
    } catch (e) {
      await sensSink.say(`❌ 访问长期记忆失败：${formatOmbError(e)}`);
    }
    return true;
  }

  if (/^(tasks|会话|历史)$/i.test(raw)) {
    try {
      const { fresh, top } = await bridge.collectBotTasks(activeTarget);
      const freshName = showBotName(bridge, fresh.id, fresh.name, isGroup);
      if (!top.length) {
        await sensSink.say(`**${freshName}** 暂无可切换的历史会话，可发 \`${cmdTarget} new\` 创建新会话。`);
        return true;
      }
      const route = { botId: fresh.id, botName: freshName, threadId: fresh.threadId, ...(isGroup ? { isGroup: true } : {}) };
      bridge.clearPickers();
      bridge.pendingTaskPick = {
        botId: fresh.id,
        botName: freshName,
        isGroup,
        tasks: top,
        expiresAt: bridge.now() + TASK_PICK_TTL,
      };
      const lines = top.map((t, i) => {
        const cur = (t.threadId ?? t.id) === fresh.threadId ? '（当前）' : '';
        const busy = t.busy ? ' · 运行中' : '';
        return `${i + 1}. **${clip(t.title || '未命名会话', 36)}**${cur}${busy}`;
      });
      const actions = top.map((t, i) => ({
        label: `${i + 1}. ${clip(t.title || '会话', 16)}`,
        text: String(i + 1),
        ...((t.threadId ?? t.id) === fresh.threadId ? { kind: 'primary' } : {}),
      }));
      await sensSink.say(
        `🗂 **${freshName} 最近会话**\n${lines.join('\n')}\n\n回复序号 \`1\`～\`${top.length}\` 切换，或发 \`${cmdTarget} new\` 新建会话`,
        route,
        null,
        actions,
      );
    } catch (e) {
      await sensSink.say(`❌ 获取会话列表失败：${formatOmbError(e)}`);
    }
    return true;
  }

  const taskM = raw.match(/^(?:task|切换)(?:\s+([\s\S]*))?$/i);
  if (taskM) {
    const taskArg = (taskM[1] ?? '').trim();
    const taskChoice = parseListChoice(taskArg);
    if (!taskChoice || taskChoice < 1) {
      await sensSink.say(`用法：\`${cmdTarget} task <正整数序号>\`，先发 \`${cmdTarget} tasks\` 查看会话编号。`);
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
        originChatId: chatCtx?.originChatId,
        banner: sensSink.banner,
      });
    } catch (e) {
      await sensSink.say(`❌ 切换会话失败：${formatOmbError(e)}`);
    }
    return true;
  }

  const newM = raw.match(/^(?:new|新会话|fresh)(?:\s+([\s\S]+))?$/i);
  if (newM) {
    const prompt = (newM[1] ?? '').trim();
    const titleArg = prompt
      ? { title: clip(prompt, 40) }
      : (isExternal ? { title: clip(`${chatCtx.chatType === 'group' ? '群聊' : '私聊'} · ${chatCtx.chatName || chatCtx.originChatId}`, 40) } : {});
    let created;
    try {
      created = isGroup
        ? await bridge.client.createGroupTask(activeTarget.id, { ...titleArg, ...(isExternal ? { select: false } : {}) })
        : await bridge.client.createTask(activeTarget.id, { ...titleArg, select: !isExternal });
    } catch (e) {
      await sensSink.say(`❌ 操作失败：${formatOmbError(e)}`);
      return true;
    }
    const newThreadId = created?.task?.threadId ?? created?.bot?.threadId ?? created?.group?.threadId ?? activeTarget.threadId;
    bridge.contextWarnedThreads.delete(newThreadId);
    const nextTarget = { ...activeTarget, threadId: newThreadId, ...(isGroup ? { isGroup: true } : {}) };
    const shownNext = showBotName(bridge, nextTarget.id, nextTarget.name, isGroup);
    if (isGroup) {
      bridge.groupByThread.set(newThreadId, { id: nextTarget.id, name: nextTarget.name, threadId: newThreadId, isGroup: true });
    } else {
      bridge.botByThread.set(newThreadId, { id: nextTarget.id, name: nextTarget.name, threadId: newThreadId });
    }
    if (isExternal) {
      bridge.setChatThread(chatCtx.originChatId, nextTarget);
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
      if (isExternal && !bridge.chatThreads.has(`${chatCtx.originChatId}:${activeTarget.id}`)) {
        await sensSink.say(`会话「${chatCtx.chatName || chatCtx.originChatId}」尚未建立独立隔离上下文（发送对话后自动创建）。`);
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

  return false;
}
