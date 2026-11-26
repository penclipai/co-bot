# `co-bot` 内网 IM 通道接入协议规范

> 本文档定义外部或内网 IM 网关/插件接入 `co-bot` 的标准协议契约。内网适配端只需实现 [im-plugin.example.ts](../im-plugin.example.ts) 约定的接口并投递标准事件（或扁平 `FlatMessage`），即可无缝复用 `co-bot` 的隔离 Thread 路由、统一转发、按需全文/翻页拉取、出站脱敏与 `@同事` 追问确认闭环。

---

## 一、接入方式与加载规范

1. **插件入口**：通过 [channel-contract.ts](../src/core/channel-contract.ts) 导出的 `defineChannelPlugin(spec)` 定义插件（支持 `.ts` / `.js` / `.mjs`，Node >= 24 原生加载 TypeScript）：
   - **根目录单文件模式**：放在仓库根目录 `im-plugin.ts`（已加入 `.gitignore`），在 `config.json` 配置：
     ```json
     {
       "channel": {
         "use": "./im-plugin.ts",
         "options": {
           "selfId": "<本人在 IM 中的真实用户 ID>",
           "selfChatId": "<自聊会话 ID，可留空由首条自聊消息自动学习>",
           "atAllCountsAsMention": false
         }
       }
     }
     ```
   - **目录插件模式**：放到 `pluginsDir`（默认 `./plugins`）子目录下并声明 `kind: 'channel'`；当 `config.channel.use` 为 `'auto'` 时自动发现加载（通道插件变更需重启生效，非通道扩展插件支持 `/api/debug/action` `reload_plugin` 热重载）。
2. **托管运行时行为**：`ManagedChannel` 会自动接管以下能力，插件无需重复实现：
   - 断线指数退避重连（`reconnectDelayMs = 2000ms` 至 `maxReconnectDelayMs = 30000ms`）；
   - `selfChatId` 自动学习（首条 `chat.type === 'self'` 入站消息自动回填）；
   - 标准/扁平入站事件归一化（`normalizeInboundEvent`）与合法性校验（`validateInboundEvent`）；
   - 统一脱敏遥测事件（`channel:inbound` / `channel:outbound`）。

---

## 二、能力声明契约（`ChannelCapabilities`）

插件通过 `capabilities` 声明真实 IM 平台能力；未显式声明字段按默认值补齐，且 `co-bot` 会自动做降级兼容：

| 字段 | 类型 | 默认值 | 说明与网关降级行为 |
| --- | --- | --- | --- |
| `markdown` | `boolean` | `true` | 为 `false` 时出站自动剥离 Markdown 标记改发纯文本 |
| `files` | `boolean` | 按是否实现 `sendFile` 推断 | 声明 `true` 但未实现 `sendFile()` 将被 `validateChannelAdapter` 拒绝加载；`false` 时跳过 `.md` 长文附件 |
| `images` | `boolean` | 同 `files` | 为 `false` 时不回传 Bot 截图与图片 |
| `replyTo` | `boolean` | `true` | 为 `false` 时出站忽略 `opts.replyTo` 引用参数 |
| `actions` | `boolean` | `false` | 真实 IM 建议保持 `false`；`co-bot` 统一使用结构化 Markdown 伪卡片 |
| `history` | `boolean` | 按是否实现 `getHistory`/`getMessage` 自动推断 | 显式设为 `false` 可禁用历史穿透；实现 `getHistory` 后默认自动启用，使 `context_pull` 可拉取更早历史 |
| `notify` | `boolean` | 按是否实现 `notify` 推断 | 若"给自己发自聊消息"手机端无系统通知，实现 `notify()` 并设为 `true` |
| `maxChars` | `number` | `0` | 单条文本硬上限（例如 `2000`）；`0` 表示沿用 `selfChat.resultChars`（默认 `1500`） |
| `multiDevice` | `boolean` | `false` | 是否在 `device` 中区分 `mobile` / `desktop` / `pad` / `web`，配合 `commandDevices` 过滤 |

---

## 三、入站事件契约（`onEvent(raw)`）

`ManagedChannel` 同时接受 **标准 `InboundEvent`**（含 `chat` 与 `sender` 对象）或 **扁平 `FlatMessage`**，由 `normalizeInboundEvent` 统一规整。

### 3.1 消息事件字段对照表

