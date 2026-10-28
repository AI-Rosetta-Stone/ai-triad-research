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
- the same four required contexts already enforced on `main` today (`ci-gate`, `CodeQL`,
  `joint-gv-guard`, `consult-hold-guard`) -- unchanged.

The command prints the new ruleset's `id` on success. Note it for the rollback below.

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

## What's NOT in this switch

The root AGENTS.md update carrying the merge-queue practice text (t/4580#2 + #4, plus the
`agent-rules-reference.md` §3 pointer) is a separate PR, held as a draft with
`consult-hold` until the PI approves this switch in the same window. See t/4567#58 item 2.
