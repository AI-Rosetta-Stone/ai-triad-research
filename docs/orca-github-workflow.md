# How the Orca Fleet Uses GitHub and Branching

**Last updated:** 2026-08-05 · **Owner:** Technical Lead

This document describes how the Orca agent fleet makes changes to the AI Triad codebase through Git, GitHub, and branch-based workflow. It covers the model as it stands after the retire-shared-checkout migration (t/2008, 2026-07-31), the benefits and costs of the approach, and where it should go next. The incidents cited are real; they are why the workflow looks the way it does.

## 1. The setting

The "developers" here are Orca roles: AI agents with persistent identities and bounded file-ownership scopes. ServerAuth owns `server/security/`, DebateTool owns `lib/debate/`, and so on. Many roles run at once. They coordinate through tickets, pings, and email, and they change code through Git. Three repositories are in play:

- **`ai-triad-research`** (public): the code, and the subject of the branching workflow below.
- **`ai-triad-data`** (SSH remote): ~410 MB of generated and structured JSON. Committed to directly; not part of the branch-PR flow.
- **`ai-triad-orca-config`** (private): the Orca overlay (`.orca.yaml`, role configs, feedback rules, skills, nested `AGENTS.md` files). It lives at `.orca-git/` and is driven by the `ogit` alias so it never mixes with the public repo.

The rest of this document is about the code repo.

## 2. The workflow

### 2.1 One hub, many worktrees

The fleet operates from a single machine with one clone of the code repo, the **hub**. The hub's working tree sits at `origin/main` and serves as a **fetch-hub**: a shared reference point, not a place to author changes. Each role does its work in its own **git worktree** cut from `origin/main`, so concurrent roles never contend over one working tree.

### 2.2 The change lifecycle (branch-first)

Every non-trivial change follows the same path, codified in the `/land-from-worktree` skill:

1. **Branch-first worktree.** `git fetch origin`, then `git worktree add -b <type>/<slug>-t<ticket> ../wt-<ticket> origin/main`. The branch exists from the moment the worktree is created, so the commit is *born* on a named branch off a fresh base.
2. **Install and build in the worktree.** `npm ci` in every package the verify gate touches. Worktrees start with no `node_modules`.
3. **Commit on the named branch.** Conventional message, ticket reference, and a `Co-Authored-By` trailer for every contributing role.
4. **Verify on the committed state.** `npm run verify` (and `Invoke-Pester ./tests/` for PowerShell). Definition of Done applies where the commit is born.
5. **Push the branch, open a PR.** `git push origin HEAD:<branch>`, then `gh pr create`.
6. **Merge on green.** When the required checks pass, land it with `node operations/devops/enqueue-pr.mjs <owner>/<repo> <N>` from a checkout at origin/main (see docs/pr-landing.md; `gh pr merge` is not used, t/535). One GitHub identity means no human reviewer is possible, so green checks *are* the merge gate. A role reviews another role's PR through the ticket and PR flow, not a GitHub approval.
7. **Sync the hub.** `git pull --ff-only` on the hub, so the next worktree branches from the current tip.

### 2.3 The commit guard

A committed pre-commit hook (`.githooks/pre-commit`, enabled per checkout with `git config core.hooksPath .githooks`) enforces the model structurally rather than by discipline:

- A commit **directly on the hub's `main`** is refused. It would strand work locally and diverge from origin.
- A commit **on a detached HEAD inside a worktree** is refused. It would be an orphan, lost on the next re-detach, which is the reason landing is branch-*first*.
- Commits on a named branch, on non-`main` branches, and with `--no-verify` (owner and emergency override) are allowed, so the guard never blocks legitimate landing.

The guard is fail-open. If any Git introspection errors out, it allows the commit, because a broken guard must never block real work.

### 2.4 Ownership routing

Changes are routed by file ownership, not grabbed. Before designing a change the TL runs `resolve_owner` / `resolve_owners_batch` on every file that will change; a feature touching three roles' files becomes three tickets, not one. Logic needed by two or more roles is extracted to a shared location such as `lib/` as a prerequisite ticket that blocks the consumers. The owner extracts the core and the consumers adopt it, a pattern used this session for both the entity resolver and the content-sanitizer core.

