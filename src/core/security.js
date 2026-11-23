/**
 * 出站确定性安全门禁：扫描并脱敏密钥/Token/私钥/连接串，保护文本附件，规范外部 🤖 标识。
 */
import fs from 'node:fs';
import path from 'node:path';

const TEXT_FILE_EXTS = new Set([
  '.md', '.markdown', '.txt', '.log', '.json', '.jsonl', '.yaml', '.yml',
  '.env', '.ini', '.conf', '.cfg', '.toml', '.csv', '.tsv', '.xml',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.sql',
  '.html', '.htm', '.css', '.scss', '.properties',
]);

const PLACEHOLDER_VAL_RE = /^(?:your[_-]|example|changeme|placeholder|redacted|undefined|true|false|null|none|xxx+|0+|\*+|\[(?:已脱敏|redacted))/i;

const SECRET_RULES = [
  {
    type: 'private_key',
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: () => '[已脱敏:private_key]',
  },
  {
    type: 'db_url',
    re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s:@"'`<>]+:[^\s@"'`<>]+@[^\s"'`<>]+/gi,
    replace: () => '[已脱敏:db_url]',
  },
  {
    type: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replace: () => '[已脱敏:jwt]',
  },
  {
    type: 'bearer_token',
    re: /\bBearer\s+(?!\[(?:已脱敏|REDACTED))[A-Za-z0-9._~+/=-]{12,}/gi,
    replace: () => 'Bearer [已脱敏:bearer_token]',
  },
  {
    type: 'api_key',
    re: /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|omb_sess_[A-Za-z0-9_-]{8,}|ctx_[A-Za-z0-9._-]{12,})\b/g,
    replace: () => '[已脱敏:api_key]',
  },
  {
    type: 'secret_kv',
    re: /\b([A-Za-z0-9_]*(?:API_KEY|SECRET_KEY|ACCESS_KEY|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY|PASSWORD|PASSWD|SECRET|TOKEN))\s*([:=])\s*(['"]?)([A-Za-z0-9._~+/=@-]{8,})\3/gi,
    replace: (full, key, sep, quote, val) => {
      if (PLACEHOLDER_VAL_RE.test(val)) return full;
      return `${key}${sep}${quote}[已脱敏:secret_kv]${quote}`;
    },
  },
];

/** 确定性扫描并脱敏出站文本中的敏感凭证。 */
export function scanAndRedactOutbound(text) {
  let out = String(text ?? '');
  if (!out) return { text: out, redacted: false, hits: [], totalHits: 0 };

  const hits = [];
  let totalHits = 0;
  for (const rule of SECRET_RULES) {
    let count = 0;
    const next = out.replace(rule.re, (...args) => {
      const match = args[0];
      const replacement = rule.replace(...args);
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
export function isTextLikeFile(nameOrPath) {
  const base = path.basename(String(nameOrPath || '')).toLowerCase();
  if (base === '.env' || base.startsWith('.env.')) return true;
  const ext = path.extname(base);
  return TEXT_FILE_EXTS.has(ext);
}

/**
 * 出站发送文本/Markdown 附件前执行凭证扫描；若命中则在同目录生成脱敏临时副本并返回新路径。
 */
export function redactTextFileBeforeSend(filePath, fileName = '', { maxBytes = 2 * 1024 * 1024 } = {}) {
  const noHit = { sendPath: filePath, tempPath: null, redacted: false, hits: [], totalHits: 0 };
  if (!filePath || !isTextLikeFile(fileName || filePath)) return noHit;
  let stat;
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
export function formatExternalBotPrefix(text, prefix = '🤖 ') {
  const s = String(text ?? '');
  if (!prefix || !s.trim()) return s;
  const p = String(prefix);
  const trimmed = s.trimStart();
  if (trimmed.startsWith('🤖') || (p.trim() && trimmed.startsWith(p.trim()))) return s;
  return `${p}${s}`;
}
