import path from 'node:path';
import { defaults } from '../config.ts';
import { ChatContextStore } from '../core/chat-context.ts';
import type { CommandRegistry } from '../core/extensions.ts';
import { normalizeCollaborators } from '../core/inbound-policy.ts';
import { normalizeProjectsConfig } from '../core/projects.ts';
import { SharedContextManager } from '../core/shared-context.ts';
import { clip } from '../format.ts';
import type {
  ChannelAction, ChannelCapabilities, ChatType, ChatsConfig, ChatsMode,
  InboundAttachment, InboundEvent, ProjectConfig, ProjectRef, QuietHoursConfig, TelemetryEvent,
} from '../types.ts';
import { buildBridgeStatus, startBridgeLifecycle, stopBridgeLifecycle, syncBridgeQuietTimer } from './bridge-lifecycle.ts';
import { extractCardInfo } from './cards.ts';
import {
  buildExternalSummaryPrompt, cancelSendBack, checkPendingReminders, compactExternalChat,
  confirmSendBack, getChatPolicy, getCoordinatorInbox, listKnownChats, requestSendBack,
  resolveKnownChat, resolvePrivateDraft,
} from './chat-manager.ts';
import { type OpenMausBotClient } from './client.ts';
import { DelegationTracker } from './delegation.ts';
import { DraftStore } from './draft-store.ts';
import { BridgeMessageCache } from './message-cache.ts';
import {
  deliverBotReply, emitCard, flushQuietDigest, forwardBotMedia,
  maybeWarnHighContext, sendOutboundFile, type SendOutboundFileOpts,
} from './delivery.ts';
import {
  cancelLatestQueue, cancelThreadQueue, collectBotTasks, dispatchSteerSupplement,
  dispatchToBot, steerLatestQueue, switchTask,
} from './dispatch.ts';
import { handleInboundEvent, sendDelegation } from './inbound-router.ts';
import { inQuietHours, trimMapCap } from './mentions.ts';
import {
  drainOutboundQueue, flushOutboundBuffer as flushOutboundQueueBuffer,
  isTransportDisconnected, sendBridgeText, type SendTextExtra,
} from './outbound-queue.ts';
import { flushBridgeState, loadBridgeState, pruneBridgeMemoryCaches, saveBridgeState } from './state-store.ts';
import {
  ensureChatThread, getChatThread, refreshMultiBot,
  resolveOwnerByThread, resolveSelfBotThread, setChatThread, setSelfThread, syncChiefBotIdentity,
} from './thread-manager.ts';
import { createTurnTracker } from './turn-tracker.ts';
import type {
  ActiveBurstWatch, BridgeChatContext, BridgeFocus, BridgeOptions, BridgeTransport, ChatThreadEntry,
  CompactChatContext, FileMsgEntry, ImContextService, InFlightTurnMeta, KnownChatSummary,
  MsgRoute, OmbBot, OmbGroup, OmbHttpError, OmbTargetBot, OmbTaskSummary, OutboundBufferItem,
  PendingCard, PendingFollowUp, PendingSendBack, PendingTaskPick, PrivateDraft, QueuedTurnEntry,
  QuietQueueItem, TurnTrackerHandle,
} from './types.ts';

export { extractCardInfo, inQuietHours };

/**
 * 极薄 IM <-> OpenMausBot 桥接器（co-bot / Coordinator Bot 手机端协调助手体验）：
 *   - 主 Bot 1v1 干净私聊（默认省略名字前缀）、多 Bot 自由 @<BotName> 协同
 *   - 连续对话短时粘性（followUpWindowMs）+ 连续纯发图防抖合批 + 笔记前缀保护
 *   - 中间口语即时流式上屏 + 中文工具进度去噪 + 适中长回复软拆分两段
 *   - 审批卡（ok / always / no）与选项/提问卡（1 / 2 / 3）快捷交互 + 模拟器按钮
 *   - 出站安全脱敏门禁、外部协作白名单策略、项目绑定与 2 态 C2C 委托
 */
