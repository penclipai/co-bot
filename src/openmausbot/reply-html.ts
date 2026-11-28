/**
 * 长回复零 JS 单文件编辑风 HTML 排版渲染器（严格适配 CSP `script-src 'none'`）。
 */
import { clip, fileSafe } from '../format.ts';
import type { LongReplyFormat } from '../types.ts';
import { escapeHtml } from './help-html.ts';

export interface ReplyHtmlTocItem {
  id: string;
  level: number;
  text: string;
}

export interface RenderedMarkdownHtml {
  html: string;
  toc: ReplyHtmlTocItem[];
  hasStructure: boolean;
}

export interface BuildReplyHtmlOptions {
  markdown: string;
  botName?: string;
  title?: string;
  originName?: string;
  generatedAt?: number;
}

const FENCE_OPEN_RE = /^\s*(```+|~~~+)\s*([\w-]*)\s*$/;
const TABLE_HEAD_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}[-|:\s]*$/;

function stripInlineMdForTitle(raw: string): string {
  return raw
    .replace(/\\([\\`*_[\]<>|#])/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]\n]+)\]\(https?:\/\/[^\s)]+\)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 提取正文首个 H1/H2 标题（跳过代码块与徽章行）；无标题返回空字符串。 */
export function extractMarkdownTitle(markdown: string): string {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  let inFence: { ch: string; len: number } | null = null;
  for (const line of lines) {
    const fm = FENCE_OPEN_RE.exec(line);
    if (fm) {
      const ch = fm[1][0];
      const len = fm[1].length;
      if (!inFence) inFence = { ch, len };
      else if (ch === inFence.ch && len >= inFence.len && !fm[2]) inFence = null;
      continue;
    }
    if (inFence) continue;
    const hm = /^(#{1,2})\s+(.+?)\s*#*\s*$/.exec(line);
    if (hm) {
      const clean = stripInlineMdForTitle(hm[2]);
      if (clean) return clip(clean, 60);
    }
  }
  return '';
}

function analyzeMarkdownStructure(markdown: string): { headings: number; hasTable: boolean; hasListOrCode: boolean } {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  let inFence: { ch: string; len: number } | null = null;
  let headings = 0;
  let hasTable = false;
  let hasListOrCode = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = FENCE_OPEN_RE.exec(line);
    if (fm) {
      const ch = fm[1][0];
      const len = fm[1].length;
      if (!inFence) {
        inFence = { ch, len };
        hasListOrCode = true;
      } else if (ch === inFence.ch && len >= inFence.len && !fm[2]) {
        inFence = null;
      }
      continue;
    }
    if (inFence) continue;
    if (/^#{1,3}\s+\S/.test(line)) headings += 1;
    if (/^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line)) hasListOrCode = true;
    if (!hasTable && i + 1 < lines.length && TABLE_HEAD_RE.test(line) && TABLE_SEP_RE.test(lines[i + 1])) {
      hasTable = true;
    }
  }
  return { headings, hasTable, hasListOrCode };
}

/** 按配置模式选择超长回复的附件格式（auto 自动识别结构化报告与表格升级为 .html）。 */
export function pickLongReplyFormat(markdown: string, mode: LongReplyFormat = 'auto'): Array<'html' | 'md'> {
  if (mode === 'html') return ['html'];
  if (mode === 'md') return ['md'];
  if (mode === 'both') return ['html', 'md'];
  const s = analyzeMarkdownStructure(markdown);
  if (s.hasTable || s.headings >= 2 || (s.headings >= 1 && markdown.length >= 1800 && s.hasListOrCode)) {
    return ['html'];
  }
  return ['md'];
}

/** 生成语义化附件文件名（优先提取文档标题，无标题时回退为 Bot 名）。 */
export function buildLongReplyFilename(markdown: string, fallbackBotName: string, ext: 'html' | 'md'): string {
  const title = extractMarkdownTitle(markdown);
  const titleSafe = title ? fileSafe(title).slice(0, 32).replace(/^[.-]+|[.-]+$/g, '') : '';
  const base = titleSafe.length >= 2 ? titleSafe : (fileSafe(fallbackBotName) || 'reply');
  return `${base}.${ext}`;
}

function trimBareUrl(u: string): string {
  let url = u.replace(/[.,;:!?*~_>]+$/, '');
  while (url.endsWith(')') && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) {
    url = url.slice(0, -1).replace(/[.,;:!?*~_>]+$/, '');
  }
  return url;
}

function renderInline(src: string): string {
  const keep: string[] = [];
  const hold = (html: string): string => `\u0000${keep.push(html) - 1}\u0000`;
  let s = src
    .replace(/\\([\\`*_[\]<>|#])/g, (_, c: string) => hold(escapeHtml(c)))
    .replace(/`([^`\n]+)`/g, (_, c: string) => hold(`<code>${escapeHtml(c)}</code>`))
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t: string, u: string) => (
      hold(`<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t)}</a>`)
    ))
    .replace(/https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g, (raw) => {
      const u = trimBareUrl(raw);
      const tail = raw.slice(u.length);
      return u ? `${hold(`<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(u)}</a>`)}${tail}` : raw;
    });
  s = escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>');
  // eslint-disable-next-line no-control-regex
  for (let pass = 0; pass < 5 && /\u0000\d+\u0000/.test(s); pass++) {
    // eslint-disable-next-line no-control-regex
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => keep[Number(i)] ?? '');
  }
  return s;
}

function splitTableCells(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, '').replace(/(^|[^\\])\|$/, '$1');
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let j = 0; j < trimmed.length; j += 1) {
    const ch = trimmed[j];
    if (ch === '\\' && !inCode && j + 1 < trimmed.length) {
      cur += ch + trimmed[++j];
      continue;
    }
    if (ch === '`') {
      inCode = !inCode;
      cur += ch;
      continue;
    }
    if (ch === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function parseTableAlignments(sepRow: string): Array<'left' | 'center' | 'right' | ''> {
  return splitTableCells(sepRow).map((c) => {
    const s = c.trim();
    const left = s.startsWith(':');
    const right = s.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return '';
  });
}

function renderListItemBody(raw: string): string {
  const taskM = /^\[( |x|X)\]\s+([\s\S]*)$/.exec(raw);
  const body = taskM ? taskM[2] : raw;
  const formatted = body.split('\n').map((x) => renderInline(x.replace(/ {2,}$/, ''))).join('<br>');
  if (!taskM) return `<li>${formatted}</li>`;
  const checked = taskM[1].toLowerCase() === 'x';
  return `<li class="task-item"><span class="chk${checked ? ' done' : ''}" aria-hidden="true">${checked ? '✓' : ''}</span><span>${formatted}</span></li>`;
}

/** 零依赖安全渲染 Markdown 为 HTML 片段，并返回二级/三级标题目录。 */
export function renderMarkdownToHtml(markdown: string): RenderedMarkdownHtml {
  const toc: ReplyHtmlTocItem[] = [];
  let secSeq = 0;
  let hasTable = false;

  const renderBlock = (src: string, collectToc: boolean): string => {
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    const out: string[] = [];
    const para: string[] = [];
    const flushPara = () => {
      if (!para.length) return;
      out.push(`<p>${para.map((l) => renderInline(l.replace(/ {2,}$/, ''))).join('<br>')}</p>`);
      para.length = 0;
    };

    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      const fm = FENCE_OPEN_RE.exec(l);
      if (fm) {
        flushPara();
        const fChar = fm[1][0];
        const fLen = fm[1].length;
        const lang = fm[2];
        const closeRe = new RegExp(`^\\s*\\${fChar}{${fLen},}\\s*$`);
        const body: string[] = [];
        i += 1;
        while (i < lines.length && !closeRe.test(lines[i])) {
          body.push(lines[i]);
          i += 1;
        }
        i += 1;
        const codeHtml = body.map((b) => (
          lang === 'diff' && /^[+-]/.test(b)
            ? `<span class="${b[0] === '+' ? 'add' : 'del'}">${escapeHtml(b)}</span>`
            : escapeHtml(b)
        )).join('\n');
        const langBadge = lang ? `<div class="code-lang">${escapeHtml(lang)}</div>` : '';
        out.push(`<div class="code-wrap">${langBadge}<pre><code>${codeHtml}</code></pre></div>`);
        continue;
      }
      if (!l.trim()) {
        flushPara();
        i += 1;
        continue;
      }
      const hm = /^(#{1,6})\s+(.*)$/.exec(l);
      if (hm) {
        flushPara();
        const level = hm[1].length;
        const cleanText = stripInlineMdForTitle(hm[2]);
        let idAttr = '';
        if (collectToc && level >= 2 && level <= 3 && toc.length < 12 && cleanText) {
          secSeq += 1;
          const id = `sec-${secSeq}`;
          toc.push({ id, level, text: clip(cleanText, 40) });
          idAttr = ` id="${id}"`;
        }
        out.push(`<h${level}${idAttr}>${renderInline(hm[2].replace(/\s+#+\s*$/, ''))}</h${level}>`);
        i += 1;
        continue;
      }
      if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(l)) {
        flushPara();
        out.push('<hr>');
        i += 1;
        continue;
      }
      if (/^\s*>/.test(l)) {
        flushPara();
        const q: string[] = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          q.push(lines[i].replace(/^\s*>\s?/, ''));
          i += 1;
        }
        out.push(`<blockquote>${renderBlock(q.join('\n'), false)}</blockquote>`);
        continue;
      }
      if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(l)) {
        flushPara();
        const ordered = /^\s*\d/.test(l);
        const itemRe = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
        const items: string[] = [];
        let hasTask = false;
        while (i < lines.length && itemRe.test(lines[i])) {
          let item = lines[i++].replace(itemRe, '');
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])) {
            item += '\n' + lines[i++].trim();
          }
          if (/^\[( |x|X)\]\s+/.test(item)) hasTask = true;
          items.push(renderListItemBody(item));
        }
        const cls = hasTask ? ' class="task-list"' : '';
        out.push(ordered ? `<ol${cls}>${items.join('')}</ol>` : `<ul${cls}>${items.join('')}</ul>`);
        continue;
      }
      if (i + 1 < lines.length && TABLE_HEAD_RE.test(l) && TABLE_SEP_RE.test(lines[i + 1])) {
        flushPara();
        hasTable = true;
        const head = splitTableCells(l).map((c) => renderInline(c));
        const aligns = parseTableAlignments(lines[i + 1]);
        i += 2;
        const rows: string[][] = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) {
          rows.push(splitTableCells(lines[i]).map((c) => renderInline(c)));
          i += 1;
        }
        const alignAttr = (idx: number) => (aligns[idx] ? ` style="text-align:${aligns[idx]}"` : '');
        const ths = head.map((c, idx) => `<th${alignAttr(idx)}>${c}</th>`).join('');
        const trs = rows.map((r) => `<tr>${head.map((_, idx) => `<td${alignAttr(idx)}>${r[idx] ?? ''}</td>`).join('')}</tr>`).join('');
        out.push(`<div class="tbl-wrap"><table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`);
        continue;
      }
      para.push(l);
      i += 1;
    }
    flushPara();
    return out.join('');
  };

  const html = renderBlock(String(markdown ?? ''), true);
  return { html, toc, hasStructure: hasTable || toc.length >= 2 };
}

