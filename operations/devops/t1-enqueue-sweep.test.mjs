// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Run: node --test operations/devops/t1-enqueue-sweep.test.mjs
// Gate-signal proof for the T1 auto-enqueue arm (t/73, Orca t/4820): the pass arm and every
// refusal arm run against the real selection code (selectT1Candidates, which calls the shared
// sharedSkipReason and approvalAtHeadVerdict), and the shim tests run the real sweep ->
// enqueueOne path with only GitHub I/O faked.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { selectT1Candidates, declaresT1, headBoundApprover, sweep, GUARD_APPROVED_SUMMARY } from './t1-enqueue-sweep.mjs';
import { selectT0Candidates } from './t0-enqueue-sweep.mjs';
import { fetchGuardRun } from './t1-approval-at-head.mjs';

const HEAD = 'head2222';
const OLD_HEAD = 'head1111';
const REVIEWER = 'ai-triad-reviewer-jpsnover';
const start = '2026-11-09T10:00:00Z';
const green = (over = {}) => ['ci-gate', 'CodeQL Analysis', 'joint-gv-guard', 'consult-hold-guard']
  .map((name) => ({ name, status: 'COMPLETED', conclusion: over[name] ?? 'SUCCESS', startedAt: start }));
const guardOk = (over = {}) => ({
  lookupError: false,
  run: {
    status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, started_at: '2026-11-09T10:30:00Z',
    output: { title: 't1-approval-guard: OK', summary: GUARD_APPROVED_SUMMARY }, ...over,
  },
});
const approvalAt = (commitId, role = 'Quality') => ({
  body: `Approved (${role}): at ${commitId}.`, login: REVIEWER, commitId, submittedAt: '2026-11-09T10:29:00Z',
});
const pr = (over = {}) => ({
  number: 1, body: 'Tier: T1\n\nA cross-role contract.', headRefOid: HEAD, headRefName: 'devops/t73-x',
  baseRefName: 'main', isDraft: false, isInMergeQueue: false, mergeStateStatus: 'BLOCKED', author: 'ai-triad-author-jpsnover',
  labels: [], isCrossRepository: false, autoMergeRequest: null, contexts: green(),
  reviewDataError: false, files: ['operations/devops/x.mjs'], reviews: [approvalAt(HEAD)], comments: [], queueEvents: [],
  guard: guardOk(), ...over,
});
const only = (p) => selectT1Candidates([p]);
const skipReason = (p) => {
  const { enqueue, skip } = only(p);
  assert.deepEqual(enqueue, [], 'must NOT enqueue');
  return skip[0].reason;
};

// ---- pass arm ----
test('PASS: an approved T1 PR at its head with green ci-gate and all required contexts is enqueued', () => {
  const { enqueue, skip } = only(pr());
  assert.deepEqual(skip, []);
  assert.deepEqual(enqueue, [{ number: 1, headRefOid: HEAD, armed: false }]);
});

// Real fetchGuardRun (the same one enqueue-pr.mjs uses), with only the gh CLI faked.
const guardFrom = (runs) => fetchGuardRun('o/r', HEAD, () => JSON.stringify({ check_runs: runs }));
const run = (conclusion, startedAt, over = {}) => ({
  status: 'completed', conclusion, app: { slug: 'github-actions' }, started_at: startedAt,
  output: { summary: conclusion === 'success' ? GUARD_APPROVED_SUMMARY : null }, ...over,
});

test('PASS: guard runs [success, later ci.yml merge_group skip] -- the live #4730 shape -- is enqueued', () => {
  const guard = guardFrom([run('success', '2026-11-09T23:23:06Z'), run('skipped', '2026-11-09T23:29:34Z')]);
  assert.equal(only(pr({ guard })).enqueue.length, 1);
});

test('REFUSE: guard runs [success (older), failure (newer)] at the same head -- the latest non-skipped run wins', () => {
  const guard = guardFrom([run('success', '2026-11-09T10:00:00Z'), run('failure', '2026-11-09T10:05:00Z')]);
  assert.equal(skipReason(pr({ guard })), 't1-approval-guard at head is failure');
});

// ---- refusal arms ----
test('REFUSE: stale-head approval (review bound to the previous head) is not enqueued even though the guard says success', () => {
  // The committer-date gap: the guard passed at the new head, but the only approval is on the old one.
  assert.match(skipReason(pr({ reviews: [approvalAt(OLD_HEAD)] })), /no reviewer-App approval review bound to the current head SHA/);
});

test('REFUSE: a comment-only approval (not bound to a SHA) is not auto-enqueued', () => {
  const comment = { body: 'Approved (Quality): looks good', login: REVIEWER, createdAt: '2026-11-09T11:00:00Z', updatedAt: null };
  assert.match(skipReason(pr({ reviews: [], comments: [comment] })), /bound to the current head SHA/);
});

