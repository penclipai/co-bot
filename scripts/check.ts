#!/usr/bin/env node
/**
 * co-bot 就绪自检（npm run check）：
 *   1. 检查 Node >= 24 与 PATH 中的 openmausbot / opencode CLI（--offline 时跳过在线探活）
 *   2. 执行部署安全基线审计（auditDeploymentSafety）与零三方运行时依赖审计（auditZeroExternalRuntimeImports）
 *   3. 若配置外部 IM 通道插件，自动执行静态契约自检
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ROOT, loadConfig, readJsonFile, resolveConfigPath, validateConfig } from '../src/config.ts';
import { discoverPlugins } from '../src/core/plugin-loader.ts';
import { OpenMausBotClient } from '../src/openmausbot/client.ts';
import { resolveChannelSpec } from '../src/plugins/channel-loader.ts';
import { probeOpenMausBot, type ProbeOpenMausBotResult } from '../src/plugins/openmausbot.ts';
import type { AppConfig } from '../src/types.ts';
import { runChannelContractTest } from './channel-test.ts';
import { findOpenMausBotServer, probeHostOf } from './omb.ts';

const LOOPBACK_HOST_RE = /^(?:127\.0\.0\.1|localhost|::1|\[::1\])$/i;
const RUNTIME_IMPORT_RE = /\b(?:import|export)\b[^;'"`\n]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;

export interface DeploymentSafetyAudit {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface ZeroExternalImportsAudit {
  ok: boolean;
  filesScanned: number;
  violations: Array<{ file: string; specifier: string }>;
}

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOST_RE.test(String(host || '').trim());
}

/** 审计配置的安全基线，防止内网误暴露管理接口、关闭脱敏或放开匿名权限。 */
export function auditDeploymentSafety(
  cfg: Partial<AppConfig> | null | undefined,
  channelKind = '',
): DeploymentSafetyAudit {
  const errors: string[] = [];
  const warnings: string[] = [];

  const webHost = String(cfg?.web?.host || '127.0.0.1').trim();
  if (!isLoopbackHost(webHost)) {
    errors.push(`web.host=${webHost} 监听非本机回环地址，/debug、/sim 与控制接口无内置鉴权，请绑定 127.0.0.1/localhost/::1`);
  }

  const ombUrl = String(cfg?.openmausbot?.url || '').trim();
  const ombToken = String(cfg?.openmausbot?.token || '').trim();
  if (ombUrl) {
    try {
      const parsed = new URL(ombUrl);
      if (!isLoopbackHost(parsed.hostname) && !ombToken) {
        warnings.push(`openmausbot.url=${ombUrl} 指向非本机地址，建议显式配置 openmausbot.token`);
      }
    } catch { /* ignore invalid url already checked by validateConfig */ }
  }

  if (cfg?.chats?.externalSanitizeMentions === 'none') {
    warnings.push('chats.externalSanitizeMentions="none" 已关闭外部出站 @提及 脱敏，可能误触发群全体/其他 Bot 回声');
  }

  const collabs = Array.isArray(cfg?.chats?.collaborators) ? cfg.chats.collaborators : [];
  for (const c of collabs) {
    const idStr = typeof c === 'string' ? c : String(c?.id || '');
    const policyStr = typeof c === 'object' && c ? c.policy : undefined;
    if (idStr.trim() === '*' && policyStr === 'auto_readonly') {
      errors.push('chats.collaborators 包含通配 "*" 且 policy="auto_readonly"，禁止对任意未知发送者开放自动回复');
    }
    if (
      typeof c === 'object'
      && c
      && Array.isArray(cfg?.projects)
      && cfg.projects.length > 0
      && (!Array.isArray(c.projects) || c.projects.length === 0)
    ) {
      warnings.push(`协作者「${c.name || idStr || '?'}」未显式限定 projects，建议按最小权限原则收窄项目白名单`);
    }
  }

  if (channelKind && channelKind !== 'sim') {
    const selfChatId = String(cfg?.channel?.options?.selfChatId || '').trim();
    if (!selfChatId) {
      warnings.push('外部通道未预设 channel.options.selfChatId，首次启动需由本人在控制群发消息完成自聊识别');
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function stripJsComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

function walkTsFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkTsFiles(full, out);
    } else if (ent.isFile() && ent.name.endsWith('.ts') && !ent.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
}

/** 审计 `src/` 与 `scripts/` 的运行时源码是否存在任何非 `node:` / 相对路径的三方依赖导入。 */
export function auditZeroExternalRuntimeImports(rootDir: string): ZeroExternalImportsAudit {
  const files: string[] = [];
  walkTsFiles(path.join(rootDir, 'src'), files);
  walkTsFiles(path.join(rootDir, 'scripts'), files);
  const violations: Array<{ file: string; specifier: string }> = [];

  for (const file of files) {
    const cleaned = stripJsComments(fs.readFileSync(file, 'utf8'));
    RUNTIME_IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RUNTIME_IMPORT_RE.exec(cleaned)) !== null) {
      const spec = (m[1] ?? m[2] ?? m[3] ?? '').trim();
      if (!spec) continue;
      if (!spec.startsWith('node:') && !spec.startsWith('./') && !spec.startsWith('../')) {
        violations.push({ file: path.relative(rootDir, file), specifier: spec });
      }
    }
  }
  return { ok: violations.length === 0, filesScanned: files.length, violations };
}

