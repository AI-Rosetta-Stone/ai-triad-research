// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Run: node --test operations/devops/t1-enqueue-sweep.test.mjs
// t/455 (TL p/9#276): the T1 approval requirement is removed. A green T1 PR enqueues on CI and
// branch protection alone. These tests prove the selection no longer reads an approval, and that
// the shared refusals still apply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectT1Candidates, declaresT1, sweep, parseCliArgs } from './t1-enqueue-sweep.mjs';

const HEAD = 'head2222';
const start = '2026-11-15T10:00:00Z';
const green = (over = {}) => ['ci-gate', 'CodeQL Analysis', 'joint-gv-guard', 'consult-hold-guard']
  .map((name) => ({ name, status: 'COMPLETED', conclusion: over[name] ?? 'SUCCESS', startedAt: start }));
const pr = (over = {}) => ({
  number: 1, body: 'Tier: T1\n\nA cross-role contract.', headRefOid: HEAD, headRefName: 'devops/t455-x',
  baseRefName: 'main', isDraft: false, isInMergeQueue: false, mergeStateStatus: 'CLEAN', author: 'ai-triad-author-jpsnover',
  labels: [], isCrossRepository: false, autoMergeRequest: null, contexts: green(),
  reviewDataError: false, files: ['operations/devops/x.mjs'], reviews: [], comments: [], queueEvents: [],
  ...over,
});

test('t/455: a green T1 PR with NO approval of any kind is selected to enqueue', () => {
  const { enqueue, skip } = selectT1Candidates([pr()]);
  assert.deepEqual(skip, []);
  assert.deepEqual(enqueue.map((p) => p.number), [1]);
});

test('t/455: a T1 PR with a stale or comment-only approval is still selected (no approval is read)', () => {
  const { enqueue } = selectT1Candidates([pr({ comments: [{ body: 'Approved (Quality): old', login: 'x' }] })]);
  assert.deepEqual(enqueue.map((p) => p.number), [1]);
});

test('a T1 PR whose required check is red is skipped (shared check still applies)', () => {
  const { enqueue, skip } = selectT1Candidates([pr({ contexts: green({ 'ci-gate': 'FAILURE' }) })]);
  assert.deepEqual(enqueue, []);
  assert.equal(skip.length, 1);
});

test('a draft T1 PR is skipped', () => {
  const { enqueue } = selectT1Candidates([pr({ isDraft: true })]);
  assert.deepEqual(enqueue, []);
});

test('a PR that declares T0 is not a T1 candidate', () => {
  const { enqueue, skip } = selectT1Candidates([pr({ body: 'Tier: T0\n\nDocs.' })]);
  assert.deepEqual(enqueue, []);
  assert.match(skip[0].reason, /not declared Tier: T1/);
});

test('a consult-hold label keeps a T1 PR out (shared label refusal still applies)', () => {
  const { enqueue } = selectT1Candidates([pr({ labels: ['consult-hold'] })]);
  assert.deepEqual(enqueue, []);
});

test('declaresT1 reads the first non-empty line only', () => {
  assert.equal(declaresT1('Tier: T1\n\nx'), true);
  assert.equal(declaresT1('Some text\nTier: T1'), false);
});

test('parseCliArgs: --enqueue and --dry-run are the only gates; no nudge flags remain', () => {
  assert.deepEqual(parseCliArgs(['o/r', '--enqueue']), { repo: 'o/r', dryRun: false, enqueueEnabled: true });
  assert.deepEqual(parseCliArgs(['o/r']), { repo: 'o/r', dryRun: false, enqueueEnabled: false });
  assert.equal(parseCliArgs(['o/r', '--dry-run', '--enqueue']).dryRun, true);
});

test('sweep with the enqueue gate off only reports: it enqueues nothing', async () => {
  const outcomes = await sweep('o/r', {
    enqueueEnabled: false,
    deps: { list: () => [pr()], enqueueDeps: { fail: true } },
  });
  assert.deepEqual(outcomes, {});
});

test('sweep with --enqueue passes the pinned head to enqueueOne', async () => {
  const seen = [];
  const enqueueDeps = {
    readLive: () => ({ state: 'OPEN', headRefOid: HEAD, autoMergeRequest: null, isInMergeQueue: false }),
    enqueue: async (repo, number, opts) => { seen.push({ number, opts }); return { ok: true, state: 'queued' }; },
    ghFn: () => '',
  };
  const outcomes = await sweep('o/r', { enqueueEnabled: true, deps: { list: () => [pr()], enqueueDeps } });
  assert.equal(outcomes[1], 'enqueued');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].opts, { expectedHeadOid: HEAD });
});
