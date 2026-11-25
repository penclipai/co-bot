# `co-bot` 使用指南

> 本指南涵盖启动运维、自聊与外部群交互、安全边界与团队协作、`@bot` 指令速查、核心配置以及 `/sim` 与 `/debug` 用法。真实 IM 通道验收、故障排查与多实例部署请见 [接入排障与多用户部署](./TROUBLESHOOTING.md)。

---

## 一、启动与日常运维

| 命令 | 说明 |
| --- | --- |
| `npm run daemon` | 通用后台启动（优先确保本机回环 OpenMausBot 就绪并设 CLI 主 Bot `computer=off`，再启动 `co-bot`） |
| `npm start` / `npm run sim` | 前台启动（`sim` 强制使用 Web 模拟器，访问 `http://127.0.0.1:8787/sim`） |
| `npm run status` / `restart` / `stop` | 查看状态 / 平滑重启 / 停止 `co-bot`（`npm run stop -- --all` 连带停止托管的 OpenMausBot CLI） |
| `npm run omb -- status` | 单独管理托管的 OpenMausBot CLI（支持 `ensure\|start\|stop\|restart\|status\|logs`） |
| `npm run check` | 校验 `config.json` 与 Node / 全局 `openmausbot` CLI / `opencode` / OpenMausBot 状态（支持 `-- --fix-cli`） |
| `npm run pair` | OpenMausBot 桌面端一次性配对（弹窗点 Allow，或传 `-- <12位配对码>`） |
| `npm run daemon -- install-service` | 安装开机自启（先加 `--dry` 预览 `systemd --user` / `LaunchAgents` / Windows 启动项；`uninstall-service` 卸载） |
| `npm run typecheck` | 运行 `tsc --noEmit` 静态严格类型检查 |
| `npm run lint` / `lint:fix` | 运行 ESLint 规范与单文件 1000 行上限校验 / 自动修复格式 |
| `npm run verify` | 一键串联 `npm run typecheck && npm run lint && npm test && npm run channel:test -- --dry` |

> 启动时支持 `--config <path>`、`--port <n>`、`--omb <url>`、`--omb-token <token>`（或 `OMB_TOKEN` 环境变量）、`--channel <plugin>`；托管日志每 6 小时按 10 MB 自动轮转。

---

## 二、自聊与多 Bot 交互

- **唤醒与接力**：自聊中用 `@bot <问题>`（默认对齐后端主协调 Bot `co-bot`，回复统一带 `🤖 **[co-bot]**` 徽章以便与本人人工消息区分；如需隐藏主 Bot 徽章可设 `selfChat.hideChiefPrefix: true`）或 `@<Bot名>` / `@<群名>` 指定协作对象；引用任意历史回复即可跨线程续聊。状态与路由防抖持久化在 `data/bridge-state.json`，重启后自动恢复在途轮次。
- **连续对话窗口（默认 120s）**：Bot 回复后在 `followUpWindowMs` 内可免 `@` 直接发文字，或连续发送图片/文件（`imageBatchMs` 默认 1.5s 防抖合批）；以 `#`、`备忘`、`记一下`、`笔记`、`todo` 开头的消息视为个人笔记自动忽略；发 `@bot bye` / `退下` 随时退出。
- **气泡控制与多媒体**：中间思考口语短窗合并上屏（单轮最多 2 条）；正文在 `resultChars`～`softSplitChars`（1500～2800 字）间智能拆为 2 段，超长自动截断并附 `.md` 原文；支持入站音频转写（`transcript` / `transcribeAudio`）、`linkCard` 及 Bot 生成图片/文件的自动回传。
- **原生斜杠命令透传**：支持 `@bot /goal <目标>`（进入 Goal 自动多步推进模式，群组 `@<群名> /goal` 同样适用）、`@bot /learn [步骤]`（沉淀为可复用技能）、`@bot /burst <并行任务>`（生成预览伪卡片，回复 `1`/`0` 或 `ok`/`no` 启动并发执行或取消）、`@bot /setup [职责]`（回复 `1`/`0` 或 `ok`/`no` 确认团队/人设提案）及自定义 `/<skill>`；斜杠命令发送时自动置顶并把项目/上下文块附于其后，确保与 OpenMausBot 原生契约完全兼容（仅限本人使用）。
- **卡片交互与免打扰**：

