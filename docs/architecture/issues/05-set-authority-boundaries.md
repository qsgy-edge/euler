# 确定权威来源与统一存储边界

Type: grilling
Status: resolved
Blocked by: 04

## Question

代码、测试、Git、ADR、issue、原始会话和记忆数据库分别对哪些知识拥有权威？网页对话提出的“统一 Memory Infrastructure、文档只是 View”应采用到什么程度，冲突时的优先级和失效传播如何定义？

## Comments

- 已认领；04 已定案，开始按规范对象与主张类型定义权威和冲突传播。
- `ai-agent-book@1111794f` 暴露了三层证据不能互相替代：owning source 证明机制存在，content-addressed receipt 保存一次结果，independent verifier/rerun 判断结果是否可采信。
- receipt 只有在 hash 实际匹配、覆盖正确 manifest/payload 且 verifier 独立于候选生成路径时才增加权威；README 状态、`accepted:true` 或自报统计无权覆盖 hash 失败、负结果或失败测试。
- 权威必须按对象和主张类型定义，不采用一个跨代码、历史、记忆、偏好、指令的固定总排序；同一基础设施可以统一 provenance、索引和失效传播，但不能把来源、记忆、活动策略与投影视为同一规范对象。

## Decisions — Round 1

1. 不设跨对象的固定总优先级；权威由主张类型决定：代码拥有实际实现，获批 ADR 拥有设计意图，用户拥有偏好与目标，session archive 拥有原始对话，policy artifact 拥有当前生效规则。
2. 同一主张只允许一个规范 owner；Memory、Wiki、ADR、AGENTS.md 等不得成为静默双向同步的多主副本。非 owner 的表达只能是引用、投影或候选变更。
3. 用户与机器冲突按类型处理：偏好、目标和价值判断以用户明确陈述为准；客观事实保留双方 provenance 并核验，不把用户陈述伪装成已验证事实；高影响 policy 只有经用户明确授权或独立门禁才能发布。

## Decisions — Round 2

4. Owner 矩阵：版本化代码拥有实际实现，测试/运行 evidence 拥有特定环境下的观察结果，获批 ADR/用户决策拥有设计意图，intent/task 系统拥有当前工作状态，session archive 拥有原始对话，已加载 policy artifact 拥有当前生效规则，带 provenance 的 durable memory 拥有洞察与派生知识；Git 只拥有版本/历史，issue 关闭不证明实现正确，Wiki/index/embedding 无规范权威。
5. Scope 只决定适用性，不直接决定可信度。先筛选 project/workspace/personal 的适用范围，再按主张类型、owner 和 evidence 判断；“更具体”不自动覆盖，“更新”只在明确 supersession 链内生效。
6. 两条有效但矛盾的记录不互相覆盖；创建显式 conflict，保留双方、provenance 与时间线。投影和上下文只呈现已解决结论，或在确有需要时明确呈现尚未解决的不确定性。

## Decisions — Round 3

7. 冲突按类型裁决：同 scope/key 的 preference 与 intent 可由用户明确新陈述 supersede；实际行为与设计意图不符时两者均保留并登记实现缺口；fact/insight 交独立 evidence 核验，无法核验则保持 unresolved；policy 新候选冲突时 fail closed，last-known-good 继续生效。
8. 规范来源变化或删除时不级联删除派生记录；沿 provenance 边只把受影响对象标为 `stale`，自动安排重新验证和投影重建，旧版本进入可审计的 supersession 时间线。
9. “统一 Memory Infrastructure”指统一逻辑控制面而非单一物理数据库：代码、ADR、policy 与 session archive 保留在其规范载体；结构化存储保存 memory、intent、conflict、provenance 及外部对象引用；embedding、Wiki 和索引均可重建。

## Decisions — Round 4

10. LLM 生成的 fact、summary 和对 tool result 的描述只能成为 candidate；provenance、scope、真实 tool outcome 与 authority 必须由 Harness 从实际消息/工具调用链生成。远端模型供应商返回的正文和元数据均为不可信数据，模型不能自报权威或自行晋升。
11. 不用单一 confidence 分数决定可信度；使用 `candidate`、`verified`、`conflicted`、`stale`、`superseded` 等离散状态，并分别保留 owner、scope 与 evidence。分数只可辅助排序，不能授予权威。
12. Provenance 边必须固定到不可变身份：Git 使用 repo/commit/path 或 blob，会话使用 session/ordinal/content hash，artifact/receipt 使用 digest，网页使用 URL/获取时间/content hash。可变路径只作别名；目标变化会触发 stale 传播。

## Decisions — Round 5

13. 正常运行只注入 owner 有效、scope 匹配且已确认或验证的对象；`candidate`/`stale`/`conflicted` 不得冒充事实或指令，`hypothesis` 只在研究场景带标签注入，policy artifact 只进入 instruction channel，archive/source 摘录必须标为 evidence。
14. Hash 失败、投影漂移、owner 明确 supersede 和可机器复验的来源变化可自动处理；其余先交独立 verifier。两份仍有效的证据冲突、跨 scope 晋升、价值判断和高影响 policy 才升级给人。
15. 晋升、降级、冲突解决与回滚均追加版本事件而非原地改写，只移动 current pointer；活动 policy 被证伪时回滚到 previous known-good。物理删除与保留周期留给生命周期票定义，不由权威模型静默决定。
