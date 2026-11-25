import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rotateLogIfNeeded } from '../scripts/omb.ts';
import { loadConfig, validateConfig } from './config.ts';
import { Kernel } from './core/kernel.ts';
import { createPluginManager, discoverPlugins, resolvePluginConfig } from './core/plugin-loader.ts';
import { loadChannelPlugin } from './plugins/channel-loader.ts';
import { extensionsPlugin } from './plugins/extensions.ts';
import { imContextPlugin } from './plugins/im-context.ts';
import { inspectorPlugin } from './plugins/inspector.ts';
import { openmausbotPlugin, type OpenMausBotService } from './plugins/openmausbot.ts';
import { webPlugin } from './plugins/web.ts';
import type { AppConfig, KernelPlugin } from './types.ts';

const MANAGED_LOG_FILES = ['cobot.log', 'cobot.err.log', 'openmausbot.log', 'openmausbot.err.log'];
const LOG_ROTATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

function rotateManagedLogs(dataDir: string): void {
  for (const name of MANAGED_LOG_FILES) {
    rotateLogIfNeeded(path.join(dataDir, name), 10 * 1024 * 1024, { copyTruncate: true });
  }
}

/** 装配 co-bot 插件内核（extensions -> web -> IM channel -> im-context -> openmausbot -> plugin-manager -> inspector -> plugins/ 扩展）。 */
export async function createApp(
  cfg: AppConfig,
  { ensureOmb = false, channelOverride = '' }: { ensureOmb?: boolean; channelOverride?: string } = {},
): Promise<{ kernel: Kernel; channelName: string }> {
  const kernel = new Kernel({ config: cfg });
  const discovered = cfg.pluginsDir ? await discoverPlugins(cfg.pluginsDir) : null;
  if (cfg.pluginsStrict && discovered?.errors.length) {
    const details = discovered.errors.map((e) => `${e.source}: ${e.error}`).join('；');
    throw new Error(`plugins 目录加载失败：${details}`);
  }

  const resolved = await loadChannelPlugin(cfg, { overrideUse: channelOverride, discovered });
  const pluginManagerPlugin: KernelPlugin = {
    name: 'plugin-manager',
    kind: 'core',
    version: '1.0.0',
    source: 'builtin',
    provides: ['pluginManager'],
    apply(ctx) {
      ctx.provide('pluginManager', createPluginManager(kernel, cfg));
    },
  };

  kernel.use(extensionsPlugin);
  kernel.use(webPlugin);
  kernel.use(resolved.plugin, resolved.options);
  kernel.use(imContextPlugin);
  kernel.use(openmausbotPlugin, { ensureOmb });
  kernel.use(pluginManagerPlugin);
  kernel.use(inspectorPlugin);

  const builtinNames = new Set(kernel.entries.map((e) => e.name));
  if (discovered) {
    for (const errRec of discovered.errors) {
      kernel.recordLoadError(errRec);
    }
    for (const rec of discovered.extensions) {
      if (builtinNames.has(rec.name)) {
        throw new Error(`外部插件「${rec.name}」（${rec.source}）与内置插件重名`);
      }
      const pCfg = resolvePluginConfig(cfg, rec.name);
      if (!pCfg.enabled) continue;
      kernel.use({
        ...rec.plugin,
        source: rec.source,
        isolated: !cfg.pluginsStrict,
      }, pCfg.options);
    }
  }

  return { kernel, channelName: resolved.resolvedName };
}

/**
 * co-bot 入口：基于插件微内核装配 Web、IM 通道、OpenMausBot 网关与本地只读诊断台。
 */
async function main(): Promise<void> {
  const cfgPath = fs.existsSync('config.json') ? 'config.json' : null;
  if (cfgPath) {
    try {
      const v = validateConfig(JSON.parse(fs.readFileSync(cfgPath, 'utf8')));
      for (const w of v.warnings) console.warn(`[co-bot:config] ⚠ ${w}`);
      for (const e of v.errors) console.error(`[co-bot:config] ✗ ${e}`);
    } catch (e) {
      console.error(`[co-bot:config] ✗ 解析 ${cfgPath} 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const cfg = loadConfig();
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  rotateManagedLogs(cfg.dataDir);
  const logRotateTimer = setInterval(() => rotateManagedLogs(cfg.dataDir), LOG_ROTATE_INTERVAL_MS);
  logRotateTimer.unref?.();

  process.on('unhandledRejection', (reason) => {
    console.error('[co-bot] unhandledRejection:', reason instanceof Error ? (reason.stack || reason.message) : reason);
  });
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    console.error(`[co-bot] ${origin}:`, err?.stack || err?.message || err);
  });

  const ensureOmb = process.argv.includes('--ensure-omb');
  const { kernel, channelName } = await createApp(cfg, { ensureOmb });
  await kernel.start();

  const ombSvc = kernel.get<OpenMausBotService>('openmausbot');
  const probe = ombSvc.startupProbe;
  console.log(`[co-bot] channel=${channelName} trigger=${cfg.selfChat.trigger} -> OpenMausBot=${cfg.openmausbot.url}`);
  if (probe) {
    if (probe.authErr) {
      console.warn(`[co-bot] OpenMausBot Token 已失效或被撤销（${probe.authErr.status}），请重新运行：npm run pair`);
    } else {
      const chief = probe.visible.find((b) => b.chiefOfStaff) ?? probe.visible[0];
      console.log(`[co-bot] 已连接 OpenMausBot v${probe.health.version ?? '?'}（${probe.visible.length} 个可见 Bot，主 Bot：${chief?.name ?? '无'}）`);
      if (probe.desktopManaged && !probe.paired) {
        console.warn('[co-bot] 检测到 OpenMausBot 桌面端模式且未配对，发送消息会被 403 拒绝。请运行：npm run pair（桌面端一键允许）或 npm run pair -- <12位配对码>');
      }
    }
  }
  const baseUrl = `http://${cfg.web.host}:${cfg.web.port}`;
  if (channelName === 'sim') {
    console.log(`[co-bot] 自聊模拟 ${baseUrl}/sim （诊断台 ${baseUrl}/debug）`);
  } else {
    console.log(`[co-bot] 本地诊断台 ${baseUrl}/debug`);
  }

  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(logRotateTimer);
      await kernel.stop();
      process.exit(0);
    });
  }
}

const isDirect = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((e: unknown) => {
    const err = e as Error | null | undefined;
    console.error('[co-bot]', err?.stack || err?.message || e);
    process.exit(1);
  });
}
