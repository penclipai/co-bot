import fs from 'node:fs';
import path from 'node:path';
import { isAudioAttachment } from '../core/channel-contract.ts';
import { sanitizeExternalMentions } from '../core/chat-context.ts';
import { formatExternalBotPrefix, redactTextFileBeforeSend } from '../core/security.ts';
import { clip, fileSafe, mdClip, mdSplit, safeAttachmentName } from '../format.ts';
import type { ChannelAction, ChannelSendOptions, InboundAttachment } from '../types.ts';
import type { OpenMausBotBridge } from './bridge.ts';
import { fmtTokens, formatCardPrompt, formatOmbError } from './cards.ts';
import { botCommandTarget } from './commands.ts';
import { formatDelegationResponse } from './delegation.ts';
import { compactChatCtx, rememberBounded, trimMapCap } from './mentions.ts';
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
  const safeOpts: ChannelSendOptions = caps?.replyTo === false && passOpts?.replyTo
    ? { ...passOpts, replyTo: undefined }
    : passOpts;
  try {
    const fid = (await bridge.transport.sendFile(chatId, { path: sendPath, name }, safeOpts)) ?? null;
    bridge.rememberOwnId(fid);
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
): Promise<{ uploads: ClaimedUpload[]; transcripts: ClaimedTranscript[] }> {
  const ids: string[] = [];
  if (mid && bridge.fileMsgs.has(mid)) ids.push(mid);
  if (quotedId && bridge.fileMsgs.has(quotedId)) ids.push(quotedId);
  if (!ids.length && (!Array.isArray(contextAttachments) || !contextAttachments.length)) {
    const now = bridge.now();
    for (const [id, entry] of bridge.fileMsgs) {
      if (!entry.used && now - entry.at < 10 * 60 * 1000 && (!originChatId || !entry.chatId || entry.chatId === originChatId)) {
        ids.push(id);
      }
    }
  }
  const uploaded: ClaimedUpload[] = [];
  const transcripts: ClaimedTranscript[] = [];
  const seenKeys = new Set<string>();
  const processOne = async (attIdKey: string, msgIdForPath: string, a: InboundAttachment): Promise<void> => {
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
    const dest = path.join(bridge.inDir, fileSafe(msgIdForPath) || 'f', safe);
    try {
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        await bridge.transport.download(a, dest);
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
      if (isAudio && directTranscript) {
        transcripts.push({ name: a.name || safe, durationSec: a.durationSec, text: directTranscript });
      }
      const failTarget = errChatId || bridge.selfChat;
      if (failTarget) {
        await bridge.say(`📎 附件 ${a.name} 上传失败：${formatOmbError(e)}`, { targetChatId: failTarget });
      }
    }
  };

  for (const id of ids) {
    const entry = bridge.fileMsgs.get(id);
    if (!entry) continue;
    entry.used = true;
    for (const a of entry.atts) {
      await processOne(`${a.msgId ?? id}:${a.id}`, id, a);
    }
  }
  if (Array.isArray(contextAttachments) && contextAttachments.length) {
    for (const a of contextAttachments) {
      const msgIdForPath = a.msgId || quotedId || 'q';
      await processOne(`${msgIdForPath}:${a.id}`, msgIdForPath, a);
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
          console.warn('[omb-media] 图片回传失败:', nameOrId(msg), reason);
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

function nameOrId(msg: OmbMessage): string {
  return String(msg.id || 'unknown');
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
  const cid = msg.card?.requestId || msg.id;
  if (!cid || bridge.deliveredCards.has(cid)) return;
  const ctrlChat = chatCtx?.readonly
    ? (bridge.selfChat || '')
    : bridge.resolveControlChatId(chatCtx);
  if (chatCtx?.readonly && !ctrlChat) return;
  rememberBounded(bridge.deliveredCards, cid);
  const cardKind: 'card' | 'secret' | 'connector' | 'signIn' | null = msg.card
    ? 'card'
    : (msg.secret ? 'secret' : (msg.connector ? 'connector' : (msg.signIn ? 'signIn' : null)));
  const speakerName = isGroup ? (msg.from?.name || '') : '';
  const speakerBotId = isGroup ? (msg.from?.botId || null) : null;
  const shownName = bridge.displayBotName(botId, botName, { isGroup });
  const isExternal = Boolean(chatCtx?.isExternal);
  const route: MsgRoute = {
    botId,
    botName,
    threadId,
    ombMsgId: msg.id ?? null,
    ...(isGroup ? { isGroup: true } : {}),
    ...(ctrlChat ? { targetChatId: ctrlChat } : {}),
  };
  const who = bridge.botPrefix(botId, botName, { isGroup, speakerName, speakerBotId });
  const prompt = formatCardPrompt(shownName, msg, who);
  const originBanner = isExternal && ctrlChat === bridge.selfChat
    ? `📍 **来自「${chatCtx?.chatName || chatCtx?.originChatId || ''}」的审批 / 确认**\n`
    : '';
  const sentId = await bridge.say(`${originBanner}${prompt.text}`, route, null, prompt.actions);
  bridge.emitTelemetry('card', { botName: shownName, kind: cardKind || 'card', summary: prompt.text });
  if (ctrlChat === bridge.selfChat) {
    bridge.notifySelf({ title: '需要审批/确认', body: prompt.text, chatId: ctrlChat, urgent: true });
  }
  if (sentId && cardKind) {
    const compacted = compactChatCtx(chatCtx);
    bridge.pendingCards.set(sentId, {
      imMsgId: sentId,
      cardKind,
      cardBotId: msg.from?.botId || botId,
      requestId: msg.card?.requestId ?? null,
      threadId,
      botId,
      botName,
      ...(isGroup ? { isGroup: true } : {}),
      ombMsgId: msg.id,
      isQuestion: Boolean(prompt.info && 'isQuestion' in prompt.info && prompt.info.isQuestion),
      options: (prompt.info && 'options' in prompt.info && prompt.info.options) ? prompt.info.options : [],
      canRememberCommand: Boolean(prompt.info && 'canRememberCommand' in prompt.info && prompt.info.canRememberCommand),
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
    proactive = false,
    isGroup = false,
    speakerName = '',
    chatCtx = null,
  }: {
    botId: string;
    botName: string;
    threadId: string;
    text: string;
    finalMsg?: OmbMessage;
    mediaMessages?: OmbMessage[];
    proactive?: boolean;
    isGroup?: boolean;
    speakerName?: string;
    chatCtx?: CompactChatContext | BridgeChatContext | null;
  },
): Promise<void> {
  if (finalMsg?.id) rememberBounded(bridge.deliveredOmbIds, finalMsg.id);
  const isExternal = Boolean(chatCtx?.isExternal);
  const targetChatId = chatCtx?.replyChatId || bridge.selfChat;
  const quoteReplyId = (!isExternal || chatCtx?.privateReply) ? null : (chatCtx?.replyToImMsgId ?? null);
  const speakerBotId = isGroup ? (finalMsg?.from?.botId || null) : null;
  const shownName = bridge.displayBotName(botId, botName, { isGroup });
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
        addBotPrefix: Boolean(chatCtx?.collaborator || chatCtx?.draftFirst),
        delegationRe: chatCtx?.delegationReq?.id || null,
      }
    : (isPolishDraft && chatCtx?.polishDraft
      ? {
          originChatId: chatCtx.polishDraft.originChatId,
          originName: chatCtx.polishDraft.originChatName || chatCtx.polishDraft.originChatId,
          originChatType: chatCtx.polishDraft.originChatType || 'group',
          replyToImMsgId: chatCtx.polishDraft.replyToImMsgId ?? null,
          addBotPrefix: Boolean(chatCtx.polishDraft.addBotPrefix),
          delegationRe: chatCtx.polishDraft.delegationRe || null,
        }
      : null);
  const draftKey = draftMeta ? `draft_${bridge.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}` : null;
  let privHead = '';
  if (isPrivDraft && draftKey) {
    if (chatCtx?.collaborator) {
      const tagNote = chatCtx?.delegationReq ? `（委托 \`${chatCtx.delegationReq.id}\`）` : '';
      const senderSuffix = originName && originName === chatCtx.collaborator.name ? '' : `的 ${chatCtx.collaborator.name}`;
      privHead = `📩 **同事协作草稿 · 来自「${originName}」${senderSuffix}**${tagNote}（\`${draftKey}\`）\n`;
    } else {
      privHead = `📩 **私密回复 · 来自「${originName}」**（\`${draftKey}\`）\n`;
    }
  } else if (isPolishDraft && draftMeta && draftKey) {
    privHead = `📩 **私密回复（润色） · 来自「${draftMeta.originName}」**（\`${draftKey}\`）\n`;
  }
  const originNote = proactive && isExternal ? `（来自「${originName}」）` : '';
  const proLabel = isGroup && shownSpeaker ? `${shownName} · ${shownSpeaker}` : shownName;
  const head = proactive
    ? `🔔 **${proLabel} 通知**${originNote}\n`
    : (who ? `${who}\n` : '');
  const safeBody = isExternal && targetChatId && targetChatId !== bridge.selfChat
    ? sanitizeExternalMentions(text, { mode: bridge.chats.externalSanitizeMentions ?? 'all', botNames: bridge.getKnownBotNames() })
    : text;
  const isDirectExternalReply = Boolean(isExternal && !chatCtx?.privateReply && !proactive && targetChatId && targetChatId !== bridge.selfChat);
  const isDirectDelegationRes = Boolean(isDirectExternalReply && chatCtx?.delegationReq?.id);
  let formattedBody = head + safeBody;
  let delegationTagSuffix = '';
  if (isDirectDelegationRes && chatCtx?.delegationReq?.id) {
    formattedBody = formatDelegationResponse({ re: chatCtx.delegationReq.id, text: formattedBody });
    const tagIdx = formattedBody.lastIndexOf('\n[cobot:res ');
    if (tagIdx >= 0) {
      delegationTagSuffix = formattedBody.slice(tagIdx);
    }
  } else if (isDirectExternalReply) {
    formattedBody = formatExternalBotPrefix(formattedBody, bridge.chats.externalBotPrefix ?? '🤖 ');
  }
  const full = privHead + formattedBody;
  const coreWithoutTag = delegationTagSuffix ? full.slice(0, full.length - delegationTagSuffix.length) : full;
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

  const draftActions: ChannelAction[] | null = draftKey && draftMeta
    ? [{ label: `发回「${clip(draftMeta.originName, 10)}」`, text: `${bridge.trigger} sendback ${draftKey}` }]
    : null;

  let firstSentId: string | null = null;
  if (full.length <= effResult) {
    firstSentId = await bridge.say(full, route, quoteReplyId, draftActions);
  } else if (effSoftSplit > effResult && full.length <= effSoftSplit) {
    const splitCap = delegationTagSuffix ? Math.max(20, effResult - delegationTagSuffix.length) : effResult;
    const chunks = mdSplit(coreWithoutTag, splitCap);
    if (delegationTagSuffix && chunks.length) chunks[chunks.length - 1] += delegationTagSuffix;
    for (let i = 0; i < chunks.length; i++) {
      const sid = await bridge.say(
        chunks[i],
        {
          ...route,
          ombMsgId: i === chunks.length - 1 ? (finalMsg?.id ?? null) : null,
        },
        i === 0 ? quoteReplyId : null,
        i === chunks.length - 1 ? draftActions : null,
      );
      if (i === 0) firstSentId = sid;
    }
  } else {
    const canAttach = bridge.supportsFiles();
    const note = canAttach ? '\n\n📎 完整回复见下一条附件' : '';
    const clipCap = delegationTagSuffix ? Math.max(20, effResult - delegationTagSuffix.length) : effResult;
    const clipped = mdClip(coreWithoutTag, clipCap);
    const out = `${clipped.text}${clipped.cut ? note : ''}${delegationTagSuffix}`;
    firstSentId = await bridge.say(out, route, quoteReplyId, draftActions);

    if (clipped.cut && canAttach) {
      try {
        fs.mkdirSync(bridge.inDir, { recursive: true });
        const mdPath = path.join(bridge.inDir, `${fileSafe(shownName) || 'bot'}-${Date.now()}.md`);
        fs.writeFileSync(mdPath, `${full}\n`);
        await sendOutboundFile(bridge, mdPath, `${fileSafe(shownName) || 'reply'}.md`, {
          chatId: targetChatId,
          ...(quoteReplyId ? { replyTo: quoteReplyId } : {}),
        });
      } catch { /* 附件失败不影响正文 */ }
    }
  }

  if (isDirectDelegationRes && chatCtx?.delegationReq?.id) {
    bridge.emitTelemetry('delegation_res', {
      chatId: targetChatId,
      chatType: chatCtx?.chatType || 'direct',
      summary: `outbound re=${chatCtx.delegationReq.id}`,
    });
  }

  if (draftMeta && draftKey) {
    const draftObj: PrivateDraft = {
      id: draftKey,
      imMsgId: firstSentId || draftKey,
      originChatId: draftMeta.originChatId,
      originChatName: draftMeta.originName,
      originChatType: draftMeta.originChatType,
      replyToImMsgId: draftMeta.replyToImMsgId,
      rawText: text,
      addBotPrefix: draftMeta.addBotPrefix,
      ...(draftMeta.delegationRe ? { delegationRe: draftMeta.delegationRe } : {}),
      createdAt: bridge.now(),
    };
    bridge.privateDrafts.set(draftKey, draftObj);
    if (firstSentId) bridge.privateDrafts.set(firstSentId, draftObj);
    bridge.lastPrivateDraftId = firstSentId || draftKey;
    trimMapCap(bridge.privateDrafts, 40);
    if (isPrivDraft && targetChatId === bridge.selfChat) {
      bridge.notifySelf({ title: '待确认草稿', body: text, chatId: targetChatId, urgent: false });
    }
  }

  bridge.recordOutboundToContext(targetChatId, {
    id: firstSentId ?? undefined,
    text: full,
    replyTo: quoteReplyId ?? undefined,
    senderName: speakerName || botName,
  });
  bridge.emitTelemetry(proactive ? 'proactive' : 'reply', {
    botName: speakerName || botName,
    isGroup,
    chatId: targetChatId || null,
    chatType: isExternal ? (chatCtx?.privateReply ? 'self' : chatCtx?.chatType) : 'self',
    summary: text,
  });

  if (!proactive && !isExternal) {
    bridge.lastBotReplyAt = bridge.now();
    bridge.focus = { botId, botName, threadId, ...(isGroup ? { isGroup: true } : {}) };
  }
  bridge.saveState();

  const media = mediaMessages.length ? mediaMessages : (finalMsg ? [finalMsg] : []);
  await forwardBotMedia(bridge, threadId, media, {
    chatId: targetChatId,
    replyTo: quoteReplyId,
  });
}

/** 将静默时段积攒的主动通知汇总发送至自聊并附带媒体。 */
export async function flushQuietDigest(bridge: OpenMausBotBridge): Promise<number> {
  if (!bridge.quietQueue.length) return 0;
  const items = bridge.quietQueue.splice(0);
  bridge.saveState();
  const lines = items.map((it) => {
    const itemBot = bridge.displayBotName(it.botId, it.botName, { isGroup: Boolean(it.isGroup) });
    const itemSpeaker = it.speakerName ? bridge.displayBotName(it.speakerBotId, it.speakerName) : '';
    return `- **${itemSpeaker ? `${itemBot} · ${itemSpeaker}` : itemBot}**：${clip(it.text.replace(/\s+/g, ' '), 180)}`;
  });
  const last = items[items.length - 1];
  await bridge.say(
    `🌙 **免打扰期间汇总（${items.length} 条）**\n${lines.join('\n')}`,
    {
      botId: last.botId,
      botName: last.botName,
      threadId: last.threadId,
      ...(last.isGroup ? { isGroup: true } : {}),
      ombMsgId: last.finalMsg?.id ?? null,
    },
  );
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
    const autoThresh = Number(bridge.chats.autoCompactThreshold ?? 0.92);

    if (chatCtx?.isExternal && autoThresh > 0 && ratio >= autoThresh && typeof bridge.client.compact === 'function') {
      const lastAt = bridge.lastAutoCompactAt.get(threadId) || 0;
      if ((bridge.now() - lastAt) >= 5 * 60_000) {
        bridge.lastAutoCompactAt.set(threadId, bridge.now());
        trimMapCap(bridge.lastAutoCompactAt, 200);
        await bridge.client.compact(botId, threadId);
        bridge.contextWarnedThreads.delete(threadId);
        const originLabel = chatCtx.chatName || chatCtx.originChatId || '';
        await bridge.say(
          `📍 **来自「${originLabel}」的会话维护**\n🗜️ 该群隔离上下文已达 ${pct}%（${fmtTokens(ctx.tokens)} / ${fmtTokens(ctx.window)}），已自动后台压缩，群内零打扰。`,
          { botId, botName: bridge.displayBotName(botId, bot?.name), threadId, targetChatId: bridge.selfChat },
        );
      }
      return;
    }

    if (bridge.contextWarnedThreads.has(threadId) || ratio < 0.8) return;
    rememberBounded(bridge.contextWarnedThreads, threadId, 200);
    const cmdTarget = botCommandTarget(bridge, botId, bot?.name);
    const compactCmd = chatCtx?.isExternal && chatCtx.originChatId ? `${cmdTarget} compact ${chatCtx.originChatId}` : `${cmdTarget} compact`;
    const originBanner = chatCtx?.isExternal
      ? `📍 **来自「${chatCtx.chatName || chatCtx.originChatId || ''}」的会话提醒**\n`
      : '';
    await bridge.say(
      `${originBanner}💡 当前会话上下文已达 ${pct}%（${fmtTokens(ctx.tokens)} / ${fmtTokens(ctx.window)}），建议发 \`${compactCmd}\` 压缩以保持准确度。`,
      { botId, botName: bridge.displayBotName(botId, bot?.name), threadId, ...(chatCtx?.isExternal && bridge.selfChat ? { targetChatId: bridge.selfChat } : {}) },
      null,
      [{ label: chatCtx?.isExternal ? '压缩该群会话' : '立即压缩', text: compactCmd, kind: 'primary' }],
    );
  } catch { /* 上下文提醒失败不影响主回复 */ }
}
