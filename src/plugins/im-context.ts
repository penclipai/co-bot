/**
 * IM 会话上下文插件：提供进程内 ChatContextStore、通道历史合并去重、以及本机只读 `/api/context/history` 探索接口。
 */
import { isLoopbackUrl, probeHostOf } from '../../scripts/omb.ts';
import { assemblePromptContext, ChatContextStore } from '../core/chat-context.ts';
import { ContextPullManager } from '../core/context-pull.ts';
import type { ManagedChannel } from '../core/channel-contract.ts';
import type { ImContextService } from '../openmausbot/types.ts';
import type { ChatContextMessage, ChatsConfig, InboundEvent, KernelPlugin } from '../types.ts';
import type { WebServer } from '../web/server.ts';

function mergeDedupedMessages(
  local: ChatContextMessage[],
  remote: ChatContextMessage[],
  isRecalled: (id: string) => boolean,
  max: number,
): ChatContextMessage[] {
  const byId = new Map<string, ChatContextMessage>();
  for (const m of remote) {
    if (m?.id && !isRecalled(m.id)) byId.set(m.id, m);
  }
  for (const m of local) {
    if (m?.id && !isRecalled(m.id)) byId.set(m.id, m);
  }
  return [...byId.values()].sort((a, b) => a.ts - b.ts).slice(-max);
}

