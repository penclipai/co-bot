/**
 * `plugins/` 目录式插件发现、Cordis 同构模块契约归一化与运行期热重载管理。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineChannelPlugin } from './channel-contract.ts';
import { Kernel } from './kernel.ts';
import type {
  AppConfig,
  ChannelPluginSpec,
  KernelPlugin,
  KernelPluginStatus,
  LoggerLike,
  PluginConfigEntry,
  PluginManagerService,
} from '../types.ts';

let reloadSeq = 0;

export interface DiscoveredPluginRecord {
  name: string;
  kind: string;
  source: string;
  plugin: KernelPlugin;
}

export interface PluginLoadErrorRecord {
  name: string;
  source: string;
  error: string;
}

export interface DiscoverPluginsResult {
  dir: string;
  plugins: DiscoveredPluginRecord[];
  channels: Map<string, DiscoveredPluginRecord>;
  extensions: DiscoveredPluginRecord[];
  errors: PluginLoadErrorRecord[];
}

function asPlainObj(val: unknown): Record<string, unknown> | null {
  return val && typeof val === 'object' && !Array.isArray(val) ? (val as Record<string, unknown>) : null;
}

/** 判断文件名是否为合法的插件模块文件（排除类型声明与测试文件）。 */
function isPluginFileName(name: string): boolean {
  const lower = String(name || '').toLowerCase();
  if (!lower || lower.startsWith('.') || lower.startsWith('_')) return false;
  if (lower.endsWith('.d.ts') || lower.includes('.test.') || lower.includes('.spec.')) return false;
  return /\.(?:[cm]?[jt]s)$/i.test(lower);
}

/** 将文件路径转成带可选 cache-bust 参数的 file URL 并执行 ESM 动态导入。 */
export async function importFreshModule(
  absPath: string,
  { bustCache = false }: { bustCache?: boolean } = {},
): Promise<Record<string, unknown>> {
  const href = pathToFileURL(path.resolve(absPath)).href;
  const spec = bustCache ? `${href}?v=${Date.now()}_${++reloadSeq}` : href;
  return (await import(spec)) as Record<string, unknown>;
}

/** 解析子目录插件的入口文件（优先 package.json main / exports['.']，其次 index.ts/js）。 */
export function resolvePluginEntryFile(dirPath: string): string | null {
  const pkgPath = path.join(dirPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
        main?: unknown;
        exports?: unknown;
      };
      let candidate = '';
      const exp = pkg.exports;
      if (typeof exp === 'string') {
        candidate = exp;
      } else if (exp && typeof exp === 'object') {
        const dot = (exp as Record<string, unknown>)['.'];
        if (typeof dot === 'string') {
          candidate = dot;
        } else if (dot && typeof dot === 'object') {
          const dotObj = dot as Record<string, unknown>;
          const picked = dotObj.import ?? dotObj.default;
          if (typeof picked === 'string') candidate = picked;
        }
      }
      if (!candidate && typeof pkg.main === 'string') {
        candidate = pkg.main;
      }
      if (candidate) {
        const abs = path.resolve(dirPath, candidate);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
      }
    } catch {
      return null;
    }
  }
  for (const name of ['index.ts', 'index.mts', 'index.js', 'index.mjs']) {
    const abs = path.join(dirPath, name);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  }
  return null;
}

/**
 * 将插件模块（Cordis 命名导出 / `definePlugin` / `defineChannelPlugin` / 默认函数）归一化为标准 `KernelPlugin`。
 */
