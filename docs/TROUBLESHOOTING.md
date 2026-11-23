# 真实 IM 接入与常见排障手册

本文档面向将 `co-bot` 从 `/sim` 模拟器切换到真实 IM 客户端（如 `im-plugin.js` 或自定义通道插件）并长期后台运行时的上线核对与常见故障排查。

---

## 一、真机上线 Checklist

1. **安装依赖与前置自检**
   ```bash
   npm install
   npm run check
   ```
   - 确认 `Node.js >= 24`、`openmausbot` 本地依赖就绪、底端引擎（如 `opencode`）正常。
   - 若使用 **OpenMausBot Desktop App**，先完成一次配对：`npm run pair`（桌面端点 Allow）或 `npm run pair -- <12位配对码>`；Token 会安全写入已忽略提交的 `config.json`。
   - 若本机使用 CLI 模式，建议确认主 Bot `computer=off`（`npm run check -- --fix-cli`），避免访问本机路径时报错。

2. **实现并验收通道插件**
   - 复制 [im-plugin.example.js](../im-plugin.example.js) 为根目录下的 `im-plugin.js`（已在 `.gitignore` 忽略）。
   - 在 `config.json` 配置 `channel.use = "./im-plugin.js"` 与 `channel.options.selfId`（以及可选的 `selfChatId`）。
   - 静态契约与实时收发验收：
     ```bash
     npm run channel:test -- --dry
     npm run channel:test -- --wait 15 --send "hello" --check-file
     ```
   - 建议在适配器中补充可选的 `getMessage` / `getHistory` / `searchHistory`（与 `capabilities.history: true`）以及 `recall` 撤回与结构化 `mentions` 映射，以解锁深层历史穿透与撤回擦除能力。

3. **切为常驻守护进程与开机自启**
   ```bash
   npm run daemon
   npm run status
   npm run daemon -- install-service --dry   # 预览后去掉 --dry 即安装系统自启
   ```
   - 打开 `http://127.0.0.1:8787/debug` 查看插件挂载、能力声明、多会话策略与实时脱敏事件流。

---

## 二、常见问题与排障速查

| 现象 | 常见原因 | 排查与解决办法 |
| :--- | :--- | :--- |
| 发送消息报 `401` / `403` | OpenMausBot Desktop App 未配对或会话 Token 失效 | 重新运行 `npm run pair`，完成后 `npm run restart`。 |
| CLI 模式读写本机文件报错 `This computer` | 主 Bot `computer` 未关闭 | 运行 `npm run check -- --fix-cli`（或在 `config.json` 保持 `openmausbot.cliComputerOff: true`）。 |
| 群里本人发消息后 Bot 自己重复回复自己（回环） | IM 客户端把自己发出的出站消息又回显为 `isSelf: true` 入站，或外部文本包含 `@bot` | 1) 确保插件 `send()` / `sendFile()` **同步返回真实 `msgId`**，以便桥接层写入 `ownIds` 精确去重；2) 出站保持 `chats.externalSanitizeMentions: "all"`（插入 `\u200B`），入站会自动忽略 `@\u200Bbot`。 |
| 外部群回复里 `@同事` 或 `@所有人` 真艾特了别人 | 手动关闭了 `externalSanitizeMentions` 或旧版本未过滤 | 确认 `config.json` 中 `chats.externalSanitizeMentions` 为 `"all"`（默认）或 `"dangerous"`。只有 `@bot!` 发回**自聊**的私密草稿会保留原始 `@`。 |
| 成员撤回消息后 Bot 仍答出撤回内容 | 通道插件未把撤回事件映射到标准 `InboundEvent` | 在插件回调推送 `{ kind: 'recall', id, chat, sender, recalledMsgId }`（可用 `normalizeInboundEvent` 验证）；若开着 `/debug` 可筛选 `type=recall` 核对是否收到。 |
| 在外部群触发后自聊串了话题（`focus` 漂移） | 使用了直接调原生 API 的旧桥接或手动在桌面端切错线程 | 确认 `chats.isolateThreadsByChat: true`（默认），通过 `/api/status` 核对外部群 `chatThreads` 与自聊 `focus.threadId` 为不同 ID；必要时在自聊发 `@bot tasks` 切回主线。 |
| 群里引用较早消息显示 `[unavailable]` 或附件无法读取 | 超出内存窗口 `contextMaxMessagesPerChat` 或通道未实现历史接口 | 适当调大 `chats.contextWindow` / `contextMaxMessagesPerChat`，或在通道插件实现 `getMessage`、`getHistory` 与 `download`。 |
| 找不到自聊会话（`尚未获知 selfChatId`） | 首次启动尚未配置 `selfChatId` 且未收到自聊消息 | 先用你的 IM 账号在**自聊窗口**发一条消息，系统会自动学习并持久化到 `data/bridge-state.json`。 |

---

## 三、推送到远端 Git 仓库前安全核对

推送代码到 GitHub / 私有 GitLab 前，建议确认本机配置与运行数据未被意外跟踪：

```bash
git status -s
npm test
npm run channel:test -- --dry
```

- 确认 `.gitignore` 正常生效（`config.json`、`im-plugin.js`、`data/`、`*.log`、`package-lock.json` 均不出现在待提交列表中）。
- 关联远端后推送：`git remote add origin <你的仓库地址> && git push -u origin main`。

---

## 四、多用户同机隔离与 7×24 弹性部署指南

当需要将个人电脑上的 `co-bot` 迁往 7×24 在线 Linux 服务器，或在同一台共用开发机上为多位成员并行运行互不干扰的 `co-bot` 实例时，按以下 4 项做实例隔离：

1. **独立配置、端口与数据目录**：
   - 每位用户使用独立配置文件（如 `config.alice.json`、`config.bob.json`），通过 `--config` 启动：
     ```bash
     node --no-deprecation src/index.js --config /srv/cobot/alice/config.json
     ```
   - 必须各自隔离 `web.port`（如 `8787` / `8789`）与 `dataDir`（如 `/srv/cobot/alice/data` / `/srv/cobot/bob/data`），避免端口冲突与 `bridge-state.json` / 临时附件混用。
2. **独立 OpenMausBot 实例与鉴权隔离**：
   - 每位用户绑定独立的 OpenMausBot 地址与认证（如 `openmausbot.url: "http://127.0.0.1:8799"` vs `"http://127.0.0.1:8809"`，并通过环境变量 `OMB_TOKEN` 或各自配置提供 `token`），确保长期记忆（Memory）与会话上下文彻底物理隔离。
3. **共享团队知识库 + 个人只读白名单**：
   - 将团队共同规范仓库同步到服务器本地（如 `/srv/shared/team-docs`），各实例配置 `sharedContextDir`，其余保留在各自的 `dataDir` 与 OpenMausBot 私有记忆内；
   - 按需配置 `chats.collaborators`（`confirm_in_self` / `auto_readonly`）与 `projects` 白名单即可开启受控只读协助及 `@bot delegate` 双实例 C2C 协同。
4. **独立 Bot 账号切换（未来扩展）**：
   - 若后续目标 IM 开放独立机器人号，只需在通道插件 `im-plugin.js` 中切换凭据并把 `chats.externalBotPrefix` 设为 `""`，上层安全门禁、白名单策略与 C2C 协议无需改动。
