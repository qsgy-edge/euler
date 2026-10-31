# Logical purge and cleanup continuation

The independent maintenance CLI implements the logical purge foundation in issue #21. It accepts a memory record in a disposable synthetic store, presents the current deletion closure, and commits the database changes with a durable cleanup continuation. The returned state is `logical-commit` with `cleanup=incomplete`; source/archive cleanup is implemented by [T22a](t22a-source-cleanup.md); the remaining physical cleanup and final completion receipt are implemented by [T22b](t22b-controlled-cleanup.md).

## Run

```powershell
npm run demo -- memory
npm run demo -- purge --sandbox <sandbox-root> --record <record-id>
npm run evidence:purge
```

The `memory` command prints the generated sandbox root and activated record. The purge command closes admission before inspecting content. If it emits `maintenance-blocked`, stop the old runtime and its controlled children, then enter `acquire` in the purge process. The maintenance coordinator does not terminate those processes itself. A normal `remember` runtime responds to `purge <record-id>` with the independent command and the interruption consequence.

`purge-preview` contains the complete manifest, its digest, the operation ID and a fresh token/nonce. Enter the exact `PURGE <token> <nonce>` phrase printed by that process. `cancel` before commit reopens a new epoch. A changed manifest or invalid identity invalidates the presentation; `acquire` must display a new one before approval.

After a committed operation, `status` returns the original logical receipt. Repeated approval or `cancel` returns `settled`, retaining `cleanup=incomplete`. After the coordinator exits, restart `purge --sandbox <sandbox-root>` to reconcile the committed operation. A coordinator that exited before commit has no persisted approval; restart with `--record` to obtain a new preview, or cancel from the new maintenance process.

## Implemented carriers and references

`PURGE_DATABASE_INVENTORY` in `packages/core/src/store/logical-purge.ts` enumerates every ordinary table in the current schema. The planner also checks the actual table/column inventory against the Store DDL and includes the FTS table and its SQLite shadow tables. An unknown table, column, carrier, unresolved project output or ambiguous unqualified source reference prevents approval or commit.

| Group | Current carriers and references | Logical action |
|---|---|---|
| Canonical memory | `memory_records`, `memory_revisions`, `memory_applicability`, `memory_heads`, `memory_events`, `provenance_refs`, `verification_runs`, `verification_evidence`, `feedback_events`, `conflict_sets`, `conflict_members` | Delete the selected records, history, provenance, verification/feedback and dependent relationships. Preserve only qualifying pre-issued owner receipt bytes after removing their contentful wrappers. |
| Capture and Historian | `capture_jobs`, `capture_work`, `compartments`; fixed raw ranges, comparison records, searches/expansions, request ownership and archived job/attempt outputs | Delete affected job, work and publication metadata; schedule the corresponding archived originals and derived outputs for owner cleanup. |
| Intent and discovery | `intent_events`, `intent_heads`, `memory_discovery_grants`, `memory_discovery_projects`, `memory_discovery_targets`, `source_query_receipts` | Delete affected intent/consent/query metadata. Query receipts retain exact result identity references so their request/page hashes can be located by the closure. |
| Published source and proposals | `source_units`, `source_projection_jobs`, `evolution_proposals`, `proposal_evidence`, `proposal_source_units`; source/approval acknowledgements, version chains, nested analysis headers | Delete affected publication, proposal and projection metadata. |
| Search and Info | `search_documents`, `search_projection_jobs`, `projection_jobs`, `activation_batches`, `host_info_batches`, `search_fts` and shadow tables | Delete affected projection/outbox/frozen batches and rebuild the FTS projection inside the transaction. |
| Owner operations | `host_presentations`, `presentation_targets`, `pending_operations`, `host_operation_delivery`; frozen snapshots and rollback selection, suppression, approval and model-summary source references | Delete affected presentations, pending/settled results and delivery references. A new purge continuation uses the existing operation table without occupying a pending approval slot. |
| Execution | `request_runs`, `request_events`, `request_assemblies`, `request_attempts`; sources, selection, windows, context, used memory, tool/file receipts and payload hashes | Remove content, transport metadata and hashes. Preserve event ordering and attempt outcomes, seal the run, and mark the stream `replayable=false`. Ordinary request replay rejects a redacted run. |
| Backups and recovery | `store_snapshots`, `store_restores`; ready/staging/retired snapshots, migration checkpoints, recovery originals and cleanup manifests | Remove all catalog/plan copies after preserving their exact file cleanup manifests in the continuation. A prepared recovery blocks purge. Content-free recovery receipts and the remaining old-owner block are retained and checked against their post-purge owner inventory. |
| Source archive | Every registered session JSONL and its bound identity, including owner commands, model/tool replies, analysis artifacts and Historian outputs | Freeze the selected event IDs and hashes for external cleanup; no archive bytes are removed by logical commit. |
| Host and files | `owner-info.jsonl`, `counting-receiver.jsonl`, registered project outputs and their actual file identities | Freeze selected entry/file identities and hashes. Complete Info batches carry content and are included in cleanup. |
| Maintenance and ownership | `schema_meta`, `owner_fences`, `maintenance_residuals`, `owner_activities`, `sessions`, `projects`, `project_resources`, `workspaces`, `workspace_projects`, `memory_scopes`, `source_projection_health`, `store_recovery_events`, `store_recovered_owners`, `execution_streams`, `execution_events` | Retain the ownership, process-exit, fence and content-free execution evidence needed while cleaning. Selected job ownership is detached from retained execution envelopes. Sensitive cleanup references remain confined to the closed maintenance path until final cleanup. |

