import { clipSummary, normalizeCapabilities } from '../core/channel-contract.js';
import { redactSecrets } from '../core/chat-context.js';

const MAX_RECENT_EVENTS = 250;

function sanitizeConfigSnapshot(cfg = {}) {
  const redactSecret = (val) => (val ? '[REDACTED]' : '');
  const clone = JSON.parse(JSON.stringify(cfg, (k, v) => {
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
    ctx.on('channel:notify', (p) => pushEvent('channel', 'notify', p));
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

    const buildStatusPayload = async () => {
      const ombSvc = ctx.has('openmausbot') ? ctx.get('openmausbot') : null;
      const bridge = ctx.has('bridge') ? ctx.get('bridge') : null;
      const imContext = ctx.has('imContext') ? ctx.get('imContext') : null;
      const omb = ombSvc ? await ombSvc.probe() : null;
      const snap = channelSnapshot();
      return {
        ok: true,
        runtime: runtimeSnapshot(),
        transport: cfg.transport,
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
      const bridge = ctx.has('bridge') ? ctx.get('bridge') : null;
      if (!bridge) {
        const err = new Error('bridge 尚未就绪');
        err.status = 503;
        throw err;
      }
      const action = String(body?.action || '').trim();
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
