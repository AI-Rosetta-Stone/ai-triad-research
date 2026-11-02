// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Run: node --test operations/devops/dependabot-enqueue-sweep.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkVerdict, selectSweepCandidates } from './dependabot-enqueue-sweep.mjs';

const green = [
  { name: 'ci-gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { name: 'CodeQL Analysis', status: 'COMPLETED', conclusion: 'SUCCESS' },
];
const pr = (over = {}) => ({
  number: 1, headRefOid: 'abc', isDraft: false, isInMergeQueue: false,
  mergeStateStatus: 'BLOCKED', autoMergeRequest: { enabledAt: 't' }, contexts: green, ...over,
});

test('checkVerdict: success, failed, pending, missing', () => {
  assert.equal(checkVerdict(green, 'ci-gate'), 'success');
  assert.equal(checkVerdict([{ name: 'ci-gate', status: 'COMPLETED', conclusion: 'FAILURE' }], 'ci-gate'), 'failed');
  assert.equal(checkVerdict([{ name: 'ci-gate', status: 'IN_PROGRESS', conclusion: null }], 'ci-gate'), 'pending');
  assert.equal(checkVerdict([], 'ci-gate'), 'missing');
});

test('checkVerdict: a successful rerun after a failure counts as success', () => {
  const runs = [
    { name: 'ci-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
    { name: 'ci-gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ];
  assert.equal(checkVerdict(runs, 'ci-gate'), 'success');
});

test('checkVerdict: a rerun still in progress is pending even if an earlier run passed', () => {
  const runs = [
    { name: 'ci-gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'ci-gate', status: 'QUEUED', conclusion: null },
  ];
  assert.equal(checkVerdict(runs, 'ci-gate'), 'pending');
});

test('checkVerdict: reads commit-status contexts (context/state) too', () => {
  assert.equal(checkVerdict([{ context: 'ci-gate', state: 'SUCCESS' }], 'ci-gate'), 'success');
  assert.equal(checkVerdict([{ context: 'ci-gate', state: 'PENDING' }], 'ci-gate'), 'pending');
});

test('selectSweepCandidates: armed, green, unqueued PR is enqueued at its head', () => {
  const { enqueue, skip } = selectSweepCandidates([pr()]);
  assert.deepEqual(enqueue, [{ number: 1, headRefOid: 'abc' }]);
  assert.deepEqual(skip, []);
});

test('selectSweepCandidates: skips each disqualifying state with a reason', () => {
  const { enqueue, skip } = selectSweepCandidates([
    pr({ number: 2, isInMergeQueue: true }),
    pr({ number: 3, isDraft: true }),
    pr({ number: 4, autoMergeRequest: null }),
    pr({ number: 5, mergeStateStatus: 'DIRTY' }),
    pr({ number: 6, contexts: [green[0]] }),
    pr({ number: 7, contexts: [{ name: 'ci-gate', status: 'COMPLETED', conclusion: 'FAILURE' }, green[1]] }),
  ]);
  assert.deepEqual(enqueue, []);
  assert.deepEqual(skip.map((s) => s.number), [2, 3, 4, 5, 6, 7]);
  assert.match(skip.find((s) => s.number === 4).reason, /minor\/patch policy/);
  assert.match(skip.find((s) => s.number === 6).reason, /CodeQL Analysis is missing/);
  assert.match(skip.find((s) => s.number === 7).reason, /ci-gate is failed/);
});
