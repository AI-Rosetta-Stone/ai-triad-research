// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Run: node --test operations/devops/t0-enqueue-sweep.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declaresT0, headPushedAt, manualDequeueHold, selectT0Candidates, planNextWake, IDLE_MINUTES } from './t0-enqueue-sweep.mjs';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();
const greenAt = (start) => ['ci-gate', 'CodeQL Analysis', 'joint-gv-guard', 'consult-hold-guard']
  .map((name) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: start }));
const pr = (over = {}) => ({
  number: 1, body: 'Tier: T0\n\nFix a thing.', headRefOid: 'abc', baseRefName: 'main', isDraft: false,
  isInMergeQueue: false, mergeStateStatus: 'BLOCKED', author: 'jpsnover', labels: [],
  isCrossRepository: false, autoMergeRequest: null, contexts: greenAt(minsAgo(20)), ...over,
});

test('a fork PR is never enqueued, even green, idle and declaring Tier: T0 (public repo, no required review)', () => {
  const { enqueue, skip } = selectT0Candidates([pr({ number: 7, isCrossRepository: true, author: 'outsider' })], NOW);
  assert.deepEqual(enqueue, []);
  assert.match(skip[0].reason, /^fork PR/);
});

test('fails closed: a PR whose fork status is unknown is treated as a fork', () => {
  const { enqueue, skip } = selectT0Candidates([pr({ number: 8, isCrossRepository: undefined })], NOW);
  assert.deepEqual(enqueue, []);
  assert.match(skip[0].reason, /^fork PR/);
});

test('declaresT0 reads only the first non-empty line', () => {
  assert.equal(declaresT0('Tier: T0\nmore'), true);
  assert.equal(declaresT0('\n\n  Tier: T0'), true);
  assert.equal(declaresT0('tier: t0'), true);
  assert.equal(declaresT0('Tier: T1\nTier: T0'), false);
  assert.equal(declaresT0('Fixes stuff. Tier: T0'), false);
  assert.equal(declaresT0('Tier: T01'), false);
  assert.equal(declaresT0(null), false);
});

test('headPushedAt is the earliest check-run start, null when none', () => {
  const ctx = [{ startedAt: minsAgo(5) }, { startedAt: minsAgo(30) }, { context: 'x', state: 'SUCCESS' }];
  assert.equal(headPushedAt(ctx), NOW - 30 * 60000);
  assert.equal(headPushedAt([{ context: 'x', state: 'SUCCESS' }]), null);
});

test('a green T0 PR idle past the threshold is enqueued, and an existing arm is reported', () => {
  const { enqueue, skip } = selectT0Candidates([pr(), pr({ number: 2, autoMergeRequest: { enabledAt: 't' } })], NOW);
  assert.deepEqual(enqueue, [
    { number: 1, headRefOid: 'abc', armed: false },
    { number: 2, headRefOid: 'abc', armed: true },
  ]);
  assert.deepEqual(skip, []);
});

test(`a green T0 PR pushed less than ${IDLE_MINUTES} minutes ago waits`, () => {
  const { enqueue, skip } = selectT0Candidates([pr({ contexts: greenAt(minsAgo(IDLE_MINUTES - 1)) })], NOW);
  assert.deepEqual(enqueue, []);
  assert.match(skip[0].reason, /^idle 14m < 15m/);
});

test('skips each disqualifying state with a reason', () => {
  const failingCi = greenAt(minsAgo(20)).map((c) => (c.name === 'ci-gate' ? { ...c, conclusion: 'FAILURE' } : c));
  const cases = [
    [pr({ number: 10, body: 'Tier: T1\n' }), /not declared Tier: T0/],
    [pr({ number: 11, baseRefName: 'epic/x' }), /base is epic\/x/],
    [pr({ number: 12, isDraft: true }), /draft/],
    [pr({ number: 13, isInMergeQueue: true }), /already in merge queue/],
    [pr({ number: 14, author: 'app/dependabot' }), /Dependabot/],
    [pr({ number: 15, labels: ['consult-hold'] }), /label consult-hold/],
    [pr({ number: 16, labels: ['joint-gv'] }), /label joint-gv/],
    [pr({ number: 17, labels: ['no-auto-enqueue'] }), /label no-auto-enqueue/],
    [pr({ number: 18, mergeStateStatus: 'DIRTY' }), /merge conflict/],
    [pr({ number: 19, contexts: failingCi }), /ci-gate is failed/],
    [pr({ number: 20, contexts: greenAt(minsAgo(20)).filter((c) => c.name !== 'consult-hold-guard') }), /consult-hold-guard is missing/],
    [pr({ number: 21, contexts: greenAt(undefined) }), /push time unknown/],
  ];
  const { enqueue, skip } = selectT0Candidates(cases.map(([p]) => p), NOW);
  assert.deepEqual(enqueue, []);
  for (const [p, re] of cases) assert.match(skip.find((s) => s.number === p.number).reason, re, `#${p.number}`);
});

