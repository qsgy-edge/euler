# 选择 v1 持久化、索引与知识投影边界

Type: grilling
Status: resolved
Blocked by: 05, 06, 09
Resolution scope: 2026-09-09 收敛首次切片：canonical/owner/search 不变量保留；overview 后续启用且正文改存 SQLite，行为评估运行系统后置，purge 首版仅维护模式。当前修订未获 runtime/独立复验证据。

## Scope revision (2026-09-09)

- `scope_overview` 保留 Context Orchestrator 这一消费者，但不阻塞首次 memory/context 闭环。启用该切片时，有界正文、refs、generation 与 cursor 直接在 SQLite 同事务提交；不采用数据库外内容寻址文件，不建 publish operation/pin/GC/repair 表族。
- 首次切片不预建未启用能力的空表。Disposable 阶段可重建 DDL；首次真实数据前正式冻结 `001`，此后新增能力用前进迁移。
- Wiki、insight、diagram 文件与行为评估执行/发布均后置；有真实消费者后再确定载体、恢复和验收，不因保留 proposal 或 overview 接口就提前实现。

## Question

根据已确定的对象和访问模式，v1 应在 Markdown、SQLite、FTS5、embedding、图关系和生成式投影之间如何取舍？哪些内容必须随仓库可克隆、可审查，哪些只存个人数据库，架构图、Wiki、ADR 与 insight 页面应是权威文件还是可再生视图？

## Decisions — Physical ownership and database boundary

1. 统一逻辑控制面不等于单一物理存储。代码、人工批准的 ADR/AGENTS/policy/manifest 与其他项目权威文件继续由所属仓库管理；Pi session、外部 source 与 immutable archive 继续由各自 owner 管理；个人数据库保存 durable memory、conflict/provenance、验证与反馈、Host-owned execution ledger，以及 v1 同库的可重建搜索投影元数据。未来生成式文件的 metadata 只有在具体消费者契约和前进迁移完成后才进入数据库。生成式 Wiki、insight 页面和架构图是可重建文件投影，不是第二份知识真值。
2. 每台宿主、每个 OS 用户、每个最终 `app-id` 使用一份 `store.sqlite3`，以 logical `project_id`、可选 `workspace_id` 和 personal scope 逻辑隔离；cwd、Git root 和路径只作为 resource/provenance alias，不能充当项目身份。不同 Windows、macOS、Linux 宿主不得共享或云盘同步 SQLite 文件。
3. 数据根使用宿主标准本地目录：Windows `%LOCALAPPDATA%/<app-id>`、macOS `~/Library/Application Support/<app-id>`、Linux `${XDG_DATA_HOME:-~/.local/share}/<app-id>`；`app-id=euler` 已由 13 确定。Store 与 backup 位于此根；instruction/source 的实际子目录按各 owner 契约绑定，不为未启用的文件投影创建 `projections/`。不绑定 MC 或 `.pi`。
4. v1 以 Node 24 内置 `node:sqlite` 为数据库引擎，不新增数据库依赖或常驻 daemon。每个连接统一启用 WAL、`synchronous=FULL`、foreign keys 与有界 busy timeout；普通事务保持短小，seq/head 变更以原子事务提交，projection 与维护任务使用短租约。
5. v1 不引入 SQLCipher 或应用层正文加密，依靠用户目录 ACL、秘密禁止进入 memory、隐私清除和备份保护；凭据不进入该数据根。该威胁模型不承诺对能读取当前用户磁盘或做介质取证的攻击者提供机密性。
6. 在首次写入或导入任何真实、不可重建数据前，原型数据库是 disposable：只保留 schema version，可以删库重建，不写兼容迁移。首次正式 memory/ledger 写入或 MC 数据迁入前冻结 `schema v1`；从此才启用编号、事务化、只前进迁移，迁移前建立恢复点，失败保留旧库，未知新版本拒绝打开。未来更换引擎走规范 event bundle 导出/导入，不永久背负原型 schema。

## Decisions — Canonical relational model

