// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Enqueue T1 PRs once a valid approval has landed at the current head (t/73, Orca t/4820).
//
// SHIPS REPORT-ONLY (Second Opinion's conditions on #4795, 2026-11-15): AS MERGED IT NEITHER
// ENQUEUES NOR COMMENTS. Enqueueing needs `--enqueue` (`sweep`'s `enqueueEnabled`) and posting a
// guard nudge needs `--nudge` (`nudgeEnabled`); both default to false, and enqueue-sweep.yml
// passes neither: its T1 step has the literals `T1_ENQUEUE: 'off'` and `T1_NUDGE: 'off'`. Until
// those are flipped in reviewed commits, the sweep only selects and logs: every skip reason,
// `[nudge off] would ask t1-approval-guard to re-run for #N` and `[enqueue off] would enqueue #N`.
// `--nudge-pr=<N>` allows the nudge for one PR only (the workflow's dispatch-only `nudge_pr`
// input), to watch the first live nudge on a throwaway PR; it cannot enqueue.
// The rules below describe the selection, and the enqueue once it is on.
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
//   2. approvalFromApiVerdict (t1-approval-at-head.mjs, the SAME check enqueue-pr.mjs refuses
//      on) is `approved_at_head` for the PR's reviews, comments and commits read from the API at
//      this head by fetchApprovalInputs (t/534 part A: no check run is read, so a forged green
//      `t1-approval-guard` row changes nothing; this replaces the old rules 2 and 3, which read
//      the guard run and its summary);
//   3. (folded into 2);
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
//   GH_TOKEN=<app token> node operations/devops/t1-enqueue-sweep.mjs <owner>/<repo> [--dry-run] [--enqueue] [--nudge] [--nudge-pr=<N>]
//     (no flag: report only; --nudge: post guard nudges; --nudge-pr=<N>: nudge that PR only;
//      --enqueue: enqueue; --dry-run: report only, wins over all of them)

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractTier } from './tier-check-predicate.mjs';
import { parseTier, ownerSlugFromBranch, normalizeRole } from './t1-approval-guard-predicate.mjs';
import { approvalFromApiVerdict, fetchApprovalInputs } from './t1-approval-at-head.mjs';
import { latestRoleVerdicts } from './role-review-verdicts.mjs';
import { sharedSkipReason, listOpenPRs, enqueueOne, REVIEWER_APP_LOGIN } from './t0-enqueue-sweep.mjs';

// The exact summary t1-approval-guard.yml posts on a real T1 pass (`okSummary`).
export const GUARD_APPROVED_SUMMARY = 'approved after the latest push';

// Self-heal for a guard that never evaluated an approved head. On 2026-11-11 GitHub left 14
// t1-approval-guard runs (88 runs repo-wide) in `queued` for good; the approvals that triggered
// them never got a verdict, so #5120, #5121, #4950, #5101 and #5096 sat approved and green for up
// to four days until a comment re-ran the guard. `guard_missing` is no run at the head;
// `guard_skipped` is only ci.yml's merge_group placeholder, which is skipped on every PR run.
// A real `failure`, an `in_progress` or a `queued` run is never nudged.
export const GUARD_NEVER_RAN = ['guard_missing', 'guard_skipped'];
export const GUARD_NUDGE_MARKER = '<!-- t1-sweep-guard-rerun:';

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

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
 * carries `approvalInputs`: fetchApprovalInputs's API read at its head, attached by the shim
 * (t/534 part A). A PR without it fails closed (treated as a lookup error). No check run is read:
 * the decision is approvalFromApiVerdict, the same one enqueue-pr.mjs refuses on.
 */