export function normalizePluginModule(
  mod: unknown,
  { fallbackName = 'custom-plugin', source = 'builtin' }: { fallbackName?: string; source?: string } = {},
): KernelPlugin {
  const m = asPlainObj(mod);
  if (!m) {
    throw new Error('插件模块没有有效导出');
  }

  const def = m.default;
  if (typeof def === 'function') {
    const fnName = (def as { name?: string }).name;
    const resolvedName = (typeof m.name === 'string' && m.name.trim())
      || (fnName && fnName !== 'default' ? fnName : '')
      || fallbackName;
    return {
      name: resolvedName,
      kind: typeof m.kind === 'string' ? m.kind : 'extension',
      version: typeof m.version === 'string' ? m.version : '1.0.0',
      provides: Array.isArray(m.provides) || typeof m.provides === 'string' ? (m.provides as string | string[]) : undefined,
      inject: m.inject as KernelPlugin['inject'],
      source,
      apply: def as KernelPlugin['apply'],
    };
  }

  const defObj = asPlainObj(def);
  if (defObj && (typeof defObj.create === 'function' || typeof defObj.apply === 'function')) {
    const spec = {
      ...defObj,
      name: String(defObj.name || fallbackName),
      source,
    } as ChannelPluginSpec & KernelPlugin;
    if (typeof spec.create === 'function') {
      return defineChannelPlugin(spec);
    }
    return {
      kind: 'extension',
      version: '1.0.0',
      ...spec,
      apply: spec.apply,
    };
  }

  if (typeof m.apply === 'function' || typeof m.create === 'function') {
    const spec = {
      ...(typeof m.name === 'string' && m.name.trim() ? { name: m.name.trim() } : { name: fallbackName }),
      ...(typeof m.kind === 'string' && m.kind.trim() ? { kind: m.kind.trim() } : {}),
      ...(typeof m.version === 'string' && m.version.trim() ? { version: m.version.trim() } : {}),
      ...(m.provides !== undefined ? { provides: m.provides as string[] } : {}),
      ...(m.inject !== undefined ? { inject: m.inject as KernelPlugin['inject'] } : {}),
      ...(m.capabilities !== undefined ? { capabilities: m.capabilities as ChannelPluginSpec['capabilities'] } : {}),
      ...(m.reconnectDelayMs !== undefined ? { reconnectDelayMs: Number(m.reconnectDelayMs) } : {}),
      ...(m.maxReconnectDelayMs !== undefined ? { maxReconnectDelayMs: Number(m.maxReconnectDelayMs) } : {}),
      ...(typeof m.create === 'function' ? { create: m.create as ChannelPluginSpec['create'] } : {}),
      ...(typeof m.apply === 'function' ? { apply: m.apply as KernelPlugin['apply'] } : {}),
      source,
    };
    if (typeof spec.create === 'function') {
      return defineChannelPlugin(spec as ChannelPluginSpec);
    }
    return {
      kind: 'extension',
      version: '1.0.0',
      ...spec,
      apply: spec.apply as KernelPlugin['apply'],
    };
  }

  throw new Error('插件必须导出 apply(ctx, opts)、create(opts, ctx) 或 default 函数/插件对象');
}

/** 读取 `config.plugins[name]` 开关与插件私有配置项。 */
export function resolvePluginConfig(
  cfg: Pick<AppConfig, 'plugins'> | { plugins?: Record<string, PluginConfigEntry> } | null | undefined,
  name: string,
): { enabled: boolean; options: Record<string, unknown> } {
  const entry = cfg?.plugins?.[name];
  if (entry === false) return { enabled: false, options: {} };
  if (entry === true || entry == null) return { enabled: true, options: {} };
  const rec = asPlainObj(entry);
  if (!rec) return { enabled: true, options: {} };
  const { enabled, ...rest } = rec;
  return {
    enabled: enabled !== false,
    options: rest,
  };
}