7. canonical schema 使用关系型公共核心与少量专用表，不建万能 JSON 对象表，也不为五种 memory type 复制五套 schema。最小表族为：

   - identity/control：`schema_meta`、`projects`、`project_resources`、`workspaces`、`workspace_projects`；最小 active intent 的 `intent_events`/`intent_heads`（07 §4）；
   - memory core：`memory_records`、`memory_revisions`、`memory_heads`、`memory_events` 及可清除的 content-bearing event payload；
   - ownership/evidence：`provenance_refs`、`conflict_sets`/members、`capture_jobs`、`verification_runs`/evidence、`feedback_events`、版本化且无行为权限的 `evolution_proposals`；不建行为 evaluation plan/attempt/result 表族；
   - execution：`execution_streams`、typed `execution_events`、结构化 reverse refs 及可清除的 assembly/event manifest payload；
   - projection（首次切片）：`projection_jobs`/outbox、`projection_state`、`projection_leases`、`search_documents`、external-content `search_fts`。Scope review 启用时再加入保存有界正文的 `projection_artifacts`、typed `projection_artifact_inputs` 和所需 cursor；raw-backfill 覆盖水位/缺口结构等到实际启用 backfill 前定案，不进入首次 P1。没有外部 overview 文件，也不建其 publish/pin/GC/repair 表；

   - host operation state（按 14 回填）：Host-owned presentation 记录与 durable pending operation；它们是宿主呈现/批准闭环的 identity 与 ordering 权威，与 execution ledger 同库但用途互斥，不得写入 `execution_events`；唯一约束建在 session 层，具体 DDL 归 12；
   - maintenance：content-free `purge_receipts`，以及 §23a 的 `owner_fences`/`owner_activities`。后两表用于启动 admission、宿主进程登记和维护独占，不要求首版登记每次内容读取/UI 缓存，不是通用任务/插件注册表；列须类型化并受 FK/CAS 约束。

   高频过滤、唯一性、外键和时间有效性必须是类型化列与约束；JSON 只保存经过版本化校验、不会参与核心门禁的 metadata。行为 proposal 保存 target/type、expected change、owner/scope、evidence refs、risk、建议 evaluation contract、完整 payload digest 与 supersedes 引用；存储层分配身份，修订追加新 proposal，引用进入 purge 闭包。建议中的 L0–L3/assertions/baseline/held-out/cost 是数据，不是 sealed 执行计划；v1 没有行为评估执行入口，外部 result/accepted 字段也不能获得发布权。将来出现评估或发布消费者，再定 seal/start/result、独立 verifier 及迁移；不把未来行为执行机制放入 X-01/X-07。Memory 的 verification_runs 和独立取源门禁保持不变。

具体列名与 DDL 可在实现时收窄，但不能改变这些 owner 和不变量。
8. `memory_record` 表示稳定逻辑身份；`memory_revision` 保存不可变正文与 hash；append-only `memory_event` 保存创建、验证、激活、替代、冲突、回滚、遗忘及 receipt；`memory_head` 是同一事务维护且可由事件重建的 current read model。纠正或替代新增 revision/event；rollback 恢复 before 的正文 revision 与语义字段，只追加 revocation event/receipt，不复制同样正文为 forward revision。每次 head 或其 scope/source/verification/lifecycle/validity 变化，在同一事务将 `head_event_id` 指向本次新 memory event；它复用已有事件身份，不另建 generation 计数器。恢复旧 revision 时不得恢复旧 `head_event_id`；无 active head 时也保留最后 head 变更事件身份。所有 mutation preview 冻结该身份及完整 snapshot，commit 原子比较两者；`r3→r4→r3`、forget→restore 后的旧预览仍为 stale。纯曝光统计和 no-op 不改变该身份。
9. 外部稳定 ID 使用标准库 `crypto.randomUUID()`，数据库内部可使用 integer rowid；每个 append-only stream 使用本地连续 `seq` 与唯一约束。跨宿主保留 `origin_host_id + origin_seq + event_id`，时间戳只用于观察时间、有效期和展示，不能定义跨宿主全局顺序或“最新获胜”。
10. 不建立通用图边表。scope/applies-to 用类型化字段和外键，supersession 用 head/event，conflict 与 provenance/derived-from 用各自专表。未来只有真实多跳需求和 held-out 实验胜出时才增加可重建图投影，图不得反向成为权威真值。
11. execution ledger 与 memory 共用同一 SQLite，但使用独立 Host-owned append-only stream/table；`execution_streams` 显式绑定不可变 `owner_kind=session|job|maintenance|migration`、owner ID、origin host、已验证 scope 与授权/任务来源。前台归 session，Proposer/Historian/Verifier 归实际 durable job，纯维护或迁移中不属于子 job 的请求归对应 maintenance/migration run；一次 attempt 恰属一条 stream，不因执行进程或活动 session 改变 owner，也不在父 run 重复记 receipt。run identity 在首次 dispatch 前由 Core 固定于 stream，不需要新 run/receipt 表；有来源 session 时仅记录可清除关联，不能用它替代实际 owner。

   ledger 只保存 assembly、context lifecycle 与 per-attempt started/finished 等 log-only receipt，不重复 prompt/response 正文。content-free envelope/seq/status 与含 source/memory/job 关联的 payload 分开存储，以结构化 reverse refs 支持 purge。每个请求仍经唯一 Orchestrator 与两道 barrier；后台以已批准 job goal/scope 作为最小 intent 输入，不伪造 user session。无合法 owner/目标快照就不 dispatch；不调用模型的 projection repair 不制造 model attempt。

   重启只接管 job lease/执行权，复用 stream 和 attempt identity，旧 writer 的过期 generation 不能提交；`started/no-finished` 一律 unknown-sent，先查询真实结果，不因 lease 到期、新 session 或新 owner_kind 重发。普通 job 结算后可回收可重建 payload，但仍被 ledger/合法操作引用时保留该 job 的最小 owner/scope 身份行及 stream 不可变 receipt，不因容量清理丢失归属。隐私清除先停止该来源的派生/请求、隔离 in-flight 并禁止晚到结果重新写入；清除来源 session 不自动删除其他 owner 的整条 stream，但必须清除其中所有相关正文引用/hash/授权和反向关联，标不可完整复算，不能继续执行依赖已删来源的 job。明确清除 owning session 或其他 owning run 时才删除该完整 stream；必要的 unknown 状态在清除前由 maintenance 的不可关联记录结算为 blocked，不能以 receipt 消失推断可重发。除显式 purge 外，未完成/unknown attempt 不自动删除。

