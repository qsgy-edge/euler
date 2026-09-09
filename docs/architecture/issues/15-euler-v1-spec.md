# Euler v1 实施规格

Type: spec
Status: open
Labels: ready-for-agent
Execution: gated (whole-design review, migration acceptance, and implementation task authorization required)
Source checkpoint: 396622b6395df44ccc466c2cc39d2e63038b7bd6
Source map: course-source:map; see ../migration-manifest.json

本规格最初按 `to-spec` 汇总设计；2026-09-09 按 owner 的审查后修改请求收敛首次交付范围，并同步修订相关契约和验收。迁移检查点与旧评审仅证明历史版本，不证明本次修订或目标运行通过。`ready-for-agent` 不是生产启用指令；实现、真实数据、能力启用和 MC cutover 分别受对应门禁约束。原始契约及其责任边界见 Further Notes；未解决的规范冲突须明确记录，不由实现者静默选择。

## Problem Statement

个人 Agent 需要在长会话、跨会话和跨项目工作中延续目标、恢复精确证据并复用已验证知识，但模型每次调用的上下文始终有限。把原始日志、摘要、长期记忆、当前任务和活动指令混成一个知识库，会使来源、适用范围与权限边界丢失；只按相似度检索或保存模型自述，也无法证明事实正确、操作获批或请求在崩溃前是否发送。

用户需要默认无感运行，同时能追问本轮实际使用了什么、纠正错误、撤销自动记忆更新、区分可恢复的忘记与不可逆的隐私清除。Pi 与自研 CLI 的交互能力不同，但不能因此采用不同的批准、CAS、持久化、隐私或安全语义。现有课程与外部项目提供机制参考，不构成 Euler 的运行验收。

## Solution

构建本地优先、单用户的 Euler 个人 Agent。v1 以一份共享 TypeScript Core 连接 Pi adapter 和自研 CLI，封闭 canonical memory、Context Orchestrator、执行账本与模型外能力门禁；宿主只转换事件、提供输入/呈现、文件/命令能力和 provider transport。

原始 source/archive、working context、durable memory、intent、policy artifact 与可重建 projection 共用身份和 provenance 基础设施，但保留各自 owner。正常路径先归档、后在硬预算内组装上下文；只把合格且强相关的记忆作为数据提供给模型，证据不足时由主 Agent 自身的工具循环有界恢复。后台完成候选提取、独立验证、记忆状态转换和索引维护；行为制品只能产生 inert proposal，不能自行发布。

先以合成数据实现和验证，再从原始 session/source fresh rebuild，并以只读 shadow、配对基准和预注册门槛决定上线。首次 live 切换是完整 context unit 的单向切换：以 durable owner/epoch/lifecycle 提交为不可取消点，之前可在互斥重验后继续或重启 MC，之后包括首个 canary 失败都只走 Euler 恢复，不保留 MC fallback、双写或旧数据兼容层。v1 以 Windows 为首个生产目标；三平台 CI 与目标宿主实测分别提供证据。

## User Stories

以下描述完整 v1 的目标，不表示全部能力同时交付；首次可用范围与后续启用条件以 I01 和 D8 为准。

1. 作为 owner，我希望长会话中的当前目标和关键决策持续可用，以便不必每轮重述任务。
2. 作为 owner，我希望能恢复原话、版本、行号与工具结果，以便摘要不足时仍能核查精确证据。
3. 作为 owner，我希望压缩失败不会导致请求越过模型上下文上限，以便故障只降低连续性而不产生非法发送。
4. 作为 owner，我希望完整工具调用及结果始终成对保留，以便模型不会看到破损的 ReAct 轨迹。
5. 作为 owner，我希望同一原文只形成稳定的一次压缩结果，以便避免递归摘要不断丢失信息。
6. 作为 owner，我希望没有强相关记忆时可以返回空，以便错误近邻不会被强行注入。
7. 作为 owner，我希望项目身份独立于当前目录，以便同一组件的源码、安装目录与相关工作不会被错误拆分或混合。
8. 作为 owner，我希望项目、可选 workspace 与个人知识按真实适用范围参与工作，以便跨项目复用不造成泄漏。
9. 作为 owner，我希望源材料、派生知识和活动规则始终可区分，以便保存一段文字不会授予它执行权限。
10. 作为 owner，我希望明确的“记住”与“同意”能连同正确上下文形成候选，以便系统记录的是我实际表达的决定。
11. 作为 owner，我希望候选由独立验证决定是否可用，以便生成者不能自报来源或自我验收。
12. 作为 owner，我希望同一对象的时间变化与不同环境的差异被区分，以便新旧事实不会被错误判为冲突或相互覆盖。
13. 作为 owner，我希望真实矛盾显式隔离并提示复验，以便模型不会悄悄择一当作事实。
14. 作为 owner，我希望低风险记忆能尽早安全启用，而高风险候选保持可见的阻塞原因，以便完整验证不变成无声积压。
15. 作为 owner，我希望任务成功、曝光次数和主观有帮助评价不直接改变事实真值，以便排序反馈不会伪造验证。
16. 作为 owner，我希望内容为真但反复产生负迁移的记忆停止注入，以便记忆保留与实际效用都能被检验。
17. 作为 owner，我希望查询本轮依据时看到实际选入的冻结 revision/source，以便查询时的 current 状态不会改写过去。
18. 作为 owner，我希望纠正前看到 canonical 原文、新正文、scope、source 与 revision，以便明确批准具体变更。
19. 作为 owner，我希望批准信号来自真实宿主输入，而不是模型的 `confirm` 字段，以便模型不能自批操作。
20. 作为 owner，我希望旧 token、过期 head、缺失 identity 或已失格的批次整次失败，且 head 返回旧值也不让旧预览复活，以便旧预览不会修改新的对象。
21. 作为 owner，我希望每个确认点都能放弃且获得真实终态，以便取消不会留下可再次提交的操作。
22. 作为 owner，我希望可恢复的 forget、restore、自动更新 rollback 与 privacy purge 明确区分，以便一般删除措辞不会升级为不可逆操作。
23. 作为 owner，我希望含糊、调查性或互相冲突的请求不打开破坏性预览，以便系统不会替我选择操作方向。
24. 作为 owner，我希望批量撤销只需一次完整预览和一次批准，以便不用逐条确认，也不会被静默缩小选择。
25. 作为 owner，我希望隐私清除报告受控闭包、不可控残留及部分完成状态；不可逆执行后失败能安全续做而不假称回滚，以便不会被误导为跨资源原子删除或介质级擦除。
26. 作为 owner，我希望每次已完成变更都有不可改写的 receipt，以便恢复、撤销和重启都不改写历史审计事实。
27. 作为 owner，我希望低风险自动更新以持久批次 Info 可发现，以便无需日常逐条审核也能回看和撤销。
28. 作为 owner，我希望 unavailable、拒绝、stale、no-op、unknown outcome 等状态分开，以便无法批准或结果未知不会被伪装为成功或未变更。
29. 作为 owner，我希望 Pi 和自研 CLI 遵守相同语义，以便更丰富的 UI 只改善体验，不改变权利和数据结果。
30. 作为 owner，我希望重启后只补齐缺失呈现而不重复 mutation，以便进程崩溃不会导致二次变更。
31. 作为 owner，我希望每次真实模型请求都能对应最终 payload 和 durable attempt 状态，以便未知发送结果不会被盲目重试。
32. 作为 owner，我希望后台模型、fallback、错误与实际使用型号可追踪，以便不能通过换模型把否定结论改成通过。
33. 作为 owner，我希望 AGENTS guidance 按实际项目与资源适用，但不能覆盖安全和当前明确指令，以便目录深度不会变成权限来源。
34. 作为 owner，我希望大量 Skill 可以按需发现，显式指定的合格 Skill 能精确绑定，以便目录大小或同名实现不会改变我的选择。
35. 作为 owner，我希望已启用 Skill 的完整指令在换窗后仍准确恢复，以便“已加载”提示不会替代真正的执行指令。
36. 作为 owner，我希望 Skill 的脚本、references 和资源按实际使用分别检查，以便激活入口不会自动授权整个包。
37. 作为 owner，我希望 MCP server 由我显式绑定、工具以确定 namespace 调用，以便模型无法指定任意服务、命令或凭据。
38. 作为 owner，我希望工具及 provider 返回始终作为不可信数据处理，以便远端角色字段不能变成 Harness 指令。
39. 作为 owner，我希望 cache 优化只降低成本，不改变内容、预算、权限或真实请求账本，以便优化不会破坏正确性。
40. 作为 owner，我希望索引可删除重建、旧 job 不覆盖新 head，以便投影故障不污染 canonical truth。
41. 作为 owner，我希望磁盘不足时先清理可重建物而不是记忆历史，以便容量压力不导致静默数据丢失。
42. 作为 owner，我希望 canonical 损坏后的恢复明确标记缺口并阻断旧 session，以便缺失 attempt 不会被当作从未发生。
43. 作为 owner，我希望跨宿主导出必须显式选择范围并校验 bundle，以便不会默认导出整库或直接信任导入内容。
44. 作为 owner，我希望平台支持有各自可复核的证据，以便三平台 CI 不被夸大成三台生产宿主已通过。
45. 作为 owner，我希望 Windows 可以在自身门槛通过后先用 Euler，以便尚无其他宿主不阻塞当前生产目标。
46. 作为 owner，我希望从原始来源重建而不是兼容旧 MC 派生状态，以便新系统不背负错误身份、旧摘要或双真值。
47. 作为 owner，我希望达到门槛后彻底退出 MC 运行时依赖，以便线上只有一套 context owner。
48. 作为实现者，我希望总规格、原始契约、验收与阶段映射可追溯，以便跨会话实现不会靠猜测补齐规则或把课程结果当生产 PASS。

## Implementation Decisions

<a id="v1-scope"></a>

### I01. 领域、权威与最小 v1

本节是首次交付与后续能力归属的唯一总范围来源；13 D8 只映射实施阶段，12 只定义相应验收子项，14 只定义模式行为。其他文档引用本节，不另行维护完整范围清单；范围变化时只同步受影响的具体契约和测试。

共享基础设施不合并语义对象：source、session archive、working context、durable memory、intent、policy artifact、projection 各有 owner。代码描述实际实现，运行证据描述特定环境下的观察，获批决策描述设计意图，用户拥有偏好/目标，archive 拥有原始对话；Git 版本、issue resolved、索引命中和模型自述都不证明实现正确。不设跨主张类型的万能权威排序或双向多主同步。

