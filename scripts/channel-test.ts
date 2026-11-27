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
import {
  validateChannelAdapter,
  validateConfigIdsAgainstPatterns,
  validateIdsAgainstPatterns,
  validateInboundEvent,
} from '../src/core/channel-contract.ts';
import { Kernel, parseInject } from '../src/core/kernel.ts';
import { loadChannelPlugin } from '../src/plugins/channel-loader.ts';
import type {
  AppConfig,
  ChannelAdapter,
  ChannelCapabilities,
  ChannelIdPatterns,
  InboundEvent,
  KernelPlugin,
  RawConfig,
} from '../src/types.ts';
import { WebServer } from '../src/web/server.ts';

function parseArgs(argv: string[]) {
  let configFile: string | undefined;
  let channelUse = '';
  let waitSec = 10;
  let waitExplicit = false;
  let sendText = '';
  let expectEvents = 1;
  let dry = false;
  let strict = false;
  let checkFile = false;
  let checkHistory = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { help = true; continue; }
    if (a === '--dry') { dry = true; continue; }
    if (a === '--strict') { strict = true; continue; }
    if (a === '--check-file') { checkFile = true; continue; }
    if (a === '--check-history') { checkHistory = true; continue; }
    if (a === '--config' && argv[i + 1]) { configFile = argv[++i]; continue; }
    if (a === '--channel' && argv[i + 1]) { channelUse = argv[++i]; continue; }
    if (a === '--wait' && argv[i + 1]) { waitSec = Math.max(0, Number(argv[++i]) || 0); waitExplicit = true; continue; }
    if (a === '--send' && argv[i + 1]) { sendText = String(argv[++i]); continue; }
    if (a === '--expect-events' && argv[i + 1]) { expectEvents = Math.max(1, Number(argv[++i]) || 1); continue; }
  }
  return { configFile, channelUse, waitSec, waitExplicit, sendText, expectEvents, dry, strict, checkFile, checkHistory, help };
}

