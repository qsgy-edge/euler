# 划定记忆、会话历史、上下文与知识投影的领域边界

Type: grilling
Status: resolved
Blocked by: 01, 02, 03

## Question

目标系统应如何规范区分事实源、原始会话档案、工作上下文、上下文虚拟化、情节记忆、项目与个人知识、用户偏好与项目指令、洞察与决策、生成式 Wiki 投影？哪些对象属于“记忆”，哪些只是来源、索引或视图？

## Comments

- 已认领进入 grilling；前置研究票 01/02/03 均已完成并纠错。
- 已读取更正后的完整网页对话 `https://chatgpt.com/share/6a8ee46a-451c-83ee-9103-62b814c2c2a9`。其核心提案是：统一逻辑 Memory Infrastructure，但区分类型、scope、生命周期与 authority；项目洞察经验证晋升为个人原则；Wiki 是人类可读投影。
- 待修正的混用：raw source ≠ memory；working context ≠ durable memory；code-derived fact/FTS/embedding/wiki ≠ source of truth；raw episode ≠ episodic abstraction；prospective intent ≠ prose fact；authority 不能只靠固定总排序。
- `ai-agent-book@1111794f` 增量证据进一步要求分开四个阶段对象：`trajectory/source_signal`（原始信号）≠ `episodic_abstraction`（经验抽象）≠ `durable_memory`（可召回知识）≠ `executable_candidate`（可能改变行为的候选制品）。进入下一阶段必须显式转换并保留 provenance，不能靠改一个 `type` 字段隐式晋升。
- 架构推断：第 9 章的 knowledge → instruction → program → parameter 是“演化落点/行为载体”，不是一组语义记忆类型。活动中的 instruction/skill/code/policy 应属于有独立权威和发布门禁的可执行制品；记忆层只保存其候选、理由、证据与决策记录。因此先前 Q3 把 `instruction` 直接列为普通 typed memory 的建议需要收窄。

## Decision

1. 原始会话、代码、Git、测试和工具轨迹属于 `source`；完整会话另以 `session_archive` 保存供恢复与审计。二者都不因被保存或检索而自动成为记忆。
2. Harness 共用身份、provenance、索引和事件基础设施，但规范对象分为 `source`、`session_archive`、`working_context`、`durable_memory`、`intent`、`policy_artifact`、`projection`；共享基础设施不代表共享语义或权威。
3. `durable_memory` 的初始候选类型为 `fact`、`preference`、`decision`、`insight`、`hypothesis`、`episode`；06 票随后将 `hypothesis` 收敛为 fact/insight 的 `unverified` 状态，最终保留五种内容类型。`episode` 是经验抽象而非原始日志；goal/task/note/reminder 属 `intent`，活动 instruction/skill/tool/code/policy 属 `policy_artifact`。
4. `session` 只承载临时上下文和 intent；持久记忆作用域为 `project → workspace → personal`。项目知识默认不外溢，只有跨项目重复验证或用户明确确认才可晋升；不新增语义重复的 `global` 记忆层。
5. Wiki、索引和架构图是 `projection`；人工批准的 ADR 是 decision/rationale 的权威来源而非普通投影，代码和测试仍描述实际行为。编辑投影只产生 source event 或候选，不静默改写规范记忆。
6. 洞察本体位于 Harness 的 durable memory / knowledge plane：`source/archive → 提炼与验证 → insight memory → retrieval/context assembly → working context`；Wiki 从 insight 生成旁路投影。洞察晋升为活动规则时另发布 policy artifact，原 insight 保留其依据与 provenance。
