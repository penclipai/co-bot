/**
 * 内置核心扩展点注册插件：提供带调用方作用域绑定（SCOPED_SERVICE）的 `commands`、`security` 与 `hooks` 服务。
 * 任意外部插件在 `apply(ctx)` 中注册的命令、脱敏规则或语音钩子会在卸载或热重载时自动注销。
 */
import { CommandRegistry, HookRegistry } from '../core/extensions.ts';
import { SCOPED_SERVICE, type ScopedServiceProvider } from '../core/kernel.ts';
import { listCustomRedactors, registerCustomRedactor } from '../core/security.ts';
import type {
  AudioTranscriberFn,
  CommandRegistryService,
  CustomRedactorRule,
  HooksExtensionService,
  KernelContext,
  KernelPlugin,
  PluginCommandDef,
  SecurityExtensionService,
} from '../types.ts';

function bindDispose<T>(ownerCtx: KernelContext, disposeFn: () => void, ret: T): T {
  ownerCtx.effect(disposeFn);
  return ret;
}

/** 构造内置扩展点提供插件，统一向外部插件暴露命令、安全与入站钩子能力。 */
export const extensionsPlugin: KernelPlugin = {
  name: 'extensions',
  kind: 'core',
  version: '1.0.0',
  source: 'builtin',
  provides: ['commands', 'security', 'hooks'],
  apply(ctx) {
    const commandRegistry = new CommandRegistry();
    const hookRegistry = new HookRegistry();

    const commandsProvider: CommandRegistry & ScopedServiceProvider<CommandRegistry> = Object.assign(
      commandRegistry,
      {
        [SCOPED_SERVICE](callerCtx: KernelContext): CommandRegistry {
          return {
            register: (def: PluginCommandDef) => {
              const off = commandRegistry.register(def);
              return bindDispose(callerCtx, off, off);
            },
            match: (rawCmd: string) => commandRegistry.match(rawCmd),
            list: () => commandRegistry.list(),
          } as CommandRegistry;
        },
      },
    );

    const securityProvider: SecurityExtensionService & ScopedServiceProvider<SecurityExtensionService> = {
      registerRedactor: (rule: CustomRedactorRule) => registerCustomRedactor(rule),
      listRedactors: () => listCustomRedactors(),
      [SCOPED_SERVICE](callerCtx: KernelContext): SecurityExtensionService {
        return {
          registerRedactor: (rule: CustomRedactorRule) => {
            const off = registerCustomRedactor(rule);
            return bindDispose(callerCtx, off, off);
          },
          listRedactors: () => listCustomRedactors(),
        };
      },
    };

    const hooksProvider: HooksExtensionService & ScopedServiceProvider<HooksExtensionService> = {
      registerAudioTranscriber: (fn: AudioTranscriberFn) => hookRegistry.registerAudioTranscriber(fn),
      transcribeAudio: hookRegistry.transcribeAudio,
      [SCOPED_SERVICE](callerCtx: KernelContext): HooksExtensionService {
        return {
          registerAudioTranscriber: (fn: AudioTranscriberFn) => {
            const off = hookRegistry.registerAudioTranscriber(fn);
            return bindDispose(callerCtx, off, off);
          },
          transcribeAudio: hookRegistry.transcribeAudio,
        };
      },
    };

    ctx.provide('commands', commandsProvider);
    ctx.provide('security', securityProvider);
    ctx.provide('hooks', hooksProvider);
    ctx.status(() => ({
      commands: (commandRegistry as CommandRegistryService).list().map((c) => c.name),
      redactors: listCustomRedactors(),
    }));
  },
};
