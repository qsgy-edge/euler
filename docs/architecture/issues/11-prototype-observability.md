# 原型化记忆出错后的最小修正闭环

Type: prototype
Status: resolved
Blocked by: 07, 09, 10
Blocks: 14
Resolution scope: 语义决策已定案；本轮按 owner 确认补充分阶段 purge 与 head 事件 CAS，目标实现仍未验证。原有单页及旧评审只证明其当时基线，不证明本轮新增门禁。该 prototype 保留为历史/合成语义参考；当前 Host 终态、verification 枚举、purge content-free receipt 与 pending supersession 以 10/14/15 冻结契约为准，prototype self-check 不构成当前验收。

## Question

在默认无感运行的前提下，用户发现 Agent 可能用了错误记忆时，能否用最少交互完成“看清依据 → 安全修改 → 必要时撤销自动记忆更新”，且关键事实与变更均由 Host/owner 证明？

## Scope

本票只定宿主无关的语义契约：哪些事实必须先展示、哪些变更必须留痕、一次决策覆盖多少对象、状态如何迁移。具体宿主怎么渲染由 [14 宿主呈现契约](14-define-host-presentation.md) 定案；原型只是这套语义的可点验证器，不代表任何宿主的真实渲染。

### 决策粒度

- 一次用户决策不得跨批次，也不得把一次选择拆成逐条 preview/confirm。批次在 activation 事务中固定完整 event membership（08 §27a），`Info` 只投影该冻结身份；用户可选择其中若干条，但已选 event 缺失、变形或因其他操作失去撤销资格时必须整次 fail closed 并要求用户重新选择，不能静默缩成其余条目后照原样继续。失效状态必须在该批次卡上可见并明说需要重新选择（宿主无已输出条目的原位更新能力时，改由与该批次以 operation ID 配对、紧随其后的失效终态条目满足该可见性，见 14），失效期间不得再提供直接提交的批量入口；该状态只在用户重新做出选择时解除，不得因刷新投影自行消失。判定失效必须看失去资格的原因：本次撤销被接受后，被撤销的 event 不再 eligible 是该操作成功的后置条件，不得据此把同一张卡标成失效、也不得撤走该批次里仍然合格的其余条目的撤销入口；该豁免只属于发起本次撤销的那张卡，且只覆盖本次实际处理的 event——不得实现成“凡被撤销过的 event 一律豁免”的全局集合，否则另一张卡或自然语言发起的撤销结算掉某个 event 后，仍选中它的卡会静默丢弃 selection、把这次决策的目标换成用户从未选中的其余条目并照原样提交（比静默缩小更糟）；反之，privacy purge 清除闭包移走已选 event 属于“因其他操作失去资格”，必须与 forget 路径一致地整次 fail closed，不得因为清除同时从 selection 里抹去了该 ID 而使失效判定看不到缺失、静默缩成其余条目后继续提交。
- 逐条确认只用于单一目标的显式请求（“mem-13 这条不对”）。
- 决策粒度是语义约束，不是布局约束：任何宿主都不得把一个批次拆成多次阻塞确认。

### 看

- 用户询问“刚才用了哪些记忆”后，Host 展示 assembly 当时冻结的 memory/source revision 或 hash、内容、locator 与选用原因；不得用查询时的 current 或另一条固定 source 重建“本轮实际使用”。指定目标展开来源时必须先唯一命中 `assembly.used` item，再按该 item 的 `sourceRef` 精确匹配同一 assembly 的 source snapshot；缺失、重复或未选入都报错。source snapshot 必须保存完整 SHA-256，并在展开前对 content 复算；locator/hash 缺失、格式错误或摘要不匹配均 fail closed，不得把篡改内容当作原文展示。
- token、`assembly_id`、attempt 等属于诊断信息，不进默认用户流程。

### 改

