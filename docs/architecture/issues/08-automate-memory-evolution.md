# 设计自动捕获、晋升、替代、遗忘与自进化门禁

Type: grilling
Status: resolved
Blocked by: 01, 03, 05, 06

## Question

候选记忆应如何自动捕获、归类、去重、验证、晋升、冲突替代、衰减和退役？哪些机器证据足以自动放行，哪些情况必须升级给人；记忆演化又如何与未来提示词、skill、代码自进化的隔离候选、独立 verifier、held-out 样例和回滚接口衔接？

## Comments

- `ai-agent-book@1111794f` 的 9-3/9-6/9-7/9-9 强化了“外部反馈 → 候选隔离 → 独立 verifier → canary/回滚”的方向，但只证明机制形态，不授权候选管线自我验收。
- 9-2 是关键反例：知识文档可通过执行门禁却产生负迁移；晋升标准必须验证未来任务效果，而不是只检查产物格式、生成成功或 campaign 自报 accepted。
- 记忆演化与 instruction/skill/tool/code/Harness 演化继续分管线：前者改变可召回知识，后者改变活动行为与权限；二者可共用 provenance、候选状态机和 verifier 接口，但发布门槛、回滚单元与人工升级条件不同。
- receipt 完整性失败或目标宿主未覆盖时一律不自动晋升；Windows 双重 URL 解码缺口表明安全 verifier 必须按真实目标平台执行。

## Decisions — Capture and candidate formation

1. 原始事件继续同步写入 immutable archive；候选提取默认异步发生在完整 ReAct、明确用户决策、compartment 提交和任务完成等语义边界，不按每条消息启动提取。用户明确要求“记住”时立即创建 capture job，但仍不直接晋升；“同意”等确认消息必须与其指向的待确认方案组成同一 source range，不能脱离上文独立提炼。
2. Candidate 形成采用一条可审计流水线：Harness 根据真实事件创建 capture job/envelope，确定结构化 event、source range/hash、active intent 与调用链；结构化工具结果可由确定性代码直接形成候选内容，语义 fact/insight/episode 则由后台 proposer 从有界原始 source 中起草。主 Agent 只能发出 capture hint。模型无权直接写 active memory，也无权自报 provenance、scope、owner、trust 或 verification；Harness 必须从真实事件补齐或覆盖这些字段，Verifier 再决定是否晋升。上述均是逻辑职责，v1 可在同一进程实现，不拆成多个服务。
3. 五种 durable memory 都允许自动产生 candidate，但证据边界不同：`fact` 来自用户陈述或可核验工具结果，`preference` 来自明确偏好或多次稳定表现，`decision` 来自用户明确拍板或人工批准 ADR，`insight` 是从一个或多个 source 推导的可复用结论，`episode` 只在任务完成且有可观察结果后形成。当前 task/goal/note、活动 instruction/policy、原始 archive、秘密、临时措辞与外部内容中的指令不得被包装成普通 memory；外部内容只能保留为不可信 source/evidence。
4. 所有自动提取结果先进入最窄可确定 scope 的 `lifecycle=candidate + verification=unverified`；logical project 未确定时只绑定当前 session 的 unresolved candidate queue，不进入跨会话检索。后续 intent、实际资源 owner 或 manifest 确认 project 后才转入对应 scope 的验证管线；该 queue 是系统内部待定状态，不要求用户维护，也不影响原始 archive 保存。

## Decisions — Independent verification

5. Verifier 前先运行确定性 integrity gate，核对 immutable source locator/hash、Harness 生成的 provenance、scope、owner、receipt schema 与目标宿主覆盖；失败直接 `block/evidence-gap`，不得交给 LLM 猜测。需要语义判断时，Verifier 使用与 Proposer 隔离的上下文并自行拥有 `source.search/source.expand` 权限，不能只看 Proposer 挑选的证据；同模型在低风险候选上允许复用，但不得共享推理或候选选择上下文。
6. Verifier 输出被限制为 `pass | block | evidence-gap`、精确 evidence refs 与内容哈希 receipt，只提供判定、不顺便扩张任务或直接移动 active pointer；真正的 lifecycle/verification transition 由 Harness gate 执行。跨 scope、安全/权限相关、高影响或会广泛重复注入的候选必须增加不同模型、真实工具、目标平台验证或人工裁决，不能由同一生成路径自我验收。
7. 验证深度按类型与影响分级，不要求所有 candidate 跑 held-out：明确 preference/decision 在原话、owner、scope 一致时可自动验证；客观 fact 需要 owner 权威来源或独立工具证据，用户陈述本身不能冒充已验证客观事实；episode 需要任务完成状态与可观察结果；普通 project insight 需要 source 忠实性、冲突和适用边界核对；跨 scope、高 salience、会重复注入的 insight 还须 held-out/canary 验证负迁移。任何试图改变 instruction/policy/tool/code/Harness 的候选都不得借 memory 晋升生效，必须转入独立系统自进化管线。

