# 建立设计证据与课程待补实验矩阵

Type: task
Status: resolved
Resolution scope: 设计矩阵已定案；resolved 不表示本次修订已通过独立复审，也不表示任何目标运行证据已完成。各 X-card 的运行状态单独记录。
Blocked by: 01, 02, 03, 07, 08, 09, 10, 11, 14
Scope: 定义实验与通过标准（含复刻位置），不在本票跑完全部实验；平台覆盖按 portable CI 与目标宿主高风险行为分层。

## 2026-09-09 首次切片与后续子项

本矩阵保留 X-01–X-15 身份，不新增验收框架。总范围只引用 [15 I01](15-euler-v1-spec.md#v1-scope)，阶段依赖见 13 D8。X-04/X-05/X-10/X-11 在卡内分为首次 CLI 必测与后续能力/模式启用前追加；执行报告按 capability/adapter/mode 和适用子项记录 PASS/FAIL/evidence-gap/deferred。共享不变量不能后置；能力/模式专属子项只阻塞对应能力/模式启用，deferred 及局部通过均不得记作无范围限定的整卡 PASS。

X-01 是 X-03/search 与 X-06/ledger 的共同依赖，两者可以并行；X-14 只依赖受控 transport/ledger/相关 Core gate，不依赖 X-15。真实数据仍须首次已启用路径的存储、Host、backup、维护模式 purge 和恢复全部通过。P0 固定契约与失败语义，disposable DDL/有界参数可随测试调整，首次真实数据前才冻结初始生产迁移。后续切片先完成增量清除/恢复，再启用。旧课程/源码证据保留历史身份，不作为本次修订 PASS。

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
  - Pi 对应模式启用前追加首轮 extension command/entry 未 flush（`_persist` 的 no-assistant guard）用例：presentation 顺序和 owner receipt 以 Host-owned 记录为准，崩溃后可恢复或报缺；缺宿主呈现确认时完整重显。不作为首次 CLI 的 Pi 依赖。
  - JSON 模式启用前追加跨进程 continuation：同 session preview→commit 跨 invocation 的 pending durability、token 和事件顺序；未通过不得开放 JSON 写路径，CLI 自身的重启恢复另按 X-11 通用组必测。
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
- **Inert proposal 存储：** 验 storage-owned identity、target/expected change/owner/scope/evidence refs、版本化 evaluation 建议、完整 digest、修订追加与 purge reverse refs；不存在运行行为评估或发布的入口，不要求 sealed plan/attempt/result 表族。Memory verification_runs 仍须通过独立证据和状态约束。
- **receipt / 位置 / 平台：** `store-schema@v1`；`RUNTIME/store`；portable schema/transaction/SQLite checks 使用 Windows/macOS/Linux GitHub Actions matrix；真实数据根、用户权限与宿主特有行为当前 Windows 待实测，macOS/Linux 无宿主/未验证。
- **失败影响：** 库 owner/app-id、append-only/CAS、pending domain 或 durability FAIL 重开 10/14；仅 query plan/容量参数失败则值保持未冻结，交 13 重测。

### X-02 · eligibility + FTS/CJK held-out 检索

- **权威主张：** 09 §1–5、10 §12–17；硬过滤先于排名，CJK 2-gram 为 v1，单字 fallback 由证据决定，弱命中可返回空。
- **最小 fixture：** 在目标仓库建立并冻结本地需求覆盖语料：中文单字/两字/长词、Latin/数字、精确/纯同义/弱近邻、跨 project、stale/conflicted/superseded/tombstoned、同 claim 不同环境/时间。登记 case IDs、来源、gold/判定规则与 digest，调参集与 held-out 分离；历史 `ai-agent-book` 60 用例取得 immutable locator 后可追加，不是开跑硬前置。缺原套件如实登记覆盖差异，不能假称复用，也不能在看到结果后更换 gold 或删失败 case。
- **观测：** 每 lane 候选、硬过滤 reason、BM25/RRF、canonical recheck、selected/rejected refs、token cost、query/index tokenizer version。
- **PASS：** eligibility 违规 0；受支持的精确/CJK gold 全部进入 candidate lane 且 current 去重正确；纯同义无强 lexical 证据时返回空/慢路径，不得注入错误近邻。单字 fallback 只有在全部单字 gold 召回且非单字 gold 排序零回归时才采纳，否则明确不支持并走慢路径。
- **任务级发现 fixture：** 同 owner 下多个已登记项目、一个未授权项目、一个不可用但允许披露状态的项目；在无 cwd 项目绑定的会话中显式请求跨项目分析，再做连续查询、分页、目标环境未知/与当前宿主不同、权限撤销和任务切换。另有普通局部请求及仅模型自报全局范围的拒绝对照。记录实际读取集合、授权/intent 版本、目标环境、覆盖/截断和继续状态；获准相关结果可返回，未授权名称/摘要/正文泄露为 0，任务结束/撤销后旧 cursor/ref 不能继续扩大查询。环境未知只给待核验参考，不能进入自动事实注入。
- **receipt / 位置 / 平台：** `retrieval-heldout@v1`；`COURSE/memory` 复刻纯检索，目标验收在 `RUNTIME/store`；三平台状态同 X-01。
- **失败影响：** scope/lifecycle/source-integrity 硬过滤或 CJK 可检索性 FAIL 重开 09/10；仅排序/时延阈值失败则阈值保持未冻结，交 13 调整。

### X-03 · projection outbox、租约、lag 与重建

- **权威主张：** 10 §12–18；首次只验 canonical/outbox 与实际 search/FTS worker，旧 job 不覆盖新 head，损坏或 backlog 超限可降级重建。Overview 为后续独立子项，正文在 SQLite，不要求外部文件发布/pin/GC/同 hash repair。
- **最小 fixture：** search job 乱序/重复、claim/upsert/watermark 崩溃、lease 接管、hash 失配、FTS 损坏与 tokenizer 升级。规模先用明确记录的有界合成数据；取得只读 MC 规模基线后再补倍率测试，不复制生产正文、不让未知旧库计数阻止功能测试。
- **观测：** job/revision/generation、lease/process identity、watermark、backlog、canonical↔search 双向 diff 与重建查询 digest；测 batch/lag，不预设最优值。
- **PASS：** stale 覆盖 0，重复/接管幂等，dirty/rebuilding/failed 可见且不用旧投影伪称最新，重建后双向 diff 为 0。参数使用有界可配置初值；平台结论和性能保证分列，不把调参失败变成身份/数据完整性通过。
- **Overview 后续子项：** 同事务提交 body/refs/generation/cursor 的各语句间崩溃，交错 input/head/owner/scope 变化与过期 worker；无半正文或越过缺口的 cursor。缺失/损坏使版本不可注入，重建成功产生新 identity/hash，旧 receipt 不改写。已被 assembly 引用的历史正文不得普通回收；缺原字节时 inspect 报缺，不用新摘要代替；purge 清理历史与 refs。另有正常 publish/read 与失败后新版本可用对照。

- **receipt / 位置 / 平台：** `projection-recovery@v1`；`RUNTIME/store`；三平台状态同 X-01。
- **失败影响：** outbox/lease/条件更新/重建或 canonical/search 边界失败阻断该首次能力；overview 子项仅阻断 overview，除非暴露共享不变量缺陷。未来文件投影不计入本卡首次 PASS。

### X-04 · context admission、完整 ReAct 与 source recovery

#### 首次 CLI 必测（后续宿主复用）

- **权威主张：** 07 §2–3/5–16、09 §9–12；唯一 Orchestrator 先归档再卸载，每次调用前硬预算，完整 ReAct 不可拆；本地检索有 deadline、后台工作不阻塞快路径且普通路径只调一次主 LLM；证据不足时由主 Agent 自身工具慢路径恢复，不新增 router/RAG Agent；原文恢复必须校验 locator/hash。
- **最小 fixture：** 含多组 assistant tool-call/tool-result、超大 tool result、弱相关 memory、近重复/可重建内容、非 pinned memory/source、当前错误/参数、已准备/未准备 compartment 的轨迹；用相同 mandatory 输入分别制造只需去弱相关/近重复/可重建、再减非 pinned memory/source、再切已准备 compartment、最后需先归档后分页/分块的四级压力。另分别注入 mandatory 恰好等于/超过 context limit、archive 写失败、source hash 失配，以及 09 §12 每类 recovery 触发条件（明确原话/行号、当前行动缺参数/错误、memory provenance 指向原文、stale/conflict、projection 不足）与 projection 已足够的无需恢复对照。P0/P1 相同，仅改变 P3 后缀再组装一次。再造快路径场景：本地 memory top-k 超 deadline、compartment 生成/candidate 提取/FTS-projection worker卡死或报错，以及证据不足需进慢路径的请求。
- **观测：** P0–P3 bytes/hash/token、mandatory/selected/reserve/margin、每次 degradation step 的输入类别与顺序、archive receipt、保留的完整 ReAct ranges、recovery trigger/reason/locator/hash/excerpt；另记快路径内主 LLM 调用次数、同步阶段含的工作项、本地检索 deadline 命中/超时、慢路径的发起者与工具序列。
- **PASS：** 每次已发送请求均满足预算不等式；tool pair 拆分 0；未归档成功或当前行动仍需精确值的内容卸载 0；mandatory 超窗明确拒发；hash 失配只返回证据缺口并标 stale；同 epoch 的 P0/P1 逐字节相同，动态变化只影响短后缀。降级必须按 fixture 所需层级依次为：弱相关/近重复/可重建 → 非 pinned memory/source → 已准备 compartment 的完整 ReAct 边界 → 已归档单条的分页/分块，跳级、逆序或卸载 mandatory 均 FAIL。09 §12 的每类触发条件都进入有界 recovery，projection 已足够的对照 recovery 次数 0。快路径另要求：本地检索超 deadline 即放弃候选而不阻塞；异步工作卡死/报错时快路径仍完成且主 LLM 调用次数恰为 1；慢路径由主 Agent 工具发起，额外 router/RAG Agent 调用次数 0。任一反例即 FAIL。
- **D4/D5/D6 与 archive 补充验收：** 在 CLI 的实际 source carrier 上测试同一 raw range/job 重放、Historian 输出失败、archive 已 flush/job 未提交后重启、首轮仅保留内存而未 durable 的负例、缺 ack 与未知 append outcome；观测 owner/event identity、实际 durable ack、range/raw/compartment hash、生成次数与 source→job/dispatch 顺序。相同 identity+bytes 幂等、异内容冲突，未确认归档时 dependent job/卸载/dispatch 均为 0；重启只补缺 job，不重复 source。正常首轮必须在模型请求前取得可重启复读的 source ack。同一 range 不重复有损生成，不以旧 summary 为输入，失败不落半成品；compartment 覆盖冻结的 mandatory decision/result/citation。再测无新摘要的 fresh window、所选 compartment baseline 切换、已加载 Skill 的同任务复用/换窗重装/失效：记录 first/previous/current/ordinal、lifecycle receipt、snapshot、P0 正文字节与 hash。窗口身份连续可复算，准确 Skill 正文和顺序完整，预算不足只报 unavailable，不截半份；临时未调用或仍适用的换文件不卸载，明确任务结束或失效才从下一 assembly 移除。archive/purge 后的 source.search/expand 返回缺口而非残余正文。
- **Intent 连续性：** 无外部 todo 的新 CLI 任务、外部 provider 不可用、分支恢复、缺失/损坏 head、模型伪造 transition、任务中途仅请求状态、合法改目标，以及 assembly 后 intent 版本变化分别入 fixture。观测真实输入身份、intent event/head/version、intent/session/branch identity、goal/constraints/scope/step/status、input locator/hash、恢复结果、assembly intent hash 与 dispatch。正常新任务有 durable 最小 intent，未换目标保留原目标，授权外的转向/扩权为 0；本地有效 intent 不因外部 todo 离线被清空。恢复按 events/CAS，不从 memory/summary 猜目标；缺证保持 needs-input/unavailable、相关副作用为 0。新旧分支不倒拨同一 intent 版本；已失效 assembly 不发，明确合法 transition 后新 assembly 可正常完成。
- **Bootstrap/累计预算与恢复正常：** 空库经真实 Host 输入建立 owner、project/root 绑定、durable input 和 intent 后能完成正常请求；未绑定且无有效任务级只读授权时 session-local 问答/绑定/诊断可用，不能跨项目读写；有明确分析授权时可从已登记获准项目建立只读任务，但仍不得操作其资源。构造不断调用工具、source-expand、重试与换窗的 run，达到累计 attempt/tool/token 或成本/deadline 限制后停止新增调用；工具超时和用户取消有终态，迟到结果不自动触发新工具/memory mutation，重启不重置旧用量或 unknown。明确新授权后可创建关联旧记录的新 run，合法任务能完成，不能靠永远 blocked 通过。
- **跨项目分析与交接接线：** 使用冻结能力描述和多个合成项目，真实 provider 通过受控工具完成需求查询→获准候选→证据展开→报告/项目提案保存；不联网核验新模型能力或读取真实项目材料。结束该任务，在另一个目标项目的新会话按问题找到其获准交接材料并继续分析；另测同任务换窗、临时 handoff 文件删除、旧来源变化和不可读引用。新会话不继承旧全局读权限，只读该项目获准材料；归档正文版本/hash 可复读，必要缺口明确，实施前核对当前条件。无任何 handoff Skill 时正常路径仍成立，只有保存/交接授权时外部发布和代码修改次数为 0。检索 primitive 通过不能替代本组真实接线；报告/提案持久行为同时按 X-07 验收。
- **receipt / 位置 / 平台：** `context-admission@v1`；`COURSE/context` 复刻纯函数，目标验收在 `RUNTIME/core`；三平台状态同 X-01。
- **失败影响：** 单一 Orchestrator、预算、ReAct 完整性、先归档后卸载或 recovery 边界 FAIL 重开 07/09；仅 deadline/预算参数失败则交 13 以真实数据重定。

#### 后续模式启用前追加

- **适用与联合门禁：** 每个后续模式在实际 source/dispatch 接线上复验上述通用不变量，并与该模式 X-10/X-11 证据合并；共享 Core 证据可按相同实现/fixture 复用，不能复用 CLI 的 Host 结果。未启用模式记 deferred，不阻塞首次 CLI。
- **Pi 首轮 source 接点：** 启用使用 Pi source carrier 的模式前，按 13 的 Pi 公开 API 边界测试原生未准备 manager 的无 assistant 负例、受控排他预建/公开 open 后的正常首轮，以及合法 header/完整分支重绑。观测真实 session/file identity、raw-event 与 native entry 映射、append/fsync/严格复读/ack/job/dispatch 的顺序和次数；同一逻辑事件不得因两个表示重复捕获。正常首轮可在无 assistant 时获得合格 source ack，并完成原单主调用路径；缺失、失败或未知 ack 时 dependent job/卸载/dispatch 均为 0。只看 flushed、getLeafId/getEntry 或 message_end 通知不算通过。Pi 切片的 synthetic 探针不替代实际模式接线及 X-12 的真实宿主 durability；失败关闭该模式相关 dispatch，不因未实现 Pi 而判 CLI 失败。

### X-05 · scope/conflict/injection/provider 数据隔离

- **权威主张：** 09 §1–8；active project 由 intent/resource owner 验证，stale/conflicted 只给状态标记，memory/source/provider response 永远无 instruction/capability 权限。

#### 首次 CLI 必测（后续宿主复用）

- **最小 fixture：** primary/affected/未触碰 project、workspace/personal、同 claim 不同 project/host/time；默认单项目请求必须解析出 primary project，并让适用与不适用的 workspace/personal 对象同时存在。显式构造 intent/task、实际 resource owner、manifest 与 tool path 一致及互相冲突的项目归属，让 `affected_project_ids` 含未被这些证据验证的项目，并加入项目身份仍未解析的请求与明确跨项目请求。正文包含伪 system/tool/approval/credential 指令；远端 provider 在正文与 metadata 中返回 system/developer/tool 字段、超长字段及 hash 错误。
- **观测：** active_project_set 及其 intent/task、resource owner、manifest、tool path 四类来源证据，workspace/personal eligible/rejected reason、最终 envelope role/bytes、capability/policy decision、实际 tool dispatch 与 provider 白名单字段。
- **PASS：** 默认单项目请求的 active_project_set 恰含已解析 primary project；适用的 workspace/personal 对象正常参与 eligible set，不适用对象被硬过滤。新增 project 必须有 intent/task 与真实 resource owner 依据，且 manifest/tool path 与之不冲突；任一来源冲突时 fail closed，不静默扩大。`affected_project_ids` 单独出现时扩大 active set 次数 0；未解析项目且无有效任务级只读发现授权时只使用 session-local context；明确跨项目操作请求只加入上述证据验证的项目，返回结果保留 project 标签且跨项目 claim 折叠次数 0；未获准作为本任务操作目标或只读发现目标的 project 正文进入 prompt 次数 0。candidate/rejected/tombstoned 正文进入正常 prompt 次数 0；stale/conflicted 只出现有界 marker；任何数据字段改变 policy、tool schema、审批或 credential scope 次数 0；未知/超长/hash 错字段均丢弃或 fail closed。
- **只读发现与操作隔离：** 对同一显式分析请求，记录任务级读取集合及原操作 `active_project_set`，测试目标环境与发起宿主不同、环境未知、任务结束/权限撤销与旧 cursor/ref/已冻结 assembly 的重用。获准发现不加载目标项目 AGENTS/Skill、不开放写入/分享/发布、不改 memory scope；引用和报告链接不能穿透到未授权项目。撤销先于后续 admission 时旧候选不发送，任务结束后普通局部请求不重用跨项目集合；同任务合法查询与有界展开可连续成功。交接材料中的“已批准”或 `suggested skills` 不成为新任务授权或技能激活信号。
- **D6 Core 隔离与本地 guidance：** 用本地合成目录测试 AGENTS/Skill 的同名多 scope、显式 ref、source/hash 变化、缺失来源和有界展示；观测 active scope/owner、guidance channel/snapshot/hash、默认及显式绑定、实际 Core/Host schema admission、dispatch 与拒绝原因。普通 guidance 只对实际目标采用最具体适用范围，不跨 project 覆盖；已识别的同一操作不可满足约束进入 instruction-conflict，未解除前相关副作用为 0，不要求通用自然语言冲突解析器。显式合格 Skill 不被同名默认替换，选中后失效不静默 fallback，部分目录不冒充完整、搜索失败不报空，allowed-tools 不授权；不要求先完成目录规模优化。Memory/source/provider metadata 均不能注册工具、改变 policy/凭据/审批或直接写 canonical memory。合法本地 guidance 与已批准工具须能正常运行，八个 Core schema 集合不变。
- **未启用能力的拒绝对照：** 不配置 MCP、不加载 Pi 时，向当前 Core 工具入口提交未知或未启用工具名、伪装的 schema/权限字段，必须拒绝且执行次数为 0；原本合法的 CLI 请求仍可完成。此项只测试 Core admission，不需实现 MCP server binding、tools/list、mcp.search 或 Pi loader；后续能力的正向运行证据不计入首次 CLI PASS。
- **D6.3 多已选 Skill 冲突：** 让两个不同 Skill 均已通过 scope/trust/hash/预算并激活，且对同一资源的同一次副作用提出已明确识别、无法同时满足的直接约束，例如同一次依赖安装分别必须用 pnpm 与 npm；交换加载顺序再测。观测两个精确 skill_ref/hash、instruction snapshot、受影响操作、冲突状态、额外 LLM 调用和真实副作用计数。必须暴露 skill-conflict，冲突未解除时该副作用次数为 0，不按加载顺序静默选一份、停用另一份或另起 LLM 裁决器；额外裁决调用为 0。相容约束或分别适用于不同操作的对照不误判为此冲突；owner 明确解除约束或停用其中一份后，经新 snapshot/assembly 重验可正常执行。不新增通用自然语言冲突解析器，实际 adapter 仍按 X-10 重验该终态。
- **receipt / 位置 / 平台：** `context-isolation@v1`；`COURSE/gate` 放确定性负例，目标验收在 `RUNTIME/core`；三平台状态同 X-01。
- **失败影响：** active-project、authority、injection 或 capability 的共享 Core 不变量失败，重开 09 并按 13 D8.5 阻塞所有受影响的模型/工具 dispatch；不能以禁用 MCP/Pi 掩盖共享漏洞。后续专属子项未实现或未运行记 deferred，不构成本组失败，不阻塞首次 CLI 验收。

#### 后续能力启用前追加

- **MCP binding/schema/namespace：** 启用 MCP 前按 13 D6.5 测已批准/未绑定 server、模型伪造任意 URL/command/credential、目录超限、schema/hash 变更、跨 server 同名及覆盖 Core/Host 名。记录 binding/scope、目录与 schema snapshot/hash、namespace 映射、实际 server/dispatch 和拒绝原因。未授权调用为 0；合格调用准确命中冻结 server/schema，不能只验证拒绝。tools/list_changed 只刷新后续 snapshot，不改当前请求；旧 schema/binding 调用失效并更新后续 assembly/epoch。未选不可用工具不阻塞任务，已选不可用明确 unavailable、不换同名 server；输出/metadata 不得激活指令、注册工具或直接写 memory。
- **MCP discovery：** 小/大目录分别验证 schema admission 和有界发现。启用 MCP 的 assembly 中八个 Core schema 与 adapter-owned `mcp.search@v1` 分列，名字/所属块/hash 可核验；大目录仅合格绑定参与发现，cursor 可继续，发现调用不执行目标工具、不接受任意 endpoint/command/credential。禁用 MCP 显式不可用，目录失败不报空；server 同名工具不能盖 discovery；选定 ref 后加载准确 schema 并经 Core 执行合法调用，不新增通用 mcp.call/plugin registry。
- **Pi loading（独立于 MCP）：** 启用 Pi 对应模式前，测试 user/project/package/CLI/inline 的第二 extension、伪装同名 adapter、加载后动态注册工具及 reload/cwd/new session 重载；记录 factory 计数、loaded set hash、Core wrapper 与拒绝点。未批准代码在 factory 前拒绝，副作用为 0；批准的唯一 adapter 和合格本地工具正常可用。该项不要求配置 MCP，也不是 CLI 上启用 MCP 的前置；Pi 与 MCP 同时启用时才追加组合接线复验。固定 hash 不是恶意同进程 runtime 的沙箱，真实模式输入/消费者按 X-10 验证。
- **范围、证据与失败影响：** 复用本卡 receipt，逐 capability/adapter/mode 记录专属结果；未启用项 deferred，不改写通用组结果。MCP 专属 binding/discovery/schema/namespace 缺证或失败只关闭对应 MCP 能力/调用；Pi loading 缺证或失败关闭对应 Pi 模式。二者都须复验通用 Core 隔离及自己的正常对照，不能用 CLI PASS 替代。若任一专属测试揭示共享 Core 不变量被绕过，仍按本卡通用失败规则阻断所有受影响路径，不能缩小为局部失败。

### X-06 · assembly/started durable barriers 与 attempt 恢复

- **权威主张：** 09 §13–16、10 §11/27；assembly flush、started flush、网络 dispatch 依次发生，receipt 不进入 prompt，unknown-sent 不自动重发。
- **最小 fixture：** 可记录请求数的本地 transport stub；对 assembly 与 started 各自在三处逐点强杀：append 前、append 成功但 durable flush 前、durable flush 成功后；再在网络已接收后/finished durable flush 前强杀。另测同 payload retry、route/model/content 改变、快照恢复 gap 与已有 started/no-finished。
- **观测：** stream seq、fsync/transaction 完成点、assembly/attempt IDs、canonical payload bytes/hash、stub request count、恢复分类、最终 prompt 中 receipt marker 搜索结果。
- **PASS：** 两道 barrier 任一未成功时网络请求数为 0；assembly/no-started=`not-dispatched`；started/no-finished=`orphaned/unknown-sent` 且自动重发 0；非 attempt metadata 变化必换 assembly ID；receipt 内容进入 model payload 次数 0；恢复 gap 下旧 session dispatch blocked。
- **Admission/恢复正反例：** 两连接交错撤销 intent/授权/fence 与 started 事务。撤销先提交则旧请求不得 admission；started 先提交则记录为 in-flight，发送前观察到取消须停止尚可停止者，不把已发请求改成未发。校验与 attempt/activity 登记必须原子。另测 provider 可查询/不可查询的 unknown：追加对账证据或由真实 owner 明确封存旧 run；原 unknown 不改写，新 run 重新授权/检查资源/预算，不能自动重做非幂等操作。必须包含对账后正常继续和合法首次发送，不能仅验拒绝。
- **通用多 owner：** 无前台 session 的 job、maintenance、migration 分别运行 assembly/started 各杀点，重启更换进程和过期 job lease，检查 stream owner/attempt 不变且未知请求不重发；故意把请求挂错 session/scope 或删除来源后投递结果，均 dispatch/mutation=0。
- **Pi transport（对应模式启用前追加）：** Pi 使用已固定 SDK/adapter 运行 automatic/manual/overflow/tree summary、设置重启 compaction、provider hook 抛错、最终 payload 改写、HTTP/WebSocket 隐式 retry 与流中断；观测 Core assembly、转换后真实 bytes、started flush、网络计数、hook/load-set digest。缺合法 assembly/owner 或 barrier 失败时请求为 0，即使普通 hook 吞异常也不能发送；每次实际发送恰有自己的 attempt，隐藏 retry=0；正常主调用及合法 Core 压缩成功且不递归用 Pi summary。仅 stub 不能关闭 Pi/真实 transport 的接线门禁；未实现 Pi 不阻塞首次 CLI 的 ledger/transport 子项。
- **receipt / 位置 / 平台：** `dispatch-barriers@v1`；`RUNTIME/core`；Windows 待实测，macOS/Linux 无宿主/未验证；CI 可跑逻辑杀点但不替代真实进程/文件系统。
- **失败影响：** 共享 assembly/started barrier、identity 或 unknown-sent 恢复 FAIL 重开 09/10，并阻塞所有受影响的真实 transport。Pi 专属接线缺证/失败只关闭该模式；若暴露共享漏洞仍按前句处理，未启用 Pi 不构成 CLI 失败。

### X-07 · candidate、验证、替代、冲突与回滚

- **权威主张：** 08 §1–20；Harness 固定 provenance/scope/owner，Verifier 自取证，先 identity+time normalization，反馈不定义真值，只有强信号回滚。
- **最小 fixture：** 明确“记住”、需结合上文的“同意”、结构化工具事实、外部不可信文件、重复 source event、同对象不重叠/重叠有效期、不同 host/environment、弱 task failure、owner correction、source hash 变化、可归因 canary failure；包含 known-bad candidate。
- **观测：** capture source range/hash、proposer/verifier evidence refs、integrity gate、lifecycle/verification transitions、head/pre-image、blocked reason/queue age、feedback 与 salience；`retrieved` 与由 canonical assembly 推导的 `injected` 分开记录。
- **PASS：** 模型自报 provenance 被采用 0 次；所有自动 capture 首次均为 `candidate + unverified`，logical project 未解析时只进入 session-local unresolved candidate queue，跨会话检索/active 注入次数为 0；project 后续由 intent、真实 resource owner 或 manifest 确认时只进入验证管线，不直接激活。重复 event 不增行；不同环境并存，不重叠时间形成 supersession，重叠可信矛盾进入 conflict 并停止注入；weak failure 不改 verification；强信号才回滚且 stale/conflicted previous 不恢复；每个 pending 有阶段和原因，快速通道下一轮前 active 或显式阻塞。`retrieved`/`injected` 不得折叠为同一事实，`injected` 必须能由 09 的 assembly receipt 重算；仅凭暴露（retrieved/injected）改变 verification 次数 0。
- **D1/D4 补充验收：** Proposer/Historian/Verifier 分别注入暂时不可用、超时/限流、协议/结构化输出失败，以及 integrity FAIL、block、evidence-gap；记录 primary/fallback ordinal、Host 实际路由/调用链、requested/actual provider-model、可得 version、config/prompt/schema/adapter identity、输入/输出/tool hash、usage 与终态。只有前一类故障能进入已配置 fallback；否定结论换模型晋升次数 0，低于所需能力只留 candidate/evidence-gap；不可得版本标 unknown，远端自报角色/型号不能改变 Host 路由或权限。全部 attempt receipt 可复算，秘密/正文不进入 receipt。
- **Scope-review 补充验收：** 同一 logical project 至少包含三个不同 session/source batch，其中一批产生新 decision、另一批产生同 subject 的旧 decision/适用边界，另加不同 project 的相似 claim。先登记 scope-review cursor/generation/input digest，再执行增量 review；观测 changed set、affected identity set、实际 source refs、candidate/relationship transitions、overview artifact hash/status 和 cross-project read count。**PASS：** 同一 generation 重放不重复 candidate/event/overview；只改变一个受影响 identity 时不重算无关 scope；同 project 的跨 session 关系能产生带 source refs 的 supersession/conflict/overview patch；不同 project 不被纳入；未解析 scope、stale/conflicted/purged source 不产生 active fact；review failure/cursor gap 只产生 `evidence-gap|stale|failed`，不修改 canonical memory 或继续注入无法验证的 overview；首次导入和 cursor gap 能按 bounded batch 续做。全量 backfill 只作为显式/恢复路径，不能出现在每轮会话关键路径。

- **Scope-review/backfill 后续 crash fixtures：** Overview 在 SQLite body/refs/cursor 事务各语句间强杀，重启无半提交，旧 worker 不覆盖新 head，损坏投影重新生成新 identity/hash，不要求相同模型输出。Backfill 启用时再对 source durable append、可重放 inventory 与 Core job ack 前后强杀，不能漏掉未确认 event 或重复 capture；processed 但 verification/relation pending 时不能声称全部历史已分析。跨 scope 启用时验 membership withdrawal 失效全部受影响 overview。各子项只在对应能力启用前落实，不捆绑首次 P0/P1。

- **Scope-review closure / concurrency / budget：** scope input 使用 Core-owned store-local monotonic `input_seq`；fixture 在 snapshot、Proposer/Historian/Verifier、relation publish、overview publish、cursor CAS 各阶段注入新的 source/memory/scope event。receipt 必须记录 `start_seq/end_seq/covered_seq`、snapshot/input digest、generation、previous cursor、pending/dirty continuation、selected/omitted refs、workset record/bytes/tokens/depth/fanout/source-expansion/attempt/wall-clock/drain usage 与 budget version。**PASS：** 新事件不被旧 generation 跳过；参与 head/scope/source 变化则本次 patch/关系不得发布，cursor 可安全重试；只存在未覆盖 seq 时旧结果最多为 stale/dirty，不得作为 fresh baseline；同一 generation/cursor 重放不重复 event/overview。超预算禁止 fresh publish，稳定排序、continuation 和 evidence-gap 可复读；多个 scope 轮转且单 scope 不吞尽 drain。关系结果用稳定 relation key 幂等，review 自己生成的 relation event 在本次 post-state/cursor 对账中结算，不产生无界自触发；输入顺序置换与同证据重放结果一致，不确定关系为 evidence-gap。
- **Inert proposal target gate：** 保存带 target/expected change/owner/scope/evidence refs 和版本化评估建议的 proposal，测试篡改 digest、来源越权、外部 accepted/result 和指令正文。只允许合格保存/显式受控输出，不调用行为评估或发布，未验证行为权限始终为 0；修订新增版本，purge 清理引用。不要求 sealed plan 或 evaluation attempt/result 表族；X-08 课程实验不替代 memory 自身验证。
- **任务报告与项目提案：** 完整分析按 source identity durable 归档，包含覆盖、事实/推断/建议、原文版本引用及未决项；测试重复保存、写入/ack 失败、重启和新增修订，旧正文/hash 不被覆盖或用新生成文本代替。按获准交付范围形成只含目标项目所需内容的 inert proposal 与有界发现单元；跨项目证据保留真实 owner，禁止伪造来源绑定或把混合报告改为目标项目 scope。普通 handoff/无具体 target/evaluation 的想法仍是 source，不产生伪 memory 或强制 proposal。
- **交接正常与拒绝对照：** 仅有分析读取授权时不能向其他项目发布资料；补齐明确交付授权后，目标项目新会话能搜索/展开其提案，其他项目资料仍不可读。导出 Markdown 含必要获准背景、改动边界和验收方法，离开原会话且不访问私有 DB 仍可理解；不可达引用如实报缺。未安装任何特定 Skill 的合成文档可完成保存/导出；可选 Skill 的临时文件经明确选择归档正文后，删除临时文件不破坏恢复，未选文件不被扫描，`suggested skills` 不触发激活。外部 Issue/仓库写入另受当前授权，不要求连接真实平台或实现任务系统集成。
- **产物恢复与清除闭包：** 报告区段、proposal、项目摘录、索引和受控导出 refs 均能从原 owner 查证；来源失效不自动重写历史，但阻止将其作为当前事实继续使用。X-12 对这些实际载体与备份/引用执行清除及防复活，缺失闭包不可签整体通过。
- **Scope dependency / raw backfill：** fixture 先更新 project input，再检查 workspace/personal overview 的 artifact-input 反向依赖、stale fan-out、claim→ref 和 purge 闭包；不同 project 相似 claim 不得混入。每条 raw coverage watermark 绑定 `source_snapshot_id`、source owner、scope/time selector、cursor domain、snapshot/inventory digest，并只表示该 domain 的最高连续前缀；缺失区间必须留在结构化 continuation/missing intervals。显式 global review/首次导入/recovery 另含 raw-only source batch，观测 source snapshot/cursor、capture envelope、integrity、candidate/unverified、verification/relation transitions、processed/evidence-gap、continuation 和 coverage boundary；失败/中断续做不得重复捕获，未完成 raw batch 不得宣称历史已完整分析，正常 turn 不启动该 backfill。

- **receipt / 位置 / 平台：** `scope-review@v1`，receipt 的 `start_seq` 为 exclusive、`end_seq` 为 inclusive，覆盖区间固定为 `(start_seq,end_seq]`；复用 `projection_jobs/projection_state/projection_leases`、scope-only `projection_artifacts` 与类型化 input refs；目标验收在 `RUNTIME/core/store`，三平台 portable 逻辑可由 CI 验证，source/archive、真实 app-data root 和 purge 按目标宿主验收。回滚另含 `r3→r4→r3` 与 forget→restore：旧预览永久 stale，新的预览绑定新 `head_event_id`；恢复前 source/scope/time/verification 失格则不激活旧值。
- **同源抑制与后台归属：** forget 后重放原 source、改 capture event ID、使用路径别名、同 lineage 同 claim 新版本，及不同 claim/owner/有效期的真新事实；观测规范 suppression tuple/provenance、候选/激活/restore event。前三类不得自动 active 或另起同义 active record；歧义 evidence-gap，独立新事实正常走 verification，不能按全局正文 hash 误伤。restore 必须独立批准且资格/CAS 有效，再 correct；purge 清除抑制指纹并禁止旧 job 回放。source-change/时间维护在无前台 session 时调用 Verifier，观测 job stream、已批准目标/scope、来源与 attempt；结束/删除 originating session 不改 stream owner，来源清除后旧授权失效，无合法来源不得续跑。模型未调用的 projection repair 不伪造 attempt。
- **receipt / 位置 / 平台：** `memory-lifecycle@v1`；`COURSE/memory` 复刻纯状态机，目标验收在 `RUNTIME/core/store`；三平台状态同 X-01。
- **失败影响：** capture authority、Verifier 独立性、identity/time normalization、conflict 或 rollback FAIL 重开 08；队列时延参数失败则交 13 重定。

### X-08 · receipt 完整性、负迁移与 held-out evolution gate

- **权威主张：** 08 §18/21–27；01 的 9-2 negative 与 9-6/9-7/9-9 integrity FAIL；memory 只能生成 inert proposal，不能凭自报效果发布行为；正负 retention 必须由冻结 held-out 的独立效果证据决定。
- **最小 fixture：** 从同一 immutable checkpoint 运行 baseline/treatment，仅改变一个 memory/proposal；含一个效果未知的正向候选，并由 held-out owner 在实现前封存至少一条 baseline 失败而 treatment 应成功、或有预声明量化指标可严格改善的目标断言；另含 9-2 型“格式通过但效果变差”候选、内容仍为真但产生负迁移的候选、篡改 manifest、陈旧 sidecar 与重签后重排 payload。对重签场景，owner 在任何实现/候选生成前另行封存不可变 pre-image manifest（完整 payload bytes、顺序、schema、digest 与 owner signature）；攻击样本可重算 digest/重签，但不得替换该 pre-image 锚点。held-out/越界负例在 treatment 前冻结并 hash，调参后污染的 case 移出 held-out 并补新 case。
- **观测：** owner-sealed pre-image locator/commit/signature、pre-image/candidate/full-payload bytes/digest/顺序、baseline/treatment 首个可判定输出、held-out outcome、proposal target/scope、activation pointer、rollback receipt。
- **PASS：** 任一 digest/sidecar 不匹配同时记录 receipt_integrity=FAIL 与 independent_validation=evidence-gap，不抹平 FAIL；攻击样本即使重算 digest/重签，只要完整 bytes/schema/顺序偏离预封存 owner pre-image 仍 FAIL，候选不能替换锚点。Known-bad 不 active，强可归因负迁移为 verified + rejected(negative_transfer)，仅恢复当前合格 known-good；行为 proposal 始终 inert，外部结果不授权发布。正向 retention 必须出现预声明目标的 baseline 失败→treatment 成功或严格量化改善，其余 held-out 零回归；baseline=treatment、丢弃有益候选或 known-bad active 均 FAIL。本项不要求生产 sealed plan/result 表或行为评估 runner。
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

### X-10 · 按模式验收 presentation/approval 状态机

- **权威主张：** 14 `Minimal host contract` 至 `Required terminal states` 及 `Handoff to 12 and 13`；adapter 只实现四操作，模型不能代替 canonical presentation 或批准信号。

#### 首次 CLI 必测（后续宿主复用）

- **最小 fixture：** 在自研交互 CLI 执行 inspect、correct、forget、restore、automatic rollback、cancel、旧卡复用和 batch supersession；测试无呈现通道、批准输入无应答/abort/被替换，以及 correct 的实际文本输入、后续 user-turn 和非法 confirm-only。另测无真实批准的 preview 同轮 commit、缺/换 token、伪造 expected head、缩减 manifest、复用 settled token、非 owner 输入冒充批准、调查疑问误调 preview，以及 owner receipt sentinel 和越界摘要。Purge 的完整 manifest、含糊回复、历史/当前精确 nonce 在维护入口测试；运行 session 中发起 purge 只能获得维护指引，不得在线执行。CLI 自身完成 receipt 重启回放；unknown outcome、提交后补呈现、Info 和 source 恢复对应 X-11 通用组。
- **摘要与 UI 前置：** 运行该模式 X-10 前，在 versioned adapter contract 固定模型摘要字段白名单与最大序列化 bytes；缺项则该模式 evidence-gap，不在看结果后自拟阈值。首次只要求持久 user-turn/文本呈现 baseline，不为测试新建点击/多选 UI；已有富 UI 时才追加开/关对照，canonical 结果和 receipt 语义须一致。检查自研 CLI 依赖图和 Agent loop/TUI 源码 owner。
- **观测：** CLI 实际呈现正文、Host presentation record/handle、event bytes、live input source、token/nonce、四操作结果、operation→terminal mapping、owner entry/model summary、批准输入参数与 return/abort reason、authorization/mutation/pending count、冻结的 head/batch digest、sentinel 命中数、摘要字段/长度、重启前后 receipt bytes/hash，以及 resolved Pi package/imported API/源码 owner；不能只记录“已调用呈现”。
- **PASS：** 正常的合法操作确实完成，owner 能直接看到匹配冻结 snapshot 的完整正文。无 canonical presentation 的 write/inspect 均 unavailable；批准 dialog 不传 timeout，无应答/abort/被替换返回 unavailable 且不悬挂，只有明确否定为 rejected。confirm-only correct、无真实批准的同轮 commit、缺/换 token、缩减 batch 均不得 mutation，并按 14 返回对应 invalid_identity 等终态；伪造 expected head 不能覆盖 Host 冻结值，current 不符为 stale；settled token 返回 settled。非 owner 输入、含糊回复和历史 purge nonce 不授权，维护入口的当前精确 nonce 仅授权冻结 manifest 一次；调查疑问为 not_actionable，pending/mutation=0。owner sentinel 不进入模型 context；摘要只含预先冻结的字段且不超 bytes 上限，越界摘要不能成为授权。每个 operation 仅落合法终态，重启只重放同一 receipt，bytes/hash 不变。CLI 只依赖 `@earendil-works/pi-ai` 的 provider/model API，不导入 `pi-agent-core`/`pi-tui`/Pi `Agent`/`AgentSession`，Agent loop/TUI 的 source owner 是本项目。
- **D6/R01 通用接线：** 在真实装配/工具入口复验 X-04/X-05 的已选 AGENTS/Skill/tool snapshot 和多 Skill conflict；篡改 schema、陈旧绑定或 model 自批不能绕过 Core，记录最终 payload/dispatch counter。未启用能力实际 unavailable，不因本卡而要求建立其成功路径。后台无 session 的 Info 仍可由 owner 查询展开，notify 不等于持久/已读。维护 purge 在逻辑提交后失败或到达调用期限时返回 error/known committed/cleanup incomplete 及不泄露正文的恢复状态；重复 commit/cancel 为 settled，维护完成追加新 owner entry，不回写旧 error/receipt，不提前声明 controlled-complete。
- **联合放行：** 上述组与 X-11 的首次 CLI 必测组必须同时通过，才有 CLI 对应能力的通过结论；不等待下面的后续模式，也不把该结论写成全宿主 PASS。

#### 后续模式启用前追加

- **通用要求：** 各模式在实际消费者和输入通道上复验其适用的通用组，并通过同模式 X-11；只读模式只验允许的读取/诊断、恢复和拒绝边界，不要求其完成被禁止的 mutation。报告写明 adapter/mode/平台，未启用模式记 deferred。MCP 启用前另追加其 X-05 的同名 server、不可用和绑定/schema 接线检查，不作为 CLI 或未启用 MCP 模式的成功路径前置。
- **Pi regular：** 启用前测试真实 tool/extension command 呈现和批准，`source === "extension"`/`sendUserMessage` 注入授权次数为 0；Pi 首轮未 flush 的恢复按 X-11 追加。故意在 factory 后覆盖 onSubmit、复制 action Map，在异步 gate 期间重复按键/改 epoch；覆盖 Enter、streaming/idle Alt+Enter、paste/展开 marker/autocomplete、图像临时文件、外部 editor、selector 内删除/rename/model/settings、startup/reload 失败及 new/resume/fork。拒绝时原生 callback 不执行，合法呈现/批准/取消仍完成。未接入的附加入口须在副作用前 unavailable，不得只隐藏按钮；fullscreen 鼠标和模式切换在启用前单独证明早期 gate，不从后加 raw hook 推断通过。
- **Pi 非模型入口：** 对待启用模式实际存在的 builtin 工具、command、`!`/`!!`、shell/export/share、reload/new/fork 验 wrapper/Core gate/fence，默认直通=0；`/share` 不能只靠 export wrapper，普通 `tool_call` hook 不代替 wrapper。合法且获准的功能仍须正常完成；RPC 方法、JSON initial prompt 和 extension command 各按其模式实测，不继承 TUI PASS。
- **RPC/JSON 消费者：** 对待启用的模式分别保存客户端真实呈现面 capture，并从中逐字节复原 Host 冻结的 canonical bytes/hash；只输出 event 而无消费者呈现证据为该模式 FAIL。检验真实输入顺序、token/批准、合法变更和重启后的 receipt 不变；RPC 检验 UI response/abort，JSON 检验跨 invocation continuation。不得以 RPC 的 capture 或 Pi TUI 结果代替 JSON，反之亦然。
- **Pi `-p` text：** 仅在启用其诊断模式前追加：有 Host 呈现义务的操作（含 inspect）均 unavailable，commit/mutation=0；允许的无呈现义务诊断可正常完成。不用模型复述、stderr/临时文件伪装 canonical 呈现；诊断 PASS 不授予写权限。
- **receipt / 位置 / 平台：** 两组均使用 `host-state-machine@v1`，位于 `RUNTIME/host`；逐 adapter/mode/目标平台记录实际结果，未测模式/平台不继承通过。
- **失败影响：** 呈现、批准或 receipt/summary 边界失败阻塞受影响模式；发现共享 invariant 失败才扩大到所有受影响路径。Deferred 模式不阻塞 CLI，已声明启用但缺证的模式不能记 deferred 逃过门禁。

### X-11 · 按模式验收 durable pending 与恢复

- **权威主张：** 14 `Presentation identity and ordering`/`Pending lifecycle`/Handoff；Host-owned identity/ordering 先持久，宿主 entry 是投影，跨进程 pending 不能靠内存。

#### 首次 CLI 必测（后续宿主复用）

- **最小 fixture：** 新 CLI session 首个动作经不依赖模型的真实 Host 入口建立 preview；在 Host record 前、record 后/CLI 输出确认前、canonical commit 后/owner entry 前、owner entry 后/model summary 前强杀。另在 commit 调用结果 unknown 时强杀，重启后仅凭 operation/receipt ID/token 对账；测试恢复同 session 的有效 pending、新 preview 明确作废旧 operation 后的旧 token、错误 nonce/绑定、缺失/未知/歧义 identity、head/head_event_id 变化，以及两 session 并发提交同一 head。正常恢复后通过新的真实输入完成合法提交，不能只测拒绝。
- **CLI 首轮 source：** 在实际 carrier 的 append、durable flush、严格复读/ack 前后强杀；加入部分写、已绑定文件丢失/损坏、内存前进但未持久、重复 identity 的同/异 bytes。重启按原 identity/hash 查证，不能将损坏当新建空 session，unknown 不盲追加；缺 ack 时 dependent capture/卸载/dispatch=0。正常首轮的 source 可在无模型响应时 durable 并重启恢复；本项与 X-04 共用证据，不依赖 Pi carrier。
- **观测：** Host presentation/pending/receipt rows、CLI 呈现句柄与输出顺序、source identity/ack、canonical mutation count、重启对账发生在 retry 之前的顺序、补投影次数、blind retry count 和 token/nonce validity。逐例记录 token 原 operation/结算状态、是否显式指向新 presentation、绑定校验和终态，不从当前 pending 补齐请求身份。
- **PASS：** Host record 未 durable 不得给可批准 token；呈现丢失或确认缺失时完整重显或明确报缺，不能直接批准。Canonical commit 只发生一次，恢复只补缺失投影/summary；unknown 时先查 operation/receipt 并核对 canonical，blind retry=0；receipt 已存在不重做 mutation，结果仍不可判保持 unknown 并提供恢复入口，不声称未提交。恢复后的顺序仍为 presentation < live user input < commit，不从历史文本重建批准。新 preview 作废旧 pending 为 superseded；重用已结算原 operation 的 token 为 settled，不重定向到当前 pending；错误绑定或 identity 缺失/未知/歧义为 invalid_identity；有效未结算预览遇到 head/head_event_id 改变为 stale，并发输家也为 stale。拒绝调用 mutation=0，正常对照能提交并在重启后复读同一 receipt。
- **版本与维护清理恢复：** CLI preview 后由另一 session 使 head `r3→r4→r3`，重启后旧 token 仍 stale，新 preview 绑定新 head_event_id。维护 purge 的 logical commit、continuation 和各 owner ack 前后崩溃；恢复时区分批准 pending 与已提交 cleanup，先查 receipt/实际副本再续做，不重做逻辑 mutation、不复用 token、不占新批准槽。未完成、unknown 或权限/identity 改变时仍隔离；敏感 continuation 删除后崩溃，凭 content-free 进度重做 SQLite 维护，并包含最终完成、重新开放后正常工作的对照。
- **自动 Info 崩溃恢复：** activation/batch/outbox 提交后、Host manifest/unread 前、owner 输出前/后、read ack 前/后及 outbox 结算前强杀。观测固定 batch/event/order/digest、Host rows/ack、job/投递与 mutation 次数。重启只补缺投递，成员不重圈、不缩小，不重复 activation/批次；已读不被重放置回 unread，append/notify 不清 unread。无 active session 时保持持久待投递，返回后可查询；rollback/forget 成员展示真实状态。维护 purge 后的旧 Info 不复活正文，真实 redacted 批次不被重建成 active。
- **联合放行：** 本组与 CLI 的 X-10 通用组联合验收；CLI 自身的首轮、pending、Info 和维护恢复不能用后续模式 deferred 为由跳过。

#### 后续模式启用前追加

- **适用规则：** 在待启用模式的真实入口重跑上述适用恢复路径；共享存储证据可按实现/fixture 复用，模式专属输出/输入/continuation 必须实测。以下各项仅阻塞各自模式，不要求同时完成；`-p` 只检验其允许的 source/ledger/诊断恢复及持续拒绝写入，不运行成功 mutation 用例或由恢复 PASS 授予写权限。
- **Pi 首轮 presentation：** 使用 Pi carrier 的模式启用前，测试新 session 首个 extension command 建 preview，覆盖 Host record 已落/Pi entry 未 flush 及 commit 后缺 owner entry/summary 的崩溃点。Pi entry 丢失时完整重显或报缺，Host-owned identity/ordering 和 receipt 不变；该模式适用的正常变更仍须完成，不能以“永久 unavailable”代替有呈现能力模式的通过。
- **Pi source ack：** 在受控 header 准备、公开 append、fsync、原文件复读/ack 前后强杀并注入部分写、权限错误、unknown、已绑定文件丢失/变空、坏行/残尾、仅内存 leaf 前进及无 assistant 的 new/fork/reload。严格核对原 bytes、stable identity/domain 和完整分支映射，不把 loader 跳过坏行当完整性 PASS；保留 header/entries/id/metadata 与 locator，同 bytes 只捕获一次、异 bytes 冲突、unknown 不盲追加，缺 ack 的依赖动作=0。Source ack 与 presentation/批准顺序分别验收，entry ID 不成为批准权威。
- **RPC：** 启用前在合规客户端检验未完成 UI request、客户端断开/abort、Host 重启及 receipt 重放；丢失应答能力为 unavailable，不凭持久 event 推定 owner 已批准。重新呈现并获得真实输入后，合法操作可正常完成；消费者证据与同模式 X-10 联合使用。
- **JSON：** 启用前实跑同 session preview→进程退出→新 invocation commit；另插入新 preview 作废、nonce/token 错绑和 `r3→r4→r3`。必须保持 presentation < 本次活 owner input < commit，superseded/settled/invalid_identity/stale 按通用组判定；不扫描历史 session 推断批准、不从新 pending 补旧 identity。完成合法跨 invocation 对照，receipt 只追加一次，重启仅补呈现；未通过不开放 JSON 写路径。
- **receipt / 位置 / 平台：** 两组均使用 `host-continuation@v1`，位于 `RUNTIME/host/store`；记录 adapter/mode/目标平台与适用子项，不以单模式结果覆盖其他模式。
- **失败影响：** 模式专属恢复失败关闭该模式受影响能力；共享 pending/CAS/durability/unknown invariant 失败则关闭所有受影响路径。未启用模式为 deferred，已声明启用但缺证的模式保持 evidence-gap/blocked。

### X-12 · capacity、backup、损坏恢复与物理 purge

- **权威主张：** 10 §6/22–27、14 purge handoff；容量不足不能删 canonical，backup 必须可恢复，schema 只前进迁移须有恢复点，损坏恢复标 gap，privacy purge 覆盖所有受控副本但不承诺取证级擦除。
- **最小 fixture：** 先用记录规模/seed 的有界合成库和倍率测试，取得只读 MC 计数后可补规模基线，不依赖未知生产计数启动功能测试。注入 ENOSPC/只读、WAL 中断、FTS/canonical page/backup 损坏及 forward migration 成败。分别建立 forget/purge 库；canary 覆盖首次启用路径的 main/WAL/free pages/backups/search/session/source/Host presentation/pending 与实际 reverse refs，后续 overview/bundle 增量加入。跨日与中断 backup 验保留策略；purge 全部经维护独占，不直接在运行中删库。
- **观测：** free space/DB/WAL/backup size、写/查询/backup/restore p50/p95、quick/foreign-key/stream-head checks、dispatch count、schema version/恢复点 digest、backup 日期/数量/原子 rename、ordinary forget 前后 revision/event/head/检索/投影、purge delete manifest、两张 Host operation 表的 reverse-ref count、受控路径 canary 扫描与明确列出的不可控残留。
- **PASS：** archive/barrier durable commit 失败时 dispatch=0；容量策略只删可重建物，canonical/event 丢失 0；ordinary forget 后原 revision/event 行与审计内容逐字节保留、head=tombstoned、正常检索/投影命中 0；损坏索引可重建，canonical 损坏不原地修复；成功 forward migration 后 schema version 与全部冻结 invariant 通过，失败迁移保留旧库且迁移前恢复点可通过检查；online backup 仅在数据变化时每日最多一份、原子保留最近两份，中断产物不被标为可恢复；只从已验证快照恢复并标 `recovered_with_gap`，unknown-sent 自动重发 0；purge 后活动查询、所有受控副本以及 presentation/pending reverse refs 的 canary 命中分别为 0，外部不可控位置被列出。portable/CI 可测参数与目标平台真实宿主的 backup/repair 参数分别记录，未完成目标平台 sweep 时只冻结 portable 结论，不冻结该平台宿主参数。
- **分阶段 purge 补充验收：** 对逻辑提交前/后、每个受控 owner 删除前/后、删除成功但 ack 未落盘、敏感 continuation 删除后、WAL/free-page 维护前/后和完成 receipt 前逐点注入强杀、文件锁、只读/ENOSPC、权限或 file identity 改变。用其他进程/worker 尝试派生旧内容、恢复旧 snapshot、重新导出或 source expand。记录逻辑 receipt、批准 manifest、各 owner 实际文件 identity/ack、续做次数、残留扫描、无内容维护进度与完成事件。逻辑提交前失败无外部删除，提交后失败只能 incomplete 且目标/受影响流保持隔离；身份漂移不删替换资源，unknown 先查证，writer 不能复制旧内容，旧备份不能复活它。包括 continuation 自身、main/WAL/free pages/备份/source/Host 引用在内的全部后置条件齐备后才有 controlled-complete；未齐时不得通过。敏感 continuation 删除后再做数据库维护，完成事件只含不可关联字段；重启可凭无内容进度完成这一末段而不恢复 locator。Purge 期间 backup/bundle 不发布含旧内容或 continuation 的副本；损坏恢复缺清除进度时保持 blocked，不从清除前快照激活目标。
- **维护独占与恢复：** A 为独立维护协调者，B 是持有内容的 CLI runtime/受控子进程，C 尝试同时启动。B 在进程登记、source append、backup/rename、dispatch 各点暂停；检查 open 与登记必须原子。A closing 后 C 不得读取内容/启动业务；B 及子任务未真实退出前，A 不展示可执行删除批准、不逻辑提交或外部删除。关闭窗口/abort/lease 到期/PID 重用不作为退出证据。退出和残留检查完成后，A 从真实状态生成 manifest 并取得一次绑定 nonce 的批准；新资源须重显重批。协调者 lease 过期但未停时，第二协调者不得接管删除；确认退出后可幂等恢复。完整正常对照必须清除成功并以新 epoch 启动，不靠永久 blocked 过测。协调者输入/呈现/continuation 自清除后 canary=0，completion 与 reopen 无半提交，旧快照/gap 不复活目标。
- **任务产物闭包：** 在实际已启用载体中加入完整报告/历史版本、项目摘录、proposal payload、来源/发现 refs/hash、受控 Markdown 输出及备份；正常备份恢复保留准确版本和权限边界。维护清除后重建搜索、恢复旧会话或使用旧 handoff 引用不能复活相关内容；未授权项目资料不能借获准摘录或报告链接泄露。外部 Issue/远端副本仅在实际存在时按可控性列残留，不以此要求实现外部发布系统。
- **Pi 维护退出（后续子项）：** Pi 在首个 source 读取前登记 runtime process/root，closing 后 source/transport 入口重验 fence；即使 agent_end/idle/dispose 已返回，只要 Pi 或其受控子任务仍可输出，清除就不能开始。真实进程退出、残留检查和独占齐备后由维护 Host 重新呈现/批准。重启不得恢复已 purge 的 source、pending 或旧 window；包含正常成功和迟到 append/子任务负例。不要求首版实现在线 Promise/UI/history/undo 的逐项 quiesce 协议。
- **receipt / 位置 / 平台：** `store-recovery-privacy@v1`；`RUNTIME/store/host`；portable 故障处理可由三平台 CI 验证；kill/ENOSPC 模拟不关闭目标用户环境下的恢复、backup/purge gate，Windows 真实宿主待实测，macOS/Linux 无宿主/未验证。
- **失败影响：** canonical durability、migration/backup 可恢复性或 privacy purge 后置条件 FAIL 重开 10/14；仅容量/时延参数失败则保持未冻结。

### X-13 · 三宿主 path/URL canonicalization 与 capability gate

- **权威主张：** 01 的 9-7 confirmed negative、09 §8、10 §2–3/28c；路径/URL 是不可信输入，能力与 resource owner 必须在模型外按宿主真实语义重验。
- **最小 fixture：** 各宿主真实临时目录内外文件；plain/percent/double-percent 编码、混合分隔符、dot segments、Unicode 正规化、大小写/drive-relative/UNC/file URL、symlink（Windows 含 junction）与不存在路径；至少含已知 `%252fetc%252fpasswd`。同一 payload 走完整 parse→normalize→policy→open 链，不用孤立 helper 自测冒充。
- **观测：** 每个 protocol boundary 的 raw/canonical bytes、decode count、realpath/owner root、policy reason、实际 open target、tool dispatch；不得在 receipt 复制秘密正文。
- **PASS：** 等价表示的 policy 结果一致；任何最终 real target 越过 owner root 均 dispatch=0；symlink/junction 逃逸、ambiguous/invalid encoding 与二次下游解码风险均 fail closed；允许路径确实打开预期 inode/file ID。对每个声明支持的平台分别判定；当前 Windows 目标平台必须真实宿主通过，macOS/Linux 在无宿主时保持 `unverified`，CI 只能验证 portable parser/fixture，不升级真实路径语义。
- **执行权限范围：** 本卡的文件 API root 检查不证明任意 shell/脚本受隔离。首次不向模型直通未隔离执行工具，Host 高权限维护动作须明确批准命令/cwd/真实权限；测试该入口不冒充受 root 限制的模型工具。后续开放执行能力，按实际选定的隔离或逐次高权限批准模式验文件/网络/子进程及数据根边界，不能用字符串 parser 测试给沙箱 PASS；Skill 激活不授权脚本。
- **receipt / 位置 / 平台：** `resource-canonicalization@v1`；`COURSE/gate` 保留 known-bad，目标验收在 `RUNTIME/core/host`；每个声明支持的平台各一份真实宿主 receipt；CI 记录 portable checks，不替代目标平台真实路径语义。
- **失败影响：** canonical resource owner 或 capability gate 任一越界打开即重开 09/10，并阻塞该平台的文件/URL tool。

### X-14 · provider cache、延迟与成本的真实边界

Ledger/实际 transport 及受控测试前置通过后即可测量，不依赖 X-15/bundle 或未启用宿主；真实数据与 D7 仍另有门禁。首次验一条目标 provider route，其他 route 在启用前追加相同检查。

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
| Runtime prerequisite | 验所选 Host（首次 CLI）的 source/intent/stream owner/Info/fence/tool/transport 与旧 epoch 拒绝；Pi 启用时再加入 loader/settings/extension 边界 | 对应首次切片 P0 契约与 X-01/04/05/06/07/10/11/12 子项齐备才进入该能力；准备库/旧 receipt 不能替代，未启用模式 unavailable，Pi gate 不反向阻塞 CLI |
| One-way owner commit | 在 quiesce/MC 退出、owner+epoch+lifecycle 事务前/中/后、Euler hook 注册、canary assembly/started/finished 各点崩溃；另测 owner receipt 缺失/损坏/快照 gap、旧启动配置、重复切换与双 hook | owner/epoch/receipt 无半提交；完整证据证明未提交时才可取消并在互斥重验后启动 MC。提交后首次 canary 失败也不回 MC；启动先读 durable owner，缺/unknown/gap 不推断 MC；barrier 未完成不发请求，unknown-sent 不重发，旧配置不能覆盖 owner。任一反例阻断对应 capability/host cutover |

D7.5 的 workload、control baseline、quality rules、overhead budget、阈值封存与配对结果需附同一证据包；先完成切换前 hard gate 和阈值，再按 D7.4 提交 owner、执行首个 live canary，通过后才能扩围。Canary 失败是已提交 Euler 的隔离/修复结果，不是取消提交的许可。

## 新实验的三轴状态（本票结算时）

| ID | source mechanism | stored receipt | independent validation | 当前证据等级 | 平台门禁 | CI |
|---|---|---|---|---|---|---|
| X-01 | target DDL/transaction 尚未实现 | 无，待 `store-schema@v1` | 必须从 DB/raw transaction 重建 | `未证实` | portable checks：Windows/macOS/Linux CI matrix；真实数据根/用户权限/宿主行为：Windows `待实测`；macOS/Linux `无宿主/未验证` | 可验证 portable SQLite/transaction，不关闭真实宿主项 |
| X-02 | lexical/CJK 教学机制 partial；target FTS 未实现 | 无，待 `retrieval-heldout@v1` | 本地需求覆盖语料/held-out 先冻结；历史 60 用例可取得后追加 | `未证实` | portable FTS/CJK：Windows/macOS/Linux CI matrix；Host-dependent 集成按目标平台另验 | 可验证 target SQLite/FTS 与检索 fixture，不关闭 Host-dependent 项 |
| X-03 | MC/Trivium 仅供借鉴；target worker 未实现 | 无，待 `projection-recovery@v1` | 故障注入后 canonical 双向复算 | `未证实` | portable worker/SQLite：Windows/macOS/Linux CI matrix；本地文件/恢复另按目标平台验 | 可验证 worker 状态机，不关闭 Host/filesystem 项 |
| X-04 | `context.ts` 有小 fixture；target Orchestrator 未实现 | 无，待 `context-admission@v1` | 从 archive/prompt bytes 复算 | `未证实` | portable Core/transport：Windows/macOS/Linux CI matrix；真实 Host dispatch 另按目标平台验 | 可验证 Core/transport stub，不升级 Host 状态 |
| X-05 | 09 为规范；target gate 未实现 | 无，待 `context-isolation@v1` | 从 rejected/selected/raw dispatch 复算，Core/MCP/Pi 子项分列 | `未证实` | 首次 Core/CLI gate 与后续 MCP/Pi 专属结果分列；portable Core 三平台 CI，实际 Host 按声明范围验 | 可验证确定性 gate，不代替 Host/MCP/Pi 实际接线 |
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

1. 按 13 D8 准备首次切片的 app-id/数据根、disposable 边界、实际路径、API/receipt 与关键合成探针。开发 fixture 可随实现完善；用于独立验收的 held-out 在相应测试前封存，不能针对已看结果改 gold。后续能力的全部 fixture 不作为首次 P0 前置。
2. 课程确定性 fixture 可作为实现参考并独立运行，不要求先完成全部课程实验才能实施 runtime。X-08 按独立课程票验正向改善、held-out 零回归与负迁移，不是首次 P0/P2 gate；课程 PASS 不能关闭目标运行时安全门禁。
3. 存储与 dispatch 基座为 X-01 后并行实施 X-03/search 与 X-06/ledger；不要求先建可选 overview 才验发送。首次路径的三项子门禁齐备前不开放上层写路径或真实 model dispatch；合成纵向探针可先行，不等于能力放行。
4. 再跑记忆与宿主集成：X-07 及 X-09/X-13 的 Core 部分在 P2 实施，Host-dependent 部分在 P3 实际接线后补齐，不把子门禁通过当整卡 PASS。X-10→X-11 表示先正常呈现/批准、再故障恢复的执行顺序；逐 adapter、目标平台须 `X-10 ∧ X-11` 才可关闭写门禁，分别保留 receipt。JSON continuation 及 X-09 的真实模型/Host 重验、X-13 的真实文件访问链，均须相应目标宿主证据齐备才能升级该平台生产支持；共享 Core 部分由三平台 GitHub Actions matrix 回归。
5. 首次物理恢复/容量/维护 purge 由 X-12 验收；X-14 在 ledger/实际 transport 与受控测试前置满足后即可测，与 X-12 可并行，不依赖 bundle。X-15 只在后续 bundle 启用前要求，并补齐该能力的清除/恢复。首次真实数据和 D7 cutover 仍须全部已启用路径通过；provider 测量与 control baseline、预注册阈值衔接，最终门槛在 canary 前判定，不用 mock 代替 X-09 的真实模型/Host 验证。
6. macOS/Linux 无真实宿主时，相关 Host-dependent 行保持 `无宿主/未验证`，但共享 Core 与 portable 行可由 GitHub Actions matrix 验证；Windows 真实宿主、CI 结果、源码同构和其他平台 CI 不能合并成 macOS/Linux 真实宿主 PASS，也不阻塞 Windows-first v1。
7. FAIL 若会改变已冻结 owner、durability、privacy、authority 或安全边界，先重开对应 resolved ticket；不得只改 fixture 直到实现“通过”。纯参数失败只把数值保留未冻结，交 13 用真实数据拍板。

## 覆盖闭包与 Handoff

- 01 强制项：知识产物负迁移、known-bad/retention、receipt/sidecar、路径双解码分别落 X-08/X-13；9-2、9-6/7/9 已按 negative/FAIL 登记而非抹平。
- 09 故障矩阵：预算/ReAct/source 在 X-04，scope/injection 在 X-05，receipt 不进 prompt 与两道 barrier 在 X-06；无遗漏。
- 10 故障矩阵：DDL/query/CJK/outbox 分别落 X-01/X-02/X-03，容量/backup/recovery/purge 落 X-12，bundle portability 落 X-15；portable 部分使用三平台 CI matrix，Host-dependent 部分按目标平台保留真实宿主门禁。
- 14 故障矩阵：Host DDL 在 X-01，状态机在 X-10，pending/首轮未 flush/JSON continuation 在 X-11，purge reverse refs 与 crash repair 在 X-12。
- 13 接线时必须把每个 `RUNTIME/*` 映射到真实路径并建立上述 receipt；课程类 X-08 与共享 held-out 的扩充另开实验执行票，不扩大 13 的生产 v1。
- 13 增量覆盖：D1 fallback/真实模型 receipt 在 X-07；D4/D5 raw compartment/window 在 X-04/X-14；D6 的 Core isolation、本地 AGENTS/Skill 在 X-04/X-05/X-10 通用组；D7 source/staging/owner commit 在独立列明但复用原证据的 migration gate。Source/archive 的 P0 HostAdapter contract 由 X-04/X-09/X-12 检验。
- D6 后续子项：MCP binding/discovery/schema/namespace 在 X-05 的 MCP 组及 X-10 的实际接线追加组；Pi loading 在 X-05 的独立 Pi 组，source/transport/consumer 另按 X-04/X-06/X-10/X-11/X-12 对应模式验收。只在启用相应能力前要求，MCP 与 Pi 不互为前置；组合使用时补组合接线证据，失败按共享不变量与能力专属问题分别处理。
- 首次闭包：bootstrap/intent 在 X-01/04/05/11，stream/admission/unknown 恢复在 X-01/06/07/12，Info 在 X-01/07/10/11，状态转换/抑制在 X-07/09/12，维护 fence 在 X-01/06/12，累计预算/取消在 X-04/06。MCP/Pi/overview/backfill/bundle 子项只约束对应后续能力，不能把 source API 存在、deferred 或历史评审当 target PASS。
- 本票的 Status: resolved 只表示设计矩阵已定案，不新增生产代码、不执行实验、不冻结无数据的性能数字，也不把任何待实测项写成 PASS。本次修订的独立复审与各 X-card 运行状态分别记录，不因文档修改或 resolved 自动解除 13 的实施/能力启用门禁。
