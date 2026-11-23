# co-bot

**IM 手机自聊 `@bot` → 本机极薄网关 `co-bot` → 本机 `OpenMausBot`**。

支持 **Linux / macOS / Windows** 跨平台部署；将 `openmausbot` 作为正式依赖声明，内网只需一次 `npm install` 即可自动安装 OpenMausBot CLI，搭配已有 `opencode`（或 Claude / Codex / 内网 OpenAI-compatible 引擎）与 `npm run daemon` 自动拉起使用，同时兼容 OpenMausBot 桌面端配对模式。

## 运行要求

- **Node.js >= 24**（运行内置 `openmausbot` CLI 依赖所需；仅连接远端 OpenMausBot 时 `co-bot` 本身需 Node >= 22.5）
- 已配置可用的底层引擎 CLI（推荐本机预先安装 `opencode`）

## 快速开始（内网 `npm install` 一键拉起）

1. 在项目根目录执行一次依赖安装（自动从当前 npm 源安装 `openmausbot`）：
   ```bash
   npm install
   ```
2. 后台常驻启动（复制 `config.example.json` 为 `config.json` 或直接运行；若本机尚未运行 OpenMausBot，`npm run daemon` 会自动拉起依赖里的 OpenMausBot CLI，并将 CLI 主 Bot 的 `computer` 设为 `off` 以直通本地 `opencode`）：
   ```bash
   npm run daemon         # Linux / macOS / Windows 通用后台启动（先确保 OpenMausBot 就绪，再启动 co-bot）
   npm run check          # 自检配置文件（未知字段/端口/时间校验）与 Node/openmausbot/opencode/OpenMausBot 状态（可选 -- --fix-cli / --apply-style）
   npm run status         # 查看 co-bot 与 OpenMausBot 状态
   npm run restart        # 平滑重启 co-bot（不中断 OpenMausBot 里的进行中任务）
   npm run stop           # 仅停止 co-bot（加 -- --all 可一并停止托管的 OpenMausBot CLI）
   npm run omb -- status  # 单独管理本机 OpenMausBot CLI（ensure|start|stop|restart|status|logs）
   npm run daemon -- install-service --dry    # 预览开机自启服务配置（去掉 --dry 即写入 systemd / LaunchAgents / Windows 启动项）
   npm run daemon -- uninstall-service        # 卸载开机自启服务
   npm start              # 仅前台运行 co-bot（Web 自聊模拟器 http://127.0.0.1:8787/sim）
   npm run lint           # 运行 ESLint 规范检查（含 1000 行上限校验）
   npm run lint:fix       # 自动修复可修复的格式问题
   npm test               # 运行单元测试（node --test）
   ```

- **开机自启与日志轮转**：`npm run daemon -- install-service` 自动生成 Linux `systemd --user`（`~/.config/systemd/user/co-bot.service`）、macOS `LaunchAgents`（`~/Library/LaunchAgents/com.cobot.agent.plist`）或 Windows 登录静默启动脚本；运行中进程每 6 小时自动按 `10 MB` 上限 copy+truncate 轮转 `cobot.log` / `openmausbot.log`。
- 相关开关（`config.json` 的 `openmausbot` 下）：`autoStart`（默认 `true`，仅对本机回环地址生效）与 `cliComputerOff`（默认 `true`）。

> 若你本机使用 **OpenMausBot Desktop App**（需要图形桌面控屏或内置浏览器），桌面端默认启用配对鉴权，首次执行一次 `npm run pair`（在桌面端弹窗点击 Allow）或 `npm run pair -- <12位配对码>` 将会话 Token 写入已忽略提交的 `config.json` 即可。

## 自聊用法（co-bot 协调助手体验）

