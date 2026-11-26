# co-bot

**IM 自聊 / 群聊 `@bot` → 本地网关 `co-bot` → 本机 `OpenMausBot` + `opencode`**。

基于零依赖插件微内核构建，将日常 IM 变为手机端 AI 协同与安全控制网关，支持 **Linux / macOS / Windows** 跨平台部署。

## 核心能力

- **顺手的 IM 协作入口**：支持自聊、`@<Bot名>` / `@<群名>` 多 Bot 协作、120s 短时续聊、引用跨线程接力、交互卡片及语音/图片/文件互通。
- **外部群防干扰与隔离**：默认仅本人可触发，每个外部会话隔离独立 Thread；支持 `@bot!` / `sendback` 私密起草确认、出站 `@` 防误艾特与撤回擦除。
- **确定性安全边界（`v0.5`）**：出站正文与文本/`.md` 附件自动脱敏，外部回复前置 `🤖 ` 标识，配合 `<im-context>` 防注入围栏与 `@bot bind` 目录边界。
- **团队协同与 C2C 委托（`v0.6`～`v0.7`）**：支持 `sharedContextDir` 共享目录指针、两级外部白名单同事只读协助（`confirm_in_self` / `auto_readonly`）及极简 2 态异步委托。
- **本地诊断与容错**：内置 `/sim` 模拟器、`/debug` 本地诊断与脱敏诊断包导出、停滞看门狗及断线缓冲重放。

## 运行要求

- **Node.js >= 24**（原生 TypeScript 执行，零编译构建步骤）
- **OpenMausBot**：通过 `npm install -g openmausbot` 全局安装 CLI，或直接启动 OpenMausBot 桌面端
- 已配置可用的底层 Agent CLI（推荐本机预先安装 `opencode`）

## 快速开始

```bash
npm install -g openmausbot  # 全局安装 OpenMausBot CLI（使用桌面端可跳过）
npm install                 # 可选：安装 TypeScript / ESLint 开发校验依赖（co-bot 零运行依赖）
npm run daemon              # 后台启动 OpenMausBot CLI 与 co-bot（桌面端首次需先运行 npm run pair）
npm start                   # 仅前台运行 co-bot（Web 模拟器 http://127.0.0.1:8787/sim）
npm run verify              # 一键全量校验：tsc 类型检查 + ESLint + 单元测试 + 通道契约检测
```

> 完整运维命令（`status` / `restart` / `stop` / `check` / `install-service`）、`@bot` 全量指令及 `config.json` 配置见 [使用指南](./docs/usage.md)。

## 接入真实 IM

1. 阅读 [内网 IM 通道接入协议规范](./docs/IM_PROTOCOL.md)，复制 [im-plugin.example.ts](./im-plugin.example.ts) 为根目录 `im-plugin.ts`（已忽略提交；亦可使用 `.js`/`.mjs` 或放到 `plugins/`），实现 `start`、`send`（含 `mentions`）及可选媒体/`getMessage`/`getHistory`/`notify` 钩子。
2. 在 `config.json` 配置 `"channel": { "use": "./im-plugin.ts", "options": { "selfId": "<用户ID>", "selfChatId": "" } }`。
3. 运行契约与收发验证：`npm run channel:test -- --dry` 与 `--wait 15 --send "hello" --check-file`。

## 项目结构

```text
src/core/            微内核、通道契约、上下文存储、出站脱敏、项目绑定与白名单策略
src/openmausbot/     OpenMausBot 客户端、桥接核心与入站/派发/投递/队列/C2C 委托模块
src/plugins/         内置插件装配层（extensions、web、channel-sim、channel-loader、im-context、openmausbot、inspector）
src/im/ & src/web/   Web 模拟器传输层与本地 HTTP 服务（127.0.0.1）
scripts/             CLI 工具链（daemon、service、omb、check、pair、channel-test）
public/              /sim 模拟器、/debug 诊断台与 Markdown 预览静态页
docs/                使用指南（usage.md）、IM 协议规范（IM_PROTOCOL.md）、排障（TROUBLESHOOTING.md）与路线（ROADMAP.md）
test/                Node 内置测试套件与共享 Mock 辅助模块
config.example.json  最小化示例配置
im-plugin.example.ts 通用 IM 通道插件模板（TypeScript）
```

## 相关文档

- [使用指南（运维命令、交互用法、指令速查、配置与诊断台）](./docs/usage.md)
- [内网 / 第三方 IM 通道接入协议规范（转发、`@` 提醒、历史穿透与安全基线）](./docs/IM_PROTOCOL.md)
- [真实 IM 接入验收、常见排障与多用户隔离部署](./docs/TROUBLESHOOTING.md)
- [架构演进路线图与克制红线（`v0.5` ~ `v0.7`）](./docs/ROADMAP.md)
