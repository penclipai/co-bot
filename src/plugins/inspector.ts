import { clipSummary, normalizeCapabilities } from '../core/channel-contract.ts';
import { redactSecrets } from '../core/chat-context.ts';
import type { OpenMausBotBridge } from '../openmausbot/bridge.ts';
import type { BridgeTransport, ImContextService } from '../openmausbot/types.ts';
import type { KernelPlugin, PluginManagerService } from '../types.ts';
import type { WebServer } from '../web/server.ts';
import type { OpenMausBotService } from './openmausbot.ts';

const MAX_RECENT_EVENTS = 250;

interface InspectorEventEntry {
  ts: number;
  source: string;
  type: string;
  summary: string;
  chatId?: string;
  chatType?: string;
  kind?: string;
  botName?: string;
}

function sanitizeConfigSnapshot(cfg: unknown = {}): unknown {
  const redactSecret = (val: string): string => (val ? '[REDACTED]' : '');
  const clone: unknown = JSON.parse(JSON.stringify(cfg, (k, v: unknown) => {
    if (/^(token|secret|password|apikey|selfid|Authorization)$/i.test(k) && typeof v === 'string' && v) {
      return redactSecret(v);
    }
    if (typeof v === 'string') return redactSecrets(v);
    return v;
  }));
  return clone;
}

function runtimeSnapshot() {
  const mem = process.memoryUsage();
  return {
    pid: process.pid,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    uptimeSec: Math.round(process.uptime()),
    memoryRssMB: Math.round(mem.rss / 1048576),
    heapUsedMB: Math.round(mem.heapUsed / 1048576),
  };
}

