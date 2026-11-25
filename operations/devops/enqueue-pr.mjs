// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4740: wraps `gh pr merge --auto --squash --match-head-commit` with a read-back
// verification and a GraphQL fallback. The CLI form has been observed (t/4731#1, t/4740#1,
// two independent agents, two different failure shapes) to report "armed" while the PR
// never actually enters the merge queue, with no confirmed trigger condition yet. Rather
// than trust the CLI's own report, this always reads back `isInMergeQueue` /
// `mergeQueueEntry` over GraphQL, falls back to the `enablePullRequestAutoMerge` mutation
// (the one remedy confirmed to work directly) on a miss, and logs a WARN with enough detail
// to pin the trigger condition next time it happens.
//
// Pure core (`classifyEnqueueOutcome`) is unit-tested; the gh CLI / GraphQL calls are the
// impure shim, same split as merge-guard-reconcile.mjs.
//
// t/4768: while required checks are still running, GitHub keeps a PR armed
// (autoMergeRequest set) but not yet in the queue — it enters the queue once checks pass.
// That is a legitimate "armed and waiting" state, not a silent miss: it must not trigger the
// silent-miss WARN, the GraphQL fallback, or the "still not enqueued" error. Only the
// genuine absence of an autoMergeRequest after the CLI arm is the t/4731#1/t/4740#1 class
// this wrapper exists to catch.
//
//   node operations/devops/enqueue-pr.mjs <owner>/<repo> <prNumber> [--gate-change-review=<review id>]
//        [--budget-exempt-review=<review id>] [--by=<collaborator id>]
//
// t/556: before anything else, the wrapper refuses unless its running copy (this file,
// gate-file-change.mjs and every local module they import) is origin/main's
// (running-copy-current.mjs). A stale copy can lack a refusal entirely (t/537#40). Fail closed.
//
// t/564: right after the currency check, the team PR budget (pr-budget.mjs): a non-Dependabot PR
// past its creation day's budget, or waiting in the carryover pool with no free slot today, is
// refused unless a TL/Security `budget-exempt:` review at its head is named with
// --budget-exempt-review (logged as BUDGET-EXEMPT). Unreadable counts refuse. The CLI (never a
// library caller) pings the PR's owner once on an over-budget refusal (pr-budget-notify.mjs).
//
// t/537: a PR that changes a workflow or a gate script is refused at every tier unless a
// reviewer-App `Approved (Tech Lead):` or `Approved (Security):` review bound to the current head is
// named with --gate-change-review (gate-file-change.mjs). The sweeps never pass it, so they skip
// such PRs. Each use is logged as a GATE-CHANGE-OVERRIDE line.
//
// t/4939 (interim refusal, Quality-approved design + 3 should-fixes): #4648 merged with no
// approval and CHANGES_REQUESTED still active, because `t1-approval-guard` isn't a required
// status check yet (promotion is a separate T2 change, step 3 of t/4939). Until then, this
// wrapper refuses to arm/enqueue a T1 PR whose guard verdict isn't a clean `success` at the
// head, refuses any draft outright, and refuses on the guard's own `failure` verdict
// regardless of declared tier. It does NOT cover a direct `gh pr merge --auto` call -- the
// required-context promotion is the real fix for that. The sweeps (t0-, t1- and
// dependabot-enqueue-sweep) DO get this refusal, because they all enqueue through
// `enqueuePR()`, which runs it on every call (t/73 corrected this comment).
//
// t/73 (Orca t/4820): the approval-at-head check (`fetchGuardRun` + `approvalAtHeadVerdict` /
// `classifyT1GuardForEnqueue` + `pickAuthoritativeGuardRun`) moved unchanged to
// t1-approval-at-head.mjs so the T1 enqueue sweep imports the same code. It is re-exported
// below. `enqueuePR` also takes an optional `expectedHeadOid`: when set, it refuses unless the
// PR's head is still that SHA, so a sweep that checked the approval at one head never arms a
// newer one.
//
// t/534 part A (supersedes the check-run reading above): the T1 refusal no longer reads the
// `t1-approval-guard` check run, which a PR-side workflow can forge. enqueuePR reads the PR's
// commits, comments and reviews from the API at the head and runs the guard's predicate on them
// (t1-approval-at-head.mjs: fetchApprovalInputs, approvalFromApiVerdict). An approval counts only
// from a reviewer-App review bound to the head or an allowlisted commenter, never the shared login;
// every read fails closed.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractTier } from './tier-check-predicate.mjs';
import { fetchChangedFiles, fetchReview, gateFileChangeVerdict, gateFileRefusalMessage } from './gate-file-change.mjs';
import { checkRunningCopy, currencyOkLine, currencyRefusalMessage } from './running-copy-current.mjs';
import { budgetOkLine, budgetRefusalMessage, checkPrBudget } from './pr-budget.mjs';
import { pingBudgetRefusal } from './pr-budget-notify.mjs';
import {
  approvalAtHeadVerdict, approvalFromApiVerdict, classifyT1GuardForEnqueue, fetchApprovalInputs, fetchGuardRun, pickAuthoritativeGuardRun,
} from './t1-approval-at-head.mjs';