## Decisions — Unified search projection

12. v1 使用一份非权威、可重建的 `search_documents` 统一搜索投影及一份 external-content FTS5 `search_fts`，而不是多个孤立索引或万能 canonical 表。每个 search document 至少携带 `owner_kind`、用于整体验证/清除的 `owner_id`、独立可检索单元 `unit_id`、current `revision_id`、logical project/scope、lifecycle/verification 提示、`exposure_mode`、content、content hash、source seq、tokenizer version 与 projection generation；`(owner_kind, unit_id)` 唯一。Memory 通常一条 record 对应一个 unit，session/source/repo owner 可发布多个有界 chunk unit。
13. 所有 eligible memory 以及 owner adapter 明确发布的有界 session/source/repo chunk unit 可进入同一物理索引，但不得为此默认复制完整 session、source 或仓库；查询按 owner kind/任务子项分 lane 取候选，再由 Orchestrator 做 RRF，避免大量 session 文本淹没 durable memory。投影中的 scope/state 只作预过滤提示；每个命中必须回到 canonical owner 重验 project/scope/applies-to/lifecycle/verification/validity/integrity，索引行无权授予资格。显式跨项目查询复用该索引并按 09 的任务级只读范围筛选，不改变记录 scope；报告/交接文档及 proposal 由所属 source/proposal owner 发布有界发现单元，以 `source.search/expand` 返回带种类和状态的任务资料，不混入 `memory.search` 的已验证事实。
14. canonical 转换与搜索投影的同步契约如下：active/verified current head 创建或更新 search document；正文 revision、rollback、scope/project/applies-to/validity 变化更新同一 unit 行；stale/conflicted 保留可匹配文本但改为 `status_only`，只能产生有界状态标记；superseded/rejected/tombstoned 删除索引行；bundle 导入先作为 candidate，通过门禁后才进入索引；retrieved/seen 等统计变化不重建 FTS。冲突成员以 `conflict_set_id` 聚合为一个状态提示。
15. canonical 事务只同步追加 projection job/outbox，不等待 FTS；未来 artifact/embedding 文件投影同样不进入 mutation 关键路径。worker 处理 search/FTS job 时必须重新读取当前 head，以 current revision/hash/seq 条件化幂等 upsert/delete，旧 job 不能覆盖新 revision。每个 eligible memory head 或 owner-published unit 必须有当前 search document，每个 search document 必须指向当前有效 owner/unit/revision；watermark 与双向完整性检查发现不一致即标 degraded 并重建。
16. 快速通道新记忆在索引追上前由下一轮 pinned delta 暴露；小规模 backlog 可用有界 canonical scan 补漏。backlog 超限、hash 不符或索引损坏时停用该投影并显示 `dirty/rebuilding/failed`，不能静默返回旧结果，也不能因投影失败阻止 canonical 写入。
17. FTS 文本只在投影中做确定性、版本化预处理：规范化拉丁文字/数字，在索引与查询两端生成 CJK overlapping 2-gram；canonical 正文保持原样。当前 Windows/SQLite 实测表明裸 `unicode61` 无法召回中文子词，而 `trigram` 无法处理两字查询；具体单字 fallback、token 体积与排序阈值留给 12 的 held-out 实验。v1 不建 embedding 表。
18. 任一 Agent 进程可在启动、写入后或空闲时抢占数据库级短租约，按有界批次执行至少一次的 projection jobs；job 以 projection type + owner revision + generation 幂等，进程崩溃后租约过期可接管，不引入常驻服务。普通 FTS 损坏执行 external-content rebuild/integrity check；tokenizer/schema 升级由迁移创建临时新 FTS、回填校验后切换，不建设通用多代索引框架。

### Scope-review projection contract

本节只在 scope-review 切片启用时生效；首次切片不建相应表、不启动 worker。Writer 是现有 cooperative worker，reader 是 Context Orchestrator，不增加 daemon、分析 Agent 或另一份 memory truth。先实现当前 project 的有界 overview；跨 scope 汇总、关系 fixed point 和 raw-backfill 按真实需求另启用，不捆绑交付。

**存储与提交：** `projection_artifacts` 保存不可变 artifact identity、scope、bounded body、content hash、format/generator version、input digest、generation 与状态；`projection_artifact_inputs` 保存逐条 claim→canonical revision/head 或 immutable source refs、owner/project/resource/`applies_to` 和授权快照。正文、refs、current projection pointer、covered cursor 与 job 结算在同一短 SQLite 事务 CAS 提交。Body 位于派生表而非 memory 表；同库存储不授予 canonical 权威。不需要外部文件、path pin、orphan GC 或同 hash repair。

