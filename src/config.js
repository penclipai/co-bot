import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { levenshtein, parseHHMM } from './openmausbot/mentions.js';

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
    turnStallMs: 180_000,
    stateSaveDebounceMs: 150,
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
    externalAckInSelf: false,
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

function closestKey(key, allowedKeys) {
  let best = null;
  let bestDist = Infinity;
  const low = String(key).toLowerCase();
  for (const k of allowedKeys) {
    const d = levenshtein(low, String(k).toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  return bestDist <= 2 ? best : null;
}

function checkUnknownKeys(obj, allowedObj, prefix, warnings) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  const allowed = Object.keys(allowedObj);
  for (const key of Object.keys(obj)) {
    if (!Object.prototype.hasOwnProperty.call(allowedObj, key)) {
      const hint = closestKey(key, allowed);
      const pathKey = prefix ? `${prefix}.${key}` : key;
      const hintPath = hint ? (prefix ? `${prefix}.${hint}` : hint) : null;
      warnings.push(
        hintPath
          ? `未知配置字段「${pathKey}」，你是不是想写「${hintPath}」？`
          : `未知配置字段「${pathKey}」（将被忽略）`,
      );
    }
  }
}

/** 轻量配置校验（零依赖）：检查未知字段拼写、端口、URL、HH:MM 时间与阈值范围。 */
export function validateConfig(rawConfig = {}) {
  const errors = [];
  const warnings = [];
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    return { ok: false, errors: ['配置根节点必须是 JSON 对象'], warnings };
  }

  checkUnknownKeys(rawConfig, { ...defaults, sim: defaults.web }, '', warnings);
  checkUnknownKeys(rawConfig.openmausbot, defaults.openmausbot, 'openmausbot', warnings);
  checkUnknownKeys(rawConfig.channel, defaults.channel, 'channel', warnings);
  checkUnknownKeys(rawConfig.ipc, defaults.ipc, 'ipc', warnings);
  checkUnknownKeys(rawConfig.web ?? rawConfig.sim, defaults.web, 'web', warnings);
  checkUnknownKeys(rawConfig.selfChat, defaults.selfChat, 'selfChat', warnings);
  checkUnknownKeys(rawConfig.selfChat?.quietHours, defaults.selfChat.quietHours, 'selfChat.quietHours', warnings);
  checkUnknownKeys(rawConfig.chats, defaults.chats, 'chats', warnings);

  if (rawConfig.openmausbot?.url !== undefined) {
    try {
      const u = new URL(String(rawConfig.openmausbot.url));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        errors.push(`openmausbot.url 必须为 http/https 地址，当前为「${rawConfig.openmausbot.url}」`);
      }
    } catch {
      errors.push(`openmausbot.url 不是合法 URL：「${rawConfig.openmausbot.url}」`);
    }
  }

  const webPort = (rawConfig.web ?? rawConfig.sim)?.port;
  if (webPort !== undefined) {
    const p = Number(webPort);
    if (!Number.isInteger(p) || p < 0 || p > 65535) {
      errors.push(`web.port 必须为 0～65535 的整数，当前为「${webPort}」`);
    }
  }

  const qh = rawConfig.selfChat?.quietHours;
  if (qh && typeof qh === 'object') {
    if (qh.start !== undefined && parseHHMM(qh.start) == null) {
      errors.push(`selfChat.quietHours.start 格式无效（应为 HH:MM）：「${qh.start}」`);
    }
    if (qh.end !== undefined && parseHHMM(qh.end) == null) {
      errors.push(`selfChat.quietHours.end 格式无效（应为 HH:MM）：「${qh.end}」`);
    }
  }

  if (rawConfig.selfChat?.turnStallMs !== undefined) {
    const ms = Number(rawConfig.selfChat.turnStallMs);
    if (!Number.isFinite(ms) || ms < 0) {
      errors.push(`selfChat.turnStallMs 必须为非负数字，当前为「${rawConfig.selfChat.turnStallMs}」`);
    }
  }

  const ch = rawConfig.chats;
  if (ch && typeof ch === 'object') {
    if (ch.mode !== undefined && ch.mode !== 'owner_everywhere' && ch.mode !== 'self_only') {
      errors.push(`chats.mode 必须为 owner_everywhere 或 self_only，当前为「${ch.mode}」`);
    }
    if (ch.externalSanitizeMentions !== undefined && !['all', 'dangerous', 'none'].includes(ch.externalSanitizeMentions)) {
      errors.push(`chats.externalSanitizeMentions 必须为 all / dangerous / none，当前为「${ch.externalSanitizeMentions}」`);
    }
    if (ch.autoCompactThreshold !== undefined) {
      const th = Number(ch.autoCompactThreshold);
      if (!Number.isFinite(th) || (th !== 0 && (th < 0.5 || th > 1))) {
        errors.push(`chats.autoCompactThreshold 必须为 0 或 0.5～1 之间，当前为「${ch.autoCompactThreshold}」`);
      }
    }
    if (Array.isArray(ch.scheduledSummaries)) {
      ch.scheduledSummaries.forEach((item, idx) => {
        if (!item?.chatId) {
          errors.push(`chats.scheduledSummaries[${idx}] 缺少必填字段 chatId`);
        }
        if (parseHHMM(item?.time) == null) {
          errors.push(`chats.scheduledSummaries[${idx}].time 格式无效（应为 HH:MM）：「${item?.time ?? ''}」`);
        }
      });
    }
  }

  return { ok: errors.length === 0, errors, warnings };
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