## Decisions — Automatic promotion, supersession and conflict

8. 只有 Harness gate 能执行状态转换。明确用户 preference/decision、权威 owner/独立工具支持的客观 fact、带完成 receipt 和结果的 episode、来源忠实且边界明确的低影响 project insight，在所需验证全部通过且没有 unresolved conflict 时可自动进入 `active + verified`；`evidence-gap` 保持 candidate 等待补证，明确虚假/越权进入 rejected，可信矛盾进入 conflicted，高影响或不可机器裁决的价值判断升级给人。
9. 新候选与现有记录比较前必须先做 identity + temporal normalization，不能按 memory `created_at` 或“最新文本”直接覆盖：规范比较 subject/resource、host/environment/component、scope/`applies_to`、`observed_at`、`as_of`/validity interval 与 source owner。相同对象在不重叠有效期内的权威观测形成 temporal supersession，旧记录保留为 `verified + superseded`，新记录成为 current；不同对象或不同适用环境的结论允许并存。
10. 冲突处理继承 05/06 的单一 owner 与不可变版本规则：同一 source event 重放为 no-op；同一 claim 获得新证据只追加 provenance；owner 明确更新自己的 preference/decision，或 mutable fact 获得同一规范对象的更晚权威观测时，创建新版本和 `supersedes` 链。未验证反例只打开待验证 conflict，不立即污染 active；只有相同规范对象、有效期重叠且结论互斥的可信证据才把双方标为 conflicted 并停止正常注入。语义相似只聚类给 Verifier，不自动合并；scope 更具体不自动胜出。

## Decisions — Progressive hardening and cross-scope promotion

11. “最窄范围先安全激活，后续再补强和扩大”是晋升总原则：首次激活只满足该类型/影响所需的最小安全证据，追加 provenance、salience、跨 scope 泛化与更强验证在后台继续，不能要求记录达到最终优化状态后才首次可用。Project 版本已验证后可独立 active，广域候选尚未通过不得阻塞窄 scope 版本。
12. 晋升分三条风险通道：快速通道处理明确 owner preference/decision、可由结构化 owner source 直接核验的 fact 与带结构化结果 receipt 的 episode，以确定性 gate 为主并在下一轮前激活或暴露阻塞原因；普通通道处理 project fact/insight/episode，异步经过 Proposer 与一次独立验证；慢速通道只处理跨 scope、高影响、可信冲突、安全相关候选，增加多源证据、真实工具/平台、held-out/canary 或人工。v1 只需实现快速通道与普通 project 通道，完整自动跨 scope canary 不作为首次可用的前置条件。
13. 跨 scope 可自动提出和验证，但不能按出现次数机械放大：用户作为 owner 的明确 personal/workspace preference/decision 可直接创建相应 scope candidate；从 lower scope 推导广域 fact/insight 时，必须覆盖该 scope 的真实变异、保留明确 `applies_to`、检查反例，并使用未参与归纳的 lower-scope 场景做 held-out/canary。通过后创建带 `derived_from` 的新广域版本，不原地改窄 scope；高影响原则、价值判断或无法机器验证的适用边界升级给用户。
14. 系统必须防止 promotion starvation：每个 candidate 都有明确当前阶段、阻塞原因、重试/升级路径和可观察延迟；快速通道不得静默积压，普通/慢速通道不得无限期停留在无原因 pending。该不变量由后续 observability 票定义指标，但不要求用户手工维护队列。

## Decisions — Runtime feedback

