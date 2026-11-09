// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4939: converted from vitest (describe/it/expect from 'vitest') to node:test. The file
// imported `vitest`, which isn't installed at the repo root and has no CI wiring anywhere in
// .github/workflows -- `node --test` on this file failed outright before this change. Every
// pre-existing assertion is preserved verbatim; only the test-runner API changed.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyEnqueueOutcome, formatSilentMissWarning, classifyT1GuardForEnqueue, enqueuePR,
  fetchGuardRun, classifyGhApiError, pickAuthoritativeGuardRun,
} from './enqueue-pr.mjs';

test('classifyEnqueueOutcome: is queued when both isInMergeQueue and mergeQueueEntry are present', () => {
  assert.deepEqual(classifyEnqueueOutcome({
    isInMergeQueue: true, mergeQueueEntry: { position: 1, state: 'QUEUED' }, autoMergeRequest: null,
  }), { state: 'queued' });
});

test('classifyEnqueueOutcome: is NOT queued when isInMergeQueue is true but mergeQueueEntry is null (t/4740#1 shape)', () => {
  assert.deepEqual(classifyEnqueueOutcome({ isInMergeQueue: true, mergeQueueEntry: null, autoMergeRequest: null }),
    { state: 'not_armed' });
});

test('classifyEnqueueOutcome: is NOT queued when isInMergeQueue is false, even with a stale mergeQueueEntry', () => {
  assert.deepEqual(classifyEnqueueOutcome({
    isInMergeQueue: false, mergeQueueEntry: { position: 1, state: 'QUEUED' }, autoMergeRequest: null,
  }), { state: 'not_armed' });
});

test('classifyEnqueueOutcome: is not_armed when all fields are null (the #4298 shape, TL p/331#2548)', () => {
  assert.deepEqual(classifyEnqueueOutcome({ isInMergeQueue: false, mergeQueueEntry: null, autoMergeRequest: null }),
    { state: 'not_armed' });
});

test('classifyEnqueueOutcome: is armed_waiting when autoMergeRequest is set but the PR has not entered the queue yet ' +
  '-- required checks still pending (t/4768, PR #4351 incident shape)', () => {
  assert.deepEqual(classifyEnqueueOutcome({
    isInMergeQueue: false,
    mergeQueueEntry: null,
    autoMergeRequest: { mergeMethod: 'MERGE', enabledAt: '2026-11-02T21:50:17Z', enabledBy: { login: 'jpsnover' } },
  }), { state: 'armed_waiting' });
});

// t/4889: data#79/#80. ai-triad-data has no merge queue and allow_auto_merge=false, so
// `gh pr merge --auto` merges at once and every queue field reads null afterwards.
const directMergeAfter = {
  state: 'MERGED', mergedAt: '2026-11-05T09:51:33Z', mergeCommit: { oid: 'f98b5f57' },
  isInMergeQueue: false, mergeQueueEntry: null, autoMergeRequest: null,
};

test('classifyEnqueueOutcome: is merged when the PR became MERGED during this run (direct merge, no queue)', () => {
  assert.deepEqual(classifyEnqueueOutcome(directMergeAfter, { before: { state: 'OPEN' } }), { state: 'merged' });
});

test('classifyEnqueueOutcome: is already_merged when the PR was MERGED before this run (TL t/4889#3)', () => {
  assert.deepEqual(classifyEnqueueOutcome(directMergeAfter, { before: { state: 'MERGED' } }), { state: 'already_merged' });
});

test('classifyEnqueueOutcome: is already_merged, never merged, when the prior state is unknown (does not claim the merge)', () => {
  assert.deepEqual(classifyEnqueueOutcome(directMergeAfter), { state: 'already_merged' });
});

test('classifyEnqueueOutcome: is still not_armed for an OPEN PR with null queue fields, so the fallback path is unchanged', () => {
  assert.deepEqual(classifyEnqueueOutcome(
    { state: 'OPEN', isInMergeQueue: false, mergeQueueEntry: null, autoMergeRequest: null },
    { before: { state: 'OPEN' } },
  ), { state: 'not_armed' });
});

