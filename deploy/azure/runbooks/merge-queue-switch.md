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
$ClearedSha = 'db5037b6'   # the exact head the SO cleared (e/388#3/e/388#4) -- confirm this still
                           # matches before using a newer one; the SO re-checks on every push

# 1. Fix the existing ruleset in place (PUT, not POST). Atomic: the CodeQL Analysis swap and the
#    code_scanning alert-gating rule land together. `enforcement: active` in the file also
#    re-enables the ruleset if the PI disabled it as an interim unblock.
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

# 5. Confirm the drift guard is clean against the newly fixed live state -- not a parallel check,
#    the final confirmation. If this doesn't exit 0, STOP and diagnose before anything else enqueues.
./operations/devops/Test-RequiredContextsListDrift.ps1
$LASTEXITCODE   # must be 0
```

**Order matters** (SO e/388#2, TL-accepted e/388#3): the ruleset `PUT` (1) lands before classic
protection (2); the retrigger (3) runs before the stuck batch is re-enqueued (4); the drift guard
(5) is the final confirmation, not a parallel check. **Then, in the same window, merge PR #4040**
-- not before. Before C1 lands, #4040's SSOT/AGENTS.md/runbook/liveness-list would describe a
`CodeQL Analysis` state that doesn't exist yet on the live ruleset/classic protection, and the
daily drift job (`Test-RequiredContextsListDrift.ps1` on its own schedule) would flag that gap as
drift that isn't real (Q1, e/388#2).

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