15. 运行反馈事实至少区分 `retrieved`、`injected`、`source_revalidated`、`task_passed/task_failed`、`user_helpful/user_wrong/user_stale` 与 `canary_passed/canary_failed`。Harness 记录真实检索、注入、工具/任务 receipt 和用户原话；模型自报“使用了某条 memory”不构成可信 feedback。存储归一化按 10-21：`retrieved` 保留真实 search receipt，`injected` 由 09 的 canonical assembly receipt 推导，不重复写第二份逐条 feedback row；这只去重物理记录，不合并两种语义。默认被动收集，不在每次使用后要求用户确认。
16. Feedback 的真值影响与排序影响严格分开：retrieved/injected 只证明暴露，不证明有帮助；普通任务成功/失败只能弱调 salience 或触发重新验证，不能改变 verification；用户作为 owner 的明确纠正可产生 supersession，source hash 变化自动标 stale。只有配对分叉、held-out 或 canary 才能较强归因到某条 memory。原始 feedback events 是事实记录，salience/retention 分数只是可重建投影，无权反向定义记忆真假。

## Decisions — Rollback, decay and forgetting

17. 自动回滚只接受强信号：owner 明确标记 wrong/stale、权威 source 变化、可归因的 held-out/canary 失败，或安全/权限边界触发；普通单次 task failure 只降权并触发复验。每次 activation 保存 current/previous pointer 与 pre-image receipt，回滚以追加事件原子切回仍通过当前 eligibility gate 的 previous known-good；若旧版本已 stale/conflicted，则宁可没有 active 结论，也不恢复已失效记录。
18. 回滚必须区分真值失败与效用失败：错误/过期/互斥证据改变 verification 为 stale/conflicted；内容仍 verified 但 canary 证明反复产生负迁移时，转为 `lifecycle=rejected + verification=verified` 并记录 `rejected_reason=negative_transfer`。后者表示结论可能为真但不再允许正常注入，避免用 salience 或“真假”字段混写交付风险；原始版本、反馈、receipt 与回滚原因继续保留审计。
19. 不设统一 TTL，也不因长期未使用自动删除：volatile fact 的 `valid_until/review_after` 到期后标 stale 并复验，source hash/owner 变化沿 provenance 传播 stale，新版本替代旧版本为 superseded，多次可归因负迁移为 rejected；低 salience 只影响默认排序，强相关显式检索仍可召回。用户普通“忘记”产生 tombstone 并按 §19a 阻止同源自动复活；隐私清除物理删除正文、embedding、缓存和投影，并由 source/archive owner 处理原始材料。
19a. 同源抑制使用既有 record/tombstone event 和 provenance 中的类型化字段，不新增全局 hash 黑名单。键为 memory owner + logical scope/applies-to + 规范 subject/claim identity + source owner/规范 source lineage；forget 同事务冻结该键、当时 immutable locator/version/raw range hash 与 head_event_id。lineage 标识原始来源的逻辑身份，版本/hash 是其中的证据版本，不以新 capture event ID 替代来源身份。规范化由 Harness 根据真实 provenance 与既有 identity/time gate 完成，模型不能自报/修改；已知别名先归一，无法确定是否同源同 claim 的候选保持 evidence-gap，不为保证召回而新建 active record。

同一来源内容换 capture event、重复导入、路径别名或摘要重述不能绕过抑制；同 lineage 的新版本若仍表达同一被忘记 claim，只追加合格证据/候选并保持抑制，不自动恢复旧 record 或另起同义 active record。不同 owner/scope/claim 或可证实不同有效期的独立新事实按 08 §9 重新验证，不按全局正文 hash 连带封禁；不承诺识别任意跨来源语义抄写。只有独立 owner restore 通过当前资格/CAS 后才能解除该 record 的抑制并继续 correct；验证未过的恢复内容仍不得正常注入。restore 事件保留原 tombstone 历史并移动 head_event_id，旧 preview 永不复活。抑制字段属于正文可关联数据，purge 必须清除，不能把 forget 规则偷作 purge 后的永久内容指纹。
20. 生命周期维护以 source-change、时间索引和 feedback event 驱动，周期扫描仅作漏处理恢复，不每晚让 LLM 重审全库。任何自动重验、退役或回滚仍通过同一 Harness gate 和 append-only transition receipt，不允许维护任务原地改写历史记录。

### Decision addendum — Incremental cross-session scope review

