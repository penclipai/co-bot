import { ensureOpenMausBot, isLoopbackUrl } from '../../scripts/omb.ts';
import { clipSummary } from '../core/channel-contract.ts';
import { OpenMausBotBridge } from '../openmausbot/bridge.ts';
import { OpenMausBotClient } from '../openmausbot/client.ts';
import type { BridgeTransport, ImContextService, OmbAuthSession, OmbBot, OmbGroup, OmbHealth, OmbHttpError } from '../openmausbot/types.ts';
import type { KernelPlugin } from '../types.ts';

export interface ProbeOpenMausBotResult {
  health: OmbHealth;
  visible: OmbBot[];
  visibleGroups: OmbGroup[];
  desktopManaged: boolean;
  paired: boolean;
  sessionLabel: string | null;
  authErr: OmbHttpError | null;
  botsErr?: OmbHttpError;
  session?: OmbAuthSession;
}

export interface OpenMausBotService {
  client: OpenMausBotClient;
  startupProbe: ProbeOpenMausBotResult | null;
  probe: () => Promise<Record<string, unknown>>;
}

export interface OpenMausBotPluginOptions {
  ensureOmb?: boolean;
  client?: OpenMausBotClient;
  execGit?: ((dir: string, timeoutMs: number) => Promise<string>) | null;
  autoHealOmb?: (() => unknown) | null;
}

/** 探测 OpenMausBot 服务、可见 Bot / 协作群组及认证配对状态。 */
export async function probeOpenMausBot(client: OpenMausBotClient): Promise<ProbeOpenMausBotResult> {
  const health = await client.health();
  const [botsRes, env, sess] = await Promise.all([
    client.listBots().catch((e: OmbHttpError) => ({ bots: [] as OmbBot[], groups: [] as OmbGroup[], _error: e })),
    client.environment().catch(() => null),
    client.authSession().catch((e: OmbHttpError) => ({ _error: e } as OmbAuthSession & { _error?: OmbHttpError })),
  ]);
  const botsErr = '_error' in botsRes ? botsRes._error : undefined;
  const sessErr = '_error' in sess ? (sess as { _error?: OmbHttpError })._error : undefined;
  const authErr = [botsErr, sessErr].find((e) => e?.status === 401 || e?.status === 403) ?? null;
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
    ...(botsErr ? { botsErr } : {}),
    ...(sess && !sessErr ? { session: sess } : {}),
  };
}

/** OpenMausBot Gateway 插件：将 `channel` 服务接入 OpenMausBot 客户端与对话桥接器。 */
export const openmausbotPlugin: KernelPlugin<OpenMausBotPluginOptions> = {
  name: 'openmausbot',
  kind: 'agent',
  version: '1.0.0',
  inject: ['channel'],
  provides: ['openmausbot', 'bridge'],
  async apply(ctx, opts = {}) {
    const cfg = ctx.config;
    const ombCfg = cfg.openmausbot;
    const channel = ctx.get<BridgeTransport>('channel');
    const logger = ctx.logger ?? console;

    if (opts.ensureOmb && ombCfg.autoStart !== false && isLoopbackUrl(ombCfg.url)) {
      try {
        await ensureOpenMausBot(cfg);
      } catch (e) {
        logger.warn?.(`[co-bot] 自动拉起 OpenMausBot 失败：${e instanceof Error ? e.message : e}（继续启动并自动重连 SSE）`);
      }
    }

    const client = opts.client ?? new OpenMausBotClient({
      baseUrl: ombCfg.url,
      timeoutMs: ombCfg.timeoutMs,
      token: ombCfg.token,
    });

    let startupProbe: ProbeOpenMausBotResult | null = null;
    try {
      startupProbe = await probeOpenMausBot(client);
    } catch (e) {
      logger.warn?.(`[co-bot] 暂未连上 OpenMausBot (${cfg.openmausbot.url}): ${e instanceof Error ? e.message : e}（启动后会继续自动重连 SSE）`);
    }

    const imContext = ctx.has('imContext') ? ctx.get<ImContextService>('imContext') : null;
    const brandName = String(cfg.selfChat?.botName || 'co-bot').trim() || 'co-bot';
    const bridge = new OpenMausBotBridge({
      client,
      transport: channel,
      dataDir: cfg.dataDir,
      imContext,
      chats: cfg.chats,
      projects: cfg.projects,
      sharedContextDir: cfg.sharedContextDir,
      sharedContextPullIntervalMs: cfg.sharedContextPullIntervalMs,
      execGit: opts.execGit ?? null,
      syncChiefIdentity: ombCfg.syncChiefIdentity !== false,
      autoHealOmb: opts.autoHealOmb !== undefined
        ? opts.autoHealOmb
        : ((ombCfg.autoStart !== false && isLoopbackUrl(ombCfg.url))
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
      if ((p as { connected?: boolean } | null)?.connected) bridge.flushOutboundBuffer().catch(() => {});
    });
    ctx.effect(() => offChanState());
    ctx.effect(() => bridge.stop());

    const ombService: OpenMausBotService = {
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
            doctor: p.health?.doctor ?? null,
            ...(p.authErr ? { authError: p.authErr.message } : {}),
            bots: p.visible.map((x) => ({
              id: x.id,
              name: x.name,
              displayName: x.chiefOfStaff ? brandName : (/^(open)?mausbot$/i.test(String(x.name || '').trim()) ? brandName : x.name),
              chiefOfStaff: !!x.chiefOfStaff,
              busy: !!x.busy,
              activity: x.activity ?? 'idle',
              replyStyle: x.replyStyle ?? 'default',
              approvalMode: x.approvalMode ?? 'ask',
              waitingForTeammates: Boolean(x.waitingForTeammates),
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
          return { ok: false, url: cfg.openmausbot.url, error: e instanceof Error ? e.message : String(e) };
        }
      },
    };

    ctx.provide('openmausbot', ombService);
    ctx.provide('bridge', bridge);
    ctx.status(() => bridge.status());
  },
};
