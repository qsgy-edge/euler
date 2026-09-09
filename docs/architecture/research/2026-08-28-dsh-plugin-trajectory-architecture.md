# DSH 插件架构、Trajectory 与目标 Agent 边界

日期：2026-08-28  
主证据：`deepseek-ai/deepseek-harness@cd5ef8148158c3a752a658978873241fdf8e2bbc`（`0.1.2-alpha.1`）  
方法：固定提交源码/测试/官方文档只读核验；未运行 DSH，未复现用户遇到的具体崩溃。

## 结论先行

1. **“一切皆插件”不是错误理念，但不适合作为目标 Agent 的公共扩展原则。** 它适合 DSH 内部用统一生命周期管理第一方组件；若把同样权限开放给第三方或 LLM 临时代码，会天然放大组合爆炸、状态迁移、热更新和故障半径。
2. **DSH 当前问题不能归因于“缺少官方文档”。** 当前版有生成式 API catalog、运行时 inspect、生命周期状态和大量边界说明；更关键的问题是：动态插件仍是 alpha 能力，定义阶段只做参数/语法校验，运行成功也不等于行为/UI 验证通过，且 host 代码与真实运行时同进程、不是安全边界。
3. **也不能归因于理念本身一个因素。** 更准确的因果链是：插件化固有复杂度（必要税）× 当前契约/隔离/验证仍不完整（可修）× LLM 生成代码的不确定性（放大器）。用户遇到的每次崩溃属于哪一类，未拿到日志前仍未证实。
4. **目标 Agent 采用“小而稳定的核心 + 少量命名 Hook + 隔离式工具协议”。** 可以借 DSH 的 fiber 所有权、依赖注入、统一卸载和 append-only event ledger；不借“任意代码可在 live core 中即时注册任意能力”。
5. **自我进化不等于热加载代码。** v1 只让 Memory 自动走 `candidate → 独立验证 → current/previous pointer → rollback`；Skill、AGENTS/policy、代码只生成带 evaluation contract 的 inert proposal，仍由各 owner/用户发布。无人值守 artifact/code 发布推迟。
6. **Q6 借鉴 DSH Session 的 canonical event log 与 Conversation 多目标投影，不照搬 Trajectory UI。** Q6 仍叫 assembly receipt；它是一组 log-only core events。Trajectory 只是以后从同一 ledger 构建的 inspection 投影。

## 证据分级

### 已证实

- Cordis plugin 的公共基础元数据只有 `name`、配置 schema、`inject`、`provide`、`intercept`；没有统一 `apiVersion`、权限/能力、冲突声明或兼容矩阵字段（`vendor/cordis/src/registry.ts:98-111`）。
- Cordis fiber 有 PENDING/LOADING/ACTIVE/FAILED/UNLOADING/DISPOSED 生命周期，资源随 owning fiber 卸载；同一 isolation scope 重复提供 service 会直接报错（`vendor/cordis/src/fiber.ts:147-156,574-589`；`vendor/cordis/src/reflect.ts:31-39`）。
- Dynamic Cordis 的 `cordis_define` 只验证参数与 JavaScript 语法，不运行、不做行为验收（`packages/extensions/tool-cordis/README.md:46-50`）。
- 动态定义虽然 session-scoped，但运行时可影响同一进程的其他 session；sandbox 不是安全边界，应按 bash 权限看待（同文件 `:57-60,181-184`；host runner `README.md:48-54`）。
- host runner 明确记录：UI 可在 `run` 返回后才崩、异步 host body 可逃逸同步超时、headless/browser approval 会悬挂（`packages/extensions/cordis-host-runner/README.md:121-133`）。

- DSH Session 是 merge-extensible、append-only canonical log；模型消息只是 surface projection。`request/header` 与 `request/context` 是 log-only 事件（`packages/core/session/src/types.ts:179-219,287-301,327-415`）。
- agent loop 只在初始/恢复、header 变化或显式 series 边界写入完整 request header；resolved provider/model/context window 以“发生变化才写入”的继承式 request-context snapshot 记录，不是逐请求 receipt（`packages/core/agent-loop/src/agent.ts:502-530`；`packages/core/session/src/types.ts:292-301`）。
- 当前 Trajectory 是浏览器端纯消费者/纯投影，不改变 Chat snapshot，也不参与 provider request（`packages/client/ui-trajectory/README.md:10-12,42-52,75-78`）。
- 固定提交中有 254 个 workspace package manifest、其中约 23 个 `tool*` package；这证明第一方组件高度插件化，**不能证明**“社区第三方插件数量”或其质量。