1. Euler 为 logical project，以及明确请求的 workspace/personal scope 维护 `scope-review`。它复用现有 cooperative worker、`projection_jobs`（兼作 projection outbox）、`projection_state` 和 lease；`projection_outbox` 是该 outbox 角色的称谓，不新增同名表、独立 agent、daemon 或跨项目共享池。默认输入范围是当前 project；更宽 scope 只沿已授权 membership/`derived_from` 获取适用材料，不由相似 claim 或调用方自报 scope 扩权。
2. 日常增量消费 Core-owned outbox 的本机单调 `input_seq`；canonical memory/capture/verification、受控 source-change、scope/membership、supersession/conflict/rollback 等有效变化进入该序列。跨宿主事件先经过导入门禁，再分配本机 seq；origin seq/时间不作为全局水位。job 冻结一致性快照的 `start_seq/end_seq`、generation、输入 identity/head/hash 和 digest，只覆盖 `(start_seq,end_seq]`。发布与 cursor 协议归 10 的 Scope-review projection contract：同事务 CAS 提交关系结果、overview metadata 和 cursor；期间新到的外部事件保持待消费，不能跳过或被旧 generation 清掉 dirty。
2a. 外部 source-change 先由 source owner 为每个不可变 source event 分配 `source_event_id`，以 canonical bytes（字段顺序、空值、range/cursor 编码、Unicode/path 规范化和 SHA-256 算法均由 P0 冻结）生成 `handoff_id = H(source_owner, source_event_id)`；`cursor_digest` 是独立的 inventory consistency 字段，不参与幂等 identity。source owner 必须在一个 owner-side durable transaction 内原子提交正文、`source_event_id`、canonical bytes/hash、pending retention fence、逐项 inventory record、scope/membership snapshot、locator 和 replay cursor；只有该提交成功后才能向 Core 发起 handoff。Core handoff ack 前 pending fence 持续保留正文和 cursor，Core 重启通过 inventory/replay API 枚举未确认 source event，而不是只读取可变高水位。`projection_jobs(kind=source-ingress)` 对 `handoff_id` 施加唯一约束，重放只返回既有状态和 `input_seq`，不得重复分配。Core 只有在同一事务提交 handoff 状态、`input_seq` 与 projection outbox 后才返回 Core handoff ack；unknown outcome 先按 source_event_id 查证，无法枚举/重建时写入带 identity 的 `evidence-gap`，阻止相关 scope overview 变 fresh。

`start_seq` 是 exclusive cursor、`end_seq` 是 inclusive high watermark；所有 SQL、receipt、continuation 和 recovery 统一读取 `(start_seq,end_seq]`。期间新到的外部事件只能进入下一 generation/dirty continuation，不能被当前 job 计入完成水位。

3. 输入是增量、同 subject/resource/适用环境/有效期的受影响邻域、当前 overview 的逐条引用及确定性 gate 标出的缺口；不逐轮重读全部 session archive。Harness 负责规范 identity、稳定排序和资格门禁；语义相似、替代或矛盾不能只凭“deterministic”名义自动定案。Proposer 提议、Verifier 独立取源，只有原有验证门禁通过后，Harness 才以稳定 relation key 向现有 append-only `memory_events` 追加合法关系/状态事件；不建通用关系图。相同关系与证据重放是 no-op，不因 job/generation/模型措辞改变再写事件；自身已体现在本次 post-state 的关系通知按 10 精确结算，其他 scope/新证据仍待消费。不能判断则保留 `evidence-gap`，也不能把已有 memory 同义改写直接晋升为新 memory。
4. `scope_overview` 是有界、可重建的 app-data projection，没有 memory、instruction、policy、权限或批准权威。每个可事实化 claim 绑定 canonical record/revision/head event 或 source owner/lineage/version/range/hash；模型生成的新 insight 先做 candidate，不能先在 overview 中当成 verified 事实。已确认决策、约束、变化只能引用当前 eligible 输入；未决问题是有来源的状态，candidate/rejected/tombstoned 正文不进入正常 overview，stale/conflicted 只给有界状态标记。旧 overview 只用于定位受影响引用和替换显示条目，不能作为新事实或递归有损摘要的证据。
5. 允许更宽 scope 使用已授权的 project 派生材料，但 source-ingress 与每条 `projection_artifact_inputs` 必须保存 source owner scope、logical project/resource identity、`applies_to`、目标 scope、membership/`derived_from` snapshot digest 和授权边界；聚合 refs digest 不能替代这些明细。project/source/关系变化或 membership/权限撤回时，Core 在接受该变化的事务中失效所有直接或沿 `derived_from` 间接依赖的 overview；无法完整确认依赖闭包则保守阻断相关 scope。Core 必须在 ingest、overview publish 和 Orchestrator read/dispatch 三处重验当前 membership、owner、scope、source version 与 snapshot digest。Context Orchestrator 读取及 dispatch 前重验 scope、当前 head/qualification/source version、覆盖水位和 hash，不能只信 fresh 标签。未请求的其他 project 内容仍不允许混入。
6. review、各模型角色及全部 `source.search/expand` 共用不可重置的累计预算。P0 必须冻结预算 schema、数值与版本：输入记录/字节/token、邻域深度/扇出、source 调用/读取量、模型 attempts/输出、总成本、wall-clock，以及单次 drain 的 batch/时间/成本上限；没有有效预算不启动。按稳定 input identity 顺序选取，超限记录 selected/omitted refs 或可复读范围摘要、实际用量、continuation 与 `partial/evidence-gap`，禁止发布 fresh overview。跨 batch 保留原 workset 快照和累计进度，不能续做时偷偷重置作业预算；需要更多资源则暂停待新的合格预算。drain 在预算内按 scope 轮转，一个持续 dirty scope 不得吞尽批次，前台关键路径不等待 review。具体数值由 P0/真实 workload 校准，架构硬上限及溢出语义现在生效。
6a. v1 的 store-wide `max_active_drains=1` 与每个 scope `max_active_scope_reviews=1` 必须由 `projection_leases/state` 的单例 drain slot、scope 唯一 active claim 和同一 SQLite 写事务中的 compare-and-register 原子取得；lease 记录 process incarnation、generation 和 lease epoch。过期只允许重新核验并竞争 claim，不能证明旧 worker 已停止；持续 dirty generation 合并为同一 scope 的 durable continuation，不能并行启动。