test('REFUSE: self-approval (the branch owner role approving its own devops/ branch) is not enqueued', () => {
  assert.match(skipReason(pr({ reviews: [approvalAt(HEAD, 'DevOps Lead')] })), /bound to the current head SHA/);
});

test('REFUSE: an approval from a human or another App login is ignored', () => {
  assert.match(skipReason(pr({ reviews: [{ ...approvalAt(HEAD), login: 'someone' }] })), /bound to the current head SHA/);
});

test('REFUSE: red ci-gate is not enqueued', () => {
  assert.equal(skipReason(pr({ contexts: green({ 'ci-gate': 'FAILURE' }) })), 'ci-gate is failed');
});

test('REFUSE: pending ci-gate and missing CodeQL Analysis are not enqueued', () => {
  const pending = green().map((c) => (c.name === 'ci-gate' ? { ...c, status: 'IN_PROGRESS', conclusion: null } : c));
  assert.equal(skipReason(pr({ contexts: pending })), 'ci-gate is pending');
  assert.equal(skipReason(pr({ contexts: green().filter((c) => c.name !== 'CodeQL Analysis') })), 'CodeQL Analysis is missing');
});

for (const label of ['no-auto-enqueue', 'consult-hold', 'joint-gv']) {
  test(`REFUSE: a PR labelled ${label} is not enqueued`, () => {
    assert.equal(skipReason(pr({ labels: [label] })), `label ${label}`);
  });
}

test('REFUSE: a draft is not enqueued', () => {
  assert.equal(skipReason(pr({ isDraft: true })), 'draft');
});

test('REFUSE (idempotency): a PR already in the merge queue is not enqueued again', () => {
  assert.equal(skipReason(pr({ isInMergeQueue: true })), 'already in merge queue');
});

test('REFUSE: unapproved T1 (guard failure) is not enqueued', () => {
  assert.equal(skipReason(pr({ guard: guardOk({ conclusion: 'failure' }) })), 't1-approval-guard at head is failure');
});

test('REFUSE: guard missing, in progress, or from a non-github-actions App is not enqueued', () => {
  assert.equal(skipReason(pr({ guard: { run: null, lookupError: false } })), 't1-approval-guard at head is missing');
  assert.equal(skipReason(pr({ guard: guardOk({ status: 'in_progress', conclusion: null }) })), 't1-approval-guard at head is in_progress');
  assert.equal(skipReason(pr({ guard: guardOk({ app: { slug: 'other-app' } }) })), 't1-approval-guard at head is missing');
});

test('REFUSE: a guard lookup error, or no guard read at all, fails closed', () => {
  assert.match(skipReason(pr({ guard: { run: null, lookupError: true } })), /^WARN: could not look up t1-approval-guard/);
  assert.match(skipReason(pr({ guard: undefined })), /^WARN: could not look up t1-approval-guard/);
});

test('REFUSE: guard success whose summary is "not a T1 PR" fails closed', () => {
  assert.match(skipReason(pr({ guard: guardOk({ output: { summary: 'not a T1 PR' } }) })), /summary is "not a T1 PR"/);
});

test('REFUSE: an active changes-request from another role at the head blocks, even with a Quality approval', () => {
  const cr = { body: 'Changes requested (Design): fix the layout.', login: REVIEWER, commitId: HEAD, submittedAt: '2026-11-09T10:31:00Z' };
  assert.equal(skipReason(pr({ reviews: [approvalAt(HEAD), cr] })), 'changes requested by Design');
});

test('REFUSE: fork PRs and unknown fork status are not enqueued', () => {
  assert.match(skipReason(pr({ isCrossRepository: true })), /^fork PR/);
  assert.match(skipReason(pr({ isCrossRepository: undefined })), /^fork PR/);
});

test('REFUSE: a manual dequeue with nothing pushed since holds the PR', () => {
  const queueEvents = [{ type: 'RemovedFromMergeQueueEvent', createdAt: '2026-11-09T11:00:00Z', reason: 'manual', actor: 'x' }];
  assert.match(skipReason(pr({ queueEvents })), /^WARN: manually dequeued/);
});

// ---- non-T1 paths untouched ----
test('non-T1: T0, T2, no tier and Dependabot bodies are all skipped as not declared Tier: T1', () => {
  for (const body of ['Tier: T0\nx', 'Tier: T2\nx', 'no tier here', '']) {
    assert.equal(skipReason(pr({ body })), 'not declared Tier: T1');
  }
  assert.equal(skipReason(pr({ author: 'dependabot[bot]' })), 'Dependabot PR (handled by dependabot-enqueue-sweep)');
});

