# Source/archive cleanup and durable continuation

Issue: #22. Delivery path: feature branch + PR, because this changes archive bytes, the maintenance API, persistence guards and required checks. Review baseline: `1ca3cb68cabaa1a6a559797d145e5b21890c5b31`.

## Run

```powershell
npm run demo -- memory
npm run demo -- purge --sandbox <sandbox-root> --record <record-id>
# Enter the exact PURGE <token> <nonce> phrase from the preview.
# After logical-commit, enter:
cleanup-source
# status reads the same operation and its current source participant result.

# After the maintenance process exits:
npm run demo -- purge --sandbox <sandbox-root>
# Enter cleanup-source to continue the already-approved operation.

npm run evidence:source-cleanup
```

The maintenance command first proves the old coordinator/runtime processes have exited and reacquires exclusivity. `cleanup-source` uses the existing logical receipt and frozen manifest; it neither asks for another approval nor repeats canonical deletion. Calling it before logical commit performs no source deletion.

The result contains `source.status`, `source.completed` and `source.total`. These count the selected archive carriers, not every registered source. A successful source participant returns `source.status=complete` while the operation remains `cleanup=incomplete` and the store fence stays `cleaning`. The CLI reports a cleanup error alongside the known logical receipt. Runtime admission, source append, model dispatch, capture/Historian publication, backup and ordinary recovery remain closed.

## Ownership and byte deletion

`ProbeStore.cleanupPurgeSources` coordinates the existing `CliArchive` owner. It accepts no caller-supplied paths: each source comes from the committed manifest and retains the exact source-owner/file identity recorded by session or recovery registration. The owner enumerates its bounded JSONL carrier and resolves the approved event IDs and hashes to byte ranges.

The owner overwrites each selected event line with spaces, preserving its newline, the file identity and every unselected byte. No target ID or content remains in those ranges. Archive reads ignore these erased lines. The owner opens the original file for writing, checks the opened handle and path identity, writes the selected ranges, calls `fsync`, rereads the carrier and verifies the result before acknowledging it. There is no replacement-file rename, contentful staging copy or separate archive subsystem.

Core validates the plan against the approved full-file hash and each selected line hash before persisting it. During continuation, a selected line must still match its original hash or be completely erased; the expected post-cleanup file hash checks every unselected byte. Core independently checks the actual resulting bytes before storing the owner acknowledgement. Existing acknowledgements are rechecked when reporting source completion.

A missing owner, changed identity, unexpected bytes, denied write permission or sharing lock leaves cleanup incomplete. A failed write or acknowledgement is not treated as a rollback. Complete erased entries can be reconciled after a crash; an unverifiable partly overwritten entry remains blocked rather than being blindly erased. Restoring a pre-purge snapshot through ordinary recovery is unavailable while the fence is closed.

## Continuation and guards

The existing `pending_operations.continuation` retains the approved `carriers`, `backups`, source-owner bindings and inventory. Its `sourceCleanup` entries add only:

- the selected carrier's index in the frozen manifest;
- the selected byte offsets/lengths and expected post-cleanup hash;
- the durable acknowledgement's resulting hash and byte count.

The plan is committed before the owner writes. The acknowledgement is committed after owner flush and independent readback. A crash after deletion but before acknowledgement is recovered from the stored plan and actual bytes. The logical receipt is unchanged throughout.

The settled-operation trigger permits continuation updates only for an existing `purge` operation in `cleaning`, through the Core purge writer. Operation identity, approval digest, result and logical receipt remain immutable. Disposable schema is **26**; old disposable stores must be recreated. The independent forward-migration harness advances its copy to **27**.

## Carrier coverage and handoff

All currently registered session JSONL files use the same source owner. Prepared and complete recovery plans preserve each original source binding and file identity, including after an interrupted database replacement. Originals belonging to sessions created after that snapshot remain controlled even when those session rows disappear or the separate recovery-directory copy is discarded. Purge includes these originals and their owner routes in the preview and freezes them in the continuation; it does not reactivate the recovered sessions. The selected closure covers original input, assistant/tool replies, report versions, handoff text, approved Markdown export snapshots, published report-section references and copies of expanded excerpts in consuming sessions. Historian raw ranges and archived replies/compartment bodies use this same carrier.

The fixture includes an unrelated memory, identical event UUIDs in distinct sessions, two report versions, a handoff, an approved export and a consuming-session excerpt. Assertions compare actual retained events and raw file bytes against the frozen selection. Independent source entries remain readable through the archive owner with their original acknowledgements.

`owner-info.jsonl`, `counting-receiver.jsonl`, file-tool project outputs, snapshots/recovery originals and SQLite main/WAL/free pages are handled by the [controlled cleanup path](t22b-controlled-cleanup.md). The current report/export API writes its durable output into the archive; it does not create another temporary export file. Registered file-tool copies remain in the frozen inventory for their file owner. The full `cleanup` command verifies those actual participants, removes sensitive continuation references, performs final SQLite maintenance and only then issues `controlled-complete` and reopens admission.

## Evidence

`fixtures/t22a-source-cleanup.json` identifies the corpus and reuses `fixtures/t21-purge-cases.json`. `scripts/evidence-source-cleanup.ts` drives real CLI processes and live stdin, kills coordinators at the deletion/ack/takeover boundaries, and independently examines source bytes and SQLite continuation/receipt rows. It retains command arguments, times, exit codes/signals, raw stdout/stderr, input, before/interrupted/after copies and artifact hashes in `artifacts/t22a-<timestamp>/receipt.json`.

The receipt binds the fixture digests, implementation commit/tree/working-tree state and environment. Its independent evidence copies are outside the application's purge ownership. Boundary tests cover pre-commit rejection, permission withdrawal, resource replacement, changed content, unavailable owners, forged plans/acknowledgements, an acknowledgement transaction failure, current-state revalidation and a real Windows sharing lock. Separate process tests exercise late capture/Historian archive writes and dispatch under a closing fence, then complete the source cleanup after that process exits. Snapshot → later session → restore cases cover approved deletion, unrelated original retention, discarded recovery copies, a cleanup crash and recovery interrupted after database replacement.

The CI runs the tests and receipt command on Windows, macOS and Linux. Windows sharing-lock observations belong to the Windows receipt; other platforms report that gap explicitly. The receipt does not claim power-loss/torn-entry recovery from process-boundary crash tests. Global controlled-copy and SQLite completion has its own T22b receipt.
