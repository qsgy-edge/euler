# Euler 记忆系统：完整目标设计与 Claude 构建参考

> 用途：供在 Claude 上构建记忆系统时参考。本文整理完整目标设计，不按当前实现进度裁剪，也不是一份实现状态清单。
>
> 依据：Euler 正式规格及其领域、权威、记忆、上下文、演化和存储契约；整理日期 2026-10-05，来源检查点 `1e516658f15c91bdb78b6e074828c4f8d2661033`。
>
> 本文是可独立阅读的架构说明，不替代 Euler 原规格，不代表 Claude 已具备这些能力，也不授予读取、写入或发布权限。具体 Claude 接入方式需要按实际宿主能力另行确定。

## 1. 核心思路

Euler 要解决的不是“把更多文字存下来”，而是三个不同问题：

1. **延续工作：** 有限上下文下，仍知道当前目标、硬约束、进行到哪一步。
2. **复用知识：** 从过去工作中形成有来源、有适用边界、可纠错的长期知识。
3. **恢复证据：** 摘要不够时，可以找回准确的原话、代码版本和工具结果。

因此，不能把日志、摘要、事实、待办、偏好和指令塞进同一个记忆池。

整个设计可以概括为：

> 原始事件先可靠归档；知识先成为候选，再独立验证；检索先检查资格，再计算相关性；只有一个组件组装上下文；记忆只提供数据，不授予权限；所有变更可以追溯、纠正和停止使用。

“可恢复的历史很长”不等于“模型拥有无限上下文”。记忆系统扩展的是存储和恢复能力，不是单次模型调用的注意力。

## 2. 总体架构：共用基础设施，不混合权威

```text
真实用户输入 / 代码 / 工具结果 / 外部材料
                   │
                   ▼
          Source 与 Session Archive
         原始内容、不可变版本、持久化确认
                   │
         ┌─────────┼────────────────┐
         ▼         ▼                ▼
   会话压缩     候选提取          按需来源恢复
  Compartment   Proposer       source.search/expand
         │         │                │
         │    完整性门禁             │
         │         ▼                │
         │   独立 Verifier           │
         │         ▼                │
         │    Memory Gate            │
         │         ▼                │
         │   Canonical Memory        │
         │         │                │
         │    可重建搜索投影          │
         │         ▼                │
         │   Memory Retriever        │
         └─────────┬────────────────┘
                   ▼
          Context Orchestrator ◄── Intent / Policy
         唯一内容选择与 token 预算 owner
                   │
            冻结上下文与请求账本
                   ▼
               主 Agent
                   │
        受模型外门禁约束的工具循环
                   │
             新的原始事件 / 反馈
```

图中的组件是**逻辑职责**，不是要求部署多个服务或多个常驻 Agent。可以在同一进程内实现。

### 2.1 七类对象

| 对象 | 保存什么 | 不应被当成什么 |
|---|---|---|
| `source` | 代码、网页、文件、运行结果等证据来源 | 已验证的长期知识或执行指令 |
| `session_archive` | 原始用户、assistant、工具事件及其顺序 | 精炼记忆；当前目标真值 |
| `working_context` | 本次模型调用实际看到的有限材料 | 完整历史；永久知识库 |
| `durable_memory` | 经验证、可复用、有边界的知识 | 原始日志；活动政策；授权 |
| `intent` | 当前任务目标、约束、范围和步骤 | 普通事实；压缩摘要中的推测 |
| `policy_artifact` | 经独立批准/发布的活动指令、Skill、权限规则等 | 可由记忆自动升级而来的文本 |
| `projection` | 搜索索引、摘要、overview、Wiki、图等派生视图 | 第二份知识真值 |

例如：

- “上次运行出现了错误 X”首先是 archive/tool evidence。
- “在环境 Y 下，错误 X 由条件 Z 导致”验证后可以是 fact 或 insight。
- “这次先修复 X，不改公共接口”是 intent。
- “工具不得访问未批准目录”应由 policy/capability 强制约束，不能只靠一条 memory。

### 2.2 权威按主张类型确定

没有一个通用的“代码 > 用户 > 记忆 > 文档”总排序。

| 主张 | 规范 owner / 权威来源 |
|---|---|
| 实际实现是什么 | 对应版本的代码 |
| 某环境运行结果是什么 | 真实测试、工具或运行 evidence |
| 设计原本想怎样 | 已批准 ADR、明确设计决定 |
| 用户偏好、价值判断和目标 | 用户明确表达 |
| 用户当时说了什么 | 原始 session archive |
| 当前活动规则是什么 | 已加载且有效的 policy artifact |
| 派生结论及其适用边界 | 带 provenance 和验证记录的 durable memory |

Git 证明版本历史，issue 关闭证明流程状态，索引证明某份派生视图存在；它们都不能单独证明事实正确。

同一主张只允许一个规范 owner。其他地方的表达应是引用、投影或变更候选，不做静默双向同步。

### 2.3 术语速查

