# 建立设计证据与课程待补实验矩阵

Type: task
Status: resolved
Blocked by: 01, 02, 03, 07, 08, 09, 10, 11, 14
Scope: 定义实验与通过标准（含复刻位置），不在本票跑完全部实验；平台覆盖按 portable CI 与目标宿主高风险行为分层。

## Question

把已定设计逐项映射到现有课程、源码证据和真实实验；对仍未证实且会改变架构的主张，定义最少的新实验、held-out 用例、通过标准和在自研 TypeScript CLI 中的复刻位置，使课程成为验证场而不是另一套架构文档。

## Comments

- `ai-agent-book@1111794f` 增量审计要求矩阵把 `source mechanism`、`stored receipt`、`independent validation` 分列，不再用单一“通过”状态折叠三者。
- 必补用例：知识产物负迁移；receipt/manifest hash 篡改或陈旧 sidecar；known-bad candidate 保留并拒绝；held-out replacement/retention；Windows、macOS、Linux 的路径与 URL 多轮 canonicalization。
- 9-2 登记为 confirmed negative result；9-6/9-7/9-9 登记为 receipt integrity FAIL；9-7 另登记 Windows double-decode 安全缺口。README 状态与 `accepted:true` 只作线索。
- 本轮不再补跑课程实验；这里记录的是后续最小验证集合，不能提前写成已通过。
- 09 必补故障矩阵：预算超限、完整 ReAct 配对、跨项目隔离、注入隔离、source/receipt hash 失配、receipt 不进入 prompt，以及 assembly/started 两道 durable barrier 前后各崩溃点；覆盖 Windows、macOS、Linux。
- 10 必补存储矩阵：最小 DDL/查询计划、CJK 单字 fallback 与 held-out 召回、projection lease/backlog/hash 条件更新、容量 soft/hard 默认值、online backup/损坏恢复/recovery gap、普通 forget 与 privacy purge 对主库/WAL/空闲页/备份/文件投影的闭包；portable schema/query/worker 检查使用三平台 GitHub Actions matrix，真实数据根、权限、本地备份/恢复和 Host-dependent purge 行为按目标平台真实宿主验收，不以 README、CI badge 或派生报告替代对应证据。
- 14 必补宿主呈现矩阵（其 Handoff 段指派给本票）：
  - Host-owned presentation 记录与 durable pending operation 的最小 DDL；pending 唯一约束建在 session 层，跨 session 并发由提交时 canonical CAS 兜底。这两张表是 10 表族新增的 host operation state domain，与 execution ledger 同库但用途互斥，不得写入 `execution_events`。
  - WAL/崩溃边界：canonical commit 已落但 owner entry 或模型摘要未出时崩溃，重启按 receipt ID 只补缺失 presentation，不重复 mutation/receipt；unknown outcome 先查询再决定。
  - Pi 新 session 首轮即走 extension command 时宿主 entry 尚未 flush（`_persist` 的 no-assistant guard），必须验证此时 presentation 顺序校对与 owner receipt 仍以 Host-owned 记录为准，并在该时机崩溃后能正确重建或报缺；该场景下“复用旧卡”必须退回完整重显。
  - 跨进程 JSON continuation：同 session preview→commit 跨 invocation 的 pending durability、token 有效性与事件顺序；在此实跑通过前不得宣称 JSON 写路径生产可用。
  - privacy purge 的 reverse refs 闭包必须覆盖 presentation/pending 两张新表；已签 content-free owner receipt 按 10  的显式例外只保留不可反查的假名 `subjectRef` 与 revision，不被改写。
  - 上述各项的 portable 检查使用三平台 CI；真实消费者与用户环境部分按当前目标平台分别验收。单平台结论不替代其余平台的生产支持证据，尚无其他平台宿主不阻塞 Windows-first v1。

## Decisions — 产出形态与平台覆盖

1. 本票只产出可执行的实验定义，不承担实验执行。每个条目必须写清：被验证的具体主张与其权威条款引用、最小复现步骤、判定所需的最小可观察字段、pass/fail 阀值、失败时影响哪条已冻结裁决，以及在自研 TypeScript CLI 或课程里的复刻位置。无法写出可观察失败条件的条目不进矩阵。
2. 实际执行拆到后续票，按依赖就近安置：存储/投影与宿主呈现的故障实验随 13 的运行时接线落地，课程类负迁移/held-out 用例另开实验票。本票不得把任何未实跑项写成已通过。
3. 平台覆盖按证据类型分层：共享 Core、可自动化 OS 检查和 portable 数据格式使用 GitHub Actions 的 Windows/macOS/Linux runner matrix；当前 Windows 另有真实宿主待实测。macOS/Linux 的真实宿主条目同样保留完整定义并标为“无宿主、未验证”，但只阻塞依赖真实用户环境的目标平台 gate，不阻塞共享实现或 Windows-first v1。
4. CI（包括 GitHub Actions runner）可以作为共享 Core、portable/可自动化 OS 行为和跨平台构建的正式回归证据，并在对应范围内关闭 CI/portable gate；它不能单独关闭依赖真实用户环境的 Host UI/approval、真实数据根与 ACL、symlink/junction 最终解析、进程恢复、本地 backup/purge 或 Pi/CLI adapter 的真实宿主 gate。CI 结果必须单独记录，不升级未实测的真实宿主状态。
5. 矩阵仍按 `source mechanism` / `stored receipt` / `independent validation` 三列分置，并额外列出平台与证据等级（已证实/推断/未证实）；三列不得用单一“通过”折叠，README、CI badge、示例自述与派生报告只作定位索引。

## 矩阵读法

- `source mechanism` 只回答“源码或真实 owner 里是否存在该机制”；它不能证明机制被目标系统接线，更不能证明效果。
- `stored receipt` 必须是运行时 owner 产生、可由原始输入重算 hash 的不可变产物；console、README、`accepted:true` 与评审文字不是 receipt。
- `independent validation` 必须从权威 raw source/fixture 自行复算，不接受被测实现挑出的片段或自报 verdict。`confirmed negative` 与 `receipt integrity FAIL` 是有效证据，不得改写成“尚未运行”。
- 真实宿主状态使用 `已实测`、`待实测`、`无宿主/未验证`、`不适用`；CI 状态另列为 `unverified`、`CI verified` 或失败。没有对应实现/fixture/runner 的可复算 receipt 时保持 `unverified`，不能由计划、badge 或源码同构升级。CI 可以关闭其实际覆盖的 portable/共享 Core gate，但不升级依赖真实用户环境的宿主状态。
- 下表中的 resolved ticket 是规范来源，不是生产行为证据；所有 `X-*` 实验在执行票落 receipt 前均为 `未证实`。

## 现有证据账本

| ID | 主张与来源 | source mechanism | stored receipt | independent validation | 当前判定 |
|---|---|---|---|---|---|
| E-01 | 原文恢复、稳定 M0、分层压缩；`code/context.ts` 的 `magic/ledger/status` 与 `learning-records/0002-context-engineering.md` | 有：确定性合成 fixture | 无 canonical raw receipt；0002 压缩比例缺原始账本 | 只覆盖小 fixture，不证明目标 archive、预算 admission 或 provider cache | `partial` |
| E-02 | 跨进程文件记忆、lexical top-3、source/status/supersedes；`code/memory.ts` 与 0003 | 有：最小教学实现 | 无目标 schema/receipt；3-1/3-2 每层仅 1 例 | 3-5 已证实精确词命中、纯同义改写失败；60 用例四模式总体排序未证实 | `partial + confirmed negative` |
| E-03 | 工具门禁、截断、路径字符串过滤；`code/tool-gate.ts` 与 book 9-7 | 有：确定性规则/自检；canonicalization 无——`tool-gate.ts` 只查 `..`/前导 `/`/drive 前缀，无 decode/normalize/realpath/symlink | 本地 console 非 durable receipt；9-7 sidecar hash 不匹配 | Windows 已证实 `%252fetc%252fpasswd` 双重解码绕过 | `receipt integrity FAIL + confirmed negative` |
| E-04 | 候选隔离、verifier、canary/回滚；book 9-2/9-6/9-7/9-9 固定源码 | 有：campaign 机制 | 9-6/9-7/9-9 `latest.sha256` 不匹配；9-2 `accepted:true` 不能证明效果 | 9-2 三项效果主张均 false；9-4/9-8 与 9-6/9-9 纵向效果未证实 | `negative / FAIL / 未证实` |
| E-05 | MC 原始 JSONL、compartment、M0/M1、恢复与项目记忆；installed 0.40.1 + Pi session + 只读生产 DB | 有，且已区分 installed/checkout/migration | 有只读证据包 SHA 与时点快照；不是目标 runtime receipt | 当前 Windows 已独立复算；0.33.1 checkout 不能逐行证明 0.40.1 | `source 已证实` |
| E-06 | typed/scoped 多平面、写入治理与评估维度；固定外部源码/论文 | 有：只作机制交叉证据 | 无本项目 runtime receipt | 不证明本项目效果；authority/conflict 无通用外部协议 | `source only` |
| E-07 | Pi 0.84.4 tool result/custom entry/RPC/JSON/TUI/`-p` 能力；14 的直接源码核验 | 有：package/docs/未打包 `dist/**` | 无本项目 adapter receipt | source 行为已独立复核，宿主状态机与 continuation 未实跑 | `source 已证实` |
| E-08 | Node 24 `node:sqlite`/FTS5/WAL 与 TriviumDB tokenizer/崩溃案例；10 §29–31 | Windows source/build 机制已跑 | 无目标 DDL、三平台或故障 receipt | Windows 基线成立；目标 schema、并发、容量、macOS/Linux 未证实 | `partial` |
| E-09 | 04–11、14 的 resolved 设计契约 | 有规范，无目标实现 | 无 | 只证明用户已冻结边界；不能作为实验通过证据 | `contract only` |

**账本结论：** 当前没有任何证据足以宣称目标 v1 的存储、检索、装配、记忆生命周期、宿主闭环或三平台行为已通过；12 只能定义下面的最少新实验。

## 统一 receipt 与复刻位置

每次执行先写原始 run artifact，再由独立 verifier 复算；最小 receipt 字段为：`experiment_id/schema_version`、权威条款 refs、实现 commit/tree hash、OS/version/arch、Node/SQLite/provider/model/adapter 版本、fixture/held-out digest、held-out owner、sealed commit、released commit、contamination/replacement case IDs、完整命令与起止时间、exit/signal、判定所需的最小观测字段、逐条 assertion 结果、stdout/stderr/DB/sidecar digest、受控副作用清单和最终 `pass|fail|evidence-gap`。秘密与原始正文只由其 owner 保存，receipt 仅放 locator/hash。缺字段、hash 不符或 sidecar 陈旧直接 `receipt integrity FAIL`。

复刻位置只分两类，不新建实验框架：

- `COURSE/context`、`COURSE/memory`、`COURSE/gate`：分别在现有 `code/context.ts`、`code/memory.ts`、`code/tool-gate.ts` 增加独立 mode，承担纯确定性、零依赖的教学负例/机制 fixture；不得伪装成目标 runtime 验收。
- `RUNTIME/store`、`RUNTIME/core`、`RUNTIME/host`：随 13 冻结的自研 CLI/adapter 模块放相邻 integration test；13 必须在首个实现 commit 前把这三个符号位置映射为具体 repo path。未映射时不得开始实现，也不得把课程 mode 当替代品。

