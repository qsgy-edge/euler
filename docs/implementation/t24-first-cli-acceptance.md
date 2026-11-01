# T24：首次 CLI 验收 gate

Issue：[#25](https://github.com/qsgy-edge/euler/issues/25)。验收日期：2026-11-01。

## 结论

**Gate：BLOCKED。初始 schema 未冻结。**

共享 Core、合成 CLI 和受控 HTTP 的已实现组合路径通过本次检查；首次可用 CLI 仍有接线缺口，真实 provider 与部分独立证据未齐。`schema 27` 继续用于 disposable 数据库；本次不生成 `migrations/001-initial.sql`，不改变产品、测试、CI 或规格。

判定依据是 [I01/I03/I05/I08](../architecture/issues/15-euler-v1-spec.md)、[X-card](../architecture/issues/12-build-evidence-experiment-matrix.md) 和 [D8 / Physical contract](../architecture/issues/13-select-target-v1-migration.md)。#25 是验收票：缺功能与基础验证交回所属实施票。

## 被测身份与原始证据

| 对象 | 身份 |
|---|---|
| 实现基线 | `b3195b91c7a2e6ddda1d13740215dbe8a97586d0` |
| Git tree | `20b545697f1245c0e772da90d800b1f480b6ddcc` |
| 复用 CI checkout | `c37d0b4eb5d949d5dc1eff425308eb3c3291793b`，tree 与基线相同 |
| CI | [41310859243](https://github.com/qsgy-edge/euler/actions/runs/41310859243)，三个平台均成功 |
| 本机 | Windows `10.0.28120` x64；Node `v24.18.0`；SQLite `3.53.1` |
| DDL 观测值 | version `27`；66,209 UTF-8 bytes；SHA-256 `3c3ef57d6c30ab827441300f41c12f1ca41a34558fa4297e27178249602a70ba` |

DDL 值由基线源码的实际 DDL 表达式展开并独立计算，和所查 SQLite 的 `schema_meta` / `PRAGMA user_version` 核对；这是被测 disposable DDL 的身份，不是初始迁移批准。

### CI 原件

制品名为 `synthetic-<os>-latest`。ZIP 保存在主工作区的 `artifacts/issue38-ci-41310859243/`，本次重新计算 ZIP、receipt、fixture 与所列载体摘要。

| 平台 | Artifact ID | ZIP SHA-256 | 947 项测试 | 文件摘要核对 |
|---|---|---|---|---:|
| Windows | `13086670234` | `14a3a7eee566b8b67e46be7e400c27c7e03ff008bbe2dc01a2524f91e49a8892` | 943 pass / 4 skip | 8,022 |
| macOS | `13085611646` | `402ac6a2554570c9b945eb10213ae1c350dd25bf7fe804f350dc8f5392b4f03a` | 911 pass / 36 skip | 7,836 |
| Linux | `13085444566` | `7a46b411aa19202d0a0e96857e8f50a0fa5c74510e6bbead9c277078eabf9c17` | 911 pass / 36 skip | 7,836 |

三平台均为 0 fail / 0 cancelled。57 份顶层 receipt、23,694 条文件摘要无缺失或不匹配。摘要数量是 receipt 引用条目数，不作为互不重复的实验数量。

### 本机复验

隔离工作树：`D:/GithubRepositories/Agent/euler-t24-acceptance`。证据目录为其中的 `artifacts/t24/`，相邻 `artifacts/t01-*` 至 `t22b-*` 及 `provider-*` 保存原始产物。被测工作树在运行时 clean。

- `local-inputs.json`、`local-results.json`、`local-complete.json`：19 个现有 evidence 命令、顺序执行、全部 exit 0；`local-receipts.json` 定位其原件，`local-file-verification.json` 记录 8,020 条摘要复算。
- `combination-tests-result.json` / `combination-tests.log`：42 pass、0 fail、0 skip，覆盖 context authority、HTTP 接线、混合记忆操作与重启、Windows 文件工具/强杀、forward migration。
- `ci-receipt-inventory.json` / `ci-file-verification.json`：三平台原始 receipt、环境与摘要索引。
- `raw-combination-verification.json`：独立读取 82 个 SQLite 镜像，重新核对 quick/FK、schema、2,095 条正文/receipt 摘要、来源引用、attempt/assembly 和清理结果。
- `schema-observation.json` / `observed-ddl.sql`：未批准冻结的 DDL 观测副本。
- `scope-probe/`、`scope-restart-probe/`、`interactive-probe/`：下述功能缺口的原始 stdin/stdout、数据库、独立进程退出记录和断言结果。
- `verify-ci.py`、`verify-local.py`、`verify-combinations.py`、`probe-scope.ts`、`probe-scope-restart.ts`、`probe-interactive.ts`：本次临时取证脚本；不是新增产品入口或必跑检查。

本次没有重新运行全部本地单元测试；全量回归复用上述同 tree 的三平台 CI。本机执行的是 19 个 evidence 命令和另外 42 项组合/Host 检查。没有调用外部 provider、读取 MC 或写入真实用户数据。

## Capability × host × X-card

下表将机制、运行原件和独立复算分列。`已证实` 仅覆盖列出的场景；整卡缺口见阻塞表。

| 能力 / X-card | Source mechanism | Stored receipt / 实际运行 | Independent validation 与判定 |
|---|---|---|---|
| 单库身份、CAS、事务、intent / X-01 | Core Store、标准数据根解析、事件/head、Host pending | T01/T02/T04 三平台与本机；T04 使用本机标准用户目录下的独立 synthetic app-id | 基线/fixture/文件摘要一致；portable CI verified；本机合成数据根已实测，正式 CLI owner/project bootstrap 仍缺 |
| 检索与任务级发现 / X-02 | scoped FTS/CJK、资格重验、累计 grant | CI dev/supplement 与 source-discovery tests；T18 实际工具循环 | 跨项目来源、撤销和新会话接续已证实；当前基线独立 held-out receipt 未齐，见 B4 |
| search/proposal 投影 / X-03 | outbox、CAS、dirty/rebuild | CI search/source projection tests；本机 source-recovery | 复用测试与摘要证明已实现 search 子集；scope overview 未启用。#37 的吞吐优化不单独作为本 gate 阻塞 |
| 预算、完整 ReAct、source、窗口 / X-04 | AgentRun、Orchestrator、archive、GuidanceSession、Historian | T11/T18/T19、#38 嵌套强杀记录；本机 context HTTP 与混合操作测试 | 原始 source ACK、预算、ledger 与重启状态核对通过；普通实际用户输入入口及真实 provider 组合未齐 |
| scope、注入、guidance / X-05 通用 | Core 权限/资格门禁，固定工具 schema | T09、T18、T23 identity cases，CI isolation/authority tests | 本机显式 grant 撤销、旧快照和跨会话副本拒读通过；合法 HTTP guidance/source 对照通过。MCP/Pi 专属部分 deferred |
| dispatch/unknown / X-06 | assembly/started 事务、独立 attempt、禁止隐式 retry | request ledger/recovery tests、#38、T23 本机 HTTP | 实际接收计数与账本匹配；真实 provider 断流、合法重试仍缺 |
| owner/普通验证、conflict/feedback / X-07 | owner fast lane、CaptureRun、独立来源 Verifier、晋升事务 | T12/T13/T14 三平台及本机 | 已实现管线与持久结果通过；unresolved 后续确认未接线，真实语义质量及接近实际长度来源的吞吐未验证 |
| inspect/correct/forget/restore/rollback / X-09 | 完整 snapshot/CAS、不可变 receipt、摘要与 suppression | T15/T16/T17；context-operations；T22b operations/rollback | 本机混合操作重启与有界上下文通过；三平台清理后原 receipt 不被改写；开放复述真实模型验证未齐 |
| 呈现、批准、Info / X-10/X-11 | CLI 文本输出与 live-input capability、durable pending/Info | T12/T15–T17、#38；本机 stdin/stdout、恢复与早到批准拒绝 | 合成 CLI 文本通道已实测；首次统一交互入口的 owner/project/provider 组合仍未验收。不要求新增富 UI |
| backup、恢复、完整 purge / X-12 | snapshot owner、fence、逐载体清理、SQLite 末段维护 | T20/T21/T22a/T22b；本机 19 命令与 migration tests | 三平台组合原件复算与本机实际进程/文件系统路径通过；未解释的历史测试超时仍列 B5；断电未实测 |
| Windows path/权限 / X-13 | Windows native handles、资源身份和逐次批准 | 本机 file-tools/windows-files/file-crash；T22b project-output | 实际 ACL、8.3、junction/symlink/hardlink、替换/取消/强杀检查通过；macOS/Linux 原生文件 Host unavailable，不声明生产支持 |
| provider/cache / X-14 | 显式配置、HTTP 单次发送、计量与 prefix/epoch | 本机 T23 98 次 loopback HTTP；三平台同 fixture | 本地 identity/成本字段/失败报告接线通过；真实缓存、延迟、费用及阈值未测，见 B3 |

Pi 各模式、MCP、overview/raw backfill、bundle/X-15、行为评估/X-08、macOS/Linux 生产支持、MC 切换与 live canary 均不在首次已启用能力中。它们保持 deferred，不用来阻塞 Windows 首次切片，也不计为 PASS。

## 实际组合与清理闭包

1. **发现→来源→换窗→报告/交接→新会话。** T18 每平台 17 次 received 与 counting receiver 一一匹配；保留原始来源、一个 handoff、两版 report section 和普通 source。已结束任务的读取 grant 为 revoked。本机 HTTP `full`、`skip-expand`、`reject` 对照通过，缺证据展开不能验收，前置拒绝零发送。
2. **记忆操作→长期摘要→重启。** 本机 `context-operations.test.ts` 复验 correct/forget/restore/rollback/cancel/supersession 后的有界下一请求和完整历史；旧值不因重启复活。T15–T17 原始 receipt 的旧长期摘要缺口由这组当前实现证据承接。
3. **后台生成→边界选用→恢复。** 三平台 T19 成功、protocol fallback、block/evidence-gap、unknown/cancel 的原始源、ledger、发布状态分别核对；未知与否定不伪造发布。T20 恢复包含 Historian、两版 handoff、owner Info、operation、canonical 关系与 unknown，旧 owner 保持恢复阻断。
4. **逐载体清理→重开→防复活→新备份。** 从 T22b preview 的真实选择和 before/after/final 载体读取，不采用 T21 logical 子集替代。43 组清理案例覆盖 canonical、source/历史版本、报告/handoff/proposal、Info/receiver、conflict/suppression、Host 操作、Historian、backup/staging/retired/migration/recovery 和 Windows 项目输出。82 份 SQLite 中包含这些清理后的 43 份；对其 after/final 共 788 个文件重新扫描目标正文、正文 hash、source locator/hash 和批准 manifest digest，命中为 0。逻辑 receipt 原字节不变；每个操作恰有一个 controlled-complete、continuation 已清除、fence=open、freelist=0；运行记录证明旧 source/token/job 拒绝后仍可启动一个新请求并创建干净备份。

T18 counting 归档保存 payload hash/长度，独立静态复算没有把它升级为全部原始 wire bytes 的重建；真正 HTTP payload 对照来自对应受控 HTTP 测试和 T23 原件。SIGKILL、部分追加和 ENOSPC/SQLITE_FULL 边界注入保留各自证据等级，不替代真实断电或填满物理卷。

## 冻结阻塞与归属

### B1 — 首次普通交互 CLI 尚未接通（已证实）

- `apps/cli/src/agent-cli.ts:90-109` 用 fixture 作为首轮输入；interactive 仅接收 `steer/follow-up/queue/cancel/status` 等控制词，三种输入模式也换成 fixture 正文。任意实际问句返回 `synthetic-command-required`。
- 本机 `interactive-probe/` 在真实文件批准等待期间输入 `Explain the current project.`，获得上述拒绝；随后 cancel，终态 cancelled，未批准文件写入。
- `agent-cli.ts:37-51` 的原生文件 capability 只在 `scenario=files` 绑定，真实 transport 只在 `scenario=real` 配置；现有公开 agent 命令没有两者的正常组合。`sandbox.ts:70-99` 仍是 disposable fixture 身份，不能充当实际 owner/project bootstrap。
- `remember` 的专用操作 stdin 与受控模型纠正可用；它的 `ask` 使用 counting path。各 demo 分别通过尚未组成 I01/X-04 所要求的首次普通会话。

**归属：#7（CLI/Host），联动 #8/#18。** 需提供明确 owner/project/session 绑定、真实输入及其 durable ACK、已选 transport 与可用能力在同一正常 CLI 会话的接线，再复验控制/取消/恢复。保留合成数据边界；不以 T24 名义实现。

### B2 — unresolved candidate 缺后续项目确认入口（已证实）

- `ProbeStore.rememberMemory`（`packages/core/src/store/probe-store.ts:3234-3299`）仅接收 `input/hostInfo/noActiveProject`。首次 capture 固定 unresolved scope；同 source 重放读取旧 candidate，并再次返回 `scope-unresolved`。
- 本机 `scope-restart-probe/` 用两个独立进程依次创建无 active project 候选、退出、重开，并在已有 project binding 下重放原 owner statement：仍为一个 session-local candidate、一个 capture event、零 verification run。
- `apps/cli/src/owner-memory.ts:403-405,457-466` 的公开命令没有确认/恢复该归属的入口。该缺口已在 [T12 交接](https://github.com/qsgy-edge/euler/issues/25#issuecomment-6244349509) 登记。

**归属：#12 的 owner-capture / Core scope owner，CLI 接点与 B1 协同。** I05 要求可信 project 确认后进入相应验证管线；重放参数本身不是确认授权。修复需固定确认来源与不可变历史关系，不能从 cwd 推断或直接改旧 scope。详细行为取舍须在实施票确认。

### B3 — 一条授权真实 provider 路径的运行证据未齐（未证实）

#7/#13/#14/#15–#19/#24 的受控 HTTP 和合成结果保留，不升级为真实模型结果。缺少首次路由的普通/工具回合、两条验证管线、长会话/交接、纠正意图、Historian 忠实度及 X-14 配对测量。

当前 transport 非流式 TTFT 为 `unsupported`；未给价格表则费用 `unknown`；未提供 cache on/off、冷重置或明确服务端指标时不推断命中。接近实际长度的合成 source 吞吐与 deadline 结算也需有界 workload 证据。

**归属：#7/#18/#19/#24 及所用 capture owner。** 执行前需 owner 指定配置文件路径、credential 环境变量与总预算；不需要在 Issue 或聊天中贴密钥。若 provider 不提供某指标，保留 unavailable 并按既定正确性/安全门禁判定，不虚构数据或自动换路由。

### B4 — X-02 的独立 held-out 收尾不完整（已证实缺字段，运行结论未证实）

三平台 dev/supplement 与任务级发现有测试记录。本机保留的 19 份历史 `t10-*/summary.json` 包含 corpus digest 和 observations，但没有 held-out owner、sealed/released commit、污染/替代案例记录；最后一份还绑定旧实现和脏工作树。它们不能作为当前基线完整 held-out PASS。

现有 `scripts/evidence-retrieval.ts` 将 H01–H05 和开发用 X01–X09 同时执行，按已有决定未接 CI。本次没有为“补一份通过”重跑或更换 gold。

**归属：#10。** 先核对可恢复的封存证据与污染情况；将可重复的开发/发现验收和手动 held-out 执行分开，保存匹配基线、平台和独立复算的原件。需要替代案例时明确登记，不追改旧 gold。

### B5 — 历史失败与未覆盖取消后代仍待结案（部分已证实）

- [T16 push attempt 1](https://github.com/qsgy-edge/euler/actions/runs/39539111231/attempts/1) 的原始 T02 `tests.stdout.txt` 是 24 pass / 1 cancelled；后续同提交通过未解释这次停顿的具体阶段。
- `artifacts/t20-v7-check.log:821-844` 保留 owner receipt 故障检查的 `spawnSync ... ETIMEDOUT`，180 秒到期。T20 的阶段计时复跑记录只证明复跑成功，未解释原停顿；T18 已批准对齐观察预算的调整也未声称消除底层耗时波动。
- `docs/implementation/t15-owner-correction.md` 明确仅验证 prerequisite 直接子进程退出，没有证明所有后代退出。当前原件不足以关闭完整进程树取消边界。

**归属：#2/#7/#12/#15 的测试 runner / Host 生命周期；T18/T20 提供既有诊断记录。** 新三平台回归和本次本机检查均成功，但 #25 明确要求未解释失败先结案。需要恢复原始阶段证据或建立真实 runner 的最小复现；不靠扩大超时、重跑成功或把失败改成 skip 收尾。已由 #38 修复的 T15 轮询竞态不重新列为未解决问题。

## 放行条件与支持范围

B1/B2 的正常入口、B3 的授权真实路径、B4 的独立检索证据及 B5 的失败/取消边界闭合后，按受影响实现、fixture、平台补跑组合验收。届时才能生成不可改写初始 DDL、版本、SHA-256 和实现 commit。未变的 portable 证据可按 tree/fixture 继续复用。

本次有效结论为：共享 Core 三平台 CI、Windows 合成 CLI/文件系统及上述组合检查通过；首次完整 CLI capability 仍 blocked。该结论不授权 MC 重建、真实数据迁移、owner 切换或 T27 canary。
