import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ROOT, isPathLikeSpecifier } from '../config.ts';
import { defineChannelPlugin } from '../core/channel-contract.ts';
import {
  type DiscoverPluginsResult,
  discoverPlugins,
  importFreshModule,
  normalizePluginModule,
  resolvePluginConfig,
  resolvePluginEntryFile,
} from '../core/plugin-loader.ts';
import type { AppConfig, ChannelPluginSpec, KernelPlugin } from '../types.ts';
import { channelSimPlugin } from './channel-sim.ts';

const BUILTIN_SIM = new Set(['sim', 'web', 'websim', 'builtin:sim']);

export interface ResolvedChannelPlugin {
  plugin: KernelPlugin;
  options: Record<string, unknown>;
  resolvedName: string;
}

/** 解析配置中的目标 IM 通道标识（优先 `overrideUse`，其次 `channel.use`，默认 `sim`；支持 `auto`）。 */
export function resolveChannelSpec(
  cfg: Pick<AppConfig, 'channel'> | null | undefined,
  overrideUse = '',
): { kind: 'builtin' | 'auto' | 'external'; name: string; spec: string } {
  const raw = String(overrideUse || cfg?.channel?.use || 'sim').trim() || 'sim';
  const low = raw.toLowerCase();
  if (BUILTIN_SIM.has(low)) return { kind: 'builtin', name: 'sim', spec: raw };
  if (low === 'auto') return { kind: 'auto', name: 'auto', spec: raw };
  return { kind: 'external', name: raw, spec: raw };
}

/**
 * 动态加载并适配 IM 通道插件：
 *   1. 内置名：sim | web
 *   2. 自动选择（`channel.use: "auto"`）：`plugins/` 下恰有 1 个通道插件时自动启用，0 个回退 `sim`，多个时显式报错
 *   3. `plugins/` 目录按插件名匹配
 *   4. 显式文件路径（如 `./im-plugin.ts`）或 npm 包名
 */
export async function loadChannelPlugin(
  cfg: Partial<Pick<AppConfig, 'channel' | 'pluginsDir' | 'plugins'>> | null | undefined,
  {
    overrideUse = '',
    baseDir = APP_ROOT,
    discovered = null,
  }: {
    overrideUse?: string;
    baseDir?: string;
    discovered?: DiscoverPluginsResult | null;
  } = {},
): Promise<ResolvedChannelPlugin> {
  const target = resolveChannelSpec(cfg as Pick<AppConfig, 'channel'> | undefined, overrideUse);
  const chanOpts = { ...(cfg?.channel?.options ?? {}) };

  if (target.kind === 'builtin' && target.name === 'sim') {
    return { plugin: channelSimPlugin as KernelPlugin, options: chanOpts, resolvedName: 'sim' };
  }

  const scanDir = cfg?.pluginsDir !== undefined ? String(cfg.pluginsDir) : path.join(baseDir, 'plugins');
  const disc = discovered ?? (scanDir ? await discoverPlugins(scanDir) : null);

  if (target.kind === 'auto') {
    if (disc && disc.channels.size > 1) {
      const names = [...disc.channels.keys()].join('、');
      throw new Error(`plugins 目录发现多个通道插件（${names}），请在 config.json 的 channel.use 或 --channel 中明确指定其中一个`);
    }
    if (disc && disc.channels.size === 1) {
      const sole = [...disc.channels.values()][0];
      const pCfg = resolvePluginConfig(cfg, sole.name);
      return {
        plugin: sole.plugin,
        options: { ...pCfg.options, ...chanOpts },
        resolvedName: sole.name,
      };
    }
    return { plugin: channelSimPlugin as KernelPlugin, options: chanOpts, resolvedName: 'sim' };
  }

  if (disc) {
    const exact = disc.channels.get(target.spec)
      ?? [...disc.channels.values()].find((c) => c.name.toLowerCase() === target.spec.toLowerCase());
    if (exact) {
      const pCfg = resolvePluginConfig(cfg, exact.name);
      return {
        plugin: exact.plugin,
        options: { ...pCfg.options, ...chanOpts },
        resolvedName: exact.name,
      };
    }
    const loadErr = disc.errors.find((e) => e.name.toLowerCase() === target.spec.toLowerCase());
    if (loadErr) {
      throw new Error(`通道插件「${target.spec}」加载失败（${loadErr.source}）：${loadErr.error}`);
    }
  }

  let importTarget = target.spec;
  let sourceLabel = target.spec;
  if (isPathLikeSpecifier(target.spec)) {
    const abs = path.isAbsolute(target.spec) ? target.spec : path.resolve(baseDir, target.spec);
    if (!fs.existsSync(abs)) {
      throw new Error(`找不到指定的通道插件文件：${abs}`);
    }
    const stat = fs.statSync(abs);
    const entry = stat.isDirectory() ? resolvePluginEntryFile(abs) : abs;
    if (!entry) {
      throw new Error(`找不到指定的通道插件入口文件：${abs}`);
    }
    sourceLabel = entry;
    importTarget = pathToFileURL(entry).href;
  }

  const mod = await (importTarget.startsWith('file://')
    ? importFreshModule(sourceLabel)
    : (import(importTarget) as Promise<Record<string, unknown>>));
  const defSpec = (mod?.default ?? mod) as ChannelPluginSpec | undefined;
  if (defSpec && (typeof defSpec.create === 'function' || typeof defSpec.apply === 'function')) {
    const plugin = normalizePluginModule(mod, { fallbackName: 'custom-channel', source: sourceLabel });
    if (plugin.kind === 'extension') plugin.kind = 'channel';
    return {
      plugin: typeof defSpec.create === 'function'
        ? defineChannelPlugin({ ...defSpec, source: sourceLabel })
        : plugin,
      options: chanOpts,
      resolvedName: plugin.name || 'custom-channel',
    };
  }

  throw new Error(
    `通道模块「${target.spec}」不符合插件契约：需导出 defineChannelPlugin({ name, capabilities, create }) 或 { name, apply(ctx, opts) }`,
  );
}