- **`@bot <内容>`**（或 `@co-bot` / `@ai`）：发给默认主协调 Bot（可在 `selfChat.botName` 自定义展示名，默认 `co-bot`，并通过 `openmausbot.syncChiefIdentity` 自动对齐后端主 Bot 名称与 `Coordinator Bot` 身份）。主 Bot 1v1 私聊默认省略名字前缀（`hideChiefPrefix: true`），主动通知与管理指令统一显示 `co-bot`。
- **短时连续对话与贴图直发（默认 2 分钟）**：主 Bot / 指定 Bot 回复后，`selfChat.followUpWindowMs`（默认 `120000` ms，设为 `0` 可关闭）内不用再打 `@bot`，直接发文字或连续发送图片/文件（`imageBatchMs` 防抖合批，默认 `1500` ms）即可续聊；以 `#`、`备忘`、`记一下`、`笔记`、`todo` 开头的自聊笔记不会被误发；回复 `@bot bye` / `退下` 可随时结束。
- **`@<Bot名> <内容>`** / **`@<群名> <内容>`** 与 **引用气泡**：随时 `@` OpenMausBot 团队里的其他 Bot（自动标出 `**[Bot名]**`）或协作群组（自动标出 `**[群名 · 发言Bot名]**`，支持群内多 Bot 接力回复、群会话切换 `tasks`/`new` 与 `stop`/`steer`/`cancel`）；点击或引用历史回复气泡可跨线程续聊（`focus`、`msgRoute`、`quietQueue`、`pendingCards`、`deliveredOmbIds`、`inFlightTurns`、`privateDrafts` 均防抖持久化在 `data/bridge-state.json`，损坏自动 `.corrupt` 备份自愈，重启续接在途任务不丢回复；临时附件默认保留 7 天自动清理 `fileRetentionDays`）。
- **会话创建、切换与上下文**：
  - `@bot new [新话题]` / `@bot compact`：新建干净会话 / 压缩当前长会话上下文；
  - `@bot tasks` / `@bot task <序号>`：列出最近 5 个会话并支持数字 `1`～`5` 快速切换；
  - `@bot context`：查看当前会话 Token 上下文占用率；超过 80% 时自动提醒压缩；
  - `@bot memory` / `记住 <规则>`：查看或直接向当前 Bot 写入长期记忆条目。
- **Web 模拟器 `/sim` 增强**：支持消息内联图片缩略图与点击放大灯箱预览，并将历史记录持久化在 `data/sim-history.json`。
- **中间进展、分气泡与卡片交互**：
  - Bot 思考中的中间口语会按 `intermediateCoalesceMs`（默认 `700` ms）短窗合并，且单轮最多发送 `maxIntermediateBubbles`（默认 `2`）条中间气泡，超出部分自动合入最终回复以防手机连续震动；长工具调用进展以中文摘要去重推送（默认 `maxProgressUpdates: 2`）；
  - 短回复 1 条到位；`1500`～`2800` 字（`resultChars`～`softSplitChars`）智能按段落与代码块围栏拆成 2 条气泡直接阅读；超过 `softSplitChars` 自动截断并附 `.md` 原文；
  - **权限审批卡**：支持 **`ok`** 允许、**`always`** 总是允许（传 `always` / `rememberCommand`）、**`no`** 拒绝；**选项/提问卡与列表**：支持数字 `1` / `2` 或中文口语序数（如 `第一个`、`选2`、`三号`）；**桌面端凭据/连接器/登录卡**：支持回复 **`skip` / `跳过`** 远程跳过继续执行（Web 模拟器 `/sim` 内可直接点快捷按钮）。
