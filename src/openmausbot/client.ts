import path from 'node:path';
import type {
  OmbAuthSession,
  OmbBot,
  OmbEnvironment,
  OmbGroup,
  OmbHealth,
  OmbHttpError,
  OmbMessage,
  OmbSseEvent,
  OmbTargetBot,
  OmbTaskSummary,
} from './types.ts';

/**
 * OpenMausBot Harness Client（纯 fetch / SSE，零外部依赖）：
 * 对接本地 OpenMausBot HTTP + SSE 服务（默认 http://127.0.0.1:8799）。
 */

const enc = encodeURIComponent;

/** 按 OpenMausBot 契约转义附件标签属性值。 */
function escapeAttachmentAttr(value: unknown): string {
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
export function formatAttachmentTag({ kind = 'file', path: filePath, name }: { kind?: string; path?: string; name?: string } = {}): string {
  const p = escapeAttachmentAttr(filePath);
  if (kind === 'image') return `<attached-image path="${p}" />`;
  const n = name ? ` name="${escapeAttachmentAttr(name)}"` : '';
  return `<attached-file path="${p}"${n} />`;
}

/** 按 OpenMausBot 契约判断一条 bot 消息是否在等待用户输入/审批。 */
export function messageNeedsInput(msg: OmbMessage | null | undefined): boolean {
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

function parseDispositionName(header: string | null, fallbackPath: string): string {
  const h = String(header ?? '');
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(h);
  if (utf8) {
    try { return decodeURIComponent(utf8[1]); } catch { /* fallback below */ }
  }
  const quoted = /filename="([^"]+)"/i.exec(h) ?? /filename=([^;\s]+)/i.exec(h);
  if (quoted) return quoted[1].trim();
  return path.posix.basename(String(fallbackPath || 'attachment').replace(/\\/g, '/')) || 'attachment';
}

function matchByNameOrId<T extends { id: string; name?: string }>(pool: T[], q: string): T | null {
  const low = q.toLowerCase();
  return pool.find((x) => String(x.name ?? '').toLowerCase() === low)
    ?? pool.find((x) => String(x.name ?? '').toLowerCase().startsWith(low))
    ?? pool.find((x) => String(x.name ?? '').toLowerCase().includes(low))
    ?? pool.find((x) => x.id === q)
    ?? null;
}

function buildMsgBody({
  text,
  threadId,
  sendId,
  replyToId,
}: {
  text?: string;
  threadId?: string | null;
  sendId?: string | null;
  replyToId?: string | null;
} = {}): Record<string, string> {
  const body: Record<string, string> = { text: String(text ?? '') };
  if (threadId) body.threadId = String(threadId);
  if (sendId) body.sendId = String(sendId);
  if (replyToId) body.replyToId = String(replyToId);
  return body;
}

const threadBody = (threadId?: string | null): Record<string, string> => (threadId ? { threadId: String(threadId) } : {});

interface FetchRawOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  skipAuth?: boolean;
}

export class OpenMausBotClient {
  baseUrl: string;
  timeoutMs: number;
  token: string;

