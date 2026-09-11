# LayerFS 与 Euler 上下文、记忆和未来自进化的关系

状态：研究参考记录；非规范，不修改 Euler v1 范围、schema、Core/Host 边界或实施顺序。

## 结论

Euler 当前计划可以继续按原计划执行。LayerFS 不应作为 Euler 上下文/记忆系统的新存储层，也不应在当前 v1 引入完整的 LayerFS 文件系统实现。

可以借鉴 LayerFS 的抽象原则：

```text
immutable raw history
        ↓
stable identity / hash / locator
        ↓
rebuildable projections
        ↓
bounded current view
```

Euler 当前设计已经有这些对应物：source/archive、memory revision/event/head、compartment、FTS、scope overview、context assembly、execution ledger、CAS 和 projection worker。LayerFS 的价值主要保留给未来行为自进化的候选 Workspace，而不是当前 Context 或 Memory Core。

## 当前 Euler 中已经覆盖的 LayerFS 理念

| LayerFS 理念 | Euler 对应设计 | 判断 |
|---|---|---|
| 原始状态不可变保存 | source/archive、原始 session 事件 | 已有 |
| 内容有稳定身份 | locator、revision、source hash、payload hash | 已有 |
| 从原始状态生成派生视图 | compartment、FTS、scope overview、context assembly | 已有 |
| 派生视图可删除并重建 | search、projection、cache、overview | 已有 |
| 当前视图只是历史的有限投影 | Context Orchestrator、P0–P3 assembly | 已有 |
| 从固定状态重新尝试 | fresh rebuild、shadow、baseline/treatment | 已有 |
| 新版本不能覆盖旧版本 | revision、head_event_id、CAS、generation | 已有 |
| 候选可隔离、保留、丢弃或回滚 | inert proposal、held-out、canary、rollback | 已有设计 |

最值得吸收的原则是：**历史逻辑上完整保存，当前上下文只保留有界投影。**这与“把所有历史都塞进当前 prompt”相反，也不要求把每个 context window 变成一个文件系统分支。

## Context、Memory 与 Trajectory 的边界

这三类数据不能合并：

```text
Trajectory
= 实际发生过什么

Memory
= 从 Trajectory 中提取并通过验证的可复用事实

Context
= 为当前一次模型调用选择的有限投影
```

LayerFS 适合管理完整 Workspace 状态；Euler Context/Memory 管理事件、证据、语义版本和 prompt 投影。它们的对象不同。

## 建议保留的数据

| 数据 | 保留策略 | 用途 |
|---|---|---|
| 用户输入 | 由 source/archive owner 持久保存，带稳定 event ID、顺序和 hash | 原话恢复、目标和授权证据 |
| 用户可见的 Agent 回复 | 持久保存原始事件 | 恢复对话和审计事实 |
| assistant tool call 与 tool result | 必须成对保存，带调用 ID、参数和结果 | 重放 ReAct、恢复证据、判断实际副作用 |
| 外部文件、网页、命令输出 | 由 source owner 保存；Euler 保存 locator、范围、版本和 hash | 按需 source recovery |
| Context assembly | 只保存 assembly 元数据、选入/排除 refs、顺序、预算、降级步骤和 hash | 证明本次请求实际使用了什么 |
| Compartment | 保存原文范围、原文 hash、摘要 hash、生成模型/attempt 和 locator | 降低 live context 成本，但保留原文恢复能力 |
| Memory revision/event | 持久保存完整生命周期和 provenance | 验证、替代、冲突、遗忘、恢复和回滚 |
| Execution ledger | 保存 owner、attempt、provider/model、payload hash、usage、终态和恢复状态 | 证明请求是否实际发送、避免未知状态下盲目重试 |
| FTS、embedding、cache、状态栏 | 可删除、可重建 | 不是真值，不应阻塞 canonical history |
| 模型隐藏 reasoning | 不默认进入核心轨迹 | 除非有独立调试/审计需求，否则结果和工具事实更重要，且更容易控制敏感信息 |
| Workspace 文件快照 | 单独由候选 Workspace owner 管理 | 未来行为自进化，不属于 Memory 或 Context |

Ledger 不应复制完整 prompt、source 正文或工具输出正文。它保存可复算的身份、引用和 hash；正文继续由相应 owner 保存。这和 Euler 当前的 execution ledger、source/archive、memory canonical store 分离设计一致。

