import { ensureOpenMausBot, isLoopbackUrl } from '../../scripts/omb.js';
import { clipSummary } from '../core/channel-contract.js';
import { OpenMausBotBridge } from '../openmausbot/bridge.js';
import { OpenMausBotClient } from '../openmausbot/client.js';

/** 探测 OpenMausBot 服务、可见 Bot / 协作群组及认证配对状态。 */
export async function probeOpenMausBot(client) {
  const health = await client.health();
  const [botsRes, env, sess] = await Promise.all([
    client.listBots().catch((e) => ({ _error: e })),
    client.environment().catch(() => null),
    client.authSession().catch((e) => ({ _error: e })),
  ]);
  const authErr = [botsRes?._error, sess?._error].find((e) => e?.status === 401 || e?.status === 403) ?? null;
  const bots = Array.isArray(botsRes?.bots) ? botsRes.bots : [];
  const groups = Array.isArray(botsRes?.groups) ? botsRes.groups : [];
  const visible = bots.filter((b) => !b.hidden);
  const visibleGroups = groups.filter((g) => !g.hidden && !g.dm);
  const desktopManaged = env?.capabilities?.selfUpdate === 'desktop-managed';
  const paired = !authErr && sess?.kind === 'session';
  return {
    health,
    visible,
    visibleGroups,
    desktopManaged,
    paired,
    sessionLabel: paired ? (sess?.label ?? null) : null,
    authErr,
    ...(botsRes?._error ? { botsErr: botsRes._error } : {}),
    ...(sess && !sess._error ? { session: sess } : {}),
  };
}

/** OpenMausBot Gateway 插件：将 `channel` 服务接入 OpenMausBot 客户端与对话桥接器。 */
export const openmausbotPlugin = {
  name: 'openmausbot',
  kind: 'agent',
  version: '1.0.0',
  inject: ['channel'],
  provides: ['openmausbot', 'bridge'],
  async apply(ctx, opts = {}) {
    const cfg = ctx.config;
    const channel = ctx.get('channel');
    const logger = ctx.logger ?? console;

    if (opts.ensureOmb && cfg.openmausbot.autoStart !== false && isLoopbackUrl(cfg.openmausbot.url)) {
      try {
        await ensureOpenMausBot(cfg);
      } catch (e) {
        logger.warn?.(`[co-bot] 自动拉起 OpenMausBot 失败：${e.message}（继续启动并自动重连 SSE）`);
      }
    }

    const client = opts.client ?? new OpenMausBotClient({
      baseUrl: cfg.openmausbot.url,
      timeoutMs: cfg.openmausbot.timeoutMs,
      token: cfg.openmausbot.token,
    });

    let startupProbe = null;
    try {
      startupProbe = await probeOpenMausBot(client);
    } catch (e) {
      logger.warn?.(`[co-bot] 暂未连上 OpenMausBot (${cfg.openmausbot.url}): ${e.message}（启动后会继续自动重连 SSE）`);
    }

    const imContext = ctx.has('imContext') ? ctx.get('imContext') : null;
    const bridge = new OpenMausBotBridge({
      client,
      transport: channel,
      dataDir: cfg.dataDir,
      imContext,
      chats: cfg.chats,
      autoHealOmb: opts.autoHealOmb !== undefined
        ? opts.autoHealOmb
        : ((cfg.openmausbot.autoStart !== false && isLoopbackUrl(cfg.openmausbot.url))
          ? () => ensureOpenMausBot(cfg)
          : null),
      onTelemetry: (ev) => ctx.emit('bridge:event', {
        ...ev,
        ...(ev?.summary ? { summary: clipSummary(ev.summary) } : {}),
      }),
      ...cfg.selfChat,
    });

    await bridge.start();
    const offChanState = ctx.on('channel:state', (p) => {
      if (p?.connected) bridge.flushOutboundBuffer().catch(() => {});
    });
    ctx.effect(() => offChanState());
    ctx.effect(() => bridge.stop());

    const ombService = {
      client,
      startupProbe,
      async probe() {
        try {
          const p = await probeOpenMausBot(client);
          return {
            ok: true,
            url: cfg.openmausbot.url,
            version: p.health.version ?? null,
            box: p.health.box ?? 'off',
            desktopManaged: p.desktopManaged,
            paired: p.paired,
            sessionLabel: p.sessionLabel,
            ...(p.authErr ? { authError: p.authErr.message } : {}),
            bots: p.visible.map((x) => ({
              id: x.id,
              name: x.name,
              chiefOfStaff: !!x.chiefOfStaff,
              busy: !!x.busy,
              activity: x.activity ?? 'idle',
              replyStyle: x.replyStyle ?? 'default',
              model: x.modelSelection?.model ?? '',
            })),
            groups: p.visibleGroups.map((g) => ({
              id: g.id,
              name: g.name,
              members: Array.isArray(g.memberIds) ? g.memberIds.length : 0,
              busy: !!g.busy,
            })),
          };
        } catch (e) {
          return { ok: false, url: cfg.openmausbot.url, error: e.message };
        }
      },
    };

    ctx.provide('openmausbot', ombService);
    ctx.provide('bridge', bridge);
    ctx.status(() => bridge.status());
  },
};
