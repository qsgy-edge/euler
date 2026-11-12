# T24 检索策略：受影响验收清单

本清单按已确认的 [R1–R8](../architecture/memory-retrieval-policy-proposal.md) 执行。[T24 gate](t24-first-cli-acceptance.md) 仍为 BLOCKED，开发证据、独立首测和独立复验分别归档。

## 任务行为的判定

| 场景 | 评估条件 | 判定 | 已有开发证据 |
|---|---|---|---|
| 输入／现有上下文完整 | 所需格式、事实和约束已经提供 | 可直接完成；额外检索记录为成本／选择行为，不预设每次必须查 | 完整给格式写通报：1 次观察，0 检索，正确完成 |
| 明确依赖尚未提供的历史 | 授权范围内有可检索的相关记录，正确答案需要它 | 检索触发、命中／送达与最终使用分别检查；证据不足应可见 | 同一历史格式题：2 个新会话，均首轮检索、第二请求完成 |
| 需求有歧义 | 可独立完成，未明确要求沿用历史 | 作为观察项；隐藏落款未出现不单独判必要检索失败 | 原普通维护通报题 A/B 均未检索，未写隐藏落款 |
| 持续约束 | 规则已明确发布且适用于真实绑定项目 | 检查实际 guidance 加载及模型是否遵守；权限不适用时不加载 | G1 的绑定会话收到规则且按格式完成，未绑定只读会话未收到规则。重复与匹配能力的对照仍缺 |
| 需要原文证据 | 任务明确要求核对来源，材料可合法定位和恢复 | 按既有 locator/hash／范围／展开契约验证 | published source 离线搜索与展开通过；真实 G4 检索命中且送达同项目跨会话原文，最终逐字引用仍缺 |

行为评估使用预先声明的需求与可用证据；不把这段文案或模型某次工具选择固化成确定性 CI 断言。新增提示词的效果应在相同题、数据、模型和预算下另做对照，当前两次历史样本不能给出其独立贡献。

预算耗尽、输出截断、传输／协议失败与模型行为分列。查询成功但返回不足、命中但尚未送达、送达但答案未用，也分别保留，不折叠成同一种“漏搜”。

## B4：策略相关项与独立保留项