v1 聚焦 memory lifecycle 和 context 协作。AGENTS、Skill、Core tool 与 MCP 是受验证的指令/能力接入面，不拥有 canonical memory。只自动激活经门禁的 Memory 与可重建 retrieval index；行为修改仅保存/导出带版本化评估建议的 inert proposal，不实现行为评估执行或发布系统。

首次可用切片沿用 14 的自研 CLI 首接方向：Windows、自研 CLI 的交互模式、一个显式绑定 project/session、一条经验证并固定配置的 provider/model 路径。闭环包含 durable source、最小 intent、低风险 memory 验证与检索、预算/换窗/恢复、实际请求 ledger、inspect/correct/forget/restore/自动更新 rollback、持久 Info，以及维护模式 purge、backup 和故障恢复。无强命中允许空；少量 owner-confirmed bootstrap 即可，不要求全历史重建。额外模型/provider、自动跨 scope 晋升不作为该切片前置。

Pi regular、RPC/JSON/print、MCP、scope overview/raw backfill、bundle 和其他平台生产支持按独立能力切片后续启用；双宿主仍共享同一 Core 和语义，但不要求同步交付。未启用的入口必须实际 unavailable，不能默认直通；不得借切片名义跳过已经启用的数据路径所需的 approval、durability、purge、恢复或 D7 门禁。小型本地 AGENTS/Skill 与固定 Host 工具先满足当前任务，目录规模优化留到出现需求后。各切片的直接依赖和 X-card 子项见 D8，不新建 capability registry。

### I02. 运行时与依赖

产品名 Euler，稳定 app-id 为 `euler`。采用一份共享 TypeScript Core，三个 private workspace 的职责分别为共享 Core、Pi adapter、自研 CLI；store 是 Core 内部模块，不拆独立包。

Control Plane、Context Orchestrator、memory/source gate、ledger、capability/credential/tool dispatch 与后台状态机封闭在 Core。Pi adapter 通过 13 的受控 SDK bootstrap 复用 `Agent`/`AgentSession`、UI/tool loop、session/source surface；Euler 独占内容选择/compaction，最终发送经受控 transport。加载前只接受 hash 固定的 Euler adapter，user/project/package/CLI/inline 的额外 extension 不进入该进程，重载和 session 替换也重验；loader/settings/实际 hook 与 wrapper 集合记录到 runtime receipt。自研 CLI 只依赖 `@earendil-works/pi-ai` 的 provider/model 接口，自有 Agent loop 和 TUI，不依赖 Pi Agent/TUI 实现。两个宿主通过 versioned 进程内 Core/HostAdapter 接口合作，不互调远程 API，不直接访问私有 canonical 表。不建 daemon、IPC、通用插件 bus 或任意同进程 JS/TS 热加载。

### I03. 持久化、数据根与 schema 冻结

每宿主、每 OS user、每 app-id 一份本地 Node 24 `node:sqlite` canonical store；连接统一 WAL、`synchronous=FULL`、foreign keys 与有界 busy timeout，短事务加 CAS/短租约协调跨进程。不跨宿主共享 SQLite 文件，不把 cwd/Git root 当 project identity。数据根、代码位置和包名的已定映射见 Further Notes。

高频过滤和不变量用类型化列、约束与外键；JSON 仅用于版本化校验后、不参与核心门禁的 metadata。首次切片的表族包含 identity/control（含 `intent_events`/`intent_heads`）、memory revision/event/head、ownership/evidence、显式 owner 的 execution streams、projection outbox/leases、search、Host presentation/pending，以及 content-free purge receipts 和维护模式所需的 owner fence/进程登记。scope-review watermark/cursor、scope-only `projection_artifacts`/typed input refs 在该能力启用前增加；未启用能力不预建空表。真实 owner mutation receipt 与 canonical 变更同事务追加在 memory events；Host operation state 不是第二份 receipt 真值，也不写入 execution events；已结算 purge 的最小 cleanup continuation 复用 pending_operations，不等于等待批准的 pending，完成前按隐私边界清除其敏感字段。Storage-owned identity、append-only 与完整 payload digest 由存储层强制：调用方不得原地改写 canonical row/revision/event、伪造行 identity 或只对 ID 重算 receipt/manifest digest；10 §28b 的数据库后置条件失败时事务回滚且外部删除次数必须为 0。

首次切片实际使用的全部表族、不变量、Host receipt、backup/维护 purge 与失败恢复门槛通过前，只用合成可删除数据库；后续未启用能力不阻塞首次真实数据许可。P0 固定外部契约、身份与事务语义，DDL 在 disposable 阶段随正常路径/故障测试调整，不为试验性改列编写兼容迁移。首次真实数据前才正式冻结初始 DDL、版本、SHA-256 和实现 commit；此后初始迁移不可改写，只前进迁移，迁移前有恢复点、失败保留旧库、未知更高版本拒开。后续能力需先完成增量 schema、清除/恢复与相应验收才能启用。P0 或 P1 通过均不单独授权真实 memory/ledger 写入。

v1 不加正文加密或 SQLCipher；依赖本地用户权限、秘密禁止进入 memory、隐私清除与备份保护。凭据由宿主 credential 机制管理，不写 memory、source receipt 或产品数据根；该威胁模型不承诺抵抗能读取当前用户磁盘的攻击者。

### I04. Memory identity、scope 与状态

各操作的前置、验证与 lifecycle 结果、事件/head/outbox 的原子关系按 08 的 `Canonical transition contract for implementation` 实现；P1 验存储/重建，P2 验语义证据，不从合法枚举的任意组合推导操作许可。

内容类型为 `fact/preference/decision/insight/episode`；hypothesis 是未验证状态而非第六种类型。`lifecycle=candidate|active|superseded|rejected|tombstoned` 与 `verification=unverified|verified|conflicted|stale` 正交。首次 activation rollback 的 canonical 结果是无 active head；`inactive` 只能是 Host/Info projection 的历史显示标签，不是 canonical lifecycle、检索资格或写入 gate 状态。记录粒度是能独立验证/失效的最小语义单元，不按句子机械切分或保存整页 Wiki。

scope 为 logical project、可选扁平 workspace、personal；每 project 最多一个 workspace，membership 必须显式。`applies_to` 独立表达 agent/platform/component 条件。Project 由 intent、manifest、真实 resource owner 解析；未明确时保留 session-local unresolved candidate，不因路径推断 durable scope。跨 scope 泛化创建带 derived-from 的新版本，不原地扩大旧 scope。

标准 UUID 为外部稳定 ID，本地 stream 使用连续 seq/唯一约束；跨宿主保留 event ID、origin host/seq，不用机器时间作全局最新胜者。Revision 正文与 event 不原地改写，事务更新可重建 current head；每次 head/资格字段变化都以已有新 event 的 ID 更新 `head_event_id`，无 active head 也保留最后变更身份。Rollback 恢复旧 revision 与业务字段，但 head_event_id 指向新 revocation，不回到旧身份；纯曝光/no-op 不改变它。所有 mutation preview/CAS 比较完整 snapshot 与当次 head_event_id，既不额外建版本计数器，也不因恢复同样正文而新建 revision。仅保存必要 provenance、conflict、supersession 与 scope 关系，不引入通用图或主题 taxonomy。

### I05. Capture、模型职责与 cooperative worker

原始事件先同步归档。完整 ReAct、明确 owner 决定/记住、compartment 或任务完成边界创建 capture job；“同意”与其指向的方案作为同一 source range。确定性事实由代码形成候选，语义内容由后台 Proposer 起草；主 Agent 只能给 hint。Harness 固定 source identity/hash、scope、owner、真实调用链，模型不能自报这些字段。秘密、临时任务/notes、原始日志与活动指令不包装成普通 memory。所有自动 capture 先固定为 `lifecycle=candidate + verification=unverified`；logical project 未确定时只进入当前 session 的 unresolved candidate queue，跨会话检索与 active 注入均为 0。只有 intent、真实 resource owner 或 manifest 确认 project 后，才进入对应 scope 的验证管线；scope、source 或 integrity 不足时保持 candidate/evidence-gap 并记录阻塞原因。

Proposer/Historian 推荐标准级，Historian 还需长上下文和忠实压缩；Verifier 按风险选能力，低风险允许同模型隔离上下文，高影响/跨 scope/安全候选增加不同模型、真实工具/平台、held-out/canary 或人工。Provider/model 可配置，无型号白名单；低于所需能力只能停留 candidate/evidence-gap。模型能力、reasoning effort 与编排拓扑不等同。行为制品只保存版本化 inert proposal：target/type、expected change、owner/scope、evidence refs、risk 和建议的 evaluation contract；正文与完整 digest 不可原地改写，修订创建新 proposal 引用旧版，引用进入 purge 闭包。评估建议可描述 L0–L3、assertions、baseline/held-out 和成本限制，但它不是执行许可或已完成的结果。v1 不建 sealed plan、evaluation attempt/result 表族、不执行行为评估或自动发布；外部附带的 accepted/result 也不能激活行为。未来有评估/发布消费者时再定义执行、独立验收和迁移，memory 自身的 verification_runs 不受此收敛影响。

Primary/fallback 只处理暂时不可用、超时、限流、协议或结构化输出失败，不覆盖 integrity FAIL、语义 block 或 evidence-gap。每个实际调用记录 requested/actual provider/model、role/job、版本可得性、fallback ordinal、配置/输入/输出/schema/hash、起止、usage/cache 与终态；未知字段明确 unknown，不记录秘密正文。

Worker 在启动、canonical 写入后、agent_end/空闲和显式 maintenance 时 cooperative drain，短租约、有界 batch/deadline、按 owner revision/input hash/generation 幂等。重启可接管过期 lease，但不得重复 mutation/receipt；未知 attempt 先查询，不盲目重复。明确否定只能在 source 变化或显式维护后重新验证；重复失败有 blocked 原因。后台不阻塞普通响应关键路径。

正常 capture 的原始事件须先 durable，按 source identity 幂等补 job，缺 ack 不卸载或 dispatch。Scope-review/backfill 的 inventory、连续水位与批次 handoff 在对应后续切片启用前落实；正文使用 10 的 SQLite 投影事务，不存在 overview file publish/pin/repair 协议。这些后续设施不作为首次 P0/P1 的隐含门禁。