export const imContextPlugin: KernelPlugin<{ chats?: Partial<ChatsConfig> }> = {
  name: 'im-context',
  version: '1.0.0',
  inject: { required: ['channel'], optional: ['web'] },
  provides: ['imContext'],
  apply(ctx, opts = {}) {
    const cfg = ctx.config;
    const chatsCfg = { ...(cfg?.chats || {}), ...(opts.chats || {}) };
    const channel = ctx.get<ManagedChannel>('channel');
    const web = ctx.has('web') ? ctx.get<WebServer>('web') : null;

    const store = new ChatContextStore({
      maxPerChat: chatsCfg.contextMaxMessagesPerChat ?? 120,
      maxChats: chatsCfg.contextMaxChats ?? 200,
      ttlMs: chatsCfg.contextTtlMs ?? 24 * 60 * 60_000,
    });

    const channelHasHistory = Boolean(
      channel?.capabilities?.history !== undefined
        ? channel.capabilities.history
        : typeof channel?.getHistory === 'function',
    );
    const channelHasMessage = Boolean(
      channel?.capabilities?.history !== undefined
        ? channel.capabilities.history
        : typeof channel?.getMessage === 'function',
    );

    const resolveMessage = async (chatId: string, msgId: string): Promise<ChatContextMessage | null> => {
      if (!chatId || !msgId) return null;
      if (store.isRecalled(chatId, msgId)) return null;
      const cached = store.getMessage(chatId, msgId);
      if (cached) return cached;

      if (channelHasMessage && typeof channel?.getMessage === 'function') {
        try {
          const remote = await channel.getMessage(chatId, msgId) as Partial<InboundEvent> | null;
          if (remote && String(remote.chat?.id ?? chatId) === String(chatId)) {
            const fixed: Partial<InboundEvent> = remote.chat?.id
              ? remote
              : { ...remote, chat: { type: 'direct', ...(remote.chat || {}), id: String(chatId) } };
            return store.recordInbound(fixed);
          }
        } catch { /* fallback below */ }
      }

      if (channelHasHistory && typeof channel?.getHistory === 'function') {
        try {
          const hist = await channel.getHistory(chatId, { limit: 40 });
          if (Array.isArray(hist) && hist.length) {
            store.recordHistoryBatch(chatId, hist);
            const found = store.getMessage(chatId, msgId);
            if (found) return found;
            const hit = hist.find((m) => String(m?.id) === String(msgId) && String(m?.chat?.id ?? chatId) === String(chatId));
            if (hit) return store.normalizeInbound(hit, chatId);
          }
        } catch { /* ignore history lookup failure */ }
      }

      return null;
    };

    const getHistory = async (
      chatId: string,
      { limit = 20, before = null, excludeMsgId = null }: { limit?: number; before?: string | null; excludeMsgId?: string | null } = {},
    ): Promise<ChatContextMessage[]> => {
      if (!chatId) return [];
      const max = Math.max(1, Math.min(200, Number(limit) || 20));
      let local = store.getRecent(chatId, { limit: max, beforeMsgId: before, excludeMsgId });

      const anchor = before ? store.getMessage(chatId, before) : null;
      const missingInLocal = Boolean(before && !anchor);
      if ((local.length < max || missingInLocal) && channelHasHistory && typeof channel?.getHistory === 'function') {
        try {
          const remote = await channel.getHistory(chatId, {
            limit: max + 5,
            beforeMsgId: before || undefined,
            beforeTs: anchor?.ts,
          });
          if (Array.isArray(remote) && remote.length) {
            const scoped = remote.filter((m) => m && String(m.chat?.id ?? chatId) === String(chatId));
            if (!before) {
              store.recordHistoryBatch(chatId, scoped);
              local = store.getRecent(chatId, { limit: max, beforeMsgId: before, excludeMsgId });
            } else {
              const normalizedRemote = scoped
                .map((m) => store.normalizeInbound(m, chatId))
                .filter((m): m is ChatContextMessage => Boolean(m && (!excludeMsgId || m.id !== String(excludeMsgId)) && m.id !== String(before)));
              return mergeDedupedMessages(local, normalizedRemote, (id) => store.isRecalled(chatId, id), max);
            }
          }
        } catch { /* fallback to local cache */ }
      }
      return local;
    };

    const pullManager = new ContextPullManager({
      resolveMessage,
      getHistory: (cid, o) => getHistory(cid, { limit: o.limit, before: o.before }),
      isSelfMessageReadable: (cid, msg) => store.isSelfMessageReadableByBot(cid, msg),
      isRecalled: (cid, mid) => store.isRecalled(cid, mid),
      searchCached: (cid, query, lim) => store.searchMessages(cid, query, lim),
      getChatType: (cid) => store.getChatMeta(cid)?.type ?? 'direct',
      onTelemetry: (data) => ctx.emit('bridge:event', { type: 'context_pull', ts: Date.now(), ...data }),
    });

    if (web) {
      web.route('GET', '/api/context/history', ({ req, url }) => pullManager.handleRequest(url, req.socket?.remoteAddress));
    }

    const resolveLoopbackWebUrl = (): string | null => {
      if (!web?.server) return null;
      const ombUrl = cfg?.openmausbot?.url;
      if (ombUrl && !isLoopbackUrl(ombUrl)) return null;
      const addr = web.server.address();
      if (!addr || typeof addr !== 'object') return null;
      const host = probeHostOf(addr.address);
      const url = `http://${host}:${addr.port}`;
      return isLoopbackUrl(url) ? url : null;
    };

    const getContextPullHint: NonNullable<ImContextService['getContextPullHint']> = (chatId, info) => (
      pullManager.formatPullHint(chatId, {
        baseUrl: resolveLoopbackWebUrl(),
        oldestMsgId: info.oldestMsgId,
        hasTruncated: info.hasTruncated,
        hasOlder: info.hasOlder,
        channelHasHistory,
        readonly: Boolean(info.readonly),
      })
    );

    const buildPromptContext: ImContextService['buildPromptContext'] = (opts2) => assemblePromptContext({
      ...opts2,
      store,
      resolveMessage,
      getHistory,
    });

    const service: ImContextService & {
      resolveMessage: typeof resolveMessage;
      pullManager: ContextPullManager;
    } = {
      store,
      pullManager,
      recordInbound: (ev) => store.recordInbound(ev),
      recordOutbound: (chatId, info) => store.recordOutbound(chatId, info),
      recallMessage: (chatId, msgId) => store.recallMessage(chatId, msgId),
      resolveMessage,
      getHistory,
      listChats: () => store.listChats(),
      getContextPullHint,
      buildPromptContext,
      stats: () => ({
        ...store.stats(),
        channelHistory: Boolean(channel?.capabilities?.history),
      }),
    };

    ctx.provide('imContext', service);
  },
};
