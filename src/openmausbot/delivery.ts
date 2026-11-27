import fs from 'node:fs';
import path from 'node:path';
import { isAudioAttachment } from '../core/channel-contract.ts';
import { sanitizeExternalMentions, SELF_NOTE_PREFIX_RE } from '../core/chat-context.ts';
import { attachBotBadge, detectInternalOpsLeak, formatExternalBotPrefix, redactTextFileBeforeSend, scanAndRedactOutbound } from '../core/security.ts';
import { clip, fileSafe, mdClip, mdSplit, plain, safeAttachmentName } from '../format.ts';
import type { ChannelAction, ChannelSendOptions, InboundAttachment } from '../types.ts';
import type { OpenMausBotBridge } from './bridge.ts';
import { extractWidgetActions, fmtTokens, formatCardPrompt, formatOmbError } from './cards.ts';
import { botCommandTarget, formatOriginBanner } from './command-helpers.ts';
import { formatDelegationResponse } from './delegation.ts';
import { createAskDraftAndConfirm, parseAskProposal } from './follow-up.ts';
import { allocateInboxRef } from './inbox.ts';
import { compactChatCtx, rememberBounded, trimMapCap, unscopeMsgKey } from './mentions.ts';
import type { BridgeChatContext, CompactChatContext, MsgRoute, OmbMessage, PrivateDraft } from './types.ts';

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

export interface SendOutboundFileOpts extends ChannelSendOptions {
  chatId?: string | null;
  recordContext?: boolean;
  replyTo?: string;
}

/** 向 IM 发送文件/图片，并在发送前执行文本附件脱敏与回声登记。 */
export async function sendOutboundFile(
  bridge: OpenMausBotBridge,
  filePath: string,
  name: string,
  opts: SendOutboundFileOpts = {},
): Promise<string | null> {
  const { chatId: targetChatId, recordContext, ...passOpts } = opts || {};
  const chatId = targetChatId || bridge.selfChat;
  if (!chatId || !bridge.supportsFiles() || typeof bridge.transport.sendFile !== 'function') return null;
  const safe = safeAttachmentName(name || path.basename(filePath), 'file');
  const redacted = redactTextFileBeforeSend(filePath, name || filePath);
  const sendPath = redacted.sendPath;
  if (redacted.redacted) {
    bridge.securityRedactions += redacted.totalHits;
    bridge.emitTelemetry('security_redacted', {
      chatId,
      kind: 'file',
      summary: `${name || safe} count=${redacted.totalHits} types=${redacted.hits.map((h) => h.type).join(',')}`,
    });
  }
  let size = 0;
  try { size = fs.statSync(sendPath).size; } catch { /* ignore */ }
  const exp = bridge.now() + 30_000;
  if (bridge.pendingOutFiles.size > 200) bridge.pruneMemoryCaches();
  trimMapCap(bridge.pendingOutFiles, 200);
  if (size > 0) bridge.pendingOutFiles.set(`${safe}:${size}`, exp);
  bridge.pendingOutFiles.set(safe, exp);
  const caps = bridge.channelCaps();
  const chatType = bridge.resolveChatType(chatId);
  const safeOpts: ChannelSendOptions = {
    ...(chatType ? { chatType } : {}),
    ...(caps?.replyTo === false && passOpts?.replyTo
      ? { ...passOpts, replyTo: undefined }
      : passOpts),
  };
  try {
    const fid = (await bridge.transport.sendFile(chatId, { path: sendPath, name }, safeOpts)) ?? null;
    bridge.rememberOwnId(fid, chatId);
    if (recordContext) {
      bridge.recordOutboundToContext(chatId, {
        id: fid ?? undefined,
        text: `[附件: ${name || safe}]`,
        replyTo: typeof safeOpts?.replyTo === 'string' ? safeOpts.replyTo : undefined,
      });
    }
    return fid;
  } finally {
    if (redacted.tempPath) {
      try { fs.rmSync(redacted.tempPath, { force: true }); } catch { /* ignore */ }
    }
  }
}

export interface ClaimedUpload {
  kind: 'image' | 'file';
  name: string;
  path: string;
}

export interface ClaimedTranscript {
  name: string;
  durationSec?: number;
  text: string;
}

