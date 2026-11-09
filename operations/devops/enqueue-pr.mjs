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
//   node operations/devops/enqueue-pr.mjs <owner>/<repo> <prNumber>
//
// t/4939 (interim refusal, Quality-approved design + 3 should-fixes): #4648 merged with no
// approval and CHANGES_REQUESTED still active, because `t1-approval-guard` isn't a required
// status check yet (promotion is a separate T2 change, step 3 of t/4939). Until then, this
// wrapper refuses to arm/enqueue a T1 PR whose guard verdict isn't a clean `success` at the
// head, refuses any draft outright, and refuses on the guard's own `failure` verdict
// regardless of declared tier. It does NOT cover a direct `gh pr merge --auto` call or the
// sweep paths (t0-enqueue-sweep, dependabot-enqueue-sweep) -- the required-context promotion
// is the real fix for those.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractTier } from './tier-check-predicate.mjs';

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

/** PURE. Formats the WARN logged on a silent CLI miss, so the message shape is testable. */
export function formatSilentMissWarning({ repo, prNumber, cliOutput, priorAutoMergeRequest }) {
  return (
    `WARN: gh pr merge --auto --squash --match-head-commit silently failed to enqueue ` +
    `#${prNumber} on ${repo}. CLI output: ${JSON.stringify(cliOutput)}. ` +
    `Prior autoMergeRequest: ${JSON.stringify(priorAutoMergeRequest ?? null)}. ` +
    `Falling back to the enablePullRequestAutoMerge GraphQL mutation (t/4731#1, t/4740).`
  );
}

function gh(args, options = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', ...options });
}

