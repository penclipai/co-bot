import path from 'node:path';
import { defaults } from '../config.js';
import { ChatContextStore } from '../core/chat-context.js';
import { normalizeCollaborators } from '../core/inbound-policy.js';
import { normalizeProjectsConfig } from '../core/projects.js';
import { SharedContextManager } from '../core/shared-context.js';
import { clip, pruneExpiredFiles, safeAttachmentName } from '../format.js';
import { extractCardInfo, formatOmbError } from './cards.js';
import {
  buildExternalSummaryPrompt,
  compactExternalChat,
  confirmSendBack,
  getChatPolicy,
  listKnownChats,
  requestSendBack,
  resolveKnownChat,
  resolvePrivateDraft,
} from './chat-manager.js';
import { DelegationTracker } from './delegation.js';
import {
  deliverBotReply,
  emitCard,
  flushQuietDigest,
  forwardBotMedia,
  maybeWarnHighContext,
  sendOutboundFile,
} from './delivery.js';
import {
  cancelLatestQueue,
  cancelThreadQueue,
  collectBotTasks,
  dispatchSteerSupplement,
  dispatchToBot,
  handleSseEvent,
  steerLatestQueue,
  switchTask,
} from './dispatch.js';
import { handleInboundEvent, sendDelegation } from './inbound-router.js';
import { inQuietHours, rememberBounded } from './mentions.js';
import {
  drainOutboundQueue,
  flushOutboundBuffer as flushOutboundQueueBuffer,
  isTransportDisconnected,
  sendBridgeText,
} from './outbound-queue.js';
import { COBOT_COORDINATOR_PROFILE, COBOT_COORDINATOR_TITLE, LEGACY_GROK_SOUL_RE } from './persona.js';
import {
  flushBridgeState,
  loadBridgeState,
  pruneBridgeMemoryCaches,
  saveBridgeState,
} from './state-store.js';
import { createTurnTracker } from './turn-tracker.js';

export { extractCardInfo, inQuietHours };

const DAY_MS = 24 * 60 * 60 * 1000;
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * 极薄 IM <-> OpenMausBot 桥接器（co-bot / Coordinator Bot 手机端协调助手体验）：
 *   - 主 Bot 1v1 干净私聊（默认省略名字前缀）、多 Bot 自由 @<BotName> 协同
 *   - 连续对话短时粘性（followUpWindowMs）+ 连续纯发图防抖合批 + 笔记前缀保护
 *   - 中间口语即时流式上屏 + 中文工具进度去噪 + 适中长回复软拆分两段
 *   - 审批卡（ok / always / no）与选项/提问卡（1 / 2 / 3）快捷交互 + 模拟器按钮
 *   - 出站安全脱敏门禁、外部协作白名单策略、项目绑定与 2 态 C2C 委托
 */
