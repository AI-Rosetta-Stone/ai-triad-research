# PR Landing, Merge Queue and Holds

The full procedure behind root `AGENTS.md` → "Landing Code". This text moved out of the root file unchanged (to cut the instruction tokens every agent loads on every turn). It is still binding. Read it before you arm, enqueue, apply or clear a hold, or jump the queue. Rationale and incident history: `docs/agent-rules-reference.md` (Ref §3, §4, §5). Where this file differs from `docs/change-tiers.md`, Change Tiers wins.

## Pre-Self-Merge Verification

- **Land code through a PR to `main`.** The required contexts are `ci-gate`, `CodeQL Analysis`, `joint-gv-guard` and `consult-hold-guard`, with `enforce_admins` on. (t/4567: the native `CodeQL` alert-gating check never reports on a merge-group ref; alert-gating is enforced by the merge queue's `code_scanning` ruleset rule instead.)
- **`main` merges through the merge queue (t/4567).** Before arming or enqueuing, confirm the base is `main`, PR-tier checks are green on the exact head, and no hold is open. **Enqueue pinned with `node operations/devops/enqueue-pr.mjs <owner>/<repo> <N>`** (t/4740) — the bare `gh pr merge --auto --squash --match-head-commit <headRefOid>` CLI form has twice (t/4731#1, t/4740#1) reported success while leaving the PR unenqueued, with no confirmed trigger; the wrapper verifies `isInMergeQueue` and falls back to the GraphQL mutation on a miss. **Never push to a queued PR:** GitHub may reject it (`GH006`), and `--disable-auto` doesn't dequeue. Use a separate PR, or dequeue, push and re-enqueue pinned. Never a bare manual merge. Ref §3.
- **Incident hotfix (jump the queue):** only the TL, or DevOps Lead with the TL's recorded go, for a PR fixing an active incident with an anchor ticket. Enqueue with `jump`, head pinned; every required check still runs. Never for `consult-hold` or `joint-gv` PRs; a T2 fix still needs its SO clearance and approval. Log each jump on the incident ticket. Bypassing branch protection stays PI-only.

## PR Budget and Batching (t/397, PI-approved 2026-11-11)

Target: **≤20 new PRs a day** team-wide (7-day average). Most PRs are features, per `docs/tl-decomposition-rules.md` § One PR per feature.

- **Per agent: at most 1 new PR a day, and at most 2 open PRs.**
  - Exempt, with the TL's ok: a fix for broken `main`, an incident, a security fix, or a PI request.
- **Add to an open PR before opening a new one.** If you already have an open PR in the same area that isn't queued, the change goes there.
- **Minimum size:** a non-urgent change under ~50 lines waits to be combined with your next change in the same area, or goes into the feature PR. Exempt as above.
- **No separate PRs for review nits or small follow-ups.** Fix review findings in the same PR; the reviewer re-stamps the delta only (`docs/review-routing.md` § Delta re-stamp). A follow-up that really needs its own change goes into your next substantive PR or the weekly docs train, never a standalone PR.
- **Weekly docs train:** agent-guidance, AGENTS.md, rule, ownership-table and docs edits go into one rolling PR per week, on branch `docs/weekly-YYYY-WW`. It's owned by Documentation and AI Rosetta Stone and landed every Monday, or sooner if urgent.
  - Commit to that week's branch instead of opening your own docs PR.
  - An urgent rule change, such as an incident, can still go alone with a TL go.
  - Overlay-only guidance (role AGENTS.md, playbooks, Interweave apps) never needs a main-repo PR: commit it with `ogit`.
- **Team daily budget (t/564, PI directive 2026-11-25):** `enqueue-pr.mjs` refuses non-exempt PRs past 20 new PRs in a UTC day (`feat/` and `train/` branches count once). At 15 the TL and that day's authors are warned. Over-budget PRs wait, oldest first, for a later day's free slots (t/564). DevOps Lead's metric job still posts the day's count at 12:00Z and 18:00Z.

## PR-Flow Practice Rules

- **Merge promptly on green,** or record why not.
- **Arm auto-merge at PR creation** (`node operations/devops/enqueue-pr.mjs <owner>/<repo> <N>`, t/4740) for **T0** PRs. For **T1**, arm only after the reviewer's `Approved (<role>):` approval (App review or comment) is on the PR for the current head (t/4247). Arming means "done", so disarm (and dequeue, if queued) before pushing more.
  - **To re-run `t1-approval-guard` and `tier-check` by hand, post a PR comment containing `/recheck-guards`.** Any other new or edited comment re-runs them only if it carries a verdict (`Approved (<role>)`, `Changes requested`, `Design-exempt`, an SO clearing note), or carried one before the edit; status comments no longer do. Deleting any PR comment and dismissing a review always re-run them, so a withdrawn approval stops counting at once (a dismissal needs the PR branch to include that trigger: rebase onto `main` if it predates #5176).
  - Never arm consult-hold, joint-gv or draft PRs, or PRs whose base isn't `main`.
  - **User-facing UI changes** (any tier, T0 included) arm only after `Approved (Design):` or `Design-exempt (Design):` on the current head: see `docs/review-routing.md` § Design Gate (PI directive, t/4781).
  - **Backstop:** `enqueue-sweep.yml` enqueues any non-draft T0 PR on `main` once its required checks are green and nothing has been pushed for 15 minutes. If you will push more, open it as a draft or add the `no-auto-enqueue` label. **To dequeue a PR in order to push a fix, add `no-auto-enqueue` first, then dequeue** (t/4879: the sweep re-enqueued #4561 29s after a manual dequeue and it merged with the old head). The sweep now also holds a manually dequeued PR until a new head is pushed, but the label is the belt-and-braces; remove it when you re-enqueue.
  - **T1 backstop (t/73): report-only for now.** The sweep's T1 step ships with both of its switches off (`T1_NUDGE: 'off'` and `T1_ENQUEUE: 'off'` in `enqueue-sweep.yml`), so it neither enqueues nor comments on any PR. **T1 PRs are not auto-enqueued today: enqueue an approved T1 PR yourself**, as above; and if `t1-approval-guard` never evaluated an approved, green head (its run was lost), post any comment on the PR to make it run again. The step only logs what it would do. Each switch is turned on in its own T2 commit. With `T1_NUDGE` on, it will post one comment per head to re-run a guard that never evaluated an approved, green head. With `T1_ENQUEUE` on, it will enqueue a non-draft T1 PR on `main`, with no idle window, once `t1-approval-guard` is `success` at the head, a reviewer-App `Approved (<role>):` **review** is bound to that head SHA (comment-only approvals are not auto-enqueued), all required checks are green, and it carries no `consult-hold`, `joint-gv` or `no-auto-enqueue` label, with the enqueue pinned to the approved head. From then on, if you mean to push after the approval, add `no-auto-enqueue` or convert to draft first.
- **Ping the reviewer in the same step (t/532).** Whoever opens or marks ready a **T1** PR pings the reviewer in that step, naming the PR, the ticket and the head SHA, unless the playbook names another reviewer. A ticket comment is not a request: it wakes no one (#5392 waited five hours on a comment).
- **Backup and archive branches are not PRs (t/532).** To keep work that is not for merge, push the branch and record its name and head SHA on the ticket. Do not open a PR for it. Examples: `backup/t183-readonly-cache` (#5184) and `archive/t268-4953` (#5116), each was opened as a PR and should have been a pushed branch.
- **Holds:** the `consult-hold` label (T2 only) is the only hold. Draft state, hold comments and condition checklists are optional.
  - It clears with the Second Opinion's clearing comment, which checks each of its own conditions against the head;
  - or with the "SO did not review" note plus the human approval.
  - Adding `consult-hold` or `joint-gv` removes a PR from the queue, and the queue guards refuse any batch containing one.
- **Co-landing PRs** carry `joint-gv` until their joint review clears. Then each reviewer posts `Joint review cleared (<roles>): <head sha>` on every PR in the set, the owner removes `joint-gv`, and enqueues them back-to-back with heads pinned — later entries' groups include the earlier ones, so the set is tested together. If the PRs must land atomically, combine them into one PR instead; the queue can land one without the other. Cross-repo sets (e.g. a data-repo PR) keep their existing order; only `main` here is queued.
- **Approve via the reviewer App:** `Invoke-AsAgentApp -Role reviewer`, with the review body `Approved (<role>): …`. Never approve your own role's PR. It fails closed; procedure in `docs/agent-pr-approval.md`. The approval is a record, not a merge requirement. Ref §4.

## Epic Branches

- Child PRs target `epic/<name>`, never `main`.
- There is one shared epic → `main` PR.
- Review each child when it merges into the epic. Ref §5.
