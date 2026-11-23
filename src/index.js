import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateConfig } from './config.js';
import { Kernel } from './core/kernel.js';
import { webPlugin } from './plugins/web.js';
import { loadChannelPlugin } from './plugins/channel-loader.js';
import { imContextPlugin } from './plugins/im-context.js';
import { openmausbotPlugin } from './plugins/openmausbot.js';
import { inspectorPlugin } from './plugins/inspector.js';
import { rotateLogIfNeeded } from '../scripts/omb.js';

const MANAGED_LOG_FILES = ['cobot.log', 'cobot.err.log', 'openmausbot.log', 'openmausbot.err.log'];
const LOG_ROTATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

function rotateManagedLogs(dataDir) {
  for (const name of MANAGED_LOG_FILES) {
    rotateLogIfNeeded(path.join(dataDir, name), 10 * 1024 * 1024, { copyTruncate: true });
  }
}

/** 装配 co-bot 插件内核（web -> IM channel -> openmausbot -> inspector）。 */
export async function createApp(cfg, { ensureOmb = false, channelOverride = '' } = {}) {
  const kernel = new Kernel({ config: cfg });
  const resolved = await loadChannelPlugin(cfg, { overrideUse: channelOverride });
  kernel.use(webPlugin);
  kernel.use(resolved.plugin, resolved.options);
  kernel.use(imContextPlugin);
  kernel.use(openmausbotPlugin, { ensureOmb });
  kernel.use(inspectorPlugin);
  return { kernel, channelName: resolved.resolvedName };
}

/**
 * co-bot 入口：基于插件微内核装配 Web、IM 通道、OpenMausBot 网关与本地只读诊断台。
 */
async function main() {
  const cfgPath = fs.existsSync('config.json') ? 'config.json' : null;
  if (cfgPath) {
    try {
      const v = validateConfig(JSON.parse(fs.readFileSync(cfgPath, 'utf8')));
      for (const w of v.warnings) console.warn(`[co-bot:config] ⚠ ${w}`);
      for (const e of v.errors) console.error(`[co-bot:config] ✗ ${e}`);
    } catch (e) {
      console.error(`[co-bot:config] ✗ 解析 ${cfgPath} 失败：${e.message}`);
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

  const ombSvc = kernel.get('openmausbot');
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
  for (const sig of ['SIGINT', 'SIGTERM']) {
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
  main().catch((e) => {
    console.error('[co-bot]', e.stack || e.message);
    process.exit(1);
  });
}
