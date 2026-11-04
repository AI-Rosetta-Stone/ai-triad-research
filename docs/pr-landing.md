# PR Landing, Merge Queue and Holds

The full procedure behind root `AGENTS.md` → "Landing Code". This text moved out of the root file unchanged (to cut the instruction tokens every agent loads on every turn). It is still binding. Read it before you arm, enqueue, apply or clear a hold, or jump the queue. Rationale and incident history: `docs/agent-rules-reference.md` (Ref §3, §4, §5). Where this file differs from `docs/change-tiers.md`, Change Tiers wins.

## Pre-Self-Merge Verification

- **Land code through a PR to `main`.** The required contexts are `ci-gate`, `CodeQL Analysis`, `joint-gv-guard` and `consult-hold-guard`, with `enforce_admins` on. (t/4567: the native `CodeQL` alert-gating check never reports on a merge-group ref; alert-gating is enforced by the merge queue's `code_scanning` ruleset rule instead.)
- **`main` merges through the merge queue (t/4567).** Before arming or enqueuing, confirm the base is `main`, PR-tier checks are green on the exact head, and no hold is open. **Enqueue pinned with `node operations/devops/enqueue-pr.mjs <owner>/<repo> <N>`** (t/4740) — the bare `gh pr merge --auto --squash --match-head-commit <headRefOid>` CLI form has twice (t/4731#1, t/4740#1) reported success while leaving the PR unenqueued, with no confirmed trigger; the wrapper verifies `isInMergeQueue` and falls back to the GraphQL mutation on a miss. **Never push to a queued PR:** GitHub may reject it (`GH006`), and `--disable-auto` doesn't dequeue. Use a separate PR, or dequeue, push and re-enqueue pinned. Never a bare manual merge. Ref §3.
- **Incident hotfix (jump the queue):** only the TL, or DevOps Lead with the TL's recorded go, for a PR fixing an active incident with an anchor ticket. Enqueue with `jump`, head pinned; every required check still runs. Never for `consult-hold` or `joint-gv` PRs; a T2 fix still needs its SO clearance and approval. Log each jump on the incident ticket. Bypassing branch protection stays PI-only.

## PR-Flow Practice Rules

- **Batch sequential same-feature work** into one PR, unless the diff is over ~400 lines or mixes concerns. Merge promptly on green, or record why not.
- **Arm auto-merge at PR creation** (`node operations/devops/enqueue-pr.mjs <owner>/<repo> <N>`, t/4740) for **T0** PRs. For **T1**, arm only after the reviewer's `Approved (<role>):` approval (App review or comment) is on the PR for the current head (t/4247). Arming means "done", so disarm (and dequeue, if queued) before pushing more.
  - Never arm consult-hold, joint-gv or draft PRs, or PRs whose base isn't `main`.
  - **User-facing UI changes** (any tier, T0 included) arm only after `Approved (Design):` or `Design-exempt (Design):` on the current head: see `docs/review-routing.md` § Design Gate (PI directive, t/4781).
  - **Backstop:** `enqueue-sweep.yml` enqueues any non-draft T0 PR on `main` once its required checks are green and nothing has been pushed for 15 minutes. If you will push more, open it as a draft or add the `no-auto-enqueue` label.
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
