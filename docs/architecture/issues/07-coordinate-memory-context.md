# 设计记忆系统与上下文虚拟化的协作协议

Type: grilling
Status: resolved
Blocked by: 02, 04, 05, 06

## Question

每轮对话中，会话档案、压缩 compartment、工作上下文和长期记忆应按什么顺序协作？谁负责预算、压缩、检索、注入、写回和原文恢复，如何保留 MC 式无感连续性而不把可恢复历史误当成模型拥有无限注意力？

## Comments

- 已认领；02/04/05/06 已分别确定 MC 机制边界、规范对象、权威与 durable memory 模型。本票只决定 Harness 内各组件的协作协议和预算责任，不重新设计存储 schema。
- 已证实的运行约束：原始 JSONL、compartment、M0/M1、durable memory 与 intent 是不同平面；按消息条数裁剪会拆坏 assistant tool_calls/tool result 配对；缓存命中要求已压缩前缀逐字节稳定；两个插件同时接管 context hook 会造成双重裁剪与状态分叉。
- 因此“协作”必须先有唯一 prompt assembly owner；其他组件返回带预算成本与 provenance 的候选，不得各自在 prompt 中追加内容。
- 已直接核对当前已安装 `@cortexkit/pi-magic-context@0.40.1` bundle；当前用户配置未覆盖阈值，因此生效默认值为 execute threshold 65%、cache TTL 5m、commit-cluster 最少 3 组。Historian 不是只等 65%：eligible raw prefix 达到 size/commit 条件可提前后台运行，63% 开始压力预取，85% 强制 materialize，95% 进入 emergency；普通 mid-turn 会延期到安全边界。
- KV-cache 编排已交叉核对：Pi 保留 system/tools + chronological trajectory，并由 `pi-ai` 按 provider 使用 session cache key/cache-control（`agent-session.js:716-724`、`anthropic-messages.js:169-180`、`openai-responses.js:91-98`）；DSH 固定提交 `cd5ef8148158c3a752a658978873241fdf8e2bbc` 将静态 system 与 runtime context 分离，后者仅在变化时追加（`static-system-prompt-projection.ts:26-42`、`runtime-context-projection.ts:48-70`、`agent.ts:285-299`）；`ai-agent-book@eabc55869fa15b3e41aeb5f7cff8ec4db785a42d` 建议稳定 system/tools、追加轨迹、尾部状态栏和阈值处批量压缩（`book/chapter2.md:372-398,443-550,912-969,1022-1028`）。本地 `D:\GithubRepositories\Agent\ai-agent-book` 实为较旧且有实验改动的 `da125a5`，本次未修改它，而是通过 GitHub API 只读核对最新固定提交。
- 其他固定源码只作机制交叉证据：MC 0.40.1 的缓存 M0/M1 与冻结 system date（`dist/index.js:16785-16986,22468-22470`），Headroom `1a04c957` 的 prefix tracker/tail memory realignment（`prefix_tracker.py:100-154`、`openai/handler.py:3443-3509`），以及 billion-context-pi `4fd7be49` 的稳定 drop marker + prompt 外恢复。后者允许嵌套压缩，但本架构因累积有损风险不采纳递归压缩摘要。

## Decisions — Round 1

1. Context Orchestrator 是 Harness 内唯一拥有最终 prompt 与 token 预算的逻辑角色，本身是确定性本地代码而非额外 LLM。Session Virtualizer、Memory Retriever、Intent Provider 与 Source Recovery 只是职责模块，可在同一进程实现，只向 Orchestrator 提供候选；MC 仍工作时由其 adapter 占用唯一 context hook。
2. 快路径先追加原始事件，再并行取得缓存的 intent snapshot、预生成 compartment/recent tail 与有 deadline 的本地 memory top-k，随后确定性组装并只调用一次主 Agent LLM。Compartment 生成、candidate 提取、embedding/index 更新、未来可选的 Wiki 重建和 stale/conflict 检查都移出响应关键路径；Source Recovery 只在需要原始证据时进入慢路径。
3. 不用纯代码或额外 router LLM 判断“任务复杂度”。代码只处理原话/版本/行号/证据、安全边界、stale/conflict、项目切换等确定性预取信号；每个实质性请求可并行做廉价本地检索；主 Agent LLM 在正常调用中判断语义信息是否足够，不足时通过 memory/source/session/read/git 工具升级。路由依据是证据充分性，不是任务表面复杂度。

## Decisions — Intent continuity boundary