/** 认领入站与上下文携带的图片/音频/文件附件，完成下载、语音转写及 OpenMausBot 上传。 */
export async function claimUploads(
  bridge: OpenMausBotBridge,
  mid: string | null,
  quotedId: string | null,
  originChatId: string | null = null,
  contextAttachments: InboundAttachment[] = [],
  errChatId: string | null = null,
  { allowPendingFileMsgs = true }: { allowPendingFileMsgs?: boolean } = {},
): Promise<{ uploads: ClaimedUpload[]; transcripts: ClaimedTranscript[] }> {
  const entries: Array<{ msgId: string; entry: { chatId: string; atts: InboundAttachment[]; used: boolean } }> = [];
  const pushResolved = (rawId: string | null) => {
    if (!rawId) return;
    const hit = bridge.getFileMsg(originChatId, rawId);
    if (hit && !entries.some((x) => x.entry === hit.entry)) {
      entries.push({ msgId: unscopeMsgKey(hit.key).msgId, entry: hit.entry });
    }
  };
  pushResolved(mid);
  pushResolved(quotedId);
  if (allowPendingFileMsgs && !entries.length && (!Array.isArray(contextAttachments) || !contextAttachments.length)) {
    const now = bridge.now();
    const winMs = Math.max(0, Number(bridge.chats.recentAttachmentWindowMs) || 120_000);
    const ctxStore = bridge.imContext?.store ?? bridge.localContextStore;
    for (const [k, entry] of bridge.fileMsgs) {
      if (!entry.used && now - entry.at <= winMs && (!originChatId || !entry.chatId || entry.chatId === originChatId)) {
        const msgId = unscopeMsgKey(k).msgId;
        const storedMsg = ctxStore?.getMessage(entry.chatId || originChatId || '', msgId);
        if (storedMsg && !storedMsg.isForwarded && !storedMsg.forwarded && SELF_NOTE_PREFIX_RE.test(String(storedMsg.text || '').trim())) {
          continue;
        }
        entries.push({ msgId, entry });
      }
    }
  }
  const uploaded: ClaimedUpload[] = [];
  const transcripts: ClaimedTranscript[] = [];
  const seenKeys = new Set<string>();
  const processOne = async (attIdKey: string, chatIdForPath: string, msgIdForPath: string, a: InboundAttachment): Promise<void> => {
    if (!a || a.id == null) return;
    if (seenKeys.has(attIdKey)) return;
    seenKeys.add(attIdKey);
    const isAudio = isAudioAttachment(a);
    let directTranscript = a.transcript ? String(a.transcript).trim() : '';
    if (typeof bridge.transport.download !== 'function') {
      if (isAudio && directTranscript) {
        transcripts.push({ name: a.name || '语音', durationSec: a.durationSec, text: directTranscript });
      }
      return;
    }
    const safe = safeAttachmentName(a.name, 'file');
    const effChatId = a.chatId || chatIdForPath || originChatId || '';
    const dest = path.join(bridge.inDir, fileSafe(effChatId) || 'chat', fileSafe(msgIdForPath) || 'f', safe);
    try {
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const attWithChat = (!a.chatId && effChatId) ? { ...a, chatId: effChatId } : a;
        const chatType = effChatId ? bridge.resolveChatType(effChatId) : undefined;
        await bridge.transport.download(attWithChat, dest, {
          ...(effChatId ? { chatId: effChatId } : {}),
          ...(chatType ? { chatType } : {}),
        });
      }
      if (isAudio && !directTranscript && typeof bridge.transcribeAudio === 'function') {
        try {
          const t = await bridge.transcribeAudio(dest, a);
          if (typeof t === 'string' && t.trim()) directTranscript = t.trim();
        } catch { /* 语音转写失败不阻断原音频附件上传 */ }
      }
      if (isAudio && directTranscript) {
        transcripts.push({ name: a.name || safe, durationSec: a.durationSec, text: directTranscript });
      }
      const buf = fs.readFileSync(dest);
      const ext = path.extname(safe).toLowerCase();
      const mime = a.mime || IMAGE_MIME[ext] || 'application/octet-stream';
      const isImg = mime.startsWith('image/') && Boolean(IMAGE_MIME[ext] || MIME_EXT[mime.toLowerCase()]);
      const res = isImg
        ? await bridge.client.uploadImage(buf, mime)
        : await bridge.client.uploadFile(a.name || safe, buf, mime);
      uploaded.push({
        kind: isImg ? 'image' : 'file',
        name: a.name || safe,
        path: res?.path || res?.url || dest,
      });
    } catch (e) {
      const failTarget = errChatId || bridge.selfChat;
      if (failTarget) {
        await bridge.say(`📎 附件 ${a.name} 上传失败：${formatOmbError(e)}`, { targetChatId: failTarget });
      }
    }
  };

  for (const { msgId, entry } of entries) {
    entry.used = true;
    for (const a of entry.atts) {
      const cid = a.chatId || entry.chatId || originChatId || '';
      await processOne(`${cid}:${a.msgId ?? msgId}:${a.id}`, cid, msgId, a);
    }
  }
  if (Array.isArray(contextAttachments) && contextAttachments.length) {
    for (const a of contextAttachments) {
      const msgIdForPath = a.msgId || quotedId || 'q';
      const cid = a.chatId || originChatId || '';
      await processOne(`${cid}:${msgIdForPath}:${a.id}`, cid, msgIdForPath, a);
    }
  }
  return { uploads: uploaded, transcripts };
}