/** 扫描 `pluginsDir` 下的全部文件与子目录插件（按名字母序），区分通道与扩展插件并隔离单文件故障。 */
export async function discoverPlugins(
  pluginsDir: string,
  { logger = console }: { logger?: LoggerLike } = {},
): Promise<DiscoverPluginsResult> {
  const result: DiscoverPluginsResult = {
    dir: pluginsDir,
    plugins: [],
    channels: new Map(),
    extensions: [],
    errors: [],
  };
  if (!pluginsDir || !fs.existsSync(pluginsDir)) return result;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(pluginsDir);
  } catch {
    return result;
  }
  if (!stat.isDirectory()) return result;

  const dirents = fs.readdirSync(pluginsDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));

  const seenNames = new Map<string, string>();

  for (const dirent of dirents) {
    const entryName = dirent.name;
    if (entryName.startsWith('.') || entryName.startsWith('_') || entryName === 'node_modules') continue;

    let entryFile: string | null;
    let fallbackName: string;
    const fullPath = path.join(pluginsDir, entryName);

    let isFile = dirent.isFile();
    let isDir = dirent.isDirectory();
    if (dirent.isSymbolicLink()) {
      try {
        const targetStat = fs.statSync(fullPath);
        isFile = targetStat.isFile();
        isDir = targetStat.isDirectory();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn?.(`[co-bot:plugins] 跳过无效符号链接「${fullPath}」：${msg}`);
        result.errors.push({ name: entryName, source: fullPath, error: msg });
        continue;
      }
    }

    if (isFile) {
      if (!isPluginFileName(entryName)) continue;
      entryFile = fullPath;
      fallbackName = entryName.replace(/\.(?:[cm]?[jt]s)$/i, '');
    } else if (isDir) {
      entryFile = resolvePluginEntryFile(fullPath);
      if (!entryFile) continue;
      fallbackName = entryName;
    } else {
      continue;
    }

    let plugin: KernelPlugin;
    try {
      const mod = await importFreshModule(entryFile);
      plugin = normalizePluginModule(mod, { fallbackName, source: entryFile });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn?.(`[co-bot:plugins] 加载插件「${entryFile}」失败：${msg}`);
      result.errors.push({ name: fallbackName || entryName, source: entryFile, error: msg });
      continue;
    }

    const name = String(plugin.name || fallbackName);
    const prevSource = seenNames.get(name);
    if (prevSource) {
      throw new Error(`发现重名插件「${name}」：${prevSource} 与 ${entryFile}`);
    }
    seenNames.set(name, entryFile);

    const record: DiscoveredPluginRecord = {
      name,
      kind: plugin.kind || 'extension',
      source: entryFile,
      plugin: { ...plugin, name, source: entryFile },
    };
    result.plugins.push(record);
    if (record.kind === 'channel') {
      result.channels.set(name, record);
    } else {
      result.extensions.push(record);
    }
  }

  return result;
}

/** 创建运行期插件管理器（供 `/api/debug/action` 执行单个外部扩展插件热重载）。 */
export function createPluginManager(kernel: Kernel, cfg: Pick<AppConfig, 'plugins'>): PluginManagerService {
  const listReloadable = (): string[] => (
    kernel.status().plugins.filter((p) => p.reloadable).map((p) => p.name)
  );

  const reloadPlugin = async (name: string): Promise<KernelPluginStatus> => {
    const targetName = String(name || '').trim();
    if (!targetName) throw new Error('缺少插件名 name');
    const meta = kernel.getEntryMeta(targetName);
    if (!meta) throw new Error(`插件「${targetName}」不存在`);
    if (meta.source === 'builtin' || meta.kind === 'core' || meta.kind === 'channel') {
      throw new Error(`插件「${targetName}」（${meta.kind}）不支持运行期热重载`);
    }
    if (!fs.existsSync(meta.source)) {
      throw new Error(`找不到插件文件：${meta.source}`);
    }

    const mod = await importFreshModule(meta.source, { bustCache: true });
    const nextPlugin = normalizePluginModule(mod, { fallbackName: targetName, source: meta.source });
    const { options } = resolvePluginConfig(cfg, targetName);
    const st = await kernel.reload(targetName, { ...nextPlugin, name: targetName, source: meta.source }, options);
    kernel.emit('bridge:event', {
      type: 'plugin_reloaded',
      ts: Date.now(),
      summary: `reloaded:${targetName}`,
    });
    return st;
  };

  return { reloadPlugin, listReloadable };
}
