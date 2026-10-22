# Batch rollback from durable Info

Issue: [#17](https://github.com/qsgy-edge/euler/issues/17). This implementation changes CLI behavior, Core mutation gates and required checks; delivery uses a feature branch and PR. The governing contracts are I15–I17, Ticket 11/14 rollback and X-09/X-10/X-11. All data is synthetic. It reuses disposable schema 19 and existing carriers without migration.

## CLI entry

Start `node apps/cli/src/main.ts remember --sandbox <root>` with a synthetic sandbox containing automatic updates. Open an Info batch to get its stable batch ID and update event IDs, then list the exact events to undo. Each command is a separate live stdin event.

```text
info
info <batchId>
rollback <batchId> <eventId-1> <eventId-2>
commit <preview-token> rollback
replay <preview-token>
info <batchId>
stop
```

`cancel <preview-token>` cancels the entire selection. A new rollback command creates an independent presentation and token, explicitly superseding the session's previous pending operation. Selection is resolved only within the supplied fixed Info manifest; empty, duplicate, missing or cross-batch members return `invalid_identity`. A no-longer-matching update returns `stale`; integrity/persistence failures return `error`. The existing batch limit is 32; the CLI does not require a rich multiselect component or a new capture run.

The full preview includes the batch payload/digest, exact selected update event IDs, preview-time head snapshots and reserved revocation event IDs. Its `selected` rows display each historical update's complete before/after and the historical snapshot to restore. The old snapshot's head identity is historical; the committed restored head uses the separately displayed new revocation identity. The owner approves all selected members once. Buffered approval received before full output, fabricated input, missing token, mismatched operation and substituted model selection cannot authorize it.

## Atomic mutation and history

Commit rechecks the fixed batch bytes, member order and event integrity, every selected current head, and the historical restoration target's current source/scope/verification/time eligibility in the existing transaction. A stale or corrupt selected member settles the entire operation as stale. Its frozen selection remains readable and the paired owner terminal entry explicitly requires reselection. A failure while writing any member rolls back every member, outbox and receipt. No selection is silently reduced or retried.

Only explicitly automatic activation/revision events qualify. Owner correction is excluded. Rollback reuses the historical body revision and business fields, appends a new revocation and receipt, and updates the head to the new event. First activation returns to `candidate` with no active head; `inactive` is never a canonical lifecycle. After B is undone, a fresh preview can undo A when its business snapshot is eligible. An earlier A preview remains stale because its frozen head identity changed.

`batch-rollback-receipt@1` is the single owner-facing aggregate of the canonical member receipts committed under one operation ID. It contains every selected update ID, revocation ID and full before/after, with a digest of that complete ordered payload. It is derived and validated against immutable `memory_events`; it introduces no second receipt store. Later changes do not rewrite it. The existing Info manifest/unread state likewise remains unchanged; expanded Info shows historical event outcomes separately from query-time current state.

Frozen rollback presentations can still be read when later canonical batch/event damage prevents submission. Live integrity checking belongs to the commit transaction; reading an old presentation does not grant eligibility. New selection still requires an intact batch. Authorized purge/redaction is owned by T21/T22 and is not implemented here.

## Delivery and model integration

Rollback shares `MemoryCorrections`, `CorrectionHost`, the live-input capability and the existing owner/model delivery recovery. Restart replays the same pending presentation or delivers a committed result; it does not repeat the mutation. A stale card stays settled. One card's successful members never become a global exemption for other cards, and remaining members require an explicit new selection.

The model tool schema exposes `memory.preview` with `operation=rollback`, `batchId` and exact `eventIds`, then `memory.commit` with the returned token and `operation=rollback`. Core compares the complete tool intent with the originating live command after the complete model response is archived. The existing configured synthetic transport and prerequisite gate apply; no external provider is chosen automatically.

The bounded `memory-operation-summary@1` keeps rollback's total `recordCount` and every selected record ID, revision ID/number, lifecycle and verification state. Rollback fixes an 8,192-byte limit for at most 32 metadata rows; correction/forget/restore retain their 2,048-byte limit. No selected identity is truncated. If a failed/cancelled operation has no observed current snapshot for a member, its ID remains present and its state fields are explicitly null. The full owner preview and aggregate receipt retain all canonical detail. No body, source, batch payload or receipt enters the summary. Actual request/context/token budgets are unchanged and are still checked against the complete payload before dispatch.

## Reproduce and evidence limits

```powershell
node --test --test-concurrency=1 apps/cli/test/memory-rollback.test.ts apps/cli/test/memory-rollback-cli.test.ts apps/cli/test/memory-rollback-crash.test.ts
npm run check
npm run evidence:memory-rollback
```

`fixtures/t17-batch-rollback.json` fixes all/subset/cancel/concurrent-change/post-commit-crash/32-member scenarios. The runner retains actual CLI stdout/stderr and exit/signal, original SQLite/JSONL artifacts and digests under `artifacts/t17-*/`. It independently checks manifest bytes/order, revision reuse, event/head/receipt chains, one live approval, immutable complete aggregate receipts, owner/model delivery, every selected identity in the actual next request, Info read state and restart retrieval. Failed cases retain diagnostics and raw artifacts. The receipt records implementation commit/tree, dirty state, OS/Node/SQLite and adapter versions, explicitly inapplicable provider/model versions for the local counting transport, fixture digest and individual case verdicts.

Regular tests additionally cover fabricated/buffered approval, wrong selection, overlapping cards and sessions, stale ABA heads, continuous B/A rollback, source/expiry failures, missing/incomplete/duplicate/reordered batch evidence, last-member transactional failure, the 32-member summary and six real CLI SIGKILL boundaries. The configured HTTP tests cover accepted/rejected prerequisite receipts, exact model intent, post-commit lookup recovery and cancellation. They use the shared prerequisite-process fixture for protocol isolation; the complete prerequisite suite remains covered by the existing cooperative integration test and full suite.

CI runs checks and retains separate evidence on Windows, macOS and Linux. A local receipt covers only its recorded OS. `syntheticPassed` is separate from overall `evidence-gap`: actual-provider semantic quality and long-session behavior, source append crash/unknown outcomes (#38), irreversible purge (T21/T22), non-CLI hosts and production data/migration remain unverified. The existing formal spec already defines this feature; tests and the CI evidence command extend its existing harness.