test('only a PR blocked by nothing but the idle window is reported as waiting, with its eligible time', () => {
  const failingCi = greenAt(minsAgo(5)).map((c) => (c.name === 'ci-gate' ? { ...c, conclusion: 'FAILURE' } : c));
  const { enqueue, waiting } = selectT0Candidates([
    pr({ number: 30, contexts: greenAt(minsAgo(5)) }),                 // green, 5m idle -> waiting
    pr({ number: 31, contexts: failingCi }),                            // red -> not waiting
    pr({ number: 32, isDraft: true, contexts: greenAt(minsAgo(5)) }),  // draft -> not waiting
    pr({ number: 33 }),                                                  // green, 20m idle -> enqueue
  ], NOW);
  assert.deepEqual(enqueue.map((e) => e.number), [33]);
  assert.deepEqual(waiting, [{ number: 30, eligibleAt: NOW - 5 * 60000 + IDLE_MINUTES * 60000 }]);
});

test('planNextWake wakes just after the earliest eligible PR, within the deadline', () => {
  const waiting = [{ number: 1, eligibleAt: NOW + 10 * 60000 }, { number: 2, eligibleAt: NOW + 4 * 60000 }];
  assert.equal(planNextWake(waiting, NOW, NOW + 16 * 60000), NOW + 4 * 60000 + 20000);
  assert.equal(planNextWake(waiting, NOW, NOW + 3 * 60000), null, 'past the deadline: stop');
  assert.equal(planNextWake([], NOW, NOW + 16 * 60000), null, 'nothing waiting: stop');
  assert.equal(planNextWake([{ number: 3, eligibleAt: NOW - 60000 }], NOW, NOW + 60000), NOW, 'already eligible: wake now');
});

// t/4879: #4561 was dequeued by hand to push a fix; the sweep re-enqueued it 29s later and
// it merged with the old head. These are the event shapes GitHub returned for #4561.
const added = (m, actor = 'jpsnover') => ({ type: 'AddedToMergeQueueEvent', createdAt: minsAgo(m), reason: null, actor });
const removed = (m, reason, actor = 'jpsnover') => ({ type: 'RemovedFromMergeQueueEvent', createdAt: minsAgo(m), reason, actor });

test('t/4879: a manual dequeue with nothing pushed since is held, with a WARN reason', () => {
  // Head pushed 20m ago, enqueued 18m ago, pulled out by hand 16m ago: green and idle, but held.
  const { enqueue, skip, waiting } = selectT0Candidates([pr({ number: 40, queueEvents: [added(18), removed(16, 'manual')] })], NOW);
  assert.deepEqual(enqueue, []);
  assert.deepEqual(waiting, []);
  assert.match(skip[0].reason, /^WARN: manually dequeued by jpsnover at .* nothing pushed since/);
  assert.deepEqual(manualDequeueHold([removed(16, 'MANUAL')], NOW - 20 * 60000), { removedAt: minsAgo(16), actor: 'jpsnover' },
    'reason is matched case-insensitively');
  assert.notEqual(manualDequeueHold([removed(16, 'manual')], null), null, 'push time unknown fails closed (held)');
});

test('t/4879: a push after the manual dequeue releases the hold', () => {
  // Dequeued 40m ago; the fix was pushed 20m ago (check runs started then).
  const { enqueue } = selectT0Candidates([pr({ number: 41, queueEvents: [added(45), removed(40, 'manual')] })], NOW);
  assert.deepEqual(enqueue.map((e) => e.number), [41]);
});

test('t/4879: non-manual removals and a later manual re-add do not hold', () => {
  const prs = [
    pr({ number: 42, queueEvents: [added(18, 'ai-triad-dependabot-merge'), removed(16, 'merged', 'github-merge-queue')] }),
    pr({ number: 43, queueEvents: [added(18), removed(16, 'failed_checks', 'github-merge-queue')] }),
    pr({ number: 44, queueEvents: [added(18), removed(16, 'manual'), added(15)] }), // re-added by hand, then left again
    pr({ number: 45 }), // no queue history at all
  ];
  const { enqueue } = selectT0Candidates(prs, NOW);
  assert.deepEqual(enqueue.map((e) => e.number), [42, 43, 44, 45]);
});
