# Archive append reconciliation

## Run and inspect

```powershell
npm run demo -- archive-reconcile --sandbox '<root>'
npm run demo -- archive-reconcile --sandbox '<root>' --session '<registered-session-id>'
node --test apps/cli/test/archive-reconciliation.test.ts apps/cli/test/archive-crash.test.ts
npm run evidence:archive
npm run evidence:source-recovery
```

`archive-reconcile` opens the registered source carrier and settles its pending append by the original identity. It returns durable source acknowledgements and sends no model request. `--session` selects another registered source owner; an unknown session is rejected before any recovery write. Without it, only the default session is reconciled. `remember` performs the same reconciliation before owner backfill. Existing request recovery remains responsible for unresolved model/tool execution; archive reconciliation never re-executes those operations or invents their outcome.

## Durable reservation and tail recovery

The CLI reserves the event identity, exact encoded line, byte offset, prefix hash and source binding in `source_appends` before writing the archive. The reservation is a separate committed SQLite transaction under the existing activity/fence checks. A source append inside an outer transaction is rejected: releasing a savepoint cannot establish the required durable reservation. Guidance prepares its snapshot, appends outside that transaction, and rechecks its assembly head, intent and project membership before publishing the assembly.

One pending append owns a session's tail. Another identity cannot append until reconciliation completes. The Host checks the bound file identity, the original prefix and the exact expected tail bytes:

- No bytes written: append the reserved line.
- Matching partial tail, including an incomplete UTF-8 sequence: append only the missing bytes.
- Complete matching line: do not append again.
- Changed prefix, conflicting tail, missing/replaced file or an unreserved incomplete line: stop with an integrity or identity error.

Recovery does not truncate, replace or rewrite surviving archive bytes. Fsync and strict readback precede acknowledgement and reservation settlement. Settlement replaces temporary line bytes with an immutable acknowledgement witness in the same row; its original identity/hash survives a crash after commit but before delivery. Lookup verifies the current line against that witness; enumeration preserves it for downstream source validation. Derived-output classification uses durable job identity independently of current body integrity, so corrupted derived entries remain excluded from owner backfill. Same identity and bytes return the original acknowledgement; different bytes or role fail with `identity-conflict`. Ordinary source enumeration and dependent Core reads cannot consume a pending event. A pending reservation blocks backup/purge auditing without marking an otherwise healthy store corrupt; reconcile it before those operations.

Agent responses use their persisted attempt ID. Tool results and file presentation/approval/reconciliation IDs derive from their run/call or presentation identity. Guidance IDs bind the run, previous assembly and snapshot hash. Reports retain their caller-supplied stable identity. Owner input IDs are reserved by the same CLI archive before any capture or activation. A lost owner-input acknowledgement is reconciled before startup backfill, which reuses the original input rather than creating another memory.

`source_appends` is part of the existing Store, not a separate file carrier. Settling removes its temporary bytes and retains the immutable acknowledgement in the same transaction as source verification. Acknowledgement witnesses participate in canonical snapshot auditing and the source-qualified purge closure; verified snapshots require no unresolved reservation. The disposable schema is 27; older disposable sandboxes must be rebuilt. The independent forward-migration copy uses 28.

## Evidence

`evidence:archive` creates `artifacts/archive-<platform>-<time>/receipt.json` with per-case process commands, timestamps, exit/signal, stdout/stderr, interrupted/recovered SQLite and archive copies and hashes. The verifier independently reads raw SQLite and JSONL with `node:sqlite` and `node:crypto` rather than trusting product replay or its reported verdict.

Real child processes are killed before reservation commit, after reservation commit, before/after write, during partial write, after fsync, after strict readback, immediately before acknowledgement settlement, after its commit but before delivery, and after acknowledgement return. The actual owner statement/agreement reader, Agent response/tool result, file presentation/approval, guidance and report paths receive partial-write and lost-ack probes. Owner backfill is repeated in separate processes. A committed source publication with its projection job still pending is drained across restarts, retaining the same job identity and a single projection.

The source-recovery receipt includes this runner and clears its unknown/torn append and pending-job gap only when the nested receipt passes. The existing Windows/macOS/Linux CI matrix runs that command and the full test suite; each receipt covers its recorded host. Process-kill evidence does not test power loss. Real providers, Pi integration and production data are outside these probes.

The authority is issue [#38](https://github.com/qsgy-edge/euler/issues/38), v1 I09 and X-04/X-11. Delivery follows the feature-branch/PR path because this change affects persistence and runtime recovery.
