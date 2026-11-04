# T24：首次 CLI 验收 gate

Issue：[#25](https://github.com/qsgy-edge/euler/issues/25)。验收日期：2026-11-04。

## 结论

**Gate：BLOCKED。B1/B2 已闭合，B3–B5 仍阻塞；初始 schema 未冻结。**

普通 CLI 输入、显式项目绑定及待定候选自动续办已由 [#54 / PR #56](https://github.com/qsgy-edge/euler/pull/56)、[#55 / PR #58](https://github.com/qsgy-edge/euler/pull/58) 交付，并在合并基线上通过受影响组合复验。共享 Core 三平台回归、Windows 实际 CLI/文件操作、候选验证、恢复与清理证据符合下述限定场景。真实 provider 与部分独立证据尚未齐备。

当前 `schema 30` 只用于 disposable 数据库，forward-migration 测试副本为 `31`。没有生成初始 migration，也没有在本票补写产品、基础测试或 CI。

判定依据是 [I01/I03/I05/I08](../architecture/issues/15-euler-v1-spec.md)、[08 §4a](../architecture/issues/08-automate-memory-evolution.md)、[X-card](../architecture/issues/12-build-evidence-experiment-matrix.md) 和 [D8 / Physical contract](../architecture/issues/13-select-target-v1-migration.md)。#25 是验收票；缺功能与基础验证交回所属实施票。

## 被测身份与原始证据

| 对象 | 身份 |
|---|---|
| B5 取消取证基线 | `4d50e249017034bce1095a1d1325ae90d3da3fd6`，tree `74055fb4f17642dd88b9cf53e0b1c17ec0b887dc` |
| B1/B2 组合复验基线 | `a23c0a28233b5780be7799bad00032d29c3d2d24` |
| 组合复验 tree | `1d4b6fdc6d9de4f53966a83f26921baa64a5b76b` |
| PR 最终 head | `a9daae15110927b9029a57086cd5c726efc3d2c9`，tree 与基线相同 |
| CI checkout | `b34b2115f6b80972f943f98fcc184f1d01ed3a79`，tree 与基线相同 |
| CI | [41630746615](https://github.com/qsgy-edge/euler/actions/runs/41630746615)，PR 三平台均成功 |
| 本机 | Windows `10.0.28120` x64；Node `v24.18.0`；SQLite `3.53.1` |
| DDL 观测值 | version `30`；72,161 UTF-8 bytes；SHA-256 `d7fce58c04868f3cdf3b32cc4f26205140af6fec51f0ba0f3e6e50015adb9d48` |

DDL 从基线源码的实际表达式展开，用标准 SHA-256 独立计算，并与所查 SQLite 的 `schema_meta` / `PRAGMA user_version` 对照；它是 disposable DDL 身份，不是初始迁移批准。

### 三平台 CI 原件

制品名为 `synthetic-<os>-latest`，原始 ZIP 和核验结果保存在 `D:/GithubRepositories/Agent/euler-t24-acceptance/artifacts/t24-pr58-acceptance/`。

| 平台 | Artifact ID | ZIP SHA-256 | 1001 项测试 | 文件摘要核对 |
|---|---|---|---|---:|
| Windows | `13229799790` | `6a729b91fa8876cf0bf26f9e9067c30d5ee75e13900a473e74fa2eda46515256` | 997 pass / 4 skip | 8,022 |
| macOS | `13229392708` | `97870d5094fc420aac9dfa2a3f173f9e15eea21579e9a5020951c3666be0e1cd` | 964 pass / 37 skip | 7,836 |
| Linux | `13230355630` | `f782f4ac328939cdcc5b2b1b9f5219b31a447992c6a1fb6ab03fc1c4e73b182b` | 964 pass / 37 skip | 7,836 |

三平台原始 `verification.log` 均为 0 fail / 0 cancelled。57 份顶层 receipt、23,694 条文件摘要无缺失或不匹配；ZIP 摘要与 GitHub 元数据一致。摘要数是 receipt 引用条目数，不是互不重复的实验数。同 head 的 push run 被取消，本次采用成功的 PR run。

CI 执行原有 19 项 evidence 命令和全部 portable 测试；独立 `evidence:session` / `evidence:scope` 尚未加入 CI 命令列表，其原始 receipt 来自 Windows 本机，不能写成三平台独立 session/scope 实测。完整 Windows 原系统卷边界补测由该 CI 的独立步骤记录。

合并前独立核对最终 scope 原件、Standards/Spec 与 guidance 增量审查、Greptile 最终 head 5/5 和已解决线程，详情见 [#55 合并验收](https://github.com/qsgy-edge/euler/issues/55#issuecomment-6605101374)。

### 本机组合复验

工作树：`D:/GithubRepositories/Agent/euler-t24-resume`。运行时 tracked tree 干净；使用系统临时目录和独立 `LOCALAPPDATA`，仅创建合成数据。日志与审计结果位于 `artifacts/t24-resume/`。

- `environment.json` 固定实现、tree、Node 和隔离环境。
- `entry-scope-tests.log`：53 pass、0 fail、0 skip；实际入口、两条候选管线、guidance、任务边界、并发、恢复、backup/purge。
- `context-recovery-tests.log`：16 pass、0 fail、0 skip；跨项目授权/撤销、配置 HTTP、混合 correct/forget/restore/rollback 的长期摘要与重启、forward migration。
- `evidence-results.json`：顺序执行 `evidence:session`、`evidence:scope`、`evidence:context`、`evidence:historian`，四项 exit 0；前两项 scoped pass，后两项保留真实 provider 等 evidence-gap。
- 原件目录分别为 `artifacts/t54-1793713725416/`、`t55-1793713748041/`、`t18-1793713790066/`、`t19-1793713818898/`，含实际 stdin/stdout、HTTP 或 counting 接收、source/SQLite、批准后的项目文件和 receipt。
- `local-verification.json` / `scope-verification.json`：复算 185 个原件文件摘要，独立读取 16 份 SQLite，核对 integrity/FK/schema、688 条正文/receipt 摘要、194 个 source ACK 和 50 条 attempt 的 assembly 关系。scope 的 4 次实际 HTTP、session 的 6 次实际 HTTP 均逐字节对齐账本；T18 的 17 次 counting 接收另行对照，不混称真实 provider 调用。
- `raw-combination-verification.json`：读取三平台 CI 的 82 份 SQLite，核对 2,095 条正文/receipt 摘要、来源、预算与 request 关系，复算 43 组完整清理。
- `schema-observation.json` / `observed-ddl.sql`：未批准冻结的 DDL 观测副本。
- `verify-local.py`、`verify-combinations.py` 和相邻 PR 验收目录的 `verify-ci.py` / `verify-scope.py` 是本次临时取证脚本，不是新增产品入口或必跑检查；读取数据库前复制原件及 WAL，不修改证据。

B1/B2 的完整回归采用与 `a23c0a2` 同 tree 的三平台 CI，本机对变化路径重跑上述 69 项检查和四项 evidence。B5 的取证按下表分别使用原失败提交和 `4d50e24`，没有在后者重跑全部 B1/B2 组合。没有外部 provider 调用、MC 访问或真实用户数据写入。

## Capability × host × X-card

`已证实` 仅覆盖列出的场景；整卡剩余缺口见 B3–B5。

| 能力 / X-card | 实际机制与运行证据 | 独立核验与结论 |
|---|---|---|
| 身份、CAS、事务、intent / X-01 | Core Store、T01/T02/T04 三平台；`session-create` / `session` / `/bind` | 实际 owner/session 身份、后绑定与重开已证实；不从 cwd/Git root 推断项目 |
| 检索与任务级发现 / X-02 | scoped FTS/CJK、资格重验、累计 grant；context-authority/HTTP | 授权、撤销、目标环境和跨会话拒读通过；独立 held-out 仍缺，见 B4 |
| search/proposal 投影 / X-03 | outbox、CAS、dirty/rebuild 与 CI projection tests | 已启用 search 子集通过；scope overview 未启用。#37 吞吐优化不单独阻塞本 gate |
| 输入、完整 ReAct、来源、窗口 / X-04 | 普通 stdin、AgentRun/Orchestrator、archive、GuidanceSession/Historian | 输入原字节先 durable、同会话工具/记忆/换窗、取消/unknown 与重启通过；真实模型质量见 B3 |
| scope、注入、guidance / X-05 通用 | Core 门禁、固定 schema、task-bound 确认、guidance 授权区分 | 常驻 guidance 不阻断合法续办，真实前台请求仍阻断；旧任务不被新绑定认领；MCP/Pi deferred |
| dispatch/unknown / X-06 | assembly/started 事务、独立 attempt、无隐藏 retry | 本机 HTTP/ledger、迟到响应与显式新预算续办通过；真实 provider 断流/重试见 B3 |
| owner/普通验证、conflict/feedback / X-07 | fast lane、独立 source Verifier、scope continuation、晋升事务 | 同 recordId 追加归属 revision/event，原证据不变，两管线实际 CLI 通过；语义质量与长源吞吐仍缺 |
| inspect/correct/forget/restore/rollback / X-09 | snapshot/CAS、不可变 receipt、suppression、长期摘要 | 混合操作重启、有界下一请求、scope 续办后的 forget/清除通过；开放复述真实模型验证见 B3 |
| 呈现、批准、Info / X-10/X-11 | CLI 文本呈现、live-input、durable pending/Info | 实际输入与精确文件批准、原始“同意”恢复、去重 Info、缺载体阻断通过；无需新增富 UI |
| backup/恢复/完整 purge / X-12 | snapshot owner、fence、逐载体清理、SQLite 末段维护 | 当前 schema 及新增 task/scope 关系的备份恢复、原件保留、独立 sibling 与防复活通过；历史失败见 B5；断电未测 |
| Windows path/权限 / X-13 | native handles、资源身份与逐次批准 | 本机真实文件读写、目录改名/替换、CI 原系统卷边界通过；macOS/Linux 原生文件 Host unavailable |
| provider/cache / X-14 | 显式配置、单次 HTTP、计量与 prefix/epoch | CI T23 98 次/平台受控请求及账本制品保留；真实缓存、成本/延迟与阈值见 B3 |

Pi 各模式、MCP、overview/raw backfill、bundle/X-15、行为评估/X-08、macOS/Linux 生产支持、MC 切换与 live canary 均为 deferred，不计为 PASS，也不作为 Windows 首次切片的额外前置。

## 实际组合与清理闭包

1. **普通输入→项目确认→guidance/文件→记忆/Info→换窗→重开。** T54 本机六份 HTTP body 与 ledger 一一对应，中文及首尾空白原样保存，文件真实批准后写入，下一请求包含已验证记忆。重开保留项目与 run 历史、不自动发送。取消、unknown、迟到工具、队列与显式 successor 由实际入口测试覆盖。
2. **无项目候选→可信绑定→两条验证管线→检索/Info→重启。** T55 本机原 archive 前缀、旧 revision/event/job 原字节保持；当前任务两候选各产生一次 `resolve-scope` 和 activation，初始区段与旧任务仍 local。普通 untyped job 保留 identity，以四次真实 loopback HTTP 和独立 source 工具验证，原 null-project source 不改写。原始 owner agreement 与常驻 guidance 在同一 CLI 路径验证，恢复与并发不重复激活。
3. **发现→来源→换窗→报告/交接→新会话。** T18 每平台 17 次 received 与 counting receiver 一一匹配，保留 handoff、两版 report section 和来源。任务结束后的 grant 为 revoked。当前基线 HTTP `full` / `skip-expand` / `reject` 对照通过，缺展开不能验收，前置拒绝零发送。
4. **记忆操作→摘要→重启；后台生成→边界选用→恢复。** 混合操作测试覆盖 correct/forget/restore/rollback/cancel/supersession 后的完整历史与下一请求；T19 成功、protocol fallback、block/evidence-gap、unknown/cancel 的源、ledger、发布状态分别核对。T20 当前 CI 原件包含 Historian、handoff、Info、operation、canonical 与 unknown 的恢复，旧 owner 保持 blocked；本机 forward-migration 三个边界通过。
5. **逐载体清理→重开→防复活→新备份。** 三平台 T22b 的 43 组 before/after/final 覆盖 canonical、原文/报告/handoff/proposal、Info/receiver、conflict/suppression、Host、Historian、ready/staging/retired/migration/recovery 快照及 Windows 项目输出。清除前目标 canary 存在，after/final 788 个文件对正文/hash/locator/manifest digest 的命中为 0；逻辑 receipt 原字节不变，各有一个 controlled-complete、空 continuation、open fence 与 freelist=0。T55 另验证共享 task/绑定不扩大独立 sibling 删除范围，清除后五个载体无目标残留，重复绑定/drain 不复活，并可创建干净备份。

T18 counting 归档只有 payload hash/长度，不据此宣称完整 wire bytes 重建。SIGKILL、部分追加、ENOSPC/SQLITE_FULL 注入保留各自证据等级，不替代真实断电或填满物理卷。

## 冻结阻塞与归属

### B3 — 授权真实 provider 路径的运行证据未齐（未证实）

首次路由尚缺普通/工具回合、两条验证管线、长会话/交接、纠正意图、Historian 忠实度和 X-14 配对测量。接近实际长度的合成 source 吞吐与 deadline 结算也需有界 workload 证据。

当前非流式 transport 的 TTFT 为 `unsupported`；未给价格表则费用 `unknown`，没有 cache on/off、冷重置或明确服务端指标时不推断命中。

**归属：#7/#13–#19/#24。** 执行前需 owner 指定配置文件路径、credential 环境变量和总预算，不在聊天或 Issue 中贴密钥。不可用指标按原正确性/安全门禁保留 unavailable；不虚构数值或自动换路由。

### B4 — 历史测试集版本可对齐，独立封存与释放缺证（evidence-gap）

| 环节 | 元数据判定 |
|---|---|
| 实际评测对象 · 已证实 | 主工作树 `artifacts/t10-*/summary.json` 的 19 份原件逐份 SHA-256 与 `euler-t24-acceptance/artifacts/t24/t10-receipt-metadata.json` 清单一致。全部记录 H01–H05，`corpusDigests.heldout` 均为 `caf4e7ecd16061e9c96b92592d871501ea457b5bf5dd0c9334f9adbe031adb42`，与 `3ac75f0:scripts/evidence-retrieval.ts:12` 固定的摘要一致。 |
| 封存顺序 · 实现提交晚于已知评测 | 最早留存的 `t10-1790187988868/summary.json`（2026-09-23 18:26:28 UTC）及下一份 `t10-1790188670795/summary.json` 均记录 HEAD `56217fc`、Core 实现有未提交改动、held-out 文件在实现工作树中未跟踪。18:38:34 UTC，`3ac75f0` 才将实现与该文件一同提交；18:40:59 UTC 的 `t10-1790188859924/summary.json` 已是该提交的干净运行。`3ac75f0` 至验收基线 `79ace1e` 的文件 Git blob 均为 `47282fe7fa0fbfcc44e530f83e9954c5b0f942ed`。因此 `3ac75f0` 不能充当首次评测前的封存凭据，`56217fc` 也不能单独标识最早收据所测的实现。 |
| 独立释放 · 缺证 | 在所查 Git 历史、原始收据、[PR #35](https://github.com/qsgy-edge/euler/pull/35) 与 [#10 结案记录](https://github.com/qsgy-edge/euler/issues/10#issuecomment-5806109758) 中，未找到工作区外的保管者原件，能够把该摘要、封存时间及提交、被测实现、向独立评测者释放的时间及提交依次绑定。 |
| 污染与替代 · 缺证 | 19 份实现侧收据均已写出五个案例的 `gold`、`passed` 字段；此处仅核对字段存在性。没有逐案提前访问、按题改码、降级或替代的登记可供对照。材料在实现侧可见已证实；具体人员是否提前看过、哪些案例受影响未证实，不能登记为零污染。 |

**归属：#10；B4 保持开放。** 未找到同期的独立封存、释放及逐案污染记录。下一步仅向原保管者核对这些记录的元数据或可核验引用；不重跑旧集，不启用新集。本次未打开标准答案。开发集与任务级发现回归结论不变。

### B5 — 历史超时未结案；Windows prerequisite 取消实测通过

| 项目 | 判定 | 原始证据与边界 |
|---|---|---|
| T14 transport-conflict / [#57](https://github.com/qsgy-edge/euler/pull/59) | **已闭合** | PR #59 合并为 `4d50e24`，三平台检查通过。冻结 head `8d397e3` 的 worker 原件记录 23 个独立 attempt、exit 0，按起止时间差为 9.889 秒，原限时 30 秒；T14 的 15 项合成检查均通过。 |
| T16 首次 Windows push 的 T02 / [attempt 1](https://github.com/qsgy-edge/euler/actions/runs/39539111231/attempts/1) | **超时已证实，内部阶段未知** | `47d5002` 的两文件 runner：24 pass / 1 cancelled，`crash-in-transaction` 测试在 15,002 ms 达到 15,000 ms 限时。失败测试没有留下 setup、writer checkpoint、kill 或 reconcile 的时标。同批独立 cross-project 测试耗时 14,860 ms，不能由此归因为宿主负载。 |
| T20 owner receipt / `17d961e` | **已缩小阶段，内部原因未知** | 原 `t20-v7-check.log:578–580,821–844`：stdout、spawn 故障用例通过，receipt 用例在 180,043 ms 返回 `spawnSync ETIMEDOUT`。该轮遗留目录 `t12-1793019826519` 含故障 CLI 输出、raw SQLite 和两份错误记录；最后的 raw-validation 错误在目录命名时刻后约 0.86 秒写出。没有 `focused-test.txt`。源码在该错误后同步执行两个 owner 测试，再写此文件。由此可把停顿缩小至 raw-validation 已落盘、focused 输出尚未落盘之间；没有当次 worker/系统 trace 区分具体子测试、调度或 I/O。 |
| T15 全 prerequisite 进程树 / Windows | **已测场景通过** | 实际 `remember → model inspect → stop`，未替换 `execFile`。在 CLI、Node test runner、test worker 和更深子进程同时存活时发送 stop。三轮均报告 cancelled、CLI exit 0、独立 loopback 接收 0；无终止策略的 Windows Job 分别累计 17/18/18 个进程，CLI 退出后 active=0，未调用清场终止。后两轮用内核退出时间核对，stop 时在场的 7 个后代分别全部先于 CLI 退出，最晚一个提前 8.818 / 8.575 ms。 |
| 同一取消路径 / WSL2 Linux | **后代会短暂晚于 CLI 退出** | 两轮实际 stop 均零发送。stop 后 21 ms 的采样中 CLI 已以 0 退出，各有 1 个同一隔离 session、已重新挂接父级的进程仍在运行；62 ms 时均已自然退出。另一次未达到采样条件，未发送 stop，不计入这两轮。macOS 没有同类进程级取证；Linux/macOS 生产支持仍为 deferred。 |

**历史超时复跑。** 两个历史提交使用各自 lockfile、全新合成目录、空 Jiti cache、Node v24.18.0 和原限时，在 Windows 顺序运行；T16 保留原来的两个并行测试文件。普通/分阶段冷复跑中，T16 目标用例分别为 2.449 / 2.671 秒，第二轮依次观察到 setup、未提交 checkpoint、强杀与 reconcile。T20 的 receipt 目标用例分别为 33.555 / 43.955 秒，第二轮 nested focused runner 占 42.391 秒并返回 0。两次历史超时均未重现；复跑时长不用于解释原失败。T20 的目标重放没有模拟原全量 suite 的宿主负载。

**原件与归属。** `D:/GithubRepositories/Agent/euler-t24-resume/artifacts/t24-b5-4d50e24/` 保留原失败样本、副本摘要、按提交隔离的冷复跑输出和逐阶段 trace、Windows Job 与 Linux /proc 样本。#25 登记的 GitHub 前置均已关闭。B5 在 Windows 首次切片仍留 #2/T02、#12/owner-evidence 两项历史内部原因；下次同路径出现超时时需要当次子进程阶段/退出证据。Linux 的退出顺序单列，不计为 Windows 失败。#38 已解决的 T15 轮询竞态不重新打开。

## 放行条件与支持范围

B1/B2 的实施及受影响组合证据已闭合。B3 授权真实路径、B4 独立检索证据、B5 的两次 Windows 历史超时仍须闭合；修复后按实际影响更新组合证据。满足原 gate 后才冻结初始 DDL、版本、SHA-256 和实现 commit。

有效结论为共享 Core 三平台 CI、Windows 合成普通 CLI、候选续办与本文列出的组合路径通过；首次完整 capability 仍 blocked。该结论不授权 MC 重建、真实数据迁移、owner 切换或 T27 canary。
