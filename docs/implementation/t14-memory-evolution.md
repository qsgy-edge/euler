# Ordinary memory promotion, comparison and feedback

Issue: [#14](https://github.com/qsgy-edge/euler/issues/14). Product behavior and persistent schema changes use a feature branch and PR. The implementation uses disposable schema 17 and synthetic data; older sandboxes are rejected rather than migrated. The governing contracts remain Ticket 08 §§8–20 and I05/I06/I17.

## Run and inspect

```sh
npm run typecheck
node --test apps/cli/test/memory-evolution.test.ts apps/cli/test/memory-evolution-boundaries.test.ts
npm run evidence:memory-evolution
node apps/cli/src/main.ts capture --scenario synthetic
```

The evidence command writes `artifacts/t14-<timestamp>/receipt.json`, child stdout/stderr and retained raw sandboxes. Its fixture is `fixtures/t14-memory-evolution-cases.json`. Keep the root printed by the capture command to inspect its durable state:

```sh
node apps/cli/src/main.ts capture-status --sandbox <root>
node apps/cli/src/main.ts info --sandbox <root>
node apps/cli/src/main.ts remember --sandbox <root>
```

In a remember session, `info <batchId>` presents the frozen update and each member's current record. The owner can use the displayed record and head IDs:

```text
feedback <recordId> <headEventId> helpful
feedback <recordId> <headEventId> wrong
feedback <recordId> <headEventId> stale
feedback <recordId> <headEventId> safety
```

The command archives the literal input and its exact structured decision. A changed head is rejected before feedback commits. Helpful feedback leaves the memory head and verification unchanged. Wrong, stale and safety feedback stop normal injection; an eligible previous revision can be restored atomically. Source loss, expiry and feedback status remain queryable through canonical events. `ask <question>` reports status warnings without injecting stale/conflicted bodies.

Configured background capture continues to use the explicit synthetic-test transport described in [capture verification](t13-capture-verification.md). No provider credentials or additional model budget are inferred.

## Promotion and comparison

The independent verification primitive leaves a qualified candidate. `CaptureRun` then calls the Core promotion gate before sealing its job-owned request run. An ordinary candidate must be a resolved project record with independent verification, current source/time qualification and no unresolved conflict. First activation reuses `activateMemoryBatch`; activation, ordered batch membership, search outbox and host-info outbox commit together. Replaying the same activation input does not add another head or batch.

Proposer output permits optional `appliesTo`, `validFrom` and `validUntil` hypotheses alongside `type/content`. Conditions and UTC timestamps pass structural checks, remain unverified candidate data, and are included in the independent verification input. The Verifier must confirm the content and every bound; missing bounds do not authorize broader applicability when the source is narrower or uncertain. Model-supplied scope, owner, authority, provenance and verification fields remain prohibited. Retrieval enforces the verified applicability conditions.

Core freezes at most 32 active records, qualified candidates or suppressed project peers with their exact record/head/source snapshots. Active stale/unverified records remain comparison barriers, and unresolved owner/safety feedback is a required independently inspected source. A larger set blocks with `comparison-coverage-gap`; the gate does not silently truncate the set. Each comparison is a fixed proposition: same claim, distinct subject/environment, candidate supersedes peer, peer supersedes candidate, or credible overlapping conflict. The independent Verifier normalizes the actual subject/resource, environment/component, applicability, observation/as-of/validity and authoritative source meaning from original evidence. A recording host/session is not assumed to be the subject environment.

The Verifier still returns only `pass | block | evidence-gap`, inspected references and a bounded reason. A negative verdict for one proposition supplies no positive proof for another. Every proposition gets a fresh context and source-inspection set; all phases share the original job's request, tool, token and wall-clock budgets. Unknown dimensions or incomplete evidence stop the job visibly. A changed peer set/head rejects admission or settlement, without shrinking the frozen comparison set. Passed comparison evidence is revalidated before activation and subsequent use.

- Same claim attaches provenance and a corroboration event to the active record, and rejects the duplicate candidate without another active entry. Existing duplicates resolve through their immutable `corroborates` proof to the same canonical revision. The canonical record's current stale/conflicted/tombstoned state remains a comparison barrier; a corrected revision cannot inherit the old alias proof. The 32-record coverage bound applies before alias resolution.
- Distinct subjects/environments can coexist; applicability conditions constrain normal retrieval.
- Authoritative temporal replacement or an explicit owner preference/decision update appends a supersession link, retains the old verified version, and activates the new record with its pre-image and batch. An older candidate stays superseded.
- Credible mutually exclusive evidence immediately isolates confirmed members when applicability and validity overlap, then continues independently through the remaining frozen peers. A project-wide claim can conflict with several platform-specific claims. Each expanded group has a new immutable membership snapshot and fresh heads for all its members; continuation survives restart. Unrelated peers remain eligible, and a later evidence gap preserves already confirmed isolation. Disjoint platforms or periods cannot form a conflict set.
- Tombstoned and rejected peers remain comparison barriers, including stale tombstones. A paraphrase does not constitute a restore decision. A fact with an explicitly later, nonoverlapping period may form an unverified candidate; activation additionally requires independent claim and supersession evidence. The old tombstone and its head remain unchanged.

Budget exhaustion is terminal for that job and cannot restart a model chain implicitly. The Core's existing `queueMemoryVerification` accepts an exact archived owner approval for a fresh verification job. It includes unresolved invalidating owner feedback across unsuccessful verification attempts and restarts; a pass requires that complete range to have been independently inspected. Reverification of an active working record returns a candidate which must pass promotion again. Negative-transfer rejection is not cleared by a successful truth-only verification.

## Feedback and recovery

`retrieved` records actual eligible-list/search observations. `injected` is derived from frozen `request_assemblies.used_memories` and payload identities, with request attempts retained separately. Source revalidation and canonical run terminal outcomes have their own feedback facts. Neither exposure, helpfulness nor ordinary task completion/failure changes truth.

`revalidateMemory` checks the selected record's immutable source, current-revision provenance, verification evidence, comparison evidence and validity. Local search and eligibility selection call it cooperatively. Source/hash/owner qualification loss or expiry appends stale state and search invalidation. Cross-project discovery does not perform canonical revalidation writes in the source project. Source observations entering the ordinary pipeline are compared through the same fixed gates. This slice installs no daemon, filesystem watcher or nightly model scan.

Strong negative transfer uses a bounded exact-output canary profile. Before dispatch, each archived user input is a `memory-canary-case@1` object with `caseId` and `expectedText`. An owner feedback decision binds two to eight pairs of distinct run IDs, archived wire payloads and the expected response hashes. Core independently checks one received request and one completed, tool-free response per run, matching route/policy/intent/budget, and wire inputs differing only by the selected memory. It compares archived answer text against the expectation already present in the original user input. Both runs must complete normally; provider errors and ordinary failed runs cannot qualify.

Repeated baseline passes and treatment output regressions can append `rejected + verified` with `negative_transfer`. Truth and utility remain separate. The comparison receipts retain original request/response references and hashes. This exact-output profile does not claim general semantic evaluation or held-out quality.

Automatic feedback rollback uses pre-images from automatic revision or ordinary supersession activation events. For a separate superseded record, its current head must still match the saved supersession head. Core rechecks original source, validity, verification and suppression, then restores eligible previous records in one fixed Info batch. Revoked replacement links stop contributing evidence requirements to the restored version; its original verification sources still apply. A missing/ineligible previous leaves no normally usable conclusion; an older temporal observation is not assumed current. The rejected/stale replacement remains in history. Feedback replay does not duplicate either the rejection or restoration.

Agent and remember background batches drain the existing owner Info carrier when they finish. Explicit capture/drain commands also perform delivery. Delivery failures leave the canonical update and pending outbox intact. Restart retries delivery by batch identity and preserves unread/read state; it never reruns activation to reconstruct a notice.

## Evidence and ownership

The evidence runner launches real child processes, preserves their actual streams, and independently opens SQLite/JSONL. It recomputes source, revision, memory-event, comparison, request, feedback, batch and owner-entry hashes; checks state chains and foreign keys; matches sent bytes to the counting receiver; and recomputes canary outcomes from archived outputs. Source-fault scenarios preserve the original archive separately for historical verification. Receipts contain metadata and digests; bodies remain in the referenced raw artifacts.

The full transport comparison fixture explicitly uses a 128,000 conservative token budget. A separate 65,536-budget fixture proves that cumulative comparison costs stop before a second activation and that another drain does not resend. The multi-member conflict fixture starts with two independently verified records and gives the new capture a 262,144 budget: 23 actual transport attempts and 32 independently recorded source operations. Search and expansion use the existing ordered tool-call batch within each isolated verifier context; the 30-second wall-clock budget is unchanged. These are local counting transports, with no external model spending.

New persistent references use existing carriers: `capture_work.comparison_event_id`; comparison/supersession/corroboration/stale/rejection/rollback metadata in `memory_events`; feedback payloads in `feedback_events`; and the existing activation/Info/search outboxes. Feedback records bind the observing project/session and frozen revision/head. Canary payloads, responses, expectations and approvals remain in registered session archives. These bodies and cross-record/source links belong in the existing backup/purge closure; no extra product carrier or global registry is introduced.

CI runs the synthetic evidence command on Windows, macOS and Linux. Each receipt supports only its recorded platform and implementation digests. Real provider semantic quality, long-archive comparison throughput, non-CLI Host integration, production backup/purge and torn-archive fault closure remain explicit evidence gaps. Profiling a larger three-job trace reached 40 transport attempts before the 30-second runner limit; repeated archive parsing, hashing and file identity checks dominated that workload. The receipt reports `syntheticPassed` separately from its overall `evidence-gap` result.
