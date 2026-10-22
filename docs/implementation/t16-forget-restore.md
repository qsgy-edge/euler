# Forget, suppression and independently approved restore

Issue: [#16](https://github.com/qsgy-edge/euler/issues/16). This changes CLI behavior, Core admission, persistent evidence and required checks, so delivery uses a feature branch and PR. The governing contracts are I04/I15–I17 and Ticket 08 §19a. Data is synthetic; disposable schema 19 rejects older sandboxes without migration.

## CLI entry

Start `node apps/cli/src/main.ts remember --sandbox <root>` with an existing synthetic sandbox. Each line below is a new live stdin event. Use the record ID returned by the remember command and the separate token returned by each preview.

```text
记住偏好：本项目使用 pnpm
ask 本项目使用 pnpm
forget <recordId>
commit <forget-token> forget
inspect <recordId>
used <assemblyId-from-ask> <recordId>
restore <recordId>
commit <restore-token> restore
replay <restore-token>
stop
```

Forget displays the complete canonical snapshot and explains that ordinary retrieval/injection stops while history remains. Restore displays its own snapshot and current eligibility. A token alone, a different operation, a historical archived command, fabricated input identity, or an input received before presentation cannot approve either operation. `cancel <token>` rejects the pending operation. Each session has one pending operation; a newer preview supersedes it explicitly. Open language stays not-actionable unless it matches the supported explicit grammar; opposing irreversible deletion and restoration directions report conflict.

Forget retains the revision, source, verification and event history, moves lifecycle to `tombstoned`, and commits its suppression snapshot, new head, search outbox and owner receipt together. Normal search and the next request exclude it even before the projection catches up. `used` still recovers the exact snapshot selected by an earlier assembly.

Restore requires fresh approval and rechecks scope, source/provenance integrity, verification, temporal eligibility and the complete head snapshot at commit. It keeps the original revision and tombstone history, creates a new head and receipt, and releases only that record’s suppression. A forget→restore round trip never revives a previous head or preview. Correct remains blocked on tombstones and becomes available after a successful restore. Restore does not depend on visibility of the old forget receipt.

## Suppression identity

The forget event freezes owner, record/claim identity, logical scope, normalized applicability, revision and head identity, content hash and the complete established source/provenance references, including prior correction revisions and corroborating sessions. Each source reference carries its immutable locator, event/version and raw/content hash. These fields remain inside the existing event and provenance boundary; there is no global hash blacklist.

For the CLI archive, a registered session is the logical source lineage. Capture event IDs and JSONL ranges are versions within that lineage. Physical paths are not caller-provided source identity; archive/resource admission validates the registered canonical path and immutable locator. Known condition aliases such as `cli`/`agent:cli` and `win32`/`platform:win32` compare canonically. Capture, proposed capture, activation and the owner fast lane consult the same suppression evidence. A new capture ID, original or corrected exact body, or another established corroborating session cannot recreate an active record.

An uncertain same-lineage claim remains a candidate with `suppression-identity-evidence-gap`; deterministic owner verification alone cannot establish that a paraphrase differs from a forgotten claim. It can proceed through the existing independently verified ordinary capture/comparison path, or the owner can restore the original record explicitly. Independent distinct claims and independently verified later fact periods retain the existing comparison gates. Different owner/scope/applicability and independent source lineages are not blocked by a global text hash. Arbitrary cross-source semantic copying is outside the guarantee.

The suppression fields are content-associated data and belong to the purge closure: `memory_events` payload/before/after snapshots and receipts, `memory_records.claim_key/source_lineage`, revisions and provenance sources, capture payload/ranges, search/Info outbox copies, presentations/targets/pending results and owner/model delivery sources. T21/T22 own the irreversible manifest, deletion and post-purge verification. Purge is not enabled by this slice; deletion of those references is an explicit evidence gap, not a passed claim.

## Approval and recovery

Forget/restore reuse the existing Core live-input capability, Host presentation and `host_operation_delivery` contract. The bounded `memory-operation-summary@1` includes the operation kind and terminal state without body, source, owner receipt or token. The owner surface retains the full immutable result. Failed delivery after commit preserves the canonical receipt and requires recovery before another dispatch. Restart reconciles canonical state and missing delivery; it never repeats the mutation. A restored lifecycle does not change any earlier receipt.

Configured `model forget …`, `model restore …` and their commit commands use the existing authorized synthetic transport. Tools carry exact `recordId`/`token` and `operation`; correct retains its actual `content` field. Host/Core compare the complete tool intent to the originating live command, after the complete model response is archived. The prerequisite suite includes the correction, forget/restore and suppression tests. Controlled loopback HTTP tests use the shared prerequisite-process fixture; actual external-provider quality requires a separately configured route, credentials and budget.

## Reproduce and evidence limits

```powershell
npm run check
npm run evidence:memory-forget
```

`fixtures/t16-forget-restore.json` fixes the synthetic corpus and retained cases. The runner saves real CLI stdout/stderr/exit/signal and closed SQLite/JSONL snapshots under `artifacts/t16-*/`. It independently recomputes archive/event/source/receipt/summary hashes, checks head and revision history, frozen suppression, same-transaction search outbox, separate approvals and immutable terminal results. The receipt records commit/dirty state, environment, fixture digest, artifact hashes and each case verdict. Normal and post-commit SIGKILL cases cover both forget and restore, plus restart retrieval, duplicate input, same-source suppression, ambiguity and actual-used history.

The regular tests additionally cover correction and cross-session provenance, equivalent applicability, independent distinct claims and later periods, buffered/fabricated approval, denial/cancel, mismatched model intent, cross-session ABA/CAS, transactional outbox failure, current source/verification/time failure, six crash boundaries for each operation and actual CLI/AgentRun/HTTP integration. CI produces separate Windows, macOS and Linux artifacts; a local Windows receipt only covers Windows.

Evidence gaps remain explicit: actual-provider semantic quality and long-session behavior, irreversible purge deletion (T21/T22), non-CLI hosts and production data/migration. Existing correction delivery/unknown-result tests exercise the shared recovery implementation; platform receipts and tests must be read at their recorded commit. The formal spec already defines this behavior; the added tests and CI evidence runner implement its existing harness requirements.