### 推断

- 用户观察到的重复、冲突和崩溃更可能来自“组合复杂度 + 运行期才暴露的语义错误 + 同进程故障半径”，而不是单纯找不到文档。
- “一切皆插件”把内部 seam 变成公共契约时，会使兼容、顺序、状态迁移和冲突检测成本随组合数增长；热重载只解决部署延迟，不自动解决正确性。
- 对 LLM 自改系统而言，实时生效若先于独立验证，会把探索错误直接变成生产故障；因此 promotion/rollback 比 hot reload 更基础。

### 未证实

- 用户所遇每次“崩溃”究竟是 host process 退出、fiber FAILED、重复 service/tool、UI render error、悬挂审批，还是 pipeline 被短路。
- 当前第三方社区插件的准确数量、重复率、崩溃率和维护状况；本研究没有做生态普查。
- DSH 团队“缺乏维护”。固定提交仍在 alpha 高速演进，不能从历史故障反推无人维护。

## DSH 实际上有三种不同的“插件”

### 1. 第一方 Cordis 组件

DSH 自身大量 package 以 Cordis plugin 形式组合。其优势不是“任何东西都可随意替换”，而是每个组件有 owning fiber、依赖注入、effect/disposer 和统一状态机。对第一方单仓代码，这能减少全局单例和卸载泄漏。

### 2. 安装型/profile 插件

包管理器安装 package，再由 `cordis.yml`/bundle patch 组成 profile。npm semver/peer dependencies 能处理一部分包版本问题，各 registry 也有局部 fail-loud 检查；但基础 plugin contract 没有统一 ABI 版本、capability/permission、conflicts/replaces 等治理字段。兼容性因此分散在包版本、各 service registry、bundle verifier 与文档中，不是一个可预检的全局契约。

### 3. Dynamic Cordis：模型临时写入的插件

这是最接近“Agent 实时改变自身”的机制：模型可 inspect API、define 不可变 package version、run/update/stop，host/browser half 可注册工具、服务或 UI。当前实现已经比盲写插件强：有生成式 catalog、运行时 inspect、session ownership、版本指针和 lifecycle cleanup。

但它仍是**临时运行时扩展器，不是自进化发布管线**：定义不持久；重启即消失；syntax pass 不是行为 pass；run receipt 不覆盖后续 UI render；没有 held-out/canary；没有 current/previous known-good 的自动回滚；host half 与 live runtime 共享进程和真实服务。

## 理论与现实冲突的根因

| 因素 | 性质 | 当前 DSH 证据 | 判断 |
|---|---|---|---|
| 插件组合数量增长 | 理念固有税 | 大量第一方 package、多个 registry/service/hook | 无法靠补文档消除，只能限制公共 seam |
| 热更新中的在途状态 | 理念固有税 | fiber 有 reload/unload；动态 browser/host 有异步与审批状态 | 必须有 quiescence、版本切换和回滚 |
| 统一契约不足 | 可修实现/治理 | Base contract 无通用 ABI、权限、冲突字段 | 是真实缺口，但各 registry 已有局部检查 |
| 同进程故障半径 | 架构选择 | dynamic sandbox 非安全边界，真实 service 可触达其他 session | 是 LLM 动态代码高风险的主要放大器 |
| 定义即运行前验证不足 | 可修实现 | `define` 仅参数/语法；`run` 不证明 UI/任务正确 | 自进化必须外接 evaluation gate |
| 文档不足 | 现状不支持为主因 | 当前有 catalog、inspect、Agent Note 和 Known Limitations | 文档可继续改进，但不是根治办法 |
| 生态维护缺失 | 未证实 | 当前仍为 `0.1.2-alpha.1` 且持续演进 | 更像契约尚未稳定，不宜称无人维护 |
| LLM 生成错误 | 外部放大器 | API inspect 只能减少错误，不能证明组合行为 | 必须隔离、测试、canary、rollback |

