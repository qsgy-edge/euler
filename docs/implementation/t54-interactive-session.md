# Interactive disposable CLI sessions

## Start and bind

Run from the repository using Node 24.18.x and PowerShell 7:

```powershell
npm ci
$owner = [guid]::NewGuid().ToString()
$hostId = [guid]::NewGuid().ToString()
node apps/cli/src/main.ts session-create --owner $owner --host $hostId
```

Save the `root` returned by `session-created`. This explicitly creates a new disposable store; opening a missing or changed store fails rather than creating a replacement.

```powershell
$store = '<returned root>'
node apps/cli/src/main.ts session --sandbox $store --transport-config 'D:/synthetic/route.json'
```

The transport configuration uses the existing [explicit test-route contract](t13-capture-verification.md). It must name `provider`, `model`, `baseUrl`, `authNamespace`, `credentialEnv`, `contextWindow`, `maxTokens`, `authorization: "synthetic-test-only"`, and the complete `budget`. Only the named environment variable supplies the credential. The transport prerequisite suite runs before `session-ready`. Without `--transport-config`, binding, diagnostics and owner memory commands remain available; a model request reports `explicit-route-model-auth-budget-required` with zero sends.

After `session-ready`, type your own synthetic question. Whitespace and Unicode in each line are preserved. Input is journaled and fsynced before Core records `received`, `admitted-to-loop`, and `bound-to-assembly`. A plain answer uses one main-model request. Completion leaves stdin open for the next question.

An unbound session has `projectId: null`. To confirm a new or existing logical project in this store, enter:

```text
/bind {"projectId":"<project UUID>","root":"D:/synthetic/project"}
```

Use `"root":null` for a logical project without file access. The project UUID is chosen explicitly, not derived from cwd, Git, or the directory name. Binding is allowed at an idle boundary, persists the exact owner confirmation and root file identity, and enables that project's capabilities. A confirmed session cannot be reassigned to another project.

Before binding, questions and raw recovery are session-local. Project memory, project guidance and file capabilities are unavailable. Previously captured candidates retain their unresolved scope; candidate continuation belongs to #55.

To start another unbound session in the same store, then choose an existing project:

```powershell
node apps/cli/src/main.ts session-create --sandbox $store
node apps/cli/src/main.ts session --sandbox $store --session '<new sessionId>' --transport-config 'D:/synthetic/route.json'
```

`session-create --sandbox` reuses the store's owner/host and generates a new session/branch identity. Use `--session` to reopen that session. The default session remains the one created with the store. `session-ready.binding` identifies the original archive; `session-ready.project` reports its confirmed project. Pre-binding source ACKs retain their original null project.

## Inputs, approval and diagnostics

| Input | Behavior |
|---|---|
| Ordinary text or `/steer TEXT` | Enters the current Core loop at its next complete boundary; starts a successor after ordinary completion. |
| `/follow-up TEXT` | Queues a follow-up while a run is active; Core starts the linked run after completion. |
| `/queue TEXT` | Archives a queued input without admitting it to the current model request. Query `/request RUN_ID` for its original source identity. |
| `/status` | Shows binding, current intent, run identities, durable attempts and this process's foreground HTTP count; does not change the goal. |
| `/request RUN_ID` | Shows the existing Core status and request ledger. |
| `/window` | At an idle boundary, requests a fresh Core window before the next input sends. |
| `/task TEXT` | Explicitly completes the previous intent and creates a new goal; does not inherit its task grant. |
| `/cancel` | Immediately stops the run and configured background workers, including admission of earlier buffered input. Sent attempts keep their delivery state. |
| `/exit` | Stops active work and closes the CLI. EOF refuses any pending file approval and waits for the active pump to settle. |

Windows uses the existing native handle-based file Host for the confirmed root. A file-write call produces `file-approval` with exact path, content and token. Only a live input received after presentation can approve it:

```text
approve <token>
reject <token>
```

The normal route and file tools coexist; no scenario switch is needed. Core selects guidance for the actual file target. A changed target/operation snapshot returns `file-guidance-refresh-required` before I/O so the model can reconsider using the full local rules. Root and nested `AGENTS.md` are loaded through `GuidanceSession`. File calls remain unavailable on macOS/Linux.

`/skills [query]` lists the current project catalog. With an active intent, `/skill NAME` activates the qualified selection through `GuidanceSession`; it grants no file, shell, network or cross-project permission.

## Memory, source recovery and background work

The entry point reuses `OwnerMemoryHost`, `CorrectionHost`, Core retrieval and durable Info:

