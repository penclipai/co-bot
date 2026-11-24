#!/usr/bin/env node
/**
 * 跨平台 OpenMausBot CLI 生命周期管理与进程工具（Linux / macOS / Windows 通用）：
 *   node scripts/omb.js <ensure|start|stop|restart|status|logs> [--config ...] [--omb ...]
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, APP_ROOT } from '../src/config.js';
import { OpenMausBotClient } from '../src/openmausbot/client.js';

const ACTIONS = new Set(['ensure', 'start', 'stop', 'restart', 'status', 'logs']);
const VALUE_FLAGS = new Set(['--config', '--port', '--omb', '--omb-token', '--channel']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    return LOOPBACK_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

export function readPidFile(pidFile) {
  try {
    const n = Number(fs.readFileSync(pidFile, 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function tailLogLines(file, n = 25) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/);
    return lines.filter(Boolean).slice(-n).join('\n');
  } catch {
    return '';
  }
}

export function printManagedLogs(logFile, errFile, lines = 40) {
  const out = tailLogLines(logFile, lines);
  const err = tailLogLines(errFile, lines);
  console.log(out ? `=== ${logFile} ===\n${out}` : `（暂无日志：${logFile}）`);
  if (err) console.log(`=== ${errFile} ===\n${err}`);
}

export function rotateLogIfNeeded(filePath, maxBytes = 10 * 1024 * 1024, { copyTruncate = false } = {}) {
  if (!filePath || !(maxBytes > 0) || !fs.existsSync(filePath)) return false;
  try {
    if (fs.statSync(filePath).size <= maxBytes) return false;
    const bak = `${filePath}.1`;
    if (!copyTruncate) {
      try {
        fs.rmSync(bak, { force: true });
        fs.renameSync(filePath, bak);
        return true;
      } catch { /* 运行中进程持有句柄时退回到复制+清空 */ }
    }
    fs.copyFileSync(filePath, bak);
    fs.truncateSync(filePath, 0);
    return true;
  } catch {
    return false;
  }
}

export async function probeHttpJson(url, timeoutMs = 800) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