历史 issue（如重复配置、hot-reload 丢失、property redefine）只能证明早期版本曾反复暴露组合/重载问题，不能逐行证明固定提交仍有同一 bug。当前具体故障若要诊断，下一步应直接读取 crash log、fiber diagnostics 与 `cordis_inspect_self`，而不是继续做理念争论。

## 目标 Agent 的插件边界

### 决策：稳定微内核 + 少量命名 Hook

目标不是“普通 Agent 的巨型核心”，也不是“一切公开插件化”，而是：

- **内部统一生命周期**：第一方模块可以复用 DSH 式 owner/fiber/effect/dispose 思路。
- **外部只开放窄 seam**：每个 Hook 有单一 owner、固定 schema、明确能力和失败语义。
- **第三方代码默认进程外**：v1 工具扩展优先复用 MCP/子进程；崩溃只损失扩展，不拖垮 Harness。
- **模型只能提议制品**：模型无权把代码直接设为 active；Harness 执行评估、发布、回滚。

### 必须封闭在核心中的能力

1. active intent/task、授权、审批和 capability gate。
2. Context Orchestrator、硬 token 预算、P0–P3 装配与 cache epoch。
3. canonical source/archive、execution ledger 与可复算的 content-reference/assembly receipt。
4. logical project identity、memory lifecycle、verification/promotion/rollback。
5. tool dispatch、credential boundary、provider request transport。
6. extension manager 自身及其 schema/version/health policy。

任何扩展都不得直接改 active policy/intent、写 active memory、重排最终 prompt、绕过工具审批、读取未授权凭据或重新定义核心事件语义。

### v1 允许的扩展面

不先造通用 plugin framework，只保留当前消费者已经需要的具体 seam：

1. **Tool provider**：优先 MCP/子进程，schema 注册与执行均由核心 capability gate 包裹。
2. **Model/provider adapter**：第一方或显式安装，不能把远端返回的 role/metadata 提升为指令。
3. **Memory/source adapter**：只能返回带 provenance 的候选数据，最终准入与装配由核心决定。
4. **Read-only event exporter**：订阅 ledger 生成指标/调试投影，无权回写执行状态。

Skill、AGENTS.md/policy、Memory 不是任意代码 plugin：它们是有 owner、scope、hash、evaluation contract 和 current pointer 的版本化 artifact。

### 后续真的需要动态代码插件时

最低门槛不是再写一份文档，而是同时具备：

- versioned manifest：host API/ABI、依赖、`provides/requires/conflicts/replaces`；
- capability/permission manifest 与用户/Control Plane 授权；
- worker/subprocess/WASM 等故障隔离，超时和资源限额覆盖异步工作；
- deterministic composition 与激活前冲突检查；
- candidate 在隔离环境加载，跑 contract test + held-out/negative case；
- 原子切换 current/previous pointer，health canary 失败自动回滚；
- state migration/quiescence 协议；
- 每个扩展的 version、配置、能力、加载/卸载和 crash receipt。

成熟插件平台也遵循这个方向：VS Code 用独立 Extension Host 避免扩展拖慢/破坏 UI，并以 `engines.vscode` 声明兼容版本；HashiCorp go-plugin 以子进程/RPC 隔离，插件崩溃不应拖垮 host。两者都说明“可扩展”并不等于“任意代码与核心同进程”。

## 自我进化应借鉴什么

### 借鉴

- DSH Dynamic Cordis 的 **immutable package version + current version pointer**。
- Cordis 的 **owner-scoped lifecycle 与统一 disposer**。
- define 与 run 分开：生成制品不等于发布制品。
- inspect/catalog：Agent 应先查询真实可用 API，而不是凭记忆生成。
- tool/schema 变化显式开启新的 prompt-cache epoch。

### 不借鉴

- 把 live process 中任意 JS 注册能力当成默认生产路径。
- syntax validation 后就允许候选影响共享 runtime。
- 用 session-local 临时代码冒充 durable evolution。
- 只看 run/activate 成功，不验证实际任务行为和负例。
- 没有独立 evaluator、canary 与 previous-known-good rollback 的自动发布。