**增量与并发：** 复用 outbox/lease/state，按稳定 identity 读取一致快照的 `(start_seq,end_seq]`，并记录参与 head/hash 与旧 cursor。发布比较当前 job claim/generation、cursor、参与输入及授权快照，过期 worker 不得提交。若参与输入变化则丢弃结果重排 job；未覆盖新 seq 保持 dirty/后续 continuation，不能被旧 cursor 跳过。未消费输入不因普通 job 回收而丢失；gap 保持 evidence-gap。具体 outbox 列和批次算法在该切片实现时收窄，不先建通用多代投影框架。

**读取与历史：** fresh 只是必要条件；装配和 admission 还要重验 body hash、scope、当前 input eligibility 和 covered generation。依赖失效、来源 purge 或 body 损坏均停止注入，走 canonical retrieval/source recovery。新生成正文产生新 artifact identity/generation/hash；不要求非确定性模型重现旧字节。仍被 assembly 引用的旧版本及 refs 保留为历史证据，不作 current 注入，只有无引用历史可回收；purge 是授权删除例外。旧 bytes 已丢失时，历史 inspect 报缺，不以新生成正文替换旧 receipt。只有能取得 hash 一致的原字节时才可恢复该旧版本。

**派生边界：** overview 只引用 eligible 事实和有来源的状态；新的 insight 先走 candidate/verification。当前 scope 之外的材料须先有显式 membership/derived-from 和授权，不因相似度引入。若启用跨 scope 依赖，typed input refs 必须支持撤销和 purge 的反向失效；缺闭包则阻断相关 overview。关系事件使用稳定语义 key、当前 relation state 与 evidence 幂等，不能以 job ID/模型措辞创建重复事件或无界自触发。

**预算与失败：** 每个 job 使用累计的输入/输出、source 调用、attempt、token/成本和 deadline 限制；单次 drain 有 batch/deadline 上限并公平轮转。参数先取可配置、有界初值，再按 workload 测量；换 batch/generation 不隐式补预算。超限保留 continuation/原因，不发布 fresh。普通失败只影响该 projection，不回滚 memory；memory relation 变更仍独立经过原 gate。清除覆盖 body、refs、digest、cursor/job 敏感字段及历史版本，不保留隐藏副本。

**Raw-backfill 后续接点：** 在启用前冻结 source snapshot/inventory、稳定 event identity 与 replay/ack、scope/time selector、连续覆盖水位、缺口及终结语义。正文先 durable 再交接，ack 前 source owner 保留可重放材料；重启补缺不重复 capture，不以可变高水位代替 inventory。枚举、捕获、验证、关系处理分别表示进度，processed 不等于 verified/active；未完成或有 unknown/gap 时不能宣称“全部历史已分析”。先用该能力的合成正反例验证，再加入需要的 schema；这些不是首次 P0/P1 的冻结义务。

所有启用路径的 resource identity 复用 Core/Host 的 `resource_identity@v1`：按输入协议 bounded decode/normalize，再对真实打开的 root/file ID 或授权 URL origin 重验；不能只凭路径字符串、realpath 或调用方自报 scope。Windows drive/UNC/case/junction 与 URL redirect 行为按实际支持 profile 冻结，未经验证的形式不可用；`applies_to` 不扩大 owner scope。此规则同时适用于文件工具，不依赖 overview 是否启用。

19. insight 本体是 SQLite durable memory；scope_overview 是独立后续切片的 SQLite 有界派生正文。Wiki、insight 页面与架构图文件继续 deferred；只有确有文件消费者时才决定输出格式、外部发布、purge 与恢复协议，不能把历史文件方案变成首次 schema 的空表或 gate。真实数据冻结后新增持久能力必须前进迁移。
20. v1 不建立统一 Wiki/知识仓库。机器生成的 project memory 只在个人 DB 中按 logical project ID 管理；用户明确批准的 ADR、AGENTS/policy、manifest 或项目文档进入其所属的现有项目仓库。需要分享时显式导出带输入 hash 和“生成快照、非权威”标记的文件；人工批准为 ADR 时创建独立权威 ADR，不能把 Wiki 文件原地升格。

<a id="analysis-handoff-artifacts"></a>

### Analysis reports and project handoff

本契约复用既有 source/archive、`evolution_proposals` 和可重建搜索投影，提供不依赖特定 Skill 的持久交接。它不启用 scope-overview/Wiki、全历史 backfill、跨宿主 bundle 或通用任务/制品管理系统。

