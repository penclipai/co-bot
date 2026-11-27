import { evaluateInboundPolicy } from '../core/inbound-policy.ts';
import {
  findUnauthorizedPathMention,
  findUnauthorizedProjectMention,
  isProjectAuthorized,
} from '../core/projects.ts';
import { clip } from '../format.ts';
import type { ChatType, InboundEvent } from '../types.ts';
import type { OpenMausBotBridge } from './bridge.ts';
import { isExternalChatAllowed } from './chat-manager.ts';
import { formatDelegationRequest, generateDelegationId } from './delegation.ts';
import { recordClosedInboxRef } from './inbox.ts';
import {
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

const OWNER_COMMAND_RE = /^(?:help|帮助|\?|？|status|状态|stop|停止|bye|退下|结束对话|退出对话|quiet|免打扰|steer|插队|cancel|取消|取消排队|chats|会话列表|mute|静音|unmute|解除静音|取消静音|恢复通知|summary|汇总|纪要|sendback|发回|bind|绑定|delegate|委托|new|新会话|task|会话|compact|压缩|\/(?:goal|learn|burst|setup))(?:[\s:：]|$)/i;

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

export async function resolveBotTarget(
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

/** 根据开头/正文 `@` 或结构化提及解析目标 Bot（从 `inbound-router.ts` 拆分）。 */
export async function resolveExplicitTrigger(
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

/** 处理来自非主人的协作者或 C2C 委托消息（含被动 @ 提醒分流与只读策略门禁）。 */
export async function handleCollaboratorEvent(
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
