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

`backup` returns a verified snapshot or the reason no new snapshot was required. `backups` verifies ready snapshots before listing them. `restore-snapshot` closes admission, obtains maintenance exclusivity, preserves the original carriers and restores one explicitly selected snapshot. `request-status` includes the immutable recovery receipt for restored runs; dispatch from an old session or job fails with `recovered-stream-blocked`. `recovery-new-session` creates a fresh synthetic session and runs the counting transport.

## Snapshot boundary and inventory

`ProbeStore.createSnapshot` pins a SQLite read transaction and captures the source and owner-carrier bytes at the same Core write boundary. SQLite's backup API materializes that read snapshot while other ordinary work may continue. Publication requires database `quick_check`, foreign-key and canonical-reference checks, archive framing/binding checks, referenced source byte/hash checks, and independent readback of the destination files. A registered staging directory is not a recovery point.

| Carrier | Snapshot treatment |
| --- | --- |
| `probe.sqlite` | SQLite backup API, full table relationships, frozen database hash and byte count |
| Every registered session archive | Exact bytes, canonical bound path and file identity; includes reports, proposals, handoffs and Historian compartments |
| `owner-info.jsonl` | Exact bytes and identity alongside its SQLite delivery state |
| `counting-receiver.jsonl` | Exact synthetic receipt bytes and identity; post-snapshot delivery evidence is also retained in the recovery original |
| Registered project-output carriers | Copied with the same file inventory and identity rules |
| Manifest and backup directory | Store/root identity, UTC day, content version, complete file hashes and byte counts |

A changed UTC day creates at most one daily snapshot. Activity, maintenance and snapshot bookkeeping alone do not trigger another data version. The latest two verified daily snapshots remain; retirement first invalidates the old snapshot in SQLite and then removes only its verified files. A `migration` checkpoint uses the same verification path and remains separate from daily retention until explicitly discarded.

Canonical/reference corruption marks store health failed and blocks normal writes and model dispatch. Recovery uses the current owner/fence control, never the snapshot's stale open fence. Missing or untrusted current control fails before restoration. Existing projection rebuilding continues to handle projection-only faults.

## Restoring and retaining uncertainty

The maintenance coordinator registers a recovery operation containing the selected snapshot, its frozen inventory, the preserved original and a restore stage. The original contains the live database plus its WAL, all captured source/owner/output carriers, later controlled project outputs and source files belonging to sessions created after the snapshot. Current controlled-output ownership is retained in the recovery operation and remains in the maintenance inventory after the original files are discarded. SQLite SHM is reconstructible and is not copied.

Recovery validates the selected snapshot again, restores source carriers through their bound file handles, builds the replacement database and applies it through SQLite's backup API. The replacement preserves current snapshot/recovery bookkeeping and the exclusive coordinator fence. Old activities become absent only under this exclusive recovery. Final canonical/file validation, completion and reopening admission occur as one control transaction. A prepared operation blocks cancellation/reopening and resumes under the same operation ID after coordinator takeover.

The immutable `store/recovered-from-snapshot@v1` receipt contains only schema, operation ID, `recovered_with_gap` and timestamp. Recovery marks owners from both the snapshot and the current session/job/stream inventory. Their request creation, reconciliation and final dispatch remain blocked, and unfinished recovered capture jobs are excluded from drain.

Historical attempts retain their exact outcomes. A pre-snapshot `unknown-sent` stays unknown. A later attempt absent from the snapshot stays absent, with the original receipt retained and its old job blocked. Recovery never reconstructs a success or `not-sent` outcome from missing history. Fresh sessions/jobs receive new identities and pass normal admission; they do not replay old attempts.

## Maintenance and schema

Backup, staging and recovery directories participate in the existing maintenance inventory. Unknown files inside a registered directory remain blockers. `snapshotCleanupManifest` / `recoveryCleanupManifest` freeze the exact files and identities; the corresponding discard operation durably records that approved manifest before deleting. Changed identities or contents are rejected. A lost deletion acknowledgement resumes the same recorded cleanup, and admission stays closed until cleanup completes. Recovery receipts and gap markers remain after original files are deleted.

The disposable schema version is **23**. Store opening rejects other schema versions. The forward migration harness operates on an independent copy, changes that copy to version 24 with a matching `schema_meta` constraint, version and target schema hash in one SQLite transaction, and verifies successful commit plus process death before/after commit against the untouched migration checkpoint. It exercises migration/recovery primitives without introducing a production schema migration.

## Evidence

`npm run evidence:backup` writes `artifacts/t20-*/receipt.json`, the CLI stdout/stderr, interrupted/final sandbox copies and artifact hashes. Its fifteen cases cover memory, approved handoff, Historian, controlled project outputs before/after the snapshot, unknown jobs before/after the snapshot, process death during carrier restore/after database restore, injected `ENOSPC`/`EROFS`, canonical corruption, and the three forward migration copy outcomes. The verifier reads the actual SQLite files and source bytes independently, checks preserved attempt outcomes and gap ownership, then proves that an old stream is rejected and a fresh session sends successfully.

The `backup*.test.ts` suite additionally verifies concurrent ordinary writes, UTC-day retention, missing current owner control, source mutation, carrier relationships, frozen cleanup, changed file identity and lost cleanup acknowledgement. The approved boundaries are the public Core API, real CLI process I/O and final dispatch.

Controlled project-output creation uses the existing real Windows file Host. On other platforms those two evidence cases explicitly report unavailable; the remaining snapshot cases run normally.

The shared CI runs the full checks and this evidence command on Windows, macOS and Linux. Each receipt describes only its recorded environment and source revision. Production schema freezing/migration belongs to T24; permanent deletion of source/history belongs to T21–T22. The existing torn-archive-append evidence gap in issue #38 is outside these snapshot interruption probes.

## Contract references

- Issue [#20](https://github.com/qsgy-edge/euler/issues/20); delivery uses a feature branch and PR.
- [Implementation specification](../architecture/issues/15-euler-v1-spec.md): I19, backup/recovery invariant and X-12.
- [Storage contract](../architecture/issues/10-choose-storage-projections.md): verified snapshots, original preservation, forward recovery and capacity handling.
- [Reproducibility contract](../architecture/issues/12-build-evidence-experiment-matrix.md): raw artifact and platform-specific receipts.