export class OpenMausBotBridge {
  client: OpenMausBotClient;
  transport: BridgeTransport;
  dataDir?: string;
  trigger: string;
  botName: string;
  syncChiefIdentity: boolean;
  chiefIdentitySynced = false;
  syncingChiefPromise: Promise<boolean> | null = null;
  commandDevices: string[];
  proactive: boolean;
  quietHours: QuietHoursConfig;
  progressDelayMs: number;
  progressIntervalMs: number;
  maxProgressUpdates: number;
  intermediateCoalesceMs: number;
  maxIntermediateBubbles: number;
  turnStallMs: number;
  turnTimeoutMs: number;
  stateSaveDebounceMs: number;
  draftTtlMs: number;
  cardTtlMs: number;
  queueTtlMs: number;
  botListCacheTtlMs: number;
  followUpRemindMs: number;
  delegationRemindMs: number;
  mutedHintCooldownMs: number;
  outboundBufferMax: number;
  outboundBufferTtlMs: number;
  resultChars: number;
  softSplitChars: number;
  followUpWindowMs: number;
  hideChiefPrefix: boolean;
  imageBatchMs: number;
  fileRetentionDays: number;
  sendRetries: number;
  sendRetryDelayMs: number;
  autoHealOmb: (() => unknown) | null;
  autoHealCooldownMs: number;
  onTelemetry: ((event: TelemetryEvent) => void) | null;
  markdown: boolean;
  outPrefix: string;
  imContext: ImContextService | null;
  transcribeAudio: ((filePath: string, att: InboundAttachment) => Promise<string | null | undefined>) | null;
  commandRegistry: CommandRegistry | null;
  now: () => number;
  chats: ChatsConfig;
  projects: ProjectConfig[];
  chatProjects = new Map<string, ProjectRef>();
  sharedContext: SharedContextManager;
  delegations: DelegationTracker;
  securityRedactions = 0;
  policyDenials = 0;
  localContextStore: ChatContextStore;
  learnedSelfChatId = '';
  warnedMissingSelfChat = false;
  inDir: string;
  stateFile: string | null;
  msgCache: BridgeMessageCache;
  pendingCards = new Map<string, PendingCard>();
  activeTurns = new Map<string, TurnTrackerHandle>();
  activeBursts = new Map<string, ActiveBurstWatch>();
  pendingThreads = new Set<string>();
  queuedByThread = new Map<string, QueuedTurnEntry[]>();
  steeredQueue = new Map<string, QueuedTurnEntry>();
  pendingTaskPick: PendingTaskPick | null = null;
  pendingMediaIds: string[] = [];
  pendingMediaTimer: ReturnType<typeof setTimeout> | null = null;
  pendingMediaTarget: OmbTargetBot | null = null;
  contextWarnedThreads = new Set<string>();
  threadInjectedScope = new Map<string, string>();
  lastAutoCompactAt = new Map<string, number>();
  draftStore: DraftStore;
  lastPrivateDraftId: string | null = null;
  inboxSeq = 0;
  recentClosedInboxRefs = new Map<number, { label: string; at: number }>();
  expiredSendBackIds = new Map<string, number>();
  lastExpiredSendBackAt = 0;
  lastMutedHintAt = new Map<string, number>();
  pendingFollowUps = new Map<string, PendingFollowUp>();
  inFlightTurns = new Map<string, InFlightTurnMeta>();
  pendingChatThreads = new Map<string, Promise<OmbTargetBot>>();
  outboundQueue = new Map<string, Promise<unknown>>();
  disconnectedBuffer: OutboundBufferItem[] = [];
  stateSaveTimer: ReturnType<typeof setTimeout> | null = null;
  startedAt: number;
  sseReconnects = 0;
  outboundFailures = 0;
  outboundReplayed = 0;
  stateSaveErrors = 0;
  stateCorruptRecoveries = 0;
  botById = new Map<string, OmbBot>();
  botByThread = new Map<string, OmbTargetBot>();
  groupById = new Map<string, OmbGroup>();
  groupByThread = new Map<string, OmbTargetBot>();
  chiefBotId: string | null = null;
  lastBotReplyAt = 0;
  lastByeAt = 0;
  quietQueue: QuietQueueItem[] = [];
  quietTimer: ReturnType<typeof setInterval> | null = null;
  cleanupTimer: ReturnType<typeof setInterval> | null = null;
  reminderTimer: ReturnType<typeof setInterval> | null = null;
  focus: BridgeFocus | null = null;
  chatThreads = new Map<string, ChatThreadEntry>();
  selfThreads = new Map<string, BridgeFocus>();
  externalThreadIds = new Set<string>();
  externalChatMeta = new Map<string, { id: string; type: ChatType; name?: string }>();
  chatPolicyOverrides: { mode: ChatsMode | null; muted: Set<string>; allowed: Set<string> } = {
    mode: null,
    muted: new Set(),
    allowed: new Set(),
  };
  sseAc: AbortController | null = null;
  sseTask: Promise<void> | null = null;
  sseConnected = false;
  sseAuthError: string | null = null;
  consecutiveSseErrors = 0;
  lastAutoHealAt = 0;
  multiBotCache: boolean | null = null;
  botListCache: { at: number; bots: OmbBot[]; groups: OmbGroup[] } | null = null;

