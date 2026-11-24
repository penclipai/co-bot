import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ROOT, isPathLikeSpecifier } from '../config.ts';
import { defineChannelPlugin } from '../core/channel-contract.ts';
import type { AppConfig, ChannelPluginSpec, KernelPlugin } from '../types.ts';
import { channelSimPlugin } from './channel-sim.ts';

const BUILTIN_SIM = new Set(['sim', 'web', 'websim', 'builtin:sim']);

export interface ResolvedChannelPlugin {
  plugin: KernelPlugin;
  options: Record<string, unknown>;
  resolvedName: string;
}

/** 解析配置中的目标 IM 通道标识（优先 `overrideUse`，其次 `channel.use`，默认 `sim`）。 */
export function resolveChannelSpec(
  cfg: Pick<AppConfig, 'channel'> | null | undefined,
  overrideUse = '',
): { kind: 'builtin' | 'external'; name: string; spec: string } {
  const raw = String(overrideUse || cfg?.channel?.use || 'sim').trim() || 'sim';
  const low = raw.toLowerCase();
  if (BUILTIN_SIM.has(low)) return { kind: 'builtin', name: 'sim', spec: raw };
  return { kind: 'external', name: raw, spec: raw };
}

/**
 * 动态加载并适配 IM 通道插件：
 *   1. 内置名：sim | web
 *   2. 标准通道插件：`defineChannelPlugin({ name, capabilities, create })` 或 `{ name, apply(ctx, opts) }`
 */
export async function loadChannelPlugin(
  cfg: Pick<AppConfig, 'channel'> | null | undefined,
  { overrideUse = '', baseDir = APP_ROOT }: { overrideUse?: string; baseDir?: string } = {},
): Promise<ResolvedChannelPlugin> {
  const target = resolveChannelSpec(cfg, overrideUse);
  const extraOpts = { ...(cfg?.channel?.options ?? {}) };

  if (target.kind === 'builtin' && target.name === 'sim') {
    return { plugin: channelSimPlugin as KernelPlugin, options: extraOpts, resolvedName: 'sim' };
  }

  let importTarget = target.spec;
  if (isPathLikeSpecifier(target.spec)) {
    const abs = path.isAbsolute(target.spec) ? target.spec : path.resolve(baseDir, target.spec);
    if (!fs.existsSync(abs)) {
      throw new Error(`找不到指定的通道插件文件：${abs}`);
    }
    importTarget = pathToFileURL(abs).href;
  }

  const mod = (await import(importTarget)) as { default?: ChannelPluginSpec } & ChannelPluginSpec;
  const exported = mod?.default ?? mod;

  if (exported && (typeof exported.apply === 'function' || typeof exported.create === 'function')) {
    const plugin = defineChannelPlugin(exported);
    return {
      plugin,
      options: extraOpts,
      resolvedName: plugin.name || 'custom-channel',
    };
  }

  throw new Error(
    `通道模块「${target.spec}」不符合插件契约：需导出 defineChannelPlugin({ name, capabilities, create }) 或 { name, apply(ctx, opts) }`,
  );
}
