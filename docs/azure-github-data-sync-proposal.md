# Azure ↔ GitHub Data Sync — Design Change Review

**Date:** 2026-04-16
**Status:** Decided — Option C with explicit-sync UX
**Scope:** Turn the Azure-hosted Taxonomy Editor's data store into a working copy of `github.com/AI-Rosetta-Stone/ai-triad-data`, so that edits made through the web app become GitHub pull requests against the data repo instead of silent writes to Azure Storage. The user controls when a batch of edits is pushed (via "Create pull request") and when the local clone is refreshed (via "Resync with GitHub"); saves never touch the network on the hot path.

---

## 1. Motivation

### What we have today

- **Code repo** (`ai-triad-research`, this repo, ~15 MB) is developed locally and deployed to Azure Container Apps via `deploy/azure/main.bicep`.
- **Data repo** (`ai-triad-data`, ~410 MB) is developed locally as a sibling directory. The Azure deployment provisions a **storage account + Azure Files share** (`main.bicep:73-89`) and mounts it into the container as a writable volume. Today this share is a one-way "latest snapshot" copy; there is no link back to the GitHub data repo.
- When a user edits a node, interpretation, or proposal through the Electron/web UI, the server writes to whatever path the `.aitriad.json` mapping resolves to — in Azure, that is the mounted file share. The change is persisted but invisible outside that share: no commit, no diff, no review, no history.

### The problem this creates

1. **No review gate.** The web app is (or soon will be) used by collaborators outside the maintainer's immediate circle. Today, any logged-in user can mutate the canonical taxonomy, and the only way to catch a bad edit is to notice it after the fact.
2. **No provenance.** Git blame / history is the project's only durable record of *why* a node was changed. Edits made in Azure skip that record entirely.
3. **No merge path back to main.** Data changes made against the live deployment and data changes made in the local dev loop diverge silently. Reconciling them today means hand-copying files, which has already caused conflicts.
4. **No rollback.** Without commits, there is no "revert this one edit" operation — only the coarse-grained "restore the whole share from a backup."

### What we want