## 最少新实验矩阵

每张 `X-*` 卡的正文与下方同 ID 三轴状态行共同构成一个验收条目：卡内给出主张、fixture、观测、阈值、receipt/位置/平台与失败影响；状态行独立给出 source mechanism、stored receipt、independent validation、当前证据等级、平台门禁和 CI。任一侧缺字段即该条目不完整。

### X-01 · canonical schema、query plan 与事务不变量

- **权威主张：** 10 §2–11、14 `Presentation identity and ordering`/`Pending lifecycle`；每用户每 app-id 单库、逻辑 scope 隔离、immutable revision/event + 可重建 head、独立 execution stream 与 host operation state。
- **最小 fixture：** 每个目标 OS 的 GitHub Actions runner 或真实 OS 宿主在该 OS 标准用户数据根下，以同一 OS user 分别从两个 cwd（其中一个不在 Git 仓库）和两个 Git root 打开同一 app-id，再用第二 app-id 打开；三平台各建本地库，不共享 SQLite 文件。库内另含两 project + 一 workspace + personal、两 session/两连接；执行 create→verify→activate→correct→conflict→rollback，并并发创建每 session pending、竞争同一 canonical head；另以未知 schema version 打开副本。
- **观测：** OS user/data-root/app-id、cwd/Git root、resolved DB path 与 file identity；DDL/hash、PRAGMA、`EXPLAIN QUERY PLAN`、row/seq/head、FK/unique/CAS、事务前后 DB digest；host operation 行与 `execution_events` 分开计数。
- **PASS：** 同 OS user + app-id 在 cwd/Git root 改变后 resolved path/file identity 不变；不同 app-id 的 DB path/file identity 不同；Windows/macOS/Linux 各自只使用本机标准数据根且跨宿主共享 SQLite 文件次数 0。高频硬过滤命中声明索引；append-only 行不变且从 event 重建 head（含 `head_event_id`，无 active head 也保留最后变更身份）与 current 完全一致；pending 的数据库唯一约束键为 session identity，同 session 第二个 pending 被 `superseded`，不同 session 可并存但第二个 canonical commit 得 `stale`；Host operation 行写入 `execution_events` 次数 0；存储层分配 row/event identity，调用方伪造 identity、原地改写已提交 row/event、只对 ID 重算 digest 或删减/重排完整 payload 均拒绝；任一数据库后置条件失败时事务回滚且外部删除次数为 0；任一事务失败无半写；未知新 schema 拒开。任一违反即 FAIL。
- **Intent/owner/Info 原子性：** 两连接并发 CAS 同一 intent event，重放 input identity、在 event/head/outbox 各语句间杀进程；检查 `intent_events`/`intent_heads` 可重建、输家 stale、unknown 查询先于重试，memory 与 intent 分域。分别创建 session/job/maintenance/migration stream，检查 owner_kind/ID/scope 非空且同一次 attempt 恰属一个合法 owner；不允许重新绑定已发 stream。自动 activation 的 batch/event 与 `host-info` outbox 要么全部提交要么都无，batch 成员/order/digest 固定、同批次无重复 target；FK、唯一约束与非权威 Host 投影不能伪造 canonical receipt。Fence 检查与 activity 登记同事务，与 closing 竞争只能一方先成功，不得出现检查 open 后绕过登记的写入。
- **Evaluation plan/result physical gate：** target `RUNTIME/store` 必须验证 `draft→sealed` plan、sealed-before-start barrier、storage-owned append-only result、plan digest/attempt binding、post-seal mutation/UPDATE 拒绝、required level/checkpoint/held-out/source/budget/stop 条件变更新建 lineage，以及 purge reverse refs；课程 X-08 只验证效果与 held-out 语义，不能关闭该目标门禁。
- **receipt / 位置 / 平台：** `store-schema@v1`；`RUNTIME/store`；portable schema/transaction/SQLite checks 使用 Windows/macOS/Linux GitHub Actions matrix；真实数据根、用户权限与宿主特有行为当前 Windows 待实测，macOS/Linux 无宿主/未验证。
- **失败影响：** 库 owner/app-id、append-only/CAS、pending domain 或 durability FAIL 重开 10/14；仅 query plan/容量参数失败则值保持未冻结，交 13 重测。

### X-02 · eligibility + FTS/CJK held-out 检索

- **权威主张：** 09 §1–5、10 §12–17；硬过滤先于排名，CJK 2-gram 为 v1，单字 fallback 由证据决定，弱命中可返回空。
- **最小 fixture：** 冻结并 hash `ai-agent-book` 3-1/3-2 的共享 60 用例四模式套件（本票未持有其 immutable locator；13 必须先登记套件路径、case IDs 与初始 digest，否则本项保持 `未证实` 不得开跑）；追加中文单字/两字/长词、Latin/数字、纯同义改写、跨 project、stale/conflicted/superseded/tombstoned 与同 claim 不同环境/时间的 held-out。调参集与 held-out 分离。
- **观测：** 每 lane 候选、硬过滤 reason、BM25/RRF、canonical recheck、selected/rejected refs、token cost、query/index tokenizer version。
- **PASS：** eligibility 违规 0；受支持的精确/CJK gold 全部进入 candidate lane 且 current 去重正确；纯同义无强 lexical 证据时返回空/慢路径，不得注入错误近邻。单字 fallback 只有在全部单字 gold 召回且非单字 gold 排序零回归时才采纳，否则明确不支持并走慢路径。
- **receipt / 位置 / 平台：** `retrieval-heldout@v1`；`COURSE/memory` 复刻纯检索，目标验收在 `RUNTIME/store`；三平台状态同 X-01。
- **失败影响：** scope/lifecycle/source-integrity 硬过滤或 CJK 可检索性 FAIL 重开 09/10；仅排序/时延阈值失败则阈值保持未冻结，交 13 调整。

### X-03 · projection outbox、租约、lag 与重建

- **权威主张：** 10 §12–18 与 Scope-review projection contract；canonical 同步写 outbox，worker 重新读 current head，旧 job 不覆盖新 revision，损坏/超 backlog 必须可见并重建。scope_overview 是 v1 已批准的唯一 app-data artifact consumer，其文件发布、operation/pin、GC、repair、reader hard gate 属于本 X-03；10 §19–20 的 Wiki/insight/diagram 等其他生成式文件仍是未来独立 gate，不属于本 v1 worker。
- **最小 fixture：** 乱序 revision jobs、重复 delivery、worker 在 claim/upsert/watermark 各点崩溃、租约过期接管、hash 不符、FTS 人为损坏、tokenizer generation 切换；scope_overview 另在 operation claim、临时文件写入/fsync、hash-path rename、metadata/cursor/pin commit、GC claim、GC 实际删除、同 hash 新 pin、stale writer rename、repair claim 各点强杀/交错；另强制覆盖“已有 pin 的 H 正文损坏→`repair_required`→同一 H 确定性重建→受控替换→`fresh`”的正常对照、共享 H 的多个 artifact、repair 与 GC/new pin/reuse 交错及 repairing 状态各崩溃点；验证 operation-specific orphan、path state、artifact pin、repair continuation、reader 不可注入和删除/重建不改变 canonical truth。规模用当前只读 MC 快照的 1×/10×/100×合成数据，不复制生产正文。
- **观测：** job/revision/generation、lease owner/expiry、process incarnation/lease epoch、watermark、backlog age、batch sweep、publish operation/path state/pin/GC claim、file identity/hash、canonical↔projection 双向 diff、repair interval/continuation、重建前后查询 digest。
- **PASS：** stale job 覆盖 current 次数 0；重复/接管结果幂等；dirty/rebuilding/failed/repair_required 可观察且不可注入；scope artifact 的 GC 只能在同一 hash-path claim 下完成“无引用→deleting→实际删除→deleted”，GC 与新 pin/reuse 交错不得误删已引用正文，stale writer 不得 rename 到已引用路径；正文缺失/hash 失配可按原区间 repair 且不能被普通 cursor 跳过；重建后双向 diff 为 0。Wiki/insight/diagram 等其他生成式文件仍留给未来独立 gate；batch/lag 默认值在三平台 sweep 完整前保持未冻结，不以单机最快值拍板。

- **receipt / 位置 / 平台：** `projection-recovery@v1`；`RUNTIME/store`；三平台状态同 X-01。
- **失败影响：** outbox、lease、条件更新、scope artifact publish/pin/GC/repair、可重建性或 canonical/search projection 边界 FAIL 重开 10；Wiki/insight/diagram 等未来 artifact gate 失败只在对应能力启用后重开专门条款；仅 batch/lag 参数失败则保持未冻结，交 13 重测。

### X-04 · context admission、完整 ReAct 与 source recovery

