# Euler

This repository is the independent Euler v1 implementation workspace for `qsgy-edge/euler`.

The repository began with architecture and implementation documents migrated from `ai-agent-cli`. The migration source passed the source-side review at commit `750a61065fb6f1a874a684ed09b6b2e9d75378e7`. The September 9, 2026 scope revision is a subsequent Euler design change, not covered by that historical review.

Delivery scope is defined in [I01 of the implementation specification](docs/architecture/issues/15-euler-v1-spec.md#v1-scope). Phase dependencies and mode-specific acceptance criteria are maintained in the referenced contracts, not duplicated here.

Issue #1 adds a runnable **synthetic P0 probe** for first-turn source durability, a local counting transport, and maintenance exclusion/recovery. See [commands, contracts, and evidence boundaries](docs/implementation/t01-synthetic-probes.md). It uses generated disposable databases and never opens MC or a production data root.

Issue #2 adds synthetic scoped memory transitions, source-backed verification fixtures, event replay, inert proposal versions, and process-crash/concurrent-writer probes. See [commands, storage behavior, and evidence boundaries](docs/implementation/t02-scoped-memory.md). Semantic verification and production acceptance remain separate work.

Full X-card acceptance, real provider dispatch, production schema/host acceptance, migration, and MC cutover remain unverified. CI and host results must be read from the artifact for the specific implementation and platform; this repository is not production-ready.

- [Euler v1 implementation specification](docs/architecture/issues/15-euler-v1-spec.md)
- [Migration manifest](docs/architecture/migration-manifest.json)

The course repository remains the historical source checkpoint. This repository does not perform MC data migration or create credentials, production databases, or runtime configuration.

The migration manifest records the imported bytes at Euler commit `ef58c8ca39fe9ec2d95c215387afe162d40fda08`; its hashes are not hashes of subsequently edited working files. Validate migration provenance against that commit. Review current contracts and their changes through Git; do not rewrite historical manifest hashes to make later edits appear migration-identical.