后续启用跨会话整体分析时，复用 maintenance/projection worker 的 `scope-review` job，先限当前 project 的增量和受影响有限邻域，不每轮重读全部 archive。身份/来源检查是确定性的，但语义替代或矛盾仍需独立 verification，不能凭“deterministic”名义定案。同义摘要不直接晋升；跨 scope 关系与 raw-backfill 另按实际需求启用，单次 source recovery 和少量原始来源重建不依赖全量历史设施。

`scope_overview` 是后续启用的可重建投影，不是真实 memory、instruction、policy 或权限。其有界正文直接保存在 SQLite `projection_artifacts`，与 input refs、generation、状态及 cursor 同事务提交，不发布外部文件，不建 publish operation/pin/GC/repair 表族。只总结当前 eligible 决策、约束、变化及有来源的未决状态；逐条保留 owner/scope/resource/`applies_to`、membership、source/revision refs、digest 和 verifier 状态。Orchestrator 只读 fresh 且当前依赖合格的版本；缺失、损坏或过期时走 retrieval/source recovery。重建产生新 artifact identity/generation/hash，不要求 LLM 复现旧字节，也不回写历史 assembly；仍被 receipt 引用的合格旧正文保留为历史证据但不作 current 注入，purge 除外。后续能力未启用时不启动 review worker、不预建空表。

### I06. Verification、时间归一、反馈与记忆回滚

I06 的前置顺序固定为：先由 Harness 检查 immutable locator/hash、provenance、scope/owner、receipt schema 和目标覆盖，再把通过 integrity gate 的 claim 交给语义 Verifier；失败不交给模型猜测。语义 Verifier 使用独立上下文，自行 source search/expand，不只看 Proposer 挑选证据；输出仅 `pass/block/evidence-gap`、evidence refs/hash。仅 Harness 移动状态。

比较记录前规范化 subject/resource、host/environment/component、scope/applies-to、observed-at、validity 与 source owner。不同环境并存，不重叠有效期形成 temporal supersession；同对象、重叠有效期且可信互斥才双方 conflicted。重放 no-op，同 claim 新证据追加 provenance，语义相似只形成待验证候选，不自动合并。

最窄 scope 先满足最低充分证据再激活。v1 实现明确 owner/结构化事实的快速通道与普通 project 通道；高风险与跨 scope 保持额外门禁，完整自动广域 canary 不是首次可用前置。候选必须有阶段、原因和重试/升级路径，不能无声 pending。Memory 验证按类型/风险取最低充分证据；行为 proposal 的 L0–L3 仅描述建议评估深度：L0 source/hash/scope/schema，L1 触发与首个关键选择，L2 checkpoint 对照，L3 held-out/越界负例/canary。v1 不运行这套行为评估；任何评估建议或外部结果都不授权发布。未来消费者启用前再冻结其执行契约，不由 fallback 把否定变通过。

retrieved、injected、source revalidated、task outcome、owner feedback 与 canary outcome 分开；injected 从 canonical assembly 推导。曝光与普通任务结果仅影响 salience/复验，不定义真值。强 owner/source/safety 或可归因 canary 信号才回滚；previous 仍须当前 eligible，否则没有 active 结论。真实但负迁移的内容可为 verified + rejected(negative_transfer)，不混成“事实为假”。无统一 TTL；按 validity/source/time/feedback 维护，不每晚用 LLM 重审全库。

### I07. Retrieval 与可重建投影

先硬过滤 logical scope、active project set、applies-to、lifecycle/verification、时间有效性及 integrity，再按当前请求/intent 检索、简单可复算融合与 claim/environment/time 去重，在预算内覆盖任务子项。不用可信度/相似度/时效总分抵消资格失败，不为固定 top-k 注入弱命中。

v1 使用一份非权威 search-documents + external-content FTS5，版本化 Latin/数字规范化和 CJK overlapping 2-gram；canonical 正文不改写，不建 embedding 表。单字 fallback 由 held-out 决定，纯同义无强 lexical 证据可返回空/慢路径。未来向量或图只有真实漏召回/多跳需求与实验胜出后再考虑。

Memory 与 owner 明确发布的有界 session/source/repo units 分 lane；不默认复制全库/整仓库。每个命中回 canonical owner 重验。active verified current 有正常搜索投影；stale/conflicted 仅 status-only，superseded/rejected/tombstoned 不正常召回。canonical 事务只追加 outbox，worker 重新读 current head 并按 revision/hash/seq/generation 条件更新；旧 job 不覆盖新 revision，重复 delivery 幂等。

跨会话的 `scope_overview` 是可选的有界 baseline，不替代 canonical retrieval。只有用户要求项目全貌/规划、当前请求需要跨主题关系，或 retrieval 暴露 evidence-gap 时才读取适用 overview；它必须带 input generation、source/memory refs digest 和 content hash。overview 过期、冲突、purge、cursor gap 或 verifier 未完成时只返回状态标记或触发局部 review/source recovery，不把旧摘要当事实注入。

新 verified head 可由 pinned delta 或有界 canonical scan 补暂时索引延迟。超 backlog、hash 失配或索引损坏时标 dirty/rebuilding/failed，停止使用旧投影并重建，不回滚 canonical truth，不伪装成最新结果。

### I08. Context admission 与有界恢复

唯一、确定性的 Context Orchestrator 拥有最终 prompt 与预算；其他职责只提供候选。Control Plane 自持 07 §4 的最小 versioned active intent，载体为同库分域的 `intent_events`/`intent_heads`，公开 API 为 `readIntent`、`transitionIntent(expected_event_id, input_ref, proposed_transition)` 与 `recoverIntent`。最小 snapshot 至少含 intent/session/branch identity、current event/version、目标与硬约束、经 owner/resource gate 确认的 scope、当前步骤、active/paused/completed/needs-input 状态，以及有界正文和 input locator/hash。Pi/CLI 经同一 API 读取，不依赖外部 todo/task/wayfinder 是否安装。外部状态仅作输入/投影，不新建通用任务系统，不从摘要反推目标。新任务先 durable 原输入；目标/约束/权限扩大需真实授权，模型步骤变更经 Alignment Gate。每个 transition 绑定 input identity 与 expected event，同事务追加事件/移动 head，重放幂等、冲突 stale、unknown 先查；未明确换任务保留原目标，分支不倒拨同一版本。缺失/损坏/来源被清除时 needs-input/unavailable，相关行动暂停；外部 todo 离线不抹掉有效本地 intent。Assembly 冻结 intent event/hash，dispatch 重验版本和状态，变化则重组；后台用已批准 job goal/scope，不借无关前台 intent。普通快路径先归档，获取缓存 intent、预生成 compartment/tail 和有 deadline 的本地检索，再只调用一次主 LLM；失败的可选后台工作不增加 router/RAG Agent。

每次调用强制 `mandatory + selected + output_reserve + safety_margin <= context_limit`。活动 policy、当前用户输入、最小 intent、需要的核心工具契约、完整最近 ReAct 边界与输出预算为硬保留项。不得按消息条数拆 tool pair；mandatory 自身超窗则明确拒发或拆任务。

这不代替累计运行预算：每个前台 run 在首次 attempt 前固定可配置的 model-attempt/tool-call 上限、累计 token 或成本上限、wall-clock deadline 和工具超时；source recovery/重试计入同一 run，换窗不重置。达到限制或用户取消后停止新增调用，返回可见原因；已发请求按 ledger 结算，迟到结果不得自动执行工具或提交 memory。参数先有合成测试初值，再用 workload 校准；缺必需预算不启动，不为调参增加通用调度系统。恢复继续须新授权和新 run，不抹掉旧用量或 unknown。

原文可恢复是卸载前置。按弱相关/近重复/可重建、非 pinned memory/source、已准备 compartment 的完整边界、已归档单条的分页/分块逐级降级；未归档成功、当前行动马上需要精确值或 hash 失败的内容不得卸载。Source Recovery 仅按明确原话/版本/证据需求、精确 provenance，或主 Agent 判断证据不足进入慢路径；返回带 immutable locator/hash 的有界非指令 excerpt。失败显式 evidence-gap，不能拿摘要冒充原文。

Scope overview 若作为 P1 baseline 被选入 assembly，assembly 必须冻结 overview artifact identity、input generation、refs digest 和 content hash；generation 或任一引用变化就新建 assembly。overview 只能帮助 Orchestrator 获得项目全局结构，不能绕过 memory eligibility、source recovery、intent、policy、capability 或 approval gate。

### I09. Archive、compartment 与 window

Source/archive 通过既有 versioned HostAdapter 绑定真实 owner、host/session、scope、受控根与 immutable locator/hash。P0 须冻结实际持久载体、API 与 append/read/expand/retention/purge 契约，不另建 source 子系统或表族。Append 只有真实 durable flush 后才给可重启复读的 acknowledgement；同 event identity+bytes 幂等、异内容冲突，unknown 先按 identity 查证。缺 ack 时 dependent capture job、原文卸载和依赖该输入的 dispatch 为 0；Pi 首轮未 flush 的 entry 不算 ack，不能靠先发请求绕过。Archive 已落而 job 未落时可按 identity 补 job，反向缺 archive 则阻断。Read/expand 有 scope/hash/offset/limit 与完整范围/截断信息，失败不拿新版本或摘要替代；purge 使用原 owner 的隔离、manifest/实际 identity 和 durable 删除 ack，缺证不能签完成。

Pi 的既有边界内候选见 13 的 `Pi P0 public-API probe boundary`：live runtime 前排他准备同一正常 Pi JSONL，经公开 open/append 后由 HostAdapter 对真实文件 fsync、严格复读再签 ack；Pi flushed/内存 leaf 不作证据，不伪造 assistant、不换 source owner。初始化与各次 new/resume/fork/reload 保留正确 header/id/完整 entries，已绑定文件丢失或损坏不当新建；P0 冻结 stable raw-event/native entry 映射、幂等及 unknown 查证，原公开同步返回语义不变。X-04/X-11 验首轮正常成功和失败/恢复，真实文件/目录 durability 仍按宿主验证；不改变 14 的批准权威。

每段 eligible raw source 只从原文生成一次稳定 compartment，保留决策、结果、引用、适用边界、range/hash/model attempt/locator；不对摘要递归有损压缩。大小/任务边界提前生成，token 压力正常切换，force/emergency 兜底；只在完整 ReAct/任务边界提交。Historian 失败保留 raw，不落残缺摘要。

