/**
 * 跨群策略、外部 Thread 治理与自聊草稿确认回发管理器。
 */
import { formatImContextBlock, sanitizeExternalMentions } from '../core/chat-context.ts';
import { attachBotBadge, detectInternalOpsLeak, formatExternalBotPrefix } from '../core/security.ts';
import { clip } from '../format.ts';
import type { ChannelAction, ChatType, ChatsMode } from '../types.ts';
import type { OpenMausBotBridge } from './bridge.ts';
import { formatDelegationResponse } from './delegation.ts';
import { allocateInboxRef, formatCoordinatorInboxLines, getCoordinatorInbox, recordClosedInboxRef } from './inbox.ts';
import { inQuietHours, trimMapCap } from './mentions.ts';
import { invalidateBotListCache } from './thread-manager.ts';
import type { KnownChatSummary, PendingSendBack, PrivateDraft } from './types.ts';

export { formatCoordinatorInboxLines, getCoordinatorInbox };

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
    const isSelfEntry = bridge.selfChat ? cid === bridge.selfChat : cid === 'self';
    const prev: KnownChatSummary = byId.get(cid) ?? {
      id: cid,
      type: isSelfEntry ? 'self' : 'direct',
      name: isSelfEntry ? '自聊' : cid,
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
    invalidateBotListCache(bridge);
    bridge.contextWarnedThreads.delete(entry.threadId);
    bridge.threadInjectedScope.delete(entry.threadId);
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
  { limit = 30, focusQuestion = '', botId = '' }: { limit?: number; focusQuestion?: string; botId?: string } = {},
): Promise<{ count: number; header: string; text: string }> {
  const maxMsgs = Math.max(1, Math.min(200, Number(limit) || 30));
  const recentMsgs = bridge.imContext
    ? await bridge.imContext.getHistory(targetChat.id, { limit: maxMsgs })
    : bridge.localContextStore.getRecent(targetChat.id, { limit: maxMsgs });
  if (!recentMsgs.length) return { count: 0, header: '', text: '' };
  const storeRef = bridge.imContext?.store ?? bridge.localContextStore;
  const stats = storeRef.getAvailableStats(targetChat.id);
  const pullHint = bridge.imContext?.getContextPullHint
    ? bridge.imContext.getContextPullHint(targetChat.id, {
        availableCount: Math.max(recentMsgs.length, stats.count),
        availableFiles: stats.fileCount,
        pullOnly: true,
        botId: botId || bridge.chiefBotId || undefined,
        readonly: false,
      })
    : '';
  const extra = focusQuestion ? `\n\n请额外重点回答：${focusQuestion}` : '';
  if (pullHint) {
    const header = formatImContextBlock({
      triggerEvent: {
        id: 'summary_req',
        chat: { id: targetChat.id, type: targetChat.type || 'group', name: targetChat.name || targetChat.id },
        sender: { id: 'me', name: '我', isSelf: true },
      },
      chatMeta: targetChat,
      recentMsgs: [],
      privateReply: true,
      historyPullHint: pullHint,
    });
    const text = `请通过 \`context_pull\` 按需拉取「${targetChat.name || targetChat.id}」最近最多 ${maxMsgs} 条对话（先用 \`&limit=${Math.min(20, maxMsgs)}&excludeBots=1\` 聚焦人类讨论，必要时用 \`&before=\` 向前翻页或 \`&onlyFiles=1\`/\`&msgId=\` 查转发与文件），用中文输出一份精炼清晰的只读纪要（仅总结给本人看）：\n1. 核心议题与背景\n2. 已达成结论 / 关键数据\n3. 待办事项、风险阻塞与负责人${extra}`;
    return { count: recentMsgs.length, header, text };
  }
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
  const text = `请基于上述 <im-context> 中的「${targetChat.name || targetChat.id}」最近 ${recentMsgs.length} 条对话，用中文输出一份精炼清晰的只读纪要（仅总结给本人看）：\n1. 核心议题与背景\n2. 已达成结论 / 关键数据\n3. 待办事项、风险阻塞与负责人${extra}`;
  return { count: recentMsgs.length, header, text };
}