v1 只自动激活经门禁的 Memory 与可重建 retrieval index；Skill、policy/AGENTS 和代码变更只保存/导出 inert proposal，不自动发布。后续具备对应 evaluation、canary 与 rollback 后再允许原子切换，这仍保留自我进化路径，却不把探索错误直接注入生产核心。

## Q6 对 DSH Trajectory 的借鉴边界

### 先纠正概念

DSH 的 Trajectory 不是独立执行真相源，也不负责组装或发送 model/provider request context。真相源属于 Session append-only event log；Conversation assembler 从同一 event window 构建多种 target projection。Trajectory 确实会装配自己的 inspection business Context，但它只是浏览器端只读 ledger/timeline，不拥有存储、顺序或模型请求装配。

因此 Q6 不应“做成 Trajectory”。正确关系是：

```text
canonical execution ledger (Session owner)
├── model surface projection
├── context/assembly receipt                    ← Q6
├── model/request-attempt-started + finished    ← Q6
└── Trajectory / metrics / audit projection     ← 后续只读视图
```

### Q6 定案

把 assembly receipt 封装成三个 Harness 生成、模型不可修改的 log-only core events：

1. `context/assembly@v1`：记录“为什么选择这些上下文，以及发送前是否满足预算”。
2. `model/request-attempt-started@v1`：每次真实 transport attempt 一条，记录最终路由与待发送 payload。
3. `model/request-attempt-finished@v1`：闭合同一 attempt 的成功、失败、取消、usage 与时延。

三者以 `session_id + turn_id + step_id + assembly_id` 关联；每次 attempt 另有 Harness 生成的 `attempt_id + attempt_ordinal`。Assembly ID 标识完整不可变 assembly payload：intent/project、policy、route/model/context limit、tokenizer/estimator、retrieval/selection/order/content、P0–P3、cache epoch、reserve/margin/degradation 或 assembled model-request bytes 任一变化，都创建新 assembly。只有这些完全不变、仅 attempt-specific transport metadata 不同的重发才沿用 ID 并增加 ordinal。

`context/assembly@v1` 最小字段：intent version、`active_project_set`、provider/model/context limit、tokenizer/estimator version、policy hash、cache epoch、P0–P3 顺序/token、retrieval query/index version、selected refs/hash/order/token/reason、关键 rejected/conflict、reserve/margin/degradation/budget result，以及 Context Orchestrator 生成的 assembled-context hash。

`model/request-attempt-started@v1` 最小字段：attempt identity、resolved route/provider/model、start time、final transport payload hash、hash algorithm 与 canonical transport encoding/adapter version。最终 transport boundary 在所有允许的 middleware 完成后冻结 payload、计算 hash；此后禁止改写。

`model/request-attempt-finished@v1` 最小字段：attempt identity、provider request ID（若有）、first-token/end time、input/output/reasoning/cache-read/cache-create token、finish/error/cancel 状态与有界 error locator。provider 未提供的事实保持 unknown，不用估算冒充。

### 写前屏障与崩溃语义

- 采用两个有序、非原子的 durable barrier：assembly 完成后先 append+flush `context/assembly`；只有预算通过且准备 dispatch 时，才冻结 transport payload、append+flush `started`，随后调用网络。任一持久化失败都禁止后续网络调用；retry 的新 `started` 同样先落盘。
- 因而 assembly/no-started 是合法 `not-dispatched`：可能是预算阻断、取消、只预计算，或进程在两个 barrier 之间退出；started/no-finished = `orphaned/unknown-sent`，不得猜测为未发送；finished = terminal。只有 provider 幂等键/查询能进一步消歧时才更新派生状态。
- receipt event 的 canonical encoding version、hash algorithm 与 payload checksum 支持内容引用和字段复算；v1 **不声称**具备防恶意篡改/尾部截断的 ledger 证明。hash chain/checkpoint root/signature 留到出现审计威胁模型后。
- receipt event 在类型层属于 non-surface core event；prompt projector 拒绝其 `surfaceOp`，并以自动测试证明它永不进入 provider payload。