有完整 archive 和可验证恢复入口时，可开启不生成新摘要的 fresh window。Euler window identity、cache epoch、assembly ID、attempt ID 和 provider opaque handle 是不同对象；window 切换有 durable lifecycle event，重建有界 baseline。外部 history/notes 或 model catalog 不成为 Euler authority，能力/route/auth/strategy 在 session/epoch 快照，未有资格和恢复证据不静默启用。

### I10. Prompt/cache 与最终 transport

Prompt 四区为 provider-stable P0 policy/tool、epoch-frozen P1 baseline/compartment/pinned memory、按序追加的 P2 完整轨迹、P3 当前输入及有界 retrieval/intent/status。物理位置不改变权威。P0/P1 在同一 epoch 字节稳定，动态 tail 在完整 ReAct turn 内冻结，后续用户轮可替换短尾；不回写旧工具结果。

P3-only、正常 P2 append、相同 payload retry、cache miss/TTL 到期及尚未选入 baseline 的 compartment 不自动换 epoch。P0/P1、已选 compartment/pinned memory、活动指令/tool schema、估计器/strategy 或缓存 namespace 变化需要新 epoch；provider/route/model/auth namespace 变化默认新 epoch。fresh window 仅在字节及 namespace 完全一致且 provider contract 允许时沿用 epoch。安全/权限/scope/policy/已确认 supersession 立即使旧 epoch 对后续 dispatch 失效；先 durable invalidation，再新 assembly，失败禁发。

Core 冻结 provider-neutral assembly，adapter 只做允许的 wire conversion；最终 payload 冻结后记录 encoding/hash algorithm/adapter version，durable started 后才网络发送，后续可变 hook 不得改写。Pi 原生 auto-compaction、manual/overflow/tree 摘要入口关闭或委托 Euler；原生 agent/provider retry 不另行发请求，每个真实发送仍经 Core。普通 `before_provider_request` 可吞异常，不能是唯一 fail-closed gate：adapter 在 `session.agent.streamFunction` 掌握受控发送链，具体 provider onPayload 的 await/错误传播/无后续改写须 P0 实证，不满足即受控 transport 或 unavailable。内建工具禁用后用 Core wrapper 提供批准集合；直接命令、shell、导航、RPC/export/share 同受 gate，不支持拦截即 unavailable。Pi 的新建/恢复/reload 不得绕过加载前 allowlist 或复活原生设置。pi-cache-optimizer 在 MC-active 不受影响，Euler-active 不加载该额外 extension；只读指标由 Euler transport 提供。可信 Pi/adapter 是计算边界，hash 标识版本，不是恶意同进程代码的沙箱或签名体系。

P0 输入接点亦按 13 的公开 API 边界：在原 Pi regular 界面冻结公开接点和 synthetic 探针，完整 Euler 主流程仍在 P3 按 X-10/X-11 验收；通过公开 EditorComponent 的受控 delegation、实际 action/selector callback 和 session/runtime 对象 wrapper 接 Core；factory 后的 callback/Map 覆盖、void 回调的异步 gate 与各次重绑须实测。未接入的附加入口在实际副作用前 unavailable；fullscreen 的早期鼠标路径、模式切换、RPC/JSON 各自有 gate，不能从单个 editor/raw hook 推断全模式支持。保持原 Pi 界面和 14 主操作合同，不以全部禁用主流程代替通过，不新增 private mode patch 或另一个 TUI。

### I11. Execution ledger 与恢复

execution ledger 为 Host-owned 独立 append-only stream，与 memory 同库不同 domain；stream 固定 `owner_kind=session|job|maintenance|migration`、owner ID、已验证 scope 和授权来源。前台归 session，后台模型调用归实际 durable job，无子 job 的维护/迁移请求归该 run；originating session 仅关联，不是无 session 时伪造的 owner。每次 attempt 恰属一 stream，进程接管不改 owner 或重发 unknown。普通 job 只回收可重建 payload，被引用的最小 job owner/scope 行及账本仍保留，来源 session purge 清除跨 stream 引用/授权并阻断依赖 job，不误删无关 owner；整条 owning stream 的显式 purge 按 10 §11 结算必要无内容状态，不能由账本消失推断可重发。surface history 是投影，receipt 为 log-only，不进入模型上下文。assembly receipt 记录 intent/project/policy/selection/ref/hash/order/token/reason、P0-P3 预算与降级；每个真实 transport attempt 有 started/finished、最终 route/model/payload、TTFT/usage/cache/finish/error/cancel。

两道有序但非原子的 barrier 为 assembly append+flush，随后冻结 payload 并 started append+flush，最后网络调用。任一失败 dispatch=0。完整 assembly 的非 attempt 内容、顺序、route、预算、epoch 等改变即新 assembly ID；只有同一完整 payload 的合法重试增加 attempt ordinal。

本地 admission 的线性化点是 started 事务：重验 intent/head、授权快照、owner/fence/epoch，并登记 attempt 与 activity，必须同一短事务完成。先提交的撤销使旧 attempt 不得 admission；后提交的撤销把已 admission 的 attempt 视为 in-flight，transport 在实际发送前再检查可观察取消并停止尚未发送者，但不能保证收回已经发出的字节。外部文件/权限按已验证 Host 接点重验，不宣称 SQLite 能与外部网络原子提交。X-06 必须覆盖这两个顺序及正常发送。

assembly/no-started 为 not-dispatched；started/no-finished 为 orphaned/unknown-sent，不能自动重发。选择、顺序、预算与 refs 必须在 store 完整时可复算；privacy purge 是授权破坏性例外，保留无内容 envelope/状态并标不可完整复算。Canonical 损坏是完整性失败，不是该例外；恢复 gap 规则见 I19。

恢复入口复用 Host 的维护操作，不新增模型工具：可查 provider/operation owner 时追加对账证据；不可查时展示 unknown、潜在重复费用/副作用及关联 run，owner 可明确封存旧 run。封存不把 unknown 改写成未发送/成功。需要重新工作时创建关联旧记录的新 run/operation，并重新检查授权、预算及资源现状；非幂等副作用须先对账或由 owner 明确承担重复风险，不能通过新 session 或自动续跑绕过阻断。

### I12. AGENTS 与 guidance

Global、Workspace、Project 为逻辑层，Resource 是 Project 内适用子树而不是第四个 scope。按真实 active project/membership/目标 resource 解析 guidance，不按共同父目录猜 workspace，不跨项目传播。默认仅支持 AGENTS；可选文件不存在正常，应生效但不可读、scope 不明、完整性不足或预算不足不能静默忽略。

Core policy 是受保护 channel，AGENTS 为独立 P0 guidance，带 owner/scope/locator/version/hash snapshot。普通 guidance 对同一目标取最具体适用范围，其他宽层规则继续有效，当前明确用户指令优先；安全、capability、credential、scope、审批不能因此放宽。不同项目规则可按资源分开遵守；同一操作不可同时满足时 instruction-conflict，阻断受影响副作用并由 owner 裁决，不新增通用自然语言规则解析器或 LLM 裁决器。

每次相关 session/window/resource/dispatch 前确认适用关系及版本；watcher 仅提示。改变生成新 snapshot/assembly/epoch，不热改正在发送的请求，也不自动改 AGENTS。

### I13. Skill discovery 与生命周期

完整 metadata catalog 留在上下文外，先资格过滤，小目录可全列，大目录给有界候选与可继续发现入口；部分目录不冒充完整，搜索失败不冒充无结果。显式引用精确绑定，仍受 owner/scope/trust/enabled/hash 门禁。默认同一目标 Project > Workspace > Global，同 scope 固定来源顺序；同 owner/resource 别名先去重，不因正文相同合并权限。选中来源失败不静默换同名实现。

遵循标准 SKILL.md 元数据，不要求 Euler 专用 frontmatter。精确 skill-ref 绑定 scope、source/entry locator 与 hash，不是手工别名；hash 不替代信任或整包资源检查。已批准来源的完整正文原样进入独立 P0 Skill guidance，预算不够则 skill-unavailable，不截半份；references 按需独立定位，脚本/assets 不因激活而执行。

绑定复用既有 task/intent 与 instruction snapshot；同任务、同 scope/hash 不反复读正文，暂未调用或仍适用的换文件不释放。任务结束、明确停用、scope/权限/信任失效才从下一 assembly 移除；换窗重新校验并装入准确正文，不靠“已加载”状态恢复。v1 无 Skill 专用版本表、包历史、市场、自动安装/升级/回滚管理器；必要状态复用 P3，不建设完整状态栏。

多个已选且合格的不同 Skill 对同一副作用提出已明确识别、无法同时满足的直接约束时，必须暴露 `skill-conflict` 并停止相关副作用；不按加载顺序静默择一或停用另一份，不增加额外 LLM 裁决器或通用自然语言冲突解析器。相容约束及适用于不同操作的对照不得被误判为此冲突；owner 明确解除冲突后，经新 instruction snapshot/assembly 和原 Core gate 重验，合法操作可恢复。X-05 明确验证冲突终态、相关副作用为 0 及正常对照，X-10 复验真实 adapter；仅证明两份正文加载成功不算该项验收。

### I14. Core/Host tools 与 MCP

八个固定 Core 模型工具为 `skill.search`、`memory.search`、`source.search`、`source.expand`、`memory.inspect`、`memory.preview`、`memory.commit`、`memory.cancel`。Memory mutation 的模型入口只有 inspect→preview→owner approval→commit，不提供通用 write/delete/update/set。Schema 由源码中的 tool-name/version/hash 标识，外部可见变更生成新 identity/assembly/epoch，不建通用 registry 或 DB tool-version 表。

每次 tool call 重新检查 policy、capability、credential、scope、参数、实际 resource owner、批准与 receipt。文件/命令/交互由 HostAdapter 提供，不能绕过 Core；不可用显式返回 unavailable。Tool schema、AGENTS、Skill allowed-tools、memory/source 与模型自述都不能授权。

文件工具的 root/file identity 检查不等于任意 shell/脚本的运行隔离。首次切片默认不向模型开放未隔离 shell/任意脚本；需要时 owner 可在 Host 以高权限维护动作明确批准具体命令、cwd 和真实权限范围，该动作不冒充受 root 限制的模型工具，也不能作为 Core 隔离 PASS。后续向模型开放执行能力，须明确其文件/网络/子进程及产品数据根保护边界并用真实执行环境验收；可复用现成隔离机制，不预设自研沙箱。批准 Skill 不自动批准脚本。若无法限制实际进程，就明确为高权限、逐次 owner 批准，不宣称参数 gate 约束了脚本内部行为。

