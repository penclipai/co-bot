/**
 * co-bot 扩展能力注册表（命令、脱敏规则、入站语音钩子），支持卸载与热重载时幂等回收。
 */
import type {
  AudioTranscriberFn,
  CommandRegistryService,
  InboundAttachment,
  PluginCommandDef,
} from '../types.ts';

/** 内置控制命令保留字集合（外部插件不可覆盖，防止劫持安全控制指令）。 */
export const BUILTIN_RESERVED_COMMANDS = new Set([
  'help', '帮助', '?', '？',
  'status', '状态',
  'stop', '停止',
  'steer', '插队',
  'cancel', '取消', '取消排队',
  'bye', '退下', '结束对话', '退出对话',
  'quiet', '免打扰',
  'task', '会话',
  'new', '新会话',
  'compact', '压缩',
  'sendback', '发回',
  'chats', '会话列表',
  'mute', '静音',
  'unmute', '取消静音', '解除静音', '恢复通知',
  'summary', '汇总', '纪要',
  'bind', '绑定',
  'delegate', '委托',
]);

interface RegisteredCommandEntry {
  id: number;
  def: PluginCommandDef;
  keys: string[];
}

export interface CommandMatchResult {
  def: PluginCommandDef;
  args: string;
}

/** `@bot <cmd>` 动态指令注册表。 */
export class CommandRegistry {
  #nextId = 1;
  #entries = new Map<number, RegisteredCommandEntry>();
  #byKey = new Map<string, RegisteredCommandEntry>();

  register(def: PluginCommandDef): () => void {
    const rawName = String(def?.name || '').trim();
    if (!rawName || /\s/.test(rawName)) {
      throw new Error(`插件命令名无效（不能为空或含空格）：「${rawName}」`);
    }
    if (typeof def?.handler !== 'function') {
      throw new Error(`插件命令「${rawName}」必须提供 handler 函数`);
    }
    const keys = [rawName, ...(Array.isArray(def.aliases) ? def.aliases : [])]
      .map((k) => String(k || '').trim().toLowerCase())
      .filter(Boolean);
    const uniqueKeys = [...new Set(keys)];
    for (const k of uniqueKeys) {
      if (BUILTIN_RESERVED_COMMANDS.has(k)) {
        throw new Error(`插件命令「${k}」与内置命令冲突，禁止覆盖`);
      }
      if (this.#byKey.has(k)) {
        throw new Error(`插件命令「${k}」重复注册`);
      }
    }

    const id = this.#nextId++;
    const entry: RegisteredCommandEntry = {
      id,
      def: {
        ...def,
        name: rawName,
        aliases: Array.isArray(def.aliases) ? def.aliases.map((a) => String(a).trim()).filter(Boolean) : [],
        description: String(def.description || '').trim(),
      },
      keys: uniqueKeys,
    };
    this.#entries.set(id, entry);
    for (const k of uniqueKeys) this.#byKey.set(k, entry);

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.#entries.delete(id);
      for (const k of uniqueKeys) {
        if (this.#byKey.get(k)?.id === id) this.#byKey.delete(k);
      }
    };
  }

  match(rawCmd: string): CommandMatchResult | null {
    const trimmed = String(rawCmd || '').trim();
    if (!trimmed) return null;
    const m = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    if (!m) return null;
    const hit = this.#byKey.get(m[1].toLowerCase());
    if (!hit) return null;
    return {
      def: hit.def,
      args: (m[2] ?? '').trim(),
    };
  }

  list(): ReturnType<CommandRegistryService['list']> {
    return [...this.#entries.values()].map(({ def }) => ({
      name: def.name,
      aliases: def.aliases ?? [],
      description: def.description ?? '',
    }));
  }
}

/** 入站扩展钩子注册表（当前支持语音转写器，按后注册先匹配执行）。 */
export class HookRegistry {
  #nextId = 1;
  #transcribers = new Map<number, AudioTranscriberFn>();

  registerAudioTranscriber(fn: AudioTranscriberFn): () => void {
    if (typeof fn !== 'function') {
      throw new Error('registerAudioTranscriber 需要传入函数');
    }
    const id = this.#nextId++;
    this.#transcribers.set(id, fn);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.#transcribers.delete(id);
    };
  }

  transcribeAudio: AudioTranscriberFn = async (filePath: string, att: InboundAttachment) => {
    const list = [...this.#transcribers.values()].reverse();
    for (const fn of list) {
      const out = await fn(filePath, att);
      if (typeof out === 'string' && out.trim()) return out.trim();
    }
    return null;
  };
}