- **权威主张：** 07 §2–3/5–16、09 §9–12；唯一 Orchestrator 先归档再卸载，每次调用前硬预算，完整 ReAct 不可拆；本地检索有 deadline、后台工作不阻塞快路径且普通路径只调一次主 LLM；证据不足时由主 Agent 自身工具慢路径恢复，不新增 router/RAG Agent；原文恢复必须校验 locator/hash。
- **最小 fixture：** 含多组 assistant tool-call/tool-result、超大 tool result、弱相关 memory、近重复/可重建内容、非 pinned memory/source、当前错误/参数、已准备/未准备 compartment 的轨迹；用相同 mandatory 输入分别制造只需去弱相关/近重复/可重建、再减非 pinned memory/source、再切已准备 compartment、最后需先归档后分页/分块的四级压力。另分别注入 mandatory 恰好等于/超过 context limit、archive 写失败、source hash 失配，以及 09 §12 每类 recovery 触发条件（明确原话/行号、当前行动缺参数/错误、memory provenance 指向原文、stale/conflict、projection 不足）与 projection 已足够的无需恢复对照。P0/P1 相同，仅改变 P3 后缀再组装一次。再造快路径场景：本地 memory top-k 超 deadline、compartment 生成/candidate 提取/FTS-projection worker卡死或报错，以及证据不足需进慢路径的请求。
- **观测：** P0–P3 bytes/hash/token、mandatory/selected/reserve/margin、每次 degradation step 的输入类别与顺序、archive receipt、保留的完整 ReAct ranges、recovery trigger/reason/locator/hash/excerpt；另记快路径内主 LLM 调用次数、同步阶段含的工作项、本地检索 deadline 命中/超时、慢路径的发起者与工具序列。
- **PASS：** 每次已发送请求均满足预算不等式；tool pair 拆分 0；未归档成功或当前行动仍需精确值的内容卸载 0；mandatory 超窗明确拒发；hash 失配只返回证据缺口并标 stale；同 epoch 的 P0/P1 逐字节相同，动态变化只影响短后缀。降级必须按 fixture 所需层级依次为：弱相关/近重复/可重建 → 非 pinned memory/source → 已准备 compartment 的完整 ReAct 边界 → 已归档单条的分页/分块，跳级、逆序或卸载 mandatory 均 FAIL。09 §12 的每类触发条件都进入有界 recovery，projection 已足够的对照 recovery 次数 0。快路径另要求：本地检索超 deadline 即放弃候选而不阻塞；异步工作卡死/报错时快路径仍完成且主 LLM 调用次数恰为 1；慢路径由主 Agent 工具发起，额外 router/RAG Agent 调用次数 0。任一反例即 FAIL。
- **D4/D5/D6 与 archive 补充验收：** 同一 raw range/job 重放、Historian 输出失败、archive 已 flush/job 未提交后重启、Pi 首轮仅有内存 entry、缺 ack 与未知 append outcome 分别入 fixture；观测 owner/event identity、实际 durable ack、range/raw/compartment hash、生成次数与 source→job/dispatch 顺序。相同 identity+bytes 幂等、异内容冲突，未确认归档时 dependent job/卸载/dispatch 均为 0；重启只补缺 job，不重复 source。正常路径同一 range 不重复有损生成，不以旧 summary 为输入，失败不落半成品；compartment 覆盖冻结的 mandatory decision/result/citation。再测无新摘要的 fresh window、所选 compartment baseline 切换、已加载 Skill 的同任务复用/换窗重装/失效：记录 first/previous/current/ordinal、lifecycle receipt、snapshot、P0 正文字节与 hash。窗口身份连续可复算，准确 Skill 正文和顺序完整，预算不足只报 unavailable，不截半份；临时未调用或仍适用的换文件不卸载，明确任务结束或失效才从下一 assembly 移除。archive/purge 后的 source.search/expand 返回缺口而非残余正文。
- **Intent 连续性：** 无外部 todo 的新 Pi/CLI 任务、外部 provider 不可用、分支恢复、缺失/损坏 head、模型伪造 transition、任务中途仅请求状态、合法改目标，以及 assembly 后 intent 版本变化分别入 fixture。观测真实输入身份、intent event/head/version、intent/session/branch identity、goal/constraints/scope/step/status、input locator/hash、恢复结果、assembly intent hash 与 dispatch。正常新任务有 durable 最小 intent，未换目标保留原目标，授权外的转向/扩权为 0；本地有效 intent 不因外部 todo 离线被清空。恢复按 events/CAS，不从 memory/summary 猜目标；缺证保持 needs-input/unavailable、相关副作用为 0。新旧分支不倒拨同一 intent 版本；已失效 assembly 不发，明确合法 transition 后新 assembly 可正常完成。
- **Pi 首轮 source 接点：** 按 13 的 P0 公开 API 边界，分别测试原生未准备 manager 的无 assistant 负例、受控排他预建/公开 open 后的正常首轮，以及合法 header/完整分支重绑。观测真实 session/file identity、raw-event 与 native entry 映射、append/fsync/严格复读/ack/job/dispatch 的顺序和次数；同一逻辑事件不得因两个表示重复捕获。正常首轮可在无 assistant 时获得合格 source ack，并完成原单主调用路径；缺失、失败或未知 ack 时 dependent job/卸载/dispatch 均为 0。只看 flushed、getLeafId/getEntry 或 message_end 通知不算通过。P0 synthetic 接点探针不替代 P3 实际 Pi/Host 接线及 X-12 的真实宿主 durability。
- **receipt / 位置 / 平台：** `context-admission@v1`；`COURSE/context` 复刻纯函数，目标验收在 `RUNTIME/core`；三平台状态同 X-01。
- **失败影响：** 单一 Orchestrator、预算、ReAct 完整性、先归档后卸载或 recovery 边界 FAIL 重开 07/09；仅 deadline/预算参数失败则交 13 以真实数据重定。

### X-05 · scope/conflict/injection/provider 数据隔离

- **权威主张：** 09 §1–8；active project 由 intent/resource owner 验证，stale/conflicted 只给状态标记，memory/source/provider response 永远无 instruction/capability 权限。
- **最小 fixture：** primary/affected/未触碰 project、workspace/personal、同 claim 不同 project/host/time；默认单项目请求必须解析出 primary project，并让适用与不适用的 workspace/personal 对象同时存在。显式构造 intent/task、实际 resource owner、manifest 与 tool path 一致及互相冲突的项目归属，让 `affected_project_ids` 含未被这些证据验证的项目，并加入项目身份仍未解析的请求与明确跨项目请求。正文包含伪 system/tool/approval/credential 指令；远端 provider 在正文与 metadata 中返回 system/developer/tool 字段、超长字段及 hash 错误。
- **观测：** active_project_set 及其 intent/task、resource owner、manifest、tool path 四类来源证据，workspace/personal eligible/rejected reason、最终 envelope role/bytes、capability/policy decision、实际 tool dispatch 与 provider 白名单字段。
- **PASS：** 默认单项目请求的 active_project_set 恰含已解析 primary project；适用的 workspace/personal 对象正常参与 eligible set，不适用对象被硬过滤。新增 project 必须有 intent/task 与真实 resource owner 依据，且 manifest/tool path 与之不冲突；任一来源冲突时 fail closed，不静默扩大。`affected_project_ids` 单独出现时扩大 active set 次数 0；未解析项目只使用 session-local context；明确跨项目请求只加入上述证据验证的项目，返回结果保留 project 标签且跨项目 claim 折叠次数 0；其余未激活 project 正文进入 prompt 次数 0。candidate/rejected/tombstoned 正文进入正常 prompt 次数 0；stale/conflicted 只出现有界 marker；任何数据字段改变 policy、tool schema、审批或 credential scope 次数 0；未知/超长/hash 错字段均丢弃或 fail closed。
- **D6 集成补充验收：** 在小/大目录、同名多 scope、显式 ref、source/hash 变化和缺失来源下测试 AGENTS/Skill/MCP。观测 active scope/owner、guidance channel/snapshot/hash、默认及显式绑定结果、有限目录/cursor、schema admission、namespace 映射、实际 dispatch 与拒绝原因。普通 guidance 只对实际目标采用最具体适用范围，不跨 project 覆盖；已识别的不可满足同一操作冲突进入 instruction-conflict，未解除前相关副作用为 0，不要求实现任意自然语言冲突解析器。显式合格 Skill 不被同名默认替换，选中后失效不静默 fallback，部分目录不冒充完整且搜索失败不伪装无结果，allowed-tools 不授权。MCP 未绑定 server/任意 URL-command-credential 被模型指定时 dispatch=0；目录超限、schema/hash 变动、同名跨 server 与 Core/Host 名冲突均按门禁处理。通过的名字确定性映射且实际调用命中冻结 server/schema；tools/list_changed 仅刷新后续 snapshot，不改当前请求。未选不可用工具不阻塞；已选不可用明确 unavailable，不换同名 server；输出/metadata 不能激活指令、注册工具或直接写 memory。八个 Core schema 集合不变，不出现通用 mcp.call/plugin registry。
- **D6.3 多已选 Skill 冲突：** 让两个不同 Skill 均已通过 scope/trust/hash/预算并激活，且对同一资源的同一次副作用提出已明确识别、无法同时满足的直接约束，例如同一次依赖安装分别必须用 pnpm 与 npm；交换加载顺序再测。观测两个精确 skill_ref/hash、instruction snapshot、受影响操作、冲突状态、额外 LLM 调用和真实副作用计数。必须暴露 skill-conflict，冲突未解除时该副作用次数为 0，不按加载顺序静默选一份、停用另一份或另起 LLM 裁决器；额外裁决调用为 0。相容约束或分别适用于不同操作的对照不误判为此冲突；owner 明确解除约束或停用其中一份后，经新 snapshot/assembly 重验可正常执行。不新增通用自然语言冲突解析器，实际 adapter 仍按 X-10 重验该终态。
- **Discovery 与加载边界：** 大 MCP 目录时模型可见八个 Core schema 加 adapter-owned `mcp.search@v1`，名字/所属块/hash 分列，不能把总工具数误验为八个。仅合格绑定参与有界发现，cursor 可继续，调用不直接执行 MCP 目标工具；伪 command/URL/credential 参数拒绝。禁用 MCP 显式不可用，目录失败不报空；同名 server tool 不能盖 discovery，schema/绑定变更后旧调用失效且后续 assembly/epoch 更新。Pi 启动夹入 user/project/package/CLI/inline 的第二 extension、伪装同名 adapter、载入后动态注册工具及 reload/cwd/new session 重载；观测 factory 执行计数、loaded set hash、实际 Core wrapper 与拒绝点。未批准代码在 factory 前即拒绝，拒绝路径副作用 0；批准的唯一 adapter 可加载合格工具，不能用“全部禁用”假过测试。固定 hash 不被当作能隔离恶意可信 runtime 的沙箱。
- **receipt / 位置 / 平台：** `context-isolation@v1`；`COURSE/gate` 放确定性负例，目标验收在 `RUNTIME/core`；三平台状态同 X-01。
- **失败影响：** active-project、authority、injection 或 capability 隔离任一错误放行即重开 09，并阻塞 13 的所有模型/工具 dispatch。

### X-06 · assembly/started durable barriers 与 attempt 恢复

- **权威主张：** 09 §13–16、10 §11/27；assembly flush、started flush、网络 dispatch 依次发生，receipt 不进入 prompt，unknown-sent 不自动重发。
- **最小 fixture：** 可记录请求数的本地 transport stub；对 assembly 与 started 各自在三处逐点强杀：append 前、append 成功但 durable flush 前、durable flush 成功后；再在网络已接收后/finished durable flush 前强杀。另测同 payload retry、route/model/content 改变、快照恢复 gap 与已有 started/no-finished。
- **观测：** stream seq、fsync/transaction 完成点、assembly/attempt IDs、canonical payload bytes/hash、stub request count、恢复分类、最终 prompt 中 receipt marker 搜索结果。
- **PASS：** 两道 barrier 任一未成功时网络请求数为 0；assembly/no-started=`not-dispatched`；started/no-finished=`orphaned/unknown-sent` 且自动重发 0；非 attempt metadata 变化必换 assembly ID；receipt 内容进入 model payload 次数 0；恢复 gap 下旧 session dispatch blocked。
- **多 owner 与 Pi transport：** 无前台 session 的 job、maintenance、migration 分别运行 assembly/started 各杀点，重启更换进程和过期 job lease，检查 stream owner/attempt 不变且未知请求不重发；故意把请求挂错 session/scope 或删除来源后投递结果，均 dispatch/mutation=0。Pi 使用已固定 SDK/adapter 运行 automatic/manual/overflow/tree summary、设置重启 compaction、provider hook 抛错、最终 payload 改写、HTTP/WebSocket 隐式 retry 与流中断；观测 Core assembly、转换后真实 bytes、started flush、网络计数、hook/load-set digest。缺合法 assembly/owner 或 barrier 失败时请求为 0，即使普通 hook 吞异常也不能发送；每次实际发送恰有自己的 attempt，隐藏 retry=0；正常主调用及合法 Core 压缩成功且不递归用 Pi summary。仅 stub 不能关闭 Pi/真实 transport 的接线门禁。
- **receipt / 位置 / 平台：** `dispatch-barriers@v1`；`RUNTIME/core`；Windows 待实测，macOS/Linux 无宿主/未验证；CI 可跑逻辑杀点但不替代真实进程/文件系统。
- **失败影响：** assembly/started durable barrier、identity 或 unknown-sent 恢复 FAIL 重开 09/10，并阻塞所有真实 transport 接线。

