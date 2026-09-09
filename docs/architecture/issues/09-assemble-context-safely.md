# 确定检索、冲突处理与安全上下文装配策略

Type: grilling
Status: resolved
Blocked by: 05, 06, 07, 08
Resolution scope: 设计裁决已完成；实现、迁移与故障注入验证仍待 11、12、13。

## Question

系统应如何从当前会话、当前项目、个人知识和用户偏好中检索并装配有限上下文？相关性、权威、时效、版本、来源可信度和多样性如何共同排序；冲突事实、过期记忆、跨项目污染和提示注入如何阻止？

## Decisions — Eligibility, ranking and project isolation

1. 不把相关性、权威、时效与可信度压成一个可互相补偿的万能加权分数。Memory Retriever 先以 logical scope、`applies_to`、lifecycle/verification、temporal validity 和 source integrity 做硬准入；未通过权威或验证门禁的对象不能靠高语义相似度进入正常上下文。
2. Eligible set 内以当前用户请求 + active intent 做 sparse lexical/BM25 与 dense semantic 召回，并用 RRF 等简单、可复算方法融合排名；融合分只表示检索相关性，不获得真值或指令权威。随后按规范 claim、subject/resource、适用环境和有效时间归一去重，只保留该语义单元的 current eligible version。
3. 最终选择在 Orchestrator 的动态 token 预算内优先覆盖当前任务的不同问题子项，避免近重复结果占满窗口；不为“多样性”维护万能 MMR 权重，不设固定 top-k，也不注入弱相关内容。没有强相关 eligible memory 时返回空，由主 Agent 决定是否进入 Agentic RAG 慢路径。
4. 多项目会话每轮维护由 active intent/task、实际 resource owner、manifest 与工具路径共同验证的 `active_project_set`；默认只含 `primary_project`，workspace/personal 中适用对象正常参与。`affected_project_ids` 只记录本会话曾触碰的项目，不自动扩大本轮检索。明确跨项目任务才加入所需项目，返回结果保留 project 标签且不跨项目折叠 claim；项目身份仍未确定时只使用 session-local context。

## Decisions — Scope overview as a derived projection

4a. 跨会话整体分析按 logical scope 运行，不把所有项目合成一个全局检索池。`scope_overview` 只作为 Context Orchestrator 可选的有界 baseline/projection：它记录当前 scope 的 verified/active 决策、适用约束、重大变化、未决问题和 evidence-gap，并携带覆盖 input watermark、逐条 input identity、claim→source/memory ref、content hash 与可重建状态；它没有 memory、instruction、policy、权限或批准权威。project→workspace/personal 只允许通过显式 membership/`derived_from`，不按相似 claim 或模型自报 scope 扩大。
4b. project/source/head/关系变化或 membership/权限撤回时，Core 通过类型化 artifact-input 反向依赖使直接及更宽 scope 的 overview stale；Orchestrator 注入前重验当前 head、scope、lifecycle、verification、source version 和覆盖水位。当前请求仍先走 canonical retrieval，只有项目全貌/规划、跨主题关系或局部 evidence-gap 需要时才读取适用 overview；任何依赖闭包、purge、cursor gap 或 verifier 状态无法证明时，只返回状态标记或触发局部 review/source recovery，不把旧 overview 当事实注入。