7. scope review 正常读取 fresh 且所有引用合格的 overview；失败、cursor gap、未完成 workset 或新外部输入使其 stale/partial/evidence-gap，不修改 canonical truth，也不将缺口写成事实。purge 先阻断依赖 overview/正在运行的 job/assembly，依 10 §23a 排空；清除正文、临时 artifact、input/claim refs、locator/hash、cursor/continuation 的敏感关联和跨 scope 派生副本。purge 后只留合法无内容终态，不以“保留旧 projection”恢复已清除内容。
8. raw-only 历史纳入显式首次导入、全局重审或 recovery/backfill，不放进普通 turn path。既有 source owner 经 HostAdapter 在授权 scope/time 的固定 source 快照上枚举有界 batch，复用 capture job：durable source ack→capture/integrity→candidate+unverified→verification→关系/scope review。同一 source identity/range/hash 不重复捕获；每批落 `processed`（已完成枚举/捕获交接，含有据拒绝或无候选）或 `evidence-gap`，候选验证 pending/rejected/verified 另列，processed 不等于 active。每批维护四条独立覆盖水位：`raw_enumerated_through`、`captured_through`、`verified_through`、`relation_reviewed_through`；另记录 `evidence_gap_through`。每条水位绑定 `source_snapshot_id`、source owner、scope/time selector、cursor domain 和 snapshot/inventory digest，只表示该 domain 内最高连续前缀；缺失或乱序成员必须保存为结构化 missing intervals/continuation，不能以最大已见位置越过缺口。`processed` 只表示枚举/捕获交接已完成，不代表 candidate 已验证或关系已结算；只有 source snapshot 枚举终结、capture/integrity 终结、verification/relation 均进入 `verified|rejected|evidence-gap`，且无 pending/unknown/cursor gap，才允许对外显示“全部历史已分析”。否则只能显示已枚举/已捕获至某水位及剩余 pending/evidence-gap。

raw source cursor、批次成员/快照 digest、capture IDs、未决项和 continuation 与批次交接同事务持久，崩溃只补缺项。无法枚举、未解析 scope、来源损坏或被清除均报告缺口，不扩大读取范围；source owner 的枚举只证明声明快照，快照后的来源留给下一批。overview 标明 canonical 与 raw-backfill 的覆盖边界；显式全局请求的 raw-only 批次未完成时不得宣称历史已完整分析。

## Decisions — Interface to system self-evolution

