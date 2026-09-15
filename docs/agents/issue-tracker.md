# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `gh issue edit <number> --remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Delivery path

Choose the delivery path by the effect of the change, not by the file extension.

### Use a pull request

Use a feature branch and PR when the change can affect the product, a running process, a durable data boundary, or a required check. This includes:

- application or library code, tests that change or validate implementation behavior, public APIs, schemas, migrations, and persistence;
- dependency, build, CI, security, permission, runtime, or deployment configuration;
- fixes or features attached to an implementation issue;
- a mixed change containing both documentation and any change above.

The PR path is:

1. Create or select the issue and record its acceptance criteria.
2. Create a feature branch from `main`.
3. Implement the change and run local focused checks, then the relevant full checks.
4. Open a PR that references the issue.
5. Resolve CI and Greptile findings, then merge the PR.
6. Close the issue after acceptance, or use `Closes #<number>` in the PR so GitHub closes it when the PR merges.

### Commit directly to `main`

A direct commit is appropriate for a documentation-only or repository-maintenance change that cannot alter product behavior or required checks. This includes Markdown or text documentation, issue-tracker guidance, comments, and other wording-only maintenance. It may include a small documentation correction related to a merged change; it must not include code, tests, dependencies, generated runtime assets, or configuration that affects execution.

For a direct commit, run the checks relevant to the edited files, commit on `main`, and record the change in the commit message. Do not open a PR or trigger Greptile for documentation-only maintenance. If a change is ambiguous or contains both documentation and behavior, use the PR path.

Direct commits are also allowed for an explicitly approved emergency repository action. Record the reason and follow up with a PR when the action changes product behavior.

### Greptile usage on the PR path

Greptile reviews the pull request diff. Complete local verification before pushing and batch related fixes into one push. After a Greptile finding, reproduce it locally, fix all related findings together, run focused tests and the relevant full checks, and push once. Use Retrigger only after the code and local evidence are ready. CI reruns and Greptile Retrigger are separate actions.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

PRs are still the required implementation and review surface for changes made by the repository maintainers. The setting above only controls whether external PRs are handled as triage requests through the issue workflow.

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>`.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE`.
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.

- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's native issue dependencies are the canonical UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric database id (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, not the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: after the implementation PR is merged and acceptance is complete, comment on the issue with the result, then close it with `gh issue close <n>`. If the PR body contains `Closes #<n>`, GitHub can close the issue automatically when the PR is merged; in that case, add the acceptance comment before or after the merge as appropriate.

<!-- agents-md-author:begin ticket-synchronization -->
## Ticket synchronization

- When the reviewed specification baseline changes, update the human-readable `Spec references` baseline in every affected open generated ticket before implementation starts. Preserve the `euler-to-tickets:` marker; it records ticket provenance.
- Treat GitHub native issue dependencies as the blocker source of truth. If a body `Blocked by` fallback is present, remove closed blockers and retain open ones after each dependency changes state.
- After an implementation PR merges, compare its recorded evidence gaps with downstream ticket scope. Add a gap only when the downstream ticket already owns that behavior; create or route new scope separately.
- After a PR is merged, remove its local and remote feature branches only after verifying that no worktree or unique patch remains. For squash- or rebase-merged branches, check patch equivalence before deletion; keep `main` and active feature branches.
<!-- agents-md-author:end ticket-synchronization -->
