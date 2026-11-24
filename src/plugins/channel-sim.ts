import path from 'node:path';
import { attachTransportTelemetry } from '../core/channel-contract.ts';
import { WebSimTransport } from '../im/sim.ts';
import type { KernelPlugin } from '../types.ts';
import type { WebServer } from '../web/server.ts';

export interface ChannelSimOptions {
  filesDir?: string;
  fileRetentionDays?: number;
  botName?: string;
  historyFile?: string | null;
}

/** 内置 Web 自聊模拟器通道插件（挂载 `/`, `/sim`, `/view`, `/md.js`）。 */
export const channelSimPlugin: KernelPlugin<ChannelSimOptions> = {
  name: 'sim',
  kind: 'channel',
  version: '1.0.0',
  inject: ['web'],
  provides: ['channel'],
  apply(ctx, opts = {}) {
    const cfg = ctx.config;
    const web = ctx.get<WebServer>('web');
    web.page('/', 'index.html');
    web.page('/sim', 'index.html');
    web.page('/view', 'view.html');
    web.asset('/md.js', 'md.js', 'text/javascript');

    const transport = new WebSimTransport({
      web,
      filesDir: opts.filesDir ?? path.join(cfg.dataDir, 'sim-files'),
      fileRetentionDays: opts.fileRetentionDays ?? cfg.selfChat?.fileRetentionDays ?? 7,
      botName: opts.botName ?? cfg.selfChat?.botName ?? 'co-bot',
      ...(opts.historyFile !== undefined ? { historyFile: opts.historyFile } : {}),
    });
    attachTransportTelemetry(transport, (ev, data) => ctx.emit(ev, data), 'sim');
    ctx.provide('channel', transport);
    ctx.effect(() => transport.stop());
    ctx.status(() => transport.status());
  },
};
