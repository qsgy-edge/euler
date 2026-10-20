# Owner correction and result recovery

Issue: [#15](https://github.com/qsgy-edge/euler/issues/15). This implementation uses a feature branch and PR because it changes CLI behavior, Core admission and durable state. It implements I15–I17 and the Correct contract using synthetic data and disposable schema 18. Older sandboxes are rejected; no production migration is provided.

## Use the CLI

Start `node apps/cli/src/main.ts remember --sandbox <root>` with an existing synthetic sandbox. Enter `记住偏好：使用 npm` and use the returned `recordId` below. Each command is a separate live stdin line:

```text
inspect <recordId>
source <recordId>
ask 使用 npm
correct <recordId> "使用 pnpm"
commit <token-from-preview> "使用 pnpm"
replay <token-from-preview>
used <assemblyId-from-ask> <recordId>
stop
```

`inspect` shows the complete current snapshot; `source` expands its immutable source. `used` reads the exact snapshot selected by that assembly, including its original source and digest. It does not replace the previous answer's evidence with the current head. Missing selection or evidence fails closed.

`correct` accepts a JSON string as the actual new body; `把 <recordId> 改为「正文」` is also supported. The preview includes full before/after text, diff, scope/source/revision/lifecycle/verification, head event, opaque token and any superseded operation ID. `cancel <token>` settles that preview. An empty or trim/NFC-equivalent body is a no-op. Open-language questions and uncertain directions request clarification; opposing destructive/restoration directions report conflict. They create no mutation pending.

Approval is `commit <token> <JSON-string>` with the exact previewed body. A bare yes, a token without a body, or different text cannot approve. Input must arrive after the complete preview was output. Buffered input received earlier is ineligible even if processed later. Restart redisplays a pending preview and requires a new live input. There is one durable pending per session, no TTL and no automatic retry after stale CAS. A new preview identifies the superseded operation. Tombstoned records require a separate restore operation before correction; this entry does not restore them.

## Canonical change and delivery

The Host archives actual input and captures an in-process live-input capability in its stdin callback. Core checks the archived user role, exact command, displayed token and optional structured model intent. Historical archive records or fabricated input handles cannot create that capability. Full snapshot/head/manifest CAS, revision/event/search outbox/receipt and reverification job registration commit in one transaction. A queue failure rolls back the correction. The lower-level synthetic Store primitives retain their existing explicit test use.

A committed correction preserves lifecycle, creates one new revision marked `unverified`, and queues independent reverification. The result says `verification: queued`; the immutable receipt claims only the committed modification. Unverified content is excluded from normal memory injection. The user need not wait for background extraction or verification to finish.

Owner result and receipt remain immutable in the existing operation/event store. `host_operation_delivery` records monotonic owner output acknowledgement, the exact approval source and a stable model-summary event identity. Recovery reads canonical operation/receipt first and fills missing delivery; it never redoes the mutation. Unknown outcomes stay unknown if canonical lookup fails. Output failure after commit reports an error with the known canonical outcome and blocks the next dispatch until both delivery planes recover. The CLI owner can replay full results by token after restart.

The model plane is `memory-operation-summary@1`, limited to 2,048 UTF-8 bytes. Fields are `schema`, `operationId`, `kind`, `status`, `records` and a bounded diagnostic `reason`. Each record contains only `recordId`, `revisionId`, `revision`, `lifecycle` and `verification`. No canonical body, source locator, owner receipt or token is copied into this summary. Probe/AgentRun assemblies include the durable summaries and their source identities so the next model request can stop using the previous state. A reused summary identity must match its original archived bytes.

## Controlled model path

Start `remember --sandbox <root> --transport-config <test-transport.json>` and prefix a command with `model ` to ask the configured model for structured tool intent. The configuration is the existing [controlled transport configuration](t13-capture-verification.md), with `authorization: "synthetic-test-only"`, explicit provider/model/route/credential environment variable and budget. Foreground transport prerequisites and correction tests run before the first send. No route or credentials are guessed; absent configuration returns `memory-model-evidence-gap` with zero sends.

`memory.inspect`, `memory.preview`, `memory.commit` and `memory.cancel` are enabled only for this authorized Core run. `replay` remains a direct Host command. `stop` immediately cancels an outstanding model request; late output cannot execute another tool. The Host/Core gate compares the entire structured intent with the original explicit input, including exact target/token/body and allowed keys. An extra `confirm` field grants nothing. Tool execution starts only after the complete model response is archived. The model cannot turn a question into permission to modify a record.

## Reproduce and evidence limits

```powershell
npm run check
npm run evidence:memory-correction
```

`fixtures/t15-owner-correction.json` fixes the synthetic text, summary bound and retained cases. The runner saves actual subprocess stdout/stderr/exit/signal and closed raw sandbox snapshots under `artifacts/t15-*/`. It independently checks archive hashes and roles, event chains, revisions, immutable receipt bytes, approval, model-summary bytes and the matching reverification job. Its receipt records implementation commit, dirty state, platform/Node version, fixture digest, artifact hashes and positive/negative verdicts. Raw snapshots are evidence copies with their original identities, not relocated live sandboxes.

The retained cases cover no-op, supersession, cancellation, commit, duplicate submission, actual-used history, restart replay and process death after commit. The normal test suite additionally covers tombstones, forget-after-preview, queue-insert rollback, complete intent matching, historical/fabricated/early/late input, first-output failure, independent owner/model delivery failures, unknown-ack reconciliation, concurrent stale heads, six SIGKILL boundaries and the actual CLI/AgentRun/HTTP loop against a loopback fixture server.

Each CI platform generates its own artifact. A Windows receipt provides Windows evidence only. Controlled HTTP demonstrates transport and tool wiring; actual external-provider semantic quality remains an explicit evidence gap until a separately authorized route and budget are supplied. Pi and other Host integration, real user data, MC access, live owner switching and production migration remain outside this ticket.