  constructor({
    client,
    transport,
    dataDir,
    trigger = '@bot',
    botName = 'co-bot',
    syncChiefIdentity = false,
    commandDevices = [],
    proactive = true,
    quietHours = { enabled: false, start: '22:00', end: '08:30' },
    progressDelayMs = 12_000,
    progressIntervalMs = 25_000,
    maxProgressUpdates = 2,
    intermediateCoalesceMs = 700,
    maxIntermediateBubbles = 2,
    turnStallMs = 180_000,
    turnTimeoutMs = 600_000,
    stateSaveDebounceMs = 150,
    draftTtlMs = 30 * 60_000,
    cardTtlMs = 30 * 60_000,
    queueTtlMs = 30 * 60_000,
    botListCacheTtlMs = 3000,
    followUpRemindMs = 15 * 60_000,
    delegationRemindMs = 30 * 60_000,
    mutedHintCooldownMs = 10 * 60_000,
    outboundBufferMax = 30,
    outboundBufferTtlMs = 5 * 60_000,
    resultChars = 1500,
    softSplitChars,
    followUpWindowMs = 120_000,
    hideChiefPrefix = false,
    imageBatchMs = 1500,
    fileRetentionDays = 7,
    sendRetries = 2,
    sendRetryDelayMs = 400,
    autoHealOmb = null,
    autoHealCooldownMs = 30_000,
    onTelemetry = null,
    markdown = true,
    outPrefix = '',
    imContext = null,
    chats = {},
    projects = [],
    sharedContextDir = '',
    sharedContextPullIntervalMs = 300_000,
    execGit = null,
    transcribeAudio = null,
    commandRegistry = null,
    now = () => Date.now(),
  }: BridgeOptions) {
    this.client = client;
    this.transport = transport;
    this.dataDir = dataDir;
    this.trigger = trigger;
    this.botName = String(botName || 'co-bot').trim() || 'co-bot';
    this.syncChiefIdentity = Boolean(syncChiefIdentity);
    this.commandDevices = commandDevices;
    this.proactive = proactive;
    this.quietHours = quietHours;
    this.progressDelayMs = progressDelayMs;
    this.progressIntervalMs = progressIntervalMs;
    this.maxProgressUpdates = maxProgressUpdates;
    this.intermediateCoalesceMs = intermediateCoalesceMs;
    this.maxIntermediateBubbles = maxIntermediateBubbles;
    this.turnStallMs = turnStallMs;
    this.turnTimeoutMs = turnTimeoutMs;
    this.stateSaveDebounceMs = stateSaveDebounceMs;
    this.draftTtlMs = draftTtlMs;
    this.cardTtlMs = cardTtlMs;
    this.queueTtlMs = queueTtlMs;
    this.botListCacheTtlMs = botListCacheTtlMs;
    this.followUpRemindMs = followUpRemindMs;
    this.delegationRemindMs = delegationRemindMs;
    this.mutedHintCooldownMs = mutedHintCooldownMs;
    this.outboundBufferMax = outboundBufferMax;
    this.outboundBufferTtlMs = outboundBufferTtlMs;
    this.resultChars = resultChars;
    this.softSplitChars = softSplitChars !== undefined
      ? Number(softSplitChars)
      : (this.resultChars >= 1000 ? 2800 : this.resultChars);
    this.followUpWindowMs = followUpWindowMs;
    this.hideChiefPrefix = hideChiefPrefix;
    this.imageBatchMs = imageBatchMs;
    this.fileRetentionDays = fileRetentionDays;
    this.sendRetries = sendRetries;
    this.sendRetryDelayMs = sendRetryDelayMs;
    this.autoHealOmb = autoHealOmb;
    this.autoHealCooldownMs = autoHealCooldownMs;
    this.onTelemetry = onTelemetry;
    this.markdown = markdown;
    this.outPrefix = outPrefix;
    this.imContext = imContext;
    this.transcribeAudio = transcribeAudio;
    this.commandRegistry = commandRegistry;
    this.now = now;
    this.chats = {
      ...defaults.chats,
      ...(chats && typeof chats === 'object' ? chats : {}),
    };
    this.chats.collaborators = normalizeCollaborators(this.chats.collaborators);
    const projectBaseDir = dataDir ? path.dirname(path.resolve(dataDir)) : process.cwd();
    this.projects = normalizeProjectsConfig(projects, projectBaseDir);
    this.sharedContext = new SharedContextManager({
      dir: sharedContextDir,
      pullIntervalMs: sharedContextPullIntervalMs,
      now: () => this.now(),
      execGit,
      onTelemetry: (type, p) => this.emitTelemetry(type, p),
    });
    this.delegations = new DelegationTracker({ now: () => this.now() });
    this.draftStore = new DraftStore(() => this.now());
    this.msgCache = new BridgeMessageCache(() => this.now());
    this.localContextStore = imContext?.store ?? new ChatContextStore({
      maxPerChat: this.chats.contextMaxMessagesPerChat,
      ttlMs: this.chats.contextTtlMs,
      now: () => this.now(),
    });
    this.inDir = path.join(dataDir || '.', 'omb-files');
    this.stateFile = dataDir ? path.join(dataDir, 'bridge-state.json') : null;
    this.startedAt = this.now();
    this.#loadState();
  }

