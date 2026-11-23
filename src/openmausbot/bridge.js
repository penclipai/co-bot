import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defaults } from '../config.js';
import { formatAttachmentTag, messageNeedsInput } from './client.js';
import { assemblePromptContext, ChatContextStore, sanitizeExternalMentions } from '../core/chat-context.js';
import { extractCardInfo, fmtTokens, formatCardPrompt, formatOmbError, parseChoiceIndex } from './cards.js';
import { botCommandTarget, buildHelpText, handleCommand } from './commands.js';
import {
  compactChatCtx,
  hasNonBotMention,
  inQuietHours,
  normalizeScheduleEntry,
  parseHHMM,
  parseInlineTriggerMention,
  parseStartMention,
  parseStructuredBotMention,
  rememberBounded,
} from './mentions.js';
import { createTurnTracker } from './turn-tracker.js';
import {
  addScheduledSummary,
  buildExternalSummaryPrompt,
  compactExternalChat,
  confirmSendBack,
  getChatPolicy,
  hydrateConfigSummaries,
  isExternalChatAllowed,
  listKnownChats,
  removeScheduledSummary,
  requestSendBack,
  resolveKnownChat,
  resolvePrivateDraft,
  runScheduledSummary,
  searchAcrossChats,
  setScheduledSummaryEnabled,
  tickScheduledSummaries,
} from './chat-manager.js';
import {
  clip, fileSafe, hardBreaks, mdClip, mdSplit, plain,
  pruneExpiredFiles, safeAttachmentName, writeJsonAtomic,
} from '../format.js';

export { extractCardInfo, inQuietHours };

