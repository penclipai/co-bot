/**
 * 统一协调收件箱（Coordinator Inbox）：分配短编号 `#1` / `#2`、统一生命周期过期清理、启动对账与冲突消歧。
 */
import { clip } from '../format.ts';
import type { OpenMausBotBridge } from './bridge.ts';
import { parseMultiChoiceAnswer } from './cards.ts';
import { cancelSendBack, confirmDraftDirect, confirmSendBack, discardPrivateDraft, requestSendBack } from './chat-manager.ts';
import { trimMapCap } from './mentions.ts';
import { pruneExpiredQueues } from './queue-and-sse.ts';
import type { CoordinatorInboxSummary, OmbMessage, PendingCard, PendingSendBack, PrivateDraft } from './types.ts';

const CLOSED_REF_TTL_MS = 10 * 60_000;
const DELEGATION_TTL_MS = 24 * 60 * 60_000;

const CONFIRM_RE = /^(?:确认发送|确认|直接发|直接发送|发送|send|ok|yes|y|okay|好|好的|1)$/i;
const PREVIEW_RE = /^(?:预览|sendback|发回)$/i;
const CANCEL_RE = /^(?:取消|算了|不要|忽略|cancel|no|n|0|stop|结束|关闭)$/i;
const EDIT_RE = /^(?:改|修改|替换)[:：\s]+([\s\S]+)$/;
const ANSWER_PREFIX_RE = /^(?:答|回答|回复)[:：\s]+([\s\S]+)$/;
const CLOSED_ACTION_RE = /^(?:确认发送|确认|直接发|直接发送|发送|send|ok|yes|y|okay|好|好的|always|all|取消|算了|不要|忽略|cancel|no|n|skip|pass|ignore|跳过|预览|sendback|发回|stop|结束|关闭|\d+(?:\s*[,，、\s]\s*\d+)*|改[:：\s]|修改[:：\s]|替换[:：\s])/i;

function hasAnyActiveInboxItem(bridge: OpenMausBotBridge): boolean {
  return Boolean(
    bridge.pendingCards.size
    || bridge.pendingSendBacks.size
    || bridge.privateDrafts.size
    || bridge.pendingFollowUps.size
    || bridge.delegations.pendingOutbound.size,
  );
}

/** 分配递增的收件箱短编号 `#1`, `#2`, ...；当收件箱完全清空时自动归零重启。 */
export function allocateInboxRef(bridge: OpenMausBotBridge): number {
  if (!hasAnyActiveInboxItem(bridge)) bridge.inboxSeq = 0;
  bridge.inboxSeq = Math.max(0, Number(bridge.inboxSeq) || 0) + 1;
  return bridge.inboxSeq;
}

/** 记录已处理或过期的短编号，便于迟到的 `#N 确认` 给出明确过期反馈而非静默忽略或误当笔记。 */
export function recordClosedInboxRef(bridge: OpenMausBotBridge, ref: number | undefined, label: string): void {
  const n = Number(ref);
  if (!Number.isInteger(n) || n <= 0) return;
  const now = bridge.now();
  for (const [k, v] of bridge.recentClosedInboxRefs) {
    if (!v || (now - v.at) > CLOSED_REF_TTL_MS) bridge.recentClosedInboxRefs.delete(k);
  }
  bridge.recentClosedInboxRefs.set(n, { label: clip(label || '待办事项', 36), at: now });
  trimMapCap(bridge.recentClosedInboxRefs, 60);
}