  get selfChat(): string {
    return this.transport?.selfChatId || this.learnedSelfChatId || '';
  }

  get selfUserId(): string {
    return String(this.transport?.selfId || '').trim();
  }

  resolveChatType(chatId: string | null | undefined): ChatType | undefined {
    const cid = String(chatId ?? '').trim();
    if (!cid) return undefined;
    if (this.selfChat && cid === this.selfChat) return 'self';
    const ext = this.externalChatMeta.get(cid);
    if (ext?.type) return ext.type;
    const meta = this.imContext?.store?.getChatMeta(cid) ?? this.localContextStore.getChatMeta(cid);
    if (meta?.type) return meta.type;
    for (const entry of this.chatThreads.values()) {
      if (entry.chatId === cid && entry.chatType) return entry.chatType;
    }
    return undefined;
  }

  #loadState(): void { loadBridgeState(this); }
  saveState(opts?: { immediate?: boolean }): void { saveBridgeState(this, opts); }
  flushState(): void { flushBridgeState(this); }
  pruneMemoryCaches(): void { pruneBridgeMemoryCaches(this); }

  get ownIds() { return this.msgCache.ownIds; }
  get ownReqIds() { return this.msgCache.ownReqIds; }
  get deliveredOmbIds() { return this.msgCache.deliveredOmbIds; }
  get deliveredCards() { return this.msgCache.deliveredCards; }
  get deliveredMedia() { return this.msgCache.deliveredMedia; }
  get pendingOutFiles() { return this.msgCache.pendingOutFiles; }
  get recent() { return this.msgCache.recent; }
  get seen() { return this.msgCache.seen; }
  get fileMsgs() { return this.msgCache.fileMsgs; }
  get msgRoute() { return this.msgCache.msgRoute; }

  syncQuietTimer(): void {
    syncBridgeQuietTimer(this);
    if (!this.quietHours?.enabled && this.quietQueue.length) {
      this.flushQuietDigest().catch(() => {});
    }
  }

  rememberOwnId(id: unknown, chatId?: string | null): void { this.msgCache.rememberOwnId(id, chatId); }
  isOwnId(chatId: string | null | undefined, msgId: string | null | undefined): boolean { return this.msgCache.isOwnId(chatId, msgId); }
  hasSeenMsg(chatId: string | null | undefined, msgId: string | null | undefined): boolean { return this.msgCache.hasSeenMsg(chatId, msgId); }
  markSeenMsg(chatId: string | null | undefined, msgId: string | null | undefined): void { this.msgCache.markSeenMsg(chatId, msgId); }
  setMsgRoute(chatId: string | null | undefined, msgId: string | null | undefined, route: MsgRoute): void { this.msgCache.setMsgRoute(chatId, msgId, route); }
  getMsgRoute(chatId: string | null | undefined, msgId: string | null | undefined): MsgRoute | null { return this.msgCache.getMsgRoute(chatId, msgId); }
  deleteMsgRoute(chatId: string | null | undefined, msgId: string | null | undefined): void { this.msgCache.deleteMsgRoute(chatId, msgId); }
  setFileMsg(chatId: string, msgId: string, atts: InboundAttachment[]): void { this.msgCache.setFileMsg(chatId, msgId, atts); }
  getFileMsg(chatId: string | null | undefined, msgId: string | null | undefined): { key: string; entry: FileMsgEntry } | null { return this.msgCache.getFileMsg(chatId, msgId); }
  deleteFileMsg(chatId: string | null | undefined, msgId: string | null | undefined): void { this.msgCache.deleteFileMsg(chatId, msgId); }

