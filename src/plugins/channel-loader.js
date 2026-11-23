import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ROOT, isPathLikeSpecifier } from '../config.js';
import { defineChannelPlugin } from '../core/channel-contract.js';
import { channelSimPlugin } from './channel-sim.js';

const BUILTIN_SIM = new Set(['sim', 'web', 'websim', 'builtin:sim']);
const BUILTIN_IPC = new Set(['ipc', 'builtin:ipc']);

/** 解析配置中的目标 IM 通道标识（优先 `overrideUse`，其次 `channel.use`，最后回退兼容 `transport`）。 */
export function resolveChannelSpec(cfg, overrideUse = '') {
  const raw = String(overrideUse || cfg?.channel?.use || cfg?.transport || 'sim').trim() || 'sim';
  const low = raw.toLowerCase();
  if (BUILTIN_SIM.has(low)) return { kind: 'builtin', name: 'sim', spec: raw };
  if (BUILTIN_IPC.has(low)) return { kind: 'builtin', name: 'ipc', spec: raw };
  return { kind: 'external', name: raw, spec: raw };
}

/** 将旧版 `{ connect, send, sendFile?, download?, close?, getMessage?, getHistory?, searchHistory? }` 模块适配为 `defineChannelPlugin`。 */
function wrapLegacyClientPlugin(clientModule = null) {
  return defineChannelPlugin({
    name: 'ipc',
    capabilities: clientModule
      ? {
          files: typeof clientModule.sendFile === 'function',
          images: typeof clientModule.sendFile === 'function',
          history: typeof clientModule.getHistory === 'function'
            || typeof clientModule.getMessage === 'function'
            || typeof clientModule.searchHistory === 'function',
        }
      : undefined,
    create(opts = {}) {
      let c = clientModule ?? opts.clientModule ?? null;
      const resolveClient = async () => {
        if (c) return c;
        if (!opts.client) throw new Error('config.json 的 ipc.client 没填：请指定通道模块路径');
        const abs = path.isAbsolute(opts.client) ? opts.client : path.resolve(APP_ROOT, opts.client);
        if (!fs.existsSync(abs)) throw new Error(`找不到指定的通道模块：${abs}`);
        const mod = await import(pathToFileURL(abs).href);
        c = mod?.default && typeof mod.default.connect === 'function' ? mod.default : mod;
        return c;
      };
      const hasFn = (k) => !clientModule || typeof clientModule[k] === 'function';
      return {
        async start(onMessage, ctx) {
          if (!opts.selfId) throw new Error('config.json 的 ipc.selfId 没填（你在 IM 中的用户 id）');
          const mod = await resolveClient();
          await mod.connect(onMessage, { onDisconnect: ctx?.onDisconnect });
        },
        async send(chatId, text, { replyTo } = {}) {
          const mod = await resolveClient();
          const r = await mod.send({ chatId, text, quoteMsgId: replyTo });
          return r?.msgId != null ? String(r.msgId) : undefined;
        },
        ...(hasFn('sendFile') ? {
          async sendFile(chatId, { path: filePath, name }, { replyTo } = {}) {
            const mod = await resolveClient();
            if (typeof mod.sendFile !== 'function') throw new Error('通道模块没有实现 sendFile');
            const r = await mod.sendFile({ chatId, filePath, fileName: name, quoteMsgId: replyTo });
            return r?.msgId != null ? String(r.msgId) : undefined;
          },
        } : {}),
        ...(hasFn('download') ? {
          async download(att, savePath) {
            const mod = await resolveClient();
            if (typeof mod.download !== 'function') throw new Error('通道模块没有实现 download');
            await mod.download({ msgId: att.msgId, fileId: att.id, savePath });
          },
        } : {}),
        ...(hasFn('getMessage') ? {
          async getMessage(chatId, msgId) {
            const mod = await resolveClient();
            return typeof mod.getMessage === 'function' ? mod.getMessage({ chatId, msgId }) : null;
          },
        } : {}),
        ...(hasFn('getHistory') ? {
          async getHistory(chatId, qOpts = {}) {
            const mod = await resolveClient();
            return typeof mod.getHistory === 'function' ? mod.getHistory({ chatId, ...qOpts }) : [];
          },
        } : {}),
        ...(hasFn('searchHistory') ? {
          async searchHistory(chatId, query, qOpts = {}) {
            const mod = await resolveClient();
            return typeof mod.searchHistory === 'function' ? mod.searchHistory({ chatId, query, ...qOpts }) : [];
          },
        } : {}),
        async stop() {
          await c?.close?.();
        },
      };
    },
  });
}

/**
 * 动态加载并适配 IM 通道插件：
 *   1. 内置名：sim | web
 *   2. 标准通道插件：`defineChannelPlugin({ name, capabilities, create })` 或 `{ name, apply(ctx, opts) }`
 *   3. 向后兼容旧版 `connect` + `send` 模块（自动纳入 `ManagedChannel` 托管）
 */
export async function loadChannelPlugin(cfg, { overrideUse = '', baseDir = APP_ROOT } = {}) {
  const target = resolveChannelSpec(cfg, overrideUse);
  const extraOpts = { ...(cfg?.channel?.options ?? {}) };

  if (target.kind === 'builtin' && target.name === 'sim') {
    return { plugin: channelSimPlugin, options: extraOpts, resolvedName: 'sim' };
  }
  if (target.kind === 'builtin' && target.name === 'ipc') {
    const ipcOpts = { ...(cfg?.ipc ?? {}), ...extraOpts };
    let staticClient = ipcOpts.clientModule ?? null;
    if (!staticClient && ipcOpts.client) {
      const abs = path.isAbsolute(ipcOpts.client) ? ipcOpts.client : path.resolve(baseDir, ipcOpts.client);
      if (fs.existsSync(abs)) {
        const mod = await import(pathToFileURL(abs).href);
        staticClient = typeof mod?.default?.connect === 'function' ? mod.default : mod;
      }
    }
    return {
      plugin: wrapLegacyClientPlugin(staticClient),
      options: ipcOpts,
      resolvedName: 'ipc',
    };
  }

  let importTarget = target.spec;
  if (isPathLikeSpecifier(target.spec)) {
    const abs = path.isAbsolute(target.spec) ? target.spec : path.resolve(baseDir, target.spec);
    if (!fs.existsSync(abs)) {
      throw new Error(`找不到指定的通道插件文件：${abs}`);
    }
    importTarget = pathToFileURL(abs).href;
  }

  const mod = await import(importTarget);
  const exported = mod?.default ?? mod;
  const legacyClient = typeof exported?.connect === 'function' && typeof exported?.send === 'function'
    ? exported
    : (typeof mod?.connect === 'function' && typeof mod?.send === 'function' ? mod : null);

  if (exported && (typeof exported.apply === 'function' || typeof exported.create === 'function')) {
    const plugin = defineChannelPlugin(exported);
    return {
      plugin,
      options: extraOpts,
      resolvedName: plugin.name,
    };
  }

  if (legacyClient) {
    return {
      plugin: wrapLegacyClientPlugin(legacyClient),
      options: { ...(cfg?.ipc ?? {}), ...extraOpts, clientModule: legacyClient },
      resolvedName: 'ipc',
    };
  }

  throw new Error(
    `通道模块「${target.spec}」不符合插件契约：需导出 defineChannelPlugin({ name, capabilities, create })、` +
    `{ name, apply(ctx, opts) } 或旧版 { connect, send }`,
  );
}
