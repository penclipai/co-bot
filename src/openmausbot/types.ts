/**
 * OpenMausBot 客户端、桥接状态机、路由与卡片协同类型定义。
 */
import type { ChatContextStore } from '../core/chat-context.ts';
import type { CommandRegistry } from '../core/extensions.ts';
import type {
  ChannelAction,
  ChannelCapabilities,
  ChannelNotifyPayload,
  ChannelSendFileInput,
  ChannelSendOptions,
  ChannelStatus,
  ChatContextMessage,
  ChatType,
  ChatsConfig,
  CollaboratorPolicy,
  InboundAttachment,
  InboundEvent,
  ProjectConfig,
  ProjectRef,
  QuietHoursConfig,
  TelemetryEvent,
} from '../types.ts';

export interface OmbHttpError extends Error {
  status?: number;
  code?: string;
  body?: unknown;
}

export interface OmbTaskUsageContext {
  tokens?: number;
  window?: number;
}

export interface OmbTaskSummary {
  id?: string;
  threadId?: string;
  title?: string;
  busy?: boolean;
  botId?: string;
  botName?: string;
  updatedAt?: number;
  lastThreadOrderAt?: number;
  createdAt?: number;
  usage?: {
    context?: OmbTaskUsageContext;
    turns?: number;
  };
}

export interface OmbBot {
  id: string;
  name: string;
  title?: string;
  soul?: string;
  threadId: string;
  mainThreadId?: string;
  hidden?: boolean;
  chiefOfStaff?: boolean;
  busy?: boolean;
  activity?: string;
  approvalMode?: string;
  computer?: string;
  waitingForTeammates?: boolean;
  replyStyle?: string;
  modelSelection?: { model?: string };
  tasks?: OmbTaskSummary[];
  isGroup?: boolean;
}

export interface OmbGroup {
  id: string;
  name: string;
  threadId: string;
  mainThreadId?: string;
  hidden?: boolean;
  dm?: boolean;
  busy?: boolean;
  memberIds?: string[];
  tasks?: OmbTaskSummary[];
  isGroup?: boolean;
}

export interface OmbCardOption {
  label?: string;
  value?: string;
  title?: string;
  description?: string;
}

export interface OmbCardQuestion {
  question?: string;
  header?: string;
  multiSelect?: boolean;
  options?: Array<string | OmbCardOption>;
}

export interface NormalizedCardQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: Array<{ label: string; description: string }>;
}

export interface OmbCard {
  requestId?: string;
  requestType?: string;
  title?: string;
  subtitle?: string;
  command?: string;
  canRememberCommand?: boolean;
  rememberCommand?: boolean;
  answered?: boolean;
  dismissed?: boolean;
  expired?: boolean;
  quotaSwitch?: boolean;
  questions?: OmbCardQuestion[];
  questionRequest?: {
    version?: number;
    questions?: OmbCardQuestion[];
  };
  options?: Array<string | OmbCardOption>;
  teamSetupRequest?: Record<string, unknown>;
  profileRequest?: Record<string, unknown>;
  appSettingRequest?: Record<string, unknown>;
  mcpRequest?: Record<string, unknown>;
  skillRequest?: Record<string, unknown>;
  routineRequest?: Record<string, unknown>;
  modelRequest?: Record<string, unknown>;
}

export interface OmbBurstCard {
  version?: number;
  burstId: string;
  botId?: string;
  task?: string;
  phase: 'preview' | 'running' | 'merging' | 'done' | 'cancelled' | 'failed' | string;
  total?: number;
  requested?: number;
  parallel?: number;
  modelName?: string;
  estimateMinutes?: number;
  counts?: {
    queued?: number;
    running?: number;
    done?: number;
    failed?: number;
    cancelled?: number;
  };
  sample?: Array<string | { title?: string; item?: string }>;
  failed?: Array<{ title?: string; reason?: string }>;
  failedMore?: number;
}

