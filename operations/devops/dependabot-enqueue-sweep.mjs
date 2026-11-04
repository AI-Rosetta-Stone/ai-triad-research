// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Enqueue policy-armed Dependabot PRs that are green but stuck outside the merge queue.
//
// WHY: since the merge queue launched (2026-10-28), every Dependabot PR armed by
// dependabot-auto-merge.yml sat 16-41h outside the queue until a human re-armed it
// (#4262, #4263, #4280, #4282). That workflow arms with the built-in GITHUB_TOKEN, and an
// auto-merge armed by GITHUB_TOKEN was never followed by queue entry, while the same PRs
// entered the queue within seconds when re-armed by a person. Dependabot-triggered
// workflows cannot read Actions secrets, so the fix runs here, on a schedule, as a GitHub
// App: dependabot-auto-merge.yml still applies the minor/patch policy by arming; this sweep
// takes every armed, green, unqueued Dependabot PR, disarms it, and enqueues it as the App
// through enqueue-pr.mjs (which verifies the queue entry and fails loudly on a miss).
//
// Pure core (`selectSweepCandidates`) is unit-tested in dependabot-enqueue-sweep.test.mjs;
// the gh calls are the impure shim.
//
//   GH_TOKEN=<app token> node operations/devops/dependabot-enqueue-sweep.mjs <owner>/<repo> [--dry-run]

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enqueuePR } from './enqueue-pr.mjs';
import { liveEnqueueVerdict, readLivePR } from './live-pr-state.mjs';
import { allContextsFor } from './pr-contexts.mjs';

/** Required contexts that must have passed before a PR is enqueued (root AGENTS.md). */
export const REQUIRED_GREEN = ['ci-gate', 'CodeQL Analysis'];

/**
 * PURE. Reduces a PR's check contexts to a per-name verdict: 'success' when at least one
 * run of that name succeeded and none is still pending, 'pending' when any run is not yet
 * complete, otherwise 'failed'; 'missing' when no run of that name exists.
 */
export function checkVerdict(contexts, name) {
  const runs = (contexts ?? []).filter((c) => (c.name ?? c.context) === name);
  if (runs.length === 0) return 'missing';
  const result = (c) => (c.conclusion ?? c.state ?? '').toUpperCase();
  if (runs.some((c) => c.status && c.status.toUpperCase() !== 'COMPLETED')) return 'pending';
  if (runs.some((c) => result(c) === 'PENDING' || result(c) === 'EXPECTED')) return 'pending';
  return runs.some((c) => result(c) === 'SUCCESS') ? 'success' : 'failed';
}

/**
 * PURE. Splits open Dependabot PRs into those to enqueue now and those to skip (with the
 * reason). A PR is enqueued only when the auto-merge workflow armed it (the minor/patch
 * policy marker), it is not a draft, not already queued, has no merge conflict, and every
 * REQUIRED_GREEN context passed.
 */
