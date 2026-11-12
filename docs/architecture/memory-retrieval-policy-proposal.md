# 普通记忆按需检索：已确认策略

状态：**R1–R8 已由 owner 确认，作为 v1 的普通记忆交付策略。** 决策日期：2026-11-12。依据为 `8a90e54eb0d540690a750238121db77e9d17e926` 的代码与文档、本轮合成开发实验，以及已交付的 PR #61 项目规则能力。

采用的分工是：持续约束由明确发布的项目规则提供；普通记忆在需要历史信息时检索；自动捕获、验证、晋升和生命周期管理继续运行。本决策只调整普通记忆进入模型上下文的触发与交付要求，具体条款已同步至下表正式规格。实现与验收状态以 [v1 规格](issues/15-euler-v1-spec.md) 和 [T24 gate](../implementation/t24-first-cli-acceptance.md) 为准。

## 依据与取舍

[实验索引](../implementation/t24-retrieval-experiment-index.md) 中，明确要求沿用历史格式的简单写作在两个新会话中均主动检索并完成；完整给出格式的一次观察直接答对。原先只要求“写维护通报”的题目没有明确历史依赖，未写出藏在记忆中的落款不足以单独诊断必要检索被遗漏。

这些结果支持特定按需路径可用。两次历史依赖样本均包含实验 B 指导，未分离该指导的独立贡献，也未比较两种记忆策略的总体效果。本决策据此确定产品取舍，不将实验提示词原样定为正式契约。

| 采用按需交付的收益 | 接受的代价与约束 |
|---|---|
| 输入完整时无需预先带入普通记忆候选 | 需要历史时，依赖主模型识别信息缺口 |
| 检索内容能与具体工具调用和任务需要对应 | 检索任务通常增加模型与工具往返，须计入原 run 预算 |
| 持续规则与历史数据各有明确入口 | 用户希望持续遵守的要求须经项目规则发布流程，普通“记住”不自动改 AGENTS |

## 已确认条款

### R1. 项目规则与普通记忆

适用的已发布项目规则沿既有 P0 guidance 路径加载。规则发布、版本、资源范围、批准及选择性清除继续采用 PR #61 的契约。普通 preference/decision/fact/episode/insight 仍是数据，不能授予权限、改变工具或审批状态，也不因多次命中或模型建议而自动转为项目规则。

“每次通报都必须使用某个落款”若作为持续约束，应通过明确的项目规则发布操作交付；“上次通报使用什么格式”作为历史信息保留在记忆或来源中。两者的表达相似，不改变各自的权威和发布入口。

### R2. 普通记忆的交付时机

普通用户请求不再要求 Harness 在首个模型调用前，以该请求和 intent 自动召回普通记忆并选入 prompt。新激活记录、后台 top-k 或跨会话普通记忆不自行进入 P1 baseline 或 P3 tail。需要当前上下文之外的历史信息时，主 Agent 在现有 ReAct 循环中调用 `memory.search`；显式 Host 查询仍采用原有入口。

已有对话中的工具结果、已选内容和合法 compartment 可按既有窗口、预算及状态重验规则继续保留。取消自主召回不要求擦除已取得的正常对话历史，也不要求每轮重复查询。新会话不能仅因记录处于 active 状态就自动把它重新 pin 到模型上下文。

### R3. 检索需要的行为口径

- 当前输入和已有有效上下文足以完成任务时，允许直接回答。
- 完成任务明确需要尚未提供的历史约定、先前决定、原话或出处时，应使用授权范围内的检索／恢复能力。结果不足、不可用或受预算限制时，说明缺少的证据，不编造历史。
- 未说明历史依赖、又可独立完成的泛化写作请求，保留为观察场景；隐藏答案未被带入不能单独作为失败判据。
- 判断依据是信息是否足够；不添加按题目长度、任务“简单／复杂”或固定实体名单运行的路由器，不要求每个写作任务都搜索。