- 纠正、forget、恢复与 privacy purge 前，Host 必须先展示目标的当前 canonical 内容、scope、source、revision 与 lifecycle。
- 每份预览绑定唯一 operation identity、目标、expected head 与 `head_event_id`；确认时由 owner 原子比较完整 snapshot 和该 head 变更事件身份（10 §8）。即使 `r3→r4→r3` 或 forget→restore 后语义字段相同，旧事件身份也不恢复，旧预览仍为 stale。任一不匹配即令预览失效，禁止 mutation 与 receipt，并要求重新读取 current。批量操作任一目标不匹配则整批 fail closed。卡内动作还必须携带生成控件时冻结的 operation identity 与 originating inspect/notice identity；adapter 不得从当前全局 pending 反推或补齐缺失 identity。身份缺失、过期或歧义时 fail closed，不得改动另一张卡。
- 同一时刻只允许一项变更等待确认；旧 operation 的确认或放弃不得作用于另一项预览。（唯一约束建在 session 层；10 是单库多进程，跨 session 并发由提交时的 canonical CAS 兜底，第二个提交转 `stale`，见 14 Pending lifecycle。）
- 纠正显示旧内容与新内容的差异，用户确认后创建唯一新 revision；显式空内容或规范化后与 current 相同属于 no-op，返回“未发生变更”且不得创建 revision/receipt。确认必须携带用户实际提交的新正文，Host 不得在确认时用预览默认值或占位草稿替换它；确认请求缺少该正文时整次 fail closed，不得回退到预览草稿。项目事实由 verifier 后台自动复验，不要求用户手动操作。
- receipt 只陈述已完成的 owner 变更。后台复验尚未返回时，receipt 与 canonical 状态都只能写“已排入复验”，不得声称已通过验证；复验结论由后续独立事件更新。
- lifecycle 迁移显式约束为 active → tombstoned（forget）与 tombstoned → active（恢复）；纠正不得隐式恢复 tombstone。目标已经 tombstoned 时，correct preview 返回 `not_actionable`，reason=`tombstoned-not-actionable`，显示先独立 restore，pending/revision/mutation receipt 均不新增；同正文也不优先按 no-op 绕开此检查。若在有效 correct preview 后被 forget，commit 因 head_event_id/lifecycle 变化返回 stale，不能误称 preview 从未有效。restore 经独立批准、当前 source/scope/verification 资格与 CAS 后才可再 correct；无效或 no-op 迁移不签 receipt。
- forget 明示“停止检索/注入但保留历史”；恢复是一次独立的 owner 变更，它的可达性来自 tombstoned 状态，而不是某张 receipt 是否还在。
- privacy purge 明示删除闭包、残留与不可恢复后果，并由 Host 要求独立明确确认。批准前从 canonical target 开始，遍历全部 owner-controlled state roots，对历史 revision、update、`sourceRef`、locator/hash 与 reverse refs 做 fixpoint 遍历，形成并展示带类型字段的结构化删除 manifest；提交时重验该 manifest、批准与完整 CAS，再按 10 §23 的数据库逻辑提交和后续受控物理清理执行，不得改写已签 receipt。关联发现不得依赖 source 副本仍满足完整 schema：只要 locator/hash/`sourceRef` 命中也必须进入闭包。按字段与完整 identity 比较，不用序列化全文 substring（如 `mem-1` 不得误伤 `mem-13`）；遍历与后置条件覆盖任意深度的键和值，不能因引用成环中断。数据库逻辑提交前失败回滚且无外部删除；提交后失败返回有已知 outcome 的 `error`、清除未完成及残留，目标保持隔离并按同一批准 manifest 续做，不宣称未发生变更或可撤销。包括 continuation 自身的敏感字段和 SQLite 维护在内的全部受控后置条件通过后，才签 `controlled-complete`。旧预览与明细卡只渲染 redacted/清除未完成的真实状态，不泄漏已清除字段或显示 `undefined`；已签 receipt 仅按 10 的不可反查假名规则保留，不回填或重写。
- 每个确认点必须可放弃；放弃后不产生任何状态变更，且同一次预览不能再被确认。独立的用户/Agent 请求必须得到“未发生变更”的可观察终态；宿主在同一次 tool 调用内部提供的阻塞选择不是新的 durable 请求，取消成功可以只恢复原结果而不新增会话事件。自然语言先识别整句否定、取消 envelope 与 correction envelope，再解析破坏性意图；整句否定只在否定词位于操作动词之前时成立，位于操作动词之后的理由从句（如“彻底清除 mem-N，我没有备份”）属正文，不得据此把已明确表达的请求整体否掉；“不要把 mem-N 改为…”必须 no-op，“取消删除 mem-N”在有 pending 时只能取消当前 operation，而“把 mem-N 改为『删除 mem-X…』”中的引号内动词/ID 只属于新正文，不得改写目标或路由。旧预览正文是否仍可见、是否原位替换及如何折叠由宿主呈现契约决定。
- 破坏性等级按用户措辞就低不就高：泛化的删除/清除/去掉只进入可恢复的 forget；只有明确不可逆的删除请求才进入 privacy purge；普通恢复进入 restore，明确针对自动更新的撤销进入 rollback。11 的自由文本 adapter 只演示这四条 canonical 路由，不承担通用中文意图分类。它必须守住一个与分类精度无关的硬不变量：在纠正、取消与整句否定 envelope 之后，同一输入若同时含删除动词、未被否定的显式不可逆标记（含 `purge`）和独立的恢复/撤销/回滚方向词，一律返回可观察的冲突终态，要求 owner 只保留一个方向后重述；不得打开任何预览、创建 pending、修改 revision/lifecycle 或签发 receipt。不可逆标记内部的“恢复/撤销”子串不算独立方向，所以 `不可恢复地删除 mem-N`、`不可撤销地删除 mem-N` 仍只能进入 purge；`恢复被彻底删除的 mem-N`、`撤销彻底删除 mem-N` 则不再猜测哪个谓语是最终意图，统一 fail closed。标记只出现在正文或疑问句里不构成破坏性意图。其他开放式复述、词序、附着、中英混用与同义词精度不属于本单页 fixture 的验收面，移交 10 的实现级验收。
- 无法解析为已定义操作的输入必须得到可观察的 Host 终态（说明未识别与可用操作），不得回一句“已处理”之类的 Agent 自述掩盖未执行的事实。
- 每次 owner 变更均返回唯一 receipt；Agent 自述不构成成功证据。receipt 是不可变的事件记录，只陈述当时发生的变更，不描述会随未来操作变化的“当前状态”，也不得本身成为执行新变更的入口。