### X-07 · candidate、验证、替代、冲突与回滚

- **权威主张：** 08 §1–20；Harness 固定 provenance/scope/owner，Verifier 自取证，先 identity+time normalization，反馈不定义真值，只有强信号回滚。
- **最小 fixture：** 明确“记住”、需结合上文的“同意”、结构化工具事实、外部不可信文件、重复 source event、同对象不重叠/重叠有效期、不同 host/environment、弱 task failure、owner correction、source hash 变化、可归因 canary failure；包含 known-bad candidate。
- **观测：** capture source range/hash、proposer/verifier evidence refs、integrity gate、lifecycle/verification transitions、head/pre-image、blocked reason/queue age、feedback 与 salience；`retrieved` 与由 canonical assembly 推导的 `injected` 分开记录。
- **PASS：** 模型自报 provenance 被采用 0 次；所有自动 capture 首次均为 `candidate + unverified`，logical project 未解析时只进入 session-local unresolved candidate queue，跨会话检索/active 注入次数为 0；project 后续由 intent、真实 resource owner 或 manifest 确认时只进入验证管线，不直接激活。重复 event 不增行；不同环境并存，不重叠时间形成 supersession，重叠可信矛盾进入 conflict 并停止注入；weak failure 不改 verification；强信号才回滚且 stale/conflicted previous 不恢复；每个 pending 有阶段和原因，快速通道下一轮前 active 或显式阻塞。`retrieved`/`injected` 不得折叠为同一事实，`injected` 必须能由 09 的 assembly receipt 重算；仅凭暴露（retrieved/injected）改变 verification 次数 0。
- **D1/D4 补充验收：** Proposer/Historian/Verifier 分别注入暂时不可用、超时/限流、协议/结构化输出失败，以及 integrity FAIL、block、evidence-gap；记录 primary/fallback ordinal、Host 实际路由/调用链、requested/actual provider-model、可得 version、config/prompt/schema/adapter identity、输入/输出/tool hash、usage 与终态。只有前一类故障能进入已配置 fallback；否定结论换模型晋升次数 0，低于所需能力只留 candidate/evidence-gap；不可得版本标 unknown，远端自报角色/型号不能改变 Host 路由或权限。全部 attempt receipt 可复算，秘密/正文不进入 receipt。
- **Scope-review 补充验收：** 同一 logical project 至少包含三个不同 session/source batch，其中一批产生新 decision、另一批产生同 subject 的旧 decision/适用边界，另加不同 project 的相似 claim。先登记 scope-review cursor/generation/input digest，再执行增量 review；观测 changed set、affected identity set、实际 source refs、candidate/relationship transitions、overview artifact hash/status 和 cross-project read count。**PASS：** 同一 generation 重放不重复 candidate/event/overview；只改变一个受影响 identity 时不重算无关 scope；同 project 的跨 session 关系能产生带 source refs 的 supersession/conflict/overview patch；不同 project 不被纳入；未解析 scope、stale/conflicted/purged source 不产生 active fact；review failure/cursor gap 只产生 `evidence-gap|stale|failed`，不修改 canonical memory 或继续注入无法验证的 overview；首次导入和 cursor gap 能按 bounded batch 续做。全量 backfill 只作为显式/恢复路径，不能出现在每轮会话关键路径。

- **Scope-review crash/host fixtures：** 在 source owner 提交 body/source_event_id/pending fence/inventory/replay cursor 的 owner-side durable transaction 各语句间、以及 source durable ack 后、Core handoff/`input_seq`/outbox 提交前分别强杀；重启必须先发现逐项 source event，再按稳定 handoff_id 幂等 replay，且不得永久漏事件；启动 N 个 Agent 进程并制造多个 scope/持续 dirty generation，active drains 不得超过 store/per-scope cap，claim 必须在单事务中原子登记；overview body 临时写入、fsync、rename、metadata/cursor commit 各点强杀，正文缺失/hash 失配必须进入不可注入的 `repair_required` continuation，不能被普通 cursor 扫描跳过；raw batch `processed` 但 candidate verification/relation pending 时不得显示“全部历史已分析”，watermark 只允许推进连续前缀并绑定 source snapshot/inventory/missing interval；membership withdrawal/permission revoke 必须使所有更宽 scope artifact stale 并阻止注入。

- **Scope-review closure / concurrency / budget：** scope input 使用 Core-owned store-local monotonic `input_seq`；fixture 在 snapshot、Proposer/Historian/Verifier、relation publish、overview publish、cursor CAS 各阶段注入新的 source/memory/scope event。receipt 必须记录 `start_seq/end_seq/covered_seq`、snapshot/input digest、generation、previous cursor、pending/dirty continuation、selected/omitted refs、workset record/bytes/tokens/depth/fanout/source-expansion/attempt/wall-clock/drain usage 与 budget version。**PASS：** 新事件不被旧 generation 跳过；参与 head/scope/source 变化则本次 patch/关系不得发布，cursor 可安全重试；只存在未覆盖 seq 时旧结果最多为 stale/dirty，不得作为 fresh baseline；同一 generation/cursor 重放不重复 event/overview。超预算禁止 fresh publish，稳定排序、continuation 和 evidence-gap 可复读；多个 scope 轮转且单 scope 不吞尽 drain。关系结果用稳定 relation key 幂等，review 自己生成的 relation event 在本次 post-state/cursor 对账中结算，不产生无界自触发；输入顺序置换与同证据重放结果一致，不确定关系为 evidence-gap。
- **Evaluation proposal target gate：** P2 `RUNTIME/core/store` 必须对 proposal 读取 sealed plan、验证 result 对应 plan digest/attempt set、required level/checkpoint/held-out/source/budget/stop 条件不可降低或替换，缺失、错误绑定、seal 顺序未知或证据不足保持 inert；X-08 课程票不替代本项。
- **Scope dependency / raw backfill：** fixture 先更新 project input，再检查 workspace/personal overview 的 artifact-input 反向依赖、stale fan-out、claim→ref 和 purge 闭包；不同 project 相似 claim 不得混入。每条 raw coverage watermark 绑定 `source_snapshot_id`、source owner、scope/time selector、cursor domain、snapshot/inventory digest，并只表示该 domain 的最高连续前缀；缺失区间必须留在结构化 continuation/missing intervals。显式 global review/首次导入/recovery 另含 raw-only source batch，观测 source snapshot/cursor、capture envelope、integrity、candidate/unverified、verification/relation transitions、processed/evidence-gap、continuation 和 coverage boundary；失败/中断续做不得重复捕获，未完成 raw batch 不得宣称历史已完整分析，正常 turn 不启动该 backfill。

- **receipt / 位置 / 平台：** `scope-review@v1`，receipt 的 `start_seq` 为 exclusive、`end_seq` 为 inclusive，覆盖区间固定为 `(start_seq,end_seq]`；复用 `projection_jobs/projection_state/projection_leases`、scope-only `projection_artifacts` 与类型化 input refs；目标验收在 `RUNTIME/core/store`，三平台 portable 逻辑可由 CI 验证，source/archive、真实 app-data root 和 purge 按目标宿主验收。回滚另含 `r3→r4→r3` 与 forget→restore：旧预览永久 stale，新的预览绑定新 `head_event_id`；恢复前 source/scope/time/verification 失格则不激活旧值。
- **同源抑制与后台归属：** forget 后重放原 source、改 capture event ID、使用路径别名、同 lineage 同 claim 新版本，及不同 claim/owner/有效期的真新事实；观测规范 suppression tuple/provenance、候选/激活/restore event。前三类不得自动 active 或另起同义 active record；歧义 evidence-gap，独立新事实正常走 verification，不能按全局正文 hash 误伤。restore 必须独立批准且资格/CAS 有效，再 correct；purge 清除抑制指纹并禁止旧 job 回放。source-change/时间维护在无前台 session 时调用 Verifier，观测 job stream、已批准目标/scope、来源与 attempt；结束/删除 originating session 不改 stream owner，来源清除后旧授权失效，无合法来源不得续跑。模型未调用的 projection repair 不伪造 attempt。
- **receipt / 位置 / 平台：** `memory-lifecycle@v1`；`COURSE/memory` 复刻纯状态机，目标验收在 `RUNTIME/core/store`；三平台状态同 X-01。
- **失败影响：** capture authority、Verifier 独立性、identity/time normalization、conflict 或 rollback FAIL 重开 08；队列时延参数失败则交 13 重定。

### X-08 · receipt 完整性、负迁移与 held-out evolution gate

- **权威主张：** 08 §18/21–27；01 的 9-2 negative 与 9-6/9-7/9-9 integrity FAIL；memory 只能生成 inert proposal，不能凭自报效果发布行为；正负 retention 必须由冻结 held-out 的独立效果证据决定。
- **最小 fixture：** 从同一 immutable checkpoint 运行 baseline/treatment，仅改变一个 memory/proposal；含一个效果未知的正向候选，并由 held-out owner 在实现前封存至少一条 baseline 失败而 treatment 应成功、或有预声明量化指标可严格改善的目标断言；另含 9-2 型“格式通过但效果变差”候选、内容仍为真但产生负迁移的候选、篡改 manifest、陈旧 sidecar 与重签后重排 payload。对重签场景，owner 在任何实现/候选生成前另行封存不可变 pre-image manifest（完整 payload bytes、顺序、schema、digest 与 owner signature）；攻击样本可重算 digest/重签，但不得替换该 pre-image 锚点。held-out/越界负例在 treatment 前冻结并 hash，调参后污染的 case 移出 held-out 并补新 case。
- **观测：** owner-sealed pre-image locator/commit/signature、pre-image/candidate/full-payload bytes/digest/顺序、baseline/treatment 首个可判定输出、held-out outcome、proposal target/scope、activation pointer、rollback receipt。
- **evaluation plan/result physical gate：** fixture must attempt missing/invalid/low-level plan, post-seal plan mutation, digest mismatch, result bound to the wrong plan, superseding attempt to change target/scope/required level/held-out refs and purge reverse-ref removal; observation includes typed plan fields, canonical plan digest, owner seal identity/time, immutable result plan binding, verifier identity and Core admission result.
- **PASS：** 任一 digest/sidecar 不匹配时同时记录 `receipt_integrity=FAIL` 与 `independent_validation=evidence-gap`，不得只写后者抹平既有 FAIL；即使攻击样本重算 digest/重新签名，只要 payload bytes/schema/顺序偏离预先封存的 owner pre-image，也必须 `receipt_integrity=FAIL`，实现者或候选签名无权替换 pre-image 锚点。缺失、结构无效、层级不足或 plan/result 绑定不一致的 `evaluation_plan`/`evaluation_result` 不得授予行为权限；L0/L1/L2/L3 的失败分别保持 inert/blocked/rejected 或 evidence-gap，不能由 fallback 改成通过。known-bad candidate 保留但不 active；负迁移使其成为 `verified + rejected(negative_transfer)` 并原子回到 known-good；未通过独立 held-out 的 proposal 获得行为权限次数 0；Skill/policy/code 只保存 inert artifact。**正向 retention 为强制项：** 预封存目标断言必须出现 baseline 失败→treatment 成功，或预声明量化指标严格改善；其余 held-out 零回归，候选才可保持 `verified + active`。baseline=treatment、丢弃有益候选与 known-bad 仍 active 均为 FAIL。
- **receipt / 位置 / 平台：** `evolution-heldout@v1`；`COURSE/memory`，执行另开课程实验票；纯知识 fixture 平台 `不适用`。v1 不发布 safety/tool/code；未来若开放，必须另加对应三宿主 held-out/canary lane，不能拿本实验代替。
- **失败影响：** integrity、held-out、正/负 retention 或 inert-only gate FAIL 重开 08，并继续禁止任何行为 artifact 自动发布。

