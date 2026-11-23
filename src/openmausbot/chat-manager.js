/**
 * 跨群策略、定时跨群汇总、外部 Thread 治理、自聊草稿确认回发与跨群检索状态管理器。
 */
import { clip } from '../format.js';
import { formatImContextBlock, sanitizeExternalMentions } from '../core/chat-context.js';
import { localDateKey, normalizeScheduleEntry, parseHHMM } from './mentions.js';

export function isExternalChatAllowed(bridge, chatId, chatType) {
  if (chatType === 'self') return true;
  const cid = String(chatId);
  const effMode = bridge.chatPolicyOverrides.mode || bridge.chats.mode || 'owner_everywhere';
  if (effMode === 'self_only') return false;
  if (Array.isArray(bridge.chats.enabledTypes) && !bridge.chats.enabledTypes.includes(chatType)) return false;
  if (bridge.chatPolicyOverrides.muted.has(cid)) return false;
  if (bridge.chatPolicyOverrides.allowed.has(cid)) return true;
  if (Array.isArray(bridge.chats.denyChatIds) && bridge.chats.denyChatIds.includes(cid)) return false;
  if (Array.isArray(bridge.chats.allowChatIds) && bridge.chats.allowChatIds.length > 0 && !bridge.chats.allowChatIds.includes(cid)) {
    return false;
  }
  return true;
}

export function getChatPolicy(bridge) {
  return {
    mode: bridge.chatPolicyOverrides.mode || bridge.chats.mode || 'owner_everywhere',
    configMode: bridge.chats.mode || 'owner_everywhere',
    enabledTypes: Array.isArray(bridge.chats.enabledTypes) ? [...bridge.chats.enabledTypes] : ['self', 'group', 'direct'],
    allowChatIds: Array.isArray(bridge.chats.allowChatIds) ? [...bridge.chats.allowChatIds] : [],
    denyChatIds: Array.isArray(bridge.chats.denyChatIds) ? [...bridge.chats.denyChatIds] : [],
    muted: [...bridge.chatPolicyOverrides.muted],
    allowed: [...bridge.chatPolicyOverrides.allowed],
  };
}

export function listKnownChats(bridge) {
  const byId = new Map();
  const touch = (id, patch = {}) => {
    if (!id) return;
    const cid = String(id);
    const prev = byId.get(cid) ?? {
      id: cid,
      type: cid === bridge.selfChat || cid === 'self' ? 'self' : 'direct',
      name: cid === bridge.selfChat || cid === 'self' ? '自聊' : cid,
      cachedMessages: 0,
      updatedAt: 0,
    };
    byId.set(cid, {
      ...prev,
      ...patch,
      name: patch.name || prev.name || cid,
      updatedAt: Math.max(prev.updatedAt || 0, Number(patch.updatedAt) || 0),
    });
  };

  const cachedList = bridge.imContext?.listChats?.() ?? bridge.localContextStore.listChats();
  for (const c of cachedList) {
    touch(c.id, { type: c.type, name: c.name, cachedMessages: c.count || 0, updatedAt: c.updatedAt || 0 });
  }
  for (const [cid, meta] of bridge.externalChatMeta) {
    touch(cid, { type: meta.type, name: meta.name });
  }
  for (const entry of bridge.chatThreads.values()) {
    touch(entry.chatId, { type: entry.chatType, name: entry.chatName });
  }
  for (const cid of [
    ...bridge.chatPolicyOverrides.muted,
    ...bridge.chatPolicyOverrides.allowed,
    ...(bridge.chats.denyChatIds || []),
    ...(bridge.chats.allowChatIds || []),
  ]) {
    touch(cid, {});
  }

  const threadMap = new Map();
  for (const entry of bridge.chatThreads.values()) {
    const list = threadMap.get(entry.chatId) ?? [];
    list.push({ botId: entry.botId, botName: entry.botName, threadId: entry.threadId, isGroup: Boolean(entry.isGroup) });
    threadMap.set(entry.chatId, list);
  }

  return [...byId.values()].map((c) => {
    const threads = threadMap.get(c.id) ?? [];
    return {
      ...c,
      muted: bridge.chatPolicyOverrides.muted.has(c.id),
      allowed: c.type === 'self' ? true : isExternalChatAllowed(bridge, c.id, c.type),
      threadCount: threads.length,
      threads,
    };
  }).sort((a, b) => (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id));
}