export async function stopManagedProcess({ name = '进程', pidFile, log = console.log } = {}) {
  const pid = readPidFile(pidFile);
  if (!pid) {
    log(`ℹ ${name} 未在运行（无 PID 文件）`);
    return false;
  }
  if (!isPidAlive(pid)) {
    fs.rmSync(pidFile, { force: true });
    log(`ℹ 已清理 ${name} 的失效 PID 文件（进程 ${pid} 已退出）`);
    return false;
  }

  try { process.kill(pid, 'SIGTERM'); } catch (e) { if (e?.code !== 'ESRCH') throw e; }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && isPidAlive(pid)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (isPidAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch (e) { if (e?.code !== 'ESRCH') throw e; }
    const killDeadline = Date.now() + 1000;
    while (Date.now() < killDeadline && isPidAlive(pid)) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  fs.rmSync(pidFile, { force: true });
  log(`⏹ ${name} 已停止（PID ${pid}）`);
  return true;
}

export async function spawnManagedProcess({
  name = '进程',
  cmd,
  args = [],
  cwd = APP_ROOT,
  env = process.env,
  pidFile,
  logFile,
  errFile,
  healthUrl,
  timeoutMs = 3000,
  pollIntervalMs = 150,
} = {}) {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  rotateLogIfNeeded(logFile);
  rotateLogIfNeeded(errFile);
  const outFd = fs.openSync(logFile, 'a');
  const errFd = fs.openSync(errFile, 'a');
  let child;
  try {
    child = spawn(cmd, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }

  fs.writeFileSync(pidFile, `${child.pid}\n`, 'utf8');
  child.unref();

  const deadline = Date.now() + timeoutMs;
  let healthy = false;
  while (Date.now() < deadline) {
    if (!isPidAlive(child.pid)) {
      fs.rmSync(pidFile, { force: true });
      const detail = tailLogLines(errFile, 20) || tailLogLines(logFile, 20);
      const err = new Error(`${name} 启动后提前退出（PID ${child.pid}）${detail ? `\n${detail}` : ''}`);
      throw err;
    }
    if (healthUrl) {
      try {
        const h = await probeHttpJson(healthUrl, 600);
        if (h?.ok !== false) { healthy = true; break; }
      } catch { /* wait */ }
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  if (healthUrl && !healthy) {
    if (!isPidAlive(child.pid)) fs.rmSync(pidFile, { force: true });
    const detail = tailLogLines(errFile, 15) || tailLogLines(logFile, 15);
    throw new Error(`${name} 在 ${timeoutMs}ms 内未就绪（${healthUrl}）${detail ? `\n${detail}` : ''}`);
  }

  return { pid: child.pid, healthy };
}

function resolveGlobalOmbDir({ run, platform, exists, realpath }) {
  if (platform === 'win32') {
    const whereRes = run('where.exe', ['openmausbot.cmd'], { timeout: 3000, encoding: 'utf8', windowsHide: true });
    if (whereRes?.status !== 0) return null;
    const cmdPath = String(whereRes.stdout || '').trim().split(/\r?\n/).find(Boolean);
    return cmdPath ? path.join(path.dirname(cmdPath), 'node_modules', 'openmausbot') : null;
  }
  const whichRes = run('which', ['openmausbot'], { timeout: 3000, encoding: 'utf8', windowsHide: true });
  if (whichRes?.status !== 0) return null;
  const binPath = String(whichRes.stdout || '').trim().split(/\r?\n/).find(Boolean);
  if (!binPath || !exists(binPath)) return null;
  try {
    return path.dirname(realpath(binPath));
  } catch {
    return path.dirname(binPath);
  }
}

export function findOpenMausBotServer({
  run = spawnSync,
  platform = process.platform,
  exists = fs.existsSync,
  realpath = fs.realpathSync,
} = {}) {
  const ver = platform === 'win32'
    ? run('cmd.exe', ['/d', '/s', '/c', 'openmausbot --version'], { timeout: 5000, encoding: 'utf8', windowsHide: true })
    : run('openmausbot', ['--version'], { timeout: 5000, encoding: 'utf8', windowsHide: true });
  if (ver?.status !== 0) return null;

  const version = String(ver.stdout || '').trim().split(/\r?\n/)[0] || null;
  const pkgDir = resolveGlobalOmbDir({ run, platform, exists, realpath });
  if (pkgDir) {
    const serverEntry = path.join(pkgDir, 'dist-server', 'index.js');
    if (exists(serverEntry)) {
      const staticDir = exists(path.join(pkgDir, 'dist', 'index.html')) ? path.join(pkgDir, 'dist') : null;
      const skillsDir = exists(path.join(pkgDir, 'skills')) ? path.join(pkgDir, 'skills') : null;
      return { kind: 'node', entry: serverEntry, version, staticDir, skillsDir };
    }
  }
  return { kind: 'cli', command: 'openmausbot', version };
}

async function alignCliComputerOff(cfg, { log = console.log } = {}) {
  const baseUrl = cfg.openmausbot.url;
  const loopClient = new OpenMausBotClient({ baseUrl, timeoutMs: 5000 });
  const tokenClient = cfg.openmausbot.token
    ? new OpenMausBotClient({ baseUrl, timeoutMs: 5000, token: cfg.openmausbot.token })
    : null;

  const env = await loopClient.environment().catch(() => null);
  if (env?.capabilities?.selfUpdate === 'desktop-managed') return;

  let botsRes = await loopClient.listBots().catch((e) => ({ _error: e }));
  let activeClient = loopClient;
  if (botsRes?._error && tokenClient) {
    botsRes = await tokenClient.listBots().catch((e) => ({ _error: e }));
    activeClient = tokenClient;
  }
  if (!Array.isArray(botsRes?.bots)) return;

  const visible = botsRes.bots.filter((b) => !b.hidden);
  const chief = visible.find((b) => b.chiefOfStaff) ?? visible[0];
  if (!chief || chief.computer === 'off') return;

  try {
    await activeClient.patchBot(chief.id, { computer: 'off' });
    log(`✓ 已自动将 CLI 模式主 Bot「${chief.name}」的 computer 设为 off`);
  } catch (e) {
    if (tokenClient && activeClient !== tokenClient) {
      await tokenClient.patchBot(chief.id, { computer: 'off' });
      log(`✓ 已自动将 CLI 模式主 Bot「${chief.name}」的 computer 设为 off`);
      return;
    }
    throw e;
  }
}

export async function ensureOpenMausBot(cfg, { log = console.log } = {}) {
  const healthUrl = `${cfg.openmausbot.url}/api/health`;
  let running = false;
  try {
    const h = await probeHttpJson(healthUrl, 1000);
    running = Boolean(h);
  } catch { /* not running yet */ }

  let started = false;
  if (!running) {
    if (cfg.openmausbot.autoStart === false || !isLoopbackUrl(cfg.openmausbot.url)) {
      return { running: false, started: false, skipped: true };
    }
    const found = findOpenMausBotServer();
    if (!found) {
      throw new Error('未检测到全局 openmausbot CLI，请先安装：npm install -g openmausbot（或先启动 OpenMausBot 桌面端）');
    }
    const portNum = Number(new URL(cfg.openmausbot.url).port || 8799);
    const serveArgs = ['serve', '--port', String(portNum), '--no-open', '--no-pair', '--local'];
    const cmd = found.kind === 'node'
      ? process.execPath
      : (process.platform === 'win32' ? 'cmd.exe' : (found.command || 'openmausbot'));
    const args = found.kind === 'node'
      ? ['--no-deprecation', found.entry]
      : (process.platform === 'win32' ? ['/d', '/s', '/c', 'openmausbot', ...serveArgs] : serveArgs);
    const env = {
      ...process.env,
      OMB_PORT: String(portNum),
      OMB_WEBHOOK_PORT: process.env.OMB_WEBHOOK_PORT || String(portNum + 1),
      ...(found.staticDir && !process.env.OMB_STATIC_DIR ? { OMB_STATIC_DIR: found.staticDir } : {}),
      ...(found.skillsDir && !process.env.OMB_SKILLS_DIR ? { OMB_SKILLS_DIR: found.skillsDir } : {}),
    };

    const spawned = await spawnManagedProcess({
      name: 'OpenMausBot CLI',
      cmd,
      args,
      cwd: APP_ROOT,
      env,
      pidFile: path.join(cfg.dataDir, 'openmausbot.pid'),
      logFile: path.join(cfg.dataDir, 'openmausbot.log'),
      errFile: path.join(cfg.dataDir, 'openmausbot.err.log'),
      healthUrl,
      timeoutMs: 15_000,
      pollIntervalMs: 200,
    });
    started = true;
    log(`✓ 已自动拉起 OpenMausBot CLI（PID ${spawned.pid}，${cfg.openmausbot.url}）`);
  }

  if (cfg.openmausbot.cliComputerOff !== false) {
    await alignCliComputerOff(cfg, { log });
  }

  return { running: true, started };
}

export function stopOpenMausBot(cfg, { log = console.log } = {}) {
  return stopManagedProcess({
    name: 'OpenMausBot CLI',
    pidFile: path.join(cfg.dataDir, 'openmausbot.pid'),
    log,
  });
}

function parseCliArgs(argv) {
  let action = '';
  let help = false;
  const extraArgs = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { help = true; continue; }
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
  return { action: action || 'status', help, extraArgs };
}

function usage() {
  console.log([
    '用法：npm run omb -- <ensure|start|stop|restart|status|logs> [--config <path>] [--omb <url>]',
    '  ensure / start  检查本机 OpenMausBot，未运行则按全局 openmausbot CLI 自动拉起并对齐 CLI computer=off',
    '  stop            停止由 co-bot 托管拉起的 OpenMausBot CLI（data/openmausbot.pid）',
    '  restart         重启 OpenMausBot CLI',
    '  status          查看 OpenMausBot 连通、运行模式与主 Bot 状态',
    '  logs            查看 data/openmausbot.log 最近日志',
  ].join('\n'));
}

async function statusOpenMausBot(cfg) {
  const pidFile = path.join(cfg.dataDir, 'openmausbot.pid');
  const pid = readPidFile(pidFile);
  const alive = Boolean(pid && isPidAlive(pid));
  try {
    const h = await probeHttpJson(`${cfg.openmausbot.url}/api/health`, 1200);
    const client = new OpenMausBotClient({ baseUrl: cfg.openmausbot.url, timeoutMs: 3000, token: cfg.openmausbot.token });
    const [env, botsRes] = await Promise.all([
      client.environment().catch(() => null),
      client.listBots().catch(() => null),
    ]);
    const desktopManaged = env?.capabilities?.selfUpdate === 'desktop-managed';
    const visible = (botsRes?.bots ?? []).filter((b) => !b.hidden);
    const chief = visible.find((b) => b.chiefOfStaff) ?? visible[0];
    const mode = desktopManaged ? '桌面端' : 'CLI 模式';
    const managedText = alive ? `托管 PID ${pid}` : '外部启动';
    const doc = h?.doctor;
    const docText = doc ? `，doctor=${doc.problems?.length ? `异常(${doc.problems.length})` : `正常(${doc.checked ?? 0}项)`}` : '';
    console.log(`🟢 OpenMausBot v${h.version ?? '?'} 在线（${cfg.openmausbot.url}，${mode}，${managedText}${chief ? `，主 Bot ${chief.name} computer=${chief.computer ?? 'auto'}` : ''}${docText}）`);
  } catch {
    if (pid && !alive) fs.rmSync(pidFile, { force: true });
    console.log(`⚪ OpenMausBot 未运行（${cfg.openmausbot.url}）`);
    process.exitCode = 1;
  }
}

async function main() {
  const { action, help, extraArgs } = parseCliArgs(process.argv.slice(2));
  if (help) {
    usage();
    return;
  }
  const cfg = loadConfig(extraArgs);
  const logFile = path.join(cfg.dataDir, 'openmausbot.log');
  const errFile = path.join(cfg.dataDir, 'openmausbot.err.log');

  if (action === 'stop') {
    await stopOpenMausBot(cfg);
  } else if (action === 'restart') {
    await stopOpenMausBot(cfg);
    await ensureOpenMausBot(cfg);
  } else if (action === 'ensure' || action === 'start') {
    const res = await ensureOpenMausBot(cfg);
    if (res.skipped) {
      console.log(`ℹ 未自动启动 OpenMausBot（${cfg.openmausbot.url} 非本机回环或已关闭 autoStart）`);
    } else if (!res.started) {
      console.log(`✓ OpenMausBot 已在运行（${cfg.openmausbot.url}）`);
    }
  } else if (action === 'logs') {
    printManagedLogs(logFile, errFile, 40);
  } else {
    await statusOpenMausBot(cfg);
  }
}

const isDirect = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((e) => {
    console.error(`[omb] ${e.message}`);
    process.exitCode = 1;
  });
}
