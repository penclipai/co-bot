import { clip } from '../format.ts';
import type { ChannelAction } from '../types.ts';
import type { NormalizedCardQuestion, OmbCardQuestion, OmbHttpError, OmbMessage } from './types.ts';

const SIMPLE_ALLOW_RE = /^(ok|okay|yes|y|allow|allow once|always|always allow|apply|approve|save|confirm|create|deny|no|cancel|reject|允许|仅此一次|总是允许|应用|保存|确认|拒绝|取消)$/i;
const GENERIC_SPOKEN_RE = /^(running a command|reading a file|searching|searching files|editing a file|writing a file|thinking|working)\.?$/i;

const CHOICE_DIGIT_MAP: Record<string, number> = {
  '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const CHOICE_INDEX_RE = /^(?:(?:选|选择|要|用|就|就选|切|切到|换|换到)\s*)?(?:第\s*)?([1-9一二两三四五六七八九])(?:\s*(?:个|项|条|号|种|步))?\s*[.。、]?$/;

export interface ExtractedCardInfo {
  isQuestion: boolean;
  isReviewProposal: boolean;
  title: string;
  questionText: string;
  options: Array<{ label: string; description: string }>;
  questions: NormalizedCardQuestion[];
  canRememberCommand: boolean;
}

export interface FormattedCardPrompt {
  text: string;
  actions: ChannelAction[];
  info: ExtractedCardInfo | { cardKind: 'secret' | 'connector' | 'signIn' | 'burst'; isQuestion?: boolean; options?: never[]; canRememberCommand?: boolean } | null;
}

/** 解析纯序号或中文口语序数（如 `2`、`2.`、`第二个`、`选一`、`三号`），返回 1..9 或 null。 */
export function parseChoiceIndex(rawText: unknown): number | null {
  const s = String(rawText ?? '').trim();
  if (!s) return null;
  const m = CHOICE_INDEX_RE.exec(s);
  return m ? (CHOICE_DIGIT_MAP[m[1]] ?? null) : null;
}

/** 解析单选或逗号/空格分隔的多选序号（如 `1,2`、`1 3`、`1、2`），返回映射后的选项文本。 */
export function parseMultiChoiceAnswer(
  rawText: unknown,
  options: Array<{ label: string }>,
  multiSelect = false,
): string | null {
  const s = String(rawText ?? '').trim();
  if (!s || !Array.isArray(options) || !options.length) return null;
  if (multiSelect && /^\d+(?:\s*[,，、\s]\s*\d+)+$/.test(s)) {
    const nums = [...new Set(s.split(/[,，、\s]+/).map(Number))];
    const picked = nums
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= options.length)
      .map((n) => options[n - 1]?.label)
      .filter((v): v is string => Boolean(v));
    if (picked.length) return picked.join(', ');
  }
  const single = parseChoiceIndex(s);
  if (single && options[single - 1]?.label) return options[single - 1].label;
  return null;
}

/** 格式化多题提问卡收集到的全部问答结果。 */
export function formatMultiQuestionAnswers(questions: NormalizedCardQuestion[], answers: string[]): string {
  return questions
    .map((q, i) => `Q: ${q.question || q.header || `问题${i + 1}`}\nA: ${answers[i] ?? ''}`)
    .join('\n\n');
}

const TOOL_LABELS: Record<string, string> = {
  bash: '执行命令',
  shell: '执行命令',
  run_command: '执行命令',
  read: '读取文件',
  read_file: '读取文件',
  grep: '搜索代码',
  ripgrep: '搜索代码',
  search: '搜索代码',
  glob: '查找文件',
  find: '查找文件',
  list_dir: '查看目录',
  edit: '修改文件',
  edit_file: '修改文件',
  patch: '修改文件',
  write: '写入文件',
  write_file: '写入文件',
  webfetch: '抓取网页',
  fetch: '抓取网页',
  websearch: '联网搜索',
  search_web: '联网搜索',
  ask_user: '等待你确认',
};