test('classifyEnqueueOutcome: prefers queued over armed_waiting when the PR has genuinely entered the queue', () => {
  assert.deepEqual(classifyEnqueueOutcome({
    isInMergeQueue: true,
    mergeQueueEntry: { position: 1, state: 'QUEUED' },
    autoMergeRequest: { mergeMethod: 'SQUASH', enabledAt: '2026-11-02T21:50:17Z', enabledBy: { login: 'jpsnover' } },
  }), { state: 'queued' });
});

test('formatSilentMissWarning: names the PR, repo, CLI output and prior auto-merge state', () => {
  const msg = formatSilentMissWarning({
    repo: 'AI-Rosetta-Stone/ai-triad-research',
    prNumber: 4262,
    cliOutput: '! The merge strategy for main is set by the merge queue',
    priorAutoMergeRequest: { mergeMethod: 'MERGE', enabledAt: '2026-10-31T18:33:34Z', enabledBy: { login: 'app/github-actions' } },
  });

  assert.match(msg, /WARN:/);
  assert.match(msg, /#4262/);
  assert.match(msg, /AI-Rosetta-Stone\/ai-triad-research/);
  assert.match(msg, /merge strategy for main is set by the merge queue/);
  assert.match(msg, /MERGE/);
  assert.match(msg, /app\/github-actions/);
});

test('formatSilentMissWarning: handles a null prior auto-merge state without throwing', () => {
  const msg = formatSilentMissWarning({ repo: 'o/r', prNumber: 1, cliOutput: '', priorAutoMergeRequest: null });
  assert.match(msg, /null/);
});

// t/4939: the interim refusal, folding in Quality's 3 should-fixes (t/4939#2).
const GHA_SUCCESS = { status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } };
const GHA_FAILURE = { status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' } };
const GHA_IN_PROGRESS = { status: 'in_progress', conclusion: null, app: { slug: 'github-actions' } };
const GHA_QUEUED = { status: 'queued', conclusion: null, app: { slug: 'github-actions' } };
const OTHER_APP_SUCCESS = { status: 'completed', conclusion: 'success', app: { slug: 'some-other-bot' } };

test('classifyT1GuardForEnqueue: T1 + guard failure -> refuse', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T1', isDraft: false, guardRun: GHA_FAILURE }),
    { allow: false, reason: 'guard_failure', warn: null },
  );
});

test('classifyT1GuardForEnqueue: T1 + guard missing -> refuse (fail-closed)', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T1', isDraft: false, guardRun: null }),
    { allow: false, reason: 'guard_missing', warn: null },
  );
});

test('classifyT1GuardForEnqueue: T1 + guard in_progress -> refuse (fail-closed, the #4648 shape)', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T1', isDraft: false, guardRun: GHA_IN_PROGRESS }),
    { allow: false, reason: 'guard_in_progress', warn: null },
  );
});

test('classifyT1GuardForEnqueue: T1 + guard queued -> refuse (fail-closed)', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T1', isDraft: false, guardRun: GHA_QUEUED }),
    { allow: false, reason: 'guard_queued', warn: null },
  );
});

test('classifyT1GuardForEnqueue: T1 + guard success -> allow', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T1', isDraft: false, guardRun: GHA_SUCCESS }),
    { allow: true, reason: 'guard_success', warn: null },
  );
});

test('classifyT1GuardForEnqueue: T0 + guard missing -> allow (no approval rule for T0)', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T0', isDraft: false, guardRun: null }),
    { allow: true, reason: 'tier_exempt', warn: null },
  );
});

test('classifyT1GuardForEnqueue: T2 + guard pending -> allow (T2 is gated by consult-hold elsewhere)', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T2', isDraft: false, guardRun: GHA_IN_PROGRESS }),
    { allow: true, reason: 'tier_exempt', warn: null },
  );
});