## LayerFS 对 Context/Memory 不需要的部分

### CAS、CDC、COW

内容寻址和 hash 对 Euler 有用，但主要作用是身份和完整性，不是文件存储优化。

CDC 对普通轨迹价值很低，因为轨迹本来就是 append-only 的事件序列。新增一条消息不会导致前面所有消息重写。大型工具结果可以通过有界 range、chunk 和 locator 读取，不需要引入完整 CDC 文件存储。

COW 在 Context 层已经以逻辑形式存在：新窗口复用旧 archive、compartment 和 memory，只重建当前 assembly。没有证据证明还需要一套 COW 文件树。

### LayerFS SQLite

Euler 已经选择 Node 24 SQLite 保存 memory、intent、execution ledger、projection 和 receipt。再引入 LayerFS SQLite 会形成两个 canonical store，并增加：

- 跨数据库一致性；
- 两套恢复语义；
- 两套隐私清除闭包；
- 记录究竟由哪个 store 拥有的复杂问题。

因此 LayerFS Store 不应成为 Euler 的 canonical memory 或 context store。

### FUSE、文件系统挂载和运行中 Commit

这些对 Context/Memory 没有直接价值。上下文压缩、窗口切换、source recovery 和 memory revision 不需要 FUSE。

LayerFS 的 FUSE/容器能力也不能代替恶意候选代码的安全隔离。Euler 仍需由 Host 根据真实平台提供容器、VM 或其他经过验证的执行隔离；没有能力时明确 `unavailable`。

## LayerFS 对未来自进化有用的部分

未来行为自进化可以采用下面的逻辑：

```text
inert evolution proposal
        ↓
冻结 baseline checkpoint 和 evaluation contract
        ↓
创建 candidate workspace
        ↓
修改 code / Skill / AGENTS / policy
        ↓
运行 evaluator
        ↓
独立 verifier
        ↓
held-out / canary
        ↓
promotion / rejection / rollback
```

这里可以借鉴 LayerFS 的：

- base snapshot；
- 从固定状态 fork；
- candidate diff；
- checkpoint；
- discard；
- 共享未变化内容；
- 通过 hash 标识候选状态。

但 LayerFS Commit 只能表示：

```text
候选文件系统状态已保存
```

它不能表示：

```text
候选行为已经改善，可以发布
```

行为发布仍然必须由 Euler 的 evaluator、独立 verifier、held-out/canary 和对应 artifact owner 决定。当前 v1 仍只保存 inert proposal，不实现行为评估 runner 或自动发布。

## 未来应增加的最小接点

如果以后实现行为自进化，最多先定义一个 Workspace Provider 接口，不引入 LayerFS 依赖：

```text
create(base, candidateManifest)
fork(checkpoint)
exec(candidate, command)
diff(candidate)
snapshot(candidate)
discard(candidate)
cleanup(candidate)
```

Candidate 记录可以保存：

```text
candidate_id
base_checkpoint_ref
workspace_provider
workspace_snapshot_ref
artifact_manifest_hash
runtime_manifest_hash
evaluator_id
heldout_digest
verifier_receipts
cleanup_result
```

其中 `workspace_provider` 可以是：

```text
git-worktree
| temp-directory
| container-overlay
| layerfs
| unavailable
```

当前实现优先使用 Git worktree、临时目录或受控容器。LayerFS 只有在真实证据显示以下问题成为瓶颈后再接入：

- 候选经常需要保留未提交的中间状态；
- 候选包含大量 Git 之外的生成文件；
- 多个候选复制大型工作区造成主要磁盘开销；
- 需要从一次候选执行的中间 checkpoint 继续分叉；
- Workspace 创建、复制和清理已经明显影响总体成本。

## 对“完整文件系统”的边界

未来自进化需要的是**完整候选执行工作区**，不是整台主机的完整文件系统。

候选状态可能包括：

```text
代码
+ Skill
+ AGENTS / policy proposal
+ 未跟踪资源
+ 构建产物
+ 测试夹具
+ 运行环境 manifest
```

但文件快照仍然不能覆盖进程状态、网络服务、外部数据库、凭据、模型动态响应、内核和时间。因此真正可复现的对象应是：

```text
CandidateExecutionCapsule
├── workspace snapshot
├── artifact manifest
├── runtime/environment manifest
├── capability policy
├── evaluator identity
├── held-out fixture digest
└── execution receipts
```