1. **完整报告：** 分析任务的完整结果由原任务 source/archive owner 归档，绑定稳定 identity、不可变版本/正文 hash、真实任务与来源。内容覆盖目标、实际覆盖项目、事实/推断/建议、证据与未决问题；修订追加新版本并引用旧版。保存在 Euler 管理的归档载体，不跟随任意启动目录写入某个项目仓库；完成声明须已有 durable ack，崩溃/重复保存沿既有 identity 对账。目录布局由现有 source carrier 决定，不另建 report 数据库或文件发布系统。
2. **项目提案：** 有明确 target、预期改动、范围/非目标和验收方法的建议，复用版本化 inert proposal，按目标项目保存；可在预期改动/评估建议中表达收益、风险和未决项，不新增万能 proposal 类型。正文包含接手者所需的项目相关背景，并引用准确报告版本/区段和证据；保存事实不证明建议已验证、已采纳或已实施。普通交接摘要、缺 target/evaluation 的想法保留为 source 文档；可复用知识另走 memory candidate/verification，不能为获得搜索入口直接晋升。
3. **跨项目来源与可见性：** 原始来源保留真实 owner/project；Host 根据已批准交付目标绑定报告区段和提案，不能伪造 source binding 或将整份混合报告改 scope 为 personal/目标项目；含跨项目内容的报告或归档事件也不能因 originating session 绑定某项目就自动向该项目全部开放。只读分析授权允许其正常任务归档，不自动授予向其他项目发布资料的权利；项目可见交接材料须处于已批准的保存/交付范围。项目会话仅能发现和展开该范围内的相关区段/提案，每条引用仍单独重验读取权限；target 标签或报告链接不开放其他项目正文、名称或摘要。必要时生成带 derived-from 的获准项目摘录，不能仅挂一个不可读总报告链接冒充可交接。
4. **发现与接续：** 归档/proposal durable 后由既有投影入口提供有界、带类型/版本/项目/来源状态的发现单元，索引损坏可重建。新会话可按项目和任务问题搜索，再按需展开，入口不依赖手工维护关系表或安装某个 Skill。进入实施前重验相关代码/来源版本、适用条件及当前授权；旧报告只证明当时分析，不能成为恢复跨项目读取或执行权限的凭据。
5. **导出与任务交接：** owner 可显式导出 Markdown 快照，或批准将选定项目提案送入该项目既有 Issue/计划系统；一次批准可覆盖明确的一批目标。输出保留版本、来源与“分析/待验证建议”状态，提供足够的获准项目上下文，使不访问 Euler 私有 DB 的接手者仍能理解目标与验收；不可达引用明确报缺。外部发布、仓库写入和实施分别受当前授权约束，不内置任务系统集成、自动创建 Issue 或另行维护实施进度；发布后进度以目标项目已有系统为准。Markdown 交接是已选资料的受控输出，不是 X-15 的整库/event bundle 导出。
6. **保留与清除：** 报告正文、历史版本、项目摘录、proposal payload、发现单元、输入/输出 refs/hash 与实际受控导出副本均复用原 owner 的备份、恢复与 purge 闭包。来源撤销/删除时不能凭缓存或旧交接副本绕过当前权限；受影响摘录/提案及索引按依赖失效或清除。外部 Issue/远端仓库等无法控制的副本按既有规则列残留，不能承诺跨资源原子发布或全域清除。

## Decisions — Retention, forgetting, privacy and capacity