test('classifyT1GuardForEnqueue: any tier + guard failure -> refuse, even T0/T2', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T0', isDraft: false, guardRun: GHA_FAILURE }),
    { allow: false, reason: 'guard_failure', warn: null },
  );
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T2', isDraft: false, guardRun: GHA_FAILURE }),
    { allow: false, reason: 'guard_failure', warn: null },
  );
});

test('classifyT1GuardForEnqueue: unparseable tier + guard missing -> refuse (treated as T1, fail-closed)', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: null, isDraft: false, guardRun: null }),
    { allow: false, reason: 'guard_missing', warn: null },
  );
});

test('classifyT1GuardForEnqueue: unparseable tier + guard success -> allow (treated as T1, and T1 passes on success)', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: null, isDraft: false, guardRun: GHA_SUCCESS }),
    { allow: true, reason: 'guard_success', warn: null },
  );
});

test('classifyT1GuardForEnqueue: draft is refused whatever the tier (should-fix 1) -- T1 draft', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T1', isDraft: true, guardRun: GHA_SUCCESS }),
    { allow: false, reason: 'draft', warn: null },
  );
});

test('classifyT1GuardForEnqueue: draft is refused whatever the tier (should-fix 1) -- T0 draft (the #4648 shape)', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T0', isDraft: true, guardRun: null }),
    { allow: false, reason: 'draft', warn: null },
  );
});

test('classifyT1GuardForEnqueue: a success run from a non-github-actions app is ignored -> missing-run refusal (should-fix 2)', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T1', isDraft: false, guardRun: OTHER_APP_SUCCESS }),
    { allow: false, reason: 'guard_missing', warn: null },
  );
});

test('classifyT1GuardForEnqueue: T0 + tier-check disagrees -> still allowed, but warns (should-fix 3, WARN-only arm)', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T0', isDraft: false, guardRun: null, tierCheckDisagreesOnT0: true }),
    { allow: true, reason: 'tier_exempt', warn: "tier-check's completed run at this head disagrees with the declared Tier: T0 -- review manually; enqueue-pr does not block on this signal yet (t/4939 follow-up)." },
  );
});

test('classifyT1GuardForEnqueue: T0 + tier-check agrees (or wasn\'t consulted) -> allowed, no warn', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T0', isDraft: false, guardRun: null, tierCheckDisagreesOnT0: false }),
    { allow: true, reason: 'tier_exempt', warn: null },
  );
});

test('classifyT1GuardForEnqueue: tierCheckDisagreesOnT0 is only consulted for T0 -- a T1 PR never gets the warn', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T1', isDraft: false, guardRun: GHA_SUCCESS, tierCheckDisagreesOnT0: true }),
    { allow: true, reason: 'guard_success', warn: null },
  );
});

// t/4939 shim tests (Quality, p/780#25): proving the WIRING, not just the predicate. Moving
// the refusal check below `gh pr merge` in enqueuePR would keep every test above green --
// these three exist specifically to catch that class of regression. `gh` is injected via
// `enqueuePR`'s options so no real CLI call happens in a unit test.

function fakeGhTracking() {
  const calls = [];
  const fn = (args) => { calls.push(args); return fn.next(args); };
  fn.calls = calls;
  fn.next = () => { throw new Error('fakeGhTracking: no response configured for this call'); };
  return fn;
}

const T1_PR_VIEW = JSON.stringify({ headRefOid: 'cafebabe', body: 'Tier: T1\n\nsome PR body', isDraft: false });