export function fmtTokens(n: unknown): string {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${Math.round(v / 1000)}K`;
  return String(v);
}

export function usageBar(pct: number, width = 6): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function toolLabel(rawName: unknown): { label: string; mapped: boolean } {
  const raw = String(rawName ?? '').trim();
  if (!raw) return { label: '', mapped: false };
  const low = raw.toLowerCase();
  if (TOOL_LABELS[low]) return { label: TOOL_LABELS[low], mapped: true };
  if (/^(browser_|playwright_)/.test(low)) return { label: '操作浏览器', mapped: true };
  return { label: raw, mapped: false };
}

/** 将 OpenMausBot 工具活动消息格式化为去噪后的中文进度摘要。 */
export function formatActivity(msg: OmbMessage | null | undefined): string {
  const { label, mapped } = toolLabel(msg?.tool?.name);
  const rawSpoken = String(msg?.tool?.spoken ?? '').trim();
  const spoken = rawSpoken && !GENERIC_SPOKEN_RE.test(rawSpoken) ? rawSpoken : '';
  const verb = mapped ? `正在${label}` : (label ? `正在调用 ${label}` : '');
  if (spoken && verb) return `⚙️ ${verb}（${clip(spoken, 40)}）…`;
  if (spoken) return `⚙️ ${clip(spoken, 50)}…`;
  if (verb) return `⚙️ ${verb}…`;
  return '⏳ 还在处理中…';
}

/** 格式化 /goal 运行中的进度摘要。 */
export function formatGoalProgress(msg: OmbMessage | null | undefined): string {
  const run = msg?.goalRun;
  if (!run) return clip(String(msg?.text ?? '').trim() || '🎯 目标推进中…', 60);
  const step = run.turnCount && run.maxTurns ? `（第 ${run.turnCount}/${run.maxTurns} 步）` : '';
  const detail = String(run.detail ?? '').trim();
  const suffix = detail ? `：${clip(detail, 50)}` : '…';
  return `🎯 目标推进中${step}${suffix}`;
}

/** 格式化 OpenMausBot HTTP/SSE 错误信息，401/403 时附带配对修复指引。 */
export function formatOmbError(e: unknown): string {
  const err = e as OmbHttpError | null | undefined;
  const msg = err?.message || String(e);
  if (err?.status === 401 || err?.status === 403 || /desktop app|paired device|expired|revoked/i.test(msg)) {
    return `${msg}\n💡 后台服务需要配对 Token：运行 \`npm run pair\`（桌面端一键允许）或 \`npm run pair -- <12位配对码>\`，完成后重启 co-bot。`;
  }
  return msg;
}

function normalizeCardOptions(arr: unknown): Array<{ label: string; description: string }> {
  if (!Array.isArray(arr)) return [];
  const out: Array<{ label: string; description: string }> = [];
  for (const item of arr) {
    if (typeof item === 'string') {
      const label = item.trim();
      if (label) out.push({ label, description: '' });
    } else if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      const label = String(rec.label ?? rec.value ?? rec.title ?? '').trim();
      const description = String(rec.description ?? '').trim();
      if (label) out.push({ label, description });
    }
  }
  return out;
}

function normalizeCardQuestions(raw: unknown): NormalizedCardQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedCardQuestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const q = item as OmbCardQuestion;
    out.push({
      question: String(q.question ?? '').trim(),
      header: String(q.header ?? '').trim(),
      multiSelect: Boolean(q.multiSelect),
      options: normalizeCardOptions(q.options),
    });
  }
  return out;
}

export interface CardRenderOpts {
  multiCard?: boolean;
  inboxRef?: number;
}

function formatQuoteBlock(text: string, maxChars: number): string {
  const clipped = clip(String(text ?? '').trim(), maxChars);
  if (!clipped) return '';
  return clipped.split('\n').map((line) => (line.trim() ? `> ${line}` : '>')).join('\n');
}

const cardFooterNote = (opts: CardRenderOpts = {}, skipOnly = false): string => {
  const ref = opts.inboxRef;
  if (opts.multiCard) {
    return ref
      ? `\n> 💡 当前有多条待确认，请**引用本条消息**回复（或直接回复 \`#${ref} ${skipOnly ? '0' : '1/0'}\`）`
      : '\n> 💡 当前有多条待确认，请**引用本条消息**回复';
  }
  return ref ? ` · 编号 \`#${ref}\`` : '';
};