### 2.5 The merge gates

Branch protection on `main` is `{ strict: false, contexts: ["ci-gate", "CodeQL"] }`.

**`ci-gate`** is an always-runs aggregate job. Its `needs` transitively cover the real jobs (Pester, the Electron matrix, container smoke, lint, audit), and it reports green only when every gated job passed or legitimately skipped. Because it always runs, a docs-only or PowerShell-only PR whose code jobs correctly skip still gets a green required context and can self-merge. One required aggregate replaced six individual contexts that used to strand skip-eligible PRs.

**`CodeQL`** is a required *differential* check. It fails a PR that introduces a new security alert but does not block on the pre-existing backlog. This closes the gap where `ci-gate` could be green while a CodeQL run was red, which would otherwise let a security fix self-merge while minting a new vulnerability.

**`strict: false`** (not "require up-to-date") is deliberate. With fast-moving concurrent roles, requiring every PR to be rebased to the tip before merge created a livelock, because `main` advanced faster than CI ran and PRs went stale every cycle. The residual risk of a PR green against a slightly stale base is caught by post-merge CI on `main`, and the deploy gate never ships a red `main`.

Supporting gates run inside `ci-gate`: `verify:config` (six registry gates over `ai-models.json`, including a dangling-reference check), a dependency-audit gate with per-app baselines, and Dependabot for version and security updates (with an auto-merge workflow for green minor and patch bumps).

### 2.6 Review and design gates

Pattern-following, single-scope work self-certifies against a documented playbook (`/add-rest-endpoint`, `/add-bridge-method`, `/add-ps-cmdlet`, `/add-test`, and the like) and skips a separate review gate. Novel architecture, cross-role interfaces, data-model changes, and auth or security-surface changes route to the TL for a design review before build and a review of the PR before merge. Security-surface PRs are reviewed at the object level, on the diff, not on report.

## 3. Why it looks like this: the shared-checkout era

The current model is a reaction to concrete failures under the previous one, where roles committed to a *shared* local `main` checkout:

- **Divergence treadmill.** A worktree push landed on `origin/main` without advancing the shared local `main`; other roles then committed onto the lagging pointer and diverged from origin, sometimes twice in one afternoon.
- **Duplicate-commit race.** Committing on the shared ref and pushing a cherry-picked copy produced byte-identical twin commits on origin.
- **Stranded fixes and dirty-tree false witness.** A deletion committed while its importer's fix sat uncommitted in the shared tree broke `main` invisibly, and "verifying" by building the dirty shared tree masked the breakage.
- **Near-loss of real work.** A reconcile that hard-reset the shared local `main` wiped local-only commits more than once.

The commit guard (t/1926) was the stopgap. The retire-shared-checkout migration (t/2008) is the durable fix: with no shared `main` to author on, the divergence class is designed out rather than merely guarded. The migration was executed as a freeze-drained, snapshot-backed cutover, and even then the "verify before the irreversible step" habit earned its place. The hub turned out to be diverged (22 local-only commits) rather than the clean fast-forward the plan assumed, and all 22 had to be confirmed content-present on origin before the reset ran.

## 4. Benefits

- **Concurrency without contention.** Per-role worktrees let many agents build, test, and commit at once without stepping on one working tree.
- **Verified before merge, structurally.** Nothing reaches `main` without passing the aggregate CI gate and the differential security gate. Because these are *required contexts*, the guarantee does not depend on any agent remembering to check. This session's own security fixes were structurally prevented from merging with a new alert.
- **Clear ownership and auditable history.** `resolve_owner` routing, `Co-Authored-By` trailers, and ticket references make every change traceable to an owner, a rationale, and the collaborating roles.
- **Divergence designed out.** The guard and the worktree topology remove the shared-mutable-state failure class at its root.
- **Isolation for risky work.** Worktrees are disposable. A bad experiment is a `worktree remove`, not a polluted shared tree.
- **Clean public/private separation.** Code stays public; Orca infrastructure and secrets never enter it, via the overlay repo and bring-your-own-key with no committed credentials.
- **The gate catches build-path gaps, not only code bugs.** When a new `lib/` runtime dependency was not installed by the container builder, the required container check went red instead of shipping a broken image.

