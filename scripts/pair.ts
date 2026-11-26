#!/usr/bin/env node
/**
 * OpenMausBot 桌面端配对脚本：
 *   - 方式 1（推荐）：npm run pair              -> 发起官方终端一键授权（在桌面端点击 Allow/允许即可）
 *   - 方式 2：       npm run pair -- <12位码> -> 用 Settings → Phone & devices 的 12 位配对码兑换 Token
 *   写入 config.json（已在 .gitignore 中），并通过 /api/auth/session 校验生效。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, loadConfig, readJsonFile } from '../src/config.ts';
import { writeJsonAtomic } from '../src/format.ts';
import { OpenMausBotClient } from '../src/openmausbot/client.ts';
import type { OmbAuthSession, OmbHttpError } from '../src/openmausbot/types.ts';

function parseArgs(argv: string[]) {
  let configFile: string | undefined;
  let ombUrl: string | undefined;
  let label = 'co-bot';
  let scope = 'client';
  let login = false;
  let help = false;
  let code = '';

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (a === '--login') { login = true; continue; }
    if (a === '--help' || a === '-h') { help = true; continue; }
    if (a === '--config' && argv[i + 1]) { configFile = argv[++i]; continue; }
    if (a === '--omb' && argv[i + 1]) { ombUrl = argv[++i]; continue; }
    if (a === '--label' && argv[i + 1]) { label = argv[++i]; continue; }
    if (a === '--scope' && argv[i + 1]) { scope = argv[++i]; continue; }
    if (!a.startsWith('-') && !code) code = a;
  }

  if (scope !== 'client' && scope !== 'admin') {
    throw new Error(`无效的 --scope "${scope}"，仅支持 client 或 admin`);
  }

  return { configFile, ombUrl, label, scope, login, help, code: code.trim() };
}

function parseDeadline(expiresAt: unknown, fallbackMs = 10 * 60_000): number {
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > 0) {
    return expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
  }
  if (typeof expiresAt === 'string') {
    const ts = Date.parse(expiresAt);
    if (Number.isFinite(ts)) return ts;
  }
  return Date.now() + fallbackMs;
}

function usage(): void {
  console.log([
    '用法：',
    '  npm run pair                  # 推荐：向 OpenMausBot 桌面端发起一键终端授权（点击允许即可）',
    '  npm run pair -- <12位配对码>  # 备选：用 Settings → Phone & devices 的 12 位码（如 7KQ2-M9XD-H4TP）配对',
    '可选参数：--scope client|admin --label co-bot --omb http://127.0.0.1:8799 --config config.json',
  ].join('\n'));
}

async function saveAndVerifyToken({
  token,
  session,
  label,
  configPath,
  existingConfigPath,
  ombUrl,
  baseUrl,
}: {
  token?: string;
  session?: OmbAuthSession;
  label: string;
  configPath: string;
  existingConfigPath: string | null;
  ombUrl?: string;
  baseUrl: string;
}): Promise<void> {
  if (typeof token !== 'string' || !token.startsWith('omb_sess_')) {
    throw new Error('OpenMausBot 未返回有效的会话 Token（omb_sess_...）');
  }

  let raw: Record<string, unknown> = {};
  const examplePath = path.join(APP_ROOT, 'config.example.json');
  if (existingConfigPath) {
    raw = readJsonFile(configPath) as Record<string, unknown>;
  } else if (fs.existsSync(examplePath)) {
    raw = readJsonFile(examplePath) as Record<string, unknown>;
  }

  if (!raw.openmausbot || typeof raw.openmausbot !== 'object' || Array.isArray(raw.openmausbot)) {
    raw.openmausbot = {};
  }
  const ombObj = raw.openmausbot as Record<string, unknown>;
  ombObj.token = token;
  if (ombUrl || !ombObj.url) {
    ombObj.url = baseUrl;
  }

  writeJsonAtomic(configPath, raw, { pretty: true });

  const authed = new OpenMausBotClient({ baseUrl, token, timeoutMs: 5000 });
  const sess = await authed.authSession();
  const sessLabel = sess?.label || session?.label || label;
  const scopes = Array.isArray(sess?.scopes) ? sess.scopes : (session?.scopes ?? []);

  console.log(`✓ 配对成功：${sessLabel}（scopes: ${scopes.join(', ') || 'unknown'}）`);
  console.log(`✓ Token 已安全写入 ${configPath}（不会输出到日志，且已在 .gitignore 中）`);
  console.log('ℹ 请重启 co-bot（例如重新运行 npm run restart 或 npm start）使新 Token 生效。');
}

async function runCliLogin({
  client,
  label,
  scope,
  configPath,
  existingConfigPath,
  ombUrl,
  baseUrl,
}: {
  client: OpenMausBotClient;
  label: string;
  scope: string;
  configPath: string;
  existingConfigPath: string | null;
  ombUrl?: string;
  baseUrl: string;
}): Promise<void> {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const verifierHash = crypto.createHash('sha256').update(verifier).digest('base64url');
  const req = await client.startCliLogin({ label, scope, verifierHash });
  if (!req?.id || !req?.code) {
    throw new Error('OpenMausBot 未返回有效的终端授权请求');
  }

  console.log('⏳ 已向 OpenMausBot 桌面端发起终端授权请求');
  console.log(`🔑 核对验证码：${req.code}`);
  console.log('👉 请在 OpenMausBot 桌面端窗口中点击「Allow / 允许」（10 分钟内有效，点击后将自动完成配对）…');

  const intervalMs = Math.max(500, Number(req.intervalMs) || 1000);
  const deadline = parseDeadline(req.expiresAt);
  let consecutiveErrors = 0;

  while (Date.now() < deadline) {
    let poll;
    try {
      poll = await client.pollCliLogin(req.id, { verifier });
      consecutiveErrors = 0;
    } catch (e) {
      const err = e as OmbHttpError;
      if (err?.status === 403 || err?.status === 404) throw e;
      consecutiveErrors += 1;
      if (consecutiveErrors >= 5) throw e;
      console.warn(`⚠ 轮询终端授权状态暂时失败（第 ${consecutiveErrors} 次）：${err?.message ?? String(e)}，稍后重试…`);
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    if (poll?.state === 'allowed') {
      await saveAndVerifyToken({
        token: poll.token,
        session: poll.session,
        label,
        configPath,
        existingConfigPath,
        ombUrl,
        baseUrl,
      });
      return;
    }
    if (poll?.state === 'waiting') {
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    throw new Error(poll?.error || '授权未通过');
  }

  throw new Error('等待桌面端确认超时，请重新运行 npm run pair');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { configFile, ombUrl, label, scope, login, help, code } = parseArgs(argv);

  if (help) {
    usage();
    return;
  }

  const configPath = configFile ? path.resolve(configFile) : path.join(APP_ROOT, 'config.json');
  const existingConfigPath = fs.existsSync(configPath) ? configPath : null;
  const cfg = loadConfig(argv, existingConfigPath);
  const client = new OpenMausBotClient({ baseUrl: cfg.openmausbot.url, timeoutMs: 10_000 });

  if (!code || login) {
    await runCliLogin({ client, label, scope, configPath, existingConfigPath, ombUrl, baseUrl: cfg.openmausbot.url });
    return;
  }

  try {
    const res = await client.pair({ code, label });
    await saveAndVerifyToken({
      token: res?.token,
      session: res?.session,
      label,
      configPath,
      existingConfigPath,
      ombUrl,
      baseUrl: cfg.openmausbot.url,
    });
  } catch (e) {
    const err = e as OmbHttpError;
    const isOld6Digit = err?.code === 'pairing_old_code'
      || /phone app|12-character|\b6\b/i.test(String(err?.message || ''))
      || /^\d{6}$/.test(code.replace(/[\s-]/g, ''));
    if (isOld6Digit) {
      throw new Error(
        `${err?.message ?? String(e)}\n💡 你输入的是手机 App 专用 6 位数字码；本地脚本可直接运行无参数的 \`npm run pair\`（在桌面端点一次 Allow 即可），或改用 12 位配对码（形如 7KQ2-M9XD-H4TP）。`,
        { cause: e },
      );
    }
    throw e;
  }
}

main().catch((e: unknown) => {
  console.error(`✗ 配对失败：${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
