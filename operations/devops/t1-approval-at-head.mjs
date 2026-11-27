// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// The ONE approval-at-head check for every enqueue path (t/73, Orca t/4820).
//
// WHY A SHARED MODULE: enqueue-pr.mjs (t/4939) refuses to arm a T1 PR unless the latest
// non-skipped `github-actions` `t1-approval-guard` run at the head concluded `success`. The T1
// enqueue sweep (t1-enqueue-sweep.mjs) must apply exactly that check before it selects a PR --
// the TL's condition was "one approval check, no reimplementation". This logic used to be inline
// in enqueue-pr.mjs; it moved here unchanged so both callers import the same code.
// enqueue-pr.mjs re-exports every name below, so its own callers and tests are unaffected.
//
// Split, as everywhere in operations/devops: `fetchGuardRun` is the only impure call (one
// check-runs read); `approvalAtHeadVerdict` / `classifyT1GuardForEnqueue` are pure.

//
// t/534 PART A (TL p/9#482, Security t/534#5, t/537): THE DECISION NO LONGER READS A CHECK RUN.
// A PR-side workflow can post a green `t1-approval-guard` run with the same name, app slug and
// external_id as ours, so no check run is evidence of an approval. Enqueue and the sweeps now
// read the PR, its commits, comments and reviews from the API at the head (fetchApprovalInputs)
// and call the guard's own predicate on them (approvalFromApiVerdict). Security's binding
// conditions:
//   1. an approval counts only from a reviewer-App REVIEW bound to the head by commit_id. Comments
//      never approve (Lead t/534, mirroring merge-approval-verdict.mjs in #5470): a comment is bound
//      to the head only through `lastPushAt`, the head commit's committer date, which the PR author
//      sets (git commit --date), so a back-dated push would make an old App approval comment count
//      for new code. lastPushAt is therefore far in the future: every comment is "before the push",
//      so an App comment can still block (and clear its own role's block) but never approve;
//   2. every API read fails closed (any error, a non-array page, a head that moved, a commit list
//      the API may have cut short);
//   3. the `t1-approval-guard` row on the PR is display only and is never an input.
// WHO CAN BLOCK: the reviewer App (reviews and comments) and reviews from OWNER / MEMBER /
// COLLABORATOR accounts. On a public repo anyone else can comment or review, so they are dropped.
// T2 needs the same App review as T1 (TL ruling); T0 is exempt.
// The row helpers below (classifyT1GuardForEnqueue, pickAuthoritativeGuardRun, fetchGuardRun,
// approvalAtHeadVerdict) stay for display and for their existing tests; no enqueue path calls them.

import { execFileSync } from 'node:child_process';
import { dependabotExemption, evaluateT1ApprovalGuard } from './t1-approval-guard-predicate.mjs';

function gh(args, options = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
}

// REST login of the reviewer App (what reviews and comments carry). Same value as
// gate-file-change.mjs's REVIEWER_APP_REST_LOGIN and t1-approval-guard.yml's REVIEWER_APP_LOGIN.
export const REVIEWER_APP_REST_LOGIN = 'ai-triad-reviewer-jpsnover[bot]';
// The only accounts whose comments are read at all (to block, never to approve). Exactly the reviewer
// App: the shared `jpsnover` login and every other account are dropped (Security t/534#5).
export const COMMENT_APPROVER_ALLOWLIST = Object.freeze([REVIEWER_APP_REST_LOGIN]);
// Review author associations whose CHANGES_REQUESTED blocks. Their approvals never count: the
// predicate counts only the reviewer App's reviews as approvals. Same list as merge-approval (#5470).
export const BLOCKING_REVIEW_ASSOCIATIONS = Object.freeze(['OWNER', 'MEMBER', 'COLLABORATOR']);
// Later than any real push, so no comment is "after the push" (see condition 1 above).
export const FAR_FUTURE_PUSH = '9999-12-31T23:59:59Z';
// GET /pulls/{n}/commits returns at most 250 commits; past that the last commit is not the head's.
export const PR_COMMITS_API_CAP = 250;

/**
 * Reads everything the approval decision needs, from the API, at the PR's current head. Never
 * throws: any failure returns `{ error }` and the caller refuses (Security condition 2).
 * `expectedHeadSha` (the head the caller is about to enqueue) must equal the PR's head as read here.
 */
