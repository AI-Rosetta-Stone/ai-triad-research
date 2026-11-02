# Merge-State Troubleshooting: "Green but BLOCKED"

Diagnosing a PR (or the whole fleet of open PRs) that shows `mergeStateStatus: BLOCKED`
while every required check reads green. First seen fleet-wide in **t/3605** — mis-diagnosed
as a branch-protection outage, costing a HIGH ticket and multi-agent time before it
**self-healed**. This runbook makes it recognizable in one query so it never gets
re-diagnosed from scratch.

## Symptom

- `gh pr view <N> --json mergeStateStatus` → `BLOCKED`, but
- `gh pr checks <N>` shows the required contexts (`ci-gate`, `changes`, `commit-hygiene`, …)
  all **green**, and
- it often hits **several PRs at once** (they share a base SHA, or a batch was re-triggered).

## Root cause — a duplicate in-flight CI suite

A required context (e.g. `ci-gate`) can be reported by **more than one CI run** on the same
head SHA — a re-run, a `workflow_dispatch`, a close/reopen retrigger, or a push race spawns a
**second `GitHub Actions` check-suite**. GitHub treats the required context as **not yet
satisfied** until *every* suite that reports it has settled. So the first suite is green, a
second suite is still `in_progress`, and the PR is `BLOCKED` with all contexts apparently green.
It clears itself the moment the second suite completes.

## The one discriminating query

```
gh api repos/:owner/:repo/commits/<sha>/check-suites \
  --jq '.check_suites[] | {app: .app.name, app_id: .app.id, status, conclusion}'
```

Read the output for **more than one `GitHub Actions` (app_id `15368`) suite** where at least
one is non-terminal (`in_progress` / `queued`). That is the signature. Example (real,
origin/main):

```
{"app":"Claude","app_id":1236702,"conclusion":null,"status":"queued"}          <- red herring, ignore
{"app":"GitHub Actions","app_id":15368,"conclusion":"success","status":"completed"}
{"app":"GitHub Actions","app_id":15368,"conclusion":"success","status":"completed"}
{"app":"GitHub Actions","app_id":15368,"conclusion":null,"status":"in_progress"}  <- the 2nd suite still running = BLOCKED
```

## Red herring to pre-dismiss

The **`Claude` app (app_id `1236702`)** check-suite frequently sits `queued` with
`conclusion: null` and never reports a required context. It is **harmless** and is **not** why
the PR is BLOCKED — do not chase it.

## Action: WAIT — do not touch branch protection

This self-heals when the second suite finishes. **Do NOT edit required status contexts /
branch protection** to "fix" it — that was the t/3605 misdiagnosis, and a real context-swap
then forces the `Invoke-ContextSwapRetrigger.ps1` close/reopen dance on every open PR (see
[context-swap.md](context-swap.md)) for no reason.

- Re-run the discriminating query after the in-flight suite completes; `mergeStateStatus`
  flips to `CLEAN` on its own.
- If a suite is genuinely **stuck** (hung job, not merely slow), cancel that run
  (`gh run cancel <id>`) so its stale suite settles — the problem is the stuck run, **not**
  branch protection.
- Merge normally once green + `CLEAN`, per Pre-Self-Merge Verification (`docs/pr-landing.md`).

Refs: t/3605 (incident), t/3606 (this runbook).
