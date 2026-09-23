# T10: scoped memory retrieval (synthetic)

Issue: [#10](https://github.com/qsgy-edge/euler/issues/10). This slice is an independent Core/CLI probe, not a live memory.search tool or a provider answer path. It uses disposable SQLite and synthetic archive inputs only. The schema is disposable version 10; it does not migrate real data.

`ProbeStore.searchMemories(activity, request)` defaults to the bound local project plus applicable workspace/personal memory. `noActiveProject: true` removes that default; it never grants another project. A trusted synthetic Host can bind a read-only discovery grant to the current active intent's durable owner input with `authorizeMemoryDiscovery(activity, consent, projectIds, maxResults, targets?, maxBytes?)`. Only registered projects of the same owner may be granted. The grant is rechecked on every query; completing the task or revoking the grant invalidates it and its cursors. Query-supplied target metadata cannot override a cross-project target fixed by the grant. No operation or guidance scope changes.

Search first checks projection/current-head agreement, then queries bounded FTS candidates and replays their canonical event, revision, verification evidence and source. Latin/digits use NFKC lowercase; Han runs add overlapping bigrams in the projection (`latin-cjk@2`), without changing canonical text. Each literal query group forms a lexical lane; within-lane order is BM25, followed by deterministic round-robin selection and claim/environment/validity dedup. A one-Han-character query is unsupported; no vectors, router/reranker LLM or fixed-result padding. Results carry project, source, version and target labels. Unknown target applicability is `reference_only`; expired/conflicted/stale states return only a bounded status with a claim digest. Dirty/unavailable responses never imply absence. `complete: false` means the result is not a full-history analysis.

## Reproduce

```powershell
npm ci --ignore-scripts
node --test apps/cli/test/memory-retrieval.test.ts apps/cli/test/search-projection.test.ts
npm run check
node scripts/evidence-retrieval.ts
```

The evidence script writes raw observations to `artifacts/t10-*/summary.json` (ignored by Git): implementation commit/worktree state, Node/platform/SQLite, source fixture digest, case-level gold/results, and a cross-project grant/revocation trace. Run again after committing to bind a clean implementation SHA. It does not read MC or create production data.

| Frozen corpus | Role | Raw SHA-256 |
|---|---|---|
| `fixtures/t10-retrieval-dev.json` | development lexical judgments D01-D05 | `c389e0256e980832d96241e6cd84286bf13098d348d795cff4ab4b0009d9c600` |
| `fixtures/t10-retrieval-supplement.json` | development S01-S05 | `d0d63c08714250d356435dad9bf9fae6a0c4eef249991ea2f803dbf94c26240a` |
| `fixtures/t10-retrieval-heldout.json` | independent lexical H01-H05 | `caf4e7ecd16061e9c96b92592d871501ea457b5bf5dd0c9334f9adbe031adb42` |
| `fixtures/t10-discovery-cases.json` | scope/target/revocation/index judgments X01-X09 | `a0b0174ca827c07b4ef2df11972731a7103c9bff3c71fea5269e95cfe02b694f` |

Supplement S03 originally had SHA-256 `3face8305b85af462c91305b5bb2feffd1cd5742a6d818816307f856694f420d` and incorrectly expected only `cache`: its literal query also contains `private`. The S03 gold was corrected to both lexical hits and re-frozen **before its first run**; the other development and held-out gold did not change. Historical 60 cases were unavailable and are not claimed as reused.

## Evidence Boundary

The tests exercise Core retrieval with a registered synthetic session. `noActiveProject` proves that an absent *active retrieval project* gives no implicit results and does not prevent an explicit grant; it does not prove a production Host can create a session with no provenance project binding. Owner intent classification/approval UI and real-loop admission remain T18 integration evidence. Current Store has no public transition that makes an active record `stale`, so that status branch is implemented but not independently exercised via the public seam. FTS shadow-table physical corruption, full-history coverage and downstream source.expand are not claimed as validated by this slice. A projection mismatch returns dirty/unavailable and can be rebuilt; a positive match is always revalidated against canonical owner evidence.