/** 为从旧状态文件恢复的在途对象补齐 `inboxRef` 并推进序号游标。 */
export function ensureInboxRefs(bridge: OpenMausBotBridge): void {
  let maxRef = Number(bridge.inboxSeq) || 0;
  const scanMax = (r: number | undefined) => {
    const n = Number(r);
    if (Number.isInteger(n) && n > maxRef) maxRef = n;
  };
  for (const c of bridge.pendingCards.values()) scanMax(c.inboxRef);
  for (const d of bridge.privateDrafts.values()) scanMax(d.inboxRef);
  for (const sb of bridge.pendingSendBacks.values()) {
    scanMax(sb.inboxRef);
    scanMax(sb.draft?.inboxRef);
  }
  for (const fp of bridge.pendingFollowUps.values()) scanMax(fp.inboxRef);
  for (const dl of bridge.delegations.pendingOutbound.values()) scanMax(dl.inboxRef);
  bridge.inboxSeq = maxRef;

  for (const c of bridge.pendingCards.values()) {
    if (!c.inboxRef) c.inboxRef = allocateInboxRef(bridge);
  }
  const seenDrafts = new Set<string>();
  for (const d of bridge.privateDrafts.values()) {
    if (!d?.id || seenDrafts.has(d.id)) continue;
    seenDrafts.add(d.id);
    if (!d.inboxRef) d.inboxRef = allocateInboxRef(bridge);
  }
  for (const sb of bridge.pendingSendBacks.values()) {
    if (!sb.inboxRef) {
      sb.inboxRef = sb.draft?.inboxRef ?? allocateInboxRef(bridge);
      if (sb.draft && !sb.draft.inboxRef) sb.draft.inboxRef = sb.inboxRef;
    }
  }
  for (const fp of bridge.pendingFollowUps.values()) {
    if (!fp.inboxRef) fp.inboxRef = allocateInboxRef(bridge);
  }
  for (const dl of bridge.delegations.pendingOutbound.values()) {
    if (!dl.inboxRef) dl.inboxRef = allocateInboxRef(bridge);
  }
}

/** 按各对象 TTL 统一清理过期在途事项，并记录已闭环编号以供迟到指令给出明确反馈。 */
export function pruneExpiredInboxItems(bridge: OpenMausBotBridge): boolean {
  const now = bridge.now();
  let changed = false;

  const cardTtl = Number(bridge.cardTtlMs) || 0;
  if (cardTtl > 0) {
    for (const [k, c] of bridge.pendingCards) {
      if (c?.createdAt && (now - c.createdAt) >= cardTtl) {
        recordClosedInboxRef(bridge, c.inboxRef, c.title || '审批/提问卡');
        bridge.pendingCards.delete(k);
        changed = true;
      }
    }
  }

  const draftTtl = Number(bridge.draftTtlMs) || 30 * 60_000;
  if (bridge.draftStore.pruneExpired(now, draftTtl, {
    onConfirmExpired: (d, conf) => {
      const ref = conf.inboxRef ?? d.inboxRef;
      recordClosedInboxRef(bridge, ref, `发回预览「${d.originChatName || d.originChatId || ''}」`);
      if (conf.imMsgId) bridge.expiredSendBackIds.set(conf.imMsgId, now);
      bridge.lastExpiredSendBackAt = now;
    },
    onDraftExpired: (d) => {
      recordClosedInboxRef(bridge, d.inboxRef, `私密草稿「${d.originChatName || d.originChatId}」`);
    },
  })) {
    changed = true;
  }
  for (const [mid, at] of bridge.expiredSendBackIds) {
    if ((now - at) > CLOSED_REF_TTL_MS) bridge.expiredSendBackIds.delete(mid);
  }
  trimMapCap(bridge.expiredSendBackIds, 40);

  for (const [k, fp] of bridge.pendingFollowUps) {
    if (!fp || fp.expiresAt <= now) {
      if (fp) recordClosedInboxRef(bridge, fp.inboxRef, `追问 @${fp.targetName}`);
      bridge.pendingFollowUps.delete(k);
      changed = true;
    }
  }

  const expiredDelegations = bridge.delegations.pruneExpired(DELEGATION_TTL_MS);
  if (expiredDelegations > 0) changed = true;

  for (const [k, v] of bridge.recentClosedInboxRefs) {
    if (!v || (now - v.at) > CLOSED_REF_TTL_MS) bridge.recentClosedInboxRefs.delete(k);
  }
  pruneExpiredQueues(bridge);
  return changed;
}

