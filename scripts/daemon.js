#!/usr/bin/env node
/**
 * co-bot 跨平台后台守护与开机自启管理脚本（Linux / macOS / Windows 通用）：
 *   node scripts/daemon.js <start|stop|restart|status|logs|install-service|uninstall-service> [--all] [--dry] [--config ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, APP_ROOT } from '../src/config.js';
import {
  isLoopbackUrl,
  isPidAlive,
  readPidFile,
  tailLogLines,
  printManagedLogs,
  probeHttpJson,
  stopManagedProcess,
  spawnManagedProcess,
  ensureOpenMausBot,
  stopOpenMausBot,
} from './omb.js';
import { installService, uninstallService } from './service.js';
import { resolveChannelSpec } from '../src/plugins/channel-loader.js';

const ACTIONS = new Set(['start', 'stop', 'restart', 'status', 'logs', 'install-service', 'uninstall-service']);
const VALUE_FLAGS = new Set(['--config', '--port', '--omb', '--omb-token', '--transport', '--channel']);

function parseArgs(argv) {
  let action = '';
  let help = false;
  let all = false;
  let dry = false;
  const extraArgs = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { help = true; continue; }
    if (a === '--all') { all = true; continue; }
    if (a === '--dry' || a === '--dry-run') { dry = true; continue; }
    if (VALUE_FLAGS.has(a) && argv[i + 1] !== undefined) {
      extraArgs.push(a, argv[++i]);
      continue;
    }
    if (!a.startsWith('-') && !action && ACTIONS.has(a)) {
      action = a;
      continue;
    }
    extraArgs.push(a);
  }

  return { action: action || 'start', help, all, dry, extraArgs };
}

function usage() {
  console.log([
    '用法：node scripts/daemon.js <start|stop|restart|status|logs|install-service|uninstall-service> [参数]',
    '  npm run daemon               # 启动后台常驻（自动按需拉起本机 OpenMausBot CLI + co-bot）',
    '  npm run restart              # 平滑重启 co-bot 后台进程',
    '  npm run stop [-- --all]      # 停止 co-bot（加 --all 一并停止托管的 OpenMausBot CLI）',
    '  npm run status               # 查看运行状态与连通情况',
    '  npm run daemon -- install-service        # 安装开机自启服务（支持 --dry 仅预览）',
    '  npm run daemon -- uninstall-service      # 卸载开机自启服务（支持 --dry 仅预览）',
    '可选参数：--config <path> --port <port> --omb <url> --transport <sim|ipc> --dry',
  ].join('\n'));
}

async function startDaemon(cfg, { pidFile, logFile, errFile, extraArgs }) {
  const oldPid = readPidFile(pidFile);
  if (oldPid && isPidAlive(oldPid)) {
    console.log(`ℹ co-bot 已在运行（PID ${oldPid}）`);
    return;
  }
  fs.rmSync(pidFile, { force: true });

  if (cfg.openmausbot.autoStart !== false && isLoopbackUrl(cfg.openmausbot.url)) {
    try {
      await ensureOpenMausBot(cfg);
    } catch (e) {
      console.warn(`⚠ 自动拉起 OpenMausBot 失败：${e.message}（继续启动 co-bot 并自动重连）`);
    }
  }

  const healthUrl = `http://${cfg.web.host}:${cfg.web.port}/api/health`;
  const { pid } = await spawnManagedProcess({
    name: 'co-bot',
    cmd: process.execPath,
    args: ['--no-deprecation', path.join(APP_ROOT, 'src', 'index.js'), ...extraArgs],
    cwd: APP_ROOT,
    pidFile,
    logFile,
    errFile,
    healthUrl,
    timeoutMs: 2500,
    pollIntervalMs: 100,
  });

  const outTail = tailLogLines(logFile, 8);
  if (outTail) console.log(outTail);
  const baseUrl = `http://${cfg.web.host}:${cfg.web.port}`;
  const chan = resolveChannelSpec(cfg);
  const endpointHint = chan.name === 'sim'
    ? `自聊模拟 ${baseUrl}/sim（诊断台 ${baseUrl}/debug）`
    : `本地诊断台 ${baseUrl}/debug`;
  console.log(`✓ co-bot 已启动（PID ${pid}，${endpointHint}）`);
}

async function statusDaemon(cfg, pidFile) {
  const pid = readPidFile(pidFile);
  const alive = Boolean(pid && isPidAlive(pid));
  const baseUrl = `http://${cfg.web.host}:${cfg.web.port}`;
  let st = null;
  try {
    st = await probeHttpJson(`${baseUrl}/api/status`, 1500);
  } catch { /* unreachable */ }

  if (alive && st?.ok) {
    const omb = st.openmausbot;
    const ombSummary = omb?.ok
      ? `OpenMausBot v${omb.version ?? '?'}（${omb.desktopManaged ? (omb.paired ? '桌面端已配对' : '桌面端未配对') : 'CLI 模式'}）`
      : `OpenMausBot 离线（${omb?.error || '未连接'}）`;
    const chName = st.channel?.name || st.im?.kind;
    const chConnected = st.channel?.status?.connected ?? st.im?.connected;
    const imSummary = chName && chName !== 'sim'
      ? `，通道 ${chName}: ${chConnected ? '已连接' : '重连中'}`
      : '';
    console.log(`🟢 co-bot 运行中（PID ${pid}，${baseUrl}，${ombSummary}${imSummary}）`);
    return;
  }
  if (alive) {
    console.log(`🟡 co-bot 进程存在（PID ${pid}），但 ${baseUrl}/api/status 暂未就绪`);
    return;
  }
  if (pid) fs.rmSync(pidFile, { force: true });
  if (st?.ok) {
    console.log(`🟡 ${baseUrl} 已有 co-bot 在线（非本 PID 文件托管）`);
    return;
  }
  console.log('⚪ co-bot 未运行');
  process.exitCode = 1;
}

function logsDaemon(logFile, errFile) {
  printManagedLogs(logFile, errFile, 40);
}

async function main() {
  const { action, help, all, dry, extraArgs } = parseArgs(process.argv.slice(2));
  if (help) {
    usage();
    return;
  }

  const cfg = loadConfig(extraArgs);
  const pidFile = path.join(cfg.dataDir, 'cobot.pid');
  const logFile = path.join(cfg.dataDir, 'cobot.log');
  const errFile = path.join(cfg.dataDir, 'cobot.err.log');

  if (action === 'install-service') {
    installService(cfg, { dry, extraArgs });
  } else if (action === 'uninstall-service') {
    uninstallService(cfg, { dry, extraArgs });
  } else if (action === 'stop') {
    await stopManagedProcess({ name: 'co-bot', pidFile });
    if (all) await stopOpenMausBot(cfg);
  } else if (action === 'restart') {
    await stopManagedProcess({ name: 'co-bot', pidFile });
    await startDaemon(cfg, { pidFile, logFile, errFile, extraArgs });
  } else if (action === 'status') {
    await statusDaemon(cfg, pidFile);
  } else if (action === 'logs') {
    logsDaemon(logFile, errFile);
  } else {
    await startDaemon(cfg, { pidFile, logFile, errFile, extraArgs });
  }
}

main().catch((e) => {
  console.error(`[daemon] ${e.message}`);
  process.exitCode = 1;
});
