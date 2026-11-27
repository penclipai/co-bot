import fs from 'node:fs';
import path from 'node:path';
import { SELF_NOTE_PREFIX_RE } from '../core/chat-context.ts';
import { evaluateInboundPolicy } from '../core/inbound-policy.ts';
import {
  findUnauthorizedPathMention,
  findUnauthorizedProjectMention,
  isProjectAuthorized,
} from '../core/projects.ts';
import { clip, fileSafe } from '../format.ts';
import type { ChatType, InboundEvent } from '../types.ts';
import type { OpenMausBotBridge } from './bridge.ts';
import { handleCardReplyText, replyMultiCardHint } from './card-actions.ts';
import { parseChoiceIndex } from './cards.ts';
import { confirmDraftDirect, discardPrivateDraft, isExternalChatAllowed } from './chat-manager.ts';
import { makeCommandSink } from './command-helpers.ts';
import { buildHelpText, handleCommand } from './commands.ts';
import { formatDelegationRequest, generateDelegationId, parseDelegationTag } from './delegation.ts';
import { handleFollowUpReply } from './follow-up.ts';
import {
  handleInboxRefAction,
  pruneExpiredInboxItems,
  recordClosedInboxRef,
  replyDisambiguationHint,
} from './inbox.ts';
import {
  buildMentionMatcher,
  hasNonBotMention,
  inQuietHours,
  parseInlineTriggerMention,
  parseStartMention,
  parseStructuredBotMention,
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
const BYE_RE = /^(bye|退下|结束对话|退出对话)$/i;
const OWNER_COMMAND_RE = /^(?:help|帮助|\?|？|status|状态|stop|停止|bye|退下|结束对话|退出对话|quiet|免打扰|steer|插队|cancel|取消|取消排队|chats|会话列表|mute|静音|unmute|解除静音|取消静音|恢复通知|summary|汇总|纪要|sendback|发回|bind|绑定|delegate|委托|new|新会话|task|会话|compact|压缩|\/(?:goal|learn|burst|setup))(?:[\s:：]|$)/i;

function extractPrivateFlag(text: string): { privateFlag: boolean; body: string } {
  const m = text.match(/^(?:-p|--private)(?:\s+([\s\S]*))?$/i);
  return m ? { privateFlag: true, body: (m[1] ?? '').trim() } : { privateFlag: false, body: text };
}

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
  const sentId = await bridge.say(wire, { targetChatId: targetChat.id }, null, null, { noBuffer: true });
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
  const chatId = String(ev.chat.id);
  const chatType = ev.chat.type || 'direct';
  if (chatType !== 'direct') {
    bridge.policyDenials += 1;
    bridge.emitTelemetry('policy_denied', { chatId, chatType, summary: `reason=delegation_res_requires_direct re=${parsedRes.re}` });
    return;
  }
  const existing = bridge.delegations.pendingOutbound.get(parsedRes.re);
  if (existing && String(existing.targetChatId) !== chatId) {
    bridge.policyDenials += 1;
    bridge.emitTelemetry('policy_denied', { chatId, chatType, summary: `reason=delegation_res_origin_mismatch re=${parsedRes.re}` });
    return;
  }
  const pending = bridge.delegations.completeOutbound(parsedRes.re);
  bridge.emitTelemetry('delegation_res', {
    chatId,
    chatType,
    summary: `inbound re=${parsedRes.re}${pending ? ' matched' : ' unmatched'}`,
  });
  if (!pending) return;
  recordClosedInboxRef(bridge, pending.inboxRef, `C2C 委托「${pending.targetChatName || chatId}」`);
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
    if (
      decision.reason === 'not_in_whitelist'
      && ev.mentionsMe
      && bridge.chats.passiveMentionAlert === true
      && bridge.selfChat
      && isExternalChatAllowed(bridge, chatId, chatType)
    ) {
      const senderLabel = ev.sender?.name || ev.sender?.id || '同事';
      const chatLabel = ev.chat?.name || chatId;
      const alertText = `📣 **「${chatLabel}」${senderLabel} 提到了你**\n> ${clip(rawText || '[附件消息]', 240)}\n\n回复 \`${bridge.trigger} summary ${chatId}\` 查看前文。`;
      bridge.emitTelemetry('passive_mention_triage', {
        chatId,
        chatType,
        summary: `from=${senderLabel}`,
      });
      if (inQuietHours(bridge.now(), bridge.quietHours)) {
        bridge.quietQueue.push({
          botId: bridge.chiefBotId || 'chief',
          botName: bridge.botName,
          threadId: chatId,
          isGroup: false,
          speakerName: chatLabel,
          speakerBotId: null,
          text: alertText,
          finalMsg: { id: String(ev.id), role: 'bot', kind: 'text', text: alertText },
        });
        bridge.saveState();
      } else {
        await bridge.say(alertText, { targetChatId: bridge.selfChat });
        bridge.notifySelf({ title: `「${chatLabel}」@了你`, body: rawText || '[附件消息]', chatId: bridge.selfChat });
      }
    }
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
    if (unauth) {
      bridge.policyDenials += 1;
      bridge.emitTelemetry('policy_denied', {
        chatId,
        chatType,
        summary: `sender=${ev.sender?.id || '?'} reason=project_not_authorized:${unauth.name}`,
      });
      return;
    }
    const unauthPath = findUnauthorizedPathMention(question, bridge.projects, decision.allowedProjects);
    if (unauthPath) {
      bridge.policyDenials += 1;
      bridge.emitTelemetry('policy_denied', {
        chatId,
        chatType,
        summary: `sender=${ev.sender?.id || '?'} reason=unauthorized_path:${unauthPath}`,
      });
      return;
    }
  }
  if (Array.isArray(ev.attachments) && ev.attachments.length) {
    bridge.setFileMsg(chatId, String(ev.id), ev.attachments);
  }

  const collabBotRef = String(bridge.chats.collaboratorBot ?? '').trim();
  const resolvedChief = collabBotRef
    ? await bridge.client.resolveBot(collabBotRef)
    : await bridge.client.resolveBot('');
  if (!resolvedChief) {
    if (collabBotRef) {
      bridge.policyDenials += 1;
      bridge.emitTelemetry('policy_denied', {
        chatId,
        chatType,
        summary: `sender=${ev.sender?.id || '?'} reason=collaborator_bot_unavailable:${collabBotRef}`,
      });
    }
    return;
  }
  let chief: OmbTargetBot;
  try {
    chief = await bridge.ensureChatThread(chatId, chatType, ev.chat?.name || chatId, resolvedChief);
  } catch (e) {
    bridge.emitTelemetry('policy_denied', {
      chatId,
      chatType,
      summary: `sender=${ev.sender?.id || '?'} reason=thread_isolation_error`,
    });
    if (bridge.selfChat) {
      await bridge.say(`⚠️ 无法为「${ev.chat?.name || chatId}」建立协作者隔离会话，已中止处理：${e instanceof Error ? e.message : e}`);
    }
    return;
  }

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
  if (decision.mode === 'confirm_in_self' && bridge.chats.collaboratorConfirmAck) {
    await bridge.say(
      '🤖 已收到，正在整理并转交主人确认后回复。',
      { targetChatId: chatId },
      String(ev.id),
    );
  }
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
    ...(polishSource.forceBotPrefix ? { forceBotPrefix: true } : {}),
    ...(polishSource.delegationRe ? { delegationRe: polishSource.delegationRe } : {}),
    ...(polishSource.mentions?.length ? { mentions: polishSource.mentions.map((m) => ({ ...m })) } : {}),
    ...(polishSource.allowMentionNames?.length ? { allowMentionNames: [...polishSource.allowMentionNames] } : {}),
    ...(polishSource.followUp ? { followUp: { ...polishSource.followUp } } : {}),
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
  if (bridge.isOwnId(chatId, mid)) return;
  if (bridge.hasSeenMsg(chatId, mid)) return;
  bridge.markSeenMsg(chatId, mid);

  // 撤回事件：同步从内存上下文窗口、待用附件队列、消息路由、拉取缓存与衍生在途待办擦除
  if (ev.kind === 'recall' && ev.recalledMsgId) {
    const recalledId = String(ev.recalledMsgId);
    if (bridge.imContext?.recallMessage) bridge.imContext.recallMessage(chatId, recalledId);
    else bridge.localContextStore.recallMessage(chatId, recalledId);
    bridge.deleteFileMsg(chatId, recalledId);
    bridge.deleteMsgRoute(chatId, recalledId);
    let stateChanged = false;
    for (const [k, d] of bridge.privateDrafts) {
      if (d?.originChatId === chatId && d?.replyToImMsgId === recalledId) {
        recordClosedInboxRef(bridge, d.inboxRef, `已撤回草稿`);
        bridge.privateDrafts.delete(k);
        for (const [sbk, sb] of bridge.pendingSendBacks) {
          if (sb?.draft?.id === d.id) bridge.pendingSendBacks.delete(sbk);
        }
        stateChanged = true;
      }
    }
    for (const [k, fp] of bridge.pendingFollowUps) {
      if (fp?.chatId === chatId && fp?.askMsgId === recalledId) {
        recordClosedInboxRef(bridge, fp.inboxRef, `已撤回追问`);
        bridge.pendingFollowUps.delete(k);
        stateChanged = true;
      }
    }
    try {
      fs.rmSync(path.join(bridge.inDir, fileSafe(chatId) || 'chat', fileSafe(recalledId) || 'f'), { recursive: true, force: true });
      fs.rmSync(path.join(bridge.inDir, fileSafe(recalledId) || 'f'), { recursive: true, force: true });
      if (bridge.dataDir) {
        fs.rmSync(path.join(bridge.dataDir, 'in', 'pull', fileSafe(chatId) || 'chat', fileSafe(recalledId) || 'msg'), { recursive: true, force: true });
      }
    } catch { /* ignore */ }
    if (stateChanged) bridge.saveState();
    bridge.emitTelemetry('recall', { chatId, chatType, summary: `recall:${recalledId}` });
    return;
  }

  const rawText = String(ev.text ?? '').trim();
  if (isSelfSender && rawText && bridge.isEcho(rawText)) return;

  const atts = Array.isArray(ev.attachments) ? ev.attachments : [];
  if (!rawText && atts.length && atts.every((a) => bridge.isPendingOutFile(a))) {
    bridge.rememberOwnId(mid, chatId);
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
      || (ev.replyTo != null && bridge.getMsgRoute(chatId, String(ev.replyTo))),
    );
    if (wouldTrigger) {
      bridge.emitTelemetry('policy_denied', {
        chatId,
        chatType,
        summary: `sender=${ev.sender?.id || 'me'} reason=chat_not_allowed`,
      });
      if (bridge.chatPolicyOverrides.muted.has(chatId) && bridge.selfChat) {
        const now = bridge.now();
        const cooldown = Number(bridge.mutedHintCooldownMs) || 0;
        const lastAt = bridge.lastMutedHintAt.get(chatId) || 0;
        if (cooldown <= 0 || (now - lastAt) >= cooldown) {
          bridge.lastMutedHintAt.set(chatId, now);
          const chatLabel = ev.chat?.name || chatId;
          await bridge.say(
            `🔇 「${chatLabel}」（\`${chatId}\`）当前已静音，刚才的 \`${bridge.trigger}\` 未触发。回复 \`${bridge.trigger} unmute ${chatId}\` 可恢复。`,
            { targetChatId: bridge.selfChat },
            null,
            [{ label: '解除静音', text: `${bridge.trigger} unmute ${chatId}`, kind: 'primary' }],
          );
        }
      }
    }
    return;
  }

  if (atts.length) {
    bridge.setFileMsg(chatId, mid, atts);
  }

  const quotedId = ev.replyTo != null ? String(ev.replyTo) : null;
  const quotedCard = quotedId ? bridge.getPendingCard(chatId, quotedId) : null;
  const quotedRoute = quotedId ? bridge.getMsgRoute(chatId, quotedId) : null;

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
            const hit = bridge.getFileMsg(chatId, id);
            return hit && !hit.entry.used;
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

  const handleCardReply = (card: NonNullable<typeof quotedCard>, isQuoted: boolean, input = rawText): Promise<unknown> | null => (
    handleCardReplyText(bridge, card, isQuoted, input)
  );

  // 0. 统一收件箱短编号快捷消项（`#N 1/0/确认/取消/改：...`）
  if (isSelfChat) {
    pruneExpiredInboxItems(bridge);
    if (!rawText.startsWith('@') && await handleInboxRefAction(bridge, rawText, { handleCardReply })) {
      return;
    }
  }

  // 1a. 显式引用卡片气泡回复优先
  if (quotedCard && !rawText.startsWith('@')) {
    const res = handleCardReply(quotedCard, true);
    if (res) return res;
  }

  // 1b. 自聊私密草稿确认回发（支持引用确认/直发/取消/改写，及无引用时的碰撞安全与过期提示）
  const sbConfirmRe = /^(?:确认发送|确认|发送|send|ok|yes|y|okay|好|好的|1)$/i;
  const sbCancelRe = /^(?:取消|算了|不要|忽略|cancel|no|n|0)$/i;
  const sbEditRe = /^(?:改|修改|替换)[:：\s]+([\s\S]+)$/;
  if (isSelfChat && !rawText.startsWith('@') && quotedId) {
    const quotedSb = [...bridge.pendingSendBacks.values()].find((p) => p.imMsgId === quotedId && bridge.now() < p.expiresAt);
    if (quotedSb) {
      if (sbConfirmRe.test(rawText)) return bridge.confirmSendBack(quotedSb.id);
      if (sbCancelRe.test(rawText)) return bridge.cancelSendBack(quotedSb.id);
      const editM = rawText.match(sbEditRe);
      if (editM && editM[1].trim()) return bridge.requestSendBack(quotedSb.draft, editM[1].trim());
    }
    if (bridge.expiredSendBackIds.has(quotedId) && (sbConfirmRe.test(rawText) || sbCancelRe.test(rawText) || sbEditRe.test(rawText))) {
      bridge.expiredSendBackIds.delete(quotedId);
      return bridge.say(`⌛ 该待发回预览已超时，请引用原草稿回复 \`${bridge.trigger} sendback\` 或 \`确认发送\`。`);
    }
    const quotedDraft = bridge.resolvePrivateDraft({ quotedId });
    if (quotedDraft && (quotedDraft.imMsgId === quotedId || quotedDraft.imMsgIds?.includes(quotedId) || bridge.privateDrafts.get(quotedId)?.id === quotedDraft.id)) {
      if (/^(?:确认发送|确认|直接发|直接发送|ok|yes|y|okay|好|好的|1)$/i.test(rawText)) return confirmDraftDirect(bridge, quotedDraft);
      if (/^(?:发回|发送|send|sendback)$/i.test(rawText)) return bridge.requestSendBack(quotedDraft);
      if (/^(?:取消|忽略|算了|不要|cancel|no|n|0)$/i.test(rawText)) return discardPrivateDraft(bridge, quotedDraft);
      const editM = rawText.match(sbEditRe);
      if (editM && editM[1].trim()) return bridge.requestSendBack(quotedDraft, editM[1].trim());
    }
  }
  const pendingSendBack = bridge.pendingSendBack;
  if (isSelfChat && !rawText.startsWith('@') && !quotedRoute && pendingSendBack && bridge.now() < pendingSendBack.expiresAt) {
    const isSbAction = sbConfirmRe.test(rawText) || sbCancelRe.test(rawText) || sbEditRe.test(rawText);
    if (isSbAction) {
      if (bridge.pendingSendBacks.size > 1) {
        return replyDisambiguationHint(bridge, 'multi_sendback');
      }
      if (bridge.pendingCards.size >= 1) {
        return replyDisambiguationHint(bridge, 'sendback_card_collision');
      }
      if (sbConfirmRe.test(rawText)) return bridge.confirmSendBack(pendingSendBack.id);
      if (sbCancelRe.test(rawText)) return bridge.cancelSendBack(pendingSendBack.id);
      const editM = rawText.match(sbEditRe);
      if (editM && editM[1].trim()) return bridge.requestSendBack(pendingSendBack.draft, editM[1].trim());
    }
  } else if (
    isSelfChat
    && !rawText.startsWith('@')
    && !quotedRoute
    && !bridge.pendingSendBacks.size
    && !bridge.pendingCards.size
    && bridge.lastExpiredSendBackAt > 0
    && (bridge.now() - bridge.lastExpiredSendBackAt) <= 10 * 60_000
    && /^(?:确认发送|发送|sendback)$/i.test(rawText)
  ) {
    bridge.lastExpiredSendBackAt = 0;
    return bridge.say(`⌛ 待发回草稿已超时，请引用私密草稿重新发送 \`${bridge.trigger} sendback\`。`);
  }

  // 1c. @bot task 列表待选择序号（仅自聊，支持 0/取消 及与 pendingCards 的碰撞保护）
  const taskPick = bridge.pendingTaskPick;
  if (
    isSelfChat
    && !rawText.startsWith('@')
    && (!quotedRoute || (taskPick?.imMsgId && quotedId === taskPick.imMsgId))
    && taskPick
    && bridge.now() < taskPick.expiresAt
  ) {
    if (/^(?:0|取消|算了|不要|cancel|no|n)$/i.test(rawText)) {
      bridge.pendingTaskPick = null;
      return bridge.say('❎ 已取消切换会话。');
    }
    const rawInt = /^\d+$/.test(rawText) ? Number(rawText) : null;
    const choice = parseChoiceIndex(rawText) ?? rawInt;
    if (choice !== null) {
      if (!quotedCard && !(taskPick.imMsgId && quotedId === taskPick.imMsgId) && bridge.pendingCards.size >= 1) {
        return replyDisambiguationHint(bridge, 'task_card_collision');
      }
      const picked = choice >= 1 ? taskPick.tasks[choice - 1] : undefined;
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
      if (rawInt !== null) {
        return bridge.say(`请输入 \`1\`～\`${taskPick.tasks.length}\` 的序号，或回复 \`0\` 取消。`);
      }
    }
  }

  // 1d. 裸回复待处理 OpenMausBot 审批/提问/阻塞卡（多卡提示编号或引用，单卡直接作答）
  if (isSelfChat && !quotedCard && bridge.pendingCards.size > 1 && !rawText.startsWith('@')) {
    const looksLikeMultiSelect = /^\d+(?:\s*[,，、\s]\s*\d+)+$/.test(rawText);
    const hasQuestionCard = [...bridge.pendingCards.values()].some((c) => c.isQuestion);
    if (
      APPROVE_RE.test(rawText)
      || ALWAYS_RE.test(rawText)
      || DENY_RE.test(rawText)
      || SKIP_RE.test(rawText)
      || /^[0-9]$/.test(rawText)
      || looksLikeMultiSelect
      || parseChoiceIndex(rawText) !== null
      || (hasQuestionCard && !SELF_NOTE_PREFIX_RE.test(rawText))
    ) {
      return replyMultiCardHint(bridge);
    }
  }
  const bareCard = !quotedCard && isSelfChat && bridge.pendingCards.size === 1 ? [...bridge.pendingCards.values()][0] : null;
  if (bareCard && !rawText.startsWith('@')) {
    const res = handleCardReply(bareCard, false);
    if (res) return res;
  }

  // 1e. 有排队中消息时，允许在自聊裸回复 steer/插队 或 cancel/取消排队
  if (isSelfChat && !rawText.startsWith('@') && !quotedRoute && bridge.queuedByThread.size > 0) {
    if (/^(steer|插队)$/i.test(rawText)) return bridge.steerLatestQueue(bridge.focus?.threadId);
    if (/^(cancel|取消排队)$/i.test(rawText)) return bridge.cancelLatestQueue(bridge.focus?.threadId);
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
      const pf = extractPrivateFlag(bodyText);
      if (pf.privateFlag) {
        privateReply = true;
        bodyText = pf.body;
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
    try {
      targetBot = !isSelfChat ? await bridge.ensureChatThread(chatId, chatType, chatCtx.chatName || '', targetBot) : scopedTarget;
    } catch (e) {
      const ctrl = makeCommandSink(bridge, chatCtx, { sensitive: true });
      return ctrl.say(`❌ 无法为当前外部会话建立隔离上下文，已中止发往底层：${e instanceof Error ? e.message : e}`);
    }
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
      const pf = extractPrivateFlag(bodyText);
      if (pf.privateFlag) {
        privateReply = true;
        bodyText = pf.body;
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

  if (isSelfChat && bridge.isStickyActive() && bridge.focus && !SELF_NOTE_PREFIX_RE.test(rawText) && !ev.isForwarded && !ev.forwarded) {
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
