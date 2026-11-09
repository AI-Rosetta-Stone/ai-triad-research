// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4939: converted from vitest (describe/it/expect from 'vitest') to node:test. The file
// imported `vitest`, which isn't installed at the repo root and has no CI wiring anywhere in
// .github/workflows -- `node --test` on this file failed outright before this change. Every
// pre-existing assertion is preserved verbatim; only the test-runner API changed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEnqueueOutcome, formatSilentMissWarning, classifyT1GuardForEnqueue } from './enqueue-pr.mjs';

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