| 术语 | 本文含义 |
|---|---|
| Harness / Host | Agent 的运行控制代码 / 具体宿主的输入、呈现与 transport 接点 |
| Canonical / Projection | 规范真值 / 从真值派生且可重建的视图 |
| Provenance | 结论来自哪些准确版本的证据，以及如何推导 |
| Gate / Admission | 模型外的资格或批准检查 / 某次实际请求的准入 |
| CAS | 只在当前状态仍等于预览冻结状态时原子提交，否则拒绝 |
| Receipt | 一次实际提交或请求的持久事实记录，不是模型自述 |
| Outbox / Lease | 与业务变更同事务登记的待处理工作 / 有期限的处理权 |
| ReAct | 模型输出工具调用、工具返回结果、模型继续推理的完整循环 |
| Compartment / Cache epoch | 从原文形成的稳定历史摘要单元 / 缓存基线的逻辑代际 |
| Held-out / Canary | 未参与候选生成或调参的验证样例 / 受控的小范围真实验证 |
| Salience / Negative transfer | 排序中的重要性 / 知识被不当泛化或使用，反而损害任务效果 |
| Inert proposal | 可阅读和交接、但没有执行或发布权限的建议制品 |

## 3. 长期记忆模型

### 3.1 五种内容类型

| 类型 | 含义 | 示例 |
|---|---|---|
| `fact` | 可核验的事实 | “组件 A 在环境 B 中使用协议 C。” |
| `preference` | 用户拥有的稳定偏好 | “解释方案时优先用具体示例。” |
| `decision` | 明确拍板的选择及必要理由 | “此模块采用 SQLite，因为需要本地事务与恢复。” |
| `insight` | 从证据提炼的可复用认识 | “仅增加等待时间会掩盖冷启动阶段的真实瓶颈。” |
| `episode` | 已结束任务的经验抽象 | “在条件 X 下尝试 Y，结果 Z；有效范围是 W。” |

`hypothesis` 不是第六种类型，而是 fact/insight 尚未验证的状态。

Episode 不是把整段聊天换个名字保存。它需要有完成状态、可观察结果和能复用的经验。

### 3.2 生命周期与验证状态正交

```text
lifecycle    = candidate | active | superseded | rejected | tombstoned
verification = unverified | verified | conflicted | stale
```

- `candidate + unverified`：待验证候选。
- `active + verified`：具备正常使用的基础资格，仍须通过范围、时效和来源检查。
- `superseded + verified`：过去成立，现在已被新版本替代。
- `active + stale`：仍保留当前工作状态，但证据失效，不能作为事实注入。
- `active + conflicted`：存在未解决的可信矛盾，不能默默选一方。
- `rejected + verified`：内容可能真实，但因可归因负迁移等原因不再正常注入。
- `tombstoned`：用户要求停止使用；历史保留，可经独立批准恢复。

不要用一个 confidence 分数同时表达真假、相关性、适用性和效用。分数可以帮助排序，不能授予验证资格。

### 3.3 记录粒度

一条 memory 是**能够独立验证或失效的最小语义单元**。

结论与不可分割的理由可以一起保存；如果其中一部分可以独立变化，就拆分。不要把整页 Wiki 存成一条记录，也不要机械逐句切碎。

例如，“使用 SQLite”与“备份保留两份”可能独立变化，应分开；某个设计选择及其不可缺少的适用条件则应一起保留。

### 3.4 稳定身份、不可变版本和当前 head

| 概念 | 职责 |
|---|---|
| `memory_record` | 一条知识的稳定逻辑身份 |
| `memory_revision` | 不可变正文及 content hash |
| `memory_event` | 创建、验证、激活、纠正、替代、冲突、回滚、遗忘等追加事件 |
| `memory_head` | 当前版本与业务状态，可由事件重建 |
| `head_event_id` | 最近一次 head/资格变化的事件身份，用于 CAS 和旧预览拒绝 |

正文修订新增 revision，状态变化追加 event。回滚可以恢复旧 revision，但必须追加新的回滚事件，不恢复旧 `head_event_id`。

所以，即使发生 `r3 → r4 → r3`，针对第一次 r3 的旧批准预览仍然过期。这防止“值又相同了，因此旧授权重新有效”的 ABA 问题。

模型不能自行分配规范身份、重写历史或重算 hash 后宣布内容已验证。

## 4. Scope：知识归属与适用条件分开

### 4.1 三种持久 scope

- **Project：** 一个有独立生命周期的逻辑项目。
- **Workspace：** 稳定相关的项目组；可选、扁平，每个 project 最多归属一个。
- **Personal：** 用户跨项目的个人知识、偏好和原则。

这不是三个独立存储层，更不是把同一条知识复制三遍。它们是同一记录模型上的归属维度。

Project identity 不等于 cwd、Git root 或磁盘路径。同一组件的源码目录和安装目录可以属于同一 logical project；同一全局配置目录中的多个独立组件也不必属于同一 project。

### 4.2 `applies_to` 独立于 scope

Scope 表示**谁拥有、在哪个逻辑边界内使用**；`applies_to` 表示**适用于什么 agent、platform、component 或环境**。

例如：某 project 拥有一条仅适用于 Windows 的事实；同 workspace 内的 macOS 项目不能直接把它当成自己的结论。

Scope 更窄不自动更可信，记录更新不自动更正确。适用性和权威分别检查。

### 4.3 Scope 解析与晋升

从已有 intent、明确 manifest、实际资源 owner 和当前真实请求确定 project。无法确定时，只保留 session-local unresolved candidate，不因当前目录自动晋升为长期记忆。

从 project 泛化到 workspace/personal 时：

1. 验证更广范围中的真实差异与反例。
2. 保留必要 `applies_to`。
3. 创建带 `derived_from` 的新广域记录，而不是原地改旧 scope。
4. 语义完全相同的窄域版本可被替代；仍有本地差异的版本继续保留。

多次出现只是提出泛化候选的线索，不是自动晋升依据。

## 5. 原始归档与 provenance

### 5.1 先归档，再提炼或卸载

用户输入、完整模型响应和工具结果先进入原始归档，得到可重启复读的 durable acknowledgement。

