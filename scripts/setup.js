#!/usr/bin/env node
/**
 * co-bot 交互式初始化向导（零依赖）：
 *   npm run setup
 *   node scripts/setup.js --non-interactive --mode plugin --config ./config.json --self-id u_123
 */
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { APP_ROOT, defaults, validateConfig } from '../src/config.js';
import { writeJsonAtomic } from '../src/format.js';

function parseArgs(argv) {
  const opts = {
    nonInteractive: false,
    mode: '',
    configPath: '',
    pluginOut: '',
    selfId: '',
    selfChatId: '',
    trigger: '',
    port: '',
    ombUrl: '',
    ombToken: '',
    force: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--non-interactive' || a === '-y') { opts.nonInteractive = true; continue; }
    if (a === '--force') { opts.force = true; continue; }
    if (a === '--mode' && argv[i + 1]) { opts.mode = String(argv[++i]).trim().toLowerCase(); continue; }
    if (a === '--config' && argv[i + 1]) { opts.configPath = String(argv[++i]); continue; }
    if (a === '--plugin-out' && argv[i + 1]) { opts.pluginOut = String(argv[++i]); continue; }
    if (a === '--self-id' && argv[i + 1]) { opts.selfId = String(argv[++i]); continue; }
    if (a === '--self-chat-id' && argv[i + 1]) { opts.selfChatId = String(argv[++i]); continue; }
    if (a === '--trigger' && argv[i + 1]) { opts.trigger = String(argv[++i]); continue; }
    if (a === '--port' && argv[i + 1]) { opts.port = String(argv[++i]); continue; }
    if (a === '--omb' && argv[i + 1]) { opts.ombUrl = String(argv[++i]); continue; }
    if (a === '--omb-token' && argv[i + 1]) { opts.ombToken = String(argv[++i]); continue; }
  }
  return opts;
}

function usage() {
  console.log([
    '用法：npm run setup [-- [选项]]',
    '  --non-interactive   跳过交互问答，使用传入参数与默认值直接生成配置',
    '  --mode <m>          通道模式：sim（默认模拟器）| plugin（推荐真实 IM 插件）| ipc（旧版 IPC 客户端）',
    '  --config <path>     目标配置文件路径（默认 ./config.json）',
    '  --plugin-out <path> plugin/ipc 模式复制模板的目标路径',
    '  --self-id <id>      你在真实 IM 中的账号 ID（plugin / ipc 模式需要）',
    '  --self-chat-id <id> 可选自聊会话 ID（留空将在首条自聊后自动学习）',
    '  --trigger <word>    触发词（默认 @bot）',
    '  --port <port>       本地 Web 诊断/模拟器端口（默认 8787）',
    '  --omb <url>         OpenMausBot 地址（默认 http://127.0.0.1:8799）',
    '  --force             覆盖已有 config.json 且不留备份',
  ].join('\n'));
}

function copyTemplateIfMissing(exampleName, targetAbsPath) {
  if (fs.existsSync(targetAbsPath)) return { copied: false, targetAbsPath };
  const src = path.join(APP_ROOT, exampleName);
  if (!fs.existsSync(src)) throw new Error(`缺少模板文件：${src}`);
  fs.mkdirSync(path.dirname(targetAbsPath), { recursive: true });
  fs.copyFileSync(src, targetAbsPath);
  return { copied: true, targetAbsPath };
}

