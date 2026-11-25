import fs from 'node:fs';
import path from 'node:path';
import { evaluateInboundPolicy } from '../core/inbound-policy.ts';
import { findUnauthorizedProjectMention, isProjectAuthorized, resolveProjectBinding } from '../core/projects.ts';
import { clip, fileSafe } from '../format.ts';
import type { ChatType, InboundEvent } from '../types.ts';
import type { OpenMausBotBridge } from './bridge.ts';
import {
  advanceQuestionCard,
  answerCard,
  dismissBlockCard,
  handleBurstCardAction,
  replyMultiCardHint,
} from './card-actions.ts';
import { parseChoiceIndex, parseMultiChoiceAnswer } from './cards.ts';
import { isExternalChatAllowed } from './chat-manager.ts';
import { buildHelpText, handleCommand } from './commands.ts';
import { formatDelegationRequest, generateDelegationId, parseDelegationTag } from './delegation.ts';
import { handleFollowUpReply } from './follow-up.ts';
import {
  buildMentionMatcher,
  hasNonBotMention,
  parseInlineTriggerMention,
  parseStartMention,
  parseStructuredBotMention,
  trimMapCap,
} from './mentions.ts';
import type {
  BridgeChatContext,
  DelegationResponseParsed,
  MentionParseResult,
  OmbTargetBot,
  ParsedDelegationTag,
} from './types.ts';