/** 回传 Bot 生成的图片与文件附件到指定 IM 会话。 */
export async function forwardBotMedia(
  bridge: OpenMausBotBridge,
  threadId: string,
  msgs: OmbMessage[],
  { chatId = null, replyTo = null }: { chatId?: string | null; replyTo?: string | null } = {},
): Promise<number> {
  const canFiles = bridge.supportsFiles();
  const canImages = bridge.supportsImages();
  if (!canFiles && !canImages) return 0;
  let forwarded = 0;
  const outOpts: SendOutboundFileOpts = {
    ...(chatId ? { chatId } : {}),
    ...(replyTo ? { replyTo } : {}),
    recordContext: true,
  };
  for (const msg of msgs) {
    if (!msg?.id) continue;
    if (canImages && (msg.kind === 'screen' || msg.hasImage)) {
      const k = `${msg.id}:__image__`;
      if (!bridge.deliveredMedia.has(k)) {
        rememberBounded(bridge.deliveredMedia, k);
        try {
          const { buf, mime } = await bridge.client.downloadMessageImage(threadId, msg.id);
          const ext = MIME_EXT[mime.split(';')[0].trim().toLowerCase()] || '.png';
          const name = `image-${String(msg.id).slice(0, 8)}${ext}`;
          fs.mkdirSync(bridge.inDir, { recursive: true });
          const dest = path.join(bridge.inDir, `out-${Date.now()}-${name}`);
          fs.writeFileSync(dest, buf);
          await sendOutboundFile(bridge, dest, name, outOpts);
          forwarded += 1;
        } catch (e) {
          const reason = formatOmbError(e);
          console.warn('[omb-media] 图片回传失败:', String(msg.id || 'unknown'), reason);
          bridge.emitTelemetry('media_failed', { chatId: chatId || bridge.selfChat || null, summary: `image ${msg.id}: ${reason}` });
        }
      }
    }
    if (!canFiles) continue;
    for (const att of msg.attachments ?? []) {
      const attPath = att?.path || att?.href || att?.url;
      if (!attPath) continue;
      const k = `${msg.id}:${attPath}`;
      if (bridge.deliveredMedia.has(k)) continue;
      rememberBounded(bridge.deliveredMedia, k);
      try {
        const res = await bridge.client.downloadMessageFile(threadId, msg.id, attPath);
        const safe = safeAttachmentName(att.name || res.name, `file-${Date.now()}`);
        fs.mkdirSync(bridge.inDir, { recursive: true });
        const dest = path.join(bridge.inDir, `out-${Date.now()}-${safe}`);
        fs.writeFileSync(dest, res.buf);
        await sendOutboundFile(bridge, dest, safe, outOpts);
        forwarded += 1;
      } catch (e) {
        const reason = formatOmbError(e);
        console.warn('[omb-media] 附件回传失败:', att.name || attPath, reason);
        bridge.emitTelemetry('media_failed', { chatId: chatId || bridge.selfChat || null, summary: `file ${att.name || attPath}: ${reason}` });
      }
    }
  }
  return forwarded;
}