// Both refusal tests mock the FULL happy-path chain (graphql queue reads, pr merge) too, not
// just the calls up to the refusal. If the refusal check were ever moved below `gh pr merge`
// (Quality's own demonstration, p/780#25), these would stop rejecting at all -- `assert.rejects`
// would fail outright -- rather than accidentally "passing" by rejecting for an unrelated
// unmocked-call error. A naive version of these tests that omits the happy-path mocks and
// merely asserts `assert.rejects(...)` is vacuous: it also "passes" when the refusal is gone,
// because the call then hits some OTHER unmocked gh invocation and throws for the wrong reason.
function happyPathNext(prView) {
  let graphqlCalls = 0;
  return (args) => {
    const joined = args.join(' ');
    if (joined.includes('pr view') && joined.includes('headRefOid,body,isDraft')) return prView;
    if (joined.includes('graphql') && joined.includes('enablePullRequestAutoMerge')) {
      throw new Error('the GraphQL fallback mutation must never be called in the success path');
    }
    if (joined.includes('graphql')) {
      graphqlCalls += 1;
      const queued = graphqlCalls > 1;
      return JSON.stringify({ data: { repository: { pullRequest: {
        state: 'OPEN', mergedAt: null, mergeCommit: null,
        isInMergeQueue: queued, mergeQueueEntry: queued ? { position: 1, state: 'QUEUED' } : null,
        headRefOid: 'cafebabe', mergeStateStatus: 'CLEAN', autoMergeRequest: null,
      } } } });
    }
    if (args[0] === 'pr' && args[1] === 'merge') return '✓ Auto-merge enabled';
    return undefined; // let the caller's own next() handle check-runs and anything else
  };
}

test('enqueuePR shim: a T1 PR with no guard run is refused, and gh pr merge is never invoked', async () => {
  const fakeGh = fakeGhTracking();
  const happy = happyPathNext(T1_PR_VIEW);
  fakeGh.next = (args) => {
    const joined = args.join(' ');
    if (joined.includes('check-runs') && joined.includes('t1-approval-guard')) return JSON.stringify({ check_runs: [] });
    const r = happy(args);
    if (r !== undefined) return r;
    throw new Error(`unexpected gh call: ${joined}`);
  };

  await assert.rejects(() => enqueuePR('o/r', 7, { sleepMs: 0, gh: fakeGh }), /refusing to arm\/enqueue.*guard_missing/s);
  assert.equal(fakeGh.calls.filter((a) => a[0] === 'pr' && a[1] === 'merge').length, 0);
});

test('enqueuePR shim: a failed t1-approval-guard lookup is refused, warns, and gh pr merge is never invoked', async () => {
  const fakeGh = fakeGhTracking();
  const happy = happyPathNext(T1_PR_VIEW);
  fakeGh.next = (args) => {
    const joined = args.join(' ');
    if (joined.includes('check-runs') && joined.includes('t1-approval-guard')) throw new Error('simulated API failure');
    const r = happy(args);
    if (r !== undefined) return r;
    throw new Error(`unexpected gh call: ${joined}`);
  };

  const warnMock = mock.method(console, 'warn', () => {});
  try {
    await assert.rejects(() => enqueuePR('o/r', 9, { sleepMs: 0, gh: fakeGh }), /could not verify t1-approval-guard/);
    assert.ok(warnMock.mock.calls.some((c) => /WARN/.test(String(c.arguments[0]))));
  } finally {
    warnMock.mock.restore();
  }
  assert.equal(fakeGh.calls.filter((a) => a[0] === 'pr' && a[1] === 'merge').length, 0);
});

