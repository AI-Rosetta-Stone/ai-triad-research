# Agent PR Approval

**Status:** Canonical (shared)
**Owner:** DevOps Lead
**Last updated:** 2026-10-20

How an agent records a PR approval, after the t/4096 Reviewer switch-over. Every agent shares one
GitHub login (`jpsnover`), so GitHub's own self-approval block never applied to a free-text
`Approved (<role>):` comment — that's why `gh pr review --approve` was banned outright (root
AGENTS.md, pre-switch-over). The reviewer App (`ai-triad-reviewer-jpsnover[bot]`) is a distinct
GitHub identity, but every PR here is still authored by `jpsnover`, not by an author App — so
GitHub's own identity check does NOT make a reviewer-App review self-approval-safe by itself (an
agent could run `Invoke-AsAgentApp -Role reviewer` on its own PR). What actually blocks that is
`t1-approval-guard`'s owner-slug check on the review body (PR #3487) — the same check it already
applied to the legacy comment. **This closes the reviewer-App vector only, not the whole class**:
the guard still trusts the self-declared role name in the body, so an author can name a *different*
role and pass. See the residual at t/4096#65.

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

## Still a comment, not a gate

A reviewer-App approval is a **record, not a gate** (t/4096#12 C1, TL ruling): branch protection
does not require it today. `required_approving_review_count` is a separate, PI-only
branch-protection decision and is out of scope here.
