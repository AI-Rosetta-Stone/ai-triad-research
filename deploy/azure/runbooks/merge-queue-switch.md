# Merge-queue switch (t/4567#58) -- PI procedure

This is the PI's switch package for turning on the GitHub merge queue on `main`, proven
end-to-end on `app-scratch` across the full t/4567 live-fire cycle (automatic re-enqueue
removed entirely per the `GITHUB_TOKEN` root-cause finding; replaced by the D1 dequeue
alert and the C5 liveness poll). DevOps does not apply this -- that's the PI's step.

## Apply

From the repo root, with a token that has `admin:org`/repo-admin rights on
`AI-Rosetta-Stone/ai-triad-research`:

```bash
gh api -X POST repos/AI-Rosetta-Stone/ai-triad-research/rulesets \
  --input operations/devops/merge-queue-ruleset.json
```

This creates a new ruleset (`main-merge-queue`) enforcing the merge queue on `main` with:
- `SQUASH` merges, `ALLGREEN` grouping;
- build and merge groups capped at 4 entries, minimum 1 to merge, a 15-minute merge wait;
- `check_response_timeout_minutes: 60` (D3 -- a required context that never reports gets
  60 minutes before the merge queue itself gives up on the group, well past the merge-queue
  liveness check's own 60-minute `awaiting-checks-stale` backstop);
- the same four required contexts already enforced on `main` today (`ci-gate`, `CodeQL Analysis`,
  `joint-gv-guard`, `consult-hold-guard`) -- unchanged, with `strict_required_status_checks_policy: false`
  to match main's current `strict:false` (strict only forces PR-tier rebases; the queue
  already tests the group against the latest `main`). (t/4567 post-launch fix: the context
  was originally `CodeQL`, GitHub's native alert-gating check, which never reports on a
  merge-group ref and stalled the first real batch -- swapped to the job-level `CodeQL
  Analysis` check, with alert-gating restored via the `code_scanning` rule below.)
- a `code_scanning` rule (`tool: CodeQL, security_alerts_threshold: high_or_higher,
  alerts_threshold: errors`) -- this is what actually gates new high-severity alerts now
  that the required-status-check context is job-level, not the native alert check.

The command prints the new ruleset's `id` on success. Note it for the rollback below.

**No bypass actors are configured** (`bypass_actors: []`), so the PI's own merges go
through the queue too, same as everyone else's -- confirmed live on `app-scratch`
(`current_user_can_bypass: "never"` in the ruleset creation response).

## Mandatory follow-up: context-swap retrigger

Any required-status-check change on `main` can leave already-open PRs missing a context
they were opened before. Run this immediately after applying:

```powershell
./operations/devops/Invoke-ContextSwapRetrigger.ps1
```

This close-reopens every open PR to re-trigger all required workflows and prints a
before/after table per PR, exiting non-zero if any PR is still missing a required
context. Full protocol: `deploy/azure/runbooks/context-swap.md`.

## Rollback

If the ruleset needs to come back out, either disable it in place or delete it outright.

**Disable (keeps the ruleset definition, stops enforcing it):**

```bash
gh api -X PUT repos/AI-Rosetta-Stone/ai-triad-research/rulesets/<id> \
  -f enforcement=disabled
```

**Delete (removes it entirely):**

```bash
gh api -X DELETE repos/AI-Rosetta-Stone/ai-triad-research/rulesets/<id>
```

Either way, re-run the context-swap retrigger afterward -- disabling the merge queue
changes how `main` resolves required contexts for already-open PRs, the same class of
drift the retrigger exists to catch on the way in.

**Coupling warning (SO, t/4567#63 e/387): disabling this ruleset silently drops
alert-gating, because alert-gating lives ONLY in this ruleset's `code_scanning` rule,
not in classic branch protection (classic requires `CodeQL Analysis`, the job, which
never fails on an alert -- only on an analysis error).** Classic protection cannot
substitute `CodeQL` (the native alert-gating check) back in either: it applies to
merge-group commits too, so re-adding it there would just re-stall the queue the same
way. If you disable this ruleset, alert-gating is OFF until you either re-enable it or
add an equivalent `code_scanning` ruleset rule elsewhere -- do not treat "classic
protection still applies" as "nothing changed."

## What's NOT in this switch

The root AGENTS.md update carrying the merge-queue practice text (t/4580#2 + #4, plus the
`agent-rules-reference.md` §3 pointer) is a separate PR, held as a draft with
`consult-hold` until the PI approves this switch in the same window. See t/4567#58 item 2.
