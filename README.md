# Euler

This repository is the independent Euler v1 implementation workspace for `qsgy-edge/euler`.

The current contents are the reviewed architecture and implementation specification migrated from `ai-agent-cli`. The migration source passed the source-side design and specification review at commit `750a61065fb6f1a874a684ed09b6b2e9d75378e7`.

Implementation, P0 artifacts, runtime tests, CI evidence, host acceptance, migration receipts, and MC cutover have **not** been completed or verified. This repository must not be treated as production-ready and must not be used to claim an Euler runtime or MC cutover.

- [Euler v1 implementation specification](docs/architecture/issues/15-euler-v1-spec.md)
- [Migration manifest](docs/architecture/migration-manifest.json)

The course repository remains the historical source checkpoint. This repository does not perform MC data migration or create credentials, production databases, or runtime configuration.