/** 执行 CLI 就绪自检，支持 `--offline` 与 `--fix-cli`。 */
export async function runCheckCli(argv: string[]): Promise<number> {
  const fixCli = argv.includes('--fix-cli');
  const offline = argv.includes('--offline');
  const rawCfgPath = resolveConfigPath(argv);
  let fails = 0;

  if (rawCfgPath && fs.existsSync(rawCfgPath)) {
    try {
      const rawJson = readJsonFile(rawCfgPath);
      const v = validateConfig(rawJson);
      for (const w of v.warnings) console.log(`⚠ [config] ${w}`);
      for (const e of v.errors) { console.error(`✗ [config] ${e}`); fails++; }
      if (v.ok && !v.warnings.length) console.log(`✓ 配置文件校验通过（${rawCfgPath}）`);
    } catch (e) {
      console.error(`✗ 配置文件 JSON 解析失败（${rawCfgPath}）：${e instanceof Error ? e.message : String(e)}`);
      fails++;
    }
  }

  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig(argv);
  } catch (e) {
    console.error(`✗ 加载配置失败：${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const [maj] = process.versions.node.split('.').map(Number);
  if (maj >= 24) {
    console.log(`✓ Node.js v${process.versions.node}`);
  } else {
    console.error(`✗ Node.js 需要 >= 24，当前 v${process.versions.node}`);
    fails++;
  }

  const chanSpec = resolveChannelSpec(cfg);
  const safety = auditDeploymentSafety(cfg, chanSpec.name || chanSpec.kind);
  for (const w of safety.warnings) console.log(`⚠ [safety] ${w}`);
  for (const e of safety.errors) { console.error(`✗ [safety] ${e}`); fails++; }
  if (safety.ok && !safety.warnings.length) console.log('✓ 部署安全基线检查通过');

  const zeroDeps = auditZeroExternalRuntimeImports(APP_ROOT);
  if (zeroDeps.ok) {
    console.log(`✓ 零三方运行时依赖检查通过（扫描 ${zeroDeps.filesScanned} 个源文件）`);
  } else {
    for (const v of zeroDeps.violations) {
      console.error(`✗ 非法外部依赖导入 ${v.file}: ${v.specifier}`);
    }
    fails++;
  }

  if (offline) {
    console.log('ℹ --offline 模式：已跳过 CLI 与 OpenMausBot 在线探活');
  } else {
    const ombCli = findOpenMausBotServer();
    if (ombCli) {
      console.log(`✓ 全局 openmausbot CLI${ombCli.version ? ` v${ombCli.version}` : ''} 已安装`);
    } else {
      console.log('ℹ 未在 PATH 检测到全局 openmausbot CLI（如使用桌面端或远端服务可忽略；需要自动拉起可运行 npm install -g openmausbot）');
    }

    const oc = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'opencode --version'], { timeout: 3000, encoding: 'utf8', windowsHide: true })
      : spawnSync('opencode', ['--version'], { timeout: 3000, encoding: 'utf8', windowsHide: true });
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
    let probe: ProbeOpenMausBotResult | null = null;
    try {
      probe = await probeOpenMausBot(client);
    } catch (e) {
      console.error(`✗ 无法连接 OpenMausBot (${cfg.openmausbot.url})：${e instanceof Error ? e.message : String(e)}`);
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
            console.log(`✓ OpenMausBot 运行模式：桌面端（已配对：${sess?.label || 'session'}，scopes: ${scopes}）`);
          } else {
            console.error('✗ OpenMausBot 为桌面端模式且未配对（发送消息会返回 403）。请先运行 `npm run pair`（桌面端一键允许）或 `npm run pair -- <12位配对码>`');
            fails++;
          }
        } else {
          if (paired) {
            console.log(`✓ OpenMausBot 运行模式：CLI 模式（已配对：${sess?.label || 'session'}，CLI 本地亦可免配对）`);
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
                console.error(`✗ 修复主 Bot computer 设置失败：${e instanceof Error ? e.message : String(e)}`);
                fails++;
              }
            } else {
              console.log(`⚠ 提示：CLI 模式下主 Bot「${chief.name}」的 computer 当前为「${chief.computer || 'auto'}」，访问本机路径可能触发 This computer 不可用报错；可运行 \`npm run check -- --fix-cli\` 一键设为 off（直接走本地 opencode 工具）。`);
            }
          }
        }
      }
    }
  }

  if (cfg.pluginsDir) {
    const disc = await discoverPlugins(cfg.pluginsDir, { logger: { warn: () => {} } });
    if (disc.plugins.length || disc.errors.length) {
      console.log(`✓ plugins 目录（${disc.dir}）：发现 ${disc.plugins.length} 个插件（通道 ${disc.channels.size} / 扩展 ${disc.extensions.length}）`);
    }
    for (const err of disc.errors) {
      console.error(`✗ plugins 加载异常（${err.source}）：${err.error}`);
      if (cfg.pluginsStrict) fails++;
    }
  }

  const webBase = `http://${probeHostOf(cfg.web.host)}:${cfg.web.port}`;
  if (chanSpec.kind === 'external' || chanSpec.kind === 'auto') {
    const res = await runChannelContractTest(cfg, { dry: true, log: () => {} });
    if (res.ok) {
      console.log(`✓ 通道插件「${res.channelName}」契约检查通过（诊断台 ${webBase}/debug）`);
    } else {
      for (const err of res.errors) console.error(`✗ 通道插件「${chanSpec.spec}」：${err}`);
      fails++;
    }
  } else {
    console.log(`✓ 通道模式：${chanSpec.name}（Web 自聊模拟器 ${webBase}/sim）`);
  }

  return fails ? 1 : 0;
}

const isDirect = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  runCheckCli(process.argv.slice(2)).then((code) => {
    if (code) process.exitCode = code;
  }).catch((e: unknown) => {
    console.error(`✗ check 失败：${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
