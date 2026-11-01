# Provider/cache 测量

## 运行入口

```powershell
npm run evidence:provider
npm run evidence:provider -- --repetitions 1 --output artifacts/provider-local
```

默认启动本机 loopback HTTP fixture，不调用外部模型。输出目录必须尚不存在，默认在 `artifacts/provider-<timestamp>/`。`receipt.json` 汇总样本、费用依据、分位数、检查与证据缺口；`observations.jsonl` 在每次 transport 结算时同步追加。三平台 CI 运行同一合成入口并上传产物。

已有明确授权的测试配置与预算时，可运行：

```powershell
npm run evidence:provider -- --scenario real --transport-config C:\test\route.json --pricing C:\test\pricing.json --repetitions 3 --output artifacts/provider-measured
```

`--pricing` 可省略，费用记为 `unknown`。未提供 route 配置的 real 模式产生零发送 `evidence-gap` receipt。配置格式复用 `configuredTransport`，例如：

```json
{
  "provider": "test-provider",
  "model": "test-model",
  "baseUrl": "https://provider.example/v1",
  "authNamespace": "authorized-synthetic-test",
  "credentialEnv": "EULER_TEST_KEY",
  "authorization": "synthetic-test-only",
  "contextWindow": 32000,
  "maxTokens": 1024,
  "budget": {
    "version": "probe-budget@1",
    "contextLimit": 32000,
    "outputReserve": 1024,
    "safetyMargin": 128,
    "maxModelAttempts": 40,
    "maxToolCalls": 30,
    "maxTotalTokens": 1000000,
    "wallClockMs": 120000,
    "toolTimeoutMs": 2000
  }
}
```

这些数值是配置示例，实际调用使用 owner 批准的值。凭据只从指定环境变量解析，不写入测量产物。real 模式先执行既有 transport、ledger、admission、context 和 Historian 前置测试；其命令、退出码、耗时和输出摘要保存在 `prerequisites.json`。失败不发送模型请求。

预算约束整组测量：新 run 只获得扣除前序消耗后的 attempt、tool、token 和 wall-clock 额度。消耗由 Core 账本与 `AgentRun.chargedTokens()` 提供，包含 Core-owned 检索工具；换样本不重置总预算。`Ctrl+C` 取消当前 run，保留已发请求的结果或 unknown。命令退出即停止，不安装后台进程。

## 固定 workload 与请求证据

`fixtures/t23-provider-workload.json` 固定两次顺序 `controlled.echo` 和最终 `T23-OK`，每轮依次运行：

1. `initial`：该轮的首次调用。
2. `repeat`：相同合成输入，另建 run。
3. `p3-change`：首次请求只改变动态尾部，P0/P1 保持相同；这是独立 run 的配对，不声称跨 run 复用逻辑 epoch。
4. `fresh-window`：两个完整工具回合后显式换窗，观测恢复 baseline、window、epoch 和 assembly。

每轮每条件正常产生三个 HTTP attempt；默认三轮。loopback fixture 分 `fixture-off` 和 `fixture-on`，仅服务端返回的 cached token 数量不同，另保留独立 `receiver.jsonl`。真实配置使用 `provider-managed`：现有协议没有 cache on/off 或清空缓存控制，因此 `coldState=unknown`，`initial/repeat` 是调用顺序，不是已证实的冷/热缓存状态。

每个样本保留：

- 实际 HTTP payload、Core neutral request、冻结 assembly 与 durable attempt、完整 run/window/epoch 事件；
- P0/P1 的正文、UTF-8 bytes/hash，以及实际 HTTP JSON 的连续稳定前缀；Core namespace `prefixHash` 与 wire prefix hash 分列；
- 归档与 SQLite 的合成 source snapshot、原始引用和输出；
- 首个可判定完整输出的 hash、时间及正确性，全部失败与未执行样本数；
- 实现 commit、dirty 标记、相关源码逐文件 hash、fixture/config digest、系统环境及证据文件 hash。

同一 epoch 的实际 wire prefix 必须逐字节一致；每个已观察的发送与账本按 attempt ID、payload hash 和字节长度对应。HTTP transport 不跟随重定向、不隐式重试；断流保留 `unknown-sent`，测量不盲目补发。首个失败停止后续样本，已有失败不会从统计中删除。

## 指标与费用

- `totalMs`：持久发送批准返回后，到完整响应校验结束的单调时钟耗时；不含前置测试与后续 Core/tool 执行。
- `firstByteMs`：首次收到 HTTP body bytes；未收到为 `unknown`。
- `ttftMs=unsupported`：现有请求为 `stream:false`，不能把首字节或完整响应耗时当作首 token 时间。
- `input/output/cacheRead`：只读取有限非负整数的 `prompt_tokens`、`completion_tokens`、`prompt_tokens_details.cached_tokens`。合法响应未提供字段为 `unsupported`，非法字段或未获得可解析 usage 为 `unknown`；cacheRead 不得超过 input。cacheWrite 未适配，记 `unsupported`。
- 返回型号只保存有界字段的 hash。远端正文、额外 role/instructions 字段不成为配置或权限。

费用表格式：

```json
{
  "schema": "provider-pricing@1",
  "provider": "test-provider",
  "model": "test-model",
  "currency": "USD",
  "inputPerMillion": 2,
  "outputPerMillion": 6,
  "cacheReadPerMillion": 0.5,
  "inputAccounting": "includes-cache-read-no-separate-write",
  "source": "https://provider.example/pricing",
  "asOf": "2026-01-01"
}
```

provider/model 必须匹配实际配置。该记账口径要求 input 包含 cache read，且没有另计的 cache write 费用；不适用的 provider 不使用这张表。费用为 `((input-cacheRead)×inputRate + cacheRead×cacheRate + output×outputRate)/1e6`。依据是注明来源和日期的 operator price schedule，不冒充 provider 账单；缺 usage/价格时费用保持 unknown，不能使用 Model 的零成本默认值。

统计按 cache condition 与 workload condition 分组，所有发送（含失败）计算 nearest-rank p50/p95/p99，逐项列样本数、缺失 usage 数、token 合计及已知费用小计。少于 20 个 workload 样本明确标记尾部分位数证据不足。

## 验收范围

`provider-measurement.test.ts` 从落盘 payload、neutral request、ledger 与文件 digest 独立复算，覆盖费用算例、前置失败零发送、整组预算、错误/断流，以及 fixture cache on/off 下的 scope 和 capability 拒绝。`model-transport.test.ts` 覆盖真实本机 HTTP 边界、usage 缺失/非法字段和无隐藏重试。已有 context/Historian/ledger 测试继续负责对应 Core 生命周期。

`syntheticPassed` 只判定固定 loopback workload。`provider-cache@v1` 的总体 verdict 保留 `evidence-gap`，并列出尚无实际样本的部分：真实 provider/cache/成本时延、cache 控制和冷缓存重置、真实中断/同 payload 重试、provider/model/route/auth namespace 变更配对、固定 tool binding 之外的 schema/order 变更，以及 Historian/指令生命周期的 wire 配对。这些缺口不被本机耗时或既有源码覆盖代替。

本入口仅使用新建合成 sandbox，不读取 MC、真实用户数据或更改 credential/owner；不产生 D7.5 的 MC control baseline 和 T27 cutover 阈值。首次组合验收仍由 T24 汇合。
