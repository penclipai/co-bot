import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const defaults = {
  openmausbot: {
    url: 'http://127.0.0.1:8799',
    timeoutMs: 15_000,
    token: '',
    autoStart: true,
    cliComputerOff: true,
  },
  transport: 'sim', // 'sim'（网页自聊模拟器）| 'ipc'（真机 IM IPC 自聊）
  channel: {
    use: '', // 可选通道插件（'sim' | 'ipc' | './im-plugin.js' | npm 包名）
    options: {},
  },
  ipc: {
    client: '',
    selfId: '',
    selfChatId: '',
    atAllCountsAsMention: false,
  },
  web: {
    host: '127.0.0.1',
    port: 8787,
  },
  selfChat: {
    trigger: '@bot',
    commandDevices: [],
    proactive: true,
    quietHours: {
      enabled: false,
      start: '22:00',
      end: '08:30',
    },
    markdown: true,
    resultChars: 1500,
    softSplitChars: 2800,
    followUpWindowMs: 120_000,
    hideChiefPrefix: true,
    imageBatchMs: 1500,
    fileRetentionDays: 7,
    sendRetries: 2,
    progressDelayMs: 12_000,
    progressIntervalMs: 25_000,
    maxProgressUpdates: 2,
    intermediateCoalesceMs: 700,
    maxIntermediateBubbles: 2,
    outPrefix: '',
  },
  chats: {
    mode: 'owner_everywhere',
    enabledTypes: ['self', 'group', 'direct'],
    allowChatIds: [],
    denyChatIds: [],
    triggerAliases: [],
    contextWindow: 15,
    contextMaxMessagesPerChat: 120,
    contextTtlMs: 24 * 60 * 60_000,
    injectRecentContext: true,
    isolateThreadsByChat: true,
    externalSilentProgress: true,
    routeControlsToSelf: true,
    privateFlag: true,
    externalSanitizeMentions: 'all',
    recentAttachmentWindowMs: 120_000,
    maxAutoAttachments: 4,
    autoCompactThreshold: 0.92,
    scheduledSummaries: [],
    maxQuotedSnippetChars: 800,
    maxRecentMessageChars: 280,
  },
  dataDir: './data',
};

export function isPathLikeSpecifier(s) {
  return /^(?:\.\.?[\\/]|\/|[a-zA-Z]:[\\/])/.test(s) || /\.(?:mjs|cjs|js)$/i.test(s);
}

/** 读入 config.json 与命令行覆盖项（--config、--port、--omb、--omb-token、--transport、--channel）。 */
export function loadConfig(argv = process.argv.slice(2), explicitFile) {
  const flag = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
  };
  const defaultCfg = fs.existsSync('config.json')
    ? 'config.json'
    : (fs.existsSync(path.join(APP_ROOT, 'config.json')) ? path.join(APP_ROOT, 'config.json') : null);
  const file = explicitFile ?? flag('--config') ?? defaultCfg;
  const raw = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const base = file ? path.dirname(path.resolve(file)) : process.cwd();

  const rawChan = typeof raw.channel === 'string'
    ? { use: raw.channel, options: {} }
    : (raw.channel && typeof raw.channel === 'object' ? raw.channel : {});
  const configUseRaw = String(rawChan.use ?? '').trim();
  const configUse = configUseRaw && isPathLikeSpecifier(configUseRaw)
    ? path.resolve(base, configUseRaw)
    : configUseRaw;

  const cfg = {
    openmausbot: { ...defaults.openmausbot, ...raw.openmausbot },
    transport: raw.transport === 'web' ? 'sim' : (raw.transport ?? defaults.transport),
    channel: {
      use: configUse,
      options: { ...defaults.channel.options, ...(rawChan.options ?? {}) },
    },
    ipc: { ...defaults.ipc, ...raw.ipc },
    web: { ...defaults.web, ...raw.web },
    selfChat: {
      ...defaults.selfChat,
      ...raw.selfChat,
      quietHours: { ...defaults.selfChat.quietHours, ...(raw.selfChat?.quietHours ?? {}) },
    },
    chats: {
      ...defaults.chats,
      ...raw.chats,
      enabledTypes: Array.isArray(raw.chats?.enabledTypes) ? raw.chats.enabledTypes : defaults.chats.enabledTypes,
      allowChatIds: Array.isArray(raw.chats?.allowChatIds) ? raw.chats.allowChatIds : defaults.chats.allowChatIds,
      denyChatIds: Array.isArray(raw.chats?.denyChatIds) ? raw.chats.denyChatIds : defaults.chats.denyChatIds,
      triggerAliases: Array.isArray(raw.chats?.triggerAliases) ? raw.chats.triggerAliases : defaults.chats.triggerAliases,
      scheduledSummaries: Array.isArray(raw.chats?.scheduledSummaries) ? raw.chats.scheduledSummaries : defaults.chats.scheduledSummaries,
    },
    dataDir: raw.dataDir ?? defaults.dataDir,
  };

  if (flag('--omb')) cfg.openmausbot.url = flag('--omb');
  if (flag('--port')) cfg.web.port = Number(flag('--port'));
  if (flag('--transport')) cfg.transport = flag('--transport') === 'web' ? 'sim' : flag('--transport');
  const cliChannel = flag('--channel');
  if (cliChannel) {
    const c = String(cliChannel).trim();
    cfg.channel.use = isPathLikeSpecifier(c) ? path.resolve(process.cwd(), c) : c;
  }

  cfg.openmausbot.url = String(cfg.openmausbot.url || defaults.openmausbot.url).replace(/\/+$/, '');
  cfg.openmausbot.token = String(flag('--omb-token') || cfg.openmausbot.token || process.env.OMB_TOKEN || '').trim();
  cfg.dataDir = path.resolve(base, cfg.dataDir);
  if (cfg.ipc.client) cfg.ipc.client = path.resolve(base, cfg.ipc.client);
  return cfg;
}
