# T24：首次 CLI 验收 gate

Issue：[#25](https://github.com/qsgy-edge/euler/issues/25)。验收日期：2026-11-03。

## 结论

**Gate：BLOCKED。B1/B2 已闭合，B3–B5 仍阻塞；初始 schema 未冻结。**

普通 CLI 输入、显式项目绑定及待定候选自动续办已由 [#54 / PR #56](https://github.com/qsgy-edge/euler/pull/56)、[#55 / PR #58](https://github.com/qsgy-edge/euler/pull/58) 交付，并在合并基线上通过受影响组合复验。共享 Core 三平台回归、Windows 实际 CLI/文件操作、候选验证、恢复与清理证据符合下述限定场景。真实 provider 与部分独立证据尚未齐备。

当前 `schema 30` 只用于 disposable 数据库，forward-migration 测试副本为 `31`。没有生成初始 migration，也没有在本票补写产品、基础测试或 CI。

判定依据是 [I01/I03/I05/I08](../architecture/issues/15-euler-v1-spec.md)、[08 §4a](../architecture/issues/08-automate-memory-evolution.md)、[X-card](../architecture/issues/12-build-evidence-experiment-matrix.md) 和 [D8 / Physical contract](../architecture/issues/13-select-target-v1-migration.md)。#25 是验收票；缺功能与基础验证交回所属实施票。

## 被测身份与原始证据

| 对象 | 身份 |
|---|---|
| 实现基线 | `a23c0a28233b5780be7799bad00032d29c3d2d24` |
| Git tree | `1d4b6fdc6d9de4f53966a83f26921baa64a5b76b` |
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

本轮没有重复本机全量 suite 或全部 22 项 evidence；完整回归与未变场景采用同 tree 的三平台 CI，本机对变化路径重跑上述 69 项检查和四项 evidence。没有外部 provider 调用、MC 访问或真实用户数据写入。

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

### B4 — 独立 held-out 收尾不完整（已证实缺字段，运行结论未证实）

先前核对的 19 份历史 T10 receipt 没有 held-out owner、sealed/released commit、污染或替代案例记录，不能充当当前基线完整 held-out PASS。开发集、任务级发现与上述实际工具回归保持有效。

`docs/implementation/t10-memory-retrieval.md` 明确 Git 历史不能单独证明封存先于结果；现有 `scripts/evidence-retrieval.ts` 混合开发与 held-out 执行，本轮未打开 gold、未重跑或替换案例。

**归属：#10。** 先恢复封存证据和污染记录；可重复开发验收与手动 held-out 分开，保存匹配基线及独立复算的原件。确需替代时登记理由，不追改旧 gold。

### B5 — 历史失败与取消后代证据待结案（部分已证实）

- [T16 首次 Windows push](https://github.com/qsgy-edge/euler/actions/runs/39539111231/attempts/1) 的 T02 原始结果是 24 pass / 1 cancelled；停顿阶段未证实。
- 旧 `artifacts/t20-v7-check.log:821-844` 的 owner receipt 故障用例在 180 秒达到 `ETIMEDOUT`；阶段复跑成功未解释原停顿。T18 已批准的观察预算对齐没有声称解决底层波动。
- `docs/implementation/t15-owner-correction.md` 记录仅验证 prerequisite 直接子进程退出，完整后代退出仍无独立证据。
- [#57](https://github.com/qsgy-edge/euler/issues/57) 已在原基线、fresh sandbox、禁用 compile cache 且无 profiler 的真实 `transport-conflict` worker 复现 30 秒限时。热点指向重复文件身份、archive scan 和 SQLite prepare；负载/缓存贡献未完成单变量归因。原预算串行通过不关闭该问题；owner 已将其从 #55 单独拆出。

**归属：#57 及 #2/#7/#12/#15 的 runner/Host，T18/T20 提供既有原件。** 修复和基础测试交回对应票；不调大超时、改 skip 或用重跑成功替代结案。#38 已修复的 T15 轮询竞态不重新列为问题。

## 放行条件与支持范围

B1/B2 的实施及本轮受影响组合证据已闭合。B3 授权真实路径、B4 独立检索证据、B5 失败/取消边界仍须闭合；修复后按实际影响更新组合证据。满足原 gate 后才冻结初始 DDL、版本、SHA-256 和实现 commit。

有效结论为共享 Core 三平台 CI、Windows 合成普通 CLI、候选续办与本文列出的组合路径通过；首次完整 capability 仍 blocked。该结论不授权 MC 重建、真实数据迁移、owner 切换或 T27 canary。