MCP server 由 owner 显式绑定 scope、transport/command-or-URL、credential reference、enabled 与 policy，模型不能创建绑定或指定任意 endpoint。tools/list 返回的 metadata/schema 不可信，先做大小、深度、字段/类型校验；变更通知只刷新目录。小目录注入合格 namespaced schema，大目录经 MCP adapter-owned `mcp.search@v1` 发现，准确固定 discovery schema 经 Core admission 进入 P0 宿主能力块，和八个 Core schema 分开计数。它只查询合格绑定目录，不接受任意 endpoint、不直接调用 server 工具，目录刷新另走受控 tools/list。Schema/version/hash/注入及目录 snapshot、cursor 和结果 hash 纳入实际 tool-call archive 与 assembly/attempt；变化按 tool identity 换 assembly/epoch。未启用/不可用显式说明，错误不报空，名称保留不能被 server 覆盖。选定 ref 后下一 assembly 注入准确目标 schema，不增加通用 mcp.call。Namespace 确定性编码并记录映射，Core/Host 名称不可覆盖；调用绑定明确 server，歧义或必需工具不可用时阻断，不静默换同名服务。MCP resources/prompts 不自动注入，输出不能注册工具、授予权限或直接写 canonical memory。

### I15. Host 呈现、批准与 pending

四个薄 adapter 操作为 presentCanonical、requestApproval、persistOwnerEntry、emitModelSummary；Core 拥有 identity、CAS、pending 结算与模型工具终态。每个有输入通道的宿主提供不经模型的入口，并复用同一流程。

可操作预览在 Host-owned durable store 中有唯一 presentation record 和 opaque token，冻结目标、expected head/lifecycle/`head_event_id`、originating inspect/notice、batch/event manifest/digest；不能由模型逐字段声明或从当前 pending 补齐。先 durable 完整 canonical presentation 并完成宿主输出，再接收绑定 token 的真实批准；可分页但不能让 owner 批准未提供的正文。旧卡复用还须完整 snapshot/membership 一致且宿主侧呈现可由已有句柄和落盘确认核验，否则完整重显。

批准只来自同一阻塞 Host 输入，或 presentation 之后的真实活 user-turn。Pi 必须当场检查 live input source，extension 注入不授权，不回扫 session 重建 provenance；同进程恶意 extension 不在该信任保证之内。批准 dialog 不传 timeout，不与 turn abort 共用 signal；abort、无应答或被顶掉是 unavailable，未 abort 的明确否定才 rejected。Correct 必须从实际文本输入取得新正文，confirm-only 不足。

每 session 只有一个 durable pending，不设 TTL。新 preview supersede 旧 pending，并且新的 durable presentation 必须明确指出被作废的旧 operation ID；另有明确 cancel、commit 成功或 stale/failure 为其结算路径。提交原子比较全部冻结 snapshot、head_event_id、event/manifest，跨 session 竞争由 CAS 处理；不自动重读、缩小选择或重试。过期、未知、歧义与 settled token 有各自终态。

### I16. 看、改、退与终态

Inspect 本轮依据从 assembly.used 冻结的 memory/source snapshot 唯一定位并重算完整 SHA-256，不用 current head 替换过去；缺 source/hash 或未选入即报缺。

Correct 对已 tombstoned 目标的 preview 返回 `not_actionable`/reason=`tombstoned-not-actionable`，不创建 pending/revision/receipt，须先独立 restore；valid preview 后被 forget 的 commit 返回 stale。合格目标展示 before/实际提交的 after/diff；缺新正文 fail closed，空或规范化相同为 no-op，不签 receipt。Forget 是可恢复 tombstone，restore 独立批准并经当前资格/CAS。08 §19a 的抑制键基于 memory owner/scope/applies-to、规范 subject/claim、source owner/lineage，冻结版本/raw hash 作证据；新 capture ID、别名或同 lineage 同 claim 新版本不自动复活，语义/来源歧义 evidence-gap。独立新事实重新验证，不按全局正文 hash 封禁；显式 restore 解除该 record 抑制后才继续 correct，purge 清除抑制指纹而不留永久黑名单。Rollback 只针对自动 revision/activation，不撤 owner 手动 correction；以冻结 before/after、完整 head/CAS 和当前 eligibility 控制恢复，不改写原 update event，新增撤销事件和自己的 receipt。Rollback 恢复旧正文 revision 与业务字段，追加新 revocation/receipt，并把 head_event_id 指向新事件。历史 before/after 业务资格与本次预览冻结的当前事件身份分别比较；因此旧预览在 `r3→r4→r3` 后仍 stale，但撤销 B 后新建预览仍可按资格撤销 A，不将当前事件身份强求等于历史 update event ID。

调查、否定、取消、correction envelope 和普通删除/恢复语义不混同。默认删除就低为 forget；只有明确不可逆请求进入 purge。删除动词、未被否定的不可逆标记与标记外恢复/撤销方向同时存在时，确定性 conflict，不创建 preview/pending/mutation；其余开放语言不确定返回 not_actionable/要求重述，不能走相反或更破坏方向。生产接线用真实模型结构化 tool intent，加 Host 对 originating input 的模型外重验，不把 prototype 正则当分类器。

合法终态沿用 Ticket 14：committed、rejected/cancelled、unavailable、superseded、invalid_identity、settled、stale、no_op、not_actionable、conflict、error；pending 是非终态。具体操作的允许集合不可互换，error 必须带已知或 unknown outcome；Agent 叙述不是成功证据。

### I17. 批次、通知与两个呈现面

低风险自动 active 更新与 batch_id、完整有序 event manifest/digest、`projection_jobs(kind=host-info)` 同一事务提交（08 §27a），不留 activation 后崩溃却没有可发现记录的空档。每个有界 batch 不跨 owner/scope、不重复 target，响应末尾可合并通知但不追加已冻结成员；consumer 以稳定 batch 幂等持久化 Host manifest/unread，再补真实投递。无 active session 保持 owner 可查询的待投递批次，重启从 event/outbox 对账，不按 current active 重新圈选、重做 activation 或把已读置未读。低风险更新不逐条打断；candidate、未晋升、rejected 不进入正常注入。Warning/Error 按风险与真实结果可见，不能用数量阈值隐藏已启用变更。Unread 由 Host 状态保存，明确查询或可核验 open/expand 在完整 batch presentation durable 后结算。

Batch identity 与完整有序 event manifest 稳定，每次新卡有独立 presentation identity/token，selection 仅属于该实例。Rollback 选择绑定同批次 eligible event，而非仅 target ID；完整 before/after 含正文、revision、verification、lifecycle、scope、source。任一已选 event 缺失、变形、重复 target、payload/head 变化或失格，整次 fail closed，不能静默缩小；成功撤销导致自身 event 失格的豁免只属于发起卡的实际成员，不传播给其他卡。空批次不签 receipt，purge 后仅真实被清除的批次可显示 redacted 终态。

模型面只收有界变更摘要以停用旧值；owner 面持久保存不可改写 receipt/终态，不进入 LLM context。跨调用 preview 在 Pi 中进入模型 surface 是已知代价，不能以结果摘要代替完整预览。Canonical mutation 与 receipt 同事务，owner entry/model summary 按 receipt ID 补齐；呈现失败不回滚已提交 mutation，不改写 receipt，下一 dispatch 前恢复缺失面。Unknown outcome 先查 canonical，不盲重试。旧卡从创建时使用永真措辞，后续结算追加配对终态，不以隐藏按钮代替 gate。

### I18. 隐私清除

首版 purge 只在维护模式执行。正常 Host 可解释请求和停止运行的影响，不先批准在线删除；独立维护入口关闭 admission、证明旧 runtime 及其受控子任务退出并取得维护独占后，才从实际状态完整展示 manifest/受控范围/外部残留/不可恢复后果，铸新 token/nonce 并取得一次批准。只接受同一真实活输入中的精确口令，先过冲突/取消 gate，不接受泛化确认、旧 session token 或 extension 注入。

清除包含正文、候选、provenance locator/hash、验证/反馈/proposal payload、搜索/缓存/文件投影、受影响 execution manifest/hash/reverse refs、presentation/pending、session/source 与受控备份。按结构化字段和完整 identity 做 cycle-safe fixpoint，覆盖键和值，不用全文 substring，不漏残缺副本。数据库内与外部清理的边界以 10 §23 为准，不能把全部载体当同一事务。

10 §23a 使用 `owner_fences`/`owner_activities` 做启动 admission、进程/root/epoch 登记与维护独占，不要求首版逐次登记所有内容读取或 UI 缓存。检查 open 与进程登记同事务，source append、mutation、backup、projection 和 started 在实际入口重验 fence。closing 后不启动新 runtime/业务请求；旧进程未停止前不删除。窗口关闭、idle/abort/lease 超时不是退出证明，协调者接管也须证明旧协调者已停。真正无法控制的外部副本预先列残留，已承诺受控者失联不能降格假称完成。未完成在线 quiesce 不阻塞维护方案，Pi 将来启用时遵守相同退出路径。

维护协调者只可枚举、展示/批准/取消、对账和清理，不调用模型或扩展删除范围；自身输入/呈现/continuation 敏感数据加入自清除。Manifest 变化须重显重批。提交前取消可开放新 epoch，旧 token/activity/window 不复活；必须包含维护成功及失败后可续做的正常路径，不能靠永久 blocked 通过验收。

短数据库事务原子逻辑清除、追加 logical-commit receipt、将 fence 置 cleaning 并保存最小 cleanup continuation；这是不可取消点，外部删除只能在它之后。提交前失败回滚且无外部删除；提交 unknown 先查 operation/receipt。提交后各 owner 按同一批准 manifest、当前权限和实际 identity 幂等向前清理，目标不进入普通查询/恢复/导出或模型上下文；失败返回 error、known committed、cleanup incomplete 与有界残留，不能假称未变更或回滚，不能盲删换了身份的资源。重复 commit/cancel 为 settled，维护续做不重复 mutation 或重新申请同一批准。