export function resolveKnownChat(bridge, query, { includeSelf = false } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return null;
  const low = q.toLowerCase();
  const list = listKnownChats(bridge).filter((c) => includeSelf || (c.type !== 'self' && c.id !== bridge.selfChat));
  return list.find((c) => c.id === q)
    ?? list.find((c) => String(c.name || '').toLowerCase() === low)
    ?? list.find((c) => String(c.name || '').toLowerCase().includes(low) || c.id.toLowerCase().includes(low))
    ?? null;
}

export async function compactExternalChat(bridge, targetChat, preferredBot = null) {
  if (!targetChat?.id || typeof bridge.client.compact !== 'function') return [];
  const cid = String(targetChat.id);
  const all = [...bridge.chatThreads.values()].filter((v) => v && v.chatId === cid && !v.isGroup);
  if (!all.length) return [];
  let picked = preferredBot?.id ? all.filter((v) => v.botId === preferredBot.id) : [];
  if (!picked.length) picked = all;
  const compacted = [];
  for (const entry of picked) {
    await bridge.client.compact(entry.botId, entry.threadId);
    bridge.contextWarnedThreads.delete(entry.threadId);
    const shownName = typeof bridge.displayBotName === 'function'
      ? bridge.displayBotName(entry.botId, entry.botName)
      : (entry.botName || bridge.botName || 'co-bot');
    compacted.push({ botId: entry.botId, botName: shownName, threadId: entry.threadId });
  }
  return compacted;
}

export function hydrateConfigSummaries(bridge) {
  const rawList = Array.isArray(bridge.chats.scheduledSummaries) ? bridge.chats.scheduledSummaries : [];
  for (let i = 0; i < rawList.length; i += 1) {
    const entry = normalizeScheduleEntry(rawList[i], { fromConfig: true, fallbackId: `cfg_${i + 1}` });
    if (entry) bridge.scheduledSummaries.push(entry);
  }
}

function resolveScheduleIndex(bridge, idxOrId) {
  const raw = String(idxOrId ?? '').trim();
  if (!raw) return -1;
  if (/^\d+$/.test(raw)) {
    const i = Number(raw) - 1;
    if (i >= 0 && i < bridge.scheduledSummaries.length) return i;
  }
  return bridge.scheduledSummaries.findIndex((s) => s.id === raw || s.chatId === raw);
}

export function addScheduledSummary(bridge, { chatId, chatName = '', chatType = 'group', time, days = null, limit = 40, focus = '' }) {
  const tStr = String(time ?? '').trim();
  if (parseHHMM(tStr) == null) throw new Error(`无效时间格式「${tStr}」，请使用 HH:MM（例如 18:00）`);
  const cid = String(chatId);
  const existing = bridge.scheduledSummaries.find((s) => s.chatId === cid && s.time === tStr);
  if (existing) {
    existing.chatName = chatName || existing.chatName;
    existing.focus = focus || existing.focus;
    existing.limit = Math.max(5, Math.min(80, Number(limit) || existing.limit));
    existing.enabled = true;
    bridge.saveState();
    return { ...existing };
  }
  const entry = normalizeScheduleEntry(
    { chatId: cid, chatName, chatType, time: tStr, days, limit, focus },
    { fromConfig: false, fallbackId: `sched_${bridge.now().toString(36)}_${bridge.scheduledSummaries.length + 1}` },
  );
  bridge.scheduledSummaries.push(entry);
  if (bridge.scheduledSummaries.length > 30) bridge.scheduledSummaries.shift();
  bridge.saveState();
  return { ...entry };
}

export function setScheduledSummaryEnabled(bridge, idxOrId, enabled) {
  const idx = resolveScheduleIndex(bridge, idxOrId);
  if (idx < 0) return null;
  bridge.scheduledSummaries[idx].enabled = Boolean(enabled);
  bridge.saveState();
  return { ...bridge.scheduledSummaries[idx] };
}

export function removeScheduledSummary(bridge, idxOrId) {
  const idx = resolveScheduleIndex(bridge, idxOrId);
  if (idx < 0) return null;
  const [removed] = bridge.scheduledSummaries.splice(idx, 1);
  bridge.saveState();
  return removed;
}