  getPendingCard(chatId: string | null | undefined, msgId: string | null | undefined): PendingCard | null {
    const mid = String(msgId ?? '').trim();
    if (!mid) return null;
    const cid = String(chatId ?? '').trim();
    const card = this.pendingCards.get(mid) ?? null;
    if (!card) return null;
    if (cid && card.chatId && card.chatId !== cid) return null;
    return card;
  }

  get privateDrafts(): Map<string, PrivateDraft> {
    return this.draftStore.draftsView;
  }

  get pendingSendBacks(): Map<string, PendingSendBack> {
    return this.draftStore.sendBacksView;
  }

  get pendingSendBack(): PendingSendBack | null {
    return this.draftStore.latestConfirming();
  }

  set pendingSendBack(val: PendingSendBack | null) {
    if (!val) {
      this.draftStore.clearAllConfirming();
      return;
    }
    const id = val.id || val.draft?.id || 'default';
    this.draftStore.setConfirmingFromEntry(id, { ...val, id });
  }

  clearPickers(): void {
    this.pendingTaskPick = null;
  }

  clearPendingMedia(): void {
    if (this.pendingMediaTimer) {
      clearTimeout(this.pendingMediaTimer);
      this.pendingMediaTimer = null;
    }
    this.pendingMediaIds = [];
    this.pendingMediaTarget = null;
  }

  isStickyActive(): boolean {
    return Boolean(
      this.followUpWindowMs > 0
      && this.focus?.botId
      && this.lastBotReplyAt > 0
      && (this.now() - this.lastBotReplyAt) <= this.followUpWindowMs,
    );
  }

  clearSticky(): void {
    this.lastBotReplyAt = 0;
    this.lastByeAt = this.now();
    this.focus = null;
    this.saveState();
  }

  displayBotName(botId: string | null | undefined, rawName = '', { isGroup = false }: { isGroup?: boolean } = {}): string {
    if (isGroup) return String(rawName ?? '').trim() || this.botName;
    const raw = String(rawName ?? '').trim();
    if ((botId && this.chiefBotId && botId === this.chiefBotId) || !raw || /^(open)?mausbot$/i.test(raw)) {
      return this.botName;
    }
    return raw;
  }

  /** 返回样式 A 徽章方括号内展示的短名（默认主 Bot `co-bot` 跟随触发词简化为 `bot`，自定义名与子 Bot 保留原名）。 */
  badgeName(botId: string | null | undefined, rawName = '', { isGroup = false }: { isGroup?: boolean } = {}): string {
    const shown = this.displayBotName(botId, rawName, { isGroup });
    if (!isGroup && this.botName === 'co-bot' && shown === 'co-bot') {
      return this.trigger.replace(/^@/, '').trim() || 'bot';
    }
    return shown;
  }

  getEffectiveTriggerAliases(): string[] {
    const raw = Array.isArray(this.chats?.triggerAliases) ? this.chats.triggerAliases : [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of [...raw, this.botName]) {
      const val = String(item ?? '').trim();
      if (!val) continue;
      const low = val.replace(/^@/, '').toLowerCase();
      if (seen.has(low)) continue;
      seen.add(low);
      out.push(val);
    }
    return out;
  }

  botPrefix(
    botId: string,
    botName: string,
    { proactive = false, isGroup = false, speakerName = '', speakerBotId = null }: {
      proactive?: boolean;
      isGroup?: boolean;
      speakerName?: string;
      speakerBotId?: string | null;
    } = {},
  ): string {
    const shown = this.badgeName(botId, botName, { isGroup });
    const shownSpeaker = speakerName ? this.badgeName(speakerBotId, speakerName) : '';
    if (isGroup) {
      return shownSpeaker ? `🤖 **[${shown} · ${shownSpeaker}]**` : `🤖 **[${shown}]**`;
    }
    const isChief = !this.multiBotCache || (Boolean(botId) && botId === this.chiefBotId);
    if (this.hideChiefPrefix && !proactive && isChief) return '';
    return `🤖 **[${shown}]**`;
  }

