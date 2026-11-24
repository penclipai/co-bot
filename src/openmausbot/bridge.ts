import path from 'node:path';
import { defaults } from '../config.ts';
import { ChatContextStore } from '../core/chat-context.ts';
import { normalizeCollaborators } from '../core/inbound-policy.ts';
import { normalizeProjectsConfig } from '../core/projects.ts';
import { SharedContextManager } from '../core/shared-context.ts';
import { clip, pruneExpiredFiles, safeAttachmentName } from '../format.ts';
import type {
  ChannelAction, ChannelCapabilities, ChatType, ChatsConfig, ChatsMode,
  InboundAttachment, InboundEvent, ProjectConfig, ProjectRef, QuietHoursConfig, TelemetryEvent,
} from '../types.ts';
import { extractCardInfo, formatOmbError } from './cards.ts';
import {
  buildExternalSummaryPrompt, compactExternalChat, confirmSendBack, getChatPolicy,
  listKnownChats, requestSendBack, resolveKnownChat, resolvePrivateDraft,
} from './chat-manager.ts';
import { type OpenMausBotClient } from './client.ts';
import { DelegationTracker } from './delegation.ts';
import {
  deliverBotReply, emitCard, flushQuietDigest, forwardBotMedia,
  maybeWarnHighContext, sendOutboundFile, type SendOutboundFileOpts,
} from './delivery.ts';
import {
  cancelLatestQueue, cancelThreadQueue, collectBotTasks, dispatchSteerSupplement,
  dispatchToBot, handleSseEvent, steerLatestQueue, switchTask,
} from './dispatch.ts';
import { handleInboundEvent, sendDelegation } from './inbound-router.ts';
import { inQuietHours, rememberBounded, trimMapCap } from './mentions.ts';
import {
  drainOutboundQueue, flushOutboundBuffer as flushOutboundQueueBuffer,
  isTransportDisconnected, sendBridgeText, type SendTextExtra,
} from './outbound-queue.ts';
import { COBOT_COORDINATOR_PROFILE, COBOT_COORDINATOR_TITLE, LEGACY_GROK_SOUL_RE } from './persona.ts';
import { flushBridgeState, loadBridgeState, pruneBridgeMemoryCaches, saveBridgeState } from './state-store.ts';
import { createTurnTracker } from './turn-tracker.ts';
import type {
  BridgeChatContext, BridgeFocus, BridgeOptions, BridgeTransport, ChatThreadEntry,
  CompactChatContext, FileMsgEntry, ImContextService, InFlightTurnMeta, KnownChatSummary,
  MsgRoute, OmbBot, OmbGroup, OmbHttpError, OmbTargetBot, OmbTaskSummary, OutboundBufferItem,
  PendingCard, PendingSendBack, PendingTaskPick, PrivateDraft, QueuedTurnEntry,
  QuietQueueItem, TurnTrackerHandle,
} from './types.ts';

export { extractCardInfo, inQuietHours };

