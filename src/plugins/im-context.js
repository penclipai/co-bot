/**
 * IM 会话上下文插件：提供进程内 ChatContextStore、历史补全能力及按 chatId 强隔离的只读 HTTP 查询接口。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assemblePromptContext, ChatContextStore, redactSecrets } from '../core/chat-context.js';
import { fileSafe, safeAttachmentName } from '../format.js';
import { send } from '../web/server.js';

const TEXT_ATTACHMENT_EXTS = new Set([
  '.log', '.txt', '.md', '.json', '.yaml', '.yml', '.xml', '.csv',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.java',
  '.rs', '.sh', '.ps1', '.sql', '.ini', '.conf', '.env', '.html', '.css',
]);

function isTextAttachment(mime = '', fileName = '') {
  const m = String(mime || '').toLowerCase().split(';')[0].trim();
  if (
    m.startsWith('text/')
    || m === 'application/json'
    || m === 'application/xml'
    || m === 'application/javascript'
    || m === 'application/typescript'
  ) {
    return true;
  }
  return TEXT_ATTACHMENT_EXTS.has(path.extname(String(fileName || '')).toLowerCase());
}

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
  inject: ['web', 'channel'],
  provides: ['imContext'],
  apply(ctx, opts = {}) {
    const cfg = ctx.config || {};
    const chatsCfg = { ...(cfg.chats || {}), ...(opts.chats || {}) };
    const web = ctx.get('web');
    const channel = ctx.get('channel');

    const store = new ChatContextStore({
      maxPerChat: chatsCfg.contextMaxMessagesPerChat ?? 120,
      maxChats: chatsCfg.contextMaxChats ?? 200,
      ttlMs: chatsCfg.contextTtlMs ?? 24 * 60 * 60_000,
    });

    const tokenSecret = crypto.randomBytes(32);

    const signScopeToken = (chatId, ttlMs = 2 * 60 * 60_000) => {
      const payload = {
        chatId: String(chatId),
        exp: Date.now() + Math.max(60_000, Number(ttlMs) || 2 * 60 * 60_000),
      };
      const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
      const sig = crypto.createHmac('sha256', tokenSecret).update(payloadB64).digest('base64url');
      return `ctx_${payloadB64}.${sig}`;
    };

    const verifyScopeToken = (token) => {
      if (typeof token !== 'string' || !token.startsWith('ctx_')) return null;
      const body = token.slice(4);
      const dot = body.indexOf('.');
      if (dot <= 0) return null;
      const payloadB64 = body.slice(0, dot);
      const sig = body.slice(dot + 1);
      if (!sig) return null;
      const expected = crypto.createHmac('sha256', tokenSecret).update(payloadB64).digest('base64url');
      const a = Buffer.from(sig, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
      try {
        const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
        if (!parsed || typeof parsed.chatId !== 'string' || !parsed.chatId) return null;
        if (!Number.isFinite(parsed.exp) || parsed.exp <= Date.now()) return null;
        return { chatId: parsed.chatId, exp: parsed.exp };
      } catch {
        return null;
      }
    };

    const resolveOrigin = () => {
      const boundPort = web?.server?.address?.()?.port || web?.port || cfg.web?.port || 8787;
      const host = (cfg.web?.host === '0.0.0.0' || !cfg.web?.host) ? '127.0.0.1' : cfg.web.host;
      return `http://${host}:${boundPort}`;
    };

    const issueContextApiUrls = (chatId, ttlMs) => {
      const token = encodeURIComponent(signScopeToken(chatId, ttlMs));
      const base = resolveOrigin();
      return {
        messagesUrl: `${base}/api/im-context/messages?token=${token}`,
        messageUrl: `${base}/api/im-context/message?token=${token}`,
        searchUrl: `${base}/api/im-context/search?token=${token}`,
        attachmentUrl: `${base}/api/im-context/attachment?token=${token}`,
      };
    };

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
      const max = Math.max(1, Math.min(50, Number(limit) || 20));
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
              // 深度翻页时允许直接返回标准化后的远端更早消息（不挤占内存中的最新滑动窗口）
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

    const searchHistory = async (chatId, query, { limit = 10 } = {}) => {
      if (!chatId) return [];
      const q = String(query ?? '').trim();
      if (!q) return [];
      const max = Math.max(1, Math.min(30, Number(limit) || 10));
      const localHits = store.search(chatId, q, { limit: max });

      if (typeof channel?.searchHistory === 'function') {
        try {
          const remoteHits = await channel.searchHistory(chatId, q, { limit: max });
          if (Array.isArray(remoteHits) && remoteHits.length) {
            const byId = new Map();
            for (const item of localHits) byId.set(item.id, item);
            for (const ev of remoteHits) {
              const norm = normalizeChannelEntry(ev, chatId);
              if (norm && !byId.has(norm.id)) byId.set(norm.id, norm);
            }
            return [...byId.values()]
              .sort((a, b) => b.ts - a.ts)
              .slice(0, max);
          }
        } catch { /* fallback to local search */ }
      }
      return localHits;
    };

    const searchAllChats = async (query, { limit = 15, chatId = null, excludeSelf = true } = {}) => {
      const q = String(query ?? '').trim();
      if (!q) return [];
      const max = Math.max(1, Math.min(50, Number(limit) || 15));
      const localHits = store.searchAll(q, { limit: max, chatId, excludeSelf });
      if (chatId && typeof channel?.searchHistory === 'function') {
        try {
          const remoteHits = await channel.searchHistory(chatId, q, { limit: max });
          if (Array.isArray(remoteHits) && remoteHits.length) {
            const byId = new Map(localHits.map((it) => [it.id, it]));
            for (const ev of remoteHits) {
              const norm = normalizeChannelEntry(ev, chatId);
              if (norm && !byId.has(norm.id)) byId.set(norm.id, norm);
            }
            return [...byId.values()].sort((a, b) => b.ts - a.ts).slice(0, max);
          }
        } catch { /* fallback to local search */ }
      }
      return localHits;
    };

    const buildPromptContext = (opts = {}) => assemblePromptContext({
      ...opts,
      store,
      resolveMessage,
      getHistory,
      issueContextApiUrls,
    });

    const extractAuth = (req, url) => {
      const fromQuery = url?.searchParams?.get('token');
      const authHeader = String(req?.headers?.authorization || '');
      const fromHeader = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
      return verifyScopeToken(fromQuery || fromHeader || '');
    };

    web.route('GET', '/api/im-context/messages', async ({ req, res, url }) => {
      const auth = extractAuth(req, url);
      if (!auth) {
        return send(res, 401, { ok: false, error: '无效或已过期的上下文令牌' });
      }
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit') || 20) || 20));
      const before = url.searchParams.get('before') || null;
      const items = await getHistory(auth.chatId, { limit: limit + 1, before });
      const hasMore = items.length > limit;
      const trimmed = hasMore ? items.slice(items.length - limit) : items;
      const meta = store.getChatMeta(auth.chatId);
      return {
        ok: true,
        chatId: auth.chatId,
        chatName: meta?.name ?? null,
        chatType: meta?.type ?? null,
        items: trimmed,
        hasMore,
      };
    });

    web.route('GET', '/api/im-context/message', async ({ req, res, url }) => {
      const auth = extractAuth(req, url);
      if (!auth) {
        return send(res, 401, { ok: false, error: '无效或已过期的上下文令牌' });
      }
      const msgId = String(url.searchParams.get('msgId') || '').trim();
      if (!msgId) {
        return send(res, 400, { ok: false, error: '缺少 msgId 参数' });
      }
      const item = await resolveMessage(auth.chatId, msgId);
      if (!item) {
        return send(res, 404, { ok: false, error: '当前会话中未找到该消息' });
      }
      return { ok: true, chatId: auth.chatId, item };
    });

    web.route('GET', '/api/im-context/search', async ({ req, res, url }) => {
      const auth = extractAuth(req, url);
      if (!auth) {
        return send(res, 401, { ok: false, error: '无效或已过期的上下文令牌' });
      }
      const q = String(url.searchParams.get('q') || '').trim();
      if (!q) {
        return send(res, 400, { ok: false, error: '缺少检索关键词 q' });
      }
      const limit = Math.max(1, Math.min(30, Number(url.searchParams.get('limit') || 10) || 10));
      const items = await searchHistory(auth.chatId, q, { limit });
      return {
        ok: true,
        chatId: auth.chatId,
        query: q,
        items,
      };
    });

    web.route('GET', '/api/im-context/attachment', async ({ req, res, url }) => {
      const auth = extractAuth(req, url);
      if (!auth) {
        return send(res, 401, { ok: false, error: '无效或已过期的上下文令牌' });
      }
      const msgId = String(url.searchParams.get('msgId') || '').trim();
      if (!msgId) {
        return send(res, 400, { ok: false, error: '缺少 msgId 参数' });
      }
      const attId = String(url.searchParams.get('attId') || '').trim();
      const item = await resolveMessage(auth.chatId, msgId);
      const atts = Array.isArray(item?.attachments) ? item.attachments : [];
      const att = attId
        ? atts.find((a) => String(a?.id) === attId)
        : atts[0];
      if (!item || !att) {
        return send(res, 404, { ok: false, error: '当前会话的该消息中未找到附件' });
      }
      if (typeof channel?.download !== 'function') {
        return send(res, 501, { ok: false, error: '当前 IM 通道不支持下载附件' });
      }
      const cacheRoot = path.join(cfg.dataDir || os.tmpdir(), 'omb-files');
      const safeName = safeAttachmentName(att.name, 'file');
      const dest = path.join(cacheRoot, fileSafe(msgId) || 'f', safeName);
      try {
        if (!fs.existsSync(dest)) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          await channel.download({ ...att, msgId: att.msgId || item.id || msgId }, dest);
        }
      } catch (e) {
        return send(res, 404, { ok: false, error: `附件拉取失败：${e?.message || 'unavailable'}` });
      }
      const stat = fs.statSync(dest);
      const metaOut = {
        id: String(att.id),
        name: String(att.name || safeName),
        mime: att.mime || null,
        size: stat.size,
      };
      if (isTextAttachment(att.mime, att.name || safeName) && stat.size <= 2 * 1024 * 1024) {
        const rawText = fs.readFileSync(dest, 'utf8');
        const truncated = rawText.length > 64_000;
        const text = redactSecrets(truncated ? `${rawText.slice(0, 64_000)}\n…[已截断]` : rawText);
        return {
          ok: true,
          chatId: auth.chatId,
          msgId,
          attachment: metaOut,
          kind: 'text',
          savedPath: dest,
          text,
          truncated,
        };
      }
      return {
        ok: true,
        chatId: auth.chatId,
        msgId,
        attachment: metaOut,
        kind: 'binary',
        savedPath: dest,
      };
    });

    ctx.provide('imContext', {
      store,
      recordInbound: (ev) => store.recordInbound(ev),
      recordOutbound: (chatId, info) => store.recordOutbound(chatId, info),
      recallMessage: (chatId, msgId) => store.recallMessage(chatId, msgId),
      resolveMessage,
      getHistory,
      searchHistory,
      searchAllChats,
      listChats: () => store.listChats(),
      issueScopeToken: (chatId, ttlMs) => signScopeToken(chatId, ttlMs),
      verifyScopeToken,
      issueContextApiUrls,
      buildPromptContext,
      stats: () => ({
        ...store.stats(),
        channelHistory: Boolean(channel?.capabilities?.history),
      }),
    });
  },
};