| 能力域 | 标准字段（`InboundEvent`） | 扁平别名（`FlatMessage`） | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| 消息 ID | `id: string` | `msgId: string` | 是 | 会话内唯一消息 ID，用于去重、引用、撤回及 `context_pull` |
| 时间戳 | `ts: number` | `time: number` | 否 | 毫秒时间戳，缺省按接收时刻补齐 |
| 会话标识 | `chat.id: string` | `chatId: string` | 是 | 会话唯一 ID；自聊可设为固定 `selfChatId` |
| 会话类型 | `chat.type` | `chatType` | 否 | `'self' \| 'direct' \| 'group' \| 'system'`；若 `chat.id === selfChatId` 强制归为 `'self'` |
| 会话名称 | `chat.name?: string` | `chatName?: string` | 否 | 群名或私聊对象名，用于自聊来源横幅与按群名检索 |
| 发送者 ID | `sender.id: string` | `fromId: string` | 是 | 平台真实唯一用户 ID（见第六节安全要求） |
| 发送者名 | `sender.name?: string` | `fromName?: string` | 否 | 昵称/显示名，用于群聊上下文署名及自动学习 `@同事` 映射表 |
| 本人标记 | `sender.isSelf: boolean` | `isSelf?: boolean` | 标准必填 | 扁平结构缺省时由 `sender.id === options.selfId` 推导 |
| 正文 | `text: string` | `text: string` | 是 | 文本内容；纯附件、纯链接卡或纯合并转发时可传 `""` |
| 引用回复 | `replyTo?: string` | `quoteMsgId?: string` | 否 | 被引用原消息的 ID |
| 单条/标志转发 | `isForwarded?: boolean` | `isForwarded?: boolean` / `forwardedFrom` | 否 | 逐条转发（如转发 5 条消息到当前群或自聊）设为 `true` |
| 合并转发 | `forwarded?: ForwardedBundle` | `forwarded` / `mergedForward` / `forwardMessages` | 否 | 聊天记录合并转发体，存在时自动推导 `isForwarded = true` |
| 结构化 `@` | `mentions?: InboundMention[]` | `mentions` / `atUserIds` / `atAll` | 否 | 结构化提及，含 `id`、`name`、`isAll`、`isSelf` |
| `@我` 标记 | `mentionsMe?: boolean` | `mentionsMe?: boolean` | 否 | 缺省时由 `mentions` 中 `isSelf` 或 `atAllCountsAsMention` 推导 |
| 链接/分享卡片 | `linkCard?: LinkCard` | `linkCard` / `card` | 否 | 含 `title`、`description`（别名 `summary`/`digest`）、`url`（`href`）、`source`（`appName`） |
| 附件列表 | `attachments?: InboundAttachment[]` | `files?: Array<{ fileId, name, ... }>` | 否 | 附件字段见 3.4 |
| 发送端设备 | `device?: InboundDevice` | `fromDevice?: InboundDevice` | 否 | `id`、`type`（`'mobile' \| 'desktop' \| 'pad' \| 'web' \| 'unknown'`）、`name` |

### 3.2 撤回事件（Recall）

当用户撤回一条历史消息或文件时，投递撤回事件（兼容 `kind: 'recall'` / `type: 'recall'` / `eventType: 'recall'`）：

```json
{
  "kind": "recall",
  "id": "recall_9001",
  "ts": 1732512000000,
  "chat": { "id": "grp_ops", "type": "group", "name": "运维群" },
  "sender": { "id": "u_alice", "name": "Alice", "isSelf": false },
  "recalledMsgId": "msg_8999",
  "text": ""
}
```

- 扁平别名：`recalledMsgId` / `targetMsgId` / `revokedMsgId`。
- 网关收到后立即从内存上下文、`ChatContextStore`、`fileMsgs`、`msgRoute`、磁盘缓存及 `/api/context/history` 分页/搜索结果中永久过滤该消息。

### 3.3 统一转发协议（逐条转发与合并转发）

1. **逐条转发（`isForwarded: true`）**：多条消息逐个转发时，每条均设 `isForwarded: true`；若在自聊 120s 粘性窗口内连发多条转发，网关会暂存上下文而不逐条抢答，直到用户发送 `@bot ...` 时一并消费注入并隔离 `#`/`备忘` 私人笔记。
2. **合并转发（`forwarded: ForwardedBundle`）**：聊天记录打包转发时结构如下（单包最多保留 50 条）：