/** 投递审批、选项/提问或阻塞类卡片至控制会话并记录 pendingCards。 */
export async function emitCard(
  bridge: OpenMausBotBridge,
  botId: string,
  botName: string,
  threadId: string,
  msg: OmbMessage,
  { isGroup = false, chatCtx = null }: { isGroup?: boolean; chatCtx?: CompactChatContext | BridgeChatContext | null } = {},
): Promise<void> {
  const cid = msg.card?.requestId || (msg.burst?.burstId ? `burst:${msg.burst.burstId}` : msg.id);
  if (!cid || bridge.deliveredCards.has(cid)) return;
  const ctrlChat = chatCtx?.readonly
    ? (bridge.selfChat || '')
    : bridge.resolveControlChatId(chatCtx);
  if (!ctrlChat) return;
  rememberBounded(bridge.deliveredCards, cid);
  const cardKind: 'card' | 'secret' | 'connector' | 'signIn' | 'burst' | null = msg.card
    ? 'card'
    : (msg.burst?.burstId ? 'burst' : (msg.secret ? 'secret' : (msg.connector ? 'connector' : (msg.signIn ? 'signIn' : null))));
  const speakerName = isGroup ? (msg.from?.name || '') : '';
  const speakerBotId = isGroup ? (msg.from?.botId || null) : null;
  const shownName = bridge.displayBotName(botId, botName, { isGroup });
  const route: MsgRoute = {
    botId,
    botName,
    threadId,
    ombMsgId: msg.id ?? null,
    ...(isGroup ? { isGroup: true } : {}),
    ...(ctrlChat ? { targetChatId: ctrlChat } : {}),
  };
  const who = bridge.botPrefix(botId, botName, { isGroup, speakerName, speakerBotId });
  const multiCard = bridge.pendingCards.size >= 1;
  const inboxRef = cardKind ? allocateInboxRef(bridge) : undefined;
  const prompt = formatCardPrompt(shownName, msg, who, { multiCard, inboxRef });
  const originBanner = formatOriginBanner(chatCtx, ctrlChat, bridge.selfChat, '的审批 / 确认');
  const sentId = await bridge.say(`${originBanner}${prompt.text}`, route, null, null, { noBuffer: true });
  if (!sentId) {
    bridge.deliveredCards.delete(cid);
    return;
  }
  bridge.emitTelemetry('card', { botName: shownName, kind: cardKind || 'card', summary: prompt.text });
  if (ctrlChat === bridge.selfChat) {
    bridge.notifySelf({ title: '需要审批/确认', body: prompt.text, chatId: ctrlChat, urgent: true });
  }
  if (cardKind) {
    const compacted = compactChatCtx(chatCtx);
    const title = prompt.info && 'title' in prompt.info
      ? prompt.info.title
      : (msg.burst?.task || msg.secret?.label || msg.connector?.label || (msg.signIn ? '登录验证' : '待确认操作'));
    bridge.pendingCards.set(sentId, {
      inboxRef,
      imMsgId: sentId,
      chatId: ctrlChat,
      cardKind,
      cardBotId: msg.from?.botId || botId,
      requestId: msg.card?.requestId ?? null,
      ...(msg.burst?.burstId ? { burstId: msg.burst.burstId } : {}),
      threadId,
      botId,
      botName,
      ...(isGroup ? { isGroup: true } : {}),
      ombMsgId: msg.id,
      title: clip(title, 60),
      isQuestion: Boolean(prompt.info && 'isQuestion' in prompt.info && prompt.info.isQuestion),
      ...(prompt.info && 'isReviewProposal' in prompt.info && prompt.info.isReviewProposal ? { isReviewProposal: true } : {}),
      options: (prompt.info && 'options' in prompt.info && prompt.info.options) ? prompt.info.options : [],
      ...(prompt.info && 'questions' in prompt.info && prompt.info.questions.length
        ? { questions: prompt.info.questions, questionIndex: 0, collectedAnswers: [] }
        : {}),
      canRememberCommand: Boolean(prompt.info && 'canRememberCommand' in prompt.info && prompt.info.canRememberCommand),
      createdAt: bridge.now(),
      ...(compacted ? { chatCtx: compacted } : {}),
    });
    bridge.saveState();
  }
}