/** 汇总所有在途协调事项（审批卡、待发回确认、未处理草稿、待回追问、C2C 委托）。 */
export function getCoordinatorInbox(bridge: OpenMausBotBridge): CoordinatorInboxSummary {
  const dirty = pruneExpiredInboxItems(bridge);
  if (dirty) bridge.saveState();
  const now = bridge.now();

  const cards = [...bridge.pendingCards.values()].map((c) => ({
    ref: c.inboxRef,
    imMsgId: c.imMsgId,
    title: c.title || '待确认操作',
    botName: bridge.displayBotName(c.botId, c.botName, { isGroup: Boolean(c.isGroup) }),
    kind: c.cardKind || 'card',
  }));

  const sendBacks: CoordinatorInboxSummary['sendBacks'] = [];
  const sbDraftIds = new Set<string>();
  for (const [k, v] of bridge.pendingSendBacks) {
    const did = v.draft?.id || k;
    sbDraftIds.add(did);
    sendBacks.push({
      ref: v.inboxRef ?? v.draft?.inboxRef,
      id: k,
      imMsgId: v.imMsgId ?? null,
      originName: v.draft?.originChatName || v.draft?.originChatId || '',
      preview: clip(v.text.replace(/\s+/g, ' '), 40),
      isFollowUp: Boolean(v.draft?.followUp),
      expiresAt: v.expiresAt,
    });
  }

  const drafts: CoordinatorInboxSummary['drafts'] = [];
  const seenDrafts = new Set<string>();
  for (const d of bridge.privateDrafts.values()) {
    if (!d?.id || seenDrafts.has(d.id)) continue;
    seenDrafts.add(d.id);
    if (sbDraftIds.has(d.id)) continue;
    drafts.push({
      ref: d.inboxRef,
      id: d.id,
      imMsgId: d.imMsgId ?? null,
      originName: d.originChatName || d.originChatId,
      preview: clip(d.rawText.replace(/\s+/g, ' '), 40),
      createdAt: d.createdAt,
    });
  }

  const followUps: CoordinatorInboxSummary['followUps'] = [];
  for (const fp of bridge.pendingFollowUps.values()) {
    followUps.push({
      ref: fp.inboxRef,
      id: fp.id,
      chatName: fp.chatName || fp.chatId,
      targetName: fp.targetName,
      question: clip(fp.question.replace(/\s+/g, ' '), 40),
      createdAt: fp.createdAt || now,
      expiresAt: fp.expiresAt,
    });
  }

  const delegations = [...bridge.delegations.pendingOutbound.values()].map((d) => ({
    ref: d.inboxRef,
    id: d.id,
    chatName: d.targetChatName || d.targetChatId,
    ...(d.project ? { project: d.project } : {}),
    question: clip((d.question || '').replace(/\s+/g, ' '), 40),
    createdAt: d.createdAt || now,
  }));

  const total = cards.length + sendBacks.length + drafts.length + followUps.length + delegations.length;
  return { cards, sendBacks, drafts, followUps, delegations, total };
}

export function formatCoordinatorInboxLines(inbox: CoordinatorInboxSummary): string[] {
  const LIMIT = 6;
  const tag = (ref?: number) => (ref ? `\`#${ref}\` ` : '');
  const lines: string[] = [];
  let omitted = 0;
  for (const c of inbox.cards.slice(0, LIMIT)) {
    lines.push(`- ${tag(c.ref)}⏸️ 审批/提问：**${c.botName}** · ${c.title}`);
  }
  omitted += Math.max(0, inbox.cards.length - LIMIT);
  for (const sb of inbox.sendBacks.slice(0, LIMIT)) {
    lines.push(`- ${tag(sb.ref)}📤 待确认发回「${sb.originName}」：${sb.preview}`);
  }
  omitted += Math.max(0, inbox.sendBacks.length - LIMIT);
  for (const d of inbox.drafts.slice(0, LIMIT)) {
    lines.push(`- ${tag(d.ref)}📝 私密草稿「${d.originName}」（\`${d.id}\`）：${d.preview}`);
  }
  omitted += Math.max(0, inbox.drafts.length - LIMIT);
  for (const fp of inbox.followUps.slice(0, LIMIT)) {
    lines.push(`- ${tag(fp.ref)}💬 等「${fp.chatName}」@${fp.targetName} 回复：${fp.question}`);
  }
  omitted += Math.max(0, inbox.followUps.length - LIMIT);
  for (const dl of inbox.delegations.slice(0, LIMIT)) {
    lines.push(`- ${tag(dl.ref)}🤝 C2C 委托「${dl.chatName}」（\`${dl.id}\`）：${dl.question || '处理中'}`);
  }
  omitted += Math.max(0, inbox.delegations.length - LIMIT);
  if (omitted > 0) {
    lines.push(`- … 另有 ${omitted} 项未展开（发 \`#编号 ...\` 或看 \`/debug\`）`);
  }
  if (lines.length > 0) {
    lines.push('💡 快捷操作：`#编号 1/0/确认/取消` 或 `#编号 改：<新内容>`');
  }
  return lines;
}

