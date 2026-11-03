// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Live (non-search) PR state for the enqueue sweeps.
//
// WHY: the sweeps list PRs through GitHub search, whose results lag the PR's real state.
// On 2026-11-03 the T0 sweep (run 41637792698) read #4441 as green and unqueued at
// 12:41:08; the author had queued it at 12:32 and the queue merged it at 12:41:23. The
// enqueue then failed with "Pull request is already merged" and turned the run red for
// nothing. Re-reading the PR directly just before acting, and again after a failure,
// removes that false failure.
//
// Pure core (`liveEnqueueVerdict`) is unit-tested in live-pr-state.test.mjs.

import { execFileSync } from 'node:child_process';

/**
 * PURE. May the sweep still enqueue this PR, given its live state and the head SHA the
 * sweep evaluated? Returns { ok: true } or { ok: false, reason, raced } where `raced` is
 * true when the PR has moved on by itself (merged, closed or queued), i.e. not a failure.
 */
export function liveEnqueueVerdict(live, expectedHead) {
  if (!live) return { ok: false, reason: 'live state unavailable', raced: false };
  if (live.state === 'MERGED') return { ok: false, reason: 'already merged', raced: true };
  if (live.state !== 'OPEN') return { ok: false, reason: `state is ${live.state}`, raced: true };
  if (live.isInMergeQueue) return { ok: false, reason: 'already in merge queue', raced: true };
  if (live.isDraft) return { ok: false, reason: 'converted to draft', raced: true };
  if (expectedHead && live.headRefOid !== expectedHead) {
    return { ok: false, reason: `head moved ${String(expectedHead).slice(0, 8)} -> ${String(live.headRefOid).slice(0, 8)}`, raced: true };
  }
  return { ok: true };
}

/** Reads one PR's live state directly (repository.pullRequest), not through search. */
export function readLivePR(repo, number) {
  const [owner, name] = repo.split('/');
  const query = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){' +
    'pullRequest(number:$number){state isInMergeQueue isDraft headRefOid}}}';
  try {
    const out = execFileSync('gh', ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`,
      '-f', `name=${name}`, '-F', `number=${number}`], { encoding: 'utf8' });
    return JSON.parse(out).data.repository.pullRequest;
  } catch (err) {
    console.warn(`WARN: could not read live state of #${number} (${err.message ?? err}); treating it as unavailable.`);
    return null;
  }
}
