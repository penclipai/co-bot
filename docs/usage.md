# `co-bot` 使用指南

> 本指南涵盖启动运维、自聊与外部群交互、统一转发与按需翻页、`@同事` 追问确认、团队协作、`@bot` 指令速查以及 `/sim` 与 `/debug` 用法。内网/第三方 IM 对接规范见 [IM 通道接入协议规范](./IM_PROTOCOL.md)，真机验收、故障排查与多实例部署见 [接入排障与多用户部署](./TROUBLESHOOTING.md)。

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

- **唤醒与接力**：自聊中用 `@bot <问题>`（默认对齐后端主协调 Bot `co-bot`，回复统一带 `🤖 **[bot]**` 徽章以便与本人人工消息区分；如需隐藏主 Bot 徽章可设 `selfChat.hideChiefPrefix: true`）或 `@<Bot名>` / `@<群名>` 指定协作对象；引用任意历史回复即可跨线程续聊。状态（含自聊续聊焦点与时间、待确认发回预览、多段软拆草稿、待处理卡片与启动对账、待回追问、在途委托、已撤回消息墓碑、`context_pull` 句柄及运行期静音/项目绑定）持久化在 `data/bridge-state.json` 与 `data/pull-grants.json`，重启后自动恢复。
- **协调收件箱与连续对话窗口（默认 120s）**：发送 `@bot status` 可一屏查看当前所有带统一短编号 `#1` / `#2` 的待处理审批卡、待确认发回、私密草稿、待回 `@同事` 追问与 C2C 委托，并直接用 `#1 确认` / `#1 1` / `#1 0` / `#1 取消` / `#1 改：<内容>` 在自聊单步消项；Bot 回复后在 `followUpWindowMs` 内可免 `@` 直接发文字，或连续发送图片/文件（`imageBatchMs` 默认 1.5s 防抖合批）；以 `#`、`备忘`、`记一下`、`笔记`、`便签`、`todo`、`待办`、`清单` 开头的消息视为个人笔记自动忽略；连续对话期间在自聊转发单条或合并聊天记录不会提前打断抢答，等发送 `@bot ...` 时一次性直接作为前文打包注入，并在本轮消费完毕后自动清空（私人笔记严格隔离，Prompt 与按需拉取接口均不可读）；发 `@bot bye` / `退下` 随时退出。
- **气泡控制与多媒体**：中间思考口语短窗合并上屏（单轮最多 2 条）；正文在 `resultChars`～`softSplitChars`（1500～2800 字）间智能拆为 2 段，超长自动截断并附脱敏 `.md` 原文；支持入站音频转写（`transcript` / `transcribeAudio`）、`linkCard` 及 Bot 生成图片/文件的自动回传。
- **原生斜杠命令透传**：支持 `@bot /goal <目标>`（进入 Goal 自动多步推进模式，群组 `@<群名> /goal` 同样适用）、`@bot /learn [步骤]`（沉淀为可复用技能）、`@bot /burst <并行任务>`（生成预览伪卡片，回复 `1`/`0` 或 `ok`/`no` 启动并发执行或取消）、`@bot /setup [职责]`（回复 `1`/`0` 或 `ok`/`no` 确认团队/人设提案）及自定义 `/<skill>`；斜杠命令发送时自动置顶并把项目/上下文块附于其后，确保与 OpenMausBot 原生契约完全兼容（仅限本人使用）。
- **卡片交互与免打扰**：

| 场景 | 手机快捷回复 / 行为 | 说明 |
| --- | --- | --- |
| 权限 / 提案审批卡 | `1`（或 `ok`）/ `2`（或 `always`）/ `0`（或 `no`），多卡支持 `#编号 1/0` | 允许本次 / 总是允许（仅权限卡）/ 拒绝（结构化 Markdown 伪卡片适配全 IM 客户端） |
| `/burst` 并发任务卡 | `1`（或 `ok`）/ `0`（或 `no`） | 启动并发执行 / 取消（完成后自动汇总回复） |
| 选项 / 提问卡 | `1`~`N`、多选 `1,2`、中文序数或 `0` 取消 | 多题自动逐题推进，亦支持直接回复自定义答案 |
| 阻塞凭据 / 登录卡 | `0` / `skip` / `跳过` | 远程跳过桌面端凭据、连接器或登录验证步骤 |
| 免打扰汇总 | `@bot quiet [on\|off\|flush]` 或 `selfChat.quietHours` | 免打扰时段暂存普通推送与超时提醒并在窗口结束自动汇总（审批卡仍即时穿透，`@bot status` 可查看待汇总条数） |

---

## 三、外部群与私聊协作

