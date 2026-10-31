# Verified snapshots and recovery gaps

Run a disposable sandbox and keep the printed root:

```powershell
npm run demo -- create
npm run demo -- run --sandbox '<root>'
npm run demo -- backup --sandbox '<root>'
npm run demo -- backups --sandbox '<root>'
npm run demo -- restore-snapshot --sandbox '<root>' --snapshot '<snapshot-id>'
npm run demo -- recovery-new-session --sandbox '<root>'
npm run evidence:backup
```

`backup` returns a verified snapshot or the reason no new snapshot was required. `backups` verifies ready snapshots before listing them. `restore-snapshot` validates the selected snapshot before closing admission, obtains maintenance exclusivity, preserves the original carriers and restores that snapshot. Invalid selection leaves a healthy sandbox open; an already pending recovery stays blocked and can resume with its original selection. `request-status` includes the immutable recovery receipt for restored runs; dispatch from an old session or job fails with `recovered-stream-blocked`. `recovery-new-session` creates a fresh synthetic session and runs the counting transport.

## Snapshot boundary and inventory

`ProbeStore.createSnapshot` pins a SQLite read transaction and captures the source and owner-carrier bytes at the same Core write boundary. SQLite's backup API materializes that read snapshot while other ordinary work may continue. Publication requires database `quick_check`, foreign-key and canonical-reference checks, archive framing/binding checks, referenced source byte/hash checks, and independent readback of the destination files. Intent and memory heads, activation batches, pending or registered Info outbox relationships, capture metadata, feedback receipts, and memory-operation presentations, results and delivery summaries use the same replay/typed-column and manifest checks as their owner readers; access scope remains enforced by the requesting reader. Published source units and proposals are checked through their canonical owner readers, including payload digests, typed versions, project scope, approvals and source relationships. Published Historian compartments are checked against their completed job, publication hash, frozen range/hash, actual attempt, recorded response and archived body. Before creating a backup directory, Core durably registers its staging intent and intended file inventory, then binds the directory identity. Interrupted staging remains available to maintenance cleanup and does not consume a verified daily snapshot slot.

| Carrier | Snapshot treatment |
| --- | --- |
| `probe.sqlite` | SQLite backup API, full table relationships, frozen database hash and byte count |
| Every registered session archive | Exact bytes, canonical bound path and file identity; includes reports, proposals, handoffs and Historian compartments |
| `owner-info.jsonl` | Exact bytes and identity alongside its SQLite delivery state |
| `counting-receiver.jsonl` | Exact synthetic receipt bytes and identity; post-snapshot delivery evidence is also retained in the recovery original |
| Registered project-output carriers | Copied with the same file inventory and identity rules |
| Manifest and backup directory | Store/root identity, UTC day, content version, complete file hashes and byte counts |

Canonical audits also compare request authorization and attempt receipts with their execution owner, adapter and timestamps; verify provenance and comparison evidence; and check capture-work, workspace and snapshot-catalog relationships. Intent and proposal rows retain their original request serialization for exact idempotency-digest checks. Feedback payloads retain their identity input, and query receipts cover their grant/query identity, request/page hashes, result count and byte count with a row digest. Historical discovery approvals are checked under their originating session binding; ordinary callers still require a current active grant.

A changed UTC day creates at most one daily snapshot. Publication rechecks the daily slot within its write transaction: an overlapping loser records its exact staging cleanup, removes that copy and returns `daily-limit`. Interrupted cleanup remains available to the maintenance coordinator. Activity, maintenance and snapshot bookkeeping alone do not trigger another data version. The latest two verified daily snapshots remain; retirement first invalidates the old snapshot in SQLite and then removes only its verified files. A `migration` checkpoint uses the same verification path and remains separate from daily retention until explicitly discarded.

Canonical/reference corruption marks store health failed and blocks normal writes and model dispatch. Recovery uses the current owner/fence control, never the snapshot's stale open fence. Missing or untrusted current control fails before restoration. A failed SQLite check confined to search projection tables prevents snapshot publication while canonical writes remain available. Projection rebuilds retain the normal activity/root/fence checks. Canonical failure keeps the store closed until recovery from a verified snapshot.

## Restoring and retaining uncertainty

Before creating the recovery directory or copying any original bytes, the maintenance coordinator durably registers the operation and its intended file inventory. It then binds the directory identity, preserves originals and marks the complete plan prepared. An interrupted preparation can resume the same operation or be discarded through its approved cleanup manifest. The original contains the live database plus its WAL, all captured source/owner/output carriers, later controlled project outputs and source files belonging to sessions created after the snapshot. Current controlled-output ownership is retained in the recovery operation and remains in the maintenance inventory after the original files are discarded. SQLite SHM is reconstructible and is not copied.