```ts
interface ForwardedBundle {
  title?: string; // 如 "群聊的聊天记录"
  messages: Array<{
    id?: string;          // 原消息 ID，可用于嵌套附件下载与追踪
    senderName?: string;  // 别名：fromName / sender.name
    senderId?: string;    // 别名：fromId / sender.id
    ts?: number;          // 别名：time（毫秒）
    text?: string;        // 别名：content
    linkCard?: LinkCard;  // 别名：card
    attachments?: InboundAttachment[]; // 别名：files（需带 id 与 name）
  }>;
}
```

- 提示词装配策略：单条消息超截断阈值（近期默认 280 字，逐条转发默认保底 500 字，引用默认 800 字）或合并转发超过 4 条 / 360 字时，Prompt 仅注入**脱敏摘要 + `msgId=<id>` 锚点**；完整原文与嵌套记录由 Bot 按需请求本机 `/api/context/history?grant=...&msgId=<id>` 读取。

### 3.4 附件与语音转写（`InboundAttachment`）

```ts
interface InboundAttachment {
  id: string;           // 扁平映射为 fileId
  msgId?: string;       // 所属消息 ID；合并转发嵌套附件强烈建议保留原 item.id 或父 msgId
  name: string;         // 原始文件名（含扩展名以便识别图片/音频/日志）
  size?: number;        // 字节数
  mime?: string;        // MIME 类型
  kind?: string;        // 例如 'audio' / 'voice' / 'image' / 'file'
  durationSec?: number; // 语音时长（秒）
  transcript?: string;  // 若 IM 自带语音转文字，直接传入可免本地二次转写
}
```

---

## 四、适配器出站与可选接口契约

### 4.1 必须实现

1. **`start(onEvent, { onDisconnect })`**：建立长连接或订阅事件，向 `onEvent(raw)` 推入入站消息；底层连接异常中断时务必调用 `onDisconnect?.(err)` 触发托管重连。
2. **`send(chatId, text, opts)` -> `Promise<string | number | undefined>`**：
   - 必须返回已发送消息的 IM `msgId`（用于引用链 `msgRoute`、`ownIds` 回声过滤与 `@同事` 回复匹配）。
   - **`opts.mentions` 结构化 `@同事` 契约**：当主机确认向群里某个同事发起追问时，`opts.mentions` 会传入目标用户列表：
     ```ts
     Array<{ id: string; name?: string }> // 例如 [{ id: 'u_alice', name: 'Alice' }]
     ```
     - 若 `opts.mentions` 非空，插件应在发送给 IM 平台时构造平台原生的真 `@提醒`（同时 `text` 中已保留 `@Alice` 纯文本）；
     - 若 `opts.mentions` 为空，代表普通回复或防误艾特文本（默认已对未放行 `@` 与 `@所有人` 插入零宽空格 `\u200B`），插件只应按普通纯文本发送。
   - 若 `capabilities.replyTo !== false` 且传入 `opts.replyTo`，尽可能挂接为 IM 原生引用回复。
3. **`stop()` -> `Promise<void>`**：优雅关闭长连接、定时器和文件句柄。

### 4.2 按能力实现（强烈推荐）

| 方法 | 签名 | 行为要求 |
| --- | --- | --- |
| `sendFile` | `(chatId, { path, name, mime }, opts) => Promise<string \| undefined>` | 从本地 `path` 读取经网关脱敏后的临时/原文文件并上传发送；返回平台消息 `id` |
| `download` | `(att: InboundAttachment, savePath: string) => Promise<void>` | 将 `att`（可能来自合并转发内嵌套 `att.msgId`）下载写入 `savePath` |
| `getMessage` | `(chatId: string, msgId: string) => Promise<Partial<InboundEvent> \| null>` | 按 `msgId` 拉取单条消息（用于引用/点击超长历史时缓存未命中回溯） |
| `getHistory` | `(chatId: string, { limit?, beforeMsgId?, beforeTs? }) => Promise<Array<Partial<InboundEvent>>>` | 返回 **严格按时间升序（旧 -> 新）** 的历史消息数组；若指定 `beforeMsgId`，**不得**重复包含该锚点消息本身；须过滤已撤回消息 |
| `notify` | `({ title, body, chatId, urgent }) => Promise<void>` | 在自聊收到审批卡、追问回复结论或协作回传时触发端内强提醒 |
| `status` | `() => { connected: boolean; selfChatId?: string; lastError?: string }` | 供 `/api/status` 与 `/debug` 诊断台展示通道健康状态 |

