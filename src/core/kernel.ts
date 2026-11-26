/**
 * 轻量级零依赖插件微内核（灵感源自 Cordis）：
 *   - provides / inject（含 required / optional）声明式依赖解析与拓扑挂载
 *   - effect / on / provide / SCOPED_SERVICE 可逆副作用管理（失败自动回滚，stop 严格逆序卸载）
 *   - 进程内安全事件总线（监听器异常隔离，支持单插件运行期 mount / unmount / reload）
 */
import type {
  AppConfig,
  KernelContext,
  KernelLike,
  KernelPlugin,
  KernelPluginStatus,
  LoggerLike,
  PluginFactory,
  PluginInjectSpec,
  RawConfig,
} from '../types.ts';

/** 供扩展服务实现“按调用方插件作用域自动回收”机制的符号协议。 */
export const SCOPED_SERVICE = Symbol('co-bot.scopedService');

export interface ScopedServiceProvider<T = unknown> {
  [SCOPED_SERVICE]: (ctx: KernelContext) => T;
}

/** 声明一个 Cordis 风格 Kernel 插件（提供完整 TypeScript 类型推断）。 */
export function definePlugin<TOptions = Record<string, unknown>>(
  spec: KernelPlugin<TOptions>,
): KernelPlugin<TOptions> {
  return spec;
}

interface KernelEntry<TOptions = Record<string, unknown>> {
  name: string;
  kind: string;
  version: string;
  source: string;
  isolated: boolean;
  loadOnlyError: boolean;
  provides: string[];
  inject: string[];
  optionalInject: string[];
  apply: (ctx: KernelContext, options: TOptions) => Promise<(() => unknown) | void> | (() => unknown) | void;
  options: TOptions;
  active: boolean;
  error: string | null;
  effects: Array<() => unknown>;
  statusProvider: (() => unknown) | null;
}

function toList(val: string | string[] | undefined): string[] {
  if (!val) return [];
  return Array.isArray(val) ? val.filter(Boolean).map(String) : [String(val)];
}