没有可靠归档确认，就不能：

- 把该内容从 live context 卸载；
- 创建依赖它的可用知识；
- 声称原文可恢复；
- 发送依赖尚未可靠保存输入的请求。

同一 event identity 和相同 bytes 重放应幂等；同 identity 异内容是冲突。提交结果未知时先按 identity 查证，不盲目重复写入。

### 5.2 引用必须定位到不可变证据

| 来源 | 引用要素 |
|---|---|
| 会话 | session identity、事件 ordinal/range、content hash |
| Git/代码 | repository、commit/blob、path、line range |
| 产物/运行 receipt | artifact identity、digest、环境和运行身份 |
| 网页 | URL、获取时间、content hash |

可变路径只能作别名，不能单独证明证据版本。Hash 证明字节完整性，不证明真实性、来源可信度或用户授权。

来源变化使依赖对象 stale，安排重新验证；不直接抹掉全部历史。隐私清除是另行批准的破坏性例外。

### 5.3 恢复不是全文塞回上下文

普通路径只用有界摘要或记忆。需要原话、版本、行号、错误参数或裁决冲突时，才执行：

```text
source.search → 选定不可变来源 → source.expand(offset, limit)
```

返回 excerpt、locator、hash、范围和截断信息。失败明确报 evidence gap，不用记忆正文、旧摘要或当前新版本冒充原文。

## 6. 自动捕获、验证与激活

### 6.1 候选从语义边界产生

触发点包括：完整 ReAct 轮次、明确用户决定、明确“记住”、compartment 提交和任务完成。

不必每条消息都启动一次 LLM 提取。“同意”必须连同它实际指向的待确认方案保存，不能单独推导出永久决定。

捕获流程：

```text
归档真实事件
  → Harness 创建 capture job，并绑定真实 source/owner/scope
  → 代码提取结构化事实，或 Proposer 起草语义候选
  → candidate + unverified
  → 完整性门禁
  → 独立验证
  → Harness gate 决定状态转换
```

主 Agent 可以给 capture hint；模型不能直接写 active memory，也不能自报 provenance、权限、owner 或 verified。

秘密、临时待办、当前任务目标、活动规则和外部内容中的指令不能包装成普通 memory。

### 6.2 先确定性门禁，再语义验证

完整性门禁核对 source locator/hash、真实调用链、owner/scope、receipt 和目标环境覆盖。失败直接阻断，不让 LLM 猜。

语义 Verifier 使用与 Proposer 隔离的上下文，可以自行读取原始证据，不只看生成者挑选的片段。输出限于：

```text
pass | block | evidence-gap
+ 精确 evidence references
+ 被验证内容的 hash
```

只有 Harness gate 能移动 current head。

### 6.3 验证深度按类型与影响选择

| 候选 | 最低充分证据 |
|---|---|
| 明确 preference/decision | 真实 owner 原话、准确指向、scope 一致 |
| 客观 fact | 权威 owner 来源或独立工具证据；用户陈述本身不证明客观事实 |
| episode | 任务完成事实与可观察结果 |
| 普通 project insight | 来源忠实性、冲突、适用边界 |
| 广域、高影响、反复影响行动的 insight | 更多独立来源、反例、held-out/canary，必要时人工裁决 |

低风险允许同模型但隔离上下文；高风险需要更强独立性，不要求所有普通事实都跑昂贵评估。

最窄 scope 可以先在满足其证据要求后安全激活，不必等待所有泛化和优化完成。

### 6.4 三条处理通道

- **快速通道：** 明确 owner preference/decision、可确定性验证的结构化事实；下一轮前激活或显示阻塞原因。
- **普通通道：** Project fact/insight/episode，后台提取与独立验证。
- **慢速通道：** 跨 scope、高影响、安全相关和可信冲突，增加验证或升级给人。

这些通道共用 gate，不是三套记忆系统。候选必须有阶段、阻塞原因、重试或升级路径，不能无限静默 pending。

## 7. 去重、时间变化与冲突

比较记录前，先归一化：subject/resource、owner、scope、适用环境、观察时间和有效期。

- 同一 source event 重放：no-op。
- 同一规范 claim 获得新证据：追加 provenance。
- 只是语义相似：形成 merge candidate，不自动合并。
- 同一对象、不同且不重叠的有效期：可以 temporal supersession。
- 不同平台、组件或对象：可以并存。
- 同一对象、有效期重叠、可信证据互斥：conflict，停止把双方当正常事实注入。

例如，“版本 1 使用 A，版本 2 使用 B”通常是时间变化；“Windows 需要 X，Linux 不需要 X”通常是环境差异；两份证据对同版本、同环境说相反结论，才需要裁决。

未验证反例可以打开待验证冲突，不应立即污染一个仍合格的 active 结论。已知可信矛盾则必须隔离。

## 8. 检索：先资格，后相关性

### 8.1 正常检索流程

```text
当前请求 + active intent
  → 获准 logical scope / 目标环境
  → lifecycle、verification、有效期、source integrity 硬过滤
  → 本地 lexical/FTS 召回，按 owner kind / 任务子项分 lane
  → 在获准候选内做可复算排序与必要融合
  → claim + 环境 + 时间去重
  → 在动态 token 预算内选择
  → 返回有来源的结果或明确降级状态
```

相关性不能抵消资格失败。不能用“很像当前问题”放行越权、过期、冲突或未验证内容。

不设必须填满的 top-k。没有强相关合格内容时可以返回空。

### 8.2 统一搜索投影，不统一规范对象

