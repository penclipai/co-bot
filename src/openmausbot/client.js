import path from 'node:path';

/**
 * OpenMausBot Harness Client（纯 fetch / SSE，零外部依赖）：
 * 对接本地 OpenMausBot HTTP + SSE 服务（默认 http://127.0.0.1:8799）。
 */

const enc = encodeURIComponent;

/** 按 OpenMausBot 契约转义附件标签属性值。 */
function escapeAttachmentAttr(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\t', '&#9;')
    .replaceAll('\r', '&#13;')
    .replaceAll('\n', '&#10;');
}

/** 构造 OpenMausBot 原生识别的多模态图片或文件附件标签。 */
export function formatAttachmentTag({ kind = 'file', path: filePath, name } = {}) {
  const p = escapeAttachmentAttr(filePath);
  if (kind === 'image') return `<attached-image path="${p}" />`;
  const n = name ? ` name="${escapeAttachmentAttr(name)}"` : '';
  return `<attached-file path="${p}"${n} />`;
}

/** 按 OpenMausBot 契约判断一条 bot 消息是否在等待用户输入/审批。 */
export function messageNeedsInput(msg) {
  if (!msg || typeof msg !== 'object') return false;
  const card = msg.card && typeof msg.card === 'object'
    && msg.card.requestId
    && !msg.card.answered
    && !msg.card.dismissed
    && !msg.card.expired
    && !msg.card.quotaSwitch;
  const connector = msg.connector && typeof msg.connector === 'object'
    && !msg.connector.dismissed
    && !msg.connector.resumed
    && msg.connector.status !== 'connected';
  const secret = msg.secret && typeof msg.secret === 'object'
    && !msg.secret.provided
    && !msg.secret.dismissed
    && !msg.secret.superseded;
  const signIn = msg.signIn && typeof msg.signIn === 'object'
    && !msg.signIn.done
    && !msg.signIn.cancelled
    && !msg.signIn.superseded
    && !msg.signIn.answeredInChat;
  return Boolean(card || connector || secret || signIn);
}

function parseDispositionName(header, fallbackPath) {
  const h = String(header ?? '');
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(h);
  if (utf8) {
    try { return decodeURIComponent(utf8[1]); } catch { /* fallback below */ }
  }
  const quoted = /filename="([^"]+)"/i.exec(h) ?? /filename=([^;\s]+)/i.exec(h);
  if (quoted) return quoted[1].trim();
  return path.posix.basename(String(fallbackPath || 'attachment').replace(/\\/g, '/')) || 'attachment';
}

function matchByNameOrId(pool, q) {
  const low = q.toLowerCase();
  return pool.find((x) => String(x.name ?? '').toLowerCase() === low)
    ?? pool.find((x) => String(x.name ?? '').toLowerCase().startsWith(low))
    ?? pool.find((x) => String(x.name ?? '').toLowerCase().includes(low))
    ?? pool.find((x) => x.id === q)
    ?? null;
}

function buildMsgBody({ text, threadId, sendId, replyToId } = {}) {
  const body = { text: String(text ?? '') };
  if (threadId) body.threadId = String(threadId);
  if (sendId) body.sendId = String(sendId);
  if (replyToId) body.replyToId = String(replyToId);
  return body;
}

const threadBody = (threadId) => (threadId ? { threadId: String(threadId) } : {});

export class OpenMausBotClient {
  constructor({ baseUrl = 'http://127.0.0.1:8799', timeoutMs = 15_000, token = '' } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.token = String(token ?? '').trim();
  }

  /** 更新内存中的配对 Bearer Token。 */
  setToken(token) {
    this.token = String(token ?? '').trim();
  }

