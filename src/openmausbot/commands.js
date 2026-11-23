import fs from 'node:fs';
import path from 'node:path';
import { clip, mdClip, safeAttachmentName } from '../format.js';
import { fmtTokens, usageBar, fmtSchedule, formatOmbError, parseChoiceIndex } from './cards.js';
import { levenshtein, parseHHMM } from './mentions.js';
import { COBOT_COORDINATOR_PROFILE, COBOT_COORDINATOR_TITLE } from './persona.js';

const showBotName = (bridge, id, name, isGroup = false) => (
  typeof bridge.displayBotName === 'function'
    ? bridge.displayBotName(id, name, { isGroup })
    : (String(name ?? '').trim() || bridge.botName || 'co-bot')
);

const TASK_PICK_TTL = 2 * 60 * 1000;
const VARIANT_EFFORT_RE = /^(low|medium|high|xhigh|max|default)$/i;
const parseListChoice = (raw) => {
  const s = String(raw ?? '').trim();
  return parseChoiceIndex(s) ?? (/^\d+$/.test(s) ? Number(s) : null);
};

function resolveChatOrId(bridge, arg, { isExternal = false, chatCtx = null } = {}) {
  const q = String(arg ?? '').trim();
  if (!q && isExternal && chatCtx) {
    return { id: chatCtx.originChatId, name: chatCtx.chatName || chatCtx.originChatId, type: chatCtx.chatType };
  }
  if (!q) return null;
  return bridge.resolveKnownChat(q) ?? (/^[\w.:-]+$/.test(q) ? { id: q, name: q, type: 'group' } : null);
}

