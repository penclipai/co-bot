/**
 * 轻量级零依赖插件微内核（灵感源自 Cordis）：
 *   - provides / inject 声明式依赖解析与拓扑挂载
 *   - effect / on / provide 可逆副作用管理（失败自动回滚，stop 严格逆序卸载）
 *   - 进程内安全事件总线（监听器异常隔离，不影响主链路）
 */
import type {
  AppConfig,
  KernelContext,
  KernelLike,
  KernelPlugin,
  KernelPluginStatus,
  LoggerLike,
  PluginFactory,
  RawConfig,
} from '../types.ts';

interface KernelEntry<TOptions = Record<string, unknown>> {
  name: string;
  kind: string;
  version: string;
  provides: string[];
  inject: string[];
  apply: (ctx: KernelContext, options: TOptions) => Promise<(() => unknown) | void> | (() => unknown) | void;
  options: TOptions;
  active: boolean;
  effects: Array<() => unknown>;
  statusProvider: (() => unknown) | null;
}

function toList(val: string | string[] | undefined): string[] {
  if (!val) return [];
  return Array.isArray(val) ? val.filter(Boolean).map(String) : [String(val)];
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
            this.logger.warn?.(`[kernel:${eventName}]`, e instanceof Error ? e.message : e);
          });
        }
      } catch (e) {
        this.logger.warn?.(`[kernel:${eventName}]`, e instanceof Error ? e.message : e);
      }
    }
  }

  use<TOptions = Record<string, unknown>>(
    plugin: KernelPlugin<TOptions> | PluginFactory<TOptions>,
    options: TOptions = {} as TOptions,
  ): this {
    const def = typeof plugin === 'function'
      ? { name: plugin.name || `plugin-${this.entries.length + 1}`, apply: plugin }
      : plugin;
    if (!def || typeof def.apply !== 'function') {
      throw new Error('插件必须导出 apply(ctx, options) 方法或为函数');
    }
    const name = String(def.name || `plugin-${this.entries.length + 1}`);
    if (this.entries.some((e) => e.name === name)) {
      throw new Error(`插件名重复：${name}`);
    }
    this.entries.push({
      name,
      kind: def.kind || 'plugin',
      version: def.version || '1.0.0',
      provides: toList(def.provides),
      inject: toList(def.inject),
      apply: def.apply as (ctx: KernelContext, options: Record<string, unknown>) => Promise<(() => unknown) | void> | (() => unknown) | void,
      options: (options ?? {}) as Record<string, unknown>,
      active: false,
      effects: [],
      statusProvider: null,
    });
    return this;
  }

  #resolveOrder(): Array<KernelEntry<Record<string, unknown>>> {
    const providerOf = new Map<string, string>();
    for (const entry of this.entries) {
      for (const svc of entry.provides) {
        if (!providerOf.has(svc)) providerOf.set(svc, entry.name);
      }
    }
    for (const entry of this.entries) {
      for (const dep of entry.inject) {
        if (!this.services.has(dep) && !providerOf.has(dep)) {
          throw new Error(`插件「${entry.name}」缺少依赖服务：${dep}`);
        }
      }
    }

    const available = new Set(this.services.keys());
    const remaining = [...this.entries];
    const ordered: Array<KernelEntry<Record<string, unknown>>> = [];
    while (remaining.length) {
      const idx = remaining.findIndex((e) => e.inject.every((dep) => available.has(dep)));
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
        this.logger.warn?.(`[kernel:stop:${entry.name}]`, e instanceof Error ? e.message : e);
      }
    }
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
      const ctx: KernelContext = {
        config: this.config,
        kernel: this,
        logger: this.logger,
        has: (k) => this.has(k),
        get: <T = unknown>(k: string) => this.get<T>(k),
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
      try {
        const ret = await entry.apply(ctx, entry.options);
        if (typeof ret === 'function') entry.effects.push(ret);
        if (this.#runGen !== gen) {
          await this.#unmount(entry);
          await this.stop();
          return;
        }
        for (const svc of entry.provides) {
          if (!this.services.has(svc)) {
            throw new Error(`插件「${entry.name}」声明提供服务「${svc}」但未调用 ctx.provide()`);
          }
        }
        entry.active = true;
        this.mounted.push(entry);
      } catch (err) {
        await this.#unmount(entry);
        await this.stop();
        throw err;
      }
    }
    if (this.#runGen === gen) this.started = true;
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
          status: extra,
        };
      }),
    };
  }
}