export function fetchApprovalInputs(repo, prNumber, expectedHeadSha, ghFn = gh) {
  try {
    const pr = JSON.parse(ghFn(['api', '-X', 'GET', `repos/${repo}/pulls/${prNumber}`]));
    if (!pr || typeof pr.head?.sha !== 'string' || !pr.head.sha) throw new Error('the PR read has no head SHA');
    if (expectedHeadSha && pr.head.sha !== expectedHeadSha) {
      throw new Error(`the head moved: expected ${expectedHeadSha}, the API reads ${pr.head.sha}`);
    }
    const pages = (path) => {
      const out = JSON.parse(ghFn(['api', '-X', 'GET', '--paginate', '--slurp', path]));
      if (!Array.isArray(out) || !out.every(Array.isArray)) throw new Error(`${path} did not return a list of pages`);
      return out.flat();
    };
    const commits = pages(`repos/${repo}/pulls/${prNumber}/commits?per_page=100`);
    if (!Number.isInteger(pr.commits) || pr.commits >= PR_COMMITS_API_CAP || commits.length !== pr.commits) {
      throw new Error(`the commit list may be cut short (listed ${commits.length}, the PR reports ${pr.commits}, API cap ${PR_COMMITS_API_CAP})`);
    }
    // t/776: the Dependabot exemption also reads the changed paths (a count mismatch is caught there).
    const files = pages(`repos/${repo}/pulls/${prNumber}/files?per_page=100`).map((f) => ({ filename: f.filename, previous_filename: f.previous_filename, status: f.status, patch: f.patch }));
    const comments = pages(`repos/${repo}/issues/${prNumber}/comments?per_page=100`);
    const reviews = pages(`repos/${repo}/pulls/${prNumber}/reviews?per_page=100`);
    return { pr, commits, files, comments, reviews, error: null };
  } catch (err) {
    return { error: err };
  }
}

/**
 * PURE. The predicate's inputs from the API reads. Mirrors merge-approval-verdict.mjs (#5470):
 * comments only from COMMENT_APPROVER_ALLOWLIST; reviews only from the reviewer App or a
 * BLOCKING_REVIEW_ASSOCIATIONS account; lastPushAt FAR_FUTURE_PUSH, so no comment approves.
 * `commits` is still read and checked by fetchApprovalInputs (a cut-short list fails closed), but
 * its committer date is deliberately not used: the PR author controls it.
 */
export function toPredicateInputs({ pr, comments, reviews, commits, files }) {
  return {
    // t/751: the facts the Dependabot exemption reads (dependabotExemption), for a PR with no Tier line.
    dependabot: { authorLogin: pr.user?.login ?? null, headRepo: pr.head?.repo?.full_name ?? null, baseRepo: pr.base?.repo?.full_name ?? null, commits, commitsTotal: pr.commits, files, filesTotal: pr.changed_files },
    body: pr.body ?? '',
    headRefName: pr.head.ref,
    headSha: pr.head.sha,
    lastPushAt: FAR_FUTURE_PUSH,
    approvalComments: comments
      .filter((c) => COMMENT_APPROVER_ALLOWLIST.includes(c?.user?.login))
      .map((c) => ({ body: c.body, createdAt: c.created_at, updatedAt: c.updated_at, login: c.user?.login })),
    botReviews: reviews
      .filter((r) => r?.user?.login === REVIEWER_APP_REST_LOGIN || BLOCKING_REVIEW_ASSOCIATIONS.includes(r?.author_association))
      .map((r) => ({ state: r.state, submittedAt: r.submitted_at, login: r.user?.login, body: r.body, commitId: r.commit_id })),
  };
}

/** PURE. The body the predicate reads: it acts only on a `Tier: T1` first line, so T2 is rewritten to it. */
function bodyAsT1(body, tier) {
  if (tier === 'T1') return body;
  if (tier === 'T2') return String(body).replace(/^(\s*Tier:\s*)T2\b/i, '$1T1');
  return body; // no (or unreadable) Tier line: the predicate itself judges it (t/751: T1 unless Dependabot-exempt)
}

/**
 * PURE. The approval verdict every enqueue path acts on (t/534 part A). Returns `{ allow, reason,
 * warn, approver?, detail? }`. `reason`:
 *   'draft' | 'tier_exempt' (T0 only) | 'approved_at_head' (allow) |
 *   'approval_lookup_error' | 'approval_cannot_evaluate' | 'changes_requested' | 'no_approval' |
 *   'missing_head_sha' | 'approval_<other predicate reason>'.
 * One predicate run on the filtered inputs (toPredicateInputs): an approval counts only from a
 * reviewer-App review bound to the head; the App and write-level reviewers can block. T1 and T2
 * both need the approval; an undeclared tier is evaluated as T1 (fail closed). No check run is read.
 */