这组条款定义行为，不冻结某段提示词。开发评估须同时记录检索是否发生、结果是否可用和答案是否满足要求。

### R4. 查询与来源恢复

`memory.search` 继续接收调用者提供的显式 query；主 Agent 可按任务改写查询。无需在每个普通请求前自动拼接用户输入和 intent 生成检索。现有 lexical 检索、硬过滤、排序、去重、分页及中文支持要求独立保留；本决策不以当前实现替代原有排序规格。

本次仅取消普通 Memory 的自主召回／装配义务。[07 §14–16](issues/07-coordinate-memory-context.md) 中因明确原文／版本／证据需求或精确 provenance 触发的定向 Source Recovery 保留，实际实现与证据缺口仍单列。它不扩展查询范围，不扫描普通记忆库来补做被取消的自动召回。

已发布项目来源通过 `source.search(scope=project)` 返回的 published unit 定位；当前会话 event 与 memory record 是不同标识。原文核验继续满足既有 scope、immutable locator、hash、完整范围与有界展开要求。记忆回答正确不替代原文恢复验收。

### R5. 新写入内容与投影延迟

取消新激活记忆“下一轮 pinned delta 自动进入模型”的交付要求，保留下一次实际检索对当前 canonical head 的可见性要求。复用有界 canonical 补漏或现有投影一致性处理；无法给出当前结果时返回明确 dirty／unavailable／覆盖缺口，不能把旧结果或假空结果当作当前完整查询。不能借本次策略调整省略原有 read-after-write、状态变化和重建验证。

### R6. 资格、权限与生命周期

[06](issues/06-design-memory-hierarchy.md)、[08](issues/08-automate-memory-evolution.md) 的 type/scope/state/provenance、capture、verification、晋升、冲突处理、correct/forget/restore/rollback、Info 和 purge 保持原契约。自动记录／验证与自动注入是独立能力。

每次检索及后续使用继续核对 scope、目标环境、当前 revision/head、lifecycle、verification、时效、source integrity 和任务授权。未授权项目不泄露名称、摘要或正文；结束／撤销后的 cursor/ref 失效；已检索结果不能绕过 dispatch 前的权限和状态重验。

### R7. 账本与计量

分别记录三种可观察事实：是否发生检索、检索返回了哪些对象、哪些内容实际进入哪次冻结请求。无检索调用不解释为“全库没有相关记忆”，也不编造未查询候选的排除原因。`retrieved` 与实际送入模型的 `injected`／selected 继续区分，后者包含作为工具结果送达的内容。

复用现有工具归档、assembly 与 attempt ledger 核对 query、返回身份／状态、排序和覆盖、实际引用／顺序／hash、预算与发送结果。按实际路径记录分数和 tokenizer 版本；缺少的 token／成本指标继续记缺证，不用字节、名次或整包 usage 冒充逐候选指标。无需另建平行追踪系统。

### R8. 调用次数与预算

“普通快路径主模型恰调用一次”改为“无需检索或其他工具、且无传输／协议故障的正常回答恰一次主调用；依赖工具的任务沿有界 ReAct 循环完成”。所有检索、来源恢复及后续模型调用计入同一 run 的 attempt/tool/token／成本/deadline 预算，换窗不重置；不引入额外 router/RAG Agent。

因预算耗尽停止，且此前已主动检索但尚未形成最终答案的运行记为受预算限制，分别保留触发与送达观测，不当作检索未触发或完整回答失败。取消、provider 失败、protocol 失败与回答质量也分别登记。

## 正式规格对应位置

下表对应当前已确认的正式条款；未列出的要求继续生效。设计定案与实际实现／独立验收分列，T24 仍保持 BLOCKED。

