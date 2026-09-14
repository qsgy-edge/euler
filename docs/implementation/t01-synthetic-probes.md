# T01：首轮合成会话与关键接点

本切片对应 [Issue #1](https://github.com/qsgy-edge/euler/issues/1)，规范基线为 `a3f253f9bef0415364b3b224e5eb4ba150111325` 的 I01–I03、I08–I11、I18、D8.1/P0 和 X-04/X-06/X-12 的合成子项。这里冻结可执行的 P0 接口和失败语义；不冻结生产 DDL，也不宣称整张 X-card 通过。

本文的 schema/恢复表描述 T01 原始切片；当前实现已由 [T02](t02-scoped-memory.md) 扩展 memory 表族与恢复输出，旧 disposable schema 拒开后重新生成沙箱。

## 运行

要求 Node **24.18.x** 或更高的 Node 24、npm。无需 provider、凭据、Pi、MC 或生产数据库。

```powershell
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test

npm run demo -- success
npm run demo -- archive-failure
npm run demo -- blocked
npm run demo -- maintenance
```

`success` 的 `source-ack` 发生时 sends=0，随后 `run-result` 恰有一次本地接收。`archive-failure` 和 `blocked` 是预期退出码 **1** 的拒绝演示，sends=0。`archive-failure` 只损坏该命令刚创建的可删除 carrier；不得对指定的现有沙箱执行故障注入。`maintenance` 输出旧运行/子任务退出、维护独占/释放、新运行成功的完整观察链。

`npm exec -- euler archive-only` 可使用 workspace binary；编译产物入口是 `node dist/apps/cli/src/main.js success`。JSONL stdout 是本票探针的观察格式，不是已启用的产品 JSON/RPC 宿主模式。

跨进程恢复与重复提交：

```powershell
$created = node apps/cli/src/main.ts create | ConvertFrom-Json
$probeRoot = $created.root
node apps/cli/src/main.ts run --sandbox $probeRoot --scenario archive-only
node apps/cli/src/main.ts recover --sandbox $probeRoot
node apps/cli/src/main.ts run --sandbox $probeRoot --scenario archive-only
```

三次结果的 event identity/hash 一致，`eventCount=1`，sends=0。`recover` 只查询，不重发旧请求。显式 `run` 是启动新合成 run 的授权；不会把旧 run 的 unknown/预算状态解释为可继续运行。

## P0 契约与边界

| 接点 | 本票固定的行为 |
|---|---|
| 包/路径 | `packages/core` 为共享 Core，store 内置于 `src/store`，Orchestrator 位于 `src/context`；`apps/cli` 为 Host。未创建 Pi workspace、MCP、overview、bundle 或后台空设施。 |
| 数据身份 | `appId=euler`。只在 OS 临时目录下由 `mkdtemp` 创建 `euler-t01-*`，绑定随机 store ID、root/file dev+ino、固定 fixture owner/host/project/session/branch。logical project 不从 cwd/Git root 推断。重新打开必须有原 manifest、原 carrier/DB identity 和匹配 fixture；丢失/替换/损坏不当新建。fixture host UUID 是合成身份，真实执行宿主另在 evidence 中记录。 |
| 生产数据根 | 已定 Windows `%LOCALAPPDATA%/euler`、macOS `~/Library/Application Support/euler`、Linux `${XDG_DATA_HOME:-~/.local/share}/euler`；本票不会打开或创建这些生产根，也没有切换 live owner 的入口。 |
| HostAdapter | 进程内 `euler-p0@1`；提供固定 binding、source append/lookup/read/expand 和 `local-counting@1` transport。可信 Host 只转换输入/载体/输出，不提供模型自批或任意 transport 注册。 |
| Source carrier | CLI-owned `session.jsonl`，首行 `cli-session@1` header，后续 `cli-input@1` user event。UTF-8 JSONL，事件必须保持 CLI 写出的固定字段顺序和字节编码；严格读取全文件并拒绝残尾/重复身份/坏 schema/非规范事件字节。文件上限 1 MiB，输入必须非空且至多 64 KiB；新输入与既存事件都校验。不增加 source 表族。 |
| Source ack | `cli-source-ack@1` 绑定 owner/host/project/session/branch、eventId、immutable locator、完整 event JSON bytes 的 SHA-256、byteLength 和 source text 的 contentHash；hash 不含行尾 LF。同 identity+规范事件 bytes 返回同 ack；异 text 为 `identity-conflict`，重排字段等字节改写为 `archive-integrity: event bytes conflict`。append fsync 后严格复读；unknown 先 lookup，lookup 也 fsync+复读，未查证不盲追加。 |
| Read/expand | 必须携带原 ack，重验 scope、carrier/file identity、完整事件 hash。`offset/limit` 单位是 Unicode code point，单页最多 4096；返回 total/end/truncated 和 excerptHash。缺失/篡改/越权报错，不返回摘要或其他版本。 |
| Retention/purge | 所有原始事件在沙箱内保留，不卸载、不回收、不生成 capture job；缺 ack 无 dependent intent/dispatch。未来 purge 必须按 I18 在维护独占后冻结实际 root/file identity、完整 manifest，再由原 owner 删除+durable ack；本票只实现退出/独占/释放探针，**purge 不可用**，不删除 source，不签 controlled-complete。 |
| SQLite | Node `node:sqlite`，WAL/FULL/FK，busy timeout=2000ms；schema 仅含 `owner_fences`、`owner_activities`、`intent_events`、`intent_heads`。初始化只能由新沙箱执行，未知版本拒开；不是生产 `001-initial.sql`，不提供原型迁移。 |
| 最小 intent | `readIntent` / `transitionIntent(expected_event_id,input_ref,transition)` / `recoverIntent`；包含稳定 intent/session/branch、event/version、goal/constraints、明确 scope、step/status、当前 input 与保留的 goalInput locator/hash。继承目标及冻结约束始终保留最初来源引用；step transition 不替换 goalInput。event identity 由 Core 分配，event/head 同事务，event 禁止 UPDATE/DELETE。重放相同 input/transition 幂等，异 transition 冲突，并发 expected-event 失配 stale。恢复、推进和发送均重验当前与继承目标来源，恢复还核对事件连续性/head/hash；来源缺失或字节改变时停止。P0 只允许可信 Host 改 step/status，额外字段明确拒绝；没有模型 transition、目标或 scope 扩大入口。 |
| 最后发送 gate | Core 保存 prepared assembly 的完整摘要，最终 gate 后重新验证它、source、intent version/state、预算及 fence；gate 内工具耗用也必须计入发送前的累计预算与本次预留之和。字符串 payload 在本地同步计数 transport 接收，拒绝/抛错/异步 gate 的发送次数为 0。每份 assembly 至多尝试一次，未知 outcome 不重试。没有可吞异常后继续发送的 provider hook。 |
| Probe receipt | T01 原始基线为 `local-dispatch-probe@1`、`formalLedger=false`，不证明 X-06。T06 接线后当前 receipt 的 `formalLedger=true` 表示本地 assembly/started/finished 事实已持久化；不升级历史 T01 证据为完整 X-06 PASS。字段包括 run/session owner、assembly、encoding/adapter、最终 payload hash/bytes、count/outcome；receipt 不进入 payload。 |
| 工具 | 固定八个 Core 工具名称保持规格集合；本探针仅提供有界 `source.expand` 行为，其他已知工具 `tool-unavailable`，未知工具 `unknown-tool`，无 shell/MCP/memory mutation。首轮 payload 无需工具，tools=[]；未实现完整模型 tool-loop、tool-call archive 或 receipt 两面呈现。 |
| 取消/恢复 | `cancel` 停止新增 prepare/dispatch/tool/intent transition；旧对象关闭后不可继续。无模型结果或后续工具自动执行。`recover` 仅恢复 source/intent；重新工作必须显式新 run。持久 run 用量、started/no-finished 对账/封存属于 P1/P2 ledger 接线，本票无恢复旧 attempt 入口。 |
| 维护 | runtime 在读取内容前同事务检查 open 并登记真实 PID、每进程随机 incarnation、进程起始时间、root/store 和 epoch。fence 固定实际 root/source/DB 的路径与 dev+ino，activity 以联合外键绑定 store/root identity。打开、事务和维护入口核验真实文件身份及持久绑定；资源被替换时拒绝继续或重新绑定。source/intent/dispatch 在实际入口重验；文件 append 与同步本地 dispatch 使用同一个短 fence 事务。closing 递增 epoch，拒绝新 runtime 和旧 append。activity 记录在进程关闭后继续保留，直到维护协调者以 OS 不存在证据完成 acquire/release；因此进程仍存活时即使 Host 已关闭数据库连接，也不能被当作已退出。独立协调者对所有登记 PID 观察 OS 不存在（`kill(pid,0)` 的 ESRCH），存活、权限错误或 PID 重用均不当退出。再取得 exclusive；释放以事务开放新 epoch，旧 activity 不复活。协调者存活时不能接管，确认退出后可接管。 |

进程测试还由父进程收集 runtime 和受控子任务的真实 `close`/exit 结果。idle、窗口消失、时间经过或租约过期都不解除围栏。`hold` 在退出前等待其受控 task 退出；`maintain` 的 EOF 只停止协调者，durable fence 保持关闭，后续需重新证明旧协调者已退出。

真实网络的 admission、外部 fsync 和 SQLite 不具有跨资源原子性。本地同步计数器放在 fence 事务中只用于这个窄探针；不可直接用此实现替换真实网络/ledger。Windows 文件 fsync+重启复读已可测试；Node 在 Windows 上没有这里采用的可移植目录 fsync，断电持久性仍是 evidence-gap。

## 有界测试初值

`DEFAULT_BUDGET` 使用 `probe-budget@1`：contextLimit=8192、outputReserve=256、safetyMargin=128、maxModelAttempts=1、maxToolCalls=4、maxTotalTokens=16384、wallClockMs=30000、toolTimeoutMs=2000。每字段须为正整数且 ≤1,000,000；reserve+margin 必须小于 contextLimit。API 可传完整配置，CLI 可用 `--budget '{"contextLimit":400}'` 覆盖已知字段。缺必需字段、NaN、非整数和未知 CLI 字段拒绝。

本地 synthetic estimator 把 UTF-8 payload bytes 作为保守 token 单位；不是任何 provider tokenizer。预算达到上限或取消后停止新增调用，不因 prepare 或恢复 source 重置。同步 source 工具完成后检查 timeout，超时不返回正文；不声称拥有异步/远端工具的中断能力。数值只用于可复跑的有界测试，不是性能最优值。

## 证据

```powershell
New-Item -ItemType Directory -Force artifacts | Out-Null
npm run check 2>&1 | Tee-Object artifacts/verification.log
npm run evidence
```

`evidence` 只使用无锁 Git 查询（`rev-parse` 和 `status`），不会写入 Git 对象或获取 index lock；验证器从公开 fixture、完整 JSONL 与 SQLite 原始行独立复算 ack binding/locator/byteLength/contentHash/hash、完整 intent snapshot/hash、head 和 resource/activity 绑定，并核对 payload hash、发送计数、维护 raw fence 状态和顺序。SQLite 验证在私有临时副本执行，原始证据保持不变；篡改 ack 与重新计算 hash 的伪造 intent 作为负对照必须被拒绝。输出 `artifacts/t01-<timestamp>/summary.json`：实现 commit/index tree/工作区状态、fixture digest、OS/Node/SQLite、原始文件 digest、逐条 assertion 和范围限定 verdict。每次新建目录，保留失败，不覆盖旧 run。未提交运行的 `implementationCommit` 和 `implementationTree` 分别记录当前 HEAD 与 `HEAD^{tree}`，staged candidate identity 由运行前的只读 tree 校验单独绑定；只有工作区 clean 且对应代码已提交的运行才能把证据绑定为最终实现。

`fixtures/first-turn.json` 是公开的确定性开发 fixture，不是独立 held-out。fixture identity digest 固定为解析后按文件键顺序 `JSON.stringify` 的 UTF-8 SHA-256，源文件实际 bytes 另记 rawFileDigest；因此 TypeScript 构建时 JSON 缩进变化不会使同一沙箱无法恢复。完整 X-card 的 held-out/真实 provider/production 门槛不由这些观察关闭。测试从公开 Core、实际 carrier、真实子进程和 transport 消费者边界验证；不测试私有 helper 布局。

GitHub Actions 已配置 Windows/macOS/Linux 的相同 `npm run check` 和 evidence artifact。每个平台只有对应实际 run artifact 才有 CI 结论；Windows 本机结果不升级为 macOS/Linux CI 或真实宿主通过。首次本票的实际环境与原始结果以生成的 evidence 为准。
