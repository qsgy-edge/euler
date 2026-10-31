# Controlled cleanup and SQLite completion

Issue: #23. The public boundaries are Core maintenance operations, real CLI input/process restart, and actual controlled files/SQLite bytes.

## Run and resume

```powershell
npm run demo -- memory
npm run demo -- purge --sandbox <sandbox-root> --record <record-id>
# Enter the exact PURGE <token> <nonce> phrase printed with the complete preview.
# After logical-commit, enter:
cleanup

# If cleanup was interrupted or returned an error, exit that coordinator,
# restore the reported resource/permission condition, and resume:
npm run demo -- purge --sandbox <sandbox-root>
# Enter cleanup again. The same committed operation is used without new approval.

npm run evidence:controlled-cleanup
```

`cleanup` runs the source, Info/receiver, project-file and backup owners, removes sensitive recovery references, maintains SQLite, and returns `status=controlled-complete`, `cleanup=complete`. The CLI exits after that result. Running `purge --sandbox` on a completed open store reads the durable completion without acquiring another maintenance fence. Starting another purge requires `--record` and a fresh preview/approval.

`cleanup-source` remains available for the source participant alone; it does not complete the overall purge. Before completion, `status` reports the logical receipt, current phase and independently checked participant results. Failed cleanup steps append immutable `purge/cleanup-incomplete@1` facts in the existing event ledger. Their `failures` list contains only random operation/receipt IDs and the bounded stage, with no raw error text or resource locator; it replays after restart and remains available with the final completion. `cancel` can reopen admission only before logical commit. After commit it reports `settled`; stopping the process leaves the durable cleanup obligation in place.

## Owners and approved inventory

`readPurgeCarriers` and `ProbeStore.purgeResources` enumerate the enabled carriers before approval. The preview freezes the current database table/column inventory, every source owner, Host carrier, registered project output and controlled backup/recovery directory. Unknown carriers, unresolved output identities or changed manifest bytes block the operation.

| Carrier | Existing owner and approved selection | Completion evidence |
|---|---|---|
| Session source, reports/history, handoff/export snapshots, consuming-session excerpts, Historian input/replies | `CliArchive`; full owner binding, file identity, selected event IDs/hashes and durable byte-range plan | Fsynced erased ranges, unchanged unrelated bytes, independent full-file readback and persisted acknowledgement |
| Info cards and counting receiver receipts | `OwnerInfoLog` / `CountingTransport`; selected JSONL entry identities and hashes | The same bounded line-erasure/readback protocol; readers skip erased lines and retain unrelated entries |
| Registered project output | `WindowsFileRoot`; all writer dependencies, exact root/parent/file identities and current content hash | Handle-relative opening, current delete access, pinned identity/content checks, deletion by file handle, and independent absence check |
| Ready, staging, retired and migration snapshots; recovery originals | Store snapshot inventory and `removeSnapshotFiles`; frozen directory identity and exact file inventory | Remaining files must be an unchanged subset of the approved manifest; deleted files/directories reconcile after interruption |
| Canonical, Intent, verification/feedback/proposal, suppression, search/FTS, jobs/outboxes, presentations and request metadata | `planPurge` / `applyLogicalPurge`; structured fixed-point closure | Logical deletion and FTS rebuild, followed by actual SQLite maintenance and non-resurrection checks |
| Sensitive continuation and maintenance observations | `ProbeStore.preparePurgeMaintenance`; same operation and verified owner acknowledgements | Approval digest, carrier/source/backup locators, range/hash acknowledgements and residual rows are removed before SQLite maintenance |

Multiple writes to one project path contribute all their dependencies before the physical carrier is deduplicated. File presentations are archived copies even when the owner rejects the write; their source acknowledgements participate in the closure. Project-file deletion uses the existing Windows native resource owner; the portable Core does not introduce a second filesystem policy.

The logical transaction preserves genuinely content-free execution sequence and outcome facts. An attempt ID that also addresses an erased archive event is replaced consistently in its retained execution/request envelopes. Removed job identities are detached. Shared session ownership and authorization needed by unaffected requests remain valid; affected runs stay sealed/redacted, and their streams remain explicitly not fully replayable. Old activities fail the epoch gate.

## Durable phases and final gate

