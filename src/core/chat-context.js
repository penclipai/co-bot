/**
 * 会话上下文内存环形缓冲区与 prompt 上下文块格式化工具。
 *
 * 隐私边界：仅保留在内存中，不落盘外部群聊/私聊记录；按 chatId 隔离并带 TTL 与条数上限。
 */

export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/\bomb_sess_[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\bctx_[A-Za-z0-9._-]{12,}/g, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
}

const DANGEROUS_MENTION_RE = /^(all|everyone|here|channel|所有人|全体成员|全体|大家|bot|ai|主bot)$/i;

/**
 * 脱敏外部群/私聊出站文本中的 `@xxx`，防止意外触发 IM @提醒、全体通知或群内其他 Bot。
 * 自动跳过代码块、行内代码、邮箱地址，以及已加入 `\u200B` 的片段。
 */
export function sanitizeExternalMentions(text, { mode = 'all', botNames = [] } = {}) {
  const s = String(text ?? '');
  if (!s || mode === 'none') return s;
  const botSet = new Set(
    (Array.isArray(botNames) ? botNames : [])
      .map((n) => String(n ?? '').replace(/^@/, '').trim().toLowerCase())
      .filter(Boolean),
  );
  const segs = s.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  for (let i = 0; i < segs.length; i += 2) {
    segs[i] = segs[i].replace(
      /(^|[^A-Za-z0-9._%+-])@([^\s@\u200B!:：,，;；)）\]】」』"'”’?？*]+)/g,
      (full, lead, name) => {
        if (mode === 'dangerous') {
          if (!DANGEROUS_MENTION_RE.test(name) && !botSet.has(name.toLowerCase())) {
            return full;
          }
        }
        return `${lead}@\u200B${name}`;
      },
    );
  }
  return segs.join('');
}