export class OpenMausBotBridge {
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
  } = {}) {
    Object.assign(this, {
      client, transport, dataDir, trigger, commandDevices, proactive, quietHours,
      progressDelayMs, progressIntervalMs, maxProgressUpdates,
      intermediateCoalesceMs, maxIntermediateBubbles,
      turnStallMs, stateSaveDebounceMs, draftTtlMs, outboundBufferMax, outboundBufferTtlMs,
      resultChars, followUpWindowMs, hideChiefPrefix,
      imageBatchMs, fileRetentionDays, sendRetries, sendRetryDelayMs,
      autoHealOmb, autoHealCooldownMs, onTelemetry,
      markdown, outPrefix, imContext, transcribeAudio, now,
    });
    this.botName = String(botName || 'co-bot').trim() || 'co-bot';
    this.syncChiefIdentity = Boolean(syncChiefIdentity);
    this.chiefIdentitySynced = false;
    this.syncingChiefPromise = null;
    this.chats = {
      ...defaults.chats,
      ...(chats && typeof chats === 'object' ? chats : {}),
    };
    this.chats.collaborators = normalizeCollaborators(this.chats.collaborators);
    const projectBaseDir = dataDir ? path.dirname(path.resolve(dataDir)) : process.cwd();
    this.projects = normalizeProjectsConfig(projects, projectBaseDir);
    this.chatProjects = new Map();
    this.sharedContext = new SharedContextManager({
      dir: sharedContextDir,
      pullIntervalMs: sharedContextPullIntervalMs,
      now: () => this.now(),
      execGit,
      onTelemetry: (type, p) => this.emitTelemetry(type, p),
    });
    this.delegations = new DelegationTracker({ now: () => this.now() });
    this.securityRedactions = 0;
    this.policyDenials = 0;
    this.localContextStore = imContext?.store ?? new ChatContextStore({
      maxPerChat: this.chats.contextMaxMessagesPerChat,
      ttlMs: this.chats.contextTtlMs,
      now: () => this.now(),
    });
    this.softSplitChars = softSplitChars !== undefined
      ? Number(softSplitChars)
      : (this.resultChars >= 1000 ? 2800 : this.resultChars);
    this.learnedSelfChatId = '';
    this.warnedMissingSelfChat = false;
    this.inDir = path.join(dataDir || '.', 'omb-files');
    this.stateFile = dataDir ? path.join(dataDir, 'bridge-state.json') : null;
    this.ownIds = new Set();
    this.ownReqIds = new Set();
    this.deliveredOmbIds = new Set();
    this.deliveredCards = new Set();
    this.deliveredMedia = new Set();
    this.pendingOutFiles = new Map();
    this.recent = new Map();
    this.seen = new Set();
    this.fileMsgs = new Map();
    this.msgRoute = new Map();
    this.pendingCards = new Map();
    this.activeTurns = new Map();
    this.pendingThreads = new Set();
    this.queuedByThread = new Map();
    this.steeredQueue = new Map();
    this.pendingTaskPick = null;
    this.pendingMediaIds = [];
    this.pendingMediaTimer = null;
    this.pendingMediaTarget = null;
    this.contextWarnedThreads = new Set();
    this.lastAutoCompactAt = new Map();
    this.privateDrafts = new Map();
    this.lastPrivateDraftId = null;
    this.pendingSendBack = null;
    this.inFlightTurns = new Map();
    this.outboundQueue = new Map();
    this.disconnectedBuffer = [];
    this.stateSaveTimer = null;
    this.startedAt = this.now();
    this.sseReconnects = 0;
    this.outboundFailures = 0;
    this.outboundReplayed = 0;
    this.stateSaveErrors = 0;
    this.stateCorruptRecoveries = 0;
    this.botById = new Map();
    this.botByThread = new Map();
    this.groupById = new Map();
    this.groupByThread = new Map();
    this.chiefBotId = null;
    this.lastBotReplyAt = 0;
    this.quietQueue = [];
    this.quietTimer = null;
    this.cleanupTimer = null;
    this.focus = null;
    this.chatThreads = new Map();
    this.selfThreads = new Map();
    this.externalThreadIds = new Set();
    this.externalChatMeta = new Map();
    this.chatPolicyOverrides = { mode: null, muted: new Set(), allowed: new Set() };
    this.sseAc = null;
    this.sseTask = null;
    this.sseConnected = false;
    this.sseAuthError = null;
    this.consecutiveSseErrors = 0;
    this.lastAutoHealAt = 0;
    this.multiBotCache = null;
    this.#loadState();
  }

  get selfChat() {
    return this.transport?.selfChatId || this.learnedSelfChatId || '';
  }

  #loadState() { loadBridgeState(this); }
  saveState(opts) { saveBridgeState(this, opts); }
  flushState() { flushBridgeState(this); }
  pruneMemoryCaches() { pruneBridgeMemoryCaches(this); }

  #syncQuietTimer() {
    clearInterval(this.quietTimer);
    this.quietTimer = null;
    if (this.quietHours?.enabled) {
      this.quietTimer = setInterval(() => {
        if (this.quietQueue.length && !inQuietHours(this.now(), this.quietHours)) {
          this.flushQuietDigest().catch(() => {});
        }
      }, 60_000);
      this.quietTimer.unref?.();
    }
  }

  rememberOwnId(id) {
    if (id != null) rememberBounded(this.ownIds, id, 2000);
  }

  clearPickers() {
    this.pendingTaskPick = null;
    this.pendingSendBack = null;
  }

  clearPendingMedia() {
    clearTimeout(this.pendingMediaTimer);
    this.pendingMediaTimer = null;
    this.pendingMediaIds = [];
    this.pendingMediaTarget = null;
  }

  isStickyActive() {
    return Boolean(
      this.followUpWindowMs > 0
      && this.focus?.botId
      && this.lastBotReplyAt > 0
      && (this.now() - this.lastBotReplyAt) <= this.followUpWindowMs,
    );
  }

  displayBotName(botId, rawName = '', { isGroup = false } = {}) {
    if (isGroup) return String(rawName ?? '').trim() || this.botName;
    const raw = String(rawName ?? '').trim();
    if ((botId && this.chiefBotId && botId === this.chiefBotId) || !raw || /^(open)?mausbot$/i.test(raw)) {
      return this.botName;
    }
    return raw;
  }

  getEffectiveTriggerAliases() {
    const raw = Array.isArray(this.chats?.triggerAliases) ? this.chats.triggerAliases : [];
    const out = [];
    const seen = new Set();
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

  botPrefix(botId, botName, { proactive = false, isGroup = false, speakerName = '', speakerBotId = null } = {}) {
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
    const uniqueDrafts = new Set();
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

  #resumeInFlightTurns() {
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

  async start() {
    const ttlMs = this.fileRetentionDays > 0 ? this.fileRetentionDays * DAY_MS : 0;
    if (ttlMs > 0) pruneExpiredFiles(this.inDir, ttlMs, { now: this.now() });
    this.cleanupTimer = setInterval(() => {
      if (ttlMs > 0) pruneExpiredFiles(this.inDir, ttlMs, { now: this.now() });
      this.pruneMemoryCaches();
    }, DAY_MS);
    this.cleanupTimer.unref?.();
    await this.transport.start((ev) => this.onEvent(ev).catch((e) => console.error('[omb-bridge]', e)));
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
          Promise.resolve().then(() => this.autoHealOmb()).catch((err) => {
            console.warn('[omb-autoheal]', err?.message || err);
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

  async stop() {
    this.sseConnected = false;
    this.sseAuthError = null;
    clearInterval(this.quietTimer);
    this.quietTimer = null;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    this.clearPendingMedia();
    this.sseAc?.abort();
    await this.drainOutbound(2000).catch(() => {});
    for (const turn of [...this.activeTurns.values()]) turn.dispose();
    this.activeTurns.clear();
    this.flushState();
    await this.sseTask?.catch(() => {});
    await this.transport.stop?.();
  }

  async syncChiefBotIdentity(bots = null) {
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
        const patch = {};
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
        if (e?.status === 400 || e?.status === 404) this.chiefIdentitySynced = true;
        return false;
      } finally {
        this.syncingChiefPromise = null;
      }
    })();
    return this.syncingChiefPromise;
  }

  async refreshMultiBot() {
    try {
      const { bots = [], groups = [] } = await this.client.listBots();
      const visible = bots.filter((b) => !b.hidden);
      const visibleGroups = groups.filter((g) => !g.hidden && !g.dm);
      this.multiBotCache = visible.length > 1 || visibleGroups.length > 0;
      const chief = visible.find((b) => b.chiefOfStaff) ?? visible[0] ?? null;
      this.chiefBotId = chief?.id ?? null;
      const indexEntities = (list, byId, byThread, isGroup) => {
        for (const item of list) {
          const entry = isGroup ? { ...item, isGroup: true } : item;
          byId.set(item.id, entry);
          if (item.threadId) byThread.set(item.threadId, entry);
          if (item.mainThreadId) byThread.set(item.mainThreadId, entry);
          for (const t of item.tasks ?? []) {
            if (t?.threadId) byThread.set(t.threadId, { ...entry, threadId: t.threadId });
          }
        }
        while (byThread.size > 500) byThread.delete(byThread.keys().next().value);
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

  async resolveOwnerByThread(threadId) {
    if (this.botByThread.has(threadId)) return this.botByThread.get(threadId);
    if (this.groupByThread.has(threadId)) return this.groupByThread.get(threadId);
    await this.refreshMultiBot();
    return this.botByThread.get(threadId) ?? this.groupByThread.get(threadId) ?? null;
  }

  rememberEcho(text) {
    const key = norm(text);
    if (!key) return;
    const now = this.now();
    this.recent.set(key, now);
    for (const [k, at] of this.recent) if (now - at > 3 * 60 * 1000) this.recent.delete(k);
  }

  isEcho(text) {
    if (this.outPrefix && text.startsWith(this.outPrefix.trim())) return true;
    const now = this.now();
    for (const [k, at] of this.recent) if (now - at > 3 * 60 * 1000) this.recent.delete(k);
    return this.recent.has(norm(text));
  }

  channelCaps() {
    const caps = this.transport?.capabilities;
    return caps && typeof caps === 'object' ? caps : null;
  }

  isPendingOutFile(att) {
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

  effectiveResultChars() {
    const maxChars = Number(this.channelCaps()?.maxChars ?? 0);
    return maxChars > 0 ? Math.min(this.resultChars, maxChars) : this.resultChars;
  }

  effectiveSoftSplitChars() {
    const maxChars = Number(this.channelCaps()?.maxChars ?? 0);
    const effRes = this.effectiveResultChars();
    if (maxChars > 0) return Math.min(this.softSplitChars, maxChars);
    return Math.max(effRes, this.softSplitChars);
  }

  supportsFiles() {
    const caps = this.channelCaps();
    return typeof this.transport.sendFile === 'function'
      && this.transport.canFiles !== false
      && caps?.files !== false;
  }

  supportsImages() {
    const caps = this.channelCaps();
    return this.supportsFiles() && caps?.images !== false;
  }

  emitTelemetry(type, data = {}) {
    try {
      this.onTelemetry?.({ ts: this.now(), type, ...data });
    } catch { /* ignore telemetry errors */ }
  }

  recordInboundToContext(ev) {
    if (!ev?.id || !ev?.chat?.id) return;
    const cid = String(ev.chat.id);
    if (this.externalChatMeta.has(cid)) this.externalChatMeta.delete(cid);
    this.externalChatMeta.set(cid, {
      id: cid,
      type: ev.chat.type,
      name: ev.chat.name ? String(ev.chat.name) : this.externalChatMeta.get(cid)?.name,
    });
    if (this.externalChatMeta.size > 200) this.externalChatMeta.delete(this.externalChatMeta.keys().next().value);
    if (this.imContext) this.imContext.recordInbound(ev);
    else this.localContextStore.recordInbound(ev);
  }

  recordOutboundToContext(chatId, info) {
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

  resolveControlChatId(chatCtx) {
    if (!chatCtx?.isExternal) return this.selfChat;
    if (this.chats.routeControlsToSelf !== false && this.selfChat) return this.selfChat;
    if (chatCtx.privateReply) return this.selfChat || '';
    return chatCtx.controlChatId || chatCtx.replyChatId || chatCtx.originChatId || this.selfChat;
  }

  getChatPolicy() { return getChatPolicy(this); }
  listChatThreads() { return [...this.chatThreads.entries()].map(([key, v]) => ({ key, ...v })); }
  listKnownChats() { return listKnownChats(this); }
  resolveKnownChat(query, opts) { return resolveKnownChat(this, query, opts); }

  setChatMuted(chatId, muted = true) {
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

  setChatAllowed(chatId) {
    if (!chatId) return;
    const cid = String(chatId);
    this.chatPolicyOverrides.muted.delete(cid);
    this.chatPolicyOverrides.allowed.add(cid);
    this.saveState();
  }

  setChatMode(mode) {
    this.chatPolicyOverrides.mode = mode === 'self_only' || mode === 'owner_everywhere' ? mode : null;
    this.saveState();
  }

  resetChatPolicy() {
    this.chatPolicyOverrides = { mode: null, muted: new Set(), allowed: new Set() };
    this.saveState();
  }

  listProjectBindings() {
    return [...this.chatProjects.entries()].map(([chatId, info]) => ({ chatId, ...info }));
  }

  bindChatProject(chatId, project) {
    const cid = String(chatId || '').trim();
    if (!cid || !project?.path) return null;
    const entry = {
      name: String(project.name || path.basename(project.path)),
      path: String(project.path),
    };
    this.chatProjects.set(cid, entry);
    this.saveState();
    this.emitTelemetry('project_bound', { chatId: cid, summary: `${entry.name} -> ${entry.path}` });
    return entry;
  }

  unbindChatProject(chatId) {
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

  notifySelf({ title, body, chatId, urgent = false } = {}) {
    if (typeof this.transport?.notify !== 'function') return;
    Promise.resolve(this.transport.notify({
      title: title || this.botName || 'co-bot',
      body: clip(String(body || '').replace(/\s+/g, ' '), 120),
      chatId: chatId || this.selfChat || '',
      urgent: Boolean(urgent),
    })).catch(() => {});
  }

  compactExternalChat(targetChat, preferredBot = null) { return compactExternalChat(this, targetChat, preferredBot); }
  resolvePrivateDraft(opts) { return resolvePrivateDraft(this, opts); }
  requestSendBack(draft, overrideText = '') { return requestSendBack(this, draft, overrideText); }
  confirmSendBack() { return confirmSendBack(this); }
  buildExternalSummaryPrompt(targetChat, opts) { return buildExternalSummaryPrompt(this, targetChat, opts); }

  getChatThread(chatId, targetBot) {
    if (!chatId || !targetBot || this.chats.isolateThreadsByChat === false) return targetBot;
    const cached = this.chatThreads.get(`${chatId}:${targetBot.id}`);
    return cached?.threadId ? { ...targetBot, threadId: cached.threadId } : targetBot;
  }

  setSelfThread(targetBot) {
    if (!targetBot?.id || !targetBot?.threadId || this.isExternalThread(targetBot.threadId)) return;
    this.selfThreads.set(String(targetBot.id), {
      botId: targetBot.id,
      botName: targetBot.name,
      threadId: targetBot.threadId,
      ...(targetBot.isGroup ? { isGroup: true } : {}),
    });
    if (this.selfThreads.size > 100) this.selfThreads.delete(this.selfThreads.keys().next().value);
    this.saveState();
  }

  isExternalThread(threadId) {
    if (!threadId) return false;
    const tid = String(threadId);
    if (this.externalThreadIds.has(tid)) return true;
    for (const entry of this.chatThreads.values()) {
      if (entry?.threadId === tid) return true;
    }
    return false;
  }

  async resolveSelfBotThread(targetBot) {
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
        ? await this.client.createGroupTask(targetBot.id, { title: '自聊主线', select: true })
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

  setChatThread(chatId, targetBot) {
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
    if (this.chatThreads.size > 200) this.chatThreads.delete(this.chatThreads.keys().next().value);
    this.saveState();
  }

  async ensureChatThread(chatId, chatType, chatName, targetBot) {
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
        ? await this.client.createGroupTask(targetBot.id, { title, select: false })
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

  getKnownBotNames() {
    const names = [this.trigger, ...this.getEffectiveTriggerAliases()];
    for (const b of this.botById.values()) if (b?.name) names.push(b.name);
    for (const g of this.groupById.values()) if (g?.name) names.push(g.name);
    return names;
  }

  async withCliLoopbackFallback(fn) {
    try {
      return await fn(this.client);
    } catch (e) {
      if (e?.status !== 403 || !this.client.token) throw e;
      const env = typeof this.client.environment === 'function' ? await this.client.environment().catch(() => null) : null;
      if (env?.capabilities?.selfUpdate === 'desktop-managed') throw e;
      const LoopCtor = this.client.constructor;
      return fn(new LoopCtor({ baseUrl: this.client.baseUrl, timeoutMs: this.client.timeoutMs }));
    }
  }

  isTransportDisconnected() { return isTransportDisconnected(this); }
  async drainOutbound(timeoutMs = 2000) { return drainOutboundQueue(this, timeoutMs); }
  async flushOutboundBuffer() { return flushOutboundQueueBuffer(this); }

  async say(text, route = null, replyTo = null, actions = null, extra = {}) {
    return sendBridgeText(this, text, route, replyTo, actions, extra);
  }

  sendDelegation(targetChat, question, opts) { return sendDelegation(this, targetChat, question, opts); }
  sendOutboundFile(filePath, name, opts) { return sendOutboundFile(this, filePath, name, opts); }
  onEvent(ev) { return handleInboundEvent(this, ev); }
  steerLatestQueue(preferredThreadId, targetChatId = null, opts = {}) { return steerLatestQueue(this, preferredThreadId, targetChatId, opts); }
  cancelLatestQueue(preferredThreadId, targetChatId = null, opts = {}) { return cancelLatestQueue(this, preferredThreadId, targetChatId, opts); }
  cancelThreadQueue(threadId) { return cancelThreadQueue(this, threadId); }
  dispatchSteerSupplement(target, text, imMsgId, quotedId, chatCtx = null, opts = {}) {
    return dispatchSteerSupplement(this, target, text, imMsgId, quotedId, chatCtx, opts);
  }
  collectBotTasks(target) { return collectBotTasks(this, target); }
  switchTask(defaultBotId, defaultBotName, task, opts) { return switchTask(this, defaultBotId, defaultBotName, task, opts); }
  dispatchToBot(bot, text, imMsgId, quotedId, replyToOmbId, chatCtx = null) {
    return dispatchToBot(this, bot, text, imMsgId, quotedId, replyToOmbId, chatCtx);
  }
  flushQuietDigest() { return flushQuietDigest(this); }

  trackTurn(params) {
    return createTurnTracker(this, params, {
      deliverBotReply: (args) => deliverBotReply(this, args),
      emitCard: (botId, botName, tid, msg, opts) => emitCard(this, botId, botName, tid, msg, opts),
      forwardBotMedia: (tid, msgs, opts) => forwardBotMedia(this, tid, msgs, opts),
      maybeWarnHighContext: (botId, tid, ctx) => maybeWarnHighContext(this, botId, tid, ctx),
    });
  }
}