- **忙时排队与插队**：前一条任务仍在执行时新消息自动提示排队状态，可发 **`@bot steer`**（或 **`插队`**）即时插队，或发 **`@bot cancel`** 取消排队；也可随时 `@bot stop` 中断执行。
- **协调助手人格**：开机自检可执行 `npm run check -- --apply-style` 将主 Bot 设为 `conversational` 回复风格与 `co-bot`（Coordinator Bot）移动端简洁人格。
- **主动通知与免打扰**：OpenMausBot 定时 Routine / 异步推送以 `🔔` 回流；在 `config.json` 配置 `selfChat.quietHours` 后，免打扰期间通知自动攒成汇总，发 `@bot digest` 可随时查看。
- **审批模式与状态诊断**：`@bot status` 与 `@bot bots` 展示 OpenMausBot `doctor` 自检报告、`approvalMode`（`ask`/`auto`/`full`）与队友协作等待状态，可用 **`@bot approval [ask|auto|full]`** 切换审批策略。
- **其他常用指令**：`@bot bots`、`@bot status`、`@bot help`。
- **稳定性保护**：支持长任务停滞看门狗（`selfChat.turnStallMs`，超时在自聊提醒并附 `stop` 按钮）、IM 断线出站缓冲重放与按会话串行发送队列。
- **原生附件、语音与链接卡片互通**：
  - 手机发来的图片/日志（或 Web 模拟器 `Ctrl+V` 粘贴 / `+` 上传）自动上传至 OpenMausBot 并嵌入原生 `<attached-image>` / `<attached-file>` 标签；支持音频/语音附件转写（入站 `transcript` 字段或自定义 `transcribeAudio` 钩子）与 `linkCard` 转发链接卡片摘要解析；
  - OpenMausBot 回复中产生的图片或文件会自动拉取并通过 `sendFile` 发回自聊；超长正文自动附带 `.md` 原文附件。

## 任意群 / 私聊 `@bot` 与会话上下文

无需建独立 Bot 账号，只需在你自己的账号所在的**任意群聊或私聊**中由本人发送 `@bot <问题>`，即可直接调用本地 OpenMausBot：

- **仅本人可触发（安全隔离）**：其他群成员发的 `@bot` 或普通消息仅做内存窗口缓存用于上下文理解，绝不会触发你本机的 OpenMausBot；通过 `chats.enabledTypes` / `allowChatIds` / `denyChatIds`（或 `"mode": "self_only"`）可细粒度控制生效会话。
- **句首/句中 `@bot` 触发与防误触**：
  - 支持句首指令/提问（`@bot ...`、`@Plum ...`）与句中自然召唤（`@Alice 别急，@bot 帮看下`），但会跳过反引号代码（`` `@bot` ``）、引号包裹（`「@bot」`、`"@bot"`）与零宽防误触标记（`@\u200Bbot`），避免技术讨论或复读误触发；
  - 对着同事消息或附件直接回复 `@bot` / `@bot!`（无额外正文）也会自动带上引用正文/附件交由 Bot 分析，而不是弹出帮助菜单；
  - 引用 Bot 回复并转交同事（如 `辛苦 @Bob 按上面排查`）不会二次触发 Bot，而引用 `co-bot` 回复写 `@Plum ...` 则会带着上文分析接力交给 `Plum`。
- **出站 `@提及` 自动防误艾特**：在外部群/他人私聊公开回复时，通过 `chats.externalSanitizeMentions`（默认 `"all"`，可选 `"dangerous"` / `"none"`）自动对散落 `@所有人` / `@同事` / `@Bot` 插入零宽空格（`@\u200B...`）防误触发，同时保留邮箱（`ops@example.com`）与代码块原貌；使用 `@bot!` / `-p` 发回**自聊**的私密草稿仍原样保留 `@`。
- **原地回复 vs 私密起草与确认回发**：
  - `@bot 总结一下刚才的分歧` → 引用你的触发消息原地回复（仅发送干净终稿，中间思考噪声通过 `externalSilentProgress` 自动静音）；引用 Bot 的回复继续追问即可接力该话题；
  - `@bot! 总结成周报` 或 `@bot -p ...` → 把完整答复加上 `📩 私密回复 · 来自「xxx」` 标签发回你的**自聊**，群里零打扰；草稿持久保存（默认 30 分钟），可在自聊引用草稿后 `@bot 改得更委婉简短` 连续润色新版并继承原群路由；
  - 对自聊收到的私密草稿（初版或润色版）发送 `@bot sendback`（或直接点草稿下方按钮）→ 在自聊预览确认后再回复 **`确认发送`**（或 `改：<新文本>` / `取消`），确认后自动做 `externalSanitizeMentions` 防误艾特并引用原群触发消息发回原群。
