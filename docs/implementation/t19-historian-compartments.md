# Stable Historian compartments

The authority is v1 I05/I08–I10, Ticket 13 D4/D5, and the Historian portions of X-04/X-07/X-14. The implementation uses the previously approved Core public operation/result boundary and actual CLI/HTTP entry points. No formal behavior amendment is required; the tests and evidence runner extend the existing harness.

## Run and inspect

```powershell
npm run demo -- historian
npm run demo -- historian --scenario protocol
npm run demo -- historian --scenario block
npm run demo -- historian --scenario evidence-gap
npm run demo -- historian --scenario unknown
npm run demo -- historian --scenario cancel
npm run evidence:historian
npm run demo -- historian --scenario real --transport-config C:/path/to/authorized-test-route.json
npm run demo -- agent --scenario tool --historian-config C:/path/to/authorized-test-route.json
npm run demo -- historian-drain --sandbox <root> --historian-config C:/path/to/authorized-test-route.json
npm run demo -- capture-status --sandbox <root> --job <job-id>
npm run demo -- capture-reconcile --sandbox <root> --job <job-id>
```

The real route uses the existing controlled HTTP format: explicit provider/model/base URL, auth namespace, credential environment-variable reference, model limits, complete budget, `authorization: "synthetic-test-only"` and `captureCapability: "standard" | "high"`. Missing configuration sends nothing. No ambient Pi provider or credentials are discovered. Preflight runs the existing archive/ledger/runtime checks and Historian checks before HTTP. Protocol and temporary transport failures may use only configured fallback routes; explicit block/evidence-gap and insufficient capability do not. An explicit Historian denial remains terminal when the same response also contains unexpected or excessive tool calls; no source tool executes and accepted denial text stays archived. A fully received HTTP response retains its validated assistant text when tool metadata is malformed. Interrupted responses remain unknown, and decoded credential echoes are rejected before archiving.

The demo keeps the foreground observations synthetic and permits only the Historian call on the selected external route. The normal Agent command schedules a separately configured Historian cooperatively; its command reader and foreground model loop do not await background generation or preflight. The existing scheduler owns cancellation, bounded drains and visible failure reporting. To supplement a completed range whose job was not committed, add `--request <original-run-id>` to `historian-drain`; it reuses the durable raw identity and does not reappend source events.

## Raw range and stable publication

Core derives input from admitted owner inputs, archived complete model responses and settled tool results in the original Agent ledger. File operations retain their complete archived presentations and separate owner approvals alongside the corresponding result. Active tasks keep their most recent complete ReAct pair outside the compressible prefix. Explicitly configured Agent sessions enqueue after a complete pair once the prefix reaches 4 KiB, and at task completion. Each range is bounded to 60 KiB; an oversized range retains the raw/fresh-window path. Unsettled/unknown tool batches, absent durable sources and granted cross-project analysis do not enqueue this local-session lane. The latter continues to use T18 recovery and fresh windows.

A separate `historian` consumer uses the existing `capture_jobs`, `capture_work`, job-owned execution stream, leases, frozen budget and request barriers. Memory capture remains a separate consumer. Range boundaries advance only over original Agent events; background model output and published compartment bodies are never selected as the next raw range. Repeating a boundary reuses its existing job, and a completed job never generates another summary. Source, owner, session, project, raw hash, route and attempt identities come from Core and actual transport observations.

The model returns a bounded summary or an explicit negative result. Harness copies exact owner inputs, their preceding response when present, tool-result envelopes, final task results and immutable citations from the raw range. Leading inputs at an incremental boundary also retain the preceding complete response and its tool results as raw dependencies, so an approval keeps its proposal across segments. These mandatory anchors and the session/project/run applicability envelope cannot be rewritten by the summary response. This conservative representation can be larger than a wholly lossy summary; it falls back to raw windows when it does not fit. Model summary text remains untrusted historical context, and semantic fidelity still needs real-provider evaluation.

A complete model reply is archived and its attempt settled before publication. Only a validated result produces a structured `compartment@1` archive entry and an immutable `compartments` metadata row. A failed/incomplete result has no published locator. The deterministic publication event identity permits replay after a received response but before publication without another model call. A publication failure in the actual pump releases the lease with `historian-publication-pending` and still reports the error. A later claim resumes the saved response within the unchanged job budget and deadline; an already appended body is reused by identity. Its durable job identity marks the body as derived even if the process dies before the publication row commits. Unknown attempts remain unknown after receiver reconciliation and cannot be retried by reopening or taking over a lease.