无需注册独立 Bot 账号，直接用本人账号在外部群或他人私聊触发（`chats.mode: "owner_everywhere"`，若只需自聊可设为 `"self_only"`）：

- **安全触发与防误触**：默认仅**本人**消息可唤醒 Bot，群成员消息仅进内存环形上下文（默认容量 120 条）；支持句首与句中自然召唤，自动跳过代码块、行内反引号、中英文引号及 Markdown 引用块（`> ...`）与 `@\u200Bbot`；仅发 `@bot` / `@bot!` 引用同事消息或附件时直接分析引用内容；引用 Bot 回复并 `@同事` 转交不重触 Bot。
- **按需探索上下文（默认 L3 拉取模式）与引用兜底**：默认 `chats.injectRecentContext: false`，仅注入引用消息（内存/历史未命中时自动使用协议内联 `quote` 快照兜底）、近期明确提及文件/截图时的附件（`hasArtifactReference`）及多群检索指针 `context_pull`；若后端 OpenMausBot 为远端非回环地址自动降级为注入最近 6 条，避免无拉取入口失明。可通过 `/api/context/history` 分片读取超长日志或合并转发（`&msgId=`）、向前翻页（`&before=`）、过滤人类讨论（`&excludeBots=1`）、只看文件（`&onlyFiles=1`）或按关键词搜索（`&q=`）；自聊下主协调 Bot 在存在外部活跃会话时常驻轻量跨群坐标 `external_chats` 与 `/api/context/chats` 入口（强制本机回环校验、15 次/分限流、已撤回消息过滤与自聊 `# 备忘` 隔离）。
- **上下文增强与隔离**：自动携带引用或同批次连续附件（默认 2 分钟内最多 4 个，含合并转发内嵌附件），支持通过通道可选 `getMessage` / `getHistory` 穿透更早历史，并在收到 `recall` 撤回事件时立即从路由、附件、拉取缓存与衍生草稿中擦除；每个 `(chatId, botId)` 绑定独立 Thread（创建失败直接报错中止，禁止回退混入自聊主线），外群上下文默认在 75%（`chats.autoCompactThreshold`）静默后台压缩，自聊或关闭自动压缩的会话达 80% 时提醒手动压缩；所有敏感指令与审批卡片在外部群执行时一律重定向回**自聊**并保留来源标注；开启 `chats.passiveMentionAlert: true` 后，非白名单同事在外部群 `@本人` 会在群内保持静默，同时按免打扰策略向自聊推送待办提醒。
- **原地直发 vs 私密起草与多草稿队列（`@bot!` + `sendback` + `@同事` 追问闭环）**：
  - **原地直发**（`externalReplyMode: "inline"`）：静音中间思考，出站前自动对 `@所有人` / `@同事` 插入零宽空格防误艾特（保留邮箱与代码块）；
  - **私密起草回发**（`@bot! <问题>` / `@bot -p <问题>` 或设为 `"draft_first"`）：仅在自聊生成带 `#编号` 与 `draft_xxx` 标识的草稿（润色后保留 `@同事` 追问元数据且不抢占自聊焦点）；支持直接回 `#1 确认` / `#1 取消` / `#1 改：<新文本>`，或引用草稿回 `确认发送` / `ok` / `改：<新文本>` / `忽略` / `no`，亦支持 `@bot sendback [#1|草稿ID]`（多待办碰撞时自动输出 `#编号` 消歧指引，发送失败保留草稿可重试）；
  - **`@同事` 追问确认与一次性回流**：Bot 在群聊中发现仍缺某位成员确认信息时，可输出 `[cobot:ask chat=<会话> to=<同事>] <追问>` 提案标记；网关会从公开回复剥离该标记，按群内自动学习到的真实成员 ID 绑定结构化 `mentions` 并推送至**自聊确认**；你回复 `确认发送` 或 `#1 确认` 后再以真 `@` 发出（`@所有人` 仍被拦截），目标同事回复（含附带图片/文件）时触发一次性回流并接续原分析 Thread，最终结论仅私密发回**自聊**（默认 15 分钟未收到回复在非免打扰时段提醒，支持 `#1 取消` 停止等待）。

---

## 四、安全防线、项目绑定与团队协作（`v0.5` ~ `v0.7`）