- **结构化 `@提及`、撤回擦除与连发多附件合批**：
  - 支持 `InboundEvent` 结构化 `mentions` 与 `kind: "recall"` 撤回事件（`/sim` 提供 `POST /recall`）；成员撤回消息后即时从内存窗口、历史回填白名单、待传队列及本地附件缓存擦除；
  - 群成员短时间（`chats.recentAttachmentWindowMs`，默认 `120000` ms）内连发多张截图或日志时，只需引用其中一条或直接提问如 `@bot 对比上面两份日志`，系统自动按时间顺序打包同批连续附件（上限 `chats.maxAutoAttachments`，默认 `4`）一并上传给 OpenMausBot。
- **引用理解 + 最近对话 + 历史穿透**：
  - 触发时自动附带被引用消息正文/发送者、被引用同事消息里的日志或图片附件，以及该会话最近 `chats.contextWindow`（默认 `15`）条消息的 `<im-context>` 摘要；若通道插件实现了可选的 `getMessage` / `getHistory`，还能穿透内存窗口读取 IM 服务端更早历史。
- **动态管群、跨群纪要与私密回发（自聊控制）**：
  - `@bot chats` 查看各群/私聊状态；`@bot chat mute|allow <群名|chatId>` / `@bot chat mode self_only|everywhere|reset` 无需改配置即时静音或恢复会话，状态持久化至 `data/bridge-state.json`；
  - `@bot summary <群名> [条数] [关注重点]`（或 `@bot 汇总 <群名>`）在自聊悄悄生成目标群讨论纪要，原群零消息、零打扰；
  - 外部群使用 `@bot! <问题>` 私密起草并仅发回自聊，可在自聊继续引用润色并发送 `@bot sendback` 预览确认后防误艾特发回原群；若配置 `chats.externalReplyMode: "draft_first"`，外部回复会默认先生成自聊草稿待确认再发出。
- **出站安全门禁、防注入与项目边界（`v0.5`）**：
  - **出站凭证脱敏**：所有发往 IM 的正文与文本/`.md` 附件在出站前自动扫描 API Key、JWT/Bearer、私钥、数据库连接串与 `*_TOKEN`/`*_SECRET`，命中替换为 `[已脱敏:<类型>]` 并写入 `/debug` 安全审计；
  - **外部 `🤖 ` 标识与防注入**：外部群/私聊公开回复默认前置 `🤖 ` 防混淆；`<im-context>` 内置不可信外部数据围栏以静默抵御群内 Prompt Injection；
  - **极简项目绑定（`@bot bind`）**：支持 `projects` 白名单配置与 `@bot bind <项目|路径>` / `@bot bind unbind` 会话目录绑定，按“提问显式提及 → 会话绑定 → 无绑定纯对话”解析工作区范围。
- **共享目录指针与白名单同事只读协作（`v0.6`）**：
  - **共享 Git 目录指针**：配置 `sharedContextDir` 后在提问前按 TTL（默认 5 分钟）后台防抖执行 `git pull --ff-only`，仅在提示头注入 2 行目录指针交由 `opencode` 按需查阅；
  - **2 档外部白名单策略**：配置 `chats.collaborators` 可授权特定同事以只读护栏触发协助（`confirm_in_self` 默认先回自聊确认，或 `auto_readonly` 限定项目自动 `🤖 ` 回复），非白名单继续 100% 忽略。
- **极简 2 态 C2C 委托与弹性部署（`v0.7`）**：
  - 发送 `@bot delegate <会话|chatId> [proj:<项目>] <问题>`（或 `@bot 委托 ...`）通过 `[cobot:req]` / `[cobot:res]` 2 态标签与同事的 `co-bot` 互通协作（按 ID 幂等防回环，对端离线时自然保留为普通 IM 消息）。
