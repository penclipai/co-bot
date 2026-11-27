# `co-bot` 协调者完备性形式化推导与验证

> 本文档从"类 Grok Bot 企业 IM 个人协调者"的使用场景出发，给出形式化系统模型 $\mathcal{S} = (U, C, I, \mathcal{P}, \Phi)$ 与五条完备性公理（$P_1 \sim P_5$），记录基线审查发现的反例、已完成的三阶段闭环实现，以及与 [演进路线图](./ROADMAP.md) 一致的刻意取舍边界。日常运维与指令见 [使用指南](./usage.md)。

---

## 一、形式化系统建模

将企业 IM 中的个人协调者系统建模为五元组：

$$\mathcal{S} = (U, C, I, \mathcal{P}, \Phi)$$

- **参与方集合** $U = \{u_0\} \cup U_{\text{col}} \cup U_{\text{other}}$：分别为账号本人 $u_0$、白名单协作者 $U_{\text{col}}$ 与其他群成员 $U_{\text{other}}$。
- **会话空间** $C = \{c_{\text{self}}\} \cup C_{\text{group}} \cup C_{\text{direct}}$：分别为本人自聊主控台、外部群聊与外部一对一私聊。
- **信息对象** $I = I_{\text{msg}} \cup I_{\text{quote}} \cup I_{\text{fwd}} \cup I_{\text{file}} \cup I_{\text{audio}} \cup I_{\text{ws}}$：覆盖文本消息、引用快照、单条/合并转发、文件与图片、语音及绑定的代码工作区。
- **待处理状态集合** $\mathcal{P}$ 共 10 类在途状态对象：`pendingCards`、`privateDrafts`、`pendingSendBacks`、`pendingFollowUps`、`delegations.pendingOutbound`、`pendingTaskPick`、`queuedByThread`、`quietQueue`、`activeTurns`、`stickyWindow`。
- **完备性判据** $\Phi = \{P_1, P_2, P_3, P_4, P_5\}$：当且仅当五条必要公理在默认配置与正常异常分支下均无未受控反例时，协调者核心闭环成立。

---

## 二、五条完备性公理推导与当前闭环状态

### 公理 $P_1$：待处理状态对象的生命周期算子闭包

对任意需要人机或外部闭环的状态对象 $p \in \mathcal{P}$，其状态机应对 7 个基础算子封闭：

$$\forall p \in \mathcal{P},\quad \text{Ops}(p) \supseteq \{\text{Inspect}, \text{Commit}, \text{Cancel}, \text{Disambiguate}_{n>1}, \text{Expire}, \text{Persist+Reconcile}, \text{SafeFail}\}$$

