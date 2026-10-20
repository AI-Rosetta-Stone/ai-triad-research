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
 * (`state: 'APPROVED'`, submitted after the latest push). The bot-review arm does NOT reuse the
 * comment's self-approval heuristic: GitHub itself refuses an App's self-approval on its own PR
 * (confirmed live, t/4096 arm 5), so a real APPROVED review already proves a distinct identity
 * reviewed it. Accepting this widens what satisfies the gate, so this change is T1, not T0.
 */

function parseTier(body) {
  const firstLine = String(body ?? '').trim().split('\n')[0].trim();
  const m = /^Tier:\s*(T[012])\b/i.exec(firstLine);
  return m ? m[1].toUpperCase() : null;
}

function ownerSlugFromBranch(headRefName) {
  const seg = String(headRefName ?? '').split('/')[0] ?? '';
  return seg.toLowerCase().replace(/[^a-z]/g, '');
}

function normalizeRole(role) {
  return String(role ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

export function evaluateT1ApprovalGuard({ body, headRefName, lastPushAt, approvalComments, botReviews }) {
  const tier = parseTier(body);
  if (tier !== 'T1') {
    return { pass: true, tier, reason: 'not-t1' };
  }

  const ownerSlug = ownerSlugFromBranch(headRefName);
  const pushTime = lastPushAt ? new Date(lastPushAt).getTime() : 0;

  const matches = [];
  for (const c of approvalComments || []) {
    const m = /^Approved \(([^)]+)\):/.exec(String(c?.body ?? '').trim());
    if (!m) continue;
    const role = normalizeRole(m[1]);
    if (ownerSlug && role.startsWith(ownerSlug)) continue; // self-approval by the PR's own owning role
    const effective = c.updatedAt ?? c.createdAt;
    if (!effective) continue;
    if (new Date(effective).getTime() <= pushTime) continue; // approval predates the latest push
    matches.push({ role: m[1], at: effective });
  }

  // t/4096 Reviewer switch-over: a real bot APPROVED review after the latest push also satisfies
  // the gate. GitHub itself refuses an App's self-approval (t/4096 arm 5), so no owner-slug check
  // is needed here.
  for (const r of botReviews || []) {
    if (String(r?.state ?? '').toUpperCase() !== 'APPROVED') continue;
    const effective = r.submittedAt;
    if (!effective) continue;
    if (new Date(effective).getTime() <= pushTime) continue; // review predates the latest push
    matches.push({ role: r.login ?? 'reviewer-app', at: effective });
  }

  if (matches.length > 0) {
    return { pass: true, tier, reason: 'approved-after-push', approver: matches[0] };
  }
  return { pass: false, tier, reason: 'no-post-push-approval' };
}