- **话题隔离与长期运行治理**：
  - 每个 `(chatId, botId)` 自动绑定独立的 OpenMausBot Thread（`createTask(..., { select: false })` 持久化至 `data/bridge-state.json`），不同群/私聊互不串台，也不影响自聊当前焦点的 `focus` 与连续对话粘性；
  - 在自聊可用 `@bot context <群名>` 查看外群隔离上下文占用率、用 `@bot compact <群名>` 手动压缩指定外群 Thread；外群上下文超过 80% 会在自聊发出提醒并附一键压缩按钮，达到 `chats.autoCompactThreshold`（默认 `0.92`，设 `0` 可关闭）时后台自动静默压缩；
  - 审批/提问卡及敏感控制指令（`bots`、`status`、`memory`、`context`、`tasks`、`compact`、`chats`、`bind`、`delegate`、`sendback`、`approval`）在外部群执行时会自动重定向至**自聊**（带 `📍 来自「xxx」`），审批通过后最终答案仍按原约定回到目标会话。

## 接入真实 IM（插件化架构）

`co-bot` 采用轻量零依赖插件微内核（`Kernel` + `ChannelPlugin` 契约），将协议细节与 OpenMausBot 核心桥接彻底解耦。

### 通用 IM 通道插件（`im-plugin.js`）
1. 复制 [im-plugin.example.js](./im-plugin.example.js) 为根目录下的 `im-plugin.js`（已加入 `.gitignore`）。
2. 在 `defineChannelPlugin({ name, capabilities, create })` 中填写 `start`、`send`（以及可选的 `sendFile`、`download`、`notify`、`stop`）：
   - 微内核托管层 `ManagedChannel` 会自动接管**断线指数退避重连**、**`selfChatId` 自动学习**、**入站消息归一化（兼容 `InboundEvent` 与扁平 IM 消息）**及**脱敏遥测埋点**；
   - `OpenMausBotBridge` 会依据通道声明的 `capabilities`（`markdown`、`files`、`images`、`replyTo`、`actions`、`notify`、`maxChars`）自动降级为纯文本、按字数上限分段或跳过按钮。
3. 在 `config.json` 中启用（或通过 `--channel ./im-plugin.js` 命令行覆盖）：
   ```json
   {
     "channel": {
       "use": "./im-plugin.js",
       "options": { "selfId": "<你在 IM 的用户 id>", "selfChatId": "" }
     }
   }
   ```
4. 运行通用通道契约检测与实时收发验证：
   ```bash
   npm run channel:test -- --dry
   npm run channel:test -- --wait 15 --send "你好" --check-file
   ```

> 旧版 `{ connect, send }` 模块同样可通过 `channel.use: "./ipc-client.js"` 由 `channel-loader` 自动适配托管。

### 本地诊断与运维台（`/debug`）与排障手册
- 启动后访问 `http://127.0.0.1:8787/debug`（无头 IM 模式下访问 `/` 亦直达此页），可实时查看进程内存/运行时长、在途续接与断线缓冲指标、安全脱敏与越权拦截统计、项目绑定与 C2C 委托统计、已加载插件列表、当前通道 `capabilities` 声明、各群/私聊策略（支持直接点**静音/允许**）与隔离 Thread 列表、待确认回发草稿状态、OpenMausBot 在线 Bot/群组状态、一键**导出脱敏诊断包 JSON**，以及按 `chatId` / `source` / **`type`**（含 `security_redacted`、`policy_denied`、`delegation_req`、`delegation_res`、`recall`、`sendback`、`turn_resumed`、`turn_stalled`、`outbound_buffered` 等）筛选的最近 80 条脱敏事件流；Web 模拟器 `/sim` 同步支持气泡一键 **撤回** 与快捷提示。
- 真实 IM 上线核对与多用户/弹性部署指南见：[真实 IM 接入与常见排障手册](./docs/TROUBLESHOOTING.md)；演进蓝图见：[演进路线图（v0.5 ~ v0.7）](./docs/ROADMAP.md)。

## 目录结构

