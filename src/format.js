/**
 * 文本与 Markdown 排版辅助函数（零依赖）。
 */
import fs from 'node:fs';
import path from 'node:path';

export const clip = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
};

const FENCE = /^\s*(```|~~~)/;

/** 不渲染 Markdown 的 IM：去掉加粗、标题、行内代码、代码块围栏，代码块内容保留 2 空格缩进。 */
export function plain(text) {
  let inFence = false;
  const out = [];
  for (let line of String(text ?? '').split('\n')) {
    if (FENCE.test(line)) { inFence = !inFence; continue; }
    if (inFence) {
      out.push(line ? `  ${line}` : '');
      continue;
    }
    line = line.replace(/^#{1,6}\s+/, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__([^_\n]+)__/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/^(\s*)[*+]\s+/, '$1- ')
      .replace(/^>\s?/, '')
      .replace(/\\([\\*_`[\]<>|])/g, '$1');
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 渲染 Markdown 的 IM：在连续正文的换行前补两个空格，防止不同客户端把单换行吞成空格。 */
export function hardBreaks(md) {
  const lines = String(md ?? '').split('\n');
  let inFence = false;
  const BLOCK = /^\s*([-*+]\s|\d+[.)]\s|#{1,6}\s|>|```|~~~|\|)/;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (FENCE.test(l)) { inFence = !inFence; continue; }
    const next = lines[i + 1];
    if (inFence || !l.trim() || next == null || !next.trim() || BLOCK.test(next) || /^\s*\|/.test(l) || / {2}$/.test(l)) continue;
    lines[i] = l + '  ';
  }
  return lines.join('\n');
}

/** 截断 Markdown：尽量在换行处断开；若断在代码块中间则补上闭合围栏。 */
export function mdClip(text, n) {
  const t = String(text ?? '');
  if (t.length <= n) return { text: t, cut: false };
  let at = t.lastIndexOf('\n', n);
  if (at < n * 0.6) at = n;
  let out = t.slice(0, at).trimEnd();
  const fences = out.split('\n').filter((l) => FENCE.test(l)).length;
  if (fences % 2) out += '\n```';
  return { text: out + '\n\n…', cut: true };
}

function findBestBreak(rem, sep, minAt, maxAt, target) {
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
export function mdSplit(text, maxChunkChars) {
  const t = String(text ?? '').trim();
  const limit = Number(maxChunkChars);
  if (!t || !(limit > 0) || t.length <= limit) return [t];

  const chunks = [];
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

    let openFence = null;
    for (const line of piece.split('\n')) {
      const m = /^\s*(```+|~~~+)(.*)$/.exec(line);
      if (!m) continue;
      const ch = m[1][0];
      const len = m[1].length;
      if (!openFence) {
        openFence = { marker: ch.repeat(len), line: line.trim(), char: ch, len };
      } else if (ch === openFence.char && len >= openFence.len && !m[2].trim()) {
        openFence = null;
      }
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
export const fileSafe = (s) => String(s ?? '')
  .replace(/[\\/:*?"<>|\s]+/g, '-')
  .replace(/-+/g, '-')
  .slice(0, 40)
  .replace(/^-|-$/g, '');

/** 统一清洗入站/出站附件文件名，去除路径段、危险字符与前导点。 */
export function safeAttachmentName(raw, fallback = 'file') {
  const baseName = path.posix.basename(String(raw || fallback).replace(/\\/g, '/'));
  return baseName.replace(/[^\w.\-\u4e00-\u9fff]/g, '_').replace(/^\.+/, '_').slice(-100) || fallback;
}

/** 原子写入 JSON 文件（先写临时文件再 rename），防止半写损坏状态。 */
export function writeJsonAtomic(filePath, data, { pretty = false } = {}) {
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

/** 清理目录中超过 maxAgeMs 毫秒的临时文件，并移除空子目录。 */
export function pruneExpiredFiles(dir, maxAgeMs, { keepPaths, now = Date.now() } = {}) {
  const ttl = Number(maxAgeMs);
  if (!dir || !(ttl > 0) || !fs.existsSync(dir)) return 0;
  const cutoff = now - ttl;
  const keep = keepPaths ? new Set([...keepPaths].map((p) => path.resolve(String(p)))) : null;
  let removed = 0;

  const walk = (cur, isRoot) => {
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        walk(full, false);
      } else if (ent.isFile()) {
        if (keep?.has(path.resolve(full))) continue;
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