/** 生成零 JS、移动端友好、带亮暗切换与可折叠 Markdown 原文的编辑风单文件 HTML 报告。 */
export function buildReplyHtml({
  markdown,
  botName = 'co-bot',
  title = '',
  originName = '',
  generatedAt = Date.now(),
}: BuildReplyHtmlOptions): string {
  const rawMd = String(markdown ?? '').trim();
  const brand = escapeHtml(String(botName || 'co-bot').trim() || 'co-bot');
  const resolvedTitle = title || extractMarkdownTitle(rawMd) || `${brand} 完整回复`;
  const safeTitle = escapeHtml(resolvedTitle);
  const rendered = renderMarkdownToHtml(rawMd);
  const compactChars = rawMd.replace(/\s+/g, '').length;
  const readMins = Math.max(1, Math.round(compactChars / 450));
  const timeStr = new Date(generatedAt).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const originChip = originName ? `<span class="meta-pill">来自「${escapeHtml(originName)}」</span>` : '';
  const startsWithH1 = /^#\s+\S/.test(rawMd);
  const leadHeaderHtml = startsWithH1 ? '' : `<h1 class="doc-title">${safeTitle}</h1>`;
  const tocHtml = rendered.toc.length >= 2
    ? `<nav class="toc" aria-label="目录">${rendered.toc.map((t) => `<a class="lvl-${t.level}" href="#${t.id}">${escapeHtml(t.text)}</a>`).join('')}</nav>`
    : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${safeTitle} · ${brand}</title>
  <style>
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      background: #14120b;
      font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
      font-size: 15.5px;
      line-height: 1.72;
      -webkit-font-smoothing: antialiased;
    }
    body:has(#theme-toggle:checked) { background: #f7f6f2; }
    .theme-input { position: fixed; opacity: 0; pointer-events: none; width: 0; height: 0; }
    .page {
      --page-bg: #14120b;
      --surface: #1b1913;
      --surface-alt: #211e17;
      --surface-border: rgba(237, 236, 236, 0.12);
      --chip-bg: #252219;
      --ink: #edecec;
      --ink-soft: rgba(237, 236, 236, 0.88);
      --ink-muted: rgba(237, 236, 236, 0.68);
      --ink-faint: rgba(237, 236, 236, 0.5);
      --border: rgba(237, 236, 236, 0.14);
      --accent: #f54e00;
      --code-bg: #232018;
      --code-ink: #f4b79b;
      --link: #7cb7ff;
      --add: #4ade80;
      --del: #f87171;
      min-height: 100vh;
      background: var(--page-bg);
      color: var(--ink);
      color-scheme: dark;
      transition: background-color 0.2s ease, color 0.2s ease;
    }
    #theme-toggle:checked ~ .page {
      --page-bg: #f7f6f2;
      --surface: #ffffff;
      --surface-alt: #f3f1ea;
      --surface-border: #e3dfd4;
      --chip-bg: #efede6;
      --ink: #1a1814;
      --ink-soft: #2e2a23;
      --ink-muted: #5c574b;
      --ink-faint: #7a7365;
      --border: #ddd8cc;
      --accent: #d94400;
      --code-bg: #f0ede4;
      --code-ink: #8b2b00;
      --link: #0969da;
      --add: #1a7f37;
      --del: #cf222e;
      color-scheme: light;
    }
    .wrap { max-width: 740px; margin: 0 auto; padding: 20px 16px 52px; }
    .top-bar { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
    .meta-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; color: var(--ink-faint); }
    .brand-tag { color: var(--accent); font-weight: 600; }
    .meta-pill { padding: 1px 8px; border-radius: 999px; background: var(--chip-bg); color: var(--ink-muted); border: 1px solid var(--surface-border); font-size: 12px; }
    .theme-btn {
      display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px;
      border-radius: 4px; background: var(--surface); border: 1px solid var(--border);
      color: var(--ink-soft); font-size: 12px; cursor: pointer; user-select: none;
    }
    .theme-btn:hover { border-color: var(--accent); color: var(--accent); }
    .lbl-dark { display: none; }
    #theme-toggle:checked ~ .page .lbl-light { display: none; }
    #theme-toggle:checked ~ .page .lbl-dark { display: inline; }
    .toc {
      display: flex; flex-wrap: wrap; gap: 6px;
      background: var(--surface); border: 1px solid var(--surface-border);
      border-radius: 6px; padding: 10px 12px; margin: 0 0 22px;
    }
    .toc a {
      color: var(--ink-soft); text-decoration: none; font-size: 12.5px;
      padding: 2px 9px; border-radius: 4px; background: var(--chip-bg);
    }
    .toc a.lvl-3 { color: var(--ink-muted); font-size: 12px; }
    .toc a:hover { color: var(--accent); }
    .prose { overflow-wrap: anywhere; }
    .prose h1, .doc-title { font-size: 25px; line-height: 1.28; font-weight: 600; margin: 0 0 14px; letter-spacing: -0.015em; }
    .prose h2 { font-size: 19px; line-height: 1.35; margin: 28px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--surface-border); }
    .prose h3 { font-size: 16.5px; margin: 20px 0 8px; }
    .prose h4, .prose h5, .prose h6 { font-size: 15px; margin: 16px 0 6px; }
    .prose p { margin: 0 0 13px; color: var(--ink-soft); }
    .prose ul, .prose ol { margin: 0 0 14px; padding-left: 1.45em; color: var(--ink-soft); }
    .prose li { margin-bottom: 5px; }
    .prose ul.task-list { list-style: none; padding-left: 0.2em; }
    .prose li.task-item { display: flex; align-items: flex-start; gap: 8px; }
    .prose .chk {
      flex: none; width: 16px; height: 16px; margin-top: 4px;
      border: 1.5px solid var(--border); border-radius: 4px;
      display: inline-grid; place-items: center; font-size: 11px; line-height: 1;
    }
    .prose .chk.done { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 700; }
    .prose blockquote {
      margin: 12px 0 14px; padding: 8px 14px; border-left: 3px solid var(--accent);
      background: var(--surface); border-radius: 0 6px 6px 0; color: var(--ink-muted);
    }
    .prose blockquote p:last-child { margin-bottom: 0; }
    .prose hr { border: 0; border-top: 1px solid var(--border); margin: 22px 0; }
    .prose a { color: var(--link); text-decoration: none; }
    .prose a:hover { text-decoration: underline; }
    .prose code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px; color: var(--code-ink); background: var(--code-bg);
      padding: 1px 5px; border-radius: 4px;
    }
    .code-wrap { margin: 12px 0 16px; background: var(--surface); border: 1px solid var(--surface-border); border-radius: 6px; overflow: hidden; }
    .code-lang { padding: 4px 12px; font-size: 11.5px; color: var(--ink-faint); background: var(--surface-alt); border-bottom: 1px solid var(--surface-border); font-family: ui-monospace, monospace; }
    .prose pre { margin: 0; padding: 12px 14px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .prose pre code { background: none; color: var(--ink); padding: 0; font-size: 13px; line-height: 1.55; }
    .prose pre .add { color: var(--add); }
    .prose pre .del { color: var(--del); }
    .tbl-wrap { margin: 14px 0 16px; overflow-x: auto; -webkit-overflow-scrolling: touch; border: 1px solid var(--surface-border); border-radius: 6px; background: var(--surface); }
    table { width: 100%; border-collapse: collapse; font-size: 14px; line-height: 1.5; }
    th, td { border-bottom: 1px solid var(--surface-border); border-right: 1px solid var(--surface-border); padding: 7px 11px; text-align: left; overflow-wrap: break-word; word-break: normal; }
    th:last-child, td:last-child { border-right: 0; }
    tr:last-child td { border-bottom: 0; }
    th { background: var(--surface-alt); color: var(--ink); font-weight: 600; white-space: nowrap; }
    .raw-md {
      margin-top: 28px; background: var(--surface); border: 1px solid var(--surface-border);
      border-radius: 6px; padding: 10px 14px;
    }
    .raw-md summary { cursor: pointer; font-size: 13px; color: var(--ink-muted); user-select: none; }
    .raw-md pre { margin: 10px 0 0; padding: 10px 12px; background: var(--surface-alt); border-radius: 4px; overflow-x: auto; max-height: 360px; }
    .raw-md pre code { font-size: 12.5px; color: var(--ink-soft); font-family: ui-monospace, Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
    .foot {
      margin-top: 26px; padding-top: 12px; border-top: 1px solid var(--border);
      font-size: 12.5px; color: var(--ink-faint); display: flex; justify-content: space-between; align-items: center;
    }
    @media (min-width: 600px) {
      .wrap { padding: 32px 24px 60px; }
      .prose h1, .doc-title { font-size: 28px; }
    }
  </style>
</head>
<body>
  <input type="checkbox" id="theme-toggle" class="theme-input" aria-label="切换亮色或暗色主题" />
  <div class="page">
  <main class="wrap">
    <div class="top-bar">
      <div class="meta-left">
        <span class="brand-tag">${brand}</span>
        ${originChip}
        <span>约 ${compactChars} 字 · 阅读约 ${readMins} 分钟 · ${escapeHtml(timeStr)}</span>
      </div>
      <label for="theme-toggle" class="theme-btn" title="切换亮色 / 暗色主题"><span class="lbl-light">☀️ 亮色</span><span class="lbl-dark">🌙 暗色</span></label>
    </div>
    ${leadHeaderHtml}
    ${tocHtml}
    <article class="prose">${rendered.html}</article>
    <details class="raw-md">
      <summary>查看 Markdown 原文</summary>
      <pre><code>${escapeHtml(rawMd)}</code></pre>
    </details>
    <footer class="foot">
      <span>由 ${brand} 生成 · 零脚本安全排版</span>
      <span>■</span>
    </footer>
  </main>
  </div>
</body>
</html>
`;
}