test('enqueuePR shim: positive control -- a T1 PR with guard success DOES reach gh pr merge', async () => {
  const fakeGh = fakeGhTracking();
  let graphqlCalls = 0;
  fakeGh.next = (args) => {
    const joined = args.join(' ');
    if (joined.includes('pr view') && joined.includes('headRefOid,body,isDraft')) return T1_PR_VIEW;
    if (joined.includes('check-runs') && joined.includes('t1-approval-guard')) {
      return JSON.stringify({ check_runs: [
        { status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, started_at: '2026-11-09T00:00:00Z' },
      ] });
    }
    if (joined.includes('graphql') && joined.includes('enablePullRequestAutoMerge')) {
      throw new Error('the GraphQL fallback mutation must never be called in the success path');
    }
    if (joined.includes('graphql')) {
      graphqlCalls += 1;
      const queued = graphqlCalls > 1;
      return JSON.stringify({ data: { repository: { pullRequest: {
        state: 'OPEN', mergedAt: null, mergeCommit: null,
        isInMergeQueue: queued, mergeQueueEntry: queued ? { position: 1, state: 'QUEUED' } : null,
        headRefOid: 'cafebabe', mergeStateStatus: 'CLEAN', autoMergeRequest: null,
      } } } });
    }
    if (args[0] === 'pr' && args[1] === 'merge') return '✓ Auto-merge enabled';
    throw new Error(`unexpected gh call: ${joined}`);
  };

  const result = await enqueuePR('o/r', 42, { sleepMs: 0, gh: fakeGh });
  assert.equal(result.state, 'queued');
  assert.equal(fakeGh.calls.filter((a) => a[0] === 'pr' && a[1] === 'merge').length, 1);
});

test('enqueuePR shim: fetchGuardRun filters by app.slug BEFORE picking the latest run (should-fix) -- ' +
  'a newer non-github-actions run does not hide an older real guard success', async () => {
  const fakeGh = fakeGhTracking();
  let graphqlCalls = 0;
  fakeGh.next = (args) => {
    const joined = args.join(' ');
    if (joined.includes('pr view') && joined.includes('headRefOid,body,isDraft')) return T1_PR_VIEW;
    if (joined.includes('check-runs') && joined.includes('t1-approval-guard')) {
      // The non-github-actions run is NEWER (later started_at). Filtering after sorting would
      // pick this one first, read it as not-github-actions, and refuse as "missing" -- wrong,
      // since a real github-actions success exists. Filtering before sorting picks it correctly.
      return JSON.stringify({ check_runs: [
        { status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, started_at: '2026-11-09T00:00:00Z' },
        { status: 'completed', conclusion: 'neutral', app: { slug: 'some-other-bot' }, started_at: '2026-11-09T01:00:00Z' },
      ] });
    }
    if (joined.includes('graphql') && joined.includes('enablePullRequestAutoMerge')) {
      throw new Error('the GraphQL fallback mutation must never be called in the success path');
    }
    if (joined.includes('graphql')) {
      graphqlCalls += 1;
      const queued = graphqlCalls > 1;
      return JSON.stringify({ data: { repository: { pullRequest: {
        state: 'OPEN', mergedAt: null, mergeCommit: null,
        isInMergeQueue: queued, mergeQueueEntry: queued ? { position: 1, state: 'QUEUED' } : null,
        headRefOid: 'cafebabe', mergeStateStatus: 'CLEAN', autoMergeRequest: null,
      } } } });
    }
    if (args[0] === 'pr' && args[1] === 'merge') return '✓ Auto-merge enabled';
    throw new Error(`unexpected gh call: ${joined}`);
  };

  const result = await enqueuePR('o/r', 42, { sleepMs: 0, gh: fakeGh });
  assert.equal(result.state, 'queued');
  assert.equal(fakeGh.calls.filter((a) => a[0] === 'pr' && a[1] === 'merge').length, 1);
});

// t/4939 live incident (#4694 enqueue refusal, 2026-11-09): ci.yml also has a job named
// `t1-approval-guard`, co-located for the merge_group queue re-check, which legitimately
// SKIPS on every normal pull_request event (its `if:` only matches merge_group). That skip
// shares the exact check-run name with the real PR-side gate (`t1-approval-guard.yml`). Picking
// "latest by started_at" is a timing race: ci.yml is a large, slow, many-job workflow that often
// finishes its meaningless skip AFTER the single-job standalone gate finishes its real success --
// shadowing a genuine approval purely by luck of the clock.
test('pickAuthoritativeGuardRun: a later SKIPPED run never shadows an earlier real success (the #4694 race)', () => {
  const runs = [
    { status: 'completed', conclusion: 'success', started_at: '2026-11-09T17:08:58Z' },
    { status: 'completed', conclusion: 'skipped', started_at: '2026-11-09T17:14:43Z' },  // later, but meaningless
  ];
  assert.equal(pickAuthoritativeGuardRun(runs).conclusion, 'success');
});