| 规范位置 | 当前交付要求 | 保留内容 |
|---|---|---|
| [07 §2–3、§11–13](issues/07-coordinate-memory-context.md) | 自动本地 top-k、request＋intent 首轮召回、普通任务一次主调用 → R2/R3/R4/R8 | 单一 Orchestrator、本地检索 primitive、主 Agent 工具循环、无额外路由模型 |
| [07 §8–9](issues/07-coordinate-memory-context.md) | 自主 session-pinned memory、动态 retrieval tail 的交付条件 → R2 | 已检索历史的保留、完整 ReAct、冻结布局和 epoch |
| [09 §2–4、4b、5、14–16](issues/09-assemble-context-safely.md)；[15 I07](issues/15-euler-v1-spec.md) 的正常检索条款 | 默认自动检索、request＋intent 查询、无调用时的候选选择／状态标记观测 → R2/R4/R7 | 硬准入、任务授权、实际查询的状态标记、排序／去重与真实送达证据 |
| [10 §16](issues/10-choose-storage-projections.md)；[15 I07](issues/15-euler-v1-spec.md) | 激活后下一轮自动 pinned delta → R5 | 新写入可检索、current-head 核验、投影 lag／重建语义 |
| [12 X-02](issues/12-build-evidence-experiment-matrix.md) | 自主选入／排除观测 → 按调用触发、返回、送达分层验收 | 权限、资格、状态转换、query／tokenizer、成本和独立证据要求 |
| [12 X-04](issues/12-build-evidence-experiment-matrix.md)；[13 D5](issues/13-select-target-v1-migration.md) | local top-k 超时与单次普通调用的适用条件 → R8 | 异步工作不阻塞、硬预算、完整工具对、Source Recovery、cache 失效 |
| [15 I08、I10–I11、Testing Decisions](issues/15-euler-v1-spec.md) | 快路径、pinned memory、选择证据及对应测试表述 → R2/R5/R7/R8 | 权威分层、immutable payload、started/finished、unknown 与恢复 |
| [T24 B3/B4](../implementation/t24-first-cli-acceptance.md) | 按新规范规划后续验收，附新证据 | 原独立首测结果、B3–B5 未闭合事实；不将取消范围的旧缺证改成 PASS |

07 §14–16 的定向 Source Recovery、06 的记忆模型、08 的自动演化不作为本次删除项。09 §4b 只消除“每个当前请求先做 canonical retrieval”的自主触发假设；overview 仍为未启用的后续切片，需要时的 canonical-first、资格、来源恢复与依赖闭包保持原约定。文档中“注入”若仅描述实际内容送达或禁止未验证内容进入 prompt，继续保留其含义，不做全局词语替换。

## 实现与发布边界

1. R1–R8 已确认：普通记忆不自主进入首请求；实际检索计入工具往返预算；source 定向恢复保留。对应开发证据不提升为完整能力验收。
2. 正式规格与 [验收计划](../implementation/t24-retrieval-acceptance-plan.md) 使用同一已确认口径。规范发布后以对应 commit 固定基线；涉及产品行为或必跑验收要求的交付按仓库 PR 路径处理，不以 Markdown 扩展名推断为纯措辞维护。
3. 在实现前同步受影响开放票的 `Spec references`。当前明确受影响的是 [#25](https://github.com/qsgy-edge/euler/issues/25)；[#26](https://github.com/qsgy-edge/euler/issues/26) 的 shadow 判定及 [#28](https://github.com/qsgy-edge/euler/issues/28) 的 canary 验收引用需逐项复核。保留 generated-ticket marker；[#27](https://github.com/qsgy-edge/euler/issues/27) 的 owner 切换和 [#37](https://github.com/qsgy-edge/euler/issues/37) 的投影吞吐不因此自动扩项。
4. 只为确认的实现差异安排修复与开发验证；独立验收的保管、释放和复验仍按原边界另行安排。

本决策不冻结 schema，不关闭 T24，不扩大 Host／生产数据支持，也不授权新的真实模型请求。本轮批准的 18 次请求已全部使用。