| 项目 | 历史要求／当前缺口 | 按已确认策略处理 | 验证入口与完成证据 |
|---|---|---|---|
| 普通自动装配 | 24 个独立缺证案例均缺自动装配观测 | 新验收改看 R2/R7 的触发→返回→冻结送达；旧 `ASSEMBLY_NOT_OBSERVED` 保留原判，注明旧规格身份 | 普通 CLI、实际请求、tool archive、assembly/attempt 逐项对齐；不只检查 Store 页 |
| 投影滞后与新激活记录 | pinned delta／current-head 与下一次可读性 | 取消自主送入 prompt，保留按需读取新 head 或明确 dirty／不可用 | `search-projection`、`owner-memory`、`agent-run` 现有测试入口；必要时用新开发数据查缺口 |
| canonical 状态变化 | 4 个独立案例另缺 transition 可达性 | 保留 | 新开发探针已记录 activation/revision/forget/restore/rejected/conflict、dirty→drain、旧快照拒用与重启，共 15 项断言；不映射未知独立案例，冻结请求送达仍分别核对 |
| 中文单字 fallback | 2 个独立查询 `unsupported-query` | 默认 FTS 仍明确不支持，项目级单字可使用显式有界慢路径 | 普通 CLI 已验证记忆和已发布来源的字面查询、权限及实际送达。全单字召回、非单字排序仍按 X-02 独立配对判定。[T10 单字入口](t10-memory-retrieval.md#explicit-single-han-search) |
| guidance 正负向 | 2 个独立案例未观测加载 | 保留独立首测判定 | 开发侧已补显式绑定、未绑定只读 grant、仅模型自报三种实际请求对照；复用 #25 的 4/4 场景和 7 次 loopback 原件 |
| scope、权限、目标环境 | 未授权泄漏、跨项目 reference-only、撤销／任务结束／切换 | 保留 | 独立复验的 9 条游标、3 条首次引用、6 条失效句柄拒绝通过。已有 grant 的 target 变化与项目不可用仍缺 |
| 排序／query tokenizer | 旧实现按组内命中数与轮询 | PR #65 已交付合格候选集 BM25、多 lane RRF 及 tokenizer 版本 | 独立复验复算 173 个 BM25 lane 分值。RRF 仍为开发路径证据 |
| 预算与成本 | 逐候选实际 token 和冻结送达缺证 | PR #65 区分返回、冻结送达、选择原因和 UTF-8 bytes 计量 | Store 页字节与整包估算分列。独立复验的 4096 整包映射 0/27 发出，逐候选实际 token `unsupported`、费用 `unknown` |
| 独立证据保管 | 旧 T10 集的封存／释放记录缺口，27 案首测 3 fail / 24 gap | 原判和收据身份分别保留 | 原 27 案经新独立释放单次复验为 0 fail / 27 gap。旧 T10 未重跑；后续访问由独立保管者按单次释放控制 |

原始身份和判定见 [Windows 独立复验](t24-first-cli-acceptance.md#同一封存集的-windows-独立复验) 和 [开发补证](t24-first-cli-acceptance.md#已确认策略基线的开发补证)。既有 27 项开发边界案例复用三平台 CI。

独立释放前按 [X-02](../architecture/issues/12-build-evidence-experiment-matrix.md#x-02--eligibility--ftscjk-held-out-检索) 分别固定 Store 查询页字节／行限额、候选估算器与单位，以及普通 CLI 的 route/adapter 整包限额、输出预留和安全余量。4096 整包结果作为紧预算对照保留，普通送达使用预先冻结的受支持配置。适用案例逐项核对 `memory.search` 返回、实际冻结的工具结果和 `source.expand(recordId)`，以及对应的原文授权、wire、assembly 和 attempt。实际逐候选 token／费用单独记录，旧独立收据保持原判。

## 来源接口的定向核对

两次旧 `source.expand` 拒绝已有调用链证据：一次把 memory recordId 作为 published unitId，一次把另会话 eventId 交给当前 archive 查询。[实验索引](t24-retrieval-experiment-index.md) 记录具体原件和代码入口。当前核对结果：

1. `memory.search` 的 unitId 为 recordId。模型 `source.expand` 用 unitId 查已发布单元，用 eventId 查当前会话，用 recordId 恢复合格记忆的来源。PR #65 保留既有错误路由的拒绝。
2. 已发布来源的 project search→unit expand 已有开发正例，可复用；权限与来源失效负例仍按现有测试覆盖。
3. PR #65 后，普通 CLI 实际送达同项目跨会话的精确原文及显式分页结果。记忆资格、原来源授权、hash 和预算继续参与发送前重验。[G4](t24-retrieval-experiment-index.md#g4-未发布原文恢复) 另证明真实模型能检索命中并收到原文。三个独立复验的正向展开只走到旧 ref-only 入口，仍需通过当前 `recordId` 路由取证。

## 后续执行顺序

| 顺序 | 工作 | 完成条件 |
|---|---|---|
| 1 | 规格与对应验收口径 | R1–R8 基线为 PR #62 合并的 `fb51c16`。X-02 后续复验使用本清单中的分项预算口径 |
| 2 | B4 独立复验的缺证补齐 | 查询页、紧预算、受支持整包和项目级单字慢路径已有开发对照。下次独立释放前冻结配置、适用断言、单字入口与实际 tool delivery／`recordId` 恢复，并补齐独立计量和状态观察 |
| 3 | B5 取证准备与新证据分析 | 原 probe 能保留拒绝时 observations/residuals 及现场；出现新失败时按具体参与者／残留追因；通过复跑不代替根因结案 |
| 4 | B3 剩余真实路径的有界方案 | G1 完成规则正负对照，各用一次真实请求。两条验证管线、纠正／遗忘、长会话／交接、Historian 与 X-14 分组冻结输入、指标及请求上限后取得对应预算 |
| 5 | T24 组合与独立验收 | 按正式规格补齐所属证据，保留历史身份和判定；满足 gate 后才冻结初始 schema |

B5 的两次历史 Windows 超时与 database restore 拒绝仍开放。新增三次 restore 定向诊断均通过且 acquired=true，未捕获拒绝原因；下一次实验应有新的可验证假设或更完整取证条件。

早先两轮真实额度各用尽 18 次。G1 单独批准的 4 次上限使用 2 次，两臂均已正常结束。G4 的原额度 3/3 已用完。其他真实测试组需要对应方案和预算。
