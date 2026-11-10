// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Enqueue T1 PRs once a valid approval has landed at the current head (t/73, Orca t/4820).
//
// WHY: the sweep enqueued only Dependabot and T0 PRs. An approved, green T1 PR waited until a
// person or agent ran enqueue-pr.mjs by hand (#4725 waited 15 minutes after its guard success;
// with nobody watching, the wait is unbounded). Design: notes/design-t73-task7-t1-auto-enqueue.md,
// option A (a T1 arm in the existing App-token sweep, not in the guard's comment-triggered
// workflow).
//
// A PR is enqueued only when ALL of these hold:
//   1. sharedSkipReason (t0-enqueue-sweep.mjs) finds nothing, with the tier read by the guard's
//      own parseTier: same-repo, `Tier: T1`, base main, not draft, not queued, not Dependabot,
//      no consult-hold / joint-gv / no-auto-enqueue label, not manually dequeued, no conflict,
//      review data complete, no active changes-request, Design gate passed when user-facing,
//      and ci-gate / CodeQL Analysis / joint-gv-guard / consult-hold-guard all green;
//   2. approvalAtHeadVerdict (t1-approval-at-head.mjs, the SAME check enqueue-pr.mjs refuses
//      on) is `guard_success` for the guard run fetched at this head by the same fetchGuardRun;
//   3. that run's summary is `approved after the latest push` (never `not a T1 PR`);
//   4. HEAD-BOUND APPROVAL: a reviewer-App `Approved (<role>):` review whose commit is the
//      current head SHA, from a role other than the branch owner. The guard measures staleness
//      against the last commit's COMMITTER date, which is not push time: a commit made before an
//      approval and pushed after it still passes the guard. A review's commit binding cannot be
//      fooled that way. Comment approvals are not head-bound, so they never auto-enqueue (a
//      human can still enqueue such a PR by hand).
// No idle window: rule 4 already requires the approval to be on the head being enqueued.
//
// The enqueue itself goes through enqueueOne -> enqueuePR with `expectedHeadOid` pinned to the
// head checked here, so a push after selection is refused, and enqueuePR re-checks the guard.
//
// Pure core (`selectT1Candidates`) is unit-tested in t1-enqueue-sweep.test.mjs.
//
//   GH_TOKEN=<app token> node operations/devops/t1-enqueue-sweep.mjs <owner>/<repo> [--dry-run]

import { fileURLToPath } from 'node:url';
import { extractTier } from './tier-check-predicate.mjs';
import { parseTier, ownerSlugFromBranch, normalizeRole } from './t1-approval-guard-predicate.mjs';
import { approvalAtHeadVerdict, fetchGuardRun } from './t1-approval-at-head.mjs';
import { latestRoleVerdicts } from './role-review-verdicts.mjs';
import { sharedSkipReason, listOpenPRs, enqueueOne, REVIEWER_APP_LOGIN } from './t0-enqueue-sweep.mjs';

// The exact summary t1-approval-guard.yml posts on a real T1 pass (`okSummary`).
export const GUARD_APPROVED_SUMMARY = 'approved after the latest push';

/** PURE. True when the PR body declares Tier: T1, parsed exactly as t1-approval-guard parses it. */
export function declaresT1(body) {
  return parseTier(body) === 'T1';
}

/**
 * PURE. The role whose reviewer-App `Approved (<role>):` review is bound to `headRefOid`
 * (review commit === head) and is not the branch owner's own role, or null.
 */
export function headBoundApprover(pr) {
  const verdicts = latestRoleVerdicts({
    reviews: pr.reviews, comments: [], reviewerAppLogin: REVIEWER_APP_LOGIN, headSha: pr.headRefOid, lastPushAt: null,
  });
  const ownerSlug = ownerSlugFromBranch(pr.headRefName);
  for (const [role, v] of verdicts) {
    if (v.kind !== 'approved') continue;
    if (ownerSlug && normalizeRole(role).startsWith(ownerSlug)) continue; // self-approval
    return role;
  }
  return null;
}

