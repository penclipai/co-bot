import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { clip, plain, hardBreaks, mdClip, mdSplit, fileSafe, pruneExpiredFiles, safeAttachmentName, stripSingleLineLeadingBold, writeJsonAtomic } from '../src/format.ts';
import { loadConfig, readJsonFile, APP_ROOT } from '../src/config.ts';
import { inQuietHours, OpenMausBotBridge } from '../src/openmausbot/bridge.ts';
import { formatCardPrompt, parseChoiceIndex } from '../src/openmausbot/cards.ts';
import { attachBotBadge, hasBotBadgePrefix } from '../src/core/security.ts';
import { WebServer } from '../src/web/server.ts';
import { ChatContextStore, collectContextAttachments, formatImContextBlock, sanitizeExternalMentions } from '../src/core/chat-context.ts';
import { clipSummary } from '../src/core/channel-contract.ts';
import { rotateLogIfNeeded } from '../scripts/omb.ts';
import { buildServiceSpec, installService, uninstallService } from '../scripts/service.ts';

const execFileAsync = promisify(execFile);

test('format helpers: clip, fileSafe, plain, hardBreaks, mdClip', () => {
  assert.equal(clip('abcdef', 4), 'abcd…');
  assert.equal(clip('abc', 4), 'abc');
  assert.equal(fileSafe('a/b:c d?e'), 'a-b-c-d-e');

  const md = '# 标题\n**加粗** 与 `code`\n```\nkeep **raw**\n```\n---\n- 条目';
  assert.equal(plain(md), '标题\n加粗 与 code\n  keep **raw**\n- 条目');
  assert.equal(plain('🤖 **[co-bot]**\n---\n一切正常'), '🤖 [co-bot]\n一切正常');

  assert.equal(hardBreaks('第一行\n第二行\n\n- 列表'), '第一行  \n第二行\n\n- 列表');

  const longCode = '```js\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```';
  const clipped = mdClip(longCode, 22);
  assert.equal(clipped.cut, true);
  assert.ok(clipped.text.includes('\n```\n\n…'), '断在代码块内部时应补全闭合围栏');

  // mdSplit：短文本直接返回单段；中等长度按段落/围栏安全拆成多气泡
  assert.deepEqual(mdSplit('hello', 20), ['hello']);
  const para = `${'A'.repeat(25)}\n\n${'B'.repeat(25)}`;
  const splitPara = mdSplit(para, 30);
  assert.equal(splitPara.length, 2);
  assert.equal(splitPara[0], 'A'.repeat(25));
  assert.equal(splitPara[1], 'B'.repeat(25));

  const codePara = `\`\`\`ts\n${'const x = 1;\n'.repeat(6)}\`\`\``;
  const splitCode = mdSplit(codePara, 42);
  assert.ok(splitCode.length >= 2);
  assert.ok(splitCode[0].endsWith('\n```'), '首段末尾应闭合代码块');
  assert.ok(splitCode[1].startsWith('```ts\n'), '次段开头应续开代码块语言标注');

  // pruneExpiredFiles：删除过期文件与空目录，保留未过期文件与 keepPaths
  const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-prune-'));
  const subDir = path.join(cleanDir, 'sub');
  fs.mkdirSync(subDir, { recursive: true });
  const oldDel = path.join(subDir, 'old.txt');
  const oldKeep = path.join(cleanDir, 'keep.txt');
  const freshFile = path.join(cleanDir, 'fresh.txt');
  fs.writeFileSync(oldDel, '1');
  fs.writeFileSync(oldKeep, '2');
  fs.writeFileSync(freshFile, '3');
  const nowMs = Date.now();
  const past = new Date(nowMs - 10_000);
  fs.utimesSync(oldDel, past, past);
  fs.utimesSync(oldKeep, past, past);
  const removed = pruneExpiredFiles(cleanDir, 5_000, { keepPaths: [oldKeep], now: nowMs });
  assert.equal(removed, 1);
  assert.equal(fs.existsSync(oldDel), false);
  assert.equal(fs.existsSync(subDir), false, '空子目录应被顺带移除');
  assert.equal(fs.existsSync(oldKeep), true, 'keepPaths 中的文件应保留');
  assert.equal(fs.existsSync(freshFile), true);

  // safeAttachmentName 与 writeJsonAtomic
  assert.equal(safeAttachmentName('../../../.hidden/my:file?.md', 'fallback'), 'my_file_.md');
  assert.equal(safeAttachmentName('.env'), '_env');
  const atomicPath = path.join(cleanDir, 'nested', 'state.json');
  writeJsonAtomic(atomicPath, { ok: true, count: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(atomicPath, 'utf8')), { ok: true, count: 2 });
});