一份可重建 `search_documents` + FTS 可以同时索引：

- 合格 memory；
- Source/session/repository owner 明确发布的有界 chunk；
- 获准发现的报告、handoff 和 inert proposal。

查询分 lane，避免原始文本淹没精炼知识。每个命中都回 canonical owner 重验，索引 metadata 只用于预过滤。

报告和 proposal 是任务资料，通过 source 路径发现和展开，不混入 `memory.search` 的已验证事实。

### 8.3 状态结果不是事实结果

- `stale/conflicted/expired`：普通路径只给 claim 标识、状态和复验入口，不泄露正文并让模型当成事实。
- `dirty/rebuilding/failed`：索引不可作为当前知识的完整视图，不能把空结果当作“没有相关记忆”。
- `superseded`：仅明确历史查询时恢复旧版本。
- `candidate/rejected/tombstoned`：不进入正常事实上下文。

明确研究/核验流程可以按权限读取带状态标签的历史或冲突证据，但不能因此改变验证状态。

### 8.4 Agentic RAG 是主 Agent 的慢路径

普通路径不增加 router LLM、RAG Agent 或 LLM reranker。主 Agent 在正常调用中判断信息是否足够；不足时用已有工具循环改写查询、沿 provenance 查找并展开来源。

触发例子：无强命中、冲突/过期、多跳证据、需要原话、跨 scope 或当前行动缺少精确参数。

证据不足不自动授予全局查询权限。

### 8.5 显式跨项目只读发现

默认仅当前 active project 与适用 workspace/personal。用户明确要求跨项目分析时：

1. 从已登记项目与本任务获准读取集合的交集建立范围。
2. 绑定真实授权来源、intent/task 版本、目标环境和累计查询/结果/字节预算，任务内允许连续搜索和展开。
3. 每次查询、展开与装配重验；撤销、任务结束或切换后失效，分页或重启不重置预算。
4. 保留 source project、被分析的 target project、环境和版本，不合并不同项目的同名 claim；未授权项目的名称、摘要和正文都不能泄露。
5. 报告实际覆盖、未覆盖、不可用、截断和继续入口。

这个只读集合不扩大操作范围，不加载其他项目 guidance，不授权写入、发布或跨 scope 晋升。授权不能由模型参数自报；相同查询 identity 的合法重放须对账而非重复扣减预算或扩大范围，无法复现原结果时明确 stale/gap。

适用性按被分析项目判断，不用查询者机器的操作系统替代目标环境；目标环境未知时只作为“适用性待核验”的参考。

## 9. 上下文协作、预算与会话连续性

### 9.1 唯一 Context Orchestrator

Orchestrator 是确定性本地代码，独占最终内容选择和 token 预算。Virtualizer、Retriever、Intent Provider、Source Recovery 只提供候选，不能各自在 prompt 中追加一块。

普通快路径：

```text
同步归档输入
  → 并行取得缓存 intent、预生成 compartment/recent tail、本地检索
  → 确定性装配与 admission
  → 一次主 Agent 模型调用
```

后续工具循环仍可继续调用模型；“一次”指普通首轮不额外插入分类或检索决策 LLM。

候选提取、压缩生成、验证、索引、overview 和 Wiki 维护不进入普通响应关键路径。

### 9.2 Intent 独立持久化

当前目标不能从 memory 或摘要反推。最小 intent 保存目标、硬约束、scope、当前步骤、状态、来源输入和版本；transition 用追加事件与 CAS。

扩大目标、约束或权限必须有真实授权；模型拟定步骤可以经 gate 更新，但 todo 完成和“我已经做完”不能授权换任务。

换窗不重置目标，树分支也不能倒拨同一 intent 版本。缺失、损坏或来源被清除时，明确 needs-input/evidence-gap，不从旧摘要猜回授权。

### 9.3 每次调用硬预算检查

```text
mandatory + selected + output_reserve + safety_margin <= context_limit
```

硬保留：活动 policy、当前用户输入、最小 intent、必要工具契约、最近未完成的完整 ReAct/tool-call-result 边界及输出预算。

剩余预算按本轮证据价值动态分配给 memory、compartment 和 source excerpt，不设固定比例。

超限降级顺序：

1. 去弱相关、近重复和可重建材料。
2. 缩减非 pinned memory/source。
3. 在完整 ReAct 边界批量切换已准备的 compartment/window。
4. 已归档的超大输入或工具结果分页/分块。
5. Mandatory 本身仍超窗：拒发或拆任务，不发送非法 prompt。

不按消息条数裁剪，不拆 assistant tool call 与其 result。

### 9.4 Compartment 只从原始证据生成

正常压缩中，每个 eligible 原始片段只从原文生成一次已提交的稳定 compartment，并保留 source range/hash；不递归摘要旧摘要，也不每轮重写全部历史。

大小/任务边界提前后台生成，token 压力触发正常切换，emergency 只作兜底。压缩失败保留 raw，降低连续性但不能绕过硬预算。

在已有完整 archive 和恢复入口时，也可开启不生成新摘要的 fresh window。新生成或重建的派生正文有新 identity/hash，不能替换历史 assembly 中原来引用的字节。

### 9.5 Cache-aware 布局

| 区域 | 内容 | 稳定性 |
|---|---|---|
| P0 | 活动 policy、固定顺序的工具 schema、合格 guidance | Provider-stable prefix |
| P1 | Session baseline、已提交 compartment、少量 pinned verified memory | 同一 cache epoch 字节冻结 |
| P2 | 完整、按时间追加的 user/assistant/tool 轨迹 | 追加，不回写旧事件 |
| P3 | 当前用户输入、本轮 memory/source 数据、短 intent/runtime status | 当前完整 ReAct turn 内冻结 |