export async function buildExternalSummaryPrompt(bridge, targetChat, { limit = 30, focusQuestion = '' } = {}) {
  const maxMsgs = Math.max(5, Math.min(80, Number(limit) || 30));
  const recentMsgs = bridge.imContext
    ? await bridge.imContext.getHistory(targetChat.id, { limit: maxMsgs })
    : bridge.localContextStore.getRecent(targetChat.id, { limit: maxMsgs });
  if (!recentMsgs.length) return { count: 0, header: '', text: '' };
  const contextApi = bridge.imContext?.issueContextApiUrls?.(targetChat.id) ?? null;
  const header = formatImContextBlock({
    triggerEvent: {
      id: 'summary_req',
      chat: { id: targetChat.id, type: targetChat.type || 'group', name: targetChat.name || targetChat.id },
      sender: { id: 'me', name: '我', isSelf: true },
    },
    chatMeta: targetChat,
    recentMsgs,
    privateReply: true,
    contextApi,
    maxRecentChars: Math.max(350, Number(bridge.chats.maxRecentMessageChars) || 280),
  });
  const extra = focusQuestion ? `\n\n请额外重点回答：${focusQuestion}` : '';
  const text = `请基于上述 <im-context> 中的「${targetChat.name || targetChat.id}」最近 ${recentMsgs.length} 条对话，用中文输出一份精炼清晰的只读纪要（仅总结给本人看）：\n1. 核心议题与背景\n2. 已达成结论 / 关键数据\n3. 待办事项、风险阻塞与负责人\n若需翻看更早记录或附件细节，可调用 more_context_api。${extra}`;
  return { count: recentMsgs.length, header, text };
}

