/**
 * 文本与 Markdown 排版辅助函数（零依赖）。
 */
import fs from 'node:fs';
import path from 'node:path';

interface OpenFenceState {
  marker: string;
  line: string;
  char: string;
  len: number;
}

export const clip = (s: unknown, n: number): string => {
  const text = String(s ?? '');
  return text.length > n ? text.slice(0, n) + '…' : text;
};

function nextFenceState(line: string, openFence: OpenFenceState | null): { openFence: OpenFenceState | null; isFenceLine: boolean } {
  const m = /^\s*(```+|~~~+)(.*)$/.exec(line);
  if (!m) return { openFence, isFenceLine: false };
  const ch = m[1][0];
  const len = m[1].length;
  if (!openFence) {
    return {
      openFence: { marker: ch.repeat(len), line: line.trim(), char: ch, len },
      isFenceLine: true,
    };
  }
  if (ch === openFence.char && len >= openFence.len && !m[2].trim()) {
    return { openFence: null, isFenceLine: true };
  }
  return { openFence, isFenceLine: false };
}

/** 不渲染 Markdown 的 IM：去掉加粗、标题、行内代码、分隔线、代码块围栏，代码块内容保留 2 空格缩进。 */
export function plain(text: unknown): string {
  let openFence: OpenFenceState | null = null;
  const HR = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
  const out: string[] = [];
  for (let line of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const f = nextFenceState(line, openFence);
    openFence = f.openFence;
    if (f.isFenceLine) continue;
    if (openFence) {
      out.push(line ? `  ${line}` : '');
      continue;
    }
    if (HR.test(line)) continue;
    const codeSpans: string[] = [];
    line = line.replace(/`([^`\n]+)`/g, (_, code: string) => {
      const idx = codeSpans.push(code) - 1;
      return `\u0000${idx}\u0000`;
    });
    line = line.replace(/^#{1,6}\s+/, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__([^_\n]+)__/g, '$1')
      .replace(/^(\s*)[*+]\s+/, '$1- ')
      .replace(/^>\s?/, '')
      .replace(/\\([\\*_`[\]<>|])/g, '$1');
    // eslint-disable-next-line no-control-regex
    line = line.replace(/\u0000(\d+)\u0000/g, (_, idx: string) => codeSpans[Number(idx)] ?? '');
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 单行消息若以 `**...**` 开头，脱去行首加粗包裹（单行在 IM 中不会按多行 Markdown 块触发渲染）。 */
export function stripSingleLineLeadingBold(text: unknown): string {
  const s = String(text ?? '').replace(/\r\n/g, '\n');
  const trimmed = s.trim();
  if (!trimmed || trimmed.includes('\n')) return s;
  return s.replace(/^(\s*)\*\*([^*\n]+?)\*\*([\s\S]*)$/, '$1$2$3');
}

/** 渲染 Markdown 的 IM：在连续正文的换行前补两个空格，防止不同客户端把单换行吞成空格。 */
export function hardBreaks(md: unknown): string {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n');
  let openFence: OpenFenceState | null = null;
  const HR = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
  const BLOCK = /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|```|~~~|\||([-*_])(?:\s*\1){2,}\s*$)/;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const f = nextFenceState(l, openFence);
    openFence = f.openFence;
    if (f.isFenceLine) continue;
    const next = lines[i + 1];
    if (openFence || !l.trim() || HR.test(l) || next == null || !next.trim() || BLOCK.test(next) || /^\s*\|/.test(l) || / {2}$/.test(l)) continue;
    lines[i] = l + '  ';
  }
  return lines.join('\n');
}

/** 截断 Markdown：尽量在换行处断开；若断在代码块中间则补上闭合围栏。 */
export function mdClip(text: unknown, n: number): { text: string; cut: boolean } {
  const t = String(text ?? '');
  const limit = Number(n);
  if (!(limit > 0)) return t ? { text: '…', cut: true } : { text: '', cut: false };
  if (t.length <= limit) return { text: t, cut: false };
  let at = t.lastIndexOf('\n', limit);
  if (at < limit * 0.6) at = limit;
  let out = t.slice(0, at).trimEnd();
  let openFence: OpenFenceState | null = null;
  for (const line of out.split('\n')) {
    openFence = nextFenceState(line, openFence).openFence;
  }
  if (openFence) out += `\n${openFence.marker}`;
  return { text: out + '\n\n…', cut: true };
}

function findBestBreak(rem: string, sep: string, minAt: number, maxAt: number, target: number): number {
  let best = -1;
  let bestDist = Infinity;
  let idx = rem.lastIndexOf(sep, maxAt);
  while (idx >= minAt) {
    const dist = Math.abs(idx - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = idx;
    }
    if (idx === 0) break;
    idx = rem.lastIndexOf(sep, idx - 1);
  }
  return best;
}

/** 按段落/换行拆分长 Markdown（保持代码块围栏完整闭合并在下一段续开）。 */
export function mdSplit(text: unknown, maxChunkChars: number): string[] {
  const t = String(text ?? '').trim();
  const limit = Number(maxChunkChars);
  if (!t || !(limit > 0) || t.length <= limit) return [t];

  const chunks: string[] = [];
  let rem = t;
  while (rem.length > limit) {
    const twoBubble = rem.length <= limit * 2;
    const target = twoBubble ? Math.min(limit, Math.ceil(rem.length / 2)) : limit;
    const minAt = twoBubble
      ? Math.max(Math.floor(target * 0.45), Math.min(rem.length - limit, Math.floor(limit * 0.6)))
      : Math.floor(limit * 0.45);

    let at = findBestBreak(rem, '\n\n', minAt, limit, target);
    if (at < 0) at = findBestBreak(rem, '\n', Math.floor(limit * 0.45), limit, target);
    if (at <= 0) at = limit;

    let piece = rem.slice(0, at).trimEnd();
    let rest = rem.slice(at).trimStart();

    let openFence: OpenFenceState | null = null;
    for (const line of piece.split('\n')) {
      openFence = nextFenceState(line, openFence).openFence;
    }

    if (openFence && rest) {
      piece = `${piece}\n${openFence.marker}`;
      const reopened = `${openFence.line}\n${rest}`;
      // 确保每轮严格缩短剩余文本，避免围栏行过长导致死循环
      if (reopened.length < rem.length) rest = reopened;
    }

    if (piece.trim()) chunks.push(piece.trim());
    if (!rest || rest.length >= rem.length) {
      if (rest) chunks.push(rest);
      rem = '';
      break;
    }
    rem = rest;
  }
  if (rem.trim()) chunks.push(rem.trim());
  return chunks.length ? chunks : [t];
}

/** 生成安全附件文件名（保留中文，消除路径与前导点）。 */
export const fileSafe = (s: unknown): string => String(s ?? '')
  .replace(/[\\/:*?"<>|\s]+/g, '-')
  .replace(/-+/g, '-')
  .replace(/^[.-]+|[.-]+$/g, '')
  .slice(0, 40)
  .replace(/^[.-]+|[.-]+$/g, '');

/** 统一清洗入站/出站附件文件名，去除路径段、危险字符与前导点。 */
export function safeAttachmentName(raw: unknown, fallback = 'file'): string {
  const baseName = path.posix.basename(String(raw || fallback).replace(/\\/g, '/'));
  return baseName.replace(/[^\w.\-\u4e00-\u9fff]/g, '_').slice(-100).replace(/^\.+/, '_') || fallback;
}

/** 原子写入 JSON 文件（先写临时文件再 rename），防止半写损坏状态。 */
export function writeJsonAtomic(filePath: string, data: unknown, { pretty = false }: { pretty?: boolean } = {}): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    const content = pretty ? `${JSON.stringify(data, null, 2)}\n` : JSON.stringify(data);
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

export interface PruneExpiredFilesOptions {
  keepPaths?: Iterable<string> | null;
  now?: number;
}

/** 清理目录中超过 maxAgeMs 毫秒的临时文件，并移除空子目录。 */
export function pruneExpiredFiles(dir: string, maxAgeMs: number, { keepPaths, now = Date.now() }: PruneExpiredFilesOptions = {}): number {
  const ttl = Number(maxAgeMs);
  if (!dir || !(ttl > 0) || !fs.existsSync(dir)) return 0;
  const cutoff = now - ttl;
  const normPath = (p: string): string => {
    const abs = path.resolve(p);
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  };
  const keep = keepPaths ? new Set([...keepPaths].map((p) => normPath(String(p)))) : null;
  let removed = 0;

  const walk = (cur: string, isRoot: boolean): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        walk(full, false);
      } else if (ent.isFile()) {
        if (keep?.has(normPath(full))) continue;
        try {
          if (fs.statSync(full).mtimeMs < cutoff) {
            fs.rmSync(full, { force: true });
            removed += 1;
          }
        } catch { /* ignore */ }
      }
    }
    if (!isRoot) {
      try {
        if (fs.readdirSync(cur).length === 0) fs.rmdirSync(cur);
      } catch { /* ignore */ }
    }
  };

  walk(dir, true);
  return removed;
}