/** 本地只读可观测性插件：统一提供 `/api/status`、`/api/debug/events` 与 `/debug` 实时诊断页面。 */
export const inspectorPlugin: KernelPlugin = {
  name: 'inspector',
  kind: 'observability',
  version: '1.0.0',
  inject: ['web', 'channel'],
  apply(ctx) {
    const cfg = ctx.config;
    const web = ctx.get<WebServer>('web');
    const channel = ctx.get<BridgeTransport>('channel');
    const events: InspectorEventEntry[] = [];

    const pushEvent = (source: string, type: string, payload: Record<string, unknown> = {}): void => {
      const entry: InspectorEventEntry = {
        ts: typeof payload.ts === 'number' ? payload.ts : Date.now(),
        source,
        type,
        summary: clipSummary(
          payload.summary
            ?? (payload.error ? `error=${String(payload.error)}` : null)
            ?? (payload.connected !== undefined ? `connected=${String(payload.connected)}` : null)
            ?? (payload.botName || payload.channel || ''),
          120,
        ),
        ...(payload.chatId ? { chatId: String(payload.chatId) } : {}),
        ...(payload.chatType ? { chatType: String(payload.chatType) } : {}),
        ...(payload.kind ? { kind: String(payload.kind) } : {}),
        ...(payload.botName ? { botName: String(payload.botName) } : {}),
      };
      events.push(entry);
      if (events.length > MAX_RECENT_EVENTS) events.shift();
    };

    ctx.on('channel:inbound', (p) => pushEvent('channel', 'inbound', (p ?? {}) as Record<string, unknown>));
    ctx.on('channel:outbound', (p) => pushEvent('channel', 'outbound', (p ?? {}) as Record<string, unknown>));
    ctx.on('channel:state', (p) => pushEvent('channel', 'state', (p ?? {}) as Record<string, unknown>));
    ctx.on('channel:notify', (p) => pushEvent('channel', 'notify', (p ?? {}) as Record<string, unknown>));
    ctx.on('bridge:event', (p) => {
      const rec = (p ?? {}) as Record<string, unknown>;
      pushEvent('bridge', typeof rec.type === 'string' ? rec.type : 'event', rec);
    });

    const channelSnapshot = () => {
      const st = channel.status?.() ?? null;
      const caps = normalizeCapabilities(channel.capabilities, channel);
      const kernelStatus = ctx.kernel.status();
      const chPlugin = kernelStatus.plugins.find((p) => p.kind === 'channel');
      return {
        name: st?.kind || chPlugin?.name || cfg.channel?.use || 'sim',
        capabilities: caps,
        status: st,
        plugins: kernelStatus.plugins,
      };
    };

    const buildStatusPayload = async () => {
      const ombSvc = ctx.has('openmausbot') ? ctx.get<OpenMausBotService>('openmausbot') : null;
      const bridge = ctx.has('bridge') ? ctx.get<OpenMausBotBridge>('bridge') : null;
      const imContext = ctx.has('imContext') ? ctx.get<ImContextService>('imContext') : null;
      const omb = ombSvc ? await ombSvc.probe() : null;
      const snap = channelSnapshot();
      return {
        ok: true,
        runtime: runtimeSnapshot(),
        trigger: cfg.selfChat?.trigger ?? '@bot',
        openmausbot: omb,
        im: snap.status,
        bridge: bridge?.status?.() ?? null,
        context: imContext?.stats?.() ?? null,
        chats: bridge?.listKnownChats?.() ?? [],
        chatPolicy: bridge?.getChatPolicy?.() ?? null,
        chatThreads: bridge?.listChatThreads?.() ?? [],
        boundProjects: bridge?.listProjectBindings?.() ?? [],
        sharedContext: bridge?.getSharedContextStatus?.() ?? null,
        delegations: bridge?.delegations?.stats?.() ?? null,
        channel: {
          name: snap.name,
          capabilities: snap.capabilities,
          status: snap.status,
        },
        plugins: snap.plugins,
        recentEventsCount: events.length,
      };
    };

    web.route('GET', '/api/status', () => buildStatusPayload());

    web.route('GET', '/api/debug/bundle', async ({ url, res }) => {
      const payload = {
        generatedAt: new Date().toISOString(),
        runtime: runtimeSnapshot(),
        sanitizedConfig: sanitizeConfigSnapshot(cfg),
        status: await buildStatusPayload(),
        events: [...events].reverse(),
      };
      if (url?.searchParams?.get('download') === '1') {
        const body = `${JSON.stringify(payload, null, 2)}\n`;
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body),
          'content-disposition': `attachment; filename="co-bot-diag-${Date.now()}.json"`,
          'cache-control': 'no-store',
        });
        res.end(res.req?.method === 'HEAD' ? undefined : body);
        return;
      }
      return payload;
    });

    web.route('POST', '/api/debug/action', async ({ body }) => {
      const action = String(body?.action || '').trim();
      if (action === 'reload_plugin') {
        const mgr = ctx.has('pluginManager') ? ctx.get<PluginManagerService>('pluginManager') : null;
        if (!mgr) {
          const err = new Error('当前实例未启用插件热重载管理器') as Error & { status?: number };
          err.status = 503;
          throw err;
        }
        const name = String(body?.name || '').trim();
        if (!name) throw new Error('缺少插件名 name');
        const plugin = await mgr.reloadPlugin(name);
        return { ok: true, action, name, plugin, plugins: ctx.kernel.status().plugins };
      }

      const bridge = ctx.has('bridge') ? ctx.get<OpenMausBotBridge>('bridge') : null;
      if (!bridge) {
        const err = new Error('bridge 尚未就绪') as Error & { status?: number };
        err.status = 503;
        throw err;
      }
      if (action === 'chat_mute' || action === 'chat_allow') {
        const chatId = String(body?.chatId || '').trim();
        if (!chatId) throw new Error('缺少 chatId');
        if (action === 'chat_mute') {
          if (chatId === 'self' || chatId === bridge.selfChat) {
            throw new Error('不能静音自聊控制会话');
          }
          bridge.setChatMuted(chatId, true);
        } else {
          bridge.setChatAllowed(chatId);
        }
        return { ok: true, action, chatId, chatPolicy: bridge.getChatPolicy() };
      }
      if (action === 'chat_mode') {
        const mode = String(body?.mode || '').trim();
        if (mode === 'reset') bridge.resetChatPolicy();
        else if (mode === 'self_only' || mode === 'owner_everywhere') bridge.setChatMode(mode);
        else throw new Error(`无效模式：${mode}`);
        return { ok: true, action, chatPolicy: bridge.getChatPolicy() };
      }
      if (action === 'flush_outbound') {
        const replayed = await bridge.flushOutboundBuffer();
        return { ok: true, action, replayed };
      }
      throw new Error(`未知操作：${action}`);
    });

    web.route('GET', '/api/debug/events', ({ url }) => {
      const snap = channelSnapshot();
      const chatFilter = String(url?.searchParams?.get('chatId') || '').trim();
      const sourceFilter = String(url?.searchParams?.get('source') || '').trim();
      const typeFilter = String(url?.searchParams?.get('type') || '').trim();
      const rawLim = url?.searchParams?.get('limit');
      const parsedLim = rawLim != null && /^\d+$/.test(String(rawLim).trim()) ? Number(rawLim) : 0;
      const limit = parsedLim > 0 ? Math.min(MAX_RECENT_EVENTS, parsedLim) : 0;
      let list = [...events].reverse();
      if (chatFilter) list = list.filter((e) => e.chatId === chatFilter);
      if (sourceFilter) list = list.filter((e) => e.source === sourceFilter);
      if (typeFilter) list = list.filter((e) => e.type === typeFilter);
      if (limit > 0) list = list.slice(0, limit);
      return {
        ok: true,
        ts: Date.now(),
        filter: {
          chatId: chatFilter || null,
          source: sourceFilter || null,
          type: typeFilter || null,
          ...(limit > 0 ? { limit } : {}),
        },
        channel: { name: snap.name, capabilities: snap.capabilities, status: snap.status },
        plugins: snap.plugins,
        events: list,
      };
    });

    web.page('/debug', 'debug.html');
    if (!web.hasRoute('GET', '/')) {
      web.page('/', 'debug.html');
    }

    ctx.status(() => ({ recentEvents: events.length }));
  },
};