function usage(): void {
  console.log([
    '用法：npm run channel:test -- [--channel <名称或路径>] [--config config.json] [--dry] [--strict] [--wait 15] [--expect-events 1] [--send "你好"] [--check-file] [--check-history]',
    '  --channel        指定待检通道插件（如 sim、./im-plugin.ts；默认读取 config.json）',
    '  --dry            仅做静态加载、方法导出与 capabilities 契约校验（不实际建立长连接）',
    '  --strict         严格契约模式：将 ID 规范/混合字段/回退 mentions 告警升级为失败',
    '  --wait N         实时模式：最多等待 N 秒接收消息并检验 InboundEvent 字段映射（默认 10s）',
    '  --expect-events  实时模式：等待收满 N 条消息事件（默认 1；便于同时核对群聊+引用+@提及）',
    '  --send T         实时模式：拿到 selfChatId 后回发一条测试文本验证 send() 与回声 ID 一致性',
    '  --check-file     实时模式：发送一个极小 .txt 文件验证 sendFile()',
    '  --check-history  实时模式：对观察到的会话执行 getHistory() 升序校验与 getMessage() 回环验证',
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

interface ContractChannelInstance extends Omit<Partial<ChannelAdapter>, 'idPatterns'> {
  adapter?: Partial<ChannelAdapter>;
  selfId?: string;
  selfChatId?: string;
  idPatterns?: ChannelIdPatterns | null;
  strictContract?: boolean;
  getHistory?: (chatId: string, opts?: { limit?: number }) => Promise<InboundEvent[]>;
  getMessage?: (chatId: string, msgId: string) => Promise<InboundEvent | null>;
}

export interface ChannelContractObservations {
  events: number;
  warnings: string[];
  historyChecked: boolean;
  echoMatched: boolean | null;
  idSamples: Array<{
    msgId: string;
    chatId: string;
    chatType: string;
    senderId: string;
    isSelf: boolean;
    quoteMsgId?: string;
    quoteSenderId?: string;
    mentionIds: string[];
  }>;
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
  observations?: ChannelContractObservations;
}

/** 对给定配置与通道插件执行静态契约验证，并在非 dry 模式下执行实时收发验收。 */
export async function runChannelContractTest(
  cfg: Partial<AppConfig> | RawConfig,
  {
    overrideUse = '',
    baseDir = APP_ROOT,
    dry = false,
    strict = false,
    waitSec = 10,
    waitExplicit = false,
    sendText = '',
    expectEvents = 1,
    checkFile = false,
    checkHistory = false,
    log = console.log,
  }: {
    overrideUse?: string;
    baseDir?: string;
    dry?: boolean;
    strict?: boolean;
    waitSec?: number;
    waitExplicit?: boolean;
    sendText?: string;
    expectEvents?: number;
    checkFile?: boolean;
    checkHistory?: boolean;
    log?: (msg: string) => void;
  } = {},
): Promise<ChannelContractTestResult> {
  const appCfg = cfg as AppConfig;
  const errors: string[] = [];
  const warnings: string[] = [];
  const observations: ChannelContractObservations = {
    events: 0,
    warnings: [],
    historyChecked: false,
    echoMatched: null,
    idSamples: [],
  };
  let loaded;
  try {
    loaded = await loadChannelPlugin(appCfg, { overrideUse, baseDir });
  } catch (e) {
    return {
      ok: false,
      channelName: overrideUse || appCfg?.channel?.use || 'sim',
      errors: [e instanceof Error ? e.message : String(e)],
      warnings,
      observations,
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

  const pushContractIssue = (msg: string): void => {
    observations.warnings.push(msg);
    if (strict) errors.push(msg);
    else warnings.push(msg);
  };

  const offContractWarn = kernel.on('channel:contract_warning', (payload) => {
    const rec = payload as { summary?: string } | null;
    if (rec?.summary) pushContractIssue(String(rec.summary));
  });

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
        observations,
      };
    }
    channel = kernel.get<ContractChannelInstance>('channel');
    const targetForValidation = (channel.adapter ?? channel) as Partial<ChannelAdapter>;
    const check = validateChannelAdapter(targetForValidation, channel.capabilities);
    errors.push(...check.errors);
    warnings.push(...check.warnings);

    const idPatterns = channel.idPatterns ?? channel.adapter?.idPatterns ?? null;
    if (idPatterns) {
      const cfgErrs = validateConfigIdsAgainstPatterns(
        {
          selfId: channel.selfId || String(loaded.options?.selfId ?? ''),
          selfChatId: channel.selfChatId || String(loaded.options?.selfChatId ?? ''),
          collaborators: appCfg?.chats?.collaborators,
          allowChatIds: appCfg?.chats?.allowChatIds,
          denyChatIds: appCfg?.chats?.denyChatIds,
        },
        idPatterns,
      );
      for (const err of cfgErrs) pushContractIssue(err);
    }

    log(`✓ 已加载通道插件「${loaded.resolvedName}」`);
    log(`  能力声明：${JSON.stringify(check.capabilities)}`);
    if (idPatterns) {
      log(`  ID 规范校验已启用：${Object.keys(idPatterns).join(', ')}`);
    }
    for (const w of warnings) log(`⚠ ${w}`);
    for (const e of errors) log(`✗ ${e}`);
    const loggedWarnings = warnings.length;
    const loggedErrors = errors.length;

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
        observations,
      };
    }

    const needCount = Math.max(1, Number(expectEvents) || 1);
    const observedChatIds = new Set<string>();
    const observedInboundTexts = new Map<string, string>();
    let gotInboundResolve: () => void = () => {};
    const gotInbound = new Promise<void>((r) => { gotInboundResolve = r; });

    await channel.start?.(async (rawEv: unknown) => {
      const ev = rawEv as Partial<InboundEvent> | null | undefined;
      observations.events += 1;
      const evCheck = validateInboundEvent(ev);
      if (!evCheck.ok) {
        errors.push(`入站事件不合规：${evCheck.errors.join('；')}`);
      } else {
        inboundValidated = true;
      }
      if (ev?.chat?.id) observedChatIds.add(String(ev.chat.id));
      if (ev?.id && ev?.text) observedInboundTexts.set(String(ev.id), String(ev.text));
      if (idPatterns && ev) {
        for (const err of validateIdsAgainstPatterns(ev, idPatterns)) {
          pushContractIssue(err);
        }
      }
      if (Array.isArray(ev?.mentions)) {
        for (const m of ev.mentions) {
          if (m?.idKind === 'name_fallback') {
            pushContractIssue(`mentions 中「@${m.name || m.id}」缺少真实用户 id，真实 IM 无法构造真 @提醒`);
          }
        }
      }
      const mentionIds = (ev?.mentions ?? []).map((m) => (m.isAll ? '__all__' : `${m.id}${m.idKind === 'name_fallback' ? '(fallback)' : ''}`));
      if (observations.idSamples.length < 10 && ev?.id && ev?.chat?.id) {
        observations.idSamples.push({
          msgId: String(ev.id),
          chatId: String(ev.chat.id),
          chatType: String(ev.chat.type || 'direct'),
          senderId: String(ev.sender?.id ?? ''),
          isSelf: Boolean(ev.sender?.isSelf),
          ...(ev.replyTo ? { quoteMsgId: String(ev.replyTo) } : {}),
          ...(ev.quote?.senderId ? { quoteSenderId: String(ev.quote.senderId) } : {}),
          mentionIds,
        });
      }
      const fwdTag = ev?.forwarded ? `bundle(${ev.forwarded.messages.length})` : (ev?.isForwarded ? 'single' : '-');
      const quoteTag = ev?.quote
        ? `${ev.quote.msgId}(by=${ev.quote.senderId || '?'})`
        : (ev?.replyTo || '-');
      log(`← 入站事件 #${observations.events} id=${ev?.id} chat=${ev?.chat?.type}:${ev?.chat?.id} sender=${ev?.sender?.id}(self=${ev?.sender?.isSelf}) quote=${quoteTag} dev=${ev?.device?.type || '-'} fwd=${fwdTag} mentions=${mentionIds.join(',') || '-'}`);
      if (ev?.chat?.type !== 'self') {
        log('  ⚠ 提示：该事件 chat.type !== "self"，请确认自聊会话映射规则');
      }
      if (!ev?.sender?.isSelf) {
        log('  ⚠ 提示：该事件 sender.isSelf === false，自聊触发器不会响应他人的消息');
      }
      if (observations.events >= needCount && ((!sendText && !checkFile) || channel.selfChatId)) {
        gotInboundResolve();
      }
    }, {});

    log(`✓ 通道已连接：${JSON.stringify(channel.status?.() ?? {})}`);
    const shouldWait = waitSec > 0 && (waitExplicit || (!sendText && !checkFile) || !channel.selfChatId);
    if (shouldWait) {
      log(`⏳ 等待最多 ${waitSec}s 接收至少 ${needCount} 条消息以验证入站字段${channel.selfChatId ? '' : '并学习 selfChatId'}…`);
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
        if (!sentMsgId || !String(sentMsgId).trim()) {
          pushContractIssue('send() 未返回非空 msgId，回声防环与引用路由将退化');
        } else {
          log(`→ send() 成功：msgId=${sentMsgId}`);
          const sidStr = String(sentMsgId);
          if (observedInboundTexts.has(sidStr)) {
            observations.echoMatched = true;
          } else {
            for (const [inId, inText] of observedInboundTexts) {
              if (inText === sendText && inId !== sidStr) {
                observations.echoMatched = false;
                pushContractIssue(`send() 返回 msgId=${sidStr} 与平台回推回声 msgId=${inId} 不一致`);
                break;
              }
            }
          }
        }
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

    if (checkHistory) {
      if (!check.capabilities.history || typeof channel.getHistory !== 'function') {
        log('ℹ 该通道未启用 history 能力，已跳过 getHistory()/getMessage() 校验');
      } else {
        const targetHistChat = [...observedChatIds][0] || channel.selfChatId || '';
        if (!targetHistChat) {
          pushContractIssue('无法确定用于校验 getHistory() 的会话 ID');
        } else {
          const hist = await channel.getHistory(targetHistChat, { limit: 5 });
          observations.historyChecked = true;
          log(`↺ getHistory(${targetHistChat}) 返回 ${hist.length} 条记录`);
          for (let i = 1; i < hist.length; i += 1) {
            if (hist[i].ts < hist[i - 1].ts) {
              pushContractIssue(`getHistory() 返回未按时间升序排列（index ${i - 1} ts=${hist[i - 1].ts} > index ${i} ts=${hist[i].ts}）`);
              break;
            }
          }
          if (hist.length > 0 && typeof channel.getMessage === 'function') {
            const sample = hist[hist.length - 1];
            const single = await channel.getMessage(targetHistChat, sample.id);
            if (!single || single.id !== sample.id) {
              pushContractIssue(`getMessage(${targetHistChat}, ${sample.id}) 未命中或返回 ID 不匹配`);
            } else {
              log(`↺ getMessage(${targetHistChat}, ${sample.id}) 校验通过`);
            }
          }
        }
      }
    }

    if (observations.idSamples.length > 0) {
      log('--- 字段映射核对表 ---');
      for (const s of observations.idSamples) {
        log(`  chat=${s.chatType}:${s.chatId} | msg=${s.msgId} | sender=${s.senderId}(isSelf=${s.isSelf}) | quote=${s.quoteMsgId || '-'}(by=${s.quoteSenderId || '-'}) | mentions=[${s.mentionIds.join(',')}]`);
      }
    }

    for (const w of warnings.slice(loggedWarnings)) log(`⚠ ${w}`);
    for (const e of errors.slice(loggedErrors)) log(`✗ ${e}`);
    return {
      ok: errors.length === 0,
      channelName: loaded.resolvedName,
      capabilities: check.capabilities,
      errors,
      warnings,
      inboundValidated,
      sentMsgId,
      sentFileId,
      observations,
    };
  } finally {
    offContractWarn();
    await kernel.stop();
  }
}

async function main(): Promise<void> {
  const { configFile, channelUse, waitSec, waitExplicit, sendText, expectEvents, dry, strict, checkFile, checkHistory, help } = parseArgs(process.argv.slice(2));
  if (help) {
    usage();
    return;
  }
  const cfg = loadConfig(process.argv.slice(2), configFile);
  const res = await runChannelContractTest(cfg, {
    overrideUse: channelUse,
    baseDir: channelUse ? process.cwd() : APP_ROOT,
    dry,
    strict,
    waitSec,
    waitExplicit,
    sendText,
    expectEvents,
    checkFile,
    checkHistory,
  });
  if (!res.ok) {
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