// The row helpers are re-exported for their existing callers and tests only; enqueuePR decides with
// fetchApprovalInputs + approvalFromApiVerdict and never reads a check run (t/534 part A).
export { approvalAtHeadVerdict, approvalFromApiVerdict, classifyT1GuardForEnqueue, fetchApprovalInputs, fetchGuardRun, pickAuthoritativeGuardRun };

/**
 * PURE. Classifies a queue-state read into one of five outcomes:
 *  - 'merged'         — the PR is MERGED now but was not before this run's merge call. On a repo
 *                       with no merge queue and allow_auto_merge=false, `gh pr merge --auto`
 *                       merges at once (t/4889, data#79/#80); that is success, not a silent miss.
 *  - 'already_merged' — MERGED, and it already was before this run (or the prior state is
 *                       unknown), so this run did not merge it (TL t/4889#3).
 *  - 'queued'        — genuinely in the merge queue.
 *  - 'armed_waiting' — auto-merge is armed (autoMergeRequest set) but the PR hasn't entered
 *                       the queue yet, because required checks on the head are still
 *                       pending (mergeStateStatus is typically BLOCKED or UNSTABLE here).
 *                       This is the normal "will queue once checks pass" state, not a miss.
 *  - 'not_armed'      — no autoMergeRequest recorded; the arm attempt genuinely did not take.
 * `before` is the read taken just before the merge call. Comparing states, not mergedAt against
 * the local clock, keeps clock skew from turning this run's merge into 'already_merged'.
 */
export function classifyEnqueueOutcome({ state, isInMergeQueue, mergeQueueEntry, autoMergeRequest }, { before } = {}) {
  if (state === 'MERGED') return { state: before && before.state !== 'MERGED' ? 'merged' : 'already_merged' };
  if (isInMergeQueue === true && mergeQueueEntry != null) return { state: 'queued' };
  if (autoMergeRequest != null) return { state: 'armed_waiting' };
  return { state: 'not_armed' };
}

/** PURE. Formats the WARN logged on a silent CLI miss, so the message shape is testable. */
export function formatSilentMissWarning({ repo, prNumber, cliOutput, priorAutoMergeRequest }) {
  return (
    `WARN: gh pr merge --auto --squash --match-head-commit silently failed to enqueue ` +
    `#${prNumber} on ${repo}. CLI output: ${JSON.stringify(cliOutput)}. ` +
    `Prior autoMergeRequest: ${JSON.stringify(priorAutoMergeRequest ?? null)}. ` +
    `Falling back to the enablePullRequestAutoMerge GraphQL mutation (t/4731#1, t/4740).`
  );
}

// t/4939 (Quality, p/780#25): `gh` is a module-level default so `enqueuePR`'s shim can be
// exercised with a fake CLI in tests -- a real `gh` call in a unit test is itself the bug
// class this file exists to prevent, and (as Quality demonstrated) moving the refusal check
// below `gh pr merge` would otherwise leave every existing test green. Every internal helper
// takes `ghFn` as its last parameter, defaulting to the real `gh`, and `enqueuePR` threads one
// override through all of them.
function gh(args, options = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', ...options });
}

