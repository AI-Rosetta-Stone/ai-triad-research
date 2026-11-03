// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Run: node --test operations/devops/dependabot-enqueue-sweep.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkVerdict, selectSweepCandidates, normalizePR } from './dependabot-enqueue-sweep.mjs';

const green = [
  { name: 'ci-gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { name: 'CodeQL Analysis', status: 'COMPLETED', conclusion: 'SUCCESS' },
];
const pr = (over = {}) => ({
  number: 1, headRefOid: 'abc', isDraft: false, isInMergeQueue: false, isCrossRepository: false,
  author: { typename: 'Bot', login: 'dependabot' },
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
    pr({ number: 2, isCrossRepository: true }),
    pr({ number: 3, author: { typename: 'Bot', login: 'dependabot-helper' } }),
    pr({ number: 4, author: { typename: 'User', login: 'dependabot' } }),
    pr({ number: 5, isInMergeQueue: true }),
    pr({ number: 6, isDraft: true }),
    pr({ number: 7, autoMergeRequest: null }),
    pr({ number: 8, mergeStateStatus: 'DIRTY' }),
    pr({ number: 9, contexts: [green[0]] }),
    pr({ number: 10, contexts: [{ name: 'ci-gate', status: 'COMPLETED', conclusion: 'FAILURE' }, green[1]] }),
  ]);
  assert.deepEqual(enqueue, []);
  assert.deepEqual(skip.map((s) => s.number), [2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.match(skip.find((s) => s.number === 2).reason, /fork PR/);
  assert.match(skip.find((s) => s.number === 3).reason, /author is not Bot\/dependabot/);
  assert.match(skip.find((s) => s.number === 4).reason, /author is not Bot\/dependabot/);
  assert.match(skip.find((s) => s.number === 7).reason, /minor\/patch policy/);
  assert.match(skip.find((s) => s.number === 9).reason, /CodeQL Analysis is missing/);
  assert.match(skip.find((s) => s.number === 10).reason, /ci-gate is failed/);
});

test('selectSweepCandidates: fork PR is never enqueued, even if otherwise fully green and armed', () => {
  const { enqueue, skip } = selectSweepCandidates([pr({ number: 1, isCrossRepository: true })]);
  assert.deepEqual(enqueue, []);
  assert.match(skip[0].reason, /fork PR/);
});

test('selectSweepCandidates: unknown (missing) isCrossRepository fails closed as a fork', () => {
  const { enqueue, skip } = selectSweepCandidates([pr({ number: 1, isCrossRepository: undefined })]);
  assert.deepEqual(enqueue, []);
  assert.match(skip[0].reason, /fork PR/);
});

test('selectSweepCandidates: lookalike author (not exactly Bot/dependabot) is never enqueued', () => {
  const { enqueue, skip } = selectSweepCandidates([pr({ number: 1, author: { typename: 'Bot', login: 'dependabot-helper' } })]);
  assert.deepEqual(enqueue, []);
  assert.match(skip[0].reason, /author is not Bot\/dependabot/);
});

test('selectSweepCandidates: wrong typename (not Bot) is never enqueued', () => {
  const { enqueue, skip } = selectSweepCandidates([pr({ number: 1, author: { typename: 'User', login: 'dependabot' } })]);
  assert.deepEqual(enqueue, []);
  assert.match(skip[0].reason, /author is not Bot\/dependabot/);
});

test('normalizePR: converts GraphQL __typename to typename and enqueues valid Dependabot PR', () => {
  // Verbatim GraphQL shape from #4282 (TL reference)
  const graphqlNode = {
    number: 4282,
    headRefOid: 'abc123',
    isDraft: false,
    isInMergeQueue: false,
    isCrossRepository: false,
    mergeStateStatus: 'BLOCKED',
    autoMergeRequest: { enabledAt: '2026-11-02T00:00:00Z' },
    author: { __typename: 'Bot', login: 'dependabot' },
    commits: {
      nodes: [{
        commit: {
          statusCheckRollup: {
            contexts: {
              nodes: [
                { name: 'ci-gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
                { name: 'CodeQL Analysis', status: 'COMPLETED', conclusion: 'SUCCESS' },
              ],
            },
          },
        },
      }],
    },
  };
  const normalized = normalizePR(graphqlNode);
  const { enqueue, skip } = selectSweepCandidates([normalized]);
  assert.deepEqual(enqueue, [{ number: 4282, headRefOid: 'abc123' }]);
  assert.deepEqual(skip, []);
});