export interface OmbGoalRun {
  runId?: string;
  goal?: string;
  status?: 'working' | 'completed' | 'done' | 'failed' | 'cancelled' | 'timed_out' | 'stopped' | string;
  coordinatorBotId?: string;
  coordinatorName?: string;
  turnCount?: number;
  maxTurns?: number;
  detail?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface OmbCardAttachment {
  kind?: string;
  mime?: string;
  path?: string;
  href?: string;
  url?: string;
  name?: string;
  source?: string;
}

export interface OmbMessage {
  id?: string;
  role?: 'bot' | 'user' | 'system' | string;
  kind?: string;
  threadId?: string;
  requestMessageId?: string;
  turnId?: string;
  sentInTurn?: string;
  sendId?: string;
  queueId?: string;
  text?: string;
  turnTerminal?: boolean;
  turnFailed?: boolean;
  error?: string;
  hasImage?: boolean;
  from?: { name?: string; botId?: string };
  tool?: { name?: string; spoken?: string };
  card?: OmbCard;
  burst?: OmbBurstCard;
  goalRun?: OmbGoalRun;
  secret?: { label?: string; target?: string; provided?: boolean; dismissed?: boolean; superseded?: boolean };
  connector?: { label?: string; slug?: string; dismissed?: boolean; resumed?: boolean; status?: string };
  signIn?: { done?: boolean; cancelled?: boolean; superseded?: boolean; answeredInChat?: boolean; url?: string };
  attachments?: OmbCardAttachment[];
}

export interface OmbHealth {
  ok?: boolean;
  app?: string;
  version?: string;
  box?: string;
  doctor?: {
    checked?: number;
    fixed?: string[];
    problems?: string[];
  };
}

export interface OmbEnvironment {
  capabilities?: {
    selfUpdate?: string;
  };
}

export interface OmbAuthSession {
  kind?: string;
  label?: string;
  scopes?: string[];
}

export interface OmbSseEvent {
  kind?: string;
  cursor?: string;
  threadId?: string;
  message?: OmbMessage;
  bot?: OmbBot;
  group?: OmbGroup;
}

export interface OmbTargetBot {
  id: string;
  name: string;
  threadId: string;
  isGroup?: boolean;
  tasks?: OmbTaskSummary[];
}

export interface BridgeFocus {
  botId: string;
  botName: string;
  threadId: string;
  isGroup?: boolean;
}

export interface MsgRoute {
  botId: string;
  botName: string;
  threadId: string;
  ombMsgId?: string | null;
  isGroup?: boolean;
  targetChatId?: string | null;
  originChatId?: string;
  originChatName?: string;
  originChatType?: ChatType;
  privateReply?: boolean;
}

export interface PolishDraftInfo {
  originChatId: string;
  originChatName: string;
  originChatType: ChatType;
  replyToImMsgId: string | null;
  addBotPrefix: boolean;
  delegationRe?: string;
}

export interface DelegationRequestParsed {
  kind: 'req';
  id: string;
  project: string;
  body: string;
  rawBody: string;
}

export interface DelegationResponseParsed {
  kind: 'res';
  re: string;
  body: string;
  rawBody: string;
}

export type ParsedDelegationTag = DelegationRequestParsed | DelegationResponseParsed;

export interface PendingOutboundDelegation {
  id: string;
  targetChatId: string;
  targetChatName?: string;
  project?: string;
  question?: string;
  createdAt?: number;
}

export interface BridgeChatContext {
  isExternal: boolean;
  originChatId: string;
  chatType: ChatType;
  chatName?: string;
  replyChatId: string;
  controlChatId: string;
  replyToImMsgId: string | null;
  originQuoteId: string | null;
  privateReply: boolean;
  silentProgress: boolean;
  readonly?: boolean;
  draftFirst?: boolean;
  collaborator?: { id: string; name: string };
  allowedProjects?: string[] | null;
  delegationReq?: DelegationRequestParsed | null;
  explicitProject?: string;
  preformattedHeader?: string;
  autoSteer?: boolean;
  steerBanner?: string;
  polishDraft?: PolishDraftInfo;
  ev?: InboundEvent | null;
}

export interface CompactChatContext {
  isExternal: boolean;
  originChatId?: string;
  chatType?: ChatType;
  chatName?: string;
  replyChatId?: string;
  controlChatId?: string;
  replyToImMsgId?: string | null;
  originQuoteId?: string | null;
  privateReply?: boolean;
  silentProgress?: boolean;
  readonly?: boolean;
  draftFirst?: boolean;
  collaborator?: { id: string; name: string };
  allowedProjects?: string[] | null;
  delegationReq?: DelegationRequestParsed | null;
  polishDraft?: PolishDraftInfo;
}

export interface PrivateDraft {
  id: string;
  imMsgId: string;
  originChatId: string;
  originChatName: string;
  originChatType: ChatType;
  replyToImMsgId: string | null;
  rawText: string;
  addBotPrefix: boolean;
  forceBotPrefix?: boolean;
  delegationRe?: string;
  createdAt: number;
}

export interface PendingSendBack {
  draft: PrivateDraft;
  text: string;
  useBotPrefix?: boolean;
  expiresAt: number;
}

export interface PendingCard {
  imMsgId: string;
  cardKind: 'card' | 'secret' | 'connector' | 'signIn' | 'burst';
  cardBotId: string;
  requestId: string | null;
  burstId?: string | null;
  threadId: string;
  botId: string;
  botName: string;
  isGroup?: boolean;
  ombMsgId?: string;
  isQuestion: boolean;
  isReviewProposal?: boolean;
  title?: string;
  options: Array<{ label: string; description: string }>;
  questions?: NormalizedCardQuestion[];
  questionIndex?: number;
  collectedAnswers?: string[];
  canRememberCommand: boolean;
  chatCtx?: CompactChatContext | null;
}

export interface ActiveBurstWatch {
  burstId: string;
  botId: string;
  botName: string;
  threadId: string;
  isGroup?: boolean;
  chatCtx?: CompactChatContext | null;
  startedAt: number;
  deliveredText?: boolean;
  doneSeen?: boolean;
}

export interface PendingTaskPick {
  botId: string;
  botName: string;
  isGroup: boolean;
  tasks: OmbTaskSummary[];
  expiresAt: number;
  imMsgId?: string | null;
  isExternal?: boolean;
  originChatId?: string | null;
  chatId?: string | null;
  banner?: string;
}

export interface QuietQueueItem {
  botId: string;
  botName: string;
  threadId: string;
  isGroup: boolean;
  speakerName: string;
  speakerBotId: string | null;
  text: string;
  finalMsg: OmbMessage;
}

export interface QueuedTurnEntry {
  queueId: string;
  botId: string;
  botName: string;
  threadId: string;
  isGroup: boolean;
  text: string;
  sendId: string;
  at: number;
  chatCtx: CompactChatContext | null;
}

export interface InFlightTurnMeta {
  key: string;
  botId: string;
  botName: string;
  threadId: string;
  reqMsgId: string | null;
  sendId: string | null;
  isGroup?: boolean;
  chatCtx: CompactChatContext | null;
  startedAt: number;
}

export interface TurnTrackerHandle {
  key: string;
  botId: string;
  botName: string;
  threadId: string;
  reqMsgId: string | null;
  sendId: string | null;
  isGroup: boolean;
  chatCtx: CompactChatContext | null;
  sawBusy: boolean;
  onMessage: (msg: OmbMessage) => void;
  complete: (jobState?: string | null) => Promise<void>;
  dispose: () => void;
  markStopped: () => void;
  startWatcher: (afterInput?: boolean) => void;
}

export interface ChatThreadEntry {
  threadId: string;
  botId: string;
  botName: string;
  isGroup: boolean;
  chatId: string;
  chatName: string;
  chatType: ChatType;
}

export interface OutboundBufferItem {
  chatId: string;
  text: string;
  route: MsgRoute | null;
  replyTo: string | null;
  actions: ChannelAction[] | null;
  expiresAt: number;
}

export interface FileMsgEntry {
  chatId: string;
  atts: InboundAttachment[];
  at: number;
  used: boolean;
}

export interface BridgeTransport {
  selfChatId?: string;
  capabilities?: Partial<ChannelCapabilities>;
  canFiles?: boolean;
  start: (onEvent: (ev: InboundEvent) => unknown) => Promise<void> | void;
  stop?: () => Promise<void> | void;
  status?: () => Partial<ChannelStatus> | null;
  send: (chatId: string, text: string, opts?: ChannelSendOptions) => Promise<string | undefined>;
  sendFile?: (chatId: string, file: ChannelSendFileInput, opts?: ChannelSendOptions) => Promise<string | undefined>;
  download?: (att: InboundAttachment, savePath: string) => Promise<void> | void;
  getMessage?: (chatId: string, msgId: string) => Promise<unknown>;
  notify?: (payload: ChannelNotifyPayload) => Promise<void> | void;
}

export interface ImContextService {
  store?: ChatContextStore;
  recordInbound: (ev: Partial<InboundEvent>) => unknown;
  recordOutbound: (chatId: string, info: Record<string, unknown>) => unknown;
  recallMessage?: (chatId: string, msgId: string) => unknown;
  getHistory: (chatId: string, opts?: { limit?: number; excludeMsgId?: string }) => Promise<ChatContextMessage[]>;
  listChats?: () => Array<{ id: string; type: ChatType; name: string; count: number; updatedAt: number }>;
  stats?: () => { chatCount: number; totalMessages: number };
  buildPromptContext: (opts: {
    ev: InboundEvent;
    privateReply?: boolean;
    contextWindow?: number;
    injectRecent?: boolean;
    maxQuotedChars?: number;
    maxRecentChars?: number;
    skipSelfQuote?: boolean;
    recentAttachmentWindowMs?: number;
    maxAutoAttachments?: number;
  }) => Promise<{
    header: string;
    quotedMsg: ChatContextMessage | null;
    recentMsgs: ChatContextMessage[];
    quotedAttachments: InboundAttachment[];
    contextAttachments: InboundAttachment[];
  }>;
}

export interface MentionParseResult {
  mention: string;
  bang: boolean;
  bodyText: string;
  isDefault: boolean;
  atStart: boolean;
}

export interface BridgeOptions {
  client: import('./client.ts').OpenMausBotClient;
  transport: BridgeTransport;
  dataDir?: string;
  trigger?: string;
  botName?: string;
  syncChiefIdentity?: boolean;
  commandDevices?: string[];
  proactive?: boolean;
  quietHours?: QuietHoursConfig;
  progressDelayMs?: number;
  progressIntervalMs?: number;
  maxProgressUpdates?: number;
  intermediateCoalesceMs?: number;
  maxIntermediateBubbles?: number;
  turnStallMs?: number;
  stateSaveDebounceMs?: number;
  draftTtlMs?: number;
  outboundBufferMax?: number;
  outboundBufferTtlMs?: number;
  resultChars?: number;
  softSplitChars?: number;
  followUpWindowMs?: number;
  hideChiefPrefix?: boolean;
  imageBatchMs?: number;
  fileRetentionDays?: number;
  sendRetries?: number;
  sendRetryDelayMs?: number;
  autoHealOmb?: (() => unknown) | null;
  autoHealCooldownMs?: number;
  onTelemetry?: ((event: TelemetryEvent) => void) | null;
  markdown?: boolean;
  outPrefix?: string;
  imContext?: ImContextService | null;
  chats?: Partial<ChatsConfig>;
  projects?: ProjectConfig[] | Record<string, unknown>;
  sharedContextDir?: string;
  sharedContextPullIntervalMs?: number;
  execGit?: ((dir: string, timeoutMs: number) => Promise<string>) | null;
  transcribeAudio?: ((filePath: string, att: InboundAttachment) => Promise<string | null | undefined>) | null;
  commandRegistry?: CommandRegistry | null;
  now?: () => number;
}

export interface KnownChatSummary {
  id: string;
  type: ChatType;
  name: string;
  cachedMessages: number;
  updatedAt: number;
  muted?: boolean;
  allowed?: boolean;
  threadCount?: number;
  threads?: Array<{ botId: string; botName: string; threadId: string; isGroup: boolean }>;
}

export type { CollaboratorPolicy, ProjectRef, ChatContextMessage };
