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

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * PURE. Classifies a queue-state read into one of three outcomes:
 *  - 'queued'        — genuinely in the merge queue.
 *  - 'armed_waiting' — auto-merge is armed (autoMergeRequest set) but the PR hasn't entered
 *                       the queue yet, because required checks on the head are still
 *                       pending (mergeStateStatus is typically BLOCKED or UNSTABLE here).
 *                       This is the normal "will queue once checks pass" state, not a miss.
 *  - 'not_armed'      — no autoMergeRequest recorded; the arm attempt genuinely did not take.
 */
export function classifyEnqueueOutcome({ isInMergeQueue, mergeQueueEntry, autoMergeRequest }) {
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

function gh(args, options = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', ...options });
}

function queryQueueState(repo, prNumber) {
  const [owner, name] = repo.split('/');
  const query =
    'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){' +
    'pullRequest(number:$number){isInMergeQueue mergeQueueEntry{position state} headRefOid ' +
    'mergeStateStatus autoMergeRequest{mergeMethod enabledAt enabledBy{login}}}}}';
  const out = JSON.parse(
    gh(['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${prNumber}`]),
  );
  return out.data.repository.pullRequest;
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
  const headSha = gh(['pr', 'view', String(prNumber), '-R', repo, '--json', 'headRefOid', '-q', '.headRefOid']).trim();
  const before = queryQueueState(repo, prNumber);

  let cliOutput = '';
  try {
    cliOutput = gh(['pr', 'merge', String(prNumber), '-R', repo, '--auto', '--squash', '--match-head-commit', headSha]);
  } catch (err) {
    cliOutput = String(err.stdout || err.message || err);
  }

  await sleep(sleepMs);
  const after = queryQueueState(repo, prNumber);
  const afterOutcome = classifyEnqueueOutcome(after);
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