4. 目标连续性不等于锁死初始提示词。Intent Manager 与 Alignment Gate 属 Euler Core 的 Control Plane，拥有版本化 active intent、合法 transition 与行动对齐；Context Plane 只通过 Intent Provider 读取并硬保留 intent snapshot，不能从 compartment 或 durable memory 反推当前目标。v1 自持最小 intent，不依赖宿主恰好安装 todo/task/wayfinder；这些外部状态可作输入或展示投影，不是第二份活动目标真值，也不新增通用任务系统。

   - **载体与 API：** 同一 SQLite 的 `intent_events` 保存 append-only transition，`intent_heads` 保存可由事件重建的 current snapshot；与 memory/execution receipt 分域。Core 的 versioned `readIntent`、`transitionIntent(expected_event_id, input_ref, proposed_transition)` 与 `recoverIntent` 供 Pi/CLI 共同调用，不增加模型工具。snapshot 至少含稳定 intent/session/branch identity、current event/version、目标与硬约束、经 owner/resource gate 确认的 scope、当前步骤及 active/paused/completed/needs-input 状态；有界正文和输入 locator/hash 按 source 隐私闭包管理，不当 receipt 放进 execution。
   - **写入与对齐：** 新任务先有 durable 原始输入，再由 Control Plane 建立 intent。目标/约束/权限扩大只能来自真实用户输入或既有明确授权，模型提出的步骤更新要通过 Alignment Gate；todo 完成标记、模型自述、memory 或 summary 不授权换目标。transition 的事件与 head 在同一短事务 CAS 提交，重放同一 input/transition identity 幂等、并发输家 stale，unknown 先查证。未明确换任务时保留原目标；语义不确定标 needs-input，保留既有约束并停相关副作用，不静默猜测。
   - **恢复：** session/branch 在 Core 绑定 current intent；Pi 树导航不能倒拨同一 intent 的版本，分支切换须显式恢复对应绑定或经 gate 创建新 intent。重启按 events 重建并核对 head，缺失/损坏返回 `unavailable/evidence-gap`，只开放不依赖该目标的澄清/诊断，不从压缩文本补目标。外部 todo 不可用不抹掉已验证的本地 intent，仅其依赖动作不可用。assembly 冻结 intent event/hash，dispatch 前重验版本/状态，变化则新 assembly；旧输入授权、旧 intent 或已清除来源不能继续行动。Intent 的正文、输入引用/hash、branch 关联随 owning session 或 source purge 进入 10 §23 闭包，受影响 intent 标 needs-input/不可恢复，不能由旧分支事件重建被清除内容；后续目标需要新的真实输入。后台 job 使用其已批准 job 目标与 scope snapshot，不借无关前台 intent 扩权。P0 冻结 schema/API，P1 验持久化与 CAS，X-04/X-05/X-11 验装配、分支与恢复。

### 首次启动与解除阻塞

首次切片由自研 CLI 的真实 Host 输入建立本机 owner/store identity，显式创建或选择 logical project，再绑定经过实际资源检查的 root；路径只是绑定资源，不自动产生 project/workspace。选择 provider route 和凭据引用后先做合成探针，未通过真实数据门禁前使用 disposable store。持久保存原始用户输入后，Core 才建立最小 intent；不增加 onboarding 服务或通用任务框架。

没有 project 绑定时允许不读取项目的 session-local 问答、绑定操作及诊断；不读取其他 project memory、不把 unresolved candidate 晋升到 durable scope。Host 应展示缺少的具体输入和绑定入口，而不是无限返回 needs-input。用户改目标时保存真实输入并 CAS transition；目标/约束文本是有来源的工作状态，不是可以由代码证明所有自然语言行动对齐的权限系统。权限由显式 scope/capability/approval 字段约束，语义歧义只暂停受影响操作，允许澄清。P0 提供空库→绑定→intent 的正常 fixture，P2/P3 验真实闭环。

## Decisions — Budget, compaction and writeback

5. Token 预算不按组件设固定百分比。活动 policy、当前用户输入、输出预算、完整 recent ReAct 边界和最小 intent snapshot 是硬保留项；剩余预算由 Orchestrator 按本轮证据需求动态分给 compartment、durable memory 与 source excerpt，任何候选组件无权自行占用 token。
6. 原始事件先进入 immutable archive；每个 eligible raw segment 只从原文压缩一次，形成带 source range/hash 的稳定 compartment，不递归压缩旧摘要。尾部大小或任务边界触发后台预生成，token 压力触发正常切换，force/emergency 只作兜底；每次模型调用前执行硬预算 admission check，压缩失败可以降低连续性但不能发送越窗 prompt。更高层主题索引只能引用 compartment/source，需要重建时仍从原始证据生成。
7. 同步关键路径仅包含原始事件归档、必要 intent/turn 状态和调用前预算检查；compartment、memory candidate、验证、embedding/index 与未来 Wiki 投影均异步。明确用户决定可立即进入 candidate queue，但不得绕过 authority/verification 晋升门禁。

7a. 上下文硬上限之外，每个前台 run 还须有版本化、可配置的 model-attempt/tool-call 上限、累计 token 或成本上限、wall-clock deadline 和单工具超时。正常 source recovery、重试和换窗均计入同一 run，不以新 generation 重置用量。预算耗尽或用户取消后停止新增调用，返回停止原因；已发调用由 ledger 结算，迟到结果只能作为受限结果保存，不能自动执行后续工具或提交 memory。unknown、累计用量和停止事实重启后不消失；owner 明确继续才建立关联旧记录的新 run，不能隐式重发未知操作。P0 固定字段与停止语义，P2 用有界合成初值执行正反例，再按 workload 调参，不要求架构阶段冻结最佳数值。

