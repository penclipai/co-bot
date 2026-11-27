# 真实 IM 接入、常见排障与多用户部署

本文档专注**真实 IM 通道插件验收**、**常见故障定位**以及**多用户同机 / 服务器隔离部署**；日常 CLI 命令、指令用法与 `config.json` 说明请见 [使用指南](./usage.md)，架构边界与形式化验证见 [形式化完备性推导](./FORMAL_COMPLETENESS.md)。

---

## 一、真机通道上线验收要点

实现 [im-plugin.example.ts](../im-plugin.example.ts) 并接入真实 IM 后，建议重点核对以下 4 项：

1. **返回真实消息 ID 与 ID 护栏**：`send()` 与 `sendFile()` 的 `Promise` 必须解析为通道实际消息 ID；建议在插件声明 `idPatterns` 与 `strictContract: true`，并用 `encodeScopedChatId` 隔离可能撞号的单聊与群聊 ID。
2. **契约与实时全量体检**：执行 `npm run channel:test -- --channel ./im-plugin.ts --strict --wait 30 --expect-events 3 --send "hello" --check-file --check-history --check-notify --check-mentions`（或离线样本回归 `--replay ./samples.json`），核对回显的**字段映射核对表**确认群聊、引用快照、真 `@`、附件、桌面通知与历史翻页均合规。
3. **离线部署安全与零依赖自检**：在内网打包/CI 或无网关连通环境可执行 `node scripts/check.ts --offline`（等价 `npm run check -- --offline`），校验配置合规性、部署安全基线与源码零三方运行时依赖，并对外部插件做 `--dry` 契约验证。
3. **可选能力钩子**：按目标平台支持度补充 `quote` 快照、`getMessage` / `getHistory`（配 `capabilities.history: true`）、入站 `recall` 撤回事件、结构化 `mentions` 与 `download` 私有 `att.extra`。
4. **自聊提醒与诊断台观察**：确认手机端能否收到“自己发给自己”的消息推送（若静默则实现 `notify` 并设 `capabilities.notify: true`）；上线初期在 `/debug` 筛选 `type=contract_warning` 确认零协议告警。

---

## 二、常见问题与排障速查

| 现象 | 常见原因 | 排查与解决办法 |
| --- | --- | --- |
| 发送消息报 `401` / `403` | OpenMausBot 桌面端未配对或 Token 失效 | 运行 `npm run pair` 完成配对，再执行 `npm run restart`。 |
| CLI 模式读写本机文件报错 `This computer` | 主 Bot `computer` 未关闭 | 运行 `npm run check -- --fix-cli`（并保持 `openmausbot.cliComputerOff: true`）。 |
| 群里本人发消息后 Bot 重复回复（回环） | 通道把本人发送又回显为 `isSelf: true` 入站，或正文残留 `@bot` | 1) 确保 `send()`/`sendFile()` 返回真实 `msgId`；2) 保持 `externalSanitizeMentions: "all"`（插入 `\u200B`），入站会自动跳过 `@\u200Bbot`。 |
| 外部群回复里 `@同事` 或 `@所有人` 真艾特了别人 | 手动关闭了 `externalSanitizeMentions` | 将 `chats.externalSanitizeMentions` 保持为 `"all"`（默认）或 `"dangerous"`。只有 `@bot!` 发回自聊的私密草稿保留原始 `@`。 |
| 成员撤回消息后 Bot 仍答出撤回内容 | 通道插件未推送标准撤回事件 | 在入站回调推送 `{ kind: 'recall', id, chat, sender, recalledMsgId }`，并在 `/debug` 筛选 `type=recall` 核对。 |
| 在外部群触发后自聊串了话题或提示建立隔离上下文失败 | 关闭了隔离或底层创建外部 Thread 失败 | 确认 `chats.isolateThreadsByChat: true`（默认）；建线失败时会 fail-closed 报错中止（不再混入自聊主线），通过 `/api/status` 核对 `chatThreads` 与 `focus.threadId`。 |
| 裸回复 `1` / `ok` / `确认发送` 触发消歧提示未直接执行 | 收件箱同时存在多个待发草稿、审批卡或待选会话列表 | 防误操作已暂停裸回复；按提示改发 `#编号 确认/1/0/取消`，或长按引用目标气泡后再回复。 |
| 非白名单同事在外部群 `@我` 未收到自聊提醒 | `chats.passiveMentionAlert` 默认关闭，或处于免打扰时段 | 在 `config.json` 设 `"chats": { "passiveMentionAlert": true }`；开启后群内仍保持静默，非免打扰时段即时提醒自聊。 |
| 白名单同事提问被拒绝（`policy_denied`） | 提及未授权项目名/越界绝对路径，或 `chats.collaboratorBot` 不可用 | 检查同事 `projects` 授权范围；若配置了 `chats.collaboratorBot`，请确认该专用 Bot 在 OpenMausBot 中存在且未隐藏（不可用时会 fail-closed 中止）。 |
| 重启后旧审批卡消失或 `#编号` 提示“已处理或已过期” | 启动自动对账清除了已在桌面端处理的卡片，或超过 `cardTtlMs`/`draftTtlMs` | 属正常生命周期收口；发送 `@bot status` 查看当前活跃收件箱，或重新发起操作。 |
| 群里引用较早消息显示 `[unavailable]` | 超出内存窗口或通道未实现历史接口 | 优先在入站事件填充 `quote` 快照（`msgId` / `senderId` / `senderName` / `text`）做零 RPC 兜底，并按需实现 `getMessage`、`getHistory` 与 `download`。 |
| 不同群消息/路由互串、雪花 ID 尾数失真或字段混写不触发 | `msgId` 撞号、64 位数字精度丢失或混写标准/扁平字段 | 使用 `createInboundMessage` + `encodeScopedChatId` 构造事件，声明 `idPatterns` 并运行 `npm run channel:test -- --strict`，或在 `/debug` 查看 `type=contract_warning`。 |
| 提示 `尚未获知 selfChatId` | 首次启动未配置 `selfChatId` 且未收到自聊消息 | 用本人 IM 账号在**自聊窗口**发一条消息，系统会自动学习并持久化到 `data/bridge-state.json`。 |

---

## 三、多用户同机隔离与 7×24 服务器部署

在同一台开发机为多位同事并行运行实例，或迁移至 7×24 Linux 开发机时，做以下 3 项物理隔离即可（`sharedContextDir`、`projects` 与 `collaborators` 配法见 [使用指南](./usage.md)）：

1. **独立配置、端口与数据目录**：每人使用独立配置文件通过 `node src/index.ts --config <path>` 启动，并各自隔离 `web.port` 与 `dataDir`（防止状态与临时附件混用）。
2. **独立 OpenMausBot 实例与鉴权隔离**：各自绑定不同的 `openmausbot.url`（如 `:8799` 与 `:8809`）和认证 `OMB_TOKEN`，确保个人 Memory 与会话历史彻底物理隔离。
3. **未来独立 Bot 账号切换**：若目标 IM 开放独立机器人号，只需更新通道插件凭据并将 `chats.externalBotPrefix` 设为 `""`，安全门禁、白名单与 C2C 委托协议无需改动。