### 自动更新提示

- 批次恢复按 08 §27a：activation/event、batch identity 与 host-info outbox 同事务，完整成员/顺序从已提交事件派生；Host state 持久 manifest/unread，重启只补缺投递。没有活动 session 也保留 owner 可查询的批次；被动 notify 或重放不得结算 unread，已读 ack 不因重建丢失。批次仍在投递前被回滚或 forget 时按实际状态展示，不能过滤掉成员后偷偷缩小 manifest。
- candidate、验证通过但尚未晋升、被拒绝的结果不提示，也不进入默认注入；它们只保留在后台状态与审计记录中。
- 低风险自动晋升/修订发生后，在当前响应结束或后台批次完成时合并为一条 Host `Info`；提示不打断、不要求逐条审核，并保留未读状态直到用户看过。主动查询必须结算该批次的未读状态；不可变 batch identity 在多次查看中保持稳定，每个可操作的卡片实例另有唯一 entry identity，二者不得混用，也不得因原位预览暂时替换而复用。selection 等卡内交互状态只存在于其所属卡片实例上，不得再镜像到全局状态供其他卡片读取。
- 批次成员被 privacy purge 全量清除后，该批次是已授权的 redacted 终态，只能渲染为 `Info` 级别的“已按授权清除”，不得报成 manifest 不完整的 `Error`；redacted 标记只能加在真的被清除过成员的批次上，未被清除的批次不得顺带标记；但非 redacted 的空批次仍然无效。
- `Info` 生成时只把 after revision 仍等于 canonical head 且 lifecycle 为 active 的条目计为“已启用”；历史批次随后可以保留 rolled-back、tombstoned、superseded 或 redacted 终态，但不得继续计为 active。canonical lifecycle 只允许 `candidate|active|superseded|rejected|tombstoned`；首次 activation rollback 的 canonical 结果是无 active head，Host/Info projection 可以用 `inactive` 作为历史显示标签，但不得把它写入 canonical lifecycle。明细把不可变的 event outcome/before/after snapshot 与查询时 canonical lifecycle 分开表示：例如 rollback 后再 forget，事件仍记录“已撤销 r4”，当前 r3 只能标“已忘记”，不能称“现在生效”。
- 从 `Info` 进入撤销时按批次决策：每次自动 revision/activation 在提交事务中即有不可变 update event ID 并归属一个 batch ID；`Info` 使用该 batch 已冻结的完整、有 digest 的有序 event-ID manifest。selection、pending 与确认时 CAS 都绑定 event ID，不得仅按 memory target 查找。update event 的 before/after 必须各自快照完整 canonical head（正文、revision、verification、lifecycle、scope、source）：字段不全的事件一律不可 rollback，CAS 不得因某字段未被快照就跳过该字段的比较，否则无 revision 变化的 scope/source 漂移会被旧事件覆盖回去。历史 before/after 的业务快照与本次预览冻结的当前 `head_event_id` 分开：资格比较使用业务字段，当前 head 事件身份只与本次 preview 冻结值比较，不能要求它等于历史 update event ID；否则连续撤销 B 后再新建预览撤销 A 会被误拒。preview 冻结完整 event payload（含 before/after）及 digest；confirm 必须重验 batch membership/order、event schema/digest 与完整 canonical head，任何成员缺失、重复 target、payload 变化或 identity 不完整均整次 fail closed，不得静默缩小 selection 或使用 live `before`。撤销只覆盖显式标记为自动晋升/修订的事件，owner 手动纠正不属于该入口；eligible 集合为空时不得打开预览，也不得签发覆盖 0 条目标的 receipt。确认成功只追加独立的 revocation identity，不改写原 update event；privacy purge 的授权 redaction 是唯一例外。UI 可多选 event，自然语言可明确列出一个或多个 target，但每个 target 必须唯一解析到同一批次内仍 eligible 的 event；缺失、歧义或跨批次均整批 fail closed。两者都必须完整展示本次选择的差异、一次确认，并由一份 receipt 覆盖全部目标。
- rollback 只把 canonical head 的正文 revision 与语义字段移回被撤销事件的 before 快照，并追加独立 revocation 事件；`head_event_id` 必须指向本次新 revocation，不能回到 before 的旧事件身份。恢复前重验来源、scope、时间与 verification 资格；head 的 previous 指针不得继续指向已撤销的更高 revision，原 update event 本身保持不改写。
- 任何已结算的预览卡（纠正、忘记、恢复、撤销）都不得继续把冻结的快照称作“当前 canonical 内容”：确认后只能写“预览时 canonical 内容（revision rN）”并注明该 revision 已被本次变更取代。已撤销的条目同样不得继续把旧 revision 呈现为 current：结果明细必须标出现在生效的 revision 与已撤销的 revision；可能在静态宿主中继续留存的预览只能写“预览时 head / 本次恢复目标”，不得使用会在确认后变假的“当前”。变更记录是否折叠或隐去由宿主决定（见 14）。
- 冲突、证据不足、跨项目、高影响或不可机器裁决的变更不自动启用，Host 立即显示 `Warning`；写入失败、receipt 缺失或状态未知显示 `Error`；只有确认事务未提交时才能说旧版本继续生效，已提交或 unknown 按 14 的 outcome 规则恢复，不盲目重试。
- 提示级别按风险和结果决定；数量只用于合并展示，不以数量阈值隐藏已启用变更。

