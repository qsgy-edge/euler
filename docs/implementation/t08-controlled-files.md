# T08 — controlled file tools

Status: local implementation, Windows/Linux validation and independent review accepted. Remote CI and merge status are tracked by the implementation PR referencing issue #8.
Delivery: `feat/t08-controlled-file-tool` + implementation PR referencing #8. Base: `1c51e9bf51932d2dce34bcb22560f0e9bb8d9844`.

## Implemented boundary

The owner approved continuing the complete T08 slice with a Windows native handle backend. The original pathname/boolean-approval prototype was rejected by independent review and replaced. This candidate is not a general shell sandbox.

- Core defines only `file.read` and `file.write`, both sequential. File capabilities come from the Host's explicit synthetic-project binding, never tool schemas, provider metadata, file contents or model arguments. The root manifest, owner/project/session binding, source and capability hash are frozen in the run and request policy snapshot.
- Core parses arguments and decodes the path once, rejects residual encoding and ambiguous/device/absolute/drive/UNC/URL paths, and revalidates the active intent, stream owner, capability source, activity/fence and durable authorization before admission. Product data roots and their ancestors/descendants cannot be file roots.
- The Windows Host uses Koffi 3.3.0 to call fixed Windows APIs. It accepts canonical local NTFS roots, verifies the root handle identity, opens each component relative to a retained directory handle using `NtCreateFile`, and rejects reparse points and hardlinks. Root, parent and existing-target handles remain open across presentation, approval and I/O. Sharing excludes write/delete access; existing writes never truncate before approval. New files use exclusive `FILE_CREATE` relative to the retained parent.
- The owner sees the exact path, existing identity (or new target), complete bounded content, cwd and actual privileges. Only the matching `approve <token>` command on the Host input channel authorizes that presentation. Missing input, rejection, forged presentation or stale intent performs no mutation. The Host does not invoke shell commands or request elevation.
- Reads and writes are limited to 4096 UTF-8 bytes. Core archives the bounded result with actual target identity. Oversized/invalid-UTF-8 reads settle only their call as ordinary failure. Before requesting a new file, the Host checks `FILE_ADD_FILE` using `GetSecurityInfo`/`AccessCheck` on the pinned parent and probes for an existing target; a refusal before `FILE_CREATE` is `no_effect`. Directory handles require `READ_CONTROL` for this query. No failed `FILE_CREATE` status by itself proves no effect: a filesystem filter may create the file and then return denial without a handle. Such failures stay `started + unknown`, block follow-on dispatch and retain cleanup responsibility. A late reliable receipt or known preflight failure can only reconcile the corresponding operation; it cannot change the terminal result or resume the loop. Fence checks apply to late archival. If the Host store has already closed, the late completion is observed and handles close, but no ledger event is appended: durable unknown remains for recovery.
- File admissions and receipts use the existing append-only execution ledger. `maintenanceStatus().controlledFiles` projects write-copy ownership, root/parent/target identities and the responsible `host-project-resource` owner. Maintenance observes these external project files, and replacement or unresolved identity prevents exclusive release; it never deletes an unknown replacement. This adds registration/observation to the existing maintenance slice, not a new irreversible purge implementation.

The CLI enables this capability only for `agent --scenario files`, creates a disposable project root outside the Euler sandbox, and uses a deterministic synthetic model transport. The existing real-provider path is unchanged and does not enable file tools. No MC access, real user data, live-owner switching, Pi integration, arbitrary model shell/Skill execution, URL capability or production-platform claim is included.

## Reproduce

```powershell
npm ci --ignore-scripts
npm run check
node --test apps/cli/test/file-tools.test.ts apps/cli/test/file-cli.test.ts apps/cli/test/windows-files.test.ts apps/cli/test/file-crash.test.ts
node apps/cli/src/main.ts agent --scenario files --interactive
```

For the interactive demo, inspect the JSON `file-approval` event and type its exact `command` value (`approve <token>`), or its `rejectCommand`. The default run deadline is 30 seconds. `file-project-bound` reports the separate synthetic root; `agent-result` includes the run, durable receipts, fixture digest and cleanup registration. Without interactive approval, mutation is unavailable. Project files are retained for inspection and remain in the recorded cleanup responsibility.

`file-cli.test.ts` also drives that actual CLI process via stdin, reads the resulting file independently, waits for process exit, reopens the store, checks maintenance registration, substitutes a target and verifies that maintenance blocks without deleting it. It saves raw receipts and maintenance observations to `artifacts/t08-files-<platform>-<timestamp>.json`, including implementation commit and dirty-worktree state. Artifacts generated before a commit explicitly identify the dirty candidate; they are not claimed as clean-commit evidence.

## Validation and platform limits

