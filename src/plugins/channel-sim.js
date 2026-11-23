import path from 'node:path';
import { attachTransportTelemetry } from '../core/channel-contract.js';
import { WebSimTransport } from '../im/sim.js';

/** 内置 Web 自聊模拟器通道插件（挂载 `/`, `/sim`, `/view`, `/md.js`）。 */
export const channelSimPlugin = {
  name: 'sim',
  kind: 'channel',
  version: '1.0.0',
  inject: ['web'],
  provides: ['channel'],
  apply(ctx, opts = {}) {
    const cfg = ctx.config;
    const web = ctx.get('web');
    web.page('/', 'index.html');
    web.page('/sim', 'index.html');
    web.page('/view', 'view.html');
    web.asset('/md.js', 'md.js', 'text/javascript');

    const transport = new WebSimTransport({
      web,
      filesDir: opts.filesDir ?? path.join(cfg.dataDir, 'sim-files'),
      fileRetentionDays: opts.fileRetentionDays ?? cfg.selfChat?.fileRetentionDays ?? 7,
      ...(opts.historyFile !== undefined ? { historyFile: opts.historyFile } : {}),
    });
    attachTransportTelemetry(transport, (ev, data) => ctx.emit(ev, data), 'sim');
    ctx.provide('channel', transport);
    ctx.effect(() => transport.stop());
    ctx.status(() => transport.status());
  },
};