test('loadConfig: loads defaults, resolves relative paths, supports web->sim channel normalization and CLI overrides', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-cfg-')));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    channel: { use: 'web' },
    dataDir: './mydata',
    selfChat: { trigger: '@bot', commandDevices: ['mobile'], quietHours: { enabled: true } },
  }));

  const cfgFromFile = loadConfig(['--port', '9001', '--omb', 'http://127.0.0.1:9999/', '--config', cfgPath]);
  assert.equal(cfgFromFile.channel.use, 'sim');

  const cfg = loadConfig(['--port', '9001', '--omb', 'http://127.0.0.1:9999/', '--channel', './cli-chan.js', '--config', cfgPath]);
  assert.equal(cfg.channel.use, path.resolve(process.cwd(), './cli-chan.js'));
  assert.equal(cfg.web.port, 9001);
  assert.equal(cfg.openmausbot.url, 'http://127.0.0.1:9999');
  assert.equal(cfg.openmausbot.autoStart, true);
  assert.equal(cfg.openmausbot.cliComputerOff, true);
  assert.equal(cfg.dataDir, path.join(dir, 'mydata'));
  assert.equal(cfg.chats.contextMaxChats, 200);
  assert.deepEqual(cfg.selfChat.commandDevices, ['mobile']);
  assert.equal(cfg.selfChat.proactive, true);
  assert.equal(cfg.selfChat.softSplitChars, 2800);
  assert.equal(cfg.selfChat.followUpWindowMs, 120_000);
  assert.equal(cfg.selfChat.hideChiefPrefix, false);
  assert.equal(cfg.selfChat.imageBatchMs, 1500);
  assert.equal(cfg.selfChat.fileRetentionDays, 7);
  assert.equal(cfg.selfChat.sendRetries, 2);
  assert.equal(cfg.selfChat.maxProgressUpdates, 2);
  assert.equal(cfg.selfChat.intermediateCoalesceMs, 700);
  assert.equal(cfg.selfChat.maxIntermediateBubbles, 2);
  assert.deepEqual(cfg.selfChat.quietHours, { enabled: true, start: '22:00', end: '08:30' });

  const t23 = new Date(2026, 10, 19, 23, 0).getTime();
  const t10 = new Date(2026, 10, 19, 10, 0).getTime();
  assert.equal(inQuietHours(t23, cfg.selfChat.quietHours), true);
  assert.equal(inQuietHours(t10, cfg.selfChat.quietHours), false);
});

test('loadConfig: OMB_TOKEN env fallback works even when config omits or empties token; CLI > config > env', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-tok-')));
  const emptyTokCfg = path.join(dir, 'empty.json');
  const fileTokCfg = path.join(dir, 'file.json');
  fs.writeFileSync(emptyTokCfg, JSON.stringify({ openmausbot: { url: 'http://127.0.0.1:8799', token: '' } }));
  fs.writeFileSync(fileTokCfg, JSON.stringify({ openmausbot: { url: 'http://127.0.0.1:8799', token: 'from_file' } }));

  const prev = process.env.OMB_TOKEN;
  try {
    process.env.OMB_TOKEN = 'from_env';
    assert.equal(loadConfig([], emptyTokCfg).openmausbot.token, 'from_env');
    assert.equal(loadConfig([], fileTokCfg).openmausbot.token, 'from_file');
    assert.equal(loadConfig(['--omb-token', 'from_cli'], fileTokCfg).openmausbot.token, 'from_cli');
  } finally {
    if (prev === undefined) delete process.env.OMB_TOKEN;
    else process.env.OMB_TOKEN = prev;
  }
});

