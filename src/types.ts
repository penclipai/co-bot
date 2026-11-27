/**
 * co-bot 核心共享类型定义（通道契约、内核、配置、上下文与安全策略）。
 */

export type ChatType = 'self' | 'direct' | 'group' | 'system';
export type DeviceType = 'mobile' | 'desktop' | 'pad' | 'web' | 'unknown';
export type CollaboratorPolicy = 'confirm_in_self' | 'auto_readonly';
export type ChatsMode = 'owner_everywhere' | 'self_only';
export type ExternalReplyMode = 'inline' | 'draft_first';
export type SanitizeMentionsMode = 'all' | 'dangerous' | 'none';

export interface LoggerLike {
  log?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

export interface QuietHoursConfig {
  enabled: boolean;
  start: string;
  end: string;
}

export interface OpenMausBotConfig {
  url: string;
  timeoutMs: number;
  token: string;
  autoStart: boolean;
  cliComputerOff: boolean;
  syncChiefIdentity: boolean;
}

export interface ChannelConfig {
  use: string;
  options: Record<string, unknown>;
}

export interface WebConfig {
  host: string;
  port: number;
}

export interface SelfChatConfig {
  trigger: string;
  commandDevices: string[];
  proactive: boolean;
  quietHours: QuietHoursConfig;
  markdown: boolean;
  resultChars: number;
  softSplitChars: number;
  followUpWindowMs: number;
  hideChiefPrefix: boolean;
  imageBatchMs: number;
  fileRetentionDays: number;
  sendRetries: number;
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
  followUpRemindMs: number;
  delegationRemindMs: number;
  mutedHintCooldownMs: number;
  outboundBufferMax: number;
  outboundBufferTtlMs: number;
  sendRetryDelayMs: number;
  autoHealCooldownMs: number;
  outPrefix: string;
  botName: string;
}

export interface CollaboratorRule {
  id: string;
  name: string;
  policy: CollaboratorPolicy;
  projects: string[];
  chats: string[];
}

export interface ChatsConfig {
  mode: ChatsMode;
  externalReplyMode: ExternalReplyMode;
  externalBotPrefix: string;
  collaborators: CollaboratorRule[];
  enabledTypes: ChatType[];
  allowChatIds: string[];
  denyChatIds: string[];
  triggerAliases: string[];
  contextWindow: number;
  contextMaxMessagesPerChat: number;
  contextMaxChats: number;
  contextTtlMs: number;
  injectRecentContext: boolean;
  isolateThreadsByChat: boolean;
  externalSilentProgress: boolean;
  externalAckInSelf: boolean;
  routeControlsToSelf: boolean;
  collaboratorConfirmAck: boolean;
  privateFlag: boolean;
  externalSanitizeMentions: SanitizeMentionsMode;
  recentAttachmentWindowMs: number;
  maxAutoAttachments: number;
  autoCompactThreshold: number;
  maxQuotedSnippetChars: number;
  maxRecentMessageChars: number;
  passiveMentionAlert: boolean;
  collaboratorBot: string;
}

export interface ProjectConfig {
  name: string;
  path: string;
  aliases: string[];
  description?: string;
}

export interface ProjectRef {
  name: string;
  path: string;
}

export type PluginInjectSpec = string | string[] | { required?: string[]; optional?: string[] };

export type PluginConfigEntry = boolean | ({ enabled?: boolean } & Record<string, unknown>);

export interface AppConfig {
  openmausbot: OpenMausBotConfig;
  channel: ChannelConfig;
  web: WebConfig;
  selfChat: SelfChatConfig;
  chats: ChatsConfig;
  projects: ProjectConfig[];
  sharedContextDir: string;
  sharedContextPullIntervalMs: number;
  pluginsDir: string;
  pluginsStrict: boolean;
  plugins: Record<string, PluginConfigEntry>;
  dataDir: string;
}

export type RawConfig = Record<string, unknown>;

export interface ChannelCapabilities {
  markdown: boolean;
  files: boolean;
  images: boolean;
  replyTo: boolean;
  actions: boolean;
  history: boolean;
  notify: boolean;
  maxChars: number;
  multiDevice: boolean;
}

export type ChannelCapabilityInput = Partial<ChannelCapabilities>;

export interface InboundChat {
  id: string;
  type: ChatType;
  name?: string;
}

export interface InboundSender {
  id: string;
  name?: string;
  isSelf: boolean;
}

export interface InboundDevice {
  id: string;
  type: DeviceType;
  name?: string;
}

export interface InboundAttachment {
  id: string;
  msgId?: string;
  chatId?: string;
  name: string;
  size?: number;
  mime?: string;
  kind?: string;
  durationSec?: number;
  transcript?: string;
  extra?: Record<string, unknown>;
}

export interface InboundMention {
  id: string;
  name?: string;
  isAll?: boolean;
  isSelf?: boolean;
  idKind?: 'platform' | 'name_fallback';
}

export interface InboundQuote {
  msgId: string;
  senderId?: string;
  senderName?: string;
  isSelf?: boolean;
  text?: string;
  ts?: number;
  chatId?: string;
}

export interface LinkCard {
  title?: string;
  description?: string;
  url?: string;
  source?: string;
}

export interface ForwardedMessageItem {
  id?: string;
  senderName?: string;
  senderId?: string;
  ts?: number;
  text?: string;
  linkCard?: LinkCard;
  attachments?: InboundAttachment[];
}

export interface ForwardedBundle {
  title?: string;
  messages: ForwardedMessageItem[];
}

export interface InboundEvent {
  id: string;
  kind?: 'message' | 'recall';
  ts: number;
  chat: InboundChat;
  sender: InboundSender;
  device?: InboundDevice;
  text: string;
  linkCard?: LinkCard;
  isForwarded?: boolean;
  forwarded?: ForwardedBundle;
  mentionsMe?: boolean;
  mentions?: InboundMention[];
  replyTo?: string;
  quote?: InboundQuote;
  recalledMsgId?: string;
  attachments?: InboundAttachment[];
}

export interface ChannelAction {
  id?: string;
  label: string;
  text?: string;
  replyText?: string;
  kind?: string;
  style?: string;
}

export interface OutboundMention {
  id: string;
  name?: string;
}

export interface ChannelSendOptions {
  chatType?: ChatType;
  replyTo?: string;
  actions?: ChannelAction[];
  mentions?: OutboundMention[];
  senderName?: string;
  [key: string]: unknown;
}

export interface ChannelSendFileInput {
  path: string;
  name: string;
  mime?: string;
  kind?: string;
}

export interface ChannelNotifyPayload {
  title?: string;
  body?: string;
  chatId?: string;
  urgent?: boolean;
}

export interface ChannelGetHistoryOptions {
  chatType?: ChatType;
  limit?: number;
  beforeMsgId?: string | null;
  beforeTs?: number | null;
}

export interface ChannelGetMessageOptions {
  chatType?: ChatType;
}

export interface ChannelDownloadContext {
  chatId?: string;
  chatType?: ChatType;
}

export interface ChannelIdPatterns {
  userId?: RegExp;
  chatId?: RegExp;
  directChatId?: RegExp;
  groupChatId?: RegExp;
  msgId?: RegExp;
}

export interface ChannelStartContext {
  onDisconnect?: (err?: unknown) => void;
}

export interface ChannelStatus {
  kind: string;
  connected: boolean;
  selfChatId: string | null;
  lastError: string | null;
  reconnectAttempts: number;
  capabilities?: ChannelCapabilities;
}

export interface ChannelAdapter {
  capabilities?: ChannelCapabilityInput;
  canFiles?: boolean;
  idPatterns?: ChannelIdPatterns;
  start: (onEvent: (rawMsg: unknown) => void, ctx: ChannelStartContext) => Promise<void> | void;
  send: (chatId: string, text: string, opts?: ChannelSendOptions) => Promise<string | number | void> | string | number | void;
  sendFile?: (chatId: string, file: ChannelSendFileInput, opts?: ChannelSendOptions) => Promise<string | number | void> | string | number | void;
  download?: (att: InboundAttachment, savePath: string, ctx?: ChannelDownloadContext) => Promise<void> | void;
  getMessage?: (chatId: string, msgId: string, opts?: ChannelGetMessageOptions) => Promise<unknown> | unknown;
  getHistory?: (chatId: string, opts?: ChannelGetHistoryOptions) => Promise<unknown[]> | unknown[];
  notify?: (payload: ChannelNotifyPayload) => Promise<void> | void;
  status?: () => Partial<ChannelStatus> | null;
  stop: () => Promise<void> | void;
}

export interface ChannelPluginSpec<TOptions extends Record<string, unknown> = Record<string, unknown>> {
  name?: string;
  kind?: string;
  version?: string;
  provides?: string[];
  inject?: PluginInjectSpec;
  capabilities?: ChannelCapabilityInput;
  idPatterns?: ChannelIdPatterns;
  strictContract?: boolean;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  source?: string;
  create?: (options: TOptions, ctx: KernelContext) => ChannelAdapter;
  apply?: (ctx: KernelContext, options: TOptions) => Promise<(() => unknown) | void> | (() => unknown) | void;
}

export interface KernelPlugin<TOptions = Record<string, unknown>> {
  name?: string;
  kind?: string;
  version?: string;
  provides?: string | string[];
  inject?: PluginInjectSpec;
  capabilities?: ChannelCapabilityInput;
  source?: string;
  isolated?: boolean;
  apply: (ctx: KernelContext, options: TOptions) => Promise<(() => unknown) | void> | (() => unknown) | void;
}

export type PluginFactory<TOptions = Record<string, unknown>> = (
  ctx: KernelContext,
  options: TOptions,
) => Promise<(() => unknown) | void> | (() => unknown) | void;

export interface KernelContext {
  config: AppConfig;
  kernel: KernelLike;
  logger: LoggerLike;
  has: (name: string) => boolean;
  get: <T = unknown>(name: string) => T;
  provide: <T>(name: string, value: T) => T;
  effect: <T extends () => unknown>(fn: T) => T;
  on: (eventName: string, handler: (payload: unknown) => unknown) => () => void;
  emit: (eventName: string, payload?: unknown) => void;
  status: (fn: () => unknown) => void;
}

export interface KernelPluginStatus {
  name: string;
  kind: string;
  version: string;
  active: boolean;
  provides: string[];
  inject: string[];
  optionalInject: string[];
  source: string;
  error: string | null;
  reloadable: boolean;
  status: unknown;
}

export interface CustomRedactorRule {
  name: string;
  pattern: RegExp;
  replace?: string | ((match: string, ...args: string[]) => string);
}

export interface SecurityExtensionService {
  registerRedactor: (rule: CustomRedactorRule) => () => void;
  listRedactors: () => string[];
}

export interface PluginCommandContext {
  args: string;
  raw: string;
  isExternal: boolean;
  chatId: string;
  chatType: ChatType;
  chatName: string;
  targetBot: { id: string; name: string; threadId: string; isGroup?: boolean };
  reply: (text: string) => Promise<string | null>;
  replySensitive: (text: string) => Promise<string | null>;
}

export interface PluginCommandDef {
  name: string;
  aliases?: string[];
  description?: string;
  ownerOnly?: boolean;
  handler: (cmdCtx: PluginCommandContext) => Promise<void> | void;
}

export interface CommandRegistryService {
  register: (def: PluginCommandDef) => () => void;
  list: () => Array<{ name: string; aliases: string[]; description: string }>;
}

export type AudioTranscriberFn = (filePath: string, att: InboundAttachment) => Promise<string | null | undefined>;

export interface HooksExtensionService {
  registerAudioTranscriber: (fn: AudioTranscriberFn) => () => void;
  transcribeAudio: AudioTranscriberFn;
}

export interface PluginManagerService {
  reloadPlugin: (name: string) => Promise<KernelPluginStatus>;
  listReloadable: () => string[];
}

export interface KernelLike {
  has: (name: string) => boolean;
  get: <T = unknown>(name: string) => T;
  on: (eventName: string, handler: (payload: unknown) => unknown) => () => void;
  emit: (eventName: string, payload?: unknown) => void;
  status: () => { started: boolean; plugins: KernelPluginStatus[] };
}

export interface ChatContextMessage {
  id: string;
  ts: number;
  chatId: string;
  chatType: ChatType;
  chatName?: string;
  senderId: string;
  senderName?: string;
  isSelf: boolean;
  isBotReply: boolean;
  botId?: string;
  targetBotId?: string;
  targetBotName?: string;
  replyTo?: string;
  mentionsMe: boolean;
  mentions?: InboundMention[];
  text: string;
  linkCard?: LinkCard;
  isForwarded?: boolean;
  forwarded?: ForwardedBundle;
  attachments: InboundAttachment[];
}

export interface InboundPolicyAllowedOwner {
  allowed: true;
  role: 'owner';
  mode: 'owner';
  readonly: false;
  allowedProjects: null;
}

export interface InboundPolicyAllowedCollaborator {
  allowed: true;
  role: 'collaborator';
  mode: CollaboratorPolicy;
  readonly: true;
  collaborator: { id: string; name: string };
  allowedProjects: string[] | null;
  isDelegationReq: boolean;
}

export interface InboundPolicyDenied {
  allowed: false;
  reason: string;
}

export type InboundPolicyDecision =
  | InboundPolicyAllowedOwner
  | InboundPolicyAllowedCollaborator
  | InboundPolicyDenied;

export interface TelemetryEvent {
  type: string;
  ts?: number;
  source?: string;
  chatId?: string | null;
  summary?: string;
  [key: string]: unknown;
}