### X-09 · 看/改/退、batch CAS、路由与逻辑 purge 闭包

- **权威主张：** 10 §22/28b/28c、11 全文；写前展示 canonical，identity/CAS/manifest/digest fail closed，rollback 只撤自动更新，purge cycle-safe 且 receipt 不改写。
- **最小 fixture：** 复用 11 prototype 的 inspect/correct/forget/restore/rollback/no-op/stale/重叠预览/取消路径；追加多层对象键和值、成环 refs、`mem-1`/`mem-13`、缺失/重复 event、scope/source 无 revision 漂移、purge 后 redaction。冻结开放式中英复述与相反方向 held-out，并通过真实模型 tool-call 后由 Host 重验 originating input。
- **观测：** assembly frozen item/source hash、preview token/expected head、完整 batch manifest/payload digest、canonical pre/post rows、delete manifest、receipt bytes/hash、Host routing reason。
- **PASS：** 任何 identity/head/schema/digest 不符均 mutation=0；correct 缺 owner 实际正文 fail closed；no-op 不产 revision/receipt；批次不静默缩小；rollback 手动 correction 次数 0；receipt/manifest digest 必须覆盖完整 payload bytes、顺序和 schema，调用方重排/删减 payload 后重算 digest、伪造 row/event identity 或原地改写已提交 canonical row 均被拒绝；purge 数据库内后置条件失败时事务回滚且外部删除次数 0；purge 遍历可终止、精确 ID 零误伤；已逻辑提交的物理清理失败则按 10 §23/X-12 返回 incomplete，不声称整操作回滚；已签 receipt bytes 不变且只余不可反查假名字段。支持的 canonical 短语必须正确路由，开放复述可要求重述但不可走相反或更破坏路线。
- **head 事件 CAS 补充验收：** 两 session 交错执行 update→rollback 与 forget→restore，保存每次 head_event_id、业务 snapshot 与 receipt；旧 token 即使 current 值再次相同也 stale，缺/伪造版本身份不能提交。另测 `r3→r4(A)→r5(B)` 撤销 B 后新建预览撤销 A：新预览使用当前 head 事件身份且业务 snapshot 满足资格时可以成功，不把历史 update event ID 当 current 版本；B 之前的旧预览仍 stale。Rollback 只新增 revocation/receipt，不复制正文 revision，previous 不指向被撤销的更高 revision；首次 activation 回到无 active head 仍保留本次事件身份。任一反例即 FAIL。
- **Tombstone 正常/拒绝路径：** tombstoned 上提交不同正文、空正文和相同正文的 correct preview 均 `not_actionable`/`tombstoned-not-actionable`，pending/revision/receipt=0；valid preview 后被另一 session forget 的 commit 必须 stale。owner 单独 restore 后新建 correct 可成功，不能要求先有旧 receipt 才显示恢复入口。旧 tombstone/restore 预览仍受 head_event_id CAS 拒绝。
- **receipt / 位置 / 平台：** `memory-operations@v1`；纯 reducer 在 `COURSE/memory`，真实信任边界在 `RUNTIME/core/store`；三平台状态同 X-01。
- **失败影响：** identity/CAS/batch、receipt 不可改写、rollback 范围或 purge 闭包 FAIL 重开 10/11，并阻塞对应 mutation route。

### X-10 · 五种宿主的 presentation/approval 状态机

- **权威主张：** 14 `Minimal host contract` 至 `Required terminal states` 及 `Handoff to 12 and 13`；adapter 只实现四操作，模型不能代替 canonical presentation 或批准信号。
- **最小 fixture：** Pi TUI、合规 RPC client、合规 JSON consumer、Pi `-p`、自研 CLI/TUI；逐一执行 inspect、correct、forget、restore、purge、automatic rollback、cancel、第二个 dialog 顶掉第一个、无 UI、旧卡复用与 batch supersession。对批准 dialog 记录真实调用参数，并分别触发无应答/abort/被第二个 dialog 顶掉；correct 分别走 input/editor、user-turn 与非法 confirm-only。另测模型在 preview 同轮直接 commit、缺 token、替换 token、提交伪造 expected head、缩减 batch manifest、复用 settled token；`source === "extension"`/`sendUserMessage` 注入口令；调查式记忆疑问误调 mutation preview；含糊回复/历史 purge nonce/当前精确 nonce；含 sentinel 的 owner receipt 与超出摘要 schema/长度上限的结果。**运行 X-10 前，13 必须在 versioned adapter contract 中冻结模型摘要字段白名单与最大序列化 bytes；缺任一项则本实验=`evidence-gap`，不得自拟阈值。**两个 Host 分别执行 receipt 重启回放；自研 CLI 富 UI 开/关各跑一次，并静态检查其依赖图和 Agent loop/TUI 源码 owner。canonical outcome unknown、commit 后补投影与 Pi 新 session 首轮未 flush 使用同一套 fixture 的 X-11 fault points。
- **观测：** Host presentation record/handle、宿主 event bytes、RPC/JSON 客户端真实呈现面 capture 及从该 capture 复原的 canonical bytes/hash、live input source、token/nonce、adapter 四操作结果、Host core operation→terminal mapping、owner entry 与 model summary；另记 dialog 调用参数与 return/abort reason、authorization/mutation/pending count、Host 冻结的 expected head/batch digest、owner sentinel 在最终模型 context 的命中数、summary 字段与序列化长度、重启前后 receipt bytes/hash、富 UI 开/关 receipt digest、自研 CLI 的 resolved Pi package/imported API 与 Agent loop/TUI 源文件 owner。只记录 Pi/RPC/JSON 发出的 event 不算消费者呈现证据。
- **PASS：** 无 canonical presentation 的 write/inspect 均 `unavailable`；批准 dialog 调用参数中 `timeout` 不存在，无应答/abort/被顶掉均=`unavailable` 且不悬挂，只有明确否定=`rejected`；confirm-only correct mutation=0。preview 同轮直接 commit、缺/换 token、缩减 batch 均=`invalid_identity` 且 mutation=0；伪造 expected head 不能覆盖 Host 冻结值，若与 current 不符则=`stale` 且 mutation=0；settled token=`settled` 且 mutation=0。含糊回复与历史 purge nonce authorization=0，当前精确 nonce 对冻结 manifest 只授权一次；`source === "extension"`/`sendUserMessage` authorization=0，调查疑问=`not_actionable` 且 pending/mutation=0；owner sentinel 进入模型 context 次数 0，模型摘要严格匹配 13 预先冻结的 versioned 字段白名单与最大序列化 bytes，并且 authorization/mutation=0；未冻结则只能 `evidence-gap`。每个 operation 仅落合法终态；RPC/JSON consumer 的真实呈现面 capture 必须能逐字节复原并匹配 Host 冻结的 canonical bytes/hash，只有 event 已输出而无该 capture 时 consumer FAIL；`-p` 只允许无 Host 呈现义务的诊断。两个 Host 重启后 receipt bytes/hash 均不变且可回放；自研 CLI 富 UI 开/关的 canonical result 与 receipt digest 相同，其唯一 Pi package dependency 为 `@earendil-works/pi-ai` provider/model API，`pi-agent-core`/`pi-tui`/Pi `Agent`/`AgentSession` import=0，Agent loop 与 TUI 的 source owner 均为本项目。X-11 的三类 fault point 还必须同时 PASS。
- **D6/R01 接线补充验收：** 每个声明支持的 adapter 在真实装配与工具入口复验 X-04/X-05 的已选 AGENTS/Skill/tool snapshot；篡改 schema、陈旧绑定、MCP 同名 server/不可用与 model 自批均不得绕过 Core，记录实际最终 payload 和 dispatch counter。Purge 在逻辑提交后故障或达到本次调用期限时，结果必须为 error/known committed/cleanup incomplete，且 owner 能读取无正文的残留与恢复状态；重复 commit/cancel 只返回 settled，不假称取消成功。后续 maintenance 完成通过新的 owner entry 呈现，不回写旧 error/receipt；未清理干净不得有 controlled-complete。
- **Pi 非模型入口：** 对每个声明模式检查 builtin 工具禁用及 wrapper 执行，直接 command、`!`/`!!`、RPC shell/export/share、reload/new/fork 的副作用都受 Core gate 和 fence；不支持拦截的入口显式 unavailable，默认直通次数 0。合法 approved 操作仍可完成且 receipt/消费者呈现与 CLI 相同；普通 extension `tool_call` 抛错或允许本身不能替代真实 wrapper。后台无 session 的 Info 可由 owner 查询并在合规宿主上原样展开，notify 不冒充持久/已读。
- **Pi 公开输入接点：** 在 13 所述 regular 受控组件组合中，故意在 factory 后覆盖 onSubmit、复制 action Map，并在异步 gate 期间重复按键/改变 epoch；分别走 Enter、streaming/idle Alt+Enter、分片 paste/展开 marker/autocomplete、图像临时文件、外部 editor、selector 内实际删除/rename/model/settings，以及 startup/reload 失败和 new/resume/fork。记录完整输入/action、实际 Core admission、file/process/network 副作用计数与终态；拒绝时原生 callback 不执行，合法 Euler 呈现/批准/取消主流程仍成功。/share 不能只靠 export wrapper；未知或未接入的附加入口在副作用前 unavailable，不能只隐藏按钮。fullscreen viewport 的早期鼠标行为及实际模式切换必须单独证明前置 gate，无证据不得开放；不能从后加 raw input hook 推断已覆盖。RPC session 方法、JSON initial prompt 与 extension command 分开复验，不复用 TUI PASS。真实装配还须复验 X-05 的多 Skill skill-conflict 与相关副作用为 0；仅准确加载正文不算完成。
- **receipt / 位置 / 平台：** `host-state-machine@v1`；`RUNTIME/host`；每种 adapter × Windows/macOS/Linux 分开，当前仅 Windows 待实测，其他无宿主/未验证。
- **失败影响：** canonical presentation、批准 authority、终态或两面 receipt/summary 边界 FAIL 重开 14，并阻塞该 adapter 的 mutation 支持。

### X-11 · durable pending、JSON continuation 与 Pi 首轮未 flush

