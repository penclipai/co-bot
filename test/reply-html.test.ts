import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateConfig } from '../src/config.ts';
import { mdClip, mdSplit } from '../src/format.ts';
import { OpenMausBotBridge } from '../src/openmausbot/bridge.ts';
import { OpenMausBotClient } from '../src/openmausbot/client.ts';
import { deliverBotReply } from '../src/openmausbot/delivery.ts';
import {
  buildLongReplyFilename,
  buildReplyHtml,
  extractMarkdownTitle,
  pickLongReplyFormat,
  renderMarkdownToHtml,
} from '../src/openmausbot/reply-html.ts';
import { makeIm, type SentImFileItem, type SentImItem, startMockOmb } from './helpers/mock-omb.ts';

test('mdSplit preserves table header across splits and mdClip avoids dangling table/heading', () => {
  const tableMd = [
    '说明前置段落。',
    '',
    '| 文件 | 用例数 | 状态 |',
    '| --- | ---: | --- |',
    ...Array.from({ length: 12 }, (_, i) => `| test-${i + 1}.test.ts | ${i + 3} | 通过 |`),
  ].join('\n');

  const parts = mdSplit(tableMd, 260);
  assert.ok(parts.length >= 2, '应触发多段拆分');
  for (let i = 1; i < parts.length; i += 1) {
    assert.match(parts[i], /^\| 文件 \| 用例数 \| 状态 \|\n\| --- \| ---: \| --- \|/, `第 ${i + 1} 段应续开完整表头`);
  }

  // 若断点恰好落在空表头之后，应把表头整块挪到下一段
  const headerBreakMd = `${'前置摘要行\n'.repeat(4)}| 列A | 列B |\n| --- | --- |\n| v1 | v2 |\n| v3 | v4 |`;
  const hbParts = mdSplit(headerBreakMd, 58);
  assert.ok(hbParts.length >= 2);
  assert.equal(hbParts[0].endsWith('| --- | --- |'), false, '前段结尾不应留空表头');
  assert.match(hbParts[1], /^\| 列A \| 列B \|\n\| --- \| --- \|/);

  // 代码块中的竖线不误判为表格
  const codeWithPipes = `\`\`\`txt\n| a | b |\n| --- | --- |\n${'| x | y |\n'.repeat(8)}\`\`\``;
  const codeParts = mdSplit(codeWithPipes, 70);
  assert.ok(codeParts[1].startsWith('```txt\n'));

  // mdClip 清理孤立标题与空表头
  const danglingHead = '第一段完整内容。\n\n## 孤立小标题\n第三行被截断到这里';
  const clippedHead = mdClip(danglingHead, 20);
  assert.equal(clippedHead.cut, true);
  assert.equal(clippedHead.text.includes('## 孤立小标题'), false);

  const danglingTbl = '前置概述内容。\n\n| A | B |\n| --- | --- |\n| r1 | r2 |';
  const clippedTbl = mdClip(danglingTbl, 30);
  assert.equal(clippedTbl.cut, true);
  assert.equal(clippedTbl.text.includes('| A | B |'), false);
});

test('reply-html: extracts titles, picks format by mode, renders rich GFM & XSS-safe zero-JS HTML', () => {
  assert.equal(extractMarkdownTitle('# `co-bot` **系统审计** 报告\n正文'), 'co-bot 系统审计 报告');
  assert.equal(extractMarkdownTitle('```md\n# 代码内忽略\n```\n## 二级标题'), '二级标题');
  assert.equal(extractMarkdownTitle('纯文字没有标题\n只有两段'), '');

  assert.deepEqual(pickLongReplyFormat('纯文本段落。'.repeat(100), 'auto'), ['md']);
  assert.deepEqual(pickLongReplyFormat('# 报告\n\n| A | B |\n| --- | --- |\n| 1 | 2 |', 'auto'), ['html']);
  assert.deepEqual(pickLongReplyFormat('## 章节一\n内容\n## 章节二\n内容', 'auto'), ['html']);
  assert.deepEqual(pickLongReplyFormat('无结构纯文', 'html'), ['html']);
  assert.deepEqual(pickLongReplyFormat('# 有表\n| A |\n| --- |', 'md'), ['md']);
  assert.deepEqual(pickLongReplyFormat('# 有表', 'both'), ['html', 'md']);

  assert.equal(buildLongReplyFilename('# 发布检查清单\n正文', 'co-bot', 'html'), '发布检查清单.html');
  assert.equal(buildLongReplyFilename('无标题正文', 'co-bot', 'md'), 'co-bot.md');

  const md = [
    '# 系统体检报告',
    '## 一、检查项 & XSS 测试 <script>alert(1)</script>',
    '- [x] 已验证 [安全链接](https://example.com/ok)',
    '- [ ] 忽略危险 [点我](javascript:alert(1)) 与 <img src=x onerror=alert(1)>',
    '## 二、对比表',
    '| 模块 | `a\\|b` 状态 | 耗时 |',
    '| :--- | :---: | ---: |',
    '| core | ✅ | 12ms |',
    '```diff',
    '+ fixed line',
    '- old line',
    '```',
  ].join('\n');

  const rendered = renderMarkdownToHtml(md);
  assert.equal(rendered.toc.length, 2);
  assert.equal(rendered.hasStructure, true);
  assert.ok(rendered.html.includes('href="https://example.com/ok"'));
  assert.equal(rendered.html.includes('<script>'), false);
  assert.equal(rendered.html.includes('href="javascript:'), false);
  assert.equal(rendered.html.includes('<img src='), false);
  assert.ok(rendered.html.includes('style="text-align:right"'));
  assert.ok(rendered.html.includes('a|b'));
  assert.ok(rendered.html.includes('<span class="add">+ fixed line</span>'));

  const html = buildReplyHtml({ markdown: md, botName: 'co-bot', originName: '研发群', generatedAt: 1795834000000 });
  assert.equal(/<script\b/i.test(html), false, '必须零 JS 兼容 sandbox CSP');
  assert.ok(html.includes('id="theme-toggle"'));
  assert.ok(html.includes('<details class="raw-md">'));
  assert.ok(html.includes('<summary>查看 Markdown 原文</summary>'));
  assert.ok(html.includes('来自「研发群」'));
  assert.ok(html.includes('#sec-1'));

  assert.equal(validateConfig({ selfChat: { longReplyFormat: 'auto' } }).ok, true);
  assert.equal(validateConfig({ selfChat: { longReplyFormat: 'both' } }).ok, true);
  assert.equal(validateConfig({ selfChat: { longReplyFormat: 'pdf' } }).ok, false);
});