5. Candidate/rejected/tombstoned 对象不进入正常上下文；superseded 历史仅在明确历史查询中返回。Relevant claim 若 stale/conflicted，不把任何一方正文当事实注入，但在它确实影响当前请求时加入有界 `memory_status` marker，包含规范 claim key、状态、conflict/source reference 与建议的复验动作，避免模型把“被安全过滤”误解为“没有相关知识”。主 Agent 可据此进入慢路径；研究模式才展开带状态标签的双方/旧版本。安全或权限冲突由 Control Plane 直接阻断，不能只靠 marker 提醒模型。
6. Memory/source 的安全边界是语义隔离加模型外能力门禁，而不是字符串过滤或 XML/Markdown 本身。P0 固定 policy 声明这些块只是数据；active policy artifact 只从独立 instruction channel 加载。Memory 用结构化 envelope 携带 type/scope/state/provenance，raw source excerpt 明确标为 untrusted 并附 immutable locator/hash；不得通过关键词删除或改写原文，否则既破坏证据完整性也防不住注入变体。
7. Preference/decision memory 只表示 owner 曾表达的偏好或决定，可以为推理提供数据，但不能授予权限、扩大 scope、改写 tool schema、路径/网络/凭据能力或审批状态；需要强制执行时必须另行发布 policy artifact。所有副作用由 Harness 在模型外重新检查当前 user intent、active policy、capability 与目标资源，记忆文本和 source 内容均无权绕过。
8. 远端模型供应商响应中的正文和元数据全部按不可信 source data 处理；返回的 system/developer/tool 等字段不映射为 Harness 指令，只保留协议白名单字段、执行长度上限与内容 hash/调用链核验。Provider adapter 可以选择最低非指令数据表示，但不能因 API 角色限制把 retrieval 内容提升为 policy 权威。

## Decisions — Budget degradation and recoverable offloading

9. 每次 provider 调用前由唯一 Context Orchestrator 强制检查 `mandatory + selected + output_reserve + safety_margin <= context_limit`；不满足就禁止发送。活动 policy、当前用户输入、最小 active intent、当前需要的核心 tool schema、最近未完成的完整 ReAct/tool-call 配对和输出预算不可卸载，绝不按消息条数裁剪或拆开 assistant/tool 配对。
10. 采用“先确认可恢复，再价值感知卸载”：原始内容先同步写入 owner source/archive 并生成 immutable locator/hash receipt，再做无损去重/去格式噪声与 Headroom 式内容感知压缩；live context 只保留错误、结果、关键变更、路径、决策锚点等 compact projection 与 recovery locator。卸载只改变 live projection，不删除原文，也不递归压缩旧摘要。
11. 超限时按当前任务的边际价值降低 selected context，而不是按 memory/tool/compartment 类型固定删除：先去弱相关、近重复和可重建内容，再缩减非 pinned memory/source，随后在完整 ReAct 边界批量切换已准备的 compartment/cache epoch。仍超限的单条输入或工具结果先归档再分页/分块；mandatory 本身超窗则明确失败或拆任务。
12. 用户要求原话/版本/行号/证据、当前行动依赖被省略参数/错误、memory provenance 指向原文、stale/conflict 需裁决或主 Agent 判断 projection 不足时，走 `source.search → source.expand` 有界恢复；仅语义相关且 projection 已足够时不恢复。未归档成功、当前步骤马上需要精确值、receipt/hash 校验失败的内容不得卸载；Recovery 失败必须暴露证据缺口。

## Decisions — Canonical execution ledger and assembly receipt

