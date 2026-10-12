**Last updated:** 2026-10-01
**Author:** Technical Lead; branch-protection + workflow sections corrected against the live API (t/3803)

# Branch Protection & Deployment Pipeline

This document explains the branch protection rules, CI pipeline, and deployment workflow for the AI Triad Research codebase — why they exist and how they interact.

> **Landing code is governed elsewhere, deliberately.** How changes reach `main` — worktree vs. direct mode, the PR-flow, self-merge verification, `/land-from-worktree` — lives in the root `AGENTS.md` (sections *Feedback Rules → workflow-mode*, *Pre-Self-Merge Verification*, *PR-Flow Practice Rules*). This document does **not** restate that workflow: two copies of a landing procedure is exactly how this file came to recommend a path the platform now refuses (t/3803). It describes the *mechanism* GitHub enforces; the root `AGENTS.md` describes the *procedure* the fleet follows.

## The Theory: Defense in Depth

The goal is to prevent broken code from reaching production. We use three layers:

1. **Branch protection** — gates what can merge to `main`
2. **CI pipeline** — validates every push and PR automatically
3. **Blue-green deployment** — catches runtime failures that tests can't

Each layer catches a different class of failure. Tests catch logic errors. Branch protection catches process errors (untested code reaching `main`). Blue-green deployment catches environment errors (missing env vars, container startup failures, infrastructure drift). No single layer is sufficient alone.

## Branch Protection Rules