async function replyContextUsage(sensSink, { title, bot, threadId, task, compactCmd, compactLabel, isExternal = false, emptyHint = '暂无统计（对话后记录）' }) {
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

const CANONICAL_COMMANDS = [
  'help', 'bots', 'groups', 'status', 'stop', 'steer', 'cancel', 'digest',
  'chats', 'chat', 'summary', 'schedule', 'sendback', 'find', 'search',
  'routines', 'context', 'export', 'model', 'memory', 'tasks', 'task', 'style', 'compact',
  'approval', 'quiet', 'prefs',
];
const COMMAND_SET = new Set(CANONICAL_COMMANDS);
const SAFE_ENGLISH_WORDS = new Set([
  'hello', 'check', 'test', 'write', 'read', 'show', 'list', 'send', 'make', 'create',
  'update', 'delete', 'thanks', 'please', 'what', 'when', 'where', 'which', 'explain',
  'review', 'debug', 'build', 'deploy', 'plan', 'code', 'note', 'time', 'date', 'file',
  'ping', 'echo', 'good', 'nice', 'fine', 'true', 'false', 'null', 'exit', 'quit', 'info',
  'next', 'back', 'home', 'work', 'call', 'wait', 'done', 'more', 'less', 'sort', 'diff',
  'stat', 'stats', 'logs', 'sync', 'push', 'pull', 'step', 'shop', 'spot', 'stay', 'mode',
  'node', 'most', 'rest', 'best', 'fast', 'last', 'look', 'news', 'view', 'mind', 'kind',
  'bind', 'wind', 'fund', 'hand', 'land', 'hold', 'tell', 'well', 'hell', 'sent', 'went',
  'that', 'with', 'this', 'from', 'your', 'have', 'will', 'just', 'like', 'take', 'give',
  'keep', 'turn', 'move', 'copy', 'save', 'load', 'open', 'close', 'start', 'clean', 'clear',
  'reset', 'verify', 'count', 'parse', 'format', 'print', 'fetch', 'post', 'patch', 'head',
  'line', 'mine', 'nine', 'disk', 'risk', 'desk', 'boot', 'root', 'soon', 'tool', 'loop',
  'star', 'form', 'port', 'host', 'cost', 'lost', 'atop', 'stow', 'stops', 'cats', 'that',
  'than', 'then', 'them', 'they', 'book', 'cool',
]);

/** 仅当首词明显像是拼错的内建 ASCII 子命令时给出纠错提示，绝不误拦正常英文提问。 */
export function suggestClosestCommand(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  const toks = trimmed.split(/\s+/).filter(Boolean);
  if (toks.length === 0 || toks.length > 2) return null;
  const tok = toks[0];
  if (!/^[a-z]{4,14}$/i.test(tok)) return null;
  const low = tok.toLowerCase();
  if (COMMAND_SET.has(low) || SAFE_ENGLISH_WORDS.has(low)) return null;

  let bestCmd = null;
  let bestDist = Infinity;
  for (const cmd of CANONICAL_COMMANDS) {
    const d = levenshtein(low, cmd);
    if (d < bestDist) {
      bestDist = d;
      bestCmd = cmd;
    }
  }
  if (!bestCmd) return null;
  const accepted = bestDist === 1 || (bestDist === 2 && bestCmd.length >= 6 && low.length >= 5 && low[0] === bestCmd[0]);
  if (!accepted) return null;
  return {
    typo: tok,
    suggestion: bestCmd,
    fullSuggestion: toks[1] ? `${bestCmd} ${toks[1]}` : bestCmd,
  };
}

/** 构造 `@bot help [分类]` 简洁使用说明（支持 default / 群聊 / 定时 / 会话 / 模型 / 全部）。 */
export function buildHelpText(bridge, topic = '') {
  const t = bridge.trigger;
  const brand = bridge.botName || 'co-bot';
  const key = String(topic ?? '').trim().toLowerCase();
  const sections = {
    group: [
      `💬 **群聊与跨群能力**`,
      `- 任意群 / 私聊：本人 \`${t} <问题>\` 原地回复；\`${t}!\` 或 \`${t} -p\` 私密起草回自聊（可持久化并引用继续润色）`,
      `- \`${t} sendback\`：预览确认后防误艾特发回原群（支持 \`确认发送\` / \`改：新文本\` / \`取消\`）`,
      `- \`${t} chats\` / \`chat mute|allow <群>\` / \`chat mode self_only|everywhere\`：实时管群与静默`,
      `- \`${t} summary <群名> [条数]\` / \`纪要 <群名>\`、\`${t} find [in:<群>] <关键词>\`：零打扰汇总与跨群检索`,
    ],
    schedule: [
      `🗓️ **定时纪要与巡检**`,
      `- \`${t} schedule add <群名|id> <HH:MM> [重点]\`：每日定时静默汇总到自聊（支持 \`list | run | on | off | del\`）`,
      `- \`${t} routines\` / \`routines run <序号>\` / \`on|off <序号>\`：管理后台定时巡检`,
      `- \`${t} digest\`：立即汇总免打扰期间积压的通知消息`,
    ],
    session: [
      `🗂 **多会话与连续对话**`,
      `- 自聊回复后 ${Math.round(bridge.followUpWindowMs / 1000)} 秒内可免 \`@\` 续聊或贴图（\`#\`/备忘开头不打扰，\`${t} bye\` 退出）`,
      `- \`${t} new [话题]\` / \`tasks\` / \`task <序号>\` / \`search <词>\` / \`export\` / \`compact [群名]\``,
    ],
    model: [
      `🤖 **Bot 协同、模型与控制**`,
      `- \`@<Bot名>\` / \`@<群名>\`：点名其他 Bot 或多 Bot 协作群组；引用气泡续聊`,
      `- \`${t} bots\` / \`status\` / \`model [关键词|high]\` / \`approval [ask|auto|full]\` / \`context [群名]\` / \`memory\` / \`style cobot\``,
      `- \`${t} quiet [on|off|HH:MM-HH:MM]\` / \`prefs [ack on|off | sanitize all|dangerous|none | stall <秒> | reset]\`：免重启热调参`,
      `- \`${t} steer\` / \`cancel\` / \`stop\`；卡片支持 \`ok / always / no / skip\` 与中文序数`,
    ],
  };

  if (/^(群聊|群|chat|chats|group|groups|外部群)$/.test(key)) return sections.group.join('\n');
  if (/^(定时|schedule|schedules|routine|routines|巡检|纪要)$/.test(key)) return sections.schedule.join('\n');
  if (/^(会话|session|sessions|task|tasks)$/.test(key)) return sections.session.join('\n');
  if (/^(模型|model|models|bot|bots|控制)$/.test(key)) return sections.model.join('\n');
  if (/^(全部|all|full)$/.test(key)) {
    return [
      `🤖 **${brand} 完整指令**`,
      ...sections.group,
      ...sections.schedule,
      ...sections.session,
      ...sections.model,
    ].join('\n');
  }

  return [
    `🤖 **${brand} 常用指南**`,
    `- \`${t} <问题>\` / \`@<Bot名>\` / \`@<群名>\`：找主 Bot 或协作团队（自聊回复后 ${Math.round(bridge.followUpWindowMs / 1000)}s 内可免 \`@\` 续聊，\`${t} bye\` 退出）`,
    `- \`${t}! <问题>\`（外部群）：私密起草发回自聊，可引用润色后发 \`${t} sendback\` 确认回群`,
    `- \`${t} chats\` / \`summary <群>\` / \`schedule\` / \`find <词>\`：动态管群、跨群纪要与检索`,
    `- \`${t} new\` / \`tasks\` / \`compact\` / \`model\` / \`context\`：新建切换会话、压缩与切模型`,
    `- \`${t} steer\` / \`cancel\` / \`stop\`：插队、取消排队或停止任务；卡片支持 \`ok/always/no/skip\``,
    `📖 发送 \`${t} help 群聊 | 定时 | 会话 | 模型 | 全部\` 查看分类详情`,
  ].join('\n');
}

function makeCommandSink(bridge, chatCtx, { sensitive = true } = {}) {
  if (!chatCtx?.isExternal) {
    return {
      chatId: bridge.selfChat,
      say: (text, route = null, replyTo = null, actions = null) => bridge.say(text, route, replyTo, actions),
      sendFile: (filePath, name, opts = {}) => bridge.sendOutboundFile(filePath, name, opts),
    };
  }
  const ctrlId = typeof bridge.resolveControlChatId === 'function'
    ? bridge.resolveControlChatId(chatCtx)
    : bridge.selfChat;
  const targetId = sensitive ? ctrlId : chatCtx.replyChatId;
  const label = chatCtx.chatName || chatCtx.originChatId;
  let bannerSent = false;
  return {
    chatId: targetId,
    say: async (text, route = null, replyTo = null, actions = null) => {
      if (!targetId) return null;
      const showOriginBanner = sensitive && !bannerSent && ctrlId && ctrlId === bridge.selfChat;
      const head = showOriginBanner ? `📍 **来自「${label}」的指令结果**\n` : '';
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

async function stopTarget(bridge, target, sink = null, { isExternal = false } = {}) {
  const say = sink?.say ?? ((t, r, rt, a) => bridge.say(t, r, rt, a));
  const active = [...bridge.activeTurns.values()].find((t) => t.threadId === target.threadId || t.botId === target.botId)
    ?? (!isExternal ? [...bridge.activeTurns.values()].at(-1) : null);
  if (target.isGroup && typeof bridge.client.interruptGroup === 'function') {
    await bridge.client.interruptGroup(target.botId, target.threadId);
  } else {
    await bridge.client.interrupt(target.botId, target.threadId);
  }
  if (active && (active.botId === target.botId || active.threadId === target.threadId)) {
    active.dispose();
    bridge.activeTurns.delete(active.key);
    bridge.inFlightTurns?.delete(active.key);
    bridge.saveState();
  }
  if (!isExternal) {
    bridge.lastBotReplyAt = 0;
    bridge.clearPickers?.();
  }
  await say(`⏹ 已请求停止 **${showBotName(bridge, target.botId, target.botName, Boolean(target.isGroup))}**`);
}

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
        const st = b.busy ? `运行中 · ${b.activity || 'busy'}` : '空闲';
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
    await sensSink.say(
      `🟢 **${brand} 在线** · 隔离模式：${h.box ?? 'off'} · 认证：${authState}${docNote}\n` +
      `协作 Bot：${visible.length} 个${groupNote} · 主协调：**${chiefShown}**（风格：${chief?.replyStyle ?? 'default'}，审批：${chief?.approvalMode ?? 'ask'}）· 活跃轮次：${bridge.activeTurns.size}${stickyNote} · 引擎 v${h.version ?? '?'}` +
      (bridge.quietQueue.length ? ` · 静默待汇总：${bridge.quietQueue.length} 条` : ''),
    );
    return true;
  }

  const quietM = raw.match(/^(?:quiet|quietHours|免打扰|勿扰)(?:\s+([\s\S]+))?$/i);
  if (quietM) {
    const arg = (quietM[1] ?? '').trim();
    const cur = bridge.quietHours || {};
    if (!arg || /^(show|查看|状态)$/i.test(arg)) {
      await sensSink.say(
        `🌙 **夜间免打扰**：${cur.enabled ? '已开启' : '未开启'}（时段 \`${cur.start || '22:00'}\` ~ \`${cur.end || '08:30'}\`）\n` +
        `用法：\`${bridge.trigger} quiet on | off | 23:00-07:30\``,
        null,
        null,
        [
          cur.enabled
            ? { label: '关闭免打扰', text: `${bridge.trigger} quiet off` }
            : { label: '开启免打扰', text: `${bridge.trigger} quiet on`, kind: 'primary' },
        ],
      );
      return true;
    }
    if (/^(on|enable|开启|打开)$/i.test(arg)) {
      const next = bridge.setQuietHours({ enabled: true });
      await sensSink.say(`🌙 已开启免打扰（\`${next.start}\` ~ \`${next.end}\`），期间主动通知将自动攒成汇总（\`${bridge.trigger} digest\` 可随时查看）。`);
      return true;
    }
    if (/^(off|disable|关闭|取消)$/i.test(arg)) {
      const next = bridge.setQuietHours({ enabled: false });
      const flushed = bridge.quietQueue.length ? await bridge.flushQuietDigest() : 0;
      await sensSink.say(`☀️ 已关闭免打扰（${next.start}~${next.end}）${flushed ? `，已顺带发出积压的 ${flushed} 条通知` : ''}。`);
      return true;
    }
    const winM = arg.match(/^(\d{1,2}:\d{2})\s*[-~到至]\s*(\d{1,2}:\d{2})$/);
    if (!winM || parseHHMM(winM[1]) == null || parseHHMM(winM[2]) == null) {
      await sensSink.say(`无效时间格式「${arg}」，请使用 \`${bridge.trigger} quiet 23:00-07:30\`、\`on\` 或 \`off\`。`);
      return true;
    }
    const fmtClock = (s) => {
      const [h, m] = s.split(':');
      return `${String(Number(h)).padStart(2, '0')}:${String(Number(m)).padStart(2, '0')}`;
    };
    const next = bridge.setQuietHours({ enabled: true, start: fmtClock(winM[1]), end: fmtClock(winM[2]) });
    await sensSink.say(`🌙 已更新并开启免打扰时段：\`${next.start}\` ~ \`${next.end}\`（无需重启即时生效）。`);
    return true;
  }

  const prefsM = raw.match(/^(?:prefs?|pref|偏好|设置)(?:\s+([\s\S]+))?$/i);
  if (prefsM) {
    const arg = (prefsM[1] ?? '').trim();
    if (!arg || /^(show|查看|list)$/i.test(arg)) {
      const p = bridge.getRuntimePrefs();
      await sensSink.say(
        `⚙️ **运行期热偏好（免重启持久化）**\n` +
        `- 外群后台接单自聊轻提示（\`ack\`）：${p.externalAckInSelf ? '开启' : '关闭'}\n` +
        `- 外群出站防误艾特（\`sanitize\`）：\`${p.externalSanitizeMentions}\`（all / dangerous / none）\n` +
        `- 长任务停滞看门狗阈值（\`stall\`）：${p.turnStallMs > 0 ? `${Math.round(p.turnStallMs / 1000)} 秒` : '已关闭'}\n` +
        `- 免打扰（\`quiet\`）：${p.quietHours?.enabled ? `开启（${p.quietHours.start}~${p.quietHours.end}）` : '关闭'}\n\n` +
        `示例：\`${bridge.trigger} prefs ack on\`、\`prefs sanitize dangerous\`、\`prefs stall 120\`、\`prefs reset\``,
      );
      return true;
    }
    const lowArg = arg.toLowerCase();
    if (/^(reset|重置)$/.test(lowArg)) {
      bridge.setRuntimePref('reset');
      await sensSink.say('🔄 已重置所有运行期热偏好，恢复为配置文件默认值。');
      return true;
    }
    const ackM = arg.match(/^ack\s+(on|off|true|false|开启|关闭)$/i);
    if (ackM) {
      const enabled = /^(on|true|开启)$/i.test(ackM[1]);
      bridge.setRuntimePref('externalAckInSelf', enabled);
      await sensSink.say(`✅ 已${enabled ? '开启' : '关闭'}外群静默接单时的自聊轻提示。`);
      return true;
    }
    const sanM = arg.match(/^sanitize\s+(all|dangerous|none)$/i);
    if (sanM) {
      const mode = sanM[1].toLowerCase();
      bridge.setRuntimePref('externalSanitizeMentions', mode);
      await sensSink.say(`✅ 已将外群出站防误艾特策略设为 \`${mode}\`。`);
      return true;
    }
    const stallM = arg.match(/^stall\s+(\d+|off|关闭)$/i);
    if (stallM) {
      const sec = /^(off|关闭)$/i.test(stallM[1]) ? 0 : Number(stallM[1]);
      bridge.setRuntimePref('turnStallMs', sec * 1000);
      await sensSink.say(sec > 0 ? `✅ 已将长任务停滞提醒阈值设为 ${sec} 秒。` : '✅ 已关闭长任务停滞看门狗提醒。');
      return true;
    }
    await sensSink.say(`用法：\`${bridge.trigger} prefs\`、\`prefs ack on|off\`、\`prefs sanitize all|dangerous|none\`、\`prefs stall <秒|off>\` 或 \`prefs reset\``);
    return true;
  }

  if (/^(stop|停止|停|interrupt)$/.test(low)) {
    const scoped = targetBot ? {
      botId: targetBot.id,
      botName: targetBot.name,
      threadId: targetBot.threadId,
      isGroup: Boolean(targetBot.isGroup),
    } : null;
    const target = isExternal
      ? (quotedRoute ?? [...bridge.activeTurns.values()].find((t) => t.chatCtx?.originChatId === chatCtx.originChatId) ?? scoped)
      : (quotedRoute ?? [...bridge.activeTurns.values()].at(-1) ?? bridge.focus);
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

  if (/^(steer|插队)$/.test(low)) {
    const tid = isExternal ? (quotedRoute?.threadId ?? targetBot?.threadId) : (quotedRoute?.threadId ?? bridge.focus?.threadId);
    await bridge.steerLatestQueue(tid, sensSink.chatId);
    return true;
  }

  if (/^(cancel|取消排队)$/.test(low)) {
    const tid = isExternal ? (quotedRoute?.threadId ?? targetBot?.threadId) : (quotedRoute?.threadId ?? bridge.focus?.threadId);
    await bridge.cancelLatestQueue(tid, sensSink.chatId);
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
    const limM = tail.match(/^(\d{1,3})(?:\s+([\s\S]*))?$/);
    if (limM) {
      limit = Number(limM[1]);
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

  // 跨群定时纪要：@bot schedule [add <群名|id> <HH:MM> [关注重点] | run|on|off|del <序号>]
  const schedM = raw.match(/^(?:schedule|schedules|定时汇总|每日汇总|定时纪要)(?:\s+([\s\S]+))?$/i);
  if (schedM) {
    const sub = (schedM[1] ?? '').trim();
    if (!sub || /^(list|ls|查看|列表)$/i.test(sub)) {
      const list = bridge.listScheduledSummaries();
      if (!list.length) {
        await sensSink.say(`暂无定时群纪要规则。\n用法：\`${bridge.trigger} schedule add <群名|chatId> <HH:MM> [关注重点]\``);
        return true;
      }
      const lines = list.map((s, i) => {
        const flag = s.enabled === false ? '⚪ 暂停' : '🟢 启用';
        const focusNote = s.focus ? ` · 重点：${clip(s.focus, 28)}` : '';
        const ranNote = s.lastRunDate ? `（最近：${s.lastRunDate}）` : '';
        return `${i + 1}. ${flag} **${s.chatName || s.chatId}**（\`${s.chatId}\`）· 每日 ${s.time}${focusNote}${ranNote}`;
      });
      const first = list[0];
      const actions = [
        { label: `立即汇总 1`, text: `${bridge.trigger} schedule run 1` },
        first.enabled === false
          ? { label: `启用 1`, text: `${bridge.trigger} schedule on 1` }
          : { label: `暂停 1`, text: `${bridge.trigger} schedule off 1` },
      ];
      await sensSink.say(
        `🗓️ **定时跨群纪要（${list.length}）**\n${lines.join('\n')}\n\n指令：\`${bridge.trigger} schedule add <群名> <HH:MM> [重点]\`、\`run|on|off|del <序号>\``,
        null,
        null,
        actions,
      );
      return true;
    }

    const addM = sub.match(/^(?:add|添加|新增)\s+([\s\S]+)$/i);
    if (addM) {
      const rest = addM[1].trim();
      let targetChat = null;
      let timeStr = '';
      let focus = '';
      const directTimeM = isExternal ? rest.match(/^(\d{1,2}:\d{2})(?:\s+([\s\S]*))?$/) : null;
      if (directTimeM) {
        targetChat = { id: chatCtx.originChatId, name: chatCtx.chatName || chatCtx.originChatId, type: chatCtx.chatType || 'group' };
        timeStr = directTimeM[1];
        focus = (directTimeM[2] ?? '').trim();
      } else {
        const fullM = rest.match(/^(\S+)\s+(\d{1,2}:\d{2})(?:\s+([\s\S]*))?$/);
        if (!fullM) {
          await sensSink.say(`用法：\`${bridge.trigger} schedule add <群名|chatId> <HH:MM> [关注重点]\``);
          return true;
        }
        const chatTok = fullM[1];
        timeStr = fullM[2];
        focus = (fullM[3] ?? '').trim();
        targetChat = resolveChatOrId(bridge, chatTok);
        if (!targetChat) {
          await sensSink.say(`未找到匹配会话「${chatTok}」，请先在该群发消息或发 \`${bridge.trigger} chats\` 查看会话 ID。`);
          return true;
        }
      }
      try {
        const added = bridge.addScheduledSummary({
          chatId: targetChat.id,
          chatName: targetChat.name || targetChat.id,
          chatType: targetChat.type || 'group',
          time: timeStr,
          focus,
        });
        await sensSink.say(
          `✅ 已设置每日 **${added.time}** 定时汇总「${added.chatName}」（仅静默发回自聊${added.focus ? `，关注：${clip(added.focus, 30)}` : ''}）。`,
          null,
          null,
          [{ label: '立即试跑一次', text: `${bridge.trigger} schedule run ${added.id}` }],
        );
      } catch (e) {
        await sensSink.say(`⚠️ 添加定时汇总失败：${e?.message || e}`);
      }
      return true;
    }

    const opM = sub.match(/^(run|执行|触发|立即|on|enable|开启|启用|off|disable|暂停|停用|del|rm|delete|remove|删除|移除)\s+(.+)$/i);
    if (!opM) {
      await sensSink.say(`用法：\`${bridge.trigger} schedule [add <群> <HH:MM> [重点] | run|on|off|del <序号>]\``);
      return true;
    }
    const op = opM[1].toLowerCase();
    const arg = opM[2].trim();
    if (/^(run|执行|触发|立即)$/.test(op)) {
      const list = bridge.listScheduledSummaries();
      let picked = /^\d+$/.test(arg) ? list[Number(arg) - 1] : list.find((s) => s.id === arg || s.chatId === arg || String(s.chatName || '').toLowerCase() === arg.toLowerCase());
      if (!picked) {
        await sensSink.say(`未找到第/名为「${arg}」的定时汇总规则。`);
        return true;
      }
      const res = await bridge.runScheduledSummary(picked, { manual: true });
      if (!res.ok) {
        await sensSink.say(`会话「${res.chatName || picked.chatName}」暂无可汇总的对话记录。`);
      }
      return true;
    }
    if (/^(del|rm|delete|remove|删除|移除)$/.test(op)) {
      const removed = bridge.removeScheduledSummary(arg);
      await sensSink.say(removed ? `🗑 已删除「${removed.chatName}」（${removed.time}）的定时汇总。` : `未找到定时汇总规则「${arg}」。`);
      return true;
    }
    const enabled = /^(on|enable|开启|启用)$/.test(op);
    const updated = bridge.setScheduledSummaryEnabled(arg, enabled);
    await sensSink.say(updated ? `${enabled ? '✅ 已启用' : '⏸ 已暂停'}「${updated.chatName}」（${updated.time}）的定时汇总。` : `未找到定时汇总规则「${arg}」。`);
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
    if (/^(confirm|确认|发送|send)$/i.test(arg) && bridge.pendingSendBack) {
      await bridge.confirmSendBack();
      return true;
    }
    let draftId = null;
    let overrideText = arg;
    const tokM = arg.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    if (tokM && bridge.privateDrafts.has(tokM[1])) {
      draftId = tokM[1];
      overrideText = (tokM[2] ?? '').trim();
    }
    const draft = bridge.resolvePrivateDraft({ quotedId, draftId });
    if (!draft) {
      await sensSink.say(`暂无待发回的私密草稿（需先在外部群/私聊用 \`${bridge.trigger}!\` 起草）。`);
      return true;
    }
    await bridge.requestSendBack(draft, overrideText);
    return true;
  }

  // 跨群只读记忆检索：@bot find [in:<群名|id>] <关键词>
  const findM = raw.match(/^(?:find|跨群查|查群|搜群)(?:\s+([\s\S]+))?$/i);
  if (findM) {
    const rest = (findM[1] ?? '').trim();
    let chatQuery = '';
    let query = rest;
    const inM = rest.match(/^in:(\S+)(?:\s+([\s\S]*))?$/i);
    if (inM) {
      chatQuery = inM[1].trim();
      query = (inM[2] ?? '').trim();
    }
    if (!query) {
      await sensSink.say(`用法：\`${bridge.trigger} find <关键词>\` 或 \`${bridge.trigger} find in:<群名> <关键词>\`（结果仅私密返回自聊）`);
      return true;
    }
    const { hits, scopedChat, missingChat } = await bridge.searchAcrossChats(query, { chatQuery, limit: 10 });
    if (missingChat) {
      await sensSink.say(`未找到匹配会话「${missingChat}」，发 \`${bridge.trigger} chats\` 查看已知会话。`);
      return true;
    }
    if (!hits.length) {
      await sensSink.say(`未在${scopedChat ? `「${scopedChat.name}」` : '已缓存群/私聊'}中找到包含「${clip(query, 30)}」的消息。`);
      return true;
    }
    const lines = hits.map((h, i) => {
      const d = new Date(Number(h.ts) || Date.now());
      const stamp = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const who = h.isBotReply ? `${h.senderName || 'Bot'}[bot]` : (h.senderName || h.senderId || '成员');
      const attNote = h.attachments?.length ? ` [附件: ${h.attachments.map((a) => a.name).join(', ')}]` : '';
      const body = clip(String(h.text || '').replace(/\s+/g, ' '), 80);
      return `${i + 1}. **[${h.chatName || h.chatId}]** · ${who}（${stamp}）\n   > ${body}${attNote}`;
    });
    const topChat = hits[0];
    const actions = topChat?.chatId
      ? [{ label: `汇总「${clip(topChat.chatName || topChat.chatId, 10)}」`, text: `${bridge.trigger} summary ${topChat.chatId}` }]
      : [];
    await sensSink.say(
      `🔍 **跨群检索「${clip(query, 24)}」命中 ${hits.length} 条**\n${lines.join('\n')}`,
      null,
      null,
      actions,
    );
    return true;
  }

  // search / 搜索 / 搜历史 / 查历史（保留“找 xxx”给普通代码搜索对话，避免误劫持）
  const searchM = raw.match(/^(?:search|搜历史|查历史|搜索)(?:\s+([\s\S]+))?$/i);
  if (searchM) {
    const q = (searchM[1] ?? '').trim();
    if (!q) { await sensSink.say(`用法：\`${bridge.trigger} search <关键词>\``); return true; }
    try {
      const { hits } = await bridge.client.search(q, { limit: 15 });
      const deduped = [];
      const seenTid = new Set();
      for (const h of hits) {
        if (!h?.threadId || seenTid.has(h.threadId)) continue;
        seenTid.add(h.threadId);
        deduped.push(h);
        if (deduped.length >= 5) break;
      }
      if (!deduped.length) {
        await sensSink.say(`未找到包含「${clip(q, 30)}」的聊天记录。`);
        return true;
      }
      const tasks = deduped.map((h) => ({
        threadId: h.threadId,
        title: h.task || h.name || '历史会话',
        botId: h.botId,
        botName: showBotName(bridge, h.botId, h.name),
      }));
      bridge.clearPickers();
      bridge.pendingTaskPick = {
        botId: tasks[0].botId,
        botName: tasks[0].botName,
        tasks,
        expiresAt: bridge.now() + TASK_PICK_TTL,
      };
      const lines = deduped.map((h, i) => `${i + 1}. **${clip(h.task || h.name || '会话', 30)}**（${showBotName(bridge, h.botId, h.name)}）\n   > ${clip(String(h.snippet ?? '').replace(/\s+/g, ' '), 80)}`);
      const actions = deduped.map((_, i) => ({ label: `切到 ${i + 1}`, text: String(i + 1) }));
      await sensSink.say(
        `🔎 搜索「${clip(q, 24)}」命中 ${deduped.length} 个会话：\n${lines.join('\n')}\n\n回复数字 \`1\`～\`${deduped.length}\` 立即切换过去`,
        null,
        null,
        actions,
      );
    } catch (e) {
      await sensSink.say(`❌ 搜索失败：${formatOmbError(e)}`);
    }
    return true;
  }

  // routines / 定时 / 巡检
  const routM = raw.match(/^(?:routines?|定时|巡检)(?:\s+([\s\S]+))?$/i);
  if (routM) {
    const sub = (routM[1] ?? '').trim();
    try {
      let list = bridge.pendingRoutineList && bridge.now() < bridge.pendingRoutineList.expiresAt && sub
        ? bridge.pendingRoutineList.routines
        : null;
      if (!list || !sub) {
        const res = await bridge.client.listRoutines();
        list = res.routines;
        bridge.pendingRoutineList = { routines: list, expiresAt: bridge.now() + TASK_PICK_TTL };
      }
      if (!sub) {
        if (!list.length) { await sensSink.say('当前没有配置定时巡检任务（可在管理后台创建）。'); return true; }
        const shown = list.slice(0, 8);
        const lines = shown.map((r, i) => `${i + 1}. ${r.enabled === false ? '⚪ 暂停' : '🟢 启用'} **${clip(r.name || '未命名任务', 32)}** · ${fmtSchedule(r.schedule)}`);
        const actions = shown.slice(0, 3).map((_, i) => ({
          label: `立即跑 ${i + 1}`,
          text: `${bridge.trigger} routines run ${i + 1}`,
        }));
        await sensSink.say(
          `⏰ **定时巡检任务（${list.length}）**\n${lines.join('\n')}\n\n发 \`${bridge.trigger} routines run <序号>\` 立即执行，或 \`on/off <序号>\` 启停`,
          null,
          null,
          actions,
        );
        return true;
      }
      const actM = sub.match(/^(run|执行|触发|on|enable|开启|启用|off|disable|暂停|关闭)\s+(.+)$/i);
      const actChoice = actM ? parseListChoice(actM[2]) : null;
      if (!actM || !actChoice) {
        await sensSink.say(`用法：\`${bridge.trigger} routines\` 查看，或 \`${bridge.trigger} routines run/on/off <序号>\``);
        return true;
      }
      const op = actM[1].toLowerCase();
      const picked = list[actChoice - 1];
      if (!picked) {
        await sensSink.say(`未找到第 ${actChoice} 号定时任务（共有 ${list.length} 条）。`);
        return true;
      }
      if (/^(run|执行|触发)$/.test(op)) {
        await bridge.client.runRoutine(picked.id);
        await sensSink.say(`▶️ 已触发定时任务「${picked.name}」，结果完成后会直接推送。`);
      } else {
        const enabled = /^(on|enable|开启|启用)$/.test(op);
        await bridge.client.patchRoutine(picked.id, { enabled });
        picked.enabled = enabled;
        await sensSink.say(`${enabled ? '✅ 已开启' : '⏸ 已暂停'}定时任务「${picked.name}」。`);
      }
    } catch (e) {
      await sensSink.say(`❌ 定时任务操作失败：${formatOmbError(e)}`);
    }
    return true;
  }

  return false;
}

async function handleModelCommand(bridge, activeTarget, arg, sensSink) {
  const say = sensSink?.say ?? ((t, r, rt, a) => bridge.say(t, r, rt, a));
  const cmdTarget = botCommandTarget(bridge, activeTarget.id, activeTarget.name);
  try {
    const [{ bots }, instRes] = await Promise.all([
      bridge.client.listBots(),
      bridge.withCliLoopbackFallback((c) => c.listInstances()).catch(() => ({ instances: [] })),
    ]);
    const fresh = bots.find((b) => b.id === activeTarget.id) ?? activeTarget;
    const freshName = showBotName(bridge, fresh.id, fresh.name);
    const task = (fresh.tasks ?? []).find((t) => (t.threadId ?? t.id) === activeTarget.threadId);
    const sel = task?.modelSelection ?? fresh.modelSelection ?? {};
    const instances = Array.isArray(instRes?.instances) ? instRes.instances : [];
    const curIns = instances.find((i) => i.instanceId === sel.instanceId)
      ?? instances.find((i) => i.snapshot?.state === 'available')
      ?? instances[0];
    const curOpts = (Array.isArray(curIns?.models?.options) ? curIns.models.options : [])
      .map((o) => ({ ...o, instanceId: curIns.instanceId }));

    if (!arg) {
      const topOpts = curOpts.slice(0, 8);
      bridge.clearPickers();
      bridge.pendingModelPick = {
        botId: fresh.id,
        botName: freshName,
        threadId: activeTarget.threadId,
        options: topOpts,
        expiresAt: bridge.now() + TASK_PICK_TTL,
      };
      const lines = topOpts.map((o, i) => {
        const mark = o.id === sel.model ? '（当前）' : '';
        return `${i + 1}. \`${o.id}\`${mark}${o.label ? ` · ${clip(o.label, 30)}` : ''}`;
      });
      const actions = topOpts.slice(0, 6).map((o, i) => ({
        label: `${i + 1}. ${clip(o.id.split('/').pop(), 16)}`,
        text: String(i + 1),
        ...(o.id === sel.model ? { kind: 'primary' } : {}),
      }));
      await say(
        `🧠 **${freshName}** 当前模型：\`${sel.model || '未设置'}\`${sel.variant || sel.effort ? `（深度：${sel.variant || sel.effort}）` : ''}\n` +
        (lines.length ? `${lines.join('\n')}\n\n回复序号 \`1\`～\`${topOpts.length}\` 或 \`${cmdTarget} model <关键词|high>\` 切换` : `暂未读到可选模型列表，可直接发 \`${cmdTarget} model <模型名>\``),
        { botId: fresh.id, botName: freshName, threadId: activeTarget.threadId },
        null,
        actions,
      );
      return true;
    }

    if (VARIANT_EFFORT_RE.test(arg)) {
      if (!sel.model) {
        await say(`当前会话尚未选定模型，请先发 \`${cmdTarget} model\` 选择模型后再调整思考深度。`);
        return true;
      }
      const lowArg = arg.toLowerCase();
      const curMeta = curOpts.find((o) => o.id === sel.model);
      const hasVariants = Array.isArray(curMeta?.variants) && curMeta.variants.length > 0;
      const nextSel = {
        instanceId: sel.instanceId,
        model: sel.model,
        ...(hasVariants ? { variant: lowArg } : { effort: lowArg }),
      };
      await bridge.applyModelSelection(fresh, activeTarget.threadId, nextSel, `${sel.model} · ${lowArg}`, sensSink?.chatId);
      return true;
    }

    const argChoice = parseListChoice(arg);
    if (argChoice) {
      const idx = argChoice - 1;
      const pool = bridge.pendingModelPick?.botId === fresh.id && bridge.now() < bridge.pendingModelPick.expiresAt
        ? bridge.pendingModelPick.options
        : curOpts;
      const chosen = pool[idx];
      if (!chosen) {
        await say(`未找到第 ${argChoice} 号模型，发 \`${cmdTarget} model\` 查看可用列表。`);
        return true;
      }
      await bridge.applyModelSelection(fresh, activeTarget.threadId, { instanceId: chosen.instanceId, model: chosen.id }, chosen.id, sensSink?.chatId);
      return true;
    }

    const qLow = arg.toLowerCase();
    const availPool = [
      ...curOpts,
      ...instances
        .filter((i) => i.instanceId !== curIns?.instanceId && (!i.snapshot?.state || i.snapshot.state === 'available'))
        .flatMap((i) => (Array.isArray(i.models?.options) ? i.models.options : []).map((o) => ({ ...o, instanceId: i.instanceId }))),
    ];
    const chosen = availPool.find((o) => String(o.id).toLowerCase() === qLow)
      ?? availPool.find((o) => String(o.id).toLowerCase().includes(qLow) || String(o.label ?? '').toLowerCase().includes(qLow));
    if (!chosen) {
      await say(`未找到匹配「${arg}」的可用模型，发 \`${cmdTarget} model\` 查看可选列表。`);
      return true;
    }
    await bridge.applyModelSelection(fresh, activeTarget.threadId, { instanceId: chosen.instanceId, model: chosen.id }, chosen.id, sensSink?.chatId);
  } catch (e) {
    await say(`❌ 切换模型失败：${formatOmbError(e)}`);
  }
  return true;
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
    if (/^(steer|插队)$/i.test(raw)) {
      await bridge.steerLatestQueue(activeTarget.threadId, sensSink.chatId);
      return true;
    }
    if (/^(cancel|取消排队)$/i.test(raw)) {
      await bridge.cancelLatestQueue(activeTarget.threadId, sensSink.chatId);
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

  if (/^(export|导出)$/i.test(raw)) {
    try {
      const exp = await bridge.client.exportThread(activeTarget.threadId, 'markdown');
      if (!exp.text) {
        await sensSink.say('当前会话暂无可导出的对话内容。');
        return true;
      }
      if (typeof bridge.transport.sendFile === 'function' && bridge.transport.canFiles !== false) {
        fs.mkdirSync(bridge.inDir, { recursive: true });
        const safeBase = safeAttachmentName(exp.name, 'conversation.md');
        const fileName = safeBase.endsWith('.md') ? safeBase : `${safeBase}.md`;
        const dest = path.join(bridge.inDir, `export-${Date.now()}-${fileName}`);
        fs.writeFileSync(dest, exp.text, 'utf8');
        await sensSink.sendFile(dest, fileName, {});
        await sensSink.say(`📦 已导出 **${shownTargetName}** 当前会话（${fileName}）。`, {
          botId: activeTarget.id, botName: shownTargetName, threadId: activeTarget.threadId,
        });
      } else {
        await sensSink.say(mdClip(exp.text, bridge.resultChars).text, {
          botId: activeTarget.id, botName: shownTargetName, threadId: activeTarget.threadId,
        });
      }
    } catch (e) {
      await sensSink.say(`❌ 导出会话失败：${formatOmbError(e)}`);
    }
    return true;
  }

  const modelM = raw.match(/^(?:model|模型)(?:\s+([\s\S]+))?$/i);
  if (modelM) return isGroup ? singleBotOnlyHint() : handleModelCommand(bridge, activeTarget, (modelM[1] ?? '').trim(), sensSink);

  const apvM = raw.match(/^(?:approval|审批模式|审批)(?:\s+([\s\S]+))?$/i);
  if (apvM) {
    if (isGroup) return singleBotOnlyHint();
    const arg = (apvM[1] ?? '').trim().toLowerCase();
    try {
      const { bots = [] } = await bridge.client.listBots();
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

  const taskM = raw.match(/^(?:task|切换)\s+(.+)$/i);
  const taskChoice = taskM ? parseListChoice(taskM[1]) : null;
  if (taskChoice) {
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
      await bridge.switchTask(activeTarget.id, activeTarget.name, picked, { isGroup, chatId: sensSink.chatId });
    } catch (e) {
      await sensSink.say(`❌ 切换会话失败：${formatOmbError(e)}`);
    }
    return true;
  }

  const styleM = raw.match(/^(?:style|风格)(?:\s+(.*))?$/i);
  if (styleM) {
    if (isGroup) return singleBotOnlyHint();
    const arg = (styleM[1] ?? '').trim().toLowerCase();
    if (!arg || arg === 'show' || arg === '查看') {
      const curStyle = activeTarget.replyStyle ?? 'default';
      const hasSoul = Boolean(String(activeTarget.soul ?? '').trim());
      await sensSink.say(
        `🎨 **${shownTargetName}** 当前对话风格：\`${curStyle}\`（人格预设：${hasSoul ? '已配置' : '未配置'}）\n` +
        `发送 \`${cmdTarget} style cobot\` 开启协调助手风格，或 \`${cmdTarget} style default\` 恢复默认。`,
      );
      return true;
    }
    if (/^(cobot|co-bot|coordinator|grok|chat|conversational|mobile|私聊)$/.test(arg)) {
      try {
        const isChiefOrDefaultName = (bridge.chiefBotId && activeTarget.id === bridge.chiefBotId)
          || activeTarget.chiefOfStaff
          || /^(open)?mausbot$/i.test(String(activeTarget.name || '').trim());
        const profilePatch = {
          ...COBOT_COORDINATOR_PROFILE,
          ...(isChiefOrDefaultName ? { name: bridge.botName || 'co-bot', title: COBOT_COORDINATOR_TITLE } : {}),
        };
        await bridge.withCliLoopbackFallback((c) => c.patchBot(activeTarget.id, profilePatch));
        await bridge.refreshMultiBot();
        await sensSink.say(`✨ 已为 **${shownTargetName}** 应用协调助手风格（\`conversational\` + co-bot 精炼人格）。`);
      } catch (e) {
        await sensSink.say(`❌ 设置风格失败：${formatOmbError(e)}`);
      }
      return true;
    }
    if (/^(default|reset|默认|重置)$/.test(arg)) {
      try {
        await bridge.withCliLoopbackFallback((c) => c.patchBot(activeTarget.id, { replyStyle: 'default', soul: '' }));
        await bridge.refreshMultiBot();
        await sensSink.say(`🔄 已将 **${shownTargetName}** 恢复为默认风格。`);
      } catch (e) {
        await sensSink.say(`❌ 重置风格失败：${formatOmbError(e)}`);
      }
      return true;
    }
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
      bridge.pendingModelPick = null;
      bridge.setSelfThread?.(nextTarget);
      bridge.focus = { botId: nextTarget.id, botName: nextTarget.name, threadId: newThreadId, ...(isGroup ? { isGroup: true } : {}) };
      bridge.lastBotReplyAt = bridge.now();
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

  if (isDefault) {
    const typoHit = suggestClosestCommand(raw);
    if (typoHit) {
      const fullCmd = `${bridge.trigger} ${typoHit.fullSuggestion}`;
      await replySink.say(
        `🤔 未识别指令 \`${typoHit.typo}\`，你是不是想输入 \`${fullCmd}\`？`,
        null,
        null,
        [{ label: fullCmd, text: fullCmd, kind: 'primary' }],
      );
      return true;
    }
  }

  return false;
}
