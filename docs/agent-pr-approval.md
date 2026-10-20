# Agent PR Approval

**Status:** Canonical (shared)
**Owner:** DevOps Lead
**Last updated:** 2026-10-20

How an agent records a PR approval, after the t/4096 Reviewer switch-over. Every agent shares one
GitHub login (`jpsnover`), so GitHub's own self-approval block never applied to a free-text
`Approved (<role>):` comment — that's why `gh pr review --approve` was banned outright (root
AGENTS.md, pre-switch-over). The reviewer App (`ai-triad-reviewer-jpsnover[bot]`) is a distinct
GitHub identity from both `jpsnover` and the author App (`ai-triad-author-jpsnover[bot]`, t/4351,
step 2 of the same rollout) — but **App-distinctness alone does not make a reviewer-App review
self-approval-safe**, whether the PR is authored by `jpsnover` directly or by the author App: an
agent could run `Invoke-AsAgentApp -Role reviewer` on its own PR either way. What actually blocks
that is `t1-approval-guard`'s owner-slug check on the review body (PR #3487) — the same check it
already applied to the legacy comment, and unaffected by which identity authored the PR. **This
closes the reviewer-App vector only, not the whole class**: the guard still trusts the
self-declared role name in the body, so an author can name a *different* role and pass. See the
residual at t/4096#65. (This doc already got this wrong once before the author-App switch-over
landed, t/4096#65/PR #3490 — don't let a future reader re-infer "different App login = safe" from
half of this doc; both identity switch-overs share the same actual control.)

## The command

```powershell
Import-Module ./operations/devops/AgentAppToken.psm1
Invoke-AsAgentApp -Role reviewer -ScriptBlock {
  gh pr review <N> --approve --body 'Approved (<role>): <one-line reason>'
}
```

`Invoke-AsAgentApp` mints a short-lived installation token, scopes `GH_TOKEN` to the block, and
revokes the token when the block ends (C4) — the token never outlives the review call.

## The review body

Keep the `Approved (<role>):` text as the review's own body, exactly as it was as a PR comment
before the switch-over. The review's `state: APPROVED` plus `user.login:
ai-triad-reviewer-jpsnover[bot]` is what makes it attributable; the body text is for a human
skimming the PR, same as before.

**Attribution note:** GitHub's `performed_via_github_app` field is **not populated on PR reviews**
(confirmed live, t/4096#64) — it's that endpoint's own field coverage, not a gap in the App. Use
`user.login` + `user.type: Bot` to confirm a review was performed via the App; don't look for
`performed_via_github_app` on a review object.

## Fallback: fail closed, never jpsnover

If the App token fails to mint (missing vault secret, expired key, the installation lacks access
to the repo) `Get-AgentAppToken`/`Invoke-AsAgentApp` throws an `ActionableError` naming the problem
(t/4096#56-59, PR #3481) — it does **not** silently fall back to approving as `jpsnover`. Fix the
underlying App/vault issue and retry; do not work around a failed mint by posting a plain
`Approved (<role>):` comment instead, since that's exactly the unattributable path this switch-over
retires.

## Author App (t/4351, t/4096 step 2)

Opening a PR under the author App makes agent actions attributable in the same way the reviewer
App did for approvals — the PR's `user.login` becomes `ai-triad-author-jpsnover[bot]` instead of
the shared `jpsnover` account.

```powershell
Import-Module ./operations/devops/AgentAppToken.psm1
Invoke-AsAgentApp -Role author -ScriptBlock {
  gh pr create --title '<title>' --body '<body>' --base main --head '<branch>'
}
```

**What changes downstream of this:**
- `pr-triage.yml`'s `BOT_LOGINS` set includes the author App's login, so author-App PRs classify
  as bot PRs for triage purposes, not human "fleet" PRs (t/4351).
- The CI-green nudge no longer `@`-mentions `pr.user.login` (now a bot handle a human can't act
  on) — it `@`-mentions the one shared human account directly, and names the branch's owner-slug
  in the message body for context. See `pr-triage.yml`'s nudge step.
- `t1-approval-guard-predicate.mjs`'s owner-slug self-approval check needed **no logic change** —
  it was never keyed on author identity. Only its own doc comment, which once said "every PR is
  authored by `jpsnover`", needed correcting.

**Fallback: same as the reviewer App.** A failed mint throws an `ActionableError`; it never falls
back to opening the PR as `jpsnover`.

**Live-fire proof (t/4351):** a throwaway PR opened by the author App must (1) trigger the
required workflows (App-token events do; `GITHUB_TOKEN` events don't), (2) get all four required
contexts reporting (`ci-gate`, `CodeQL`, `joint-gv-guard`, `consult-hold-guard`), (3) allow
auto-merge to arm with `--match-head-commit`, and (4) be approvable by the reviewer App. Recorded
on t/4351, cleaned up after.

## Still a comment, not a gate

A reviewer-App approval is a **record, not a gate** (t/4096#12 C1, TL ruling): branch protection
does not require it today. `required_approving_review_count` is a separate, PI-only
branch-protection decision and is out of scope here.
