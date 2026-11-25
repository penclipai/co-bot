/**
 * 跨群策略、外部 Thread 治理与自聊草稿确认回发管理器。
 */
import { formatImContextBlock, sanitizeExternalMentions } from '../core/chat-context.ts';
import { attachBotBadge, formatExternalBotPrefix } from '../core/security.ts';
import { clip } from '../format.ts';
import type { ChatType, ChatsMode } from '../types.ts';
import type { OpenMausBotBridge } from './bridge.ts';
import { formatDelegationResponse } from './delegation.ts';
import type { KnownChatSummary, PrivateDraft } from './types.ts';

export interface ChatPolicyView {
  mode: ChatsMode;
  configMode: ChatsMode;
  enabledTypes: ChatType[];
  allowChatIds: string[];
  denyChatIds: string[];
  muted: string[];
  allowed: string[];
}

export interface CompactedChatResult {
  botId: string;
  botName: string;
  threadId: string;
}

export function isExternalChatAllowed(bridge: OpenMausBotBridge, chatId: string, chatType: ChatType): boolean {
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

export function getChatPolicy(bridge: OpenMausBotBridge): ChatPolicyView {
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

export function listKnownChats(bridge: OpenMausBotBridge): KnownChatSummary[] {
  const byId = new Map<string, KnownChatSummary>();
  const touch = (id: string, patch: Partial<KnownChatSummary> = {}): void => {
    if (!id) return;
    const cid = String(id);
    const prev: KnownChatSummary = byId.get(cid) ?? {
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

  const threadMap = new Map<string, NonNullable<KnownChatSummary['threads']>>();
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

export function resolveKnownChat(
  bridge: OpenMausBotBridge,
  query: unknown,
  { includeSelf = false }: { includeSelf?: boolean } = {},
): KnownChatSummary | null {
  const q = String(query ?? '').trim();
  if (!q) return null;
  const low = q.toLowerCase();
  const list = listKnownChats(bridge).filter((c) => includeSelf || (c.type !== 'self' && c.id !== bridge.selfChat));
  return list.find((c) => c.id === q)
    ?? list.find((c) => String(c.name || '').toLowerCase() === low)
    ?? list.find((c) => String(c.name || '').toLowerCase().includes(low) || c.id.toLowerCase().includes(low))
    ?? null;
}

export async function compactExternalChat(
  bridge: OpenMausBotBridge,
  targetChat: { id?: string } | null | undefined,
  preferredBot: { id?: string } | null = null,
): Promise<CompactedChatResult[]> {
  if (!targetChat?.id || typeof bridge.client.compact !== 'function') return [];
  const cid = String(targetChat.id);
  const all = [...bridge.chatThreads.values()].filter((v) => v && v.chatId === cid && !v.isGroup);
  if (!all.length) return [];
  let picked = preferredBot?.id ? all.filter((v) => v.botId === preferredBot.id) : [];
  if (!picked.length) picked = all;
  const compacted: CompactedChatResult[] = [];
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

export async function buildExternalSummaryPrompt(
  bridge: OpenMausBotBridge,
  targetChat: { id: string; type?: ChatType; name?: string },
  { limit = 30, focusQuestion = '' }: { limit?: number; focusQuestion?: string } = {},
): Promise<{ count: number; header: string; text: string }> {
  const maxMsgs = Math.max(1, Math.min(200, Number(limit) || 30));
  const recentMsgs = bridge.imContext
    ? await bridge.imContext.getHistory(targetChat.id, { limit: maxMsgs })
    : bridge.localContextStore.getRecent(targetChat.id, { limit: maxMsgs });
  if (!recentMsgs.length) return { count: 0, header: '', text: '' };
  const header = formatImContextBlock({
    triggerEvent: {
      id: 'summary_req',
      chat: { id: targetChat.id, type: targetChat.type || 'group', name: targetChat.name || targetChat.id },
      sender: { id: 'me', name: '我', isSelf: true },
    },
    chatMeta: targetChat,
    recentMsgs,
    privateReply: true,
    maxRecentChars: Math.max(350, Number(bridge.chats.maxRecentMessageChars) || 280),
  });
  const extra = focusQuestion ? `\n\n请额外重点回答：${focusQuestion}` : '';
  const text = `请基于上述 <im-context> 中的「${targetChat.name || targetChat.id}」最近 ${recentMsgs.length} 条对话，用中文输出一份精炼清晰的只读纪要（仅总结给本人看）：\n1. 核心议题与背景\n2. 已达成结论 / 关键数据\n3. 待办事项、风险阻塞与负责人${extra}`;
  return { count: recentMsgs.length, header, text };
}

export function resolvePrivateDraft(
  bridge: OpenMausBotBridge,
  { quotedId = null, draftId = null }: { quotedId?: string | null; draftId?: string | null } = {},
): PrivateDraft | null {
  const cutoff = bridge.now() - 30 * 60_000;
  for (const [k, v] of bridge.privateDrafts) {
    if ((v.createdAt || 0) < cutoff) bridge.privateDrafts.delete(k);
  }
  if (draftId) {
    return bridge.privateDrafts.get(String(draftId)) ?? null;
  }
  if (quotedId && bridge.privateDrafts.has(String(quotedId))) {
    return bridge.privateDrafts.get(String(quotedId)) ?? null;
  }
  if (bridge.lastPrivateDraftId && bridge.privateDrafts.has(bridge.lastPrivateDraftId)) {
    return bridge.privateDrafts.get(bridge.lastPrivateDraftId) ?? null;
  }
  return [...bridge.privateDrafts.values()].at(-1) ?? null;
}

export async function requestSendBack(
  bridge: OpenMausBotBridge,
  draft: PrivateDraft | null | undefined,
  overrideText = '',
): Promise<string | null> {
  if (!draft?.originChatId) return null;
  const hasOverride = Boolean(String(overrideText ?? '').trim());
  const text = String(overrideText || draft.rawText || '').trim();
  if (!text) return null;
  const useBotPrefix = Boolean(!draft.delegationRe && (draft.forceBotPrefix || (!hasOverride && draft.addBotPrefix)));
  bridge.clearPickers();
  bridge.pendingSendBack = {
    draft,
    text,
    useBotPrefix,
    expiresAt: bridge.now() + 2 * 60_000,
  };
  const safePreview = sanitizeExternalMentions(text, {
    mode: bridge.chats.externalSanitizeMentions ?? 'all',
    botNames: bridge.getKnownBotNames(),
  });
  const quoteHint = draft.replyToImMsgId ? `，将引用原消息 \`${draft.replyToImMsgId}\`` : '';
  const attrLabel = draft.delegationRe
    ? '协作结果回传，带 🤖 协议标识'
    : (useBotPrefix ? `以 🤖 **[${bridge.botName}]** 名义` : '以本人名义直接发出');
  return bridge.say(
    `**📤 确认发回到「${draft.originChatName || draft.originChatId}」**（${attrLabel}${quoteHint}）\n> ${clip(safePreview, 600)}\n\n回复 \`确认发送\` 立即发出，回复 \`改：<新内容>\` 修改后再发，或回复 \`取消\``,
  );
}

export async function confirmSendBack(bridge: OpenMausBotBridge): Promise<string | null> {
  const pending = bridge.pendingSendBack;
  if (!pending || bridge.now() >= pending.expiresAt) {
    bridge.pendingSendBack = null;
    await bridge.say('⌛ 待发回草稿已超时，请引用私密草稿重新发送 `@bot sendback`。');
    return null;
  }
  bridge.pendingSendBack = null;
  const { draft, text, useBotPrefix } = pending;
  const applyBotPrefix = useBotPrefix ?? Boolean(draft.addBotPrefix);
  let safeBody = sanitizeExternalMentions(text, {
    mode: bridge.chats.externalSanitizeMentions ?? 'all',
    botNames: bridge.getKnownBotNames(),
  });
  if (draft.delegationRe) {
    safeBody = formatDelegationResponse({ re: draft.delegationRe, text: safeBody });
  } else if (applyBotPrefix) {
    const extPrefix = bridge.chats.externalBotPrefix ?? '🤖 ';
    if (extPrefix) {
      safeBody = extPrefix.trim() === '🤖'
        ? attachBotBadge(`🤖 **[${bridge.botName}]**`, safeBody)
        : formatExternalBotPrefix(safeBody, extPrefix);
    }
  }
  const sentId = await bridge.say(safeBody, { targetChatId: draft.originChatId }, draft.replyToImMsgId);
  if (!sentId) {
    await bridge.say(`❌ 发回「${draft.originChatName || draft.originChatId}」失败，请检查通道连接。`);
    return null;
  }
  bridge.recordOutboundToContext(draft.originChatId, {
    id: sentId,
    text: safeBody,
    replyTo: draft.replyToImMsgId ?? undefined,
    senderId: 'me',
    senderName: '我',
    isBotReply: Boolean(draft.delegationRe || applyBotPrefix),
  });
  if (draft.delegationRe) {
    bridge.emitTelemetry('delegation_res', {
      chatId: draft.originChatId,
      chatType: draft.originChatType,
      summary: `outbound re=${draft.delegationRe}`,
    });
  }
  bridge.emitTelemetry('sendback', {
    chatId: draft.originChatId,
    chatType: draft.originChatType,
    summary: safeBody,
  });
  for (const [k, v] of bridge.privateDrafts) {
    if (k === draft.id || k === draft.imMsgId || v?.id === draft.id) {
      bridge.privateDrafts.delete(k);
    }
  }
  if (bridge.lastPrivateDraftId === draft.id || bridge.lastPrivateDraftId === draft.imMsgId) {
    bridge.lastPrivateDraftId = null;
  }
  bridge.saveState();
  await bridge.say(`✅ 已发回「${draft.originChatName || draft.originChatId}」（已做防误艾特与安全脱敏处理）。`);
  return sentId;
}
