# T12: explicit owner memory fast lane and durable Host Info (synthetic)

Issue: [#12](https://github.com/qsgy-edge/euler/issues/12). This slice uses only disposable SQLite, synthetic CLI archives and the local counting transport. The disposable schema is version 14; there is no production migration or live owner switch.

## Owner statement grammar

The fast lane accepts only explicit, typed owner wording. Core re-parses the durable archive bytes itself; a Host or model cannot supply the type, content, owner, scope, source or verification state.

- Owner statement (`user` event): the whole event text is `记住偏好：<content>`, `记住决定：<content>` or `记住事实：<content>` (ASCII `:` is also accepted). The content is the verbatim remainder.
- Assistant proposal (`assistant` event): exactly one line of the text is `建议记住偏好：<content>` / `建议记住决定：<content>` / `建议记住事实：<content>`. Other lines are free text and never become memory fields.
- Owner agreement (`user` event): `{"schema":"owner-agreement@1","text":"同意","proposal":<assistant SourceAck>}`. The Host resolves the proposal as the event immediately preceding the owner's `同意`/`agree` in the same session archive; Core re-reads the referenced assistant event and uses `[proposal, agreement]` as the durable source range.

An untyped `记住：…` is archived and immediately gets an idempotent `pending` capture job (`needs-input`, `memory-type-required`). The job retains source range, owner and scope without inventing a typed memory record. Restart backfills missing jobs and surfaces the same pending reason; semantic extraction/processing belongs to the normal Proposer lane (T13). Other text is rejected as command syntax, with the accepted forms displayed; this carrier is not a free-text chat interface.

## Store contract

`ProbeStore.rememberMemory(activity, { input, hostInfo, noActiveProject? })` is the only fast-lane entry. Unknown request keys (for example a model hint carrying `ownerId`, `source`, `scope`, `type`, `verification`) are rejected before any write. In one transaction it captures (`candidate + unverified`, idempotent by source identity), runs the deterministic `owner-fast-lane@1` verification, and, when eligible, activates. Activation, the fixed one-member batch manifest/digest, the `host-info` outbox job and the search outbox job commit together; any failure rolls the whole call back.

- `preference`/`decision` from an explicit owner statement or agreement: verification `pass`, evidence = the source range.
- `fact`: verification `evidence-gap`, reason `objective-fact-authority-required`; the owner's statement or approval is not an authoritative source.
- No active project (`noActiveProject`): the candidate stays in the current session's unresolved queue (`scope-unresolved`), no verification, no cross-session retrieval.
- `hostInfo: 'unavailable'`: verification may pass, but activation is refused (`host-info-unavailable`); a later call with a durable Host resumes it.
- A matching active claim (`claim-already-active`) appends the new source range as provenance, without a second record, activation or batch; replay is idempotent even after later owner changes. A tombstoned claim stays suppressed (`memory-suppressed`).
- Restart resumes only a fast-lane capture/verify head. A later rollback/correct/forget or another lane's event returns `no_op` (`later-memory-change`); identity checks use the immutable captured claim, not subsequently corrected content.

Verification runs record `verifier` and a `reason`. Repeated calls reuse the stored fast-lane run; they do not re-verify a blocked candidate. Scope blocks are derived from persisted unresolved scope; the durable verified fast-lane head can resume when Host Info becomes available.

`host_info_batches` is the Host-owned durable Info state: frozen manifest digest copied from `activation_batches`, `pending -> delivered` and `unread -> read` only, guarded by triggers. `registerHostInfo` is an idempotent consumer keyed by batch ID; `recordHostInfoDelivery` records the durable owner entry; `acknowledgeHostInfo` settles read only after delivery. `readHostInfo` returns the frozen manifest plus each member's current canonical state, so later forget/correct shows real history without rewriting the batch.

The existing `host_presentations` table is session/branch/token-bound approval state for inspect/mutation operations. Info is owner-scoped and must exist without a presenting session, so its monotonic delivery/read state uses `host_info_batches` in the same Host-owned SQLite boundary rather than borrowing another session's approval presentation. Registration uses fixed chunks of 32; the Host finishes registration/delivery before dispatch. The legacy `memory`/`memory-worker` commands remain synthetic store test harnesses, not owner automatic-update modes; their outbox batches are queryable through `info`.

`pinnedMemoryDelta` returns a bounded set (≤16) of eligible records whose search job has not been processed; it lets the next synthetic question use a new memory before the index drains. Search itself keeps reporting `dirty/index-lag` until then.

## CLI

`remember --sandbox <dir> [--host-info unavailable] [--no-active-project] [--synthetic-proposals]` runs an owner session over stdin. Commands: an owner statement, `propose <text>` (only with explicit `--synthetic-proposals`; a synthetic assistant fixture, not a real model turn), `同意`/`agree`, `取消`/`cancel`, `info`, `info <batchId>`, `ask <question>`, `stop`. The owner-facing Info surface is the append-only `owner-info.jsonl` carrier bound in `sandbox.json`; stdout notices are non-authoritative. `info --sandbox <dir> [--batch <id>]` queries without an agent session.

On start the Host backfills durable owner events whose capture was lost (idempotent by source identity), drains search, and delivers pending Info. Owner-visible results carry `status`, `stage`, `reason`, `level` and `info` (non-store outcomes have null stage/record fields):

- `activated` + `delivered`: committed and durably presented.
- `activated` + `pending-redelivery` (`level: error`): committed, Info registration, owner entry write or delivery-record persistence failed; the batch stays pending and `ask` refuses dispatch (`host-info-recovery-required`) until redelivery succeeds.
- `blocked` (`level: warning`): with a reason such as `objective-fact-authority-required`, `scope-unresolved`, `host-info-unavailable`.
- `error` (`committed: false`): the owner input could not be made durable or verified (for example `file-identity-changed`, `source-evidence-gap`); no canonical change.
- `cancelled` (`owner-declined`), `not-actionable` (`agreement-target-missing`), `needs-input` (`memory-type-required`).

Info notices explicitly label content truncation. `info <batchId>` displays stable update event IDs and complete frozen before/after snapshots separately from query-time current state. Owner entries enforce their 4 MiB cap before appending, so a rejected append does not corrupt the existing carrier.

`ask` selects `ready` search results plus the pinned delta; the model payload carries only `untrusted-memory` content, never batch IDs, digests or owner entry identities.

## Review disposition (baseline `72411cc`)

- Fixed: restart undoing rollback/misreporting correction; duplicate-claim provenance loss; missing immediate untyped capture jobs; incomplete/truncated expanded Info; post-commit registration/delivery errors losing outcome; synthetic proposal input lacking a gate.
- Fixed evidence/robustness findings: failure-path child reaping/root retention, pre-write owner-entry size cap, fixture-wide receipt body checks, model eligibility independently checked against SQLite, receipt shape checks, and inconsistent result fields. Added actual CLI restart/Info observations after Store-driven owner changes. A mutation disabling the replay guard reproduced re-activation; an injected evidence-scenario failure preserved the killed child's logs and raw root.
- Retained boundaries: session-bound approval `host_presentations` is not reused as owner-wide Info state; legacy `memory`/`memory-worker` stay explicitly synthetic harnesses. These choices do not make them new owner-facing automatic-update modes. Normal-mode stdin cannot mint assistant events; the explicit synthetic flag is for fixtures only.
- Consolidated stable duplication (bounded durable append, kill point, Info queries/counts/hints) and removed unused caller options; no general receipt framework or storage rearchitecture was introduced for subjective style findings.

## Reproduce

```powershell
npm run check
npm run evidence:owner-memory
```

The evidence runner drives real CLI processes (a main owner session, a no-session query, a restart, seven SIGKILL points, an Info write failure, a Host without Info and boundary cases), also restarts after Store-driven rollback/correction and queries actual CLI Info (the owner mutation UI belongs to T15–T17), records each process's stdout/stderr/exit/signal, reaps live children and retains every synthetic root even if a scenario fails under `artifacts/t12-*/raw/`, and recomputes its verdict from the raw archive, `owner-info.jsonl`, counting receiver and SQLite rows. Kill points: `crash-before-activation-commit`, `crash-after-activation-commit`, `crash-before-info-append`, `crash-after-info-append`, `crash-after-info-delivery`, `crash-before-info-read`, `crash-after-info-read`.

## Evidence boundary

The receipt status is `evidence-gap`, not `pass`. Unverified and registered in the receipt: Info after logical purge of a member (T21/T22b; closure must include `host_info_batches` and `owner-info.jsonl`), later project confirmation of a session-local candidate (no Host entry), normal-lane processing of pending untyped capture jobs (T13), real provider/model turns and authenticated owner UI, non-CLI Host modes, source append crash/unknown outcomes for the owner statement (#38), and other OS results outside their CI artifacts.