- The Azure-hosted data store should **be** a git clone of `ai-triad-data`, not a detached copy.
- Every mutation from the web app should produce a **pull request** against the data repo, never a direct commit to `main`.
- PRs must **not auto-merge.** A human reviewer is always in the loop. (User's explicit requirement: "did not automatically get corrected.")
- The local dev loop (`git pull` in `../ai-triad-data`) should stay the same; the web app becomes just another contributor.

---

## 2. Options Considered

### Option A — Direct-to-GitHub from the server (no Azure-side repo)

The web server keeps writing to Azure Files as today, but on every save it **also** calls the GitHub REST API (via Octokit) to:
1. Create or fast-forward a per-session branch in `ai-triad-data`,
2. Commit the changed file(s) via the Contents API,
3. Open or update a PR against `main`.

The Azure share stays as a working/cache area; GitHub is the system of record.

**Pros:**
- Minimal infrastructure change. No git running inside the container.
- Clean attribution: each PR carries the web user's GitHub identity (via the GitHub App "on-behalf-of" flow) or the maintainer's bot identity with the user's name in the commit trailer.
- Easy to throttle: one PR per session instead of one per save.

**Cons:**
- Azure Files and GitHub can drift. If a maintainer merges PR #42 but the file share hasn't pulled, the next web save opens a PR that re-introduces the pre-merge state.
- Requires a reconciliation step: after a PR merges, something has to update the Azure share. Either a webhook handler or a periodic `git pull`-into-share job.
- Two writers to the Azure share (the app, and the sync-back job) is a concurrency hazard.

### Option B — Sync worker, Azure stays primary

Azure Files remains the primary data store. A separate **worker** (Container App job or Azure Function on a timer) periodically:
1. Diffs the Azure share against `ai-triad-data@main`,
2. Groups changes into a PR,
3. Opens it against GitHub.

**Pros:**
- Web app hot path is unchanged — still just file writes. No added latency on save.
- Batching naturally produces coherent PRs ("Tuesday's edits") instead of one PR per click.

**Cons:**
- Reverses the desired source-of-truth. Edits are canonical *before* review, not after — which contradicts the "must not auto-correct" requirement.
- Attribution is weak: the worker knows *what* changed, not *who* changed it, unless we add a per-edit audit log.
- Two moving parts (app + worker) with their own failure modes, secrets, and schedules.

### Option C — Git clone **is** the Azure data share (recommended)

The Azure Files share *literally contains a git working tree* of `ai-triad-data`. The container initializes it on first boot (`git clone` if empty, `git fetch` otherwise). Instead of writing directly to files, the server-side save handler runs through a thin git wrapper that, per edit (or per session):

1. Checks out a branch named `web/<user>/<session-id>` off the current `main`.
2. Writes the file change on that branch.
3. `git commit` with the web user's identity in author, the bot in committer.
4. `git push` to `origin`.
5. Uses the GitHub API to open a PR against `main` (idempotent — re-open or update if the branch already has an open PR).

A small **post-merge webhook handler** listens for `pull_request.closed && merged == true` and runs `git fetch && git reset --hard origin/main` on the `main` branch of the share. While a reset is running the save endpoint returns `409 Conflict` with a "retry in a moment" hint.

**Pros:**
- Azure share is definitionally a clone — no drift possible, because the working tree *is* the git state.
- The "main branch" of the share is always exactly what GitHub says main is; web edits only ever live on feature branches until a human merges them.
- Review-before-merge is enforced by GitHub branch protection, not by our own code. Much less for us to get wrong.
- `git log`, `git blame`, rollback, and conflict resolution all work with zero custom code.

**Cons:**
- Introduces `git` as a runtime dependency inside the container (small: `apk add git` or equivalent).
- Per-save latency goes from "write a file" to "write + local `git commit`" — roughly 20–80 ms. The push happens only when the user initiates a PR (§4.4), so the hot path stays network-free. The user-visible sync state is surfaced through the status-bar counter and unsynced-changes panel (§4.4) rather than a per-save toast.
- The 410 MB share now has a `.git/` that will grow. Needs Git LFS for the PDF source documents and periodic `git gc`.
- The SMB mount used by Container Apps has known quirks with file locking; git operations on SMB are sometimes slow. Needs validation in a non-prod slot before cutover.

---

## 3. Decision

**Option C adopted, with an explicit-sync UX.** It is the only option where the "web edits surface as PRs" guarantee is enforced structurally rather than by code we have to maintain. Options A and B both require us to write and defend our own "is this edit reviewed yet?" state machine; Option C delegates that to GitHub's branch protection rules, which is a system designed for exactly this job.

Saves commit to a local session branch and **stop there** — no push, no GitHub API call on the hot path. The user decides when to push via a visible "Create pull request" action; they decide when to pull via a visible "Resync with GitHub" action. This keeps save latency local-only and gives the user clear control over when their edits become visible to collaborators.

Option A remains a fallback if Git-on-SMB turns out to be unusably slow in Container Apps — we would keep Azure Files as a cache and move the git working tree to an ephemeral container volume. The UX contract in §4.4 is unchanged in that scenario; only the storage substrate differs.

---

## 4. Detailed Design (Option C)

### 4.1 Identity and authentication

- Register a **GitHub App** ("AI Triad Web Editor") scoped to `ai-triad-data` only, with permissions: `contents: write`, `pull_requests: write`, `metadata: read`.
- Install the app on `ai-triad-data`. Store its private key in the same Azure Key Vault that already holds per-user API keys (`keyStore.ts:70-89`); add a `github-app-private-key` secret.
- The server mints a short-lived installation token per request. `git push` uses `https://x-access-token:<token>@github.com/AI-Rosetta-Stone/ai-triad-data.git` as the remote URL.
- Commit **author** = the web user (name + `<userid>+web@users.noreply.github.com` email, derived from Easy Auth headers in `server.ts:600`). Commit **committer** = the GitHub App bot identity. This keeps attribution visible in GitHub's UI without requiring each web user to have push access themselves.

### 4.2 Branch and PR strategy

- **Per session, local-first.** When a user opens the editor, allocate a branch `web/<github-login-or-sub>/<yyyy-mm-dd>-<short-session-id>`. Every save during that session commits to this branch **locally** — no `git push`, no GitHub API call.
- **User-initiated PR.** The branch stays local until the user clicks "Create pull request" (§4.4, #3). On click, the server pushes the branch and opens a **ready-for-review** PR against `main` via the GitHub API. There is no draft-PR state: either the user is still editing locally, or they have explicitly asked for review.
- **After the PR is open**, subsequent saves `--force-with-lease` push the same branch on each commit and (best-effort) update the PR body with a rolling summary of changed files. Errors on that push do not fail the save — the commit is durable locally and the next save retries.
- **Abandoned branches** (no commits in 14 days, no open PR) → a nightly job deletes the branch. Idle open PRs (no commits in 14 days) get a bot comment but are left open for a human to close.

### 4.3 Save-path pseudocode

```
POST /api/<write>
  ├─ resolve UserContext (existing, userContext.ts)
  ├─ resolve or create session branch (local)
  ├─ acquire per-branch mutex (per-process, Redis-free; single container for now)
  ├─ git checkout <session-branch>              # fast, local
  ├─ write file(s)                              # existing logic
  ├─ git add <paths>
  ├─ git commit -m "<node-id>: <short summary>" --author="<user>"
  ├─ if a PR is already open for this branch:
  │     git push --force-with-lease origin <session-branch>   (best-effort)
  │     best-effort PR body refresh via Octokit (non-blocking)
  └─ return { ok, unsynced_count, pr_number?, push_pending? } → UI refreshes the status bar
```

The save is durable as soon as `git commit` returns; the network is never on the hot path for the common case (no PR open yet).

Failure modes:
- **No PR yet:** Nothing to push. The save always succeeds as long as the working tree is writable. This is the expected common case.
- **Push rejected after PR open (non-fast-forward):** someone force-pushed to the same session branch. Rebase the local branch onto its remote, retry once, then surface to the UI with an `ActionableError` (goal: update your open PR; problem: concurrent write on your session branch; next steps: reload and try again).
- **Push rejected after PR open (main moved):** a PR merged while the session was open. The commit is safe locally. The response includes `push_pending: true`, and the next refresh prompts the user to use **Resync with GitHub** (§4.4, #4).
- **GitHub API 5xx on post-open push:** the commit is local; `push_pending: true` in the response. The next save retries the push, and the unsynced counter badge grows a small "⏳" indicator to make the pending state visible.

### 4.4 User experience

The web app surfaces the git state to the user through four touch-points. The model is **explicit-sync**: saves are local; network-touching operations are initiated by the user.

**1. Unsynced-change counter in the status bar.**
When non-zero, the existing status bar (bottom of the app chrome) shows a compact badge: `● 3 unsynced`. Clicking the badge opens the unsynced-changes panel (#2). When the count is zero, the badge is hidden — no visual noise for a clean working tree. If a PR is already open for the session, the badge includes the PR number: `● 3 unsynced · PR #123`.

The count is `number of files changed on the session branch vs. origin/main`. A new server endpoint `GET /api/sync/status` returns `{ unsynced_count, session_branch, pr_number?, push_pending?, main_head_sha, session_head_sha }`. The renderer refreshes immediately after every save and polls every 15 s while the app has focus.

**2. Unsynced-changes panel.**
A side drawer that lists every file changed on the session branch:
- Grouped by top-level folder (`taxonomy/`, `proposals/`, `summaries/`, `embeddings/`, …).
- Per-row status glyph: `M` modified, `A` added, `D` deleted.
- Clicking a row reveals an inline read-only diff (reuses the conflict-modal diff component).
- Per-row action: **"Discard"** — reverts that file and rewrites the session branch to exclude it.
- Panel-level actions at the top of the drawer:
  - **"Create pull request"** (#3)
  - **"Resync with GitHub"** (#4)
  - **"Discard all"** — resets the session branch to `origin/main`; requires typing the session-branch name to confirm.

**3. "Create pull request" action.**
Button at the top of the unsynced-changes panel and in the command palette. Opens a dialog:
- **Title** — pre-filled with `<n> edit(s) from web session <short-id>`, user-editable.
- **Description** — textarea pre-populated with a bulleted list of changed files/nodes, user-editable.
- **Reviewers** — optional multi-select from the maintainer list.

On submit, the server pushes the session branch and opens a **ready-for-review** PR against `main`. On success, the button is replaced with a **"PR #123 · open"** pill that links to GitHub and the counter badge gains the `· PR #123` suffix. From this point forward, saves on the session push to the branch as described in §4.3, so the PR updates live. If a PR already exists for the session, the button reads "View pull request" instead.

**4. "Resync with GitHub" action.**
Button in the unsynced-changes panel and the Settings menu. Fetches `origin` and reconciles `main`:
- If there are **no unsynced changes** on the session branch → silently runs `git fetch && git checkout main && git reset --hard origin/main`. Toast: "Resynced to `<short-sha>`."
- If there **are** unsynced changes → modal warns: "You have <n> unsynced changes. Resyncing updates `main` but does not discard them. Your session branch may need to be rebased onto the new `main` before your next PR update." Options:
  - **"Rebase my session"** → `git fetch && git rebase origin/main`. On conflict, pause and open the conflict modal with a merge-resolution UI; if a PR is already open, the post-rebase push uses `--force-with-lease`.
  - **"Fetch only"** → `git fetch origin`; neither `main` nor the session branch is moved. The user deals with divergence at PR-review time.
  - **"Cancel"** → no-op.

During the fetch/reset window (typically < 5 s), `/api/<write>` endpoints return `409` with `Retry-After: 5` and the UI shows a "Resyncing…" banner. Read endpoints continue to serve the previous commit's files.

**Optional: webhook-assisted resync prompt.** A GitHub `pull_request.closed && merged == true` webhook can POST a hint to `/webhooks/github`; the server sets a flag on `GET /api/sync/status` so the status bar surfaces a "New changes available — Resync?" banner proactively, rather than waiting for the user to notice. The resync itself is still user-initiated; the webhook only changes the notification, not the control flow.

### 4.5 Large files and repo hygiene

- Move source PDFs and `embeddings.json` to **Git LFS** now, as part of this change. The pre-migration audit already calls this out (`data-separation-plan.md:276`).
- Add a `.gitattributes` to `ai-triad-data` declaring LFS patterns.
- Schedule `git gc --auto` nightly on the container's working tree to keep `.git/` bounded.

### 4.6 What does **not** change

- `.aitriad.json` and `AI_TRIAD_DATA_ROOT` still resolve the data root exactly as today. The working tree is at the same path; the server cannot tell the difference.
- Local dev loop: `git clone ai-triad-data` into a sibling directory as always. No change.
- CI in `ai-triad-research` is unaffected. CI in `ai-triad-data` gains a PR-build job that validates JSON shape, node-ID uniqueness, and embedding-vector length before a human reviewer sees the PR.

---

## 5. Risks and Open Questions

| # | Risk / question | Mitigation or owner |
|---|----|---|
| 1 | Git operations over SMB in Container Apps may be slow or flaky under concurrent writes. | Benchmark before committing: stand up a non-prod container, run a 100-edit script with 3 simulated users, measure p95 `git commit` latency on the save hot path. Cutover only if p95 < 500 ms. (The push latency is off the hot path in the explicit-sync model, so it has a looser budget.) |
| 2 | `.git/` on a multi-GB data share will grow. | Git LFS for source PDFs; `git gc` nightly; periodic `git repack` monthly. |
| 3 | A user's Azure Easy Auth identity is not the same as a GitHub identity; attribution is approximate. | Accept the approximation. Commit author email embeds the Easy Auth `sub`, so provenance is unambiguous even if not a clickable GitHub handle. |
| 4 | Branch-protection rules must actually forbid direct pushes to `main` — otherwise the bot could bypass review. | Enable branch protection on `ai-triad-data` main requiring at least one approving review; the GitHub App must not have `administration` permission. |
| 5 | Secret leakage risk: the installation token is short-lived, but the private key in Key Vault is not. | Key Vault RBAC already scopes access to the container's managed identity. Rotate the App's private key annually. |
| 6 | Very large PRs (a bulk migration via the web UI) may time out the GitHub API. | For bulk operations, fall back to an "export patch" flow — save the diff as a `.patch` file, attach to an issue, handle offline. |
| 7 | What happens when `ai-triad-research` and `ai-triad-data` move in lockstep (e.g., a schema change that needs code + data changes)? | Document a two-PR dance: merge the code PR first (tolerant of both shapes), data PR second. No automation for this in v1. |

---

## 6. Non-Goals

- Offline editing as a first-class feature. Saves tolerate GitHub being unreachable (they only write locally), so a transient outage does not block editing — but we are explicitly not building a store-and-forward queue, a per-user offline replica, or a retry daemon in v1. If the user clicks "Create pull request" or "Resync with GitHub" while the GitHub API is unreachable, the action fails with an `ActionableError` and the user retries later.
- Multi-region / active-active. Single container, single working tree, single push origin.
- Automating review. Humans always merge.
- Replacing the local dev loop. This is about the web app. Local contributors keep using `git` directly.

---

## 7. Rollout Plan

1. **Prototype (1 week).** New branch of `taxonomy-editor`. Add a `GitRepoStore` module that wraps `git` via `simple-git` or similar. Exercise with a local clone of `ai-triad-data`, not Azure yet.
2. **Benchmark on Azure (3 days).** Deploy the prototype to a staging slot with the real SMB-mounted share. Run the concurrency script. Decide Option C vs. fall back to A.
3. **GitHub App + Key Vault wiring (2 days).** Register, install, store private key, smoke-test token minting.
4. **UI affordances (3 days).** Status-bar unsynced counter with PR-number suffix, unsynced-changes side drawer with per-file diff and discard, "Create pull request" dialog, "Resync with GitHub" action with the rebase/fetch-only/cancel branches from §4.4. Conflict modal for the rebase path.
5. **Branch protection + webhook (1 day).** Enable branch protection on `ai-triad-data`. Deploy the webhook handler.
6. **Cutover.** Switch the production container from "Azure Files writable" to "Azure Files is a git working tree." Maintainer-only for one week. Invite collaborators after.

Total: ~3 weeks elapsed for a single engineer, including the buffer that Step 2 might send us back to the drawing board.

---

## 8. Decision

Option C adopted 2026-04-16 with the explicit-sync UX described in §4.4. Checkpoint after Step 2 of the rollout plan: if Git-on-SMB does not meet the p95 latency target, we fall back to Option A. The UX contract (status-bar counter, unsynced-changes panel, user-initiated PR and resync) does not change in that scenario — only the storage substrate for the working tree.