  constructor({ baseUrl = 'http://127.0.0.1:8799', timeoutMs = 15_000, token = '' }: {
    baseUrl?: string;
    timeoutMs?: number;
    token?: string;
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.token = String(token ?? '').trim();
  }

  /** 更新内存中的配对 Bearer Token。 */
  setToken(token: string): void {
    this.token = String(token ?? '').trim();
  }

  async #fetchRaw(urlPath: string, opts: FetchRawOpts = {}): Promise<Response> {
    const ms = opts.timeoutMs ?? this.timeoutMs;
    const timeoutSig = AbortSignal.timeout(ms);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSig]) : timeoutSig;
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (this.token && !opts.skipAuth && !headers.authorization && !headers.Authorization) {
      headers.authorization = `Bearer ${this.token}`;
    }
    let rawBody: RequestInit['body'];
    const body = opts.body;
    if (body !== undefined) {
      if (typeof body === 'string') {
        rawBody = body;
      } else if (body instanceof Uint8Array) {
        rawBody = new Uint8Array(body);
      } else {
        headers['content-type'] ??= 'application/json';
        rawBody = JSON.stringify(body);
      }
    }
    const res = await fetch(`${this.baseUrl}${urlPath}`, {
      method: opts.method ?? 'GET',
      headers,
      body: rawBody,
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let data: { error?: string; code?: string } | null = null;
      if (text) { try { data = JSON.parse(text) as { error?: string; code?: string }; } catch { /* non-json error */ } }
      const err: OmbHttpError = new Error(data?.error || `OpenMausBot API error ${res.status} (${urlPath})`);
      err.status = res.status;
      err.code = data?.code;
      err.body = data;
      throw err;
    }
    return res;
  }

  async #json<T = Record<string, unknown>>(urlPath: string, opts: FetchRawOpts = {}): Promise<T> {
    const res = await this.#fetchRaw(urlPath, opts);
    const text = await res.text();
    if (!text) return {} as T;
    try { return JSON.parse(text) as T; } catch { return { raw: text } as T; }
  }

  health(): Promise<OmbHealth> {
    return this.#json<OmbHealth>('/api/health');
  }

  environment(): Promise<OmbEnvironment> {
    return this.#json<OmbEnvironment>('/.well-known/openmausbot/environment', { skipAuth: true });
  }

  authSession(): Promise<OmbAuthSession> {
    return this.#json<OmbAuthSession>('/api/auth/session');
  }

  pair({ code, label = 'co-bot' }: { code?: string; label?: string } = {}): Promise<{ token?: string; session?: OmbAuthSession }> {
    return this.#json('/api/auth/pair', {
      method: 'POST',
      skipAuth: true,
      body: { code: String(code ?? '').trim(), label: String(label || 'co-bot').trim() },
    });
  }

  startCliLogin({ label = 'co-bot', scope = 'client', verifierHash }: {
    label?: string;
    scope?: string;
    verifierHash?: string;
  } = {}): Promise<{ id?: string; code?: string; intervalMs?: number; expiresAt?: number | string }> {
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

  pollCliLogin(id: string, { verifier }: { verifier?: string } = {}): Promise<{
    state?: string;
    token?: string;
    session?: OmbAuthSession;
    error?: string;
  }> {
    return this.#json(`/api/auth/cli-login/${enc(id)}`, {
      method: 'POST',
      skipAuth: true,
      body: { verifier: String(verifier ?? '') },
    });
  }

  async listBots(): Promise<{ bots: OmbBot[]; groups: OmbGroup[] }> {
    const data = await this.#json<{ bots?: OmbBot[]; groups?: OmbGroup[] }>('/api/bots?messages=0');
    return { bots: Array.isArray(data.bots) ? data.bots : [], groups: Array.isArray(data.groups) ? data.groups : [] };
  }

  /** 解析 @提及 的目标 Bot；默认（@bot / @ai / @主bot / @co-bot）返回 chiefOfStaff 或第一个可见 Bot。 */
  async resolveBot(mention = ''): Promise<OmbBot | null> {
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
  async resolveGroup(mention = ''): Promise<OmbGroup | null> {
    const q = String(mention ?? '').trim();
    if (!q) return null;
    const { groups } = await this.listBots();
    const team = groups.filter((g) => !g.hidden && !g.dm);
    const visible = team.length ? team : groups.filter((g) => !g.hidden);
    const pool = visible.length ? visible : groups;
    return pool.length ? matchByNameOrId(pool, q) : null;
  }

  sendMessage(botId: string, opts: { text?: string; threadId?: string | null; sendId?: string | null; replyToId?: string | null } = {}): Promise<{
    queued?: boolean;
    queueId?: string;
    blockedBy?: string;
    steered?: boolean;
    message?: OmbMessage;
  }> {
    return this.#json(`/api/bots/${enc(botId)}/messages`, { method: 'POST', body: buildMsgBody(opts) });
  }

  sendGroupMessage(groupId: string, opts: { text?: string; threadId?: string | null; sendId?: string | null; replyToId?: string | null } = {}): Promise<{
    queued?: boolean;
    queueId?: string;
    blockedBy?: string;
    steered?: boolean;
    message?: OmbMessage;
  }> {
    return this.#json(`/api/groups/${enc(groupId)}/messages`, { method: 'POST', body: buildMsgBody(opts) });
  }

  createGroupTask(groupId: string, { title }: { title?: string } = {}): Promise<{ task?: OmbTaskSummary; bot?: OmbBot; group?: OmbGroup }> {
    const body = title ? { title: String(title) } : {};
    return this.#json(`/api/groups/${enc(groupId)}/tasks`, { method: 'POST', body });
  }

  selectGroupTask(groupId: string, taskThreadId: string): Promise<Record<string, unknown>> {
    return this.#json(`/api/groups/${enc(groupId)}/tasks/${enc(taskThreadId)}?messages=0`, { method: 'POST', body: {} });
  }

  interruptGroup(groupId: string, threadId?: string | null): Promise<Record<string, unknown>> {
    return this.#json(`/api/groups/${enc(groupId)}/interrupt`, { method: 'POST', body: threadBody(threadId) });
  }

  steerGroupQueued(groupId: string, queueId: string, threadId?: string | null): Promise<{ queued?: boolean; blockedBy?: string }> {
    return this.#json(`/api/groups/${enc(groupId)}/queue/${enc(queueId)}/steer`, { method: 'POST', body: threadBody(threadId) });
  }

  cancelGroupQueued(groupId: string, queueId: string): Promise<Record<string, unknown>> {
    return this.#json(`/api/groups/${enc(groupId)}/queue/${enc(queueId)}`, { method: 'DELETE' });
  }

  patchBot(botId: string, patch: Record<string, unknown>): Promise<{ bot?: OmbBot }> {
    return this.#json(`/api/bots/${enc(botId)}`, { method: 'PATCH', body: patch });
  }

  createTask(botId: string, { title, select = true }: { title?: string; select?: boolean } = {}): Promise<{ task?: OmbTaskSummary; bot?: OmbBot; group?: OmbGroup }> {
    const body: Record<string, unknown> = { select: select !== false };
    if (title) body.title = String(title);
    return this.#json(`/api/bots/${enc(botId)}/tasks`, { method: 'POST', body });
  }

  selectTask(botId: string, taskThreadId: string): Promise<Record<string, unknown>> {
    return this.#json(`/api/bots/${enc(botId)}/tasks/${enc(taskThreadId)}?messages=0`, { method: 'POST', body: {} });
  }

  steerQueued(botId: string, queueId: string, threadId?: string | null): Promise<{ queued?: boolean; blockedBy?: string }> {
    return this.#json(`/api/bots/${enc(botId)}/queue/${enc(queueId)}/steer`, { method: 'POST', body: threadBody(threadId) });
  }

  cancelQueued(botId: string, queueId: string, threadId?: string | null): Promise<Record<string, unknown>> {
    return this.#json(`/api/bots/${enc(botId)}/queue/${enc(queueId)}`, { method: 'DELETE', body: threadBody(threadId) });
  }

  compact(botId: string, threadId?: string | null): Promise<Record<string, unknown>> {
    return this.#json(`/api/bots/${enc(botId)}/compact`, { method: 'POST', body: threadBody(threadId) });
  }

  interrupt(botId: string, threadId?: string | null): Promise<Record<string, unknown>> {
    return this.#json(`/api/bots/${enc(botId)}/interrupt`, { method: 'POST', body: threadBody(threadId) });
  }

  respond(threadId: string, { requestId, behavior, message, always, rememberCommand }: {
    requestId?: string | null;
    behavior?: string;
    message?: string;
    always?: boolean;
    rememberCommand?: boolean;
  } = {}): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { requestId: String(requestId), behavior };
    if (message !== undefined) body.message = String(message);
    if (always === true) body.always = true;
    if (rememberCommand === true) body.rememberCommand = true;
    return this.#json(`/api/threads/${enc(threadId)}/respond`, { method: 'POST', body });
  }

  dismissSecretCard(botId: string, messageId: string, threadId?: string | null): Promise<Record<string, unknown>> {
    return this.#json(`/api/bots/${enc(botId)}/secret-cards/${enc(messageId)}/dismiss`, { method: 'POST', body: threadBody(threadId) });
  }

  dismissConnectorCard(botId: string, messageId: string, threadId?: string | null): Promise<Record<string, unknown>> {
    return this.#json(`/api/bots/${enc(botId)}/connector-cards/${enc(messageId)}/dismiss`, { method: 'POST', body: threadBody(threadId) });
  }

  cancelSignInCard(botId: string, messageId: string, threadId?: string | null): Promise<Record<string, unknown>> {
    return this.#json(`/api/bots/${enc(botId)}/sign-in-cards/${enc(messageId)}/cancel`, { method: 'POST', body: threadBody(threadId) });
  }

  getMessages(threadId: string, limit = 20): Promise<{ messages?: OmbMessage[] }> {
    return this.#json(`/api/threads/${enc(threadId)}/messages?limit=${limit}`);
  }

  getJob(threadId: string, { scope = 'turn', since, wait = 0, version, signal }: {
    scope?: string;
    since?: unknown;
    wait?: number;
    version?: unknown;
    signal?: AbortSignal;
  } = {}): Promise<{ state?: string; since?: unknown; version?: unknown; needsInput?: unknown[] }> {
    const params = new URLSearchParams({ scope });
    if (since !== undefined) params.set('since', String(since));
    if (wait > 0) params.set('wait', String(wait));
    if (version !== undefined) params.set('version', String(version));
    return this.#json(`/api/threads/${enc(threadId)}/job?${params.toString()}`, {
      signal,
      timeoutMs: Math.max(this.timeoutMs, (Number(wait) || 0) + 10_000),
    });
  }

  uploadImage(buf: Uint8Array, mime = 'image/png'): Promise<{ path?: string; url?: string }> {
    return this.#json('/api/attachments', {
      method: 'POST',
      headers: { 'content-type': mime },
      body: buf,
      timeoutMs: Math.max(this.timeoutMs, 30_000),
    });
  }

  uploadFile(name: string, buf: Uint8Array, mime = 'application/octet-stream'): Promise<{ path?: string; url?: string }> {
    return this.#json(`/api/files?name=${enc(String(name || 'file'))}`, {
      method: 'POST',
      headers: { 'content-type': mime },
      body: buf,
      timeoutMs: Math.max(this.timeoutMs, 60_000),
    });
  }

  async downloadMessageImage(threadId: string, messageId: string): Promise<{ buf: Buffer; mime: string }> {
    const res = await this.#fetchRaw(`/api/threads/${enc(threadId)}/messages/${enc(messageId)}/image`, {
      timeoutMs: Math.max(this.timeoutMs, 30_000),
    });
    return {
      buf: Buffer.from(await res.arrayBuffer()),
      mime: res.headers.get('content-type') || 'image/png',
    };
  }

  async downloadMessageFile(threadId: string, messageId: string, filePath: string): Promise<{ buf: Buffer; mime: string; name: string }> {
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
  async subscribeEvents(
    onEvent: (evt: OmbSseEvent) => Promise<void> | void,
    { signal, reconnectDelayMs = 1000, authRetryDelayMs, onError }: {
      signal?: AbortSignal;
      reconnectDelayMs?: number;
      authRetryDelayMs?: number;
      onError?: (err: OmbHttpError) => void;
    } = {},
  ): Promise<void> {
    let cursor: string | null = null;
    while (!signal?.aborted) {
      let delay = reconnectDelayMs;
      try {
        const qs = new URLSearchParams({ screens: 'off', ...(cursor ? { since: cursor } : {}) });
        const headers: Record<string, string> = {
          accept: 'text/event-stream',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(cursor ? { 'last-event-id': cursor } : {}),
        };
        const res = await fetch(`${this.baseUrl}/api/events?${qs.toString()}`, { headers, signal });
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => '');
          let data: { error?: string } | null = null;
          if (text) { try { data = JSON.parse(text) as { error?: string }; } catch { /* non-json error */ } }
          const err: OmbHttpError = new Error(data?.error || `SSE connect failed (${res.status})`);
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
          let cut: number;
          while ((cut = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            let eventId: string | null = null;
            const dataLines: string[] = [];
            for (const line of block.split('\n')) {
              if (!line || line.startsWith(':')) continue;
              if (line.startsWith('id:')) eventId = line.slice(3).trim();
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
            }
            if (eventId) cursor = eventId;
            if (!dataLines.length) continue;
            let evt: OmbSseEvent;
            try { evt = JSON.parse(dataLines.join('\n')) as OmbSseEvent; } catch { continue; }
            if (evt?.kind === 'hello' && evt.cursor) cursor = String(evt.cursor);
            await onEvent(evt);
          }
        }
        if (!signal?.aborted) {
          try { onError?.(new Error('SSE stream closed')); } catch { /* callback error */ }
        }
      } catch (e) {
        const err = e as OmbHttpError;
        if (signal?.aborted || err?.name === 'AbortError') break;
        try { onError?.(err); } catch { /* callback error */ }
        if (err?.status === 401 || err?.status === 403) {
          delay = authRetryDelayMs ?? Math.max(reconnectDelayMs * 10, 15_000);
        }
      }
      if (signal?.aborted) break;
      await new Promise<void>((r) => {
        const onAbort = (): void => {
          clearTimeout(t);
          r();
        };
        const t = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          r();
        }, delay);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }
}

export type { OmbTargetBot };