21. 不设统一 TTL：memory revisions、provenance、lifecycle/conflict/verification、owner correction 及导致状态变化的强 feedback 保留到隐私清除；execution ledger 跟随 §11 的显式 owner 与来源清除规则；FTS job 成功并推进 watermark 后可删除；host-info job 按 08 §27a 的持久 manifest/投递确认结算，不能套 FTS watermark 删除，已读/批次身份不随 job 回收；失败 job 保留到解决；FTS、embedding、未来 Wiki/cache 随时可重建。08-15 所要求的 `injected` 语义事实由 09 的 canonical assembly receipt 推导，不再重复写第二份逐条 feedback row；`retrieved` 仍由真实 search receipt 记录。source/archive 与仓库导出物遵循各 owner 的保留策略。
22. 普通“忘记”写 tombstone，以 08 §19a 的 owner/scope/claim/source 抑制键阻止同源自动复活，将 head 转为 tombstoned 并从正常搜索和投影中移除，但 canonical revision/event 仍保留供审计与人工恢复；界面必须明确其可恢复。隐私清除则不可恢复地删除 revision/candidate 正文、`provenance_refs` 中的 locator/hash、verification evidence、feedback/user text、evolution proposal payload、FTS/embedding/cache/文件投影、execution reverse refs/manifest 中对应的 ref/hash、受影响 assembled/transport/payload hash 及包含旧内容的本地备份；任何 metadata row 只要无法证明已移除全部自由文本、locator 与原内容 hash，就删除整行。隐私清除只有在 §23 的全部受控后置条件通过后才算完成；完成后的 purge 审计记录（本次 logical-commit、后续结果及最终 completion）均只保留与原内容不可关联的随机 operation ID、阶段/结果，不携带 target、正文、locator 或原内容 hash；逻辑提交事实仍属 memory_events，最终完成标记在 purge_receipts，各自证明不同阶段，不是重复 receipt 真值。另有下述旧 receipt 保留例外：purge **之前**已签发的 owner operation receipt 不属于须删整行的 metadata row，它只保留与原内容不可关联的假名 `subjectRef` 与 revision 标识（不得是 `mem-13` 这类可反查定位的目标 ID，也不得携带正文、locator 或原内容 hash），因而本身已满足“与原内容不可关联”；它是 11 要求的不可改写审计证据，清除闭包不回填也不重写它。若已签 receipt 无法证明其 `subjectRef` 不可反查，则仍适用删整行规则。Privacy purge 是对 09-16 可复算保证及 append-only replayability 的唯一破坏性例外：execution stream 的 content-free event envelope、type/version/seq/timestamp 与 attempt 状态可以保留，受影响 payload 删除并追加无内容 redaction/purge marker，stream 标记为不可完整复算；整段 session 被清除时直接删除其 owning ledger。
23. 隐私清除由 source/archive owner 一并处理 Pi session、文件等原始材料；无法控制的 Git remote 或外部备份必须列为残留位置，不能宣称这些位置已清除。SQLite 主库、WAL 与空闲页进入清理维护，但因 v1 不加密，该保证仅覆盖活动系统和受控本地副本，不冒充 SSD/文件系统层面的取证级擦除。

   - **准备与唯一提交点：** 先按已批准的 target/scope 形成完整结构化删除 manifest，并在提交前重验批准、`head_event_id`、完整 snapshot、owner/resource identity 与闭包。Core 按 §23a 经各 owner 关闭 admission 并取得旧活动终止/内容失效的确认，使其不能再派生旧内容；确认不齐就不开始删除。短 SQLite 事务原子完成数据库内逻辑清除、不可变的 logical-commit receipt，并在既有 `pending_operations` 中保存同一 operation 的最小 cleanup continuation、manifest 与 owner 确认进度。此事务 durable commit 是不可取消点，外部文件/备份删除必须在它之后。提交前失败回滚数据库且不删除外部载体；提交结果 unknown 时先按 operation/receipt 查询，不重做 mutation，也不把未知当未提交。
   - **提交后向前清理：** 目标从正常查询、恢复、bundle、projection 与模型上下文中隔离；所有持有受影响内容的 session/window 先停止 dispatch，按既有 invalidation/重建路径处理。各 owner 以同一批准 manifest、当前权限和实际 file/resource identity 幂等清理 main/WAL/free pages、备份、source/archive、缓存及展示引用。删后崩溃、锁文件、ENOSPC、权限撤回或载体变化只能报告 `error` 且 `cleanup=incomplete`/明确残留，不能假称未变更、已回滚或 controlled-complete。重启先核对已提交 receipt、实际残留与进度，再续做；缺证、身份漂移或原边界之外的新目标保持 blocked，不盲删替换后的资源，也不复用批准扩大范围。
   - **恢复材料与完成：** continuation 只保留续做所需的 locator/identity/ack，不保存正文；它受同一隐私边界保护，不用于检索或模型输入。这是清理未完成期间的临时恢复材料，不是 §22 的完成后保留例外；清理中不得发布或恢复会复活旧内容的备份/bundle。各外部 owner 的后置条件通过后，先在数据库事务内删去 continuation 的敏感字段/反向引用，只留下不可关联的 operation ID 与“外部已完成、数据库维护未完成”进度。随后在受影响读写仍被阻断时完成 SQLite 主库/WAL/空闲页维护及复核；删 continuation 自身产生的旧页也在此次维护内。此阶段崩溃按无内容进度重做整库维护，不依赖已删 locator，不恢复旧数据。全部维护通过后才追加 content-free `purge_receipts` 完成记录，恢复缺失呈现和允许的读写；在此之前不得显示 controlled-complete。已签 logical-commit receipt 与后续结果分别追加，不改写旧 receipt。`pending` 仍仅表示等待批准，cleanup continuation 不占新的批准槽位；它复用已结算 operation state 和现有 maintenance/cooperative drain，不新建清理框架。
   - **失败安全：** canonical store 或 continuation 不可验证时，受影响能力保持关闭；不能从清除前快照重新激活目标或用“找不到 operation”推断从未清除。恢复须先对账清除进度/受控残留，无法证明时交 owner 处理。普通 correct/forget/restore/rollback 的单库事务语义不受分阶段 purge 改变。
