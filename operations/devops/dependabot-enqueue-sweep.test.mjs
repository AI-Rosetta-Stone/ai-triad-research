// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Run: node --test operations/devops/dependabot-enqueue-sweep.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkVerdict, classifyEnqueueFailure, selectSweepCandidates, normalizePR, pendingCheckNames, sweep } from './dependabot-enqueue-sweep.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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

test('pendingCheckNames: lists every run not yet finished, required or not (t/403)', () => {
  assert.deepEqual(pendingCheckNames(green), []);
  assert.deepEqual(pendingCheckNames([...green, { name: 'Stray File Guard', status: 'IN_PROGRESS', conclusion: null }]), ['Stray File Guard']);
  assert.deepEqual(pendingCheckNames([{ context: 'docs-lint', state: 'PENDING' }]), ['docs-lint']);
  assert.deepEqual(pendingCheckNames([{ name: 'x', status: 'QUEUED', conclusion: null }]), ['x']);
});

test('selectSweepCandidates: a green PR with a non-required check still running is not armed (t/403)', () => {
  const contexts = [...green, { name: 'Stray File Guard', status: 'IN_PROGRESS', conclusion: null }];
  const { enqueue, skip } = selectSweepCandidates([pr({ contexts })]);
  assert.deepEqual(enqueue, []);
  assert.match(skip[0].reason, /^1 check\(s\) still running \(Stray File Guard\)/);
});

// ── t/600 (incident #5509): a refused Dependabot PR is never re-armed; only a transient failure retries ──

const GREEN_PR = {
  number: 77, headRefOid: 'a'.repeat(40), isDraft: false, isInMergeQueue: false, mergeStateStatus: 'CLEAN',
  autoMergeRequest: { enabledAt: 'x' }, isCrossRepository: false, author: { typename: 'Bot', login: 'dependabot' },
  contexts: [{ name: 'ci-gate', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'CodeQL Analysis', status: 'COMPLETED', conclusion: 'SUCCESS' }],
};
function harness(enqueueImpl) {
  const calls = { gh: [], enqueue: 0, sleeps: [] };
  const deps = {
    list: () => [GREEN_PR],
    readLive: () => ({ state: 'OPEN', isInMergeQueue: false, isDraft: false, headRefOid: GREEN_PR.headRefOid }),
    gh: (args) => {
      calls.gh.push(args);
      if (args.join(' ').includes('pullRequest(number')) return JSON.stringify({ data: { repository: { pullRequest: { id: 'PR_1', autoMergeRequest: { enabledAt: 'x' } } } } });
      return '{}';
    },
    enqueue: async (...a) => { calls.enqueue++; return enqueueImpl(calls.enqueue, ...a); },
    sleep: async (ms) => { calls.sleeps.push(ms); },
  };
  return { calls, deps };
}
const refusal = (reason) => new Error(`enqueue-pr: refusing to arm/enqueue #77 on o/r (${reason}).\n  Goal: …`);
const quietly = async (fn) => {
  const o = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, o); }
};

test('t/600: classifyEnqueueFailure: every enqueue-pr refusal is policy; anything else is transient', () => {
  for (const r of ['gate_files_no_override', 'over_budget_today', 'no_approval', 'no_auto_enqueue', 'differs']) {
    assert.deepEqual(classifyEnqueueFailure(refusal(r)), { kind: 'policy', reason: r });
  }
  assert.equal(classifyEnqueueFailure(new Error('gh: HTTP 502')).kind, 'transient');
  assert.equal(classifyEnqueueFailure(new Error('still not enqueued after the GraphQL fallback')).kind, 'transient');
});

test('t/600: a POLICY refusal leaves the PR unarmed: no retry, no re-arm, no `gh pr merge` of any kind', async () => {
  for (const reason of ['gate_files_no_override', 'over_budget_today', 'no_approval']) {
    const { calls, deps } = harness(() => { throw refusal(reason); });
    await assert.rejects(() => quietly(() => sweep('o/r', { deps })), /did not enqueue #77/);
    assert.equal(calls.enqueue, 1, `${reason}: enqueue is tried once and never retried`);
    assert.deepEqual(calls.sleeps, [], reason);
    assert.ok(calls.gh.every((a) => !(a[0] === 'pr' && a[1] === 'merge')), `${reason}: no gh pr merge (re-arm or otherwise)`);
    assert.ok(calls.gh.some((a) => a.join(' ').includes('disablePullRequestAutoMerge')), `${reason}: the policy arm was removed through GraphQL`);
  }
});

test('t/600: a TRANSIENT failure retries once through enqueue-pr; a second failure leaves it unarmed too', async () => {
  const ok = harness((n) => { if (n === 1) throw new Error('gh: HTTP 502'); return { usedFallback: false, state: 'queued' }; });
  const r = await quietly(() => sweep('o/r', { deps: ok.deps }));
  assert.equal(r.enqueued, 1); assert.equal(ok.calls.enqueue, 2); assert.deepEqual(ok.calls.sleeps, [10000]);
  const bad = harness(() => { throw new Error('gh: HTTP 502'); });
  await assert.rejects(() => quietly(() => sweep('o/r', { deps: bad.deps })), /did not enqueue #77/);
  assert.equal(bad.calls.enqueue, 2);
  assert.ok(bad.calls.gh.every((a) => !(a[0] === 'pr' && a[1] === 'merge')));
  const refusedOnRetry = harness((n) => { if (n === 1) throw new Error('gh: HTTP 502'); throw refusal('gate_files_no_override'); });
  await assert.rejects(() => quietly(() => sweep('o/r', { deps: refusedOnRetry.deps })), /did not enqueue #77/);
  assert.equal(refusedOnRetry.calls.enqueue, 2);
});

test('t/600 pin (Security p/131#66): no `gh pr merge` is INVOKED outside enqueue-pr.mjs in operations/devops or .github', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
  const files = execFileSync('git', ['ls-files', 'operations/devops', '.github'], { cwd: root, encoding: 'utf8' }).split('\n')
    .filter((f) => /\.(mjs|js|cjs|sh|ps1|ya?ml)$/.test(f) && !/\.test\.mjs$|\.Tests\.ps1$|test-[^/]*\.sh$/.test(f));
  // Allowed: the wrapper itself, and dependabot-auto-merge.yml's GITHUB_TOKEN policy-marker arm, which
  // never enters the queue (t/600: GitHub doesn't start queue entry for a GITHUB_TOKEN arm; the sweep
  // removes it with GraphQL before enqueue-pr.mjs arms as the App).
  const allowed = new Set(['operations/devops/enqueue-pr.mjs', '.github/workflows/dependabot-auto-merge.yml']);
  const offenders = [];
  for (const f of files) {
    if (allowed.has(f)) continue;
    const lines = fs.readFileSync(path.join(root, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const code = line.replace(/^\s*(#|\/\/|\*).*$/, '');
      if (/['"]pr['"]\s*,\s*['"]merge['"]/.test(code)) offenders.push(`${f}:${i + 1}`); // execFile-style argv
      if (/^\s*(run:\s*)?gh\s+pr\s+merge\b/.test(code) || /[;&|]\s*gh\s+pr\s+merge\b/.test(code)) offenders.push(`${f}:${i + 1}`); // shell invocation
    });
  }
  assert.deepEqual(offenders, []);
});