/** 格式化并投递 Bot 最终文本、软拆分长文、.md 附件、私密草稿与后续媒体。 */
export async function deliverBotReply(
  bridge: OpenMausBotBridge,
  {
    botId,
    botName,
    threadId,
    text,
    finalMsg,
    mediaMessages = [],
    widgetMessages,
    proactive = false,
    isGroup = false,
    speakerName = '',
    turnStartedAt,
    chatCtx = null,
  }: {
    botId: string;
    botName: string;
    threadId: string;
    text: string;
    finalMsg?: OmbMessage;
    mediaMessages?: OmbMessage[];
    widgetMessages?: OmbMessage[];
    proactive?: boolean;
    isGroup?: boolean;
    speakerName?: string;
    turnStartedAt?: number;
    chatCtx?: CompactChatContext | BridgeChatContext | null;
  },
): Promise<void> {
  if (finalMsg?.id) rememberBounded(bridge.deliveredOmbIds, finalMsg.id);
  const askParsed = (!proactive && !chatCtx?.readonly) ? parseAskProposal(text) : { cleanText: text, proposal: null };
  const effectiveText = askParsed.cleanText;
  const isExternal = Boolean(chatCtx?.isExternal);
  const targetChatId = chatCtx?.replyChatId || bridge.selfChat;
  const quoteReplyId = (!isExternal || chatCtx?.privateReply) ? null : (chatCtx?.replyToImMsgId ?? null);
  const speakerBotId = isGroup ? (finalMsg?.from?.botId || null) : null;
  const shownName = bridge.displayBotName(botId, botName, { isGroup });
  const badgeShown = bridge.badgeName(botId, botName, { isGroup });
  const shownSpeaker = speakerName ? bridge.displayBotName(speakerBotId, speakerName) : '';
  const who = bridge.botPrefix(botId, botName, { proactive: false, isGroup, speakerName, speakerBotId });
  const originName = chatCtx?.chatName || chatCtx?.originChatId || '';
  const isPrivDraft = Boolean(isExternal && chatCtx?.privateReply && !proactive && chatCtx?.originChatId);
  const isPolishDraft = Boolean(!proactive && !isExternal && chatCtx?.polishDraft?.originChatId);
  const draftMeta = isPrivDraft && chatCtx?.originChatId
    ? {
        originChatId: chatCtx.originChatId,
        originName,
        originChatType: chatCtx.chatType || 'group',
        replyToImMsgId: chatCtx.originQuoteId ?? null,
        addBotPrefix: true,
        forceBotPrefix: Boolean(chatCtx?.collaborator || chatCtx?.draftFirst),
        delegationRe: chatCtx?.delegationReq?.id || null,
      }
    : (isPolishDraft && chatCtx?.polishDraft
      ? {
          originChatId: chatCtx.polishDraft.originChatId,
          originName: chatCtx.polishDraft.originChatName || chatCtx.polishDraft.originChatId,
          originChatType: chatCtx.polishDraft.originChatType || 'group',
          replyToImMsgId: chatCtx.polishDraft.replyToImMsgId ?? null,
          addBotPrefix: Boolean(chatCtx.polishDraft.addBotPrefix),
          forceBotPrefix: Boolean(chatCtx.polishDraft.forceBotPrefix),
          delegationRe: chatCtx.polishDraft.delegationRe || null,
          mentions: chatCtx.polishDraft.mentions,
          allowMentionNames: chatCtx.polishDraft.allowMentionNames,
          followUp: chatCtx.polishDraft.followUp,
        }
      : null);
  const draftKey = draftMeta ? `draft_${bridge.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}` : null;
  const draftRef = draftMeta ? allocateInboxRef(bridge) : undefined;
  let privHead = '';
  if (isPrivDraft && draftKey) {
    if (chatCtx?.collaborator) {
      const tagNote = chatCtx?.delegationReq ? `（委托 \`${chatCtx.delegationReq.id}\`）` : '';
      const senderSuffix = originName && originName === chatCtx.collaborator.name ? '' : `的 ${chatCtx.collaborator.name}`;
      privHead = `📩 **同事协作草稿 · 来自「${originName}」${senderSuffix}**${tagNote}（\`#${draftRef}\` · \`${draftKey}\`）\n`;
    } else {
      privHead = `📩 **私密回复 · 来自「${originName}」**（\`#${draftRef}\` · \`${draftKey}\`）\n`;
    }
  } else if (isPolishDraft && draftMeta && draftKey) {
    privHead = `📩 **私密回复（润色） · 来自「${draftMeta.originName}」**（\`#${draftRef}\` · \`${draftKey}\`）\n`;
  }
  const originNote = proactive && isExternal ? `（来自「${originName}」）` : '';
  const proLabel = isGroup && shownSpeaker ? `${shownName} · ${shownSpeaker}` : shownName;
  const proHead = proactive ? `🔔 **${proLabel} 通知**${originNote}\n` : '';
  const safeBody = isExternal && targetChatId && targetChatId !== bridge.selfChat
    ? sanitizeExternalMentions(effectiveText, { mode: bridge.chats.externalSanitizeMentions ?? 'all', botNames: bridge.getKnownBotNames() })
    : effectiveText;
  const isDirectExternalReply = Boolean(isExternal && !chatCtx?.privateReply && !proactive && targetChatId && targetChatId !== bridge.selfChat);
  const isDirectDelegationRes = Boolean(isDirectExternalReply && chatCtx?.delegationReq?.id);
  let externalSafeBody = safeBody;
  if (isDirectExternalReply) {
    const leak = detectInternalOpsLeak(safeBody);
    if (leak.matched) {
      bridge.emitTelemetry('internal_leak_intercepted', {
        chatId: targetChatId,
        chatType: chatCtx?.chatType,
        summary: `${leak.reason} bot=${shownName}`,
      });
      if (bridge.selfChat) {
        await bridge.say(
          `⚠️ **已拦截外部会话内部运维细节**（来自「${originName}」· ${shownName}）\n> ${clip(safeBody, 800)}`,
          { targetChatId: bridge.selfChat },
        );
      }
      externalSafeBody = '暂时无法直接访问该工作区，已转交主人处理。';
    }
  }
  const customExtPrefix = bridge.chats.externalBotPrefix ?? '🤖 ';
  const useDefaultExtBadge = Boolean(
    isDirectExternalReply && !isDirectDelegationRes && customExtPrefix && customExtPrefix.trim() === '🤖',
  );
  const badge = proactive
    ? ''
    : (isDirectExternalReply && !isDirectDelegationRes
      ? (useDefaultExtBadge ? (who || `🤖 **[${badgeShown}]**`) : '')
      : who);

  let bodyCore = externalSafeBody;
  let delegationTagSuffix = '';
  if (isDirectDelegationRes && chatCtx?.delegationReq?.id) {
    const tagged = formatDelegationResponse({ re: chatCtx.delegationReq.id, text: externalSafeBody });
    const tagIdx = tagged.lastIndexOf('\n[cobot:res ');
    const rawCore = tagIdx >= 0 ? tagged.slice(0, tagIdx) : tagged;
    bodyCore = badge ? rawCore.replace(/^🤖\s*/u, '') : rawCore;
    if (tagIdx >= 0) delegationTagSuffix = tagged.slice(tagIdx);
  } else if (isDirectExternalReply && !useDefaultExtBadge && customExtPrefix) {
    bodyCore = formatExternalBotPrefix(bodyCore, customExtPrefix);
  }

  const draftFooter = draftKey && draftMeta
    ? `\n\n---\n👉 回复 \`#${draftRef} 确认\` 或 \`${bridge.trigger} sendback ${draftKey}\` 发回「${clip(draftMeta.originName, 16)}」，或引用本条回 \`确认发送\` / \`取消\` / 继续润色`
    : '';
  const tailSuffix = `${draftFooter}${delegationTagSuffix}`;
  const fixedPrefix = privHead + proHead;
  const composeMessage = (
    partBody: string,
    { partIndex, partTotal, includeFixed = true, includeTag = true }: {
      partIndex?: number;
      partTotal?: number;
      includeFixed?: boolean;
      includeTag?: boolean;
    } = {},
  ): string => {
    const badged = badge ? attachBotBadge(badge, partBody, { partIndex, partTotal }) : partBody;
    return `${includeFixed ? fixedPrefix : ''}${badged}${includeTag ? tailSuffix : ''}`;
  };

  const full = composeMessage(bodyCore);
  const compactCtx = compactChatCtx(chatCtx);
  const route: MsgRoute = {
    botId,
    botName,
    threadId,
    ombMsgId: finalMsg?.id ?? null,
    ...(isGroup ? { isGroup: true } : {}),
    ...(targetChatId ? { targetChatId } : {}),
    ...(compactCtx ? {
      originChatId: compactCtx.originChatId,
      originChatName: compactCtx.chatName,
      originChatType: compactCtx.chatType,
      privateReply: compactCtx.privateReply,
    } : {}),
  };
  const effResult = bridge.effectiveResultChars();
  const effSoftSplit = bridge.effectiveSoftSplitChars();
  const caps = bridge.channelCaps();
  const useMarkdown = Boolean(bridge.markdown && caps?.markdown !== false);
  const badgeEffLen = badge ? (useMarkdown ? badge.length : plain(badge).length) : 0;

  const effWidgets = widgetMessages ?? (finalMsg?.kind === 'widget' ? [finalMsg] : []);
  const widgetActions: ChannelAction[] = [];
  if (!isPrivDraft && !isPolishDraft && effWidgets.length) {
    const extPrefix = isDirectExternalReply
      ? ((botId === bridge.chiefBotId || badgeShown === 'bot') ? bridge.trigger : `@${shownName}`)
      : '';
    const seenAct = new Set<string>();
    for (const wm of effWidgets) {
      for (const act of extractWidgetActions(wm.widget, { externalTriggerPrefix: extPrefix })) {
        const k = `${act.label}\0${act.text ?? ''}`;
        if (seenAct.has(k)) continue;
        seenAct.add(k);
        widgetActions.push(act);
        if (widgetActions.length >= 10) break;
      }
      if (widgetActions.length >= 10) break;
    }
  }
  const draftActions: ChannelAction[] = (draftKey && draftMeta && !widgetActions.length)
    ? [
        { label: '发回原群', text: `${bridge.trigger} sendback ${draftKey}`, kind: 'primary' },
        { label: '忽略', text: `${bridge.trigger} sendback cancel ${draftKey}` },
      ]
    : [];
  const outActions = widgetActions.length
    ? widgetActions
    : (draftActions.length ? draftActions : null);

  const fullScan = scanAndRedactOutbound(full);
  const safeFull = fullScan.text;
  const sentIds: string[] = [];
  if (full.length <= effResult) {
    const sid = await bridge.say(full, route, quoteReplyId, outActions);
    if (sid) sentIds.push(sid);
  } else if (effSoftSplit > effResult && full.length <= effSoftSplit) {
    let chunks: string[];
    if (badge) {
      const splitOverhead = fixedPrefix.length + badgeEffLen + 12 + tailSuffix.length;
      const splitCap = Math.max(20, effResult - splitOverhead);
      const rawChunks = mdSplit(bodyCore, splitCap);
      chunks = rawChunks.map((part, idx) => composeMessage(part, {
        partIndex: idx + 1,
        partTotal: rawChunks.length,
        includeFixed: idx === 0,
        includeTag: idx === rawChunks.length - 1,
      }));
    } else {
      const splitCap = Math.max(20, effResult - tailSuffix.length);
      const baseText = `${fixedPrefix}${bodyCore}`;
      chunks = mdSplit(baseText, splitCap);
      if (tailSuffix && chunks.length) chunks[chunks.length - 1] += tailSuffix;
    }
    for (let i = 0; i < chunks.length; i++) {
      const sid = await bridge.say(
        chunks[i],
        {
          ...route,
          ombMsgId: i === chunks.length - 1 ? (finalMsg?.id ?? null) : null,
        },
        i === 0 ? quoteReplyId : null,
        i === chunks.length - 1 ? outActions : null,
      );
      if (sid) sentIds.push(sid);
    }
  } else {
    const canAttach = bridge.supportsFiles();
    const note = canAttach ? '\n\n📎 完整回复见下一条附件' : '';
    let out: string;
    let wasCut: boolean;
    if (badge) {
      const clipOverhead = fixedPrefix.length + badgeEffLen + 5 + tailSuffix.length;
      const clipCap = Math.max(16, effResult - clipOverhead);
      const clipped = mdClip(bodyCore, clipCap);
      wasCut = clipped.cut;
      const badgedClip = attachBotBadge(badge, clipped.text);
      out = `${fixedPrefix}${badgedClip}${clipped.cut ? note : ''}${tailSuffix}`;
    } else {
      const clipCap = Math.max(20, effResult - tailSuffix.length);
      const clipped = mdClip(`${fixedPrefix}${bodyCore}`, clipCap);
      wasCut = clipped.cut;
      out = `${clipped.text}${clipped.cut ? note : ''}${tailSuffix}`;
    }
    const sid = await bridge.say(out, route, quoteReplyId, outActions);
    if (sid) sentIds.push(sid);

    if (wasCut && canAttach) {
      try {
        fs.mkdirSync(bridge.inDir, { recursive: true });
        const mdName = `${fileSafe(shownName) || 'reply'}.md`;
        const mdPath = path.join(bridge.inDir, `${fileSafe(shownName) || 'bot'}-${Date.now()}.md`);
        if (fullScan.redacted) {
          bridge.securityRedactions += fullScan.totalHits;
          bridge.emitTelemetry('security_redacted', {
            chatId: targetChatId || bridge.selfChat,
            kind: 'file',
            summary: `${mdName} count=${fullScan.totalHits} types=${fullScan.hits.map((h) => h.type).join(',')}`,
          });
        }
        fs.writeFileSync(mdPath, `${fullScan.text}\n`);
        await sendOutboundFile(bridge, mdPath, mdName, {
          chatId: targetChatId,
          ...(quoteReplyId ? { replyTo: quoteReplyId } : {}),
        });
      } catch { /* 附件失败不影响正文 */ }
    }
  }
  const firstSentId = sentIds[0] ?? null;

  if (isDirectDelegationRes && chatCtx?.delegationReq?.id) {
    bridge.emitTelemetry('delegation_res', {
      chatId: targetChatId,
      chatType: chatCtx?.chatType || 'direct',
      summary: `outbound re=${chatCtx.delegationReq.id}`,
    });
  }

  const safeTextSummary = scanAndRedactOutbound(effectiveText).text;
  if (draftMeta && draftKey) {
    const draftObj: PrivateDraft = {
      id: draftKey,
      inboxRef: draftRef,
      imMsgId: firstSentId || draftKey,
      ...(sentIds.length ? { imMsgIds: [...sentIds] } : {}),
      originChatId: draftMeta.originChatId,
      originChatName: draftMeta.originName,
      originChatType: draftMeta.originChatType,
      replyToImMsgId: draftMeta.replyToImMsgId,
      rawText: effectiveText,
      addBotPrefix: draftMeta.addBotPrefix,
      ...('forceBotPrefix' in draftMeta && draftMeta.forceBotPrefix ? { forceBotPrefix: true } : {}),
      ...(draftMeta.delegationRe ? { delegationRe: draftMeta.delegationRe } : {}),
      ...('mentions' in draftMeta && draftMeta.mentions?.length ? { mentions: draftMeta.mentions } : {}),
      ...('allowMentionNames' in draftMeta && draftMeta.allowMentionNames?.length ? { allowMentionNames: draftMeta.allowMentionNames } : {}),
      ...('followUp' in draftMeta && draftMeta.followUp ? { followUp: draftMeta.followUp } : {}),
      createdAt: bridge.now(),
    };
    bridge.privateDrafts.set(draftKey, draftObj);
    for (const sid of sentIds) bridge.privateDrafts.set(sid, draftObj);
    bridge.lastPrivateDraftId = firstSentId || draftKey;
    trimMapCap(bridge.privateDrafts, 40);
    if (isPrivDraft && targetChatId === bridge.selfChat) {
      bridge.notifySelf({ title: '待确认草稿', body: safeTextSummary, chatId: targetChatId, urgent: false });
    }
  }

  bridge.recordOutboundToContext(targetChatId, {
    id: firstSentId ?? undefined,
    text: safeFull,
    replyTo: quoteReplyId ?? undefined,
    senderName: speakerName || botName,
    botId: speakerBotId || botId,
  });
  bridge.emitTelemetry(proactive ? 'proactive' : 'reply', {
    botName: speakerName || botName,
    isGroup,
    chatId: targetChatId || null,
    chatType: isExternal ? (chatCtx?.privateReply ? 'self' : chatCtx?.chatType) : 'self',
    summary: safeTextSummary,
  });

  if (!proactive && !isExternal && !isPolishDraft && (turnStartedAt === undefined || turnStartedAt >= bridge.lastByeAt)) {
    bridge.lastBotReplyAt = bridge.now();
    bridge.focus = { botId, botName, threadId, ...(isGroup ? { isGroup: true } : {}) };
  }
  bridge.saveState();

  if (askParsed.proposal) {
    await createAskDraftAndConfirm(bridge, {
      proposal: askParsed.proposal,
      botId,
      botName,
      threadId,
      isGroup,
      chatCtx,
    });
  }

  const media = mediaMessages.length ? mediaMessages : (finalMsg ? [finalMsg] : []);
  await forwardBotMedia(bridge, threadId, media, {
    chatId: targetChatId,
    replyTo: quoteReplyId,
  });
}