1. **Logical commit.** The original database transaction removes the closure, appends the immutable logical receipt, persists the approved cleanup continuation and changes the fence to `cleaning`. No external owner deletes before this transaction commits.
2. **External cleanup.** Each owner operates only on its frozen resources. Core persists line plans before writes and acknowledgements after flush/readback. Backup/output deletion is reconciled against the frozen identity or actual absence. A remaining approved backup subset is valid progress; a substituted resource is not.
3. **SQLite maintenance.** Once all participant acknowledgements match actual state, one transaction removes the sensitive continuation fields, approval digest and residual observations. The remaining continuation contains only the random operation identity, `sqlite-maintenance` phase and empty inventories. Recovered archives with surviving unrelated entries retain their existing session ownership; restoring that ownership does not clear recovered-owner dispatch blocks.
4. **Physical maintenance.** Under the store maintenance fence, Core audits canonical integrity, enables SQLite secure deletion, truncates the WAL checkpoint, runs `VACUUM`, truncates the checkpoint again, and checks SQLite quick/FK results, zero freelist pages and an empty or absent WAL. A live SQLite reader that prevents truncation blocks completion.
5. **Controlled completion.** One final transaction appends `purge/controlled-complete@1`, clears the content-free continuation, settles the operation and opens a new epoch. It clears the coordinator pointer from the fence. The original logical receipt is unchanged. `purgeCompletion(operationId)` and repeated completion read the same immutable result.

A crash after reference scrubbing resumes from the content-free phase and repeats SQLite maintenance; no old locator is reconstructed. Missing or corrupt operation/receipt progress blocks admission. Normal runtime, background derivation, snapshot creation and ordinary restore stay closed until the final transaction. The completion is presented by the maintenance Host, not sent back into an exited model session.

The disposable schema is **26**. Earlier disposable stores must be recreated. The independent forward-migration harness advances its own copy to **27**; production schema freezing remains a separate acceptance boundary.

## Verification and retained evidence

`fixtures/t22b-controlled-cleanup.json` freezes the case identities and reuses the T21/T22a synthetic corpora. `scripts/evidence-controlled-cleanup.ts` retains:

- the approved preview and actual table/carrier/backup inventory, associated owner and per-case result;
- original logical and final completion observations, live stdin, stdout/stderr and process outcomes;
- before/after database and carrier copies, WAL bytes when present, raw byte-scan results and artifact SHA-256 values;
- schema/quick/FK/freelist checks, source/token/job rejection, repeated index rebuild/drain, a new dispatched task and a clean backup;
- fixture digests, implementation commit/tree/worktree state, environment and exact commands.

The authoritative receipt is `artifacts/t22b-<timestamp>/receipt.json`. Its evidence copies belong to the independent synthetic runner outside the application's purge-owned sandbox. CI runs the command on Windows, macOS and Linux and uploads it with the existing `synthetic-<os>` artifacts.

| Requirement group | Runnable evidence |
|---|---|
| Canonical, conflict, suppression, correction/rollback receipts, Intent, search and Host operations | `purge-complete.test.ts`; `shared`, `operations`, `rollback`, `discovery`, `conflict` receipt cases |
| Reports, versions, proposal/source discovery, excerpts and handoff | `handoff` / `discovery` receipt cases; actual source restoration rejection and rebuild/drain checks |
| Historian compartments and source-addressable execution identities | `historian` receipt case; `purge-closure.test.ts` and `purge-complete.test.ts` |
| Participant bytes, unrelated retention, identity drift, current permissions and sharing locks | `purge-copies.test.ts`, `purge-project.test.ts`, existing source-boundary tests |
| Ready/unpublished/retired/migration backups and recovery-original copies | `backup`, `staging-backup`, `retired-backup`, `migration-backup`, `recovery` receipt cases |
| Post-snapshot session ownership after restored or interrupted databases | `purge-source-recovery.test.ts`, including full completion and a surviving original source |
| Before/after owner deletion, partial backup removal, scrub, vacuum and final receipt interruption | `purge-faults.test.ts`; all restarts retain one logical operation and one final receipt, and ENOSPC/SQLITE_FULL failure facts replay before and after completion |
| SQLite main/WAL/free pages, blocked checkpoint and sensitive continuation removal | `purge-copies.test.ts` plus retained raw byte scans and SQLite observations |
| Normal use after completion | Real CLI restart, new task dispatch, unchanged unrelated memory and clean backup |

The Windows receipt covers the native file Host and Windows sharing locks. Other platforms mark the native project-output case unavailable while running portable paths. Ordinary mode-bit permission tests are unavailable under root. ENOSPC and SQLITE_FULL are injected at owner/SQLite boundaries; no physical volume is filled. Process-boundary interruption does not establish power-loss or torn-entry recovery. External remote copies and independently exported backups remain the residuals stated in the approved preview.