13. Q6 采用 explicit hybrid：Pi adapter 复用稳定 `Agent`/`AgentSession`、会话与 tool loop；`euler-active` 的 context conversion 只做 Euler 批准的表示转换，内容选择、compaction 与预算归唯一 Euler Orchestrator。Pi 原生自动/手动/overflow/branch summarization 不得另行压缩或发无 ledger 请求，具体受控启动与 transport 按 13 的 Pi 接线契约；execution ledger 由 Host/Harness 核心自有并单独写入。该复用只约束 Pi 宿主 adapter：本条写定时 Pi 是唯一运行时，14 后来定案 v1 首接的自研 CLI 只借 `@earendil-works/pi-ai` 的 provider/model 接口、自有 Agent loop 与 TUI，因此不受该复用约束；但本票的 Host-owned ledger、预算、receipt 与安全不变量仍同时约束两个宿主，13 按此拆分运行时接线。Pi 当前 `SessionManager` persistence 与 `AgentHarness` 只作设计/运行时参考，不能直接充当 Q6 receipt ledger；DSH 当前 agent loop 同样不能被表述为已提供 per-attempt receipt。模型历史只由 surface events 投影，receipt 是类型上禁止 `surfaceOp` 的 log-only core event；以后 Trajectory/metrics/audit 都是同一 ledger 的只读投影。
14. Q6 由 Host/Harness 核心生成、模型不可修改的 versioned events 组成：`context/assembly@v1` 记录 intent/project/policy/cache epoch、retrieval、selected/rejected refs+hash+顺序+token+reason、P0–P3 预算、reserve/margin/degradation 与 assembled-context hash；每个真实 transport attempt 各写一条 `model/request-attempt-started@v1` 和 `model/request-attempt-finished@v1`，以 `attempt_id/ordinal` 记录最终 route/provider/model、冻结后的 canonical transport payload hash、start/TTFT/end、usage/cache、finish/error/cancel。正文仍由规范 owner 保存，receipt 不重复敏感内容。存储层只借 DSH 的 typed append-only log、连续 seq、durable flush 与冷恢复/repair 语义，不直接复用 DSH 当前 agent loop。
15. Assembly ID 标识完整不可变 assembly payload：intent/project、policy、route/model/context limit、tokenizer/estimator、retrieval/selection/order/content、P0–P3、cache epoch、reserve/margin/degradation 或 assembled model-request bytes 任一变化都创建新 ID；只有这些完全不变、仅 attempt-specific transport metadata 不同的重发才增加 attempt ordinal。持久化使用两个有序、非原子的 barrier：先 append+flush assembly，预算通过后再冻结 final transport payload、append+flush started，随后才调用网络；失败即禁发。`assembly/no-started` 是预算阻断、取消、预计算或两 barrier 间崩溃形成的 `not-dispatched`，`started/no-finished = orphaned/unknown-sent`。最终 transport boundary 记录 canonical encoding/hash algorithm/adapter version 后禁止改写。
16. canonical store 完整时，v1 保证选择/顺序/预算与 content refs 可复算、attempt 状态可恢复、receipt-to-prompt exclusion 有自动测试；10-22 定义的显式 privacy purge 是唯一由 policy 主动授权的破坏性例外，它可删除含 locator/hash 的 manifest payload、保留无内容 envelope/seq/attempt 状态并将 stream 标记为不可完整复算。canonical store 损坏后从已验证快照恢复属于完整性失败而非授权例外，必须按 10-27 显式标记 recovery gap。单 event checksum 不冒充防篡改 ledger，hash chain/checkpoint root/signature 留到出现审计威胁模型后。不实现 Trajectory UI、分布式 trace、全量 prompt diff 或通用 plugin event bus；11 票只决定显示与指标。

## Cross-cutting decision — Extension boundary

17. DSH 核验结论落为稳定核心 + 少量命名 Hook，而非公开的“一切皆插件”：Control Plane、Context Orchestrator、source/archive、memory gate、ledger、capability/credential/tool dispatch 必须封闭在核心；第三方工具 v1 优先 MCP/子进程，memory/source/exporter 只能提交候选或只读投影。内部可借 Cordis 的 owner-scoped lifecycle/disposer，但任意 LLM 代码不得直接热载入 live core。
18. 与 08 的既定边界一致：v1 只自动激活经门禁的 Memory 与可重建 retrieval index；Skill、AGENTS/policy 和代码只保存/导出带 evaluation contract 的 inert proposal，由各 owner/用户发布。动态代码插件及其他 artifact 的无人值守发布待 API/ABI 与 capability manifest、进程隔离、冲突预检、state migration、held-out/canary 和自动回滚齐备后再考虑。Q6 的 Pi/DSH 运行时裁决见 `../research/2026-08-29-pi-vs-dsh-q6.md`；DSH 插件与 Trajectory 事实见 `../research/2026-08-28-dsh-plugin-trajectory-architecture.md`。实现状态仍未完成。

18a. `euler-active` 使用 13 定义的受控 Pi runtime：只加载经内容校验的 Euler adapter，其他扩展不进入该进程；工具、直接命令、input、context 与 transport 全部走 Core。哈希只标识获准实现，不构成同进程沙箱或签名体系；被信任 runtime/adapter 本身被恶意替换属于既有本机攻击边界，正常可加载扩展不能绕过门禁。MC-active 的既有运行与配置不受影响。