  async #fetchRaw(urlPath, opts = {}) {
    const ms = opts.timeoutMs ?? this.timeoutMs;
    const timeoutSig = AbortSignal.timeout(ms);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSig]) : timeoutSig;
    const headers = { ...(opts.headers ?? {}) };
    if (this.token && !opts.skipAuth && !headers.authorization && !headers.Authorization) {
      headers.authorization = `Bearer ${this.token}`;
    }
    let body = opts.body;
    if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
      headers['content-type'] ??= 'application/json';
      body = JSON.stringify(body);
    }
    const res = await fetch(`${this.baseUrl}${urlPath}`, {
      method: opts.method ?? 'GET',
      headers,
      body,
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch { /* non-json error */ } }
      const err = new Error(data?.error || `OpenMausBot API error ${res.status} (${urlPath})`);
      err.status = res.status;
      err.code = data?.code;
      err.body = data;
      throw err;
    }
    return res;
  }

  async #json(urlPath, opts = {}) {
    const res = await this.#fetchRaw(urlPath, opts);
    const text = await res.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }

  health() {
    return this.#json('/api/health');
  }

  environment() {
    return this.#json('/.well-known/openmausbot/environment', { skipAuth: true });
  }

  authSession() {
    return this.#json('/api/auth/session');
  }

  pair({ code, label = 'co-bot' } = {}) {
    return this.#json('/api/auth/pair', {
      method: 'POST',
      skipAuth: true,
      body: { code: String(code ?? '').trim(), label: String(label || 'co-bot').trim() },
    });
  }

  startCliLogin({ label = 'co-bot', scope = 'client', verifierHash } = {}) {
    return this.#json('/api/auth/cli-login', {
      method: 'POST',
      skipAuth: true,
      body: {
        label: String(label || 'co-bot').trim(),
        scope,
        verifierHash: String(verifierHash ?? ''),
      },
    });
  }

  pollCliLogin(id, { verifier } = {}) {
    return this.#json(`/api/auth/cli-login/${enc(id)}`, {
      method: 'POST',
      skipAuth: true,
      body: { verifier: String(verifier ?? '') },
    });
  }

  async listBots() {
    const data = await this.#json('/api/bots?messages=0');
    return { bots: Array.isArray(data.bots) ? data.bots : [], groups: Array.isArray(data.groups) ? data.groups : [] };
  }

  /** 解析 @提及 的目标 Bot；默认（@bot / @ai / @主bot / @co-bot）返回 chiefOfStaff 或第一个可见 Bot。 */
  async resolveBot(mention = '') {
    const { bots } = await this.listBots();
    const visible = bots.filter((b) => !b.hidden);
    const pool = visible.length ? visible : bots;
    if (!pool.length) return null;
    const q = String(mention ?? '').trim();
    if (!q || /^(bot|ai|主bot|co-bot|cobot|default|chief)$/i.test(q)) {
      return pool.find((b) => b.chiefOfStaff) ?? pool[0];
    }
    return matchByNameOrId(pool, q);
  }

  /** 解析 @提及 的多 Bot 协作群组。 */
  async resolveGroup(mention = '') {
    const q = String(mention ?? '').trim();
    if (!q) return null;
    const { groups } = await this.listBots();
    const team = groups.filter((g) => !g.hidden && !g.dm);
    const visible = team.length ? team : groups.filter((g) => !g.hidden);
    const pool = visible.length ? visible : groups;
    return pool.length ? matchByNameOrId(pool, q) : null;
  }

  sendMessage(botId, opts = {}) {
    return this.#json(`/api/bots/${enc(botId)}/messages`, { method: 'POST', body: buildMsgBody(opts) });
  }

  sendGroupMessage(groupId, opts = {}) {
    return this.#json(`/api/groups/${enc(groupId)}/messages`, { method: 'POST', body: buildMsgBody(opts) });
  }

  createGroupTask(groupId, { title } = {}) {
    const body = title ? { title: String(title) } : {};
    return this.#json(`/api/groups/${enc(groupId)}/tasks`, { method: 'POST', body });
  }

  selectGroupTask(groupId, taskThreadId) {
    return this.#json(`/api/groups/${enc(groupId)}/tasks/${enc(taskThreadId)}?messages=0`, { method: 'POST', body: {} });
  }

  interruptGroup(groupId, threadId) {
    return this.#json(`/api/groups/${enc(groupId)}/interrupt`, { method: 'POST', body: threadBody(threadId) });
  }

  steerGroupQueued(groupId, queueId, threadId) {
    return this.#json(`/api/groups/${enc(groupId)}/queue/${enc(queueId)}/steer`, { method: 'POST', body: threadBody(threadId) });
  }

  cancelGroupQueued(groupId, queueId) {
    return this.#json(`/api/groups/${enc(groupId)}/queue/${enc(queueId)}`, { method: 'DELETE' });
  }

  patchBot(botId, patch) {
    return this.#json(`/api/bots/${enc(botId)}`, { method: 'PATCH', body: patch });
  }

  createTask(botId, { title, select = true } = {}) {
    const body = { select: select !== false };
    if (title) body.title = String(title);
    return this.#json(`/api/bots/${enc(botId)}/tasks`, { method: 'POST', body });
  }

  selectTask(botId, taskThreadId) {
    return this.#json(`/api/bots/${enc(botId)}/tasks/${enc(taskThreadId)}?messages=0`, { method: 'POST', body: {} });
  }

  steerQueued(botId, queueId, threadId) {
    return this.#json(`/api/bots/${enc(botId)}/queue/${enc(queueId)}/steer`, { method: 'POST', body: threadBody(threadId) });
  }

  cancelQueued(botId, queueId, threadId) {
    return this.#json(`/api/bots/${enc(botId)}/queue/${enc(queueId)}`, { method: 'DELETE', body: threadBody(threadId) });
  }

  compact(botId, threadId) {
    return this.#json(`/api/bots/${enc(botId)}/compact`, { method: 'POST', body: threadBody(threadId) });
  }

  interrupt(botId, threadId) {
    return this.#json(`/api/bots/${enc(botId)}/interrupt`, { method: 'POST', body: threadBody(threadId) });
  }

  respond(threadId, { requestId, behavior, message, always, rememberCommand } = {}) {
    const body = { requestId: String(requestId), behavior };
    if (message !== undefined) body.message = String(message);
    if (always === true) body.always = true;
    if (rememberCommand === true) body.rememberCommand = true;
    return this.#json(`/api/threads/${enc(threadId)}/respond`, { method: 'POST', body });
  }

  dismissSecretCard(botId, messageId, threadId) {
    return this.#json(`/api/bots/${enc(botId)}/secret-cards/${enc(messageId)}/dismiss`, { method: 'POST', body: threadBody(threadId) });
  }

  dismissConnectorCard(botId, messageId, threadId) {
    return this.#json(`/api/bots/${enc(botId)}/connector-cards/${enc(messageId)}/dismiss`, { method: 'POST', body: threadBody(threadId) });
  }

  cancelSignInCard(botId, messageId, threadId) {
    return this.#json(`/api/bots/${enc(botId)}/sign-in-cards/${enc(messageId)}/cancel`, { method: 'POST', body: threadBody(threadId) });
  }

  getMessages(threadId, limit = 20) {
    return this.#json(`/api/threads/${enc(threadId)}/messages?limit=${limit}`);
  }

  getJob(threadId, { scope = 'turn', since, wait = 0, version, signal } = {}) {
    const params = new URLSearchParams({ scope });
    if (since !== undefined) params.set('since', String(since));
    if (wait > 0) params.set('wait', String(wait));
    if (version !== undefined) params.set('version', String(version));
    return this.#json(`/api/threads/${enc(threadId)}/job?${params.toString()}`, {
      signal,
      timeoutMs: Math.max(this.timeoutMs, (Number(wait) || 0) + 10_000),
    });
  }

  uploadImage(buf, mime = 'image/png') {
    return this.#json('/api/attachments', {
      method: 'POST',
      headers: { 'content-type': mime },
      body: buf,
      timeoutMs: Math.max(this.timeoutMs, 30_000),
    });
  }

  uploadFile(name, buf, mime = 'application/octet-stream') {
    return this.#json(`/api/files?name=${enc(String(name || 'file'))}`, {
      method: 'POST',
      headers: { 'content-type': mime },
      body: buf,
      timeoutMs: Math.max(this.timeoutMs, 60_000),
    });
  }

  async downloadMessageImage(threadId, messageId) {
    const res = await this.#fetchRaw(`/api/threads/${enc(threadId)}/messages/${enc(messageId)}/image`, {
      timeoutMs: Math.max(this.timeoutMs, 30_000),
    });
    return {
      buf: Buffer.from(await res.arrayBuffer()),
      mime: res.headers.get('content-type') || 'image/png',
    };
  }

  async downloadMessageFile(threadId, messageId, filePath) {
    const res = await this.#fetchRaw(`/api/threads/${enc(threadId)}/messages/${enc(messageId)}/file`, {
      method: 'POST',
      body: { path: String(filePath) },
      timeoutMs: Math.max(this.timeoutMs, 60_000),
    });
    return {
      buf: Buffer.from(await res.arrayBuffer()),
      mime: res.headers.get('content-type') || 'application/octet-stream',
      name: parseDispositionName(res.headers.get('content-disposition'), filePath),
    };
  }

  /** 订阅 OpenMausBot 规范化 SSE 事件流，断线后带 cursor 自动重连，直到 signal 中止。 */
  async subscribeEvents(onEvent, { signal, reconnectDelayMs = 1000, authRetryDelayMs, onError } = {}) {
    let cursor = null;
    while (!signal?.aborted) {
      let delay = reconnectDelayMs;
      try {
        const qs = new URLSearchParams({ screens: 'off', ...(cursor ? { since: cursor } : {}) });
        const headers = {
          accept: 'text/event-stream',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(cursor ? { 'last-event-id': cursor } : {}),
        };
        const res = await fetch(`${this.baseUrl}/api/events?${qs.toString()}`, { headers, signal });
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => '');
          let data = null;
          if (text) { try { data = JSON.parse(text); } catch { /* non-json error */ } }
          const err = new Error(data?.error || `SSE connect failed (${res.status})`);
          err.status = res.status;
          throw err;
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let cut;
          while ((cut = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            let eventId = null;
            const dataLines = [];
            for (const line of block.split('\n')) {
              if (!line || line.startsWith(':')) continue;
              if (line.startsWith('id:')) eventId = line.slice(3).trim();
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
            }
            if (eventId) cursor = eventId;
            if (!dataLines.length) continue;
            let evt;
            try { evt = JSON.parse(dataLines.join('\n')); } catch { continue; }
            if (evt?.kind === 'hello' && evt.cursor) cursor = String(evt.cursor);
            await onEvent(evt);
          }
        }
        if (!signal?.aborted) {
          try { onError?.(new Error('SSE stream closed')); } catch { /* callback error */ }
        }
      } catch (e) {
        if (signal?.aborted || e?.name === 'AbortError') break;
        try { onError?.(e); } catch { /* callback error */ }
        if (e?.status === 401 || e?.status === 403) {
          delay = authRetryDelayMs ?? Math.max(reconnectDelayMs * 10, 15_000);
        }
      }
      if (signal?.aborted) break;
      await new Promise((r) => {
        const done = () => { clearTimeout(t); signal?.removeEventListener('abort', done); r(); };
        const t = setTimeout(done, delay);
        signal?.addEventListener('abort', done, { once: true });
      });
    }
  }
}