test('loadConfig: APP_ROOT points to repo root and config loading works from another CWD', async () => {
  assert.equal(fs.existsSync(path.join(APP_ROOT, 'package.json')), true);
  assert.equal(fs.existsSync(path.join(APP_ROOT, 'public', 'index.html')), true);
  const { stdout } = await execFileAsync(
    process.execPath,
    ['-e', `import(${JSON.stringify(new URL('../src/config.ts', import.meta.url).href)}).then(m => console.log(JSON.stringify({ root: m.APP_ROOT, url: m.loadConfig([]).openmausbot.url })))`],
    { cwd: os.tmpdir() },
  );
  const out = JSON.parse(stdout.trim()) as { root: string; url: string };
  assert.equal(out.root, APP_ROOT);
  assert.match(out.url, /^http:\/\/127\.0\.0\.1:/);
});

test('WebServer & omb log rotation: handles byte-split multi-byte UTF-8 JSON, enforces limit 413, and rotates oversized logs', async () => {
  const web = new WebServer({ host: '127.0.0.1', port: 0, publicDir: path.join(APP_ROOT, 'public') });
  web.route('POST', '/echo', ({ body }) => ({ echoed: (body as Record<string, unknown>)?.text }));
  web.route('POST', '/tiny', ({ body }) => ({ ok: body }), { limit: 12 });
  await web.start();
  const { port } = web.server!.address() as AddressInfo;
  try {
    const raw = Buffer.from(JSON.stringify({ text: '你好世界🚀' }), 'utf8');
    const res1 = await new Promise<{ status?: number; body: { echoed: string } }>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, method: 'POST', path: '/echo', headers: { 'content-type': 'application/json' } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as { echoed: string } }));
        },
      );
      req.on('error', reject);
      for (let i = 0; i < raw.length; i++) req.write(raw.subarray(i, i + 1));
      req.end();
    });
    assert.equal(res1.status, 200);
    assert.equal(res1.body.echoed, '你好世界🚀');

    const res413 = await fetch(`http://127.0.0.1:${port}/tiny`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: '0123456789abcdef' }),
    });
    assert.equal(res413.status, 413);
  } finally {
    await web.stop();
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-rot-'));
  const logFile = path.join(dir, 'test.log');
  fs.writeFileSync(logFile, 'x'.repeat(200), 'utf8');
  assert.equal(rotateLogIfNeeded(logFile, 500), false);
  assert.equal(rotateLogIfNeeded(logFile, 100), true);
  assert.equal(fs.existsSync(logFile), false);
  assert.equal(fs.readFileSync(`${logFile}.1`, 'utf8').length, 200);

  const liveLog = path.join(dir, 'live.log');
  fs.writeFileSync(liveLog, 'y'.repeat(160), 'utf8');
  assert.equal(rotateLogIfNeeded(liveLog, 100, { copyTruncate: true }), true);
  assert.equal(fs.existsSync(liveLog), true, 'copyTruncate 模式应保留原日志文件句柄');
  assert.equal(fs.statSync(liveLog).size, 0);
  assert.equal(fs.readFileSync(`${liveLog}.1`, 'utf8').length, 160);
});