```text
记住偏好：回答使用合成示例。
记住决定：合成输出使用 output.txt。
/memory 合成
/info
/info <batchId>
inspect <recordId>
source <recordId> [offset]
correct <recordId> "完整的新正文"
forget <recordId>
restore <recordId>
rollback <batchId> <updateEventId> [more updateEventIds]
commit <previewToken> "预览中的完整正文"
commit <previewToken> forget
commit <previewToken> restore
commit <previewToken> rollback
cancel <previewToken>
replay <previewToken>
/source-search <query>
/expand {"eventId":"<original eventId>","offset":0,"limit":512}
```

Only complete explicit command forms use the memory-operation path. Ordinary questions such as `不要术语，解释这个示例。`, `feedback on this design, please`, and an agreement without a memory proposal keep the ordinary model route. An explicit assistant proposal such as `建议记住偏好：使用合成示例。` followed by `同意` uses the owner lane and retains both original source ACKs as its evidence range. The agreement's exact input, including whitespace, is archived before its separate proposal-association envelope. `source <recordId>` recovers that canonical memory’s bounded original event, including another session in the same confirmed project; an unbound session cannot use it to reach project memory.

Correction/forget/restore/rollback retain their existing preview and live-approval checks. Objective `记住事实` statements still require independent evidence. Corrected content remains unverified until reverification. Model tool calls to `memory.search`, `source.search`, `source.expand`, and `skill.search` go through Core; owner commands do not send a counting-model substitute.

Completed exchanges can appear in the next request only as complete pairs fitting the actual encoded request budget. Core rechecks their source permissions and memory qualifications at dispatch. Raw events remain recoverable after a window change; a Historian summary is not returned by `source.expand`.

```powershell
node apps/cli/src/main.ts session --sandbox $store --transport-config 'D:/synthetic/route.json' `
  --capture-config 'D:/synthetic/capture.json' --historian-config 'D:/synthetic/historian.json'
```

Background configurations use the existing capture route contract and `captureCapability`. Startup recovery and owner input schedule eligible queued work; memory capture waits for foreground boundaries. `/drain` waits for the configured workers and reports both queues; `/cancel` stops them. Prerequisite subprocess launches are recorded in the existing process/maintenance fence. No configured worker means no background provider send.

Cross-project discovery still requires an active task and a structured owner grant:

```text
/task Compare the selected synthetic projects.
/grant {"projectIds":["<registered project UUID>"],"targets":{},"maxResults":8,"maxBytes":8192}
/revoke <grantId>
```

The grant binds to the current intent and archived owner decision, leaves the primary operation project unchanged, and is not inherited by another session. Empty environment targets retain the existing “needs verification” meaning.

## Unknown delivery and recovery

Reopen the same store/session and inspect `/status` or `/request RUN_ID`. It does not resend old attempts or reset their usage. Seal an interrupted old run with `/seal RUN_ID` if needed. `/reconcile ATTEMPT_ID` uses the existing receipt reader; configured HTTP has no independent receiver-query protocol, so it returns `reconciliation-reader-unavailable` rather than consulting the counting receiver.

To explicitly authorize a new linked request despite possible duplicate delivery:

```text
/resume {"relatedRunId":"<old runId>","acceptDuplicateRisk":true,"input":"new synthetic request"}
```

The successor receives its own authorized budget, while the predecessor's attempts and outcomes remain immutable. An unresolved unknown is not cleared by an ordinary question, a new intent or project confirmation. Recovery-only guidance authorization cannot dispatch model/tool work.

## Storage and validation

Disposable schema **28** stores immutable `session_project_bindings` in SQLite. `session_scopes` resolves the current project without rewriting `sessions`, historical source ACKs, intents or request ownership. Each new archive event records the project at append time. Existing demo identities and command entry points remain supported. Older disposable schemas must be rebuilt; the separate forward-migration test copy uses version 29.

Binding confirmations, raw input and presentations use the existing archive and database carriers. Snapshot integrity checks include the confirmation and its root identity. Restore retains the existing recovered-stream block; purge uses the same source/Host/backup owners and preserves unrelated project confirmation. No additional content carrier is introduced.

```powershell
node --test --test-concurrency=1 apps/cli/test/interactive-session.test.ts apps/cli/test/interactive-recovery.test.ts
npm run check
npm run evidence:session
```

The Windows evidence command retains actual stdin/stdout, HTTP request bodies and counts, archive/SQLite copies, file output, implementation/fixture/environment identities and a receipt under `artifacts/t54-<timestamp>/`. Its requests use loopback and synthetic credentials. The copies preserve observed bytes; they are not relocatable runtime stores because their original file identities are intentionally retained in the manifest. External-provider semantic quality/X-14 remains T24 B3's evidence gap.