test('deliverBotReply: long structured reply sends concise preview + HTML, untitled sends MD, both sends 2 files, failure alerts', async () => {
  const omb = await startMockOmb([{ id: 'b1', name: 'co-bot', threadId: 't1', chiefOfStaff: true }]);
  const sent: SentImItem[] = [];
  const filesSent: SentImFileItem[] = [];
  const telemetry: Array<{ type: string; summary?: string }> = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-long-html-'));

  const makeBridge = (longReplyFormat: 'auto' | 'html' | 'md' | 'both' = 'auto') => new OpenMausBotBridge({
    client: new OpenMausBotClient({ baseUrl: omb.baseUrl }),
    transport: makeIm(sent, filesSent),
    dataDir,
    resultChars: 1000,
    softSplitChars: 1600,
    longReplyFormat,
    onTelemetry: (ev) => telemetry.push({ type: ev.type, summary: ev.summary }),
  });

  const bridge = makeBridge('auto');
  try {
    await bridge.start();
    const structured = [
      '# 架构迁移与风控排查报告',
      '',
      '## 一、结论摘要',
      '整体状态可控，核心需要补齐两条脱敏与重试边界。'.repeat(24),
      '',
      '## 二、模块风险矩阵',
      '| 模块 | 风险 | 优先级 |',
      '| --- | --- | --- |',
      ...Array.from({ length: 28 }, (_, i) => `| mod-${i + 1} | 状态与边界风险说明文案长度验证条目 | P${i % 3} |`),
      '',
      'TOKEN=sk-proj-1234567890abcdefghijklmnopqrstuvwxyz',
    ].join('\n');

    await deliverBotReply(bridge, {
      botId: 'b1',
      botName: 'co-bot',
      threadId: 't1',
      text: structured,
    });

    const preview = sent.at(-1)!.text;
    assert.ok(preview.length <= 1000, `预览气泡应紧凑（<=1000，当前 ${preview.length}）`);
    assert.match(preview, /《架构迁移与风控排查报告》/);
    assert.match(preview, /HTML 排版版/);
    assert.equal(filesSent.length, 1);
    assert.equal(filesSent[0].name, '架构迁移与风控排查报告.html');
    assert.equal(filesSent[0].content.includes('sk-proj-1234567890'), false, 'HTML 附件必须完成脱敏');
    assert.ok(filesSent[0].content.includes('<details class="raw-md">'));

    // 无结构长文本在 auto 下仍生成 .md 附件
    const plainLong = '这是一段没有标题与表格的长篇连续口语总结。'.repeat(120);
    await deliverBotReply(bridge, { botId: 'b1', botName: 'co-bot', threadId: 't1', text: plainLong });
    assert.equal(filesSent.length, 2);
    assert.equal(filesSent[1].name, 'co-bot.md');
    assert.match(sent.at(-1)!.text, /Markdown 版/);

    // both 模式同时发出 .html 与 .md
    bridge.longReplyFormat = 'both';
    await deliverBotReply(bridge, { botId: 'b1', botName: 'co-bot', threadId: 't1', text: structured });
    assert.equal(filesSent.length, 4);
    assert.deepEqual(filesSent.slice(2).map((f) => f.name), ['架构迁移与风控排查报告.html', '架构迁移与风控排查报告.md']);
    assert.match(sent.at(-1)!.text, /HTML \+ Markdown/);

    // 附件上传失败时不再静默吞错：记录 media_failed 并发出明确兜底提示
    bridge.transport.sendFile = async () => { throw new Error('disk full'); };
    bridge.longReplyFormat = 'html';
    await deliverBotReply(bridge, { botId: 'b1', botName: 'co-bot', threadId: 't1', text: structured });
    assert.match(sent.at(-1)!.text, /⚠️ 完整回复附件发送失败/);
    assert.ok(telemetry.some((e) => e.type === 'media_failed' && e.summary?.includes('disk full')));
  } finally {
    await bridge.stop();
    await omb.close();
  }
});