| 状态对象 $p \in \mathcal{P}$ | 基线审查反例（改造前） | 当前闭环实现与代码落点（改造后） |
| --- | --- | --- |
| `pendingCards` | 无 TTL 成永久僵尸卡；重启未对账；多卡缺编号；`stop` 未清理 | 分配短编号 `#N`；支持 `cardTtlMs`（默认 30m）清理；`start()` 调用 `reconcilePendingCards` 与 OpenMausBot 对账；`stopTarget` 清除对应线程卡片（[inbox.ts](../src/openmausbot/inbox.ts)、[command-helpers.ts](../src/openmausbot/command-helpers.ts)） |
| `privateDrafts` | 重启丢失软拆分第 2 段气泡 ID；润色丢失 `mentions` 与 `followUp` 元数据 | 持久化 `imMsgIds[]` 数组（[state-store.ts](../src/openmausbot/state-store.ts)）；`polishDraft` 保留 `mentions`/`allowMentionNames`/`followUp` 且润色不误开 `stickyActive`（[delivery.ts](../src/openmausbot/delivery.ts)、[mentions.ts](../src/openmausbot/mentions.ts)） |
| `pendingSendBacks` | 未持久化；2 分钟静默过期；发送前先删除导致失败丢文本；多发回缺编号 | TTL 延至 10m；纳入 `#N` 收件箱并持久化；外发失败后保留条目可重试；多发回/与卡片碰撞触发消歧（[chat-manager.ts](../src/openmausbot/chat-manager.ts)、[inbox.ts](../src/openmausbot/inbox.ts)） |
| `pendingFollowUps` | 无取消入口；同群他条回复可能误消耗；回复所带附件未入库 | 支持 `#N 取消`（`cancelFollowUp`）；显式 `replyTo !== askMsgId` 不误消耗；同事回复携带附件即刻登记 `setFileMsg`（[follow-up.ts](../src/openmausbot/follow-up.ts)、[inbox.ts](../src/openmausbot/inbox.ts)） |
| `delegations.pendingOutbound` | 无取消入口；运行期永不过期 | 支持 `#N 取消`（`cancelOutboundDelegation`）；`pruneExpired(24h)` 在巡检与收件箱检查时清理超期委托（[delegation.ts](../src/openmausbot/delegation.ts)、[inbox.ts](../src/openmausbot/inbox.ts)） |
| `pendingTaskPick` | 无 `0`/取消；数字越界无提示；与审批卡碰撞 | 支持 `0`/`取消` 退出、`9` 等越界数字显式范围提示；与 `pendingCards` 并存时阻止裸数字碰撞（[inbound-router.ts](../src/openmausbot/inbound-router.ts)）；切换列表按设计保持会话级瞬态，重启不保留 |
| `queuedByThread` | `status` 无可见数量；404/409/410 过期队列不清除；仅中文 `取消排队` | `@bot status` 展示 `queuedCount`；`cancelLatestQueue` 在 404/409/410 时清理本地失效队列；支持裸 `cancel` 与 `取消排队`（[commands.ts](../src/openmausbot/commands.ts)、[dispatch.ts](../src/openmausbot/dispatch.ts)） |
| `quietQueue` | `flushQuietDigest` 发送前先 `splice` 丢数据；无运行时开关与主动汇总指令 | 先发成功再 `splice`（[delivery.ts](../src/openmausbot/delivery.ts)）；新增 `@bot quiet [on\|off\|flush\|status]` 即时切开关与手动排空（[commands.ts](../src/openmausbot/commands.ts)） |
| `activeTurns` | 无硬超时；异常 800ms 死轮询；自聊 `stop` 误杀外群；重启后 `grant` 403 | 增加 `turnTimeoutMs`（默认 10m，`needs-input` 暂停计时）与指数退避/60 次失败止损（[turn-tracker.ts](../src/openmausbot/turn-tracker.ts)）；`stopTarget` 隔离自聊与外群；`pull-grants.json` 重启恢复（[im-context.ts](../src/plugins/im-context.ts)）；空回复按设计显式报错而非盲目自动重试 |
| `stickyWindow` | 重启丢失 `lastBotReplyAt`；多处边界无法平滑退出 | `lastBotReplyAt` 持久化至 `bridge-state.json`（[state-store.ts](../src/openmausbot/state-store.ts)）；支持 `@bot bye` / `退下` / `结束对话` |

**当前状态**：除按产品边界刻意保留的瞬态项（`pendingTaskPick`）与显式报错项（空轮次不盲目重试）外，**$P_1$ 闭环完成**。

---

### 公理 $P_2$：路由确定性与裸文本无干扰

设第 $k$ 层裸文本入口的合法输入域为 $D_k \subseteq \text{Text}$，其中 $k \in \{1\text{a}, 1\text{b}, 1\text{c}, 1\text{d}, 1\text{e}, 2\}$。确定性要求两条不变式同时成立：

$$\forall i \neq j,\quad \text{Active}(i) \land \text{Active}(j) \implies (D_i \cap D_j = \emptyset) \lor \text{PromptDisambiguation}$$

$$\forall m \in \text{Text},\quad \text{ExpiredTarget}(m) \implies \text{Route}(m) = \text{ExpiryFeedback}$$

**已闭环机制**：
1. **统一收件箱短编号 `#N`**：所有待办在创建时递增分配 `#1`、`#2`（[inbox.ts](../src/openmausbot/inbox.ts)），收件箱清空后归零重置；自聊可用 `#1 确认` / `#1 0` / `#1 答：<内容>` 精确消项。同时严格区分私人笔记，普通文本 `#1 买牛奶` 在非卡片结构化动作下直接透传保留为静默自聊笔记。
2. **跨层碰撞消歧拦截**：当 `pendingSendBacks.size > 1`、`pendingSendBack` 与 `pendingCards` 共存、或 `pendingTaskPick` 与 `pendingCards` 共存时，裸发 `1` / `ok` / `确认发送` 不消费任何状态，而是返回 `replyDisambiguationHint` 列表指引 `#N` 或引用回复（[inbound-router.ts](../src/openmausbot/inbound-router.ts)）。
3. **过期确定反馈**：通过 `expiredSendBackIds`、`lastExpiredSendBackAt` 与 `recentClosedInboxRefs` 对迟到的引用确认、裸确认或 `#N 确认` 输出明确的已处理/已过期提示。
4. **引用草稿词法一致化**：引用 `privateDraft` 回复 `ok`/`1` 直接走确认发回，`no`/`0` 走忽略丢弃，其余自然语言才进入润色流程；并同步对齐 `@default`/`@chief`（[mentions.ts](../src/openmausbot/mentions.ts)）及中文控制别名（[commands.ts](../src/openmausbot/commands.ts)、[extensions.ts](../src/core/extensions.ts)）。