test('non-T1: the T0 sweep still ignores this approved T1 PR, and still enqueues a green idle T0 PR', () => {
  const t0 = pr({ number: 2, body: 'Tier: T0\nx', reviews: [], guard: undefined });
  const { enqueue, skip } = selectT0Candidates([pr(), t0], Date.parse('2026-11-09T12:00:00Z'));
  assert.deepEqual(enqueue, [{ number: 2, headRefOid: HEAD, armed: false }]);
  assert.deepEqual(skip, [{ number: 1, reason: 'not declared Tier: T0' }]);
});

test('declaresT1 uses the guard parser: first line only, exact tier', () => {
  assert.equal(declaresT1('Tier: T1\nmore'), true);
  assert.equal(declaresT1('\n  tier: t1'), true);
  assert.equal(declaresT1('Tier: T0\nTier: T1'), false);
  assert.equal(declaresT1('Tier: T12'), false);
});

test('headBoundApprover names the head-bound non-self role', () => {
  assert.equal(headBoundApprover(pr()), 'Quality');
  assert.equal(headBoundApprover(pr({ reviews: [approvalAt(OLD_HEAD)] })), null);
});

// ---- shim: real sweep -> enqueueOne, GitHub I/O faked ----
function harness({ listed, live }) {
  const calls = { enqueue: [], gh: [], guard: [] };
  const deps = {
    list: () => listed.map((p) => ({ ...p })),
    fetchGuard: (repo, sha) => { calls.guard.push(sha); return guardOk(); },
    enqueueDeps: {
      readLive: () => live,
      enqueue: async (repo, n, opts) => { calls.enqueue.push({ n, opts }); return { ok: true, state: 'queued' }; },
      ghFn: (args) => { calls.gh.push(args); return ''; },
    },
  };
  return { calls, deps };
}

const quiet = () => [mock.method(console, 'log', () => {}), mock.method(console, 'warn', () => {})];

test('shim: an approved T1 PR is enqueued once, pinned to the approved head (expectedHeadOid)', async () => {
  const mocks = quiet();
  try {
    const { calls, deps } = harness({ listed: [pr()], live: { state: 'OPEN', isInMergeQueue: false, isDraft: false, headRefOid: HEAD } });
    const out = await sweep('o/r', { deps });
    assert.deepEqual(out, { 1: 'enqueued' });
    assert.deepEqual(calls.enqueue, [{ n: 1, opts: { expectedHeadOid: HEAD } }]);
    assert.deepEqual(calls.guard, [HEAD]);
  } finally { mocks.forEach((m) => m.mock.restore()); }
});

test('shim idempotency: a second sweep after the PR is queued makes no enqueue call', async () => {
  const mocks = quiet();
  try {
    const { calls, deps } = harness({ listed: [pr({ isInMergeQueue: true })], live: null });
    assert.deepEqual(await sweep('o/r', { deps }), {});
    assert.equal(calls.enqueue.length, 0);
  } finally { mocks.forEach((m) => m.mock.restore()); }
});

test('shim idempotency: search lag says unqueued but the live read says merged or queued -> no enqueue, no failure', async () => {
  const mocks = quiet();
  try {
    for (const live of [
      { state: 'MERGED', isInMergeQueue: false, isDraft: false, headRefOid: HEAD },
      { state: 'OPEN', isInMergeQueue: true, isDraft: false, headRefOid: HEAD },
    ]) {
      const { calls, deps } = harness({ listed: [pr()], live });
      assert.deepEqual(await sweep('o/r', { deps }), { 1: 'skipped' });
      assert.equal(calls.enqueue.length, 0);
    }
  } finally { mocks.forEach((m) => m.mock.restore()); }
});

test('shim: head moved between listing and enqueue -> no enqueue', async () => {
  const mocks = quiet();
  try {
    const { calls, deps } = harness({ listed: [pr()], live: { state: 'OPEN', isInMergeQueue: false, isDraft: false, headRefOid: 'newhead' } });
    assert.deepEqual(await sweep('o/r', { deps }), { 1: 'skipped' });
    assert.equal(calls.enqueue.length, 0);
  } finally { mocks.forEach((m) => m.mock.restore()); }
});

test('shim: the guard is fetched only for T1 PRs; T0 PRs are not touched', async () => {
  const mocks = quiet();
  try {
    const { calls, deps } = harness({ listed: [pr({ number: 3, body: 'Tier: T0\nx', guard: undefined })], live: null });
    assert.deepEqual(await sweep('o/r', { deps }), {});
    assert.deepEqual(calls.guard, []);
    assert.equal(calls.enqueue.length, 0);
  } finally { mocks.forEach((m) => m.mock.restore()); }
});