- **权威主张：** 14 `Presentation identity and ordering`/`Pending lifecycle`/Handoff；Host-owned identity/ordering 先持久，宿主 entry 是投影，跨进程 pending 不能靠内存。
- **最小 fixture：** 新 Pi session 首个动作直接由 extension command 建 preview；在 Host record 前、Host record 后/Pi entry flush 前、canonical commit 后/owner entry 前、owner entry 后/model summary 前强杀。另在 canonical commit 请求已发出但调用方得到 unknown outcome 时强杀，重启后只持有预分配的 receipt ID/token；再用同 session JSON preview 与新进程 commit，分别测试新 preview 顶旧 pending 后只回传旧 opaque token（未绑定新 presentation，且新 presentation 必须明确列出被作废的旧 operation ID）、对新 presentation 使用旧 nonce/错误 token 绑定、缺失/未知/歧义 identity，以及仍未结算的有效预览遇到 head/head_event_id 变化；另测两 session 各持有效预览对同 head 并发提交。
- **观测：** Host presentation/pending/receipt rows、Pi/JSON entry ID 与输出顺序、canonical mutation count、重启后按 receipt ID/canonical head 的查询次数及查询发生在任何 retry 之前的顺序、补投影次数、blind retry count、token/nonce validity；逐例记录请求 token 所定位的原 operation 及其结算状态、是否显式指向新 presentation、nonce/绑定校验结果和 Host 返回终态，不从当前 pending 补齐请求身份。
- **PASS：** Host record 未 durable 不得给可批准 token；Pi entry 丢失时重启完整重显或明确报缺；canonical commit 只发生一次，恢复只补缺失投影/summary；canonical outcome unknown 时，任何 retry 前必须按 receipt ID 查询并核对 canonical head，blind retry=0；receipt 已存在时 mutation retry=0，只补缺失呈现，receipt 缺失/结果仍不可判时保持 unknown 并交由明确恢复路径，禁止声称未提交。JSON 跨 invocation 顺序仍为 presentation < live user input < commit；新 preview 作废的旧 pending=`superseded`。重用可定位到已提交、取消、作废或失败的原 operation 的旧 token=`settled`，不得将其重定向为当前 pending 的 token；对新 presentation 使用旧 nonce/错误 token 绑定，或 identity 缺失、未知、歧义=`invalid_identity`。仍未结算的有效预览遇到 head/head_event_id 变化=`stale`；两 session 各持有效且未结算的同 head 预览时，后提交者=`stale`。上述拒绝调用均 mutation=0。
- **版本与清理恢复补充验收：** JSON preview 之后由另一 session 使 head `r3→r4→r3`，重启后的旧 token 必须 stale，新 preview 使用新 head_event_id。Purge 逻辑提交后在各 continuation 写入/owner ack 前后崩溃，重启区分批准 pending 与已提交 cleanup；先查 operation/receipt 与实际副本，再幂等续做，不重做逻辑 mutation、不复用 token、不占新批准槽。清理未完成、未知或权限/identity 变化时保持目标/受影响 dispatch 隔离；完成前删除敏感 continuation 后崩溃仍能依据 content-free 进度重做 SQLite 维护。
- **自动 Info 崩溃恢复：** activation/batch/outbox 提交后、Host manifest/unread 前、owner 输出前/后、read ack 前/后及 outbox 结算前强杀。观测固定 batch/event/order/digest、Host rows/ack、job/投递与 mutation 次数。重启缺投递可补，成员不重圈不缩小，重复投递无重复 activation/批次；成功阅读不被重放置回 unread，单纯 append/notify 不清 unread。无 active session 时保持持久待投递，返回后可查询；批次内已 rollback/forget 成员仍展示真实状态。purge 与恢复交错时 fence 阻止迟到旧正文，真实 redacted 批次不被重建成 active。
- **Pi source ack 恢复：** 在受控 header 准备、公开 append、fsync、原文件复读和返回 ack 前后分别强杀/注入部分写、权限错误与 unknown；加入已绑定文件丢失/变空、坏行/残尾、仅内存 leaf 前进，以及无 assistant 的 new/fork/reload。重启必须先严格核对原 bytes、stable event identity/domain 和完整分支映射，再按同 identity 查证；不能把原生 open 成功或 loader 跳过坏行当完整性 PASS，不能把损坏恢复当新建空 session。合格 header/entries/id 与旧 source locator 保持正确，不丢 metadata 或分支历史；同 bytes 重放只捕获一次，异 bytes 冲突，未知不盲追加；缺 ack 时依赖动作均为 0。source ack 与 14 的 Host presentation/批准 ordering 仍分别验收，Pi entry ID 不成为批准权威。
- **receipt / 位置 / 平台：** `host-continuation@v1`；`RUNTIME/host/store`；三平台状态同 X-10；通过前 JSON 写路径保持未验证。
- **失败影响：** pending durability、ordering、unknown outcome 或补投影幂等 FAIL 重开 14，并关闭 JSON 写路径及受影响 adapter。

### X-12 · capacity、backup、损坏恢复与物理 purge

- **权威主张：** 10 §6/22–27、14 purge handoff；容量不足不能删 canonical，backup 必须可恢复，schema 只前进迁移须有恢复点，损坏恢复标 gap，privacy purge 覆盖所有受控副本但不承诺取证级擦除。
- **最小 fixture：** 以当前只读 MC 快照计数为 1× 基线生成无真实正文的 1×/10×/100×数据；fault injection 制造 ENOSPC/只读目录、WAL 中断、FTS 损坏、canonical page 损坏、latest backup 损坏，以及成功 forward migration 与 migration 中途失败。分别从同一 canary seed 建两份合成库：ordinary forget 库；privacy purge 库，其中 canary 明确写入 main DB/WAL/free pages/backups/projections/session/source 及 Host-owned presentation/pending 两张表的每类 reverse ref。另跨多日写入并中断一次 online backup，以验证创建原子性与保留策略。
- **观测：** free space/DB/WAL/backup size、写/查询/backup/restore p50/p95、quick/foreign-key/stream-head checks、dispatch count、schema version/恢复点 digest、backup 日期/数量/原子 rename、ordinary forget 前后 revision/event/head/检索/投影、purge delete manifest、两张 Host operation 表的 reverse-ref count、受控路径 canary 扫描与明确列出的不可控残留。
- **PASS：** archive/barrier durable commit 失败时 dispatch=0；容量策略只删可重建物，canonical/event 丢失 0；ordinary forget 后原 revision/event 行与审计内容逐字节保留、head=tombstoned、正常检索/投影命中 0；损坏索引可重建，canonical 损坏不原地修复；成功 forward migration 后 schema version 与全部冻结 invariant 通过，失败迁移保留旧库且迁移前恢复点可通过检查；online backup 仅在数据变化时每日最多一份、原子保留最近两份，中断产物不被标为可恢复；只从已验证快照恢复并标 `recovered_with_gap`，unknown-sent 自动重发 0；purge 后活动查询、所有受控副本以及 presentation/pending reverse refs 的 canary 命中分别为 0，外部不可控位置被列出。portable/CI 可测参数与目标平台真实宿主的 backup/repair 参数分别记录，未完成目标平台 sweep 时只冻结 portable 结论，不冻结该平台宿主参数。
- **分阶段 purge 补充验收：** 对逻辑提交前/后、每个受控 owner 删除前/后、删除成功但 ack 未落盘、敏感 continuation 删除后、WAL/free-page 维护前/后和完成 receipt 前逐点注入强杀、文件锁、只读/ENOSPC、权限或 file identity 改变。用其他进程/worker 尝试派生旧内容、恢复旧 snapshot、重新导出或 source expand。记录逻辑 receipt、批准 manifest、各 owner 实际文件 identity/ack、续做次数、残留扫描、无内容维护进度与完成事件。逻辑提交前失败无外部删除，提交后失败只能 incomplete 且目标/受影响流保持隔离；身份漂移不删替换资源，unknown 先查证，writer 不能复制旧内容，旧备份不能复活它。包括 continuation 自身、main/WAL/free pages/备份/source/Host 引用在内的全部后置条件齐备后才有 controlled-complete；未齐时不得通过。敏感 continuation 删除后再做数据库维护，完成事件只含不可关联字段；重启可凭无内容进度完成这一末段而不恢复 locator。Purge 期间 backup/bundle 不发布含旧内容或 continuation 的副本；损坏恢复缺清除进度时保持 blocked，不从清除前快照激活目标。
- **跨进程围栏：** A 准备 purge，B 在 fence 检查/登记间、append/临时文件/backup copy/最终 rename/缓存读取/dispatch 间暂停；C 同时启动新进程。记录 owner_fences epoch/phase、activity/process incarnation、真实 quiesce ack/进程及子任务退出证据、批准 manifest 与排空后闭包。检查与登记须原子，closing 后新增普通 activity=0；受限协调者仍可重显变化的 manifest/收取批准/取消，无自等待，普通写入口不能伪造 purge-control。故意仅让协调者 lease 过期但保留其进程/回调，第二协调者删除次数为 0；真实结束后可接管。未 ack 的 B 即使 lease 到期、心跳断开或 PID 重用也不能签完成，恢复后晚到写/发布被拒；无可信结束证据只 blocked。B 已完成产物若使 manifest 改变，A 必须重新展示批准，不扩大旧授权。已承诺受控 owner 失联不能降为“外部残留”假过；原本不可控者必须显式列出。全部旧活动排空且内容失效、按新 manifest 清理后可以完成并以新 epoch 正常读写；清理器自己崩溃、敏感 fence/activity/intent/Info 字段删除后仍由无内容 store fence 阻断并恢复末段维护。既有数据库活动不足以证明终止时保持 blocked，协调者显示/进度敏感数据也进完成扫描。清除后扫描所有这些载体的 canary=0；完成 receipt 与开放 fence 无半提交，恢复旧库/gap 不能开放旧活动。
- **Pi session/window quiesce：** 两个既有宿主进程持同一 synthetic owner/root：Pi 从首次 source 读取前持 session/window activity，另一 Core maintenance 协调者 closing。分别暂停在 transport 完成后/原生 message_end append 前、异步 session.subscribe callback、post-run continuation、独立 bash/compact/UI 延迟发布和 pending flush 失败处，并保留 editor undo/history/next-turn/provider cache canary。观测实际 append/派生/dispatch、受控 Promise/callback join、内容失效证据及 quiesce ack；能力未失效时 ack/逻辑删除为 0，旧 epoch 的晚到写/发布为 0。agent_end/settled/idle、clearQueue、dispose 或 setText(空) 单独成功不能签 ack；在被 Agent await 的 handler 中等待同一 run 应显式避免自锁。只有完整 join 加全部旧 window/cache 失效，或真实进程及子任务退出并检查残留后，才可重验 manifest 继续原清理；新 window/Info 不复活 undo/next-turn 正文。正常控制路径亦须完成，不能靠一直 blocked 通过。本项按原 X-12 真实宿主阶段验收，P0 仅冻结接口/释放条件和对应 synthetic 探针，不前置要求完整目标实现已完成。
- **receipt / 位置 / 平台：** `store-recovery-privacy@v1`；`RUNTIME/store/host`；portable 故障处理可由三平台 CI 验证；kill/ENOSPC 模拟不关闭目标用户环境下的恢复、backup/purge gate，Windows 真实宿主待实测，macOS/Linux 无宿主/未验证。
- **失败影响：** canonical durability、migration/backup 可恢复性或 privacy purge 后置条件 FAIL 重开 10/14；仅容量/时延参数失败则保持未冻结。