---

## 五、本机上下文按需探索接口说明（网关内置，插件无需实现）

当插件实现可选的 `getMessage` / `getHistory` 并投递转发或长上下文消息后，`co-bot` 仅在 **Web 监听于 `127.0.0.1` 且 OpenMausBot URL 为本机回环地址** 时向主人/内部回流提示暴露 `GET /api/context/history`：

- `&msgId=<id>&offset=0&limit=4000`：分片读取超长正文或合并转发完整对话（默认分片 4000 字，上限 12000 字）；
- `&before=<最早msgId>&limit=20`：向前翻看未进首屏窗口的更早群历史（合并本地缓存与插件 `getHistory`，自动过滤已撤回消息）；
- `&q=<关键词>`：在当前会话可读历史中按关键词检索。
- 安全硬约束：强制检验回环来源（非 `127.0.0.1`/`::1` 返回 `403`）、进程期会话隔离句柄 `grant`（无效 `403`、缺失 `401`、限流 15 次/分 `429`）、全文/摘要强制走 `scanAndRedactOutbound` 脱敏、自聊 `#`/`备忘` 私人笔记对 API 完全不可见（返回 `404` / 零检索命中）。

---

## 六、内网实现安全基线与验收清单

### 6.1 安全基线

1. **严禁仅凭昵称判断 `isSelf`**：`sender.isSelf` 必须严格基于 IM 平台认证后的真实 `userId === selfId`（自聊专属通道除外），防止群成员改同名伪造主人权限。
2. **严禁跳过 `onEvent` 返回稳定 `id`**：若插件每次重连对同一历史消息生成随机 ID，会导致上下文重复与撤回失效；需使用 IM 平台稳定消息 ID。
3. **回声与文件防环**：`send()` / `sendFile()` 返回的出站消息 ID 会记入 `ownIds`，若 IM 平台通过长连接回推自己发出的消息，务必保留原 ID 以便精准消重。
4. **`collaborators` 仅写明真实用户 ID**：外部只读白名单配在 `config.json` `chats.collaborators[].id` 时须对应平台不可伪造的 `sender.id`。

### 6.2 内网联调与验收流程

1. **静态契约与目录发现检查**：
   ```bash
   npm run channel:test -- --channel ./im-plugin.ts --dry
   ```
   确认零错误并核对打印出的 `capabilities`（特别检查 `history`、`files`、`replyTo` 与真实实现一致）。
2. **真机收发冒烟校验**：
   ```bash
   npm run channel:test -- --channel ./im-plugin.ts --wait 20 --send "co-bot 通道联通自检" --check-file
   ```
   在等待窗内从手机自聊发一条消息，验证 `InboundEvent` 字段映射、文件收发与 `selfChatId` 自动学习均无告警。
3. **6 项端到端场景实测清单**：
   - [ ] **单条长文本/多条逐条转发**：群里转发 1 段 >5KB 日志和 2 条零散消息后 `@bot 总结`，能调取完整末尾内容且密钥片段被脱敏。
   - [ ] **合并转发（含嵌套附件）**：群里发送包含 ≥5 条消息及附件的聊天记录合并转发，能展开末尾结论并自动下载上传嵌套附件。
   - [ ] **自聊粘性窗口转发隔离**：自聊发 `# 备忘` 私人笔记后再连发两条转发消息，期间无抢答；`@bot` 总结不泄露 `# 备忘` 内容。
   - [ ] **更早历史与撤回一致**：询问窗口外更早消息可通过 `getHistory` 翻页查到；撤回消息后立即从后续上下文与翻页接口消失。
   - [ ] **`@同事` 追问闭环**：触发追问提案 -> 自聊回复 `确认发送` -> 群里真实触发目标同事移动端 `@提醒`（且不误触发 `@所有人`）-> 同事回复后仅私密回流总结至自聊。
   - [ ] **自聊 `notify` 与降级**：锁屏时自聊收到确认卡/追问结论能正常弹出手机提醒；纯文本模式下 Markdown 与超长分段正常。