| 场景 | 手机快捷回复 / 行为 | 说明 |
| --- | --- | --- |
| 权限 / 提案审批卡 | `1`（或 `ok`）/ `2`（或 `always`）/ `0`（或 `no`） | 允许本次 / 总是允许（仅权限卡）/ 拒绝（结构化 Markdown 伪卡片适配全 IM 客户端） |
| `/burst` 并发任务卡 | `1`（或 `ok`）/ `0`（或 `no`） | 启动并发执行 / 取消（完成后自动汇总回复） |
| 选项 / 提问卡 | `1`~`N`、多选 `1,2`、中文序数或 `0` 取消 | 多题自动逐题推进，亦支持直接回复自定义答案 |
| 阻塞凭据 / 登录卡 | `0` / `skip` / `跳过` | 远程跳过桌面端凭据、连接器或登录验证步骤 |
| 免打扰汇总 | 配置 `selfChat.quietHours` | 免打扰时段暂存普通推送并在窗口结束自动汇总（审批卡仍即时穿透，`@bot status` 可查看待汇总条数） |

---

## 三、外部群与私聊协作

无需注册独立 Bot 账号，直接用本人账号在外部群或他人私聊触发（`chats.mode: "owner_everywhere"`，若只需自聊可设为 `"self_only"`）：

- **安全触发与防误触**：默认仅**本人**消息可唤醒 Bot，群成员消息仅进环形上下文窗口（默认 15 条，内存默认最多保留 120 条）；支持句首与句中自然召唤，自动跳过代码块、行内反引号、中英文引号及 Markdown 引用块（`> ...`）与 `@\u200Bbot`；仅发 `@bot` / `@bot!` 引用同事消息或附件时直接分析引用内容；引用 Bot 回复并 `@同事` 转交不重触 Bot。
- **上下文增强与隔离**：自动携带同批次连续附件（默认 2 分钟内最多 4 个），支持通过通道可选 `getMessage` / `getHistory` 穿透更早历史，并在收到 `recall` 撤回事件时立即从上下文与缓存擦除；每个 `(chatId, botId)` 绑定独立 Thread（外群未建立隔离 Thread 时禁止误查或压缩自聊主线），外群上下文达 80% 时自聊提醒、达 92% 自动后台压缩；所有敏感指令与审批卡片在外部群执行时一律重定向回**自聊**并保留来源标注。
- **原地直发 vs 私密起草（`@bot!` + `sendback`）**：
  - **原地直发**（`externalReplyMode: "inline"`）：静音中间思考，出站前自动对 `@所有人` / `@同事` 插入零宽空格防误艾特（保留邮箱与代码块）；
  - **私密起草回发**（`@bot! <问题>` / `@bot -p <问题>` 或设为 `"draft_first"`）：仅在自聊生成附带草稿编号的草稿（润色后保留来源标识），支持自聊引用继续润色后发 `@bot sendback` 预览并回复 `确认发送`（或 `改：<新文本>` / `取消`）防误艾特发回原群；已发回的草稿会自动消费，防止重复误发。

---

## 四、安全防线、项目绑定与团队协作（`v0.5` ~ `v0.7`）