function queryQueueState(repo, prNumber, ghFn = gh) {
  const [owner, name] = repo.split('/');
  const query =
    'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){' +
    'pullRequest(number:$number){state mergedAt mergeCommit{oid} isInMergeQueue mergeQueueEntry{position state} headRefOid ' +
    'mergeStateStatus autoMergeRequest{mergeMethod enabledAt enabledBy{login}}}}}';
  const out = JSON.parse(
    ghFn(['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${prNumber}`]),
  );
  return out.data.repository.pullRequest;
}

/**
 * PURE. Classifies a `gh api` failure so a live test (or a future caller) can tell a transient
 * platform blip from a real regression. TL condition (p/648#363, t/4939):
 *  - 'network_error' / 'server_error' (5xx): skip, don't fail -- a GitHub-side blip must never
 *    turn a CI gate red.
 *  - 'not_found' (404) / 'unknown' (anything else, including an unparseable response shape):
 *    fail -- this is exactly the class of regression that shipped silently (t/4939 incident).
 */
export function classifyGhApiError(err) {
  const msg = String(err?.stderr ?? err?.message ?? err ?? '');
  if (/HTTP 404/.test(msg)) return 'not_found';
  if (/HTTP 5\d\d/.test(msg)) return 'server_error';
  if (/could not resolve host|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network/i.test(msg)) return 'network_error';
  return 'unknown';
}

/**
 * Best-effort, never throws. `disagrees` is true when `tier-check`'s latest completed run at
 * `headSha` concluded `failure`. Mirrors `fetchGuardRun`'s `{ run, lookupError, error }` shape:
 * a failed lookup (network, 5xx, 404, bad JSON) returns `{ disagrees: false, lookupError: true,
 * error }` and logs a WARN, so a dead check is distinguishable from "tier-check agrees" (t/4950).
 * Non-blocking either way: this only feeds the T0 WARN-only arm of classifyT1GuardForEnqueue.
 */
export function tierCheckDisagreesAt(repo, headSha, ghFn = gh) {
  try {
    // t/4939: same -F-forces-POST trap as fetchGuardRun (t1-approval-at-head.mjs) -- needs -X GET.
    const out = JSON.parse(ghFn(['api', '-X', 'GET', `repos/${repo}/commits/${headSha}/check-runs`, '-F', 'check_name=tier-check']));
    const runs = (out.check_runs ?? []).filter((r) => r.app?.slug === 'github-actions' && r.status === 'completed');
    if (!runs.length) return { disagrees: false, lookupError: false };
    runs.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
    return { disagrees: runs[0].conclusion === 'failure', lookupError: false };
  } catch (err) {
    console.warn(
      `WARN: enqueue-pr could not look up tier-check's check run on ${repo} at ${headSha} ` +
      `(${err?.message ?? 'API error'}). Treating tier-check as unknown, not as agreeing; continuing (WARN-only arm).`,
    );
    return { disagrees: false, lookupError: true, error: err };
  }
}

function enqueueViaMutation(repo, prNumber, headSha, ghFn = gh) {
  const nodeId = ghFn(['pr', 'view', String(prNumber), '-R', repo, '--json', 'id', '-q', '.id']).trim();
  const mutation =
    'mutation($pullRequestId:ID!,$headSha:GitObjectID!){enablePullRequestAutoMerge(input:{' +
    'pullRequestId:$pullRequestId,mergeMethod:SQUASH,expectedHeadOid:$headSha}){pullRequest{autoMergeRequest{mergeMethod}}}}';
  ghFn(['api', 'graphql', '-f', `query=${mutation}`, '-f', `pullRequestId=${nodeId}`, '-f', `headSha=${headSha}`]);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Arms auto-merge on a PR and verifies it actually took — either by entering the queue
 * directly, or by leaving autoMergeRequest set so it enters once required checks pass
 * (t/4768). Falls back to the direct GraphQL mutation only on a genuine silent miss (no
 * autoMergeRequest at all). Throws (never silently returns ok:false) if even the fallback
 * doesn't result in the PR being queued or armed.
 */
export async function enqueuePR(repo, prNumber, { sleepMs = 5000, gh: ghFn = gh, expectedHeadOid = null, gateChangeReviewId = null, by = null, currency = checkRunningCopy, budget = checkPrBudget, budgetExemptReviewId = null } = {}) {
  // t/556: BEFORE ANY OTHER CHECK, refuse unless this running copy (this file, gate-file-change.mjs
  // and every local module they import) is origin/main's. A stale copy can lack a refusal entirely
  // (t/537#40). Fail closed: a failed fetch or read refuses. `currency` is injectable for tests only.
  const current = currency();
  if (!current?.ok) {
    throw Object.assign(new Error(currencyRefusalMessage(current ?? { reason: 'no_result', detail: 'the check returned nothing' })), {
      name: 'ActionableError', reason: current?.reason ?? 'no_result',
    });
  }
  console.log(currencyOkLine(current));

  // t/564: the team PR budget, before the gate-file check and any other PR read. Fail closed: a
  // check that throws or returns nothing refuses. `budget` is injectable for tests only.
  let bv;
  try {
    bv = budget(repo, prNumber, { gh: ghFn, exemptReviewId: budgetExemptReviewId, by });
  } catch (err) {
    bv = { allow: false, reason: 'budget_read_failed', detail: `the budget check threw: ${err?.message ?? err}` };
  }
  if (!bv?.allow) {
    const verdict = bv ?? { allow: false, reason: 'budget_read_failed', detail: 'the budget check returned nothing' };
    throw Object.assign(new Error(budgetRefusalMessage({ repo, prNumber, verdict })), {
      name: 'ActionableError', reason: verdict.reason, budget: verdict,
    });
  }
  if (bv.reason !== 'budget_exempt') console.log(budgetOkLine({ repo, prNumber, verdict: bv }));

  const prMeta = JSON.parse(ghFn(['pr', 'view', String(prNumber), '-R', repo, '--json', 'headRefOid,body,isDraft']));
  const headSha = prMeta.headRefOid;
  const tier = extractTier(prMeta.body);
  // t/564 (Second Opinion on #5473, C): the budget (and any budget-exempt review) was judged on the head
  // the budget check read. Refuse if the head this enqueue pins is a different one.
  if (bv.pr && bv.pr.headRefOid !== headSha) {
    const verdict = { allow: false, reason: 'budget_read_failed', today: bv.today, nextDayStart: bv.nextDayStart,
      detail: `the head moved between the budget check (${String(bv.pr.headRefOid).slice(0, 9)}) and the enqueue read (${String(headSha).slice(0, 9)}); rerun` };
    throw Object.assign(new Error(budgetRefusalMessage({ repo, prNumber, verdict })), { name: 'ActionableError', reason: verdict.reason, budget: verdict });
  }

  // t/73: a caller that verified the approval at a specific head pins the enqueue to it. Both
  // arming paths below already pass `headSha` (`--match-head-commit`, `expectedHeadOid`), so
  // refusing here when the head moved keeps them pinned to the APPROVED head, not just the
  // current one.
  if (expectedHeadOid && headSha !== expectedHeadOid) {
    throw new Error(
      `enqueue-pr: refusing #${prNumber} on ${repo} -- head moved from ${expectedHeadOid} to ${headSha}.\n` +
      '  Goal:       enqueue the PR at the head its approval and checks were verified on.\n' +
      '  Problem:    a new commit was pushed after the caller checked the PR.\n' +
      '  Location:   operations/devops/enqueue-pr.mjs (expectedHeadOid pin, t/73).\n' +
      '  Next steps: none for a sweep (the next run re-checks the new head); by hand, rerun after re-approval.',
    );
  }

  // t/537: a PR that changes a workflow or a gate script is refused, at every tier, unless a
  // Tech Lead or Security reviewer-App approval bound to this head is named. Read from the API;
  // unreadable is a refusal. Before any guard read, so nothing the PR's own checks say matters.
  const changed = fetchChangedFiles(repo, prNumber, ghFn);
  if (changed.error) console.warn(`WARN: enqueue-pr could not read the changed files of #${prNumber} on ${repo} (${changed.error.message ?? changed.error}); refusing.`);
  const override = gateChangeReviewId == null ? null : fetchReview(repo, prNumber, gateChangeReviewId, ghFn);
  if (override?.error) console.warn(`WARN: enqueue-pr could not read review ${gateChangeReviewId} on #${prNumber} (${override.error.message ?? override.error}); refusing.`);
  const gateVerdict = gateFileChangeVerdict({ files: changed, headSha, override });
  if (gateVerdict.allow && gateVerdict.reason === 'gate_files_overridden' && !(typeof by === 'string' && by.trim())) {
    throw new Error(
      `enqueue-pr: refusing to arm/enqueue #${prNumber} on ${repo} (override_without_by).\n` +
      `  Goal:       land #${prNumber} via the merge queue.\n` +
      '  Problem:    --gate-change-review was given without --by, so the override cannot be attributed.\n' +
      '  Location:   operations/devops/enqueue-pr.mjs (t/537).\n' +
      '  Next steps: rerun with --by=<your collaborator id>.',
    );
  }
  if (!gateVerdict.allow) throw new Error(gateFileRefusalMessage({ repo, prNumber, headSha, verdict: gateVerdict }));
  if (gateVerdict.reason === 'gate_files_overridden') {
    console.log(`GATE-CHANGE-OVERRIDE repo=${repo} pr=${prNumber} head=${headSha} review=${gateChangeReviewId} approver="${gateVerdict.role}" by=${by.trim()} ` +
      `at=${new Date().toISOString()} files=${gateVerdict.gateFiles.join(',')}`);
  }

  // t/534 part A: the approval is decided HERE, from the PR's reviews and comments read from the
  // API at this head, by the guard's own predicate (approvalFromApiVerdict). No check run is read
  // for the decision: the `t1-approval-guard` row on the PR is display only (Security condition 3).
  // T0 is exempt, so nothing is read for it. T2 needs the same reviewer-App review as T1 (TL ruling,
  // Lead t/534; merge-approval does the same).
  const needsApproval = !prMeta.isDraft && tier !== 'T0';
  const inputs = needsApproval ? fetchApprovalInputs(repo, prNumber, headSha, ghFn) : null;
  // A tier-check lookup error is non-blocking: tierCheckDisagreesAt already WARNed (t/4950).
  const tierCheckDisagreesOnT0 = tier === 'T0' ? tierCheckDisagreesAt(repo, headSha, ghFn).disagrees : false;
  const verdict = approvalFromApiVerdict({ tier, isDraft: prMeta.isDraft, headSha, inputs, tierCheckDisagreesOnT0 });

  if (verdict.reason === 'approval_lookup_error') {
    console.warn(
      `WARN: enqueue-pr could not read the reviews, comments or commits of #${prNumber} on ${repo} ` +
      `at ${headSha} (${verdict.detail}). Refusing rather than risk arming an unapproved T1 PR.`,
    );
    throw new Error(
      `enqueue-pr: refusing #${prNumber} on ${repo} -- could not verify the approval at ${headSha}.\n` +
      '  Goal:       land the PR only once an approval at this head is confirmed from the API.\n' +
      `  Problem:    ${verdict.detail}.\n` +
      '  Location:   operations/devops/enqueue-pr.mjs (fetchApprovalInputs, t/534).\n' +
      '  Next steps: check gh auth / API rate limits, then rerun.',
    );
  }

  if (verdict.warn) console.warn(`WARN: ${verdict.warn} (#${prNumber} on ${repo}, head ${headSha})`);
  if (!verdict.allow) {
    throw new Error(
      `enqueue-pr: refusing to arm/enqueue #${prNumber} on ${repo} (${verdict.reason}).\n` +
      `  Goal:       land #${prNumber} via the merge queue.\n` +
      `  Problem:    ${verdict.reason === 'draft'
        ? 'the PR is still a draft.'
        : `the approval read from the API at ${headSha} is ${verdict.reason}${verdict.detail ? ` (${verdict.detail})` : ''}, ` +
          `and the declared tier (${tier ?? 'none'}) requires one.`}\n` +
      '  Location:   operations/devops/enqueue-pr.mjs (approvalFromApiVerdict, t/534).\n' +
      '  Next steps: get a reviewer-App `Approved (<role>):` review on this exact head from a role ' +
      'other than the branch owner, resolve any changes-request, then rerun. This is the same incident class as #4648/#3343/#3364.',
    );
  }

  const before = queryQueueState(repo, prNumber, ghFn);

  let cliOutput = '';
  try {
    cliOutput = ghFn(['pr', 'merge', String(prNumber), '-R', repo, '--auto', '--squash', '--match-head-commit', headSha]);
  } catch (err) {
    cliOutput = String(err.stdout || err.message || err);
  }

  await sleep(sleepMs);
  const after = queryQueueState(repo, prNumber, ghFn);
  const afterOutcome = classifyEnqueueOutcome(after, { before });
  if (afterOutcome.state === 'merged' || afterOutcome.state === 'already_merged') {
    const sha = after.mergeCommit?.oid ?? 'unknown';
    console.log(afterOutcome.state === 'merged'
      ? `enqueue-pr: #${prNumber} on ${repo} merged directly as ${sha} (no merge queue or auto-merge on this repo).`
      : `enqueue-pr: #${prNumber} on ${repo} was already merged (${sha} at ${after.mergedAt}) before this run; nothing to do.`);
    return { ok: true, usedFallback: false, state: afterOutcome.state, mergeCommit: sha };
  }
  if (afterOutcome.state === 'queued') {
    return { ok: true, usedFallback: false, state: 'queued' };
  }
  if (afterOutcome.state === 'armed_waiting') {
    console.log(
      `enqueue-pr: #${prNumber} on ${repo} is armed (mergeStateStatus: ${after.mergeStateStatus}); ` +
      'will enter the queue once required checks pass.',
    );
    return { ok: true, usedFallback: false, state: 'armed_waiting' };
  }

  console.warn(formatSilentMissWarning({ repo, prNumber, cliOutput, priorAutoMergeRequest: before.autoMergeRequest }));

  enqueueViaMutation(repo, prNumber, headSha, ghFn);
  await sleep(sleepMs);
  const afterFallback = queryQueueState(repo, prNumber, ghFn);
  const fallbackOutcome = classifyEnqueueOutcome(afterFallback);
  if (fallbackOutcome.state === 'not_armed') {
    throw new Error(
      `enqueue-pr: #${prNumber} on ${repo} is still not enqueued or armed after the GraphQL fallback.\n` +
      '  Goal:       land the PR via the merge queue.\n' +
      '  Problem:    neither the CLI arm nor the direct enablePullRequestAutoMerge mutation ' +
      'resulted in isInMergeQueue=true or a recorded autoMergeRequest.\n' +
      '  Location:   operations/devops/enqueue-pr.mjs.\n' +
      '  Next steps: check mergeStateStatus/mergeable by hand; this may be a real block ' +
      '(failing required check, conflict), not the silent-miss class.',
    );
  }

  return { ok: true, usedFallback: true, state: fallbackOutcome.state };
}

const isCliEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCliEntry) {
  const [repo, prNumberArg, ...flags] = process.argv.slice(2);
  const flag = (name) => flags.map((f) => new RegExp(`^--${name}=(.+)$`).exec(f)).find(Boolean)?.[1] ?? null;
  const unknown = flags.filter((f) => !/^--(gate-change-review|budget-exempt-review|by)=.+$/.test(f));
  if (!repo || !prNumberArg || unknown.length) {
    console.error('Usage: node operations/devops/enqueue-pr.mjs <owner>/<repo> <prNumber> [--gate-change-review=<review id>] [--budget-exempt-review=<review id>] [--by=<collaborator id>]');
    process.exit(1);
  }
  runCli(repo, Number(prNumberArg), { gateChangeReviewId: flag('gate-change-review'), budgetExemptReviewId: flag('budget-exempt-review'), by: flag('by') }).then(
    (code) => { process.exitCode = code; },
  );
}

/**
 * The CLI: enqueuePR, and on an over-budget refusal ONE ping to the PR's owner (t/564; library callers
 * such as the sweeps never ping). Returns the exit code. `deps` ({ enqueue, ping, log, error }) is for tests.
 */
export async function runCli(repo, prNumber, opts, deps = {}) {
  const { enqueue = enqueuePR, ping = pingBudgetRefusal, log = console.log, error = console.error } = deps;
  try {
    log(JSON.stringify(await enqueue(repo, prNumber, opts)));
    return 0;
  } catch (err) {
    error(err?.message ?? err);
    if (err?.budget) await ping({ repo, pr: err.budget.pr, reason: err.reason, message: err.message, by: opts.by });
    return 1;
  }
}
