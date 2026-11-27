/**
 * Bot 发现上下文缺失时发起的 `@同事` 追问提案、确认发回与一次性回复回流闭环。
 */
import { clip } from '../format.ts';
import type { ChatType, InboundEvent } from '../types.ts';
import type { OpenMausBotBridge } from './bridge.ts';
import { requestSendBack } from './chat-manager.ts';
import { dispatchToBot } from './dispatch.ts';
import { buildExternalChatCtx } from './inbound-router.ts';
import { allocateInboxRef, recordClosedInboxRef } from './inbox.ts';
import { trimMapCap } from './mentions.ts';
import type { BridgeChatContext, CompactChatContext, PrivateDraft } from './types.ts';

const ASK_TAG_RE = /(?:^|\n)(?:```[^\n]*\n)?\s*(?:[-*]\s+)?`?\[cobot:ask\s+([^\]]+)\]\s*([\s\S]+?)\s*$/i;

export interface AskProposal {
  chatRef: string;
  toRef: string;
  question: string;
}

/** 从 Bot 回复末尾解析并剥离 `[cobot:ask chat=<会话> to=<用户>] <追问问题>` 提案标记。 */
export function parseAskProposal(rawText: string): { cleanText: string; proposal: AskProposal | null } {
  const s = String(rawText ?? '').trim();
  const m = s.match(ASK_TAG_RE);
  if (!m) return { cleanText: s, proposal: null };

  const attrsRaw = m[1] || '';
  const question = (m[2] || '')
    .replace(/\n?```\s*$/g, '')
    .replace(/`+\s*$/g, '')
    .trim();
  const cleanText = s.slice(0, m.index).trim();
  if (!question) return { cleanText: cleanText || s, proposal: null };

  const readAttr = (key: string): string => {
    const re = new RegExp(`(?:^|\\s)${key}=(?:"([^"]+)"|'([^']+)'|(\\S+))`, 'i');
    const hit = attrsRaw.match(re);
    return String(hit?.[1] || hit?.[2] || hit?.[3] || '').trim();
  };

  const toRef = readAttr('to');
  const chatRef = readAttr('chat');
  if (!toRef) return { cleanText: cleanText || s, proposal: null };
  return {
    cleanText: cleanText || `ℹ️ 需要向 ${toRef} 进一步确认信息，已生成待确认追问。`,
    proposal: { chatRef, toRef, question },
  };
}

