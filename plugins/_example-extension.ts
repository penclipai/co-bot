/**
 * 示例扩展插件（以 `_` 开头的文件默认不会自动加载；复制重命名为 `plugins/my-ext.ts` 即可生效）。
 */
import type {
  CommandRegistryService,
  KernelContext,
  SecurityExtensionService,
} from '../src/types.ts';

export const name = 'example-extension';
export const kind = 'extension';
export const version = '1.0.0';
export const inject = { required: ['commands', 'security'], optional: ['web'] };

export function apply(ctx: KernelContext, options: { tag?: string } = {}): void {
  const commands = ctx.get<CommandRegistryService>('commands');
  const security = ctx.get<SecurityExtensionService>('security');
  const tag = options.tag || 'ready';

  commands.register({
    name: 'ping',
    description: '检查插件扩展系统是否正常工作',
    async handler(cmd) {
      await cmd.reply(`pong (${tag})`);
    },
  });

  security.registerRedactor({
    name: 'internal_token',
    pattern: /\bINTRANET_SECRET_[A-Za-z0-9_-]{8,}\b/g,
  });
}