23a. **首版仅维护模式 purge（同库 admission + 宿主进程退出）：**

   1. 正常运行可用多个合规宿主进程，但每个进程在首次读取受控 source/store 前，须在同一事务检查 store/实际 root fence open 并登记 `owner_activities` 中的 process incarnation、owner/root 与 epoch；身份不能仅用 PID，也不能由模型自报。登记持续到整个进程及其受控子任务结束，不为每个 UI 缓存或内容读取另建活动状态机。所有模型请求、canonical mutation、source append、backup 和投影提交在实际入口重验 fence/epoch。
   2. 用户请求清除时，普通 Host 只说明需要维护模式和停止运行的影响，不在旧运行 session 中先批准删除。独立的受信任维护入口以 CAS 将 store/受影响 root fence 置 closing、递增 epoch，停止新增 runtime/dispatch，要求旧宿主进程及其子任务退出并核验临时文件、backup 和其他受控残留。需要终止工作或进程时取得 owner 授权；不删除外部内容。关闭窗口、agent_end、abort、失去心跳或 lease 到期均不是退出证明；证据不足保持 blocked。进程退出机制与证明方法先用当前 Windows synthetic 探针验证，不要求首版实现各类缓存在线 quiesce。
   3. 取得维护独占并证明旧进程不能迟到写入后，维护 Host 才从实际状态生成完整 canonical preview/manifest，取得一次绑定 token/nonce 的真实批准；此批准不从旧 session/pending 重建。范围变化必须重显重批，不能扩大既有批准。唯一维护协调者仅可查询批准范围、呈现/批准/取消、对账及执行清除，不能调用模型或普通业务工具；自身呈现、输入与 continuation 的敏感数据归该 operation 并加入自清除。提交前取消可重开新 epoch，旧 token/activity/window 不复活。
   4. 按 §23 短事务提交逻辑清除、receipt、continuation 和 cleaning；之后外部清理只能幂等向前完成。实际删除 ack、资源 identity 与残留扫描是进度证据，不以超时推断完成。新进程启动先查持久 fence，不能默认 open；协调者崩溃后只有证明旧协调者退出并重新取得维护独占才能续做，不因 lease 到期并行删除。清理中的目标不能进入恢复、模型或新 backup。
   5. 敏感 continuation、fence/activity、intent、Info 与 source 引用全部清除后，只保留无内容 operation/store epoch 进度；在仍独占的条件下维护 main/WAL/free pages 并核验，再同事务追加 content-free completion 和开放新 epoch。崩溃按无内容进度重做末段，不恢复已删 locator。旧 runtime 必须重新启动并从当前合格状态建立新 window，不能 resume 已清除内容。已承诺受控的 owner 失联保持 incomplete；事先声明无法控制的外部副本列残留。该保证不涵盖任意恶意同用户进程或取证级擦除。在线细粒度 quiesce 是有实际需求后的独立能力，不是首次 P0/X-12 必须实现的路径。

24. 容量压力先删除可重建 projection/cache，再清理已完成 job/临时文件，再暂停可选 embedding、统计与未来 Wiki 生成；仍不足则明确失败，绝不自动删除 canonical memory 或审计事件。若 archive 或 dispatch 前 ledger barrier 不能 durable commit，必须停止模型请求。soft/hard 数值需要 12 以真实数据规模和三平台磁盘行为确定，不能在无数据时拍脑袋写死。
25. 首次真实数据冻结 v1 后，使用 Node 内置 SQLite online backup：数据变化时每日最多一份，原子保留最近两份；schema 迁移前另建临时恢复点，迁移通过后删除；快照须经 `quick_check` 后才标记可恢复。隐私清除时按 §23a 排空 backup activity，删除所有含旧内容的受控快照，再在完成门禁后生成干净快照；临时备份及最终 rename 都在 activity 内，未确认产物不能标可恢复。同盘快照只防逻辑损坏；离机备份依赖显式 bundle，不实现自动云同步。

## Decisions — Portability, integrity and recovery

26. 跨宿主 bundle 是后续独立能力，不阻塞首次本地 provider 测量/启用；未验 X-15 不提供该入口。启用时使用版本化、明文、内容寻址 `manifest.json + events.ndjson + blobs/<sha256>`。必须显式选择 scope/project/session 或 records，禁止默认整库导出；仅展开必要 records/revisions/events/provenance/tombstones 闭包，heads/index/cache/jobs/leases 不导出。逐文件 hash、event_id 与 origin 幂等检查，冲突保留，导入内容先为待重验候选。仅显式 owning session 可携带其 ledger；不导出 job/maintenance/migration streams、活动 intent/fence 或待执行批准。导入地的重新验证事件与原 origin 事件分开，往返不改写原事件，也不复活原运行权限。
27. 每次打开只执行 schema fence 与连接 PRAGMA；backup、迁移和定期维护执行 `quick_check + foreign_key_check + stream/head invariant check`。projection 损坏直接删除重建；canonical 检查失败时停止写入和模型 dispatch、保留原损坏文件，只从最近已验证快照恢复，不自动运行可能丢记录的“智能修复”。恢复后必须追加 content-free `store/recovered-from-snapshot@v1` receipt，将所有可能丢失快照后事件的 stream 标记为 `recovered_with_gap`/不可完整复算；这些旧 session 及 job/maintenance/migration owner 在与真实来源/操作 owner 对账或显式封存前保持 dispatch-blocked，不能把快照后的缺失事件当作从未发生。快照中已有的 started/no-finished attempt 保持 `orphaned/unknown-sent`，绝不自动重发；用户只能开启不继承旧 attempt 的新 session/epoch。
28. v1 使用 revision/blob SHA-256、连续 stream seq/唯一约束、receipt payload hash 与 bundle manifest hash；不增加签名、密钥体系或全局 hash chain。hash 是完整性与内容寻址 receipt，不提供本机恶意篡改后的真实性；远端 bundle 无论 hash 是否正确都仍是不可信数据。