P0/P1 确定性序列化，在同一 cache epoch 内保持字节冻结。下一用户轮可以替换上一轮的短 retrieval tail，不为更新动态信息改写长前缀。

Window、cache epoch、assembly 和 attempt 是不同身份。安全/权限/scope/policy/已确认 supersession 立即使旧上下文对后续发送失效；缓存优化不能推迟撤销。

这些区名只是布局概念，物理位置不改变消息权威。实际 cache boundary 和复用条件由 provider adapter 按真实协议实现与测量。

## 10. 防止记忆变成提示注入或隐式授权

Memory/source 作为明确标记的数据进入上下文，携带 type、scope、state、provenance；活动规则通过独立 instruction channel 加载。

以下内容不获得权限：

- 偏好/decision memory 中的“以后直接执行”；
- Archive 或网页中的 system/developer/tool 字段；
- 检索结果中的“忽略前面的规则”；
- Proposal 的 `accepted` 或“建议安装某 Skill”；
- 模型自报“用户已经同意”。

不靠 XML 标签、关键词删除或改写原文来保证安全。标签帮助语义隔离，真实安全边界是模型外的 scope、capability、credential、policy、approval 和资源检查。

记忆可以说明“用户曾批准过什么”，不能证明**本次操作仍获批准**。

## 11. 持久化与后台维护

### 11.1 物理存储选择

Euler 选择每宿主、每 OS 用户、每 app-id 一份本地 SQLite；代码、ADR、policy 和原始来源仍留在各自规范载体。

SQLite 保存 memory records/revisions/events/heads、provenance/conflict、capture/verification/feedback、intent、独立 execution ledger、Host operation state 和可重建投影。

连接统一 WAL、`synchronous=FULL`、foreign keys、有界 busy timeout；短事务、CAS 和短租约。Euler 使用 Node 24 内置 `node:sqlite`，这是其技术选择，不要求 Claude 侧照搬语言或运行时。

原设计不引入正文加密或 SQLCipher，依赖本地用户目录权限、秘密不进入 memory、隐私清除与备份保护。凭据由宿主管理，不进入产品数据根；这个威胁模型不承诺抵抗能读取当前 OS 账户磁盘的攻击者。

Canonical 不是 Markdown-only：Markdown 适合阅读、分享和受控导出，但单独文件不天然提供并发 CAS、事件顺序、批准身份与跨对象原子性。

不要让多台机器或云盘同步同一个 SQLite 文件。跨宿主通过显式选定范围的导出/导入进行。

### 11.2 Canonical 与投影用 outbox 衔接

Canonical 变更在同一事务追加 projection job，不同步等待 FTS 或文件投影。

Worker 处理时重新读 current head，按 revision/hash/事件身份条件幂等更新。乱序旧 job 不得覆盖新 head；崩溃后可以至少一次处理，不能至少一次激活同一 mutation。

用 watermark 和双向完整性核验发现丢行、错行及 FTS posting 损坏。小延迟可由 pinned delta/有界 canonical scan 补；无法安全补齐时明确 dirty，并重建，不回滚正确的 canonical memory。

### 11.3 Cooperative worker，而非常驻服务

在启动、写入后、响应结束、空闲或显式维护时有界 drain。后台 job 有 durable identity、输入 hash、lease 和累计预算；过期 worker 不能提交。

Lease 到期只表示可接管执行权，不证明未知操作从未发生。恢复先查原 operation/attempt，再决定下一步。

模型 fallback 只处理暂时不可用、限流、超时或协议故障，不能把语义 block、integrity fail 或 evidence gap 换模型后洗成通过。

### 11.4 不用统一 TTL

- Volatile fact 按 `as_of`、`valid_until`、`review_after` 与来源变化失效。
- Preference/decision 在明确替代前持续有效。
- Source 变化沿 provenance 标 stale，触发重验。
- 低 salience 只影响排序，不自动删除历史或改变真假。

维护由来源、时间和反馈事件驱动；周期扫描只补漏，不每晚让 LLM 重审全库。

## 12. 反馈、全貌与长期演化

### 12.1 真值与效用分开

分别记录真实发生的：retrieved、injected、source revalidated、task outcome、用户 helpful/wrong/stale、canary outcome。

`injected` 从冻结 assembly 推导；模型说“我用到了这条记忆”不算事实。曝光不证明有帮助，普通任务成功/失败也不能直接改变 verification。

普通反馈可调整 salience 或触发复验；owner 明确纠正、权威来源变化或可归因 held-out/canary 才支持更强状态转换。

内容真实但反复导致错误泛化时，可以 `verified + rejected(negative_transfer)`；不必把“无助于任务”写成“事实为假”。

### 12.2 Scope overview：项目全貌，不是第二份记忆

完整目标包含按 scope 的增量 overview：当前有效决定、约束、重大变化和有来源的未决状态。

它是有界派生投影，逐条引用 canonical revision/head 或 immutable source，并携带覆盖水位、generation、hash 和状态。旧 overview 只作定位，不作为生成新事实的证据。

当前请求仍先走 canonical retrieval；需要项目全貌、跨主题关系或局部证据补缺时才读取适用 overview。输入资格、权限、source、membership 或覆盖发生变化时失效；fresh 标志本身不足以证明可注入。

增量 review 复用 worker，读取新增事件及受影响有限邻域，不每轮扫描全部 archive。跨 scope 汇总须有实际 membership/derived-from 和授权，不把所有项目合成全局池。