/** 取消等待中的 `@同事` 追问并释放对应短编号。 */
export async function cancelFollowUp(bridge: OpenMausBotBridge, refOrId: string | number): Promise<string | null> {
  const raw = String(refOrId ?? '').trim().replace(/^#/, '');
  const refNum = /^\d+$/.test(raw) ? Number(raw) : null;
  let hitKey: string | null = null;
  let hitFp = null;
  for (const [k, fp] of bridge.pendingFollowUps) {
    if (k === raw || fp.id === raw || (refNum !== null && fp.inboxRef === refNum)) {
      hitKey = k;
      hitFp = fp;
      break;
    }
  }
  if (!hitKey || !hitFp) return bridge.say('当前未找到匹配的待回追问。');
  bridge.pendingFollowUps.delete(hitKey);
  recordClosedInboxRef(bridge, hitFp.inboxRef, `追问 @${hitFp.targetName}`);
  bridge.saveState();
  return bridge.say(`❎ 已取消等待「${hitFp.chatName || hitFp.chatId}」@${hitFp.targetName} 的追问（\`#${hitFp.inboxRef ?? hitFp.id}\`）。`);
}

/** 取消在途 C2C 委托追踪并释放对应短编号（已发出的 IM 消息保持现状）。 */
export async function cancelOutboundDelegation(bridge: OpenMausBotBridge, refOrId: string | number): Promise<string | null> {
  const removed = bridge.delegations.cancelOutbound(refOrId);
  if (!removed) return bridge.say('当前未找到匹配的在途协作委托。');
  recordClosedInboxRef(bridge, removed.inboxRef, `C2C 委托「${removed.targetChatName || removed.targetChatId}」`);
  bridge.saveState();
  return bridge.say(`❎ 已取消协作委托 \`#${removed.inboxRef ?? removed.id}\`（\`${removed.id}\`）。`);
}

function isOmbCardMessageResolved(msg: OmbMessage | undefined): boolean {
  if (!msg) return false;
  if (msg.card && (msg.card.answered || msg.card.dismissed || msg.card.expired)) return true;
  if (msg.burst && ['running', 'merging', 'done', 'cancelled', 'failed'].includes(String(msg.burst.phase || ''))) {
    return true;
  }
  if (msg.secret && (msg.secret.provided || msg.secret.dismissed || msg.secret.superseded)) return true;
  if (msg.connector && (msg.connector.dismissed || msg.connector.resumed || msg.connector.status === 'connected')) {
    return true;
  }
  if (msg.signIn && (msg.signIn.done || msg.signIn.cancelled || msg.signIn.superseded || msg.signIn.answeredInChat)) {
    return true;
  }
  return false;
}

/** 启动时向 OpenMausBot 对账持久化卡片状态，自动移除已在桌面端处理或过期的僵尸卡片。 */
export async function reconcilePendingCards(bridge: OpenMausBotBridge): Promise<number> {
  if (!bridge.pendingCards.size || typeof bridge.client?.getMessages !== 'function') return 0;
  const threadIds = new Set<string>();
  for (const c of bridge.pendingCards.values()) {
    if (c?.threadId) threadIds.add(c.threadId);
  }
  const msgById = new Map<string, OmbMessage>();
  const msgByReqId = new Map<string, OmbMessage>();
  const msgByBurstId = new Map<string, OmbMessage>();
  const countByThread = new Map<string, number>();
  const jobByThread = new Map<string, { state?: string; needsInput?: unknown[]; conversation?: unknown } | null>();
  for (const tid of threadIds) {
    try {
      const res = await bridge.client.getMessages(tid, 50);
      const msgs = res?.messages ?? [];
      countByThread.set(tid, msgs.length);
      for (const m of msgs) {
        if (m.id) msgById.set(m.id, m);
        if (m.card?.requestId) msgByReqId.set(m.card.requestId, m);
        if (m.burst?.burstId) msgByBurstId.set(m.burst.burstId, m);
      }
    } catch { /* 对账失败时保留本地卡片由人工响应时再清理 */ }
    if (typeof bridge.client?.getJob === 'function') {
      try {
        const job = await bridge.client.getJob(tid, { scope: 'turn' });
        if (job) jobByThread.set(tid, job as { state?: string; needsInput?: unknown[]; conversation?: unknown });
      } catch { /* ignore */ }
    }
  }
  let removed = 0;
  for (const [k, card] of bridge.pendingCards) {
    const matched = (card.ombMsgId ? msgById.get(card.ombMsgId) : undefined)
      ?? (card.requestId ? msgByReqId.get(card.requestId) : undefined)
      ?? (card.burstId ? msgByBurstId.get(card.burstId) : undefined);
    const job = jobByThread.get(card.threadId);
    const jobIdle = Boolean(
      job
      && ['idle', 'completed', 'failed'].includes(String(job.state || ''))
      && (!Array.isArray(job.needsInput) || job.needsInput.length === 0),
    );
    const missingButScrolledIdle = Boolean(
      !matched
      && jobIdle
      && (card.cardKind === 'burst' || (countByThread.get(card.threadId) ?? 0) >= 50 || Boolean(job?.conversation)),
    );
    if (isOmbCardMessageResolved(matched) || (matched && jobIdle) || missingButScrolledIdle) {
      recordClosedInboxRef(bridge, card.inboxRef, card.title || '审批/提问卡');
      bridge.pendingCards.delete(k);
      if (card.requestId) bridge.deliveredCards.delete(card.requestId);
      if (card.burstId) bridge.deliveredCards.delete(`burst:${card.burstId}`);
      if (card.ombMsgId) bridge.deliveredCards.delete(card.ombMsgId);
      removed += 1;
    }
  }
  if (removed > 0) bridge.saveState();
  return removed;
}

/** 当多类或多条待办同时激活导致裸回复语义碰撞时，输出精确的 `#编号` 消歧指引。 */
export async function replyDisambiguationHint(
  bridge: OpenMausBotBridge,
  reason: 'multi_sendback' | 'sendback_card_collision' | 'task_card_collision' | 'multi_card',
): Promise<string | null> {
  const lines: string[] = [];
  for (const sb of bridge.pendingSendBacks.values()) {
    const ref = sb.inboxRef ?? sb.draft?.inboxRef;
    const tag = ref ? `\`#${ref}\` ` : '';
    lines.push(`- ${tag}📤 待发回「${sb.draft?.originChatName || sb.draft?.originChatId || ''}」：${clip(sb.text.replace(/\s+/g, ' '), 36)}`);
  }
  for (const c of bridge.pendingCards.values()) {
    const tag = c.inboxRef ? `\`#${c.inboxRef}\` ` : '';
    const who = bridge.displayBotName(c.botId, c.botName, { isGroup: Boolean(c.isGroup) });
    lines.push(`- ${tag}⏸️ 审批/提问：**${who}** · ${clip(c.title || '待确认操作', 36)}`);
  }
  if (bridge.pendingTaskPick && bridge.now() < bridge.pendingTaskPick.expiresAt) {
    lines.push(`- 🗂 待切换会话（**${bridge.pendingTaskPick.botName}**，共 ${bridge.pendingTaskPick.tasks.length} 项）`);
  }
  const titleMap: Record<typeof reason, string> = {
    multi_sendback: '⚠️ 当前有多个待确认发回草稿，请指定编号或引用对应气泡：',
    sendback_card_collision: '⚠️ 当前同时有**待发回草稿**与**待处理审批卡**，为防误操作已暂停裸回复：',
    task_card_collision: '⚠️ 当前同时有**待选会话列表**与**待处理审批卡**，为防误操作已暂停裸数字：',
    multi_card: '⚠️ 当前有多张待处理审批/提问卡，请指定编号或引用对应气泡：',
  };
  return bridge.say(`${titleMap[reason]}\n${lines.join('\n')}\n\n👉 回复 \`#编号 确认/取消/1/0\`（例如 \`#1 确认\`），或引用对应消息气泡回复。`);
}

/** 解析 `#N` 或 `draft_xxx` 到唯一草稿或待发回预览 ID。 */
export function resolveInboxDraftOrSendBackRef(
  bridge: OpenMausBotBridge,
  rawRef: unknown,
): { kind: 'sendback' | 'draft'; id: string } | null {
  const raw = String(rawRef ?? '').trim();
  const numM = raw.match(/^#?(\d+)$/);
  if (numM) {
    const targetRef = Number(numM[1]);
    for (const [k, sb] of bridge.pendingSendBacks) {
      if ((sb.inboxRef ?? sb.draft?.inboxRef) === targetRef) return { kind: 'sendback', id: k };
    }
    for (const d of bridge.privateDrafts.values()) {
      if (d?.inboxRef === targetRef) return { kind: 'draft', id: d.id };
    }
    return null;
  }
  if (bridge.pendingSendBacks.has(raw)) return { kind: 'sendback', id: raw };
  if (bridge.privateDrafts.has(raw)) {
    const d = bridge.privateDrafts.get(raw)!;
    return { kind: 'draft', id: d.id };
  }
  return null;
}

function findActiveByRef(bridge: OpenMausBotBridge, targetRef: number): (
  | { kind: 'sendback'; key: string; entry: PendingSendBack }
  | { kind: 'card'; card: PendingCard }
  | { kind: 'draft'; draft: PrivateDraft }
  | { kind: 'followUp'; id: string; chatName: string; targetName: string }
  | { kind: 'delegation'; id: string; chatName: string }
  | null
) {
  for (const [k, sb] of bridge.pendingSendBacks) {
    if ((sb.inboxRef ?? sb.draft?.inboxRef) === targetRef) return { kind: 'sendback', key: k, entry: sb };
  }
  for (const c of bridge.pendingCards.values()) {
    if (c.inboxRef === targetRef) return { kind: 'card', card: c };
  }
  for (const d of bridge.privateDrafts.values()) {
    if (d?.inboxRef === targetRef) return { kind: 'draft', draft: d };
  }
  for (const [k, fp] of bridge.pendingFollowUps) {
    if (fp.inboxRef === targetRef) {
      return { kind: 'followUp', id: k, chatName: fp.chatName || fp.chatId, targetName: fp.targetName };
    }
  }
  for (const dl of bridge.delegations.pendingOutbound.values()) {
    if (dl.inboxRef === targetRef) {
      return { kind: 'delegation', id: dl.id, chatName: dl.targetChatName || dl.targetChatId };
    }
  }
  return null;
}

/** 处理自聊中按短编号 `#N <动作>` 直接消项（支持卡、发回、草稿、追问与委托）。 */
export async function handleInboxRefAction(
  bridge: OpenMausBotBridge,
  rawText: string,
  { handleCardReply, explicitCommand = false }: {
    handleCardReply: (card: PendingCard, isQuoted: boolean, inputText: string) => Promise<unknown> | null;
    explicitCommand?: boolean;
  },
): Promise<boolean> {
  const m = String(rawText ?? '').trim().match(/^#(\d+)(?:\s+([\s\S]+))?$/);
  if (!m) return false;
  pruneExpiredInboxItems(bridge);
  const targetRef = Number(m[1]);
  const arg = (m[2] ?? '').trim();
  const hit = findActiveByRef(bridge, targetRef);

  if (!hit) {
    const closed = bridge.recentClosedInboxRefs.get(targetRef);
    if (closed && (bridge.now() - closed.at) <= CLOSED_REF_TTL_MS && CLOSED_ACTION_RE.test(arg)) {
      await bridge.say(`⌛ \`#${targetRef}\`（${closed.label}）已处理或已过期。`);
      return true;
    }
    return false;
  }

  if (hit.kind === 'card') {
    if (!arg) {
      await bridge.say(`⏸️ \`#${targetRef}\` 待处理：**${clip(hit.card.title || '待确认操作', 48)}**，请回复 \`#${targetRef} 1\` / \`#${targetRef} 0\`${hit.card.isQuestion ? ' 或 `#编号 答：<内容>`' : ''}。`);
      return true;
    }
    if (!hit.card.isQuestion) {
      const res = handleCardReply(hit.card, false, arg);
      if (res) {
        await res;
        return true;
      }
      if (!explicitCommand) return false;
      await bridge.say(`ℹ️ 无法识别对 \`#${targetRef}\` 的操作「${clip(arg, 24)}」，请回复 \`#${targetRef} 1\`、\`#${targetRef} 0\` 或 \`#${targetRef} 2\``);
      return true;
    }
    const ansM = arg.match(ANSWER_PREFIX_RE);
    const effectiveArg = ansM ? ansM[1].trim() : arg;
    const curQ = hit.card.questions?.[hit.card.questionIndex ?? 0];
    const curOpts = curQ?.options ?? hit.card.options ?? [];
    const pickedChoice = parseMultiChoiceAnswer(effectiveArg, curOpts, Boolean(curQ?.multiSelect));
    if (ansM || CANCEL_RE.test(effectiveArg) || /^0$/.test(effectiveArg) || pickedChoice !== null || explicitCommand) {
      const res = handleCardReply(hit.card, true, effectiveArg);
      if (res) {
        await res;
        return true;
      }
    }
    return false;
  }

  if (hit.kind === 'sendback') {
    if (!arg) {
      await bridge.say(`📤 \`#${targetRef}\` 待确认发回「${hit.entry.draft?.originChatName || ''}」：请回复 \`#${targetRef} 确认\`、\`#${targetRef} 改：<新内容>\` 或 \`#${targetRef} 取消\``);
      return true;
    }
    if (CONFIRM_RE.test(arg)) {
      await confirmSendBack(bridge, hit.key);
      return true;
    }
    if (CANCEL_RE.test(arg)) {
      await cancelSendBack(bridge, hit.key, { discardDraft: true });
      return true;
    }
    const editM = arg.match(EDIT_RE);
    if (editM && editM[1].trim()) {
      await requestSendBack(bridge, hit.entry.draft, editM[1].trim());
      return true;
    }
    return false;
  }

  if (hit.kind === 'draft') {
    if (!arg || PREVIEW_RE.test(arg)) {
      await requestSendBack(bridge, hit.draft);
      return true;
    }
    if (CONFIRM_RE.test(arg)) {
      await confirmDraftDirect(bridge, hit.draft);
      return true;
    }
    if (CANCEL_RE.test(arg)) {
      await discardPrivateDraft(bridge, hit.draft);
      return true;
    }
    const editM = arg.match(EDIT_RE);
    if (editM && editM[1].trim()) {
      await requestSendBack(bridge, hit.draft, editM[1].trim());
      return true;
    }
    return false;
  }

  if (hit.kind === 'followUp') {
    if (!arg) {
      await bridge.say(`💬 \`#${targetRef}\` 正在等待「${hit.chatName}」@${hit.targetName} 回复；发 \`#${targetRef} 取消\` 可结束等待。`);
      return true;
    }
    if (CANCEL_RE.test(arg)) {
      await cancelFollowUp(bridge, targetRef);
      return true;
    }
    return false;
  }

  if (hit.kind === 'delegation') {
    if (!arg) {
      await bridge.say(`🤝 \`#${targetRef}\` C2C 委托「${hit.chatName}」（\`${hit.id}\`）处理中；发 \`#${targetRef} 取消\` 可取消本地追踪。`);
      return true;
    }
    if (CANCEL_RE.test(arg)) {
      await cancelOutboundDelegation(bridge, targetRef);
      return true;
    }
    return false;
  }

  return false;
}
