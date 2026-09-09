# 确定最小记忆层次、类型、作用域与生命周期

Type: grilling
Status: resolved
Blocked by: 04, 05

## Question

网页对话提出的 L0 Artifact、L1 Project Knowledge、L2 Personal Knowledge 以及 typed memory 模型是否合理？满足当前需求所需的最小层次、类型、作用域和生命周期是什么，哪些分类应合并、拆分或删除以避免巨型枚举和投机性知识图谱？

## Comments

- 已认领；04/05 已确定对象边界、owner、scope 语义、冲突与失效规则。这里仅设计 durable memory 的最小规范模型，不重新混入 source、intent、policy 或 projection。
- 课程证据只证明文件持久化和 lexical top-3；当前 `memory.ts` 没有 scope/status/supersedes、结构化 provenance 或冲突隔离，不能反推生产 schema。
- 外部证据支持 typed/scoped 多平面和统一访问外观，但不支持把原文、事实、指令、intent、关系图与索引压成一个层次或提前采用图数据库。

## Decisions — Round 1

1. 不把网页提案的 L0/L1/L2 实现成三套记忆层：L0 Artifact 属 source/archive，L1 Project 与 L2 Personal 是 scope。Durable memory 使用一套记录模型，以 type、scope、state 和 provenance 等正交维度组织，避免晋升时跨层复制成多主。
2. v1 不建立语义实体—关系知识图谱。规范记忆只保存运行必需的 `derived_from`、`supersedes`、`conflicts_with`、`scoped_to` 等操作关系，普通关系存储即可。Wiki 通过这些硬关系、标签、全文/向量检索生成目录、链接、backlinks 与“相关洞察”；这些展示关系是可重建投影，不反向获得权威。

## Decisions — Round 2 (partial)

3. Durable memory 的内容类型收敛为 `fact`、`preference`、`decision`、`insight`、`episode`。`hypothesis` 不作为内容类型，而表示 fact/insight 尚未证实的 verification 状态；它进入 durable memory 后仍必须明确标记 `unverified`，不能当成 verified 事实注入。
4. 目标模型保留 `project / workspace / personal` 三种 scope。Workspace 表示稳定相关的项目组，不表示 Android/Flutter 等可重叠技术条件；v1 仅支持扁平、可选 workspace，每个 project 最多归属一个。没有 workspace 时等价于 `project + personal`，不引入运行开销。
5. 一条 memory 以“能够独立验证或失效的最小语义单元”为边界：共同拥有 scope、evidence、verification 状态和失效条件的结论与必要理由可留在同一记录；任一部分能独立变化就拆分。Wiki 页面聚合多条记录，不把整页存成 blob，也不机械逐句切碎。

## Decisions — Round 3

6. 不维护统一主题 taxonomy 或实体词表；只固定 type/scope/state。Topic、tag 和 entity alias 只是可选检索元数据，允许按实际重复按需归一，不获得规范权威。
7. 生命周期与验证状态分成两个正交维度：`lifecycle = candidate | active | superseded | rejected | tombstoned`，`verification = unverified | verified | conflicted | stale`。例如 `superseded + verified` 表示过去成立但当前已被替代。
8. Project 洞察晋升到 workspace/personal 时不原地改 scope；创建带 `derived_from` 的更广 scope 版本。语义完全相同的窄 scope 记录可 supersede，仍含本地差异的记录继续保留；晋升因此可审计、可回滚。

## Decisions — Round 4

9. 不设统一 TTL。会变化的 fact 可有 `as_of`、`valid_until` 或 `review_after`；preference/decision 在明确 supersede 前持续有效；source 变化通过 provenance 标 stale，不按记录年龄粗暴失效。
10. “普通忘记”使用 tombstone，停止检索并阻止同一来源自动复活；“隐私清除”物理删除正文、embedding、缓存和投影，彻底清除还必须由各 owner 处理对应 source/archive。
11. 只自动处理确定性重复：同一 source event 重放为 no-op，同一规范 claim 获得新 evidence 时追加 provenance；仅语义相似的记录只形成 merge candidate，必须经 verifier 才能合并或 supersede。

## Decisions — Scope identity clarification

12. `project` 是独立于 cwd、目录与 Git root 的 logical project identity；目录只作为 `resource_ref`、provenance 和权限定位。以目录直接划 scope 会把 `~/.pi` 等全局配置根中的多个独立任务错误合并，也会把同一组件的源码与安装目录错误拆分。
13. Scope owner 与适用条件正交：`project/workspace/personal` 表示记忆由哪个逻辑边界拥有，`applies_to` 表示它适用于哪些 agent、platform 或 component。Workspace 可表示 `personal-agent-stack` 等稳定项目组；第三方插件的普通配置属于 agent runtime project，只有具备独立代码、测试、版本与回滚生命周期时才建立独立 project。
14. Active intent 提供 primary logical project，跨项目任务可列 affected projects；每条 memory 仍按自己的 claim 单独定 scope。解析顺序为已有 intent/mission、明确 manifest 或资源 owner、当前请求与实际触碰资源；仍不明确时只保留 session-local candidate，不因 cwd 自动晋升 durable memory。
