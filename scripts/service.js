import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_ROOT, isPathLikeSpecifier } from '../src/config.js';

function xmlEscape(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function systemdQuote(arg) {
  const s = String(arg);
  if (!/[\s"'\\$`%;&*?<>|()\[\]{}]/.test(s)) return s;
  return `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '$$').replaceAll('%', '%%')}"`;
}

function systemdValue(str) {
  return String(str).replaceAll('%', '%%');
}

function normalizeServiceExtraArgs(extraArgs, cwd = process.cwd()) {
  const out = [];
  for (let i = 0; i < extraArgs.length; i++) {
    const a = extraArgs[i];
    if (a === '--dry' || a === '--dry-run') continue;
    if ((a === '--config' || a === '--channel') && extraArgs[i + 1] !== undefined) {
      const next = String(extraArgs[++i]);
      const isPath = a === '--config' || isPathLikeSpecifier(next);
      out.push(a, isPath ? path.resolve(cwd, next) : next);
      continue;
    }
    out.push(a);
  }
  return out;
}

function vbsEscape(str) {
  return String(str).replaceAll('"', '""');
}

function cmdQuoteWin(arg) {
  const s = String(arg);
  if (!s || /[\s"&|<>^()]/.test(s)) return `"${s.replaceAll('"', '\\"')}"`;
  return s;
}

/** 根据目标操作系统生成开机自启服务描述与配置文件内容（Linux systemd --user / macOS LaunchAgents / Windows Startup）。 */
export function buildServiceSpec(cfg, {
  platform = process.platform,
  homeDir = os.homedir(),
  appDataDir = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  nodePath = process.execPath,
  appRoot = APP_ROOT,
  extraArgs = [],
  cwd = process.cwd(),
} = {}) {
  const cleanedArgs = normalizeServiceExtraArgs(extraArgs, cwd);
  const p = platform === 'win32' ? path.win32 : path.posix;
  const logFile = p.join(cfg.dataDir, 'cobot.log');
  const errFile = p.join(cfg.dataDir, 'cobot.err.log');

  if (platform === 'linux') {
    const filePath = p.join(homeDir, '.config', 'systemd', 'user', 'co-bot.service');
    const entryScript = p.join(appRoot, 'src', 'index.js');
    const execArgs = ['--no-deprecation', entryScript, '--ensure-omb', ...cleanedArgs];
    const execStart = [nodePath, ...execArgs].map(systemdQuote).join(' ');
    const content = [
      '[Unit]',
      'Description=co-bot IM to OpenMausBot gateway',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      `WorkingDirectory=${systemdValue(appRoot)}`,
      `ExecStart=${execStart}`,
      'Restart=on-failure',
      'RestartSec=5',
      `StandardOutput=append:${systemdValue(logFile)}`,
      `StandardError=append:${systemdValue(errFile)}`,
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
    return {
      platform,
      kind: 'systemd-user',
      serviceName: 'co-bot.service',
      filePath,
      content,
      installCommands: [
        ['systemctl', ['--user', 'daemon-reload']],
        ['systemctl', ['--user', 'enable', '--now', 'co-bot.service']],
      ],
      uninstallCommands: [
        ['systemctl', ['--user', 'disable', '--now', 'co-bot.service']],
        ['systemctl', ['--user', 'daemon-reload']],
      ],
      note: '若为无桌面 Linux 服务器，建议额外执行一次：loginctl enable-linger "$USER"',
    };
  }

  if (platform === 'darwin') {
    const label = 'com.cobot.agent';
    const filePath = p.join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`);
    const entryScript = p.join(appRoot, 'src', 'index.js');
    const progArgs = [nodePath, '--no-deprecation', entryScript, '--ensure-omb', ...cleanedArgs];
    const content = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key>',
      `  <string>${xmlEscape(label)}</string>`,
      '  <key>ProgramArguments</key>',
      '  <array>',
      ...progArgs.map((a) => `    <string>${xmlEscape(a)}</string>`),
      '  </array>',
      '  <key>WorkingDirectory</key>',
      `  <string>${xmlEscape(appRoot)}</string>`,
      '  <key>RunAtLoad</key>',
      '  <true/>',
      '  <key>KeepAlive</key>',
      '  <dict>',
      '    <key>SuccessfulExit</key>',
      '    <false/>',
      '  </dict>',
      '  <key>StandardOutPath</key>',
      `  <string>${xmlEscape(logFile)}</string>`,
      '  <key>StandardErrorPath</key>',
      `  <string>${xmlEscape(errFile)}</string>`,
      '</dict>',
      '</plist>',
      '',
    ].join('\n');
    return {
      platform,
      kind: 'launchd',
      serviceName: label,
      filePath,
      content,
      installCommands: [
        ['launchctl', ['unload', '-w', filePath]],
        ['launchctl', ['load', '-w', filePath]],
      ],
      uninstallCommands: [
        ['launchctl', ['unload', '-w', filePath]],
      ],
      note: '开机登录后将自动拉起 OpenMausBot CLI 与 co-bot（logs 位于 data/cobot.log）。',
    };
  }

  if (platform === 'win32') {
    const filePath = p.join(appDataDir, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'co-bot.vbs');
    const daemonScript = p.join(appRoot, 'scripts', 'daemon.js');
    const cmdLine = [nodePath, '--no-deprecation', daemonScript, 'start', ...cleanedArgs]
      .map(cmdQuoteWin)
      .join(' ');
    const content = [
      'Set sh = CreateObject("WScript.Shell")',
      `sh.CurrentDirectory = "${vbsEscape(appRoot)}"`,
      `sh.Run "${vbsEscape(cmdLine)}", 0, False`,
      '',
    ].join('\r\n');
    return {
      platform,
      kind: 'windows-startup',
      serviceName: 'co-bot.vbs',
      filePath,
      content,
      installCommands: [],
      uninstallCommands: [],
      note: '已写入用户登录启动项（静默后台运行，可用 npm run status / restart / stop 管理）。',
    };
  }

  throw new Error(`暂不支持当前平台生成自启服务：${platform}`);
}

function runServiceCommands(commands, { ignoreErrors = false, strictLast = false } = {}) {
  for (let i = 0; i < commands.length; i++) {
    const [cmd, args] = commands[i];
    const isLast = i === commands.length - 1;
    const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10_000 });
    const allowFail = ignoreErrors || (strictLast && !isLast);
    if (!allowFail && (res.error || res.status !== 0)) {
      const detail = (res.stderr || res.stdout || res.error?.message || `exit ${res.status}`).trim();
      throw new Error(`执行 ${cmd} ${args.join(' ')} 失败：${detail}`);
    }
  }
}

/** 安装并启用当前平台的开机自启服务；dry=true 时仅预览不改写系统状态。 */
export function installService(cfg, opts = {}) {
  const { dry = false, log = console.log, ...specOpts } = opts;
  const spec = buildServiceSpec(cfg, specOpts);

  if (dry) {
    log(`[dry-run] 目标服务（${spec.kind}）：${spec.filePath}`);
    log(spec.content.trimEnd());
    if (spec.installCommands.length) {
      log(`[dry-run] 将执行：${spec.installCommands.map(([c, a]) => `${c} ${a.join(' ')}`).join(' && ')}`);
    }
    if (spec.note) log(`ℹ ${spec.note}`);
    return { dry: true, installed: false, spec };
  }

  fs.mkdirSync(path.dirname(spec.filePath), { recursive: true });
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(spec.filePath, spec.content, 'utf8');
  runServiceCommands(spec.installCommands, { strictLast: spec.kind === 'launchd' });
  log(`✓ 已安装并启用自启服务（${spec.kind}）：${spec.filePath}`);
  if (spec.note) log(`ℹ ${spec.note}`);
  return { dry: false, installed: true, spec };
}

/** 卸载当前平台的开机自启服务；dry=true 时仅预览不改写系统状态。 */
export function uninstallService(cfg, opts = {}) {
  const { dry = false, log = console.log, ...specOpts } = opts;
  const spec = buildServiceSpec(cfg, specOpts);

  if (dry) {
    log(`[dry-run] 将卸载服务（${spec.kind}）：${spec.filePath}`);
    if (spec.uninstallCommands.length) {
      log(`[dry-run] 将执行：${spec.uninstallCommands.map(([c, a]) => `${c} ${a.join(' ')}`).join(' && ')}`);
    }
    return { dry: true, removed: false, spec };
  }

  runServiceCommands(spec.uninstallCommands, { ignoreErrors: true });
  const existed = fs.existsSync(spec.filePath);
  fs.rmSync(spec.filePath, { force: true });
  log(existed ? `⏹ 已卸载自启服务：${spec.filePath}` : `ℹ 未发现已安装的自启服务文件（${spec.filePath}）`);
  return { dry: false, removed: existed, spec };
}
