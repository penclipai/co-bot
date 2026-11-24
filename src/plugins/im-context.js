/**
 * IM 会话上下文插件：提供进程内 ChatContextStore 与通道历史补全能力。
 */
import { assemblePromptContext, ChatContextStore, redactSecrets } from '../core/chat-context.js';

function normalizeChannelEntry(ev, fallbackChatId) {
  if (!ev || !ev.id) return null;
  const chatId = String(ev.chat?.id ?? fallbackChatId ?? '');
  if (!chatId || (fallbackChatId && chatId !== String(fallbackChatId))) return null;
  return {
    id: String(ev.id),
    ts: Number(ev.ts) || Date.now(),
    chatId,
    chatType: ev.chat?.type || 'direct',
    chatName: ev.chat?.name ? String(ev.chat.name) : undefined,
    senderId: String(ev.sender?.id ?? ''),
    senderName: ev.sender?.name ? String(ev.sender.name) : undefined,
    isSelf: Boolean(ev.sender?.isSelf),
    isBotReply: false,
    replyTo: ev.replyTo != null ? String(ev.replyTo) : undefined,
    mentionsMe: Boolean(ev.mentionsMe),
    ...(Array.isArray(ev.mentions) && ev.mentions.length ? { mentions: ev.mentions.map((m) => ({ ...m })) } : {}),
    text: redactSecrets(ev.text ?? ''),
    attachments: Array.isArray(ev.attachments) ? ev.attachments : [],
  };
}

export const imContextPlugin = {
  name: 'im-context',
  version: '1.0.0',
  inject: ['channel'],
  provides: ['imContext'],
  apply(ctx, opts = {}) {
    const cfg = ctx.config || {};
    const chatsCfg = { ...(cfg.chats || {}), ...(opts.chats || {}) };
    const channel = ctx.get('channel');

    const store = new ChatContextStore({
      maxPerChat: chatsCfg.contextMaxMessagesPerChat ?? 120,
      maxChats: chatsCfg.contextMaxChats ?? 200,
      ttlMs: chatsCfg.contextTtlMs ?? 24 * 60 * 60_000,
    });

    const resolveMessage = async (chatId, msgId) => {
      if (!chatId || !msgId) return null;
      const cached = store.getMessage(chatId, msgId);
      if (cached) return cached;

      if (typeof channel?.getMessage === 'function') {
        try {
          const remote = await channel.getMessage(chatId, msgId);
          if (remote && String(remote.chat?.id ?? chatId) === String(chatId)) {
            const fixed = remote.chat?.id ? remote : { ...remote, chat: { ...(remote.chat || {}), id: String(chatId) } };
            return store.recordInbound(fixed);
          }
        } catch { /* fallback below */ }
      }

      if (typeof channel?.getHistory === 'function') {
        try {
          const hist = await channel.getHistory(chatId, { limit: 40 });
          if (Array.isArray(hist) && hist.length) {
            store.recordHistoryBatch(chatId, hist);
            const found = store.getMessage(chatId, msgId);
            if (found) return found;
            const hit = hist.find((m) => String(m?.id) === String(msgId) && String(m?.chat?.id ?? chatId) === String(chatId));
            if (hit) return normalizeChannelEntry(hit, chatId);
          }
        } catch { /* ignore history lookup failure */ }
      }

      return null;
    };

    const getHistory = async (chatId, { limit = 20, before = null, excludeMsgId = null } = {}) => {
      if (!chatId) return [];
      const max = Math.max(1, Math.min(200, Number(limit) || 20));
      let local = store.getRecent(chatId, { limit: max, beforeMsgId: before, excludeMsgId });

      const missingInLocal = before && !store.getMessage(chatId, before);
      if ((local.length < max || missingInLocal) && typeof channel?.getHistory === 'function') {
        try {
          const anchor = before ? store.getMessage(chatId, before) : null;
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
              const merged = scoped
                .map((m) => normalizeChannelEntry(m, chatId))
                .filter((m) => m && (!excludeMsgId || m.id !== String(excludeMsgId)) && m.id !== String(before))
                .sort((a, b) => a.ts - b.ts);
              if (merged.length) return merged.slice(-max);
            }
          }
        } catch { /* fallback to local cache */ }
      }
      return local;
    };

    const buildPromptContext = (opts2 = {}) => assemblePromptContext({
      ...opts2,
      store,
      resolveMessage,
      getHistory,
    });

    ctx.provide('imContext', {
      store,
      recordInbound: (ev) => store.recordInbound(ev),
      recordOutbound: (chatId, info) => store.recordOutbound(chatId, info),
      recallMessage: (chatId, msgId) => store.recallMessage(chatId, msgId),
      resolveMessage,
      getHistory,
      listChats: () => store.listChats(),
      buildPromptContext,
      stats: () => ({
        ...store.stats(),
        channelHistory: Boolean(channel?.capabilities?.history),
      }),
    });
  },
};
