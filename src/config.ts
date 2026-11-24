import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig, RawConfig } from './types.ts';
import { normalizeCollaborators } from './core/inbound-policy.ts';
import { normalizeProjectsConfig } from './core/projects.ts';
import { levenshtein, parseHHMM } from './openmausbot/mentions.ts';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const defaults: AppConfig = {
  openmausbot: {
    url: 'http://127.0.0.1:8799',
    timeoutMs: 15_000,
    token: '',
    autoStart: true,
    cliComputerOff: true,
    syncChiefIdentity: true,
  },
  channel: {
    use: 'sim', // 通道插件（'sim' | './im-plugin.ts' | npm 包名）
    options: {},
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
    hideChiefPrefix: false,
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
    botName: 'co-bot',
  },
  chats: {
    mode: 'owner_everywhere',
    externalReplyMode: 'inline',
    externalBotPrefix: '🤖 ',
    collaborators: [],
    enabledTypes: ['self', 'group', 'direct'],
    allowChatIds: [],
    denyChatIds: [],
    triggerAliases: [],
    contextWindow: 15,
    contextMaxMessagesPerChat: 120,
    contextMaxChats: 200,
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
    maxQuotedSnippetChars: 800,
    maxRecentMessageChars: 280,
  },
  projects: [],
  sharedContextDir: '',
  sharedContextPullIntervalMs: 300_000,
  dataDir: './data',
};

type AnyObj = Record<string, unknown>;

export function isPathLikeSpecifier(s: string): boolean {
  return /^(?:\.\.?[\\/]|\/|[a-zA-Z]:[\\/])/.test(s) || /\.(?:[mc]?[jt]s)$/i.test(s);
}

function asObj(val: unknown): AnyObj | null {
  return val && typeof val === 'object' && !Array.isArray(val) ? (val as AnyObj) : null;
}