全历史 backfill 要另有稳定 source inventory、幂等交接、连续覆盖水位和缺口恢复。最大已见 cursor 不证明前面全部处理；“processed”也不等于“verified/active”。

### 12.3 Wiki、图和向量是可选消费者

Wiki、相关洞察、backlinks 和架构图可以由 memory/source 生成；编辑它们只形成 source event 或候选，不直接重写 canonical。

向量检索、LLM reranker 或图投影只有在真实漏召回/多跳需求可复现、对照实验胜出后才值得加入。完整目标不等于必须预建向量库、知识图谱、主题 taxonomy 或文件发布框架。

Overview 服务于上下文全貌；Wiki 服务于阅读；它们都不能反过来定义事实和权限。

### 12.4 记忆演化与行为演化分管线

```text
已验证知识 / 经验 / 反馈
  → 明确 target、预期变化、scope 和评估方法
  → inert proposal（没有行为权限）
  → 目标 artifact owner 的独立评估与批准
  → 独立发布 / canary / 回滚
```

Memory gate 只决定知识能否正常召回，不直接修改 prompt、AGENTS、Skill、工具、代码或权限。

后续行为发布需要隔离候选、真实目标环境、独立验证、未参与生成的 held-out、canary 和回滚。权限、安全、凭据及不可机器裁决的价值变化仍交给用户。

不要建立一个同时决定知识真值、工具权限和代码发布的万能自进化引擎。

## 13. 分析报告与跨会话交接

完整分析报告和普通 handoff 归档为任务 source；具备明确 target、预期改动、范围与验收的建议保存为版本化 inert proposal。

这些产物要保存**正文和准确版本**，不能只留一个后来会消失的临时文件路径。

新会话可以按项目与任务问题发现，再按需展开；不依赖手工维护关系表或指定 handoff Skill。进入实施前重新检查代码版本、适用条件和当前授权。

跨项目混合报告只向获准目标开放已批准区段或项目摘录；原始报告的 owner 不因交接而改变。只读分析授权不自动授权向其他项目发布整份资料。

报告可显式导出独立可读 Markdown。发布到仓库、Issue 或外部系统及后续实施，分别由当前授权和项目既有流程承担；“建议采用”不能保存成“用户已经决定采用”。

## 14. 可解释、可纠错、可撤销

### 14.1 Inspect 查实际选入的版本

“你这轮依据什么”应从冻结 assembly 找实际选入的 memory revision/source refs、顺序、hash 和选择理由。

不能拿查询时的 current head 替换过去版本，也不能把“检索过”冒充“注入过”，或把“绑定到请求”冒充“模型已理解”。缺原文、hash 或实际 membership 就报缺。

Execution receipt 留在审计域，不把整份账本反复塞回模型上下文。

### 14.2 用户变更采用 preview → approval → commit

```text
inspect / 选择唯一目标
  → 读取 canonical before
  → 完整预览目标、正文、after/diff、范围、影响
  → Host 保存冻结 snapshot 与 opaque token
  → 真实 owner 输入批准
  → 同事务 CAS：mutation + 不可变 receipt + 必要 outbox
  → 呈现真实终态
```

模型的 `confirm=true` 不算批准。Correct 必须有用户实际提交的新正文；新正文先 unverified 待复验，不继承旧正文的 verified。

每 session 一个 durable pending；新预览显式作废旧预览。过期 snapshot/token 整次失败，不静默重读、缩小范围或自动重试。

批量操作冻结完整有序成员；任何已选成员变形、失格或 head 改变，整批拒绝，不只提交剩余“还能做”的部分。

### 14.3 自动更新可发现，不逐条打断

低风险自动激活与固定 batch manifest、通知 outbox 同事务提交。响应结束或后台批次完成后合并 Info；详细内容、真实历史状态和撤销入口可查询。

Candidate/rejected 不要求用户日常逐条审核。可信冲突、高影响或需人工裁决的候选显示阻塞；写入失败、receipt 缺失或 unknown 显示真实错误。

通知失败只补投递，不重复 activation；已读状态也不能因重启重新变未读。

### 14.4 Rollback 不是抹掉过去

Rollback 撤自动 activation/revision，不撤用户手动 correction。追加 revocation，恢复仍满足当前资格的 previous known-good。

旧版本若 stale/conflicted，不恢复为 active；首次 activation 被撤销后可以没有 active 结论。回滚不修改原 update receipt。

Mutation 已提交但呈现失败：补呈现。提交结果 unknown：先查 canonical receipt。不能因为界面没显示成功就重复变更。

## 15. 忘记、恢复与隐私清除

| 操作 | 语义 |
|---|---|
| Forget | Tombstone，停止正常召回，保留历史，可恢复 |
| Restore | 独立批准，重新检查当前 source/scope/verification 和 CAS |
| Rollback | 撤销合格的自动更新，回到可用的旧业务状态 |
| Privacy purge | 不可恢复地清除受控正文与相关副本，独立高风险流程 |

普通“删除/别再记住”默认不升级成不可逆 purge；调查、否定和相反方向措辞不能被模型猜成破坏性操作。

### 15.1 防止忘记后自动复活

Forget 固定 owner、scope/适用条件、规范 claim、source owner/lineage 的抑制关系。

换 capture ID、重复导入、路径别名、摘要重述或同源新版本仍表达同一 claim，都不能自动重新激活它。不同独立事实按资格重新验证，不建立全局正文 hash 黑名单。