/**
 * PURE. Splits open PRs into those to enqueue now and those to skip (with the reason). Each PR
 * carries `guard`: fetchGuardRun's result at its head (`{ run, lookupError }`), attached by the
 * shim. A PR without `guard` fails closed (treated as a lookup error).
 */
export function selectT1Candidates(prs) {
  const enqueue = [];
  const skip = [];
  for (const pr of prs) {
    let reason = sharedSkipReason(pr, { declares: declaresT1, tierName: 'T1' });
    if (!reason) {
      const v = approvalAtHeadVerdict({ tier: extractTier(pr.body), isDraft: pr.isDraft, guard: pr.guard });
      const summary = pr.guard?.run?.output?.summary ?? null;
      if (v.reason === 'guard_lookup_error') {
        reason = 'WARN: could not look up t1-approval-guard at the head -- failing closed (the next sweep retries)';
      } else if (!v.allow || v.reason !== 'guard_success') {
        reason = `t1-approval-guard at head is ${v.reason.replace(/^guard_/, '')}`;
      } else if (summary !== GUARD_APPROVED_SUMMARY) {
        reason = `t1-approval-guard summary is ${JSON.stringify(summary)}, not "${GUARD_APPROVED_SUMMARY}"`;
      } else if (!headBoundApprover(pr)) {
        reason = 'no reviewer-App approval review bound to the current head SHA (stale or comment-only approval)';
      }
    }
    if (reason) skip.push({ number: pr.number, reason });
    else enqueue.push({ number: pr.number, headRefOid: pr.headRefOid, armed: pr.autoMergeRequest != null });
  }
  return { enqueue, skip };
}

/**
 * One pass. `deps` replaces the listing, the guard lookup and enqueueOne's own deps in tests.
 * Returns the outcome per enqueued PR number.
 */
export async function sweep(repo, { dryRun = false, deps = {} } = {}) {
  const { list = listOpenPRs, fetchGuard = fetchGuardRun, enqueueDeps } = deps;
  const prs = list(repo);
  for (const pr of prs) {
    if (!declaresT1(pr.body)) continue;
    pr.guard = fetchGuard(repo, pr.headRefOid);
    if (pr.guard.lookupError) {
      console.warn(`WARN: could not look up t1-approval-guard for #${pr.number} at ${pr.headRefOid} ` +
        `(${pr.guard.error?.message ?? 'API error'}); skipping it this pass.`);
    }
  }
  const { enqueue, skip } = selectT1Candidates(prs);
  for (const s of skip) console.log(`skip #${s.number}: ${s.reason}`);
  if (enqueue.length === 0) console.log('no T1 PRs to enqueue.');

  const outcomes = {};
  const failures = [];
  for (const pr of enqueue) {
    if (dryRun) { console.log(`[dry-run] would enqueue #${pr.number} at ${pr.headRefOid}`); continue; }
    outcomes[pr.number] = await enqueueOne(repo, pr, { enqueueOpts: { expectedHeadOid: pr.headRefOid }, deps: enqueueDeps });
    if (outcomes[pr.number] === 'failed') failures.push(pr.number);
  }
  if (failures.length) {
    throw new Error(
      `t1-enqueue-sweep: failed to enqueue ${failures.map((n) => `#${n}`).join(', ')} on ${repo}.\n` +
      '  Goal:       land approved, green T1 PRs through the merge queue.\n' +
      '  Problem:    enqueue-pr.mjs could not get these PRs into the queue as the App.\n' +
      '  Location:   operations/devops/t1-enqueue-sweep.mjs (see the ::error:: lines above).\n' +
      "  Next steps: check each PR's mergeStateStatus; the next sweep retries automatically.",
    );
  }
  return outcomes;
}

const isCliEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCliEntry) {
  const repo = process.argv[2];
  if (!repo) {
    console.error('Usage: node operations/devops/t1-enqueue-sweep.mjs <owner>/<repo> [--dry-run]');
    process.exit(1);
  }
  sweep(repo, { dryRun: process.argv.includes('--dry-run') }).then(
    () => {},
    (err) => { console.error(err.message ?? err); process.exit(1); },
  );
}
