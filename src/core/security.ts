/**
 * 出站确定性安全门禁：扫描并脱敏密钥/Token/私钥/连接串，保护文本附件，规范外部 🤖 标识。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { CustomRedactorRule } from '../types.ts';

export interface RedactionHit {
  type: string;
  count: number;
}

export interface RedactionScanResult {
  text: string;
  redacted: boolean;
  hits: RedactionHit[];
  totalHits: number;
}

export interface RedactFileResult {
  sendPath: string;
  tempPath: string | null;
  redacted: boolean;
  hits: RedactionHit[];
  totalHits: number;
}

interface SecretRule {
  type: string;
  re: RegExp;
  replace: (full: string, ...args: string[]) => string;
}

const customRedactors = new Map<string, SecretRule>();

function ensureGlobalRegex(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

/** 注册自定义出站脱敏规则，返回幂等注销函数（供安全扩展点与热重载回收）。 */
export function registerCustomRedactor(rule: CustomRedactorRule): () => void {
  const type = String(rule?.name || '').trim();
  if (!type) throw new Error('自定义脱敏规则必须提供非空 name');
  if (!(rule?.pattern instanceof RegExp)) throw new Error(`自定义脱敏规则「${type}」必须提供 RegExp pattern`);
  const re = ensureGlobalRegex(rule.pattern);
  const replaceFn = typeof rule.replace === 'function'
    ? rule.replace
    : (() => (typeof rule.replace === 'string' && rule.replace ? rule.replace : `[已脱敏:${type}]`));

  const entry: SecretRule = { type, re, replace: replaceFn };
  const key = `${type}#${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  customRedactors.set(key, entry);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    customRedactors.delete(key);
  };
}

/** 列出当前生效的自定义脱敏规则名称。 */
export function listCustomRedactors(): string[] {
  return [...new Set([...customRedactors.values()].map((r) => r.type))];
}

const TEXT_FILE_EXTS = new Set([
  '.md', '.markdown', '.txt', '.log', '.json', '.jsonl', '.yaml', '.yml',
  '.env', '.ini', '.conf', '.cfg', '.toml', '.csv', '.tsv', '.xml',
  '.pem', '.key', '.p8', '.crt', '.pub', '.csr',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.sql',
  '.html', '.htm', '.css', '.scss', '.properties',
]);

const PLACEHOLDER_VAL_RE = /^(?:your[_-]|example|changeme|placeholder|redacted|undefined|true|false|null|none|xxx+|0+|\*+|\[(?:已脱敏|redacted)|(?:process|import\.meta)\.env\.|env\.|\$\{)/i;

const SECRET_RULES: SecretRule[] = [
  {
    type: 'private_key',
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: () => '[已脱敏:private_key]',
  },
  {
    type: 'db_url',
    re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s:@"'`<>]*:[^\s@"'`<>]+@[^\s"'`<>]+/gi,
    replace: () => '[已脱敏:db_url]',
  },
  {
    type: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])/g,
    replace: () => '[已脱敏:jwt]',
  },
  {
    type: 'bearer_token',
    re: /\bBearer\s+(?!\[(?:已脱敏|REDACTED))[A-Za-z0-9._~+/=-]{12,}/gi,
    replace: () => 'Bearer [已脱敏:bearer_token]',
  },
  {
    type: 'api_key',
    re: /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|omb_sess_[A-Za-z0-9_-]{8,}|ctx_[A-Za-z0-9._-]{12,})(?![A-Za-z0-9_-])/g,
    replace: () => '[已脱敏:api_key]',
  },
  {
    type: 'secret_kv',
    re: /(["']?)\b([A-Za-z0-9_]*(?:API_KEY|SECRET_KEY|ACCESS_KEY|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY|PASSWORD|PASSWD|SECRET|TOKEN))\1\s*([:=])\s*(?:(["'])([^\s"'`<>\\]{8,})\4|([A-Za-z0-9._~+/=@!#$%^&*-]{8,}))/gi,
    replace: (full, keyQuote = '', key = '', sep = '', valQuote = '', quotedVal = '', bareVal = '') => {
      const val = quotedVal || bareVal;
      if (!val || PLACEHOLDER_VAL_RE.test(val)) return full;
      return `${keyQuote}${key}${keyQuote}${sep}${valQuote}[已脱敏:secret_kv]${valQuote}`;
    },
  },
];

/** 确定性扫描并脱敏出站文本中的敏感凭证。 */
export function scanAndRedactOutbound(text: unknown): RedactionScanResult {
  let out = String(text ?? '');
  if (!out) return { text: out, redacted: false, hits: [], totalHits: 0 };

  const hits: RedactionHit[] = [];
  let totalHits = 0;
  const activeRules = customRedactors.size > 0
    ? [...SECRET_RULES, ...customRedactors.values()]
    : SECRET_RULES;
  for (const rule of activeRules) {
    let count = 0;
    rule.re.lastIndex = 0;
    const next = out.replace(rule.re, (match: string, ...args: string[]) => {
      const replacement = rule.replace(match, ...args);
      if (replacement !== match) count += 1;
      return replacement;
    });
    if (count > 0) {
      hits.push({ type: rule.type, count });
      totalHits += count;
      out = next;
    }
  }
  return { text: out, redacted: totalHits > 0, hits, totalHits };
}

/** 判断文件名或路径是否为适合做文本凭证扫描的文本类附件。 */
function isTextLikeFile(nameOrPath: string): boolean {
  const base = path.basename(String(nameOrPath || '')).toLowerCase();
  if (base === '.env' || base.startsWith('.env.')) return true;
  const ext = path.extname(base);
  return TEXT_FILE_EXTS.has(ext);
}

/**
 * 出站发送文本/Markdown 附件前执行凭证扫描；若命中则在同目录生成脱敏临时副本并返回新路径。
 */
export function redactTextFileBeforeSend(
  filePath: string,
  fileName = '',
  { maxBytes = 2 * 1024 * 1024 }: { maxBytes?: number } = {},
): RedactFileResult {
  const noHit: RedactFileResult = { sendPath: filePath, tempPath: null, redacted: false, hits: [], totalHits: 0 };
  if (!filePath || (!isTextLikeFile(fileName) && !isTextLikeFile(filePath))) return noHit;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return noHit;
  }
  if (!stat.isFile() || stat.size > maxBytes) return noHit;

  const raw = fs.readFileSync(filePath, 'utf8');
  const res = scanAndRedactOutbound(raw);
  if (!res.redacted) return noHit;

  const tempName = `redacted-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${path.basename(filePath)}`;
  const tempPath = path.join(path.dirname(filePath), tempName);
  fs.writeFileSync(tempPath, res.text, 'utf8');
  return {
    sendPath: tempPath,
    tempPath,
    redacted: true,
    hits: res.hits,
    totalHits: res.totalHits,
  };
}

/** 为发往外部群/私聊的机器人回复前置清晰 🤖 标识（避免与本人人工发言混淆）。 */
export function formatExternalBotPrefix(text: unknown, prefix = '🤖 '): string {
  const s = String(text ?? '');
  if (!prefix || !s.trim()) return s;
  const p = String(prefix);
  const trimmed = s.trimStart();
  if (trimmed.startsWith('🤖') || (p.trim() && trimmed.startsWith(p.trim()))) return s;
  return `${p}${s}`;
}

const BOT_BADGE_RE = /^🤖\s*(?:\*\*\[[^\]\r\n]{1,80}\]\*\*|\[[^\]\r\n]{1,80}\])(?=\s|$)/;
const HR_LINE_START_RE = /^\s*([-*_])(?:\s*\1){2,}\s*(?:\n|$)/;

/** 检测消息正文是否以样式 A 的 Bot 徽章开头（用于自发消息回声防环）。 */
export function hasBotBadgePrefix(text: unknown): boolean {
  const trimmed = String(text ?? '').trimStart();
  return Boolean(trimmed) && BOT_BADGE_RE.test(trimmed);
}

/**
 * 为机器人回复前置样式 A 徽章（如 `🤖 **[co-bot]**`）：
 * - 统一在徽章后附加独立 `---` 分隔行再接正文（含单行短答复），稳定触发 IM 的 Markdown 渲染；
 * - 若正文已以水平分隔线开头则直接换行衔接，避免重复分隔线；
 * - 拆分气泡传入 `partIndex`/`partTotal`（>1）时附加 `(i/n)` 标识。
 */
export function attachBotBadge(
  badge: string,
  body: unknown,
  opts: { partIndex?: number; partTotal?: number } = {},
): string {
  const b = String(badge ?? '').trim();
  const raw = String(body ?? '').replace(/\r\n/g, '\n');
  if (!b) return raw;
  const partTotal = Number(opts.partTotal) || 0;
  const partIndex = Number(opts.partIndex) || 0;
  const partTag = partTotal > 1 && partIndex >= 1 ? ` (${partIndex}/${partTotal})` : '';
  const head = `${b}${partTag}`;
  if (!raw.trim()) return head;
  const trimmedStart = raw.trimStart();
  if (!partTag && (trimmedStart.startsWith(b) || hasBotBadgePrefix(trimmedStart))) return raw;
  const cleanBody = raw.startsWith('\n') ? raw.replace(/^\n+/, '') : raw;
  const sep = HR_LINE_START_RE.test(cleanBody) ? '\n' : '\n---\n';
  return `${head}${sep}${cleanBody}`;
}