### X-13 · 三宿主 path/URL canonicalization 与 capability gate

- **权威主张：** 01 的 9-7 confirmed negative、09 §8、10 §2–3/28c；路径/URL 是不可信输入，能力与 resource owner 必须在模型外按宿主真实语义重验。
- **最小 fixture：** 各宿主真实临时目录内外文件；plain/percent/double-percent 编码、混合分隔符、dot segments、Unicode 正规化、大小写/drive-relative/UNC/file URL、symlink（Windows 含 junction）与不存在路径；至少含已知 `%252fetc%252fpasswd`。同一 payload 走完整 parse→normalize→policy→open 链，不用孤立 helper 自测冒充。
- **观测：** 每个 protocol boundary 的 raw/canonical bytes、decode count、realpath/owner root、policy reason、实际 open target、tool dispatch；不得在 receipt 复制秘密正文。
- **PASS：** 等价表示的 policy 结果一致；任何最终 real target 越过 owner root 均 dispatch=0；symlink/junction 逃逸、ambiguous/invalid encoding 与二次下游解码风险均 fail closed；允许路径确实打开预期 inode/file ID。对每个声明支持的平台分别判定；当前 Windows 目标平台必须真实宿主通过，macOS/Linux 在无宿主时保持 `unverified`，CI 只能验证 portable parser/fixture，不升级真实路径语义。
- **receipt / 位置 / 平台：** `resource-canonicalization@v1`；`COURSE/gate` 保留 known-bad，目标验收在 `RUNTIME/core/host`；每个声明支持的平台各一份真实宿主 receipt；CI 记录 portable checks，不替代目标平台真实路径语义。
- **失败影响：** canonical resource owner 或 capability gate 任一越界打开即重开 09/10，并阻塞该平台的文件/URL tool。

### X-14 · provider cache、延迟与成本的真实边界

- **权威主张：** 07 §8–10、09 §9/15；上下文按稳定→易变排序以利用 provider cache，但安全/正确性不依赖 cache；`assembly_id` 随 route/model/正文/tool schema 等非 attempt 字段改变，`cache_epoch` 是独立的逻辑失效代际；阈值必须按真实 provider/model 测量。
- **最小 fixture：** 13 选定的每个 provider/model 各做配对调用：完全相同 P0/P1 + 改 P3、相同 epoch 第二次调用、切换 P1 epoch、仅改 tool schema/order、同 payload retry 与 route/model 改变；固定输出任务与网络时段，保存 canonical request hash。
- **观测：** P0/P1 prefix bytes/hash、assembly ID 与 cache epoch（分列）、provider reported cached/input/output tokens、TTFT/总时延/费用、route/model、response/tool-call correctness；provider 不暴露 cache 指标时记录 `unsupported`，不得由时延反推命中。
- **PASS：** 未变 epoch 的稳定 P0/P1 前缀字节差异 0；P3-only 正文变化创建新 assembly ID，但允许保持同一 cache epoch；P1 baseline 变化必须开启新 epoch 并创建新 assembly ID；provider/route/model/auth namespace 变化必须开启新 cache epoch 并创建新 assembly ID；影响 P0/P1 或 cache namespace 的正文、tool schema 或顺序变化必须换 epoch，其余变化至少换 assembly ID；同一完整 assembly payload 的 transport retry 只增加 attempt ordinal，不换 assembly ID；安全/预算/capability 结果在 cache on/off 间差异 0；只有 provider 指标明确显示命中才可声称 cache 有效。延迟与成本门槛由 13 在真实 provider 数据上冻结，12 不预填数字。
- **窗口/指令更新补充验收：** 加入 fresh window 有/无相同 P0/P1 namespace、生成但未选中的 compartment、任务结束释放 Skill、policy/AGENTS/tool binding 更新及 emergency invalidation。观测 Euler window identity/ordinal、baseline、epoch、lifecycle append/flush 与实际请求顺序。fresh window 一定有新 window ID；只有字节/namespace 相同且 provider contract 允许才复用 epoch；未选 compartment 不换 epoch，已选 baseline 或生效指令变化按 D5.5 换 epoch。Emergency 的 durable invalidation 必须早于后续 dispatch，持久化失败 dispatch=0；已发送 payload/旧 receipt 不改写，不把 provider handle 当 Euler window。
- **receipt / 位置 / 平台：** `provider-cache@v1`；`RUNTIME/core`；每个目标 provider/model 必测，Windows 待实测，macOS/Linux 无宿主/未验证；CI 不适用真实 cache/网络时延。
- **失败影响：** assembly identity、cache epoch 或安全/正确性依赖 cache 的 FAIL 重开 07/09；仅命中率/TTFT 收益不足则保留正确路径、参数交 13 重定。

### X-15 · content-addressed bundle 跨宿主往返

- **权威主张：** 10 §9/22/26/28；导出必须显式 selector，bundle 为 versioned manifest + events + blobs，导入幂等且保持 origin，远端内容仍按 candidate 重验。
- **最小 fixture：** 以三平台 GitHub Actions runner 或目标真实宿主构成最小环路 `Windows export → macOS import/re-export → Linux import/re-export → Windows import`；每个平台至少一次作为 exporter 与 importer。初始内容为两 project/一 personal/一显式 session ledger；分别测试无 selector、仅选 record、选 project、选 session。对 manifest/blob/event 做删改/重排，再重复导入同一 bundle；各目标库预置同 subject 不同 origin/有效期冲突，并包含已 purge canary。
- **观测：** 每一跳 manifest/文件 hash、依赖闭包、event_id/origin_host_id/origin_seq、导入前后 row diff、candidate/verification/conflict、heads/projection/job 是否被传输，以及 import→re-export 前后 canonical event/origin/依赖闭包 digest。
- **PASS：** 无 selector 拒绝；未选 owner 正文泄漏 0；任一 hash/缺件错误时 mutation=0；重复导入新增 event=0；heads/projection/job/lease 不导出；导入内容不直接 active，冲突双方保留且不按机器时间覆盖；purged canary 不进入 bundle；每一跳 import→re-export 后 canonical event/origin/依赖闭包 digest 不变，环路结束的内容与初始选择闭包相同。
- **导出 owner 边界：** 同库再含 job/maintenance/migration streams、intent/fence/activity、host-info job；原有 record/project/session selector 不得隐式导出这些运行状态或复活待执行批准。仅显式 owning session 可携带其 ledger；目标仍可复算选中 canonical/provenance 闭包且重复导入不增 event，已 purge 的 refs/hash 不得因其他 stream 关联混入。
- **receipt / 位置 / 平台：** `bundle-roundtrip@v1`；`RUNTIME/store`；portable manifest/hash/幂等格式与跨 runner 往返可由 Windows/macOS/Linux GitHub Actions matrix 验证；依赖真实用户环境的 Host/filesystem 行为仍需目标平台真实宿主；当前 Windows 待实测，macOS/Linux 无宿主/未验证。
- **失败影响：** owner selection、event/origin/依赖闭包、幂等或 purge 排除 FAIL 重开 10，并阻塞跨宿主导入/导出。

## D7 migration gate（复用统一 receipt）

该组是 13 D7 已定要求的验收展开，不增加 X-card 或实验框架；与 X-06/X-12/X-14 的已有工具与原始证据复用，三轴仍分别判定，当前全部 `未证实`。

| gate | 最小 fixture / 观测 | PASS 与失败影响 |
|---|---|---|
| Source audit/rebuild | 合成 MC/raw archive 含有效、缺失、错 hash、旧 active/unverified、scope 未映射和重复来源；读取一致事务 snapshot，记录 locator、事务边界、schema head、计数、mapping policy/digest；逐 candidate 保存 snapshot/raw locator/hash/origin/mapping reason/初始状态及转换 receipt | 相同 snapshot/policy/source identity 重放不增 event；缺字段或来源不可信不晋升，MC memory 行不直接转 verified，scope 不由路径猜测；MC 数据/缓存/请求字节无变化。真实 source audit 仅只读，不将生产副本拿来故障注入 |
| Staging/shadow | 启动时记录 app-id/run/scope、store 路径/file identity、可写表族和证据目录；分别注入与 MC/live store 同文件别名、未授权路径、校验失败和准备库损坏，观察实际写集合与 candidate/verification/head/projection/attempt | 写入只在声明准备库/证据位置；别名或身份未知禁写，失败不改/删 MC/live/source；shadow 输出不改线上请求，无 live hook 或越权副作用。准备库启用只绑定已验的数据身份与资格，不重新提取绕过 gate |
| Runtime prerequisite | 在 staging 与首次 live 前验证 intent/stream owner、Info outbox、owner fence，以及受控 Pi loader/settings/tool wrapper/transport 的实际接线；夹入旧 epoch/额外 extension/未封存 API | 只有 P0 契约与对应 X-01/04/05/06/07/10/11/12 证据齐备才进入实际受影响能力，准备库或旧 Pi receipt 不能替代；不支持模式明确 unavailable |
| One-way owner commit | 在 quiesce/MC 退出、owner+epoch+lifecycle 事务前/中/后、Euler hook 注册、canary assembly/started/finished 各点崩溃；另测 owner receipt 缺失/损坏/快照 gap、旧启动配置、重复切换与双 hook | owner/epoch/receipt 无半提交；完整证据证明未提交时才可取消并在互斥重验后启动 MC。提交后首次 canary 失败也不回 MC；启动先读 durable owner，缺/unknown/gap 不推断 MC；barrier 未完成不发请求，unknown-sent 不重发，旧配置不能覆盖 owner。任一反例阻断对应 capability/host cutover |

D7.5 的 workload、control baseline、quality rules、overhead budget、阈值封存与配对结果需附同一证据包；先完成切换前 hard gate 和阈值，再按 D7.4 提交 owner、执行首个 live canary，通过后才能扩围。Canary 失败是已提交 Euler 的隔离/修复结果，不是取消提交的许可。

## 新实验的三轴状态（本票结算时）

