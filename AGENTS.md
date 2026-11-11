# AGENTS.md

Always-relevant rules for agents in this repository. Situational rules live in the docs each pointer names: **read the named doc before doing that kind of work. It is binding.** Rationale and incident history: `docs/agent-rules-reference.md` (Ref §N).

## Project

AI Triad Research: a multi-perspective research platform for AI policy and safety literature. Code lives here; data lives in `../ai-triad-data`. `.aitriad.json` maps paths to the data dirs. Override with `$env:AI_TRIAD_DATA_ROOT`; the env var beats `.aitriad.json`, which beats the monorepo fallback. Build and test commands are in each subtree's `AGENTS.md`.

**Taxonomy:**
- Four POV camps, with BDI categories.
- Node IDs are `{pov}-{category}-{NNN}` (`acc`/`saf`/`skp`/`cc`); policy actions are `pol-*` in `policy_actions.json`.
- Embeddings: all-MiniLM-L6-v2, 384-dim, in `embeddings.json`, under `data['nodes']`.
- Data JSON is nested, so inspect a sample before you assume a schema. Enriched fields live under `node.graph_attributes.*`. Field types vary (list vs dict).

## Orca Overlay Repo

Orca config lives in the overlay repo `.orca-git/`, so it stays private while this repo is public. `ogit` is `git --git-dir=.orca-git --work-tree=.`, run from the repo root.
- **Never `git add` or `git commit`** `.orca.yaml`, `.orca/`, `.orca-gitignore` or any **nested** `AGENTS.md`. Only this file and `operations/devops/azure/AGENTS.md` belong to the main repo. If unsure, run `sh .githooks/agent-file-owner.sh --path <file>`.
- **Interweave apps and config are overlay-only** (PI rule, 2026-11-11). Build apps under `.interweave/apps/<name>/` and commit them only with `ogit add -f` and a pathspec. Main's `.gitignore` excludes `.interweave/`; never force-add it to main.
- **New role or instance:** `ogit add -f <role>/AGENTS.md`, then run `sh .githooks/agent-file-owner.sh --audit` before your next commit. Never `--no-verify`. Never ogit-add a `.worktrees/<name>/AGENTS.md`.
- **Feedback rules and skills only through the MCP tools** (`create_feedback_rule`, `manage_skill`). Hand-written rules load as dead. To repair an invalid rule, back it up, delete it and re-create it with the same `scope`. Only an observed injection proves a rule works. Ref §1.

## Shared Checkout and Git Hygiene

- **The shared checkout stays on `main`.** `checkout`, `reset`, `rebase`, `merge`, `pull --rebase` and `stash` happen only in a worktree.
- **Mode** is line 1 of `.orca/workflow-mode` (`worktree` is strict, and the default). Change it only deliberately, recording who, when and why in the file. In `worktree` mode, work on a branch in `.worktrees/` (or use `/land-from-worktree`), and `cd` into it in the same command. Ref §2.
- **Commit with a pathspec** (`git commit -m "…" -- <paths>`). Never `-a` or `add -A`. Scan `git status --short` before you commit and `git show --stat HEAD` after. Commits that set the executable bit go through a worktree. Ref §6.
- **On the shared checkout, push immediately after committing.** If the push is rejected, land it from a worktree. Only DevOps cleans up a diverged shared tree (`docs/shared-tree-divergence.md`).
- **Shell quoting:** code containing special shell characters goes through Edit/Write and scripts run from files, never inline heredocs, `sed` or `awk`. Before you `rm --` a 0-byte file named after a code fragment, check that it's empty and untracked, and never commit one. In Windows Bash, prefix `git show <ref>:<path>` with `MSYS_NO_PATHCONV=1`.

## Working Rules

- **Claim before you implement:** first check for a peer's claim, an open PR or a recent commit. Ticket → **In Progress** when you start, and **Done** when it merges.
- **Verify against the authoritative source:** `origin/main` (not the shared checkout), the cloud API (not the workflow YAML), and the failing arm of a gate. A file that *configures* Y is not evidence that Y happens.
- **Errors:** use `New-ActionableError` / `ActionableError` (Goal / Problem / Location / Next Steps), never a bare `throw`. **Log every fallback with a `WARN`** saying it was taken and why. See `docs/error-handling.md`.
- **Tokens:** prefer pings to email, reference entities (`t/KEY`) instead of inlining them, read files in ranges, pipe long output through head/tail/grep, quote test summaries not runs, and read CI with `gh run view --log-failed`.

## Situational Rules (read the doc first)

- **Landing code:** see `docs/pr-landing.md`.
  - Merge through a PR to `main` via the merge queue.
  - Enqueue only pinned, with `node operations/devops/enqueue-pr.mjs <owner>/<repo> <N>`. If it refuses, stop and escalate; never fall back to the raw `enablePullRequestAutoMerge` mutation or `gh pr merge --auto`, which skip the approval guard (PI-approved 2026-11-09, t/4939).
  - **Never push to a queued PR.**
  - User-facing UI changes need `Approved (Design):` (`docs/review-routing.md`).
- **Change tiers and decision rights:** see `docs/change-tiers.md`.
  - The PR body's first line is `Tier: T0`, `T1` or `T2`.
  - T2 means a Second Opinion round plus `consult-hold`.
  - **The PI decides** spending, credentials, product and UX, research claims, deleting prod data, roles and branch protection.
- **Incidents:** `docs/incident-response.md`.
- **AI backends:** `ai-models.json` is the single source of truth, and a model's backend comes from the registry, never from its id prefix. `AI_API_KEY` is a fallback for gemini models only. Run `npm run verify:config` before landing; when adding a backend, use `/add-ai-backend`.
- **Dependency security bumps:** `docs/security/dependency-policy.md`. Overrides live in `pnpm-workspace.yaml`.

## Change Tiers and Decision Rights (t/4092, PI-approved 2026-10-07)

Moved unchanged to **`docs/change-tiers.md`**; see "Situational Rules" above. This heading stays so that existing links to it still resolve.

## Incident Response

Moved unchanged to **`docs/incident-response.md`**.