### 退

- rollback 只指撤销自动 memory revision/activation：先展示 current/previous 与原因，确认后由 memory owner 移动 pointer 并返回 receipt。自动修订回到 previous head；首次自动 activation 回到“无 active head”，canonical 不新增 `inactive` lifecycle。Host/Info 可将该无 active head 的历史 projection 标作 `inactive`，该标签不进入 memory lifecycle、检索资格或写入 gate。

## Non-goals

- 不定任何宿主的渲染形态、交互控件或点击能力——那是 14 的题目。
- 不新增独立 CLI，不冻结最终 tool schema，也不连接真实模型或数据库。
- 不把复验做成用户步骤；不为模型请求错误或发送状态设计独立工具，运行时错误由 Host 直接显示。
- 不在本票设计通用 Policy/Skill/Code 演化回滚；这些仍是 inert proposal 的独立管线。

## Prototype and acceptance

- 单文件原型：[`../prototypes/11-observability-tools-prototype.html`](../prototypes/11-observability-tools-prototype.html)
- 纯内存 fixture，只回答上述语义是否正确；页面顶部必须声明它演示语义、不代表宿主渲染。
- reviewer 对自由文本路由只核验上述四条 canonical 路由、方向冲突硬不变量及 envelope 隔离；不得以继续生成无界自然语言复述作为 11 的 FAIL 条件。
- 批量自动更新以一条 `Info` 汇总；进入撤销后按批次多选，一次确认产出一份覆盖全部选中目标的 receipt。
- 历史内存 fixture 的 `Warning` 和确定未提交的 `Error` 不改变 current；目标实现必须另外区分已提交后的清理/呈现失败及 unknown outcome，不能据旧 fixture 声称所有 Error 均未变更。`Info`、`Warning`、`Error` 都不是 Agent 自述。
- 每个确认点都有放弃路径，放弃后 canonical 状态不变；并验证 stale head、重复操作、交叠预览、取消后 purge、刷新 rollback 明细、目标解析与跨流程 selection。
- 查看、纠正、forget/恢复、privacy purge、批量撤销自动更新五条流程及上述跨流程检查均符合以上边界后，才写回 verdict 并标记 resolved。