Continuation、fence/activity、intent、Info/outbox 的敏感关联全部进清除闭包；在删 locator 前获取并排空整个 store 的维护 fence，只留随机 store identity/epoch/无内容进度，重启继续关闭。外部完成后删敏感 continuation、再做 SQLite 维护，完成 receipt 与开放 fence 最后同事务提交，旧 activity/缓存/token 不因重新开放复活。Continuation 不保存正文，仅在未完成期间保护必要 locator/ack，不用于检索或模型输入，也不是完成后保留例外。外部 owner 全部完成后，先事务删除其敏感字段/反向引用，只留无内容 operation 进度，再完成 main/WAL/free-page 维护及复核，最后追加 content-free controlled-complete。删 continuation 本身产生的旧页也须清理；中途崩溃凭无内容进度重做末段维护，不恢复 locator。受影响备份/bundle 不发布或恢复旧内容；缺清除进度或 store integrity 时保持 blocked，不从清除前快照复活目标。逻辑提交、incomplete 和最终结果是不同追加事实，不回写旧 receipt。

Purge 前已签 owner operation receipt 仅在原本已是不可反查假名 subjectRef/revision、无正文/locator/原 hash 时保留且不改写；否则删整行及对应展示。清除完成后的其他保留物仅 content-free envelope/seq/attempt 状态与不可反查 purge marker，受影响 stream 明示不可完整复算。旧 preview/detail 只能 redacted，外部 remote/备份列为不可控残留；不声称 SSD/文件系统取证级擦除。

清除结果由维护 Host 持久呈现；不为补模型摘要向已退出 session 重投已清除目标。新 runtime 读取 completion/fence 与当前合格来源建立新 window，旧 source 已清除则报缺，必要状态无敏感内容。普通 correction/forget/restore/rollback 的两面投递义务不变，见 14。

### I19. 容量、备份、恢复与 bundle

容量先清可重建 projection/cache、完成 job/临时物和可选工作，不自动删 canonical/history。Archive 或 dispatch ledger 无法 durable commit 时禁发。参数按真实基线和平台证据冻结，不预填 soft/hard 数值。

首次真实 schema 冻结后，数据变化时每日最多一份 online backup，原子保留最近两份；迁移前另建临时恢复点，校验后才标可恢复。Purge 先按围栏排空已启动 backup（含临时文件和最终 rename），删除经重新批准 manifest 中含旧内容的所有受控快照；完成门禁后才生成干净快照。同盘备份不防设备损坏，不自动云同步。

打开先 schema fence/PRAGMA；备份、迁移与维护执行 quick/FK/stream-head 检查。索引坏可重建，canonical 坏则阻断写入/dispatch、保留坏文件，仅从已验证快照恢复并追加 content-free recovered-from-snapshot receipt；可能缺事件的 stream 标 recovered_with_gap。旧 session 及 job/maintenance/migration 在对账或明确封存前 dispatch-blocked，started/no-finished 保持 unknown-sent；新 session 不继承旧 attempt，也不能绕过未完成 purge 或 owner 恢复门禁。

Bundle 是后续能力切片，未通过 X-15 不开放导入/导出，但不阻塞本地 provider 测量与首次切片。启用时使用 versioned manifest、events 与内容寻址 blobs；无显式 scope/project/session/record selector 拒绝导出，只展开所选 canonical/provenance/tombstone 必要闭包，owning session 被选才包含其 ledger。不导出 job/maintenance/migration streams、active intent、fence/activity、待执行批准、heads/index/jobs/leases。逐文件 hash、origin/event identity 与幂等检查，冲突保留，导入始终为待重验候选。Hash 不等于 authenticity，不加签名/密钥体系或全局 hash chain；课程 X-08 不改变生产密码学范围。

### I20. MC 替代、平台与阶段

文档迁移已完成于历史检查点 ef58c8c；本次是 Euler 仓库中的后续设计修订，不重新迁移或回写课程源。运行时替代 MC 是另一件事，只在 D7 与当前切片 X-card 实证门槛后发生。

MC 生产 DB 只以一致性只读方式盘点；不迁移旧 memories、notes、Dreamer、M0/M1、compartment、FTS、embedding、pending 或其他投影，不导出兼容层。重建只取原始 session/source 和 owner 明确 bootstrap，经 provenance/scope/time/conflict/verification 形成新 staging 候选；缺原文即 evidence-gap，旧摘要只可当定位线索或负例。Project 映射需真实 owner/manifest，不把路径或旧 ecosystem/universe 自动映射成新 scope。每次 source snapshot receipt 保留 locator、只读事务边界、MC schema head、表/行计数与 mapping policy/digest；每个新 candidate 带 snapshot、原始 locator/row-message hash、origin、mapping reason 和初始 unverified，按 snapshot/policy/source identity 幂等。现有盘点数量不是固定基线，不从旧报告补写运行数值。

准备库用目标 schema，P0 冻结 app-id、host/run/scope、私有路径/file identity、证据位置与启用步骤；不得与 MC 或任一已 live store 重合。允许准备库内 candidate/verification/event/head/projection 与独立 assembly/attempt 审计写入；其中 verified/active 不授予 live hook 或外部副作用。失败仅隔离本次准备结果，不删原始 source。首次启用绑定已验证的同一数据身份，关闭准备写入者，必要的停写/文件移动后重验 identity/hash/schema，不借切换重新提取或绕过资格门禁，不保留第二份 live canonical owner。真实来源写入仍受 I03 的 schema/验收前置约束。

Shadow 不改 MC request/cache/DB，不执行未授权副作用；比较原始 source/gold 下的质量而非旧 memory 行相等。差异分 equivalent、improvement、expected migration difference、legacy defect、regression、inconclusive；不可判不能 PASS。“只读 shadow”约束 MC、已有 live state/request/cache 与未授权外部副作用，不禁止上述准备库写入，也不增加独立 shadow 系统或 MC 兼容层。

首次切换单一 project/session 的完整 context unit，包括 memory retrieval、source recovery、Orchestrator、budget/compaction、compartment 或 fresh-window fallback、request barriers；不能只接检索而由 MC 继续裁剪。先通过 hard gate、control baseline/阈值和 shadow，再 quiesce 并证明 MC 不再 dispatch；同一事务提交新 owner/epoch/cutover lifecycle 是唯一不可取消点，随后才注册 Euler hook、通过 assembly/started barrier 发 canary。提交前可在证明未提交和互斥后继续或重启 MC，维护可暂时无服务；提交后 hook、barrier、首次 canary 失败均只走 Euler 修复/阻断，不回 MC。每次启动先核验 durable owner/store identity，再加载并验证唯一 hook；缺失、损坏、unknown 或快照 gap 不得推断 MC，启动配置不能覆盖 owner。Canary PASS 决定扩围，不决定该提交是否已发生。MC 原库是否删除是另一个 owner 决策，不是兼容前置。

Windows-first；共享 Core/portable/可自动化 OS 用 Windows/macOS/Linux CI matrix，真实数据根/权限、Host consumer/UI、文件访问、进程与本地恢复等按目标平台实测。无其他真实宿主不阻塞 Windows，但也不声称其他平台生产支持。未来行为自修改的三实际宿主门槛不扩张 v1。

实施阶段 P0-P4 与 prompt P0-P3 是不同命名空间：P0 准备契约/fixture；P1 durable foundation；P2 Core；P3 Host；P4 综合验收。跨阶段可实施，但未齐证据不能升级整卡、生产能力或真实数据许可。具体映射见 Testing Decisions，仍以 D8.2 为准。

## Testing Decisions

### 已确认的测试入口

测试边界沿用 owner 已批准的 Ticket 12 和 D8.2，不另建测试框架：共享 Core 的公开操作/结果边界、HostAdapter 的真实输入与呈现边界、最终 transport 的 payload/dispatch 边界。Store 事务、约束和崩溃恢复是外部可观察契约，必须用实际 SQLite 和重启核验；私有 helper 的自测不能代替这些边界。

优先测试输入产生的 canonical 状态、明确终态、真正输出给消费者的正文、不可变 receipt、实际网络/文件副作用及恢复结果；不以函数调用次数或类布局作为需求。唯一快路径主 LLM 调用数、dispatch=0 等是已定外部行为，仍作为明确断言。

课程 fixture/原型和固定源码反例只用于发现遗漏，不证明目标行为。当前 Ticket 12 的相应能力子项及失败影响是验收依据：首次切片不能跳过其启用路径的 case，后续未启用能力标 deferred 而非 PASS，也不作为首次隐含前置。正常成功、失败后恢复与拒绝路径都要验证；原型/旧评审不证明本次修订或 runtime。

### X-card 覆盖与阶段

| ID | 阶段 | 必须观察的结果与完整 PASS 边界 |
|---|---|---|
| X-01 | P1 | 首次路径的 app-id/数据根、schema/FK/CAS/seq/head/intent、pending、Info/outbox、stream owner/fence 与 inert proposal 完整 digest；不预建可选 artifact 或行为评估表，portable/Host 分列。 |
| X-02 | P2 | eligibility、FTS/CJK、current 去重与本地冻结需求语料/held-out；历史 60 用例取得后追加，不是开跑硬前置，不伪称复用。 |
| X-03 | P1 | 实际 search worker 的乱序/重复/崩溃/lease、FTS 损坏重建与双向完整性；overview 后续子项验 SQLite body/refs/cursor 原子性、历史证据与新版本重建。 |
| X-04 | P2，P3 接线复验 | bootstrap、硬上下文及累计 run 预算、取消、四级降级、完整 ReAct、source ack/recovery、单主调用快路径和失败后正常继续。 |
| X-05 | P2，P3 补齐 | 按 12 通用组验 project/scope、本地 AGENTS/Skill/provider metadata 与 Core gate；MCP 和 Pi loading 分别为后续追加组。共享隔离失败与能力专属失败分开处理，未启用能力不阻塞首次 CLI。 |
| X-06 | P1，P3 接线复验 | 两道 barrier、started 与撤销的并发线性化、payload/网络计数、unknown-sent 对账/封存与 recovery gap；有正常发送及继续路径，stub 不替代真实接线。 |
| X-07 | P2 | capture/独立取源、08 状态转换表、时间/冲突/回滚/抑制/Info、retrieved/injected 和 inert proposal 无行为权限；scope review/backfill 是后续子项，无行为 evaluation runner。 |
| X-08 | 独立课程票 | owner 预封存 pre-image/held-out、重签篡改、known-bad、负迁移及正向严格改善/其他零回归；不替代 P2 runtime 安全门禁。 |
| X-09 | P2 Core，P3 Host | actual-used inspect、correct/forget/restore/rollback、完整 batch CAS、结构化 cycle-safe purge 和真实模型 tool-call 后 Host 重验；物理副本归 X-12。 |
| X-10 | P3 | 按 12 卡内“首次 CLI 必测”和“后续模式启用前追加”分组验呈现/批准/终态及 receipt 两面；与同模式 X-11 联合验收，只读模式不授予写权限。 |
| X-11 | P3 | 按 12 卡内分组验首轮 source、pending/unknown/Info/维护恢复；模式专属 carrier/consumer/continuation 在对应模式启用前追加，共享保证不能跳过。 |
| X-12 | P4 | ENOSPC/只读/损坏/迁移中断、backup/恢复 gap、维护独占与旧进程退出、main/WAL/free pages/受控引用清除及恢复正常；不要求在线 UI/cache quiesce。 |
| X-13 | P2 Core，P3 Host | 实际 parse→normalize→policy→open 与 inode/file ID、编码/UNC/大小写/symlink/junction/双解码负例；字符串 helper 不等于真实路径语义。 |
| X-14 | P4，可早期受控测量 | 依赖实际 transport/ledger/相关 Core gate，不依赖 X-15；provider usage/cache、payload/epoch 与安全等价，接 D7 baseline/阈值，不反推命中。 |
| X-15 | Bundle 切片 | 启用前验三 OS 往返、selector/闭包/hash/幂等/origin/重验/purge 排除与增量恢复；不阻塞本地首发。 |

