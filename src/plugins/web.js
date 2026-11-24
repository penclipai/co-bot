import path from 'node:path';
import { APP_ROOT } from '../config.js';
import { WebServer } from '../web/server.js';

/** 内置本地 HTTP 服务插件（提供 `web` 服务与 `/api/health`）。 */
export const webPlugin = {
  name: 'web',
  kind: 'core',
  version: '1.0.0',
  provides: ['web'],
  async apply(ctx) {
    const cfg = ctx.config;
    const web = new WebServer({ ...cfg.web, publicDir: path.join(APP_ROOT, 'public') });
    web.route('GET', '/api/health', () => ({ ok: true, app: 'co-bot', channel: cfg.channel?.use || 'sim' }));
    await web.start();
    ctx.provide('web', web);
    ctx.effect(() => web.stop());
    ctx.status(() => ({
      host: cfg.web?.host ?? '127.0.0.1',
      port: web.server?.address()?.port ?? cfg.web?.port ?? 8787,
    }));
  },
};