/** 根据 Bot 追问提案构建带结构化 `mentions` 的待确认草稿并推送至主人自聊确认。 */
export async function createAskDraftAndConfirm(
  bridge: OpenMausBotBridge,
  {
    proposal,
    botId,
    botName,
    threadId,
    isGroup,
    chatCtx,
  }: {
    proposal: AskProposal;
    botId: string;
    botName: string;
    threadId: string;
    isGroup: boolean;
    chatCtx?: CompactChatContext | BridgeChatContext | null;
  },
): Promise<string | null> {
  if (!bridge.selfChat) return null;
  const targetChat = proposal.chatRef
    ? (bridge.resolveKnownChat(proposal.chatRef) ?? { id: proposal.chatRef, name: proposal.chatRef, type: 'group' as ChatType })
    : (chatCtx?.originChatId ? { id: chatCtx.originChatId, name: chatCtx.chatName || chatCtx.originChatId, type: (chatCtx.chatType || 'group') as ChatType } : null);

  if (!targetChat?.id || targetChat.type === 'self' || (bridge.selfChat ? targetChat.id === bridge.selfChat : targetChat.id === 'self')) {
    await bridge.say(`⚠️ Bot 建议向 **${proposal.toRef}** 追问「${clip(proposal.question, 80)}」，但未能确定目标外部群/私聊。`);
    return null;
  }

  const parts = proposal.toRef.split('|').map((x) => x.trim()).filter(Boolean);
  const rawRef = parts[0] || proposal.toRef;
  const labelHint = parts[1] || '';
  const ctxStore = bridge.imContext?.store ?? bridge.localContextStore;
  const learned = ctxStore.findMember(targetChat.id, rawRef) ?? (labelHint ? ctxStore.findMember(targetChat.id, labelHint) : null);

  const targetUserId = learned?.id || (parts.length > 1 ? rawRef : null);
  const targetName = learned?.name || labelHint || rawRef.replace(/^@/, '');
  const mentionPrefix = `@${targetName}`;
  const askBody = proposal.question.includes(mentionPrefix)
    ? proposal.question
    : `${mentionPrefix} ${proposal.question}`;

  const draftId = `draft_${bridge.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const draft: PrivateDraft = {
    id: draftId,
    inboxRef: allocateInboxRef(bridge),
    imMsgId: draftId,
    originChatId: targetChat.id,
    originChatName: targetChat.name || targetChat.id,
    originChatType: targetChat.type || 'group',
    replyToImMsgId: chatCtx?.originQuoteId ?? chatCtx?.replyToImMsgId ?? null,
    rawText: askBody,
    addBotPrefix: Boolean(bridge.chats.externalBotPrefix),
    mentions: targetUserId ? [{ id: targetUserId, name: targetName }] : undefined,
    allowMentionNames: targetName ? [targetName] : undefined,
    followUp: {
      botId,
      botName,
      threadId,
      isGroup,
      targetUserId,
      targetName,
      question: askBody,
    },
    createdAt: bridge.now(),
  };

  bridge.privateDrafts.set(draft.id, draft);
  trimMapCap(bridge.privateDrafts, 30);
  const sentId = await requestSendBack(bridge, draft);
  if (sentId) {
    draft.imMsgId = sentId;
    bridge.privateDrafts.set(sentId, draft);
  }
  bridge.lastPrivateDraftId = draft.id;
  bridge.saveState();
  return sentId;
}

/** 拦截目标同事对追问的回复，一次性消费跟踪记录并自动接回原分析线程（结果仅发回主人自聊）。 */
export async function handleFollowUpReply(bridge: OpenMausBotBridge, ev: InboundEvent): Promise<boolean> {
  if (!ev || ev.chat?.type === 'self' || ev.sender?.isSelf) return false;
  if (!bridge.pendingFollowUps.size) return false;
  const chatId = String(ev.chat.id);
  const nowTs = bridge.now();
  for (const [k, v] of bridge.pendingFollowUps) {
    if (v.expiresAt <= nowTs) bridge.pendingFollowUps.delete(k);
  }

  const replyTo = ev.replyTo != null ? String(ev.replyTo) : '';
  const senderId = String(ev.sender?.id ?? '');
  const senderName = String(ev.sender?.name ?? '').trim().toLowerCase();

  let matched: typeof bridge.pendingFollowUps extends Map<string, infer V> ? V | null : null = null;
  for (const fp of bridge.pendingFollowUps.values()) {
    if (fp.chatId !== chatId) continue;
    // 若对方明确引用了其他无关消息，不应误触发本条追问回流
    if (replyTo && fp.askMsgId && replyTo !== fp.askMsgId) continue;
    const hitQuote = Boolean(replyTo && replyTo === fp.askMsgId);
    const hitId = Boolean(fp.targetUserId && senderId && fp.targetUserId === senderId);
    const hitName = Boolean(!fp.targetUserId && fp.targetName && senderName && senderName === fp.targetName.toLowerCase());
    if (hitQuote || hitId || hitName) {
      matched = fp;
      break;
    }
  }
  if (!matched) return false;

  // 一次性消费：防止后续普通对话再次触发回流或死循环
  bridge.pendingFollowUps.delete(matched.id);
  recordClosedInboxRef(bridge, matched.inboxRef, `追问 @${matched.targetName}`);
  if (Array.isArray(ev.attachments) && ev.attachments.length) {
    bridge.setFileMsg(chatId, String(ev.id), ev.attachments);
  }
  bridge.saveState();
  const who = ev.sender?.name || ev.sender?.id || matched.targetName;
  const replyText = String(ev.text ?? '').trim();

  bridge.emitTelemetry('followup_reply', {
    chatId,
    chatType: ev.chat.type,
    summary: `from=${who} thread=${matched.threadId}`,
  });

  if (bridge.selfChat) {
    await bridge.say(
      `💬 **收到「${matched.chatName}」${who} 的追问回复**\n> ${clip(replyText || '[附件消息]', 300)}\n\n正在交由 **${matched.botName}** 结合前文继续分析并私密回复你…`,
    );
  }

  const chatCtx = buildExternalChatCtx(bridge, {
    isSelfChat: false,
    chatId,
    chatType: ev.chat.type || matched.chatType,
    chatName: ev.chat.name || matched.chatName,
    mid: String(ev.id),
    privateReply: true,
    ev,
  });
  const resumePrompt =
    `[追问已获「${who}」补充回复 · 来自「${matched.chatName}」]\n` +
    `此前追问：${matched.question}\n` +
    `对方回复：${replyText || '（见附带文件/消息）'}\n\n` +
    `请结合此回复与此前上下文完成分析并给出结论。`;

  await dispatchToBot(
    bridge,
    { id: matched.botId, name: matched.botName, threadId: matched.threadId, isGroup: matched.isGroup },
    resumePrompt,
    String(ev.id),
    ev.replyTo ?? null,
    null,
    chatCtx,
  );
  return true;
}
