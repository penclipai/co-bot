#!/usr/bin/env node
/**
 * co-bot 就绪自检（npm run check）：
 *   1. 检查 Node >= 24 与 PATH 中的 opencode CLI
 *   2. 检查 OpenMausBot Harness 连通性、运行模式（CLI / 桌面端）与 CLI computer 设置（可选 --fix-cli）
 *   3. 若配置外部 IM 通道插件，自动执行静态契约自检
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, validateConfig, APP_ROOT } from '../src/config.js';
import { OpenMausBotClient } from '../src/openmausbot/client.js';
import { resolveChannelSpec } from '../src/plugins/channel-loader.js';
import { probeOpenMausBot } from '../src/plugins/openmausbot.js';
import { runChannelContractTest } from './channel-test.js';

const argv = process.argv.slice(2);
const fixCli = argv.includes('--fix-cli');
const cfgIdx = argv.indexOf('--config');
const explicitCfg = cfgIdx >= 0 && argv[cfgIdx + 1] ? argv[cfgIdx + 1] : null;
const rawCfgPath = explicitCfg ?? (fs.existsSync('config.json') ? 'config.json' : (fs.existsSync(path.join(APP_ROOT, 'config.json')) ? path.join(APP_ROOT, 'config.json') : null));
let fails = 0;

if (rawCfgPath && fs.existsSync(rawCfgPath)) {
  try {
    const rawJson = JSON.parse(fs.readFileSync(rawCfgPath, 'utf8'));
    const v = validateConfig(rawJson);
    for (const w of v.warnings) console.log(`⚠ [config] ${w}`);
    for (const e of v.errors) { console.error(`✗ [config] ${e}`); fails++; }
    if (v.ok && !v.warnings.length) console.log(`✓ 配置文件校验通过（${rawCfgPath}）`);
  } catch (e) {
    console.error(`✗ 配置文件 JSON 解析失败（${rawCfgPath}）：${e.message}`);
    fails++;
  }
}

const cfg = loadConfig(argv);
const [maj] = process.versions.node.split('.').map(Number);

if (maj >= 24) {
  console.log(`✓ Node.js v${process.versions.node}`);
} else {
  console.error(`✗ Node.js 需要 >= 24，当前 v${process.versions.node}`);
  fails++;
}

const ombPkgPath = path.join(APP_ROOT, 'node_modules', 'openmausbot', 'package.json');
if (fs.existsSync(ombPkgPath)) {
  try {
    const pkg = JSON.parse(fs.readFileSync(ombPkgPath, 'utf8'));
    console.log(`✓ 本地依赖 openmausbot v${pkg.version ?? '?'} 已安装`);
  } catch {
    console.log('✓ 本地依赖 openmausbot 已安装');
  }
} else {
  console.log('⚠ 本地未安装 openmausbot，可运行 npm install 自动安装');
}

const oc = process.platform === 'win32'
  ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'opencode --version'], { timeout: 3000, encoding: 'utf8' })
  : spawnSync('opencode', ['--version'], { timeout: 3000, encoding: 'utf8' });
if (oc.status === 0 && String(oc.stdout || '').trim()) {
  console.log(`✓ opencode CLI: ${String(oc.stdout).trim().split(/\r?\n/)[0]}`);
} else {
  console.log('ℹ 未在 PATH 检测到 opencode（如 OpenMausBot 使用其他引擎或自定义路径可忽略）');
}

const client = new OpenMausBotClient({
  baseUrl: cfg.openmausbot.url,
  timeoutMs: 5000,
  token: cfg.openmausbot.token,
});
let probe = null;
try {
  probe = await probeOpenMausBot(client);
} catch (e) {
  console.error(`✗ 无法连接 OpenMausBot (${cfg.openmausbot.url})：${e.message}`);
  fails++;
}

if (probe) {
  const { health: ombHealth, authErr, botsErr, visible, desktopManaged, paired, session: sess } = probe;
  if (authErr) {
    console.log(`✓ OpenMausBot v${ombHealth.version ?? '?'} 已连通（${cfg.openmausbot.url}）`);
    console.error(`✗ OpenMausBot 认证失败（${authErr.status}：${authErr.message}），Token 可能已过期或被撤销，请重新运行：npm run pair`);
    fails++;
  } else if (botsErr) {
    console.error(`✗ 读取 Bot 列表失败：${botsErr.message}`);
    fails++;
  } else {
    const chief = visible.find((b) => b.chiefOfStaff) ?? visible[0];
    console.log(`✓ OpenMausBot v${ombHealth.version ?? '?'} 已就绪（${cfg.openmausbot.url}，可见 Bot ${visible.length} 个，主 Bot：${chief?.name ?? '无'}）`);
    const doc = ombHealth?.doctor;
    if (doc) {
      if (Array.isArray(doc.problems) && doc.problems.length) {
        console.log(`⚠ OpenMausBot doctor 发现 ${doc.problems.length} 个问题：${doc.problems.join('；')}`);
      } else {
        console.log(`✓ OpenMausBot doctor 自检正常（已检 ${doc.checked ?? 0} 项${doc.fixed?.length ? `，自动修复 ${doc.fixed.length} 项` : ''}）`);
      }
    }
    const scopes = Array.isArray(sess?.scopes) ? sess.scopes.join(', ') : '';
    const getPatchClient = () => (!desktopManaged && paired && !sess?.scopes?.includes('admin'))
      ? new OpenMausBotClient({ baseUrl: cfg.openmausbot.url, timeoutMs: 5000 })
      : client;
    if (desktopManaged) {
      if (paired) {
        console.log(`✓ OpenMausBot 运行模式：桌面端（已配对：${sess.label || 'session'}，scopes: ${scopes}）`);
      } else {
        console.error('✗ OpenMausBot 为桌面端模式且未配对（发送消息会返回 403）。请先运行 `npm run pair`（桌面端一键允许）或 `npm run pair -- <12位配对码>`');
        fails++;
      }
    } else {
      if (paired) {
        console.log(`✓ OpenMausBot 运行模式：CLI 模式（已配对：${sess.label || 'session'}，CLI 本地亦可免配对）`);
      } else {
        console.log('✓ OpenMausBot 运行模式：CLI 模式（本地免配对）');
      }
      if (chief && chief.computer !== 'off') {
        if (fixCli) {
          try {
            const patched = await getPatchClient().patchBot(chief.id, { computer: 'off' });
            const cur = patched?.bot?.computer ?? 'off';
            if (cur !== 'off') throw new Error(`bot.computer 仍为 ${cur}`);
            console.log(`✓ 已将 CLI 模式主 Bot「${chief.name}」的 computer 设为 off（避免访问本机路径触发 agents_select_computer 报错，直接走本地 opencode/bash）`);
          } catch (e) {
            console.error(`✗ 修复主 Bot computer 设置失败：${e.message}`);
            fails++;
          }
        } else {
          console.log(`⚠ 提示：CLI 模式下主 Bot「${chief.name}」的 computer 当前为「${chief.computer || 'auto'}」，访问本机路径可能触发 This computer 不可用报错；可运行 \`npm run check -- --fix-cli\` 一键设为 off（直接走本地 opencode 工具）。`);
        }
      }
    }
  }
}

const chanSpec = resolveChannelSpec(cfg);
if (chanSpec.kind === 'external') {
  const res = await runChannelContractTest(cfg, { dry: true, log: () => {} });
  if (res.ok) {
    console.log(`✓ 通道插件「${res.channelName}」契约检查通过（诊断台 http://${cfg.web.host}:${cfg.web.port}/debug）`);
  } else {
    for (const err of res.errors) console.error(`✗ 通道插件「${chanSpec.spec}」：${err}`);
    fails++;
  }
} else {
  console.log(`✓ 通道模式：${chanSpec.name}（Web 自聊模拟器 http://${cfg.web.host}:${cfg.web.port}/sim）`);
}

if (fails) process.exitCode = 1;