const DAY_MS = 24 * 60 * 60 * 1000;
const norm = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();

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
  stateSaveDebounceMs: number;
  draftTtlMs: number;
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
  ownIds = new Set<string>();
  ownReqIds = new Set<string>();
  deliveredOmbIds = new Set<string>();
  deliveredCards = new Set<string>();
  deliveredMedia = new Set<string>();
  pendingOutFiles = new Map<string, number>();
  recent = new Map<string, number>();
  seen = new Set<string>();
  fileMsgs = new Map<string, FileMsgEntry>();
  msgRoute = new Map<string, MsgRoute>();
  pendingCards = new Map<string, PendingCard>();
  activeTurns = new Map<string, TurnTrackerHandle>();
  pendingThreads = new Set<string>();
  queuedByThread = new Map<string, QueuedTurnEntry[]>();
  steeredQueue = new Map<string, QueuedTurnEntry>();
  pendingTaskPick: PendingTaskPick | null = null;
  pendingMediaIds: string[] = [];
  pendingMediaTimer: ReturnType<typeof setTimeout> | null = null;
  pendingMediaTarget: OmbTargetBot | null = null;
  contextWarnedThreads = new Set<string>();
  lastAutoCompactAt = new Map<string, number>();
  privateDrafts = new Map<string, PrivateDraft>();
  lastPrivateDraftId: string | null = null;
  pendingSendBack: PendingSendBack | null = null;
  inFlightTurns = new Map<string, InFlightTurnMeta>();
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
  quietQueue: QuietQueueItem[] = [];
  quietTimer: ReturnType<typeof setInterval> | null = null;
  cleanupTimer: ReturnType<typeof setInterval> | null = null;
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
    stateSaveDebounceMs = 150,
    draftTtlMs = 30 * 60_000,
    outboundBufferMax = 30,
    outboundBufferTtlMs = 5 * 60_000,
    resultChars = 1500,
    softSplitChars,
    followUpWindowMs = 120_000,
    hideChiefPrefix = true,
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
    this.stateSaveDebounceMs = stateSaveDebounceMs;
    this.draftTtlMs = draftTtlMs;
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

  #loadState(): void { loadBridgeState(this); }
  saveState(opts?: { immediate?: boolean }): void { saveBridgeState(this, opts); }
  flushState(): void { flushBridgeState(this); }
  pruneMemoryCaches(): void { pruneBridgeMemoryCaches(this); }

  #syncQuietTimer(): void {
    if (this.quietTimer) {
      clearInterval(this.quietTimer);
      this.quietTimer = null;
    }
    if (this.quietHours?.enabled) {
      this.quietTimer = setInterval(() => {
        if (this.quietQueue.length && !inQuietHours(this.now(), this.quietHours)) {
          this.flushQuietDigest().catch(() => {});
        }
      }, 60_000);
      this.quietTimer.unref?.();
    }
  }

  rememberOwnId(id: unknown): void {
    if (id != null) rememberBounded(this.ownIds, id, 2000);
  }

  clearPickers(): void {
    this.pendingTaskPick = null;
    this.pendingSendBack = null;
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

  displayBotName(botId: string | null | undefined, rawName = '', { isGroup = false }: { isGroup?: boolean } = {}): string {
    if (isGroup) return String(rawName ?? '').trim() || this.botName;
    const raw = String(rawName ?? '').trim();
    if ((botId && this.chiefBotId && botId === this.chiefBotId) || !raw || /^(open)?mausbot$/i.test(raw)) {
      return this.botName;
    }
    return raw;
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
    const shown = this.displayBotName(botId, botName, { isGroup });
    const shownSpeaker = speakerName ? this.displayBotName(speakerBotId, speakerName) : '';
    if (isGroup) {
      return shownSpeaker ? `**[${shown} · ${shownSpeaker}]**` : `**[${shown}]**`;
    }
    if (!this.multiBotCache) return '';
    if (proactive) return `**[${shown}]**`;
    if (this.hideChiefPrefix && botId && botId === this.chiefBotId) return '';
    return `**[${shown}]**`;
  }

  status() {
    let queuedCount = 0;
    for (const arr of this.queuedByThread.values()) queuedCount += arr.length;
    const uniqueDrafts = new Set<string>();
    for (const d of this.privateDrafts.values()) if (d?.id) uniqueDrafts.add(d.id);
    return {
      connected: this.sseConnected,
      sseAuthFailed: Boolean(this.sseAuthError),
      proactive: this.proactive !== false,
      quietPending: this.quietQueue.length,
      activeTurns: this.activeTurns.size,
      inFlightTurns: this.inFlightTurns.size,
      queuedCount,
      pendingCards: this.pendingCards.size,
      stickyActive: this.isStickyActive(),
      botName: this.botName,
      focus: this.focus
        ? { ...this.focus, botName: this.displayBotName(this.focus.botId, this.focus.botName, { isGroup: Boolean(this.focus.isGroup) }) }
        : null,
      multiBot: this.multiBotCache,
      chatThreads: this.chatThreads.size,
      chatPolicy: this.getChatPolicy(),
      pendingSendBack: Boolean(this.pendingSendBack && this.now() < this.pendingSendBack.expiresAt),
      privateDraftsCount: uniqueDrafts.size,
      securityRedactions: this.securityRedactions,
      policyDenials: this.policyDenials,
      boundProjectsCount: this.chatProjects.size,
      sharedContext: this.sharedContext.status(),
      delegations: this.delegations.stats(),
      outboundBuffered: this.disconnectedBuffer.length,
      outboundFailures: this.outboundFailures,
      outboundReplayed: this.outboundReplayed,
      sseReconnects: this.sseReconnects,
      stateSaveErrors: this.stateSaveErrors,
      stateCorruptRecoveries: this.stateCorruptRecoveries,
      uptimeSec: Math.max(0, Math.round((this.now() - this.startedAt) / 1000)),
      context: this.imContext?.stats?.() ?? this.localContextStore.stats(),
    };
  }

  #resumeInFlightTurns(): void {
    if (!this.inFlightTurns.size) return;
    const cutoff = this.now() - 30 * 60_000;
    for (const [key, meta] of [...this.inFlightTurns.entries()]) {
      if (!meta?.botId || !meta?.threadId || (meta.startedAt && meta.startedAt < cutoff)) {
        this.inFlightTurns.delete(key);
        continue;
      }
      if (this.activeTurns.has(key)) continue;
      const turn = this.trackTurn(meta);
      turn.startWatcher();
      this.emitTelemetry('turn_resumed', {
        botName: this.displayBotName(meta.botId, meta.botName, { isGroup: Boolean(meta.isGroup) }),
        chatId: meta.chatCtx?.originChatId || this.selfChat || null,
        summary: `thread=${meta.threadId}`,
      });
    }
  }

  async start(): Promise<void> {
    const ttlMs = this.fileRetentionDays > 0 ? this.fileRetentionDays * DAY_MS : 0;
    if (ttlMs > 0) pruneExpiredFiles(this.inDir, ttlMs, { now: this.now() });
    this.cleanupTimer = setInterval(() => {
      if (ttlMs > 0) pruneExpiredFiles(this.inDir, ttlMs, { now: this.now() });
      this.pruneMemoryCaches();
    }, DAY_MS);
    this.cleanupTimer.unref?.();
    await this.transport.start((ev) => Promise.resolve(this.onEvent(ev)).catch((e) => console.error('[omb-bridge]', e)));
    this.sseAc = new AbortController();
    this.sseTask = this.client.subscribeEvents((evt) => handleSseEvent(this, evt), {
      signal: this.sseAc.signal,
      onError: (e) => {
        if (this.sseConnected) this.sseReconnects += 1;
        this.sseConnected = false;
        if (e?.status === 401 || e?.status === 403) {
          this.consecutiveSseErrors = 0;
          if (!this.sseAuthError) console.error(`[omb-sse] 认证失败（${e.status}）：${formatOmbError(e)}`);
          this.sseAuthError = e.message || `HTTP ${e.status}`;
          return;
        }
        this.consecutiveSseErrors += 1;
        if (
          this.consecutiveSseErrors >= 2
          && typeof this.autoHealOmb === 'function'
          && (this.now() - this.lastAutoHealAt) >= this.autoHealCooldownMs
        ) {
          this.lastAutoHealAt = this.now();
          const heal = this.autoHealOmb;
          Promise.resolve().then(() => heal()).catch((err) => {
            console.warn('[omb-autoheal]', err instanceof Error ? err.message : err);
          });
        }
      },
    }).catch((e) => { if (!this.sseAc?.signal.aborted) console.error('[omb-sse]', e); });
    this.#syncQuietTimer();
    await this.refreshMultiBot();
    this.#resumeInFlightTurns();
    if (!this.isTransportDisconnected() && this.disconnectedBuffer.length) {
      this.flushOutboundBuffer().catch(() => {});
    }
  }

  async stop(): Promise<void> {
    this.sseConnected = false;
    this.sseAuthError = null;
    if (this.quietTimer) {
      clearInterval(this.quietTimer);
      this.quietTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.clearPendingMedia();
    this.sseAc?.abort();
    await this.drainOutbound(2000).catch(() => {});
    for (const turn of [...this.activeTurns.values()]) turn.dispose();
    this.activeTurns.clear();
    this.flushState();
    await this.sseTask?.catch(() => {});
    await this.transport.stop?.();
  }

  async syncChiefBotIdentity(bots: OmbBot[] | null = null): Promise<boolean> {
    if (!this.syncChiefIdentity || this.chiefIdentitySynced || typeof this.client?.patchBot !== 'function') return false;
    if (this.syncingChiefPromise) return this.syncingChiefPromise;
    this.syncingChiefPromise = (async () => {
      try {
        const list = Array.isArray(bots) ? bots : ((await this.client.listBots())?.bots ?? []);
        const visible = list.filter((b) => b && !b.hidden);
        const chief = visible.find((b) => b.chiefOfStaff) ?? visible[0];
        if (!chief?.id) return false;
        this.chiefBotId = chief.id;

        const rawName = String(chief.name ?? '').trim();
        const patch: Record<string, string> = {};
        if ((!rawName || /^(open)?mausbot$/i.test(rawName)) && rawName !== this.botName) {
          patch.name = this.botName;
        }
        if (!String(chief.title ?? '').trim()) {
          patch.title = COBOT_COORDINATOR_TITLE;
        }
        const curSoul = String(chief.soul ?? '').trim();
        if (!curSoul || LEGACY_GROK_SOUL_RE.test(curSoul)) {
          Object.assign(patch, COBOT_COORDINATOR_PROFILE);
        }
        if (Object.keys(patch).length > 0) {
          await this.withCliLoopbackFallback((c) => c.patchBot(chief.id, patch));
          const updated = { ...chief, ...patch };
          this.botById.set(chief.id, updated);
          for (const [tid, entry] of this.botByThread) {
            if (entry?.id === chief.id) this.botByThread.set(tid, { ...entry, ...patch });
          }
          console.log(`[co-bot] 已同步主 Bot 身份为 ${updated.name || this.botName}（${updated.title || COBOT_COORDINATOR_TITLE}）`);
        }
        this.chiefIdentitySynced = true;
        return true;
      } catch (e) {
        const err = e as OmbHttpError;
        if (err?.status === 400 || err?.status === 404) this.chiefIdentitySynced = true;
        return false;
      } finally {
        this.syncingChiefPromise = null;
      }
    })();
    return this.syncingChiefPromise;
  }

  async refreshMultiBot(): Promise<OmbBot[]> {
    try {
      const { bots = [], groups = [] } = await this.client.listBots();
      const visible = bots.filter((b) => !b.hidden);
      const visibleGroups = groups.filter((g) => !g.hidden && !g.dm);
      this.multiBotCache = visible.length > 1 || visibleGroups.length > 0;
      const chief = visible.find((b) => b.chiefOfStaff) ?? visible[0] ?? null;
      this.chiefBotId = chief?.id ?? null;
      const indexEntities = <T extends { id: string; name: string; threadId: string; mainThreadId?: string; tasks?: OmbTaskSummary[] }>(
        list: T[],
        byId: Map<string, T>,
        byThread: Map<string, OmbTargetBot>,
        isGroup: boolean,
      ): void => {
        for (const item of list) {
          const entry = isGroup ? { ...item, isGroup: true } : item;
          byId.set(item.id, entry);
          if (item.threadId) byThread.set(item.threadId, entry);
          if (item.mainThreadId) byThread.set(item.mainThreadId, entry);
          for (const t of item.tasks ?? []) {
            if (t?.threadId) byThread.set(t.threadId, { ...entry, threadId: t.threadId });
          }
        }
        trimMapCap(byThread, 500);
      };
      indexEntities(bots, this.botById, this.botByThread, false);
      indexEntities(groups, this.groupById, this.groupByThread, true);
      if (this.syncChiefIdentity && !this.chiefIdentitySynced && bots.length > 0) {
        await this.syncChiefBotIdentity(bots);
      }
      return bots;
    } catch {
      return [];
    }
  }

  async resolveOwnerByThread(threadId: string): Promise<OmbTargetBot | null> {
    if (this.botByThread.has(threadId)) return this.botByThread.get(threadId) ?? null;
    if (this.groupByThread.has(threadId)) return this.groupByThread.get(threadId) ?? null;
    await this.refreshMultiBot();
    return this.botByThread.get(threadId) ?? this.groupByThread.get(threadId) ?? null;
  }

  rememberEcho(text: string): void {
    const key = norm(text);
    if (!key) return;
    const now = this.now();
    this.recent.set(key, now);
    for (const [k, at] of this.recent) if (now - at > 3 * 60 * 1000) this.recent.delete(k);
  }

  isEcho(text: string): boolean {
    if (this.outPrefix && text.startsWith(this.outPrefix.trim())) return true;
    const now = this.now();
    for (const [k, at] of this.recent) if (now - at > 3 * 60 * 1000) this.recent.delete(k);
    return this.recent.has(norm(text));
  }

  channelCaps(): Partial<ChannelCapabilities> | null {
    const caps = this.transport?.capabilities;
    return caps && typeof caps === 'object' ? caps : null;
  }

  isPendingOutFile(att: Partial<InboundAttachment> | null | undefined): boolean {
    if (!this.pendingOutFiles.size) return false;
    const now = this.now();
    for (const [k, exp] of this.pendingOutFiles) {
      if (exp <= now) this.pendingOutFiles.delete(k);
    }
    const safe = safeAttachmentName(att?.name, '');
    if (!safe) return false;
    const keys = att?.size ? [`${safe}:${att.size}`, safe] : [safe];
    const hit = keys.find((k) => this.pendingOutFiles.has(k));
    if (!hit) return false;
    for (const k of keys) this.pendingOutFiles.delete(k);
    return true;
  }

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
  confirmSendBack() { return confirmSendBack(this); }
  buildExternalSummaryPrompt(targetChat: { id: string; type?: ChatType; name?: string }, opts?: { limit?: number; focusQuestion?: string }) {
    return buildExternalSummaryPrompt(this, targetChat, opts);
  }

  getChatThread(chatId: string, targetBot: OmbTargetBot): OmbTargetBot {
    if (!chatId || !targetBot || this.chats.isolateThreadsByChat === false) return targetBot;
    const cached = this.chatThreads.get(`${chatId}:${targetBot.id}`);
    return cached?.threadId ? { ...targetBot, threadId: cached.threadId } : targetBot;
  }

  setSelfThread(targetBot: OmbTargetBot): void {
    if (!targetBot?.id || !targetBot?.threadId || this.isExternalThread(targetBot.threadId)) return;
    this.selfThreads.set(String(targetBot.id), {
      botId: targetBot.id,
      botName: targetBot.name,
      threadId: targetBot.threadId,
      ...(targetBot.isGroup ? { isGroup: true } : {}),
    });
    trimMapCap(this.selfThreads, 100);
    this.saveState();
  }

  isExternalThread(threadId?: string | null): boolean {
    if (!threadId) return false;
    const tid = String(threadId);
    if (this.externalThreadIds.has(tid)) return true;
    for (const entry of this.chatThreads.values()) {
      if (entry?.threadId === tid) return true;
    }
    return false;
  }

  async resolveSelfBotThread(targetBot: OmbTargetBot): Promise<OmbTargetBot> {
    if (!targetBot) return targetBot;
    if (!this.isExternalThread(targetBot.threadId)) {
      this.setSelfThread(targetBot);
      return targetBot;
    }
    const saved = this.selfThreads.get(String(targetBot.id));
    if (saved?.threadId && !this.isExternalThread(saved.threadId)) {
      return { ...targetBot, threadId: saved.threadId };
    }
    if (this.focus?.botId === targetBot.id && this.focus?.threadId && !this.isExternalThread(this.focus.threadId)) {
      const next = { ...targetBot, threadId: this.focus.threadId };
      this.setSelfThread(next);
      return next;
    }
    try {
      const created = targetBot.isGroup && typeof this.client.createGroupTask === 'function'
        ? await this.client.createGroupTask(targetBot.id, { title: '自聊主线' })
        : (typeof this.client.createTask === 'function'
          ? await this.client.createTask(targetBot.id, { title: '自聊主线', select: true })
          : null);
      const newTid = created?.task?.threadId ?? created?.bot?.threadId ?? created?.group?.threadId;
      if (newTid && !this.isExternalThread(newTid)) {
        const next = { ...targetBot, threadId: newTid };
        this.setSelfThread(next);
        return next;
      }
    } catch { /* ignore */ }
    return targetBot;
  }

  setChatThread(chatId: string, targetBot: OmbTargetBot): void {
    if (!chatId || !targetBot?.id || !targetBot?.threadId) return;
    const cid = String(chatId);
    const meta = this.externalChatMeta.get(cid);
    const key = `${cid}:${targetBot.id}`;
    this.chatThreads.set(key, {
      threadId: targetBot.threadId,
      botId: targetBot.id,
      botName: targetBot.name,
      isGroup: Boolean(targetBot.isGroup),
      chatId: cid,
      chatName: meta?.name || '',
      chatType: meta?.type || 'direct',
    });
    rememberBounded(this.externalThreadIds, targetBot.threadId, 500);
    trimMapCap(this.chatThreads, 200);
    this.saveState();
  }

  async ensureChatThread(chatId: string, chatType: ChatType, chatName: string, targetBot: OmbTargetBot): Promise<OmbTargetBot> {
    if (!chatId || chatType === 'self' || !targetBot || this.chats.isolateThreadsByChat === false) {
      return targetBot;
    }
    const key = `${chatId}:${targetBot.id}`;
    const existing = this.chatThreads.get(key);
    if (existing?.threadId) return { ...targetBot, threadId: existing.threadId };

    const title = clip(`${chatType === 'group' ? '群聊' : '私聊'} · ${chatName || chatId}`, 40);
    let created;
    try {
      created = targetBot.isGroup && typeof this.client.createGroupTask === 'function'
        ? await this.client.createGroupTask(targetBot.id, { title })
        : (typeof this.client.createTask === 'function'
          ? await this.client.createTask(targetBot.id, { title, select: false })
          : null);
    } catch {
      return targetBot;
    }
    const newTid = created?.task?.threadId ?? created?.bot?.threadId ?? created?.group?.threadId ?? targetBot.threadId;
    if (!newTid) return targetBot;
    if (targetBot.isGroup) {
      this.groupByThread.set(newTid, { id: targetBot.id, name: targetBot.name, threadId: newTid, isGroup: true });
    } else {
      this.botByThread.set(newTid, { id: targetBot.id, name: targetBot.name, threadId: newTid });
    }
    const nextTarget = { ...targetBot, threadId: newTid };
    this.setChatThread(chatId, nextTarget);
    return nextTarget;
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
