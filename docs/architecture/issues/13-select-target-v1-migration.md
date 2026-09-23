# 定案目标架构、最小 v1 与 MC 迁移路线

Type: grilling
Status: resolved
Blocked by: 05, 06, 07, 08, 09, 10, 11, 12, 14

## Question

综合全部已关闭决策，最终目标架构、最小 v1、阶段顺序和可观察验收标准是什么？v1 如何与 Magic Context 配合，达到哪些恢复、连续性、正确性、安全与成本门槛后才允许替换其能力？

## Comments

- **2026-09-09 范围修订：** 总交付范围统一引用 [15 I01](15-euler-v1-spec.md#v1-scope)；本票 D8 只映射阶段和直接依赖，后续能力的接点不成为首次切片的隐含前置。历史 D1–D8 的“已定案”只指当时设计，当前修订需复验，不新增运行 PASS。

- `ai-agent-book@1111794f` 不改变既定实现范围：v1 实现聚焦记忆生命周期与上下文协作；AGENTS/policy、Skill、Tool/MCP 在本票只冻结与 Core 的集成接口、装配边界和安全门禁，不拥有 canonical memory；代码与 Harness 自修改仍留在后续地图。
- 未来启用任何行为自修改前，新增两个硬门槛：content-addressed receipt 必须通过完整性核验；安全与回滚 verifier 必须覆盖 Windows、macOS、Linux 三个实际目标宿主。该门槛不扩张 v1。
- 本票冻结最终 `app-id` 与首次真实 `schema v1`，明确 Pi `Agent`/`AgentSession` 接线、Host-owned ledger 契约及跨 harness API；MC 仍启用时由 MC adapter 独占唯一 context hook，不运行第二套裁剪器。
- 运行时接线按 14 拆分：Pi 宿主 adapter 用 Pi 稳定 `Agent`/`AgentSession` 运行时，自研 CLI 只依赖 `@earendil-works/pi-ai` 的 provider/model 接口、自有 Agent loop 与 TUI（不引入 `pi-agent-core`/`pi-tui`）；两者共用 09 的 Host-owned ledger、预算、receipt 与安全不变量，并实现 14 的同一宿主状态机与四个薄操作，按 14 的能力矩阵做真实验收。
- 迁移按阶段推进，且只在 cutover 前可取消：D7.1 默认只读审计 MC 并保留其原库作为历史 reference，不把旧 memory 导入 Euler canonical；优先从原始 session/source archive 以新模型重建 candidate，完成 provenance/verification 后再重建搜索投影，再以 11/12 的可观察与故障证据决定是否切流；只有对应能力的恢复、连续性、正确性、安全、延迟与成本量化门槛达标，才允许替换该项 MC 能力，不要求全历史库一次性达标。Euler 成为 live owner 后单向前进，不做 MC 双写、数据兼容层或运行时 fallback。
- 2026-09-04 的 Codex/GPT-6 Astra 研究只作为上下文管理兼容性证据：上游已有实验性 fresh-window、token-budget 与 bounded history/notes 路径，但未证明默认启用、当前本机可用或具备 Euler 的 provenance/scope/安全语义；以下增量不改变已冻结的 Q8–Q10，Q11 的生成式 artifact 时机已通过 Ticket 10 窄重开修正，Q12/D4 已定案，D1/D2/D3/D4 已完整回填，D5.1–D5.5 已定案，D6.1 已定案，D6.2 已定案：有界发现、必要状态提示、同名解析及内容识别与加载一致性，D6.3 完整 Skill 指令生命周期已定案，D6.4 已定案，D6.5 已定案，D7.1 已定案为只读审计 + fresh rebuild，D7.2 已定案为按能力切片的只读 shadow 与差异门禁，D7.3 已定案为先以唯一 live context unit 小范围切换 Euler，再扩大 memory lifecycle；Notes 不导入、不阻塞 v1，旧 Dreamer 状态不迁移，D7.4 已定案为 owner 提交前可取消并重验后继续/重启 MC、提交后 Euler 单向运行且不保留 MC fallback/双写/旧数据兼容层，D7.5 已定案为按能力/宿主执行硬门禁、配对基准和 canary 前预注册阈值，D8.1/D8.5 已定案为五阶段实现顺序及全局 fail-closed + 局部降级，D8.3/D8.4 已定案为三平台 GitHub Actions 共享回归、目标平台真实宿主高风险验收及 Windows 先行，D8.2 已定案：X-01～X-15 按五阶段及独立课程实验映射，Core/Host 分层验收，X-10/X-11 联合放行；D1–D8 设计决策全部完成。

## Decision inventory

以下分叉均已由 owner 定案；`resolved` 只表示设计决策已确认，不表示独立复验、P0 制品、schema v1 或任何 X-card/CI/真实宿主验收已通过。本轮继续按 owner 批准补齐 purge 跨进程围栏、显式 stream owner、Core intent、Info outbox、tombstone、MCP discovery 与受控 Pi runtime；原分阶段 purge、head 事件 CAS、staging 与单向 cutover 方向保留，需新 SHA 完整复验后才可迁移。

### D1: Background model policy

- [x] D1.1 Proposer: 用于 candidate 提取的默认模型、fallback、配置方式、失败处理
- [x] D1.2 Compartment Historian: 用于生成 compartment/摘要的默认模型、fallback、是否允许与 Proposer 相同
- [x] D1.3 Verifier: 用于验证 memory 的默认模型、隔离要求、何时必须使用不同模型/平台
- [x] D1.4 Receipt recording: 每次 proposal/compression/verification 是否记录实际使用的 provider/model/version，记录在哪里

### D2: Runtime topology and ownership

- [x] D2.1 Shared core: 哪些组件属于共享核心（封闭在核心，不开放插件），边界是什么
- [x] D2.2 Pi adapter: Pi adapter 的职责边界、它使用哪些 Pi 运行时组件、不使用哪些
- [x] D2.3 Self-built CLI: 自研 CLI 的职责边界、它依赖哪些 Pi 包、自有哪些组件
- [x] D2.4 Cross-Harness API: 两个宿主之间是否有共享 API/契约，是什么，放在哪里
- [x] D2.5 Repository mapping: Ticket 12 的 `RUNTIME/store`、`RUNTIME/core`、`RUNTIME/host` 实际对应哪些仓库/目录/包

### D3: Physical contract (app-id, schema v1, DDL)

- [x] D3.1 App-id: 最终 app-id 是什么，与 MC/`.pi` 的关系
- [x] D3.2 Platform data roots: Windows/macOS/Linux 的实际数据根路径模板
- [x] D3.3 Schema v1 freeze: 何时冻结 schema v1，冻结前后的行为差异
- [x] D3.4 Minimal DDL: 10 §7 列出的表族，v1 必须实现哪些表，哪些可延迟
- [x] D3.5 Host presentation state: 14 要求的 Host-owned presentation/pending 记录具体放在哪些表，与 execution ledger 的关系

### D4: Background work wiring

- [x] D4.1 Candidate extraction: 在哪些边界触发、谁负责提取、如何进入队列
- [x] D4.2 Verification: Verifier 何时运行、独立上下文如何构造、失败如何处理
- [x] D4.3 Compartment generation: Historian 何时运行、输入是什么、输出如何持久化
- [x] D4.4 Indexing: FTS/projection worker 何时运行、幂等性如何保证、失败如何观察
- [x] D4.5 Wiki/insight projection: 何时触发、输出到哪里、失败/队列/重试行为

### D5: Prompt/cache ownership and ordering

- [x] D5.1 Context Orchestrator: 唯一 Orchestrator 的职责边界、它在哪个层次/组件中实现
- [x] D5.2 MC context hook: MC 启用时如何独占 context hook、禁止第二套裁剪器的机制
- [x] D5.3 pi-cache-optimizer: 与 pi-cache-optimizer 的兼容性、是否使用它、如何协调
- [x] D5.4 Provider request serialization: provider API 请求格式转换、最终 transport payload 的冻结边界与后续可改写者
- [x] D5.5 Cache epoch: 何时开启新 cache epoch、如何与 compartment/compression 协调、紧急变更如何处理

### D6: Agent instruction/capability integration contract (AGENTS/policy, skills, tools)

- [x] D6.1 AGENTS/policy: 当前项目 AGENTS.md/policy 如何进入 P0 instruction channel、更新如何观察
- [x] D6.2 Skill catalog: compact skill catalog 何时注入、包含什么、如何与 full instructions 协调；有界目录、按需发现、必要状态提示、同名解析及内容识别与加载一致性边界、来源及顺序、catalog 元数据与引用形式已定案
- [x] D6.3 Full skill instructions: 选中 skill 的完整指令何时注入、在哪个优先级区、如何缓存
- [x] D6.4 Core tool schemas: 哪些 tool 属于 core/mandatory、哪些是可选、schema 版本如何管理
- [x] D6.5 MCP tools: MCP 工具如何发现、注入、与 core tools 的优先级

### D7: MC migration, cutover, and failure handling

- [x] D7.1 Read-only source audit + fresh rebuild: MC production DB 只读盘点与旧 memory 保留/重建策略
- [x] D7.2 Shadow verification: MC/Euler 只读 shadow 的比较维度、差异分类与按能力切片的可接受差异
- [x] D7.3 Capability-by-capability cutover: 按什么顺序切换能力（memory retrieval / compartment / notes / dreamer）、每项的前置条件
- [x] D7.4 One-way cutover and pre-cutover failure recovery: 切换前如何取消/保持 MC，切换后 Euler 故障如何处理；不保留 MC 运行时回退、双写或旧数据兼容层
- [x] D7.5 Evidence required: 每项 cutover 需要哪些量化证据（latency / recall / correctness / cost）

### D7.1 Decision — read-only source audit and fresh rebuild

1. D7.1 默认采用 fresh rebuild，不把 MC 的旧 `memories` 或 `user_memories` 行导入 Euler 的 active/canonical memory。MC production `context.db` 只用 `mode=ro`/`readOnly=true` 的一致性事务盘点与对照；不得在 MC 上执行 migration、vacuum、repair、checkpoint 或测试，也不得复制生产 DB 后对副本宣称为一致迁移源。MC 原库保持原位，仅作为只读历史 reference/source，不作为 Euler 的运行时回退实现。
2. Euler 的重建输入优先是原始 Pi JSONL、source archive 和 owner 明确批准的 bootstrap facts。Euler 读取这些原始来源，重新执行 candidate extraction、provenance、integrity gate、独立 verification 和 scope/temporal/conflict normalization；旧 MC summary、compartment、memory 文本不能替代原始证据。原始来源缺失时保持 `evidence-gap`，不从旧摘要补写或猜测。
3. MC 旧 memory 只允许作为 read-only reference、已知错误/负例集或带 provenance 的定位线索。线索必须回到原始来源重新提取和验证，不能直接成为 Euler candidate 的事实证据；旧的 `status=active`、`verification_status`、Historian/Dreamer/agent 来源和 mapper 记录都不能直接转成 Euler `verified/active`。
4. 迁移时建立 source snapshot receipt：记录 source locator、只读事务边界、MC schema migration head、表/行计数、mapping policy、observation timestamp、host/install identity 与 digest。当前实时盘点观察到 MC migration head 为 83、`memories` 1543 条且全部 `unverified`；该数量只作为本次盘点证据，不是固定 schema 或未来迁移基线。每次重建以新的 snapshot receipt 为准。
5. scope/project 不按字符串或路径自动转换。MC `project` 只有在真实 resource owner/manifest 将其绑定到 Euler `project_id` 后才可重建；`ecosystem`/`universe` 没有 Euler v1 的直接等价物，保留为未映射 reference/quarantine，不映射成 workspace/personal。workspace membership 必须显式确认。
6. MC FTS、embedding、cache/M0/M1、compartment summary、Dreamer queue/run、pending/mirror 状态、session metadata、primers、generated key files 和其他运行投影全部不导入；Euler 自己重建 FTS、compartment、job、lease、window、ledger 和 projection。`memory_mutation_log`/`memory_verifications` 只作为不完整历史 evidence，不冒充 Euler append-only event/receipt。
7. 重建写入全新的 Euler staging DB，不写 MC。P0 在启动配置与 receipt 中冻结该准备库的 app-id、host、run/scope、路径与实际 file identity；与 MC 及任何已 live store 重合、指向同一文件或身份不明时禁写，不建额外 profile/registry。准备库使用目标 schema，允许 candidate、verification、memory event/head、projection 和独立 execution/assembly/attempt receipt 写入；其中 verified/active 只代表准备数据通过了对应资格门禁，不赋予 live hook 或外部副作用权限。每个 rebuilt candidate 带 source snapshot、原始 locator、source row/message hash、origin、mapping reason 和初始 `unverified` 状态；以 snapshot/mapping policy/source identity 幂等，不能生成重复 event。校验失败只隔离本次准备库，按其 owner/retention 规则清理；MC/live 数据不变，原始来源不随 staging 失败删除。未通过 verification 的内容不进入正常 retrieval/index。真实来源重建仍须先通过 Physical contract 的真实写入门禁。
8. 首次 cutover 绑定已验证准备库的同一数据身份、scope 与 receipt，不借切换重新提取或绕过 verification；P0 冻结其正式数据根落点及停写/关闭连接后的启用步骤，若需要移动文件则重验 identity/hash/schema 后才能绑定。此后它是该宿主唯一 Euler live store，不保留可继续写它的 staging 连接；后续 project 扩围沿同一 Core 门禁执行，不建立第二个 canonical owner。fresh rebuild/shadow 期间 MC 仍是唯一 live context owner；D7.4 的 durable owner 提交才授权 Euler live。旧 MC memory 不进入 Euler 正常 prompt。

### D7.2 Decision — capability-scoped shadow verification

1. MC-active 期间 MC 继续作为唯一 live context、compaction 与线上注入 owner；Euler 以相同 raw session/source input 做 offline replay 或 live read-only shadow。这里的只读约束 MC、已有 live store/request/cache 与未授权外部副作用，不禁止 D7.1 准备库内的 candidate、验证、head、retrieval、assembly 与 receipt 写入；shadow 的所有结果只落该准备库及其已声明的私有证据位置。模型调用使用准备库独立 attempt receipt，并限制为已授权的只读测试路径；shadow 配置无权启用 live hook，不能把准备库身份替换成线上文件。
2. shadow 的比较基准不是 MC memory 行逐条相等。MC 旧 memory 只作 reference/negative baseline；Euler 的事实质量以原始 source、owner 标签、人工标注与 held-out corpus 为准。每个比较样本必须保存输入/source snapshot、active project set、两套选择结果、assembly/payload hash、模型与版本和差异分类，避免用不可复现的实时状态比较。
3. 比较至少覆盖：scope/project/workspace 隔离、owner/capability/approval/CAS/receipt gate、source locator/hash 与 evidence-gap、temporal/conflict/supersession、candidate/verification/active 生命周期、retrieval precision/recall/claim coverage、window rollover/source recovery/ReAct tool pairing、预算与 P0–P3 字节边界、projection/lease/idempotency/purge，以及 input/output/cache tokens、TTFT、总延迟、失败率、存储和成本。有效 immutable locator 的恢复在测试 fixture 内必须可验证；质量、延迟与成本阈值由 D7.5 按能力切片登记，不要求全历史数据一次性达到目标。
4. 差异必须分类为 `equivalent`、`Euler improvement`、`expected migration difference`、`MC legacy defect`、`Euler regression` 或 `inconclusive`。Euler 过滤 MC 的 unverified/错误 scope 内容属于预期替代差异，不是回归；source 缺失、两套系统都无 gold evidence 或 provider 观测不足属于 `inconclusive`，不能算 PASS，也不自动算 Euler FAIL。
5. 以下为零容忍硬门禁：错误 scope/owner 泄漏、未验证 memory 自动激活、source hash 错误冒充原文、policy/capability/approval 绕过、receipt 与请求不一致、prompt 超预算、拆散 assistant/tool pairing、Euler shadow 改写 MC live request，以及任何未经授权的副作用。一次高影响错误阻断对应能力，不能用平均召回、延迟或成本抵消。
6. 非硬安全质量按能力和 scope 独立放行，而不是全局 all-or-nothing。可以先以空 memory 或少量 verified/owner-confirmed bootstrap facts 启用单一 project/低风险 memory slice；未通过的历史数据、project 或能力保持 `evidence-gap`/disabled/quarantine，不阻塞已通过的 slice。检索排序差异、旧摘要与新 candidate 数量差异、cache 命中或 TTFT 差异，只要满足对应质量门槛且无安全回归，可以接受。
7. 未解释的高影响差异阻断受影响能力；局部召回不足、投影失败或 provider 指标不支持只允许局部降级为空结果、`unavailable` 或 `evidence-gap`，不能回退到不可信 memory。shadow 通过只表示该能力具备进入 D7.3 cutover 评估的证据，不自动改变 live owner；D7.4/D7.5 分别决定切换前失败处理与量化门槛。

### D7.3 Decision — capability-by-capability cutover

1. 迁移先建立新系统，再按能力切换；在对应能力满足自身门槛前，MC 继续是 live context、compaction、memory 注入和 notes 的 owner。基础阶段依次完成 `raw archive/source inventory → Euler staging DB → fresh rebuild → candidate/provenance/verification → FTS/retrieval/compartment shadow → offline/live shadow verification`，Euler 的准备写入仅按 D7.1/D7.2 进行，不修改 outgoing prompt、MC DB、已 live store 或 live cache。
2. 第一项 live 能力是一个不可拆分的 Euler context unit：`memory retrieval + source recovery + Context Orchestrator + budget/compaction + compartment 或 fresh-window fallback + provider request barrier`。不能先把 Euler retrieval 注入 live prompt、再让 MC 继续 compaction；切换步骤为 `shadow 通过 → 选定 project/session canary → quiesce MC → 证明 MC context handler 未加载或已卸载 → 持久化 Euler owner/epoch 与不可改写 cutover lifecycle receipt（D7.4 唯一提交点） → Euler 注册唯一 live hook → 发送 canary 请求 → 观察后扩大范围`。若无法证明 hook owner 互斥，session/process 必须 fail-closed；无可靠 unsubscribe 时先 quiesce 并重启。
3. 第一阶段仅启用一个明确 project/session、少量低风险且已 `verified` 的 memory；无强命中返回空，source 不足返回 `evidence-gap`，不要求继承全部旧 MC memory。context unit 稳定后，再扩大 Euler 的后台 memory lifecycle：`capture → Proposer → integrity gate → Verifier → verified head → retrieval projection`，先限于新 raw events、单一 project、低风险 preference/decision 和 owner-confirmed 或高证据 candidate；高风险、跨 scope、安全/权限和行为修改候选继续人工门禁或保持 `evidence-gap`。
4. MC `notes` 与 Euler canonical memory 属于不同语义面。v1 不自动导入 MC notes，不把它们作为 Euler active context，也不让 notes 阻塞 Euler memory/context 上线；需要保留时只把 MC 原库作为只读 reference。未来若确认 notes 是独立产品能力，另行定义 owner、schema、展示和恢复契约。
5. 旧 MC Dreamer 的 queue、run、pending、M0/M1 和 compartment summaries 不迁移。Euler 只使用已定案的 cooperative worker、Historian、Proposer、Verifier 和 projection jobs；若未来确有 Dreamer 类主动后台工作的产品需求，作为 Euler 新 job type 单独验收，不作为 MC Dreamer 的兼容切换。
6. 推荐阶段为：`S0 MC live + Euler shadow`；`S1` 一个 project/session 的 Euler memory/context canary，MC hook 退出且 Euler 唯一 live；`S2` 扩大到更多 project 但仍只启用 verified slice；`S3` 扩大 Euler capture/Proposer/Verifier 后台能力；`S4` 仅在明确产品需求下单独设计 notes 或 Dreamer 类能力。
7. 每项切换共同需要 D7.1 fresh rebuild、对应 D7.2 shadow 通过、D7.5 capability-specific evidence、D7.4 one-way cutover contract、明确 project/scope/owner、可证明互斥的 hook owner，以及 durable 的新 epoch、assembly 和 lifecycle receipt。无需等待全历史 memory 重建、所有 project 映射、notes/Dreamer 替代或所有 provider 优化完成。cutover 提交前的硬门禁失败只允许保持 Euler shadow；在证明未提交、无 in-flight/第二 owner 后可继续或重新启动 MC，维护中可暂时无 live 服务。提交后不保留 MC 运行时 fallback、双写或旧数据兼容层。非硬质量失败可以把对应 slice 保持 `disabled`/`evidence-gap`，不阻塞已通过的 slice。

### D7.4 Decision — one-way cutover and failure handling

1. D7.4 不实现 MC ↔ Euler 数据兼容、双写、旧 memory 导入或切换后的 MC 运行时 fallback。MC 原库可按 D7.1 作为只读历史 reference/source 保留，但不作为 Euler 的 context、memory、compaction 或恢复 owner。
2. cutover 的唯一不可取消点是同一短 SQLite 事务 durable 提交 `owner=euler`、新 context epoch 与不可变 cutover lifecycle receipt。scope、准备库身份、旧 owner/epoch 与 quiesce 证据须通过 CAS 和所有前置门禁；事务失败无半个 owner 切换。首个 canary 不定义提交点，只是提交后的验收请求。
3. 固定顺序为：停止受影响 scope 的新请求，完成或明确隔离既有 attempt（unknown-sent 不重发），证明 MC handler 已退出且不会再 dispatch，必要时采用维护重启；然后执行第 2 项提交；最后才启用 Euler 唯一 hook，冻结 assembly/最终 payload、通过 assembly/started barrier 后发 canary。提交前失败可以取消，只有证明未提交且 owner 互斥时才可继续或重新启动 MC，不承诺维护窗口始终在线。提交后 hook 注册、启动、barrier 或 canary 失败均是 Euler 故障，保持 blocked/按 Euler 修复，不能再记作切换前取消。
4. 每次相关宿主启动或恢复，先验证 durable owner/epoch/lifecycle 与 store identity，再按该 owner 选择加载 hook，并在 dispatch 前重验互斥；启动配置和内存 hook 不是另一份 owner 真值。记录缺失、损坏、提交结果 unknown 或快照恢复存在 gap 时保持 ownership 未知并禁发，不能由“找不到 Euler receipt”推断可回 MC；只有完整可信证据证明提交尚未发生，才能走提交前取消。已提交后仅使用 Euler store、archive/source、Orchestrator、compaction 与 ledger，修复后用新的 assembly/epoch 继续。
5. 切换后的恢复点是 Euler 自己的 durable backup、event/bundle、archive/source 和 ledger 语义，不是 MC DB。canonical store 损坏按 Ticket 10 §27 的快照恢复与 `recovered_with_gap` 规则处理；未知或可能已发送的 attempt 不重发。若 Euler 无法恢复到可验证状态，保持 dispatch-blocked，要求建立新的 Euler session/epoch 或人工处理，不能恢复 MC 运行时。
6. cutover receipt 至少记录 `old_owner=mc`、`new_owner=euler`、project/session scope、绑定的 store identity、旧/新 hook identity、旧/新 context epoch 与 quiesce 边界；与 owner/epoch 同事务追加，不改写。提交后实际 assembly/attempt、canary 结果、失败、修复与暂停各自追加，并引用该 cutover receipt，不要求先存在尚未构造的 canary assembly 才能提交 owner。
7. MC 退出分两层：Euler cutover 完成后立即退出 MC 运行时依赖；MC 原库和扩展文件是否物理删除，另按 retention/privacy/owner 决策处理，不是 D7.4 的兼容前置条件。

### D7.5 Decision — capability- and host-scoped evidence

1. D7.5 不设跨能力总分，也不让平均召回、延迟或成本抵消单项安全/正确性失败。每个 `capability × host` 单独判定；Notes 与旧 Dreamer 不属于 v1 cutover，因此不创建迁移证据或假定通过。
2. 每项证据包必须绑定冻结的 workload/fixture 与 held-out digest、source snapshot、被测实现 Git commit、宿主/OS/user data root、provider route/model/auth namespace、配置与 feature flags、Core/adapter/schema 版本、assembly/payload hash、逐次 attempt receipt locator，以及独立 verifier 的复算结果。MC 结果只作为同输入 control 的连续性、延迟和成本对照；事实质量以原始 source、owner 标注和 held-out gold 为准，不以 MC 旧 memory 行相等为目标。
3. 以下是不可被统计指标抵消的 hard gate：错误 project/scope/owner 泄漏、未验证或 negative-transfer memory 激活、错误 source locator/hash、policy/capability/approval 绕过、receipt 与请求不一致、超预算、assistant/tool pairing 拆散、assembly/started barrier 违规、任何未经授权副作用，均要求 `0` 次；任一失败阻断对应 capability/host。声明支持的 exact/CJK gold 必须全部进入正确 candidate lane，canonical recheck、source recovery 和 mandatory context 必须正确；无强证据的同义查询必须为空或进入明确慢路径。
4. context unit 还必须证明：compartment 保留 mandatory decision/result/citation 且原文可按 locator/hash 恢复；同一 epoch 的 P0/P1 字节稳定；Euler 不修改 MC live request；unknown-sent 不自动重发；provider cache 开关不改变安全/正确性结论。memory lifecycle 还必须证明 provenance、scope、identity/time normalization、Verifier 状态和 head/event 转换正确，known-bad 不 active，未验证 proposal 获得行为权限为 `0`。
5. 量化报告至少按 lane 和 cold/warm/cache 条件分别给出 retrieval precision/recall/claim coverage、成功/失败与 evidence-gap 数、TTFT、总延迟 p50/p95/p99、输入/输出/cache tokens、费用、存储、projection backlog/lag 和失败率；provider 不提供 cache 指标时记为 `unsupported`，不得由时延反推命中。质量阈值由预先封存的 held-out/gold/known-bad 规则定义；延迟和成本的具体数值阈值必须在 canary 前从冻结 workload 的 MC control baseline 与预先批准的 Euler overhead budget 计算并封存。没有真实 baseline、封存质量规则或性能阈值未封存时只能 `evidence-gap`，不能 PASS。
6. MC control 与 Euler treatment 使用相同 raw input、相同 provider/model、相同 workload 顺序的配对运行，冷/热缓存分开，保存全部失败和首个可判定输出；性能数字不跨 provider、model、宿主或 cache 条件合并平均。质量回归按预注册 held-out/known-bad 规则判定，不能在看到结果后更换 case、阈值或统计口径。
7. cutover 顺序为：先完成 hard gate 与 control baseline，再封存具体阈值，随后执行单一 project/session canary；canary 的每项能力/宿主结果必须独立 PASS 后才扩大范围。任何 `inconclusive`、未解释高影响差异、阈值未支持或平台未验证都不能成为 cutover PASS：owner 提交前保留 shadow/disabled；提交后保持 Euler 故障隔离、禁止扩围，不回 MC。

### D8: Implementation phases and X-01~X-15 mapping

- [x] D8.1 Phase ordering: v1 实现分几个阶段、每个阶段的交付物和验收标准
- [x] D8.2 X-card mapping: Ticket 12 的 X-01~X-15 如何映射到实现阶段、哪些 X-card 是每阶段的门禁
- [x] D8.3 Platform gates: 三平台 CI 与目标平台真实宿主验收各覆盖哪些行为，何时允许该平台切换
- [x] D8.4 Unverified states: CI 或真实宿主证据缺失时，如何继续实现而不宣称已通过
- [x] D8.5 Fail-closed gates: 哪些故障/验证失败必须 fail-closed 阻止继续、哪些可以降级运行

### D8.1 Decision — five implementation phases

1. **P0 contracts and feasibility:** 固定首次切片的 app-id/数据根、Core/Host 路径、source carrier 与 durable ack、最小 intent/bootstrap API、head_event_id CAS、操作终态、Info 原子性、stream owner、started admission 线性化点及维护模式进程退出协议。产出可执行 synthetic schema/API/receipt fixtures；先验证 CLI 首轮归档、最后发送接点和维护独占三个高风险假设。前台/worker 预算固定字段与溢出/取消语义，使用有界可配置测试初值；DDL 在 disposable 阶段可调整，不先冻结最佳数值或生产迁移。Pi 探针可并行，但只约束 Pi 切片；MCP、overview/backfill、bundle、行为评估运行设施不进入首次 P0。
2. **P1 durable foundation:** 实现 identity/intent、memory revision/event/head、Host presentation/pending/Info、search outbox/lease、显式 owner 的 ledger、进程登记/维护 fence 和两道 durable barrier。X-01 是 X-03 与 X-06 的共同前置；X-03 验实际 search worker，X-06 验发送记账，两者无须互相串行。三项首次切片子门禁齐备前不开放上层写路径或真实 model dispatch；不等待可选 overview 文件/语义设施。Memory 操作采用 08 的 transition contract。
3. **P2 Core behavior:** FTS/CJK、任务级跨项目只读发现、Orchestrator/硬上下文与累计运行预算/source recovery、scope/注入 gate、低风险 memory capture/独立 verification/inert proposal、任务报告与项目交接、memory operations 与逻辑 purge、path/capability gate。验 X-02/04/05/07 和 X-09/13 Core 部分；缺 Host 实测不阻止实现 Host，但不能声称整卡通过。运行时安全/known-bad/inert-only 必须验；X-08 课程效果实验、行为 evaluation runner、scope review/backfill 不作为此阶段前置。
4. **P3 first Host:** 首接自研交互 CLI，验四个 Host 操作、真实批准、pending/receipt/Info 与重启恢复，按该模式的 `X-10 ∧ X-11` 联合放行。补齐 X-09/13 和 X-04/05/06 的真实接线、未知请求对账/封存正常路径，以及预算取消/迟到结果。Pi regular、RPC/JSON/print 之后按同样语义逐模式接线，未启用模式明确 unavailable，不要求一起交付或自研额外 UI 框架。
5. **P4 first-slice acceptance:** X-12 验实际 Windows 宿主的容量、backup、维护模式 purge、损坏/中断恢复；X-14 在 ledger/transport 及受控测试前置满足后即可测 provider/cache，与 X-12 可并行，不依赖 X-15。首次真实数据前，首次切片使用的全部路径须通过相应存储/Host/backup/purge/recovery 门禁并正式冻结 schema。D7 的 shadow/hard gate/control baseline/预注册阈值齐备后，才按单向 owner 提交与 canary 扩围；合成 provider 探针不等于真实数据许可。X-15 仅在 bundle 启用前完成，不阻塞本地首次切片。
6. 阶段是依赖 gate，不是禁止早期纵向合成探针的瀑布开发。共享 Core/portable 做三平台 CI，生产只声明实际宿主已验证范围。后续能力通过增量 schema、清除/恢复与自己的 Core/Host gate 后启用；未启用不预建空表，也不能把 deferred 记成 PASS。参数按观测调整，不扩大权限或削弱数据不变量。

### D8.2 Decision — X-card mapping and completion gates

沿用 Ticket 12 的实验定义、receipt 与三轴状态，不新增实验框架。以下 P0–P4 指实现阶段；进入下一阶段实施不等于前一阶段涉及的整卡、真实宿主或生产能力已通过。

| 实验 | 实施阶段 | 完整验收边界 |
|---|---|---|
| X-01 | P1 首项 | 首次切片的 canonical/intent/Host/ledger/outbox/fence schema、事务/FK/CAS/identity、完整 digest 与 inert proposal；不预建可选 artifact 或行为评估表。Portable 与实际数据根/权限分列。 |
| X-02 | P2 | P1 投影基座之上的 target FTS/CJK 检索、任务级只读发现与覆盖说明；课程检索结果不能替代。 |
| X-03 | P1，X-01 后 | 首次只验实际 search/FTS worker、lease、乱序/重复/崩溃、损坏重建和查询复算。Overview 后续子项验 SQLite body/refs/cursor 原子提交、历史保留与新 generation 重建，不验外部文件/pin/GC/同 hash repair。 |
| X-04 | P2；P3 接线复验 | Core admission、预算、ReAct 与 archive/source recovery；真实 Host dispatch 接线后复验相应边界。 |
| X-05 | P2；P3 补齐 | 首次验 12 的 Core/CLI 通用隔离组，实际 resource-owner/path 与 X-13 汇合；MCP binding/discovery 和 Pi loading 分别在相应能力启用前追加，不互为前置。共享不变量失败仍阻断所有受影响路径。 |
| X-06 | P1，X-01 后；P3 接线复验 | assembly/started barrier、admission 与撤销的并发顺序、杀点、unknown-sent 及显式对账/封存；不依赖 X-03。真实 transport 接线复验 payload/flush/dispatch/取消，mock 不升级物理证据。 |
| X-07 | P2；P3 source/装配复验 | Memory lifecycle、独立取源、冲突/时间、抑制/rollback、Info 与 inert proposal 无行为权限；任务报告/项目提案交接复用 source 和 proposal，按 X-04/07/12 验接续、恢复与清除。只依赖启用路径的 P1。Overview、跨 scope 关系和 backfill 为后续独立子项，行为评估执行不在 v1。 |
| X-08 | 独立课程票 | 课程效果实验运行前才封存其 owner pre-image/held-out；不阻塞首次 P0，不替代目标运行时安全/完整性。 |
| X-09 | P2 Core；P3 Host | P2 验证 CAS、batch 与逻辑 purge；P3 补真实模型 tool-call、originating input 重验和呈现闭环；物理副本 purge 归 P4 X-12。 |
| X-10 | P3 正常路径 | 首次交互 CLI、之后逐 adapter/mode 验呈现与批准；每个已启用模式必须联合 X-11 放行，不能因其他模式 deferred 降低本模式保证。 |
| X-11 | P3 故障恢复 | 按 12 的首次 CLI 必测组验证首轮 source、pending/commit/Info 和维护恢复；后续模式启用前追加各自 source/consumer/continuation 子项。与同一 adapter/mode 的 X-10 联合验收，不以 CLI PASS 代替后续模式。 |
| X-12 | P4 | 已启用路径的 ledger、archive/source、Host、projection、backup/恢复和所有受控副本维护 purge；先验退出/独占再删除，不要求在线 UI/cache quiesce。 |
| X-13 | P2 Core；P3 Host | P2 parser/policy 子门禁；P3 走实际 parse→normalize→policy→open 全链并核对 file ID，验证 `resource_identity@v1` 的 bounded decode、Unicode/case/UNC、symlink/junction、URL origin/redirect 和 `applies_to` wildcard 规则；目标宿主证据齐备后才开放对应文件/URL 能力。 |
| X-14 | P4；可早期受控测量 | 依赖 X-06/真实 transport 与相关 Core gate，不依赖 bundle；最终性能门槛结合 D7 baseline/预注册阈值判定。 |
| X-15 | Bundle 切片 | 启用前验 selector/完整闭包/导入重验/幂等/purge 排除与三平台 runner 往返；扩展的清除/恢复先有 X-12 证据，不是首次本地上线前置。 |

1. P0 准备首次切片可执行契约与 fixture 身份/判定规则，不宣称运行通过。X-02 以冻结的本地需求覆盖语料为必需基线，历史 60 用例可取得则追加，不把不可取得的外部套件设为开跑前置；替代/来源/覆盖差异明确登记，测试后不得换 gold 降门槛。X-08 在该独立实验前封存，X-10 在对应模式测试前固定摘要字段和 bytes 上限。缺制品如实报缺，但不虚构已有 receipt 或“最优”参数。
2. Core/portable、课程和 Host-dependent 结果分别判定。X-09/X-13 可在 P2 完成子门禁、P3 补齐实际闭环；不得要求 P2 整卡 PASS 才能实施其所依赖的 Host 接线，也不得凭子门禁开放证据未齐的生产能力。X-09 所需真实模型调用可在 barrier/安全前置满足的受控测试路径完成，不推迟到 X-14，也不以 mock 替代。
3. X-08 另票完成，不扩张生产 v1；P2 的 integrity、known-bad/negative-transfer 拒绝和 inert-only 门禁仍按 D7.5 取目标实现证据。任何课程 PASS 都不能关闭运行时门禁；任何 schema-only 检查也不能把 X-08 的完整效果实验标为 PASS。
4. P0/P1 不解除合成 DB 边界；首次真实 memory/ledger 须满足首次切片全部已启用路径的 Physical contract，包括 Host receipt、backup、维护 purge 与恢复，正式冻结初始 schema。后续未启用能力不阻塞，新增持久能力须前进迁移和增量验收。X-card 通过不自动授权 cutover，D7 唯一 context unit、shadow、owner 互斥与 durable epoch 不变；三平台 CI 不等于三平台生产支持。

### D8.5 Decision — global fail-closed and local degradation

1. **Global fail-closed:** canonical schema/invariant、append-only/CAS、数据库 durability/recovery、scope/project/owner 隔离、policy/capability/approval、path canonicalization、receipt/assembly/started barrier、预算不等式、assistant/tool pairing、unknown-sent recovery、provider serialization、privacy purge 后置条件或 live hook ownership 任一无法证明或发生违规时，停止受影响的写入和 model dispatch；若影响共享 invariant，则停止全部相关 dispatch，保留原始证据并暴露明确失败状态。
2. **Local block/degradation:** retrieval/index 不可用时返回空、`unavailable` 或 `evidence-gap`；projection/backlog/worker/Proposer/Verifier 失败时 canonical truth 不回滚，标记 `dirty/failed/pending/evidence-gap`；Host presentation/approval 不可用时关闭 mutation，仅保留允许的只读诊断；provider cache 指标不可用时不宣称命中；单一 provider/model 不可用时只在已批准且不改变语义的 adapter fallback 范围内返回明确不可用或重试结果。
3. 以下行为永远不属于降级：回退 MC、读取或激活未验证/冲突/过期 memory、静默扩大 project/scope、静默替换 provider/tool/server、盲目重发 `unknown-sent`、拆散 ReAct 配对、超预算发送，或以平均性能抵消任何安全/正确性硬门禁。
4. 平台证据未验证、fixture/receipt 缺失或出现 `inconclusive` 时，不得进入该 capability × host 的 canary/cutover；Euler 可继续 shadow 或已通过范围内的局部运行。任何 hard gate 失败不得通过修改 fixture、阈值或统计口径来“修复”。

### D8.3 Decision — layered CI and target-host gates

1. 平台证据分为两层。GitHub Actions 的 `windows`、`macos`、`ubuntu` runner 矩阵负责共享 Core、可自动化的 OS API/路径单元、SQLite/Node 组合和确定性故障 fixture 的持续回归；每个 job 保存 runner image、OS/version/arch、Node/SQLite、实现 commit、fixture digest 和结果 receipt。CI 证据可以关闭对应的 portable/CI gate，但不升级真实生产宿主状态。
2. 真实宿主只对依赖桌面/用户环境的行为设门禁：目标数据根和文件 identity、ACL/权限、symlink/junction/URL 最终解析、真实进程终止与恢复、真实 Host UI/approval/consumer、Pi/CLI adapter 和本地 backup/purge 语义。对应 X-10/X-11/X-12/X-13 以及声明平台的 Host-dependent 部分，必须取得该平台真实宿主 receipt；GitHub Actions 或其他平台不能替代。
3. 三个平台不作为所有能力的全局前置。共享 Core 的三平台 CI matrix 用于对应 portable gate 的验收，不要求先取得三台生产宿主才能开始实现；目标平台只有在其自身真实宿主高风险 gate、D7.5 基线/阈值与切换前证据通过后，才能按 D7.4 提交 owner 并开始该平台首次 canary；canary 通过后才能扩围。当前 v1 先以 Windows 为目标平台，Windows 真实宿主通过即可独立进入 Windows canary；macOS/Linux 的真实宿主 gate 不阻塞 Windows，但不能据此宣称 macOS/Linux 生产支持。
4. 若未来发布“三平台生产支持”，每个平台都必须补齐其声明支持范围内的真实宿主 gate；若未来启用行为自修改，仍遵守既定的 Windows/macOS/Linux 三个实际目标宿主安全与回滚 verifier 门槛。该发布/自修改门槛不回溯扩大当前 Windows-first v1。

### D8.4 Decision — unverified-platform handling

1. 本票尚未登记可复算的目标 runtime CI receipt，三平台 CI 均为 `unverified`；真实宿主仍分别记录为 Windows `待实测`、macOS/Linux `无宿主/未验证`。只有对应实现 commit、fixture 和 runner 环境的实际结果及 receipt 通过核验后，才可将对应 CI 项记为 `CI verified`；不能把“计划用 CI 验收”写成当前已通过，也不能据此升级真实宿主状态。
2. 无 macOS/Linux 真实宿主时，在实现阶段运行三平台 GitHub Actions matrix，完成共享 Core、可自动化 OS checks、课程 fixture、receipt schema 和 cross-platform build；这些结果写入独立 CI 字段。需要真实桌面、用户目录、权限、进程恢复或 Host consumer 的实验保持 `unverified`，不修改 fixture 冒充通过。
3. Windows 先完成其真实宿主 X-10/X-11/X-12/X-13 与 provider/adapter 切换前证据；按 D7.4 提交 Windows-only Euler owner 后执行 canary，通过后才扩大范围。macOS/Linux 后续取得宿主时，只补跑其 Host-dependent gate 和 D7.5 `capability × host` canary；不要求重复所有已由共享 Core 与 CI matrix 覆盖的 portable 证据；复用须匹配被测实现、fixture 和环境，变更影响的检查仍须重跑。
4. 未验证平台不阻塞共享实现或已验证平台的独立发布；跨平台生产支持声明、bundle 的真实宿主集成声明及该平台 cutover 必须有对应真实宿主 receipt。可依据实际 CI receipt 声明已验证的 portable/跨 runner 往返范围，但不得扩写成真实宿主 PASS；缺少对应证据时保持 `unverified`。

## Decisions — Background model policy

1. Euler 不设 provider/model 白名单，型号可由用户配置；配置只声明 route，凭据仍由宿主的 provider credential 机制管理。能力等级是推荐和风险门禁输入，不接受模型自报能力。
2. Proposer 推荐为标准级：支持结构化输出、来源约束、中文/CJK 与有界原文；基础级只允许明确 preference/decision 或其他确定性结构化事实。Historian 推荐为标准级加长上下文/忠实压缩：必须保留决策、结果、引用和适用边界，格式或来源校验失败不得落盘。Verifier 低风险可用标准级；跨 scope、高影响、安全/权限或高 salience 候选使用高保证级。高保证级必须再满足不同模型/provider/platform、真实工具、held-out/canary 或人工验证之一；fallback 不构成独立证据。
3. Proposer、Historian、Verifier 可以配置 primary 与 fallback；fallback 只处理暂时不可用、超时、限流、协议或结构化输出失败。`integrity FAIL`、语义 `block`、`evidence-gap` 和其他否定结论不得由 fallback 改成成功。低于推荐能力仍可运行，但结果只能停留在 `candidate/evidence-gap`，不得自动晋升。
4. 每次实际 proposal、compression、verification 调用都在 Host-owned `execution_events` 中追加不可变 attempt receipt。receipt 至少包含 10 §11 的 stream ID、owner_kind/owner ID/已批准 scope 与实际 role、job/operation ID、requested/actual provider/model、可得时的版本、fallback ordinal、config digest、prompt/schema/adapter version、输入/输出/tool-call hash、起止时间、usage/cache、错误和终态；缺失的远端版本记为 `unknown`。远端返回的 model/system/developer/tool metadata 只保存经过白名单、长度与 hash/调用链核验的观测字段，不能改变路由、权限或验证结论；receipt 不复制 prompt、source 正文或秘密。

## Decisions — Physical contract

1. 首次切片实际使用的表族、约束/CAS/head 重建、Host presentation/pending/receipt、outbox、backup/维护 purge 和恢复通过前，只用合成可删除库。P0 固定身份、接口、事务边界和失败语义；正常路径/故障 fixture 可推动 disposable DDL 调整，不编写原型兼容迁移。首次真实数据前才正式冻结 `migrations/001-initial.sql`、schema version、DDL SHA-256 与实现 commit；以后不改 `001`、只前进迁移，有恢复点，未知更高版本拒开。后续未启用能力不阻塞首次许可，也不因设计已存在就预建空表。
2. 首次最小 DDL 按 10 §7：identity/intent、memory revision/event/head、provenance/conflict/capture/verification/feedback/inert proposal、显式 owner 的 execution stream/event/reverse refs、search outbox/state/lease/FTS、Host presentations/pending、content-free purge receipts 与进程登记/维护 fence。不建行为 evaluation plan/attempt/result 表族。Scope review 启用前增加 SQLite 有界 body/typed input refs/cursor；不建外部 publish/pin/GC/repair 表。Raw-backfill 进度 schema 到该能力实施时定案。列/FK/索引按实际操作和查询收窄，逻辑 owner 不自动变成独立 package、服务或表族；无 embedding/通用图/registry/云同步。
3. `host_presentations` 与 `pending_operations` 是 Host-owned operation state：前者保存不可变 canonical snapshot/diff、presentation 顺序、token/payload digest 与 durable acknowledgement，也以不同类型记录 Info batch manifest/投递及显式 read ack；batch 唯一身份和 mutation event 真值仍来自 08 §27a，不能按卡片数量生成第二份批次。后者保存跨调用 pending/终态、expected revision/`head_event_id`/manifest 与 receipt 引用，并按 10 §23 保存已结算 purge 的最小 cleanup continuation；仅 `state='pending'` 是等待批准，清理状态不另占批准槽；`UNIQUE(session_id) WHERE state='pending'` 建在 pending 层。真实 memory mutation 的不可变 owner receipt 仍在同一事务追加到 `memory_events`，两张 Host 表不成为第二份 receipt 真值，也不写入 `execution_events`；execution ledger 只记录模型 attempt、assembly 与 context lifecycle。
4. Insight 本体仍是 verified canonical memory；scope_overview 是后续非权威 SQLite 派生正文，writer 为现有 worker、reader 为 Orchestrator，与 refs/generation/cursor 同事务提交。新生成版本用新 identity/hash，旧 assembly 所引用字节不能被新摘要替代；历史保留、失效和 purge 按 10。Wiki/insight/diagram 文件继续 deferred，不因 overview 存在而自动启用。

## Decisions — Background work wiring

1. 原始事件必须先同步写入 immutable archive；只有在完整 ReAct、明确 owner 决策/“记住”意图、compartment 边界或任务完成后，才创建 `capture_jobs`。确定性事实由代码提取，需要语义判断的内容才调用 Proposer。
2. candidate 先通过 integrity gate，再创建 `verification_runs`。Verifier 使用隔离上下文，只接收 Harness 固定的 claim、scope、owner、provenance，并自行执行 `source.search/expand`；结果限于 `pass`、`block`、`evidence-gap`，后两者不能由 fallback 改成成功。
3. Historian 只读取 immutable raw archive，在完整任务边界、可压缩前缀形成或 token 压力时运行。每段原文只生成一次稳定 compartment，记录 range、原文 hash、compartment hash、model attempt ID 和 locator；原文及正文由 session/archive owner 管理，数据库保存 locator、hash 与 metadata。Historian 失败只保留 raw history，不落残缺摘要。
4. 当 archive 与恢复入口已经就绪时，允许选择 fresh-window rollover 而不生成新的有损 summary；窗口切换必须写入 Host-owned lifecycle/ledger receipt，并由 Context Orchestrator 重建有界、可验证的 baseline。该路径不替代 raw archive、immutable compartment、source recovery 或唯一 prompt assembly。
5. canonical head 变化时，在同一事务中追加 `projection_jobs`。自动 active 更新同时按 08 §27a 固定 batch identity/有序成员并写 `kind=host-info` outbox；consumer 幂等补 Host manifest/unread/投递，失败不重做 activation。FTS 与 Info 使用不同 job type/幂等键，不能以 FTS 的 current-head 覆盖旧批次成员。FTS/projection worker 确定性读取 current head，以 revision/hash/generation 幂等更新；失败标记为 `dirty/failed`，不得静默返回旧索引并假装是最新结果。
6. Scope review 与 raw-backfill 是独立后续切片：先当前 project 的有界 SQLite overview，再按需求增加跨 scope/关系维护/历史覆盖；08/10 定义准入、cursor CAS、预算、历史证据与清除边界。未启用时不启动 worker，不影响 memory lifecycle 或单次 source recovery；没有全量分析能力就不宣称全部历史已处理。Wiki/insight/diagram 文件不生成。
7. worker 采用进程内 cooperative drain，不建 daemon、IPC 或通用任务框架；在宿主启动、canonical 写入后、`agent_end`/空闲期及显式 maintenance 时运行。每次只获取短租约、处理有界 batch 和 deadline；快速通道未完成时记录 pending/blocked，不阻塞主 Agent，也不伪装为 active。
8. 一次 lease 只执行一条 primary + fallback chain。仅超时、限流、暂时不可用、协议或结构化输出失败可有界重试；`integrity FAIL`、语义 `block`、`evidence-gap` 只有在 source 变化或显式 maintenance 后才能重新验证。`started` 无 `finished` receipt 时记为 `unknown`，先查询实际状态，不盲目重复执行；重复失败进入可观察 `blocked`。job 以 owner revision、输入 hash、generation 幂等，重启可接管过期 job lease 但不能重复 mutation 或 receipt，也不能据 lease 到期宣称旧进程已无外部写能力；purge 的终止证据按 10 §23a。后台 stream 按 10 §11 绑定实际 job/maintenance/migration owner，快照恢复 gap、来源 purge 和晚到结果均先对账或隔离，不借新 session 重发。

## Agreed compatibility constraints

以下是已确认的外部能力边界；D7/D8 的切换与验收条款共同约束其启用，不构成当前能力或实验已通过的声明：

1. External model context features are optional capabilities, not authority。provider、auth mode、feature gate、model capability 与 context strategy 在 session/epoch 启动时快照；中途换模型不得静默改变已承诺的上下文语义，切换必须产生新的明确 epoch/lifecycle event。
2. 每个 context window 保留稳定的 Euler `euler_context_window_id`（`first/previous/current`/ordinal）和 prefix baseline；provider-native window/continuation handle 若存在只作可选 opaque metadata，不是模型参数、Euler 权威恢复身份或 Agent/Harness Handoff。它们属于 Context Orchestrator/session execution metadata，不是 durable memory，也不授权模型自行改变 scope 或 lifecycle。
3. 独立记录 full-window hard cap、compaction trigger 和 fallback reserve。compaction threshold 不能替代模型硬上限；fallback reserve 仅在实际存在 fallback 时计入；任何超限仍执行 09 已定案的降级链。
4. 允许将 fresh-window rollover 作为可选路径：在 raw archive 和可验证恢复入口完备时，可以不生成新的有损 summary 而开启新窗口；窗口切换必须写入 Host-owned lifecycle/ledger receipt，并由 Orchestrator 重新构造有界、可验证的 baseline。它不替代 raw archive、immutable compartment、source recovery 或唯一 prompt assembly。
5. 可借鉴 bounded history/source recovery 的 opaque locator、limit/offset、scope 限制和输出截断；供应商 history/notes 不得自动进入 Euler canonical memory、source evidence 或 verifier 证据，完整 source 仍须通过 immutable locator/hash、scope/owner 和 stale/conflict gate。
6. 模型能力等级、reasoning effort 与多代理编排分开建模。Euler 继续允许任意 provider/model；能力等级只提供推荐或风险门禁输入，model catalog/自报能力不构成质量、权限或独立验证证据。
7. 上述外部能力默认关闭、可观测失败并可回退到 Euler 自有路径；没有资格、版本、完整性或恢复证据时不得静默启用或伪装为成功。

## Decisions — App identity and runtime topology

1. 产品名为 **Euler**，稳定 `app-id` 为小写 `euler`；它标识整个个人 Agent，而非仅 memory/context 子系统，也不绑定 Magic Context、Pi、`.pi` 或课程仓库名。
2. 每宿主、每 OS user 的数据根固定为 Windows `%LOCALAPPDATA%\euler\`、macOS `~/Library/Application Support/euler/`、Linux `${XDG_DATA_HOME:-~/.local/share}/euler/`；store/backup 与 owner 绑定的 instruction/source 目录分别管理，不为未启用文件投影创建 `projections/`，不得跨宿主共享 SQLite 文件。
3. v1 只有一份共享 TypeScript core implementation。Control Plane、Context Orchestrator、canonical store、memory lifecycle/gate、retrieval/source recovery gate、Host-owned execution ledger、capability/tool dispatch gate 与后台作业状态机封闭在 core；不让两个宿主各自复制这些不变量。
4. v1 不建 daemon、IPC 或网络控制面。Pi adapter 与 Euler CLI 在各自进程内直接加载 core；跨进程并发由 SQLite WAL、事务、CAS、短 job 租约及 10 §23a 的 durable owner fence/activity 协调；外部资源不因同库而自动获得事务原子性。
5. Pi adapter 复用 Pi 稳定 `Agent`/`AgentSession`、tool loop、session/source surface 与 受控 provider transport（按下节先关闭原生内容选择/额外发送路径）；Euler CLI 只复用 `@earendil-works/pi-ai` 的 provider/model 接口，自有 Agent loop 与 TUI。两者的 adapter 只做宿主事件/session/source/transport 转换及 14 的四个呈现操作，不直接写 canonical 表、不自行批准 mutation，也不复制预算或安全规则。
6. “跨 Harness API”不是 Pi 与 Euler CLI 互调的远程 API，而是两者共同调用的版本化进程内 TypeScript core interface；宿主差异通过 versioned `HostAdapter` interface 反向注入。SQLite schema 不是宿主 interface，宿主不得绕过 core 依赖私有表结构。
7. 目标源码冻结为独立私有 monorepo `qsgy-edge/euler`，Windows 主开发副本位于 `D:\GithubRepositories\Agent\euler`；Ticket 13 评审通过后才创建并按冻结清单迁移权威制品。其他宿主使用同一 Git 仓库的独立 checkout，Git 是源码真值，不同步工作目录。
8. 仓库初始设为 private；未来是否公开是独立决策，须先完成隐私扫描、文档脱敏与首个可运行版本，不影响 `app-id`。
9. monorepo 只设三个 workspace：`packages/core/`（`@euler/core`，共享 core，store 是其内部模块）、`packages/pi/`（`@euler/pi`，Pi adapter/extension）和 `apps/cli/`（`@euler/cli`，自研 Agent loop/TUI，提供 `euler` binary）。Ticket 12 的 `RUNTIME/store` 映射到 `packages/core/src/store/`，`RUNTIME/core` 映射到 `packages/core/src/`，`RUNTIME/host` 映射到 `packages/pi/` 与 `apps/cli/`。当前只有 core 使用 store，故不拆独立 store package；三个 package 初期均为 private，不承诺 npm 发布名称。

### Pi runtime ownership and startup contract

以下是 Pi 切片的接线路径，不是首次 CLI 的前置。先钉住该切片实际 Pi/Node/adapter 版本，用合成探针证明首轮 source ack、最终发送 gate 以及正常输入/维护退出，再决定支持哪些模式并接完整 Core/Host。探针失败先收窄该模式或记录不可行，不通过更多 wrapper 或全部禁用主流程假称支持；不表示当前安装已受控。

1. `packages/pi` 在受控 SDK bootstrap 中创建 Pi `Agent`/`AgentSession`，复用其 UI/tool loop/会话能力；使用 versioned ResourceLoader 的封闭输入，加载前只接受构建时已批准的 Euler adapter artifact、入口和依赖内容 hash。allowlist 初始只有该 adapter，不建用户维护的扩展市场或签名体系；不导入用户/项目自动发现的扩展、settings 中额外路径、CLI `-e` 或未批准 inline factory。`noExtensions` 只禁自动发现，`additionalExtensionPaths`/factory 仍可能加载；`extensionsOverride` 在加载后执行，不能当代码执行前的防线。必须在 import/factory 之前决定集合，再校验实际 loaded set/hook/tool owner 与预期一致；不合格就不创建 live runtime。loader/settings 在新建、resume/fork、cwd 切换和 reload 时仍使用同一封闭规则，旧实例停止 dispatch 后才能替换。
2. Core 提供完整 instruction、intent 与 context snapshot；默认 AGENTS/Skill/template 的自动注入必须禁用或由受控 loader 返回 Core 已选集合，不能再叠加一份。Pi auto-compaction 通过进程内 settings `compaction.enabled=false` 关闭；manual/overflow/tree summary 入口取消 Pi 原有生成，转由 Euler 已定 raw-only/fresh-window 路径处理。取消失败或出现非 Core summarization 请求由 transport 拒绝，不能默认 fallback 到 Pi。`context`/`before_agent_start` 仅为 Euler 宿主转换，`convertToLlm` 不拥有裁剪、摘要或改 scope 的权限；重放有旧 Pi compaction 时仍从合格 archive 重建，不把旧 summary 当唯一来源。
3. 最终发送由 adapter 掌握 `session.agent.streamFunction` 接点，调用受控 provider transport；在完成所有被允许的 wire conversion 后，直接执行最终 payload hash/预算、intent/owner/fence 检查与 started durable barrier，再发送。不能把可能吞异常的普通 extension hook 当唯一 gate。若采用 provider `onPayload`，P0 必须证明该具体 API/transport 上 callback 被 await、异常在网络前终止、没有后续改写；否则选择已可兑现的受控 transport 或标 unavailable。Pi 原生 agent retry 与 provider/SDK 隐式 retry 在此运行路径禁用，合法重试由 Core 发起并逐次计 attempt；任何实际 HTTP/WebSocket 重发不能绕过同一屏障。finished/error 仍由真实 transport 结算，unknown-sent 不盲重发。
4. Pi 内建模型工具以 `noTools: "builtin"` 禁用，实际暴露的 Core/Host/MCP 工具都用受控 wrapper 进入 Core admission/execute gate；`tool_call` hook 可作辅助，不能代替 wrapper 内参数/权限重验。直接命令、`!`/`!!`、RPC shell/export/share、session navigation 等可产生副作用的非模型入口同样经过该边界；没有相应 interposition 的入口显式 unavailable，不保留原生直通。allowlist 不是同进程沙箱：批准的 Pi runtime/adapter 是可信计算边界，模型、第三方 MCP/输出和可选代码不在其中；已取得同 OS user 的恶意代码替换仍按既有威胁模型，不宣称哈希能抵抗它。
5. 每次 runtime 绑定和 dispatch 前验证 loaded extension/hook 集合、Core wrapper 工具集合、原生 compaction/retry 设置及最终 transport owner，记录实际 runtime/adapter/build/config/load-set digest 到 lifecycle/assembly/attempt。新版本、意外 handler、设置漂移或未知接口状态停止受影响 dispatch，不能让禁用失效变成普通日志。TUI/RPC/JSON/print 各模式分别验证；API 尚无证据的路径保持 unavailable，不在本次选新 TUI、fork Pi 或改安装包。

接点证据（只读源码事实，不是 Euler PASS）：本机 Pi `0.85.1` 的 `docs/sdk.md`/`docs/extensions.md`/`docs/compaction.md` 及 SDK 的 `06-extensions.ts`、`10-settings.ts` 示例分别说明 loader、工具集合、compaction settings 和取消入口；`dist/core/sdk.js:145-239` 链接 transformContext→convertToLlm→streamFn/onPayload，`dist/core/extensions/runner.js:820-850` 会捕获 `before_provider_request` 异常后继续返回 payload，故仅在该 hook 抛错不足以禁发；`dist/core/resource-loader.js:312-329` 在 load 后才应用 override。目标版本必须重新以实际 bytes/异常/dispatch counter 核验，14 的 0.84.4 历史呈现事实不自动升级为 0.85.1 或目标实现证据。

### Source/archive contract on HostAdapter

首次 P0 在 versioned `HostAdapter` 内落实 CLI 的实际 source carrier/root、API 与下列契约；Pi 在自己的切片接线前另验，不阻塞 CLI。只有接口草图或 entry ID 不算可兑现：要有 synthetic 首轮 append/read/重启正常与失败探针。复用各 source owner 的载体，不另建通用 source registry；raw 全量枚举设施仅在 backfill 切片启用前加入。

1. **绑定与身份：** 每个 source/archive 绑定真实 owner、host/session、logical scope、受控 root 与 immutable locator/version/hash；调用者不能自报更高 scope 或切换 owner。仓库文件、外部 source 仍归原 owner，Core 只持验证后的引用及 gate。
2. **append 与恢复确认：** 原始事件先由 owner 按稳定 event identity/hash 追加并 durable flush，返回可重启后复读的 locator/hash/commit acknowledgement；在 Core handoff ack 前 source owner 以 pending retention fence 保留正文、逐项 inventory 和 source_event_id，Core 可按不可变 identity 重放，不只依赖可变 cursor 高水位。相同 identity+bytes 重放幂等，identity 相同而内容不同即 integrity failure；unknown 先按 identity 查询，不能当成功或重复追加。未取得 durable acknowledgement 时，不创建 dependent capture job、不卸载原文、不通过依赖该输入的模型 dispatch。Pi 首轮未 flush 的内存 session entry 不能满足该条件；若当前 adapter 不能提供合格持久载体，显式 unavailable，不能靠发出首个模型请求来绕过前置。
3. **read/expand：** 请求携带 locator、scope 和有界 offset/limit；返回原始版本与总范围/截断信息，并能对恢复 bytes 校验 hash。失配、越权、缺失、已清除或 stale 均明确报缺，不以当前版本或摘要替代。Archive 已持久而 canonical capture job 尚未提交时重启，可按原 event identity 补 job；反向存在 job 却无 archive ack 时阻断，不制造原文。
4. **retention/purge：** 每个 owner 说明受控根与不可控残留，支持 10 §23a 的启动 admission、进程登记/维护退出与结构化 manifest，实际 identity 重验、幂等删除及 durable ack；首版不要求在线细粒度 quiesce。仅有读取权限的 source 不假称删除；已承诺受控者失联仍 blocked。清除中的内容禁止恢复/再捕获，缺 ack 不签完成；接口/root/identity 变化使旧绑定失效或重验，不静默扩权。

### Pi P0 public-API probe boundary

以下是历史 Pi `0.85.1` 源码推导的候选接线，不是当前安装保证。这里的 Pi P0 指 Pi 切片自己的可行性探针，可并行探索但不阻塞首次 CLI；实际版本/bytes 必须重新绑定。先证首轮 ack、最终发送及正常输入/维护退出，再冻结该模式接口；依赖完整消费者/物理恢复的结果仍按 X-card 分层。公开字段或一次成功回调不是全链 PASS。

1. **同一 Pi carrier 的首轮 ack：** 在 Core 已登记 owner/root activity、live AgentSession 尚未创建时，排他准备新的正常 Pi JSONL，并通过公开 `SessionManager.open` 初始化；已存在的空文件会写合法 header，使后续无 assistant 的 append 也实际写文件。也可先持久保存公开 `getHeader()` 取得的原生 header 再 open，以保留已选 session id。空文件重新初始化会生成新 id，不能拿它恢复已绑定但意外丢失/变空的 session；非空分支必须保留完整 header/entries，不能只播种 header 丢掉已有事件。SDK 初始化会追加 model/thinking 等 metadata，所以持久载体准备与公开 append 包装须先完成。HostAdapter 对同一实际 file identity 在 append 后 fsync、严格复读 event bytes/hash，再签 source ack；公开同步 `append*` 仍返回原同步结果，不能改成无人 await 的 Promise。Pi 的 `flushed`、内存 leaf/entry 或 `message_end` 通知都不是 ack。P0 冻结 stable raw-event identity/domain 与 native entry 的映射、去重及恢复格式；可复用同一文件的原生 custom entry，不伪造 assistant、不新增 source owner/表族或调用私有持久化方法。unknown 按原始文件严格查询同 identity/bytes，不盲重写，不只查当前 branch 或信任会跳过坏行的原生 loader。new/resume/fork/reload 每次重新绑定都重验受控根、实际文件、完整事件序列与 fsync；resume 缺失/损坏不被当成合法新建，factory 之前发生的 open/复制也须先有外层 admission。X-04/X-11 验正常首轮、幂等、未知/部分写与重绑；文件/目录 durability 和 file identity 按真实宿主记录，不把仅重启复读升级为断电证明。Host presentation/approval 的权威仍是 14 的 Host-owned 记录。
2. **保留原 Pi 界面的输入接线：** P0 以 Pi 自带 `regular` 界面冻结公开接点和 synthetic 探针；完整 Euler 呈现/批准主流程仍在 P3 按 X-10/X-11 联合验收。受控实现公开 `EditorComponent`，保存 Pi 在 factory 后赋入的 `onSubmit` callback，经 Core gate 后才委托；只在 factory 中一次赋值会被覆盖。adapter 持有自己创建的实例，在公开 app action Map/特殊 callback 完成复制后包装实际动作，或以前置 `handleInput` 分发。异步 gate 先消费并冻结展开后的文本/action/runtime identity，再自行跟踪完成；不能假定 void callback 会被 Pi await。Alt+Enter、paste/autocomplete、图像临时文件、外部 editor、selector 内实际选择/删除/rename 均各有前置 gate；可受控组合 SDK 已有 selector 的公开 callback，不只守打开 selector。`/share` 必须在进入原生副作用链前接 Core 或 unavailable，单包 export 不够。公开 session/runtime factory/rebind 及对象 wrapper 只转入同一 Core，保留 receiver、同步/异步返回和错误语义；startup/reload/new/resume/fork 替换期间保持 admission 关闭，复核所有绑定后才开放，失败不得恢复直通默认 editor。RPC 的 steer/follow-up/bash/export 和 JSON/print initial prompt、extension command 另验，不能继承 TUI 输入探针的 PASS。fullscreen viewport 可早于后加的 raw input hook 消费鼠标并打开链接/复制；未取得更早控制证据时不开放这些附加路径，切换到未验证模式也须在实际切换前拒绝，仅拦 settings 写入不够。不使用 private mode patch、新 TUI 或通用黑名单框架；未接入附加能力须真正 unavailable，不能用全部禁用 Euler 主流程冒充 14 的 full。
3. **维护退出：** Pi 切片从首次读取 source 前登记实际 runtime process/root/epoch，source append 和 transport 重验 fence。Purge 只由独立维护入口在旧 Pi 进程及受控子任务真实退出、残留核验和独占取得后执行；无需证明运行中每个 UI/history/undo 缓存已被逐项清空。agent_end/idle/dispose/窗口消失/lease 超时不等于退出，不在被 await 的 handler 中等待同一 run 自锁。X-12 验仍活跃进程、迟到 append/子任务及正常退出对照；旧进程未停时不得逻辑删除，重启不能恢复已 purge 的 source/pending/cache。在线 quiesce 将来有需求再单独验收。

## Decisions — Prompt/cache ownership and ordering

1. Context Orchestrator 唯一实现于共享 core 的 `packages/core/src/context/`，独占最终 prompt assembly、context admission、预算检查、P0–P3 排布、降级链、fresh-window/compartment 选择和 assembly receipt。
2. Orchestrator 消费 Control Plane 的 intent、合格检索候选、已准备 compartment、Source Recovery 结果与当前 turn，输出有界 assembly plan、budget report 和不可变 receipt；Pi adapter、Euler CLI、MC adapter 只执行宿主事件转换与 transport，不各自裁剪或重组最终 prompt。
3. Memory Retriever、Source Recovery、Session Virtualizer 等逻辑职责只返回候选材料，不能直接拼装最终 prompt。Orchestrator 不负责 memory 晋升、Verifier 判定、source 所有权、Host UI 批准或模型权限变更。
4. 迁移期采用互斥 live hook 模式：`mc-active` 下 MC 保持 context hook、compaction 与相关注入的唯一线上权威，Euler 只从 immutable archive 做 shadow/read-only，不修改 outgoing prompt、cache key 或 MC 状态；`euler-active` 下 MC context handler 必须未加载或已由已验证的宿主能力卸载，唯一 hook 调用 core Orchestrator。不能把 MC 与 Euler 串成两级裁剪器，也不能仅以关闭 native compaction 证明 MC 已退出。hook owner 的权威是 D7.4 的 durable owner/epoch/lifecycle，宿主启动配置只执行该选择，不能覆盖它；无法证明旧 handler 已卸载、检测到双 owner 或 handoff 不确定时，session fail-closed，不发送模型请求。若无可靠 unsubscribe，切换先 quiesce，再重启 session/process；若提交前门禁失败，在证明未提交和互斥后可保持或重启 MC；owner 提交后不支持切回 MC。
5. `pi-cache-optimizer` 不是 Euler Core 依赖或 prompt owner；`mc-active` 可保留既有行为。`euler-active` 按上文 allowlist 不加载它或其他第三方 extension；所需只读 cache 观测经 Euler transport 既有指标获得，不复制扩展实现。将来若新增辅助代码，须单独批准并验证集成后才能改变加载集合；`prompt_cache_key`、retention、session-affinity 等仍服从 Euler epoch，不覆盖 assembly/receipt。
6. Provider request serialization：Core 先冻结 provider-neutral assembly；adapter 只把它转换为具体 provider API 的 role、tool schema、编码与必要 transport 字段，不得增删、重排或语义改写已选内容。所有允许的转换完成后，adapter 记录 canonical encoding、payload hash 与版本，Host 再 append+flush `model/request-attempt-started`，之后才调用网络；任何后续 payload 替换都 fail-closed。相同 assembly/bytes/route/model/epoch 的重发只增加 attempt ordinal，任一语义、顺序、预算、route/model 或 epoch 变化都创建新的 assembly ID；若 Pi 无法在最后可变 hook 后建立 barrier，则使用受控 transport 或禁止发送。
7. Cache epoch 是 Euler 自己的逻辑缓存失效代际，独立于 `euler_context_window_id`、`assembly_id`、`attempt_id` 和可选的 `provider_context_handle`；后者不是模型参数或权威恢复依据。仅改变 P3 current-turn、追加正常 P2 轨迹、同一完整 payload 重试、provider cache TTL 到期/cache miss，或生成但尚未选入 baseline 的 compartment，保持同一 epoch。P0/P1 bytes、已选 compartment/pinned memory、policy/AGENTS/skill/tool schema、tokenizer/estimator/context strategy 或缓存命名空间变化，必须在下一次 dispatch 前开启新 epoch；provider/route/model/auth namespace 变化默认开启新 epoch。正常 compaction 只在完整 ReAct/任务边界、immutable compartment 已提交并被选入新 baseline 后切换；压缩失败不产生半成品 epoch。fresh window 必须生成新的 Euler window ID，只有在 P0/P1 bytes 与缓存命名空间可证明完全相同且 provider contract 允许时才可沿用 epoch，否则创建新 epoch。安全、权限、scope、policy 或已确认 supersession 等 emergency 立即使旧 epoch 对后续 dispatch 失效，先持久化 invalidation/lifecycle event；持久化或新 assembly barrier 失败时禁止发送。provider TTL、hit/miss 和 opaque handle 只作 transport/diagnostic metadata，adapter 不得用它们改写 Euler 的 archive、assembly、epoch 或 receipt。

## Decisions — Injection contract

1. 指令作用域分为三层逻辑归属：Global、Workspace、Project。Resource/path 是 Project 内的局部适用范围，不是第四个 scope，也不改变 project identity。Global 对所有 Euler 工作生效；Workspace 是可选的稳定项目组；Project 是独立的逻辑项目身份，均不由 cwd、Git root 或目录名自动推断。
2. Workspace 是持久化的逻辑实体，不是项目父目录。`workspaces` 与 `workspace_projects` 保存显式成员关系；一个 project v1 最多属于一个 workspace。workspace AGENTS 存在 Euler data root 的 `agent/workspaces/<workspace-id>/AGENTS.md`，因此不同磁盘路径下的成员项目可以共享同一份 workspace guidance。没有明确的 `active_project_set` 时，不自动加载 workspace 或 project AGENTS。
3. Euler user-global AGENTS 位于 `<euler-data-root>/agent/AGENTS.md`；Project AGENTS 由 project owner 管理，默认位于项目 resource root 的 `AGENTS.md`。目标资源路径下的更深层 `AGENTS.md` 只对该 Project 的对应子树适用。v1 只默认支持 `AGENTS.md`，不引入 `CLAUDE.md`、`.local` 或 `.override` 候选。
4. Context Control Plane 先依据 active intent/task、真实 resource owner、manifest 与已注册 workspace membership 解析 `active_project_set`，再按以下顺序形成 instruction snapshot：Global AGENTS → 每个适用 Workspace AGENTS → 各 active Project AGENTS → 目标 resource path 的祖先 AGENTS。workspace 文件按 workspace identity 去重；不同 project/workspace 的规则保留来源标签，不互相静默覆盖。跨项目操作任务只加入证据已验证的项目；任务级只读发现按 09 单独验证读取范围，不扩展此 guidance 集合；`affected_project_ids` 单独存在时不扩大 active set。
5. 目录祖先链只解决 Project→Resource 的局部规则，不能用共同父目录推断 Workspace，也不能把一个 project 的 AGENTS 传播给同 workspace 的其他 project。针对即将读取、写入或编辑的 resource，Host 必须在 dispatch/副作用前解析完整目标路径链；无法确定 project、workspace membership 或适用规则时，受影响操作 fail-closed。解析当前 cwd 不能替代解析实际目标 resource。
6. Core 内置安全规则和 active policy artifact 进入 P0 的受保护 policy channel；Global/Workspace/Project AGENTS 进入独立 guidance channel。两者都带 owner、scope、locator、版本与 content hash，形成不可变 instruction snapshot；AGENTS 不能覆盖 policy、capability、credential、scope、审批或 direct user instruction。memory、source、tool result、provider metadata 和模型输出不能激活或修改任一指令层。
7. 每次 session、context window、目标 resource 或 dispatch 前，Host/Control Plane 重新确认适用关系与文件版本；hash、membership、policy 或 AGENTS 内容变化创建新的 instruction snapshot、assembly 和 cache epoch，不在正在发送的 request 中途热改写。watcher 或 touch 只能作提示，不能替代 dispatch 前确认；不存在的可选文件是正常状态，已确认应生效但不可读、scope 不明、内容完整性无法确认或预算无法容纳的规则不得静默忽略。
8. AGENTS 冲突先按实际适用范围与指令类型区分。对于同一目标、同一规则的普通 guidance，采用 Global → Workspace → Project → Resource 中最具体的适用范围，更宽层的其他规则继续有效；当前用户明确指令优先于普通 guidance。该局部优先规则不改变 05 的主张类型/owner 权威边界，也不用于 memory/source 的真值裁决。AGENTS 与 Core 安全规则、active policy、capability、credential、scope 或审批要求冲突时，不得凭目录深度或普通 guidance 裁决放宽，受影响操作阻断。
9. 不同 active project/workspace 的 guidance 保留来源与目标标签，不按加载顺序相互覆盖。不同资源分别使用 pnpm/npm 等规则可拆分操作各自遵守，不构成必须二选一的冲突；规则同时约束同一操作且无法同时满足，或其适用范围/指令类型无法确定时，暴露 `instruction-conflict`，列出冲突原文、owner/scope、locator/version/hash 与受影响操作。未解决前停止相关写入、执行、网络等副作用，要求 owner 明确选择；现有 policy/capability 允许的只读澄清可以继续。workspace membership 不确定仍按第 5 项阻断受影响操作。
10. v1 不实现任意自然语言 AGENTS 的完整规则解析器或额外 LLM 裁决器，也不承诺穷尽检测所有语义冲突；主 Agent 可以报告疑似冲突，但不能将自己的判断当作权限豁免或解除冲突的 owner 批准。Control Plane 独立执行模型外 policy/capability 检查。owner 对普通 guidance 的明确裁决绑定当前冲突文件版本与适用范围；继续前生成新的 instruction snapshot、assembly 和 cache epoch，不回写正在发送的 request 或旧 receipt，也不自动修改 AGENTS。持久规则修改仍由原 owner 发布，所有最终内容由唯一 Context Orchestrator 组装并纳入 assembly receipt。

### Skill discovery and runtime status

1. 完整 Skill 元数据目录保留在模型上下文之外，先按 Global/Workspace/Project、当前 `active_project_set`、批准与启用状态过滤，再由 Orchestrator 按实际 token 预算提供候选。目录较小时可完整展示元数据，较大时只展示有界候选；不因技能数量多就阻断整个任务，也不把部分目录冒充完整目录。发现候选不等于启用技能，更不等于执行其脚本。
2. 未展示的合格技能仍可通过受控、只读、有界的发现入口补查，支持继续查询或分页；入口本身不能藏在待发现技能里。显式技能引用走精确定位，不受推荐排序挤出，但仍须核对 owner、scope、启用状态与版本。搜索失败不得伪装成没有技能，搜索命中不得授予权限或自动安装、发布技能。`skill.search` 是固定 Core schema，具体字段与有界分页按 D6.4 执行；不为本题另建路由 LLM、向量库或统一 Skill/tool 管理框架。
3. Core 必须维护真实任务、scope、已启用技能内容身份与实际可调用工具等状态；09 已定案的最小 intent、当前所需指令和调用契约仍须保留。完整状态栏不列为 v1 必做项，不新增独立状态管理器；只复用 P3 runtime status 表达影响下一步决策、且其他上下文未清楚表达的必要状态，如目录仅部分可见或发现失败。计数、加载列表等汇总可选，不要求重复已清楚展示的信息；状态提示从实际记录与装配结果派生，不能以模型自述代替真实状态，也不能成为权限或批准证明。
4. 稳定的发现说明与核心工具 schema 由 Orchestrator 放入 P0，随任务变化的候选视图和必要状态提示进入有界动态区域；真实搜索调用与结果仍按 P2 的完整 ReAct 配对记录，不为更新状态提示而回写旧工具结果。候选与普通状态数据变化不要求重写 P0/P1；生效指令、工具契约或权限变化仍按 D5.5 与对应的 D6 决策处理。已启用技能所需的准确正文不能被一条“已加载”状态替代；完整指令的落点、退出、压缩与换窗恢复见下文 D6.3。
5. 少量运行必需的核心工具采用固定常驻 schema，大量可选工具/MCP 工具可按需发现；工具名或状态提示不能替代准确调用契约，实际调用仍由 Core 校验 schema、scope、capability、审批与 receipt。固定 Core schema 已按 D6.4 定案；MCP/动态可选工具的接线按 D6.5；宿主能力仍由 HostAdapter 提供，不因本节改变 D5.4 的最终请求冻结边界。
6. 同名 Skill 默认采用确定性解析，模型继续按任务选择能力，不在普通路径反复比较所有同名实现。先完成 owner/scope、信任与启用门禁；同一 owner、同一规范资源的重复发现先去重，不把路径别名当成多个技能，也不因正文相同合并不同 owner 或 scope 的授权。对同一目标 project，默认 `Project > Workspace > Global`；同一 scope 按固定来源顺序选择，并记录被遮蔽来源，不依赖文件系统枚举顺序。该优先级只解析默认名称，不提升权限或信任、不删除文件、不拼接同名正文。明确指定其他合格来源/版本时，沿用已有 location/精确引用直接绑定，不被默认规则改绑，仍须核对 scope、权限与版本；保留被遮蔽来源的定位信息，不新增别名管理系统。跨项目分别解析，A 项目的实现不能覆盖 B 项目；选定版本后失败不得静默换成同名替代品。
7. D6.2 仅要求内容识别与加载一致性，不内置独立的 Skill 版本/更新管理器。加载选定且获准来源时重新确认实际内容；目录或搜索所示内容已变化时，刷新并重新解析，不将新正文冒充选定的旧内容，也不静默换成其他同名技能。实际注入正文复用既有 instruction snapshot/archive 保存，receipt 只引用 locator/hash；已冻结的 assembly、已发送请求与旧记录不可原地改写。生效指令内容变化按 D5.4/D5.5 生成新的 snapshot、assembly 和 cache epoch；已激活技能的刷新时机及换窗恢复按下文 D6.3 执行。
8. 本节中的“版本”只指实际内容身份或外部已有的版本/ref，不要求 Skill 专属版本表、历史包副本、依赖锁、逐版本审批流程或升级/回滚状态机。远端检查、下载、安装、更新与文件回退由 Git、既有安装工具或 owner 维护，v1 不内置自动更新，也不承诺整个技能包及运行环境的历史恢复。hash 是内容指纹，不是版本库或安全批准；`SKILL.md` hash 只覆盖入口，不能替代 references、脚本等实际资源使用时的来源、完整性及权限检查。上述简化不改变既有来源信任、权限、owner 发布责任或 08 的自进化门禁；未来若实际需要由 Euler 分发、原子升级或自动回滚技能包，再单独评估并优先复用已有包管理能力。
9. Skill catalog 的默认来源遵循三层逻辑 scope：Global 使用 `<euler-data-root>/agent/skills/`，并支持用户共享的 `~/.agents/skills/`；Workspace 使用 `<euler-data-root>/agent/workspaces/<workspace-id>/skills/`；Project 使用已绑定项目 resource root 下的 `.agents/skills/`。Workspace 通过 membership 生效，不通过父目录推断；允许 owner 显式绑定已有技能目录，不要求复制文件，也不扫描其他项目或宿主的任意技能目录。默认来源在同一 scope 内使用固定顺序：Euler 原生来源先于共享来源；显式绑定来源追加在默认来源之后，并使用 owner 注册时的稳定顺序，不依赖文件系统枚举顺序。默认名称解析仍先按 Project > Workspace > Global，且先通过 owner、scope、信任与启用门禁。
10. 技能文件直接遵循 Agent Skills 规范：每个技能目录至少包含带 YAML frontmatter 的 `SKILL.md`，`name` 与 `description` 是标准必填字段，标准可选字段按规范处理；Euler 不要求作者添加 Euler 专用 frontmatter。模型目录视图提供 `name`、`description`、适用目标标签和精确 `skill_ref`；Core 在文件之外维护 owner、scope、规范 locator、内容 hash、启用状态与遮蔽诊断。`skill_ref` 是由 scope、来源 locator、技能入口 locator 与内容 hash 组成的内部结构化引用，可作为稳定 opaque token 传递；它不是供用户维护的别名，也不授予额外权限；标准 `allowed-tools` 声明不能替代 Core 的 capability、审批和实际调用检查。
11. D6.2 至此定案：完整 metadata catalog 在上下文外维护，小目录完整展示、大目录有界展示并通过只读发现补查；选定后完整正文的注入、缓存、退出与换窗恢复归 D6.3，核心工具 schema 已由 D6.4 定案，MCP 工具契约已由 D6.5 定案，搜索实现与规模测试归 D8。不扩展到技能市场、自动安装发布或行为自修改系统。

### Full skill instructions lifecycle

1. Skill 只有在用户明确指定，或模型依据合格 catalog 提出选择后，才由 Core 验证 `skill_ref` 并在下一次模型请求前加载完整 `SKILL.md`。激活绑定记录 task/intent snapshot、project/workspace、activation reason、source locator 与 content hash；当前请求已经开始后不得临时插入正文。
2. 同一 task、同一 scope 且来源与 hash 未变化时，复用已验证的 instruction snapshot，不反复读取来源或重新选择；每次模型请求仍按需要包含准确 P0 Skill guidance 字节，provider prefix cache 可降低重复输入成本。任务转换由既有 Intent Manager/Alignment Gate 及 task/intent 状态确认，不另建 Skill 专用任务分类器。只有确认任务边界，或 project/workspace/resource 变化导致原绑定不再适用时，旧 task binding 才在下一次 assembly 释放并重新解析；同一任务内换文件但仍在适用范围内，或一轮暂时未调用该 Skill，均不触发释放。
3. 完整 `SKILL.md` 原样进入独立的 P0 Skill guidance block；物理位置不改变权威，Core policy、capability、credential、scope、approval 与当前用户明确意图不能被 Skill 覆盖。正文不得被模型重写、有损压缩或静默截断；超出预算时该 Skill 不激活，标记 `skill-unavailable`，不能加载半份指令。P3 状态提示不能替代正文。
4. `references/` 等辅助文本只在本轮明确需要时读取，并以自己的 locator/hash 绑定当前 assembly；不自动把整个技能包装入上下文。`scripts/` 与 `assets/` 不因 Skill 激活而自动执行或获得权限，实际使用仍须通过 Core 的 capability、参数、scope、审批与 receipt 检查。
5. active Skill 集合、顺序、正文 hash 与已加载辅助资源身份属于 instruction snapshot。集合、顺序或内容变化生成新的 snapshot、assembly 与 cache epoch；已发送 request 与旧 receipt 不回写。v1 不新增 Skill 版本表、整包历史、自动更新或回滚管理器，已失效或被替代的 snapshot 仅用于审计/重放，不能在当前来源已变化时冒充新内容。
6. 新 context window 建立时，active Skill 不靠“已加载”状态栏恢复；Core 重新验证选定的 `skill_ref`、scope、启用状态和 hash，并将准确正文重新装入新 assembly。若相同字节与 cache namespace 可证明，允许沿用 cache epoch；无法读取、hash 不符、owner 撤销或 scope 失效时标记 `stale`/`skill-unavailable`，不得静默换成同名技能。
7. 明确任务结束、用户停用、scope/信任/权限失效或 owner 撤销时，Skill 只从下一次 assembly 移除，不改写已发送请求。没有明确任务转换时不依赖时间、轮数或模型自述自动卸载；新任务的能力选择仍通过 D6.2 catalog 和 Core 门禁完成。多个已选 Skill 对同一副作用发生无法同时满足的直接冲突时，暴露 `skill-conflict` 并停止相关副作用，不增加额外 LLM 裁决器。

### Optional handoff workflows

Euler 提供 [10 的持久任务产物与项目交接能力](10-choose-storage-projections.md#analysis-handoff-artifacts)，具体总结、计划、交接模板及后续技能选择由用户选用的工作流负责；没有 Matt 或其他 handoff Skill 时，归档、项目内发现、读取和 Markdown 导出仍可完成。

- handoff Skill 产出的临时文件可经既有受控文件/source 接口归档明确选中的正文，固定真实来源、项目交付范围与 hash，取得 durable ack 后才算保存；不扫描整个临时目录，也不只持久保存可能被清理的路径。原技能的临时输出约定无需改写，不新增专属 importer、插件协议或工作流引擎。
- 交接文档只作为 source；有明确 target/evaluation 的改动建议才形成 inert proposal。`suggested skills` 或正文内命令属于建议数据，不能自动激活 Skill 或授权脚本。若选用技能声明 `disable-model-invocation: true` 等显式调用限制，保留该约定；不能因交接入口而自动调用、安装或改写技能。技能缺失时使用基础交接能力，不虚称已执行技能。
- 采用通用合成 Markdown 作为必需验收，另可用用户已选 handoff 技能作接入样例；共享 Core 与首次 CLI 的 PASS 不依赖任何个人已安装技能。接手者仍按当前 intent、项目权限、准确技能版本和代码现状决定后续操作。

### Core tool schemas

1. v1 的固定 Core 模型工具为：`skill.search`、`memory.search`、`source.search`、`source.expand`、`memory.inspect`、`memory.preview`、`memory.commit`、`memory.cancel`。这些工具的模型可见接口属于本节；memory、retrieval、source recovery 与 mutation 的业务语义仍由 07–11、14 的对应 owner contract 拥有。固定 schema 始终由 Core 提供；后端或宿主能力不可用时，调用返回明确的 `unavailable`，不能把不可用伪装成 owner 拒绝或静默改变工具集合。`skill.search` 只返回 D6.2 的有界 metadata，不加载正文、不安装、不发布；`memory.search` 与 `source.search/expand` 默认受 active project/workspace、scope、owner、provenance、hash 与有界结果门禁约束；显式跨项目分析按 [09 的任务级只读发现契约](09-assemble-context-safely.md#cross-project-discovery) 使用 Core 验证的读取范围，不扩大操作/guidance 的 active project set。工具参数只能请求该模式或缩小已授权目标，模型不能自报授权。任务资料由 source/proposal owner 提供带种类/状态的 source 发现单元，不为提案另开 memory 写入后门。
2. `memory.inspect/preview/commit/cancel` 是唯一的 v1 memory operation 模型表面。不存在通用 `memory.write/delete/update/set`；变更必须走 `inspect → preview → owner approval → commit`。Ticket 14 已定案的 Host presentation、token、pending、CAS、批准信号和 receipt 语义不因工具 schema 改变；模型不能以 `confirm` 字段、assistant 自述或工具结果替代真实批准。
3. 每个 Core 工具在源码中拥有稳定的 `tool_name@schema_version` 与 canonical schema hash，例如 `memory.search@v1`。schema 的字段、参数约束、返回结构、关键描述或权限语义发生外部可见变化时，产生新的 schema identity；不原地改变已发送请求使用的 schema。Git 中的 schema 常量和实现是权威，不建通用 tool registry 或数据库版本表；assembly/attempt receipt 记录 tool name、schema version 与 hash，schema 变化创建新的 assembly 与 cache epoch。
4. Tool schema 只描述调用契约，不授予权限。每次模型 tool call 都必须由 Core 重新检查 active policy、capability、credential、scope、参数、真实 resource owner、审批条件与 receipt；AGENTS、Skill、memory/source、provider metadata、`allowed-tools` 或模型自述不能修改 schema 或放宽 gate。tool result 是有界的不可信数据，不能反向激活指令、改变 scope 或注册新工具。
5. 文件、命令和交互能力不归 Core 实现。Pi 的 `read/write/edit/bash` 等以及 Euler CLI 的对应宿主工具由各自 HostAdapter 提供；Core 只拥有统一的 schema admission、policy/capability/resource gate、调用生命周期与 receipt。HostAdapter 是既有宿主接入边界，不是可由任意第三方调用的插件 registry；宿主没有某项能力时返回 `unavailable`。

   路径解析/文件 API gate 不约束任意 shell/脚本内部的文件、网络和子进程行为。首次切片不向模型直通未隔离的任意执行工具；owner 需要运行时，可通过真实 Host 的高权限维护动作明确批准具体命令、cwd 和实际权限范围，这不宣称为 sandboxed 模型工具，也不作为 Core 隔离 PASS。后续开放模型执行能力前，须明确并验证真实执行环境的隔离边界，或明确采用逐次 owner 批准的高权限模式；不得把后一种包装成 root 限制。产品数据根/canonical store 是否可被进程直接访问必须明示，不以“同用户攻击者不在威胁模型内”掩盖已提供工具的权限。Skill 激活不授权脚本；无需先自研沙箱。
6. v1 不提供通用 Euler plugin tool registration，不动态加载同进程 JS/TS tool handler，也不允许 Pi extension 在 `euler-active` 下绕过 Core 直接把工具送入 Pi tool loop。第三方工具优先通过 D6.5 的 MCP 或进程外 provider 接入；若未来出现 MCP 无法覆盖的真实消费者，再单独设计带 manifest、schema hash、scope/capability、隔离、超时/取消与 receipt 的进程外 `ToolProvider` 协议。当前不预留空 registry、plugin_tools 表或假定的公共插件 API。
7. 少量固定 Core schema 放入 P0；大量可选工具不进入 Core，具体 MCP 的发现、描述、注入、命名冲突和优先级已由 D6.5 定案。Provider adapter 可以转换 Core schema 的 wire representation，但不得增删、重排或语义改写已冻结的 tool contract；动态工具也必须服从 D5.4 的最终 transport barrier。

### MCP tools

1. MCP server 是 Agent instruction/capability integration 的外部 provider，不是 memory/context Core、canonical memory 或通用 Euler plugin。server 必须由 owner 显式绑定到 Global、Workspace 或 Project scope；绑定至少记录 `server_ref`、target scope/project、transport、command 或 URL、credential reference、enabled 状态与 capability policy。模型、Skill、AGENTS、memory 或 MCP 返回内容不能创建 server binding、传入任意 command/URL/credential 或自动安装 server。
2. MCP adapter 对已绑定 server 使用 `tools/list` 获取目录，在上下文外保存有界 metadata/schema cache；server name、description、input schema 与 metadata 都按不可信数据处理，须经过大小、深度、字段和类型校验。`tools/list_changed` 只触发刷新，不能直接改写正在发送的 assembly。MCP resources/prompts 不在 v1 自动注入，分别留待未来 source/instruction 集成。
3. 小目录可以把通过 owner/scope/capability/完整性门禁的 namespaced MCP tool schema 直接放入下一次 assembly；大目录由 MCP adapter 提供固定的 `mcp.search` discovery surface，返回有界的 `mcp_tool_ref`、name、description、server label、scope/target、availability 与 cursor，不默认返回完整 schema。模型或用户选定 ref 后，Core 在下一次 assembly 注入准确 schema；`mcp.search` 是 MCP adapter-owned 固定 discovery schema（`mcp.search@v1`），与八个 Core schema 分开计入 P0 的宿主能力块；它是模型工具，但不是第九个 Core 工具。每个启用 MCP 的 assembly 必须含该有界入口及准确 schema；未配置/不可用时明确 disabled/unavailable，不能伪称目录为空。Schema 版本/hash 由 adapter 源码常量固定并经 Core admission，调用只查询已批准绑定的 metadata cache、不接受任意 URL/command/credential，不调用目标 MCP 工具；必要目录刷新另走受控 tools/list。schema/注入集合变化创建新 assembly/epoch，调用参数/结果由 Core gate 检查并作为正常 tool-call/tool-result 写入 Host archive；对应 assembly/attempt 归 10 §11 的当前 stream，不新建 discovery receipt domain。receipt 记录 adapter/discovery schema hash、绑定/目录 snapshot、cursor 与有界结果 hash，不复制秘密。命名保留 `mcp.search`，server 同名工具必须 namespace，不能覆盖它或 Core/Host 名。v1 不增加 generic `mcp.call`，优先保留 provider 原生参数 schema。
4. MCP 暴露给模型的工具名使用确定性 namespace（概念上为 `mcp.<server-ref>.<tool-name>`）；provider 不允许该格式时由 adapter 生成确定性编码并在 receipt 保存映射。Core tool 名称保留，MCP 不能覆盖或合并 Core/Host tool；不同 server 的同名 tool 不按扫描顺序选择，必须绑定明确 `server_ref`，歧义时阻断。Skill 或 AGENTS 推荐某个 MCP tool 不等于获得授权。
5. MCP tool call 必须经 Core 校验当前 server binding、schema snapshot/hash、active policy、capability、credential、scope、参数、真实 resource owner、审批条件与 receipt，再由 adapter 调用 server。server/URL/command 不由模型决定；返回值是有界不可信 tool result，不能激活 policy、修改 schema/scope、扩大 active_project_set 或自动写入 canonical memory。MCP 输出要成为 memory，仍须经过 candidate、provenance 与 verification gate。
6. 选中的 MCP tool 的 server binding、原始 tool name、暴露名、protocol/adapter version 与 canonical schema hash 进入 assembly/attempt receipt。工具添加、删除、schema/binding/namespace 变化创建新的 schema identity、assembly 与 cache epoch；已发送请求和旧 receipt 不回写。server 不可用时未选中的工具不阻塞当前任务；已选工具返回明确 `unavailable`，当前动作依赖它且无安全替代时 fail-closed，不静默换同名 server。
7. v1 不提供 MCP server registry、自动安装/升级、同进程 handler 或通用插件注册。MCP transport 可以使用受 HostAdapter 控制的进程外 stdio/HTTP 等方式；Core 仍拥有统一的 schema admission、policy/capability/resource gate、调用生命周期与 receipt。Provider adapter 只能做 D5.4 允许的 wire conversion，不得增删、重排或语义改写已冻结的 MCP tool contract。