Shared session, project and claim labels do not expand a memory deletion. A shared frozen Info batch is removed as one contentful display copy; unaffected memories stay canonical, and their event-to-batch links are explicitly listed as `detach-batch` actions in the manifest. Actual conflict, comparison and provenance dependencies can expand the selected records and are presented before approval.

Traversal compares complete structured values and object keys, parses nested serialized payloads including JSON scalars, and reaches a fixed point across cycles. Exact strings inside source, Info and project-output bodies are matched against known content hashes. Source event UUIDs shared across sessions or object kinds require qualified references resolved against the actual archive inventory; a known source-owner/event pair retains that exact source dependency. An unresolved ambiguous reference stops the operation. Text containing an ID as only a substring is not a reference.

## Approval and atomicity

Core binds the preview to the current maintenance coordinator, epoch, operation, manifest and fresh token/nonce. The CLI acknowledges presentation only after the complete output write finishes. Core accepts an input object minted by its live input receiver after that acknowledgement; copied objects, earlier inputs and generic or contradictory phrases cannot approve deletion.

Before preview and commit, maintenance runs the existing canonical integrity audit, including SQLite quick/FK checks, stream continuity, request ledger and head replay. Failed canonical health prevents both operations. The commit also rechecks maintenance exclusivity, resource identities, complete carrier hashes, backup inventories and the exact manifest. A short SQLite transaction then:

1. Removes the database closure and checks the remaining references and foreign keys.
2. Preserves qualifying historical owner receipts without changing their receipt bytes; removes the record/revision/source and contentful event wrapper around them.
3. Appends `purge/logical-commit@1` to `memory_events` and stores the same operation's content-free result plus sensitive cleanup continuation in `pending_operations`.
4. Moves the store fence to `cleaning`.

A failed database postcondition rolls back all four actions and performs no external deletion. The durable commit is the cancellation boundary. Lost acknowledgements are reconciled through the stored operation and receipt, including after a proved-dead coordinator is replaced. Missing or corrupt continuation evidence keeps admission closed.

The continuation stores selected carrier entry/file identities, hashes, backup cleanup manifests and the bound carrier inventory. It contains no canonical memory body or frozen record snapshot, is unavailable to normal search/model input, and is removed by the later cleanup path. New runtime registration, source access through ordinary activities, capture, backup and model dispatch remain blocked while it exists. No `controlled-complete` receipt is produced here.

## Evidence

`fixtures/t21-purge-cases.json` identifies the synthetic corpus. `scripts/evidence-purge.ts` drives real CLI processes and live stdin, records their output, and independently reads SQLite and file bytes. Each run writes `artifacts/t21-<timestamp>/receipt.json` with fixture digest, implementation commit/tree/working-tree state, environment, commands, raw observations and artifact hashes. Per-case `before` and `after` copies are retained by the independent evidence runner outside the application's controlled cleanup boundary.

The runnable cases cover separate/shared batches, owner correction/forget/restore, rollback, published source/proposal/query references, conflict relationships, Historian metadata, qualified source identity and ambiguous partial references, nested body/scalar copies, controlled project output, backups/recovery originals, failed canonical health and damaged streams/ledgers, transaction postcondition failure, coordinator exit before commit, lost acknowledgement after commit, cancellation, changed preview and unknown carriers. The process tests also exercise old-runtime exclusion, incomplete presentation, copied approval input, unknown database schema and normal-runtime maintenance guidance.

Controlled project output uses the existing Windows file Host. Other platforms record that case as an evidence gap while running the portable logical-purge cases. Physical deletion of source/Host/backups, SQLite main/WAL/free-page maintenance and the final controlled-complete gate remain unverified by this receipt. Source/archive deletion has a separate T22a receipt; the other cleanup participants have a separate T22b receipt. T24 checks the enabled-path integration.

Disposable schema is 26. Older disposable stores must be recreated. The separate forward-migration test copy advances to 27; it does not freeze the production v1 schema.