/** 将静默时段积攒的主动通知汇总发送至自聊并附带媒体。 */
export async function flushQuietDigest(bridge: OpenMausBotBridge): Promise<number> {
  if (!bridge.quietQueue.length) return 0;
  const items = bridge.quietQueue.slice();
  const lines = items.map((it) => {
    const itemBot = bridge.displayBotName(it.botId, it.botName, { isGroup: Boolean(it.isGroup) });
    const itemSpeaker = it.speakerName ? bridge.displayBotName(it.speakerBotId, it.speakerName) : '';
    return `- **${itemSpeaker ? `${itemBot} · ${itemSpeaker}` : itemBot}**：${clip(it.text.replace(/\s+/g, ' '), 180)}`;
  });
  const last = items[items.length - 1];
  const sentId = await bridge.say(
    `🌙 **免打扰期间汇总（${items.length} 条）**\n${lines.join('\n')}`,
    {
      botId: last.botId,
      botName: last.botName,
      threadId: last.threadId,
      ...(last.isGroup ? { isGroup: true } : {}),
      ombMsgId: last.finalMsg?.id ?? null,
    },
  );
  if (!sentId) return 0;
  bridge.quietQueue.splice(0, items.length);
  bridge.saveState();
  for (const it of items) {
    if (it.finalMsg) await forwardBotMedia(bridge, it.threadId, [it.finalMsg]);
  }
  return items.length;
}