test('pickAuthoritativeGuardRun: a later SKIPPED run never shadows an earlier FAILURE either (fail-closed, not fail-open)', () => {
  const runs = [
    { status: 'completed', conclusion: 'failure', started_at: '2026-11-09T17:08:58Z' },
    { status: 'completed', conclusion: 'skipped', started_at: '2026-11-09T17:14:43Z' },
  ];
  assert.equal(pickAuthoritativeGuardRun(runs).conclusion, 'failure');
});

test('pickAuthoritativeGuardRun: among several non-skipped runs, the latest still wins (unchanged prior behavior)', () => {
  const runs = [
    { status: 'completed', conclusion: 'failure', started_at: '2026-11-09T17:00:00Z' },
    { status: 'completed', conclusion: 'success', started_at: '2026-11-09T17:08:58Z' },  // latest real evaluation
    { status: 'completed', conclusion: 'skipped', started_at: '2026-11-09T17:14:43Z' },
  ];
  assert.equal(pickAuthoritativeGuardRun(runs).conclusion, 'success');
});

test('pickAuthoritativeGuardRun: all runs skipped -> falls back to the latest skip (still correctly fail-closed)', () => {
  const runs = [
    { status: 'completed', conclusion: 'skipped', started_at: '2026-11-09T17:00:00Z' },
    { status: 'completed', conclusion: 'skipped', started_at: '2026-11-09T17:14:43Z' },
  ];
  const r = pickAuthoritativeGuardRun(runs);
  assert.equal(r.conclusion, 'skipped');
  assert.equal(r.started_at, '2026-11-09T17:14:43Z');
});

test('pickAuthoritativeGuardRun: empty/null input returns null', () => {
  assert.equal(pickAuthoritativeGuardRun([]), null);
  assert.equal(pickAuthoritativeGuardRun(null), null);
  assert.equal(pickAuthoritativeGuardRun(undefined), null);
});

test('fetchGuardRun: a later ci.yml merge_group skip does not shadow an earlier t1-approval-guard.yml success (live #4694 shape), real argv still has -X GET', () => {
  const calls = [];
  const fakeGh = (args) => {
    calls.push(args);
    const joined = args.join(' ');
    if (joined.includes('check-runs') && joined.includes('t1-approval-guard')) {
      return JSON.stringify({ check_runs: [
        // The REAL gate (t1-approval-guard.yml), finished first.
        { status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, started_at: '2026-11-09T17:08:58Z' },
        // ci.yml's co-located merge_group-only job, finished later on this ordinary PR run,
        // legitimately skipped since github.event_name != 'merge_group'.
        { status: 'completed', conclusion: 'skipped', app: { slug: 'github-actions' }, started_at: '2026-11-09T17:14:43Z' },
      ] });
    }
    throw new Error(`unexpected gh call: ${joined}`);
  };
  const result = fetchGuardRun('o/r', 'abc123', fakeGh);
  assert.equal(result.lookupError, false);
  assert.equal(result.run.conclusion, 'success');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('-X'), 'argv must include -X GET, not just -F (t/4939 regression)');
  assert.ok(calls[0].includes('GET'), 'argv must include -X GET, not just -F (t/4939 regression)');
});

// t/4939 live incident (Lead, p/648#361): `enqueue-pr.mjs:154`/`:167` passed `-F check_name=X`
// with no `-X GET` -- any `-F`/`-f` flag makes `gh api` default to POST, which 404s a GET-only
// route. Every prior test mocked `ghFn` without checking the ARGV it was called with, so this
// shipped silently and blocked every T1 enqueue (fail-closed, but still blocked real work).

