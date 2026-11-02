// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Run: node --test operations/devops/t0-enqueue-sweep.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declaresT0, headPushedAt, selectT0Candidates, IDLE_MINUTES } from './t0-enqueue-sweep.mjs';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();
const greenAt = (start) => ['ci-gate', 'CodeQL Analysis', 'joint-gv-guard', 'consult-hold-guard']
  .map((name) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: start }));
const pr = (over = {}) => ({
  number: 1, body: 'Tier: T0\n\nFix a thing.', headRefOid: 'abc', baseRefName: 'main', isDraft: false,
  isInMergeQueue: false, mergeStateStatus: 'BLOCKED', author: 'jpsnover', labels: [],
  autoMergeRequest: null, contexts: greenAt(minsAgo(20)), ...over,
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
