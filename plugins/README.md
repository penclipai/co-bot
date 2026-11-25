# `plugins/` 目录说明

将自定义插件（IM 通道插件或功能扩展插件）直接放入本目录即可自动被 `co-bot` 发现与加载，无需修改核心代码。

## 目录规则

- **单文件插件**：`plugins/<name>.ts`（或 `.js` / `.mjs`）
- **子目录插件**：`plugins/<name>/index.ts`（或通过 `package.json` 的 `main` / `exports['.']` 指定入口）
- **自动忽略**：以 `_` 或 `.` 开头的文件/目录（如 `_example-extension.ts`）、`README.md`、`*.d.ts`、`*.test.*`、`node_modules`

## 编写方式（Cordis 同构契约）

### 1. 扩展插件（推荐命名导出，放入即默认启用）

参考 [_example-extension.ts](./_example-extension.ts)：

```ts
import type { CommandRegistryService, KernelContext, SecurityExtensionService } from '../src/types.ts';

export const name = 'my-ext';
export const kind = 'extension';
export const inject = ['commands', 'security'];

export function apply(ctx: KernelContext) {
  const commands = ctx.get<CommandRegistryService>('commands');
  const security = ctx.get<SecurityExtensionService>('security');

  commands.register({
    name: 'ping',
    description: '返回插件存活检查',
    handler: async (cmd) => {
      await cmd.reply('pong');
    },
  });

  security.registerRedactor({
    name: 'internal_emp_id',
    pattern: /\bEMP-\d{6}\b/g,
  });
}
```

### 2. IM 通道插件

将 [im-plugin.example.ts](../im-plugin.example.ts) 复制为 `plugins/my-im.ts`，导出 `defineChannelPlugin({ name: 'my-im', capabilities, create })`。在 `config.json` 中配置 `"channel": { "use": "my-im" }` 或 `"channel": { "use": "auto" }` 即可接入，并通过 `npm run channel:test -- --channel my-im --dry` 校验契约。

## 配置开关与热重载

- 在 `config.json` 的 `"plugins"` 下可为插件单独配置启用开关与参数，例如：`"plugins": { "my-ext": false }` 或 `{ "my-ext": { "enabled": true, "endpoint": "..." } }`。
- 在本地只读诊断台 `/debug` 中可查看全部插件状态及报错，并对外部扩展插件一键点击 **重载** 实现热更新。