| ID | source mechanism | stored receipt | independent validation | 当前证据等级 | 平台门禁 | CI |
|---|---|---|---|---|---|---|
| X-01 | target DDL/transaction 尚未实现 | 无，待 `store-schema@v1` | 必须从 DB/raw transaction 重建 | `未证实` | portable checks：Windows/macOS/Linux CI matrix；真实数据根/用户权限/宿主行为：Windows `待实测`；macOS/Linux `无宿主/未验证` | 可验证 portable SQLite/transaction，不关闭真实宿主项 |
| X-02 | lexical/CJK 教学机制 partial；target FTS 未实现 | 无，待 `retrieval-heldout@v1` | 冻结 60 用例四模式 + 新 held-out | `未证实` | portable FTS/CJK：Windows/macOS/Linux CI matrix；Host-dependent 集成按目标平台另验 | 可验证 target SQLite/FTS 与检索 fixture，不关闭 Host-dependent 项 |
| X-03 | MC/Trivium 仅供借鉴；target worker 未实现 | 无，待 `projection-recovery@v1` | 故障注入后 canonical 双向复算 | `未证实` | portable worker/SQLite：Windows/macOS/Linux CI matrix；本地文件/恢复另按目标平台验 | 可验证 worker 状态机，不关闭 Host/filesystem 项 |
| X-04 | `context.ts` 有小 fixture；target Orchestrator 未实现 | 无，待 `context-admission@v1` | 从 archive/prompt bytes 复算 | `未证实` | portable Core/transport：Windows/macOS/Linux CI matrix；真实 Host dispatch 另按目标平台验 | 可验证 Core/transport stub，不升级 Host 状态 |
| X-05 | 09 为规范；target gate 未实现 | 无，待 `context-isolation@v1` | 从 rejected/selected/raw dispatch 复算 | `未证实` | portable Core gate：Windows/macOS/Linux CI matrix；真实 resource-owner/path 集成按目标平台验 | 可验证确定性 gate，不代替 Host resource owner |
| X-06 | Pi callback 只证明边界；target ledger 未实现 | 无，待 `dispatch-barriers@v1` | 独立 transport request counter | `未证实` | portable barrier/ledger：Windows/macOS/Linux CI matrix；真实进程/文件系统恢复按目标平台验 | 可验证逻辑杀点，不关闭真实进程/宿主项 |
| X-07 | `memory.ts` 状态机 partial；target pipeline 未实现 | 无，待 `memory-lifecycle@v1` | Verifier 自行 source search/expand | `未证实` | portable Core lifecycle：Windows/macOS/Linux CI matrix；Host adapter 集成按目标平台验 | 可验证纯状态机，不升级 Host 状态 |
| X-08 | book 有 negative/FAIL；target evolution 只允许 inert | 无，待 `evolution-heldout@v1` | baseline/treatment + untouched held-out | `未证实` | 纯知识 fixture `不适用` | 可验 schema/gate；held-out 仍由独立 owner 执行 |
| X-09 | 11 只有单页 prototype；target trust boundary 未实现 | 无，待 `memory-operations@v1` | 从 canonical rows/delete manifest 复算 | `未证实` | portable Core/store reducer：Windows/macOS/Linux CI matrix；Host presentation/filesystem 集成按目标平台验 | 可验证 reducer，不代替 Host/store 集成边界 |
| X-10 | Pi surface source 已证实；adapter 未实现 | 无，待 `host-state-machine@v1` | 每宿主消费者/owner entry 独立核验 | `未证实` | 每 adapter：Windows `待实测`；macOS/Linux `无宿主/未验证` | 可验 protocol mock，不证明真实 UI/消费者 |
| X-11 | continuation/首轮未 flush 仅设计 | 无，待 `host-continuation@v1` | crash 后从 Host store 与输出流复算 | `未证实` | 每 adapter：Windows `待实测`；macOS/Linux `无宿主/未验证` | 可验证 portable pending/ordering 检查，不关闭目标用户环境的进程恢复/消费者项 |
| X-12 | Windows SQLite 基线 partial；target recovery 未实现 | 无，待 `store-recovery-privacy@v1` | raw DB/WAL/backup/路径扫描 | `未证实` | Windows `待实测`；macOS/Linux `无宿主/未验证` | 可验证 portable 故障处理；kill/ENOSPC 模拟不关闭目标用户环境的恢复/backup/purge 项 |
| X-13 | Windows double-decode 已知负例；target gate 未实现 | 无，待 `resource-canonicalization@v1` | 实际 file ID/realpath + dispatch counter | `未证实` | Windows `待实测`；macOS/Linux `无宿主/未验证` | 可跑字符串负例，不代替真实路径语义 |
| X-14 | prompt prefix 设计已定；provider 效果未测 | 无，待 `provider-cache@v1` | provider usage + request bytes | `未证实` | 目标 provider/model 所在 Windows `待实测`；macOS/Linux `无宿主/未验证` | 真实 provider cache/网络时延 `不适用` |
| X-15 | bundle 结构只在 10 定义；target exporter/importer 未实现 | 无，待 `bundle-roundtrip@v1` | 跨宿主从 manifest/events/blobs 复算 | `未证实` | portable bundle：Windows/macOS/Linux CI matrix；Host/filesystem 集成按目标平台真实宿主；当前 Windows `待实测`，macOS/Linux `无宿主/未验证` | 可验证格式、hash、幂等和 runner 往返，不关闭真实宿主项 |

`source mechanism` 一列出现“已有”只表示可借机制；只要 target 路径仍未接线，本行就不能升级为 target PASS。执行后也必须分别更新三列，禁止只改一个总状态。

## held-out 与反作弊纪律

1. fixture schema、case IDs 与判定阈值由实现者可见；held-out payload 由独立 verifier owner 在实现工作区外封存，先记录 sealed commit/digest，再记录被测 implementation commit，之后才 release 给 verifier。receipt 必须引用 held-out owner、sealed/released commit；任何提前访问或按 case 改码都记录 contamination IDs，将该 case 降级为 dev，并由 owner 补入 replacement IDs 后重新封存。没有可核验的封存/释放顺序时只能 `evidence-gap`。
2. proposer 不得选择 verifier 看到的 evidence；verifier 从 immutable source locator 自行 search/expand。无法独立取证时只能 `evidence-gap`，不能拿 proposer 摘要补齐。
3. baseline/treatment 从同一 checkpoint 启动，一次只改一个 object；首个可判定输出与所有失败都入 raw artifact，不能只保存最终成功 run。
4. known-bad、rejected、negative-transfer candidate 保留在隔离层以证明门禁，不注入正常 prompt；retention 用例必须同时含“仍然有用而保留”和“内容为真但产生负迁移而拒绝”两类。
5. 安全/隐私门禁以 0 次错误放行作为 PASS；开放语言不确定时 fail closed/要求重述可接受，但不得进入相反方向或更破坏的操作。正常支持的 canonical 短语必须全部正确路由。
6. 对模型调用记录真实 provider/model、request/response/tool-call hash；temperature 0 也不称确定性。硬安全结论必须由 Host gate 保证，不能靠重复采样得到低误判率。
7. current MC 生产 DB 只允许 `mode=ro` 读取计数来定 fixture scale；所有破坏、迁移、purge 与 corruption 实验使用合成库，禁止复制生产 DB 后对其宣称一致快照。
8. probe 只打印判定所需字段；raw 大对象按 owner 保存并以 locator/hash 引用，既避免泄密，也防长输出截断后伪造完整 verdict。

## 执行顺序与失败处置

1. 13 先冻结 `app-id`、schema v1 前的 disposable 边界、`RUNTIME/*` 具体路径与 receipt schema；随后冻结所有 fixture digest，不能边实现边改 held-out。
2. 先跑纯确定性层：X-02/X-04/X-05/X-07/X-08/X-09/X-13 的 course 部分；它们不能替代 runtime 测试。X-08 仍按独立课程票完成全部正向改善、held-out 零回归和负迁移效果验收，不列入 P2 target runtime gate；运行时安全门禁不得借用课程 PASS 关闭，阶段归属以 13 D8.2 为准。
3. 再跑存储与 dispatch 基座：X-01→X-03→X-06；任一 durable/identity/ordering FAIL 时停止上层写路径。
4. 再跑记忆与宿主集成：X-07 及 X-09/X-13 的 Core 部分在 P2 实施，Host-dependent 部分在 P3 实际接线后补齐，不把子门禁通过当整卡 PASS。X-10→X-11 表示先正常呈现/批准、再故障恢复的执行顺序；逐 adapter、目标平台须 `X-10 ∧ X-11` 才可关闭写门禁，分别保留 receipt。JSON continuation 及 X-09 的真实模型/Host 重验、X-13 的真实文件访问链，均须相应目标宿主证据齐备才能升级该平台生产支持；共享 Core 部分由三平台 GitHub Actions matrix 回归。
5. 最后跑物理恢复/容量、跨宿主 bundle 与真实 provider：X-12→X-15→X-14，再完成上述 D7 migration gate 的切换前证据；X-14 测量与 13 D7 control baseline、预注册阈值衔接，最终性能/成本门槛在 canary 前判定，不要求先性能 PASS 再取得 baseline。性能数字只能在 correctness 全绿后用于替换门槛；X-09 的受控真实模型验证不因 X-14 后置而延期或改用 mock。
6. macOS/Linux 无真实宿主时，相关 Host-dependent 行保持 `无宿主/未验证`，但共享 Core 与 portable 行可由 GitHub Actions matrix 验证；Windows 真实宿主、CI 结果、源码同构和其他平台 CI 不能合并成 macOS/Linux 真实宿主 PASS，也不阻塞 Windows-first v1。
7. FAIL 若会改变已冻结 owner、durability、privacy、authority 或安全边界，先重开对应 resolved ticket；不得只改 fixture 直到实现“通过”。纯参数失败只把数值保留未冻结，交 13 用真实数据拍板。

## 覆盖闭包与 Handoff

- 01 强制项：知识产物负迁移、known-bad/retention、receipt/sidecar、路径双解码分别落 X-08/X-13；9-2、9-6/7/9 已按 negative/FAIL 登记而非抹平。
- 09 故障矩阵：预算/ReAct/source 在 X-04，scope/injection 在 X-05，receipt 不进 prompt 与两道 barrier 在 X-06；无遗漏。
- 10 故障矩阵：DDL/query/CJK/outbox 分别落 X-01/X-02/X-03，容量/backup/recovery/purge 落 X-12，bundle portability 落 X-15；portable 部分使用三平台 CI matrix，Host-dependent 部分按目标平台保留真实宿主门禁。
- 14 故障矩阵：Host DDL 在 X-01，状态机在 X-10，pending/首轮未 flush/JSON continuation 在 X-11，purge reverse refs 与 crash repair 在 X-12。
- 13 接线时必须把每个 `RUNTIME/*` 映射到真实路径并建立上述 receipt；课程类 X-08 与共享 held-out 的扩充另开实验执行票，不扩大 13 的生产 v1。
- 13 增量覆盖：D1 fallback/真实模型 receipt 在 X-07；D4/D5 raw compartment/window 在 X-04/X-14；D6 guidance/Skill/MCP 在 X-04/X-05/X-10；D7 source/staging/owner commit 在独立列明但复用原证据的 migration gate。Source/archive 的 P0 HostAdapter contract 由 X-04/X-09/X-12 检验。
- 本轮八项闭包：intent 在 X-01/04/05/11，显式 stream owner 在 X-01/06/07/12/15，Info activation/outbox/ack 在 X-01/07/10/11，tombstone/suppression 在 X-07/09/12，fence/activity 在 X-01/06/12，MCP discovery 在 X-05/10/14，Pi runtime/扩展/transport 在 X-04/05/06/10 与 D7 prerequisite。表族、API 和最小故障探针先在 P0 冻结，P1 持久化先于 P2 行为，P3 接线与 P4 物理验收仍按原依赖完成，不把 source API 的存在当 target PASS。
- 本票不新增生产代码、不执行实验、不冻结无数据的性能数字，也不把任何待实测项写成 PASS。矩阵完整性独立复核通过后，12 才可改为 resolved 并解除 13 的 blocker。
