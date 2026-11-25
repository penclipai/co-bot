#!/usr/bin/env node
/**
 * 通用 IM 通道插件契约检测与联调工具（npm run channel:test）：
 *   node scripts/channel-test.ts [--channel ./im-plugin.ts] [--config config.json] [--dry] [--wait 15] [--send "测试"] [--check-file]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ROOT, loadConfig } from '../src/config.ts';
import { validateChannelAdapter, validateInboundEvent } from '../src/core/channel-contract.ts';
import { Kernel, parseInject } from '../src/core/kernel.ts';
import { loadChannelPlugin } from '../src/plugins/channel-loader.ts';
import type { AppConfig, ChannelAdapter, ChannelCapabilities, InboundEvent, KernelPlugin, RawConfig } from '../src/types.ts';
import { WebServer } from '../src/web/server.ts';

function parseArgs(argv: string[]) {
  let configFile: string | undefined;
  let channelUse = '';
  let waitSec = 10;
  let waitExplicit = false;
  let sendText = '';
  let dry = false;
  let checkFile = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { help = true; continue; }
    if (a === '--dry') { dry = true; continue; }
    if (a === '--check-file') { checkFile = true; continue; }
    if (a === '--config' && argv[i + 1]) { configFile = argv[++i]; continue; }
    if (a === '--channel' && argv[i + 1]) { channelUse = argv[++i]; continue; }
    if (a === '--wait' && argv[i + 1]) { waitSec = Math.max(0, Number(argv[++i]) || 0); waitExplicit = true; continue; }
    if (a === '--send' && argv[i + 1]) { sendText = String(argv[++i]); continue; }
  }
  return { configFile, channelUse, waitSec, waitExplicit, sendText, dry, checkFile, help };
}

function usage(): void {
  console.log([
    '用法：npm run channel:test -- [--channel <名称或路径>] [--config config.json] [--dry] [--wait 15] [--send "你好"] [--check-file]',
    '  --channel     指定待检通道插件（如 sim、./im-plugin.ts；默认读取 config.json）',
    '  --dry         仅做静态加载、方法导出与 capabilities 契约校验（不实际建立长连接）',
    '  --wait N      实时模式：最多等待 N 秒接收一条消息并检验 InboundEvent 字段映射（默认 10s）',
    '  --send T      实时模式：拿到 selfChatId 后回发一条测试文本验证 send()',
    '  --check-file  实时模式：发送一个极小 .txt 文件验证 sendFile()',
  ].join('\n'));
}

function createContractWebPlugin(cfg: Pick<AppConfig, 'web'>, { dry }: { dry: boolean }): KernelPlugin {
  return {
    name: dry ? 'web-contract-stub' : 'web-contract-live',
    kind: 'core',
    provides: ['web'],
    async apply(ctx) {
      const web = new WebServer({
        host: cfg.web?.host ?? '127.0.0.1',
        port: 0,
        publicDir: path.join(APP_ROOT, 'public'),
      });
      if (!dry) {
        await web.start();
        ctx.effect(() => web.stop());
      }
      ctx.provide('web', web);
    },
  };
}

interface ContractChannelInstance extends Partial<ChannelAdapter> {
  adapter?: Partial<ChannelAdapter>;
  selfChatId?: string;
}

export interface ChannelContractTestResult {
  ok: boolean;
  channelName: string;
  capabilities?: Partial<ChannelCapabilities>;
  errors: string[];
  warnings: string[];
  inboundValidated?: boolean;
  sentMsgId?: string | number | void | null;
  sentFileId?: string | number | void | null;
}

/** 对给定配置与通道插件执行静态契约验证，并在非 dry 模式下执行实时收发验收。 */
export async function runChannelContractTest(
  cfg: Partial<AppConfig> | RawConfig,
  {
    overrideUse = '',
    baseDir = APP_ROOT,
    dry = false,
    waitSec = 10,
    waitExplicit = false,
    sendText = '',
    checkFile = false,
    log = console.log,
  }: {
    overrideUse?: string;
    baseDir?: string;
    dry?: boolean;
    waitSec?: number;
    waitExplicit?: boolean;
    sendText?: string;
    checkFile?: boolean;
    log?: (msg: string) => void;
  } = {},
): Promise<ChannelContractTestResult> {
  const appCfg = cfg as AppConfig;
  const errors: string[] = [];
  const warnings: string[] = [];
  let loaded;
  try {
    loaded = await loadChannelPlugin(appCfg, { overrideUse, baseDir });
  } catch (e) {
    return {
      ok: false,
      channelName: overrideUse || appCfg?.channel?.use || 'sim',
      errors: [e instanceof Error ? e.message : String(e)],
      warnings,
    };
  }

  const kernel = new Kernel({ config: appCfg, logger: { warn: () => {}, error: () => {} } });
  const parsedInject = parseInject(loaded.plugin.inject);
  const needsWeb = parsedInject.required.includes('web') || parsedInject.optional.includes('web');
  if (needsWeb) {
    kernel.use(createContractWebPlugin(appCfg, { dry }));
  }
  kernel.use(loaded.plugin, loaded.options);

  let channel: ContractChannelInstance;
  let inboundValidated = false;
  let sentMsgId: string | number | void | null = null;
  let sentFileId: string | number | void | null = null;

  try {
    try {
      await kernel.start();
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      return {
        ok: false,
        channelName: loaded.resolvedName,
        capabilities: {},
        errors,
        warnings,
        inboundValidated,
        sentMsgId,
        sentFileId,
      };
    }
    channel = kernel.get<ContractChannelInstance>('channel');
    const targetForValidation = channel.adapter ?? channel;
    const check = validateChannelAdapter(targetForValidation, channel.capabilities);
    errors.push(...check.errors);
    warnings.push(...check.warnings);

    log(`✓ 已加载通道插件「${loaded.resolvedName}」`);
    log(`  能力声明：${JSON.stringify(check.capabilities)}`);
    for (const w of warnings) log(`⚠ ${w}`);
    for (const e of errors) log(`✗ ${e}`);

    if (dry || errors.length) {
      return {
        ok: errors.length === 0,
        channelName: loaded.resolvedName,
        capabilities: check.capabilities,
        errors,
        warnings,
        inboundValidated,
        sentMsgId,
        sentFileId,
      };
    }

    let gotInboundResolve: () => void = () => {};
    const gotInbound = new Promise<void>((r) => { gotInboundResolve = r; });

    await channel.start?.(async (rawEv: unknown) => {
      const ev = rawEv as Partial<InboundEvent> | null | undefined;
      const evCheck = validateInboundEvent(ev);
      if (!evCheck.ok) {
        errors.push(`入站事件不合规：${evCheck.errors.join('；')}`);
      } else {
        inboundValidated = true;
      }
      const fwdTag = ev?.forwarded ? `bundle(${ev.forwarded.messages.length})` : (ev?.isForwarded ? 'single' : '-');
      log(`← 入站事件 id=${ev?.id} chat=${ev?.chat?.type}:${ev?.chat?.id} self=${ev?.sender?.isSelf} dev=${ev?.device?.type || '-'} fwd=${fwdTag} mentions=${ev?.mentions?.length ?? 0}`);
      if (ev?.chat?.type !== 'self') {
        log('  ⚠ 提示：该事件 chat.type !== "self"，请确认自聊会话映射规则');
      }
      if (!ev?.sender?.isSelf) {
        log('  ⚠ 提示：该事件 sender.isSelf === false，自聊触发器不会响应他人的消息');
      }
      const needsSelfChatId = Boolean((sendText || checkFile) && !channel.selfChatId);
      if (!needsSelfChatId || channel.selfChatId) gotInboundResolve();
    }, {});

    log(`✓ 通道已连接：${JSON.stringify(channel.status?.() ?? {})}`);
    const shouldWait = waitSec > 0 && (waitExplicit || (!sendText && !checkFile) || !channel.selfChatId);
    if (shouldWait) {
      log(`⏳ 等待最多 ${waitSec}s 接收消息以验证入站字段${channel.selfChatId ? '' : '并学习 selfChatId'}…`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        gotInbound,
        new Promise<void>((r) => { timer = setTimeout(r, waitSec * 1000); timer.unref?.(); }),
      ]);
      if (timer) clearTimeout(timer);
    }

    if (sendText) {
      if (!channel.selfChatId) {
        errors.push('未获取到 selfChatId，无法测试 send()（请配置 selfChatId 或在等待窗内发一条自聊消息）');
      } else {
        sentMsgId = await channel.send?.(channel.selfChatId, sendText);
        log(`→ send() 成功：msgId=${sentMsgId ?? 'undefined'}`);
      }
    }

    if (checkFile) {
      if (!check.capabilities.files) {
        log('ℹ 该通道声明 capabilities.files=false，已跳过 sendFile() 校验');
      } else if (!channel.selfChatId) {
        errors.push('未获取到 selfChatId，无法测试 sendFile()');
      } else {
        const tmpFile = path.join(os.tmpdir(), `cobot-channel-test-${Date.now()}.txt`);
        fs.writeFileSync(tmpFile, 'co-bot channel contract smoke file\n', 'utf8');
        try {
          sentFileId = await channel.sendFile?.(channel.selfChatId, { path: tmpFile, name: 'cobot-smoke.txt' }, {});
          log(`→ sendFile() 成功：msgId=${sentFileId ?? 'undefined'}`);
        } finally {
          fs.rmSync(tmpFile, { force: true });
        }
      }
    }

    return {
      ok: errors.length === 0,
      channelName: loaded.resolvedName,
      capabilities: check.capabilities,
      errors,
      warnings,
      inboundValidated,
      sentMsgId,
      sentFileId,
    };
  } finally {
    await kernel.stop();
  }
}

async function main(): Promise<void> {
  const { configFile, channelUse, waitSec, waitExplicit, sendText, dry, checkFile, help } = parseArgs(process.argv.slice(2));
  if (help) {
    usage();
    return;
  }
  const cfg = loadConfig(process.argv.slice(2), configFile);
  const res = await runChannelContractTest(cfg, {
    overrideUse: channelUse,
    baseDir: channelUse ? process.cwd() : APP_ROOT,
    dry,
    waitSec,
    waitExplicit,
    sendText,
    checkFile,
  });
  if (!res.ok) {
    for (const e of res.errors) console.error(`✗ ${e}`);
    process.exitCode = 1;
  }
}

const isDirect = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((e: unknown) => {
    console.error(`✗ channel:test 失败：${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
