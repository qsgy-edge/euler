# Euler

This repository is the independent Euler v1 implementation workspace for `qsgy-edge/euler`.

The repository began with architecture and implementation documents migrated from `ai-agent-cli`. The migration source passed the source-side review at commit `750a61065fb6f1a874a684ed09b6b2e9d75378e7`. The September 9, 2026 scope revision is a subsequent Euler design change, not covered by that historical review.

Delivery scope is defined in [I01 of the implementation specification](docs/architecture/issues/15-euler-v1-spec.md#v1-scope). Phase dependencies and mode-specific acceptance criteria are maintained in the referenced contracts, not duplicated here.

Issue #1 adds a runnable **synthetic P0 probe** for first-turn source durability, a local counting transport, and maintenance exclusion/recovery. See [commands, contracts, and evidence boundaries](docs/implementation/t01-synthetic-probes.md). It uses generated disposable databases and never opens MC or a production data root.

Issue #2 adds synthetic scoped memory transitions, source-backed verification fixtures, event replay, inert proposal versions, and process-crash/concurrent-writer probes. See [commands, storage behavior, and evidence boundaries](docs/implementation/t02-scoped-memory.md). Semantic verification and production acceptance remain separate work.

Issue #3 adds durable synthetic session/job/maintenance/migration stream ownership, controlled child registration, recoverable stop/residual evidence, maintenance cancellation and coordinator takeover. See [commands and evidence boundaries](docs/implementation/t03-process-maintenance.md).

Issue #4 adds the synthetic X-01 persistence foundation: app/store identity, multiple logical sessions, durable preview/pending settlement, immutable owner receipts, fixed activation batches and statement-by-statement crash recovery. See [commands, ownership and evidence boundaries](docs/implementation/t04-persistence.md). Its app identity fixtures use disposable test app-ids under the OS user data directory; real approval and Info delivery remain later work.

Job-owned capture and independent verification, immutable reports, approved project excerpts and Markdown handoff are described in [capture ownership and evidence boundaries](docs/implementation/t13-capture-verification.md).

Ordinary project candidates use [promotion, comparison and feedback gates](docs/implementation/t14-memory-evolution.md): fixed activation/Info batches, provenance, supersession, conflict isolation and source/feedback invalidation. Run `npm run evidence:memory-evolution` for retained synthetic observations. Real-provider quality and full cross-mode acceptance remain evidence gaps.

Owner corrections use the actual CLI input, complete previews and live approval before [atomic correction and result recovery](docs/implementation/t15-owner-correction.md). Corrected bodies remain unverified until independent reverification. Run `npm run evidence:memory-correction` for retained CLI/SQLite observations.

[Forget and restore](docs/implementation/t16-forget-restore.md) use the same live approval and durable recovery path. Forget preserves history and suppresses same-source recapture; restore requires a separate preview, approval and current eligibility. Run `npm run evidence:memory-forget` for retained CLI, suppression and immutable receipt observations.

Full X-card acceptance, real provider dispatch, production schema/host acceptance, migration, and MC cutover remain unverified. CI and host results must be read from the artifact for the specific implementation and platform; this repository is not production-ready.

- [Euler v1 implementation specification](docs/architecture/issues/15-euler-v1-spec.md)
- [Migration manifest](docs/architecture/migration-manifest.json)

The course repository remains the historical source checkpoint. This repository does not perform MC data migration or create credentials, production databases, or runtime configuration.

The migration manifest records the imported bytes at Euler commit `ef58c8ca39fe9ec2d95c215387afe162d40fda08`; its hashes are not hashes of subsequently edited working files. Validate migration provenance against that commit. Review current contracts and their changes through Git; do not rewrite historical manifest hashes to make later edits appear migration-identical.
