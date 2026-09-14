# T06 — Synthetic request ledger and recovery

This slice implements GitHub issue #6 for the disposable CLI and local counting transport. It does not enable a real provider or Pi transport.

## Durable behavior

`request_runs` records authorization, owner/stream/epoch, budget and the optional previous run. `request_assemblies` records immutable request identity; `request_events` retains assembly, started, finished and recovery facts. Payload text stays in the source archive and transport, outside the ledger.

Assembly commit precedes started commit; transport runs after both. A missing started fact means `not-dispatched`. Started without finished remains `unknown-sent`, including when the receiver actually received the request but the sender died before committing its receipt.

Admission checks the intent, source references, epoch, authorized request budget and request identity in the started transaction. A second connection may revoke after that transaction; the sender rechecks observable cancellation before calling transport. A revoke before admission leaves no attempt; a revoke after admission but before sending records `cancelled-before-send`. A source removed during transport prevents a late result from settling the attempt.

## Recovery

Opening diagnostics registers the Host activity without authorizing a new model run. An unknown request blocks unlinked new work and previously opened runs in the same principal/project, including another session. This is a conservative gate for the synthetic Host, which has no narrower operation identity.

The owner can append a reconciliation outcome and an evidence hash. This is Host-provided evidence, not a model claim or an automatically queried remote provider. The old attempt stays `unknown-sent`; the reconciliation is a separate event. Evidence of `not-received` permits a linked successor without duplicate-risk approval. Evidence of receipt, or an unqueryable attempt, requires explicit acceptance of the risk before repeating work.

A successor requires the old run to be sealed, intact evidence, valid source references, a fresh authorization/budget and a durable `relatedRunId`. Each old run has at most one authorized recovery successor. An unknown in the successor blocks further work again.

A restored snapshot cannot reveal facts that were absent from the snapshot. The Host must mark the affected run with `request-gap` before reopening work. The gap remains durable and blocks the old run; linked new work requires explicit duplicate-risk acceptance. This is the request-side recovery gate, not a backup/restore orchestrator.

Closing seals a run without rewriting its attempt outcomes. Failed cancellation writes are reported; they do not become a successful cancellation receipt.

## CLI commands

Use only a disposable sandbox created by `node apps/cli/src/main.ts create`.

```powershell
node apps/cli/src/main.ts request-status --sandbox <root> --request <run-id>
node apps/cli/src/main.ts request-seal --sandbox <root> --request <run-id>
node apps/cli/src/main.ts request-reconcile --sandbox <root> --request <run-id> --attempt <attempt-id> --outcome not-received --receipt-hash <sha256>
node apps/cli/src/main.ts request-resume --sandbox <root> --request <run-id>
# Required when repeating a received/unqueryable request, or after a snapshot gap:
node apps/cli/src/main.ts request-resume --sandbox <root> --request <run-id> --accept-duplicate-risk
# After restoring a snapshot, before reopening work:
node apps/cli/src/main.ts request-gap --sandbox <root> --request <run-id>
```

`request-resume` uses the prior assembly's source input, revalidates it and sends it in the newly linked synthetic run. Reconciliation does not automatically send anything.

## Reproducible checks

```powershell
npm run check
node --test apps/cli/test/request-crash.test.ts apps/cli/test/request-recovery.test.ts apps/cli/test/request-integrity.test.ts
npm run evidence
npm run evidence:maintenance
npm run evidence:persistence
```

| Requirement | Evidence |
|---|---|
| Ordered barriers and normal send | `request-crash.test.ts`: real child-process termination before/after assembly, started and finished COMMIT, after receiver persistence, plus normal control; repeated for session/job/migration |
| Independent send count and state reconstruction | Raw SQLite rows, event hashes and a separately fsynced receiver JSONL; `PRAGMA quick_check` and FK validation after process exit |
| Revoke ordering | Two SQLite connections: revoke first versus revoke immediately after the outer started COMMIT; send count is zero in both cancellation cases |
| No unknown blind retry | Same-run, unlinked new-run and cross-session negative tests; linked recovery positive tests |
| Source loss / integrity | Late transport result after source removal; corrupted assembly with and without a recomputed identity hash; admission and diagnostics reject damaged canonical facts |
| Snapshot gap | Real SQLite backup before started, later attempt, restore of the older bytes, durable gap declaration, blocked old run and explicitly authorized linked successor |
| Host recovery | Separate CLI processes run status, reject unapproved repetition and perform approved linked recovery |
| Maintenance boundary | Maintenance fences activities before/after started; late settlement is refused and unknown survives. The current maintenance coordinator has no model transport; no maintenance-owned send is claimed |

Crash tests save raw per-case JSON under `artifacts/t06-crash-<platform>-<timestamp>/` and print each artifact path/hash, fixture digest, runtime and observed outcomes. `npm run check` runs these same OS-process tests in the existing Windows/macOS/Linux CI jobs. Results describe those runner environments, not power-loss durability or an end user's filesystem.

The existing T01/T03/T04 evidence scripts remain regression checks for their original scopes. They do not substitute for the T06 raw crash records. Physical privacy purge, complete backup orchestration, real provider reconciliation and provider telemetry remain outside this synthetic transport slice.