```text
src/index.js                  入口：日志轮转 + Kernel 插件微内核装配与启动
src/core/kernel.js            轻量零依赖插件微内核（provides/inject 拓扑装配、effect 逆序卸载、事件总线）
src/core/channel-contract.js  通用 IM 通道插件契约、capabilities 归一化与 ManagedChannel 托管基类
src/core/chat-context.js      按 chatId 隔离的内存环形上下文存储与 `<im-context>` 安全围栏格式化器
src/core/security.js          出站确定性凭证扫描脱敏、文本附件脱敏与 🤖 外部回复标识
src/core/projects.js          项目白名单归一化、@bot bind 目录解析与工作区范围声明
src/core/shared-context.js    共享 Git 目录后台防抖同步与 2 行路径指针注入器
src/core/inbound-policy.js    2 档外部白名单准入与只读安全护栏策略引擎
src/plugins/                  内置插件（web、channel-sim、channel-loader、im-context、openmausbot、inspector）
src/config.js                 零依赖配置加载（config.json + APP_ROOT 回退 + CLI/env 覆盖）
src/format.js                 文本截断、plain()、hardBreaks()、mdClip()、mdSplit() 与文件/原子写工具
src/web/server.js             极简本地 HTTP 服务（仅监听 127.0.0.1，同源/JSON 校验）
src/im/sim.js                 Web 手机自聊模拟器传输层（/sim，含撤回广播、快捷操作按钮与历史持久化）
src/openmausbot/client.js     OpenMausBot Harness HTTP + SSE 客户端
src/openmausbot/cards.js      审批卡、选项提问卡与工具进展格式化纯函数
src/openmausbot/mentions.js   @mention 解析、防误触掩码与时间纯函数
src/openmausbot/delegation.js 2 态 C2C 委托协议（[cobot:req] / [cobot:res]）与防回环追踪器
src/openmausbot/chat-manager.js 跨群策略、外部摘要、私密草稿确认回发管理器
src/openmausbot/state-store.js  Bridge 状态防抖持久化与损坏备份自愈存储
src/openmausbot/outbound-queue.js 按会话串行出站队列、出站脱敏拦截与断线缓冲重放器
src/openmausbot/turn-tracker.js SSE/Job 单轮追踪、停滞看门狗与中间气泡合并器
src/openmausbot/commands.js   @bot / @<Bot名> 指令分发与子命令处理器
src/openmausbot/persona.js    手机 IM 端 co-bot（Coordinator Bot）默认人格与防注入原则预设
src/openmausbot/bridge.js     极薄 IM <-> OpenMausBot 桥接器（按 channel.capabilities 自适应降级）
public/                       /sim 自聊模拟页、/debug 只读诊断页与 .md 附件预览页（view.html、md.js）
docs/ROADMAP.md               精简三步演进路线图（v0.5 ~ v0.7：安全底线、真实 IM 闭环、共享目录与 2 态 C2C 委托）
docs/TROUBLESHOOTING.md       真实 IM 接入上线 Checklist、排障与多用户隔离部署手册
.github/workflows/ci.yml      GitHub Actions 跨平台矩阵 CI（Ubuntu/Windows/macOS）
LICENSE                       MIT 开源许可证
scripts/channel-test.js       通用 IM 通道契约测试与收发验证器（npm run channel:test）
scripts/check.js              启动前配置合法性与 Node/openmausbot/opencode/通道插件自检
scripts/daemon.js             跨平台后台守护进程与自启服务管理（start/stop/restart/status/logs/install-service/uninstall-service）
scripts/service.js            跨平台开机自启服务生成器（Linux systemd --user / macOS LaunchAgents / Windows 启动项）
scripts/omb.js                跨平台本机 OpenMausBot CLI 托管、日志轮转与崩溃自愈
scripts/pair.js               OpenMausBot 桌面端一次性配对脚本（npm run pair）
test/                         单元测试与 Mock Harness / 插件微内核集成测试
im-plugin.example.js          通用 IM 通道插件模板
```
