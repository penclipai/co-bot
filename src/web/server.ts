import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export interface RouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  params: RegExpMatchArray | null;
  body: Record<string, unknown>;
}

export type RouteHandler = (ctx: RouteContext) => Promise<unknown> | unknown;

interface RouteEntry {
  method: string;
  pattern: string | RegExp;
  handler: RouteHandler;
  limit?: number;
}

interface HttpErrorLike extends Error {
  status?: number;
  code?: string;
}

/**
 * 极简 HTTP 服务（零依赖）：主界面 + 管理 API，以及网页模拟器的路由。
 * 默认只监听 127.0.0.1；所有写请求要求同源 + JSON，本机其他网页无法跨站调用。
 */
export class WebServer {
  host: string;
  port: number;
  publicDir: string;
  routes: RouteEntry[];
  server: http.Server | null;

  constructor({ host = '127.0.0.1', port = 8787, publicDir = '' }: { host?: string; port?: number; publicDir?: string } = {}) {
    this.host = host;
    this.port = port;
    this.publicDir = publicDir;
    this.routes = [];
    this.server = null;
  }

  /** pattern: 字符串精确匹配，或带捕获组的正则。handler(ctx) 返回值会作为 JSON 响应。 */
  route(method: string, pattern: string | RegExp, handler: RouteHandler, opts: { limit?: number } = {}): void {
    this.routes.push({ method, pattern, handler, limit: opts.limit });
  }

  hasRoute(method: string, pattern: string | RegExp): boolean {
    return this.routes.some((r) => r.method === method && r.pattern === pattern);
  }

  page(urlPath: string, file: string): void {
    this.asset(urlPath, file, 'text/html');
  }

  asset(urlPath: string, file: string, type: string): void {
    this.route('GET', urlPath, ({ req, res }) => {
      const buf = fs.readFileSync(path.join(this.publicDir, file));
      res.writeHead(200, {
        'content-type': `${type}; charset=utf-8`,
        'content-length': buf.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  }

  async start(): Promise<void> {
    const srv = http.createServer((req, res) => this.#handle(req, res).catch((e) => {
      console.error('[web]', e);
      if (!res.headersSent) send(res, 500, { error: '服务器内部错误' });
    }));
    this.server = srv;
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(this.port, this.host, () => resolve());
    });
    console.log(`[web] http://${this.host}:${this.port}`);
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections?.();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local');
    const reqMethod = req.method === 'HEAD' ? 'GET' : (req.method ?? 'GET');
    let params: RegExpMatchArray | null = null;
    const r = this.routes.find((x) => {
      if (x.method !== reqMethod) return false;
      if (typeof x.pattern === 'string') return x.pattern === url.pathname;
      params = url.pathname.match(x.pattern);
      return !!params;
    });
    if (!r) return send(res, 404, { error: 'not found' });

    let body: Record<string, unknown> = {};
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      const isDelete = req.method === 'DELETE';
      const ct = String(req.headers['content-type'] ?? '').trim();
      const isJsonCt = /^application\/(?:json|[\w.+-]+\+json)(?:\s*;|$)/i.test(ct);
      if ((origin && origin !== `http://${req.headers.host}`) || (!isDelete && !isJsonCt)) {
        return send(res, 403, { error: 'forbidden' });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await read(req, r.limit, isDelete));
      } catch (e) {
        const msg = e instanceof Error ? e.message : '';
        return send(res, msg === 'too large' ? 413 : 400, { error: msg === 'too large' ? '太大了' : '请求体不是合法的 JSON' });
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return send(res, 400, { error: '请求体必须是 JSON 对象' });
      }
      body = parsed as Record<string, unknown>;
    }
    try {
      const out = await r.handler({ req, res, url, params, body });
      if (!res.headersSent && !res.writableEnded && out !== undefined) send(res, 200, out);
    } catch (e) {
      if (res.headersSent) throw e;
      const err = e as HttpErrorLike;
      send(res, err.code === 'CONFLICT' ? 409 : err.status ?? 400, { error: err.message });
    }
  }
}

function read(req: http.IncomingMessage, limit = 512 * 1024, allowEmpty = false): Promise<string> {
  const maxBytes = limit ?? 512 * 1024;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    req.on('data', (d: Buffer | string) => {
      if (done) return;
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(d);
      total += buf.length;
      if (total > maxBytes) {
        done = true;
        reject(new Error('too large'));
        req.resume();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(chunks.length ? Buffer.concat(chunks, total).toString('utf8') : (allowEmpty ? '{}' : ''));
    });
    req.on('error', (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
  });
}

export function send(res: http.ServerResponse, code: number, obj: unknown): void {
  const payload = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(res.req?.method === 'HEAD' ? undefined : payload);
}