export function selectT1Candidates(prs) {
  const enqueue = [];
  const skip = [];
  for (const pr of prs) {
    let reason = sharedSkipReason(pr, { declares: declaresT1, tierName: 'T1' });
    if (!reason) {
      const v = approvalFromApiVerdict({ tier: extractTier(pr.body), isDraft: pr.isDraft, headSha: pr.headRefOid, inputs: pr.approvalInputs });
      if (v.reason === 'approval_lookup_error') {
        reason = `WARN: could not read the approval at the head (${v.detail}) -- failing closed (the next sweep retries)`;
      } else if (!v.allow || v.reason !== 'approved_at_head') {
        reason = `approval at head is ${v.reason}`;
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
 * Asks t1-approval-guard to evaluate a head it never evaluated, by posting one comment (the
 * guard runs on `issue_comment`; the sweep's App token triggers workflows, GITHUB_TOKEN would
 * not). At most one comment per head, found by its marker. Best-effort: a failed post only
 * WARNs, since the PR is skipped either way and the next sweep tries again. Returns 'posted',
 * 'already' (a nudge for this head exists; the WARN says how long ago) or 'failed'.
 */
export function postGuardNudge(repo, number, { headRefOid }, { ghFn = gh, nowMs = Date.now() } = {}) {
  const marker = `${GUARD_NUDGE_MARKER}${headRefOid} -->`;
  try {
    const comments = JSON.parse(ghFn(['api', `repos/${repo}/issues/${number}/comments?per_page=100`, '--jq', '[.[] | {body, created_at}]']));
    const prior = comments.find((c) => (c.body ?? '').includes(marker));
    if (prior) {
      const minutes = Math.round((nowMs - Date.parse(prior.created_at)) / 60000);
      console.log(`WARN: #${number}: t1-approval-guard was asked to re-run for ${headRefOid.slice(0, 9)} ${minutes}m ago and still has no verdict there; ` +
        'not asking again (post any comment on the PR to re-run it by hand)');
      return 'already';
    }
    const body = [
      `**T1 sweep (t/73):** \`t1-approval-guard\` has no verdict at this head (\`${headRefOid.slice(0, 9)}\`), although a reviewer approval is recorded on it and the required checks are green. ` +
        'Its run for that approval was most likely lost. This comment makes the guard run again; the sweep enqueues the PR once it reports success. No action is needed.',
      marker,
    ].join('\n');
    ghFn(['api', `repos/${repo}/issues/${number}/comments`, '-f', `body=${body}`]);
    console.log(`commented on #${number}: asked t1-approval-guard to re-run at ${headRefOid.slice(0, 9)}`);
    return 'posted';
  } catch (err) {
    console.log(`WARN: #${number}: could not post the guard re-run comment (${err.message ?? err}); the PR is still skipped`);
    return 'failed';
  }
}

/**
 * PURE. The CLI's arguments: `<owner>/<repo> [--dry-run] [--enqueue] [--nudge] [--nudge-pr=<N>]`.
 * Each gate is on only with its own exact flag; `--nudge-pr` takes a positive integer or is ignored.
 */
export function parseCliArgs(argv) {
  const args = argv ?? [];
  const nudgePr = args.map((a) => /^--nudge-pr=([1-9]\d{0,8})$/.exec(a)).find(Boolean);
  return {
    repo: args.find((a) => !a.startsWith('--')) ?? null,
    dryRun: args.includes('--dry-run'),
    enqueueEnabled: args.includes('--enqueue'),
    nudgeEnabled: args.includes('--nudge'),
    nudgeOnlyPr: nudgePr ? Number(nudgePr[1]) : null,
  };
}

/**
 * One pass. `deps` replaces the listing, the guard lookup and enqueueOne's own deps in tests.
 * Returns the outcome per enqueued PR number.
 *
 * ONE GATE, default FALSE, on only for the boolean `true`, so a caller that forgets it (or passes
 * a string) cannot enqueue: `enqueueEnabled` off -> a selected PR is only logged as
 * `[enqueue off] would enqueue`: no live re-read, no disarm and no enqueue call. `dryRun` wins.
 *
 * GUARD NUDGES ARE RETIRED (t/534 part A). They asked t1-approval-guard to re-run on an approved
 * head whose check run was missing, because that run decided the enqueue. The decision now reads
 * the reviews from the API, so a missing run no longer blocks anything and nothing is nudged.
 * `nudgeEnabled` / `nudgeOnlyPr` (and the CLI's --nudge / --nudge-pr, still passed by
 * enqueue-sweep.yml) are accepted and ignored; postGuardNudge is no longer called. Removing them
 * with the workflow flags is a follow-up.
 */
export async function sweep(repo, { dryRun = false, enqueueEnabled = false, nudgeEnabled = false, nudgeOnlyPr = null, deps = {} } = {}) {
  const { list = listOpenPRs, fetchApproval = fetchApprovalInputs, enqueueDeps } = deps;
  // Only the boolean: a stray 'off' or 'false' string must not enqueue.
  const enqueueOn = enqueueEnabled === true;
  if (!dryRun) {
    console.log(`T1 sweep: enqueue is ${enqueueOn ? 'ON (--enqueue)' : 'OFF (no --enqueue)'}; guard nudges are retired (t/534)` +
      `${nudgeEnabled === true || nudgeOnlyPr != null ? ', so --nudge / --nudge-pr do nothing' : ''}.` +
      (enqueueOn ? '' : ' This run only reports.'));
  }
  const prs = list(repo);
  for (const pr of prs) {
    if (!declaresT1(pr.body)) continue;
    // t/534 part A: the approval is read from the API at the head, never from the guard's check run.
    pr.approvalInputs = fetchApproval(repo, pr.number, pr.headRefOid);
    if (pr.approvalInputs?.error) {
      console.warn(`WARN: could not read the approval for #${pr.number} at ${pr.headRefOid} ` +
        `(${pr.approvalInputs.error?.message ?? 'API error'}); skipping it this pass.`);
    }
  }
  const { enqueue, skip } = selectT1Candidates(prs);
  for (const s of skip) {
    console.log(`skip #${s.number}: ${s.reason}`);
  }
  if (enqueue.length === 0) console.log('no T1 PRs to enqueue.');

  const outcomes = {};
  const failures = [];
  for (const pr of enqueue) {
    if (dryRun) { console.log(`[dry-run] would enqueue #${pr.number} at ${pr.headRefOid}`); continue; }
    if (!enqueueOn) { console.log(`[enqueue off] would enqueue #${pr.number} at ${pr.headRefOid}`); continue; }
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
  const { repo, dryRun, enqueueEnabled, nudgeEnabled, nudgeOnlyPr } = parseCliArgs(process.argv.slice(2));
  if (!repo) {
    console.error('Usage: node operations/devops/t1-enqueue-sweep.mjs <owner>/<repo> [--dry-run] [--enqueue] [--nudge] [--nudge-pr=<N>]');
    process.exit(1);
  }
  sweep(repo, { dryRun, enqueueEnabled, nudgeEnabled, nudgeOnlyPr }).then(
    () => {},
    (err) => { console.error(err.message ?? err); process.exit(1); },
  );
}
