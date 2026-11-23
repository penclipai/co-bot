import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 极简 HTTP 服务（零依赖）：主界面 + 管理 API，以及网页模拟器的路由。
 * 默认只监听 127.0.0.1；所有写请求要求同源 + JSON，本机其他网页无法跨站调用。
 */
export class WebServer {
  constructor({ host = '127.0.0.1', port = 8787, publicDir }) {
    Object.assign(this, { host, port, publicDir });
    this.routes = [];
  }

  /** pattern: 字符串精确匹配，或带捕获组的正则。handler(ctx) 返回值会作为 JSON 响应。 */
  route(method, pattern, handler, opts = {}) { this.routes.push({ method, pattern, handler, limit: opts.limit }); }
  hasRoute(method, pattern) {
    return this.routes.some((r) => r.method === method && r.pattern === pattern);
  }
  page(urlPath, file) {
    this.asset(urlPath, file, 'text/html');
  }

  asset(urlPath, file, type) {
    this.route('GET', urlPath, ({ req, res }) => {
      const buf = fs.readFileSync(path.join(this.publicDir, file));
      res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'content-length': buf.length, 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  }

  async start() {
    this.server = http.createServer((req, res) => this.#handle(req, res).catch((e) => {
      console.error('[web]', e);
      if (!res.headersSent) send(res, 500, { error: '服务器内部错误' });
    }));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, resolve);
    });
    console.log(`[web] http://${this.host}:${this.port}`);
  }

  async stop() {
    this.server?.closeAllConnections?.();
    await new Promise((r) => (this.server ? this.server.close(r) : r()));
  }

  async #handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const reqMethod = req.method === 'HEAD' ? 'GET' : req.method;
    let params = null;
    const r = this.routes.find((x) => {
      if (x.method !== reqMethod) return false;
      if (typeof x.pattern === 'string') return x.pattern === url.pathname;
      params = url.pathname.match(x.pattern);
      return !!params;
    });
    if (!r) return send(res, 404, { error: 'not found' });

    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      const isDelete = req.method === 'DELETE';
      const ct = String(req.headers['content-type'] ?? '');
      if ((origin && origin !== `http://${req.headers.host}`) || (!isDelete && !ct.includes('application/json'))) {
        return send(res, 403, { error: 'forbidden' });
      }
      try { body = JSON.parse(await read(req, r.limit)); } catch (e) { return send(res, e.message === 'too large' ? 413 : 400, { error: e.message === 'too large' ? '太大了' : '请求体不是合法的 JSON' }); }
    }
    try {
      const out = await r.handler({ req, res, url, params, body });
      if (!res.headersSent && !res.writableEnded && out !== undefined) send(res, 200, out);
    } catch (e) {
      if (res.headersSent) throw e;
      send(res, e.code === 'CONFLICT' ? 409 : e.status ?? 400, { error: e.message });
    }
  }
}

function read(req, limit = 512 * 1024) {
  limit ??= 512 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    req.on('data', (d) => {
      if (done) return;
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(d);
      total += buf.length;
      if (total > limit) {
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
      resolve(chunks.length ? Buffer.concat(chunks, total).toString('utf8') : '{}');
    });
    req.on('error', (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
  });
}

export function send(res, code, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(res.req?.method === 'HEAD' ? undefined : payload);
}