/** 监测会话 Token 上下文占比，超阈值提醒或在外部群静默自动压缩。 */
export async function maybeWarnHighContext(
  bridge: OpenMausBotBridge,
  botId: string,
  threadId: string,
  chatCtx: CompactChatContext | BridgeChatContext | null = null,
): Promise<void> {
  if (!threadId) return;
  if (chatCtx?.isExternal && !bridge.selfChat) return;
  try {
    const bots = await bridge.refreshMultiBot();
    const bot = bots.find((b) => b.id === botId);
    const task = (bot?.tasks ?? []).find((t) => (t.threadId ?? t.id) === threadId) ?? bot?.tasks?.[0];
    const ctx = task?.usage?.context;
    if (!ctx?.window || !ctx?.tokens) return;
    const ratio = ctx.tokens / ctx.window;
    const pct = Math.min(100, Math.round(ratio * 100));
    const autoThresh = Number(bridge.chats.autoCompactThreshold ?? 0.75);

    if (chatCtx?.isExternal && autoThresh > 0 && ratio >= autoThresh && typeof bridge.client.compact === 'function') {
      const lastAt = bridge.lastAutoCompactAt.get(threadId) || 0;
      if ((bridge.now() - lastAt) >= 5 * 60_000) {
        bridge.lastAutoCompactAt.set(threadId, bridge.now());
        trimMapCap(bridge.lastAutoCompactAt, 200);
        await bridge.client.compact(botId, threadId);
        bridge.contextWarnedThreads.delete(threadId);
        bridge.threadInjectedScope.delete(threadId);
        const originBanner = formatOriginBanner(chatCtx, bridge.selfChat, bridge.selfChat, '的会话维护');
        await bridge.say(
          `${originBanner}🗜️ 该群隔离上下文已达 ${pct}%（${fmtTokens(ctx.tokens)} / ${fmtTokens(ctx.window)}），已自动后台压缩，群内零打扰。`,
          { botId, botName: bridge.displayBotName(botId, bot?.name), threadId, targetChatId: bridge.selfChat },
        );
      }
      return;
    }

    if (bridge.contextWarnedThreads.has(threadId) || ratio < 0.8) return;
    rememberBounded(bridge.contextWarnedThreads, threadId, 200);
    const cmdTarget = botCommandTarget(bridge, botId, bot?.name);
    const compactCmd = chatCtx?.isExternal && chatCtx.originChatId ? `${cmdTarget} compact ${chatCtx.originChatId}` : `${cmdTarget} compact`;
    const originBanner = formatOriginBanner(chatCtx, bridge.selfChat, bridge.selfChat, '的会话提醒');
    await bridge.say(
      `${originBanner}💡 当前会话上下文已达 ${pct}%（${fmtTokens(ctx.tokens)} / ${fmtTokens(ctx.window)}），建议发 \`${compactCmd}\` 压缩以保持准确度。`,
      { botId, botName: bridge.displayBotName(botId, bot?.name), threadId, ...(chatCtx?.isExternal && bridge.selfChat ? { targetChatId: bridge.selfChat } : {}) },
    );
  } catch { /* 上下文提醒失败不影响主回复 */ }
}
