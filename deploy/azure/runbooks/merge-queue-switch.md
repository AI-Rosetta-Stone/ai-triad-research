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
- `SQUASH` merges. **`grouping_strategy` is `HEADGREEN` as of 2026-10-28** (PI-applied,
  t/4567#72) -- originally created `ALLGREEN`, switched to test each batch once instead of
  once per entry (TL design, t/4567#71). See "Collateral dequeues" below for what changed.
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

## Fix existing ruleset (C1) -- t/4567, SO-cleared at PR #4040's head (e/388#3, e/388#4)

The ruleset created above (`main-merge-queue`, id `26043005`) already exists on `main` but
still requires the native `CodeQL` check, which never reports on a `merge_group` ref
(`gh-readonly-queue/*`) -- that stalled the first real batch indefinitely (t/4567). **Do not
re-run the `POST` above** -- that would create a SECOND ruleset that still stalls. Fix the
existing one in place, with `PUT`, instead.

PI runs PowerShell 7 (`pwsh`), so these are PowerShell-first. If running from Git Bash instead,
prefix every `git show` with `MSYS_NO_PATHCONV=1` (root AGENTS.md, Windows Bash path-mangling)
-- `pwsh` has no equivalent mangling and needs no prefix.

Every input file is read from **PR #4040's head**, not from `main` -- the files aren't on `main`
until #4040 merges, and this applies exactly what the SO cleared (e/388#3), not whatever happens
to be locally checked out:

```powershell
git fetch origin pull/4040/head
$ClearedSha = '<full 40-char SHA from the SO''s clearing comment on PR #4040>'
# NEVER hardcode a specific short SHA here -- the SO clears a specific head and the PR keeps
# moving. A stale SHA silently PUTs an OLD version of the ruleset (e.g. db5037b6 still required
# plain `CodeQL` with no `code_scanning` rule at all -- SO e/388#7, G2). Paste the full SHA from
# the SO's own clearing comment, not whatever's locally checked out.

# 0. Pre-flight: stop before touching anything live if $ClearedSha doesn't actually carry the
#    C1 fix (SO e/388#7, G2) -- a file can't name the commit it's in, so this is the next best
#    thing: fail loud instead of silently re-stalling the queue.
$rs = git show "${ClearedSha}:operations/devops/merge-queue-ruleset.json" | Out-String
if ($LASTEXITCODE -ne 0 -or $rs -notmatch '"CodeQL Analysis"' -or $rs -notmatch '"code_scanning"') {
    throw "ClearedSha $ClearedSha does not carry the C1 ruleset -- stop."
}
git show "${ClearedSha}:operations/devops/classic-required-status-checks.json" | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "ClearedSha $ClearedSha has no classic-checks file -- stop."
}

# 1. Fix the existing ruleset in place (PUT, not POST). Atomic: the CodeQL Analysis swap and the
#    code_scanning alert-gating rule land together. `enforcement: active` in the file also
#    re-enables the ruleset if the PI disabled it as an interim unblock. All four
#    required_status_checks entries are pinned to integration_id 15368 (TL e/388#6, SO-agreed
#    e/388#7) -- a stray same-named status can't satisfy any of them, not just CodeQL Analysis.
git show "${ClearedSha}:operations/devops/merge-queue-ruleset.json" |
  gh api -X PUT repos/AI-Rosetta-Stone/ai-triad-research/rulesets/26043005 --input -

# 2. Swap classic branch protection the same way, via the required_status_checks sub-resource
#    (never a full PUT /protection -- see context-swap.md's warning). All four `checks` pinned to
#    app_id 15368 (GitHub Actions) so a stray same-named status can't satisfy the requirement.
#    NOTE the field name differs from step 1: the ruleset uses `integration_id`, classic
#    protection's `checks[]` uses `app_id` (e/388#4) -- both files already use the right one.
git show "${ClearedSha}:operations/devops/classic-required-status-checks.json" |
  gh api -X PATCH repos/AI-Rosetta-Stone/ai-triad-research/branches/main/protection/required_status_checks --input -

# 3. Re-trigger every open PR so none is stranded on the old context name.
./operations/devops/Invoke-ContextSwapRetrigger.ps1

# 4. Re-arm the batch that was stuck under the old context, pinned to its current head. Step 3's
#    close/reopen already dequeued the stale entries -- this just re-enqueues them under the
#    fixed ruleset.
foreach ($pr in 4036, 4037, 4038, 4039) {
    $headSha = gh pr view $pr --json headRefOid -q .headRefOid
    gh pr merge $pr --auto --squash --match-head-commit $headSha
}

# #4040 itself goes in the SAME window (TL e/388#9) -- it merges through the now-fixed queue
# right alongside the batch it unblocks, not as a separate manual step. Pin it to $ClearedSha
# specifically, NOT to its "current head" (SO e/388#10): if the PR has moved since the SO
# cleared it, the cleared version isn't what would merge, so this should stop rather than merge
# something nobody reviewed. The TL's T1 approval comment must also be posted against
# $ClearedSha before this is armed -- confirm that on the PR before running it.
gh pr merge 4040 --auto --squash --match-head-commit $ClearedSha
```

**Stop here -- do NOT run the drift guard from this session.** (TL e/388#9, correcting an earlier
draft of this runbook that had it as step 5.) `Test-RequiredContextsListDrift.ps1` reads the SSOT
(`.github/ci/required-contexts.json`) from **this local checkout**, which is still on the OLD
`main` -- #4040 (the C2 drift-guard extension and the fixed SSOT) hasn't merged yet at this point,
so the guard would compare the newly-fixed live state against a stale SSOT that still says
`CodeQL` and has no `merge_queue_ruleset` expectation at all. That's a false red, not a real one.

**Order matters** (SO e/388#2, TL-accepted e/388#3): the ruleset `PUT` (1) lands before classic
protection (2); the retrigger (3) runs before the batch -- including #4040 -- is re-enqueued (4).
This is also why #4040 merges **after** C1, in the same window, not before: before C1 lands,
#4040's SSOT/AGENTS.md/runbook/liveness-list would describe a `CodeQL Analysis` state that doesn't
exist yet on the live ruleset/classic protection, and the daily drift job would flag that gap as
drift that isn't real (Q1, e/388#2).

## Post-merge confirmation (TL, after #4040 lands)

Once #4040 has merged through step 4 above, **the TL** -- not the PI, and from a fresh worktree
on the new `origin/main`, not this session's checkout -- confirms the fix actually landed clean:

```powershell
git worktree add -b t4567-post-merge-check .worktrees/t4567-post-merge-check origin/main
cd .worktrees/t4567-post-merge-check
./operations/devops/Test-RequiredContextsListDrift.ps1
$LASTEXITCODE   # must be 0
```

This now runs the C2-extended guard against the SSOT and `merge_queue_ruleset` expectation that
actually matches #4040's merged code -- the PI's local checkout never had either. **Expected
output** (SO e/388#10): exit code `0`, and a `RULESET 'main-merge-queue':` line showing
`active=True` and `tool=CodeQL/high_or_higher/errors`. Post the exit code and this line on t/4567.
If it isn't 0, STOP and diagnose before anything else enqueues -- do
not treat a non-zero exit here as "probably just the merge not propagated yet."

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

## Collateral dequeues under HEADGREEN (TL p/331#2497, accepted condition)

Switching `grouping_strategy` to `HEADGREEN` and adding a `concurrency` cancel-in-progress
group to `ci.yml`/`codeql.yml`'s `merge_group` runs (t/4567#71) means the queue tests each
batch once instead of once per entry -- a real win on the Free plan's ~20-concurrent-job
cap. Live-fire on `app-scratch` (t/4567 arms a-d, t/4567#77) proved the saving is real, but
also found a trade-off:

**A real CI failure anywhere in a batch can collaterally dequeue CLEAN entries too, not
just the actual culprit.** GitHub's bisection progressively drops the oldest untested
entry and retests; whichever entries fall out of the surviving test group get dequeued
`CI_FAILURE`, whether or not they were ever individually proven bad. Confirmed live-fire
twice: a clean PR (#84, arm b) and a clean PR queued ahead of a held one (#89, arm c) were
both dequeued `CI_FAILURE` despite never failing on their own.

**TL's call (t/4567#77, p/331#2497): accept this trade-off.** It's safe (nothing unsafe
ever merges) and the saving applies to every batch, not just failing ones. Three
conditions:
1. **D1 (`merge-queue-dequeue-alert.yml`) groups every dequeue from the same
   batch-failure episode into one issue** instead of one issue per PR, and retroactively
   marks every earlier entry `[COLLATERAL]` once a later one dequeues in the same episode
   (mechanically justified: a later dequeue proves the smaller remaining group still
   failed, so removing the earlier entries alone didn't explain it). The alert tells every
   owner to **re-arm pinned to their current head** -- this workflow never
   auto-re-enqueues.
2. This section.
3. **Count collateral dequeues in the one-week review** (t/4567, due 2026-11-04) -- how
   many clean entries got bounced per real failure, to judge whether the trade-off still
   holds at real-repo batch sizes and suite lengths (app-scratch's ~45s `ci-gate` is not a
   stand-in for the real ~25-30min suite's bisection cost).

## What's NOT in this switch

The root AGENTS.md update carrying the merge-queue practice text (t/4580#2 + #4, plus the
`agent-rules-reference.md` §3 pointer) is a separate PR, held as a draft with
`consult-hold` until the PI approves this switch in the same window. See t/4567#58 item 2.