export function resolvePrivateDraft(
  bridge: OpenMausBotBridge,
  { quotedId = null, draftId = null }: { quotedId?: string | null; draftId?: string | null } = {},
): PrivateDraft | null {
  const cutoff = bridge.now() - (Number(bridge.draftTtlMs) || 30 * 60_000);
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

function resolvePendingSendBackEntry(
  bridge: OpenMausBotBridge,
  targetRef?: string | null,
): { key: string; entry: PendingSendBack } | null {
  const now = bridge.now();
  for (const [k, v] of bridge.pendingSendBacks) {
    if (!v || v.expiresAt <= now) bridge.pendingSendBacks.delete(k);
  }
  const ref = String(targetRef || '').trim();
  if (ref) {
    const direct = bridge.pendingSendBacks.get(ref);
    if (direct) return { key: ref, entry: direct };
    for (const [k, v] of bridge.pendingSendBacks) {
      if (v.id === ref || v.imMsgId === ref || v.draft?.id === ref) {
        return { key: k, entry: v };
      }
    }
    return null;
  }
  const last = [...bridge.pendingSendBacks.entries()].at(-1);
  return last ? { key: last[0], entry: last[1] } : null;
}

function purgePrivateDraft(bridge: OpenMausBotBridge, draft: PrivateDraft): void {
  const extraIds = Array.isArray(draft.imMsgIds) ? draft.imMsgIds : [];
  bridge.draftStore.purge(draft.id);
  if (bridge.lastPrivateDraftId === draft.id || bridge.lastPrivateDraftId === draft.imMsgId || extraIds.includes(bridge.lastPrivateDraftId || '')) {
    bridge.lastPrivateDraftId = null;
  }
}

export async function discardPrivateDraft(bridge: OpenMausBotBridge, draft: PrivateDraft): Promise<string | null> {
  recordClosedInboxRef(bridge, draft.inboxRef, `私密草稿「${draft.originChatName || draft.originChatId}」`);
  purgePrivateDraft(bridge, draft);
  bridge.saveState();
  return bridge.say(`❎ 已忽略来自「${draft.originChatName || draft.originChatId}」的草稿。`);
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
  bridge.pendingTaskPick = null;
  const ref = draft.inboxRef ?? allocateInboxRef(bridge);
  draft.inboxRef = ref;
  const entryId = draft.id || `sb_${bridge.now().toString(36)}`;
  const entry: PendingSendBack = {
    id: entryId,
    inboxRef: ref,
    draft,
    text,
    useBotPrefix,
    expiresAt: bridge.now() + 10 * 60_000,
  };
  const now = bridge.now();
  for (const [k, v] of bridge.pendingSendBacks) {
    if (!v || v.expiresAt <= now) bridge.pendingSendBacks.delete(k);
  }
  bridge.pendingSendBacks.set(entryId, entry);
  trimMapCap(bridge.pendingSendBacks, 10);
  const safePreview = sanitizeExternalMentions(text, {
    mode: bridge.chats.externalSanitizeMentions ?? 'all',
    botNames: bridge.getKnownBotNames(),
    allowNames: draft.allowMentionNames,
  });
  const quoteHint = draft.replyToImMsgId ? `，将引用原消息 \`${draft.replyToImMsgId}\`` : '';
  const askHint = draft.followUp
    ? (draft.mentions?.length
      ? `，将真 @${draft.followUp.targetName}（\`${draft.mentions[0].id}\`）提醒并在对方回复后自动续分析`
      : `，未匹配到「${draft.followUp.targetName}」的用户 ID，将按纯文本提及发出`)
    : '';
  const extPrefix = bridge.chats.externalBotPrefix ?? '🤖 ';
  const badgeLabel = bridge.badgeName(bridge.chiefBotId, bridge.botName);
  const attrLabel = draft.delegationRe
    ? '协作结果回传，带 🤖 协议标识'
    : (useBotPrefix && extPrefix
      ? (extPrefix.trim() === '🤖' ? `以 🤖 **[${badgeLabel}]** 名义` : `以「${extPrefix.trim()}」前缀`)
      : '以本人名义直接发出');
  const titleText = draft.followUp
    ? `**📤 确认向「${draft.originChatName || draft.originChatId}」追问 @${draft.followUp.targetName}**`
    : `**📤 确认发回到「${draft.originChatName || draft.originChatId}」**`;
  const actions: ChannelAction[] = [
    { label: '确认发送', text: `${bridge.trigger} sendback confirm ${entryId}`, kind: 'primary' },
    { label: '取消', text: `${bridge.trigger} sendback cancel ${entryId}`, kind: 'danger' },
  ];
  const sentId = await bridge.say(
    `${titleText}（\`#${ref}\` · ${attrLabel}${quoteHint}${askHint}）\n> ${clip(safePreview, 600)}\n\n回复 \`确认发送\` 或 \`#${ref} 确认\` 立即发出，回复 \`改：<新内容>\` 修改后再发，或回复 \`取消\``,
    null,
    null,
    actions,
  );
  if (sentId) {
    entry.imMsgId = sentId;
    bridge.draftStore.setConfirmingImMsgId(entryId, sentId);
  }
  bridge.lastExpiredSendBackAt = 0;
  bridge.saveState();
  return sentId;
}

export async function confirmDraftDirect(bridge: OpenMausBotBridge, draft: PrivateDraft): Promise<string | null> {
  const text = String(draft.rawText || '').trim();
  if (!text) return null;
  const ref = draft.inboxRef ?? allocateInboxRef(bridge);
  draft.inboxRef = ref;
  const entryId = draft.id || `sb_${bridge.now().toString(36)}`;
  bridge.pendingSendBacks.set(entryId, {
    id: entryId,
    inboxRef: ref,
    draft,
    text,
    useBotPrefix: Boolean(!draft.delegationRe && (draft.forceBotPrefix || draft.addBotPrefix)),
    expiresAt: bridge.now() + 10 * 60_000,
  });
  return confirmSendBack(bridge, entryId);
}

export async function cancelSendBack(
  bridge: OpenMausBotBridge,
  targetRef?: string | null,
  { discardDraft = false }: { discardDraft?: boolean } = {},
): Promise<string | null> {
  const hit = resolvePendingSendBackEntry(bridge, targetRef);
  if (!hit) {
    return bridge.say('当前没有待取消的发回确认。');
  }
  const ref = hit.entry.inboxRef ?? hit.entry.draft?.inboxRef;
  recordClosedInboxRef(bridge, ref, `发回预览「${hit.entry.draft?.originChatName || hit.entry.draft?.originChatId || ''}」`);
  bridge.pendingSendBacks.delete(hit.key);
  if ((discardDraft || hit.entry.draft?.followUp) && hit.entry.draft) {
    purgePrivateDraft(bridge, hit.entry.draft);
  }
  bridge.saveState();
  return bridge.say(`❎ 已取消发回原群${ref ? `（\`#${ref}\`）` : ''}。`);
}

export async function confirmSendBack(bridge: OpenMausBotBridge, targetRef?: string | null): Promise<string | null> {
  const hit = resolvePendingSendBackEntry(bridge, targetRef);
  if (!hit) {
    await bridge.say(`⌛ 待发回草稿已超时，请引用私密草稿重新发送 \`${bridge.trigger} sendback\`。`);
    return null;
  }
  const pending = hit.entry;
  const { draft, text, useBotPrefix } = pending;
  const ref = pending.inboxRef ?? draft.inboxRef;
  const applyBotPrefix = useBotPrefix ?? Boolean(draft.addBotPrefix);
  let safeBody = sanitizeExternalMentions(text, {
    mode: bridge.chats.externalSanitizeMentions ?? 'all',
    botNames: bridge.getKnownBotNames(),
    allowNames: draft.allowMentionNames,
  });
  const isUneditedOrBotAttributed = text === String(draft.rawText || '').trim() || applyBotPrefix;
  if (isUneditedOrBotAttributed) {
    const leak = detectInternalOpsLeak(safeBody);
    if (leak.matched) {
      bridge.emitTelemetry('internal_leak_intercepted', {
        chatId: draft.originChatId,
        chatType: draft.originChatType,
        summary: `${leak.reason} sendback=${draft.id}`,
      });
      await bridge.say(
        `⚠️ **已拦截待发回草稿中的内部运维细节**（\`#${ref ?? draft.id}\` · ${leak.reason}）\n请回复 \`改：<新内容>\` 修改后再发，或回复 \`取消\`。`,
      );
      return null;
    }
  }
  if (draft.delegationRe) {
    safeBody = formatDelegationResponse({ re: draft.delegationRe, text: safeBody });
  } else if (applyBotPrefix) {
    const extPrefix = bridge.chats.externalBotPrefix ?? '🤖 ';
    if (extPrefix) {
      const badgeLabel = bridge.badgeName(bridge.chiefBotId, bridge.botName);
      safeBody = extPrefix.trim() === '🤖'
        ? attachBotBadge(`🤖 **[${badgeLabel}]**`, safeBody)
        : formatExternalBotPrefix(safeBody, extPrefix);
    }
  }
  let pendingFpId: string | null = null;
  let fpRef: number | undefined;
  if (draft.followUp) {
    const nowTs = bridge.now();
    pendingFpId = `fp_${nowTs.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    fpRef = allocateInboxRef(bridge);
    bridge.pendingFollowUps.set(pendingFpId, {
      id: pendingFpId,
      inboxRef: fpRef,
      chatId: draft.originChatId,
      chatName: draft.originChatName || draft.originChatId,
      chatType: draft.originChatType,
      askMsgId: '',
      targetUserId: draft.followUp.targetUserId,
      targetName: draft.followUp.targetName,
      botId: draft.followUp.botId,
      botName: draft.followUp.botName,
      threadId: draft.followUp.threadId,
      isGroup: draft.followUp.isGroup,
      question: text,
      createdAt: nowTs,
      expiresAt: nowTs + 30 * 60_000,
    });
  }
  const sentId = await bridge.say(
    safeBody,
    { targetChatId: draft.originChatId },
    draft.replyToImMsgId,
    null,
    { noBuffer: true, ...(draft.mentions?.length ? { mentions: draft.mentions } : {}) },
  );
  if (!sentId) {
    if (pendingFpId) bridge.pendingFollowUps.delete(pendingFpId);
    bridge.draftStore.extendConfirming(hit.key, bridge.now() + 2 * 60_000);
    bridge.saveState();
    await bridge.say(`❌ 发回「${draft.originChatName || draft.originChatId}」失败，已保留待发草稿${ref ? ` \`#${ref}\`` : ''}，请检查通道连接后重试。`);
    return null;
  }
  bridge.pendingSendBacks.delete(hit.key);
  recordClosedInboxRef(bridge, ref, `发回「${draft.originChatName || draft.originChatId}」`);
  if (pendingFpId) {
    const fp = bridge.pendingFollowUps.get(pendingFpId);
    if (fp) fp.askMsgId = sentId;
  }
  bridge.recordOutboundToContext(draft.originChatId, {
    id: sentId,
    text: safeBody,
    replyTo: draft.replyToImMsgId ?? undefined,
    senderId: bridge.selfUserId || 'me',
    senderName: '我',
    isBotReply: Boolean(draft.delegationRe || applyBotPrefix),
    ...(applyBotPrefix ? { botId: draft.followUp?.botId || bridge.chiefBotId || undefined } : {}),
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
  purgePrivateDraft(bridge, draft);
  bridge.saveState();
  const awaitingFollowUp = Boolean(pendingFpId && bridge.pendingFollowUps.has(pendingFpId));
  await bridge.say(
    draft.followUp
      ? `✅ 已向「${draft.originChatName || draft.originChatId}」发送追问${awaitingFollowUp ? `（将等待 **${draft.followUp.targetName}** 回复后自动继续分析${fpRef ? `，可回复 \`#${fpRef} 取消\` 停止等待` : ''}）` : '。'}`
      : `✅ 已发回「${draft.originChatName || draft.originChatId}」（已做防误艾特与安全脱敏处理）。`,
  );
  return sentId;
}

