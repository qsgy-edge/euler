# T24 检索开发实验索引

核对日期：2026-11-12。当前结论：明确依赖历史的具体简单写作场景在两个新会话中完成了检索和正确作答；完整给出格式的一次观察直接答对。原模糊写作请求的检索必要性未明确，不能仅凭隐藏落款缺失判定漏掉了必要检索。详见 [已确认策略](../architecture/memory-retrieval-policy-proposal.md) 与 [验收计划](t24-retrieval-acceptance-plan.md)。

## Pi 行为调查背景

本轮只读调查的安装版本为 Pi 1.5.2、Magic Context 0.49.52。插件通过运行时 `sections.magic_context` 向实际系统提示加入检索使用指导，工具描述也提供用途与查询示例；仅查看主提示词文件会漏掉这些运行时内容。对应已读实现为包内 `dist/index.js` 的系统 section／auto-search 路径及 `dist/index-cc73przv.js` 的指导和工具描述。

已检查的两个实际回合均调用 `ctx_search`，对应自动 hint 决策均为 `no-hint`，原因分别为 `too-short`、`below-threshold`。因此主动检索确实出现在无当次自动 hint 的回合；最初直接将其归因于自动 hint 的解释需要收窄。插件指导、任务的历史依赖与模型差异各自的贡献尚未分离。样本使用 goodlucky / gpt-6-astra / Responses，与 Euler 开发实验不同；未重建完整历史请求或归因既有 M0/M1 状态。

本节只记录机制与聚合观察，不复制私有会话正文，也不计作 T24 独立验收证据。检索使用指导属于工具说明；记忆正文是否实际送达仍需分别检查请求内容。

## 证据身份与额度

本轮代码基线为 `8a90e54eb0d540690a750238121db77e9d17e926`；未改产品代码。使用 disposable 合成数据、独立会话、官方 Euler 工具描述及实际 CLI/AgentRun。实验脚本和原件位于本机 `artifacts/`，该目录不随 Git 文档分发；应按下列相对路径在原工作区复核，不能仅靠本文恢复原始请求或数据库。

原 `13f2015` 的 B3 轮次另有 **18/18** 次额度与原件，见 [既有 B3 报告](t24-first-cli-acceptance.md)。下表是随后单独批准的 **新 18 次**，两轮不混计。

| 新额度分组 | 请求数 | 结果 | 本机原件 |
|---|---:|---|---|
| goodlucky / gpt-6.1-sol 初次与一次重试 | 2 | 两次 HTTP 503，无模型行为结果 | `artifacts/t24-system-search-8a90e54/audit.json`；`real/`、`real-retry-1/` |
| mistral-vibe / deepseek-v4-1-flash-1017 直连 | 1 | ETIMEDOUT，未收到 HTTP 响应 | `artifacts/t24-system-search-mistral-8a90e54/real/implicit-project-convention-A/wire.jsonl` |
| 新模型三组 A/B 配对 | 10 | 全部 HTTP 200，6 个实验臂完成 | `artifacts/t24-system-search-mistral-8a90e54/audit.json`；`real-proxy/` |
| 历史依赖／完整给格式对照 | 3 | 两个条件分别用 2／1 次完成 | `artifacts/t24-history-dependency-8a90e54/audit.json`；`real/` |
| 历史依赖同题复测 | 2 | 新会话首轮检索，第二请求完成 | `artifacts/t24-history-replication-8a90e54/audit.json`；`real/` |
| **合计** | **18** | **15 次 HTTP 200，3 次传输失败；余额 0** | 共享槽位 `artifacts/t24-system-search-8a90e54/real/slot-1.json` 至 `slot-18.json` |

早期 audit 的余额是阶段快照，不能累加。provider/model 切换经用户明确指定；模型上限保持每次输出 1024 tokens，请求参数 high。Mistral 成功路径使用本机既有环境代理；没有修改 Pi 或宿主配置。凭据仅在进程内从既有 Pi 配置指向的凭据助手加载，原件不保存凭据值。

Mistral 配置 API 名为 `mistral-conversations`，实际 wire endpoint 为 `/v1/chat/completions`。实验使用非流式请求及本地响应适配器，保留可见文本和工具调用、跳过 thinking 块；不是完整 Pi runtime 复现。HTTP 200 响应的报告模型均与所请求模型匹配；high 是发送参数，未据此断言供应商内部执行方式。

## 已观察结果

A 为原系统策略；B 只增加“当已有项目约定、决定或偏好可能影响结果时检索；自包含任务跳过”的系统指导。两者均没有普通记忆预取、自动 hint 或强制 tool choice。

| 场景 | 观察 | 结论强度 |
|---|---|---|
| 原模糊维护通报题 | A/B 均 1 请求、0 工具、未写隐藏落款 | 本次未观察到新增指导改善；题目历史依赖有歧义，不推广为必要检索缺陷或“指导无效” |
| 明确问既有落款 | A/B 首轮均含 memory.search，均正确区分桤湾/青砚与桤港/白帆；随后 source.expand 各失败一次 | 记忆识别与答案内容已观察；原始来源核验未完成 |
| 单词排序 | A/B 各 1 请求，正确且无检索 | 本次自包含控制成立 |
| 格式完整给出的简单写作 | B，1 请求，0 工具，正确两行正文 | 单次观察可直接完成 |
| 沿用历史格式的简单写作 | B，2 次新会话各 2 请求，均首轮 memory.search 与项目 source.search，最终两行正文正确 | 具体场景可复现；未估计长期可靠性，也未分离 B 指导贡献 |