- **出站凭证脱敏与防注入（`v0.5`）**：正文、内存上下文、`/debug` 审计事件流及文本/`.md` 附件强制扫描私钥、数据库连接串、JWT、Bearer Token、API Key 及大小写不敏感敏感键值对（含 `AWS_SECRET_ACCESS_KEY` / `api_key=` / `*_SECRET` 等），命中片段替换为 `[已脱敏:<类型>]`；外部公开回复默认前置 `🤖 `（`chats.externalBotPrefix`），`<im-context>` 内嵌防提示词注入围栏。
- **项目工作区绑定（`@bot bind`）**：配置 `projects` 白名单后，按“提问显式提及 → 会话绑定 → 无绑定纯对话”解析工作区范围（支持在群内直接 `@bot bind <当前会话> <项目|unbind>`），避免越界翻查无关仓库。
- **共享 Git 目录指针（`v0.6`）**：配置 `sharedContextDir` 后按 TTL 防抖后台执行 `git pull --ff-only`（离线或冲突自动降级保留本地缓存），仅在提示头注入 2 行共享目录指针供 `opencode` 按需查阅。
- **两级外部白名单策略（`chats.collaborators`）**：白名单同事触发时代码中强制挂载严格只读护栏，预拦截主人的管理/控制指令，支持默认 `confirm_in_self`（草稿发回你自聊确认再发出）与 `auto_readonly`（限定授权项目内自动回复 `🤖 `）。
- **2 态 C2C 异步委托（`v0.7`，`@bot delegate`）**：用人类可读文本加末尾单行 `[cobot:req id=... proj=...]` / `[cobot:res re=...]` 仅在私聊 (`direct`) 与已知同事 `co-bot` 互通；按委托 ID 去重防回环、正文同步校验授权项目边界，对端离线时自然保持为一条普通留言等待本人处理。

---

## 五、常用 `@bot` 指令速查表

> 所有指令亦支持通过 `@<Bot名> <指令>` 定向作用于指定 Bot 或群组。

| 分类 | 指令 | 作用 |
| --- | --- | --- |
| **对话与团队** | `@bot <问题>` / `@<Bot名>` / `@<群名>` | 向主 Bot 或指定 Bot / 群组提问；`@bot bye` 结束自聊连续对话 |
| **私密草稿** | `@bot! <问题>` / `@bot -p <问题>` | 外部群提问并将草稿仅发回自聊 |
|  | `@bot sendback [草稿ID]` | 在自聊预览草稿并确认发回原群（`确认发送` / `改：...` / `取消`） |
| **管群与纪要** | `@bot chats [self\|all\|reset]` | 查看外部会话策略、批量切全静默 / 放行或重置运行期静音与触发模式覆盖 |
|  | `@bot mute\|unmute [群]` | 即时静音或取消静音当前群或指定外部群（`self` 不可静音） |
|  | `@bot summary <群名> [条数] [重点]` | 在自聊悄悄生成外部群近况纪要（支持 `1～200` 条，别名 `汇总` / `纪要`） |
| **项目与委托** | `@bot bind [项目\|路径\|unbind]` | 查看/绑定/解绑会话目录；支持 `bind <会话> <项目\|路径\|unbind>` |
|  | `@bot delegate <会话> [proj:<项目>] <问题>` | 向已知同事 `co-bot` 发起私聊异步委托（别名 `委托`） |
| **会话与控制** | `@bot status [群]` | 查看运行诊断、团队成员（含 `dead` 异常）、上下文占用与指定外群上下文 |
|  | `@bot new [话题]` / `task [序号]` / `compact [群]` | 新建会话 / 列出并切换最近 5 个会话 / 压缩当前或指定外群上下文 |
|  | `@bot stop` / `help` | 停止当前任务并清空队列 / 查看指令指南；卡片支持 `ok/always/no/skip` |

---

## 六、核心配置说明（`config.json`）

基础示例见 [config.example.json](../config.example.json)，以下展示常用团队协作字段：

