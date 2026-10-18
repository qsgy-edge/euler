# Capture, independent verification and analysis handoff

Issue: [#13](https://github.com/qsgy-edge/euler/issues/13). This implementation uses disposable schema version 15, synthetic archives and controlled test transport. It has no production migration, MC access, background daemon or automatic memory activation.

## Run and inspect

```sh
npm ci --ignore-scripts
npm run typecheck
node apps/cli/src/main.ts capture --scenario synthetic
node apps/cli/src/main.ts handoff --scenario synthetic
npm run evidence:capture
```

Each command creates a disposable sandbox unless `--sandbox <root>` is supplied. `capture` prints the root, frozen synthetic requests and durable result; `handoff` prints the report reference, approved section and standalone Markdown export. Keep the printed root to inspect or reopen it:

```sh
node apps/cli/src/main.ts capture-status --sandbox <root>
node apps/cli/src/main.ts capture-reconcile --sandbox <root> --job <job-id>
```

`capture --scenario protocol|block|evidence-gap|unknown` runs the corresponding fixed case from `fixtures/t13-capture-cases.json`. Repeating a case in the same sandbox preserves its job and attempt identity. A terminal block or unknown never silently starts another request. The demo drains only its own fixture job. `--transport-config` is rejected by these synthetic demo commands; real-provider acceptance needs a separately authorized Host route and remains unverified.

## Capture ownership and execution

`AgentRun` durably queues normal capture at a fully settled ReAct tool batch and at task completion. Bound input, archived full model responses and settled tool results form the source range; provisional text, unconsumed queued inputs and unknown tool effects are excluded. Typed owner preference/decision statements retain T12's deterministic parsing and owner gates; this normal pipeline supplies its complete fixed event range to the semantic Proposer. An untyped owner “remember” instruction keeps the same pending job across replay and restart. A correction or an exact owner approval tied to the current revision/head can enqueue reverification. Existing capture triggers and consumer flags continue to use `capture_jobs`.

The Host's explicit `drainCaptures` call accepts a bounded batch, deadline, frozen role configuration, budget and I/O adapter. It can run at a Host's cooperative boundary; the synthetic CLI invokes it explicitly. The foreground `agent` command queues jobs but does not choose background provider credentials or routes. No timer or process is installed to drain them automatically.

`capture_work` holds the phase, blocker, source budget, lease generation and exact candidate head. Leases belong to a real durable job. Proposer and Verifier each claim one lease for their primary/fallback chain; both use the same job-owned execution stream and cumulative budget. A candidate commit releases the Proposer lease before verification. Retired holders cannot commit another phase.

Proposer can return a bounded ordinary memory claim or null. Harness supplies scope, owner, provenance and initial `candidate + unverified` state. It rejects model-supplied governance fields. Basic-capability extraction cannot advance fact/insight/episode claims; a basic Verifier leaves an evidence gap. Other explicit role routes are bounded ordered configuration, recorded with requested/actual provider, model, auth namespace, capability, role and fallback ordinal.

The Verifier starts without Proposer conversation or its answer rationale. It receives the fixed claim and source references, then uses `source.search` and `source.expand` against raw range and published project evidence. Search reports coverage/truncation; expansion respects the discovered approved range. Source tools execute only after a complete response is archived and the attempt settles. Durable tool envelopes distinguish success/failure, preserve argument identity, and pair results with their calls on recovery.

A pass requires independently expanded evidence and minimum type/scope gates. Objective facts require a successful ledger-backed file observation; episodes require a completed task with supported results. User statements alone do not prove an objective fact. Failed, missing, stale or insufficient evidence remains blocked/evidence-gap. Verification freezes the exact claim head in each request assembly; a changed head fails before dispatch or settlement. A passed ordinary candidate remains inactive for T14, and produces no active-memory Info batch.

Only Host-observed temporary failure, timeout, rate limiting and structured-output protocol failure can use the next configured fallback. A Verifier block/evidence-gap, permanent failure or insufficient capability does not trigger another model to seek a different verdict. Assembly and started barriers, role/request/output hashes and real job ownership reuse the request ledger. Started without finished remains unknown; receiver reconciliation records observed receipt without authorizing resend. Provider TTFT/cache remain null when the adapter has no observation.

## Reports and project handoff

`AnalysisArtifacts` saves immutable report versions as archived assistant text, separating facts, inferences, recommendations, unresolved items and evidence references. A deterministic caller-supplied event ID supports append-ack reconciliation. A repeated ID must match the original bytes. Full reports remain readable in their originating active task; a target project receives a separately approved `report-section` with exact source identity and Unicode offset/length.

Project discovery reuses `publishSourceUnit`, `searchSources`, `expandSource` and their outbox projection. Cross-project proposals must reference an approved unit for the target project; source owner/project remain those of the original archive. Proposals stay inert and versioned, and never grant implementation authority or become verified memory.

Explicit Markdown export freezes the selected unit identities/hashes and an archived user approval. It embeds the selected material, source owner/project, locator, archive hash, section hash and report version, and saves the export itself in the archive. Private unselected report text is excluded. Proposal exports include their stored scope, non-goals, acceptance and provenance. Export does not contact another agent or publish externally.

Selected temporary handoff Markdown is saved as complete UTF-8 text with its content hash; deleting the temporary file does not remove the archived copy. The same archive/discovery path works without a handoff Skill. Suggested skill text is inert. Selection, publication, export and reads use existing task/owner/project authorization; task completion revokes full report access without deleting approved project units.

The disposable schema has no migration path. Previous schema versions are rejected. Maintenance treats capture runtime as an owned row, preserves ledger evidence for referenced jobs, and applies existing retention and scope gates; controlled privacy purge and backup/recovery acceptance remain with T22/T20.

The actual carrier/reference inventory for those owners is:

| Carrier | Owned data and references |
| --- | --- |
| Registered session JSONL | Original events, report/handoff/export bodies and immutable versions, approvals, model responses and source tool envelopes; `SourceAck` binds the session, event, locator and hashes. |
| `capture_jobs`, `capture_work` | Fixed raw range, record/head, source inspection refs, budgets, lease generation and job-owned request run. |
| `memory_records`, `memory_revisions`, `memory_heads`, `memory_events`, `provenance_refs` | Candidate and verification history with original source identity. |
| `verification_runs`, `verification_evidence` | Immutable result and exact inspected evidence for a revision/head. |
| `source_units` | Approved report sections and selected handoff units; source/approval refs, project, version, offset/length and content hash. |
| `evolution_proposals`, `proposal_evidence`, `proposal_source_units` | Inert versioned payload, original evidence, approved target units and superseded proposal identity. |
| `source_projection_jobs`, `source_projection_health`, `search_documents`, `search_fts` | Rebuildable discovery/outbox state; search copies do not become canonical sources. |
| `memory_discovery_grants`, `memory_discovery_projects`, `memory_discovery_targets`, `source_query_receipts` | Existing task-bound cross-project read grants and bounded query/expansion receipts. |
| `execution_streams`, `request_runs`, `request_assemblies`, `request_attempts`, `request_events` | Durable job ownership, frozen claim head, source refs, route/budget/payload hashes and attempt/reconciliation facts. |
| `counting-receiver.jsonl`, evidence directories | Controlled synthetic receiver and explicitly retained evidence copies; evidence receipts list their locations and digests. |


## Validation and evidence boundaries

Focused tests cover job identity, phase lease handoff, independent source tools, configured fallback, source loss, same-identity report append reconciliation, old report/proposal versions, cross-project section isolation, standalone export and temporary-file recovery. Real child-process kill probes cover started-before-send, received-before-finished and committed-candidate recovery. Existing agent, request-ledger, source, owner-memory and maintenance tests protect integration boundaries.

`npm run evidence:capture` writes a receipt under `artifacts/t13-<timestamp>/`, retains synthetic sandbox copies, captures actual child stdout/stderr and records command/exit/environment/commit/fixture/file digests. Its raw checker opens the persisted SQLite and JSONL, recomputes source/output/request hashes, checks the receiver, job stream, candidate lifecycle, verification evidence and export section. Receipt metadata never embeds report/proposal/memory bodies. Exact outputs remain in hashed raw artifacts.

CI runs the synthetic evidence command on Windows, macOS and Linux. A local run supports only the platform in its receipt; consult actual CI artifacts for the other platforms. The evidence result stays `evidence-gap` even when all synthetic checks pass because real model quality, non-CLI Host integration, T20/T22/T24 closure and torn-archive append fault coverage tracked by #38 are unverified. A synthetic result is not complete X-04 acceptance.