test('parseChoiceIndex: handles Arabic digits and Chinese spoken ordinals without false positives', () => {
  assert.equal(parseChoiceIndex('1'), 1);
  assert.equal(parseChoiceIndex('2.'), 2);
  assert.equal(parseChoiceIndex('第一个'), 1);
  assert.equal(parseChoiceIndex('第 2 个'), 2);
  assert.equal(parseChoiceIndex('选二'), 2);
  assert.equal(parseChoiceIndex('选两项'), 2);
  assert.equal(parseChoiceIndex('三号'), 3);
  assert.equal(parseChoiceIndex('切到 5'), 5);
  assert.equal(parseChoiceIndex('用第九条。'), 9);

  assert.equal(parseChoiceIndex(''), null);
  assert.equal(parseChoiceIndex('1个问题想问你'), null);
  assert.equal(parseChoiceIndex('帮我看一下第2行'), null);
  assert.equal(parseChoiceIndex('10'), null);
  assert.equal(parseChoiceIndex('0'), null);
});

test('scripts/service.ts: cross-platform service specs, dry-run install/uninstall, and daemon CLI integration', async () => {
  const cfg = { dataDir: '/srv/co%bot/data' };
  const linux = buildServiceSpec(cfg, {
    platform: 'linux',
    homeDir: '/home/alice',
    nodePath: '/usr/local/bin/node',
    appRoot: '/srv/co bot',
    cwd: '/tmp/caller',
    extraArgs: ['--config', './config.json'],
  });
  assert.equal(linux.kind, 'systemd-user');
  assert.equal(linux.filePath, '/home/alice/.config/systemd/user/co-bot.service');
  assert.match(linux.content, /ExecStart=\/usr\/local\/bin\/node --no-deprecation "\/srv\/co bot\/src\/index\.ts" --ensure-omb --config/);
  assert.match(linux.content, /StandardOutput=append:\/srv\/co%%bot\/data\/cobot\.log/);

  const mac = buildServiceSpec(cfg, {
    platform: 'darwin',
    homeDir: '/Users/alice',
    nodePath: '/opt/node & bin/node',
    appRoot: '/Users/alice/co-bot',
    extraArgs: ['--port', '9001'],
  });
  assert.equal(mac.kind, 'launchd');
  assert.equal(mac.filePath, '/Users/alice/Library/LaunchAgents/com.cobot.agent.plist');
  assert.match(mac.content, /<string>com\.cobot\.agent<\/string>/);
  assert.match(mac.content, /\/opt\/node &amp; bin\/node/);
  assert.match(mac.content, /<string>--ensure-omb<\/string>/);

  const win = buildServiceSpec({ dataDir: 'D:\\co bot\\data' }, {
    platform: 'win32',
    appDataDir: 'C:\\Users\\Alice\\AppData\\Roaming',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    appRoot: 'D:\\co bot',
    extraArgs: ['--port', '8787'],
  });
  assert.equal(win.kind, 'windows-startup');
  assert.equal(win.filePath, 'C:\\Users\\Alice\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\co-bot.vbs');
  assert.match(win.content, /WScript\.Shell/);
  assert.match(win.content, /scripts\\daemon\.ts/);
  assert.match(win.content, /, 0, False/);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-svc-'));
  const dryLogs: string[] = [];
  const dryRes = installService(
    { dataDir: path.join(tmpRoot, 'data') },
    { dry: true, platform: 'win32', appDataDir: tmpRoot, log: (s) => dryLogs.push(String(s)) },
  );
  assert.equal(dryRes.dry, true);
  assert.equal(fs.existsSync(dryRes.spec.filePath), false, '--dry 不应写入任何文件');
  assert.ok(dryLogs.some((l) => l.includes('[dry-run]')));

  const realRes = installService(
    { dataDir: path.join(tmpRoot, 'data') },
    { dry: false, platform: 'win32', appDataDir: tmpRoot, log: () => {} },
  );
  assert.equal(realRes.installed, true);
  assert.equal(fs.existsSync(realRes.spec.filePath), true);

  const unRes = uninstallService(
    { dataDir: path.join(tmpRoot, 'data') },
    { dry: false, platform: 'win32', appDataDir: tmpRoot, log: () => {} },
  );
  assert.equal(unRes.removed, true);
  assert.equal(fs.existsSync(realRes.spec.filePath), false);

  const daemonScript = path.join(APP_ROOT, 'scripts', 'daemon.ts');
  const cliDry = await execFileAsync(process.execPath, [daemonScript, 'install-service', '--dry'], { cwd: os.tmpdir() });
  assert.match(cliDry.stdout, /\[dry-run\] 目标服务/);
});