### 与 DSH 的关键差异

- 借 Session typed append-only events、Conversation 的 model/inspection 多目标投影与 log-only 事件；Trajectory 只作 inspection UI 参照。
- 不在每轮重复存完整 system/tools/messages；用 immutable artifact/source refs + hash，避免敏感正文复制和存储膨胀。
- 比 DSH request header 多记录 retrieval 选择、过滤理由、预算、degradation、per-attempt 身份和 write-ahead/crash 状态。
- v1 不做 Trajectory UI；只保证选择/顺序/预算和内容引用可复算、attempt 状态可恢复、ledger 可查询，不承诺自动重放有副作用的 provider 请求。

## v1 与后续拆分

| v1 必须完成 | 延后到有真实需求 |
|---|---|
| 稳定核心边界；不允许任意 live-core JS | 通用第三方 plugin SDK/marketplace |
| 具体命名 adapter；第三方工具优先 MCP/子进程 | worker/WASM 动态代码 host |
| append-only execution ledger + 单调 seq | 分布式 trace/跨 Agent 关联 |
| model surface 与 log-only receipt 硬分离 | 完整 Trajectory 可视化、搜索、时间轴 |
| `context/assembly@v1` + per-attempt started/finished receipt | prompt diff、cache epoch 可视诊断 |
| dispatch 前 durable barrier + orphan/unknown-sent 恢复语义 | ledger hash chain/signature（仅有威胁模型时） |
| owner source/archive refs + content hash | 可选加密 full-request debug capture |
| Headroom 式价值感知卸载 + MC 式有界恢复 | 学习型价值裁剪/reranker |
| Memory lifecycle + Skill/AGENTS/policy/code inert proposal 接口 | 非 Memory artifact 的无人值守发布 |
| tool/policy/schema 变化开启新 cache epoch | plugin state migration/quiescence SDK |
| 最小 JSONL/SQLite 查询与导出 | OTel exporter、远程观测平台 |

## 对 09 Q5/Q6 的最终裁决

- **Q5**：维持已经同意的方案——先 archive/source + hash receipt，再做 Headroom 式内容感知卸载；live context 保留稳定 compact projection + locator，只有证据不足时按 MC 方式有界恢复原文。
- **Q6**：采用 DSH Session canonical event log 与 Conversation surface/inspection projection 分离，落为 assembly + per-attempt started/finished 三类 log-only events；不复制 Trajectory UI，不把观测系统做成插件总线。
- **09 可关闭。** 11 票只决定这些 receipt 如何展示和衡量，不再重新定义其真实性、字段 owner 或 prompt 权限。

## 残余风险与验证

1. 本研究没有用户实际 crash log，所以不能给每次故障下统一根因；若以后诊断具体 DSH 崩溃，应保留 package source/version、`cordis_inspect_self`、fiber state、duplicate service/tool error、browser render diagnostics 和 process exit code。
2. Q6 schema 仍需在 10/11 票转成精确数据表与最小原型；届时以正常、retry、发送前失败、started 后崩溃四条路径验证 receipt 可复算 selection/order/budget 与各 attempt 状态，并以投影测试确认 core receipt 绝不进入 provider payload。
3. 进程外扩展也不是安全沙箱；它只缩小 crash blast radius。权限仍须由 capability gate 和 OS/sandbox policy 限制。

## 主要来源

### DSH 固定提交

- `vendor/cordis/src/registry.ts`
- `vendor/cordis/src/fiber.ts`
- `vendor/cordis/src/reflect.ts`
- `packages/extensions/tool-cordis/README.md`
- `packages/extensions/cordis-host-runner/README.md`
- `packages/core/session/src/types.ts`
- `packages/core/agent-loop/src/agent.ts`
- `packages/client/ui-trajectory/README.md`
- `.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md`

### 外部一手对照

- VS Code Extension Host：https://code.visualstudio.com/api/advanced-topics/extension-host
- VS Code Extension Manifest：https://code.visualstudio.com/api/references/extension-manifest
- HashiCorp go-plugin：https://github.com/hashicorp/go-plugin