- **出站凭证脱敏与防注入（`v0.5`）**：正文、内存上下文、`/debug` 审计事件流及文本/`.md` 附件强制扫描私钥、数据库连接串、JWT、Bearer Token、API Key 及大小写不敏感敏感键值对（含 `AWS_SECRET_ACCESS_KEY` / `api_key=` / `*_SECRET` 等），命中片段替换为 `[已脱敏:<类型>]`；外部公开回复默认以 `🤖 **[bot]**` 徽章开头（可通过 `chats.externalBotPrefix` 改为自定义字符串前缀或置空），`<im-context>` 内嵌防提示词注入围栏；内部路径与面板泄露拦截同时覆盖外部直发、发回草稿与 C2C 协作回复。
- **项目工作区绑定（`@bot bind`）**：配置 `projects` 白名单后，按“提问显式提及 → 会话绑定 → 无绑定纯对话”解析工作区范围（支持在群内直接 `@bot bind <当前会话> <项目|unbind>`），并对协作者同步拦截未授权项目名与越界绝对路径，避免翻查无关仓库。
- **共享 Git 目录指针（`v0.6`）**：配置 `sharedContextDir` 后按 TTL 防抖后台执行 `git pull --ff-only`（离线或冲突自动降级保留本地缓存），仅在提示头注入 2 行共享目录指针供 `opencode` 按需查阅。
- **两级外部白名单策略（`chats.collaborators`）**：白名单同事触发时代码中强制挂载严格只读护栏，预拦截主人的管理/控制指令，支持默认 `confirm_in_self`（草稿发回你自聊确认再发出）与 `auto_readonly`（限定授权项目内自动回复），并可通过 `chats.collaboratorBot` 指定专用受限只读 Bot。
- **2 态 C2C 异步委托（`v0.7`，`@bot delegate`）**：用人类可读文本加末尾单行 `[cobot:req id=... proj=...]` / `[cobot:res re=...]` 仅在私聊 (`direct`) 与已知同事 `co-bot` 互通；严格校验回执来源与委托编号匹配、按委托 ID 去重防回环、正文同步校验授权项目边界，支持通过收件箱 `#编号 取消` 终止本地追踪，对端离线时自然保持为一条普通留言等待本人处理。

---

## 五、常用 `@bot` 指令速查表

> 所有控制指令与参数细节按作用域划分：通用控制词支持 `@bot`、`@<Bot名>` 与 `@<群名>`，`status`/`compact` 仅支持 `@bot` 或具体 `@<Bot名>`，全局治理指令仅限主入口 `@bot`。

| 分类 | 指令 | 作用 |
| --- | --- | --- |
| **对话与收件箱** | `@bot <问题>` / `@<Bot名>` / `@<群名>` | 向主 Bot 或指定 Bot / 群组提问；`@bot bye` 结束自聊连续对话 |
|  | `#编号 1/0/确认/取消` / `#编号 答：...` / `#编号 改：...` | 在自聊对收件箱中任意待处理卡片（含开放式提问卡）、草稿、追问或委托一键消项（`#1 买牛奶` 等普通文本仍作个人笔记忽略） |
| **私密草稿** | `@bot! <问题>` / `@bot -p <问题>` | 外部群提问并将草稿仅发回自聊 |
|  | `@bot sendback [#编号\|草稿ID\|confirm\|cancel]` | 在自聊预览/确认/取消发回原群草稿（亦支持引用草稿回 `确认发送` / `ok` / `改：...` / `忽略`） |
| **管群与免打扰** | `@bot chats [self\|all\|reset]` | 查看外部会话策略、批量切全静默 / 放行或重置运行期覆盖（别名 `会话列表`） |
|  | `@bot mute\|unmute [群]` | 即时静音或取消静音当前群或指定外部群（`self` 不可静音；别名 `解除静音` / `取消静音` / `恢复通知`） |
|  | `@bot quiet [on\|off\|flush\|status]` | 查看/开关免打扰时段，或立即汇总积攒的主动通知（别名 `免打扰`） |
|  | `@bot summary <群名> [条数] [重点]` | 在自聊悄悄生成外部群近况纪要（支持 `1～200` 条，别名 `汇总` / `纪要`） |
| **项目与委托** | `@bot bind [项目\|路径\|unbind]` | 查看/绑定/解绑会话目录；支持 `bind <会话> <项目\|路径\|unbind>` |
|  | `@bot delegate <会话> [proj:<项目>] <问题>` | 向已知同事 `co-bot` 发起私聊异步委托（别名 `委托`） |
| **会话与队列** | `@bot status [群]` | 查看协调收件箱（含 `#编号`）、团队成员（含 `dead` 异常）与上下文占用 |
|  | `@bot new [话题]` / `task [序号]` / `compact [群]` | 新建会话 / 列出并切换最近 5 个会话（`0` 取消）/ 压缩当前或指定外群上下文 |
|  | `@bot steer [补充]` / `cancel` / `stop` / `help` | 对排队中任务立即插队 / 取消排队 / 停止当前任务与卡片 / 查看指令指南 |

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
| `openmausbot.autoStart` | `true` | 本机回环自动拉起 OpenMausBot CLI |
| `channel.use` / `options` | `"sim"` / `{}` | IM 通道插件与账号参数（`selfId`、`selfChatId` 等） |
| `web.host` / `port` | `"127.0.0.1"` / `8787` | `/sim`、`/debug` 与本机按需拉取监听地址与端口 |
| `selfChat.trigger` / `botName` | `"@bot"` / `"co-bot"` | 默认唤醒词与协调助手名称 |
| `selfChat.followUpWindowMs` / `quietHours` | `120000` / `22:00~08:30` | 自聊免 `@` 续聊窗口与免打扰时段 |
| `chats.mode` | `"owner_everywhere"` \| `"self_only"` | 是否允许本人在外部群/私聊触发 |
| `chats.externalReplyMode` | `"inline"` \| `"draft_first"` | 外部群默认原地回复或先发自聊草稿 |
| `chats.allowChatIds` / `denyChatIds` | `[]` | 允许/禁止触发的外部会话白名单与黑名单 |
| `chats.triggerAliases` | `[]` | 主触发词的额外别名 |
| `chats.collaborators` / `collaboratorBot` | `[]` / `""` | 白名单同事权限（`confirm_in_self` / `auto_readonly`）及可选专用受限 Bot |
| `chats.passiveMentionAlert` | `false` | 开启后外部群非白名单同事 `@本人` 会私密转自聊提醒 |
| `projects` | `[]` | 项目工作区白名单（支持 `{ name, path, aliases }` 或 `{ name: path }`） |
| `sharedContextDir` | `""` | 团队共享 Git 仓库目录（后台防抖 `git pull --ff-only`） |
| `plugins` / `dataDir` | `{}` / `"./data"` | 插件启停与运行状态持久化目录 |