  status() { return buildBridgeStatus(this); }
  async start(): Promise<void> { return startBridgeLifecycle(this); }
  async stop(): Promise<void> { return stopBridgeLifecycle(this); }

  async syncChiefBotIdentity(bots: OmbBot[] | null = null): Promise<boolean> { return syncChiefBotIdentity(this, bots); }
  async refreshMultiBot(opts?: { force?: boolean }): Promise<OmbBot[]> { return refreshMultiBot(this, opts); }
  async resolveOwnerByThread(threadId: string): Promise<OmbTargetBot | null> { return resolveOwnerByThread(this, threadId); }

  rememberEcho(text: string): void { this.msgCache.rememberEcho(text); }
  isEcho(text: string): boolean { return this.msgCache.isEcho(text, this.outPrefix); }
  channelCaps(): Partial<ChannelCapabilities> | null {
    const caps = this.transport?.capabilities;
    return caps && typeof caps === 'object' ? caps : null;
  }
  isPendingOutFile(att: Partial<InboundAttachment> | null | undefined): boolean { return this.msgCache.isPendingOutFile(att); }

  effectiveResultChars(): number {
    const maxChars = Number(this.channelCaps()?.maxChars ?? 0);
    return maxChars > 0 ? Math.min(this.resultChars, maxChars) : this.resultChars;
  }

  effectiveSoftSplitChars(): number {
    const maxChars = Number(this.channelCaps()?.maxChars ?? 0);
    const effRes = this.effectiveResultChars();
    if (maxChars > 0) return Math.min(this.softSplitChars, maxChars);
    return Math.max(effRes, this.softSplitChars);
  }

  supportsFiles(): boolean {
    const caps = this.channelCaps();
    return typeof this.transport.sendFile === 'function'
      && this.transport.canFiles !== false
      && caps?.files !== false;
  }

  supportsImages(): boolean {
    const caps = this.channelCaps();
    return this.supportsFiles() && caps?.images !== false;
  }

  emitTelemetry(type: string, data: Record<string, unknown> = {}): void {
    try {
      this.onTelemetry?.({ ts: this.now(), type, ...data });
    } catch { /* ignore telemetry errors */ }
  }

  recordInboundToContext(ev: InboundEvent): void {
    if (!ev?.id || !ev?.chat?.id) return;
    const cid = String(ev.chat.id);
    const prevName = this.externalChatMeta.get(cid)?.name;
    if (this.externalChatMeta.has(cid)) this.externalChatMeta.delete(cid);
    this.externalChatMeta.set(cid, {
      id: cid,
      type: ev.chat.type,
      name: ev.chat.name ? String(ev.chat.name) : prevName,
    });
    trimMapCap(this.externalChatMeta, 200);
    if (this.imContext) this.imContext.recordInbound(ev);
    else this.localContextStore.recordInbound(ev);
  }

  recordOutboundToContext(chatId: string, info: Record<string, unknown>): void {
    if (!chatId) return;
    const cid = String(chatId);
    const meta = this.externalChatMeta.get(cid);
    const payload = {
      ...info,
      ...(meta?.type ? { chatType: meta.type } : {}),
      ...(meta?.name ? { chatName: meta.name } : {}),
    };
    if (this.imContext) this.imContext.recordOutbound(cid, payload);
    else this.localContextStore.recordOutbound(cid, payload);
  }

  resolveControlChatId(chatCtx: CompactChatContext | BridgeChatContext | null | undefined): string {
    if (!chatCtx?.isExternal) return this.selfChat;
    if (this.chats.routeControlsToSelf !== false && this.selfChat) return this.selfChat;
    if (chatCtx.privateReply) return this.selfChat || '';
    return chatCtx.controlChatId || chatCtx.replyChatId || chatCtx.originChatId || this.selfChat;
  }

  getChatPolicy() { return getChatPolicy(this); }
  listChatThreads() { return [...this.chatThreads.entries()].map(([key, v]) => ({ key, ...v })); }
  listKnownChats(): KnownChatSummary[] { return listKnownChats(this); }
  resolveKnownChat(query: unknown, opts?: { includeSelf?: boolean }) { return resolveKnownChat(this, query, opts); }

