// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Pure predicate for the t1-approval-guard check (t/4247): a T1 PR auto-merged twice on 10-17
 * (#3343, #3364) with no `Approved (<role>):` comment from the round-robin reviewer. Root cause,
 * in part a rule conflict: root AGENTS.md says "arm auto-merge at PR creation for T1", Change
 * Tiers says T1 needs the reviewer's approval first — nothing mechanical enforced the approval,
 * so arming at creation merged on green CI alone.
 *
 * `evaluateT1ApprovalGuard` takes already-fetched PR facts and returns a pass/fail verdict. It
 * does not call GitHub itself — the workflow (CLI wrapper, not duplicated here) does the API
 * reads and feeds their results in, so the decision is testable without a live PR.
 *
 * TIER GATING: only a PR whose body's first line is exactly `Tier: T1` is checked at all. A
 * missing, malformed, T0 or T2 declaration always passes THIS gate — tier-check.yml already
 * flags a missing/malformed declaration on its own, and T2 has its own consult-hold mechanism.
 *
 * APPROVAL MATCH: a comment matches if it starts with `Approved (<role>):` AND its EFFECTIVE time
 * (`updatedAt` if the comment was edited, else `createdAt`) is after `lastPushAt`. Using the
 * effective time means an approval added by editing an EARLIER comment in place still counts —
 * one of this gate's own required route-table entries.
 *
 * SELF-APPROVAL HEURISTIC (a design choice, not GitHub-enforced — every agent shares one GitHub
 * login, so GitHub's own self-approval block does not apply to a free-text comment): the PR's
 * "owner slug" is the branch name's leading path segment (e.g. `devops/t4242-...` -> `devops`).
 * An approval comment whose parsed role name STARTS WITH that slug (after stripping non-letters
 * and lowercasing) is rejected as self-approval. This is an approximation, not an exact identity
 * check — documented here so a reviewer can propose a better one if this heuristic misfires on a
 * real role name.
 *
 * t/4096 Reviewer switch-over: during the transition, a T1 PR can be approved EITHER way --
 * the legacy `Approved (<role>):` comment, OR a real GitHub review left by the reviewer App
 * (originally `state: 'APPROVED'` after the latest push; since t/116, its role-tagged body bound
 * to the current head -- see the t/116 block below).
 *
 * TL correction (PR #3487 review): arm 5 proved GitHub refuses an App's approval of a PR **the
 * App itself authored** -- it does NOT prove a human-authored PR is self-approval-safe. Every PR
 * is authored by SOME identity -- `jpsnover` directly before the t/4351 author-App switch-over,
 * the author App (`ai-triad-author-jpsnover[bot]`) after it -- and any agent can run
 * `Invoke-AsAgentApp -Role reviewer`, so an author approving their own PR through the reviewer
 * App would otherwise pass EITHER WAY (App-distinctness from the reviewer App never made this
 * safe; it was never the control). The bot-review arm therefore reuses the EXACT SAME owner-slug
 * self-approval check as the comment arm, independent of author identity: the review body must
 * still start with `Approved (<role>):`, and that role must not match the head branch's owner
 * slug. It is also restricted to the configured reviewer App's own login (`reviewerAppLogin`) --
 * a human's review or any other App's review must not silently satisfy this gate.
 *
 * t/116 (a) (TL decision t/116#3, HIGH; rule refined by the TL in p/12#58, recorded on
 * t/116#8): ROLE VERDICTS, NOT REVIEW STATE. The gate used to pre-filter reviews on
 * `state === 'APPROVED'` and never looked at CHANGES_REQUESTED at all, so once any
 * `Approved (<role>):` existed after the push, a later CHANGES_REQUESTED from anyone (another
 * role through the same shared reviewer-App account -- the #4686 class -- or a human) did not
 * revoke it. Now every verdict comes from `latestRoleVerdicts({ ..., mode: 'gate' })` in
 * role-review-verdicts.mjs, the ONE shared implementation (tier-check R6, t/116 (b), is meant to
 * reuse it). That module documents the slots and the clearing rules. In short:
 *   - APPROVALS ARE HEAD-BOUND: a review at `commitId === headSha`, or a comment after
 *     `lastPushAt`. A push invalidates them.
 *   - A CHANGES-REQUEST IS STICKY ACROSS PUSHES: it blocks until the same role (reviewer App) or
 *     the same login (human) approves later, or the review is dismissed. A push, a comment, or
 *     another role's approval never clears it. Role-less App latches clear only by dismissal
 *     (or, for a comment, editing or deleting it).
 *   - Ties go to the block.
 * This predicate adds only the T1 policy on top: ANY outstanding request blocks; otherwise it
 * passes on an at-head approval from the reviewer App or a comment (never a human review, TL
 * blocking 2, PR #3487) whose role is not the branch owner's (self-approval). A reviewer-App
 * review's verdict is its body, so a COMMENTED-state review whose body is `Approved (<role>):`
 * counts, exactly as the same text in a comment always has.
 *
 * `missing-head-sha`: reviews present but no `headSha` fails closed explicitly (no review could
 * be bound to the head, so no review approval could count anyway).
 *
 * DEPENDENCY: imports ./role-review-verdicts.mjs. t1-approval-guard.yml and ci.yml's merge_group
 * arm copy this file into a temp dir from main's tip, so they must copy role-review-verdicts.mjs
 * into the SAME dir (both do, from the same base tip).
 */

import { latestRoleVerdicts } from './role-review-verdicts.mjs';

function parseTier(body) {
  const firstLine = String(body ?? '').trim().split('\n')[0].trim();
  const m = /^Tier:\s*(T[012])\b/i.exec(firstLine);
  return m ? m[1].toUpperCase() : null;
}

/** Exported for reuse by pr-triage.yml's CI-green nudge (t/4351): since the author-App
 * switch-over, `pr.user.login` is a bot handle and no longer names a notifiable human, so the
 * nudge uses this to say WHICH role's branch is green, while still @-mentioning the one shared
 * human account (t/4351, see pr-triage.yml). */
export function ownerSlugFromBranch(headRefName) {
  const seg = String(headRefName ?? '').split('/')[0] ?? '';
  return seg.toLowerCase().replace(/[^a-z]/g, '');
}

function normalizeRole(role) {
  return String(role ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

export function evaluateT1ApprovalGuard({ body, headRefName, headSha, lastPushAt, approvalComments, botReviews, reviewerAppLogin }) {
  const tier = parseTier(body);
  if (tier !== 'T1') {
    return { pass: true, tier, reason: 'not-t1' };
  }

  // `botReviews` keeps its historical name so a caller and a predicate from different commits
  // still agree (the merge_group arm runs a PR's ci.yml against main's predicate), but callers
  // now pass EVERY review on the PR, human ones included, each with `commitId`.
  const reviews = botReviews || [];
  if (reviews.length > 0 && !headSha) {
    return { pass: false, tier, reason: 'missing-head-sha' };
  }

  const slots = latestRoleVerdicts({
    reviews, comments: approvalComments || [], reviewerAppLogin, headSha, lastPushAt, mode: 'gate',
  });

  const blockers = [...slots.values()].filter((s) => s.kind === 'changes_requested');
  if (blockers.length > 0) {
    return {
      pass: false, tier, reason: 'changes-requested-outstanding',
      blockers: blockers.map((b) => ({ role: b.role, at: b.at, source: b.source })),
    };
  }

  const ownerSlug = ownerSlugFromBranch(headRefName);
  const approvals = [...slots.values()]
    .filter((s) => s.kind === 'approved' && s.atHead && s.source !== 'human-review')
    .filter((s) => !(ownerSlug && normalizeRole(s.role).startsWith(ownerSlug))) // self-approval by the owning role
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  if (approvals.length > 0) {
    return { pass: true, tier, reason: 'approved-after-push', approver: { role: approvals[0].role, at: approvals[0].at } };
  }
  return { pass: false, tier, reason: 'no-post-push-approval' };
}