> 高级调优参数（通常保持默认即可）：`selfChat.turnTimeoutMs`（默认 `600000`，硬超时自动中止）、`selfChat.cardTtlMs`（`1800000`）、`selfChat.draftTtlMs`（`1800000`）、`selfChat.followUpRemindMs`（`900000`）、`selfChat.delegationRemindMs`（`1800000`）、`selfChat.resultChars`/`softSplitChars`（`1500`/`2800`）、`chats.injectRecentContext`（`false`）、`chats.autoCompactThreshold`（`0.75`）、`chats.externalBotPrefix`（`"🤖 "`）、`chats.externalSanitizeMentions`（`"all"`）。完整字段校验以 [src/config.ts](../src/config.ts) 为准。

---

## 七、Web 模拟器（`/sim`）、诊断台（`/debug`）与热插拔插件（`plugins/`）

- **`/sim`（`http://127.0.0.1:8787/sim`）**：模拟自聊、`研发架构群` 与外部私聊；支持粘贴/上传图片、放大灯箱预览、通用 Markdown 文本与草稿/解除静音快捷操作胶囊、单条「转发到自聊」与右上角「多选 → 逐条→自聊 / 合并→自聊 / 合并→当前群」、超长转发原文与合并转发记录卡折叠展开、出站真 `@同事` 徽章展示、气泡一键撤回及历史持久化（`data/sim-history.json`）。
- **`/debug`（`http://127.0.0.1:8787/debug`）**：本机诊断台（含应急静音/放行开关），展示协调收件箱待办计数、`idPatterns`/`strictContract`/契约告警数、`dead` 异常预警、插件能力声明与 `plugins/` 扩展状态、会话策略与一键**静音/允许**（内置防误静音 `self` 保护）、项目绑定/共享目录/C2C 委托统计、**一键导出脱敏诊断包**（`/api/debug/bundle`），以及按 `chatId` / `source` / `type` / `limit`（默认最近 250 条，含 `contract_warning`、`context_pull`、`followup_reply`、`security_redacted`、`internal_leak_intercepted`、`policy_denied`、`delegation_req`、`delegation_res`、`recall`、`sendback`、`turn_timeout`、`turn_failed` 等）筛选的实时事件流。
- **即插即用扩展（`plugins/`）**：把自定义通道插件、命令、出站脱敏器、钩子或音频转写扩展放到 `./plugins/` 目录即可自动扫描加载（`pluginsStrict: false` 时单插件异常自动隔离不影响主链路）；非通道扩展插件支持通过 `/api/debug/action` 执行 `reload_plugin` 热重载。

---

- **内网/第三方 IM 接入协议规范**：[docs/IM_PROTOCOL.md](./IM_PROTOCOL.md)
- **真机验收、排障与多用户隔离部署**：[docs/TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
- **架构演进路线与克制红线**：[docs/ROADMAP.md](./ROADMAP.md)
- **协调者完备性形式化推导与验证**：[docs/FORMAL_COMPLETENESS.md](./FORMAL_COMPLETENESS.md)
