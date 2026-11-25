// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/597 (PowerShell p/98#14, TL p/37#209): the SANCTIONED way to disarm or dequeue a PR. `gh pr merge`
// in any form is forbidden (root AGENTS.md, t/4939): on a merge-queue branch even `--disable-auto`
// goes through the same command family the rule bans. This uses the GraphQL mutations directly:
//   - queued (mergeQueueEntry present)  -> dequeuePullRequest
//   - auto-merge armed (autoMergeRequest) -> disablePullRequestAutoMerge
// then READS BACK and refuses (ActionableError, exit 1) unless autoMergeRequest is null and there is
// no mergeQueueEntry. Idempotent: an already-clean PR does nothing and exits 0. Every step is logged.
//
//   node operations/devops/disarm-pr.mjs <owner>/<repo> <N>
//
// The usual flow after it: push, then re-enqueue with enqueue-pr.mjs.
// Pure core: planDisarm, readBackVerdict. Impure shim: disarmPR (gh injectable).

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const STATE_QUERY =
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){' +
  'id state isInMergeQueue mergeQueueEntry{position state} autoMergeRequest{enabledAt}}}}';
const DEQUEUE = 'mutation($id:ID!){dequeuePullRequest(input:{id:$id}){mergeQueueEntry{state}}}';
const DISABLE_AUTO = 'mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){pullRequest{autoMergeRequest{enabledAt}}}}';

/** PURE. The mutations to run, in order, for a PR state. Dequeue first: a queued PR is also armed. */
export function planDisarm(pr) {
  const steps = [];
  if (pr.mergeQueueEntry || pr.isInMergeQueue) steps.push('dequeue');
  if (pr.autoMergeRequest) steps.push('disable-auto');
  return steps;
}

/** PURE. The read-back verdict: clean only when nothing remains. */
export function readBackVerdict(pr) {
  const left = [];
  if (pr.mergeQueueEntry || pr.isInMergeQueue) left.push('still in the merge queue');
  if (pr.autoMergeRequest) left.push('auto-merge still armed');
  return { clean: left.length === 0, left };
}

function actionable(goal, problem, location, next) {
  const err = new Error(`disarm-pr: ${problem}\n  Goal:       ${goal}\n  Problem:    ${problem}\n  Location:   ${location}\n  Next steps: ${next}`);
  err.name = 'ActionableError';
  return err;
}

function readState(repo, number, ghFn) {
  const [owner, name] = repo.split('/');
  const out = JSON.parse(ghFn(['api', 'graphql', '-f', `query=${STATE_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`]));
  const pr = out?.data?.repository?.pullRequest;
  if (!pr || typeof pr.id !== 'string') throw new Error('the PR read returned no pull request');
  return pr;
}

/**
 * Disarms and dequeues PR `number` on `repo`, then verifies. Returns { ok, did: [steps], state }.
 * Throws an ActionableError when a read or a mutation fails, or the read-back still shows it armed
 * or queued. `log(msg)` receives every step.
 */
export function disarmPR(repo, number, { gh: ghFn = gh, log = (m) => console.log(m) } = {}) {
  const goal = `take #${number} on ${repo} out of the merge queue and disarm auto-merge, so a push cannot race the queue`;
  let pr;
  try {
    pr = readState(repo, number, ghFn);
  } catch (err) {
    throw actionable(goal, `could not read #${number}'s queue and auto-merge state (${String(err?.message ?? err).split('\n')[0]})`,
      'operations/devops/disarm-pr.mjs (readState)', 'check gh auth and the PR number, then rerun. Do not push until it succeeds.');
  }
  log(`disarm-pr: #${number} on ${repo}: state=${pr.state} queued=${Boolean(pr.mergeQueueEntry || pr.isInMergeQueue)} armed=${Boolean(pr.autoMergeRequest)}`);
  const steps = planDisarm(pr);
  if (steps.length === 0) {
    log(`disarm-pr: #${number} is already disarmed and not queued; nothing to do.`);
    return { ok: true, did: [], state: pr };
  }
  for (const step of steps) {
    const query = step === 'dequeue' ? DEQUEUE : DISABLE_AUTO;
    log(`disarm-pr: #${number}: ${step === 'dequeue' ? 'dequeuePullRequest' : 'disablePullRequestAutoMerge'}...`);
    try {
      ghFn(['api', 'graphql', '-f', `query=${query}`, '-f', `id=${pr.id}`]);
    } catch (err) {
      const msg = String(err?.stderr || err?.message || err).split('\n')[0];
      // Dequeueing a PR also removes its auto-merge on GitHub's side, so disable-auto can then fail
      // as "not enabled". The read-back below decides; a real failure still refuses there.
      log(`disarm-pr: WARN #${number}: ${step} returned an error (${msg}); the read-back decides.`);
    }
  }
  let after;
  try {
    after = readState(repo, number, ghFn);
  } catch (err) {
    throw actionable(goal, `could not read #${number} back after disarming (${String(err?.message ?? err).split('\n')[0]})`,
      'operations/devops/disarm-pr.mjs (read-back)', 'rerun; do not push until a read-back shows it disarmed.');
  }
  const v = readBackVerdict(after);
  if (!v.clean) {
    throw actionable(goal, `#${number} is ${v.left.join(' and ')} after ${steps.join(' + ')}`,
      'operations/devops/disarm-pr.mjs (read-back)', 'rerun in a minute (the queue may be mid-batch); if it persists, ask the DevOps Lead. Do not push.');
  }
  log(`disarm-pr: #${number} read back clean (not queued, auto-merge off). Now push, then re-enqueue with node operations/devops/enqueue-pr.mjs ${repo} ${number}.`);
  return { ok: true, did: steps, state: after };
}

const isCliEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCliEntry) {
  const [repo, n] = process.argv.slice(2);
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo) || !/^[1-9]\d*$/.test(n ?? '')) {
    console.error('Usage: node operations/devops/disarm-pr.mjs <owner>/<repo> <PR number>');
    process.exit(1);
  }
  try {
    const r = disarmPR(repo, Number(n));
    console.log(JSON.stringify({ ok: r.ok, did: r.did }));
  } catch (err) {
    console.error(err.message ?? err);
    process.exit(1);
  }
}