**GitHub branch protection is authoritative, and this document is only a description — descriptions drift, and this one did (t/3803).** So this section deliberately does **not** transcribe the current settings: a count, a context list, or an `enforce_admins` value copied into prose here is exactly what went four facts stale and *inverted*, and a dated snapshot only resets the clock on the same failure. Read the live settings and interpret each field against the design intent below. (The strongest evidence for this: a reader with full API access and a standing rule to check authoritative sources still mis-stated the context count from a restated fact — e/227#25.)

```
gh api repos/AI-Rosetta-Stone/ai-triad-research/branches/main/protection
```

The authoritative mirror of the *required-context set* is `.github/ci/required-contexts.json`, and `operations/devops/Test-RequiredContextsListDrift.ps1` validates that mirror against the live API on a daily heartbeat. Trust the API and that mirror over any list written in prose.

How to read the settings — the field, its design-intent value, and what a deviation means:

- **`enforce_admins` — by design `true`; a `false` reading is a regression, not a baseline.** When `true`, the required status checks bind **everyone, admins included**. The Orca fleet commits and pushes as the admin `jpsnover` identity, so this is the field that denies *any* identity a bypass of the checks — it closes the direct-push-with-bypass pattern older versions of this doc wrongly described as available (turned on after an incident, t/3736). It is currently **load-bearing beyond itself**: per root `AGENTS.md` it substitutes for two inert feedback rules (`pre-self-merge-verify`, `auto-merge-jointgv-guard`), so flipping it to `false` silently re-opens two incident classes (merge-on-an-untested-head, joint-gv auto-merge) with no signal anywhere. A merge it refuses surfaces as a status-check error — e.g. `HTTP 405 Required status check "ci-gate" is failing.` (t/3736) — **not** a permissions error, so a reader who trusted a stale "bypass is available" doc is apt to misread the refusal and go looking to disable the protection. Don't; that is the failure, not the fix.
- **Required status checks — by design the `ci-gate` aggregate plus independent guard contexts.** The merge gate is **not** a list of per-job checks (the old `test-powershell` / `test-electron (…)` / `test-container` framing is obsolete). It is a single aggregating job, `ci-gate` (see below), alongside independently-posted guards: CodeQL, `joint-gv-guard` (t/3607), and `consult-hold-guard` (t/3680). The exact set is whatever the API returns and what `required-contexts.json` mirrors — read it there, not from a number memorised here.
- **`strict` — by design `false`.** GitHub does not force a branch to be up to date with `main` before merging.
- **`required_pull_request_reviews` — by design NOT configured.** PR review is *not* platform-required (removed 2026-07-29). PR-flow and TL review are the fleet's *convention* (root `AGENTS.md`, `/land-from-worktree`), enforced by process, not by GitHub. **The distinction matters:** green protection settings *are* evidence that **merges** are gated (required contexts + `enforce_admins`); they are **not** evidence that **review** happened. Nothing in branch protection requires a human or TL to have looked at the diff. Merges are gated; reviews are not.
- **`allow_force_pushes` / `allow_deletions` — by design `false`.**

### The `ci-gate` aggregate (why one required context, not a list of jobs)

`ci-gate` is a single **aggregating** job (`.github/workflows/ci.yml`), and it — not the individual test jobs — is the required status context. It `needs:` the full set of gated jobs and runs with `if: always()`, then fails if any gated job concluded `failure` or `cancelled`:

```yaml
ci-gate:
  needs: [changes, test-powershell, test-electron, …]   # every gated job; the live
                                                         # list is ci-gate's needs: in ci.yml
  if: always()
  steps:
    - name: Block on any failed/cancelled gated job
      if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')
      run: exit 1
```

(The `needs:` list above is abbreviated on purpose — enumerating it here would be the same restate-a-list drift this doc warns against. Read the authoritative set from `ci.yml`.)

Why this shape rather than listing each job as its own required context:

- **New gated jobs don't need a branch-protection edit.** Adding a job to `ci-gate`'s `needs` makes it merge-blocking without touching the protection config — one required context covers all of them.
- **Path-filtered jobs skip soundly.** A `changes` job computes which subsystems a PR touches; gated jobs that don't apply **skip**, and `ci-gate` treats a *skipped* need as satisfied (only `failure`/`cancelled` block). The `changes` job is itself in `needs`, so if path-filtering itself breaks, `ci-gate` reds (t/1962). A skipped gated job is by design, not a false-green (t/2094/t/2025/t/3646).
- **Promotion/demotion is a `needs` edit.** A warn-only job becomes blocking by being added to `needs` (e.g. `render-smoke`, t/3026); demote by removing it. No protection change, no re-trigger of open PRs.

`CodeQL` (security analysis), `joint-gv-guard` (fails when a `joint-gv`-labelled PR has auto-merge armed — t/3607), and `consult-hold-guard` (the mandatory-consult hold gate — DevOps's t/3680 flip) are the other three required contexts, each posted independently of `ci-gate`.

## CI Pipeline (`ci.yml`)

Triggers on every push to `main`, every PR targeting `main`, and `epic/**` bases (t/3642).

```
Push / PR
    |
    ├── changes  (path filter — decides which gated jobs run)
    │
    ├── gated jobs (parallel, path-filtered):
    │     test-powershell, test-electron × apps, test-container, render-smoke, …
    │     (the full set is ci-gate's `needs:` in ci.yml — not re-listed here)
    │
    └── ci-gate  (if: always(); needs ALL gated jobs)
          └── fails if any gated job is failure/cancelled  ← the required context
```

Gated jobs run in parallel; `ci-gate` aggregates their results into the single required status check. A skipped (path-filtered) job does not block; a failed or cancelled one does.

### Why Matrix, Not Monolith

The Electron apps share code via `lib/` but have independent `package.json`, `tsconfig`, and build pipelines. A change to `lib/debate/` could break `taxonomy-editor` without breaking `poviewer`. The matrix strategy (`fail-fast: false`) runs the apps in parallel and reports each independently — a failure in one app doesn't mask results from others.

## Deployment Pipeline

Deployment is a separate, manually-triggered pipeline — CI passing does not auto-deploy.

```
1. Developer tags a release (v0.x.x)
   or manually triggers "Container Image" workflow
       |
       v
2. Container Image workflow
   ├── Lint Dockerfile
   ├── Fetch taxonomy snapshot (baked fallback data)
   ├── Build + push to GHCR
   ├── Trivy security scan (CRITICAL + HIGH)
   └── Generate SBOM
       |
       v
3. Auto-Deploy to Staging (triggered automatically)
   ├── Deploy new revision to staging Container App
   └── Health check (18 attempts × 10s = 3 min)
       |
       v
4. Manual verification on staging
   (human checks staging URL, reviews logs)
       |
       v
5. Deploy to Azure (manual trigger)
   ├── Bicep what-if (preview infrastructure changes)
   ├── Deploy Bicep template (full infrastructure)
   ├── Deploy new revision at 0% traffic
   ├── Health check (30 attempts × 10s = 5 min)
   ├── Shift traffic to 100% (if healthy)
   └── Auto-rollback (if unhealthy)
```

### Blue-Green Deployment

Azure Container Apps runs in `Multiple` revision mode. A new deploy creates a revision at 0% traffic. The workflow health-checks the new revision directly (via its revision-specific FQDN). Only after the health check passes does it shift traffic to 100%. If the check fails, the workflow deactivates the failed revision and restores traffic to the previous one.

This means a bad deploy **never serves user traffic** — the old revision keeps running throughout.

### Why Deployment Is Manual

Deploying from CI without human verification would mean:
- A passing test suite automatically reaches production
- Test suites can't catch everything (missing env vars, OAuth misconfiguration, API rate limit changes)
- There's no opportunity to verify on staging first

The staging auto-deploy provides a safe preview. Production deploy requires explicit human action.

## How Code Lands on `main`

**Through a PR. Always.** There is no sanctioned direct-push-with-bypass path anymore — `enforce_admins: true` means even the admin identity cannot land a head the required contexts have not passed, so attempting a direct push of code to `main` is refused server-side (see Branch Protection Rules above). Earlier versions of this document described a "multi-agent case" in which agents committed to local `main` and the owner pushed with admin bypass; that pattern is **prohibited by the PR-Flow rules and refused by the platform**, and has been removed rather than restated here to keep it from drifting back in (t/3803).

The procedure — worktree vs. direct workflow mode, batching, self-merge verification with `--match-head-commit`, gated/draft/`joint-gv` discipline — is owned by the root `AGENTS.md`:

- **Workflow mode** (`worktree` strict vs. `direct`) — root `AGENTS.md` → *Feedback Rules*; read with `sh .githooks/read-workflow-mode.sh`. Mode governs branching discipline in the shared checkout; it does **not** loosen branch protection — code lands via PR in either mode.
- **Landing a change** — `/land-from-worktree` (branch-first, checks-only self-merge).
- **Self-merge verification** — root `AGENTS.md` → *Pre-Self-Merge Verification* (base is `main`, `--match-head-commit`, CI green on the exact head).
- **PR-flow practice** — root `AGENTS.md` → *PR-Flow Practice Rules* (batching, prompt merge on green, gated-PR draft discipline, `joint-gv` co-merge).

### Workflow / CI file changes — the one real friction point

A change to `ci.yml` or a required workflow sometimes can't be fully validated by a PR, because the PR runs the *old* workflow until it merges. This is a genuine chicken-and-egg case, not a license to bypass: open the PR, let the checks that *can* run run, and coordinate with DevOps for anything that requires the new workflow to be live. Changing the **set of required contexts** has its own mandatory follow-up (`operations/devops/Invoke-ContextSwapRetrigger.ps1`; runbook `deploy/azure/runbooks/context-swap.md`) — it close-reopens open PRs so they re-trigger against the new context set.

## Key Files

| File | Purpose |
|---|---|
| `.github/workflows/ci.yml` | CI pipeline — gated jobs aggregated by the `ci-gate` required context |
| `.github/ci/required-contexts.json` | SSOT **mirror** of the required contexts (description; validated against the live API by `Test-RequiredContextsListDrift.ps1`) |
| `.github/workflows/joint-gv-guard.yml` | `joint-gv-guard` required context — fails if a `joint-gv` PR has auto-merge armed |
| `.github/workflows/codeql.yml` | CodeQL security analysis (posts the `CodeQL` required context as an app aggregate) |
| `.github/workflows/container.yml` | Container image build + GHCR push + security scan |
| `.github/workflows/deploy-azure.yml` | Production blue-green deployment |
| `.github/workflows/deploy-staging.yml` | Auto-deploy to staging after container build |
| `deploy/azure/main.bicep` | Infrastructure-as-code (Container Apps, Key Vault, Storage, alerts) |
| `taxonomy-editor/Dockerfile` | App container definition |
| `deploy/azure/Dockerfile.base` | Base image with system dependencies |
