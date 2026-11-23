import { clipSummary, normalizeCapabilities } from '../core/channel-contract.js';

const MAX_RECENT_EVENTS = 80;

/** 本地只读可观测性插件：统一提供 `/api/status`、`/api/debug/events` 与 `/debug` 实时诊断页面。 */
export const inspectorPlugin = {
  name: 'inspector',
  kind: 'observability',
  version: '1.0.0',
  inject: ['web', 'channel'],
  apply(ctx) {
    const cfg = ctx.config;
    const web = ctx.get('web');
    const channel = ctx.get('channel');
    const events = [];

    const pushEvent = (source, type, payload = {}) => {
      const entry = {
        ts: payload.ts || Date.now(),
        source,
        type,
        summary: clipSummary(
          payload.summary
            ?? (payload.error ? `error=${payload.error}` : null)
            ?? (payload.connected !== undefined ? `connected=${payload.connected}` : null)
            ?? (payload.botName || payload.channel || ''),
          120,
        ),
        ...(payload.chatId ? { chatId: String(payload.chatId) } : {}),
        ...(payload.chatType ? { chatType: payload.chatType } : {}),
        ...(payload.kind ? { kind: payload.kind } : {}),
        ...(payload.botName ? { botName: payload.botName } : {}),
      };
      events.push(entry);
      if (events.length > MAX_RECENT_EVENTS) events.shift();
    };

    ctx.on('channel:inbound', (p) => pushEvent('channel', 'inbound', p));
    ctx.on('channel:outbound', (p) => pushEvent('channel', 'outbound', p));
    ctx.on('channel:state', (p) => pushEvent('channel', 'state', p));
    ctx.on('bridge:event', (p) => pushEvent('bridge', p?.type || 'event', p));

    const channelSnapshot = () => {
      const st = channel.status?.() ?? null;
      const caps = normalizeCapabilities(channel.capabilities, channel);
      const kernelStatus = ctx.kernel.status();
      const chPlugin = kernelStatus.plugins.find((p) => p.kind === 'channel');
      return {
        name: st?.kind || chPlugin?.name || cfg.channel?.use || cfg.transport,
        capabilities: caps,
        status: st,
        plugins: kernelStatus.plugins,
      };
    };

    web.route('GET', '/api/status', async () => {
      const ombSvc = ctx.has('openmausbot') ? ctx.get('openmausbot') : null;
      const bridge = ctx.has('bridge') ? ctx.get('bridge') : null;
      const imContext = ctx.has('imContext') ? ctx.get('imContext') : null;
      const omb = ombSvc ? await ombSvc.probe() : null;
      const snap = channelSnapshot();
      return {
        ok: true,
        transport: cfg.transport,
        trigger: cfg.selfChat?.trigger ?? '@bot',
        openmausbot: omb,
        im: snap.status,
        bridge: bridge?.status?.() ?? null,
        context: imContext?.stats?.() ?? null,
        chats: bridge?.listKnownChats?.() ?? [],
        chatPolicy: bridge?.getChatPolicy?.() ?? null,
        chatThreads: bridge?.listChatThreads?.() ?? [],
        scheduledSummaries: bridge?.listScheduledSummaries?.() ?? [],
        channel: {
          name: snap.name,
          capabilities: snap.capabilities,
          status: snap.status,
        },
        plugins: snap.plugins,
        recentEventsCount: events.length,
      };
    });

    web.route('GET', '/api/debug/events', ({ url }) => {
      const snap = channelSnapshot();
      const chatFilter = String(url?.searchParams?.get('chatId') || '').trim();
      const sourceFilter = String(url?.searchParams?.get('source') || '').trim();
      const typeFilter = String(url?.searchParams?.get('type') || '').trim();
      let list = [...events].reverse();
      if (chatFilter) list = list.filter((e) => e.chatId === chatFilter);
      if (sourceFilter) list = list.filter((e) => e.source === sourceFilter);
      if (typeFilter) list = list.filter((e) => e.type === typeFilter);
      return {
        ok: true,
        ts: Date.now(),
        filter: { chatId: chatFilter || null, source: sourceFilter || null, type: typeFilter || null },
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