/** 解析插件依赖声明（支持字符串、数组或 `{ required, optional }` 对象）。 */
export function parseInject(spec: PluginInjectSpec | undefined): { required: string[]; optional: string[] } {
  if (!spec) return { required: [], optional: [] };
  if (typeof spec === 'string' || Array.isArray(spec)) {
    return { required: toList(spec), optional: [] };
  }
  return {
    required: toList(spec.required),
    optional: toList(spec.optional),
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Kernel implements KernelLike {
  config: AppConfig;
  logger: LoggerLike;
  services: Map<string, unknown>;
  listeners: Map<string, Set<(payload: unknown) => unknown>>;
  entries: Array<KernelEntry<Record<string, unknown>>>;
  mounted: Array<KernelEntry<Record<string, unknown>>>;
  started: boolean;
  #runGen = 0;

  constructor({ config = {}, logger = console }: { config?: Partial<AppConfig> | RawConfig; logger?: LoggerLike } = {}) {
    this.config = config as AppConfig;
    this.logger = logger;
    this.services = new Map();
    this.listeners = new Map();
    this.entries = [];
    this.mounted = [];
    this.started = false;
  }

  has(name: string): boolean {
    return this.services.has(name);
  }

  get<T = unknown>(name: string): T {
    if (!this.services.has(name)) {
      throw new Error(`服务未注册：${name}`);
    }
    return this.services.get(name) as T;
  }

  provide<T>(name: string, value: T): () => void {
    this.services.set(name, value);
    return () => {
      if (this.services.get(name) === value) {
        this.services.delete(name);
      }
    };
  }

  on(eventName: string, handler: (payload: unknown) => unknown): () => void {
    if (typeof handler !== 'function') return () => {};
    let set = this.listeners.get(eventName);
    if (!set) {
      set = new Set();
      this.listeners.set(eventName, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.listeners.delete(eventName);
    };
  }

  emit(eventName: string, payload?: unknown): void {
    const set = this.listeners.get(eventName);
    if (!set?.size) return;
    for (const handler of [...set]) {
      try {
        const res = handler(payload);
        if (res && typeof (res as Promise<unknown>).catch === 'function') {
          (res as Promise<unknown>).catch((e: unknown) => {
            this.logger.warn?.(`[kernel:${eventName}]`, errMsg(e));
          });
        }
      } catch (e) {
        this.logger.warn?.(`[kernel:${eventName}]`, errMsg(e));
      }
    }
  }

  #buildEntry<TOptions>(
    plugin: KernelPlugin<TOptions> | PluginFactory<TOptions>,
    options: TOptions = {} as TOptions,
  ): KernelEntry<Record<string, unknown>> {
    const def = typeof plugin === 'function'
      ? { name: plugin.name || `plugin-${this.entries.length + 1}`, apply: plugin }
      : plugin;
    if (!def || typeof def.apply !== 'function') {
      throw new Error('插件必须导出 apply(ctx, options) 方法或为函数');
    }
    const name = String(def.name || `plugin-${this.entries.length + 1}`);
    const parsedInject = parseInject(def.inject);
    return {
      name,
      kind: def.kind || 'plugin',
      version: def.version || '1.0.0',
      source: def.source || 'builtin',
      isolated: Boolean(def.isolated),
      loadOnlyError: false,
      provides: toList(def.provides),
      inject: parsedInject.required,
      optionalInject: parsedInject.optional,
      apply: def.apply as (ctx: KernelContext, options: Record<string, unknown>) => Promise<(() => unknown) | void> | (() => unknown) | void,
      options: (options ?? {}) as Record<string, unknown>,
      active: false,
      error: null,
      effects: [],
      statusProvider: null,
    };
  }

  use<TOptions = Record<string, unknown>>(
    plugin: KernelPlugin<TOptions> | PluginFactory<TOptions>,
    options: TOptions = {} as TOptions,
  ): this {
    const entry = this.#buildEntry(plugin, options);
    if (this.entries.some((e) => e.name === entry.name)) {
      throw new Error(`插件名重复：${entry.name}`);
    }
    this.entries.push(entry);
    return this;
  }

  /** 记录目录发现阶段加载失败的隔离插件，便于在 `/api/status` 与 `/debug` 展示诊断信息。 */
  recordLoadError({
    name,
    kind = 'extension',
    source,
    error,
  }: {
    name: string;
    kind?: string;
    source: string;
    error: string;
  }): void {
    const existing = this.entries.find((e) => e.name === name);
    if (existing) {
      existing.error = error;
      existing.source = source;
      existing.loadOnlyError = true;
      return;
    }
    this.entries.push({
      name,
      kind,
      version: '0.0.0',
      source,
      isolated: true,
      loadOnlyError: true,
      provides: [],
      inject: [],
      optionalInject: [],
      apply() {},
      options: {},
      active: false,
      error,
      effects: [],
      statusProvider: null,
    });
  }

  getEntryMeta(name: string): {
    name: string;
    kind: string;
    source: string;
    isolated: boolean;
    active: boolean;
    error: string | null;
  } | null {
    const entry = this.entries.find((e) => e.name === name);
    if (!entry) return null;
    return {
      name: entry.name,
      kind: entry.kind,
      source: entry.source,
      isolated: entry.isolated,
      active: entry.active,
      error: entry.error,
    };
  }

  #createPluginContext(entry: KernelEntry<Record<string, unknown>>): KernelContext {
    const ctx: KernelContext = {
      config: this.config,
      kernel: this,
      logger: this.logger,
      has: (k) => this.has(k),
      get: <T = unknown>(k: string) => {
        const svc = this.get<unknown>(k);
        if (svc && (typeof svc === 'object' || typeof svc === 'function') && SCOPED_SERVICE in (svc as object)) {
          return (svc as ScopedServiceProvider<T>)[SCOPED_SERVICE](ctx);
        }
        return svc as T;
      },
      provide: <T>(k: string, v: T) => {
        const revoke = this.provide(k, v);
        entry.effects.push(revoke);
        return v;
      },
      effect: (fn) => {
        if (typeof fn === 'function') entry.effects.push(fn);
        return fn;
      },
      on: (ev, handler) => {
        const off = this.on(ev, handler);
        entry.effects.push(off);
        return off;
      },
      emit: (ev, payload) => this.emit(ev, payload),
      status: (fn) => {
        if (typeof fn === 'function') entry.statusProvider = fn;
      },
    };
    return ctx;
  }

  #resolveOrder(): Array<KernelEntry<Record<string, unknown>>> {
    const activeEntries = this.entries.filter((e) => !e.loadOnlyError);
    const excluded = new Set<KernelEntry<Record<string, unknown>>>();

    let changed = true;
    while (changed) {
      changed = false;
      const providerOf = new Map<string, string>();
      for (const entry of activeEntries) {
        if (excluded.has(entry)) continue;
        for (const svc of entry.provides) {
          if (!providerOf.has(svc)) providerOf.set(svc, entry.name);
        }
      }
      for (const entry of activeEntries) {
        if (excluded.has(entry)) continue;
        for (const dep of entry.inject) {
          if (!this.services.has(dep) && !providerOf.has(dep)) {
            if (entry.isolated) {
              entry.error = `缺少依赖服务：${dep}`;
              this.logger.warn?.(`[kernel:plugin:${entry.name}] 已隔离跳过：${entry.error}`);
              excluded.add(entry);
              changed = true;
              break;
            }
            throw new Error(`插件「${entry.name}」缺少依赖服务：${dep}`);
          }
        }
      }
    }

    const mountable = activeEntries.filter((e) => !excluded.has(e));
    const mountableProviders = new Set<string>();
    for (const entry of mountable) {
      for (const svc of entry.provides) mountableProviders.add(svc);
    }

    const available = new Set(this.services.keys());
    const remaining = [...mountable];
    const ordered: Array<KernelEntry<Record<string, unknown>>> = [];
    while (remaining.length) {
      let idx = remaining.findIndex((e) => (
        e.inject.every((dep) => available.has(dep))
        && e.optionalInject.every((dep) => !mountableProviders.has(dep) || available.has(dep))
      ));
      if (idx < 0) {
        idx = remaining.findIndex((e) => e.inject.every((dep) => available.has(dep)));
      }
      if (idx < 0) {
        const names = remaining.map((e) => e.name).join('、');
        throw new Error(`检测到插件循环依赖：${names}`);
      }
      const [picked] = remaining.splice(idx, 1);
      ordered.push(picked);
      for (const svc of picked.provides) available.add(svc);
    }
    return ordered;
  }

  async #unmount(entry: KernelEntry<Record<string, unknown>>): Promise<void> {
    entry.active = false;
    entry.statusProvider = null;
    const fns = entry.effects.splice(0).reverse();
    for (const fn of fns) {
      try {
        await fn();
      } catch (e) {
        this.logger.warn?.(`[kernel:stop:${entry.name}]`, errMsg(e));
      }
    }
  }

  async #mountEntry(entry: KernelEntry<Record<string, unknown>>, gen: number): Promise<boolean> {
    for (const dep of entry.inject) {
      if (!this.services.has(dep)) {
        throw new Error(`插件「${entry.name}」缺少依赖服务：${dep}`);
      }
    }
    entry.error = null;
    const ctx = this.#createPluginContext(entry);
    const ret = await entry.apply(ctx, entry.options);
    if (typeof ret === 'function') entry.effects.push(ret);
    if (this.#runGen !== gen) {
      await this.#unmount(entry);
      return false;
    }
    for (const svc of entry.provides) {
      if (!this.services.has(svc)) {
        throw new Error(`插件「${entry.name}」声明提供服务「${svc}」但未调用 ctx.provide()`);
      }
    }
    entry.active = true;
    this.mounted.push(entry);
    return true;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const gen = ++this.#runGen;
    const ordered = this.#resolveOrder();
    for (const entry of ordered) {
      if (this.#runGen !== gen) {
        await this.stop();
        return;
      }
      try {
        const ok = await this.#mountEntry(entry, gen);
        if (!ok) {
          await this.stop();
          return;
        }
      } catch (err) {
        await this.#unmount(entry);
        if (entry.isolated) {
          entry.error = errMsg(err);
          this.logger.warn?.(`[kernel:plugin:${entry.name}] 启动失败已隔离：${entry.error}`);
          continue;
        }
        await this.stop();
        throw err;
      }
    }
    if (this.#runGen === gen) this.started = true;
  }

  /** 在运行时挂载一个新插件（Kernel 未启动时等同于 `use()`）。 */
  async mount<TOptions = Record<string, unknown>>(
    plugin: KernelPlugin<TOptions> | PluginFactory<TOptions>,
    options: TOptions = {} as TOptions,
  ): Promise<void> {
    if (!this.started) {
      this.use(plugin, options);
      return;
    }
    const entry = this.#buildEntry(plugin, options);
    if (this.entries.some((e) => e.name === entry.name)) {
      throw new Error(`插件名重复：${entry.name}`);
    }
    for (const dep of entry.inject) {
      if (!this.services.has(dep)) {
        const msg = `插件「${entry.name}」缺少依赖服务：${dep}`;
        if (entry.isolated) {
          entry.error = msg;
          this.entries.push(entry);
          this.logger.warn?.(`[kernel:plugin:${entry.name}] 挂载失败：${msg}`);
          return;
        }
        throw new Error(msg);
      }
    }
    this.entries.push(entry);
    const gen = this.#runGen;
    try {
      await this.#mountEntry(entry, gen);
    } catch (err) {
      await this.#unmount(entry);
      entry.error = errMsg(err);
      if (!entry.isolated) {
        const idx = this.entries.indexOf(entry);
        if (idx >= 0) this.entries.splice(idx, 1);
      }
      throw err;
    }
  }

  /** 按插件名卸载已挂载插件并回收其全部副作用。 */
  async unmount(name: string, { keepEntry = false }: { keepEntry?: boolean } = {}): Promise<boolean> {
    const idx = this.entries.findIndex((e) => e.name === name);
    if (idx < 0) return false;
    const entry = this.entries[idx];
    const mIdx = this.mounted.indexOf(entry);
    if (mIdx >= 0) this.mounted.splice(mIdx, 1);
    await this.#unmount(entry);
    if (!keepEntry) {
      const curIdx = this.entries.indexOf(entry);
      if (curIdx >= 0) this.entries.splice(curIdx, 1);
    }
    return true;
  }

  /** 运行期重载指定插件：先回收旧副作用，再按原槽位重新挂载新实现。 */
  async reload<TOptions = Record<string, unknown>>(
    name: string,
    nextPlugin: KernelPlugin<TOptions> | PluginFactory<TOptions>,
    nextOptions?: TOptions,
  ): Promise<KernelPluginStatus> {
    const idx = this.entries.findIndex((e) => e.name === name);
    if (idx < 0) {
      throw new Error(`插件「${name}」不存在`);
    }
    const prev = this.entries[idx];
    const mIdx = this.mounted.indexOf(prev);
    if (mIdx >= 0) this.mounted.splice(mIdx, 1);
    await this.#unmount(prev);

    const nextEntry = this.#buildEntry(
      nextPlugin,
      (nextOptions ?? prev.options) as TOptions,
    );
    nextEntry.name = name;
    nextEntry.source = nextEntry.source === 'builtin' ? prev.source : nextEntry.source;
    nextEntry.isolated = prev.isolated;
    const curIdx = this.entries.indexOf(prev);
    if (curIdx >= 0) this.entries[curIdx] = nextEntry;
    else this.entries.push(nextEntry);

    if (!this.started) {
      return this.status().plugins.find((p) => p.name === name)!;
    }

    for (const dep of nextEntry.inject) {
      if (!this.services.has(dep)) {
        nextEntry.error = `缺少依赖服务：${dep}`;
        throw new Error(`插件「${name}」${nextEntry.error}`);
      }
    }

    const gen = this.#runGen;
    try {
      await this.#mountEntry(nextEntry, gen);
    } catch (err) {
      await this.#unmount(nextEntry);
      nextEntry.error = errMsg(err);
      throw err;
    }
    return this.status().plugins.find((p) => p.name === name)!;
  }

  async stop(): Promise<void> {
    this.#runGen += 1;
    this.started = false;
    const mounted = this.mounted.splice(0).reverse();
    for (const entry of mounted) {
      await this.#unmount(entry);
    }
  }

  status(): { started: boolean; plugins: KernelPluginStatus[] } {
    return {
      started: this.started,
      plugins: this.entries.map((e) => {
        let extra: unknown = null;
        if (e.active && typeof e.statusProvider === 'function') {
          try { extra = e.statusProvider(); } catch { extra = null; }
        }
        return {
          name: e.name,
          kind: e.kind,
          version: e.version,
          active: e.active,
          provides: [...e.provides],
          inject: [...e.inject],
          optionalInject: [...e.optionalInject],
          source: e.source,
          error: e.error,
          reloadable: e.source !== 'builtin' && e.kind !== 'core' && e.kind !== 'channel',
          status: extra,
        };
      }),
    };
  }
}