/** 对超时未获回复的 @同事追问与 C2C 委托向自聊发送单次提醒。 */
export async function checkPendingReminders(bridge: OpenMausBotBridge): Promise<number> {
  if (!bridge.selfChat || inQuietHours(bridge.now(), bridge.quietHours)) return 0;
  const now = bridge.now();
  const fpThreshold = Number(bridge.followUpRemindMs) || 0;
  const delThreshold = Number(bridge.delegationRemindMs) || 0;
  let sentCount = 0;
  let changed = bridge.delegations.pruneExpired(24 * 60 * 60_000) > 0;

  for (const [k, fp] of bridge.pendingFollowUps) {
    if (!fp || fp.expiresAt <= now) {
      recordClosedInboxRef(bridge, fp?.inboxRef, `追问 @${fp?.targetName || ''}`);
      bridge.pendingFollowUps.delete(k);
      changed = true;
      continue;
    }
    const createdAt = fp.createdAt || now;
    if (fpThreshold > 0 && !fp.remindedAt && (now - createdAt) >= fpThreshold) {
      fp.remindedAt = now;
      changed = true;
      sentCount += 1;
      const mins = Math.max(1, Math.round((now - createdAt) / 60_000));
      const cancelHint = fp.inboxRef ? `，回复 \`#${fp.inboxRef} 取消\` 可停止等待` : '';
      await bridge.say(
        `⏰ **追问超时提醒**：在「${fp.chatName || fp.chatId}」向 **${fp.targetName}** 的追问已等待 ${mins} 分钟尚未收到回复（\`${clip(fp.question.replace(/\s+/g, ' '), 50)}\`${cancelHint}）。`,
      );
    }
  }

  for (const d of bridge.delegations.pendingOutbound.values()) {
    const createdAt = d.createdAt || 0;
    if (delThreshold > 0 && createdAt > 0 && !d.remindedAt && (now - createdAt) >= delThreshold) {
      d.remindedAt = now;
      changed = true;
      sentCount += 1;
      const mins = Math.max(1, Math.round((now - createdAt) / 60_000));
      const cancelHint = d.inboxRef ? `（\`#${d.inboxRef}\`，回 \`#${d.inboxRef} 取消\` 可停止追踪）` : '';
      await bridge.say(
        `⏰ **协作委托超时提醒**：向「${d.targetChatName || d.targetChatId}」发出的委托 \`${d.id}\` 已等待 ${mins} 分钟未回传${cancelHint}（${clip((d.question || '').replace(/\s+/g, ' '), 50)}）。`,
      );
    }
  }

  if (changed) bridge.saveState();
  return sentCount;
}