## 5. Costs

- **Provisioning overhead.** Each worktree needs its own `npm ci` and Electron binary, which costs disk and setup time per role. A fleet of about thirteen worktrees runs to real gigabytes.
- **Ceremony per change.** Branch, worktree, install, commit, push, PR, merge, hub-sync is a lot of steps for a one-line fix. The `/land-from-worktree` skill encodes the sequence, but it is not free.
- **CI wall-time on the critical path.** The Electron test job dominated at roughly eleven minutes. t/1988 cut it ~55%; a second pass (t/2073) decoupled `test-container` from the test matrix, cutting p50 a further ~44% to 398 s (6.6 min). `test-electron/taxonomy-editor` is now the sole dominant contributor (~93% of the critical path). `strict: false` remains necessary: the serialization ceiling at today's p50 is ~9 merges/hr, and active-hour burst rates can exceed it (t/2074).
- **High change volume from a large fleet.** Many concurrent roles plus Dependabot generate a lot of PRs, and without a merge policy they accumulate. The backlog reached 32 open PRs this session, a mix of unmanaged bot bumps and green-but-stranded fleet work.
- **Migration side-effects strand in-flight work.** Swapping a required status context stranded the open PRs that predated the swap, because they lacked the new check and their armed auto-merge could not fire. A required-context change needs a "re-trigger all open PRs" step that is easy to forget.
- **Multi-repo cognitive load.** `git` versus `ogit` versus the data repo, three remotes, and a dual-tracked `AGENTS.md` (main-repo authoritative, overlay secondary) are a standing source of foot-guns.
- **GitHub subtleties bite.** Making CodeQL a required *check-run*, not the workflow *job* (which passes even on a new alert), was load-bearing and non-obvious. Several platform features (merge queue, ruleset `evaluate` mode) turned out to be org-only and unavailable on this user-owned repo.
- **Agents cannot verify their own guardrail changes.** A running session's feedback-rule runner is pinned to the manifest loaded at session start, so a rule change cannot be trigger-verified in the session that made it. Verification waits for a later session.
- **Coordination tax.** Design gates and pre-merge reviews add latency. They are justified for security and architecture surfaces but a drag if applied too broadly, which is why this session narrowed TL pre-merge review to novel and critical input-surface changes and let canonical remediations self-certify.

## 6. Improvements delivered (t/2072)

All nine improvements shipped. Evidence, measurements, and deviation notes are on the child tickets.

1. **CI critical-path cut further (t/2073).** `test-container` had been serialized after the full electron matrix despite having no artifact dependency on it. The old `needs` ordering was purely fail-fast. Decoupling it to run concurrently collapsed the critical path from `electron + container` to `max(electron, container)`. Measured over five or more post-merge PRs, p50 fell from 711 s to 398 s and p90 from 747 s to 487 s. `test-electron/taxonomy-editor` is now the sole dominant contributor at roughly 93% of the critical path. Gate integrity was confirmed throughout: `test-container` remains in `ci-gate`'s `needs` closure, a deliberate-failure probe showed a red container reds the gate, and a docs-only PR confirmed the skip path ends green.

2. **pnpm shared store adopted (t/2078).** The fleet migrated from npm to pnpm 11.20.0 with `nodeLinker: hoisted` and a workspace-level shared store. Worktrees resolve dependencies by hardlinking to the store rather than duplicating packages, collapsing the dominant per-worktree disk cost.

3. **PR-backlog hygiene automated (t/2075).** `.github/workflows/pr-triage.yml` runs weekly (Monday 09:00 UTC). It closes superseded or conflicting Dependabot PRs using a numeric semver comparison (avoiding the lexicographic sort trap), exempts security-labeled PRs from conflict-close, re-triggers stranded fleet PRs via branch-update, and posts a digest of every remaining PR and its stuck reason. Fleet-authored PRs are never closed. A dry-run mode defaulting to `true` was validated against a real run before live closing was enabled.