function closestKey(key: string, allowedKeys: string[]): string | null {
  let best: string | null = null;
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

function checkUnknownKeys(obj: unknown, allowedObj: object, prefix: string, warnings: string[]): void {
  const rec = asObj(obj);
  if (!rec) return;
  const allowed = Object.keys(allowedObj);
  for (const key of Object.keys(rec)) {
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
export function validateConfig(rawConfig: unknown = {}): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const raw = asObj(rawConfig);
  if (!raw) {
    return { ok: false, errors: ['配置根节点必须是 JSON 对象'], warnings };
  }

  const omb = asObj(raw.openmausbot);
  const web = asObj(raw.web);
  const selfChat = asObj(raw.selfChat);
  const qh = asObj(selfChat?.quietHours);
  const ch = asObj(raw.chats);

  checkUnknownKeys(raw, defaults, '', warnings);
  checkUnknownKeys(omb, defaults.openmausbot, 'openmausbot', warnings);
  checkUnknownKeys(raw.channel, defaults.channel, 'channel', warnings);
  checkUnknownKeys(web, defaults.web, 'web', warnings);
  checkUnknownKeys(selfChat, defaults.selfChat, 'selfChat', warnings);
  checkUnknownKeys(qh, defaults.selfChat.quietHours, 'selfChat.quietHours', warnings);
  checkUnknownKeys(ch, defaults.chats, 'chats', warnings);

  if (omb?.url !== undefined) {
    try {
      const u = new URL(String(omb.url));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        errors.push(`openmausbot.url 必须为 http/https 地址，当前为「${String(omb.url)}」`);
      }
    } catch {
      errors.push(`openmausbot.url 不是合法 URL：「${String(omb.url)}」`);
    }
  }

  if (omb?.syncChiefIdentity !== undefined && typeof omb.syncChiefIdentity !== 'boolean') {
    errors.push(`openmausbot.syncChiefIdentity 必须为布尔值，当前为「${String(omb.syncChiefIdentity)}」`);
  }

  if (selfChat?.botName !== undefined) {
    if (typeof selfChat.botName !== 'string' || !selfChat.botName.trim()) {
      errors.push('selfChat.botName 必须为非空字符串');
    }
  }

  const webPort = web?.port;
  if (webPort !== undefined) {
    const p = Number(webPort);
    if (!Number.isInteger(p) || p < 0 || p > 65535) {
      errors.push(`web.port 必须为 0～65535 的整数，当前为「${String(webPort)}」`);
    }
  }

  if (qh) {
    if (qh.start !== undefined && parseHHMM(qh.start) == null) {
      errors.push(`selfChat.quietHours.start 格式无效（应为 HH:MM）：「${String(qh.start)}」`);
    }
    if (qh.end !== undefined && parseHHMM(qh.end) == null) {
      errors.push(`selfChat.quietHours.end 格式无效（应为 HH:MM）：「${String(qh.end)}」`);
    }
  }

  if (selfChat?.turnStallMs !== undefined) {
    const ms = Number(selfChat.turnStallMs);
    if (!Number.isFinite(ms) || ms < 0) {
      errors.push(`selfChat.turnStallMs 必须为非负数字，当前为「${String(selfChat.turnStallMs)}」`);
    }
  }

  if (ch) {
    if (ch.mode !== undefined && ch.mode !== 'owner_everywhere' && ch.mode !== 'self_only') {
      errors.push(`chats.mode 必须为 owner_everywhere 或 self_only，当前为「${String(ch.mode)}」`);
    }
    if (ch.externalReplyMode !== undefined && ch.externalReplyMode !== 'inline' && ch.externalReplyMode !== 'draft_first') {
      errors.push(`chats.externalReplyMode 必须为 inline 或 draft_first，当前为「${String(ch.externalReplyMode)}」`);
    }
    if (ch.externalBotPrefix !== undefined && typeof ch.externalBotPrefix !== 'string') {
      errors.push('chats.externalBotPrefix 必须为字符串');
    }
    if (ch.collaborators !== undefined) {
      if (typeof ch.collaborators !== 'object' || ch.collaborators === null) {
        errors.push('chats.collaborators 必须为数组或对象');
      } else {
        const items = Array.isArray(ch.collaborators) ? ch.collaborators : Object.values(ch.collaborators as AnyObj);
        for (const col of items) {
          const rec = asObj(col);
          if (rec && rec.policy !== undefined && !['confirm_in_self', 'auto_readonly'].includes(String(rec.policy))) {
            errors.push(`chats.collaborators[].policy 必须为 confirm_in_self 或 auto_readonly，当前为「${String(rec.policy)}」`);
          }
        }
      }
    }
    if (ch.externalSanitizeMentions !== undefined && !['all', 'dangerous', 'none'].includes(String(ch.externalSanitizeMentions))) {
      errors.push(`chats.externalSanitizeMentions 必须为 all / dangerous / none，当前为「${String(ch.externalSanitizeMentions)}」`);
    }
    if (ch.autoCompactThreshold !== undefined) {
      const th = Number(ch.autoCompactThreshold);
      if (!Number.isFinite(th) || (th !== 0 && (th < 0.5 || th > 1))) {
        errors.push(`chats.autoCompactThreshold 必须为 0 或 0.5～1 之间，当前为「${String(ch.autoCompactThreshold)}」`);
      }
    }
  }

  if (raw.projects !== undefined) {
    if (typeof raw.projects !== 'object' || raw.projects === null) {
      errors.push('projects 必须为数组或对象');
    } else {
      const list = Array.isArray(raw.projects)
        ? raw.projects
        : Object.entries(raw.projects as AnyObj).map(([k, v]) => (typeof v === 'string' ? { name: k, path: v } : { name: k, ...(asObj(v) || {}) }));
      for (const p of list) {
        const rec = asObj(p);
        if (!rec || typeof rec.path !== 'string' || !rec.path.trim()) {
          errors.push('projects 中的每项都必须包含非空字符串 path');
        }
      }
    }
  }
  if (raw.sharedContextDir !== undefined && typeof raw.sharedContextDir !== 'string') {
    errors.push('sharedContextDir 必须为字符串');
  }
  if (raw.sharedContextPullIntervalMs !== undefined) {
    const ms = Number(raw.sharedContextPullIntervalMs);
    if (!Number.isFinite(ms) || ms < 0) {
      errors.push(`sharedContextPullIntervalMs 必须为非负数字，当前为「${String(raw.sharedContextPullIntervalMs)}」`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** 读入 config.json 与命令行覆盖项（--config、--port、--omb、--omb-token、--channel）。 */
export function loadConfig(argv: string[] = process.argv.slice(2), explicitFile?: string): AppConfig {
  const flag = (k: string): string | undefined => {
    const i = argv.indexOf(k);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
  };
  const defaultCfg = fs.existsSync('config.json')
    ? 'config.json'
    : (fs.existsSync(path.join(APP_ROOT, 'config.json')) ? path.join(APP_ROOT, 'config.json') : null);
  const file = explicitFile ?? flag('--config') ?? defaultCfg;
  const raw = (file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}) as RawConfig;
  const base = file ? path.dirname(path.resolve(file)) : process.cwd();

  const rawChan = typeof raw.channel === 'string'
    ? { use: raw.channel, options: {} as AnyObj }
    : (asObj(raw.channel) ?? {});
  const configUseRaw = String(rawChan.use ?? defaults.channel.use).trim() || 'sim';
  const normalizedUse = configUseRaw === 'web' ? 'sim' : configUseRaw;
  const configUse = normalizedUse && isPathLikeSpecifier(normalizedUse)
    ? path.resolve(base, normalizedUse)
    : normalizedUse;

  const rawOmb = asObj(raw.openmausbot);
  const rawWeb = asObj(raw.web);
  const rawSelf = asObj(raw.selfChat);
  const rawQh = asObj(rawSelf?.quietHours);
  const rawChats = asObj(raw.chats);

  const cfg: AppConfig = {
    openmausbot: { ...defaults.openmausbot, ...(rawOmb as Partial<AppConfig['openmausbot']>) },
    channel: {
      use: configUse,
      options: { ...defaults.channel.options, ...(asObj(rawChan.options) ?? {}) },
    },
    web: { ...defaults.web, ...(rawWeb as Partial<AppConfig['web']>) },
    selfChat: {
      ...defaults.selfChat,
      ...(rawSelf as Partial<AppConfig['selfChat']>),
      quietHours: { ...defaults.selfChat.quietHours, ...(rawQh as Partial<AppConfig['selfChat']['quietHours']>) },
    },
    chats: {
      ...defaults.chats,
      ...(rawChats as Partial<AppConfig['chats']>),
      collaborators: normalizeCollaborators(rawChats?.collaborators ?? defaults.chats.collaborators),
      enabledTypes: Array.isArray(rawChats?.enabledTypes) ? (rawChats.enabledTypes as AppConfig['chats']['enabledTypes']) : defaults.chats.enabledTypes,
      allowChatIds: Array.isArray(rawChats?.allowChatIds) ? (rawChats.allowChatIds as string[]) : defaults.chats.allowChatIds,
      denyChatIds: Array.isArray(rawChats?.denyChatIds) ? (rawChats.denyChatIds as string[]) : defaults.chats.denyChatIds,
      triggerAliases: Array.isArray(rawChats?.triggerAliases) ? (rawChats.triggerAliases as string[]) : defaults.chats.triggerAliases,
    },
    projects: normalizeProjectsConfig(raw.projects ?? defaults.projects, base),
    sharedContextDir: raw.sharedContextDir ? path.resolve(base, String(raw.sharedContextDir).trim()) : defaults.sharedContextDir,
    sharedContextPullIntervalMs: raw.sharedContextPullIntervalMs !== undefined
      ? Math.max(0, Number(raw.sharedContextPullIntervalMs) || 0)
      : defaults.sharedContextPullIntervalMs,
    dataDir: typeof raw.dataDir === 'string' ? raw.dataDir : defaults.dataDir,
  };

  const cliOmb = flag('--omb');
  if (cliOmb) cfg.openmausbot.url = cliOmb;
  const cliPort = flag('--port');
  if (cliPort) cfg.web.port = Number(cliPort);
  const cliChannel = flag('--channel');
  if (cliChannel) {
    const c = String(cliChannel).trim();
    const normCli = c === 'web' ? 'sim' : c;
    cfg.channel.use = isPathLikeSpecifier(normCli) ? path.resolve(process.cwd(), normCli) : normCli;
  }

  cfg.openmausbot.url = String(cfg.openmausbot.url || defaults.openmausbot.url).replace(/\/+$/, '');
  cfg.openmausbot.token = String(flag('--omb-token') || cfg.openmausbot.token || process.env.OMB_TOKEN || '').trim();
  cfg.openmausbot.syncChiefIdentity = cfg.openmausbot.syncChiefIdentity !== false;
  cfg.selfChat.botName = String(cfg.selfChat.botName || defaults.selfChat.botName).trim() || 'co-bot';
  cfg.dataDir = path.resolve(base, cfg.dataDir);
  return cfg;
}