test('fetchGuardRun: the real argv passed to ghFn includes -X GET (t/4939 regression guard)', () => {
  const calls = [];
  const fakeGh = (args) => {
    calls.push(args);
    return JSON.stringify({ check_runs: [
      { status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, started_at: '2026-11-09T00:00:00Z' },
    ] });
  };
  const result = fetchGuardRun('o/r', 'abc123', fakeGh);
  assert.equal(calls.length, 1);
  const xIndex = calls[0].indexOf('-X');
  assert.notEqual(xIndex, -1, `expected -X in argv, got: ${JSON.stringify(calls[0])}`);
  assert.equal(calls[0][xIndex + 1], 'GET', `expected -X GET, got: ${JSON.stringify(calls[0])}`);
  assert.equal(result.run?.conclusion, 'success');
});

test('classifyGhApiError: a 404 is not_found (fail, not skip -- TL, p/648#363)', () => {
  assert.equal(classifyGhApiError(new Error('gh: Not Found (HTTP 404)')), 'not_found');
});

test('classifyGhApiError: a 5xx is server_error (skip, not fail -- a GitHub blip must never red the gate)', () => {
  assert.equal(classifyGhApiError({ stderr: 'HTTP 503 Service Unavailable' }), 'server_error');
  assert.equal(classifyGhApiError({ stderr: 'HTTP 500 Internal Server Error' }), 'server_error');
});

test('classifyGhApiError: a network failure is network_error (skip, not fail)', () => {
  assert.equal(classifyGhApiError(new Error('could not resolve host: api.github.com')), 'network_error');
  assert.equal(classifyGhApiError(new Error('connect ECONNREFUSED 140.82.112.6:443')), 'network_error');
});

test('classifyGhApiError: anything else (including an unparseable response shape) is unknown (fail)', () => {
  assert.equal(classifyGhApiError(new Error('Unexpected token W in JSON at position 0')), 'unknown');
  assert.equal(classifyGhApiError(undefined), 'unknown');
});

// LIVE, read-only (TL ask, p/648#362/#363): exercises the REAL `gh` binary against a fixed,
// known commit -- #4675's own HEAD sha (never its squash-merge commit, which carries no
// check-run of its own -- checks run against the PR's head, not the synthetic merge commit) --
// to prove the actual invocation (not a mock) returns a run, not a 404. Skips (never fails)
// when no token is available, or on a transient network/5xx; only a 404 or an unparseable
// shape fails, since that is exactly the class of regression this incident was.
test('fetchGuardRun: LIVE call against a fixed known commit (#4675 head SHA) returns a real run', (t) => {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    t.skip('GH_TOKEN/GITHUB_TOKEN not set in this environment -- skipping the live gh api call');
    return;
  }
  const KNOWN_SHA = 'f505537d90ca7cd3e0aa79dccb23aaea1cb0db90'; // #4675's own head SHA (t/4939), NOT its merge commit d0b4ee2b8
  // Quality nit (p/780#35): prefer the runner-provided slug (GITHUB_REPOSITORY, set by Actions)
  // over the hard-coded one, given the org move (e/293) -- falls back to the hard-coded slug
  // when run locally, where that env var isn't set.
  const REPO = process.env.GITHUB_REPOSITORY || 'AI-Rosetta-Stone/ai-triad-research';
  const result = fetchGuardRun(REPO, KNOWN_SHA);
  if (result.lookupError) {
    const cls = classifyGhApiError(result.error);
    if (cls === 'network_error' || cls === 'server_error') {
      t.skip(`transient (${cls}), not a regression: ${result.error?.message ?? result.error}`);
      return;
    }
    assert.fail(`fetchGuardRun failed with a non-transient error (${cls}): ${result.error?.message ?? result.error}`);
  }
  assert.ok(result.run, 'expected a real t1-approval-guard run on the known commit, got none');
  assert.equal(result.run.app?.slug, 'github-actions');
});
