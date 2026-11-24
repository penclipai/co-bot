/**
 * 极薄共享 Git 目录指针管理器：后台防抖 `git pull --ff-only` 同步，提示头仅注入路径指针（不自建索引）。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { redactSecrets } from './chat-context.ts';

export type SharedContextSyncStatus = 'idle' | 'ok' | 'error' | 'unavailable';

export interface SharedContextRefreshResult {
  ok: boolean;
  status: SharedContextSyncStatus;
  output?: string;
  error?: string;
}

export interface SharedContextStatus {
  configured: boolean;
  available: boolean;
  dir: string;
  lastSyncAt: number | null;
  lastStatus: SharedContextSyncStatus;
  lastError: string | null;
}

export interface SharedContextManagerOptions {
  dir?: string;
  pullIntervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  execGit?: ((dir: string, timeoutMs: number) => Promise<string>) | null;
  onTelemetry?: ((type: string, data: { summary: string }) => void) | null;
}

function defaultExecGit(dir: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', dir, 'pull', '--ff-only'], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const detail = redactSecrets(String(stderr || err.message || 'git pull failed')).trim();
        reject(new Error(detail));
        return;
      }
      resolve(redactSecrets(String(stdout || '')).trim());
    });
  });
}

export class SharedContextManager {
  dir: string;
  pullIntervalMs: number;
  timeoutMs: number;
  now: () => number;
  execGit: (dir: string, timeoutMs: number) => Promise<string>;
  onTelemetry: ((type: string, data: { summary: string }) => void) | null;
  lastSyncAt: number;
  lastStatus: SharedContextSyncStatus;
  lastError: string | null;
  inFlight: Promise<SharedContextRefreshResult> | null;

  constructor({
    dir = '',
    pullIntervalMs = 300_000,
    timeoutMs = 8000,
    now = () => Date.now(),
    execGit = null,
    onTelemetry = null,
  }: SharedContextManagerOptions = {}) {
    this.dir = dir ? String(dir).trim() : '';
    this.pullIntervalMs = Math.max(0, Number(pullIntervalMs ?? 300_000) || 0);
    this.timeoutMs = Math.max(1000, Number(timeoutMs ?? 8000) || 8000);
    this.now = now;
    this.execGit = execGit || defaultExecGit;
    this.onTelemetry = onTelemetry;
    this.lastSyncAt = 0;
    this.lastStatus = 'idle';
    this.lastError = null;
    this.inFlight = null;
  }

  isAvailable(): boolean {
    if (!this.dir) return false;
    try {
      return fs.existsSync(this.dir) && fs.statSync(this.dir).isDirectory();
    } catch {
      return false;
    }
  }

  async refreshNow(): Promise<SharedContextRefreshResult> {
    if (!this.isAvailable()) {
      this.lastStatus = this.dir ? 'unavailable' : 'idle';
      return { ok: false, status: this.lastStatus };
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async (): Promise<SharedContextRefreshResult> => {
      try {
        const out = await this.execGit(this.dir, this.timeoutMs);
        this.lastSyncAt = this.now();
        this.lastStatus = 'ok';
        this.lastError = null;
        this.onTelemetry?.('shared_context_sync', { summary: `ok: ${out ? out.split(/\r?\n/)[0].slice(0, 80) : 'synced'}` });
        return { ok: true, status: 'ok', output: out };
      } catch (e) {
        const msg = redactSecrets(e instanceof Error ? e.message : String(e));
        this.lastSyncAt = this.now();
        this.lastStatus = 'error';
        this.lastError = msg;
        this.onTelemetry?.('shared_context_sync', { summary: `fallback: ${this.lastError}` });
        return { ok: false, status: 'error', error: this.lastError };
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /** 在后台按冷却时间（TTL）触发非阻塞同步；离线或失败时降级沿用本地缓存。 */
  triggerRefresh(): void {
    if (!this.isAvailable() || !(this.pullIntervalMs > 0) || this.inFlight) return;
    if (this.lastSyncAt > 0 && (this.now() - this.lastSyncAt) < this.pullIntervalMs) return;
    this.refreshNow().catch(() => {});
  }

  /** 返回 2 行共享目录指针；仅告知只读参考与写入自聊确认红线。 */
  formatPromptPointer(): string {
    if (!this.isAvailable()) return '';
    return [
      '<shared-context>',
      `shared_docs_dir: ${this.dir} (team docs, conventions, shared memory; inspect on demand, never write back without owner confirmation in self-chat; personal memory & self-chat stay local)`,
      '</shared-context>',
      '',
    ].join('\n') + '\n';
  }

  status(): SharedContextStatus {
    return {
      configured: Boolean(this.dir),
      available: this.isAvailable(),
      dir: this.dir || '',
      lastSyncAt: this.lastSyncAt || null,
      lastStatus: this.lastStatus,
      lastError: this.lastError,
    };
  }
}