- Confirmed on Windows x64, Windows `10.0.28020`, Node `v24.18.0`, local NTFS. `npm ci --ignore-scripts` loads the packaged Koffi binary and the real Windows handle test passes; no install-time compiler/script is required on this tested layout.
- Windows full check of code tree `5f362a55ba0bad73a30f739eaed1c29dd5205426`: typecheck + build + 201 tests, 200 passed, 1 platform skip, no failures/cancellations. Log: `artifacts/t08-verification-preflight.log`. The ACL test also passed under Git Bash, with native utilities resolved explicitly from System32.
- Linux WSL2 x64, Node `v24.18.0`, kernel `6.6.87.2-microsoft-standard-WSL2`: identical candidate tree after Git/line-ending setup, full check passed: 201 tests, 179 passed, 22 explicit Windows-only skips. Log: `artifacts/t08-linux-preflight.log`. `npm ci --ignore-scripts` was checked on the unchanged lockfile. Initial archive-only runs lacked Git metadata and then had mismatched `autocrlf`, causing the existing crash-test harness to fail before tests; those environment failures are preserved and are not reported as product PASS.
- Windows behavior covers successful actual reads/existing writes/new creates, exact owner presentation, unchanged echo behavior, single decoding, Unicode/case/separators, double/invalid encoding, dot segments, drives/UNC/devices/URL, symlink/junction/hardlink escape, root replacement, parent-path aliases, pinned-target replacement, raced creation, missing/rejected/forged approval, stale intent/fence, cancellation, late reconciliation, unknown recovery, and persisted cleanup responsibility.
- `file-crash.test.ts` kills a real worker at the public execution boundary before I/O and after native write/truncate/flush but before Core receipt archival. It independently checks target existence/content, reopens the ledger, verifies the started-without-completion/unknown cleanup evidence, and confirms recovery cannot dispatch automatically. It saves raw evidence to `artifacts/t08-crash-<platform>-<phase>-<timestamp>.json`. It does not claim fault injection inside an individual Windows syscall.
- A separate child-process test emulates the documented filter cancellation at the external native-call boundary: it performs a real NTFS create, closes that handle, then returns access denied/no handle. Independent filesystem observation finds the empty file; Core records unknown, cancels the sibling and retains cleanup responsibility. This is controlled fault injection, not an installed-kernel-filter reproduction.
- Linux/macOS native file operations are intentionally unavailable. Portable tests validate parsing, Core rejection and existing runtime behavior, while Windows-only tests are explicitly skipped. macOS and three-platform evidence must be read from the implementation PR's CI artifacts; no native file capability PASS is claimed for Linux/macOS.
- Real provider: evidence gap. No route/credential/budget was invented, no real provider call was made and no external private data was accessed.

## Native API basis

Official Microsoft documentation checked on 2026-09-16 (HTTP 200):

- [NtCreateFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile): directory-relative `RootDirectory`/`ObjectName`, `FILE_CREATE`, synchronous I/O and `FILE_OPEN_REPARSE_POINT`.
- [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew): desired access cannot conflict with the sharing mode of an existing open handle; the fixed backend holds handles without write/delete sharing.
- [GetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandle): handle-based information used to compare the NTFS volume/file identity.
- [GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo) and [AccessCheck](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-accesscheck): descriptor access requires `READ_CONTROL`; access evaluation uses an impersonation token duplicated from the Host process token.
- [FltCancelFileOpen](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/fltkernel/nf-fltkernel-fltcancelfileopen): cancelling a completed create before returning its handle does not delete the new file. Native failure codes cannot be used alone as evidence of no effect.

The documents explain the APIs; the executable tests supply this candidate's actual Windows evidence. No guarantee is inferred for unsupported filesystems or arbitrary scripts.

## Independent review history

The original prototype failed Spec review: canonical-store exposure, no real owner-approval path, pathname check/open race, inadequate unknown/cleanup handling and incomplete evidence. Standards reported no documented violations. Those findings drove the replacement; neither result certifies this candidate. The first failed/hung review workflow is not evidence.

Review of native candidate tree `78e589d04fdf563d7436dbb3c03a406ee89dd6ca` completed in workflow `e1d06b61-5357-4cd6-81c4-ccef806c02d2`: Standards found no documented violations and suggested reusing Core file types (applied). Spec found deterministic failures incorrectly classified as unknown (confirmed and corrected), and requested actual-Host negative paths, composed/decomposed Unicode, process-death and delayed-completion evidence (added and passed). No confirmed root escape or approval bypass was reported; that is a bounded review finding, not a security guarantee.

Full review of tree `cc016085c85ffd711cbde6b609637a1c41de2253` passed Standards with an optional shared-byte-limit suggestion (deferred; current checks agree). Spec identified permission-denial classification; the parent reproduced it using a disposable NTFS ACL. Targeted review of the subsequent error-code mapping found the documented post-create filter counterexample and GNU/native utility ambiguity. Both were accepted: the mapping was removed in favor of non-creating preflight, and the test uses System32 with protected cleanup. Final targeted review `0eda17d8-15e6-4c75-88cf-8df0a9290817` independently verified tree `77f0fe2654d6a625fe6292c9c39105ddcfbb0c7e`, reran seven focused Windows checks, inspected the Win32 contracts and Core/cleanup propagation, and returned **PASS with no Critical, Important or Minor findings**. The parent verified the findings against source and test evidence. Only this delivery-note update follows that frozen review; implementation/test sources are unchanged.

Successful maintenance reconciliation of unknown file copies after restart is an acknowledged evidence gap; this slice retains the obligation and blocks unsafe cleanup/retry, and does not enable a new irreversible purge action. This acceptance does not authorize real user data, production capability enablement or an unapproved merge.