/** 渲染提问卡指定题号的 Markdown 伪卡片文案（无真卡片按钮，适配全 IM 客户端）。 */
export function formatQuestionStepPrompt(
  whoPrefix: string,
  title: string,
  questions: NormalizedCardQuestion[],
  stepIndex = 0,
  opts: CardRenderOpts = {},
): { text: string; actions: ChannelAction[] } {
  const head = whoPrefix ? `${whoPrefix} ` : '';
  const q = questions[stepIndex] ?? { question: '', header: '', multiSelect: false, options: [] };
  const total = questions.length;
  const metaParts: string[] = [];
  if (total > 1) metaParts.push(`${stepIndex + 1}/${total}${q.header ? ` · ${q.header}` : ''}`);
  if (q.multiSelect) metaParts.push('可多选');
  const metaSuffix = metaParts.length ? `（${metaParts.join(' · ')}）` : '';
  const lines = [whoPrefix ? `${head}❓ **${title}${metaSuffix}**` : `**❓ ${title}${metaSuffix}**`];
  if (q.question && q.question !== title) {
    const quoted = formatQuoteBlock(q.question, 300);
    if (quoted) lines.push(quoted);
  }
  if (q.options.length) {
    if (lines.length > 1) lines.push('');
    q.options.forEach((opt, i) => {
      lines.push(`${i + 1}. **${opt.label}**${opt.description ? `：${clip(opt.description, 80)}` : ''}`);
    });
    const multiHint = q.multiSelect ? '（多选 **`1,2`**）' : '';
    lines.push(
      '---',
      `👉 回复序号 **\`1\`**${multiHint}、直接打字自定义，或 **\`0\` 取消**${cardFooterNote(opts)}`,
    );
  } else {
    lines.push('---', `👉 直接回复你的想法，或 **\`0\` 取消**${cardFooterNote(opts)}`);
  }
  return { text: lines.join('\n'), actions: [] };
}

/** 解析 OpenMausBot 审批卡或提问选项卡结构。 */
export function extractCardInfo(msg: OmbMessage | null | undefined): ExtractedCardInfo | null {
  const card = msg?.card;
  if (!card || typeof card !== 'object') return null;
  const rawQuestions = Array.isArray(card.questionRequest?.questions) && card.questionRequest.questions.length
    ? card.questionRequest.questions
    : (Array.isArray(card.questions) ? card.questions : []);
  const questions = normalizeCardQuestions(rawQuestions);
  const firstQ = questions[0] ?? null;
  const options = firstQ?.options.length ? firstQ.options : normalizeCardOptions(card.options);
  const simpleAllowDeny = options.length > 0 && options.length <= 3 && options.every((o) => SIMPLE_ALLOW_RE.test(o.label));
  const isReviewProposal = Boolean(
    card.teamSetupRequest
    || card.profileRequest
    || card.appSettingRequest
    || card.mcpRequest
    || card.skillRequest
    || card.routineRequest
    || card.modelRequest,
  );
  const isQuestion = !isReviewProposal && (
    card.requestType === 'question'
    || Boolean(card.questionRequest)
    || questions.length > 0
    || (options.length > 0 && card.requestType !== 'permission' && !simpleAllowDeny)
  );
  const titleRaw = String(card.title || '').trim();
  const title = (isQuestion && /^your bot has a question$/i.test(titleRaw))
    ? '需要你做个决定'
    : (titleRaw || (isQuestion ? '需要你选择' : '需要你确认操作'));
  const questionText = String(firstQ?.question || card.subtitle || (isQuestion ? msg?.text : '') || '').trim();
  const canRememberCommand = Boolean(card.command || card.canRememberCommand || card.rememberCommand);
  return { isQuestion, isReviewProposal, title, questionText, options, questions, canRememberCommand };
}