P1 为 `X-01 → (X-03/search 与 X-06/ledger)`，两条可以并行；P3 按每个已启用模式的 X-10 正常路径与 X-11 故障恢复联合放行。X-12 与已有受控 transport 下的 X-14 可并行，X-15 只在 bundle 启用前要求。X-09/X-13 的 P2 子门禁不要求尚未实现的 Host 整卡通过，也不据此提前开放能力；受控真实模型检查不拖到 X-14、不以 mock 替代。首次真实数据仍须 I03 全部相关门槛。

### 增量验收闭包

- D1 primary/fallback、实际模型/版本与 attempt receipt 对账：X-07；否定结论不被 fallback 覆盖。
- D4/D5 archive ack/job 恢复、raw-only compartment、window identity/lifecycle 与 baseline：X-04/X-14；Pi 未 flush 和 unknown source 不冒充 durable。
- D6 Core isolation：本地 AGENTS scope/conflict、Skill 发现/同名/准确正文/换窗、多已选 Skill 的 skill-conflict，以及 provider metadata、Core/Host schema 与未启用工具拒绝，归 X-04/X-05/X-10 通用组；包含拒绝、相容和解除冲突后正常对照，不要求通用自然语言冲突解析器或先实现 MCP/Pi。
- D6 MCP follow-on：server binding/discovery/schema/namespace、目录失败与实际调用在 MCP 启用前验 X-05 的 MCP 组和 X-10 追加组；Pi loading 独立归相应 Pi 模式的 X-05/X-10 子项，不与 MCP 互为前置，同时启用才补组合复验。专属缺证/失败关闭相应能力；暴露共享 Core 漏洞仍阻断全部受影响路径，deferred 不等于 PASS。
- head_event_id 的旧预览拒绝及新预览连续撤销：X-07/X-09/X-11；purge 的逻辑事务、部分失败、continuation 自清除、末段 SQLite 维护及不可逆后恢复：X-09/X-10/X-11/X-12。
- D7 source snapshot/candidate envelope/幂等、准备库 no-write 边界和 owner 提交各杀点：Ticket 12 的 D7 migration gate，复用原 X-06/X-12/X-14 证据，不新建实验框架。切换前门槛满足后才提交 owner，首次 canary 在提交后运行，失败不回 MC。

- 首次闭包：bootstrap/intent X-01/04/05/11；stream/admission/unknown X-01/06/07/12；Info X-01/07/10/11；状态转换与抑制 X-07/09/12；维护 purge X-01/06/09/10/11/12；累计预算/取消 X-04/06。P0 先验 CLI 载体与关键接点，再按 P1–P4 实施；D7 不绕过当前启用路径的门禁。

- Pi 切片先做 source ack、最终发送与正常输入/维护退出的 synthetic 可行性探针，再按 X-04/05/06/10/11/12 验受控接线和消费者。MCP discovery、overview/backfill、bundle 各验自己的子项；未实现的后续能力保持 deferred，不阻塞 CLI，也不宣称已支持。

### 验证纪律与上线证据

1. 每条原始 assertion、fixture/held-out identity、owner/sealed/released commit、implementation commit、环境/Node/SQLite/provider/model/adapter、完整命令/退出结果、原始 artifact/hash 与受控副作用进入可复算证据。`source mechanism`、`stored receipt`、`independent validation` 三轴分别维护，README/badge/报告自述不替代原始证据。
2. Held-out payload 由独立 owner 在实现工作区外封存；实现者可见 schema/case IDs/判定规则，不提前取 payload。污染 case 降为 dev 并补 replacement，保存所有失败，不靠换阈值或只留成功 run 通过。Negative 与 integrity FAIL 保留原等级，不能改成“未运行”。
3. 支持的 exact/CJK gold 全进正确 candidate lane，canonical 短语全部正确；开放语言不确定可拒绝/重述，不得走相反或更破坏方向。X-08 必须正向严格改善且其他 held-out 零回归，schema-only 或 baseline=treatment 不算 PASS。
4. 安全/隐私、scope/owner、未验证激活、source hash、批准、receipt、预算、ReAct 与 dispatch barrier 违规全部要求 0 次；平均召回/性能/费用不能抵消。完整性或共享 invariant 失败阻断受影响写入/dispatch；索引、可选 worker/cache 等局部失败只按已定 unavailable/evidence-gap/dirty 状态降级。
5. 同 workload/source、provider/model 的 MC control 与 Euler treatment 配对，cold/warm/cache 条件分开；报告 precision/recall/coverage、成功/失败/缺口、TTFT/总延迟 p50/p95/p99、tokens/cache/cost、存储/backlog/lag。质量规则先封存，性能/成本数值由真实 control baseline 和预批准 overhead budget 计算，canary 前冻结，不在看过 canary 后调口径。Provider 无 cache 指标记 unsupported。
6. 每个 capability × host 单独 PASS；未解释的高影响差异、缺 receipt、无阈值或未测平台不升级为通过。通过实验也不自动授权 live owner 变更，仍走 D7 的完整 context unit 门禁。
7. 所有故障、迁移、purge 与 corruption 实验用合成库。MC 只读计数只能作为规模基线，不复制生产 DB 当一致快照，不接真实 memory/ledger 做测试。
8. 当前没有本规格的实现/运行 receipt；全部 X-card、目标 runtime CI、真实 Host 与 canary 仍是未证实。正式参数、X-02 套件登记、X-10 模型摘要白名单/最大序列化 bytes 和独立 held-out 制品是后续阶段前置，不由本规格编造。

## Out of Scope

- 多人协作、云 SaaS、自动跨设备同步、音视频记忆、共享/云盘 SQLite。
- 把源材料、intent、活动指令、Wiki 或索引当作一种 canonical memory；L0/L1/L2 多套 store、统一主题 taxonomy、通用图、向量数据库或默认 embedding。
- 生成 Wiki/insight/diagram 文件、空 artifact metadata 表及通用 artifact worker；首个真实消费者获批后另走契约与前进迁移。
- 自动发布或热加载 policy/AGENTS/Skill/tool/code/Harness 修改、通用插件注册、MCP server 市场/自动安装更新、Skill 包版本/更新系统。
- 行为自进化的 sealed-plan/attempt/result 执行系统、overview 外部文件发布/pin/GC/同 hash repair，以及在线细粒度 UI/cache purge quiesce；不得通过为未来预留空表重新加入首次 P0/P1。
- 额外 RAG/router Agent、通用 task 框架、完整状态栏、Trajectory UI、分布式 trace、全量 prompt diff。
- 为 Pi -p 建 stderr/文件旁路或依赖模型复述 canonical；把 RPC/JSON 事件输出冒充真实消费者呈现。
- 重新选择自研 TUI 框架、鼠标/多选库或视觉方案；富 UI 不能改变已定语义。
- 导入旧 MC memory/notes/Dreamer/摘要/索引/运行状态，MC/Euler 双写、旧数据兼容、Euler-active 后回退 MC。
- SQLCipher、应用层正文加密、全局 hash chain/签名/密钥体系、取证级擦除保证。
- 将课程全部代码、研究草稿、旧评审、原始 session/数据库、凭据或用户数据复制到产品仓库；本规格不授权读取额外私有来源或启动无人值守实现。

## Further Notes

### 原始契约与可追溯关系

最初生成依据为课程检查点 `396622b6395df44ccc466c2cc39d2e63038b7bd6`；随后 owner 批准的修订以本规格及原始契约所在的同一新 Git commit 冻结，不能用旧检查点覆盖新定案。独立评审记录准确 SHA；设计票 resolved 和旧评审都不是新版本通过证据。以下引用相对当前本地 tracker，迁移后的历史定位仅作本节规定的转换：

| 规格主题 | 原始 owner contract |
|---|---|
| I01、I04 的对象/owner/scope | [04](04-define-domain-boundaries.md)、[05](05-set-authority-boundaries.md)、[06](06-design-memory-hierarchy.md) |
| I05 Capture/worker、I06 Verification/feedback/evolution | [08](08-automate-memory-evolution.md)、[13 D1/D4](13-select-target-v1-migration.md) |
| I07-I11 检索、上下文、预算、ledger、cache | [07](07-coordinate-memory-context.md)、[09](09-assemble-context-safely.md)、[10](10-choose-storage-projections.md)、[13 D5](13-select-target-v1-migration.md) |
| I02/I03/I19 的运行时与物理边界 | [10](10-choose-storage-projections.md)、[13 D2/D3](13-select-target-v1-migration.md) |
| I12-I14 的 AGENTS/Skill/tool/MCP | [13 D6](13-select-target-v1-migration.md) |
| I15-I18 的操作与 Host 契约 | [11](11-prototype-observability.md)、[14](14-define-host-presentation.md)、[10 §28b/28c](10-choose-storage-projections.md) |
| I20、所有 X-card、CI/宿主/阶段门禁 | [12](12-build-evidence-experiment-matrix.md)、[13 D7/D8](13-select-target-v1-migration.md) |