export async function runScheduledSummary(bridge, sched, { manual = false } = {}) {
  if (!sched?.chatId) return { ok: false, reason: 'invalid' };
  const known = resolveKnownChat(bridge, sched.chatId);
  const targetChat = known ?? {
    id: sched.chatId,
    name: sched.chatName || sched.chatId,
    type: sched.chatType || 'group',
  };
  const latestList = bridge.imContext
    ? await bridge.imContext.getHistory(targetChat.id, { limit: 1 })
    : bridge.localContextStore.getRecent(targetChat.id, { limit: 1 });
  const latestMsg = latestList.at(-1);
  if (!latestMsg) return { ok: false, reason: 'empty', chatName: targetChat.name };
  if (!manual && latestMsg.ts <= (sched.lastRunTs || 0)) {
    return { ok: false, reason: 'no_new_messages', chatName: targetChat.name };
  }

  const built = await buildExternalSummaryPrompt(bridge, targetChat, {
    limit: sched.limit || 40,
    focusQuestion: sched.focus || '',
  });
  if (!built.count) return { ok: false, reason: 'empty', chatName: targetChat.name };

  const nowMs = bridge.now();
  sched.lastRunDate = localDateKey(nowMs);
  sched.lastRunTs = Math.max(nowMs, Number(latestMsg.ts) || 0);
  bridge.saveState();

  if (!bridge.selfChat) return { ok: false, reason: 'no_self_chat', chatName: targetChat.name };
  const chief = await bridge.client.resolveBot('');
  if (!chief) return { ok: false, reason: 'no_bot', chatName: targetChat.name };
  const selfBot = await bridge.resolveSelfBotThread(chief);
  const prefix = manual
    ? `📋 **汇总 · 「${targetChat.name || targetChat.id}」**\n`
    : `🗓️ **定时群纪要 · 「${targetChat.name || targetChat.id}」**\n`;
  await bridge.dispatchToBot(
    selfBot,
    `${prefix}${built.text}`,
    null,
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
  return { ok: true, count: built.count, chatName: targetChat.name };
}

export async function tickScheduledSummaries(bridge, nowMs = bridge.now()) {
  if (!bridge.scheduledSummaries.length) return [];
  const d = new Date(Number(nowMs) || Date.now());
  const curMin = d.getHours() * 60 + d.getMinutes();
  const day = d.getDay();
  const dateKey = localDateKey(nowMs);
  const triggered = [];
  for (const sched of bridge.scheduledSummaries) {
    if (sched.enabled === false) continue;
    if (Array.isArray(sched.days) && sched.days.length && !sched.days.includes(day)) continue;
    if (sched.lastRunDate === dateKey) continue;
    const targetMin = parseHHMM(sched.time);
    if (targetMin == null) continue;
    if (curMin >= targetMin && (curMin - targetMin) <= 5) {
      sched.lastRunDate = dateKey;
      const res = await runScheduledSummary(bridge, sched, { manual: false });
      if (res.ok) triggered.push(res);
    }
  }
  return triggered;
}

export function resolvePrivateDraft(bridge, { quotedId = null, draftId = null } = {}) {
  const cutoff = bridge.now() - 30 * 60_000;
  for (const [k, v] of bridge.privateDrafts) {
    if ((v.createdAt || 0) < cutoff) bridge.privateDrafts.delete(k);
  }
  if (draftId && bridge.privateDrafts.has(String(draftId))) {
    return bridge.privateDrafts.get(String(draftId));
  }
  if (quotedId && bridge.privateDrafts.has(String(quotedId))) {
    return bridge.privateDrafts.get(String(quotedId));
  }
  if (bridge.lastPrivateDraftId && bridge.privateDrafts.has(bridge.lastPrivateDraftId)) {
    return bridge.privateDrafts.get(bridge.lastPrivateDraftId);
  }
  return [...bridge.privateDrafts.values()].at(-1) ?? null;
}

export async function requestSendBack(bridge, draft, overrideText = '') {
  if (!draft?.originChatId) return null;
  const text = String(overrideText || draft.rawText || '').trim();
  if (!text) return null;
  bridge.clearPickers();
  bridge.pendingSendBack = {
    draft,
    text,
    expiresAt: bridge.now() + 2 * 60_000,
  };
  const safePreview = sanitizeExternalMentions(text, {
    mode: bridge.chats.externalSanitizeMentions ?? 'all',
    botNames: bridge.getKnownBotNames(),
  });
  const quoteHint = draft.replyToImMsgId ? `（将引用原消息 \`${draft.replyToImMsgId}\`）` : '';
  return bridge.say(
    `📤 **确认发回到「${draft.originChatName || draft.originChatId}」**${quoteHint}\n> ${clip(safePreview, 600)}\n\n回复 \`确认发送\` 立即发出，回复 \`改：<新内容>\` 修改后再发，或回复 \`取消\``,
    null,
    null,
    [
      { label: '确认发送', text: '确认发送', kind: 'primary' },
      { label: '取消', text: '取消', kind: 'danger' },
    ],
  );
}

export async function confirmSendBack(bridge) {
  const pending = bridge.pendingSendBack;
  if (!pending || bridge.now() >= pending.expiresAt) {
    bridge.pendingSendBack = null;
    await bridge.say('⌛ 待发回草稿已超时，请引用私密草稿重新发送 `@bot sendback`。');
    return null;
  }
  bridge.pendingSendBack = null;
  const { draft, text } = pending;
  const safeBody = sanitizeExternalMentions(text, {
    mode: bridge.chats.externalSanitizeMentions ?? 'all',
    botNames: bridge.getKnownBotNames(),
  });
  const sentId = await bridge.say(safeBody, { targetChatId: draft.originChatId }, draft.replyToImMsgId);
  if (!sentId) {
    await bridge.say(`❌ 发回「${draft.originChatName || draft.originChatId}」失败，请检查通道连接。`);
    return null;
  }
  bridge.recordOutboundToContext(draft.originChatId, {
    id: sentId,
    text: safeBody,
    replyTo: draft.replyToImMsgId,
    senderId: 'me',
    senderName: '我',
    isBotReply: false,
  });
  bridge.emitTelemetry('sendback', {
    chatId: draft.originChatId,
    chatType: draft.originChatType,
    summary: safeBody,
  });
  await bridge.say(`✅ 已发回「${draft.originChatName || draft.originChatId}」（已做防误艾特处理）。`);
  return sentId;
}

export async function searchAcrossChats(bridge, query, { chatQuery = '', limit = 10 } = {}) {
  const scopedChat = chatQuery ? resolveKnownChat(bridge, chatQuery, { includeSelf: true }) : null;
  if (chatQuery && !scopedChat) return { hits: [], scopedChat: null, missingChat: chatQuery };
  const chatId = scopedChat?.id ?? null;
  const hits = bridge.imContext?.searchAllChats
    ? await bridge.imContext.searchAllChats(query, { limit, chatId, excludeSelf: true })
    : bridge.localContextStore.searchAll(query, { limit, chatId, excludeSelf: true });
  return { hits, scopedChat, missingChat: null };
}