/** 生成或更新 config.json 与可选通道插件模板（可由 CLI 或测试直接调用）。 */
export async function runSetup(options = {}) {
  const nonInteractive = Boolean(options.nonInteractive);
  const log = options.log ?? console.log;
  const targetConfig = path.resolve(options.baseDir || process.cwd(), options.configPath || 'config.json');
  const configDir = path.dirname(targetConfig);

  let existing = {};
  const hadExisting = fs.existsSync(targetConfig);
  if (hadExisting) {
    try {
      existing = JSON.parse(fs.readFileSync(targetConfig, 'utf8'));
    } catch {
      existing = {};
    }
  }

  let mode = options.mode || (existing.channel?.use ? 'plugin' : (existing.transport === 'ipc' ? 'ipc' : 'sim'));
  let ombUrl = options.ombUrl || existing.openmausbot?.url || defaults.openmausbot.url;
  let webPort = options.port ? Number(options.port) : (existing.web?.port ?? defaults.web.port);
  let trigger = options.trigger || existing.selfChat?.trigger || defaults.selfChat.trigger;
  let selfId = options.selfId ?? existing.channel?.options?.selfId ?? existing.ipc?.selfId ?? '';
  let selfChatId = options.selfChatId ?? existing.channel?.options?.selfChatId ?? existing.ipc?.selfChatId ?? '';
  let pluginOut = options.pluginOut || '';

  if (!nonInteractive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const ask = async (label, fallback = '') => {
        const suffix = fallback !== '' ? ` [${fallback}]` : '';
        const ans = (await rl.question(`${label}${suffix}: `)).trim();
        return ans || String(fallback);
      };
      const rawMode = await ask('1) 选择接入方式 (sim=Web模拟器, plugin=通用IM插件[推荐], ipc=旧版IPC)', mode);
      mode = ['sim', 'plugin', 'ipc'].includes(rawMode.toLowerCase()) ? rawMode.toLowerCase() : 'sim';
      ombUrl = await ask('2) OpenMausBot 服务地址', ombUrl);
      webPort = Number(await ask('3) 本地 /sim 与 /debug 端口', webPort)) || defaults.web.port;
      trigger = await ask('4) 对话触发词', trigger);
      if (mode !== 'sim') {
        selfId = await ask('5) 你在 IM 中的用户 ID (selfId)', selfId);
        selfChatId = await ask('6) 自聊会话 ID (可选，留空首次自聊自动学习)', selfChatId);
        const defSpec = mode === 'plugin' ? './im-plugin.js' : './ipc-client.js';
        pluginOut = await ask(`7) ${mode === 'plugin' ? '通道插件' : 'IPC 客户端'}文件路径`, pluginOut || defSpec);
      }
    } finally {
      rl.close();
    }
  }

  if (!['sim', 'plugin', 'ipc'].includes(mode)) {
    throw new Error(`不支持的接入模式「${mode}」，可选：sim | plugin | ipc`);
  }

  const nextConfig = {
    openmausbot: {
      ...defaults.openmausbot,
      ...(existing.openmausbot ?? {}),
      url: ombUrl,
      token: options.ombToken || existing.openmausbot?.token || '',
    },
    transport: mode === 'ipc' ? 'ipc' : 'sim',
    channel: {
      use: '',
      options: {},
    },
    ipc: {
      ...defaults.ipc,
      ...(existing.ipc ?? {}),
    },
    web: {
      ...defaults.web,
      ...(existing.web ?? {}),
      port: Number(webPort),
    },
    selfChat: {
      ...defaults.selfChat,
      ...(existing.selfChat ?? {}),
      trigger,
    },
    chats: {
      ...defaults.chats,
      ...(existing.chats ?? {}),
    },
    dataDir: existing.dataDir || './data',
  };

  let scaffold = null;
  if (mode === 'plugin') {
    const spec = pluginOut || existing.channel?.use || './im-plugin.js';
    const absPlugin = path.isAbsolute(spec) ? spec : path.resolve(configDir, spec);
    scaffold = copyTemplateIfMissing('im-plugin.example.js', absPlugin);
    nextConfig.channel = {
      use: spec,
      options: {
        ...(existing.channel?.options ?? {}),
        selfId,
        selfChatId,
      },
    };
  } else if (mode === 'ipc') {
    const spec = pluginOut || existing.ipc?.client || './ipc-client.js';
    const absClient = path.isAbsolute(spec) ? spec : path.resolve(configDir, spec);
    scaffold = copyTemplateIfMissing('ipc-client.example.js', absClient);
    nextConfig.ipc = {
      ...nextConfig.ipc,
      client: spec,
      selfId,
      selfChatId,
    };
  }

  const validation = validateConfig(nextConfig);
  if (!validation.ok) {
    throw new Error(`配置校验未通过：${validation.errors.join('；')}`);
  }

  let backupPath = null;
  if (hadExisting && !options.force) {
    backupPath = `${targetConfig}.bak.${Date.now()}`;
    fs.copyFileSync(targetConfig, backupPath);
  }
  writeJsonAtomic(targetConfig, nextConfig, { pretty: true });

  log(`✓ 已写入配置文件：${targetConfig}${backupPath ? `（原配置已备份至 ${path.basename(backupPath)}）` : ''}`);
  if (scaffold) {
    log(`${scaffold.copied ? '✓ 已生成通道模板' : 'ℹ 沿用已有通道文件'}：${scaffold.targetAbsPath}`);
  }
  for (const w of validation.warnings) log(`⚠ ${w}`);
  log('下一步建议：');
  log('  1. npm run check');
  log('  2. npm run channel:test -- --dry');
  log('  3. npm run daemon');

  return { configPath: targetConfig, backupPath, scaffold, config: nextConfig, validation };
}

const isDirect = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
  } else {
    runSetup(opts).catch((e) => {
      console.error(`✗ setup 失败：${e.message}`);
      process.exitCode = 1;
    });
  }
}
