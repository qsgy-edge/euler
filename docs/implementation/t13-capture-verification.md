# Capture, independent verification and analysis handoff

Issue: [#13](https://github.com/qsgy-edge/euler/issues/13). This implementation uses disposable schema version 17, synthetic archives and controlled test transport. Ordinary activation uses the [promotion and feedback gates](t14-memory-evolution.md). It has no production migration, MC access or background daemon.

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

`capture --scenario protocol|block|evidence-gap|unknown` runs the corresponding fixed case from `fixtures/t13-capture-cases.json`. Repeating a case in the same sandbox preserves its job and attempt identity. A terminal block or unknown never silently starts another request. The demo drains only its own fixture job. `--transport-config` is rejected by these synthetic demo commands.

Ordinary jobs use the existing controlled HTTP transport and an explicitly selected background configuration:

```sh
node apps/cli/src/main.ts capture-drain --sandbox <root> --capture-config <test-transport.json>
node apps/cli/src/main.ts agent --sandbox <root> --scenario tool --capture-config <test-transport.json>
node apps/cli/src/main.ts remember --sandbox <root> --capture-config <test-transport.json>
```

The configuration uses the same `provider`, `model`, `baseUrl`, `authNamespace`, `credentialEnv`, `contextWindow`, `maxTokens`, `budget` and `authorization: "synthetic-test-only"` fields as the foreground transport, plus an explicit `captureCapability: "basic" | "standard" | "high"`. The CLI binds that one route to both independent role contexts; the Core/Host API also accepts ordered per-role fallback routes. Credentials come only from the named environment variable. It asynchronously runs the existing transport prerequisite checks plus capture tests before its first background send; foreground controls and input consumption stay available during those checks. Local HTTP is limited to loopback; other endpoints require HTTPS. No external provider credentials are supplied by the repository, so actual provider quality remains unverified.

## Capture ownership and execution

`AgentRun` durably queues normal capture at a fully settled ReAct tool batch and at task completion. Bound input, archived full model responses and settled tool results form the source range; provisional text, unconsumed queued inputs and unknown tool effects are excluded. Typed owner preference/decision statements retain T12's deterministic parsing and owner gates; this normal pipeline supplies its complete fixed event range to the semantic Proposer. An untyped owner “remember” instruction keeps the same pending job across replay and restart. A correction or an exact owner approval tied to the current revision/head can enqueue reverification. Existing capture triggers and consumer flags continue to use `capture_jobs`.

The Host's `drainCaptures` call accepts a bounded batch, deadline, frozen role configuration, budget and I/O adapter. Agent and remember sessions schedule cooperative work at startup, canonical boundaries and agent-end/idle; `capture-drain` is the explicit queue-maintenance entry. The scheduler coalesces triggers, yields to foreground input, and never awaits a background model in the command reader. Unstarted work waits while a foreground run is active; settled background responses can release the lease and defer the next request without changing job, attempt history or cumulative budget. Missing configuration persists `capture-route-unavailable` without inventing a budget or starting a lease. Invalid configuration and prerequisite failure remain visible and durable. No recurring timer or daemon is installed.

Core tracks a live background pump only in its owning Store instance, bound to its exact job/run, lease token, activity and generation. Foreground requests may proceed alongside that observed pump while its lease/deadline and authorized run remain valid. A different Store, restart, expired lease, sealed run, recovery gap or failed pump has no exemption from the existing recovery gate. This volatile observation never changes the durable attempt outcome. A complete reply arriving after sealing, revocation or a recovery gap is archived and settles the actual received attempt, but its result is quarantined with `late-model-result`. Tools and memory mutations recheck authorization inside their Store transaction; no candidate or verification change is applied. Closing the session cancels the pump before closing its Store; a sent request without a settled reply stays unknown.

`capture_work` holds the phase, blocker, source budget, lease generation and exact candidate head. Leases belong to a real durable job. Proposer, claim verification and each fixed comparison claim an isolated lease for their primary/fallback chain; all use the same job-owned execution stream and cumulative budget. A candidate commit releases the Proposer lease before verification. Retired holders cannot commit another phase.

Proposer can return a bounded ordinary memory claim or null, with optional untrusted applicability and validity bounds. Harness supplies scope, owner, provenance and initial `candidate + unverified` state. It structurally validates the bounds and includes them in independent verification, while rejecting model-supplied governance fields. Basic-capability extraction cannot advance fact/insight/episode claims; a basic Verifier leaves an evidence gap. Other explicit role routes are bounded ordered configuration, recorded with requested/actual provider, model, auth namespace, capability, role and fallback ordinal.

The Verifier starts without Proposer conversation or its answer rationale. It receives the fixed claim and source references, then uses `source.search` and `source.expand` against raw range and published project evidence. Search reports coverage/truncation; expansion respects the discovered approved range. Published sections are selected by their destination project while retaining their original source owner/project. Verification records the inspected source-unit identities in its immutable event, and rechecks those publication approvals and original archives when reading or using the verified record. Source tools execute only after a complete response is archived and the attempt settles. Durable tool envelopes distinguish success/failure, preserve argument identity, and pair results with their calls on recovery.

A pass requires independently expanded evidence and minimum type/scope gates. Objective facts require a successful ledger-backed file observation; episodes require a completed task with supported results. User statements alone do not prove an objective fact. Failed, missing, stale or insufficient evidence remains blocked/evidence-gap. Verification freezes the exact claim head in each request assembly; a changed head fails before dispatch or settlement. The verification primitive returns a qualified candidate. The cooperative runtime then invokes the separate promotion/comparison gate; activation and its Info batch commit atomically only after that gate passes.

Only Host-observed temporary failure, timeout, rate limiting and structured-output protocol failure can use the next configured fallback. A fully received HTTP response with invalid encoding, JSON, tool arguments or excessive capture tool-call count settles as received with a sanitized protocol failure and the original response digest; valid observed usage remains chargeable. Interrupted deliveries retain unknown status and cannot use protocol fallback. Actual usage is charged conservatively against request-byte estimates and output reserves, and rechecked at assembly, durable admission and final send. Archive/Host exceptions retain a bounded diagnostic code in the durable job and propagate to the caller after conservative settlement. Foreground integrations display `capture-error` with a diagnostic hash and stop that session's worker, keeping foreground error handling and controls available; the explicit drain command propagates failure. A Verifier block/evidence-gap, permanent failure or insufficient capability does not trigger another model to seek a different verdict. Assembly and started barriers, role/request/output hashes and real job ownership reuse the request ledger. Started without finished remains unknown; receiver reconciliation records observed receipt without authorizing resend. The Host freezes the adapter identity with the role configuration: only explicit `capture-counting@1` attempts use the counting receiver. `capture-http@1` and undeclared adapters have no receipt-query capability here, so reconciliation reports unavailable and retains unknown rather than consulting the counting file. Provider TTFT/cache remain null when the adapter has no observation.

## Reports and project handoff

`AnalysisArtifacts` saves immutable report versions as archived assistant text, separating facts, inferences, recommendations, unresolved items and evidence references. A deterministic caller-supplied event ID supports append-ack reconciliation. A repeated ID must match the original bytes. Full reports remain readable in their originating active task; a target project receives a separately approved `report-section` with exact source identity and Unicode offset/length.

Project discovery reuses `publishSourceUnit`, `searchSources`, `expandSource` and their outbox projection. Full analysis artifacts cannot be used as raw proposal input/evidence to publish mixed reports through an originating project. Every proposal requires an independently archived user input `{ "schema": "analysis-proposal-approval@1", "proposal": <exact proposal input> }` binding the complete proposed payload, evidence and destination, including proposals derived from ordinary Markdown or raw archive events. Full analysis artifacts use approved source units for their background. Changing the proposed text requires another approval even when its background unit was already published. These gates are checked again on reads. Cross-project proposals must reference an approved unit for the target project; source owner/project remain those of the original archive. Proposals stay inert and versioned, and never grant implementation authority or become verified memory.

Explicit Markdown export freezes the selected unit identities/hashes and an archived user approval. It embeds the selected material, source owner/project, locator, archive hash, section hash and report version, and saves the export itself in the archive. Private unselected report text is excluded. Proposal exports include their stored scope, target type, risk, evaluation level, non-goals, acceptance and provenance, approved unit background and legacy raw evidence text with immutable event/hash references. Unavailable evidence fails explicitly rather than silently omitting it. Export does not contact another agent or publish externally.

Selected temporary handoff Markdown is saved as complete UTF-8 text with its content hash; deleting the temporary file does not remove the archived copy. The same archive/discovery path works without a handoff Skill. Suggested skill text is inert. Selection, publication, export and reads use existing task/owner/project authorization; task completion revokes full report access without deleting approved project units.

The disposable schema has no migration path. Previous schema versions are rejected. Maintenance treats capture runtime as an owned row, preserves ledger evidence for referenced jobs, and applies existing retention and scope gates; controlled privacy purge and backup/recovery acceptance remain with T22/T20.

The actual carrier/reference inventory for those owners is:

| Carrier | Owned data and references |
| --- | --- |
| Registered session JSONL | Original events, report/handoff/export bodies and immutable versions, approvals, model responses and source tool envelopes; `SourceAck` binds the session, event, locator and hashes. |
| `capture_jobs`, `capture_work` | Fixed raw range, record/head, comparison event, source inspection refs, budgets, lease generation and job-owned request run. |
| `memory_records`, `memory_revisions`, `memory_heads`, `memory_events`, `provenance_refs` | Candidate and verification history with original source identity. |
| `verification_runs`, `verification_evidence` | Immutable result and exact inspected evidence for a revision/head. |
| `source_units` | Approved report sections and selected handoff units; source/approval refs, project, version, offset/length and content hash. |
| `evolution_proposals`, `proposal_evidence`, `proposal_source_units` | Inert versioned payload, original evidence, approved target units and superseded proposal identity. |
| `source_projection_jobs`, `source_projection_health`, `search_documents`, `search_fts` | Rebuildable discovery/outbox state; search copies do not become canonical sources. |
| `memory_discovery_grants`, `memory_discovery_projects`, `memory_discovery_targets`, `source_query_receipts` | Existing task-bound cross-project read grants and bounded query/expansion receipts. |
| `execution_streams`, `request_runs`, `request_assemblies`, `request_attempts`, `request_events` | Durable job ownership, frozen claim head, source refs, route/budget/payload hashes and attempt/reconciliation facts. |
| `counting-receiver.jsonl`, evidence directories | Controlled synthetic receiver and explicitly retained evidence copies; evidence receipts list their locations and digests. |


## Validation and evidence boundaries

`npm test` runs files serially. Transport preflight launches a separate Node test runner with at most four file workers and removes inherited Node test-runner context before launch. Each prerequisite fixture owns separate disposable resources, allowing independent durable I/O to overlap. Existing per-test deadlines retain their budgets.

`capture-cooperative.test.ts` runs the complete prerequisite command before its real HTTP capture and verification loop. `capture-background.test.ts` uses a test-only preload to control that subprocess's accept/reject outcome while exercising the real CLI, HTTP, persistence and foreground controls. Its prerequisite observation records the actual fixture command. A rejected prerequisite must persist its blocker and send zero HTTP requests.

Focused tests cover job identity, phase lease handoff, independent source tools, configured fallback, source loss, same-identity report append reconciliation, old report/proposal versions, cross-project section isolation, standalone export and temporary-file recovery. Real child-process kill probes cover started-before-send, received-before-finished and committed-candidate recovery. Existing agent, request-ledger, source, owner-memory and maintenance tests protect integration boundaries. A local HTTP receiver test drains ordinary remember and Agent jobs at startup and agent-end, independently matches transmitted payload hashes to job-owned attempts, and verifies zero resend on a repeated drain. Additional real CLI probes preserve piped startup commands, withhold HTTP replies while foreground answers/controls continue, and kill an HTTP sender to prove unknown cannot reconcile against an empty counting file. Lease-expiry, Store isolation, sealing, recovery-gap and pump-failure tests protect the live-pump boundary. Successful late Proposer, Verifier and tool replies after sealing, revocation or a recovery gap retain request facts with zero memory/tool effects. Owner agreement tests interleave a background reply with a visible proposal, restart the CLI and check the exact proposal reference, including a job originating in another session of the same project. Output ownership uses its actual recorded SourceAck and the job owner/project, preserving the distinction between input and output sessions; an unrecorded response append uses its owned attempt identity. Copied recorded outputs in another session/project are not background output there. Foreground replacements and duplicate agreements remain invalid.

`npm run evidence:capture` writes a receipt under `artifacts/t13-<timestamp>/`, retains synthetic sandbox copies, captures actual child stdout/stderr and records command/exit/environment/commit/fixture/file digests. Its raw checker opens the persisted SQLite and JSONL, recomputes source/output/request hashes, checks the receiver, job stream, candidate lifecycle, verification evidence and export section. Receipt metadata never embeds report/proposal/memory bodies. Exact outputs remain in hashed raw artifacts.

CI runs the synthetic evidence command on Windows, macOS and Linux. A local run supports only the platform in its receipt; consult actual CI artifacts for the other platforms. The evidence result stays `evidence-gap` even when all synthetic checks pass because real model quality, non-CLI Host integration, T20/T22/T24 closure and torn-archive append fault coverage tracked by #38 are unverified. A synthetic result is not complete X-04 acceptance.