28b. 以下加固由本层承担、不由 11 的单页 fixture 负责验证（11 只定语义，单页 JS 对象图无信任边界：能调 reducer 的代码同样能直接改内存状态并重算摘要）。v1 实现必须把它们作为显式验收项：canonical record/revision/event 行提交后 append-only、调用方无法原地重写再重算摘要；receipt/manifest digest 覆盖完整 payload 而非仅 ID 列表，重新签名不得让重排或改写后的 payload 通过；行级 identity 由存储层分配、调用方不可伪造；privacy purge 的删除闭包遍历必须 cycle-safe 且按结构化字段/键比较，不使用序列化全文 substring；purge 的数据库内后置条件失败时该逻辑事务回滚，外部清理尚不得开始；逻辑提交之后的物理清理失败按 §23 保留可恢复的 incomplete 结果，不承诺跨资源回滚。

28c. 自由文本到记忆操作的生产接线同样由实现层承担，不把 11 单页里的正则 adapter 当作意图分类器：模型只能提交版本化、结构化的 memory tool intent，Host 仍须对 originating user input、action kind、唯一目标、scope/权限、lifecycle 与破坏性等级做模型外重验。打开破坏性预览前必须有确定性冲突门禁：同一输入若同时含删除动词、未被否定的显式不可逆标记（含 `purge`）和不在该标记内部的恢复/撤销/回滚方向词，拒绝执行并要求 owner 只保留一个方向后重述；不得由模型或启发式替 owner 在两个相反方向中择一。其余开放式中文复述、词序、附着、中英混用与同义词精度在本层使用冻结的 held-out/对抗语料及真实模型 tool-call 做实现验收；解析失败只能降级为不执行/要求重述，不能升级成不可逆操作或落入相反方向，也不再作为 11 fixture reviewer 可无限扩展的 FAIL 面。

## Evidence and reuse boundaries

29. 当前 Windows 宿主实测 Node 24 的 `node:sqlite`、SQLite 3.53.1、FTS5 与 WAL 可用，项目本身零运行依赖；这支持“内置 SQLite + 最小 TypeScript host”作为 v1 起点，但 macOS/Linux 与真实并发、故障和容量仍须 12 独立验证。
30. 已安装 MC `0.40.1` 的 bundle 与生产 `context.db` 已只读核验：它使用用户级 SQLite、WAL/FULL/foreign keys/busy timeout、编号迁移、external-content FTS、embedding、watermark/lease 与 hash 条件写入；一次历史观察记录该库已应用 81 个编号迁移并包含大量 canonical、FTS shadow 与运行状态表，该数字必须绑定 observation timestamp、host/install identity 和 source receipt，不能与其他时间点的 migration head 直接比较。它同时使用路径型项目身份、mutable memory rows、默认 embedding 和大量运行状态表，也没有 09 所需的 per-attempt dispatch ledger。因此只借连接 PRAGMA、v1 后 schema fence/事务迁移、external-content FTS/dirty watermark、hash 条件投影写入、source/canonical/projection 分离及恢复状态；不读写其私有 schema 作为新系统真值，不让两个系统共管同一 DB。13 仅通过只读 adapter 迁移所需数据。
31. TriviumDB 固定提交 `e1201af53aaf4ca8bed666c2d60424c260b1992a` 的完整 Rust library 测试在当前 Windows 宿主 112/112 通过，独立临时 clone 中源码构建的 Node 24 binding 生命周期也通过；其 CJK 2-gram、WAL/恢复、generation/hash 校验和损坏索引降级均为可借鉴实现。但它要求固定维度向量、缺少本方案的关系约束/迁移/lifecycle 模型，writer 持排他锁，截至 2026-08-29，Node `payloadFilter` 缺口仍见 [issue #29](https://github.com/YoKONCy/TriviumDB/issues/29)，空 WAL 格式兼容修复仍在 [PR #30](https://github.com/YoKONCy/TriviumDB/pull/30)；因此不进入 v1 依赖，不复制存储代码，只借 tokenizer、索引校验和崩溃测试案例。未来 embedding/多跳检索有真实需求且 held-out 实验胜出后，可把它重新评估为可重建检索投影，不能作为 canonical store 或 execution ledger。

## Explicitly deferred / rejected

- v1 不使用图数据库、统一语义库、Markdown-only canonical memory、MC 私有 DB、TriviumDB canonical store、默认 embedding、手写内存向量检索、统一 TTL、网络同步或单一平台验收。
- 具体 DDL/索引根据正常事务与 query plan 收窄；CJK fallback、batch/lag、容量和 backup 时延先用有界可配置测试初值，再按 workload/平台实验调整。未测数值不宣传为性能保证，不要求先在三平台找出最优值才允许实现。参数调整不改变 owner、durability、privacy 与失败语义。
- 11 只原型化记忆出错后的“看、改、退”闭环：变更前展示 canonical 内容与影响，复验自动运行，rollback 仅针对自动 memory revision/activation；不新增独立 CLI，也不把模型请求错误变成用户工具。13 冻结 `app-id`、目标运行时接线、MC 只读迁移与单向切换路线和首次真实 schema v1。