21. Memory 永远不能直接改写活动 instruction/policy/skill/tool/code/Harness。已验证 memories、episodes 与 feedback 只有在能指向明确 target artifact、预期行为变化、适用 scope 与可观察 evaluation 时，才可自动生成无行为权限的 inert evolution proposal；否则继续作为 insight。目标 owner 创建新的 policy artifact 或隔离补丁并记录 `derived_from`，不得把原 memory 改类型或靠高 salience 偷渡为规则。
22. 两条演化管线只共用薄契约与基础设施：Harness provenance/scope/owner、immutable evidence/candidate hashes、integrity receipt、isolated candidate、independent verifier、held-out/canary、current/previous pointer 与 rollback event。Memory gate 只决定可召回知识，Policy/Skill/Code owner 分别决定行为制品发布并使用自己的测试、安全与目标平台门禁；系统变更结果作为 source/feedback 回流后仍重新走 memory candidate 管线，不建立万能自进化引擎。
23. 未来只有候选隔离、目标平台验证、未参与迭代的 held-out、canary 和自动回滚齐备时才允许无人值守发布；权限、安全、凭据、公共接口和不可机器判断的价值变化继续升级给用户。v1 只实现 memory 生命周期与 inert proposal 的保存/导出接口，不自动修改 prompt、skill 或代码。

## Decisions — Minimum-sufficient evaluation contract

24. 每个 evolution proposal 必须携带 evaluation contract，并按风险选择最低充分层级，而不是默认完整重跑旧任务：L0 用确定性代码检查 source/hash/scope/conflict/schema；L1 检查触发、注入和首个关键选择；L2 从最接近目标行为的旧任务 checkpoint 做 baseline/treatment 局部分叉；L3 才使用未参与生成的相似 held-out、越界负例和线上 canary。旧任务只能证明回归，不单独证明泛化。
25. 验证强度按 target 区分：明确 owner memory 与客观 fact 通常止于 L0/L1，普通 project insight 核验来源和边界，只有广域/高 salience/反复影响行动的 insight 进入 L2/L3；Skill 发布至少覆盖应触发、不应触发、关键步骤/工具调用、一个旧失败样例和一个 held-out；AGENTS/policy 还必须做 baseline/candidate、适用正例、不适用负例、边界/安全样例以及优先级、scope 与 token 成本检查。
26. 评估默认复用不可变原始轨迹作为 baseline，从最近 decision checkpoint 开始，回放已记录工具结果并在首次可判定输出后提前停止；只有高影响候选才重跑 baseline 或完整 canary。下一次自然适用任务提供线上证据，但不能替代发布前离线门禁；长期未遇到时状态只能表述为“离线通过、尚无线上证据”。
27. 自动更新的可发现性与审核负担分离：candidate、验证通过但未晋升和 rejected 不向用户打断；低风险 active 晋升/修订在当前响应结束或后台批次完成时合并为一条 Host `Info` 并留在会话记录中；冲突、证据不足、跨 scope、高影响或不可机器裁决的候选显示 `Warning` 且不启用；写入失败、receipt 缺失或状态未知显示 `Error`；仅在确认事务未提交时才说旧版本继续生效，已提交或 unknown 按 canonical receipt 对账并恢复，不能盲目自动重试。数量只用于合并展示，不用于隐藏已启用变更；`Info` 可展开变更详情并进入带确认的 rollback。

27a. 自动 active 更新必须与可发现性在单库事务中绑定：一次有界 activation 事务由 Core 固定 batch_id、完整有序 update event IDs/ordinal 与 digest，并在同一事务写入 `projection_jobs(kind=host-info)`。同批次不跨通知 owner/scope、不重复 target；失败整批未激活，不能先激活后靠内存凑 batch。响应结束/后台 drain 可汇总多个待投递批次的一条通知，但每个 batch 的成员与决策身份独立且不可追加，不能把后来的 update 塞进已展示批次。

host-info consumer 复用 11/14 的 Host presentation state：按 batch_id 幂等持久化完整 manifest/初始 unread，再以真实 Host ack 补 owner 呈现；没有 active session 时仍在该 owner 可查询的持久批次中待投递，不借另一个 session 假称已展示。job 只在目标持久状态与必要投递确认齐备后结算，呈现失败不重做 activation。重启从未结算 outbox 及 memory event 的固定 batch identity 对账，补缺失状态/投递，不凭当前 active 列表重组旧批次；已 superseded/tombstoned/rollback 的成员保留真实历史终态。显式阅读 ack 保存在现有 Host 状态，重放不把已读变未读，notify/append 不等于已读。purge 按闭包清除成员引用、outbox 和相关 state，留下被授权的 redacted 状态，迟到投递受 fence 拒绝；不能从残缺 manifest 重建已删内容。P1 验 outbox 原子性，P2/P3 验完整批次与 X-11 的各崩溃点。