const APPROVE_RE = /^(ok|okay|yes|y|好|好的|可以|允许|同意|通过|执行|批准)$/i;
const ALWAYS_RE = /^(always|all|总是允许|始终允许|永久允许|以后都允许)$/i;
const DENY_RE = /^(no|n|cancel|拒绝|不允许|不同意|取消|算了|不要)$/i;
const SKIP_RE = /^(skip|pass|ignore|跳过|先跳过|略过|忽略|稍后再说|稍后|取消)$/i;
const NOTE_PREFIX_RE = /^(#|备忘|记一下|笔记|便签|todo\b|待办|清单)/i;
const BYE_RE = /^(bye|退下|结束对话|退出对话)$/i;
const OWNER_COMMAND_RE = /^(?:help|帮助|status|状态|stop|停止|bye|退下|steer|插队|cancel|取消排队|chats|mute|静音|unmute|解除静音|summary|汇总|纪要|sendback|发回|bind|绑定|delegate|委托|new|新会话|task|会话|compact|压缩|\/(?:goal|learn|burst|setup))(?:[\s:：]|$)/i;

/** 构建入站消息对应的会话上下文描述对象。 */
export function buildExternalChatCtx(
  bridge: OpenMausBotBridge,
  {
    isSelfChat,
    chatId,
    chatType,
    chatName,
    mid,
    privateReply,
    ev,
  }: {
    isSelfChat: boolean;
    chatId: string;
    chatType: ChatType;
    chatName?: string;
    mid: string | null;
    privateReply: boolean;
    ev: InboundEvent | null;
  },
): BridgeChatContext {
  const replyChatId = isSelfChat ? bridge.selfChat : (privateReply ? bridge.selfChat : chatId);
  return {
    isExternal: !isSelfChat,
    originChatId: chatId,
    chatType,
    chatName: chatName || bridge.externalChatMeta.get(chatId)?.name || '',
    replyChatId,
    controlChatId: !isSelfChat && bridge.chats.routeControlsToSelf !== false && bridge.selfChat ? bridge.selfChat : replyChatId,
    replyToImMsgId: !isSelfChat && !privateReply ? mid : null,
    originQuoteId: ev?.replyTo != null ? String(ev.replyTo) : null,
    privateReply: Boolean(!isSelfChat && privateReply),
    silentProgress: Boolean(!isSelfChat && bridge.chats.externalSilentProgress !== false),
    ev,
  };
}

/** 向合作者发送带 `[cobot:req]` 协议尾注的 2 态协作委托。 */
export async function sendDelegation(
  bridge: OpenMausBotBridge,
  targetChat: { id?: string; name?: string; type?: ChatType },
  question: string,
  { project = '' }: { project?: string } = {},
): Promise<{ ok: boolean; id?: string; sentId?: string; error?: string }> {
  if (!targetChat?.id) return { ok: false, error: '缺少目标会话' };
  const id = generateDelegationId(bridge.now());
  const wire = formatDelegationRequest({ id, project, text: question });
  const sentId = await bridge.say(wire, { targetChatId: targetChat.id });
  if (!sentId) return { ok: false, error: '消息发送失败，请检查通道连接' };
  bridge.delegations.trackOutbound({
    id,
    targetChatId: targetChat.id,
    targetChatName: targetChat.name || targetChat.id,
    project,
    question: clip(question, 200),
  });
  bridge.saveState();
  bridge.emitTelemetry('delegation_req', {
    chatId: targetChat.id,
    chatType: targetChat.type || 'direct',
    summary: `outbound id=${id}${project ? ` proj=${project}` : ''}`,
  });
  return { ok: true, id, sentId };
}

async function handleDelegationResponse(bridge: OpenMausBotBridge, ev: InboundEvent, parsedRes: DelegationResponseParsed): Promise<void> {
  const pending = bridge.delegations.completeOutbound(parsedRes.re);
  bridge.emitTelemetry('delegation_res', {
    chatId: String(ev.chat.id),
    chatType: ev.chat.type || 'direct',
    summary: `inbound re=${parsedRes.re}${pending ? ' matched' : ' unmatched'}`,
  });
  if (!pending) return;
  bridge.saveState();
  if (!bridge.selfChat) return;
  const fromName = ev.sender?.name || pending.targetChatName || ev.chat?.name || ev.chat?.id;
  const projNote = pending.project ? ` · 项目：\`${pending.project}\`` : '';
  const header = `🤝 **协作结果回传 · ${fromName}**（委托 \`${parsedRes.re}\`${projNote}）`;
  await bridge.say(`${header}\n${parsedRes.body || '（空答复）'}`);
  bridge.notifySelf({ title: `协作结果 · ${fromName}`, body: parsedRes.body, chatId: bridge.selfChat });
}

async function resolveBotTarget(
  bridge: OpenMausBotBridge,
  mention: string,
  isDefault: boolean,
  ev: InboundEvent,
): Promise<{ targetBot: OmbTargetBot | null; isDefault: boolean }> {
  let targetBot: OmbTargetBot | null;
  let resolvedDefault = isDefault;
  if (isDefault) {
    targetBot = await bridge.client.resolveBot('');
  } else {
    targetBot = await bridge.client.resolveBot(mention);
    if (!targetBot && typeof bridge.client.resolveGroup === 'function') {
      const grp = await bridge.client.resolveGroup(mention);
      if (grp) targetBot = { ...grp, isGroup: true };
    }
    // 原生 IM `@自己` 触发时（mentionsMe=true），回退路由到默认主 Bot
    if (!targetBot && ev?.mentionsMe) {
      resolvedDefault = true;
      targetBot = await bridge.client.resolveBot('');
    }
  }
  return { targetBot, isDefault: resolvedDefault };
}

async function resolveExplicitTrigger(
  bridge: OpenMausBotBridge,
  rawText: string,
  ev: InboundEvent,
  knownNames: string[],
  triggerAliases: string[],
): Promise<{ parsed: MentionParseResult | null; targetBot: OmbTargetBot | null }> {
  const parsed = parseStartMention(rawText, bridge.trigger, triggerAliases, knownNames);
  if (parsed) {
    const resolved = await resolveBotTarget(bridge, parsed.mention, parsed.isDefault, ev);
    if (resolved.targetBot) {
      return { parsed: { ...parsed, isDefault: resolved.isDefault }, targetBot: resolved.targetBot };
    }
  }
  const inlineParsed = parseInlineTriggerMention(rawText, bridge.trigger, triggerAliases, knownNames);
  if (inlineParsed) {
    const resolved = await resolveBotTarget(bridge, inlineParsed.mention, inlineParsed.isDefault, ev);
    if (resolved.targetBot) {
      return { parsed: { ...inlineParsed, isDefault: resolved.isDefault }, targetBot: resolved.targetBot };
    }
  }
  if (Array.isArray(ev?.mentions) && ev.mentions.length) {
    const structParsed = parseStructuredBotMention(rawText, ev.mentions, bridge.trigger, triggerAliases, knownNames);
    if (structParsed) {
      const resolved = await resolveBotTarget(bridge, structParsed.mention, structParsed.isDefault, ev);
      if (resolved.targetBot) {
        return { parsed: { ...structParsed, isDefault: resolved.isDefault }, targetBot: resolved.targetBot };
      }
    }
  }
  return { parsed: null, targetBot: null };
}

async function handleCollaboratorEvent(
  bridge: OpenMausBotBridge,
  ev: InboundEvent,
  rawText: string,
  delegation: ParsedDelegationTag | null,
): Promise<unknown> {
  const chatId = String(ev.chat.id);
  const chatType = ev.chat.type || 'direct';
  if (delegation?.kind === 'res') {
    await handleDelegationResponse(bridge, ev, delegation);
    return;
  }

  const knownNames = bridge.getKnownBotNames();
  const triggerAliases = bridge.getEffectiveTriggerAliases();
  const isReq = delegation?.kind === 'req';
  const hit = !isReq && rawText ? await resolveExplicitTrigger(bridge, rawText, ev, knownNames, triggerAliases) : { parsed: null, targetBot: null };
  if (!isReq && !hit.parsed && !ev.mentionsMe) return;

  const decision = evaluateInboundPolicy(ev, {
    collaborators: bridge.chats.collaborators,
    chatAllowed: isExternalChatAllowed(bridge, chatId, chatType),
    isDelegationReq: isReq,
  });
  if (!decision.allowed) {
    bridge.policyDenials += 1;
    bridge.emitTelemetry('policy_denied', {
      chatId,
      chatType,
      summary: `sender=${ev.sender?.id || '?'} reason=${decision.reason}`,
    });
    return;
  }
  if (decision.role !== 'collaborator') return;

  if (isReq && delegation.kind === 'req') {
    if (bridge.delegations.hasProcessed(delegation.id)) return;
    if (decision.allowedProjects?.length) {
      if (delegation.project) {
        const matchedProj = bridge.projects.find((p) => p.name.toLowerCase() === delegation.project.toLowerCase()
          || p.aliases.includes(delegation.project.toLowerCase()));
        const authorized = matchedProj
          ? isProjectAuthorized(matchedProj, decision.allowedProjects)
          : decision.allowedProjects.some((p) => p.toLowerCase() === delegation.project.toLowerCase());
        if (!authorized) {
          bridge.policyDenials += 1;
          bridge.emitTelemetry('policy_denied', {
            chatId,
            chatType,
            summary: `sender=${ev.sender?.id || '?'} reason=project_not_authorized:${delegation.project}`,
          });
          return;
        }
      }
      const unauth = findUnauthorizedProjectMention(delegation.body, bridge.projects, decision.allowedProjects);
      if (unauth) {
        bridge.policyDenials += 1;
        bridge.emitTelemetry('policy_denied', {
          chatId,
          chatType,
          summary: `sender=${ev.sender?.id || '?'} reason=project_not_authorized:${unauth.name}`,
        });
        return;
      }
    }
    bridge.delegations.markProcessed(delegation.id);
    bridge.saveState();
    bridge.emitTelemetry('delegation_req', {
      chatId,
      chatType,
      summary: `inbound id=${delegation.id}${delegation.project ? ` proj=${delegation.project}` : ''}`,
    });
  }

  if (decision.mode === 'confirm_in_self' && !bridge.selfChat) {
    console.warn('[omb-bridge] 收到协作者只读请求（confirm_in_self），但尚未获知 selfChatId');
    return;
  }

  let question = rawText;
  if (isReq && delegation.kind === 'req') {
    const innerStart = parseStartMention(delegation.body, bridge.trigger, triggerAliases, knownNames);
    question = innerStart ? innerStart.bodyText : delegation.body;
  } else if (hit.parsed) {
    question = hit.parsed.bodyText;
  }
  const quotedId = ev.replyTo != null ? String(ev.replyTo) : null;
  if (!question) {
    if (!quotedId) return;
    question = '请查看我引用的这条消息并只读解答。';
  }
  if (OWNER_COMMAND_RE.test(question)) {
    bridge.policyDenials += 1;
    bridge.emitTelemetry('policy_denied', {
      chatId,
      chatType,
      summary: `sender=${ev.sender?.id || '?'} reason=owner_only_command`,
    });
    return;
  }
  if (decision.allowedProjects?.length) {
    const unauth = findUnauthorizedProjectMention(question, bridge.projects, decision.allowedProjects);
    const authMention = unauth
      ? resolveProjectBinding({
          text: question,
          chatId,
          chatProjects: new Map(),
          projects: bridge.projects,
          allowedProjects: decision.allowedProjects,
        }).source === 'explicit'
      : false;
    if (unauth && !authMention) {
      bridge.policyDenials += 1;
      bridge.emitTelemetry('policy_denied', {
        chatId,
        chatType,
        summary: `sender=${ev.sender?.id || '?'} reason=project_not_authorized:${unauth.name}`,
      });
      return;
    }
  }
  if (Array.isArray(ev.attachments) && ev.attachments.length) {
    bridge.fileMsgs.set(String(ev.id), { chatId, atts: ev.attachments, at: bridge.now(), used: false });
    trimMapCap(bridge.fileMsgs, 50);
  }

  const resolvedChief = await bridge.client.resolveBot('');
  if (!resolvedChief) return;
  const chief = await bridge.ensureChatThread(chatId, chatType, ev.chat?.name || chatId, resolvedChief);

  const chatCtx = buildExternalChatCtx(bridge, {
    isSelfChat: false,
    chatId,
    chatType,
    chatName: ev.chat?.name,
    mid: String(ev.id),
    privateReply: decision.mode === 'confirm_in_self',
    ev,
  });
  chatCtx.readonly = true;
  chatCtx.collaborator = decision.collaborator;
  chatCtx.allowedProjects = decision.allowedProjects;
  chatCtx.delegationReq = isReq && delegation.kind === 'req' ? delegation : null;
  chatCtx.explicitProject = isReq && delegation.kind === 'req' ? delegation.project : '';
  return bridge.dispatchToBot(chief, question, String(ev.id), quotedId, null, chatCtx);
}

function tryDispatchDraftPolish(
  bridge: OpenMausBotBridge,
  {
    isSelfChat,
    quotedId,
    bodyText,
    targetBot,
    mid,
    replyToOmbId,
    chatCtx,
  }: {
    isSelfChat: boolean;
    quotedId: string | null;
    bodyText: string;
    targetBot: OmbTargetBot;
    mid: string;
    replyToOmbId: string | null;
    chatCtx: BridgeChatContext;
  },
): Promise<unknown> | null {
  const polishSource = isSelfChat && quotedId ? bridge.privateDrafts.get(quotedId) : null;
  if (!polishSource?.originChatId || polishSource.createdAt < (bridge.now() - (Number(bridge.draftTtlMs) || 30 * 60_000))) {
    return null;
  }
  chatCtx.polishDraft = {
    originChatId: polishSource.originChatId,
    originChatName: polishSource.originChatName || polishSource.originChatId,
    originChatType: polishSource.originChatType || 'group',
    replyToImMsgId: polishSource.replyToImMsgId ?? null,
    addBotPrefix: Boolean(polishSource.addBotPrefix),
    ...(polishSource.delegationRe ? { delegationRe: polishSource.delegationRe } : {}),
  };
  const ask = bodyText || '请进一步精简润色这版草稿，保持意思准确。';
  const promptForDraft = `[待润色草稿 · 原目标会话「${chatCtx.polishDraft.originChatName}」]\n${polishSource.rawText}\n\n[改写要求]\n${ask}`;
  return bridge.dispatchToBot(targetBot, promptForDraft, mid, quotedId, replyToOmbId, chatCtx);
}

/** 处理单条 IM 入站事件（去重、撤回、协作者安全门禁、卡片交互、@触发与连续对话）。 */
export async function handleInboundEvent(bridge: OpenMausBotBridge, ev: InboundEvent): Promise<unknown> {
  if (!ev || !ev.id || !ev.chat?.id) return;
  if (bridge.disconnectedBuffer.length && !bridge.isTransportDisconnected()) {
    bridge.flushOutboundBuffer().catch(() => {});
  }
  const chatId = String(ev.chat.id);
  const chatType = ev.chat.type || 'direct';
  const isSelfChat = chatType === 'self';
  const isSelfSender = Boolean(ev.sender?.isSelf);

  if (isSelfChat && isSelfSender && chatId !== bridge.learnedSelfChatId) {
    bridge.learnedSelfChatId = chatId;
    bridge.warnedMissingSelfChat = false;
    if (bridge.transport && !bridge.transport.selfChatId) bridge.transport.selfChatId = bridge.learnedSelfChatId;
    bridge.saveState();
  }

  const mid = String(ev.id);
  if (bridge.ownIds.has(mid)) return;
  if (bridge.seen.has(mid)) return;
  bridge.seen.add(mid);
  if (bridge.seen.size > 5000) {
    const first = bridge.seen.values().next().value;
    if (first !== undefined) bridge.seen.delete(first);
  }

  // 撤回事件：同步从内存上下文窗口、待用附件队列、消息路由和磁盘缓存擦除
  if (ev.kind === 'recall' && ev.recalledMsgId) {
    const recalledId = String(ev.recalledMsgId);
    if (bridge.imContext?.recallMessage) bridge.imContext.recallMessage(chatId, recalledId);
    else bridge.localContextStore.recallMessage(chatId, recalledId);
    bridge.fileMsgs.delete(recalledId);
    bridge.msgRoute.delete(recalledId);
    try {
      fs.rmSync(path.join(bridge.inDir, fileSafe(recalledId) || 'f'), { recursive: true, force: true });
    } catch { /* ignore */ }
    bridge.emitTelemetry('recall', { chatId, chatType, summary: `recall:${recalledId}` });
    return;
  }

  const rawText = String(ev.text ?? '').trim();
  if (isSelfSender && rawText && bridge.isEcho(rawText)) return;

  const atts = Array.isArray(ev.attachments) ? ev.attachments : [];
  if (!rawText && atts.length && atts.every((a) => bridge.isPendingOutFile(a))) {
    bridge.rememberOwnId(mid);
    return;
  }

  const delegation = parseDelegationTag(rawText);

  // 将非 C2C 协议的入站消息写入内存环形上下文，供引用与多轮对话理解使用
  if (!delegation) bridge.recordInboundToContext(ev);

  // 优先检查是否为同事对 @追问 的回复（一次性回流给原分析线程，结果仅回自聊）；否则走 2 档白名单/C2C 协议评估
  if (!isSelfSender) {
    if (await handleFollowUpReply(bridge, ev)) return;
    return handleCollaboratorEvent(bridge, ev, rawText, delegation);
  }

  // 防止自身发出的 C2C 协议消息被本机回放/误二次触发
  if (delegation?.kind === 'req' || delegation?.kind === 'res') return;

  if (Array.isArray(bridge.commandDevices) && bridge.commandDevices.length) {
    const dev = ev.device;
    if (!bridge.commandDevices.some((d) => d === dev?.type || d === dev?.id)) return;
  }

  if (!isSelfChat && !isExternalChatAllowed(bridge, chatId, chatType)) {
    const aliases = bridge.getEffectiveTriggerAliases();
    const names = bridge.getKnownBotNames();
    const wouldTrigger = Boolean(
      parseStartMention(rawText, bridge.trigger, aliases, names)
      || parseInlineTriggerMention(rawText, bridge.trigger, aliases, names)
      || (ev.replyTo != null && bridge.msgRoute.has(String(ev.replyTo))),
    );
    if (wouldTrigger) {
      bridge.emitTelemetry('policy_denied', {
        chatId,
        chatType,
        summary: `sender=${ev.sender?.id || 'me'} reason=chat_not_allowed`,
      });
    }
    return;
  }

  if (atts.length) {
    bridge.fileMsgs.set(mid, { chatId, atts, at: bridge.now(), used: false });
    trimMapCap(bridge.fileMsgs, 50);
  }

  const quotedId = ev.replyTo != null ? String(ev.replyTo) : null;
  const quotedCard = quotedId ? (bridge.pendingCards.get(quotedId) ?? null) : null;
  const quotedRoute = quotedId ? (bridge.msgRoute.get(quotedId) ?? null) : null;

  if (!rawText) {
    if (!atts.length && !ev.linkCard && !ev.forwarded) return;
    const bareMsg = ev.forwarded && !atts.length
      ? '请查看并总结我转发的这组聊天记录。'
      : (ev.linkCard && !atts.length ? '请查看并总结我转发的这张卡片。' : '请查看我发送的附件。');
    if (quotedRoute) {
      bridge.clearPendingMedia();
      const chatCtx = buildExternalChatCtx(bridge, {
        isSelfChat,
        chatId,
        chatType,
        chatName: ev.chat?.name,
        mid,
        privateReply: false,
        ev,
      });
      await bridge.dispatchToBot(
        {
          id: quotedRoute.botId,
          name: quotedRoute.botName,
          threadId: quotedRoute.threadId,
          isGroup: Boolean(quotedRoute.isGroup),
        },
        bareMsg,
        mid,
        quotedId,
        quotedRoute.ombMsgId ?? null,
        chatCtx,
      );
    } else if (isSelfChat && bridge.isStickyActive() && bridge.focus) {
      if (ev.isForwarded || ev.forwarded) return;
      if (ev.linkCard && !atts.length) {
        await bridge.dispatchToBot(
          {
            id: bridge.focus.botId,
            name: bridge.focus.botName,
            threadId: bridge.focus.threadId,
            isGroup: Boolean(bridge.focus.isGroup),
          },
          bareMsg,
          mid,
          quotedId,
          null,
          buildExternalChatCtx(bridge, { isSelfChat: true, chatId, chatType, chatName: ev.chat?.name, mid, privateReply: false, ev }),
        );
        return;
      }
      if (bridge.imageBatchMs > 0 && atts.length) {
        bridge.pendingMediaIds.push(mid);
        bridge.pendingMediaTarget = {
          id: bridge.focus.botId,
          name: bridge.focus.botName,
          threadId: bridge.focus.threadId,
          isGroup: Boolean(bridge.focus.isGroup),
        };
        if (bridge.pendingMediaTimer) {
          clearTimeout(bridge.pendingMediaTimer);
          bridge.pendingMediaTimer = null;
        }
        bridge.pendingMediaTimer = setTimeout(() => {
          const target = bridge.pendingMediaTarget;
          const ids = [...bridge.pendingMediaIds];
          bridge.clearPendingMedia();
          const hasUnused = ids.some((id) => {
            const ent = bridge.fileMsgs.get(id);
            return ent && !ent.used;
          });
          if (target && hasUnused) {
            bridge.dispatchToBot(target, '请查看我发送的图片/文件。', null, null, null).catch(() => {});
          }
        }, bridge.imageBatchMs);
        bridge.pendingMediaTimer.unref?.();
      }
    }
    return;
  }

  if (isSelfChat) bridge.clearPendingMedia();

  const handleCardReply = (card: NonNullable<typeof quotedCard>, isQuoted: boolean): Promise<unknown> | null => {
    if (card.cardKind === 'burst') {
      if (APPROVE_RE.test(rawText) || /^1$/.test(rawText)) return handleBurstCardAction(bridge, card, 'run');
      if (DENY_RE.test(rawText) || SKIP_RE.test(rawText) || /^0$/.test(rawText)) return handleBurstCardAction(bridge, card, 'cancel');
      return null;
    }
    if (card.cardKind && card.cardKind !== 'card') {
      return (SKIP_RE.test(rawText) || /^0$/.test(rawText)) ? dismissBlockCard(bridge, card) : null;
    }
    if (card.isQuestion) {
      if (DENY_RE.test(rawText) || /^0$/.test(rawText)) return answerCard(bridge, card, 'deny');
      const curQ = card.questions?.[card.questionIndex ?? 0];
      const curOpts = curQ?.options ?? card.options ?? [];
      const curMulti = Boolean(curQ?.multiSelect);
      const pickedAnswer = parseMultiChoiceAnswer(rawText, curOpts, curMulti);
      const stepAnswer = pickedAnswer ?? ((isQuoted || !NOTE_PREFIX_RE.test(rawText)) ? rawText : null);
      if (stepAnswer) {
        if (card.questions && card.questions.length > 1) return advanceQuestionCard(bridge, card, stepAnswer);
        return answerCard(bridge, card, 'answer', stepAnswer);
      }
      return null;
    }
    if (!card.isReviewProposal && (ALWAYS_RE.test(rawText) || /^2$/.test(rawText))) {
      return answerCard(bridge, card, 'allow', undefined, { always: true, rememberCommand: card.canRememberCommand });
    }
    if (APPROVE_RE.test(rawText) || /^1$/.test(rawText)) return answerCard(bridge, card, 'allow');
    if (DENY_RE.test(rawText) || /^0$/.test(rawText)) return answerCard(bridge, card, 'deny');
    if (isQuoted) return answerCard(bridge, card, 'answer', rawText);
    return null;
  };

  // 1a. 显式引用卡片气泡回复优先
  if (quotedCard && !rawText.startsWith('@')) {
    const res = handleCardReply(quotedCard, true);
    if (res) return res;
  }

  // 1b. 自聊私密草稿确认回发（确认发送 / 取消 / 改：...）
  const pendingSendBack = bridge.pendingSendBack;
  if (isSelfChat && !rawText.startsWith('@') && !quotedRoute && pendingSendBack && bridge.now() < pendingSendBack.expiresAt) {
    if (/^(?:确认发送|确认|发送|send|ok|yes|好|好的)$/i.test(rawText)) return bridge.confirmSendBack();
    if (/^(?:取消|算了|不要|cancel|no)$/i.test(rawText)) {
      bridge.pendingSendBack = null;
      return bridge.say('❎ 已取消发回原群。');
    }
    const editM = rawText.match(/^(?:改|修改|替换)[:：\s]+([\s\S]+)$/);
    if (editM && editM[1].trim()) {
      return bridge.requestSendBack(pendingSendBack.draft, editM[1].trim());
    }
  }

  // 1c. @bot task 列表待选择序号（仅自聊，支持直接回复或引用列表气泡回复）
  const taskPick = bridge.pendingTaskPick;
  if (
    isSelfChat
    && !rawText.startsWith('@')
    && (!quotedRoute || (taskPick?.imMsgId && quotedId === taskPick.imMsgId))
    && taskPick
    && bridge.now() < taskPick.expiresAt
  ) {
    const choice = parseChoiceIndex(rawText);
    if (choice) {
      const picked = taskPick.tasks[choice - 1];
      if (picked) {
        return bridge.switchTask(
          taskPick.botId,
          taskPick.botName,
          picked,
          {
            isGroup: Boolean(taskPick.isGroup),
            ...(taskPick.chatId ? { chatId: taskPick.chatId } : {}),
            ...(taskPick.isExternal ? { isExternal: true } : {}),
            ...(taskPick.originChatId ? { originChatId: taskPick.originChatId } : {}),
            ...(taskPick.banner ? { banner: taskPick.banner } : {}),
          },
        );
      }
    }
  }

  // 1d. 裸回复待处理 OpenMausBot 审批/提问/阻塞卡（多卡提示引用，单卡直接作答）
  if (isSelfChat && !quotedCard && bridge.pendingCards.size > 1 && !rawText.startsWith('@')) {
    const looksLikeMultiSelect = /^\d+(?:\s*[,，、\s]\s*\d+)+$/.test(rawText);
    if (
      APPROVE_RE.test(rawText)
      || ALWAYS_RE.test(rawText)
      || DENY_RE.test(rawText)
      || SKIP_RE.test(rawText)
      || /^[0-9]$/.test(rawText)
      || looksLikeMultiSelect
      || parseChoiceIndex(rawText) !== null
    ) {
      return replyMultiCardHint(bridge);
    }
  }
  const bareCard = !quotedCard && isSelfChat && bridge.pendingCards.size === 1 ? [...bridge.pendingCards.values()][0] : null;
  if (bareCard && !rawText.startsWith('@')) {
    const res = handleCardReply(bareCard, false);
    if (res) return res;
  }

  // 1e. 有排队中消息时，允许在自聊裸回复 steer/插队 或 取消排队
  if (isSelfChat && !rawText.startsWith('@') && !quotedRoute && bridge.queuedByThread.size > 0) {
    if (/^(steer|插队)$/i.test(rawText)) return bridge.steerLatestQueue(bridge.focus?.threadId);
    if (/^(取消排队)$/i.test(rawText)) return bridge.cancelLatestQueue(bridge.focus?.threadId);
  }

  // 2. 解析 @bot / @bot! / 句中 @bot / 结构化 mentions / @<BotName> / @<GroupName>、引用气泡、或自聊连续对话粘性窗口
  const knownNames = bridge.getKnownBotNames();
  const triggerAliases = bridge.getEffectiveTriggerAliases();
  let replyToOmbId: string | null = null;
  let privateReply = false;

  const hit = await resolveExplicitTrigger(bridge, rawText, ev, knownNames, triggerAliases);
  let effectiveParsed = hit.parsed;
  let targetBot = hit.targetBot;

  if (effectiveParsed && targetBot) {
    let bodyText = effectiveParsed.bodyText;
    privateReply = Boolean(!isSelfChat && effectiveParsed.bang);
    if (effectiveParsed.atStart) {
      const matcher = buildMentionMatcher(bridge.trigger, triggerAliases, knownNames);
      for (let hops = 0; hops < 5 && /^@[^\s\u200B!:：,，]+/.test(bodyText); hops += 1) {
        const nested = parseStartMention(bodyText, bridge.trigger, triggerAliases, knownNames);
        if (!nested || !matcher.isKnownBotOrGroup(nested.mention)) break;
        if (!nested.isDefault) {
          const nextRes = await resolveBotTarget(bridge, nested.mention, false, ev);
          if (!nextRes.targetBot) break;
          targetBot = nextRes.targetBot;
          effectiveParsed = { ...effectiveParsed, isDefault: nextRes.isDefault };
        }
        privateReply = privateReply || Boolean(!isSelfChat && nested.bang);
        bodyText = nested.bodyText;
      }
    }
    if (!isSelfChat && bridge.chats.privateFlag !== false && bodyText) {
      const privM = bodyText.match(/^(?:-p|--private)(?:\s+([\s\S]*))?$/i);
      if (privM) {
        privateReply = true;
        bodyText = (privM[1] ?? '').trim();
      }
    }
    if (!isSelfChat && privateReply && !bridge.selfChat) {
      console.warn('[omb-bridge] 收到私密回复指令（@bot! / -p），但尚未获知 selfChatId；请先在自聊发一条消息或配置 channel.options.selfChatId');
      return;
    }

    const scopedTarget = !isSelfChat
      ? bridge.getChatThread(chatId, targetBot)
      : await bridge.resolveSelfBotThread(targetBot);
    const chatCtx = buildExternalChatCtx(bridge, {
      isSelfChat,
      chatId,
      chatType,
      chatName: ev.chat?.name,
      mid,
      privateReply,
      ev,
    });

    if (effectiveParsed.atStart && await handleCommand(bridge, bodyText, {
      isDefault: effectiveParsed.isDefault,
      targetBot: scopedTarget,
      quotedRoute,
      mid,
      quotedId,
      hasAttachments: atts.length > 0,
      chatCtx,
    })) {
      return;
    }
    targetBot = !isSelfChat ? await bridge.ensureChatThread(chatId, chatType, chatCtx.chatName || '', targetBot) : scopedTarget;
    if (quotedRoute && quotedRoute.botId === targetBot.id && quotedRoute.threadId === targetBot.threadId) {
      replyToOmbId = quotedRoute.ombMsgId ?? null;
    }

    const polishRes = tryDispatchDraftPolish(bridge, { isSelfChat, quotedId, bodyText, targetBot, mid, replyToOmbId, chatCtx });
    if (polishRes) return polishRes;

    if (!bodyText && !atts.length) {
      if (!quotedId) {
        return bridge.say(buildHelpText(bridge), { targetChatId: chatCtx.replyChatId }, chatCtx.replyToImMsgId);
      }
      return bridge.dispatchToBot(targetBot, '请查看并回复我引用的这条消息。', mid, quotedId, replyToOmbId, chatCtx);
    }
    return bridge.dispatchToBot(targetBot, bodyText || '请查看附件', mid, quotedId, replyToOmbId, chatCtx);
  }

  if (quotedRoute) {
    // 外部群里引用 Bot 回复但显式 @同事（未再 @bot），视作向同事交接/讨论，不重触发 Bot
    if (!isSelfChat && hasNonBotMention(rawText, bridge.trigger, triggerAliases, knownNames, ev.mentions)) {
      return;
    }
    let bodyText = rawText;
    if (!isSelfChat && bridge.chats.privateFlag !== false) {
      const privM = bodyText.match(/^(?:-p|--private)(?:\s+([\s\S]*))?$/i);
      if (privM) {
        privateReply = true;
        bodyText = (privM[1] ?? '').trim();
      }
    }
    const isDraftFirst = Boolean(!isSelfChat && !privateReply && bridge.chats.externalReplyMode === 'draft_first' && bridge.selfChat);
    if (isDraftFirst) privateReply = true;
    if (!isSelfChat && privateReply && !bridge.selfChat) {
      console.warn('[omb-bridge] 收到私密回复指令（-p），但尚未获知 selfChatId；请先在自聊发一条消息或配置 channel.options.selfChatId');
      return;
    }
    targetBot = {
      id: quotedRoute.botId,
      name: quotedRoute.botName,
      threadId: quotedRoute.threadId,
      isGroup: Boolean(quotedRoute.isGroup),
    };
    replyToOmbId = quotedRoute.ombMsgId ?? null;
    const chatCtx = buildExternalChatCtx(bridge, {
      isSelfChat,
      chatId,
      chatType,
      chatName: ev.chat?.name,
      mid,
      privateReply,
      ev,
    });
    if (isDraftFirst) chatCtx.draftFirst = true;

    const polishRes = tryDispatchDraftPolish(bridge, { isSelfChat, quotedId, bodyText, targetBot, mid, replyToOmbId, chatCtx });
    if (polishRes) return polishRes;

    if (!bodyText && !atts.length) {
      return bridge.say(buildHelpText(bridge), { targetChatId: chatCtx.replyChatId }, chatCtx.replyToImMsgId);
    }
    return bridge.dispatchToBot(targetBot, bodyText || '请查看附件', mid, quotedId, replyToOmbId, chatCtx);
  }

  if (isSelfChat && bridge.isStickyActive() && bridge.focus && !NOTE_PREFIX_RE.test(rawText) && !ev.isForwarded && !ev.forwarded) {
    if (BYE_RE.test(rawText)) {
      bridge.clearSticky();
      return bridge.say('👋 已结束连续对话，之后普通消息将作为自聊笔记不再打扰。');
    }
    const bodyText = rawText;
    targetBot = {
      id: bridge.focus.botId,
      name: bridge.focus.botName,
      threadId: bridge.focus.threadId,
      isGroup: Boolean(bridge.focus.isGroup),
    };
    targetBot = await bridge.resolveSelfBotThread(targetBot);
    return bridge.dispatchToBot(
      targetBot,
      bodyText || '请查看附件',
      mid,
      quotedId,
      replyToOmbId,
      buildExternalChatCtx(bridge, { isSelfChat: true, chatId, chatType, chatName: ev.chat?.name, mid, privateReply: false, ev }),
    );
  }
  return undefined;
}
