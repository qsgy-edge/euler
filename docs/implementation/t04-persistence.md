# T04 — synthetic persistence transactions and recovery

Implements [Issue #4](https://github.com/qsgy-edge/euler/issues/4), the X-01 foundation, against specification commit `a3f253f9bef0415364b3b224e5eb4ba150111325`: I03/I04/I11/I15–I17, Ticket 12 X-01 and Ticket 13 D8.1/P1 and D8.2. All inputs and databases remain synthetic and disposable.

## Reproduce

Use Node 24.18.0:

```sh
npm ci --ignore-scripts
npm run check
npm run evidence
npm run evidence:memory
npm run evidence:maintenance
npm run evidence:persistence
```

`evidence:persistence` takes longer than a short interactive command window. Allow the process to finish and require its `summary.json`; an interrupted run without a summary is incomplete evidence. It records under `artifacts/t04-<timestamp>/` and never reads MC, credentials or production Euler data.

The identity cases create randomly named `euler-t04-<UUID>` app directories under the actual OS user data directory. They open each store from two newly initialized Git roots and one non-Git cwd. The same app preserves store path and actual file identity; a different app uses another `store.sqlite3`. The normal CLI `create` command continues to create temporary `euler-t01-*` sandboxes. Existing app directories are opened, never silently reset. `createSandbox('euler')` is rejected; the standard production `euler` directory is not created by this fixture.

The controlled worker is `scripts/persistence-worker.ts`. It records the SQL write sequence for a successful intent transition, activation batch, preview replacement, correction, rollback and cancellation. The parent then repeats each scenario with a fresh database and kills the child after every recorded write statement and after the outer COMMIT: 3 + 9 + 5 + 7 + 8 + 2 = 34 checkpoints in the current implementation. This instrumentation exists only in that child process; Core and the product CLI have no fault hook. Two additional scenarios race separate sessions on one head, including killing the winning writer after COMMIT but before its result acknowledgement.

Each case retains raw stdout/stderr, commands, exit/signal, source files, SQLite/WAL snapshots before the operation, before restart and after restart. The verifier uses separate copies and Node's SHA-256 directly to compare raw rows, source acknowledgements, sequences, event chains, heads, complete batch payloads, outbox, presentation targets, operation results and receipts. It does not call Core hashing or replay helpers. Before COMMIT all logical transaction rows must equal the pre-image; after COMMIT all related rows must exist. Restart must preserve canonical rows and receipts and perform no model send. The runtime summary binds authority refs, experiment/schema, fixture digests, implementation commit/tree, working-tree state, environment/provider/model/adapter, individual process timings and exits, assertions and raw file digests. Held-out owner/sealed/released identities and contamination/replacement IDs are explicitly not applicable for this deterministic fixture. It records the independent verifier identity/result and every disposable root's cleanup observation. Receipt checks recompute all listed raw hashes and reject absent authority refs or changed sidecars. The raw Host verifier also requires exactly one mutation per committed target, valid/null reserved identities, complete selection order and the immutable pending-to-presentation digest. Saved negative inputs cover missing members, invalid reserved IDs, changed bodies and extra selection. A dirty tree identifies development evidence, not an accepted frozen commit.

## Store behavior

Disposable schema **7** replaces schema 6. Recreate earlier sandboxes; there is no compatibility migration or frozen production `001` migration.

`schema_meta` binds schema version, DDL digest, store, app-id and OS user. Connections use WAL, FULL synchronous writes, foreign keys and a 2-second busy timeout. Unknown versions or mismatched identities fail closed. The store/root fence is independent of session/project selection. `sessions` records immutable explicit logical bindings and source file identity. Project/resource aliases and explicit workspace membership are relational; a project has at most one workspace. A session can recover its intent and pending operations while another session accesses eligible shared project/workspace/personal memory. Session-local candidates remain local. Changing cwd does not choose or expand a project.

Intent identities, source references, sequence and previous-event relationships are storage checked. Recovery validates the complete event chain and reconstructs a missing head without inventing history. An existing head that points to an older event is an integrity failure, not a rollback. Memory continues to validate immutable revision/event history against its current head. Source reads use the same admitted Store connection, avoiding cross-connection writer-lock recursion. Capture deduplication uses the typed `capture_jobs.source_owner + source_event_id` key and the initial revision, so identical UUIDs in distinct session carriers do not collide and a later revision's source does not masquerade as an earlier capture. Source validation checks the target scope before reading bytes: session evidence is local to its session, project evidence to its project, workspace evidence to a registered member, and personal evidence to the same owner. Verification, automatic revision, proposal writes and reads share this gate. Synthetic correction preview and commit admit the same target-scoped sources, including explicit workspace members and the personal owner; this source check does not supply production human approval. Historical request reconciliation remains available after a later head change while enforcing scope authorization.

`host_presentations` freezes a complete canonical snapshot, token, session/branch, epoch/order, originating inspect, replaced operation identity and any selected batch. `presentation_targets` supplies typed record/revision/head/scope and selected-event references. Each mutation preview also reserves a Store-generated `update_event_id` per target (`updateEventIds` in the payload); the immutable target row and mutation SQL trigger bind that future receipt event to the operation. Rollback `eventIds`/`selected_event_id` continue to identify the earlier update being revoked, separately from both the current head and the new revocation event. Public mutation methods accept no caller-chosen event identity. Output acknowledgement can only advance and cannot change the frozen payload. Pending records keep an immutable `presentation_hash` reference that anchors the complete displayed input/body/selection; re-signing only presentation JSON cannot change the approved mutation. `pending_operations` has a partial unique index on session identity while pending; a new preview settles the old operation and names it in its own presentation. Other sessions keep their pending slots. Commit compares the complete frozen snapshots, including `head_event_id`, in the mutation transaction. Stale batches return the full available current target set and never silently shrink selection.

Committed owner changes append their immutable receipt inside `memory_events`, with the head, search outbox and operation settlement in one transaction. The receipt itself uses a random subject pseudonym and revision numbers rather than memory IDs, source locators, content or original content hashes. Host operation results reference these receipts; they are not a second receipt authority and never enter `execution_events`. Cancellation, unavailable output, stale/failure and no-op settle without a mutation receipt. Repeated commit/cancel returns settled, and restart queries the stored result without repeating the mutation.

An activation batch freezes bounded, ordered members with one owner/scope and no repeated target. `memory_events.batch_id/batch_ordinal` identifies the exact events. `activation_batches` preserves the full event payload manifest and digest, with one `host-info` outbox and individual search jobs in the same transaction. Later forget/rollback does not rewrite the old batch. Re-signing a reordered payload is rejected against the immutable event rows. Info delivery, unread state and real Host rendering remain later business work.

The new Store operation methods are transaction primitives for the controlled synthetic Host. They do not establish human approval. The fixture acknowledges output and invokes them directly; `ProbeSession` still returns unavailable for `memory.preview/commit/cancel`. No synthetic approval flag or test driver is registered as a production/model tool. Actual input provenance, UI ordering, owner/model delivery and ordinary language routing are accepted by their later Host tickets.

## Ownership and clearing responsibility

| Persistent material | Owner and clearing responsibility |
| --- | --- |
| `schema_meta`, store/root fence, process/stream bindings | Store and maintenance owner; schema/fence identity must survive only in the content-free form required by later purge/recovery work. |
| Sessions, project/resource aliases, workspace membership, source paths/identities | Explicit identity owner. CLI owns the registered JSONL carriers. Source deletion must clear dependent intent/memory/Host references and authorization; another session does not become the source owner. |
| Intent events and heads | Session/branch control owner. Events retain input/goal source references; heads are rebuildable from intact events. |
| Memory records/revisions/events, verification/provenance/conflicts/proposals | Canonical memory owner. Historical content and references remain until the authorized purge closure handles them. |
| Activation batch payloads and search/Info outbox | Canonical mutation owner fixes batch identity; projection consumers own later delivery. Their event/source/body references belong in the purge closure; current active state cannot reconstruct old members. |
| Presentations, target rows, pending/terminal results and output acknowledgements | Host operation state owner. Complete snapshots, proposal text, source references and batch payload copies are sensitive and must be cleared with their referenced targets. They are not model context or execution receipts. |
| Owner receipts embedded in memory events | Immutable canonical operation evidence. Later purge must remove identifying links/content or the whole row; only receipts meeting the specification's unlinkable, content-free exception may be retained unchanged. |
| Raw probe snapshots/logs in `artifacts/` | Synthetic evidence owner. These are disposable test copies, not a product backup or recovery service. |

The maintenance inventory now recognizes every registered session carrier and blocks on a missing or replaced carrier, including one belonging to another session. Fence and intent/memory head inserts, updates and deletes require the Store writer connection, including reopening and read-model rebuilding; the normal maintenance cancellation/release paths still advance the epoch. These connection guards prevent accidental external SQLite writes, not malicious code with full SQLite function/DDL access. This does not enable physical deletion, backup or an online cleanup mechanism.

## Acceptance limits

A passing T04 artifact proves only its observed synthetic SQLite, concurrency and process-restart paths on its recorded OS. The CI workflow runs the same checks on Windows, macOS and Linux; each platform requires its own matching artifact before its portable gate is accepted. Windows data-root/file observations do not establish macOS/Linux production-host support, ACL hardening or power-loss durability.

Full search/FTS workers and the execution request ledger belong to T05/T06. Real approval/UI and complete Info delivery belong to later business tickets. Backup, physical/logical purge, schema freeze, real provider/data access and live owner/canary remain outside this ticket. The new tables do not include deferred overview/backfill, embedding, behavior evaluation or publication facilities.
