import { clip } from '../format.ts';
import type { OpenMausBotBridge } from './bridge.ts';
import { formatMultiQuestionAnswers, formatOmbError, formatQuestionStepPrompt } from './cards.ts';
import { formatOriginBanner } from './command-helpers.ts';
import type { BridgeChatContext, MsgRoute, OmbHttpError, PendingCard } from './types.ts';

function buildCardReplyContext(bridge: OpenMausBotBridge, card: PendingCard): {
  ctrlChatId: string;
  who: string;
  head: string;
  route: MsgRoute;
} {
  const ctrlChatId = bridge.resolveControlChatId(card.chatCtx);
  const who = bridge.botPrefix(card.botId, card.botName, { isGroup: Boolean(card.isGroup) });
  const head = who ? `${who} ` : '';
  const route: MsgRoute = {
    botId: card.botId,
    botName: card.botName,
    threadId: card.threadId,
    ombMsgId: card.ombMsgId ?? null,
    ...(card.isGroup ? { isGroup: true } : {}),
    ...(ctrlChatId ? { targetChatId: ctrlChatId } : {}),
  };
  return { ctrlChatId, who, head, route };
}

/** 清理与当前响应关联的 pendingCards 条目并持久化状态。 */
function deleteCard(bridge: OpenMausBotBridge, card: PendingCard): void {
  for (const [k, v] of bridge.pendingCards) {
    const sameReq = Boolean(card.requestId && v.requestId === card.requestId);
    const sameBurst = Boolean(card.burstId && v.burstId === card.burstId);
    const sameMsg = Boolean(card.ombMsgId && v.ombMsgId && v.ombMsgId === card.ombMsgId);
    if (sameReq || sameBurst || sameMsg || k === card.imMsgId) {
      bridge.pendingCards.delete(k);
    }
  }
  bridge.saveState();
}

function cleanupIfStaleCardError(bridge: OpenMausBotBridge, card: PendingCard, err: unknown): void {
  const status = (err as OmbHttpError | null | undefined)?.status;
  if (status === 404 || status === 409 || status === 410) {
    deleteCard(bridge, card);
  }
}

/** 当有多张待处理卡片且用户裸回复快捷词时，提示引用对应消息回复以免误批。 */
export async function replyMultiCardHint(bridge: OpenMausBotBridge): Promise<void> {
  const who = bridge.botPrefix('', bridge.botName);
  const head = who ? `${who} ` : '';
  const items = [...bridge.pendingCards.values()].map((c) => {
    const name = bridge.displayBotName(c.botId, c.botName, { isGroup: Boolean(c.isGroup) });
    return `- **${name}**：${clip(c.title || '待确认操作', 48)}`;
  });
  await bridge.say(
    `${head}⚠️ 当前有 **${bridge.pendingCards.size}** 条待确认请求，请**引用对应气泡**回复（如 \`1\` / \`0\` 或 \`ok\` / \`no\`）：\n${items.join('\n')}`,
  );
}

/** 推进多题提问卡至下一题，全部答完后汇总提交给 OpenMausBot。 */
export async function advanceQuestionCard(bridge: OpenMausBotBridge, card: PendingCard, stepAnswer: string): Promise<unknown> {
  const questions = Array.isArray(card.questions) ? card.questions : [];
  const nextAnswers = [...(card.collectedAnswers ?? []), stepAnswer];
  const nextIndex = (card.questionIndex ?? 0) + 1;
  if (nextIndex < questions.length) {
    const { ctrlChatId, who, head, route } = buildCardReplyContext(bridge, card);
    const multiCard = bridge.pendingCards.size > 1;
    const step = formatQuestionStepPrompt(who, card.title || '需要你做个决定', questions, nextIndex, { multiCard });
    const originBanner = formatOriginBanner(card.chatCtx, ctrlChatId, bridge.selfChat, '的审批 / 确认');
    const nextSentId = await bridge.say(`${originBanner}${step.text}`, route, null, null, { noBuffer: true });
    if (!nextSentId) {
      await bridge.say(`${head}⚠️ 下一题发送失败，请稍后重试当前回复。`, route);
      return undefined;
    }
    bridge.pendingCards.delete(card.imMsgId);
    if (!card.chatCtx?.isExternal) bridge.lastBotReplyAt = bridge.now();
    bridge.pendingCards.set(nextSentId, {
      ...card,
      imMsgId: nextSentId,
      questionIndex: nextIndex,
      collectedAnswers: nextAnswers,
      options: questions[nextIndex]?.options ?? [],
    });
    bridge.saveState();
    return undefined;
  }
  const combined = questions.length > 1 ? formatMultiQuestionAnswers(questions, nextAnswers) : stepAnswer;
  return answerCard(bridge, card, 'answer', combined);
}

