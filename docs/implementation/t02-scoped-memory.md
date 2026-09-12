# T02：Scoped memory 的合成存储切片

对应 [Issue #2](https://github.com/qsgy-edge/euler/issues/2)，契约基线是 `a3f253f9bef0415364b3b224e5eb4ba150111325` 的 I03–I06、08 Canonical transition contract、10 canonical relational model 和 X-01 的本票子项。

## 运行与身份

要求 Node 24.18.x 或更高的 Node 24。继续使用 [T01 disposable sandbox 的资源与身份围栏](t01-synthetic-probes.md)，不会打开真实 MC、生产数据根或切换 live owner。此切片将 disposable SQLite schema 更新为版本 3；旧版本拒开，重新生成合成沙箱即可，不做生产迁移。

```powershell
npm ci --ignore-scripts
npm run check
npm run evidence:memory

$created = node apps/cli/src/main.ts create | ConvertFrom-Json
$probeRoot = $created.root
node apps/cli/src/main.ts memory --sandbox $probeRoot
node apps/cli/src/main.ts recover --sandbox $probeRoot
```

`memory` 从实际 fsync+复读过的合成 source 建立 intent、candidate、verification、active head 和两个 inert proposal 版本；输出来源、完整 snapshot、历史事件和待消费 outbox。`recover` 是新进程读取，不重新发送或激活。定向测试还从不同 cwd 打开同一沙箱，验证 project identity 来自固定 binding，而不是 cwd/Git root。缺少 head 时从不可变事件重建；已有 head 与事件不一致时拒绝覆盖。

`fixtures/scoped-memory.json` 是公开开发 fixture，非 held-out。fixture identity digest 是解析后按文件键顺序 `JSON.stringify` 的 UTF-8 SHA-256，原始文件 bytes 另记 rawDigest。source/session/owner/project 身份仍来自 `fixtures/first-turn.json`；该 host UUID 是合成身份，实际 OS/Node/SQLite 版本另行记录。

## 已实现的存储行为

- record、revision、event、verification run、conflict set、proposal 等行 identity 由 Store 分配。record 稳定；revision/event/证据与 proposal 版本 append-only；head 通过 record/revision/event 复合外键保持关联。SQLite writer guard 限制普通外部连接插入这些行；它不是防御能修改本机数据库、DDL 或注册自定义函数的恶意进程的安全边界。
- 类型、lifecycle、verification 使用既有枚举。project/personal 必须匹配当前 owner binding。未解析 scope 只能是当前 session candidate。workspace membership 尚未接线，workspace scope 拒绝。`appliesTo` 用有序关系行保存；当前 CLI 要求所有条件匹配 `cli` 或当前 `process.platform`，未知条件不放行。
- 每次来源验证都经原 CLI archive adapter 复读 immutable locator/完整事件 hash/text hash。`verifyMemory(pass/block/evidence-gap)` 的结论由**合成 fixture**提供，事件带 `synthetic:true`；这不证明语义真伪、来源独立性或模型资格。独立语义 Verifier 属于后续 Core。
- 完整 snapshot（含 head_event_id）参加 CAS 与请求 digest。对原请求重试且其结果仍是当前 head 时返回 no-op；head 已改变时旧请求 stale。`lookupMemoryOperation` 可查询历史已提交结果，供 unknown 后先查再决定是否重试。曝光写 `feedback_events`，不写 mutation event。
- capture/source 重放、相同/空白 correction、重复转换不会制造 mutation receipt。correction 追加 revision 并降为 unverified；synthetic automatic revision 同事务保存验证结果。activation/自动修订分配 batch identity，与完整 event manifest 的 search/host-info outbox 一起提交；其他 mutation 保存 search outbox。此票只持久化待消费项，没有 search worker、真实 Host 通知或行为发布入口。
- forget 留 tombstone，restore 是单独转换且重新核验来源/资格。同 lineage 与 canonical `claimKey` 的重述保持抑制；fixture 显式提供稳定 claimKey。未提供时仅使用 NFC/trim 正文作为确定性 key，**不宣称识别任意自然语言同义改写**；语义 claim 归一化仍属后续 Core。
- conflict 将两侧隔离。rollback 只撤销可行动的自动 activation/修订，复用旧 revision，生成新 head/event 身份；连续 B→A 回滚使用最新 CAS，拒绝旧 preview 和人工 correction 回滚。
- proposal 保存版本化 target/type/risk/expected change/owner/scope/source/evaluation 建议，修订追加、输入幂等、完整 payload digest 可复算。`inert:true` 固定，无评估执行、安装、写入目标文件或发布能力。intent 与 memory 使用各自的事件/head。

所有 mutation 使用同一 fence 事务；嵌套调用使用 savepoint，即使调用者捕获失败，也不会保留半写 revision/event/outbox。

## 实际字段的归属与未来清除闭包

此表清点本票实际存储的内容，不授予删除权限。物理 purge 尚未实现；append-only 约束仍保留，运行结束只删除本次创建的完整 disposable 沙箱。后续受控 purge 必须覆盖下列正文副本和反向引用，不得只删 memory head。

| 归属 | 实际字段/关系 |
|---|---|
| CLI source owner（session） | `session.jsonl` 的完整输入；SourceAck 的 binding、eventId、locator、hash、contentHash、byteLength。源 bytes 只由 CLI owner 管理。 |
| Core canonical memory | `memory_records.claim_key/source_lineage`；`memory_revisions.content/source_json` 和来源标量；`memory_applicability`；`memory_heads.snapshot`；`memory_events.before_snapshot/after_snapshot/payload`（含 evidence/旧内容）。删除闭包需按 record→所有 revision/event/head 展开。 |
| Core capture/provenance | `capture_jobs.payload/source_event_id/record_id`；`provenance_refs.payload/source_json` 及 record/revision/source owner、event、locator/hash 关系。 |
| Core verification/conflict | `verification_runs.evidence_json`；`verification_evidence` 的 run→source owner/event/locator/hash 反向索引；`conflict_members` 的 record→conflict set。 |
| Core inert proposal | `evolution_proposals.payload` 及 target/expected_change/scope_json/evidence_json/evaluation_json，supersedes 的版本链；`proposal_evidence` 保存 input 和所有 evidence 的 source owner/event/locator/hash 反向索引。target 只是字符串建议。 |
| Core projection/feedback | `projection_jobs.payload` 含完整事件副本，按 event/owner/scope/batch 归属；`feedback_events` 引用实际被查询的 record/revision/head event，不复制正文。 |
| Core intent（T01 延续） | `intent_events.snapshot`、当前 input 与继承 goalInput 的来源标量、`intent_heads`。同一 source 的 intent 引用不能因只清 memory 而遗漏。 |
| 本地合成证据 owner | `artifacts/t02-*` 的 JSONL stdout、SQLite/source 副本、测试输出；它们含合成完整内容，独立于运行数据库。真实生产数据不得进入此通道。 |

## 故障与原始证据

```powershell
node --test apps/cli/test/memory-store.test.ts
node --test apps/cli/test/memory-recovery.test.ts
npm run evidence:memory
```

证据脚本驱动实际 CLI，并保存每个进程的原始 stdout/stderr、参数、退出状态、结束后的 SQLite/source 副本和逐文件 digest。其验证器不导入 Core 的 hash/recovery helper：在临时副本中独立复算 source/revision/event/head/outbox/proposal，检查 FK、事件顺序和完整 payload，而不是仅检查 identity。

- 正常完成后由另一个进程恢复 intent 与 memory；伪造并重算摘要的 snapshot 必须被原始事件链拒绝。
- `crash-in-transaction` 在 correction 已执行、外层事务仍未提交时发出同步 checkpoint，然后父进程强杀；恢复只能看到旧 head，无部分 revision/event/outbox。另有 SQLite trigger 注入失败，覆盖 event 与 head 提交中断及 savepoint 回滚。
- `crash-after-commit` 在事务提交后、业务回执前强杀；新进程先 `lookupMemoryOperation` 找到实际结果，再恢复同一 head，不盲目重试。
- 两个真实 writer 从同一冻结 snapshot 竞争，恰有一个提交，另一个 stale；核对最终行数、FK 和恢复结果。

`memory-worker`/`memory-reconcile` 是 disposable CLI 测试接点；worker 的 checkpoint 最多等待 5 秒，未被父进程杀死则报错退出。不是后台自动化或产品操作 API。

每次输出新 `artifacts/t02-<timestamp>/summary.json`，记录实现 HEAD/tree、工作区状态、fixture digest、环境、原始观察、逐项 assertions 和 evidence-gap。工作区 dirty 的运行仅属于开发证据；最终绑定须使用已提交且 clean 的实现重新运行。`npm run evidence` 继续提供 T01 回归证据。

GitHub Actions 的现有 Windows/macOS/Linux matrix 都运行这两个证据命令；只有实际平台 run artifact 才能支持该平台通过结论。Windows 本机强杀不证明断电持久性或其他 OS 已通过。全 X-01、生产 data root/live owner、真实语义 Verifier、pending/ledger/Host 消费者及物理 purge 仍属于其他切片，不能用本票合成 verified 或本地 pass 替代。