const FILE_TTL = 10 * 60 * 1000;
const ECHO_TTL = 3 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const APPROVE_RE = /^(ok|okay|yes|y|好|好的|可以|允许|同意|通过|执行|批准)$/i;
const ALWAYS_RE = /^(always|all|总是允许|始终允许|永久允许|以后都允许)$/i;
const DENY_RE = /^(no|n|cancel|拒绝|不允许|不同意|取消|算了|不要)$/i;
const SKIP_RE = /^(skip|pass|ignore|跳过|先跳过|略过|忽略|稍后再说|稍后|取消)$/i;
const NOTE_PREFIX_RE = /^(#|备忘|记一下|笔记|便签|todo\b|待办|清单)/i;
const BYE_RE = /^(bye|退下|结束对话|退出对话)$/i;
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MIME_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * 极薄 IM <-> OpenMausBot 桥接器（类 Grok Bot 私聊体验）：
 *   - 主 Bot 1v1 干净私聊（默认省略名字前缀）、多 Bot 自由 @<BotName> 协同
 *   - 连续对话短时粘性（followUpWindowMs）+ 连续纯发图防抖合批 + 笔记前缀保护
 *   - 中间口语即时流式上屏 + 中文工具进度去噪 + 适中长回复软拆分两段
 *   - 审批卡（ok / always / no）与选项/提问卡（1 / 2 / 3）快捷交互 + 模拟器按钮
 *   - 忙时排队感知、全量状态原子持久化与发送退避重试（子命令分发见 commands.js）
 */
export class OpenMausBotBridge {
  constructor({
    client,
    transport,
    dataDir,
    trigger = '@bot',
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
      markdown, outPrefix, imContext, now,
    });
    this.chats = {
      ...defaults.chats,
      ...(chats && typeof chats === 'object' ? chats : {}),
    };
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
    this.pendingModelPick = null;
    this.pendingRoutineList = null;
    this.pendingMediaIds = [];
    this.pendingMediaTimer = null;
    this.pendingMediaTarget = null;
    this.contextWarnedThreads = new Set();
    this.lastAutoCompactAt = new Map();
    this.privateDrafts = new Map();
    this.lastPrivateDraftId = null;
    this.pendingSendBack = null;
    this.scheduledSummaries = [];
    this.summaryTimer = null;
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
    hydrateConfigSummaries(this);
    this.#loadState();
  }

  get selfChat() {
    return this.transport?.selfChatId || this.learnedSelfChatId || '';
  }

  #loadState() {
    if (!this.stateFile) return;
    let rawText;
    try {
      rawText = fs.readFileSync(this.stateFile, 'utf8');
    } catch {
      return; // 首次启动尚无状态文件
    }
    let raw;
    try {
      raw = JSON.parse(rawText);
    } catch (e) {
      this.stateCorruptRecoveries += 1;
      try {
        fs.renameSync(this.stateFile, `${this.stateFile}.corrupt.${this.now()}`);
      } catch { /* ignore */ }
      console.error(`[omb-bridge] 状态文件损坏，已自动备份并重置：${e.message}`);
      this.emitTelemetry('state_corrupt', { summary: e.message });
      return;
    }
    try {
      if (typeof raw?.selfChatId === 'string' && raw.selfChatId) {
        this.learnedSelfChatId = raw.selfChatId;
        if (this.transport && !this.transport.selfChatId) this.transport.selfChatId = raw.selfChatId;
      }
      if (raw?.focus?.botId) this.focus = raw.focus;
      if (Array.isArray(raw?.msgRoute)) {
        for (const [k, v] of raw.msgRoute.slice(-500)) if (k && v?.botId) this.msgRoute.set(String(k), v);
      }
      if (Array.isArray(raw?.quietQueue)) {
        this.quietQueue = raw.quietQueue.filter((it) => it && it.botId && it.threadId).slice(-100);
      }
      if (Array.isArray(raw?.pendingCards)) {
        for (const [k, v] of raw.pendingCards.slice(-20)) {
          if (k && v?.botId && v?.threadId) {
            this.pendingCards.set(String(k), v);
            rememberBounded(this.deliveredCards, v.requestId || v.ombMsgId);
          }
        }
      }
      if (Array.isArray(raw?.deliveredOmbIds)) {
        for (const id of raw.deliveredOmbIds.slice(-200)) rememberBounded(this.deliveredOmbIds, id);
      }
      if (Array.isArray(raw?.externalThreadIds)) {
        for (const tid of raw.externalThreadIds.slice(-500)) rememberBounded(this.externalThreadIds, tid, 500);
      }
      if (Array.isArray(raw?.chatThreads)) {
        for (const [k, v] of raw.chatThreads.slice(-200)) {
          if (k && v?.botId && v?.threadId) {
            this.chatThreads.set(String(k), v);
            rememberBounded(this.externalThreadIds, v.threadId, 500);
          }
        }
      }
      if (Array.isArray(raw?.selfThreads)) {
        for (const [k, v] of raw.selfThreads.slice(-100)) {
          if (k && v?.threadId && !this.externalThreadIds.has(String(v.threadId))) {
            this.selfThreads.set(String(k), v);
          }
        }
      }
      if (raw?.chatPolicy && typeof raw.chatPolicy === 'object') {
        if (raw.chatPolicy.mode === 'self_only' || raw.chatPolicy.mode === 'owner_everywhere') {
          this.chatPolicyOverrides.mode = raw.chatPolicy.mode;
        }
        for (const id of raw.chatPolicy.muted ?? []) if (id) this.chatPolicyOverrides.muted.add(String(id));
        for (const id of raw.chatPolicy.allowed ?? []) if (id) this.chatPolicyOverrides.allowed.add(String(id));
      }
      if (Array.isArray(raw?.scheduledSummaries)) {
        const byId = new Map(this.scheduledSummaries.map((s) => [s.id, s]));
        for (const s of raw.scheduledSummaries.slice(-30)) {
          if (!s?.id || !s?.chatId || parseHHMM(s.time) == null) continue;
          const existing = byId.get(String(s.id));
          if (existing) {
            if (typeof s.enabled === 'boolean') existing.enabled = s.enabled;
            if (s.lastRunDate) existing.lastRunDate = String(s.lastRunDate);
            if (Number(s.lastRunTs) > 0) existing.lastRunTs = Number(s.lastRunTs);
          } else if (!s.fromConfig) {
            const entry = normalizeScheduleEntry(s, { fromConfig: false, fallbackId: String(s.id) });
            if (entry) this.scheduledSummaries.push(entry);
          }
        }
      }
      const turnCutoff = this.now() - 30 * 60_000;
      if (Array.isArray(raw?.inFlightTurns)) {
        for (const [k, v] of raw.inFlightTurns.slice(-20)) {
          if (k && v?.botId && v?.threadId && (!v.startedAt || v.startedAt >= turnCutoff)) {
            this.inFlightTurns.set(String(k), v);
          }
        }
      }
      const draftCutoff = this.now() - (Number(this.draftTtlMs) || 30 * 60_000);
      if (Array.isArray(raw?.privateDrafts)) {
        for (const d of raw.privateDrafts.slice(-40)) {
          if (d?.id && d?.originChatId && (!d.createdAt || d.createdAt >= draftCutoff)) {
            this.privateDrafts.set(d.id, d);
            if (d.imMsgId) this.privateDrafts.set(d.imMsgId, d);
          }
        }
        if (raw.lastPrivateDraftId && this.privateDrafts.has(String(raw.lastPrivateDraftId))) {
          this.lastPrivateDraftId = String(raw.lastPrivateDraftId);
        }
      }
      // 防止早期版本遗留的外部会话 threadId 污染自聊 focus
      if (this.focus?.threadId && this.externalThreadIds.has(String(this.focus.threadId))) {
        const recovered = this.selfThreads.get(String(this.focus.botId));
        this.focus = recovered ? { ...recovered } : null;
      }
    } catch { /* 状态恢复兼容降级 */ }
  }

  #writeStateNow() {
    clearTimeout(this.stateSaveTimer);
    this.stateSaveTimer = null;
    if (!this.stateFile) return;
    try {
      const seenDrafts = new Set();
      const draftCutoff = this.now() - (Number(this.draftTtlMs) || 30 * 60_000);
      const uniqueDrafts = [];
      for (const d of this.privateDrafts.values()) {
        if (!d?.id || seenDrafts.has(d.id)) continue;
        if (d.createdAt && d.createdAt < draftCutoff) continue;
        seenDrafts.add(d.id);
        uniqueDrafts.push(d);
      }
      writeJsonAtomic(this.stateFile, {
        selfChatId: this.selfChat,
        focus: this.focus,
        msgRoute: [...this.msgRoute.entries()].slice(-500),
        quietQueue: this.quietQueue.slice(-100),
        pendingCards: [...this.pendingCards.entries()].slice(-20),
        deliveredOmbIds: [...this.deliveredOmbIds].slice(-200),
        chatThreads: [...this.chatThreads.entries()].slice(-200),
        selfThreads: [...this.selfThreads.entries()].slice(-100),
        externalThreadIds: [...this.externalThreadIds].slice(-500),
        chatPolicy: {
          mode: this.chatPolicyOverrides.mode,
          muted: [...this.chatPolicyOverrides.muted],
          allowed: [...this.chatPolicyOverrides.allowed],
        },
        scheduledSummaries: this.scheduledSummaries.slice(-30),
        inFlightTurns: [...this.inFlightTurns.entries()].slice(-20),
        privateDrafts: uniqueDrafts.slice(-40),
        lastPrivateDraftId: this.lastPrivateDraftId || null,
      });
    } catch (e) {
      this.stateSaveErrors += 1;
      console.error('[omb-bridge] 状态持久化失败：', e?.message || e);
      this.emitTelemetry('state_save_error', { summary: e?.message || 'save failed' });
    }
  }

  saveState({ immediate = false } = {}) {
    if (!this.stateFile) return;
    const delay = Number(this.stateSaveDebounceMs);
    if (immediate || !(delay > 0)) {
      this.#writeStateNow();
      return;
    }
    if (this.stateSaveTimer) return;
    this.stateSaveTimer = setTimeout(() => this.#writeStateNow(), delay);
    this.stateSaveTimer.unref?.();
  }

  flushState() {
    this.saveState({ immediate: true });
  }

  rememberOwnId(id) {
    if (id != null) rememberBounded(this.ownIds, id, 2000);
  }

  clearPickers() {
    this.pendingTaskPick = null;
    this.pendingModelPick = null;
    this.pendingSendBack = null;
  }

  #clearPendingMedia() {
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

  botPrefix(botId, botName, { proactive = false, isGroup = false, speakerName = '' } = {}) {
    if (isGroup) {
      return speakerName ? `**[${botName} · ${speakerName}]**` : `**[${botName}]**`;
    }
    if (!this.multiBotCache) return '';
    if (proactive) return `**[${botName}]**`;
    if (this.hideChiefPrefix && botId && botId === this.chiefBotId) return '';
    return `**[${botName}]**`;
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
      focus: this.focus,
      multiBot: this.multiBotCache,
      chatThreads: this.chatThreads.size,
      chatPolicy: this.getChatPolicy(),
      scheduledSummaries: this.scheduledSummaries.filter((s) => s.enabled !== false).length,
      pendingSendBack: Boolean(this.pendingSendBack && this.now() < this.pendingSendBack.expiresAt),
      privateDraftsCount: uniqueDrafts.size,
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

  #pruneMemoryCaches() {
    const now = this.now();
    for (const [k, ent] of this.fileMsgs) {
      if ((ent?.at || 0) + FILE_TTL < now) this.fileMsgs.delete(k);
    }
    for (const [k, exp] of this.pendingOutFiles) {
      if (exp <= now) this.pendingOutFiles.delete(k);
    }
    for (const [k, at] of this.recent) {
      if (now - at > ECHO_TTL) this.recent.delete(k);
    }
    const draftCutoff = now - (Number(this.draftTtlMs) || 30 * 60_000);
    for (const [k, v] of this.privateDrafts) {
      if ((v?.createdAt || 0) < draftCutoff) this.privateDrafts.delete(k);
    }
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
      const turn = this.#trackTurn(meta);
      turn.startWatcher();
      this.emitTelemetry('turn_resumed', {
        botName: meta.botName || 'MausBot',
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
      this.#pruneMemoryCaches();
    }, DAY_MS);
    this.cleanupTimer.unref?.();
    await this.transport.start((ev) => this.onEvent(ev).catch((e) => console.error('[omb-bridge]', e)));
    this.sseAc = new AbortController();
    this.sseTask = this.client.subscribeEvents((evt) => this.#onSseEvent(evt), {
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
    if (this.quietHours?.enabled) {
      this.quietTimer = setInterval(() => {
        if (this.quietQueue.length && !inQuietHours(this.now(), this.quietHours)) {
          this.flushQuietDigest().catch(() => {});
        }
      }, 60_000);
      this.quietTimer.unref?.();
    }
    this.summaryTimer = setInterval(() => {
      this.tickScheduledSummaries().catch(() => {});
    }, 30_000);
    this.summaryTimer.unref?.();
    await this.refreshMultiBot();
    this.#resumeInFlightTurns();
    if (!this.#isTransportDisconnected() && this.disconnectedBuffer.length) {
      this.flushOutboundBuffer().catch(() => {});
    }
  }

  async stop() {
    this.sseConnected = false;
    this.sseAuthError = null;
    clearInterval(this.quietTimer);
    this.quietTimer = null;
    clearInterval(this.summaryTimer);
    this.summaryTimer = null;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    this.#clearPendingMedia();
    this.sseAc?.abort();
    await this.drainOutbound(2000).catch(() => {});
    for (const turn of [...this.activeTurns.values()]) turn.dispose();
    this.activeTurns.clear();
    this.flushState();
    await this.sseTask?.catch(() => {});
    await this.transport.stop?.();
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
      return bots;
    } catch {
      return [];
    }
  }

  async #resolveOwnerByThread(threadId) {
    if (this.botByThread.has(threadId)) return this.botByThread.get(threadId);
    if (this.groupByThread.has(threadId)) return this.groupByThread.get(threadId);
    await this.refreshMultiBot();
    return this.botByThread.get(threadId) ?? this.groupByThread.get(threadId) ?? null;
  }

  #remember(text) {
    const key = norm(text);
    if (!key) return;
    const now = this.now();
    this.recent.set(key, now);
    for (const [k, at] of this.recent) if (now - at > ECHO_TTL) this.recent.delete(k);
  }

  #isEcho(text) {
    if (this.outPrefix && text.startsWith(this.outPrefix.trim())) return true;
    const now = this.now();
    for (const [k, at] of this.recent) if (now - at > ECHO_TTL) this.recent.delete(k);
    return this.recent.has(norm(text));
  }

  #isPendingOutFile(att) {
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

  #channelCaps() {
    const caps = this.transport?.capabilities;
    return caps && typeof caps === 'object' ? caps : null;
  }

  #effectiveResultChars() {
    const maxChars = Number(this.#channelCaps()?.maxChars ?? 0);
    return maxChars > 0 ? Math.min(this.resultChars, maxChars) : this.resultChars;
  }

  #effectiveSoftSplitChars() {
    const maxChars = Number(this.#channelCaps()?.maxChars ?? 0);
    const effRes = this.#effectiveResultChars();
    if (maxChars > 0) return Math.min(this.softSplitChars, maxChars);
    return Math.max(effRes, this.softSplitChars);
  }

  #supportsFiles() {
    const caps = this.#channelCaps();
    return typeof this.transport.sendFile === 'function'
      && this.transport.canFiles !== false
      && caps?.files !== false;
  }

  #supportsImages() {
    const caps = this.#channelCaps();
    return this.#supportsFiles() && caps?.images !== false;
  }

  emitTelemetry(type, data = {}) {
    try {
      this.onTelemetry?.({ ts: this.now(), type, ...data });
    } catch { /* ignore telemetry errors */ }
  }

  #recordInboundToContext(ev) {
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

  compactExternalChat(targetChat, preferredBot = null) { return compactExternalChat(this, targetChat, preferredBot); }
  listScheduledSummaries() { return this.scheduledSummaries.map((s) => ({ ...s })); }
  addScheduledSummary(spec) { return addScheduledSummary(this, spec); }
  setScheduledSummaryEnabled(idxOrId, enabled) { return setScheduledSummaryEnabled(this, idxOrId, enabled); }
  removeScheduledSummary(idxOrId) { return removeScheduledSummary(this, idxOrId); }
  runScheduledSummary(sched, opts) { return runScheduledSummary(this, sched, opts); }
  tickScheduledSummaries(nowMs = this.now()) { return tickScheduledSummaries(this, nowMs); }
  resolvePrivateDraft(opts) { return resolvePrivateDraft(this, opts); }
  requestSendBack(draft, overrideText = '') { return requestSendBack(this, draft, overrideText); }
  confirmSendBack() { return confirmSendBack(this); }
  searchAcrossChats(query, opts) { return searchAcrossChats(this, query, opts); }
  buildExternalSummaryPrompt(targetChat, opts) { return buildExternalSummaryPrompt(this, targetChat, opts); }

  getChatThread(chatId, targetBot) {
    if (!chatId || !targetBot || this.chats.isolateThreadsByChat === false) return targetBot;
    const cached = this.chatThreads.get(`${chatId}:${targetBot.id}`);
    return cached?.threadId ? { ...targetBot, threadId: cached.threadId } : targetBot;
  }

  setSelfThread(targetBot) {
    if (!targetBot?.id || !targetBot?.threadId || this.#isExternalThread(targetBot.threadId)) return;
    this.selfThreads.set(String(targetBot.id), {
      botId: targetBot.id,
      botName: targetBot.name,
      threadId: targetBot.threadId,
      ...(targetBot.isGroup ? { isGroup: true } : {}),
    });
    if (this.selfThreads.size > 100) this.selfThreads.delete(this.selfThreads.keys().next().value);
    this.saveState();
  }

  #isExternalThread(threadId) {
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
    if (!this.#isExternalThread(targetBot.threadId)) {
      this.setSelfThread(targetBot);
      return targetBot;
    }
    const saved = this.selfThreads.get(String(targetBot.id));
    if (saved?.threadId && !this.#isExternalThread(saved.threadId)) {
      return { ...targetBot, threadId: saved.threadId };
    }
    if (this.focus?.botId === targetBot.id && this.focus?.threadId && !this.#isExternalThread(this.focus.threadId)) {
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
      if (newTid && !this.#isExternalThread(newTid)) {
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

  async #ensureChatThread(chatId, chatType, chatName, targetBot) {
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

  async #buildPromptContext(ev, chatCtx, { skipSelfQuote = false } = {}) {
    if (!ev?.chat?.id) return { header: '', quotedMsg: null, recentMsgs: [], quotedAttachments: [], contextAttachments: [] };
    const common = {
      ev,
      privateReply: Boolean(chatCtx?.privateReply),
      contextWindow: this.chats.contextWindow,
      injectRecent: this.chats.injectRecentContext !== false,
      maxQuotedChars: this.chats.maxQuotedSnippetChars,
      maxRecentChars: this.chats.maxRecentMessageChars,
      skipSelfQuote,
      recentAttachmentWindowMs: this.chats.recentAttachmentWindowMs,
      maxAutoAttachments: this.chats.maxAutoAttachments,
    };
    if (this.imContext) return this.imContext.buildPromptContext(common);
    return assemblePromptContext({
      ...common,
      store: this.localContextStore,
      resolveMessage: async (cid, msgId) => {
        const cached = this.localContextStore.getMessage(cid, msgId);
        if (cached) return cached;
        if (typeof this.transport?.getMessage === 'function') {
          try {
            const remote = await this.transport.getMessage(cid, msgId);
            if (remote) return this.localContextStore.recordInbound(remote);
          } catch { /* ignore */ }
        }
        return null;
      },
      getHistory: async (cid, { limit, excludeMsgId } = {}) => this.localContextStore.getRecent(cid, { limit, excludeMsgId }),
    });
  }

  async sendOutboundFile(filePath, name, opts = {}) {
    const { chatId: targetChatId, recordContext, ...passOpts } = opts || {};
    const chatId = targetChatId || this.selfChat;
    if (!chatId || !this.#supportsFiles()) return null;
    const safe = safeAttachmentName(name || path.basename(filePath), 'file');
    let size = 0;
    try { size = fs.statSync(filePath).size; } catch { /* ignore */ }
    const exp = this.now() + 30_000;
    if (this.pendingOutFiles.size > 200) this.#pruneMemoryCaches();
    while (this.pendingOutFiles.size > 200) this.pendingOutFiles.delete(this.pendingOutFiles.keys().next().value);
    if (size > 0) this.pendingOutFiles.set(`${safe}:${size}`, exp);
    this.pendingOutFiles.set(safe, exp);
    const caps = this.#channelCaps();
    const safeOpts = caps?.replyTo === false && passOpts?.replyTo
      ? { ...passOpts, replyTo: undefined }
      : passOpts;
    const fid = await this.transport.sendFile(chatId, { path: filePath, name }, safeOpts);
    this.rememberOwnId(fid);
    if (recordContext) {
      this.recordOutboundToContext(chatId, {
        id: fid,
        text: `[附件: ${name || safe}]`,
        replyTo: safeOpts?.replyTo,
      });
    }
    return fid;
  }

  #isTransportDisconnected() {
    return this.transport?.status?.()?.connected === false;
  }

  #bufferOutbound(item) {
    const now = this.now();
    this.disconnectedBuffer = this.disconnectedBuffer.filter((x) => x.expiresAt > now);
    this.disconnectedBuffer.push(item);
    const cap = Math.max(1, Number(this.outboundBufferMax) || 30);
    while (this.disconnectedBuffer.length > cap) this.disconnectedBuffer.shift();
    this.emitTelemetry('outbound_buffered', {
      chatId: item.chatId,
      summary: item.text,
    });
  }

  #enqueueOutbound(chatId, fn) {
    const key = String(chatId || '_default');
    const prev = this.outboundQueue.get(key) ?? Promise.resolve();
    const task = prev.then(fn, fn);
    const tail = task.catch(() => {}).finally(() => {
      if (this.outboundQueue.get(key) === tail) this.outboundQueue.delete(key);
    });
    this.outboundQueue.set(key, tail);
    return task;
  }

  async drainOutbound(timeoutMs = 2000) {
    const pending = [...this.outboundQueue.values()];
    if (!pending.length) return;
    let timer;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((r) => { timer = setTimeout(r, timeoutMs); timer.unref?.(); }),
    ]);
    clearTimeout(timer);
  }

  async flushOutboundBuffer() {
    if (this.#isTransportDisconnected() || !this.disconnectedBuffer.length) return 0;
    const now = this.now();
    const items = this.disconnectedBuffer.splice(0).filter((it) => it.expiresAt > now);
    let replayed = 0;
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (this.#isTransportDisconnected()) {
        for (const rem of items.slice(i)) this.#bufferOutbound(rem);
        break;
      }
      const sid = await this.say(it.text, it.route, it.replyTo, it.actions, { chatId: it.chatId, noBuffer: true });
      if (sid != null) {
        replayed += 1;
        this.outboundReplayed += 1;
      }
    }
    if (replayed > 0) {
      this.emitTelemetry('outbound_replayed', { summary: `replayed=${replayed}` });
    }
    return replayed;
  }

  async say(text, route = null, replyTo = null, actions = null, extra = {}) {
    const chatId = extra?.chatId || route?.targetChatId || this.selfChat;
    if (!chatId) {
      if (!this.warnedMissingSelfChat) {
        this.warnedMissingSelfChat = true;
        console.warn('[omb-send] 尚未获知目标会话 ID，请先在自聊发一条消息或在 config.json 配置 ipc.selfChatId');
      }
      return null;
    }
    const caps = this.#channelCaps();
    const useMarkdown = Boolean(this.markdown && caps?.markdown !== false);
    const body = this.outPrefix + (useMarkdown ? hardBreaks(text) : plain(text));
    this.#remember(body);
    const opts = {
      ...(replyTo && caps?.replyTo !== false ? { replyTo } : {}),
      ...(Array.isArray(actions) && actions.length && caps?.actions !== false ? { actions } : {}),
    };

    return this.#enqueueOutbound(chatId, async () => {
      if (!extra?.noBuffer && this.#isTransportDisconnected()) {
        this.#bufferOutbound({
          chatId,
          text,
          route,
          replyTo,
          actions,
          expiresAt: this.now() + (Number(this.outboundBufferTtlMs) || 5 * 60_000),
        });
        return null;
      }
      const retries = Math.max(0, Number(this.sendRetries) || 0);
      let lastErr = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const sentId = await this.transport.send(chatId, body, opts);
          if (sentId != null) {
            const sid = String(sentId);
            rememberBounded(this.ownIds, sid, 2000);
            if (route?.botId) {
              this.msgRoute.set(sid, route);
              if (this.msgRoute.size > 500) this.msgRoute.delete(this.msgRoute.keys().next().value);
              this.saveState();
            }
            return sid;
          }
          return null;
        } catch (e) {
          lastErr = e;
          if (attempt < retries) {
            await new Promise((r) => setTimeout(r, (Number(this.sendRetryDelayMs) || 400) * (attempt + 1)));
            continue;
          }
          this.outboundFailures += 1;
          this.emitTelemetry('outbound_failed', { chatId, summary: e?.message || 'send failed' });
          if (!extra?.noBuffer && (this.#isTransportDisconnected() || extra?.bufferOnFail)) {
            this.#bufferOutbound({
              chatId,
              text,
              route,
              replyTo,
              actions,
              expiresAt: this.now() + (Number(this.outboundBufferTtlMs) || 5 * 60_000),
            });
          }
          console.error('[omb-send]', e.message);
        }
      }
      void lastErr;
      return null;
    });
  }

  getKnownBotNames() {
    const names = [this.trigger, ...(this.chats.triggerAliases || [])];
    for (const b of this.botById.values()) if (b?.name) names.push(b.name);
    for (const g of this.groupById.values()) if (g?.name) names.push(g.name);
    return names;
  }

  async #resolveBotTarget(mention, isDefault, ev) {
    let targetBot = null;
    let resolvedDefault = isDefault;
    if (isDefault) {
      targetBot = await this.client.resolveBot('');
    } else {
      targetBot = await this.client.resolveBot(mention);
      if (!targetBot && typeof this.client.resolveGroup === 'function') {
        const grp = await this.client.resolveGroup(mention);
        if (grp) targetBot = { ...grp, isGroup: true };
      }
      // 原生 IM `@自己` 触发时（mentionsMe=true），回退路由到默认主 Bot
      if (!targetBot && ev?.mentionsMe) {
        resolvedDefault = true;
        targetBot = await this.client.resolveBot('');
      }
    }
    return { targetBot, isDefault: resolvedDefault };
  }

  #buildExternalChatCtx({ isSelfChat, chatId, chatType, chatName, mid, privateReply, ev }) {
    const replyChatId = isSelfChat ? this.selfChat : (privateReply ? this.selfChat : chatId);
    return {
      isExternal: !isSelfChat,
      originChatId: chatId,
      chatType,
      chatName: chatName || this.externalChatMeta.get(chatId)?.name || '',
      replyChatId,
      controlChatId: !isSelfChat && this.chats.routeControlsToSelf !== false && this.selfChat ? this.selfChat : replyChatId,
      replyToImMsgId: !isSelfChat && !privateReply ? mid : null,
      originQuoteId: ev?.replyTo != null ? String(ev.replyTo) : null,
      privateReply: Boolean(!isSelfChat && privateReply),
      silentProgress: Boolean(!isSelfChat && this.chats.externalSilentProgress !== false),
      ev,
    };
  }

  async onEvent(ev) {
    if (!ev || !ev.id || !ev.chat?.id) return;
    if (this.disconnectedBuffer.length && !this.#isTransportDisconnected()) {
      this.flushOutboundBuffer().catch(() => {});
    }
    const chatId = String(ev.chat.id);
    const chatType = ev.chat.type || 'direct';
    const isSelfChat = chatType === 'self';
    const isSelfSender = Boolean(ev.sender?.isSelf);

    if (isSelfChat && isSelfSender && chatId !== this.learnedSelfChatId) {
      this.learnedSelfChatId = chatId;
      this.warnedMissingSelfChat = false;
      if (this.transport && !this.transport.selfChatId) this.transport.selfChatId = this.learnedSelfChatId;
      this.saveState();
    }

    const mid = String(ev.id);
    if (this.ownIds.has(mid)) return;
    if (this.seen.has(mid)) return;
    this.seen.add(mid);
    if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value);

    // 撤回事件：同步从内存上下文窗口、待用附件队列、消息路由和磁盘缓存擦除
    if (ev.kind === 'recall' && ev.recalledMsgId) {
      const recalledId = String(ev.recalledMsgId);
      if (this.imContext?.recallMessage) this.imContext.recallMessage(chatId, recalledId);
      else this.localContextStore.recallMessage(chatId, recalledId);
      this.fileMsgs.delete(recalledId);
      this.msgRoute.delete(recalledId);
      try {
        fs.rmSync(path.join(this.inDir, fileSafe(recalledId) || 'f'), { recursive: true, force: true });
      } catch { /* ignore */ }
      this.emitTelemetry('recall', { chatId, chatType, summary: `recall:${recalledId}` });
      return;
    }

    const rawText = String(ev.text ?? '').trim();
    if (isSelfSender && rawText && this.#isEcho(rawText)) return;

    const atts = Array.isArray(ev.attachments) ? ev.attachments : [];
    if (!rawText && atts.length && atts.every((a) => this.#isPendingOutFile(a))) {
      this.rememberOwnId(mid);
      return;
    }

    // 先将所有成员与本人的合法入站消息写入内存环形上下文，供引用与多轮对话理解使用
    this.#recordInboundToContext(ev);

    // 安全门槛：仅账号本人（sender.isSelf）可触发 Bot 执行或控制指令
    if (!isSelfSender) return;

    if (Array.isArray(this.commandDevices) && this.commandDevices.length) {
      const dev = ev.device ?? {};
      if (!this.commandDevices.some((d) => d === dev.type || d === dev.id)) return;
    }

    if (!isSelfChat && !isExternalChatAllowed(this, chatId, chatType)) return;

    if (atts.length) {
      this.fileMsgs.set(mid, { chatId, atts, at: this.now(), used: false });
      if (this.fileMsgs.size > 50) this.fileMsgs.delete(this.fileMsgs.keys().next().value);
    }

    const quotedId = ev.replyTo != null ? String(ev.replyTo) : null;
    const quotedCard = quotedId ? this.pendingCards.get(quotedId) : null;
    const quotedRoute = quotedId ? this.msgRoute.get(quotedId) : null;

    if (!rawText) {
      if (!atts.length) return;
      if (quotedRoute) {
        this.#clearPendingMedia();
        const chatCtx = this.#buildExternalChatCtx({
          isSelfChat,
          chatId,
          chatType,
          chatName: ev.chat?.name,
          mid,
          privateReply: false,
          ev,
        });
        await this.dispatchToBot(
          {
            id: quotedRoute.botId,
            name: quotedRoute.botName,
            threadId: quotedRoute.threadId,
            isGroup: Boolean(quotedRoute.isGroup),
          },
          '请查看我发送的附件。',
          mid,
          quotedId,
          quotedRoute.ombMsgId,
          chatCtx,
        );
      } else if (isSelfChat && this.isStickyActive() && this.imageBatchMs > 0) {
        this.pendingMediaIds.push(mid);
        this.pendingMediaTarget = {
          id: this.focus.botId,
          name: this.focus.botName,
          threadId: this.focus.threadId,
          isGroup: Boolean(this.focus.isGroup),
        };
        clearTimeout(this.pendingMediaTimer);
        this.pendingMediaTimer = setTimeout(() => {
          const target = this.pendingMediaTarget;
          const ids = [...this.pendingMediaIds];
          this.#clearPendingMedia();
          const hasUnused = ids.some((id) => {
            const ent = this.fileMsgs.get(id);
            return ent && !ent.used;
          });
          if (target && hasUnused) {
            this.dispatchToBot(target, '请查看我发送的图片/文件。', null, null, null).catch(() => {});
          }
        }, this.imageBatchMs);
        this.pendingMediaTimer.unref?.();
      }
      return;
    }

    if (isSelfChat) this.#clearPendingMedia();

    // 1. 待处理 OpenMausBot 审批卡、选项/提问卡或阻塞卡（仅在卡片对应会话或自聊裸回复触发）
    const activeCard = quotedCard ?? (isSelfChat && this.pendingCards.size === 1 ? [...this.pendingCards.values()][0] : null);
    if (activeCard && !rawText.startsWith('@')) {
      if (activeCard.cardKind && activeCard.cardKind !== 'card') {
        if (SKIP_RE.test(rawText)) return this.#dismissBlockCard(activeCard);
      } else if (activeCard.isQuestion) {
        const choice = parseChoiceIndex(rawText);
        if (choice) {
          const picked = activeCard.options?.[choice - 1];
          if (picked) return this.#answerCard(activeCard, 'answer', picked.label);
        }
        if (DENY_RE.test(rawText)) return this.#answerCard(activeCard, 'deny');
        if (quotedCard || !NOTE_PREFIX_RE.test(rawText)) {
          return this.#answerCard(activeCard, 'answer', rawText);
        }
      } else {
        if (ALWAYS_RE.test(rawText)) {
          return this.#answerCard(activeCard, 'allow', undefined, {
            always: true,
            rememberCommand: activeCard.canRememberCommand,
          });
        }
        if (APPROVE_RE.test(rawText)) return this.#answerCard(activeCard, 'allow');
        if (DENY_RE.test(rawText)) return this.#answerCard(activeCard, 'deny');
        if (quotedCard) return this.#answerCard(quotedCard, 'answer', rawText);
      }
    }

    // 1b. @bot tasks / @bot search 列表待选择序号（仅自聊）
    if (isSelfChat && !rawText.startsWith('@') && !quotedRoute && this.pendingTaskPick && this.now() < this.pendingTaskPick.expiresAt) {
      const choice = parseChoiceIndex(rawText);
      if (choice) {
        const picked = this.pendingTaskPick.tasks[choice - 1];
        if (picked) {
          return this.switchTask(
            this.pendingTaskPick.botId,
            this.pendingTaskPick.botName,
            picked,
            { isGroup: Boolean(this.pendingTaskPick.isGroup) },
          );
        }
      }
    }

    // 1c. @bot model 列表待选择序号（仅自聊）
    if (isSelfChat && !rawText.startsWith('@') && !quotedRoute && this.pendingModelPick && this.now() < this.pendingModelPick.expiresAt) {
      const choice = parseChoiceIndex(rawText);
      if (choice) {
        const picked = this.pendingModelPick.options[choice - 1];
        if (picked) {
          return this.applyModelSelection(
            { id: this.pendingModelPick.botId, name: this.pendingModelPick.botName },
            this.pendingModelPick.threadId,
            { instanceId: picked.instanceId, model: picked.id },
            picked.id,
          );
        }
      }
    }

    // 1c-bis. 自聊私密草稿确认回发（确认发送 / 取消 / 改：...）
    if (isSelfChat && !rawText.startsWith('@') && !quotedRoute && this.pendingSendBack && this.now() < this.pendingSendBack.expiresAt) {
      if (/^(?:确认发送|确认|发送|send|ok|yes|好|好的)$/i.test(rawText)) return this.confirmSendBack();
      if (/^(?:取消|算了|不要|cancel|no)$/i.test(rawText)) {
        this.pendingSendBack = null;
        return this.say('❎ 已取消发回原群。');
      }
      const editM = rawText.match(/^(?:改|修改|替换)[:：\s]+([\s\S]+)$/);
      if (editM && editM[1].trim()) {
        return this.requestSendBack(this.pendingSendBack.draft, editM[1].trim());
      }
    }

    // 1d. 有排队中消息时，允许在自聊裸回复 steer/插队 或 取消排队
    if (isSelfChat && !rawText.startsWith('@') && !quotedRoute && this.queuedByThread.size > 0) {
      if (/^(steer|插队)$/i.test(rawText)) return this.steerLatestQueue(this.focus?.threadId);
      if (/^(取消排队)$/i.test(rawText)) return this.cancelLatestQueue(this.focus?.threadId);
    }

    // 2. 解析 @bot / @bot! / 句中 @bot / 结构化 mentions / @<BotName> / @<GroupName>、引用气泡、或自聊连续对话粘性窗口
    const knownNames = this.getKnownBotNames();
    let targetBot = null;
    let bodyText = '';
    let replyToOmbId = null;
    let privateReply = false;

    let parsed = parseStartMention(rawText, this.trigger, this.chats.triggerAliases, knownNames);
    if (parsed) {
      const resolved = await this.#resolveBotTarget(parsed.mention, parsed.isDefault, ev);
      if (resolved.targetBot) {
        targetBot = resolved.targetBot;
        parsed = { ...parsed, isDefault: resolved.isDefault };
      } else {
        // 句首 @他人（如「@Alice 别急，@bot 帮查下」）：尝试在句中继续查找 @bot/@<BotName>
        parsed = null;
      }
    }
    if (!parsed) {
      const inlineParsed = parseInlineTriggerMention(rawText, this.trigger, this.chats.triggerAliases, knownNames);
      if (inlineParsed) {
        const resolved = await this.#resolveBotTarget(inlineParsed.mention, inlineParsed.isDefault, ev);
        if (resolved.targetBot) {
          targetBot = resolved.targetBot;
          parsed = { ...inlineParsed, isDefault: resolved.isDefault };
        }
      }
    }
    if (!parsed && Array.isArray(ev.mentions) && ev.mentions.length) {
      const structParsed = parseStructuredBotMention(rawText, ev.mentions, this.trigger, this.chats.triggerAliases, knownNames);
      if (structParsed) {
        const resolved = await this.#resolveBotTarget(structParsed.mention, structParsed.isDefault, ev);
        if (resolved.targetBot) {
          targetBot = resolved.targetBot;
          parsed = { ...structParsed, isDefault: resolved.isDefault };
        }
      }
    }

    if (parsed && targetBot) {
      bodyText = parsed.bodyText;
      privateReply = Boolean(!isSelfChat && parsed.bang);
      if (!isSelfChat && this.chats.privateFlag !== false && bodyText) {
        const privM = bodyText.match(/^(?:-p|--private)(?:\s+([\s\S]*))?$/i);
        if (privM) {
          privateReply = true;
          bodyText = (privM[1] ?? '').trim();
        }
      }
      if (!isSelfChat && privateReply && !this.selfChat) {
        console.warn('[omb-bridge] 收到私密回复指令（@bot! / -p），但尚未获知 selfChatId；请先在自聊发一条消息或配置 ipc.selfChatId');
        return;
      }

      const scopedTarget = !isSelfChat
        ? this.getChatThread(chatId, targetBot)
        : await this.resolveSelfBotThread(targetBot);
      const chatCtx = this.#buildExternalChatCtx({
        isSelfChat,
        chatId,
        chatType,
        chatName: ev.chat?.name,
        mid,
        privateReply,
        ev,
      });

      if (parsed.atStart && await handleCommand(this, bodyText, {
        isDefault: parsed.isDefault,
        targetBot: scopedTarget,
        quotedRoute,
        mid,
        quotedId,
        hasAttachments: atts.length > 0,
        chatCtx,
      })) {
        return;
      }
      targetBot = !isSelfChat ? await this.#ensureChatThread(chatId, chatType, chatCtx.chatName, targetBot) : scopedTarget;
      if (quotedRoute && quotedRoute.botId === targetBot.id && quotedRoute.threadId === targetBot.threadId) {
        replyToOmbId = quotedRoute.ombMsgId ?? null;
      }

      const polishSource = isSelfChat && quotedId ? this.privateDrafts.get(quotedId) : null;
      if (polishSource?.originChatId && polishSource.createdAt >= (this.now() - (Number(this.draftTtlMs) || 30 * 60_000))) {
        chatCtx.polishDraft = {
          originChatId: polishSource.originChatId,
          originChatName: polishSource.originChatName || polishSource.originChatId,
          originChatType: polishSource.originChatType || 'group',
          replyToImMsgId: polishSource.replyToImMsgId ?? null,
        };
        const ask = bodyText || '请进一步精简润色这版草稿，保持意思准确。';
        const promptForDraft = `[待润色草稿 · 原目标会话「${chatCtx.polishDraft.originChatName}」]\n${polishSource.rawText}\n\n[改写要求]\n${ask}`;
        return this.dispatchToBot(targetBot, promptForDraft, mid, quotedId, replyToOmbId, chatCtx);
      }

      if (!bodyText && !atts.length) {
        if (!quotedId) {
          return this.say(buildHelpText(this), { targetChatId: chatCtx.replyChatId }, chatCtx.replyToImMsgId);
        }
        return this.dispatchToBot(targetBot, '请查看并回复我引用的这条消息。', mid, quotedId, replyToOmbId, chatCtx);
      }
      return this.dispatchToBot(targetBot, bodyText || '请查看附件', mid, quotedId, replyToOmbId, chatCtx);
    }

    if (quotedRoute) {
      // 外部群里引用 Bot 回复但显式 @同事（未再 @bot），视作向同事交接/讨论，不重触发 Bot
      if (!isSelfChat && hasNonBotMention(rawText, this.trigger, this.chats.triggerAliases, knownNames, ev.mentions)) {
        return;
      }
      bodyText = rawText;
      if (!isSelfChat && this.chats.privateFlag !== false) {
        const privM = bodyText.match(/^(?:-p|--private)(?:\s+([\s\S]*))?$/i);
        if (privM) {
          privateReply = true;
          bodyText = (privM[1] ?? '').trim();
        }
      }
      if (!isSelfChat && privateReply && !this.selfChat) {
        console.warn('[omb-bridge] 收到私密回复指令（-p），但尚未获知 selfChatId；请先在自聊发一条消息或配置 ipc.selfChatId');
        return;
      }
      targetBot = {
        id: quotedRoute.botId,
        name: quotedRoute.botName,
        threadId: quotedRoute.threadId,
        isGroup: Boolean(quotedRoute.isGroup),
      };
      replyToOmbId = quotedRoute.ombMsgId ?? null;
      const chatCtx = this.#buildExternalChatCtx({
        isSelfChat,
        chatId,
        chatType,
        chatName: ev.chat?.name,
        mid,
        privateReply,
        ev,
      });
      const polishSource = isSelfChat && quotedId ? this.privateDrafts.get(quotedId) : null;
      if (polishSource?.originChatId && polishSource.createdAt >= (this.now() - (Number(this.draftTtlMs) || 30 * 60_000))) {
        chatCtx.polishDraft = {
          originChatId: polishSource.originChatId,
          originChatName: polishSource.originChatName || polishSource.originChatId,
          originChatType: polishSource.originChatType || 'group',
          replyToImMsgId: polishSource.replyToImMsgId ?? null,
        };
        const ask = bodyText || '请进一步精简润色这版草稿，保持意思准确。';
        const promptForDraft = `[待润色草稿 · 原目标会话「${chatCtx.polishDraft.originChatName}」]\n${polishSource.rawText}\n\n[改写要求]\n${ask}`;
        return this.dispatchToBot(targetBot, promptForDraft, mid, quotedId, replyToOmbId, chatCtx);
      }
      if (!bodyText && !atts.length) {
        return this.say(buildHelpText(this), { targetChatId: chatCtx.replyChatId }, chatCtx.replyToImMsgId);
      }
      return this.dispatchToBot(targetBot, bodyText || '请查看附件', mid, quotedId, replyToOmbId, chatCtx);
    }

    if (isSelfChat && this.isStickyActive() && !NOTE_PREFIX_RE.test(rawText)) {
      if (BYE_RE.test(rawText)) {
        this.lastBotReplyAt = 0;
        return this.say('👋 已结束连续对话，之后普通消息将作为自聊笔记不再打扰。');
      }
      bodyText = rawText;
      targetBot = {
        id: this.focus.botId,
        name: this.focus.botName,
        threadId: this.focus.threadId,
        isGroup: Boolean(this.focus.isGroup),
      };
      targetBot = await this.resolveSelfBotThread(targetBot);
      return this.dispatchToBot(
        targetBot,
        bodyText || '请查看附件',
        mid,
        quotedId,
        replyToOmbId,
        this.#buildExternalChatCtx({ isSelfChat: true, chatId, chatType, chatName: ev.chat?.name, mid, privateReply: false, ev }),
      );
    }
  }

  #deleteCard(card) {
    for (const [k, v] of this.pendingCards) {
      const sameReq = card.requestId && v.requestId === card.requestId;
      const sameMsg = card.ombMsgId && v.ombMsgId && v.ombMsgId === card.ombMsgId;
      if (sameReq || sameMsg || k === card.imMsgId) {
        this.pendingCards.delete(k);
      }
    }
    this.saveState();
  }

  async #dismissBlockCard(card) {
    const cardBotId = card.cardBotId || card.botId;
    const ctrlChatId = this.resolveControlChatId(card.chatCtx);
    const route = {
      botId: card.botId,
      botName: card.botName,
      threadId: card.threadId,
      ombMsgId: card.ombMsgId,
      ...(card.isGroup ? { isGroup: true } : {}),
      ...(ctrlChatId ? { targetChatId: ctrlChatId } : {}),
    };
    try {
      try {
        if (card.cardKind === 'secret') {
          await this.client.dismissSecretCard(cardBotId, card.ombMsgId, card.threadId);
        } else if (card.cardKind === 'connector') {
          await this.client.dismissConnectorCard(cardBotId, card.ombMsgId, card.threadId);
        } else if (card.cardKind === 'signIn') {
          await this.client.cancelSignInCard(cardBotId, card.ombMsgId, card.threadId);
        }
      } catch (e) {
        if (e?.status === 404 || e?.status === 409 || e?.status === 410) this.#deleteCard(card);
        throw e;
      }
      this.#deleteCard(card);
      this.emitTelemetry('card_dismiss', { botName: card.botName, kind: card.cardKind });
      if (!card.chatCtx?.isExternal) this.lastBotReplyAt = this.now();
      await this.say('⏭ 已跳过该步骤，继续执行。', route);
    } catch (e) {
      await this.say(`⚠️ 跳过操作失败：${formatOmbError(e)}`, route);
    }
  }

  async #answerCard(card, behavior, message, opts = {}) {
    const ctrlChatId = this.resolveControlChatId(card.chatCtx);
    const route = {
      botId: card.botId,
      botName: card.botName,
      threadId: card.threadId,
      ombMsgId: card.ombMsgId,
      ...(card.isGroup ? { isGroup: true } : {}),
      ...(ctrlChatId ? { targetChatId: ctrlChatId } : {}),
    };
    try {
      if (!card.requestId) {
        this.#deleteCard(card);
        const text = message ?? (behavior === 'allow' ? 'ok' : 'no');
        return this.dispatchToBot(
          { id: card.botId, name: card.botName, threadId: card.threadId, isGroup: Boolean(card.isGroup) },
          text,
          null,
          null,
          card.ombMsgId,
          card.chatCtx ?? null,
        );
      }

      const payload = {
        requestId: card.requestId,
        behavior,
        ...(message !== undefined ? { message } : {}),
        ...(opts.always ? { always: true } : {}),
        ...(opts.rememberCommand ? { rememberCommand: true } : {}),
      };
      try {
        await this.client.respond(card.threadId, payload);
      } catch (e) {
        if (opts.rememberCommand && e?.status === 403) {
          delete payload.rememberCommand;
          await this.client.respond(card.threadId, payload);
        } else {
          if (e?.status === 404 || e?.status === 409 || e?.status === 410) this.#deleteCard(card);
          throw e;
        }
      }
      this.#deleteCard(card);
      this.emitTelemetry('card_answer', { botName: card.botName, kind: behavior });
      if (!card.chatCtx?.isExternal) this.lastBotReplyAt = this.now();
      const label = behavior === 'allow'
        ? (opts.always ? '已设为总是允许，继续执行' : '已允许，继续执行')
        : behavior === 'deny'
          ? '已拒绝该操作'
          : (message ? `已选择「${clip(message, 40)}」，继续执行` : '已提交回复，继续执行');
      await this.say(`✅ ${label}`, route);
    } catch (e) {
      await this.say(`⚠️ 审批提交失败：${formatOmbError(e)}`, route);
    }
  }

  #pickQueuedEntry(preferredThreadId) {
    if (preferredThreadId && this.queuedByThread.get(preferredThreadId)?.length) {
      return { threadId: preferredThreadId, list: this.queuedByThread.get(preferredThreadId) };
    }
    for (const [tid, list] of this.queuedByThread) {
      if (list.length) return { threadId: tid, list };
    }
    return null;
  }

  #removeQueued(threadId, queueId) {
    const list = this.queuedByThread.get(threadId);
    if (!list) return null;
    const idx = list.findIndex((q) => q.queueId === queueId);
    if (idx < 0) return null;
    const [removed] = list.splice(idx, 1);
    if (!list.length) this.queuedByThread.delete(threadId);
    return removed;
  }

  async steerLatestQueue(preferredThreadId, targetChatId = null) {
    const hit = this.#pickQueuedEntry(preferredThreadId);
    if (!hit) {
      await this.say('当前没有排队中的消息。', targetChatId ? { targetChatId } : null);
      return;
    }
    const q = hit.list.at(-1);
    const outChatId = targetChatId || q.chatCtx?.controlChatId || this.selfChat;
    const route = { botId: q.botId, botName: q.botName, threadId: q.threadId, ...(q.isGroup ? { isGroup: true } : {}), ...(outChatId ? { targetChatId: outChatId } : {}) };
    try {
      const res = q.isGroup && typeof this.client.steerGroupQueued === 'function'
        ? await this.client.steerGroupQueued(q.botId, q.queueId, q.threadId)
        : await this.client.steerQueued(q.botId, q.queueId, q.threadId);
      if (res?.queued) {
        await this.say(`⏳ 当前工具执行暂不支持直接插队${res.blockedBy ? `（${res.blockedBy}）` : ''}，已保留在队列等待上一轮完成。`, route);
        return;
      }
      this.#removeQueued(q.threadId, q.queueId);
      this.steeredQueue.set(q.sendId, q);
      if (this.steeredQueue.size > 50) this.steeredQueue.delete(this.steeredQueue.keys().next().value);
      await this.say(`⚡ 已插队注入当前任务：「${clip(q.text, 50)}」`, route);
    } catch (e) {
      await this.say(`❌ 插队失败：${formatOmbError(e)}`, outChatId ? { targetChatId: outChatId } : null);
    }
  }

  async cancelLatestQueue(preferredThreadId, targetChatId = null) {
    const hit = this.#pickQueuedEntry(preferredThreadId);
    if (!hit) {
      await this.say('当前没有排队中的消息。', targetChatId ? { targetChatId } : null);
      return;
    }
    const q = hit.list.at(-1);
    const outChatId = targetChatId || q.chatCtx?.controlChatId || this.selfChat;
    const route = { botId: q.botId, botName: q.botName, threadId: q.threadId, ...(q.isGroup ? { isGroup: true } : {}), ...(outChatId ? { targetChatId: outChatId } : {}) };
    try {
      if (q.isGroup && typeof this.client.cancelGroupQueued === 'function') {
        await this.client.cancelGroupQueued(q.botId, q.queueId);
      } else {
        await this.client.cancelQueued(q.botId, q.queueId, q.threadId);
      }
      this.#removeQueued(q.threadId, q.queueId);
      await this.say(`🗑 已取消排队消息：「${clip(q.text, 50)}」`, route);
    } catch (e) {
      await this.say(`❌ 取消排队失败：${formatOmbError(e)}`, outChatId ? { targetChatId: outChatId } : null);
    }
  }

  async collectBotTasks(target) {
    const { bots = [], groups = [] } = await this.client.listBots();
    const isGroup = Boolean(target.isGroup);
    const fresh = (isGroup ? groups.find((g) => g.id === target.id) : bots.find((b) => b.id === target.id)) ?? target;
    const list = Array.isArray(fresh.tasks) ? [...fresh.tasks] : [];
    list.sort((a, b) => (b.updatedAt ?? b.lastThreadOrderAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.lastThreadOrderAt ?? a.createdAt ?? 0));
    const top = list.slice(0, 5);
    return { fresh, top };
  }

  async switchTask(defaultBotId, defaultBotName, task, { isGroup = false, chatId = null } = {}) {
    const botId = task.botId ?? defaultBotId;
    const botName = task.botName ?? defaultBotName;
    const tid = task.threadId ?? task.id;
    this.clearPickers();
    const route = { botId, botName, threadId: tid, ...(isGroup ? { isGroup: true } : {}), ...(chatId ? { targetChatId: chatId } : {}) };
    try {
      if (isGroup && typeof this.client.selectGroupTask === 'function') {
        await this.client.selectGroupTask(botId, tid);
        this.groupByThread.set(tid, { id: botId, name: botName, threadId: tid, isGroup: true });
      } else {
        await this.client.selectTask(botId, tid);
        this.botByThread.set(tid, { id: botId, name: botName, threadId: tid });
      }
      this.focus = { botId, botName, threadId: tid, ...(isGroup ? { isGroup: true } : {}) };
      this.setSelfThread({ id: botId, name: botName, threadId: tid, isGroup });
      this.lastBotReplyAt = this.now();
      this.saveState();
      const title = clip(task.title || '未命名会话', 50);
      await this.say(`🔀 已切换到 **${botName}** 的会话「${title}」，直接发消息即可续聊。`, route);
    } catch (e) {
      await this.say(`❌ 切换会话失败：${formatOmbError(e)}`, chatId ? { targetChatId: chatId } : null);
    }
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

  async applyModelSelection(bot, threadId, selection, labelDesc, targetChatId = null) {
    this.clearPickers();
    try {
      await this.withCliLoopbackFallback(async (c) => {
        if (typeof c.patchTask === 'function' && threadId) {
          try {
            return await c.patchTask(bot.id, threadId, { modelSelection: selection });
          } catch (err) {
            if (err?.status !== 404) throw err;
          }
        }
        return c.patchBot(bot.id, { modelSelection: selection });
      });
      await this.refreshMultiBot();
      if (!targetChatId || targetChatId === this.selfChat) this.lastBotReplyAt = this.now();
      await this.say(`🧠 已将 **${bot.name}** 当前会话模型切换为 \`${labelDesc}\`。`, {
        botId: bot.id, botName: bot.name, threadId, ...(targetChatId ? { targetChatId } : {}),
      });
    } catch (e) {
      await this.say(`❌ 切换模型失败：${formatOmbError(e)}`, targetChatId ? { targetChatId } : null);
    }
  }

  async #maybeWarnHighContext(botId, threadId, chatCtx = null) {
    if (!threadId) return;
    if (chatCtx?.isExternal && !this.selfChat) return;
    try {
      const bots = await this.refreshMultiBot();
      const bot = bots.find((b) => b.id === botId);
      const task = (bot?.tasks ?? []).find((t) => (t.threadId ?? t.id) === threadId) ?? bot?.tasks?.[0];
      const ctx = task?.usage?.context;
      if (!ctx?.window || !ctx?.tokens) return;
      const ratio = ctx.tokens / ctx.window;
      const pct = Math.min(100, Math.round(ratio * 100));
      const autoThresh = Number(this.chats.autoCompactThreshold ?? 0.92);

      if (chatCtx?.isExternal && autoThresh > 0 && ratio >= autoThresh && typeof this.client.compact === 'function') {
        const lastAt = this.lastAutoCompactAt.get(threadId) || 0;
        if ((this.now() - lastAt) >= 5 * 60_000) {
          this.lastAutoCompactAt.set(threadId, this.now());
          if (this.lastAutoCompactAt.size > 200) this.lastAutoCompactAt.delete(this.lastAutoCompactAt.keys().next().value);
          await this.client.compact(botId, threadId);
          this.contextWarnedThreads.delete(threadId);
          const originLabel = chatCtx.chatName || chatCtx.originChatId;
          await this.say(
            `📍 **来自「${originLabel}」的会话维护**\n🗜️ 该群隔离上下文已达 ${pct}%（${fmtTokens(ctx.tokens)} / ${fmtTokens(ctx.window)}），已自动后台压缩，群内零打扰。`,
            { botId, botName: bot?.name ?? 'MausBot', threadId, targetChatId: this.selfChat },
          );
        }
        return;
      }

      if (this.contextWarnedThreads.has(threadId) || ratio < 0.8) return;
      rememberBounded(this.contextWarnedThreads, threadId, 200);
      const cmdTarget = botCommandTarget(this, botId, bot?.name);
      const compactCmd = chatCtx?.isExternal ? `${cmdTarget} compact ${chatCtx.originChatId}` : `${cmdTarget} compact`;
      const originBanner = chatCtx?.isExternal
        ? `📍 **来自「${chatCtx.chatName || chatCtx.originChatId}」的会话提醒**\n`
        : '';
      await this.say(
        `${originBanner}💡 当前会话上下文已达 ${pct}%（${fmtTokens(ctx.tokens)} / ${fmtTokens(ctx.window)}），建议发 \`${compactCmd}\` 压缩以保持准确度。`,
        { botId, botName: bot?.name ?? 'MausBot', threadId, ...(chatCtx?.isExternal && this.selfChat ? { targetChatId: this.selfChat } : {}) },
        null,
        [{ label: chatCtx?.isExternal ? '压缩该群会话' : '立即压缩', text: compactCmd, kind: 'primary' }],
      );
    } catch { /* 上下文提醒失败不影响主回复 */ }
  }

  async #claimUploads(mid, quotedId, originChatId = null, contextAttachments = [], errChatId = null) {
    const ids = [];
    if (mid && this.fileMsgs.has(mid)) ids.push(mid);
    if (quotedId && this.fileMsgs.has(quotedId)) ids.push(quotedId);
    if (!ids.length && (!Array.isArray(contextAttachments) || !contextAttachments.length)) {
      const now = this.now();
      for (const [id, entry] of this.fileMsgs) {
        if (!entry.used && now - entry.at < FILE_TTL && (!originChatId || !entry.chatId || entry.chatId === originChatId)) {
          ids.push(id);
        }
      }
    }
    const uploaded = [];
    const seenKeys = new Set();
    const processOne = async (attIdKey, msgIdForPath, a) => {
      if (!a || a.id == null || typeof this.transport.download !== 'function') return;
      if (seenKeys.has(attIdKey)) return;
      seenKeys.add(attIdKey);
      const safe = safeAttachmentName(a.name, 'file');
      const dest = path.join(this.inDir, fileSafe(msgIdForPath) || 'f', safe);
      try {
        if (!fs.existsSync(dest)) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          await this.transport.download(a, dest);
        }
        const buf = fs.readFileSync(dest);
        const ext = path.extname(safe).toLowerCase();
        const mime = a.mime || IMAGE_MIME[ext] || 'application/octet-stream';
        const isImg = mime.startsWith('image/') && Boolean(IMAGE_MIME[ext] || MIME_EXT[mime.toLowerCase()]);
        const res = isImg
          ? await this.client.uploadImage(buf, mime)
          : await this.client.uploadFile(a.name || safe, buf, mime);
        uploaded.push({
          kind: isImg ? 'image' : 'file',
          name: a.name || safe,
          path: res?.path || res?.url || dest,
        });
      } catch (e) {
        const failTarget = errChatId || this.selfChat;
        if (failTarget) {
          await this.say(`📎 附件 ${a.name} 上传失败：${formatOmbError(e)}`, { targetChatId: failTarget });
        }
      }
    };

    for (const id of ids) {
      const entry = this.fileMsgs.get(id);
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
    return uploaded;
  }

  async dispatchToBot(bot, text, imMsgId, quotedId, replyToOmbId, chatCtx = null) {
    const ctxInfo = chatCtx ?? this.#buildExternalChatCtx({
      isSelfChat: true,
      chatId: this.selfChat,
      chatType: 'self',
      mid: null,
      privateReply: false,
      ev: null,
    });
    const isExternal = Boolean(ctxInfo.isExternal);
    const isGroup = Boolean(bot.isGroup);
    let threadId = bot.threadId;

    const promptCtx = ctxInfo.preformattedHeader !== undefined
      ? { header: ctxInfo.preformattedHeader, quotedMsg: null, recentMsgs: [], quotedAttachments: [], contextAttachments: [] }
      : await this.#buildPromptContext(ctxInfo.ev, ctxInfo, {
          skipSelfQuote: Boolean(!isExternal && replyToOmbId),
        });
    const uploads = await this.#claimUploads(
      imMsgId,
      quotedId,
      ctxInfo.originChatId,
      promptCtx.contextAttachments ?? promptCtx.quotedAttachments,
      ctxInfo.controlChatId,
    );
    let outboundText = `${promptCtx.header || ''}${text}`;
    if (uploads.length) {
      const tags = uploads.map((u) => formatAttachmentTag(u));
      outboundText = `${outboundText}\n\n${tags.join('\n')}`;
    }

    const sendId = `cobot_${crypto.randomUUID().replace(/-/g, '')}`;
    if (!isExternal) {
      this.focus = { botId: bot.id, botName: bot.name, threadId, ...(isGroup ? { isGroup: true } : {}) };
      this.setSelfThread({ ...bot, threadId });
      this.saveState();
    }
    await this.refreshMultiBot();
    this.emitTelemetry('dispatch', {
      botName: bot.name,
      isGroup,
      chatId: ctxInfo.originChatId || null,
      chatType: ctxInfo.chatType || 'self',
      privateReply: Boolean(ctxInfo.privateReply),
      summary: text,
    });

    const sendReq = (tid) => (isGroup && typeof this.client.sendGroupMessage === 'function'
      ? this.client.sendGroupMessage(bot.id, { text: outboundText, threadId: tid, sendId, replyToId: replyToOmbId })
      : this.client.sendMessage(bot.id, { text: outboundText, threadId: tid, sendId, replyToId: replyToOmbId }));

    let receipt;
    this.pendingThreads.add(threadId);
    try {
      try {
        receipt = await sendReq(threadId);
      } catch (e) {
        if (isExternal && e?.status === 404 && ctxInfo.originChatId) {
          this.pendingThreads.delete(threadId);
          this.chatThreads.delete(`${ctxInfo.originChatId}:${bot.id}`);
          const refreshed = await this.#ensureChatThread(ctxInfo.originChatId, ctxInfo.chatType, ctxInfo.chatName, bot);
          threadId = refreshed.threadId;
          this.pendingThreads.add(threadId);
          receipt = await sendReq(threadId);
        } else {
          throw e;
        }
      }
    } catch (e) {
      const errTarget = ctxInfo.controlChatId || ctxInfo.replyChatId || this.selfChat;
      const errBanner = isExternal && errTarget === this.selfChat
        ? `📍 **来自「${ctxInfo.chatName || ctxInfo.originChatId}」**\n`
        : '';
      return this.say(`${errBanner}❌ 发送给 **${bot.name}** 失败：${formatOmbError(e)}`, errTarget ? { targetChatId: errTarget } : null);
    } finally {
      this.pendingThreads.delete(threadId);
    }

    const alreadyTracking = [...this.activeTurns.values()].some((t) => t.threadId === threadId);
    const compactCtx = compactChatCtx(ctxInfo);
    const route = {
      botId: bot.id,
      botName: bot.name,
      threadId,
      ...(isGroup ? { isGroup: true } : {}),
      ...(ctxInfo.replyChatId ? { targetChatId: ctxInfo.replyChatId } : {}),
      ...(compactCtx ? {
        originChatId: compactCtx.originChatId,
        originChatName: compactCtx.chatName,
        originChatType: compactCtx.chatType,
        privateReply: compactCtx.privateReply,
      } : {}),
    };

    if (receipt?.queued === true) {
      const queueId = receipt.queueId || sendId;
      const list = this.queuedByThread.get(threadId) ?? [];
      list.push({ queueId, botId: bot.id, botName: bot.name, threadId, isGroup, text, sendId, at: this.now(), chatCtx: compactCtx });
      this.queuedByThread.set(threadId, list);
      const who = this.botPrefix(bot.id, bot.name, { isGroup });
      const cmdTarget = isGroup ? `@${bot.name}` : this.trigger;
      const ctrlChat = this.resolveControlChatId(ctxInfo);
      const ctrlBanner = isExternal && ctrlChat === this.selfChat
        ? `📍 **来自「${ctxInfo.chatName || ctxInfo.originChatId}」**\n`
        : '';
      await this.say(
        `${ctrlBanner}📥 ${who ? `${who} ` : ''}已排队，等当前任务完成后自动继续。\n回复 \`${cmdTarget} steer\` 立即插队，或 \`${cmdTarget} cancel\` 取消排队。`,
        { ...route, ...(ctrlChat ? { targetChatId: ctrlChat } : {}) },
        null,
        [
          { label: '立即插队', text: `${cmdTarget} steer`, kind: 'primary' },
          { label: '取消排队', text: `${cmdTarget} cancel`, kind: 'danger' },
        ],
      );
      return receipt;
    }

    const reqMsgId = receipt?.message?.id ?? null;
    if (reqMsgId) rememberBounded(this.ownReqIds, reqMsgId);

    if (receipt?.steered === true && alreadyTracking) {
      if (!isExternal || ctxInfo.controlChatId === this.selfChat) {
        const ctrlChat = this.resolveControlChatId(ctxInfo);
        await this.say('⚡ 已将补充信息插入当前任务。', { ...route, ...(ctrlChat ? { targetChatId: ctrlChat } : {}) });
      }
      return receipt;
    }

    const turn = this.#trackTurn({
      key: reqMsgId || `${threadId}:${sendId}`,
      botId: bot.id,
      botName: bot.name,
      threadId,
      reqMsgId,
      sendId,
      isGroup,
      chatCtx: compactCtx,
    });
    turn.startWatcher();
    if (isExternal && ctxInfo.silentProgress && this.chats.externalAckInSelf && this.selfChat) {
      const cmdTarget = isGroup || (this.chiefBotId && bot.id !== this.chiefBotId) ? `@${bot.name}` : this.trigger;
      this.say(
        `⏳ 已收到来自「${ctxInfo.chatName || ctxInfo.originChatId}」的提问，正在后台处理…`,
        { botId: bot.id, botName: bot.name, threadId, ...(isGroup ? { isGroup: true } : {}), targetChatId: this.selfChat },
        null,
        [{ label: '停止', text: `${cmdTarget} stop`, kind: 'danger' }],
      ).catch(() => {});
    }
    return receipt;
  }

  async #emitCard(botId, botName, threadId, msg, { isGroup = false, chatCtx = null } = {}) {
    const cid = msg.card?.requestId || msg.id;
    if (!cid || this.deliveredCards.has(cid)) return;
    rememberBounded(this.deliveredCards, cid);
    const cardKind = msg.card
      ? 'card'
      : (msg.secret ? 'secret' : (msg.connector ? 'connector' : (msg.signIn ? 'signIn' : null)));
    const speakerName = isGroup ? (msg.from?.name || '') : '';
    const isExternal = Boolean(chatCtx?.isExternal);
    const ctrlChat = this.resolveControlChatId(chatCtx);
    const route = {
      botId,
      botName,
      threadId,
      ombMsgId: msg.id,
      ...(isGroup ? { isGroup: true } : {}),
      ...(ctrlChat ? { targetChatId: ctrlChat } : {}),
    };
    const who = this.botPrefix(botId, botName, { isGroup, speakerName });
    const prompt = formatCardPrompt(botName, msg, who);
    const originBanner = isExternal && ctrlChat === this.selfChat
      ? `📍 **来自「${chatCtx.chatName || chatCtx.originChatId}」的审批 / 确认**\n`
      : '';
    const sentId = await this.say(`${originBanner}${prompt.text}`, route, null, prompt.actions);
    this.emitTelemetry('card', { botName, kind: cardKind || 'card', summary: prompt.text });
    if (sentId && cardKind) {
      this.pendingCards.set(sentId, {
        imMsgId: sentId,
        cardKind,
        cardBotId: msg.from?.botId || botId,
        requestId: msg.card?.requestId ?? null,
        threadId,
        botId,
        botName,
        ...(isGroup ? { isGroup: true } : {}),
        ombMsgId: msg.id,
        isQuestion: Boolean(prompt.info?.isQuestion),
        options: prompt.info?.options ?? [],
        canRememberCommand: Boolean(prompt.info?.canRememberCommand),
        ...(compactChatCtx(chatCtx) ? { chatCtx: compactChatCtx(chatCtx) } : {}),
      });
      this.saveState();
    }
  }

  async #forwardBotMedia(threadId, msgs, { chatId = null, replyTo = null } = {}) {
    const canFiles = this.#supportsFiles();
    const canImages = this.#supportsImages();
    if (!canFiles && !canImages) return;
    const outOpts = {
      ...(chatId ? { chatId } : {}),
      ...(replyTo ? { replyTo } : {}),
      recordContext: true,
    };
    for (const msg of msgs) {
      if (!msg?.id) continue;
      if (canImages && (msg.kind === 'screen' || msg.hasImage)) {
        const k = `${msg.id}:__image__`;
        if (!this.deliveredMedia.has(k)) {
          rememberBounded(this.deliveredMedia, k);
          try {
            const { buf, mime } = await this.client.downloadMessageImage(threadId, msg.id);
            const ext = MIME_EXT[mime.split(';')[0].trim().toLowerCase()] || '.png';
            const name = `image-${String(msg.id).slice(0, 8)}${ext}`;
            fs.mkdirSync(this.inDir, { recursive: true });
            const dest = path.join(this.inDir, `out-${Date.now()}-${name}`);
            fs.writeFileSync(dest, buf);
            await this.sendOutboundFile(dest, name, outOpts);
          } catch { /* 图片回传失败不阻断正文 */ }
        }
      }
      if (!canFiles) continue;
      for (const att of msg.attachments ?? []) {
        const attPath = att?.path || att?.href || att?.url;
        if (!attPath) continue;
        const k = `${msg.id}:${attPath}`;
        if (this.deliveredMedia.has(k)) continue;
        rememberBounded(this.deliveredMedia, k);
        try {
          const res = await this.client.downloadMessageFile(threadId, msg.id, attPath);
          const safe = safeAttachmentName(att.name || res.name, `file-${Date.now()}`);
          fs.mkdirSync(this.inDir, { recursive: true });
          const dest = path.join(this.inDir, `out-${Date.now()}-${safe}`);
          fs.writeFileSync(dest, res.buf);
          await this.sendOutboundFile(dest, safe, outOpts);
        } catch { /* 附件回传失败不阻断正文 */ }
      }
    }
  }

  async #deliverBotReply({ botId, botName, threadId, text, finalMsg, mediaMessages = [], proactive = false, isGroup = false, speakerName = '', chatCtx = null }) {
    if (finalMsg?.id) rememberBounded(this.deliveredOmbIds, finalMsg.id);
    const isExternal = Boolean(chatCtx?.isExternal);
    const targetChatId = chatCtx?.replyChatId || this.selfChat;
    const quoteReplyId = (!isExternal || chatCtx?.privateReply) ? null : (chatCtx?.replyToImMsgId ?? null);
    const who = this.botPrefix(botId, botName, { proactive, isGroup, speakerName });
    const originName = chatCtx?.chatName || chatCtx?.originChatId;
    const privHead = isExternal && chatCtx?.privateReply && !proactive
      ? `📩 **私密回复 · 来自「${originName}」**\n`
      : '';
    const originNote = proactive && isExternal ? `（来自「${originName}」）` : '';
    const head = proactive
      ? (who ? `🔔 ${who}${originNote}\n` : `🔔 **主动通知${originNote}**\n`)
      : (who ? `${who}\n` : '');
    const safeBody = isExternal && targetChatId && targetChatId !== this.selfChat
      ? sanitizeExternalMentions(text, { mode: this.chats.externalSanitizeMentions ?? 'all', botNames: this.getKnownBotNames() })
      : text;
    const full = privHead + head + safeBody;
    const compactCtx = compactChatCtx(chatCtx);
    const route = {
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
    const isPrivDraft = Boolean(isExternal && chatCtx?.privateReply && !proactive && chatCtx?.originChatId);
    const isPolishDraft = Boolean(!proactive && !isExternal && chatCtx?.polishDraft?.originChatId);
    const draftMeta = isPrivDraft
      ? {
          originChatId: chatCtx.originChatId,
          originName,
          originChatType: chatCtx.chatType || 'group',
          replyToImMsgId: chatCtx.originQuoteId ?? null,
        }
      : (isPolishDraft
        ? {
            originChatId: chatCtx.polishDraft.originChatId,
            originName: chatCtx.polishDraft.originChatName || chatCtx.polishDraft.originChatId,
            originChatType: chatCtx.polishDraft.originChatType || 'group',
            replyToImMsgId: chatCtx.polishDraft.replyToImMsgId ?? null,
          }
        : null);
    const effResult = this.#effectiveResultChars();
    const effSoftSplit = this.#effectiveSoftSplitChars();

    const draftKey = draftMeta ? `draft_${this.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}` : null;
    const draftActions = draftKey
      ? [{ label: `发回「${clip(draftMeta.originName, 10)}」`, text: `${this.trigger} sendback ${draftKey}` }]
      : null;

    let firstSentId = null;
    if (full.length <= effResult) {
      firstSentId = await this.say(full, route, quoteReplyId, draftActions);
    } else if (effSoftSplit > effResult && full.length <= effSoftSplit) {
      const chunks = mdSplit(full, effResult);
      for (let i = 0; i < chunks.length; i++) {
        const sid = await this.say(
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
      const clipped = mdClip(full, effResult);
      const canAttach = clipped.cut && this.#supportsFiles();
      const out = canAttach ? `${clipped.text}\n\n📎 完整回复见下一条附件` : clipped.text;
      firstSentId = await this.say(out, route, quoteReplyId, draftActions);

      if (canAttach) {
        try {
          fs.mkdirSync(this.inDir, { recursive: true });
          const mdPath = path.join(this.inDir, `${fileSafe(botName) || 'bot'}-${Date.now()}.md`);
          fs.writeFileSync(mdPath, `${full}\n`);
          await this.sendOutboundFile(mdPath, `${fileSafe(botName) || 'reply'}.md`, {
            chatId: targetChatId,
            ...(quoteReplyId ? { replyTo: quoteReplyId } : {}),
          });
        } catch { /* 附件失败不影响正文 */ }
      }
    }

    if (draftMeta && draftKey) {
      const draftObj = {
        id: draftKey,
        imMsgId: firstSentId || draftKey,
        originChatId: draftMeta.originChatId,
        originChatName: draftMeta.originName,
        originChatType: draftMeta.originChatType,
        replyToImMsgId: draftMeta.replyToImMsgId,
        rawText: text,
        createdAt: this.now(),
      };
      this.privateDrafts.set(draftKey, draftObj);
      if (firstSentId) this.privateDrafts.set(firstSentId, draftObj);
      this.lastPrivateDraftId = firstSentId || draftKey;
      while (this.privateDrafts.size > 40) this.privateDrafts.delete(this.privateDrafts.keys().next().value);
    }

    this.recordOutboundToContext(targetChatId, {
      id: firstSentId,
      text: full,
      replyTo: quoteReplyId,
      senderName: speakerName || botName,
    });
    this.emitTelemetry(proactive ? 'proactive' : 'reply', {
      botName: speakerName || botName,
      isGroup,
      chatId: targetChatId || null,
      chatType: isExternal ? (chatCtx?.privateReply ? 'self' : chatCtx?.chatType) : 'self',
      summary: text,
    });

    if (!proactive && !isExternal) {
      this.lastBotReplyAt = this.now();
      this.focus = { botId, botName, threadId, ...(isGroup ? { isGroup: true } : {}) };
    }
    this.saveState();

    const media = mediaMessages.length ? mediaMessages : (finalMsg ? [finalMsg] : []);
    await this.#forwardBotMedia(threadId, media, {
      chatId: targetChatId,
      replyTo: quoteReplyId,
    });
  }

  async flushQuietDigest() {
    if (!this.quietQueue.length) return 0;
    const items = this.quietQueue.splice(0);
    this.saveState();
    const lines = items.map((it) => `- **${it.speakerName ? `${it.botName} · ${it.speakerName}` : it.botName}**：${clip(it.text.replace(/\s+/g, ' '), 180)}`);
    const last = items.at(-1);
    await this.say(
      `🌙 **免打扰期间汇总（${items.length} 条）**\n${lines.join('\n')}`,
      { botId: last.botId, botName: last.botName, threadId: last.threadId, ...(last.isGroup ? { isGroup: true } : {}), ombMsgId: last.finalMsg?.id ?? null },
    );
    for (const it of items) {
      if (it.finalMsg) await this.#forwardBotMedia(it.threadId, [it.finalMsg]);
    }
    return items.length;
  }

  #trackTurn(params) {
    return createTurnTracker(this, params, {
      deliverBotReply: (args) => this.#deliverBotReply(args),
      emitCard: (botId, botName, tid, msg, opts) => this.#emitCard(botId, botName, tid, msg, opts),
      forwardBotMedia: (tid, msgs, opts) => this.#forwardBotMedia(tid, msgs, opts),
      maybeWarnHighContext: (botId, tid, ctx) => this.#maybeWarnHighContext(botId, tid, ctx),
    });
  }

  async #handleProactiveMessage(threadId, msg) {
    if (!msg || msg.role !== 'bot' || this.proactive === false) return;
    if (msg.kind === 'digest' || msg.kind === 'activity') return;
    if (msg.id && this.deliveredOmbIds.has(String(msg.id))) return;
    if (msg.requestMessageId && this.ownReqIds.has(String(msg.requestMessageId))) return;
    if (this.pendingThreads.has(threadId)) return;

    const owner = await this.#resolveOwnerByThread(threadId);
    const botId = owner?.id ?? threadId;
    const botName = owner?.name ?? 'MausBot';
    const isGroup = Boolean(owner?.isGroup);
    const speakerName = isGroup ? (msg.from?.name || '') : '';
    const extChat = [...this.chatThreads.values()].find((v) => v.threadId === threadId) ?? null;
    const proChatCtx = extChat
      ? {
          isExternal: true,
          originChatId: extChat.chatId,
          chatType: extChat.chatType,
          chatName: extChat.chatName,
          replyChatId: this.selfChat || extChat.chatId,
          controlChatId: this.selfChat || extChat.chatId,
          privateReply: Boolean(this.selfChat),
          silentProgress: true,
        }
      : null;

    if (messageNeedsInput(msg)) {
      await this.#emitCard(botId, botName, threadId, msg, { isGroup, chatCtx: proChatCtx });
      return;
    }

    if (msg.kind === 'screen' && msg.hasImage) {
      rememberBounded(this.deliveredOmbIds, msg.id);
      this.saveState();
      if (extChat) return; // 外部会话后台异常或重试产生的无文字截图不再误发自聊
      await this.#forwardBotMedia(threadId, [msg], { chatId: proChatCtx?.replyChatId || this.selfChat });
      return;
    }

    if (msg.kind === 'text' && msg.turnTerminal) {
      const text = String(msg.text ?? '').trim();
      if (!text && !msg.hasImage && !(msg.attachments?.length)) return;
      rememberBounded(this.deliveredOmbIds, msg.id);
      if (inQuietHours(this.now(), this.quietHours)) {
        this.quietQueue.push({ botId, botName, threadId, isGroup, speakerName, text: text || '（附件通知）', finalMsg: msg });
        this.saveState();
        return;
      }
      await this.#deliverBotReply({
        botId,
        botName,
        threadId,
        text: text || '（附件通知）',
        finalMsg: msg,
        mediaMessages: [msg],
        proactive: true,
        isGroup,
        speakerName,
        chatCtx: proChatCtx,
      });
    }
  }

  #claimQueuedUserMessage(threadId, msg) {
    const list = this.queuedByThread.get(threadId);
    let hit = null;
    if (list?.length) {
      const idx = list.findIndex((q) => (msg.sendId && q.sendId === msg.sendId) || (msg.queueId && q.queueId === msg.queueId));
      if (idx >= 0) {
        [hit] = list.splice(idx, 1);
        if (!list.length) this.queuedByThread.delete(threadId);
      }
    }
    if (!hit && msg.sendId && this.steeredQueue.has(msg.sendId)) {
      hit = this.steeredQueue.get(msg.sendId);
      this.steeredQueue.delete(msg.sendId);
    }
    if (!hit) return false;

    const reqMsgId = msg.id ?? null;
    if (reqMsgId) rememberBounded(this.ownReqIds, reqMsgId);
    const key = reqMsgId || `${threadId}:${hit.sendId}`;
    if (!this.activeTurns.has(key)) {
      const turn = this.#trackTurn({
        key,
        botId: hit.botId,
        botName: hit.botName,
        threadId,
        reqMsgId,
        sendId: hit.sendId,
        isGroup: Boolean(hit.isGroup),
        chatCtx: hit.chatCtx ?? null,
      });
      turn.startWatcher();
    }
    return true;
  }

  async #onSseEvent(evt) {
    if (!evt || typeof evt !== 'object') return;
    this.sseConnected = true;
    this.sseAuthError = null;
    this.consecutiveSseErrors = 0;
    if ((evt.kind === 'message' || evt.kind === 'message.patch') && evt.message) {
      const threadId = evt.threadId ?? evt.message.threadId;
      if (evt.message.role === 'user') {
        this.#claimQueuedUserMessage(threadId, evt.message);
        return;
      }
      let handled = false;
      for (const turn of this.activeTurns.values()) {
        if (turn.threadId === threadId) {
          turn.onMessage(evt.message);
          handled = true;
        }
      }
      if (!handled) await this.#handleProactiveMessage(threadId, evt.message);
      return;
    }
    if (evt.kind === 'bot' && evt.bot) {
      if (!evt.bot.hidden) await this.refreshMultiBot();
      for (const turn of this.activeTurns.values()) {
        if (turn.botId !== evt.bot.id || turn.isGroup) continue;
        if (evt.bot.busy) turn.sawBusy = true;
        else if (turn.sawBusy && !evt.bot.busy) turn.complete().catch(() => {});
      }
      return;
    }
    if (evt.kind === 'group' && evt.group) {
      if (!evt.group.hidden) await this.refreshMultiBot();
      for (const turn of this.activeTurns.values()) {
        if (!turn.isGroup || turn.botId !== evt.group.id) continue;
        if (evt.group.busy) turn.sawBusy = true;
        else if (turn.sawBusy && !evt.group.busy) turn.complete().catch(() => {});
      }
    }
  }
}