/** 渲染结构化 Markdown 伪卡片文案（去掉真卡片按钮，适配全 IM 客户端）。 */
export function formatCardPrompt(
  _botName: string,
  msg: OmbMessage,
  whoPrefix: string,
  opts: CardRenderOpts = {},
): FormattedCardPrompt {
  const head = whoPrefix ? `${whoPrefix} ` : '';
  const footNote = cardFooterNote(opts);
  const skipNote = cardFooterNote(opts, true);
  if (msg.card) {
    const info = extractCardInfo(msg)!;
    if (info.isQuestion) {
      const qs = info.questions.length
        ? info.questions
        : [{ question: info.questionText, header: '', multiSelect: false, options: info.options }];
      const rendered = formatQuestionStepPrompt(whoPrefix, info.title, qs, 0, opts);
      return { text: rendered.text, actions: [], info };
    }
    const lines = [`${head}⏸️ **需要确认 · ${info.title}**`];
    const subRaw = String(msg.card.subtitle ?? '').trim();
    if (subRaw) lines.push(formatQuoteBlock(subRaw, 260));
    const cmdRaw = String(msg.card.command ?? '').trim();
    if (cmdRaw && !subRaw.includes(cmdRaw)) {
      lines.push('```sh', clip(cmdRaw, 200), '```');
    }
    if (info.isReviewProposal) {
      lines.push('---', `👉 回复 **\`1\` 允许** · **\`0\` 拒绝**（也支持 \`ok\` / \`no\`）${footNote}`);
    } else {
      lines.push('---', `👉 回复 **\`1\` 允许** · **\`2\` 总是允许** · **\`0\` 拒绝**（也支持 \`ok\` / \`always\` / \`no\`）${footNote}`);
    }
    return { text: lines.join('\n'), actions: [], info };
  }
  if (msg.burst?.burstId) {
    const b = msg.burst;
    const total = Number(b.total ?? b.requested ?? b.counts?.queued ?? 0) || (Array.isArray(b.sample) ? b.sample.length : 0);
    const metaParts: string[] = [];
    if (total > 0) metaParts.push(`共 ${total} 项`);
    if (b.parallel) metaParts.push(`并发 ${b.parallel}`);
    if (b.estimateMinutes) metaParts.push(`预计约 ${b.estimateMinutes} 分钟`);
    const sampleLines = Array.isArray(b.sample)
      ? b.sample.slice(0, 5).map((item) => {
          const rawTitle = typeof item === 'string' ? item : (item?.title ?? item?.item ?? '');
          return clip(String(rawTitle).trim(), 60);
        }).filter(Boolean).map((s) => `- ${s}`)
      : [];
    const lines = [`${head}⚡ **并发任务待确认 · ${clip(b.task || '并行任务', 120)}**`];
    if (metaParts.length) lines.push(`> ${metaParts.join(' · ')}`);
    if (sampleLines.length) lines.push(...sampleLines);
    lines.push('---', `👉 回复 **\`1\` 开始执行** · **\`0\` 取消**（也支持 \`ok\` / \`no\`）${footNote}`);
    return {
      text: lines.join('\n'),
      actions: [],
      info: { cardKind: 'burst' },
    };
  }
  if (msg.secret) {
    return {
      text: `${head}🔐 **需要补充凭据 · 「${msg.secret.label || msg.secret.target || '密钥'}」**\n> 请到管理后台输入对应凭据。\n---\n👉 如需跳过，请回复 **\`0\` 跳过**（也支持 \`skip\` / \`跳过\`）${skipNote}`,
      actions: [],
      info: { cardKind: 'secret' },
    };
  }
  if (msg.connector) {
    return {
      text: `${head}🔌 **需要授权连接器 · 「${msg.connector.label || msg.connector.slug || ''}」**\n> 请到管理后台完成连接器授权。\n---\n👉 如需跳过，请回复 **\`0\` 跳过**（也支持 \`skip\` / \`跳过\`）${skipNote}`,
      actions: [],
      info: { cardKind: 'connector' },
    };
  }
  if (msg.signIn) {
    return {
      text: `${head}🔑 **需要完成登录验证**\n> 请到管理后台完成登录后继续。\n---\n👉 如需跳过，请回复 **\`0\` 跳过**（也支持 \`skip\` / \`跳过\`）${skipNote}`,
      actions: [],
      info: { cardKind: 'signIn' },
    };
  }
  return { text: `${head}⏸️ **需要确认**\n> 请在管理后台确认下一步操作。`, actions: [], info: null };
}