A volatile Store-local observation ties a live foreground pump to the exact Historian job derived from it. This permits background work on an already frozen prefix without treating an abandoned foreground run as live. Another Store or process restart cannot borrow the observation. Foreground admission retains the existing live-background-pump check; unknown attempts from an unobserved job still block it.

## Selection and recovery

Generating a compartment creates no frontend window or epoch event. `AgentRun.newWindow()` selects published local compartments only at a settled complete boundary. The complete encoded request determines their available budget after mandatory content, output reserve and safety margin; there is no fixed component percentage. Oversized selections shrink at another complete window boundary, including provider encoding overhead. The window freezes their job/source identities. The new assembly includes the structured bodies, exact active instructions and intent, the latest complete pair, and raw recovery anchors. Prefix changes then create a new epoch. Old sent payloads and receipts remain immutable.

Assembly, started and send gates recheck the selected compartment and its raw dependencies. Missing/corrupt optional bodies are reported as compartment gaps and use a raw window; corruption after assembly prevents sending the stale snapshot. Older settled assemblies can validate a compartment through its immutable publication identity and complete original raw range, so a damaged historical body does not block fresh-window model/tool admission, reconciliation of a later request, or linked recovery after reopening. Current and unresolved requests retain strict artifact checks; historical inspection still reports the unavailable artifact. Additional pressure can drop optional compartments at a new boundary. Mandatory content and cumulative run budgets retain T18 behavior. Exact parameters, wording and citations remain recoverable through the original `source.search/source.expand` path. Session searches exclude background outputs; raw expansion and project source publication reject their durable identities, including damaged or unpublished compartment bodies and altered archive roles. Publication and discovery/export approvals, task inputs and pending-operation approvals reject durable derived identities on admission and reread. Analysis evidence checks nested direct references as well as source units before publication or use as memory evidence; its task, preceding-version and export-approval references retain the same identity check. A literal analysis marker without the complete header delimiter remains raw text for capture and source recovery. Explicit document reads require a parsed header, and framed documents retain header, body-hash and reference checks. Memory capture, owner statements and proposal agreements, verification/reverification, feedback, correction/revision and evolution proposals enforce the same raw-source eligibility. Memory reads and eligibility recheck their source, verification and provenance references. Owner backfill skips durable derived identities even if their current archive role or text was changed into an owner command. Summary text does not substitute for the referenced raw bytes.

## Ownership and evidence

Disposable schema 22 has no migration path. Previous probe databases are refused. Body carriers remain registered session JSONL; no additional filesystem carrier is introduced.

| Carrier | Owned content and cleanup references |
| --- | --- |
| Session JSONL | Original events, complete Historian replies and structured compartment bodies; session/archive owner retains their immutable event IDs, locators and hashes. |
| `capture_jobs` / `capture_work` | Consumer, fixed raw range and hash, originating run and complete boundaries, owner/scope, lease generation, configuration/budget, job-owned request run and terminal blocker. |
| `compartments` | Immutable publication source reference, actual received attempt and complete metadata digest, owned by the job and original session. |
| Request streams/assemblies/attempts/events | Role/model/fallback/config/prompt/schema/adapter identities; input/output hashes, frozen selections, actual request facts and lifecycle links. |
| Counting receiver and evidence directories | Synthetic transport receipts and explicitly retained stdout/stderr/SQLite/JSONL copies, with file digests in the evidence receipt. |

T20 backup and T21–T22 purge must include these rows and all raw/output/selection references. Cleanup must stop their owning pumps before clearing derived copies. This ticket does not implement or claim that later closure.

Focused tests cover stable identity, nonrecursive input, mandatory anchors, selection/epoch timing, source loss, inadequate capability, negative verdicts, protocol fallback, unknown reconciliation, missing-job supplementation, publication interruption, reopening, corruption and Store isolation. Actual process-kill tests cover durable raw input before enqueue and the started, send, received-response, body-append and publication boundaries. The real CLI HTTP test runs the complete preflight, independently compares transmitted bytes to request hashes and publication attempts, and verifies zero sends after rejected preflight. The evidence runner launches actual child commands for success, protocol fallback, both negative verdicts, unknown and cancellation, reopens each sandbox in another process, and independently checks SQLite/archive/receiver/raw-request artifacts without using the product's validator.

`npm run evidence:historian` writes a content-free receipt and hashed raw artifacts under `artifacts/t19-*/`. CI runs it and the full tests on Windows, macOS and Linux; local evidence proves only the recorded local platform. External-provider fidelity/long-session quality, torn/unknown archive-append closure tracked by #38, backup/purge and production data remain explicit evidence gaps. The receipt remains `evidence-gap` when synthetic checks pass. MC access, live owner switching, Pi integration, daemon/IPC and real user data are outside this controlled path.