export function selectSweepCandidates(prs) {
  const enqueue = [];
  const skip = [];
  for (const pr of prs) {
    let reason = null;
    // Security (t/4779, TL p/331#2578): Dependabot's author is { __typename: "Bot", login: "dependabot" }
    // (verified live on #4280–4282). Exact-match only — reject lookalike accounts (e.g. dependabot-helper).
    if (pr.author?.typename !== 'Bot' || pr.author?.login !== 'dependabot') reason = `author is not Bot/dependabot (was ${JSON.stringify(pr.author)})`;
    // isCrossRepository fails closed: any fork PR is rejected (defense-in-depth). GitHub's current behavior
    // never produces fork PRs from Dependabot, but this must not rely on that forever.
    else if (pr.isCrossRepository !== false) reason = 'fork PR (never auto-enqueued; a maintainer must review and enqueue it)';
    else if (pr.isInMergeQueue) reason = 'already in merge queue';
    else if (pr.isDraft) reason = 'draft';
    else if (!pr.autoMergeRequest) reason = 'not armed by dependabot-auto-merge (outside minor/patch policy)';
    else if (pr.mergeStateStatus === 'DIRTY') reason = 'merge conflict';
    else {
      for (const name of REQUIRED_GREEN) {
        const v = checkVerdict(pr.contexts, name);
        if (v !== 'success') { reason = `${name} is ${v}`; break; }
      }
    }
    if (reason) skip.push({ number: pr.number, reason });
    else enqueue.push({ number: pr.number, headRefOid: pr.headRefOid });
  }
  return { enqueue, skip };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

export function normalizePR(n) {
  return {
    number: n.number,
    headRefOid: n.headRefOid,
    isDraft: n.isDraft,
    isInMergeQueue: n.isInMergeQueue,
    mergeStateStatus: n.mergeStateStatus,
    autoMergeRequest: n.autoMergeRequest,
    isCrossRepository: n.isCrossRepository,
    author: n.author ? { typename: n.author.__typename, login: n.author.login } : {},
    contexts: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [],
  };
}

// A full-suite PR has more than 100 contexts; allContextsFor reads past the first page (#4475).
const CONTEXT_FIELDS = '... on CheckRun{name status conclusion} ... on StatusContext{context state}';

function listOpenDependabotPRs(repo) {
  const query = `query($q:String!){search(query:$q,type:ISSUE,first:50){nodes{... on PullRequest{
    number headRefOid isDraft isInMergeQueue mergeStateStatus autoMergeRequest{enabledAt} isCrossRepository
    author{__typename login}
    commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){pageInfo{hasNextPage endCursor} nodes{
      ${CONTEXT_FIELDS}}}}}}}}}}}`;
  const out = JSON.parse(gh(['api', 'graphql', '-f', `query=${query}`,
    '-f', `q=repo:${repo} is:pr is:open author:app/dependabot`]));
  return out.data.search.nodes.map((n) => ({
    ...normalizePR(n),
    contexts: allContextsFor(repo, n.number, n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts, CONTEXT_FIELDS),
  }));
}

export async function sweep(repo, { dryRun = false } = {}) {
  const { enqueue, skip } = selectSweepCandidates(listOpenDependabotPRs(repo));
  for (const s of skip) console.log(`skip #${s.number}: ${s.reason}`);
  if (enqueue.length === 0) { console.log('No Dependabot PRs to enqueue.'); return { enqueued: 0, failed: 0 }; }

  let enqueued = 0;
  const failures = [];
  for (const pr of enqueue) {
    if (dryRun) { console.log(`[dry-run] would enqueue #${pr.number} at ${pr.headRefOid}`); continue; }
    // Search results lag: re-read the PR directly before touching it (see live-pr-state.mjs).
    // Checked BEFORE the disarm, so a PR that has moved on keeps its policy arm.
    const before = liveEnqueueVerdict(readLivePR(repo, pr.number), pr.headRefOid);
    if (!before.ok) {
      console.log(`skip #${pr.number} at enqueue time: ${before.reason}` +
        (before.raced ? '' : ' (WARN: will retry on the next sweep)'));
      continue;
    }
    try {
      // Disarm first: re-arming an already-armed PR is a no-op, which leaves the original
      // GITHUB_TOKEN arm in place (the state that never enqueues).
      gh(['pr', 'merge', String(pr.number), '-R', repo, '--disable-auto']);
      const result = await enqueuePR(repo, pr.number);
      console.log(`enqueued #${pr.number} (usedFallback=${result.usedFallback})`);
      enqueued++;
    } catch (err) {
      // The PR may have moved on in the seconds since the check above (merged or queued, or
      // Dependabot rebased it). That is a race, not a failure, and no re-arm is needed: a
      // rebase re-runs dependabot-auto-merge.yml, which arms the new head itself.
      const after = liveEnqueueVerdict(readLivePR(repo, pr.number), pr.headRefOid);
      if (after.raced) {
        console.log(`skip #${pr.number}: ${after.reason} while enqueuing (race, not a failure): ${err.message ?? err}`);
        continue;
      }
      failures.push(pr.number);
      console.error(`::error::#${pr.number}: ${err.message ?? err}`);
      // Restore the policy marker so the next sweep retries this PR instead of dropping it.
      try {
        gh(['pr', 'merge', String(pr.number), '-R', repo, '--auto', '--squash', '--match-head-commit', pr.headRefOid]);
        console.warn(`WARN: re-armed #${pr.number} after a failed enqueue so the next sweep retries it.`);
      } catch (rearmErr) {
        console.warn(`WARN: could not re-arm #${pr.number} after a failed enqueue (${rearmErr.message ?? rearmErr}); ` +
          'it will not be retried automatically. Enqueue it by hand.');
      }
    }
  }
  console.log(`Enqueued ${enqueued}/${enqueue.length}.`);
  if (failures.length) {
    throw new Error(
      `dependabot-enqueue-sweep: failed to enqueue ${failures.map((n) => `#${n}`).join(', ')} on ${repo}.\n` +
      '  Goal:       land green, policy-armed Dependabot PRs through the merge queue.\n' +
      '  Problem:    enqueue-pr.mjs could not get these PRs into the queue as the App.\n' +
      '  Location:   operations/devops/dependabot-enqueue-sweep.mjs (see the ::error:: lines above).\n' +
      '  Next steps: check each PR\'s mergeStateStatus and the App\'s permissions (contents, ' +
      'pull requests and, for workflow-file bumps, workflows: write).',
    );
  }
  return { enqueued, failed: 0 };
}

const isCliEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCliEntry) {
  const repo = process.argv[2];
  if (!repo) {
    console.error('Usage: node operations/devops/dependabot-enqueue-sweep.mjs <owner>/<repo> [--dry-run]');
    process.exit(1);
  }
  sweep(repo, { dryRun: process.argv.includes('--dry-run') }).then(
    () => {},
    (err) => { console.error(err.message ?? err); process.exit(1); },
  );
}