[01 课程检查点](../migration-manifest.json)、[02 课程检查点](../migration-manifest.json)、[03 课程检查点](../migration-manifest.json) 和原始 research 只解释历史来源及反例，不是 Euler 的生产 receipt。[Q6 对照](../research/2026-08-29-pi-vs-dsh-q6.md) 的 Pi runtime 选择后来已由 14/13 限定为 Pi adapter，自研 CLI 仍只复用 pi-ai；不能把历史表述重新扩大。MC migration head、行计数与 Pi 0.84.3/0.84.4/0.85.1 版本引用均是各自观察时点的事实，迁移/接线必须绑定 UTC observation timestamp、host/install identity、source/installation receipt 和具体 bytes；不能把不同时间点的观察互相当作当前环境保证。

### 已定路径与迁移清单

本节保留已完成迁移的历史清单和当时的四处 rewrite 规则，不是后续文档维护的限制。`migration-manifest.json` 的 target/README hashes 对应 Euler 检查点 `ef58c8ca39fe9ec2d95c215387afe162d40fda08`，应对该 commit 的 Git blob 校验，不与当前修订后的工作树比同。后续规范直接在 Euler 中同步修改相关 owner contract/验收，并用 Git diff/新提交追踪；不重签历史 manifest、不回写课程源，也不重新要求“只许四处转换”。本次修改仍是未提交的设计修订，不构成独立复验或 runtime PASS。

产品仓库为独立 private `qsgy-edge/euler`；Windows 主开发副本 `D:\GithubRepositories\Agent\euler`。生成本规格时，课程仓库无 remote，不能编造可访问的 GitHub blob URL 或在本次授权之外发布整个课程仓库；原始完整轨迹留在当前本地 Git 检查点。

源码映射已定：`packages/core/`（`@euler/core`，store 在 `packages/core/src/store/`）、`packages/pi/`（`@euler/pi`）、`apps/cli/`（`@euler/cli`，binary `euler`）。`RUNTIME/core` 对应 Core，`RUNTIME/host` 对应两个宿主；不得在课程仓库就地实现产品。数据根为 Windows `%LOCALAPPDATA%\euler\`、macOS `~/Library/Application Support/euler/`、Linux `${XDG_DATA_HOME:-~/.local/share}/euler/`，不是源码目录。

原迁移在源侧评审通过后复制了以下集合；这是已完成的代码库文档迁移记录，不是 MC 数据迁移或本次新增待办：

| 来源（当前架构目录） | 独立仓库位置 | 角色 |
|---|---|---|
| `issues/15-euler-v1-spec.md` | `docs/architecture/issues/15-euler-v1-spec.md` | 统一实施规格；未解除各阶段门禁 |
| `issues/04-define-domain-boundaries.md` | `docs/architecture/issues/04-define-domain-boundaries.md` | 领域契约 |
| `issues/05-set-authority-boundaries.md` | `docs/architecture/issues/05-set-authority-boundaries.md` | 权威契约 |
| `issues/06-design-memory-hierarchy.md` | `docs/architecture/issues/06-design-memory-hierarchy.md` | Memory 模型 |
| `issues/07-coordinate-memory-context.md` | `docs/architecture/issues/07-coordinate-memory-context.md` | 协作契约 |
| `issues/08-automate-memory-evolution.md` | `docs/architecture/issues/08-automate-memory-evolution.md` | 生命周期与验证契约 |
| `issues/09-assemble-context-safely.md` | `docs/architecture/issues/09-assemble-context-safely.md` | 安全装配与 ledger |
| `issues/10-choose-storage-projections.md` | `docs/architecture/issues/10-choose-storage-projections.md` | 存储/隐私/恢复契约 |
| `issues/11-prototype-observability.md` | `docs/architecture/issues/11-prototype-observability.md` | 看/改/退语义契约 |
| `issues/12-build-evidence-experiment-matrix.md` | `docs/architecture/issues/12-build-evidence-experiment-matrix.md` | 验收矩阵；保留未证实状态 |
| `issues/13-select-target-v1-migration.md` | `docs/architecture/issues/13-select-target-v1-migration.md` | 架构、阶段和 MC 切换契约 |
| `issues/14-define-host-presentation.md` | `docs/architecture/issues/14-define-host-presentation.md` | Host 唯一权威契约 |
| `prototypes/11-observability-tools-prototype.html` | `docs/architecture/prototypes/11-observability-tools-prototype.html` | 历史/合成语义参考；不代表当前 Host 终态、canonical lifecycle/verification schema、purge receipt 或 pending supersession；原型中的 `inactive` 与 `pending-reverification` 只能作为 projection/job 历史标签，迁移不得写入 canonical lifecycle/verification 枚举；也不是产品 UI 或运行验收 |
| `research/2026-08-29-pi-vs-dsh-q6.md` | `docs/architecture/research/2026-08-29-pi-vs-dsh-q6.md` | 已被后续契约限定范围的 Q6 参考 |
| `research/2026-08-28-dsh-plugin-trajectory-architecture.md` | `docs/architecture/research/2026-08-28-dsh-plugin-trajectory-architecture.md` | Q6 引用的历史机制证据，旧运行时选择已被 supersede |

保留上述 15 个文件的相对布局与规范正文。产品中的来源清单固定为 `docs/architecture/migration-manifest.json`（普通版本化 JSON，不是运行时 registry）；根 `README.md` 仅链接实施规格与该清单，并明确尚未实现/运行验收。Manifest 使用 `schema_version=1`，记录 `source_repository=ai-agent-cli`、实际已通过完整评审的 `source_commit` 与 `source_root=.scratch/agent-memory-context-architecture`；`files` 逐项记录 source_path/source_git_blob/source_sha256、target_path/target_sha256、role；`external_references` 记录下表四个课程源的同样 commit/blob/hash 与“不在产品内”的角色；`rewrites` 记录文件、旧/新定位及次数，`generated_files` 记录 README 的 hash。Manifest 不包含自身 hash，避免自引用。

仅 `issues/15-euler-v1-spec.md` 允许以下四处定位转换，每处恰好一次；表格中的文字是转换定义，不再次改写。其他 14 个文件按已评审 Git blob 字节迁移。Source/target SHA-256 分别从 Git blob 和转换后的真实 bytes 计算，不用受 autocrlf 影响的工作副本文本代替。

| spec 中的位置 | 原定位 | 产品定位 | external reference |
|---|---|---|---|
| 顶部 Source map 字段 | `../map.md` | `course-source:map; see ../migration-manifest.json` | `map.md` |
| 原始契约说明的 01 链接 | `01-audit-course-evidence.md` | `../migration-manifest.json`，标签注明“01 课程检查点” | `issues/01-audit-course-evidence.md` |
| 原始契约说明的 02 链接 | `02-verify-magic-context.md` | `../migration-manifest.json`，标签注明“02 课程检查点” | `issues/02-verify-magic-context.md` |
| 原始契约说明的 03 链接 | `03-recheck-external-evidence.md` | `../migration-manifest.json`，标签注明“03 课程检查点” | `issues/03-recheck-external-evidence.md` |

这四个源仍在同一课程 commit 中，可用 `git show <source_commit>:<source_root>/<source_path>` 恢复；产品不得伪造它们已复制或存在远程 URL。其余选中文档的本地 Markdown 链接须落到本清单内的真实文件；HTML 只检查真实 src/href，不能把 JS 正则当 Markdown 链接。普通历史源码路径/观察不是必迁规范。迁移前预演四处转换、JSON schema/必填字段、完整文件与链接集合，迁移后重算真实 target hash 并验证工作树/文件集合；任何未列转换或规范语义改动先修源并重新评审，不在产品副本静默分叉。

迁移不删除课程原件、不推送整个课程仓库，也不创建生产 DB、配置凭据、启动 P0 程序或切换 MC。经过核验的产品副本成为后续实现规范的维护位置，课程检查点保留历史，不建立双向同步。后续再按规格拆分实施任务。

### Owner-approved review amendments

以下 F01-F04 是原修订的追溯索引，其语义仍须由当前实现证明；源侧旧评审不能证明 2026-09-09 修订通过，不把本表当 PASS：

| 原项 | 当前权威条款 | 复验重点 |
|---|---|---|
| F01 / R04 | 10 §8、11/14 的 snapshot/head_event_id 与 rollback | 旧 preview 永久 stale，新 preview 可合法连续撤销；恢复旧 revision 不恢复旧事件身份 |
| F02 / R01 | 10 §23、11/14、I18 | SQL 逻辑提交与物理清理分开；partial/unknown 可恢复、不假称回滚；continuation 自清除后完成末段维护 |
| F03 / R03 | 13 D7.1/D7.2 | 准备库允许写、MC/live 不写；snapshot/envelope/幂等与数据身份启用不绕过资格 |
| F04 / R02 | 13 D7.4、D5/D8 | owner/epoch/lifecycle 单次 durable 提交、启动恢复与 canary 顺序一致，提交后不回 MC |

### Subsequent owner-approved contract completion

owner 已批准补齐 C-01/I-01–I-07，当前契约落点如下；这些是待新 SHA 复验的设计，不把旧 BLOCKED/EVIDENCE-GAP 改写为 PASS：

| 事项 | 唯一详细条款 | 验收焦点 |
|---|---|---|
| purge 跨进程隔离 | 10 §23a | 首版维护模式、原子 admission/进程登记、真实退出/独占后批准、store 末段恢复；在线 quiesce 后置 |
| MCP discovery | 13 D6.5 | adapter-owned schema 与八个 Core 分列，hash/调用/目录错误可观测 |
| background stream | 10 §11 | 四类显式 owner、来源清除、unknown/接管不重发 |
| active intent | 07 §4 | Core events/head、真实授权、分支/版本 CAS 与缺证停止 |
| 自动 Info | 08 §27a、11/14 | activation/batch/outbox 原子，投递/已读可恢复，purge 不复活 |
| tombstone correct/抑制 | 08 §19a、11/14 | preview not_actionable、commit stale，独立 restore 与同源重放 |
| Pi context 与 extension | 13 Pi runtime ownership and startup contract | 加载前固定集合、唯一内容 owner、受控 transport、非模型入口与各模式验收 |

本次修订的复验应覆盖首次切片边界、正常操作/恢复、对应 owner contract 与 X-card 的一致性。Pi/MCP/overview/bundle 后续按自身能力复验，不回到“全部未来设施先过才能实施”的旧范围；旧 migration 只校验历史 bytes，不替代当前设计或运行证据。