**当前状态**：**$P_2$ 已闭环**。

---

### 公理 $P_3$：默认配置下的上下文可达性

设用户在第 $t$ 轮合理预期协调者可见的信息集合为 $I_{\text{user}}(t)$，模型实际可读集合为 $I_{\text{llm}}(t)$。可达性要求在**默认配置**（`chats.injectRecentContext: false`）下满足：

$$\forall t,\quad I_{\text{user}}(t) \subseteq I_{\text{llm}}(t)$$

| 基线断点 | 当前解决方式与权衡 |
| --- | --- |
| 1. 默认 `injectRecentContext=false` 吞掉自聊转发 `pendingSelf` | 自聊显式逐条/合并转发改为**始终直接内联**注入当轮 Prompt（[chat-context.ts](../src/core/chat-context.ts)），不受外部群 L3 开关限制 |
| 2. 默认关闭近期注入导致未引用截图不可达 | 仅凭严格文件名/截图词正则 `hasArtifactReference` 触发近期附件自动携带；`claimUploads` 将兜底窗口收敛至 2 分钟并显式排除自聊 `#`/`备忘` 笔记所带图片（[context-pull.ts](../src/core/context-pull.ts)、[delivery.ts](../src/openmausbot/delivery.ts)） |
| 3. `CROSS_CHAT_INTENT_RE` 漏判口语或英文跨群提问 | 移除脆弱意图正则；当存在外部活跃会话时，自聊主控 Bot 始终注入 1 行 `external_chats` 与 `chats_url` 索引（多占约 40～80 token 换取确定可达） |
| 4. 远端非回环 OpenMausBot 上下文归零 | 检测到无本机 `hasLoopbackPull()` 时，自动回退为注入最近最多 6 条外部会话上下文（[dispatch.ts](../src/openmausbot/dispatch.ts)） |
| 5. 同事追问回复携带附件丢失 | `handleFollowUpReply` 在放行流转前登记入站附件至 `fileMsgs`（[follow-up.ts](../src/openmausbot/follow-up.ts)） |
| 6. 群内未经触发的被动语音消息转写（**有意取舍**） | **不在被动群消息流强制触发转写**：若 IM 自带 `transcript` 字段直接保留；本地 `transcribeAudio` 仅在附件进入 `@bot` 引用或近期截图/文件拉取时按需触发，避免大群语音消息产生无界算力与费用消耗 |

**当前状态**：前 5 项断点已闭环，第 6 项按成本与性能边界保持按需转写，**$P_3$ 在设计边界内完备**。

---

### 公理 $P_4$：协调者交互象限覆盖

按作用空间（本地个人 vs 跨群跨人）与触发驱动（被动响应 vs 主动感知）构建 2×2 交互矩阵：

| 触发方式与边界 | 个人与本地空间 | 跨群与跨人空间 |
| --- | --- | --- |
| **被动响应** | 完备：多 Bot / 群调度、斜杠透传、`#N` 收件箱、自聊粘性与转发内联、私人笔记隔离 | 完备：外群原地直发、私密草稿发回、`@同事` 追问回流、两级只读协作者、2 态 C2C 委托 |
| **主动感知** | **已补齐**：`checkPendingReminders` 严格遵守 `quietHours`（不半夜打扰）；新增 `@bot quiet on\|off\|flush\|status`；`turnTimeoutMs` 兜底卡死轮次 | **条件覆盖**：新增 `chats.passiveMentionAlert`（默认 `false`），开启后非白名单同事在外群 `@本人` 保持群内静默并私密向自聊投递待办提醒（遵守免打扰）；周期性定时巡检/早晚报仍按 [ROADMAP.md](./ROADMAP.md) 边界交给 OpenMausBot 原生 Routine 能力，不在网关自造调度器 |

**当前状态**：**$P_4$ 在网关职责边界内完备**（定时多群无触发巡检有赖团队试点反馈决定是否由上层配置暴露）。

---

### 公理 $P_5$：硬安全与隔离不变量

在以本人 IM 账号宿主运行的企业内网场景下，信任边界必须由代码与运行时强制执行：