function queryQueueState(repo, prNumber) {
  const [owner, name] = repo.split('/');
  const query =
    'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){' +
    'pullRequest(number:$number){state mergedAt mergeCommit{oid} isInMergeQueue mergeQueueEntry{position state} headRefOid ' +
    'mergeStateStatus autoMergeRequest{mergeMethod enabledAt enabledBy{login}}}}}';
  const out = JSON.parse(
    gh(['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${prNumber}`]),
  );
  return out.data.repository.pullRequest;
}

/** Latest `t1-approval-guard` check run at `headSha`, or `null` on a lookup error (caller refuses on null+error). */
function fetchGuardRun(repo, headSha) {
  try {
    const out = JSON.parse(gh(['api', `repos/${repo}/commits/${headSha}/check-runs`, '-F', 'check_name=t1-approval-guard']));
    const runs = out.check_runs ?? [];
    if (!runs.length) return { run: null, lookupError: false };
    runs.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
    return { run: runs[0], lookupError: false };
  } catch (err) {
    return { run: null, lookupError: true, error: err };
  }
}

/** Best-effort, never throws: true when `tier-check`'s latest completed run at `headSha` concluded `failure`. */
function tierCheckDisagreesAt(repo, headSha) {
  try {
    const out = JSON.parse(gh(['api', `repos/${repo}/commits/${headSha}/check-runs`, '-F', 'check_name=tier-check']));
    const runs = (out.check_runs ?? []).filter((r) => r.app?.slug === 'github-actions' && r.status === 'completed');
    if (!runs.length) return false;
    runs.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
    return runs[0].conclusion === 'failure';
  } catch {
    return false;
  }
}

function enqueueViaMutation(repo, prNumber, headSha) {
  const nodeId = gh(['pr', 'view', String(prNumber), '-R', repo, '--json', 'id', '-q', '.id']).trim();
  const mutation =
    'mutation($pullRequestId:ID!,$headSha:GitObjectID!){enablePullRequestAutoMerge(input:{' +
    'pullRequestId:$pullRequestId,mergeMethod:SQUASH,expectedHeadOid:$headSha}){pullRequest{autoMergeRequest{mergeMethod}}}}';
  gh(['api', 'graphql', '-f', `query=${mutation}`, '-f', `pullRequestId=${nodeId}`, '-f', `headSha=${headSha}`]);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Arms auto-merge on a PR and verifies it actually took — either by entering the queue
 * directly, or by leaving autoMergeRequest set so it enters once required checks pass
 * (t/4768). Falls back to the direct GraphQL mutation only on a genuine silent miss (no
 * autoMergeRequest at all). Throws (never silently returns ok:false) if even the fallback
 * doesn't result in the PR being queued or armed.
 */
export async function enqueuePR(repo, prNumber, { sleepMs = 5000 } = {}) {
  const prMeta = JSON.parse(gh(['pr', 'view', String(prNumber), '-R', repo, '--json', 'headRefOid,body,isDraft']));
  const headSha = prMeta.headRefOid;
  const tier = extractTier(prMeta.body);

  const { run: guardRun, lookupError, error: guardLookupErr } = fetchGuardRun(repo, headSha);
  const tierCheckDisagreesOnT0 = tier === 'T0' ? tierCheckDisagreesAt(repo, headSha) : false;

  if (lookupError) {
    console.warn(
      `WARN: enqueue-pr could not look up t1-approval-guard's check run for #${prNumber} on ${repo} ` +
      `at ${headSha} (${guardLookupErr?.message ?? 'API error'}). Refusing rather than risk arming an unapproved T1 PR.`,
    );
    throw new Error(
      `enqueue-pr: refusing #${prNumber} on ${repo} -- could not verify t1-approval-guard's state at ${headSha}.\n` +
      '  Goal:       land the PR only once its approval guard verdict is confirmed.\n' +
      '  Problem:    the check-runs API lookup for t1-approval-guard failed.\n' +
      '  Location:   operations/devops/enqueue-pr.mjs (fetchGuardRun).\n' +
      '  Next steps: check gh auth / API rate limits, then rerun.',
    );
  }

  const verdict = classifyT1GuardForEnqueue({ tier, isDraft: prMeta.isDraft, guardRun, tierCheckDisagreesOnT0 });
  if (verdict.warn) console.warn(`WARN: ${verdict.warn} (#${prNumber} on ${repo}, head ${headSha})`);
  if (!verdict.allow) {
    throw new Error(
      `enqueue-pr: refusing to arm/enqueue #${prNumber} on ${repo} (${verdict.reason}).\n` +
      `  Goal:       land #${prNumber} via the merge queue.\n` +
      `  Problem:    ${verdict.reason === 'draft'
        ? 'the PR is still a draft.'
        : `t1-approval-guard at ${headSha} is ${verdict.reason.replace(/^guard_/, '')}, and the declared tier (${tier ?? 'none'}) requires a clean pass.`}\n` +
      '  Location:   operations/devops/enqueue-pr.mjs (classifyT1GuardForEnqueue, t/4939).\n' +
      '  Next steps: get an `Approved (<role>):` comment or review, wait for t1-approval-guard ' +
      'to go green on this exact head, then rerun. This is the same incident class as #4648/#3343/#3364.',
    );
  }

  const before = queryQueueState(repo, prNumber);

  let cliOutput = '';
  try {
    cliOutput = gh(['pr', 'merge', String(prNumber), '-R', repo, '--auto', '--squash', '--match-head-commit', headSha]);
  } catch (err) {
    cliOutput = String(err.stdout || err.message || err);
  }

  await sleep(sleepMs);
  const after = queryQueueState(repo, prNumber);
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

  enqueueViaMutation(repo, prNumber, headSha);
  await sleep(sleepMs);
  const afterFallback = queryQueueState(repo, prNumber);
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
  const [repo, prNumberArg] = process.argv.slice(2);
  if (!repo || !prNumberArg) {
    console.error('Usage: node operations/devops/enqueue-pr.mjs <owner>/<repo> <prNumber>');
    process.exit(1);
  }
  enqueuePR(repo, Number(prNumberArg)).then(
    (result) => { console.log(JSON.stringify(result)); },
    (err) => { console.error(err.message ?? err); process.exit(1); },
  );
}
