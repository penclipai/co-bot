/**
 * 构建 `@bot help` 移动端零 JS 单文件 HTML 使用指南与架构说明并作为附件下发。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeAttachmentName } from '../format.ts';
import type { OpenMausBotBridge } from './bridge.ts';
import type { CommandSink } from './command-helpers.ts';

const HELP_DIAGRAM_SVG = fs.readFileSync(new URL('./assets/help-diagram.svg', import.meta.url), 'utf8').trim();

type HelpHtmlBridge = Pick<OpenMausBotBridge, 'trigger' | 'botName' | 'followUpWindowMs' | 'commandRegistry'>;

/** 转义 HTML 文本与属性中的特殊字符。 */
export function escapeHtml(raw: unknown): string {
  return String(raw ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** 生成完全自包含、零 JS 的 `@bot help` 暗色编辑风 HTML 指南。 */
export function buildHelpHtml(bridge: HelpHtmlBridge): string {
  const brand = escapeHtml(bridge.botName || 'co-bot');
  const trigger = escapeHtml(bridge.trigger || '@bot');
  const followUpSec = Math.max(1, Math.round((bridge.followUpWindowMs || 120_000) / 1000));
  const extCmds = bridge.commandRegistry?.list() ?? [];
  const extRowHtml = extCmds.length
    ? `\n        <div class="cmd-row"><div><code>扩展指令</code></div><div class="cmd-desc">${extCmds
      .map((c) => `<code>${trigger} ${escapeHtml(c.name)}</code>${c.description ? `（${escapeHtml(c.description)}）` : ''}`)
      .join('、')}</div></div>`
    : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${brand} 使用指南</title>
  <style>
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      background: #14120b;
      color: #edecec;
      font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
      font-size: 15px;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    .wrap { max-width: 660px; margin: 0 auto; padding: 24px 16px 48px; }
    .eyebrow {
      font-size: 12px;
      color: rgba(237, 236, 236, 0.56);
      letter-spacing: 0.04em;
      margin-bottom: 8px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 28px;
      font-weight: 500;
      line-height: 1.22;
      letter-spacing: -0.02em;
    }
    .lead {
      margin: 0 0 16px;
      color: rgba(237, 236, 236, 0.72);
      font-size: 15px;
    }
    .toc {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      background: #1b1913;
      border-radius: 4px;
      padding: 10px 12px;
      margin-bottom: 28px;
    }
    .toc a {
      color: #edecec;
      text-decoration: none;
      font-size: 13px;
      padding: 3px 9px;
      border-radius: 4px;
      background: #252219;
    }
    .toc a:hover { color: #f54e00; }
    h2 {
      margin: 34px 0 12px;
      font-size: 19px;
      font-weight: 700;
      letter-spacing: -0.005em;
    }
    p { margin: 0 0 14px; color: rgba(237, 236, 236, 0.86); }
    .diagram-box {
      background: #06080f;
      border: 1px solid rgba(237, 236, 236, 0.14);
      border-radius: 4px;
      padding: 10px;
      margin: 14px 0 16px;
    }
    .diagram-scroll {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    .diagram-scroll svg {
      display: block;
      width: 100%;
      height: auto;
    }
    .d-hint {
      margin-top: 8px;
      font-size: 12px;
      color: rgba(237, 236, 236, 0.52);
      text-align: center;
    }
    .note-grid {
      display: grid;
      gap: 10px;
      margin: 14px 0;
    }
    .flat-card {
      background: #1b1913;
      border-radius: 4px;
      padding: 13px 14px;
    }
    .flat-card h3 {
      margin: 0 0 6px;
      font-size: 14px;
      font-weight: 600;
      color: #edecec;
    }
    .flat-card p {
      margin: 0;
      font-size: 13.5px;
      color: rgba(237, 236, 236, 0.72);
    }
    .cmd-group {
      background: #1b1913;
      border-radius: 4px;
      padding: 12px 14px;
      margin-bottom: 12px;
    }
    .cmd-title {
      font-size: 13px;
      font-weight: 700;
      color: #f54e00;
      margin: 0 0 8px;
    }
    .cmd-row {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 7px 0;
      border-top: 1px solid rgba(237, 236, 236, 0.08);
    }
    .cmd-row:first-of-type { border-top: 0; padding-top: 2px; }
    .cmd-row:last-of-type { padding-bottom: 0; }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12.5px;
      color: #f4b79b;
      background: #252219;
      padding: 1px 5px;
      border-radius: 3px;
    }
    .cmd-desc { font-size: 13px; color: rgba(237, 236, 236, 0.74); }
    .tag {
      display: inline-block;
      font-size: 11px;
      padding: 1px 6px;
      border-radius: 3px;
      margin-left: 6px;
      background: #28241b;
      color: rgba(237, 236, 236, 0.7);
      vertical-align: middle;
    }
    .foot {
      margin-top: 28px;
      padding-top: 14px;
      border-top: 1px solid rgba(237, 236, 236, 0.12);
      font-size: 13px;
      color: rgba(237, 236, 236, 0.6);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .tomb { color: #f54e00; font-size: 14px; }
    @media (min-width: 560px) {
      .wrap { padding: 36px 24px 56px; }
      .note-grid { grid-template-columns: repeat(2, 1fr); }
      .cmd-row { flex-direction: row; justify-content: space-between; align-items: baseline; gap: 12px; }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <div class="eyebrow">${brand} · 使用指南</div>
    <h1>多人协作的 IM 智能体工作区</h1>
    <p class="lead">把日常自聊与群聊直接升级为团队 AI 协作空间。每位成员保留私密自聊与独立的群聊对话上下文，同时在团队间按需共享信息、发起跨人协作，并守住出站安全边界。</p>

    <nav class="toc" aria-label="目录">
      <a href="#workspace">协作架构</a>
      <a href="#context">统一上下文</a>
      <a href="#safety">协同与安全</a>
      <a href="#commands">指令速查</a>
    </nav>

    <section id="workspace">
      <h2>多人协作、多智能体 IM 工作区</h2>
      <p>传统协同工具并非为 AI 智能体协作而设计。${brand} 直接生长在日常 IM 里：每位成员用习惯的自聊与群聊指挥各自的 AI 助手，底层多智能体按角色并行推进任务，同时依托一套按权限开放的团队共享上下文底座，让信息自然流转。</p>
      <div class="diagram-box">
        <div class="diagram-scroll">${HELP_DIAGRAM_SVG}</div>
        <div class="d-hint">双指缩放可放大查看节点细节</div>
      </div>
    </section>

    <section id="context">
      <h2>面向团队的统一上下文系统</h2>
      <p>每位成员在自聊中拥有私密 1:1 空间与连续对话窗口（${followUpSec} 秒内免 @ 直接续聊，以 <code>#</code> 或 <code>备忘</code> 开头的私人笔记会自动忽略）；在外部群聊中，每个群与不同助手自动隔离会话，互不串台。</p>
      <div class="note-grid">
        <div class="flat-card">
          <h3>转发记录与历史回溯</h3>
          <p>直接转发单条消息或合并聊天记录即可交给助手分析；遇到超长记录会自动先提炼摘要，需要细节时再按需查看原文与更早群聊历史，并自动忽略已撤回消息。</p>
        </div>
        <div class="flat-card">
          <h3>团队知识库与项目范围</h3>
          <p>团队共享的规范与约定会自动同步给各成员助手；同时可通过 <code>${trigger} bind</code> 为会话指定对应项目范围，确保排查与问答只围绕当前项目展开，避免跨项目干扰。</p>
        </div>
      </div>
    </section>

    <section id="safety">
      <h2>跨人协同与出站安全边界</h2>
      <p>不同成员的 ${brand} 之间支持私聊双向异步委托，自动对齐依赖、交接排查进展；外部群里经授权的同事也可在只读模式下获得协助，所有需要发回群里的内容均需本人确认。</p>
      <div class="note-grid">
        <div class="flat-card">
          <h3>@同事追问与私密起草</h3>
          <p>在群里发 <code>${trigger}!</code> 可先把回复草稿发到自聊润色，确认后再发回原群；助手需要向同事核实信息时也会先征得你同意再正式提醒对方，并将结论私密汇总给你。</p>
        </div>
        <div class="flat-card">
          <h3>敏感信息脱敏与防误打扰</h3>
          <p>公开回复与文本附件会自动检测并隐藏密钥、连接串等敏感凭证；外部群默认屏蔽 @所有人 与无关提醒，且所有对外回复统一带有 🤖 机器人标识，避免与本人发言混淆。</p>
        </div>
      </div>
    </section>

    <section id="commands">
      <h2>常用指令速查</h2>
      <div class="cmd-group">
        <div class="cmd-title">通用（${trigger} / @Bot名 / @群名 均可用）</div>
        <div class="cmd-row"><div><code>${trigger} &lt;问题&gt;</code> / <code>${trigger}!</code></div><div class="cmd-desc">向主助手或指定对象提问；外群加 <code>!</code> 先私密起草回自聊</div></div>
        <div class="cmd-row"><div><code>${trigger} new [话题]</code> / <code>task [号]</code></div><div class="cmd-desc">新建会话，或列出并切换最近会话</div></div>
        <div class="cmd-row"><div><code>${trigger} stop</code></div><div class="cmd-desc">停止当前任务并清空该会话排队</div></div>
        <div class="cmd-row"><div><code>${trigger} status [群]</code><span class="tag">仅单Bot</span></div><div class="cmd-desc">查看在线状态、成员与上下文占用（不含 @群名）</div></div>
        <div class="cmd-row"><div><code>${trigger} compact [群]</code><span class="tag">仅单Bot</span></div><div class="cmd-desc">压缩当前或指定外群的对话上下文（不含 @群名）</div></div>
        <div class="cmd-row"><div><code>${trigger} bye</code></div><div class="cmd-desc">结束自聊 ${followUpSec} 秒免 @ 连续对话</div></div>${extRowHtml}
      </div>

      <div class="cmd-group">
        <div class="cmd-title">仅主入口 ${trigger} 可用</div>
        <div class="cmd-row"><div><code>${trigger} sendback [ID]</code></div><div class="cmd-desc">在自聊预览并确认将草稿发回原群（确认发送 / 改：… / 取消）</div></div>
        <div class="cmd-row"><div><code>${trigger} chats [self|all|reset]</code></div><div class="cmd-desc">查看外群开关状态，一键切换仅自聊或恢复全部</div></div>
        <div class="cmd-row"><div><code>${trigger} mute|unmute [群]</code></div><div class="cmd-desc">静音或恢复指定外部群（自聊受保护不可静音）</div></div>
        <div class="cmd-row"><div><code>${trigger} summary &lt;群&gt; [条数]</code></div><div class="cmd-desc">在自聊悄悄生成外部群近况纪要</div></div>
        <div class="cmd-row"><div><code>${trigger} bind [项目|unbind]</code></div><div class="cmd-desc">绑定或解绑当前会话对应的项目范围</div></div>
        <div class="cmd-row"><div><code>${trigger} delegate &lt;私聊&gt; &lt;问题&gt;</code></div><div class="cmd-desc">向同事的 ${brand} 发起异步协作委托</div></div>
      </div>

      <div class="cmd-group">
        <div class="cmd-title">审批与提问卡片快捷回复</div>
        <div class="cmd-row"><div><code>1</code> / <code>2</code> / <code>0</code> 或 <code>ok/always/no/skip</code></div><div class="cmd-desc">允许本次 / 总是允许 / 拒绝 / 跳过；多选支持 <code>1,2</code></div></div>
      </div>
    </section>

    <footer class="foot">
      <span>发裸 <code>${trigger}</code> 可随时获取纯文本简表</span>
      <span class="tomb">■</span>
    </footer>
  </main>
</body>
</html>
`;
}

/** 将零 JS 使用指南生成为临时 HTML 文件并作为 IM 附件发出；失败或不支持文件时返回 false。 */
export async function sendHelpHtmlAttachment(
  bridge: OpenMausBotBridge,
  sink: CommandSink,
  opts: { replyTo?: string | null } = {},
): Promise<boolean> {
  if (!bridge.supportsFiles()) return false;
  const html = buildHelpHtml(bridge);
  const baseName = safeAttachmentName(bridge.botName || 'co-bot', 'co-bot').replace(/\.html$/i, '') || 'co-bot';
  const fileName = `${baseName}-help.html`;
  const tmpPath = path.join(os.tmpdir(), `cobot-help-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`);
  try {
    fs.writeFileSync(tmpPath, html, 'utf8');
    const fid = await sink.sendFile(
      tmpPath,
      fileName,
      opts.replyTo ? { replyTo: opts.replyTo } : {},
    );
    return Boolean(fid);
  } catch (err) {
    console.warn(`[omb-bridge] 发送帮助 HTML 附件失败，将降级为纯文本: ${(err as Error).message}`);
    return false;
  } finally {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
  }
}