LayerFS 最多提供其中的 workspace snapshot，不能代替整套 capsule、评估器、安全边界或发布控制面。

## 隐私与 owner 边界

如果将来使用 LayerFS 保存包含用户内容的候选状态，LayerFS Store 必须明确属于哪个 owner，并加入 Euler 的 purge 依赖闭包。当前 LayerFS 版本的 append-only 对象存储、对象回收和删除能力不能直接满足 Euler 的隐私清除要求。

如果候选 Workspace 只是临时、可整体丢弃的测试状态，可以把它作为独立的 disposable store；如果其中包含需要长期保留的用户 source，则必须另外定义：

- store identity；
- content locator；
- reverse references；
- 清除和备份责任；
- 部分失败与恢复状态。

不能因为删除了 Workspace 目录就宣称 LayerFS Store 中的对象已经被清除。

## 当前决策

1. Euler v1 继续按现有计划执行，不修改 Context/Memory 的总体设计。
2. 不在当前 v1 加入 LayerFS、FUSE、CDC、COW 文件树或第二套 SQLite Store。
3. Euler 当前保留 immutable raw archive、stable locator/hash、一次性 compartment、可重建 projection、bounded context 和 append-only ledger。
4. 未来行为自进化只增加一个候选 Workspace Provider 接点，不把 LayerFS Commit 当成行为发布批准。
5. Git worktree、临时目录、容器 overlay 和 LayerFS 都是未来可替换的 Host 后端；选择依据是真实 workload、平台和安全证据。
6. LayerFS 的性能、Windows 兼容性、隐私清除集成和恶意候选隔离能力目前均未在 Euler workload 上验证，不作为当前架构事实。

## 证据边界

### 已证实

- Euler 当前仓库仍是设计和迁移记录，README 明确说明实现、运行时测试、CI、真实 Host 和 MC cutover 尚未完成或验证。
- Euler 已明确分离 source/archive、memory、intent、policy、context projection 和 execution ledger 的 owner。
- Euler v1 聚焦 memory lifecycle 和 context 协作；行为修改只能保存为 inert proposal。
- Euler 已明确要求 candidate isolation、independent verifier、held-out/canary 和 rollback 作为未来行为自进化门槛。
- Euler 首次目标是 Windows；未来行为自修改需要按 Windows、macOS、Linux 的实际目标宿主验证安全与回滚。
- LayerFS 0.1.4 是 Developer Preview，当前文档明确没有跨主机同步，也不保证进程崩溃或断电后的数据库持久性；FUSE/managed container 不是完整的恶意代码安全边界。

### 推断

- LayerFS 最适合作为未来 candidate Workspace Provider 的可选后端。
- Context/Memory 当前设计已经吸收了 LayerFS 对本任务真正有价值的不可变身份、派生投影、快照恢复和状态分离理念。
- 对 Euler 而言，最小的未来扩展是 workspace snapshot reference，而不是完整 LayerFS storage engine。

### 未证实

- LayerFS 在 Euler 未来候选 workload 上是否能显著降低磁盘、创建或清理成本。
- LayerFS 是否能满足 Euler 的 Windows-first 目标和三平台行为自修改门槛。
- LayerFS Store 如何与 Euler 的 source owner、backup、purge、recovery gap 和审计闭包集成。
- LayerFS 的文件快照是否足以满足某种具体自进化评估的可复现性要求。

## 参考

- [Euler README](../README.md)
- [Euler v1 实施规格](../issues/15-euler-v1-spec.md)
- [Euler 记忆演化设计](../issues/08-automate-memory-evolution.md)
- [Euler 上下文装配与执行账本设计](../issues/09-assemble-context-safely.md)
- [Euler 存储、索引与投影设计](../issues/10-choose-storage-projections.md)
- [Euler 目标范围、迁移和验收矩阵](../issues/13-select-target-v1-migration.md)
- [LayerFS README](https://github.com/Ephemeral-AI-Lab/layerfs/blob/main/README.md)
- [LayerFS concepts](https://github.com/Ephemeral-AI-Lab/layerfs/blob/main/docs/general/concepts.md)
- [LayerFS storage format](https://github.com/Ephemeral-AI-Lab/layerfs/blob/main/docs/versioned/0.1.4/storage-format.md)
- [LayerFS limitations](https://github.com/Ephemeral-AI-Lab/layerfs/blob/main/docs/versioned/0.1.4/limitations.md)