4. **Required-context swaps safe by construction (t/2076).** `operations/devops/Invoke-ContextSwapRetrigger.ps1` enumerates open PRs, close-reopens each to synthesize a `pull_request` event (re-triggering all required workflows without empty commits), polls to terminal state, and prints a per-PR before/after context table. It exits non-zero if any PR is left without all required contexts. A runbook at `deploy/azure/runbooks/context-swap.md` documents the full swap-and-re-trigger sequence as one operation. An Orca feedback rule injects the protocol reminder at the moment of a protection change.

5. **Build-path coverage check (t/2077).** `scripts/ci-audit-build-paths.mjs` derives its build-path list from Dockerfile stage definitions rather than a hand-maintained set, then exits non-zero when a package gains a runtime dependency the production Docker stage does not install. The check runs as the `dependency-coverage` job in `ci.yml`, wired into `ci-gate`'s `needs` closure and paths-filtered to container and lib changes. Gate verification before landing showed a deliberately injected dependency gap failing the check and its removal passing.

6. **Shared-primitive dedups completed (t/2079).** An adoption audit from `origin/main` with an explicit repo-root path found exactly one live inline copy across three extracted primitives: the `SENSITIVE_KEYS` set in `communityReviewHandler.ts`. It was fixed (t/2071). Post-fix greps confirmed zero inline copies remain in the tree, verified positively against all eleven consumer import sites. A re-introduction lint is in progress as t/2085 to make re-introduction structurally impossible.

7. **Multi-repo foot-guns reduced (t/2080).** The authoritative home for each `AGENTS.md` is now a derivable predicate (main-tracked iff a public-repo consumer needs it without the overlay), enforced by explicit allowlists in `.gitignore` and `.orca-gitignore` that are disjoint by construction. `agent-file-owner.sh --path` answers ownership from one command; `--audit`, wired into `.githooks/pre-commit`, fails a commit that would create a double-track or leave a file unbacked. The audit itself found two orphaned files (the chat and settings role `AGENTS.md`) that predated the change and existed in exactly one place on one machine; both were recovered before they could be lost. The data-repo sweep guard was evaluated and accepted-not-built: the failure is recoverable from origin, and a branch guard would refuse all normal data commits.

8. **Verification habits migrated into enforcement (t/2081).** Habits were ranked by recurrence count crossed with gate-ability, using Sage's failure-pattern archive as the evidence base. The top three migrated: exit-code literacy (nine to ten incidents across four agents) into the `exit-code-literacy-guard` feedback rule, observed firing live; verify-before-teardown into the `verify-head-on-origin-before-teardown` feedback rule, gate-logic proven on five cases, live-firing pending a later session per t/1625; prove-the-gate already enforced structurally by CodeQL required differential check-run, ci-gate aggregate, and the deploy pre-traffic gate (health check plus acceptance tests plus persona/auth matrix, auto-rollback on failure). Confirming object-level state on origin rather than a local tree or PR check was the highest-recurrence habit at roughly fifteen or more incidents, but it has no hookable syntactic trigger and remains a standing documented rule. Its one hookable slice, teardown, is covered by the second rule above.

### strict:true evaluation (t/2074)

After the t/2073 cut, CI p50 is 398 s. Fleet commit rate runs at roughly two per hour on a conservative daily average and 4.5 per hour at peak. A Poisson stale-rate model gives roughly 20% stale PRs at the conservative rate and 39% at peak. The sharper argument is the serialization ceiling: at 398 s p50, serial merges can run at most 9.05 per hour. Over 110 active hours measured from the git log, 24 hours exceeded that ceiling outright, and 47.5% of commits landed during over-ceiling periods. The worst observed single hour ran at a utilization ratio of 2.54, meaning unbounded queue growth, not just slowdown.

Decision: **hold `strict: false`.** The conditions that would flip it are any one of: p50 CI below about 90 s (a further ~77% reduction, running entirely through `test-electron/taxonomy-editor`), no active hour sustaining above roughly six merges per hour, or merge queue availability (org-only on this repo tier, t/1968).

## 7. Summary

The fleet trades per-change ceremony and CI and provisioning overhead for concurrency, structurally verified merges, and a divergence class that is designed out rather than guarded. The remaining costs are largely about speed (CI wall-time, provisioning) and volume (PR backlog from many agents). Both are addressable with the improvements above, and none requires a change to the core model.