  setChatMuted(chatId: string, muted = true): void {
    if (!chatId) return;
    const cid = String(chatId);
    if (muted) {
      this.chatPolicyOverrides.muted.add(cid);
      this.chatPolicyOverrides.allowed.delete(cid);
    } else {
      this.chatPolicyOverrides.muted.delete(cid);
    }
    this.saveState();
  }

  setChatAllowed(chatId: string): void {
    if (!chatId) return;
    const cid = String(chatId);
    this.chatPolicyOverrides.muted.delete(cid);
    this.chatPolicyOverrides.allowed.add(cid);
    this.saveState();
  }

  setChatMode(mode: string | null): void {
    this.chatPolicyOverrides.mode = mode === 'self_only' || mode === 'owner_everywhere' ? mode : null;
    this.saveState();
  }

  resetChatPolicy(): void {
    this.chatPolicyOverrides = { mode: null, muted: new Set(), allowed: new Set() };
    this.saveState();
  }

  listProjectBindings(): Array<{ chatId: string; name: string; path: string }> {
    return [...this.chatProjects.entries()].map(([chatId, info]) => ({ chatId, ...info }));
  }

  bindChatProject(chatId: string, project: ProjectRef): ProjectRef | null {
    const cid = String(chatId || '').trim();
    if (!cid || !project?.path) return null;
    const entry: ProjectRef = {
      name: String(project.name || path.basename(project.path)),
      path: String(project.path),
    };
    this.chatProjects.set(cid, entry);
    this.saveState();
    this.emitTelemetry('project_bound', { chatId: cid, summary: `${entry.name} -> ${entry.path}` });
    return entry;
  }

  unbindChatProject(chatId: string): boolean {
    const cid = String(chatId || '').trim();
    if (!cid || !this.chatProjects.has(cid)) return false;
    this.chatProjects.delete(cid);
    this.saveState();
    this.emitTelemetry('project_bound', { chatId: cid, summary: 'unbind' });
    return true;
  }

  getSharedContextStatus() {
    return this.sharedContext.status();
  }

  notifySelf({ title, body, chatId, urgent = false }: { title?: string; body?: string; chatId?: string; urgent?: boolean } = {}): void {
    if (typeof this.transport?.notify !== 'function') return;
    Promise.resolve(this.transport.notify({
      title: title || this.botName || 'co-bot',
      body: clip(String(body || '').replace(/\s+/g, ' '), 120),
      chatId: chatId || this.selfChat || '',
      urgent: Boolean(urgent),
    })).catch(() => {});
  }

  compactExternalChat(targetChat: { id?: string } | null, preferredBot: { id?: string } | null = null) {
    return compactExternalChat(this, targetChat, preferredBot);
  }
  resolvePrivateDraft(opts?: { quotedId?: string | null; draftId?: string | null }) { return resolvePrivateDraft(this, opts); }
  requestSendBack(draft: PrivateDraft | null | undefined, overrideText = '') { return requestSendBack(this, draft, overrideText); }
  confirmSendBack(targetRef?: string | null) { return confirmSendBack(this, targetRef); }
  cancelSendBack(targetRef?: string | null) { return cancelSendBack(this, targetRef); }
  getCoordinatorInbox() { return getCoordinatorInbox(this); }
  checkPendingReminders() { return checkPendingReminders(this); }
  buildExternalSummaryPrompt(targetChat: { id: string; type?: ChatType; name?: string }, opts?: { limit?: number; focusQuestion?: string; botId?: string }) {
    return buildExternalSummaryPrompt(this, targetChat, opts);
  }

  getChatThread(chatId: string, targetBot: OmbTargetBot): OmbTargetBot { return getChatThread(this, chatId, targetBot); }
  setSelfThread(targetBot: OmbTargetBot): void { setSelfThread(this, targetBot); }
  async resolveSelfBotThread(targetBot: OmbTargetBot): Promise<OmbTargetBot> { return resolveSelfBotThread(this, targetBot); }
  setChatThread(chatId: string, targetBot: OmbTargetBot): void { setChatThread(this, chatId, targetBot); }
  async ensureChatThread(chatId: string, chatType: ChatType, chatName: string, targetBot: OmbTargetBot): Promise<OmbTargetBot> {
    return ensureChatThread(this, chatId, chatType, chatName, targetBot);
  }

