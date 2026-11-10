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
 * t/116 (a) (TL decision t/116#3, HIGH): ROLE VERDICTS, NOT REVIEW STATE. The gate used to
 * pre-filter reviews on `state === 'APPROVED'` and never looked at CHANGES_REQUESTED at all, so
 * once any `Approved (<role>):` existed after the push, a later CHANGES_REQUESTED from anyone
 * (another role through the same shared reviewer-App account -- the #4686 class -- or a human)
 * did not revoke it. Now:
 *   - Verdicts come from `latestRoleVerdicts` (role-review-verdicts.mjs): the role is read from
 *     the body, and each role's LATEST verdict wins. A review counts only if it is bound to the
 *     current head (`commitId === headSha`); a comment only if it postdates `lastPushAt`. So an
 *     old-head verdict, approving or blocking, is ignored.
 *   - ANY outstanding `changes_requested` at the head BLOCKS, whatever other roles approved,
 *     including the fail-closed `(unparseable)` latch.
 *   - Reviewer-App reviews and comments: full latestRoleVerdicts grammar, including its
 *     fail-closed backstop. An App review whose STATE is CHANGES_REQUESTED but whose body does
 *     not parse as a changes-request also blocks (state may only ADD a block, never grant an
 *     approval), latched for this head like the `(unparseable)` entry.
 *   - Other-login COMMENTS (the legacy shared-login `Approved (<role>):` path): strict grammar
 *     only. The loose "changes requested anywhere on line 1" backstop is App-only, because status
 *     chatter on the shared login ("addressed the changes requested by Quality") must not latch
 *     a block until the next push.
 *   - Human / other-login REVIEWS (TL: "human reviews count too"): a human review carries no
 *     role tag, so its verdict is its GitHub state, tracked per LOGIN (`@<login>`). The latest
 *     APPROVED / CHANGES_REQUESTED / DISMISSED review by that login at the head decides;
 *     COMMENTED does not clear a request (GitHub semantics). A human review never SATISFIES the
 *     gate (TL blocking 2, PR #3487); it can only block, and clear its own block.
 *   - A reviewer-App review's verdict is its body: a COMMENTED-state review whose body is
 *     `Approved (<role>):` counts, exactly as the same text in a comment always has.
 *   - Self-approval: an approval naming the branch owner's role never satisfies the gate, but
 *     that role's changes-request still blocks.
 *
 * `headSha` is required whenever reviews are present: without it no review can be bound to the
 * head, and ignoring them would drop blocks (fail open), so the verdict is `missing-head-sha`.
 *
 * DEPENDENCY: imports ./role-review-verdicts.mjs. t1-approval-guard.yml and ci.yml's merge_group
 * arm copy this file into a temp dir from main's tip, so they must copy role-review-verdicts.mjs
 * into the SAME dir (both do, from the same base tip).
 */

import { latestRoleVerdicts } from './role-review-verdicts.mjs';

const UNPARSEABLE_ROLE = '(unparseable)';

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

// Merge key for one verdict slot. Role names are normalized so `Tech Lead` from a review and
// `TechLead` from a comment are one role; the fail-closed `(unparseable)` latch and `@<login>`
// human slots keep their own keys, so no real role can collide with (and so supersede) them.
function slotKey(role) {
  if (role === UNPARSEABLE_ROLE || role.startsWith('@')) return role;
  return normalizeRole(role);
}

// Latest-wins merge across sources. Taking the max per role of each source's own latest verdict
// equals the latest over one merged timeline. A tie goes to the block (fail closed).
function mergeVerdict(slots, role, verdict) {
  const key = slotKey(role);
  const prev = slots.get(key);
  const atMs = new Date(verdict.at).getTime();
  if (prev) {
    const prevMs = new Date(prev.at).getTime();
    if (prevMs > atMs) return;
    if (prevMs === atMs && prev.kind === 'changes_requested') return;
  }
  slots.set(key, { role, kind: verdict.kind, at: verdict.at, source: verdict.source });
}

// A human (non-reviewer-App) review's verdict is its GitHub state: no role tag exists to read.
// Per LOGIN, so the shared-account overwrite (#4686) that rules state out for the App can't apply.
function humanReviewVerdict(state) {
  const s = String(state ?? '').toUpperCase();
  // lint:review-state-ok: a human review has no role tag; its state is tracked per human login (never across roles), and only to BLOCK or clear that login's own block, never to satisfy the gate (t/116)
  if (s === 'CHANGES_REQUESTED') return 'changes_requested';
  if (s === 'APPROVED' || s === 'DISMISSED') return 'cleared';
  return null; // COMMENTED / PENDING: no verdict, does not clear an earlier request
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
  const comments = approvalComments || [];
  if (reviews.length > 0 && !headSha) {
    return { pass: false, tier, reason: 'missing-head-sha' };
  }

  const ownerSlug = ownerSlugFromBranch(headRefName);
  const slots = new Map();
  const add = (map, source, { strictOnly = false } = {}) => {
    for (const [role, v] of map) {
      if (strictOnly && v.unparsed) continue;
      mergeVerdict(slots, role, { kind: v.kind, at: v.at, source });
    }
  };

  // 1. Reviewer App: reviews at the head and comments after the push, full grammar.
  const appReviews = reviewerAppLogin ? reviews.filter((r) => r?.login === reviewerAppLogin) : [];
  add(latestRoleVerdicts({ reviews: appReviews, comments, reviewerAppLogin, headSha, lastPushAt }), 'app');

  // 1b. An App review whose state requests changes but whose body doesn't parse as a request:
  // state may add a block, never an approval. Latched under its own key for this head.
  for (const r of appReviews) {
    if (r?.commitId !== headSha || !r?.submittedAt) continue;
    if (humanReviewVerdict(r?.state) !== 'changes_requested') continue;
    const own = latestRoleVerdicts({ reviews: [r], comments: [], reviewerAppLogin, headSha, lastPushAt: null });
    if ([...own.values()].some((v) => v.kind === 'changes_requested')) continue; // the body already blocks
    mergeVerdict(slots, `@${reviewerAppLogin}:state:${r.submittedAt}`, { kind: 'changes_requested', at: r.submittedAt, source: 'app-state' });
  }

  // 2. Other-login comments (the legacy shared-login path): strict grammar only, per login.
  const NO_LOGIN = '(no-login)';
  const otherCommentLogins = new Set(comments.map((c) => c?.login ?? NO_LOGIN).filter((l) => l !== reviewerAppLogin));
  for (const login of otherCommentLogins) {
    const own = comments.filter((c) => (c?.login ?? NO_LOGIN) === login).map((c) => ({ ...c, login }));
    add(latestRoleVerdicts({ reviews: [], comments: own, reviewerAppLogin: login, headSha, lastPushAt }), 'comment', { strictOnly: true });
  }

  // 3. Human / other-login reviews at the head: state per login, can block, never satisfies.
  const humanLatest = new Map();
  for (const r of reviews) {
    if (!r?.login || r.login === reviewerAppLogin) continue;
    if (r.commitId !== headSha || !r.submittedAt) continue; // old head: ignored
    const kind = humanReviewVerdict(r.state);
    if (!kind) continue;
    const prev = humanLatest.get(r.login);
    if (!prev || new Date(r.submittedAt).getTime() >= new Date(prev.at).getTime()) {
      humanLatest.set(r.login, { kind, at: r.submittedAt });
    }
  }
  for (const [login, v] of humanLatest) {
    if (v.kind === 'changes_requested') mergeVerdict(slots, `@${login}`, { kind: v.kind, at: v.at, source: 'human-review' });
  }

  const blockers = [...slots.values()].filter((s) => s.kind === 'changes_requested');
  if (blockers.length > 0) {
    return {
      pass: false, tier, reason: 'changes-requested-at-head',
      blockers: blockers.map((b) => ({ role: b.role, at: b.at, source: b.source })),
    };
  }

  const approvals = [...slots.values()]
    .filter((s) => s.kind === 'approved' && !s.role.startsWith('@'))
    .filter((s) => !(ownerSlug && normalizeRole(s.role).startsWith(ownerSlug))) // self-approval by the owning role
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  if (approvals.length > 0) {
    return { pass: true, tier, reason: 'approved-after-push', approver: { role: approvals[0].role, at: approvals[0].at } };
  }
  return { pass: false, tier, reason: 'no-post-push-approval' };
}