```json
{
  "openmausbot": { "url": "http://127.0.0.1:8799", "token": "", "autoStart": true, "cliComputerOff": true },
  "channel": { "use": "sim", "options": {} },
  "web": { "host": "127.0.0.1", "port": 8787 },
  "selfChat": {
    "trigger": "@bot",
    "botName": "co-bot",
    "followUpWindowMs": 120000,
    "quietHours": { "enabled": false, "start": "22:00", "end": "08:30" }
  },
  "chats": {
    "mode": "owner_everywhere",
    "externalReplyMode": "inline",
    "externalBotPrefix": "🤖 ",
    "externalSanitizeMentions": "all",
    "collaborators": [
      { "id": "col_alice", "name": "Alice", "policy": "confirm_in_self", "projects": ["order"] }
    ]
  },
  "projects": [{ "name": "order", "path": "/srv/repos/order", "aliases": ["订单"] }],
  "sharedContextDir": "",
  "sharedContextPullIntervalMs": 300000,
  "dataDir": "./data"
}
```

| 配置项 | 默认值 / 可选值 | 说明 |
| --- | --- | --- |
| `openmausbot.url` / `token` | `http://127.0.0.1:8799` / `""` | 后端地址与桌面端配对 Token（可由 `OMB_TOKEN` 覆盖） |
| `openmausbot.autoStart` / `cliComputerOff` | `true` / `true` | 本机回环自动拉起 CLI，并设主 Bot `computer=off` 直通本地 `opencode` |
| `channel.use` / `options` | `"sim"` / `{}` | IM 通道插件与账号参数（`selfId`、`selfChatId` 等） |
| `selfChat.trigger` / `botName` | `"@bot"` / `"co-bot"` | 默认唤醒词与协调助手名称 |
| `selfChat.resultChars` / `softSplitChars` | `1500` / `2800` | 单气泡字数阈值与双气泡软拆上限 |
| `chats.mode` | `"owner_everywhere"` \| `"self_only"` | 是否允许本人在外部群/私聊触发 |
| `chats.externalReplyMode` | `"inline"` \| `"draft_first"` | 外部群默认原地回复或先发自聊草稿 |
| `chats.externalBotPrefix` | `"🤖 "` | 外部公开回复前缀（独立 Bot 账号场景可设 `""`） |
| `chats.externalSanitizeMentions` | `"all"` \| `"dangerous"` \| `"none"` | 外部群出站 `@` 防误艾特策略 |
| `chats.collaborators` | `[]` | 白名单同事权限，支持 `confirm_in_self` / `auto_readonly` |
| `projects` | `[]` | 项目工作区白名单（支持 `{ name, path, aliases }` 或 `{ name: path }`） |
| `sharedContextDir` / `PullIntervalMs` | `""` / `300000` | 团队共享 Git 仓库目录及后台拉取间隔（毫秒） |

---

## 七、Web 模拟器（`/sim`）与诊断台（`/debug`）

- **`/sim`（`http://127.0.0.1:8787/sim`）**：模拟自聊、`研发架构群` 与外部私聊；支持粘贴/上传图片、放大灯箱预览、纯 Markdown 文本交互（与真实 IM 保持一致，业务消息无交互按钮）、气泡一键撤回与历史持久化（`data/sim-history.json`）。
- **`/debug`（`http://127.0.0.1:8787/debug`）**：纯本机只读诊断台，展示运行指标、`dead` 异常预警、插件能力声明、会话策略与一键**静音/允许**（内置防误静音 `self` 保护）、项目绑定/共享目录/C2C 委托统计、**一键导出脱敏诊断包**（`/api/debug/bundle`），以及按 `chatId` / `source` / `type` / `limit`（默认最近 250 条，含 `security_redacted`、`policy_denied`、`delegation_req`、`delegation_res`、`recall`、`sendback`、`turn_failed` 等）筛选的实时事件流。

---

- **真机验收、排障与多用户隔离部署**：[docs/TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
- **架构演进路线与克制红线**：[docs/ROADMAP.md](./ROADMAP.md)