Recovery validates the selected snapshot again, restores source carriers through their bound file handles, builds the replacement database and applies it through SQLite's backup API. The replacement preserves current snapshot/recovery bookkeeping, original-copy deletion state and the exclusive coordinator fence. Old activities become absent only under this exclusive recovery. Final canonical/file validation, completion and reopening admission occur as one control transaction. Preparing and prepared operations block cancellation/reopening. After coordinator takeover, a prepared operation resumes under the same operation ID.

The immutable `store/recovered-from-snapshot@v1` receipt contains only schema, operation ID, `recovered_with_gap` and timestamp. The prepared recovery plan freezes the owner union from the snapshot and current session/job/stream inventory, including unclaimed capture jobs that never acquired an execution stream. Recovery markers are checked against that frozen union and its receipts; missing or changed markers block request creation and dispatch. Their reconciliation also remains blocked, and unfinished recovered capture jobs are excluded from drain.

Historical attempts retain their exact outcomes. A pre-snapshot `unknown-sent` stays unknown. A later attempt absent from the snapshot stays absent, with the original receipt retained and its old job blocked. Recovery never reconstructs a success or `not-sent` outcome from missing history. Fresh sessions/jobs receive new identities and pass normal admission; they do not replay old attempts.

## Maintenance and schema

Backup, staging and recovery directories participate in the existing maintenance inventory. Unknown files inside a registered directory remain blockers. `snapshotCleanupManifest` / `recoveryCleanupManifest` freeze the exact files and identities; the corresponding discard operation durably records that approved manifest before deleting. Changed identities or contents are rejected. Staging snapshots keep their staging state until deletion completes. A process exit before or after directory removal resumes the same recorded cleanup, and admission stays closed until cleanup completes. Recovery receipts and gap markers remain after original files are deleted.

Recovery preparation preserves the binding and file identity of every controlled original source, including sessions created after the selected snapshot. Restoring session rows from the snapshot does not discard that original-source ownership; purge freezes these registrations before deleting recovery metadata. Discarding the separate recovery-directory copy leaves the original source registration intact.

The disposable schema version is **26**. Store opening rejects other schema versions. The forward migration harness operates on an independent copy, changes that copy to version 27 with a matching `schema_meta` constraint, version and target schema hash in one SQLite transaction, and verifies successful commit plus process death before/after commit against the untouched migration checkpoint. It exercises migration/recovery primitives without introducing a production schema migration.

## Evidence

`npm run evidence:backup` writes `artifacts/t20-*/receipt.json`, the CLI stdout/stderr, interrupted/final sandbox copies and artifact hashes. Its cases cover memory; delivered/read Info and post-snapshot Info gaps; report history, approved project excerpts and cross-project rejection; Historian; controlled project outputs and unknown jobs before/after the snapshot; snapshot-only unclaimed memory/Historian jobs; backup-directory and recovery interruptions; injected `ENOSPC`/`EROFS`; projection repairs with canonical writes still available; canonical, Intent, Info outbox, capture/feedback, source/proposal metadata and Historian corruption; settled and pending memory operations, delivery summaries, receipt relationships and cross-session token rejection; original-copy cleanup state; and the three forward migration copy outcomes. The verifier reads the actual SQLite files and source bytes independently, checks preserved attempt outcomes and gap ownership, then proves that an old stream is rejected and a fresh session sends successfully.

The evidence runner also saves the command, exit status and TAP output for the retention/concurrency, maintenance inventory, canonical integrity and recovery-control tests. The relationship tests retain their before-fault, damaged and final sandbox files under `canonical-relations`, including SQLite WAL and case identity. Provenance cases verify historical sources through a post-recovery forget operation. Project visibility observations include each reader binding, request and actual result or error. The `backup*.test.ts` suite additionally verifies source mutation, cross-session Historian verification, session-scoped head validation and carrier relationships. The approved boundaries are the public Core API, real CLI process I/O and final dispatch.

Controlled project-output creation uses the existing real Windows file Host. On other platforms those two evidence cases explicitly report unavailable; the remaining snapshot cases run normally.

The shared CI runs the full checks and this evidence command on Windows, macOS and Linux. Each receipt describes only its recorded environment and source revision. Production schema freezing/migration belongs to T24; permanent deletion of source/history belongs to T21–T22. The existing torn-archive-append evidence gap in issue #38 is outside these snapshot interruption probes.

## Contract references

- Issue [#20](https://github.com/qsgy-edge/euler/issues/20).
- [Implementation specification](../architecture/issues/15-euler-v1-spec.md): I19, backup/recovery invariant and X-12.
- [Storage contract](../architecture/issues/10-choose-storage-projections.md): verified snapshots, original preservation, forward recovery and capacity handling.
- [Reproducibility contract](../architecture/issues/12-build-evidence-experiment-matrix.md): raw artifact and platform-specific receipts.