/** 处理 `/burst` 预览卡片在 IM 中的确认执行或取消操作。 */
export async function handleBurstCardAction(
  bridge: OpenMausBotBridge,
  card: PendingCard,
  action: 'run' | 'cancel',
): Promise<void> {
  if (!card.burstId) {
    deleteCard(bridge, card);
    return;
  }
  const { head, route } = buildCardReplyContext(bridge, card);
  try {
    try {
      if (action === 'run') await bridge.client.runBurst(card.burstId);
      else await bridge.client.cancelBurst(card.burstId);
    } catch (e) {
      cleanupIfStaleCardError(bridge, card, e);
      throw e;
    }
    deleteCard(bridge, card);
    bridge.emitTelemetry('card_answer', { botName: card.botName, kind: action === 'run' ? 'burst_run' : 'burst_cancel' });
    if (!card.chatCtx?.isExternal) bridge.lastBotReplyAt = bridge.now();
    if (action === 'run') {
      const cutoff = bridge.now() - 2 * 60 * 60_000;
      for (const [k, w] of bridge.activeBursts) if (w.startedAt < cutoff) bridge.activeBursts.delete(k);
      bridge.activeBursts.set(card.burstId, {
        burstId: card.burstId,
        botId: card.botId,
        botName: card.botName,
        threadId: card.threadId,
        isGroup: Boolean(card.isGroup),
        chatCtx: card.chatCtx ?? null,
        startedAt: bridge.now(),
      });
      await bridge.say(`${head}✅ 已启动并发拆分任务，完成后会自动汇总回复。`, route);
    } else {
      await bridge.say(`${head}❎ 已取消该并发拆分任务。`, route);
    }
  } catch (e) {
    await bridge.say(`${head}⚠️ 并发任务操作失败：${formatOmbError(e)}`, route);
  }
}

/** 跳过阻塞类卡片（凭据 / 连接器 / 登录验证）。 */
export async function dismissBlockCard(bridge: OpenMausBotBridge, card: PendingCard): Promise<void> {
  const cardBotId = card.cardBotId || card.botId;
  const { head, route } = buildCardReplyContext(bridge, card);
  try {
    try {
      const ombId = card.ombMsgId ?? '';
      if (card.cardKind === 'secret') {
        await bridge.client.dismissSecretCard(cardBotId, ombId, card.threadId);
      } else if (card.cardKind === 'connector') {
        await bridge.client.dismissConnectorCard(cardBotId, ombId, card.threadId);
      } else if (card.cardKind === 'signIn') {
        await bridge.client.cancelSignInCard(cardBotId, ombId, card.threadId);
      }
    } catch (e) {
      cleanupIfStaleCardError(bridge, card, e);
      throw e;
    }
    deleteCard(bridge, card);
    bridge.emitTelemetry('card_dismiss', { botName: card.botName, kind: card.cardKind });
    if (!card.chatCtx?.isExternal) bridge.lastBotReplyAt = bridge.now();
    await bridge.say(`${head}⏭ 已跳过该步骤，继续执行。`, route);
  } catch (e) {
    await bridge.say(`${head}⚠️ 跳过操作失败：${formatOmbError(e)}`, route);
  }
}

/** 提交审批卡或提问卡响应并反馈回执。 */
export async function answerCard(
  bridge: OpenMausBotBridge,
  card: PendingCard,
  behavior: string,
  message?: string,
  opts: { always?: boolean; rememberCommand?: boolean } = {},
): Promise<unknown> {
  const { head, route } = buildCardReplyContext(bridge, card);
  try {
    if (!card.requestId) {
      deleteCard(bridge, card);
      const text = message ?? (behavior === 'allow' ? 'ok' : 'no');
      const cardChatCtx: BridgeChatContext | null = card.chatCtx?.isExternal
        ? {
            isExternal: true,
            originChatId: card.chatCtx.originChatId || '',
            chatType: card.chatCtx.chatType || 'group',
            chatName: card.chatCtx.chatName,
            replyChatId: card.chatCtx.replyChatId || bridge.selfChat,
            controlChatId: card.chatCtx.controlChatId || bridge.selfChat,
            replyToImMsgId: card.chatCtx.replyToImMsgId ?? null,
            originQuoteId: card.chatCtx.originQuoteId ?? null,
            privateReply: Boolean(card.chatCtx.privateReply),
            silentProgress: Boolean(card.chatCtx.silentProgress),
            readonly: card.chatCtx.readonly,
            draftFirst: card.chatCtx.draftFirst,
            collaborator: card.chatCtx.collaborator,
            allowedProjects: card.chatCtx.allowedProjects,
            delegationReq: card.chatCtx.delegationReq,
          }
        : null;
      return bridge.dispatchToBot(
        { id: card.botId, name: card.botName, threadId: card.threadId, isGroup: Boolean(card.isGroup) },
        text,
        null,
        null,
        card.ombMsgId ?? null,
        cardChatCtx,
      );
    }

    const payload: {
      requestId: string;
      behavior: string;
      message?: string;
      always?: boolean;
      rememberCommand?: boolean;
    } = {
      requestId: card.requestId,
      behavior,
      ...(message !== undefined ? { message } : {}),
      ...(opts.always ? { always: true } : {}),
      ...(opts.rememberCommand ? { rememberCommand: true } : {}),
    };
    try {
      await bridge.client.respond(card.threadId, payload);
    } catch (e) {
      const err = e as OmbHttpError;
      if (opts.rememberCommand && err?.status === 403) {
        delete payload.rememberCommand;
        await bridge.client.respond(card.threadId, payload);
      } else {
        cleanupIfStaleCardError(bridge, card, err);
        throw e;
      }
    }
    deleteCard(bridge, card);
    bridge.emitTelemetry('card_answer', { botName: card.botName, kind: behavior });
    if (!card.chatCtx?.isExternal) bridge.lastBotReplyAt = bridge.now();
    const label = behavior === 'allow'
      ? (opts.always ? '已设为总是允许，继续执行' : '已允许，继续执行')
      : behavior === 'deny'
        ? '已拒绝该操作'
        : (message ? `已选择「${clip(message, 40)}」，继续执行` : '已提交回复，继续执行');
    await bridge.say(`${head}✅ ${label}`, route);
  } catch (e) {
    await bridge.say(`${head}⚠️ 审批提交失败：${formatOmbError(e)}`, route);
  }
  return undefined;
}
