# T09 — controlled local guidance

Issue: #9. Delivery path: `feat/t09-local-guidance` + PR (Core behavior, dependency and acceptance tests). Base: `fb60566c5242e6ffee0c30f3676ae93f620793d6`.

Spec: current `docs/architecture/issues/15-euler-v1-spec.md` I12/I13 and `13-select-target-v1-migration.md` D6.1–D6.3. Tests use the already approved Core public operation/result boundary.

## Implemented boundary

`GuidanceSession` is the Host-only **synthetic Core acceptance entry**. The caller supplies owner-bound project roots, approved local source settings and the existing source archive. SQLite supplies actual owner/project/workspace membership and the existing durable intent. No parent-directory inference supplies workspace membership. Model messages cannot invoke configuration, approval or activation APIs.

`prepare(targets)` reads default AGENTS (global, explicit workspace membership, project, then target ancestors), revalidates selected Skills and references, and writes complete immutable instruction snapshot bytes through the existing source archive. The existing request assembly ledger records its source references, payload hash, budget, protected policy and provenance. There is no Skill version table, migration, package manager, new tool registry or separate persistence backend.

The snapshot's `cacheEpoch` is an instruction/cache generation; the existing assembly `epoch` remains the owner maintenance fence epoch. Changed instruction bytes, scope, selection, configuration or resolution create a new snapshot/assembly/cache epoch. An intent step change alone creates a new assembly while retaining the cache epoch. An unchanged same-task selection reuses verified body bytes and assembly identity. A new window clears the body cache and verifies sources again. A stale concurrent session cannot restore an older selection over the durable head.

The local file reader opens sources read-only, verifies canonical containment, regular-file identity, UTF-8 completeness and a bounded file size, and checks identity/version at each boundary. Default Skill directory checks use the verified native root spelling on Windows, so an approved 8.3 root is not compared against its long path as if they were different directories. It rejects nested links and multi-link files. Cached full bytes are reused only after reopening and comparing device/inode/size/mtime/ctime; a new window always reads again. Empty AGENTS is valid. Missing optional sources are normal; unreadable, malformed and changed required sources remain explicit failures. These portable checks are for this controlled local acceptance path; they do not claim the adversarial Windows handle guarantees of T08.

## Skills and conflicts

- Metadata uses the standard YAML frontmatter `name` and `description`, parsed with `yaml`; no Euler-specific field is required. Original SKILL.md bytes, including frontmatter and line endings, enter the independent Skill guidance block.
- Default sources are project `.agents/skills`, explicitly registered workspace `agent/workspaces/<id>/skills`, Euler `agent/skills`, an explicitly bound shared directory, then owner-bound additions within each scope. Shared `~/.agents/skills` must be supplied as a bound directory by the Host; tests never read the user's real skills.
- Catalog results carry completeness, a content-bound continuation cursor, exact owner/scope/source/entry/hash refs, and explicit failure reasons. `total` counts the filtered matches; `complete` means the response itself contains the entire matching set, not merely the final continuation page. Scope and ref identity use named fields, independent of object property order, including trust/enabled overrides, deduplication, activation and deactivation. Default name resolution is project > workspace > global with stable source order; it returns shadowed refs. Activation stores selection/rejection evidence and never silently substitutes a same-name source.
- A full required body exceeding the conservative UTF-8 byte budget yields `skill-unavailable:budget`; no truncated body is returned. The file reader also imposes a 48 KiB source limit, producing an explicit integrity/unavailable result. Large-directory optimization is outside T09.
- References are requested explicitly with their own locator/hash inside the selected package. Source changes, trust revocation or a stale reference create unavailable snapshots. Explicit deactivation and task completion remove bodies from the next assembly. Same-task resource movement retains applicable bindings.
- Scripts/assets are not executed. `allowed-tools` is untrusted metadata and never changes permissions.
- `recognize` accepts explicitly identified constraints with exact quote/hash/target/operation evidence. Valid constraints for the same source version stay additive; an empty recognition cannot retract a contradiction. When source bytes change, `prepare` retires obsolete evidence only when a replacement for the same source/target/operation/key matches the current hash and exact quote. Frozen history is unchanged. It does not parse arbitrary natural language. Ordinary AGENTS precedence is applied per target/key, retaining wider unrelated rules. Conflicts are grouped by operation, target and key, so independently satisfiable targets can run together. Same-target incompatible constraints produce `instruction-conflict` or `skill-conflict`; compatible rules and separate operations remain executable. Explicit source-backed owner directives override the corresponding stale ordinary constraint before conflict checks.
- `direct` and `resolve` are synthetic Host owner-input seams. They verify source-backed input; a resolution additionally binds the conflict identity, operation and source versions. The real Host's live-user provenance is a T18 integration obligation. A new snapshot is required before execution resumes.
- `execute` revalidates current sources, intent, scope, authorization and policy/capability/credential/approval flags before a synchronous synthetic effect. The callback type is `() => undefined`, so typed async callbacks and promise factories are rejected; native async and bound-async callbacks are also rejected before invocation at runtime. It returns `not_started + unavailable` on refusal, `started + success` on completion, and `started + unknown` if an effect throws or an untyped callback violates the synchronous return contract. These Host-owned callbacks are trusted synthetic effects, not a sandbox for arbitrary scheduling code, a production tool executor or a permission transport.

## Reproduce and inspect

```powershell
npm ci
npm run typecheck
node --test apps/cli/test/guidance.test.ts
npm run build
npm test
npm run evidence:guidance
```

The evidence command writes `artifacts/t09-<timestamp>/` with `summary.json`, full snapshot bytes, raw archive, copied SQLite database, fixture text and the actual synthetic effect. Its independent verifier uses raw SQLite/JSONL rows and Node SHA-256 directly to recompute archive, snapshot and local source hashes. The disposable source tree is removed afterwards; fixture text and snapshots remain in the evidence directory for inspection. The report records exact implementation HEAD, dirty status, Node/OS, fixture digest, chosen sources, conflict evidence, rejection reason, assembly hashes/epochs and effect counts. Run on a clean implementation commit to bind a release candidate precisely.

Fixture digest: `dc125fe79689da959c341440a13f5b9c8ed204280f92f789d46c4fe02f10b964` (SHA-256 of the evidence script's serialized fixture map).

Observed locally on Windows / Node v24.18.0: targeted Core tests pass; the evidence run independently verifies `skill-conflict → effects=0`, denied capability `→ effects=0`, version-bound owner resolution `→ effects=1`, and retained immutable history after deactivation.

## Evidence limits

This ticket demonstrates controlled local sources and the synthetic Core entry only. `skill.search` wiring in the production agent pump, real-model P0 payloads, live-user approval provenance, actual Host lifecycle integration and transport admission remain for T18/composite acceptance. It is not X-04/X-05 whole-card or production PASS. Shared regression tests run on the existing Windows/macOS/Linux CI matrix; platform production filesystem/permission claims require their own real-host evidence. No MC, real user data, live owner, MCP or Pi source is read or changed.
