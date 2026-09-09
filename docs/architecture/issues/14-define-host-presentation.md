# 定义修正闭环的宿主呈现契约

Type: grilling
Status: resolved
Blocked by: 11
Blocks: 13

## Question

11 定下的修正闭环语义要求宿主提供哪些最小能力，各宿主能力不同时如何降级而不丢失“先展示、可放弃、必留痕、批量决策”四条保证？

## Scope and result

本票只冻结宿主契约，不选择自研 TUI 框架、不实现生产代码，也不修改 11 的 canonical 语义。本文件是宿主行为的权威契约；总交付范围见 [15 I01](15-euler-v1-spec.md#v1-scope)。已启用宿主必须遵守同一状态机语义（实现可独立）；宿主能力只能改善呈现和往返次数，不能产生不同的批准、CAS、receipt 或隐私语义。

结论是：宿主必须在模型外呈现 canonical 预览，取得模型无法自行生成的批准信号，持久化 owner 可回看的不可变结果，并把最小变更摘要送回模型。无法满足某项能力时必须返回可观察的 `unavailable`，不得把“宿主无能力”冒充“用户拒绝”。

下表描述各模式启用时的契约，而非当前支持声明或同时交付要求。Privacy purge 按 10 §23a 转入独立维护入口：旧运行进程及子任务退出并取得独占后，才呈现完整 manifest/取得批准；原运行 session 只提供维护指引，不在线清除。Core identity/CAS/receipt 和批准来源不因模式不同而改变。

上游已回填：09 的 Q6 写“运行时使用 Pi 已能运行的 `Agent`/`AgentSession`、context conversion、compaction 与 tool loop”时，Pi 是当时唯一运行时；本票 Self-built CLI/TUI 定案自研 CLI 只借 `@earendil-works/pi-ai`、自有 Agent loop，因此该复用只约束 Pi 宿主 adapter。两者的预算与 receipt 约束继续相同；Pi 复用的 context/compaction 接线以 13 受控 runtime 为准，Euler-active 不保留第二套内容选择或无 ledger 摘要调用。09 的 Host-owned ledger、预算、receipt 与安全不变量仍同时约束两者。11 的“同一时刻只允许一项等待确认”也已补上 per-session 唯一约束 + 跨 session CAS 兜底的说明。

## Decision index

本票逐项定案的十九个分叉与其权威段落：

| # | 分叉 | 定案位置 |
|---|---|---|
| 1 | 批准权威来源 | Approval authority |
| 2 | receipt 与自动更新 Info 落在哪个面 | Two presentation planes |
| 3 | 是否必须提供不经模型的入口 | Minimal host contract · 补充约束 1 |
| 4 | 已结算/已放弃预览的可见度 | Pi interaction shape |
| 5 | 有批准信号但无展示通道的宿主 | Host capability and degradation matrix（`-p` 只读） |
| 6 | identity 如何跨调用携带 | Presentation identity and ordering |
| 7 | 批量多选是否需自写组件 | Pi interaction shape |
| 8 | 自研 CLI 额外能力可否改变语义 | Self-built CLI/TUI |
| 9 | 调查型输入误触发工具 | Intent misclassification |
| 10 | purge 确认语法 | Intent misclassification |
| 11 | pending 生命周期 | Pending lifecycle |
| 12 | owner 如何指认要退的那次操作 | Operation-specific presentation · 自动更新 Info |
| 13 | purge 口令含什么 | Intent misclassification |
| 14 | 批量 purge 口令形式 | Intent misclassification |
| 15 | 退的预览展示什么 | Operation-specific presentation · rollback 两行 |
| 16 | 契约放在哪里 | Scope and result |
| 17 | Host 如何证明“先展示”发生过 | Presentation identity and ordering · 顺序链 |
| 18 | “同一 revision 已展示”复用什么 | Reusing prior presentation |
| 19 | 是否建 capability registry | Minimal host contract；Non-goals |

## Verified Pi 0.84.4 baseline

本节是历史观察基线，必须绑定 observation timestamp、host/install identity 和 source receipt；它不覆盖后续 Pi 版本。Euler P0/P3 以当时实际安装的目标版本重新读取 Git/安装包 bytes 和异常/dispatch 证据，不能把本节的 0.84.4 观察直接当作 0.85.1 或未来版本的 runtime 结论。

票面原先基于 Pi 0.84.3 的四项前提不完整；本票已对当前安装的 Pi 0.84.4 文档、类型与未打包 `dist/**` 源码逐项复核：

- `toolResult` 会作为 session `message` 落入 JSONL，`details` 一并持久；TUI 重载时重建 `ToolExecutionComponent` 并再次调用 `renderResult`。`renderResult` 不是每帧调用，但折展与 `context.invalidate()` 均可使它在工具结束后重调；最终 `result` 数据保持冻结。
- `pi.sendMessage()` + `registerMessageRenderer()` 形成持久 custom message：进入 LLM context，可在 command handler 中发送，并在 TUI 重载时重渲染；`deliverAs: "nextTurn"` 只有实际投递后才落盘。
- `pi.appendEntry()` + `registerEntryRenderer()` 形成 append-only custom entry：持久、在 TUI 重载时重渲染、不进入 LLM context，但无 update/replace API，renderer 也拿不到 `invalidate()`。
- Pi 的落盘是**延迟的**：新 session（`flushed` 尚为 false）且尚无 assistant message 时，`_persist()` 只标记未 flush 就返回，文件在首个 assistant 响应到达时才整体写入；resume 后 `flushed` 已为 true 则直接追写。因此新 session 首个输入即 extension command 时，`appendEntry()`/`sendMessage()` 只在内存中，进程此时崩溃即全部丢失。
- 扩展可以事后用 `ctx.sessionManager.getLeafId()` 取回刚追加的 entry ID（`appendEntry()` 本身返回 `void`，`ExtensionEvent` 也不派送 `entry_appended`），但该推断不受 Host 控制、且宿主落盘可能延迟，因此 Pi entry 不得充当 identity 或 ordering 锚点。注意这只限于**扩展**：RPC 与 JSON 都是 `session.subscribe` 全量转发 + `toJsonEvent`（只改写 `message_update`），因此**外部消费者直接收到 `entry_appended` 事件及其中的 entry ID**；它仍只是宿主侧引用，不因可见而成为权威锚点。
- `on("input")` 事件在**运行时**带 `source: "interactive" | "rpc" | "extension"`，可区分真人输入与扩展注入；该字段不写入 session，所以只能当场判定、不能事后从持久记录重建。
- TUI 下 `ctx.ui.notify()` 只写内存组件树、不落盘，连续 `Info` 会原位覆盖上一条；RPC 下它只发 fire-and-forget `extension_ui_request`，Pi 仍不持久化，客户端可显示或忽略。两者都不能作为 receipt、未读状态或审计留痕。
- `ctx.ui.select()` 只支持单选。真多选需要自写组件 + `ctx.ui.custom()`；`custom()` 仅 TUI 可用，RPC 返回 `undefined`。
- RPC 的 `ctx.hasUI` 为 `true`，支持标准 UI request/response；print/json 的 `hasUI` 为 `false`。无 UI 时 `confirm()` 静默返回 `false`，`select/input/editor/custom` 返回 `undefined`，`notify()` no-op。
- `registerCommand`、`registerShortcut` 与事件 handler 都可取得 `ctx` 并启动阻塞 UI；交互入口不只存在于 tool `execute()` 期间。
- Pi 没有卡片点击；fullscreen mouse 只负责滚动、OSC 8 链接与文本拖选。`ctrl+o` 是全局工具输出折展，不是单卡折叠。
- RPC 的 dialog 在 `AbortSignal` 触发或 `opts.timeout` 到期时直接 `resolve(defaultValue)`，而 `confirm` 的 default 是 `false`；因此一个 `false` 可能来自明确拒绝、abort 或超时三种不同情形。TUI 的 `showExtensionConfirm` 同样把非 `"Yes"` 全部归为 `false`。
- `pi -p` 文本模式只输出最终 assistant text，canonical tool result 不经 Host 直接抵达用户；`--mode json` 则输出完整事件流，消费者可取得未经模型转述的 tool result。
- `pi.sendUserMessage()` 虽以 `source: "extension"` 进入 input event，但 source 不写入 session；扩展注入与真人输入的 user entry 在持久记录中不可区分。这是 Pi 基线的已知 provenance 缺口。

源码锚点：`dist/core/session-manager.js:726-750`（`_persist` 的 no-assistant guard 在 729-730，首个 assistant 到达时 750 置 `flushed`；630/639 是 resume 路径）；`dist/core/extensions/types.d.ts:219,655,664,813,985` 与 `dist/core/session-manager.d.ts:140`（ctx 的 ReadonlySessionManager、`InputSource`、`appendEntry` 返回 void、无 `entry_appended`）；`dist/modes/rpc/rpc-mode.js:47-85`（`createDialogPromise` 在 abort/timeout 回 default；85 行 confirm 的 default 为 `false`）；`dist/modes/interactive/components/tool-execution.js:68,89,214,247-257`（result renderer 的获取、render context、`updateDisplay` 与 renderer 重调）；`dist/core/session-manager.js:822-833,868-879` 与 `dist/core/agent-session.js:382-399,1128-1141,2019-2029`（custom entry/message 持久化与 API）；`dist/modes/interactive/components/custom-entry.js:12-36`（custom entry rebuild）；`dist/core/extensions/runner.js:88-119,318-320`（no-op UI/hasUI）；`dist/modes/rpc/rpc-mode.js:152-155`（RPC custom）；`docs/rpc.md:67,1184-1205`（RPC command/UI）；`dist/modes/print-mode.js:84-124`（JSON/text 输出分叉）；`dist/core/agent-session.js:813-831`（initial prompt 的 extension command dispatch）；`dist/core/agent-session.js:905,1161-1188` 与 `dist/core/session-manager.js:760-785`（user entry/source 丢失）；`docs/extensions.md:2927-2934`、`docs/keybindings.md:89,159` 与 `docs/session-format.md:263-271`。本轮补齐的四条锚点：`dist/modes/interactive/interactive-mode.js:1976-1996,2017-2020`（TUI selector 的 abort 与 owner 取消同样 `resolve(undefined)`，`confirm` 再压成 `false`）；`dist/modes/interactive/interactive-mode.js:2893-2909`（连续 info 级 notify 原位覆写，无 session 写入）；`dist/core/extensions/types.d.ts:70`（`select` 返回 `string | undefined`，单选）；`dist/modes/print-mode.js:53-54` 与 `dist/core/extensions/runner.js:88-119,318-320`（print/json 不传 uiContext，`hasUI` 为 false）；`dist/modes/rpc/rpc-mode.js:265-266`、`dist/modes/print-mode.js:86` 与 `dist/modes/json-event.js`（全量转发 session 事件，只改写 `message_update`）。版本来自安装包 `package.json` 的 `0.84.4`。这些是已证实事实；宿主状态机、JSON 跨 invocation 与自研 CLI 行为是本票设计，仍须 12/13 实跑。

## Minimal host contract

不建立通用插件注册表或大量 capability 开关。13 只需把每个宿主接到四个薄操作；实际调用结果而不是静态自述决定能力：

```text
presentCanonical(payload) → presentation | unavailable
requestApproval(presentation) → approved | rejected | pending | unavailable
persistOwnerEntry(entry) → persisted | error
emitModelSummary(summary) → delivered | error
```

`pending` 是跨调用路径的正常结果：preview 已建立、等待 owner 的下一次输入，本身不是终态，只能由 Pending lifecycle 的三条结算路径终结。阻塞路径不会返回 `pending`。

这四个操作只是 **Host 核心 ↔ 宿主 adapter** 的接缝，不是模型看到的工具表面。`preview`/`commit`/`cancel`/`inspect` 以及下文 Required terminal states 由 Host 核心的模型工具表面返回，CAS 与 pending 结算也归 Host 核心；adapter 只负责呈现与批准信号，不自行实现 CAS。具体 tool schema 归 13。

补充约束：

- 有自有输入通道的宿主必须提供至少一条不经模型的触发路径；它只替换发起者，仍复用同一 Host 流程、identity、CAS 与 receipt。Pi TUI/RPC 可用 extension command，自研 CLI 使用自己的输入层；print/json 也可由本次 initial prompt 调 extension command，但进程是 single-shot、没有持续输入循环，必须显式声明该限制。
- `requestApproval()` 必须区分 `rejected`、`pending` 与 `unavailable`，不得直接透传 Pi UI 的布尔返回值。Pi 的 `confirm()` 把“明确拒绝”、abort 与超时全部压成 `false`，因此批准类 dialog 不得传 `timeout`，也不得与 turn abort 共用同一 `AbortSignal`；adapter 必须在 dialog 返回后检查 `signal.aborted`（TUI 侧 selector 的 abort 与 owner 取消同样都 `resolve(undefined)`，仅凭返回值不可区分），已 abort 一律 `unavailable`，只有在未 abort 且 owner 在 UI 中明确选择否定（含 escape/取消）时才记为 `rejected`。阻塞批准请求不得无终态悬挂：若它被后续 dialog 顶掉、宿主退出或任何原因失去接收 owner 应答的能力，adapter 必须返回 `unavailable` 并结算该请求（canonical 不变），不得等待一个永不到来的回答。
- `persistOwnerEntry()` 保存 owner 侧完整且不可改写的 canonical receipt/终态，不额外复制 privacy purge 要清除的正文或可定位字段；已签 receipt 只保留 10 例外允许的不可反查假名 `subjectRef` 与 revision 标识。它只有在 **Host-owned durable 写入成功后**才可返回 `persisted`：宿主自有 entry 的落盘时机不受 Host 控制（Pi 即为此例），宿主 entry 只是可从 canonical receipt 重放的投影，不是持久性证据。
- `emitModelSummary()` 只发送让模型停用旧值所需的有界结构化摘要：operation ID、受影响记录、变更种类、新 revision/lifecycle 与失败状态；完整审计字段不进入长期模型上下文。

## Approval authority

合法批准信号只有两类：

1. **阻塞宿主输入**：canonical 预览已在同一宿主 prompt 中展示，owner 通过 confirm/custom/click 等 Host 输入动作批准。点击与键盘确认同属一类，不产生第三种批准语义。**该路径只适用于 payload 已由冻结预览完全确定的操作**（forget/restore/purge、以及选定冻结 manifest 的 rollback）：布尔型 confirm 无法携带 11 要求的 owner 实际提交正文，所以需要新正文的 correct 必须走能回传文本的宿主输入（如 `ui.input`/`ui.editor`/自研 CLI 自有控件）或持久 user-turn 路径；仅凭 `confirm()` 的 true 提交 correct 一律 fail closed。
2. **持久 user-turn 边界**：预览先成为 Host 的持久 presentation entry；随后出现一条 user entry，模型根据该输入调用 commit，Host 再核对 presentation/token/ordering/CAS。

两类信号均必须满足相同 identity、CAS、fail-closed 与 receipt 规则。持久 user-turn 路径是 preview 与 commit 两次调用、但 owner 只批准一次；不是在第一次选择后再追加第二次确认。阻塞路径只是把这一次批准放进同一 prompt 以减少往返，不能替代 owner 侧原子比较。模型传入 `confirm: true`、assistant 自述“用户已同意”或缺少 presentation 的 commit 均不构成批准。

Pi session 无法证明 user entry 由真人产生：其他 extension 可经 `sendUserMessage()` 注入同形条目。因此第二类信号只证明“模型没有自行生成该 entry”，不构成恶意同进程 extension 的安全边界。该已核实的 Pi 0.84.4 限制保留为来源事实。Euler-active 按 13 在加载前排除非 Euler extension，并持续使用真实 input provenance；它不把 session JSONL 或 hash allowlist 宣传为 human-attested，也不承诺抵抗已取得可信 runtime 内存/执行权限的恶意代码。

### Intent misclassification

调查性问题（例如“帮我判断是否由记忆污染导致，要不要删除”）不是变更授权：Agent 先走只读 inspect/source，基于真实证据回答并提出建议，只有 owner 随后明确要求变更才可打开 preview。模型若误调 mutation-preview，Host 仍按 10 §28c 对 originating user input、action、唯一目标、scope/权限、lifecycle 与破坏性等级做模型外重验；疑问、歧义或未明确请求变更时返回可观察的 `not_actionable`，不得创建 pending，更不能 mutation。

可恢复的 correct/forget/restore/rollback 由模型解释 preview 后的 user reply；错误解释仍受 CAS、receipt 与后续恢复/rollback 兜底。privacy purge 不依赖自由文本分类，必须额外通过 Host 的确定性回显口令：

- 单目标：`确认清除 <target-id> <nonce4>`
- 批量：`确认清除 <N> 项 <nonce4>`

`nonce4` 是四位十六进制随机串，与 presentation token 一同铸造、一同失效：同一 batch 重新查看时铸新卡即铸新 nonce，旧口令对新卡一律 `invalid_identity`。它只用于阻止历史语句和意外注入复用，不冒充抵抗能读取 preview 的恶意 extension。Host 先执行 11 的冲突/取消 envelope，再在**同一条来自宿主真实输入通道的活输入事件文本**中对自己生成的完整口令做逐字节连续子串匹配（Pi 为 `on("input")` 且 `source !== "extension"`），并将该判定记入 Host-owned 记录；不得回头扫描持久 session entry 取文（`source` 不落盘，注入与真人不可区分），也不做同义词或语义归一化；普通“确认”“可以”“删吧”均不足以授权 purge。批量口令一次覆盖整批，不逐项确认，也不预设无证据的数量上限。

## Presentation identity and ordering

每个可操作 presentation instance 都在 **Host-owned durable store** 中有唯一 presentation 记录，并另有 Host 铸造的 opaque action token；该记录是 identity 与 ordering 的唯一权威。宿主自有的 entry ID 即使可取（Pi 可用 `getLeafId()` 事后推断）也只是展示侧引用，不是安全凭证：它不受 Host 控制、且宿主落盘可能延迟。adapter 不得以它为准，也不得扫描 session 分支推断。模型只原样回传 action token；operation identity、target、originating inspect/notice identity、batch identity、冻结的有序 event-ID manifest/digest、update event ID、expected head 与 lifecycle 全部由 Host 冻结，不能由模型逐字段声明，也不能从“当前 pending”补齐。

同一后台批次重复查看时 `batch_id + manifest` 保持稳定，但每张新卡必须取得新的 presentation 记录与 token；继续操作原卡才沿用原 token。selection、pending 与 CAS 绑定 update event ID，不能退化成只按 memory target 查找。每个目标还冻结 10 §8 的 `head_event_id`；它标识当前 head 的最近变更，和被撤销的 update event ID 不是同一角色，均不得从模型输入或当前 pending 补齐。

跨调用批准必须满足可核验顺序：

```text
Host-owned presentation 记录（完整 canonical payload + token）+ 宿主已输出的呈现
    → 后续 user entry
    → commit(token + 用户实际提交的新正文/selection)
```

Pi tool 路径以 session `toolResult` entry 作为展示面；extension command 路径以持久 custom message 作为展示面；自研 CLI 使用自己的 append-only output entry。但 commit 前的顺序校对只能以 Host-owned 记录为准：宿主自有落盘可能延迟或丢失（Pi 新 session 首轮即如此），不得充当“已展示”证据。Host 必须先完成自己的 durable presentation 写入并完成呈现调用，才能接受后续批准；写入或呈现失败时返回 `unavailable`。

“出现后续 user turn”只能用宿主的**活输入/turn 事件**判定（Pi 为 `on("input")` 与 turn 事件），不得扫描 session entry。Pi 的 `InputEvent.source` 在运行时可区分 `interactive`/`rpc` 与 `extension`：批准必须只接受宿主真实输入通道的事件，`source === "extension"` 的注入不得充当批准。该判定必须当场做并记入 Host-owned 记录；事后从持久 session 无法重建（`source` 不落盘），因此错过活事件时只能 fail closed。阻塞路径则由同一 UI prompt 的返回结果证明。canonical 正文不得静默截断：宿主可分页/折叠，但 approval 前必须已提供同一 token/digest 对应的完整正文；视觉 diff 只有在完整 before/after 可取时才可有界省略。宿主容量不足则返回 `unavailable`，不能让 owner 批准未呈现的内容。契约只声称 Host 已提供不经模型的阅读机会，不声称证明 owner 真的阅读或理解。

### Pending lifecycle

同一 session 同时只允许一个 pending operation，跨 session 并发由 canonical CAS 兜底（第二个提交 stale）。Pending 持久化首先服务重启恢复，后续 JSON 跨 invocation 也复用它；不因 JSON deferred 而删掉。Presentation/pending 已纳入 10 的独立 Host-owned domain，不能写入 context/attempt execution ledger。DDL 由 10/13 的首次实际路径落实，12 验可观察约束，不另建一份 receipt 真值。

不设置 TTL：时效由提交时的 canonical CAS 决定。pending 仅在三种情况下结算：新 preview 明确作废旧 pending、显式 cancel、commit 时成功或 stale/failure 终结。新 preview 必须在自己的 presentation 中指出被作废的旧 operation ID。缺失、未知、歧义或已结算 token 均返回各自可观察的 fail-closed 终态。

提交时原子比较冻结的完整 head snapshot、`head_event_id` 与 update event identity；任一不符则整个操作或批次失败，原样返回 expected/current head，不自动重读、缩小 selection、重解析或重试。revision/lifecycle 值回到预览时状态不会使旧预览复活。

Purge 的数据库逻辑提交结算本次批准 token；其后 `pending_operations` 仅按 10 §23 保留已批准操作的 cleanup continuation，不再是等待批准的 pending，也不占新的批准槽。重复 commit/cancel 返回 `settled` 及真实清理状态，不能撤销已完成删除或重新执行逻辑 mutation。维护只依据该 continuation 续做原范围，缺证/身份或权限变化保持 blocked；清理完成/失败状态与 owner 呈现可重放，敏感 continuation 在完成前清除。

### Reusing prior presentation

“同一 revision 已展示”不能只比较 revision number。新 preview 仅在以下全部匹配时，才可通过 `originating inspect/notice entry identity` 引用旧卡而省略重复 canonical 正文：

- 同一 target；
- lifecycle、scope、source 相同；
- 完整 canonical snapshot digest 和 `head_event_id` 相同且仍等于 current head；
- 旧 presentation 的**宿主侧呈现**仍可被 owner 取回（Host 能核验其存在），而不只是 Host-owned 记录仍在；无法核验时完整重显 canonical 正文。Pi 新 session 首轮未 flush 后重启就属于无法核验。核验只能靠 Host 在创建 presentation 时就记入自己记录的**宿主侧呈现句柄与已落盘确认**（宿主返回的可定位引用，或宿主确认落盘的回执），不得临时扫描 session entry 去找卡片；该句柄缺失或未获得落盘确认即视为无法核验。

引用旧卡不等于复用其 actionable identity：新操作仍铸新的 presentation token，并显示本次特有的 proposed body/diff、selection manifest、lifecycle 迁移或 purge 删除闭包与后果。任一引用或 digest 缺失/失配时完整重显。

## Two presentation planes

跨调用 preview 与结算结果是两条不同 entry：preview 的 tool result/custom message 必须包含 Host 原样展示所需的完整、有界 canonical snapshot/diff；它进入 LLM context 是 Pi 现有 surface 的已知代价。下面的“两面”只描述 operation 结算后如何分发结果，不得把有界模型摘要误作 preview 并省掉 canonical 正文。

每次变更完成后写两个语义面；两面都可以持久，但职责不同：

1. **模型面**：模型触发时使用 tool result；不经模型的 command 触发时使用 `sendMessage(display: true)`。只含有界结构化结果摘要，让当前与后续模型停止使用旧值。
2. **owner 面**：使用不进入 LLM context 的持久 owner entry 保存完整 canonical receipt/终态，供重启后回看和审计。权威副本在 Host-owned store；Pi 的 `appendEntry()` 与自研 CLI 的 append-only entry 都只是可从它重放的展示投影。

owner entry 的 renderer 只读冻结 data。receipt 一经签发不得被恢复、撤销或重渲染改写；后续 owner 变更追加自己的 entry。privacy purge 后，旧预览/明细只渲染统一 redacted 终态；purge 的最终完成标记在 10 的 `purge_receipts` 中只留 content-free、与原内容不可关联的随机 ID；本次 logical-commit/后续结果同样从签发时即无内容、不可反查，按 10 §22 分别保存阶段事实。

purge **之前**已签发的 owner operation receipt 按 10 的显式例外保留假名 `subjectRef` 与 revision 标识：该假名必须不可反查定位目标（不得是 `mem-13` 这类 ID）且不携带正文、locator 或原内容 hash，否则仍适用删整行规则。receipt 是不可改写的审计证据，清除闭包不回填也不重写它，所以对应的 owner entry 投影仍有可重放来源。若某条 receipt 因无法证明假名不可反查而被整行删除，其 owner entry 投影同样只渲染统一 redacted 终态。

`notify()` 只可作为非权威的一次性提示，不能满足任一持久面。自动更新 `Info` 的固定 batch/event 与 outbox 在 activation 同事务落盘（08 §27a），Host canonical 状态保存 manifest、投递状态及 unread/read acknowledgement，不写回旧卡。重启从固定 batch/outbox 对账，不能重新圈选 current active；未有活动宿主时保持 owner 可查询的待投递批次，不假称已呈现。被动 append/notify 不结算 unread。只有显式查询或宿主可核验的 owner open/expand 动作在完整 batch presentation 持久化后才能结算，并追加或返回当前状态。

canonical mutation 与 canonical receipt 必须在同一 DB 事务内提交；该 receipt 的唯一真值按 13 Physical contract 位于 `memory_events`，Host-owned store 是其所属边界，不要求另一张 receipt 表。owner entry 与模型摘要是以 receipt ID 去重、可从 canonical receipt 重放的 presentation。任一 presentation 写入失败不能回滚或改写已签 receipt：Host 返回带已知 outcome 的 `error`，并在后续模型 dispatch 前恢复缺失面。若提交结果未知，先按 operation/receipt ID 查询 canonical store，禁止盲目重试 mutation。

维护 purge 没有继续运行的旧模型会话：不得为补模型面向已退出 session 重新投递被清除的目标/正文。维护 Host 持久呈现 content-free 结果；新 runtime 通过持久 fence/completion 与当前合格 source 重建新 window，仅给必要的无敏感状态。旧 session/source 因 purge 已不可恢复时明确报缺。正常 correct/forget/restore/rollback 仍执行原两面投递和恢复，不因维护例外省略摘要。

## Host capability and degradation matrix

| Host | Canonical presentation outside model | Approval signal | Persistent owner entry | Direct non-model trigger | Write behavior |
|---|---|---|---|---|---|
| 自研 CLI/TUI | 自有 append-only card | blocking input 或后续 user turn | 自有持久 entry | required | full |
| Pi TUI | tool result/custom message + custom entry | `ui.confirm/custom` 或后续 user turn | `appendEntry` | extension command | full |
| Pi RPC | 客户端原样渲染 RPC event（消费者义务）；`hasUI=true` | 标准 UI response 或后续 user turn | session entry + 外部 Host 展示 | extension command/prompt dispatch | full for a conforming consumer；`custom()` 不可用 |
| Pi `--mode json` | JSONL `tool_execution_end`/message event | 后续同 session user invocation | session JSONL；消费者负责渲染 | initial prompt 可调 extension command；无持续输入循环 | allowed only for a conforming consumer |
| Pi `-p` text | **无**；只有 assistant 转述 | 后续 invocation 理论可产生 user entry | session JSONL 但 owner 当场不可见 | initial prompt 可调 extension command；无持续输入循环 | 所有需要 Host presentation 的操作（含 inspect/看）均返回 `unavailable`，禁止 commit；仅允许不产生呈现义务的诊断 |

RPC/JSON 消费者都必须逐字呈现 canonical payload；Pi 进程只能证明事件已输出（包括 dialog 的 title/message 也只是字符串，客户端可不渲染就自动回复），不能证明消费者展示。消费者不满足时该链路不合规。JSON 跨 invocation 提交是已选设计、尚未实跑；在 12/13 证明同 session continuation、pending durability 与事件顺序前只能标为未验证，不得宣称生产可用。`-p` 不得用模型“原样复述”、stderr 或临时文件伪装 Host presentation；用户应切换 TUI、RPC、JSON 合规消费者或自研 CLI。

## Pi interaction shape

v1 不实现 TUI-only 多选组件。批量选择由自然语言表达，Host 将模型解析出的成员逐项列出并冻结为 manifest；owner 批准的是该 manifest，不是原始措辞。解析错误必须在 preview 暴露并通过重述修正。单目标操作可用阻塞 `ui.confirm()` 减少一次往返。

Pi 的持久 presentation 从创建时即使用永真措辞：

```text
记忆预览 · op-77 · 生成于 14:32
mem-13 · scope=personal · source=session/… · lifecycle=active
预览时 canonical 内容（revision r3）
- 旧正文
+ 拟提交正文
```

“回复确认”属于本轮操作提示，不写成卡片的永久状态。结算、取消、作废或 stale 都追加新的 terminal entry，以 operation ID 配对；旧卡不重写，也不继续提供可提交控件。11 要求的“批次失效状态必须在该批次卡上可见并明说需重新选择”由这条以 operation ID 配对的失效 terminal entry 满足；Pi 无 update API，不做原位改写。阻塞 prompt 内按 No 至少返回同样的可观察 `rejected/cancelled` 终态，但按 11 的边界不必因此新增 durable session entry：

```text
receipt · op-77 · 已提交 · r3 → r4
cancel  · op-78 · 已放弃 · 未发生变更
stale   · op-79 · expected r3 / current r4 · 未发生变更
```

门禁由 pending/token/CAS 保证，而不是靠隐藏旧卡。Pi 无单卡折叠，baseline 保持有界正文可见；tool result 可在结算后利用 `context.invalidate()` 收成摘要，但这只是可选视觉优化，重启或静态宿主不依赖它。任何冻结快照只能称“预览时 canonical/head/恢复目标”，不得继续声称 current。

独立 cancel 请求必须产生“未发生变更”的 Host 终态；同一次阻塞 prompt 内按 No 也必须返回可观察的 `rejected/cancelled` 结果，但不是新的 durable 请求，可不新增 session entry。两者都会结算 token，canonical 不变。

## Self-built CLI/TUI

自研 CLI 只借 `@earendil-works/pi-ai` 的模型/provider 接口能力，Agent loop、状态机实现、Host adapter 与 TUI 由本项目拥有；不把 Pi RPC/TUI 限制当作其架构上限。该复用中的 context/compaction 受 13 的 Euler 唯一内容 owner 与受控 transport 约束，09 的 Host-owned ledger、预算、receipt 与安全不变量仍约束两者，13 必须按此拆分运行时接线。它可以提供点击、真多选、单卡折叠、原位重绘与显式 read acknowledgement，但这些能力只能压缩往返或改善呈现。

自研能力不得跳过 canonical preview、增加第三类批准信号、改写 receipt、放宽永真措辞、绕过 CAS，或让已结算 operation 保持可提交。缺少富 UI 时必须退回同一持久 user-turn baseline。

## Operation-specific presentation

- **correct**：目标 tombstoned 时只返回 `not_actionable`/`tombstoned-not-actionable`，提示先独立恢复，不创建可批准 preview。合格目标显示旧正文、用户实际提交的新正文及有界 diff；commit 缺新正文时 fail closed，不得回退到 preview draft；preview 后生命周期变化走 stale。
- **forget / restore**：显示 current canonical snapshot 与明确 lifecycle 迁移，分别说明“停止检索/注入但保留历史”和“重新 active”。
- **privacy purge**：普通 Host 返回维护入口及停止运行的影响，不创建可直接删除的在线批准。按 10 §23a 关闭 admission、验证旧进程及子任务退出、取得维护独占后，维护 Host 才完整显示实际删除闭包、受控范围、外部残留和不可恢复后果，并铸造新的 token/精确 nonce（单目标 `确认清除 <target-id> <nonce4>`；批量 `确认清除 <N> 项 <nonce4>`），取得一次批准。旧运行 session 的 token 不沿用；逻辑提交后不可取消，物理失败报告已提交/未完成及残留，只按同一 manifest 续做。协调者自己的输入/呈现/continuation 同样自清除，全部完成才签 content-free 成功。
- **rollback 自动 revision**：同时显示 current/target revision 和有界 before/after diff，说明恢复旧正文 revision、追加新的 revocation event/receipt，`head_event_id` 随新事件改变，不创建重复正文的 forward revision，也不改写旧事件。按 11，rollback 只适用于自动 memory revision/activation；owner 自己的手动 correction 不走 rollback 路由，要改就再开一次 correct。
- **rollback activation/promotion**：显示将不再注入的完整 snapshot 与 rollback 后 lifecycle；具体 lifecycle 值由 08/10 决定，宿主不得笼统写成“删除”。
- **自动更新 Info**：显示稳定、可复述的 batch/operation/update event ID；冻结完整 manifest/digest，分别呈现不可变 event outcome/before/after snapshot 与查询时 canonical lifecycle。自然语言“撤销刚才那次”可作为便利，但 Host 必须解析到这些 ID 并在 rollback preview 回显。

rollback 属可恢复 owner 变更，不使用 purge 口令；rollback 自己出错时再走新的 preview/commit/receipt，不改写原 receipt。

## Required terminal states

每个请求只能以可观察的 Host 终态结束。`pending`（preview 已建立、等待 owner）是可观察的**非终态**结果，只能由 Pending lifecycle 的三条结算路径终结。终态至少区分：

- `approved/committed`：mutation 已原子提交且 receipt 已持久化；purge 只有全部受控清理完成后才以成功终态返回，数据库逻辑提交 receipt 单独标明 logical-commit，不能冒充 controlled-complete；
- `rejected/cancelled`：owner 明确放弃，canonical 不变；
- `unavailable`：宿主缺 presentation 或 approval 能力，或批准请求未获得真实 UI 响应（abort/无应答）；
- `superseded`：旧 pending 被新 preview 作废，canonical 不变；
- `invalid_identity`：token/entry/batch/update identity 缺失、未知或歧义；
- `settled`：token 已提交、取消、作废或失败，不能重用；
- `stale`：expected/current 完整 head、`head_event_id` 或 update event 不符；
- `no_op`：空变更或规范化后等于 current，不签 receipt；
- `not_actionable`：originating input 只是调查/疑问、语义歧义、未识别、未明确请求变更，或 correct preview 的目标已 tombstoned（reason=`tombstoned-not-actionable`）；不创建 pending/mutation，并说明只读结果、先独立 restore 或要求重述；
- `conflict`：输入同时包含互斥方向，按 11 fail closed；
- `error`：写入、持久化或后续受控清理失败；必须返回 canonical/receipt 的已知或 unknown outcome，不能在 unknown 时声称旧 canonical 仍生效，也不得盲目自动重试。Purge 已逻辑提交而清理未完成时返回 `error`、`canonical=committed`、`cleanup=incomplete` 和有界残留/恢复状态；后续维护结果追加呈现，不把失败请求改写为成功，也不重新打开批准 token。

Agent 叙述不构成上述任一终态。只有 Host canonical result/receipt 可以证明成功或未发生变更。

各操作的合法终态集合（超出集合的返回值视为实现错误）：

| 操作 | 合法终态 |
|---|---|
| inspect（看） | `unavailable`、`not_actionable`、`invalid_identity`、`error`，或正常只读结果（不创建 pending） |
| preview（各 mutation） | `pending`（非终态）、`unavailable`、`not_actionable`、`conflict`、`invalid_identity`、`stale`、`no_op`、`error` |
| commit（correct/forget/restore/purge/rollback） | `approved/committed`、`rejected/cancelled`、`unavailable`、`stale`、`no_op`、`invalid_identity`、`settled`、`error` |
| cancel | `rejected/cancelled`、`invalid_identity`、`settled`、`error` |
| 新 preview 顶掉旧 pending | 旧 operation 得 `superseded`；新 operation 走 preview 自己的终态集合 |

## Handoff to 12 and 13

12 定义最小 DDL、fixture 和验收，13 D8 映射实施依赖；这些设计票的 resolved 不表示运行验证完成。后续实现任务按 [12 的 X-04/X-10/X-11 分组](12-build-evidence-experiment-matrix.md) 逐模式取得实际证据；pending 唯一约束仍在 session 层，不进入 context/attempt execution ledger。

### 首次 CLI 必测（后续宿主复用）

1. 自研交互 CLI 的直接入口、实际 canonical 呈现/批准、cancel/stale/no-op、receipt 与重启回放均完成正常/拒绝对照；依赖仅到 `pi-ai` provider/model，不接 Pi `Agent`/`AgentSession`/TUI。首次只要求文本/持久 user-turn baseline；已有点击/多选/重绘能力时再验开/关语义一致，不为验收另建富 UI。
2. 无真实批准的同轮 commit、缺/换 token、伪造 expected head、缩减 batch、复用 settled token 不能 mutation；调查疑问只读、误调 preview 为 not_actionable 且无 pending，非 owner 输入不能授权。批准 dialog 不传 timeout，abort/失去应答能力为 unavailable 而非 rejected。
3. owner entry 不进入模型 context，摘要符合预先固定的字段/bytes 上限；维护 purge 在退出/独占后展示实际 manifest 和 nonce，含糊/历史口令不授权，当前口令只批准冻结范围。运行 session 不在线清除，清理完成前不报成功，已签合法 content-free receipt 不改写。
4. 首轮真实 source 的 durable ack、Host presentation/pending、commit 后缺 owner entry/summary 和 unknown outcome 按 X-04/X-11 测试。重启先按 identity/receipt 对账，仅补缺失呈现，不重复 mutation；缺展示确认则完整重显，新真实输入后合法操作可继续。
5. activation/batch/outbox 原子性以及 manifest/unread/输出/read ack 各杀点按 X-11 通用组执行；成员不缩小、不重复 activation、不丢已读状态，维护 purge 后旧 Info 不复活。CLI 的 X-10/X-11 联合通过不需要任何后续模式先完成。

### 后续模式启用前追加

各模式只在计划启用自身能力前复验适用通用组与对应追加项；共享 Core 证据可按版本复用，实际 Host/消费者证据不可互代。未启用记 deferred，不阻塞 CLI；已声明启用但缺证不得借 deferred 放行。

1. **Pi regular：** 按 13 的 Pi 接点、12 的后续组验证 tool/extension command、首轮未 flush、source ack、真实输入来源和非模型入口。`InputEvent.source === "extension"`/`sendUserMessage` 不授权；旧展示缺确认时完整重显，合法主流程仍可完成。
2. **RPC / JSON：** 分别在各自启用前验证合规消费者真实呈现及批准，event 已输出不等于已展示。RPC 追加 UI 应答丢失/重启；JSON 追加同 session 跨 invocation pending/commit、旧 token/nonce 和 head 变化。二者互不替代，也不继承 TUI PASS。
3. **Pi `-p` text：** 启用其诊断能力前验证允许诊断能完成，有呈现义务的操作（含 inspect）及写入不可用；不要求或允许完成成功 mutation 用例，不以模型复述或文件旁路补呈现。

每个模式只按其实际能力取得有范围限定的 X-10/X-11 结论；发现共享 invariant 失败时仍阻断全部受影响路径，不能用模式分组掩盖。

## Non-goals

- 不选自研 TUI 组件框架、鼠标库或视觉样式。
- 不实现通用插件式 UI 或 runtime capability registry。
- 不为 `-p` 另造 stderr/file side channel，也不新增独立记忆管理 CLI。
- 不在本票冻结 schema、DDL、app-id、模型 tool schema 或跨平台默认参数。
- 不修改 11 已定 canonical memory 语义；实现发现不可满足时回改上游票面，不在 Host adapter 静默放宽。