function asWidgetRecord(val: unknown): Record<string, unknown> | null {
  return val && typeof val === 'object' && !Array.isArray(val) ? (val as Record<string, unknown>) : null;
}

function walkWidgetNodes(root: unknown, visit: (node: Record<string, unknown>) => void): void {
  const start = asWidgetRecord(root);
  if (!start) return;
  const stack: Array<{ node: Record<string, unknown>; depth: number }> = [{ node: start, depth: 0 }];
  let visited = 0;
  while (stack.length && visited < 120) {
    const cur = stack.pop()!;
    visited += 1;
    visit(cur.node);
    if (cur.depth >= 12) continue;
    const nextDepth = cur.depth + 1;
    const childList: Record<string, unknown>[] = [];
    if (Array.isArray(cur.node.children)) {
      for (const c of cur.node.children) {
        const rec = asWidgetRecord(c);
        if (rec) childList.push(rec);
      }
    }
    for (const [k, v] of Object.entries(cur.node)) {
      if (k === 'children' || k === 'onClickAction') continue;
      const rec = asWidgetRecord(v);
      if (rec) childList.push(rec);
    }
    for (let i = childList.length - 1; i >= 0; i -= 1) {
      stack.push({ node: childList[i], depth: nextDepth });
    }
  }
}

/** 从 OpenMausBot `kind: 'widget'` 消息的 UI 树提取可点击按钮，转为通道通用的 `ChannelAction[]`。 */
export function extractWidgetActions(
  widget: OmbMessage['widget'] | null | undefined,
  opts: { externalTriggerPrefix?: string } = {},
): ChannelAction[] {
  const root = widget?.root;
  if (!root || typeof root !== 'object') return [];
  const prefix = String(opts.externalTriggerPrefix ?? '').trim();
  const seen = new Set<string>();
  const out: ChannelAction[] = [];
  walkWidgetNodes(root, (node) => {
    if (out.length >= 10) return;
    const isBtn = node.type === 'Button' || Boolean(asWidgetRecord(node.onClickAction));
    if (!isBtn) return;
    const label = String(node.label ?? '').trim();
    if (!label) return;
    const act = asWidgetRecord(node.onClickAction);
    if (act && /^(?:url|link|open_?url)$/i.test(String(act.type ?? '').trim())) return;
    const payload = act ? asWidgetRecord(act.payload) : null;
    const rawReply = String(payload?.text ?? act?.text ?? act?.value ?? label).trim() || label;
    const text = prefix && !rawReply.startsWith('@') ? `${prefix} ${rawReply}` : rawReply;
    const key = `${label}\0${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    const style = String(node.style ?? '').trim().toLowerCase();
    const kind = style === 'primary'
      ? 'primary'
      : ((style === 'danger' || style === 'destructive') ? 'danger' : undefined);
    out.push({ label, text, ...(kind ? { kind } : {}) });
  });
  return out;
}

/** 当 `kind: 'widget'` 缺少兜底文本时，从 widget UI 树提取标题、说明与按钮标签作为降级展示文本。 */
export function extractWidgetFallbackText(msg: OmbMessage | null | undefined): string {
  const direct = String(msg?.text ?? '').trim();
  if (direct) return direct;
  const root = msg?.widget?.root;
  if (!root || typeof root !== 'object') return '';
  const descLines: string[] = [];
  const seenDesc = new Set<string>();
  const labels: string[] = [];
  const pushDesc = (raw: unknown): void => {
    const s = String(raw ?? '').trim();
    if (!s || seenDesc.has(s)) return;
    seenDesc.add(s);
    descLines.push(s);
  };
  walkWidgetNodes(root, (node) => {
    pushDesc(node.title);
    pushDesc(node.caption);
    const nType = String(node.type ?? '').trim();
    if (/^(?:text|markdown)$/i.test(nType)) {
      pushDesc(node.value ?? node.text);
    }
    if (nType === 'Button' || asWidgetRecord(node.onClickAction)) {
      const lbl = String(node.label ?? '').trim();
      if (lbl && !labels.includes(lbl)) labels.push(lbl);
    }
  });
  if (descLines.length) return descLines.join('\n');
  return labels.length ? `选项：${labels.join(' / ')}` : '';
}
