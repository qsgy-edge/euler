# T03 — synthetic process ownership and maintenance

Implements [Issue #3](https://github.com/qsgy-edge/euler/issues/3) against specification commit `a3f253f9bef0415364b3b224e5eb4ba150111325`, I03/I11/I18 and the synthetic X-01/X-06/X-12 subsets. The scope remains the Windows-first custom CLI and disposable SQLite; the same portable checks run on Windows, macOS and Linux CI.

## Reproduce

Use Node 24.18.0:

```sh
npm ci --ignore-scripts
npm run check
npm run evidence
npm run evidence:memory
npm run evidence:maintenance
```

The last command records seven scenarios under `artifacts/t03-<timestamp>/`: stream ownership after a fresh-process query, successful exclusive maintenance, cancellation followed by a fresh run, stopped-coordinator takeover, missing controlled launch acknowledgement, and unexplained residuals. The seventh scenario closes admission after a child reservation but before its acknowledgement, observes both failed child and parent exits, and then verifies exclusive acquisition plus a successful fresh run. Raw process observations, stderr, source/SQLite snapshots, environment, fixture digests, implementation commit/tree and working-tree state accompany the assertions. The verifier independently queries private copies of the recorded SQLite files; it does not treat Core's status output as canonical proof. Read the recorded `status`, case errors and working changes before claiming a pass. CI adds the full test log, including real startup/closing races, late writes, revalidation at release, and connection restart tests.

The fixture is `fixtures/first-turn.json`; its canonical JSON SHA-256 is recorded at runtime. Authorization is explicitly `synthetic-host-command`. It means the trusted disposable CLI/test control path chose a fixed owner/project, not production policy approval or semantic verification. No model/provider is used beyond the pre-existing local counting transport.

For manual process control, first run `npm run demo -- create` and use its returned root:

```sh
npm run demo -- hold --sandbox <root>
npm run demo -- maintain --sandbox <root>
npm run demo -- maintenance-status --sandbox <root>
```

Run `hold` and `maintain` in separate terminals. `hold` starts a registered child job. The maintenance terminal accepts `inspect`, `acquire`, `release`, and `cancel`. After maintenance closes admission, `append` in the runtime terminal must report `late-append-blocked`. Send `stop` to the runtime; it waits for the controlled task's actual exit. Then `acquire` and `release` permit a fresh `run --sandbox <root>`. `cancel` also opens a new epoch, while the old runtime remains fenced. EOF or killing the coordinator leaves the fence closed; a replacement coordinator must observe its absence before takeover. The status command does not register a business activity or call a model.

## Storage and admission

Disposable schema version 5 replaces version 4; recreate old development sandboxes. There is no production schema migration.

`execution_streams` stores immutable owner kind/ID, principal, origin host, resolved project and synthetic authorization source. The stream registry itself is the minimal retained owner record for these synthetic jobs and maintenance/migration runs. It does not start production background jobs. Session owner IDs must match the bound session; controlled jobs refer to their durable parent activity as authorization source. Reusing an owner with different authorization fails. `execution_events` adds only immutable `attempt-bound` ownership records with per-stream sequence, unique attempt IDs and one-stream-per-run enforcement. This is not the full assembly/started/finished ledger: local receipt `formalLedger` remains false, and no unknown attempt is replayed. Session/job/migration counting-transport receipts take their owner from the durable attempt, including when an originating session exists. Maintenance creates no model attempt.

`register` checks open admission and records process PID, random incarnation, start timestamp, root identity, stream and epoch in one short SQLite transaction. PID alone is never a registration token. A stale process incarnation cannot re-register after epoch change. Existing archive, mutation, projection, source and local dispatch paths remain behind `withActivity`; a borrowed or changed activity token fails. Backup, physical purge, production started barriers and live transports remain unavailable.

Before spawning a controlled child, the parent reserves its job/activity row. It then persists the PID obtained from the actual child handle, even if admission closed in that interval. This limited control-evidence update cannot authorize business work. The child claims that one-time reservation under the same open fence, recording its own incarnation before readiness; a claimed PID must agree with the launch PID. If closing rejects the child, the parent still closes its readline/timer/database resources on failure. Maintenance can settle the recorded launch only after the OS proves that PID absent. A launch with neither a handle PID nor a child acknowledgement remains a durable participant with unknown exit state; the implementation does not silently drop or relabel it. Cancellation can reopen admission, but a future exclusive acquisition is still blocked by unresolved participants.

## Maintenance evidence and recovery

The fence records the coordinator's capability ID, actual process identity, maintenance stream and registered activity. A takeover keeps the same owning stream and retains the previous coordinator's confirmed absence. A coordinator can enumerate/status/cancel/release; it cannot reuse its activity for business writes.

Each acquisition checks every earlier registered participant, excluding only the current coordinator. Successful `process.kill(pid, 0)` means the PID is occupied and blocks; only `ESRCH` proves absence. Other errors and launches with no PID evidence stay unknown. PID reuse can conservatively delay maintenance; it cannot establish false absence. A recorded absence is terminal evidence for that registered incarnation. Stale heartbeat, UI idle, closing the database and abort requests do not qualify.

The same acquisition enumerates the bound disposable root. The existing manifest/source/database/WAL/SHM regular files are recognized carriers. Unexpected entries, aliases/hardlinks or unreadable entries block and are recorded in `maintenance_residuals`; the current snapshot remains queryable after restart. This bounded inventory does not inspect unrelated host processes or clean unknown files. Parent/root identity still undergoes the existing per-transaction validation.

Release repeats participant and residual checks, and persists a newly blocked result even when refusing release. Successful release and cancellation increment the epoch and retain activities, streams, attempts and last evidence. They do not delete historical ownership. No irreversible operation is enabled, so cancellation remains available before release. Filesystem enumeration and SQLite are not claimed to be atomic against arbitrary external actors; this is a controlled synthetic root, not an OS isolation boundary.

## Evidence limits and clear ownership

Runtime passes cover only the recorded platform and scenarios. Missing platform artifacts are evidence gaps, regardless of CI configuration. No full X-card, external side-effect settlement, real MC, live owner, production data, backup, physical purge or power-loss durability is accepted here.

All new canonical rows belong to the disposable store/root. `owner_activities` links controlled child to parent and process to stream; `execution_events` belongs to its immutable owning stream; `maintenance_residuals` is the latest root inventory. A future owning-stream purge must settle necessary content-free state and references before clearing these rows. This ticket neither enables purge nor treats disappearance of a ledger row as permission to retry.