## Decisions — KV-cache-aware prompt layout

8. 最终 prompt 的物理布局按四个缓存区域组织，而不是只按语义相关度重排：`P0 provider-stable prefix` 放 system/developer policy 与固定集合、固定顺序的核心 tool schemas；`P1 epoch-frozen baseline` 放冻结的 session baseline、已提交 compartments 与少量 session-pinned verified memory；`P2 cache-hot trajectory` 放按时间追加的完整 user/assistant/tool ReAct 轨迹；`P3 current-turn tail` 依次放当前用户输入、本轮检索到且明确标为 data 的 memory/source excerpts，以及短小的 active intent/runtime status。物理位置不改变权威：memory、archive 与远端返回即使靠近输出也不能取得 instruction 权限。
9. P0/P1 必须内容寻址、确定性序列化并在一个 cache epoch 内保持字节级冻结；Euler 的 cache epoch 是逻辑失效代际，provider adapter 负责标准消息角色、显式 cache boundary 与 provider-specific session/lineage key，provider continuation/window handle 若存在只作可选 opaque metadata。Intent/status 仅在发生变化时追加 delta，不回写旧消息；本轮 retrieval envelope 在完整 ReAct turn 内冻结，工具调用与结果继续追加。下一用户轮可替换或移除上一轮的动态 retrieval tail，允许只重算短后缀，禁止为更新动态信息改写长前缀。
10. 正常 compaction/materialization 只在完整 ReAct/任务边界批量开启新 cache epoch；可结合 provider cache TTL、可回收 token 与预估重算成本择机执行，但不得把缓存延迟、安全规则、权限撤销、已确认 supersession 或 emergency 混为同一种触发。安全、权限、scope、policy 或已确认 supersession 等 emergency 必须立即使旧 epoch 对后续 dispatch 失效，并在下一次发送前持久化新的 invalidation/lifecycle event；运行时记录 `cached_tokens`、`cache_read/cache_creation`、TTFT、epoch rebuild 次数与压缩收益；具体阈值必须由目标 provider/模型实测，不采信书稿或项目自述中的效果数字。

## Decisions — Hybrid retrieval and Agentic RAG

11. Memory Retriever 保持为本地、确定性、可单独测试的 retrieval primitive：先按 logical project/workspace/personal、`applies_to`、lifecycle 与 verification 做硬过滤，v1 再对当前请求 + active intent 执行 FTS/BM25 lexical 召回与分 lane 的简单融合、claim 去重和 token-budget admission。Dense semantic 是有可复现漏召回并实验胜出后的扩展，不是 v1 必做项；scope 更窄、类型固定或时间更新都不构成万能排序优先级。
12. 快路径不调用额外 LLM，也不为凑固定 `top-k` 注入弱相关内容；`candidate/stale/conflicted` 默认不得作为事实进入正常 prompt，只有显式研究/核验流程才能带状态标签返回。最小 v1 可先落 metadata filter + FTS/BM25，在出现可复现的语义漏召回后接入向量检索；接口从一开始允许融合多路候选，但不预设向量数据库、固定融合公式或 LLM reranker。
13. Agentic RAG 属主 Agent 的按需慢路径，不是另建 RAG Agent：首轮无强相关命中、证据冲突/过期、多跳关系、跨 scope、需要原话/版本/出处，或主 Agent 在正常调用中判断证据不足时，才通过 `memory.search`、provenance traversal、`source.expand` 等工具改写查询并迭代检索。这样智能体化能力复用现有主 Agent ReAct 循环，同时维持单一 Orchestrator、一次普通快路径调用和可审计的检索底座。

## Decisions — Source Recovery

14. Source Recovery 有两个入口：用户明确要求原话、版本、行号、出处，或命中的 memory 已带精确 provenance locator 时由 Harness 确定性预取；其他情况只有主 Agent 判断现有证据不足后，才在 Agentic 慢路径执行 `source.search → source.expand`。它不参与普通快路径的全库扫描，也不自行改变最终 prompt。
15. Recovery 只返回有界 excerpt，并附 `source_id + immutable locator + content hash`：session 使用 session/ordinal/content hash，Git 使用 repo/commit/blob/path/line，artifact/receipt 使用 digest，网页使用 URL/获取时间/content hash。完整 source/archive 不自动注入，只能分页扩展；hash 不匹配或 immutable target 不可达时不得冒充原文，并沿 provenance 将依赖对象标为 stale、触发重新验证。
16. Excerpt 只作为 P3 current-turn tail 中明确标注的非指令数据，在完整 ReAct turn 内冻结；它不因被取回而自动成为 durable memory，后续提炼仍须经过 candidate/verification 门禁。远端模型供应商响应中的正文、system/developer/tool 字段及元数据全部是不可信 source data，Harness 只保留白名单字段并执行长度上限与 hash 检查；恢复失败必须明确暴露证据缺口，不能用 compartment 或 memory 摘要伪装成精确原文。