test('ChatContextStore, redact/clipSummary, and chats config defaults', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-cfg-chats-'));
  const cfgPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    chats: { mode: 'owner_everywhere', allowChatIds: ['grp_1'], contextWindow: 8 },
  }));
  const cfg = loadConfig([], cfgPath);
  assert.equal(cfg.chats.mode, 'owner_everywhere');
  assert.deepEqual(cfg.chats.allowChatIds, ['grp_1']);
  assert.deepEqual(cfg.chats.enabledTypes, ['self', 'group', 'direct']);
  assert.equal(cfg.chats.contextWindow, 8);
  assert.equal(cfg.chats.routeControlsToSelf, true);
  assert.equal(cfg.chats.externalSanitizeMentions, 'all');
  assert.equal(cfg.chats.recentAttachmentWindowMs, 120_000);
  assert.equal(cfg.chats.maxAutoAttachments, 4);
  assert.equal(cfg.chats.autoCompactThreshold, 0.75);
  assert.equal(cfg.chats.injectRecentContext, false);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  assert.match(clipSummary('GET /api/im-context/messages?token=ctx_eyJjaGF0IjoiZ3JwXzEifQ.abc123def456'), /\[REDACTED\]/);

  let fakeNow = 100_000;
  const store = new ChatContextStore({ maxPerChat: 4, ttlMs: 120_000, now: () => fakeNow });
  for (let i = 1; i <= 6; i += 1) {
    store.recordInbound({
      id: `m${i}`,
      ts: fakeNow + i * 100,
      chat: { id: 'grp_1', type: 'group', name: '测试群' },
      sender: { id: 'u1', name: 'Alice', isSelf: false },
      text: `msg ${i} nginx token=sk-1234567890abcdef`,
    });
  }
  const recent = store.getRecent('grp_1', { limit: 10 });
  assert.deepEqual(recent.map((m) => m.id), ['m3', 'm4', 'm5', 'm6']);
  assert.equal(store.getRecent('grp_1', { beforeMsgId: 'm5', limit: 2 }).map((m) => m.id).join(','), 'm3,m4');

  const block = formatImContextBlock({
    triggerEvent: { id: 'm6', ts: 100_600, chat: { id: 'grp_1', type: 'group', name: '测试群' }, sender: { id: 'me', name: '我', isSelf: true }, text: '', replyTo: 'm3' },
    chatMeta: store.getChatMeta('grp_1'),
    quotedMsg: store.getMessage('grp_1', 'm3'),
    recentMsgs: recent.slice(0, 3),
    privateReply: true,
  });
  assert.match(block, /<im-context>/);
  assert.match(block, /reply_destination: self_chat_private/);
  assert.doesNotMatch(block, /sk-1234567890abcdef/);

  fakeNow += 200_000;
  assert.equal(store.getRecent('grp_1').length, 0);
  assert.deepEqual(store.stats(), { chatCount: 0, totalMessages: 0 });

  const rawOut = '请 @Alice 和 @所有人 注意：联系 ops@example.com，查看 `@bot` 与 ```\n@Plum test\n``` 以及 @Plum。';
  const allSafe = sanitizeExternalMentions(rawOut, { mode: 'all', botNames: ['Plum'] });
  assert.equal(allSafe, '请 @\u200BAlice 和 @\u200B所有人 注意：联系 ops@example.com，查看 `@bot` 与 ```\n@Plum test\n``` 以及 @\u200BPlum。');
  assert.equal(sanitizeExternalMentions(allSafe, { mode: 'all', botNames: ['Plum'] }), allSafe);

  const dangerousOnly = sanitizeExternalMentions('请 @Alice 和 @所有人 问 @Plum', { mode: 'dangerous', botNames: ['Plum'] });
  assert.equal(dangerousOnly, '请 @Alice 和 @\u200B所有人 问 @\u200BPlum');
  assert.equal(sanitizeExternalMentions('@Alice hi', { mode: 'none' }), '@Alice hi');

  const store2 = new ChatContextStore({ maxPerChat: 20, ttlMs: 120_000, now: () => 500_000 });
  store2.recordInbound({
    id: 'g1',
    ts: 490_000,
    chat: { id: 'grp_a', type: 'group', name: 'A群' },
    sender: { id: 'alice', name: 'Alice', isSelf: false },
    text: 'secret temp_pass_999',
  });
  store2.recordInbound({
    id: 'g2',
    ts: 491_000,
    chat: { id: 'grp_a', type: 'group', name: 'A群' },
    sender: { id: 'alice', name: 'Alice', isSelf: false },
    text: 'node1 error',
    attachments: [{ id: 'f1', msgId: 'g2', name: 'node1.log' }],
  });
  store2.recordInbound({
    id: 'g3',
    ts: 492_000,
    chat: { id: 'grp_a', type: 'group', name: 'A群' },
    sender: { id: 'alice', name: 'Alice', isSelf: false },
    text: '',
    attachments: [{ id: 'f2', msgId: 'g3', name: 'node2.log' }],
  });
  store2.recordInbound({
    id: 's1',
    ts: 493_000,
    chat: { id: 'self', type: 'self', name: '自聊' },
    sender: { id: 'me', name: '我', isSelf: true },
    text: 'self note temp_pass_999',
  });
  assert.equal(store2.recallMessage('grp_a', 'g1').removed, true);
  assert.equal(store2.getMessage('grp_a', 'g1'), null);
  assert.equal(store2.recordInbound({
    id: 'g1',
    ts: 490_000,
    chat: { id: 'grp_a', type: 'group', name: 'A群' },
    sender: { id: 'alice', name: 'Alice', isSelf: false },
    text: 'secret temp_pass_999',
  }), null);

  const recentA = store2.getRecent('grp_a', { limit: 10 });
  const unquotedArt = collectContextAttachments({
    triggerEvent: { id: 'g4', ts: 495_000, chat: { id: 'grp_a', type: 'group' }, sender: { id: 'me', isSelf: true }, text: '@bot 对比上面两份日志' },
    recentMsgs: recentA,
  });
  assert.deepEqual(unquotedArt.attachments.map((a) => a.id), ['f1', 'f2']);
  const unrelated = collectContextAttachments({
    triggerEvent: { id: 'g5', ts: 495_000, chat: { id: 'grp_a', type: 'group' }, sender: { id: 'me', isSelf: true }, text: '@bot 今天中午吃什么' },
    recentMsgs: recentA,
  });
  assert.equal(unrelated.attachments.length, 0);
});