export function approvalFromApiVerdict({ tier, isDraft, headSha, inputs, tierCheckDisagreesOnT0 = false, evaluate = evaluateT1ApprovalGuard }) {
  if (isDraft) return { allow: false, reason: 'draft', warn: null };
  if (tier === 'T0') {
    const warn = tier === 'T0' && tierCheckDisagreesOnT0
      ? "tier-check's completed run at this head disagrees with the declared Tier: T0 -- review " +
        'manually; enqueue-pr does not block on this signal yet (t/4939 follow-up).'
      : null;
    return { allow: true, reason: 'tier_exempt', warn };
  }
  if (!inputs || inputs.error) {
    return { allow: false, reason: 'approval_lookup_error', warn: null, detail: String(inputs?.error?.message ?? inputs?.error ?? 'no API read') };
  }
  let base;
  try {
    base = toPredicateInputs(inputs);
  } catch (err) {
    return { allow: false, reason: 'approval_lookup_error', warn: null, detail: `unreadable API data (${err.message ?? err})` };
  }
  // t/751 (TL p/9#701 item 5): a PR with no Tier line is refused outright, whatever its approvals,
  // unless the Dependabot exemption holds (every commit verified, from an allowlisted bot). The
  // reason word is 'no_tier_line'; the sweeps read it as a policy refusal (classifyEnqueueFailure).
  if (tier === null || tier === undefined) {
    const ex = dependabotExemption(base.dependabot);
    return ex.exempt
      ? { allow: true, reason: 'dependabot_exempt', warn: null, detail: ex.reason }
      : { allow: false, reason: 'no_tier_line', warn: null, detail: `no Tier line: treated as T1, and a PR with no Tier line is not enqueued (${ex.reason}); add \`Tier: T0\`, \`T1\` or \`T2\` as the first line of the body` };
  }
  if (base.headSha !== headSha) return { allow: false, reason: 'approval_lookup_error', warn: null, detail: `the API read is for ${base.headSha}, not ${headSha}` };
  let r;
  try {
    r = evaluate({ ...base, body: bodyAsT1(base.body, tier), reviewerAppLogin: REVIEWER_APP_REST_LOGIN });
  } catch (err) {
    return { allow: false, reason: 'approval_cannot_evaluate', warn: null, detail: String(err?.message ?? err) };
  }
  if (!r?.pass || r.reason !== 'approved-after-push') {
    const reason = r?.reason === 'changes-requested-outstanding' ? 'changes_requested'
      : r?.reason === 'no-post-push-approval' ? 'no_approval'
        : r?.reason === 'missing-head-sha' ? 'missing_head_sha'
          : `approval_${String(r?.reason ?? 'unknown').replace(/-/g, '_')}`;
    const detail = r?.blockers ? JSON.stringify(r.blockers)
      : reason === 'no_approval' ? 'no reviewer-App approval review bound to this head from a role other than the branch owner (comments never approve)'
        : (r?.summary ?? null);
    return { allow: false, reason, warn: null, detail };
  }
  return { allow: true, reason: 'approved_at_head', warn: null, approver: r.approver };
}

/**
 * PURE. Decides whether enqueue-pr.mjs may arm/enqueue a PR, given its declared tier, draft
 * state, and the latest `t1-approval-guard` check run at the head SHA.
 *
 * `guardRun` is `{ status, conclusion, app: { slug } }` or `null`/missing if no such run
 * exists at the head. A run from any app other than `github-actions` is ignored (should-fix
 * 2, Quality t/4939#2) -- treated exactly like a missing run, never a green light.
 *
 * `tierCheckDisagreesOnT0` (should-fix 3, WARN-only arm, Quality t/4939#2): true when the PR
 * declares `Tier: T0` but `tier-check`'s own completed run at the head concluded `failure`.
 * `tier-check`'s verdict isn't trusted enough yet to BLOCK on (t/4939#1), so this never
 * changes `allow` -- it only surfaces a `warn` string for the caller to log, and the
 * blocking version of should-fix 3 is a named follow-up, not done here.
 *
 * Returns `{ allow, reason, warn }`. `reason` is one of: 'draft', 'guard_failure',
 * 'guard_success', 'guard_missing', 'guard_in_progress', 'guard_queued',
 * 'guard_<other-conclusion>', 'tier_exempt'.
 */