历史依赖题新增了已发布的上一则通报及对应历史决定，两种新条件拥有相同数据。新对照只有 user 请求不同；与更早模糊题的比较是解释性对照，不能写成严格的三条件实验。

历史依赖两次首请求逐字节相同，SHA-256 为 `243ae82d0d8041835a77dc270b837a042ec952e66361642725e8f67bfb71903f`。第二次多了一次 session source.search，工具路径并非完全固定。原上限 3、本次上限 2，两次均在第二请求以正常 stop 完成，没有预算截断。

三组配对与后续诊断均检查了实际请求 hash／字节数与 assembly/attempt 的对应。成功请求未出现输出截断。TTFT 在该非流式路径为 unsupported；未完成 X-14 缓存／成本／延迟配对，不从返回的 cache token 数单独推断策略效果。

## 来源标识与展开

旧明确落款题的工具归档位于两臂 `input.json` 指向的 sandbox `session.jsonl`，只需读取可见 assistant calls 与 tool 事件：

- A 将 `memory.search` 返回的 memory recordId 作为 `source.expand.unitId`；该分支查 published source/proposal，返回 `source-scope-mismatch`。
- B 将 seed 的另会话 eventId 交给 `source.expand.eventId`；模型工具从当前 archive lookup，返回 `source-evidence-gap`。
- 上述旧实现的模型工具仅有 eventId/unitId，Core 已有 recordId 展开。PR #65 将合格记忆的 `recordId` 展开和命中后精确原文预取接入普通 CLI，开发组合结果见 [gate 报告](t24-first-cli-acceptance.md#pr-65-合并基线的组合验证)。

新历史 fixture 通过既有 `publishSourceUnit` 发布项目来源；`artifacts/t24-history-dependency-8a90e54/offline-xDiZ6e/receipt.json` 验证 project search→published unit expand→答案、memory search→答案、直接回答三条离线链。离线模型回复为 mock，外部请求为 0。两次真实历史写作都使用搜索内容，没有调用 source.expand。

## G1 项目规则对照

受测 head `248e5db57688da1711cf51432c73a890ded9a44a`，tree `9c21dbcdf0d7d4cb42c33833cca33e445b6aabc9`。独立于前两轮各 18 次请求，G1 获批 4 次上限，每臂最多 2 次。两臂各用一次请求，均 HTTP 200、`received/completed`，工具调用为 0。沿用 `mistral-vibe / deepseek-v4-1-flash-1017` 和输出上限 1024 tokens，实际发送参数 `reasoning_effort=high`。

| 场景 | 请求与回答 |
|---|---|
| 已绑定项目 | system 中含已发布规则。回答严格两行，正确表达巡检完成并使用固定签收灯 |
| 未绑定且持任务只读 grant | 请求无项目规则。回答表达巡检完成，另加输入未提供的巡检范围和归档事实 |

两臂的文件 capability 和 `file.read/write` 工具集也有差异，无法单独归因到 guidance。真实原件为 `artifacts/t24-b3-next-plan/run-real-2026-11-12T08-28-10-611Z-68aece7a/`。只读复核匹配 5 份脚本／计划摘要、2 个槽位以及请求的 6570／4108 bytes 和响应的 1010／3370 bytes。离线演练 `run-offline-2026-11-12T08-20-28-736Z-f0c39a7f` 的 3 次 loopback 单列。

## G4 未发布原文离线演练

在 PR #65 合并 `c9e4e7b` 的 Windows 普通 CLI 上，用冻结的 G4 中文输入完成三次 Mistral 格式 loopback。旧会话存原文及简写记忆，发布来源数为 0。新会话绑定同项目后依次检索、用 `recordId` 显式展开、给出逐字引文和实际 locator／contentHash。首请求无原文，检索返回的记忆正文无完整引文，最终冻结请求带 108 bytes 原文。只读复核匹配 4 份脚本／计划摘要、6 份 wire 摘要，三次请求的 6008／9985／13179 bytes 与 JSON、SQLite 的 attempt 和 assembly 一致。原件在 `artifacts/t24-b3-g4-preflight/run-2026-11-12T09-18-03-242Z-bbe54633/`，真实 provider 请求数为 0。模型是否会主动检索并准确引用仍待真实 G4。

## B5：本轮独立取证

原件目录为 `C:/Users/17945/AppData/Local/Temp/euler-t24-b5-restore-e5ca065e7db34a998e091e4c15b489ee/`。`run.json` 固定 head `c3a69938ce1067237c92b4ddc0c9c8cb6ae2b53a`、tree `dea761341c85b5a1b61b687eaa8fb4d72a9adb23`，仅运行 database restore 用例，次数上限 3。该身份与上方模型实验基线分列。

三份 `attempt-N/test.log` 均为 1 pass / 0 fail / 0 cancelled；三份 `maintenance.jsonl` 均为 `acquired: true`、`participantCount: 2`、`residualCount: 8`。参与者／残留数是 probe 的观测字段，acquired=true 的运行没有提供原失败的拒绝判定。没有找回首次被清理的 sandbox，本轮不关闭 B5。

所有记录均为开发／取证证据。未读取 held-out 标准答案、未重跑独立集、未启用第三套题；B3/B4/B5 仍按现行 gate 保持开放。