test('Style A bot badges: attachBotBadge layout, hasBotBadgePrefix, card prefix order, hideChiefPrefix opt-out, and isEcho loop guard', () => {
  const badge = '🤖 **[co-bot]**';
  // 少于 10 个等效中文字的单行纯文本去掉 ** 和 --- 分隔线；≥10 字或多行/块语法保留完整样式
  assert.equal(attachBotBadge(badge, '一切正常'), '🤖 [co-bot] 一切正常');
  assert.equal(attachBotBadge(badge, '✅ 九个中文字不加粗线。'), '🤖 [co-bot] ✅ 九个中文字不加粗线。');
  assert.equal(attachBotBadge(badge, 'OK'), '🤖 [co-bot] OK');
  assert.equal(attachBotBadge('🤖 **[项目组 · Dev]**', '已收到'), '🤖 [项目组 · Dev] 已收到');
  assert.equal(attachBotBadge(badge, '十个中文字刚好触发线'), '🤖 **[co-bot]**\n---\n十个中文字刚好触发线');
  assert.equal(attachBotBadge(badge, 'Everything is working properly now'), '🤖 **[co-bot]**\n---\nEverything is working properly now');
  assert.equal(attachBotBadge(badge, '第一行\n第二行'), '🤖 **[co-bot]**\n---\n第一行\n第二行');
  assert.equal(attachBotBadge(badge, '# 标题\n正文'), '🤖 **[co-bot]**\n---\n# 标题\n正文');
  assert.equal(attachBotBadge(badge, '```ts\nconst x = 1;\n```'), '🤖 **[co-bot]**\n---\n```ts\nconst x = 1;\n```');
  assert.equal(attachBotBadge(badge, '- 条目A\n- 条目B'), '🤖 **[co-bot]**\n---\n- 条目A\n- 条目B');
  assert.equal(attachBotBadge(badge, '1. 第一步'), '🤖 **[co-bot]**\n---\n1. 第一步');
  assert.equal(attachBotBadge(badge, '> 引用'), '🤖 **[co-bot]**\n---\n> 引用');
  assert.equal(attachBotBadge(badge, '| col1 | col2 |'), '🤖 **[co-bot]**\n---\n| col1 | col2 |');
  assert.equal(attachBotBadge(badge, '---\n已有分隔线'), '🤖 **[co-bot]**\n---\n已有分隔线');
  // 软拆分编号与幂等防重复
  assert.equal(attachBotBadge(badge, '第一段', { partIndex: 1, partTotal: 2 }), '🤖 **[co-bot]** (1/2)\n---\n第一段');
  assert.equal(attachBotBadge(badge, '第二段A\n第二段B', { partIndex: 2, partTotal: 2 }), '🤖 **[co-bot]** (2/2)\n---\n第二段A\n第二段B');
  assert.equal(attachBotBadge(badge, '🤖 **[co-bot]** 已有徽章'), '🤖 **[co-bot]** 已有徽章');
  assert.equal(attachBotBadge(badge, '🤖 [co-bot] 已有短徽章'), '🤖 [co-bot] 已有短徽章');
  // 普通 🤖 开头人工文本仍应加徽章，不被误判
  assert.equal(attachBotBadge(badge, '🤖 hello'), '🤖 [co-bot] 🤖 hello');

  assert.equal(hasBotBadgePrefix('🤖 **[co-bot]** 一切正常'), true);
  assert.equal(hasBotBadgePrefix('🤖 **[co-bot]**\n---\n一切正常'), true);
  assert.equal(hasBotBadgePrefix('🤖 **[项目组 · Dev]** (1/2)\n---\n内容'), true);
  assert.equal(hasBotBadgePrefix('🤖 [co-bot] 降级纯文本'), true);
  assert.equal(hasBotBadgePrefix('🤖 hello'), false);
  assert.equal(hasBotBadgePrefix('普通文本'), false);

  const cardRes = formatCardPrompt('co-bot', {
    id: 'm_card',
    role: 'bot',
    kind: 'card',
    threadId: 't1',
    card: { title: '允许执行 rm -rf /tmp/test 吗？' },
  }, badge);
  assert.match(cardRes.text, /^🤖 \*\*\[co-bot\]\*\* ⏸️ /);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-badge-optout-'));
  try {
    const bDefault = new OpenMausBotBridge({ client: {} as never, transport: {} as never, dataDir: tmpDir });
    assert.equal(bDefault.hideChiefPrefix, false);
    assert.equal(bDefault.botPrefix('b1', 'MausBot'), '🤖 **[bot]**');
    assert.equal(bDefault.badgeName('b1', 'MausBot'), 'bot');
    assert.equal(bDefault.badgeName('b2', 'Plum'), 'Plum');
    assert.equal(bDefault.isEcho('🤖 **[bot]** 任意文本'), true);
    assert.equal(bDefault.isEcho('🤖 [bot] 纯文本降级'), true);
    assert.equal(bDefault.isEcho('🤖 我自己发的机器人表情'), false);

    const bCustom = new OpenMausBotBridge({ client: {} as never, transport: {} as never, dataDir: tmpDir, botName: '协调官' });
    assert.equal(bCustom.badgeName('b1', 'MausBot'), '协调官');
    assert.equal(bCustom.botPrefix('b1', 'MausBot'), '🤖 **[协调官]**');

    const bHidden = new OpenMausBotBridge({ client: {} as never, transport: {} as never, dataDir: tmpDir, hideChiefPrefix: true });
    assert.equal(bHidden.botPrefix('b1', 'MausBot'), '');
    assert.equal(bHidden.botPrefix('b1', 'MausBot', { proactive: true }), '🤖 **[bot]**');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('stripSingleLineLeadingBold strips leading ** only on single-line messages', () => {
  assert.equal(stripSingleLineLeadingBold('**📊 标题** 内容'), '📊 标题 内容');
  assert.equal(stripSingleLineLeadingBold('**结论**：OK'), '结论：OK');
  assert.equal(stripSingleLineLeadingBold('**🟢 co-bot 在线**\n- 列表项'), '**🟢 co-bot 在线**\n- 列表项');
  assert.equal(stripSingleLineLeadingBold('🤖 **[co-bot]** 收到'), '🤖 **[co-bot]** 收到');
});

test('safeAttachmentName slices before stripping leading dots', () => {
  const raw = `${'a'.repeat(50)}.hidden_${'b'.repeat(95)}.txt`;
  const clean = safeAttachmentName(raw);
  assert.equal(clean.startsWith('.'), false);
  assert.equal(clean.length <= 100, true);
});

test('readJsonFile handles UTF-8 BOM and loadConfig supports explicit null without ENOENT', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobot-cfg-bom-'));
  try {
    const bomPath = path.join(dir, 'bom.json');
    fs.writeFileSync(bomPath, '\uFEFF{"openmausbot":{"url":"http://127.0.0.1:9111"}}', 'utf8');
    const parsed = readJsonFile(bomPath) as { openmausbot?: { url?: string } };
    assert.equal(parsed.openmausbot?.url, 'http://127.0.0.1:9111');

    const cfg = loadConfig(['--config', path.join(dir, 'missing.json'), '--omb', 'http://127.0.0.1:9222'], null);
    assert.equal(cfg.openmausbot.url, 'http://127.0.0.1:9222');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('public/md.js handles nested fences, adjacent mixed lists, and code-pipe table cells', () => {
  const src = fs.readFileSync(path.join(APP_ROOT, 'public/md.js'), 'utf8');
  const win: { renderMarkdown?: (s: string) => string } = {};
  vm.runInNewContext(src, { window: win });
  const render = win.renderMarkdown!;

  const nested = render('````md\n```ts\nconst x = 1;\n```\n````\nafter');
  assert.match(nested, /<pre><code>```ts\nconst x = 1;\n```<\/code><\/pre><p>after<\/p>/);

  const mixedLists = render('- a\n- b\n1. one\n2. two');
  assert.equal(mixedLists, '<ul><li>a</li><li>b</li></ul><ol><li>one</li><li>two</li></ol>');

  const pipeTable = render('|Expr|Result|\n|---|---|\n|`a | b`|ok|');
  assert.match(pipeTable, /<td><code>a \| b<\/code><\/td><td>ok<\/td>/);
});