function clipText(text, max) {
  const s = redactSecrets(text).replace(/\r\n/g, '\n').trim();
  if (!s) return '';
  if (!max || s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function cloneAttachments(attachments, fallbackMsgId) {
  if (!Array.isArray(attachments) || !attachments.length) return [];
  return attachments
    .filter((a) => a && a.id != null)
    .map((a) => ({
      id: String(a.id),
      msgId: String(a.msgId ?? fallbackMsgId ?? ''),
      name: String(a.name ?? a.id),
      ...(a.size != null ? { size: Number(a.size) || undefined } : {}),
      ...(a.mime ? { mime: String(a.mime) } : {}),
    }));
}

function formatClock(ts) {
  const d = new Date(Number(ts) || Date.now());
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export class ChatContextStore {
  constructor({
    maxPerChat = 120,
    maxChats = 200,
    ttlMs = 24 * 60 * 60_000,
    maxTextChars = 4000,
    now = () => Date.now(),
  } = {}) {
    this.maxPerChat = Math.max(1, Number(maxPerChat) || 120);
    this.maxChats = Math.max(1, Number(maxChats) || 200);
    this.ttlMs = Math.max(60_000, Number(ttlMs) || 24 * 60 * 60_000);
    this.maxTextChars = Math.max(200, Number(maxTextChars) || 4000);
    this.now = now;
    this.chats = new Map();
    this.seq = 0;
  }

  #pruneExpired() {
    const cutoff = this.now() - this.ttlMs;
    for (const [chatId, bucket] of this.chats) {
      if (bucket.updatedAt < cutoff) {
        this.chats.delete(chatId);
      } else {
        while (bucket.order.length) {
          const head = bucket.byId.get(bucket.order[0]);
          if (head && head.ts >= cutoff) break;
          bucket.order.shift();
          if (head) bucket.byId.delete(head.id);
        }
        if (!bucket.order.length && bucket.updatedAt < cutoff) {
          this.chats.delete(chatId);
        }
      }
    }
  }

  #getOrCreateBucket(chatId, meta = {}) {
    this.#pruneExpired();
    let bucket = this.chats.get(chatId);
    if (!bucket) {
      if (this.chats.size >= this.maxChats) {
        let oldestId = null;
        let oldestTs = Infinity;
        for (const [id, b] of this.chats) {
          if (b.updatedAt < oldestTs) {
            oldestTs = b.updatedAt;
            oldestId = id;
          }
        }
        if (oldestId != null) this.chats.delete(oldestId);
      }
      bucket = {
        meta: {
          id: String(chatId),
          type: meta.type || 'direct',
          name: meta.name || undefined,
        },
        order: [],
        byId: new Map(),
        recalled: new Set(),
        updatedAt: this.now(),
      };
      this.chats.set(String(chatId), bucket);
    } else {
      if (meta.type) bucket.meta.type = meta.type;
      if (meta.name) bucket.meta.name = meta.name;
      bucket.updatedAt = Math.max(bucket.updatedAt, this.now());
    }
    return bucket;
  }

  #upsertEntry(bucket, entry) {
    const existing = bucket.byId.get(entry.id);
    if (existing) {
      bucket.byId.set(entry.id, { ...existing, ...entry });
      return bucket.byId.get(entry.id);
    }
    bucket.byId.set(entry.id, entry);
    // 按时间顺序插入（通常只需追加到末尾；补录历史时插到合适位置）
    if (!bucket.order.length || (bucket.byId.get(bucket.order[bucket.order.length - 1])?.ts ?? 0) <= entry.ts) {
      bucket.order.push(entry.id);
    } else {
      const idx = bucket.order.findIndex((id) => (bucket.byId.get(id)?.ts ?? 0) > entry.ts);
      if (idx < 0) bucket.order.push(entry.id);
      else bucket.order.splice(idx, 0, entry.id);
    }
    while (bucket.order.length > this.maxPerChat) {
      const dropped = bucket.order.shift();
      bucket.byId.delete(dropped);
    }
    return entry;
  }

  recordInbound(ev) {
    if (!ev?.id || !ev?.chat?.id) return null;
    if (ev.kind === 'recall') return null;
    const chatId = String(ev.chat.id);
    const ts = Number(ev.ts) || this.now();
    const bucket = this.#getOrCreateBucket(chatId, {
      type: ev.chat.type,
      name: ev.chat.name,
    });
    if (bucket.recalled.has(String(ev.id))) return null;
    const entry = {
      id: String(ev.id),
      ts,
      chatId,
      chatType: bucket.meta.type,
      chatName: bucket.meta.name,
      senderId: String(ev.sender?.id ?? ''),
      senderName: ev.sender?.name ? String(ev.sender.name) : undefined,
      isSelf: Boolean(ev.sender?.isSelf),
      isBotReply: false,
      replyTo: ev.replyTo != null ? String(ev.replyTo) : undefined,
      mentionsMe: Boolean(ev.mentionsMe),
      ...(Array.isArray(ev.mentions) && ev.mentions.length ? { mentions: ev.mentions.map((m) => ({ ...m })) } : {}),
      text: clipText(ev.text ?? '', this.maxTextChars),
      attachments: cloneAttachments(ev.attachments, ev.id),
    };
    return this.#upsertEntry(bucket, entry);
  }

  recallMessage(chatId, msgId) {
    if (!chatId || !msgId) return { ok: false, removed: false };
    const cid = String(chatId);
    const mid = String(msgId);
    const bucket = this.#getOrCreateBucket(cid);
    bucket.recalled.add(mid);
    if (bucket.recalled.size > 200) bucket.recalled.delete(bucket.recalled.values().next().value);
    const existed = bucket.byId.delete(mid);
    if (existed) {
      const idx = bucket.order.indexOf(mid);
      if (idx >= 0) bucket.order.splice(idx, 1);
    }
    bucket.updatedAt = this.now();
    return { ok: true, removed: existed };
  }

  recordOutbound(chatId, {
    id,
    ts,
    text = '',
    replyTo,
    attachments,
    senderId = '__bot__',
    senderName = 'bot',
    isBotReply = true,
    chatType,
    chatName,
  } = {}) {
    if (!chatId) return null;
    const cid = String(chatId);
    const stamp = Number(ts) || this.now();
    this.seq += 1;
    const msgId = id ? String(id) : `out_${stamp}_${this.seq}`;
    const bucket = this.#getOrCreateBucket(cid, {
      ...(chatType ? { type: chatType } : {}),
      ...(chatName ? { name: chatName } : {}),
    });
    const entry = {
      id: msgId,
      ts: stamp,
      chatId: cid,
      chatType: bucket.meta.type,
      chatName: bucket.meta.name,
      senderId: String(senderId || '__bot__'),
      senderName: String(senderName || 'bot'),
      isSelf: true,
      isBotReply: Boolean(isBotReply),
      replyTo: replyTo != null ? String(replyTo) : undefined,
      mentionsMe: false,
      text: clipText(text, this.maxTextChars),
      attachments: cloneAttachments(attachments, msgId),
    };
    return this.#upsertEntry(bucket, entry);
  }

  recordHistoryBatch(chatId, events = []) {
    if (!chatId || !Array.isArray(events)) return 0;
    let added = 0;
    for (const ev of events) {
      if (!ev?.id) continue;
      const normalized = ev.chat?.id ? ev : { ...ev, chat: { ...(ev.chat || {}), id: String(chatId) } };
      if (String(normalized.chat.id) !== String(chatId)) continue;
      if (this.recordInbound(normalized)) added += 1;
    }
    return added;
  }

  getMessage(chatId, msgId) {
    if (!chatId || !msgId) return null;
    this.#pruneExpired();
    const bucket = this.chats.get(String(chatId));
    return bucket?.byId.get(String(msgId)) ?? null;
  }

  getRecent(chatId, { limit = 15, beforeMsgId = null, excludeMsgId = null } = {}) {
    if (!chatId) return [];
    this.#pruneExpired();
    const bucket = this.chats.get(String(chatId));
    if (!bucket) return [];
    let endIdx = bucket.order.length;
    if (beforeMsgId) {
      const idx = bucket.order.indexOf(String(beforeMsgId));
      if (idx >= 0) endIdx = idx;
    }
    const max = Math.max(1, Math.min(200, Number(limit) || 15));
    const slice = [];
    for (let i = Math.max(0, endIdx - 1); i >= 0 && slice.length < max; i -= 1) {
      const id = bucket.order[i];
      if (excludeMsgId && id === String(excludeMsgId)) continue;
      const item = bucket.byId.get(id);
      if (item) slice.push(item);
    }
    return slice.reverse();
  }

  search(chatId, query, { limit = 10 } = {}) {
    if (!chatId) return [];
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return [];
    this.#pruneExpired();
    const bucket = this.chats.get(String(chatId));
    if (!bucket) return [];
    const max = Math.max(1, Math.min(50, Number(limit) || 10));
    const hits = [];
    for (let i = bucket.order.length - 1; i >= 0 && hits.length < max; i -= 1) {
      const item = bucket.byId.get(bucket.order[i]);
      if (!item) continue;
      const hay = [
        item.text,
        item.senderName,
        ...(item.attachments || []).map((a) => a.name),
      ].filter(Boolean).join('\n').toLowerCase();
      if (hay.includes(q)) hits.push(item);
    }
    return hits;
  }

  searchAll(query, { limit = 15, chatId = null, excludeSelf = true } = {}) {
    const tokens = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];
    this.#pruneExpired();
    const max = Math.max(1, Math.min(50, Number(limit) || 15));
    const hits = [];
    const targetBuckets = chatId
      ? [this.chats.get(String(chatId))].filter(Boolean)
      : [...this.chats.values()];
    for (const bucket of targetBuckets) {
      if (!chatId && excludeSelf && bucket.meta.type === 'self') continue;
      for (let i = bucket.order.length - 1; i >= 0; i -= 1) {
        const item = bucket.byId.get(bucket.order[i]);
        if (!item) continue;
        const hay = [
          item.text,
          item.senderName,
          item.chatName,
          ...(item.attachments || []).map((a) => a.name),
        ].filter(Boolean).join('\n').toLowerCase();
        if (tokens.every((t) => hay.includes(t))) hits.push(item);
      }
    }
    return hits.sort((a, b) => b.ts - a.ts).slice(0, max);
  }

  getChatMeta(chatId) {
    if (!chatId) return null;
    this.#pruneExpired();
    const bucket = this.chats.get(String(chatId));
    if (!bucket) return null;
    return {
      ...bucket.meta,
      count: bucket.order.length,
      updatedAt: bucket.updatedAt,
    };
  }

  stats() {
    this.#pruneExpired();
    let totalMessages = 0;
    for (const bucket of this.chats.values()) {
      totalMessages += bucket.order.length;
    }
    return {
      chatCount: this.chats.size,
      totalMessages,
    };
  }

  listChats() {
    this.#pruneExpired();
    return [...this.chats.values()]
      .map((b) => ({
        id: b.meta.id,
        type: b.meta.type,
        name: b.meta.name || b.meta.id,
        count: b.order.length,
        updatedAt: b.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  clear(chatId) {
    if (!chatId) {
      this.chats.clear();
      return;
    }
    this.chats.delete(String(chatId));
  }
}

const ARTIFACT_REF_RE = /(图|截图|图片|照片|日志|文件|附件|报错|表格|pdf|log|png|jpg|webp|screenshot|image|file|上面|这几张|这几个|刚发)/i;

/**
 * 收集外部会话中随提问一起提交的多附件：
 * 1) 被直接引用的消息附件，以及同一成员短时间窗口内连发的同批附件；
 * 2) 未直接引用但提问词明确指代上方图片/日志/文件时，自动吸附最近同批连续附件。
 */
export function collectContextAttachments({
  triggerEvent,
  quotedMsg = null,
  recentMsgs = [],
  windowMs = 120_000,
  maxAttachments = 4,
} = {}) {
  const empty = { attachments: [], sourceMsgIds: [] };
  if (!triggerEvent || triggerEvent?.chat?.type === 'self') return empty;
  const cap = Math.max(0, Number(maxAttachments) || 0);
  const winMs = Math.max(0, Number(windowMs) || 0);
  if (!cap) return empty;

  const out = [];
  const seen = new Set();
  const srcSet = new Set();
  const pushFrom = (msg) => {
    if (!msg?.attachments?.length || out.length >= cap) return;
    for (const a of msg.attachments) {
      if (!a || a.id == null) continue;
      const msgId = String(a.msgId ?? msg.id ?? '');
      const key = `${msgId}:${a.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...a, msgId });
      if (msgId) srcSet.add(msgId);
      if (out.length >= cap) break;
    }
  };

  if (quotedMsg?.attachments?.length) {
    pushFrom(quotedMsg);
    if (winMs > 0 && Array.isArray(recentMsgs) && recentMsgs.length && out.length < cap) {
      const qTs = Number(quotedMsg.ts) || 0;
      const qSender = String(quotedMsg.senderId ?? '');
      const burst = [];
      let qIdx = recentMsgs.findIndex((m) => m?.id === quotedMsg.id);
      if (qIdx < 0) {
        qIdx = recentMsgs.findIndex((m) => (Number(m?.ts) || 0) >= qTs);
        if (qIdx < 0) qIdx = recentMsgs.length;
      }
      for (let i = qIdx - 1, gap = 0; i >= 0; i -= 1) {
        const m = recentMsgs[i];
        if (!m) continue;
        if (qTs && m.ts && Math.abs(qTs - m.ts) > winMs) break;
        if (m.attachments?.length) {
          if (String(m.senderId ?? '') !== qSender) break;
          burst.unshift(m);
          gap = 0;
        } else {
          gap += 1;
          if (gap > 2) break;
        }
      }
      const startFwd = recentMsgs[qIdx]?.id === quotedMsg.id ? qIdx + 1 : qIdx;
      for (let i = startFwd, gap = 0; i < recentMsgs.length; i += 1) {
        const m = recentMsgs[i];
        if (!m) continue;
        if (qTs && m.ts && Math.abs(m.ts - qTs) > winMs) break;
        if (m.attachments?.length) {
          if (String(m.senderId ?? '') !== qSender) break;
          burst.push(m);
          gap = 0;
        } else {
          gap += 1;
          if (gap > 2) break;
        }
      }
      for (const m of burst) pushFrom(m);
    }
    return { attachments: out, sourceMsgIds: [...srcSet] };
  }

  if (
    !quotedMsg
    && !(triggerEvent?.attachments?.length)
    && winMs > 0
    && Array.isArray(recentMsgs)
    && recentMsgs.length
    && ARTIFACT_REF_RE.test(String(triggerEvent?.text ?? ''))
  ) {
    const trigTs = Number(triggerEvent?.ts) || Date.now();
    let anchorIdx = -1;
    for (let i = recentMsgs.length - 1, skipped = 0; i >= 0 && skipped <= 4; i -= 1) {
      const m = recentMsgs[i];
      if (!m) continue;
      if (m.ts && (trigTs - m.ts) > winMs) break;
      if (m.attachments?.length && !m.isBotReply) {
        anchorIdx = i;
        break;
      }
      skipped += 1;
    }
    if (anchorIdx >= 0) {
      const anchor = recentMsgs[anchorIdx];
      const anchorSender = String(anchor.senderId ?? '');
      const anchorTs = Number(anchor.ts) || trigTs;
      const burst = [anchor];
      for (let i = anchorIdx - 1, gap = 0; i >= 0; i -= 1) {
        const m = recentMsgs[i];
        if (!m) continue;
        if (m.ts && (anchorTs - m.ts) > winMs) break;
        if (m.attachments?.length && !m.isBotReply) {
          if (String(m.senderId ?? '') !== anchorSender) break;
          burst.unshift(m);
          gap = 0;
        } else {
          gap += 1;
          if (gap > 2) break;
        }
      }
      for (const m of burst) pushFrom(m);
    }
  }
  return { attachments: out, sourceMsgIds: [...srcSet] };
}

function formatSenderLabel(entry) {
  if (!entry) return 'unknown';
  const base = entry.senderName || entry.senderId || (entry.isSelf ? 'me' : 'member');
  if (entry.isBotReply) return `${base}[bot]`;
  if (entry.isSelf) return `${base}[me]`;
  return base;
}

function formatMsgLine(entry, maxChars = 280) {
  const parts = [];
  const body = clipText(entry.text || '', maxChars);
  if (body) parts.push(body);
  if (Array.isArray(entry.mentions) && entry.mentions.length) {
    const extra = entry.mentions
      .map((m) => (m?.isAll ? '所有人' : String(m?.name || m?.id || '').replace(/^@/, '')))
      .filter((label) => label && !body.includes(`@${label}`));
    if (extra.length) parts.push(`[提及: ${extra.map((x) => `@${x}`).join(', ')}]`);
  }
  if (entry.attachments?.length) {
    const names = entry.attachments.map((a) => a.name).join(', ');
    parts.push(`[附件: ${names}]`);
  }
  const content = parts.join(' ') || '[空消息]';
  const replyHint = entry.replyTo ? ` -> reply:${entry.replyTo}` : '';
  return `[${formatClock(entry.ts)}] ${formatSenderLabel(entry)} (id:${entry.id}${replyHint}): ${content}`;
}

/**
 * 构造注入给 OpenMausBot 的 `<im-context>` 提示头（或自聊引用前缀）。
 */
export function formatImContextBlock({
  triggerEvent,
  chatMeta,
  quotedMsg = null,
  recentMsgs = [],
  bundledAttachments = [],
  privateReply = false,
  contextApi = null,
  maxQuotedChars = 800,
  maxRecentChars = 280,
} = {}) {
  const chatType = chatMeta?.type || triggerEvent?.chat?.type || 'direct';
  const chatName = chatMeta?.name || triggerEvent?.chat?.name || triggerEvent?.chat?.id || 'unknown';
  const isSelfChat = chatType === 'self';

  // 自聊保持原生语义：不对 Bot 回复或未知历史消息额外包裹 [引用消息]，仅在显式引用人工内容时附加
  if (isSelfChat) {
    if (quotedMsg && !quotedMsg.isBotReply) {
      return `[引用消息 ${formatSenderLabel(quotedMsg)} (${quotedMsg.id})]\n${formatMsgLine(quotedMsg, maxQuotedChars)}\n\n`;
    }
    return '';
  }

  const lines = [
    '<im-context>',
    `chat_type: ${chatType}`,
    `chat_name: ${redactSecrets(chatName)}`,
    `invoker: ${redactSecrets(triggerEvent?.sender?.name || triggerEvent?.sender?.id || 'owner')}[me]`,
    `reply_destination: ${privateReply ? 'self_chat_private' : 'current_chat'}`,
    ...(!privateReply ? ['reply_policy: answer concisely on behalf of the owner in a shared chat; do NOT ping @all/@everyone, colleagues, or other bots unless explicitly instructed by the owner'] : []),
  ];

  if (quotedMsg) {
    lines.push('quoted_message:');
    lines.push(`  ${formatMsgLine(quotedMsg, maxQuotedChars)}`);
  } else if (triggerEvent?.replyTo) {
    lines.push(`quoted_message: [id:${triggerEvent.replyTo} unavailable in cache/history]`);
  }

  if (Array.isArray(recentMsgs) && recentMsgs.length) {
    lines.push(`recent_messages (${recentMsgs.length}, oldest_first):`);
    for (const m of recentMsgs) {
      lines.push(`  - ${formatMsgLine(m, maxRecentChars)}`);
    }
  }

  if (Array.isArray(bundledAttachments) && bundledAttachments.length) {
    lines.push(`auto_attached_files: ${bundledAttachments.map((a) => `${a.name} (from ${a.msgId})`).join(', ')}`);
  }

  if (contextApi && (contextApi.messagesUrl || contextApi.searchUrl || contextApi.messageUrl || contextApi.attachmentUrl)) {
    lines.push('more_context_api (read-only JSON supporting GET/HEAD, strictly scoped to this chat; quote URLs in shell because they contain "&"):');
    if (contextApi.messagesUrl) {
      const oldest = recentMsgs?.[0]?.id ? `&before=${encodeURIComponent(recentMsgs[0].id)}` : '';
      lines.push(`  - recent/older: GET ${contextApi.messagesUrl}&limit=30${oldest}`);
    }
    if (contextApi.messageUrl) {
      lines.push(`  - by_id: GET ${contextApi.messageUrl}&msgId=<MESSAGE_ID>`);
    }
    if (contextApi.searchUrl) {
      lines.push(`  - search: GET ${contextApi.searchUrl}&q=<KEYWORD>`);
    }
    if (contextApi.attachmentUrl) {
      lines.push(`  - attachment: GET ${contextApi.attachmentUrl}&msgId=<MESSAGE_ID>`);
    }
  }

  lines.push('</im-context>');
  return `${lines.join('\n')}\n\n`;
}

/** 统一装配入站提示上下文：记录入站消息、拉取引用与最近历史、合批同批多附件并格式化 `<im-context>`。 */
export async function assemblePromptContext({
  ev,
  store,
  resolveMessage,
  getHistory,
  issueContextApiUrls = null,
  privateReply = false,
  contextWindow = 15,
  injectRecent = true,
  maxQuotedChars = 800,
  maxRecentChars = 280,
  skipSelfQuote = false,
  recentAttachmentWindowMs = 120_000,
  maxAutoAttachments = 4,
} = {}) {
  if (!ev?.chat?.id) {
    return { header: '', quotedMsg: null, recentMsgs: [], quotedAttachments: [], contextAttachments: [] };
  }
  store.recordInbound(ev);
  const chatId = String(ev.chat.id);
  const isSelfSkip = ev.chat.type === 'self' && skipSelfQuote;
  const quotedMsg = (ev.replyTo && !isSelfSkip) ? await resolveMessage(chatId, ev.replyTo) : null;
  const isExternal = ev.chat.type !== 'self';
  const recentMsgs = (isExternal && injectRecent && contextWindow > 0)
    ? await getHistory(chatId, { limit: contextWindow, excludeMsgId: ev.id })
    : [];
  const bundled = isExternal
    ? collectContextAttachments({
        triggerEvent: ev,
        quotedMsg,
        recentMsgs,
        windowMs: recentAttachmentWindowMs,
        maxAttachments: maxAutoAttachments,
      })
    : { attachments: quotedMsg?.attachments || [], sourceMsgIds: [] };
  const contextApi = isExternal && typeof issueContextApiUrls === 'function' ? issueContextApiUrls(chatId) : null;
  const header = formatImContextBlock({
    triggerEvent: ev,
    chatMeta: store.getChatMeta(chatId),
    quotedMsg,
    recentMsgs,
    bundledAttachments: isExternal ? bundled.attachments : [],
    privateReply,
    contextApi,
    maxQuotedChars,
    maxRecentChars,
  });
  return {
    header,
    quotedMsg,
    recentMsgs,
    quotedAttachments: quotedMsg?.attachments || [],
    contextAttachments: isExternal ? bundled.attachments : (quotedMsg?.attachments || []),
  };
}