1. **协作者未授权项目、本地路径与受限 Bot 强制隔离**：`inbound-router.ts` 移除混合授权/未授权项目时的短路放行；增加 `findUnauthorizedPathMention`（[projects.ts](../src/core/projects.ts)）阻断协作者传入未授权本地绝对路径；新增 `chats.collaboratorBot` 支持把协作者固定路由到权限/工作区受限的专用只读 Bot（不存在时 fail-closed 拒绝派发）；`ensureChatThread` 建线失败直接抛错中止，绝不回退自聊主线（[thread-manager.ts](../src/openmausbot/thread-manager.ts)）。
2. **C2C `[cobot:res]` 来源硬校验**：`handleDelegationResponse` 强制校验入站必须为 `direct` 私聊，且对已在途委托校验 `ev.chat.id === pending.targetChatId`（[inbound-router.ts](../src/openmausbot/inbound-router.ts)）。
3. **出站防内部运维泄漏与脱敏落盘**：`detectInternalOpsLeak` 覆盖直发 C2C `res` 回复（[delivery.ts](../src/openmausbot/delivery.ts)）以及未修改内容或带有 Bot 署名的 `sendback` 预览（[chat-manager.ts](../src/openmausbot/chat-manager.ts)）；超长回复导出 `.md` 附件时**先脱敏后落盘**并同步上报 `security_redacted` 审计指标，消除先写明文再覆盖的崩溃时间窗。
4. **全链路 `recall` 擦除**：收到撤回事件时立即清除内存上下文、路由、附件、`data/in/pull/<chatId>/<msgId>` 拉取磁盘缓存及由该消息衍生的 `privateDrafts` / `pendingSendBacks` / `pendingFollowUps`，并将 `recalledMsgIds` 持久化至 `bridge-state.json`（[im-context.ts](../src/plugins/im-context.ts)、[inbound-router.ts](../src/openmausbot/inbound-router.ts)、[chat-context.ts](../src/core/chat-context.ts)、[state-store.ts](../src/openmausbot/state-store.ts)）。

**当前状态**：**$P_5$ 已闭环**。

---

## 三、易用性、简洁性与交互间接入数收敛

- **交互步数收敛**：草稿确认从原来的"看草稿 -> `sendback` -> `确认发送`"3 轮交互收敛为直接回复 `#1 确认` 或引用回复 `ok`；多张审批卡无需滚动长按引用，直接回复 `#N 1`/`#N 0`。
- **提示与文档一致性**：补齐 `steer` / `cancel` / `-p` / `/goal` / `quiet` / 8 种笔记前缀与 75% 自动压缩阈值描述；实现全部已占用保留别名（`会话列表`、`取消静音`、`恢复通知`、`取消`、`免打扰`、`取消排队`），不再吞入闲聊。
- **配置分层**：在 [使用指南](./usage.md) 中前置约 16 项高频配置，其余 TTL/防抖/缓冲区参数统一作为高阶可调默认项归口于 [src/config.ts](../src/config.ts) 校验。

---

## 四、自动化回归验证基线

五条公理的对应回归用例已全部固化在 [completeness-ux.test.ts](../test/completeness-ux.test.ts)（共 5 组端到端测试，分别覆盖 $P_1 \sim P_5$），并纳入全量门禁：

- `Completeness 1`：验证 `#N` 递增与清空归零、`#1 买牛奶` 笔记保护、sendback/taskPick 与卡片的碰撞消歧、过期 `#N` 反馈及 `taskPick` `0`/越界边界。
- `Completeness 2`：验证引用草稿统一动词、润色保留 `mentions`/`followUp` 且不污染粘性、发送失败保留预览、`clearPickers` 保护及自聊 `stop` 作用域隔离。
- `Completeness 3`：验证卡片 TTL、启动对账、追问与委托 `#N 取消`、重启持久化（含 `lastBotReplyAt`、`imMsgIds`、`pull-grants.json`）、`@bot quiet` 控制与 `turnTimeoutMs`。
- `Completeness 4`：验证默认配置下自聊 `# 备忘` 配图隔离、外群截图 `hasArtifactReference` 召回、自聊跨群口语/英文索引、追问引用精确匹配与附件登记，以及 `passiveMentionAlert` 静默告警。
- `Completeness 5`：验证协作者未授权路径拦截、`collaboratorBot` fail-closed、C2C `res` 来源校验、内部运维细节出站拦截、`recall` 清理 `pull` 缓存及衍生状态、`@default`/`@chief` 与保留中文别名。

全量验收命令 `npm run verify`（串联 `tsc --noEmit`、`eslint .`、`node --test "test/*.test.ts"` 与 `node scripts/channel-test.ts --dry`）已验证 124/124 测试通过。
