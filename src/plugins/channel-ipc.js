import { attachTransportTelemetry } from '../core/channel-contract.js';
import { IpcTransport } from '../im/ipc.js';

/** 内置 IPC 通道插件（兼容现有 `config.ipc.client` 与 `ipc-client.js` 契约）。 */
export const channelIpcPlugin = {
  name: 'ipc',
  kind: 'channel',
  version: '1.0.0',
  provides: ['channel'],
  apply(ctx, opts = {}) {
    const merged = { ...(ctx.config?.ipc ?? {}), ...(opts ?? {}) };
    const transport = new IpcTransport(merged);
    attachTransportTelemetry(transport, (ev, data) => ctx.emit(ev, data), 'ipc');
    ctx.provide('channel', transport);
    ctx.effect(() => transport.stop());
    ctx.status(() => transport.status());
  },
};