Restore 明确解除该记录抑制；purge 必须清除这些可关联指纹，不能声称删掉正文却永久保留内容指纹。

### 15.2 隐私清除必须覆盖依赖闭包

包括：正文与历史 revision、候选、provenance locator/hash、验证/反馈/proposal、索引/embedding/cache/投影、assembly/transport 引用和关联 hash、Host 展示/pending、原始来源及受控备份。

不能仅删 memory 表一行。按结构化身份 cycle-safe 遍历闭包，不用序列化全文 substring 猜依赖。

Euler 采用维护模式：关闭 admission，证明旧宿主及受控子任务不能再迟到写入，取得独占后展示完整 manifest 并批准。窗口关闭、abort、心跳丢失或 lease 到期都不是退出证明。

执行分两段：

1. 短数据库事务逻辑清除、保存 receipt 和最小 cleanup continuation；durable commit 是不可取消点。
2. 各 owner 按批准 manifest 幂等向前清理外部载体、备份、WAL/空闲页和 continuation 自身；全部后置条件通过才声明完成。

提交后失败必须显示“已逻辑提交、物理清理未完成、残留位置”，不能假称已回滚。重启续做，不从清除前备份复活内容。

完成后仅保留不可关联的无内容审计事实；原 receipt 只有本来就不含可反查正文身份/locator/hash 时才可保留。不可控远端副本列为残留，不承诺全域清除或 SSD 取证级擦除。

## 16. 请求账本、预算与故障恢复

### 16.1 模型请求有两道持久化 barrier

```text
冻结 assembly → append + flush
  → admission 重验并冻结最终 transport payload
  → attempt started append + flush
  → 实际发送
  → attempt finished / unknown
```

任何前置持久化失败都禁止发送。内容、顺序、route/model、预算或 epoch 变化创建新 assembly；真正相同完整 payload 的合法重试才增加 attempt ordinal。

- Assembly 无 started：not-dispatched。
- Started 无 finished：unknown-sent，不能推断未发送或自动重发。

后台调用归实际 durable job，不借无关前台 session 的目标和权限。接管 job 不改变请求归属或抹掉 unknown。

模型响应完整结束且完整 assistant/tool-call 可靠归档后，才调度工具；不因流式输出中某个 call 已完整就提前执行。

### 16.2 累计 run 预算不随换窗重置

每个 run 有 model-attempt/tool-call 上限、累计 token/成本、wall-clock deadline 和单工具超时。检索恢复、重试和换窗计入同一预算。

预算耗尽、取消或权限失效后停止新增调用；迟到结果不能自动执行后续工具或提交 memory。

### 16.3 索引坏与 canonical 坏分别处理

索引坏：dirty、停用派生结果、重建。

Canonical 坏：停止写入与相关 dispatch，保留损坏文件，只从已验证快照恢复，并标记可能丢失事件的 recovery gap。旧 unknown 不因快照缺记录而变成“从未发生”。

容量不足先清可重建 cache/projection 和已完成临时物，不自动删除 canonical memory/history。

备份要校验后才标可恢复，隐私清除覆盖含旧内容的受控备份。跨宿主 bundle 显式选择范围、校验 hash/identity，导入先作为待重验候选，不携带活动权限、pending approval 或执行权；不是默认整库同步。

## 17. 在 Claude 侧如何借鉴

### 17.1 应优先保留的架构骨架

不论用哪种 Claude 宿主，优先保留：

1. Archive/source 与 durable memory 分开。
2. Type、scope、verification、lifecycle 正交。
3. 稳定 record identity、不可变 revision、追加 event 和 CAS head。
4. Capture → integrity → independent verification → activation。
5. 检索先资格后相关性，允许空与明确降级。
6. 精确 provenance 与有界 source recovery。
7. Forget、restore、rollback、purge 分清。
8. Memory 不直接修改活动指令或授予权限。

SQLite、五种类型、scope 模型和 outbox 都是可参考的具体选择，但不要为了照搬 Euler 而引入没有消费者的表、服务或框架。

### 17.2 将能力映射到实际宿主控制面

| 想得到的保证 | 宿主必须真正掌握的能力 |
|---|---|
| 可审计记忆 CRUD / 检索 | 本地服务或工具对存储、scope、审批和事务的控制 |
| 精确原话恢复 | 原始事件的可靠持久化、版本身份和读取入口 |
| 唯一上下文装配与硬 token 检查 | 每次最终模型请求的内容选择与发送 admission |
| 精确缓存 epoch 与 attempt ledger | 最终 transport payload、真实发送和 provider 结果 |
| 迟到结果不复活已清除内容 | 对运行进程、子任务、写入接点和受控副本的隔离 |

若 Claude 宿主只提供工具接入，可以构建存储、检索和生命周期子系统，但不能因此声称已掌握其内部 compaction、完整请求账本或硬预算。若能控制 API 调用/Agent harness，才有条件接入完整 Orchestrator 与 transport gate。

仅靠一段提示词或上传 Markdown，可以参考知识模型，但不能获得事务、原文归档、权限隔离、自动维护和可靠 purge 保证。

这里不假定使用 Claude Code、网页端还是自建 API 客户端，也不把任何一种接口能力当作已核验事实。

### 17.3 工具面可以小，但权利边界要完整

Euler 的记忆/来源模型工具为：

```text
memory.search
source.search
source.expand
memory.inspect
memory.preview
memory.commit
memory.cancel
```

工具名可以调整；关键是查询与 mutation 分离，mutation 必须经过唯一目标、canonical preview、真实批准和 CAS。

