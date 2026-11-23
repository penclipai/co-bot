import { clip } from '../format.js';

const SIMPLE_ALLOW_RE = /^(ok|okay|yes|y|allow|allow once|always|always allow|deny|no|cancel|reject|允许|仅此一次|总是允许|拒绝|取消)$/i;
const GENERIC_SPOKEN_RE = /^(running a command|reading a file|searching|searching files|editing a file|writing a file|thinking|working)\.?$/i;

const CHOICE_DIGIT_MAP = {
  '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const CHOICE_INDEX_RE = /^(?:(?:选|选择|要|用|就|就选|切|切到|换|换到)\s*)?(?:第\s*)?([1-9一二两三四五六七八九])(?:\s*(?:个|项|条|号|种|步))?\s*[.。、]?$/;

/** 解析纯序号或中文口语序数（如 `2`、`2.`、`第二个`、`选一`、`三号`），返回 1..9 或 null。 */
export function parseChoiceIndex(rawText) {
  const s = String(rawText ?? '').trim();
  if (!s) return null;
  const m = CHOICE_INDEX_RE.exec(s);
  return m ? (CHOICE_DIGIT_MAP[m[1]] ?? null) : null;
}

const TOOL_LABELS = {
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

export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${Math.round(v / 1000)}K`;
  return String(v);
}

export function usageBar(pct) {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function toolLabel(rawName) {
  const raw = String(rawName ?? '').trim();
  if (!raw) return { label: '', mapped: false };
  const low = raw.toLowerCase();
  if (TOOL_LABELS[low]) return { label: TOOL_LABELS[low], mapped: true };
  if (/^(browser_|playwright_)/.test(low)) return { label: '操作浏览器', mapped: true };
  return { label: raw, mapped: false };
}

/** 将 OpenMausBot 工具活动消息格式化为去噪后的中文进度摘要。 */
export function formatActivity(msg) {
  const { label, mapped } = toolLabel(msg?.tool?.name);
  const rawSpoken = String(msg?.tool?.spoken ?? '').trim();
  const spoken = rawSpoken && !GENERIC_SPOKEN_RE.test(rawSpoken) ? rawSpoken : '';
  const verb = mapped ? `正在${label}` : (label ? `正在调用 ${label}` : '');
  if (spoken && verb) return `⚙️ ${verb}（${clip(spoken, 40)}）…`;
  if (spoken) return `⚙️ ${clip(spoken, 50)}…`;
  if (verb) return `⚙️ ${verb}…`;
  return '⏳ 还在处理中…';
}

/** 格式化 OpenMausBot HTTP/SSE 错误信息，401/403 时附带配对修复指引。 */
export function formatOmbError(e) {
  const msg = e?.message || String(e);
  if (e?.status === 401 || e?.status === 403 || /desktop app|paired device|expired|revoked/i.test(msg)) {
    return `${msg}\n💡 后台服务需要配对 Token：运行 \`npm run pair\`（桌面端一键允许）或 \`npm run pair -- <12位配对码>\`，完成后重启 co-bot。`;
  }
  return msg;
}

function normalizeCardOptions(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    if (typeof item === 'string') {
      const label = item.trim();
      if (label) out.push({ label, description: '' });
    } else if (item && typeof item === 'object') {
      const label = String(item.label ?? item.value ?? item.title ?? '').trim();
      const description = String(item.description ?? '').trim();
      if (label) out.push({ label, description });
    }
  }
  return out;
}

/** 解析 OpenMausBot 审批卡或提问选项卡结构。 */
export function extractCardInfo(msg) {
  const card = msg?.card;
  if (!card || typeof card !== 'object') return null;
  const questions = Array.isArray(card.questions) ? card.questions : [];
  const firstQ = questions[0] && typeof questions[0] === 'object' ? questions[0] : null;
  const options = firstQ ? normalizeCardOptions(firstQ.options) : normalizeCardOptions(card.options);
  const simpleAllowDeny = options.length > 0 && options.length <= 3 && options.every((o) => SIMPLE_ALLOW_RE.test(o.label));
  const isQuestion = card.requestType === 'question'
    || questions.length > 0
    || (options.length > 0 && card.requestType !== 'permission' && !simpleAllowDeny);
  const titleRaw = String(card.title || '').trim();
  const title = (isQuestion && /^your bot has a question$/i.test(titleRaw))
    ? '需要你做个决定'
    : (titleRaw || (isQuestion ? '需要你选择' : '需要你确认操作'));
  const questionText = String(firstQ?.question || card.subtitle || (isQuestion ? msg?.text : '') || '').trim();
  const canRememberCommand = Boolean(card.command || card.canRememberCommand || card.rememberCommand);
  return { isQuestion, title, questionText, options, canRememberCommand };
}

/** 渲染审批卡、选项/提问卡或授权提示，同时返回 Web 模拟器快捷按钮。 */
export function formatCardPrompt(_botName, msg, whoPrefix) {
  const head = whoPrefix ? `${whoPrefix} ` : '';
  if (msg.card) {
    const info = extractCardInfo(msg);
    if (info.isQuestion) {
      const lines = [`❓ ${head}${info.title}`];
      if (info.questionText && info.questionText !== info.title) lines.push(clip(info.questionText, 300));
      if (info.options.length) {
        lines.push('');
        info.options.forEach((opt, i) => {
          lines.push(`${i + 1}. **${opt.label}**${opt.description ? ` — ${clip(opt.description, 80)}` : ''}`);
        });
        lines.push('', '回复序号（如 `1`）或直接回复你的想法');
      } else {
        lines.push('', '请直接回复你的想法');
      }
      const actions = info.options.slice(0, 6).map((opt, i) => ({
        label: `${i + 1}. ${clip(opt.label, 22)}`,
        text: String(i + 1),
        ...(i === 0 ? { kind: 'primary' } : {}),
      }));
      return { text: lines.join('\n'), actions, info };
    }
    const sub = msg.card.subtitle ? `\n${clip(msg.card.subtitle, 240)}` : '';
    return {
      text: `⏸️ ${head}${info.title}${sub}\n\n回复 \`ok\` 允许，\`always\` 总是允许，\`no\` 拒绝`,
      actions: [
        { label: '允许', text: 'ok', kind: 'primary' },
        { label: '总是允许', text: 'always' },
        { label: '拒绝', text: 'no', kind: 'danger' },
      ],
      info,
    };
  }
  if (msg.secret) {
    return {
      text: `🔐 ${head}需要补充凭据「${msg.secret.label || msg.secret.target || '密钥'}」，请到管理后台输入；或回复 \`skip\` / \`跳过\` 先跳过。`,
      actions: [{ label: '跳过', text: 'skip' }],
      info: { cardKind: 'secret' },
    };
  }
  if (msg.connector) {
    return {
      text: `🔌 ${head}需要授权连接器「${msg.connector.label || msg.connector.slug || ''}」，请到管理后台完成；或回复 \`skip\` / \`跳过\` 先跳过。`,
      actions: [{ label: '跳过', text: 'skip' }],
      info: { cardKind: 'connector' },
    };
  }
  if (msg.signIn) {
    return {
      text: `🔑 ${head}需要完成登录验证，请到管理后台操作；或回复 \`skip\` / \`跳过\` 先跳过。`,
      actions: [{ label: '跳过', text: 'skip' }],
      info: { cardKind: 'signIn' },
    };
  }
  return { text: `⏸️ ${head}需要你在管理后台确认下一步操作。`, actions: [], info: null };
}