  getKnownBotNames(): string[] {
    const names = [this.trigger, ...this.getEffectiveTriggerAliases()];
    for (const b of this.botById.values()) if (b?.name) names.push(b.name);
    for (const g of this.groupById.values()) if (g?.name) names.push(g.name);
    return names;
  }

  async withCliLoopbackFallback<T>(fn: (client: OpenMausBotClient) => Promise<T>): Promise<T> {
    try {
      return await fn(this.client);
    } catch (e) {
      const err = e as OmbHttpError;
      if (err?.status !== 403 || !this.client.token) throw e;
      const env = typeof this.client.environment === 'function' ? await this.client.environment().catch(() => null) : null;
      if (env?.capabilities?.selfUpdate === 'desktop-managed') throw e;
      const LoopCtor = this.client.constructor as typeof OpenMausBotClient;
      return fn(new LoopCtor({ baseUrl: this.client.baseUrl, timeoutMs: this.client.timeoutMs }));
    }
  }

  isTransportDisconnected(): boolean { return isTransportDisconnected(this); }
  async drainOutbound(timeoutMs = 2000): Promise<void> { return drainOutboundQueue(this, timeoutMs); }
  async flushOutboundBuffer(): Promise<number> { return flushOutboundQueueBuffer(this); }

  async say(
    text: string,
    route: MsgRoute | { targetChatId?: string | null } | null = null,
    replyTo: string | null = null,
    actions: ChannelAction[] | null = null,
    extra: SendTextExtra = {},
  ): Promise<string | null> { return sendBridgeText(this, text, route, replyTo, actions, extra); }

  sendDelegation(targetChat: { id?: string; name?: string; type?: ChatType }, question: string, opts?: { project?: string }) {
    return sendDelegation(this, targetChat, question, opts);
  }
  sendOutboundFile(filePath: string, name: string, opts?: SendOutboundFileOpts) { return sendOutboundFile(this, filePath, name, opts); }
  onEvent(ev: InboundEvent) { return handleInboundEvent(this, ev); }
  steerLatestQueue(preferredThreadId?: string | null, targetChatId: string | null = null, opts: { banner?: string } = {}) {
    return steerLatestQueue(this, preferredThreadId, targetChatId, opts);
  }
  cancelLatestQueue(preferredThreadId?: string | null, targetChatId: string | null = null, opts: { banner?: string } = {}) {
    return cancelLatestQueue(this, preferredThreadId, targetChatId, opts);
  }
  cancelThreadQueue(threadId: string) { return cancelThreadQueue(this, threadId); }
  dispatchSteerSupplement(target: OmbTargetBot, text: string, imMsgId: string | null, quotedId: string | null, chatCtx: BridgeChatContext | null = null, opts: { banner?: string; cmdTarget?: string } = {}) {
    return dispatchSteerSupplement(this, target, text, imMsgId, quotedId, chatCtx, opts);
  }
  collectBotTasks(target: OmbTargetBot) { return collectBotTasks(this, target); }
  switchTask(defaultBotId: string, defaultBotName: string, task: OmbTaskSummary, opts?: { isGroup?: boolean; chatId?: string | null; isExternal?: boolean; originChatId?: string | null; banner?: string }) {
    return switchTask(this, defaultBotId, defaultBotName, task, opts);
  }
  dispatchToBot(bot: OmbTargetBot, text: string, imMsgId: string | null, quotedId: string | null, replyToOmbId: string | null, chatCtx: BridgeChatContext | null = null) {
    return dispatchToBot(this, bot, text, imMsgId, quotedId, replyToOmbId, chatCtx);
  }
  flushQuietDigest() { return flushQuietDigest(this); }

  trackTurn(params: {
    key: string; botId: string; botName: string; threadId: string; reqMsgId: string | null;
    sendId: string | null; isGroup?: boolean; chatCtx?: CompactChatContext | BridgeChatContext | null; startedAt?: number;
  }): TurnTrackerHandle {
    return createTurnTracker(this, params, {
      deliverBotReply: (args) => deliverBotReply(this, args),
      emitCard: (botId, botName, tid, msg, opts) => emitCard(this, botId, botName, tid, msg, opts),
      forwardBotMedia: (tid, msgs, opts) => forwardBotMedia(this, tid, msgs, opts),
      maybeWarnHighContext: (botId, tid, ctx) => maybeWarnHighContext(this, botId, tid, ctx),
    });
  }
}