自动 capture/verification 是受控后台管线，不向模型提供随意 `write_active_memory`。宿主还需要不经模型的查看、批准、取消、对账和维护入口，避免所有权利都只能靠模型转述。

## 18. 设计验收问题

构建时至少验证以下行为，而不是只验证“工具返回了成功”：

- 未验证、过期、冲突、跨项目未授权内容能否进入正常上下文？要求不能。
- 用户说“同意”时，是否绑定了正确方案，而非脱离上下文的永久授权？
- 项目目录变化、源码/安装目录别名和多平台差异是否错误合并？
- 相似记忆、不同有效期和真正冲突能否区分？
- 索引丢行、FTS posting 损坏、旧 job 乱序时是否明确降级且可重建？
- 没有强命中是否真的返回空，而非补足固定数量？
- Inspect 是否恢复本轮实际选入的 revision，而非当前新版？
- 旧 preview 在回滚到相同正文后是否仍被拒绝？
- 崩溃后是否只补呈现/投影，不重复 mutation 或重发 unknown 请求？
- Forget 后重放同源材料是否仍被抑制？Purge 是否覆盖备份和迟到写入？
- 换窗是否保留真实目标、完整 ReAct 边界且不重置累计预算？
- 普通任务成功是否被错误地当成记忆真实/有用的证明？
- 反复注入的 insight 是否有未参与生成的反例/held-out，能否检测负迁移？
- 每个目标宿主是否有真实证据，而非用另一平台的结果代替？

安全、scope、批准、来源完整性和预算违规不能被平均召回率或低延迟抵消。性能比较需固定 workload/provider/model，分开 cold/warm/cache；没有指标就明确未测，不编造保证。

## 附录 A：值得带走的落地注意事项

这里保留检索和来源切片中积累的约束，不列实现进度，也不声称本文重新执行了生产验证。

1. **中文不能直接假定英文 FTS 就够用。** Euler 的证据记录指出，裸 `unicode61` 对中文子词召回不足，trigram 对两字查询不适配；采用版本化 CJK overlapping 2-gram。分词只改投影，原文不改。单字策略须单独验证，不能把不支持解释成不存在。见存储契约 §17 与 T10。
2. **共享索引的全库 BM25 可能破坏隔离。** 未授权文档会影响全库语料统计，进而改变授权内排序。不要先按全库分数截断再过滤；排序/限额应只依赖获准候选，或使用真正隔离的统计。T10 采用可复算的获准候选 lexical 排序；这也是本文没有要求固定融合公式的原因。
3. **用户查询不是 FTS 表达式。** `OR`、引号等不能自动获得检索运算符权限；数字/版本号需要准确匹配，不能因为别处出现同一数字就召回错误对象。见 T10 及其检索测试。
4. **Dirty 不等于空。** 投影滞后、posting 丢失或完整性失败必须有 coverage/status；命中资格以 canonical 为准，空结果也不能掩盖索引缺口。见 T10/T11。
5. **发现单元不应复制一份原始档案真值。** T11 的 source unit 保存不可变引用和有界范围；每次展开回原 archive 校验完整 hash 与当前权限，混合报告只开放获准区段。
6. **验收 receipt 不能自证。** 脚本成功、`passed=true` 或报告里的摘要都不能替代真实 archive、SQLite、请求 payload、stdout/stderr 与独立复算。存在强制 evidence gap 时应报 partial/gap，不能报完整通过。见 T11 与正式验收纪律。

## 附录 B：Euler 原始文档导航

本文正文已经包含构建参考所需的核心语义；下面的链接用于在 Euler 仓库内进一步查证，不要求接收者拥有仓库才能理解本文。

| 内容 | 原始依据 |
|---|---|
| 总规格与所有关键不变量 | [15：Euler v1 实施规格](issues/15-euler-v1-spec.md)，I01–I19 |
| 对象、知识与活动规则的边界 | [04：领域边界](issues/04-define-domain-boundaries.md) |
| Owner、权威、冲突与来源完整性 | [05：权威边界](issues/05-set-authority-boundaries.md) |
| Type、scope、粒度、生命周期 | [06：记忆模型](issues/06-design-memory-hierarchy.md) |
| Orchestrator、intent、快慢路径、cache、来源恢复 | [07：记忆与上下文协作](issues/07-coordinate-memory-context.md) |
| Capture、独立验证、反馈、晋升、遗忘与行为演化隔离 | [08：自动演化门禁](issues/08-automate-memory-evolution.md) |
| 检索资格、跨项目只读发现、预算和 assembly | [09：安全上下文装配](issues/09-assemble-context-safely.md) |
| SQLite、搜索投影、overview、报告交接、隐私与恢复 | [10：存储与投影](issues/10-choose-storage-projections.md) |
| 看、改、退及批次操作的详细语义 | [11：可观测与纠错](issues/11-prototype-observability.md)，总规格 I15–I17 |
| 各宿主的真实呈现、批准和终态要求 | [14：Host 呈现](issues/14-define-host-presentation.md)，总规格 I15–I18 |
| 原始验收矩阵 | [12：证据实验矩阵](issues/12-build-evidence-experiment-matrix.md)，总规格 Testing Decisions |
| 检索切片积累的注意事项 | [T10：Scoped memory retrieval](../implementation/t10-memory-retrieval.md)、`apps/cli/test/memory-retrieval.test.ts` |
| 来源恢复、发现单元与冻结版本检查 | [T11：Source recovery](../implementation/t11-source-recovery.md)、`apps/cli/test/source-recovery.test.ts` |