export function classifyT1GuardForEnqueue({ tier, isDraft, guardRun, tierCheckDisagreesOnT0 = false }) {
  if (isDraft) return { allow: false, reason: 'draft', warn: null };

  const effRun = guardRun && guardRun.app?.slug === 'github-actions' ? guardRun : null;
  const conclusion = effRun && effRun.status === 'completed' ? effRun.conclusion : null;

  // The guard's own failing verdict blocks regardless of declared tier -- it's the guard
  // speaking for itself, not a tier-gated rule.
  if (conclusion === 'failure') return { allow: false, reason: 'guard_failure', warn: null };

  const knownTier = tier === 'T0' || tier === 'T1' || tier === 'T2';
  // An unparseable tier is fail-closed: treated exactly like a declared T1 (Quality t/4939#2).
  const treatAsT1 = !knownTier || tier === 'T1';

  if (treatAsT1) {
    if (conclusion === 'success') return { allow: true, reason: 'guard_success', warn: null };
    const reason = !effRun
      ? 'guard_missing'
      : effRun.status === 'in_progress'
        ? 'guard_in_progress'
        : effRun.status === 'queued'
          ? 'guard_queued'
          : `guard_${conclusion ?? 'unknown'}`;
    return { allow: false, reason, warn: null };
  }

  // T0 or T2: the guard isn't required here (T0 has no approval rule; T2 is gated by
  // consult-hold elsewhere). should-fix 3's WARN-only arm: flag disagreement, never block.
  const warn = tier === 'T0' && tierCheckDisagreesOnT0
    ? "tier-check's completed run at this head disagrees with the declared Tier: T0 -- review " +
      'manually; enqueue-pr does not block on this signal yet (t/4939 follow-up).'
    : null;
  return { allow: true, reason: 'tier_exempt', warn };
}

/**
 * PURE. The approval-at-head verdict both enqueue paths act on: `fetchGuardRun`'s result fed
 * through `classifyT1GuardForEnqueue`. A failed lookup is its own refusal reason
 * (`guard_lookup_error`) -- never a pass. `guard` is `fetchGuardRun`'s return value
 * (`{ run, lookupError }`); a missing `guard` also counts as a lookup error (fail closed).
 */
export function approvalAtHeadVerdict({ tier, isDraft, guard, tierCheckDisagreesOnT0 = false }) {
  if (!guard || guard.lookupError) return { allow: false, reason: 'guard_lookup_error', warn: null };
  return classifyT1GuardForEnqueue({ tier, isDraft, guardRun: guard.run, tierCheckDisagreesOnT0 });
}

/**
 * PURE. Picks the check-run `fetchGuardRun` should treat as authoritative, from every
 * `github-actions`-app run named `t1-approval-guard` at the head.
 *
 * Live bug (#4694 enqueue refusal, 2026-11-09): ci.yml also has a job named `t1-approval-guard`
 * co-located for the merge_group queue re-check (t/4939#4) -- `if: github.event_name ==
 * 'merge_group'`. On an ordinary `pull_request` run that job's `if:` is false, so it legitimately
 * reports `skipped`, UNDER THE SAME CHECK-RUN NAME as the real PR-side gate
 * (`t1-approval-guard.yml`). Picking "latest by started_at" is a RACE: ci.yml is a large,
 * many-job workflow that often finishes its skip later than the single-job standalone gate
 * finishes its real evaluation, so the meaningless skip can shadow a genuine `success` purely by
 * timing. A `skipped` conclusion carries no information (it never evaluated anything) and must
 * never be allowed to outrank an actual evaluation of the same check name, regardless of which
 * finished later. Prefer the latest NON-skipped run; fall back to the latest skipped run only
 * when nothing else exists (still correctly fail-closed -- the real gate genuinely never ran).
 */
export function pickAuthoritativeGuardRun(runs) {
  if (!runs?.length) return null;
  const sorted = [...runs].sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
  const nonSkipped = sorted.filter((r) => r.conclusion !== 'skipped');
  return nonSkipped.length ? nonSkipped[0] : sorted[0];
}

/**
 * Latest `t1-approval-guard` check run at `headSha` from the `github-actions` App, or `null`
 * on a lookup error (caller refuses on null+error). Filters by `app.slug` BEFORE picking the
 * latest run (Quality should-fix, p/780#25) -- filtering after would let a newer run from a
 * different app hide an older, still-current `github-actions` run.
 */
export function fetchGuardRun(repo, headSha, ghFn = gh) {
  try {
    // t/4939 live bug (Lead, p/648#361): any `-F`/`-f` flag makes `gh api` default to POST,
    // even on a GET-only route -- this 404s without `-X GET`. Confirmed live on #4679's own
    // head: identical request, `-X GET` added, returns total_count: 1.
    const out = JSON.parse(ghFn(['api', '-X', 'GET', `repos/${repo}/commits/${headSha}/check-runs`, '-F', 'check_name=t1-approval-guard']));
    const runs = (out.check_runs ?? []).filter((r) => r.app?.slug === 'github-actions');
    if (!runs.length) return { run: null, lookupError: false };
    return { run: pickAuthoritativeGuardRun(runs), lookupError: false };
  } catch (err) {
    return { run: null, lookupError: true, error: err };
  }
}
