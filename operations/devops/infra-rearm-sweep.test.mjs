// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/387: which merge-queue ejections get re-armed. Fixtures are shaped on 2026-11-11's real runs
// (render-smoke's Chromium install on the apt DNS outage, t/374; the merge_group guards on the
// installation rate limit, t/313).
// Run: node --test operations/devops/infra-rearm-sweep.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEjection, rearmCount, lastEjection, ejectionsSince, ejectingRun, settledBy, failingStepContext, MAX_PER_HEAD } from './infra-rearm-sweep.mjs';

const job = (name, conclusion, failedStep, annotations = [], log = null) => ({
  name, conclusion, log,
  steps: [{ name: 'Set up job', conclusion: 'success' }, ...(failedStep ? [{ name: failedStep, conclusion: conclusion === 'failure' ? 'failure' : conclusion }] : [])],
  annotations: annotations.map((message) => ({ message })),
});
const GATE = job('ci-gate', 'failure', 'Block on any failed/cancelled gated job', ['Process completed with exit code 1.']);

test('t/374 shape: render-smoke failed installing Chromium (apt DNS), ci-gate red as a consequence: INFRA', () => {
  const v = classifyEjection({ jobs: [job('render-smoke', 'failure', 'Install Chromium (Playwright, pinned @playwright/test 1.60.0)', ['Process completed with exit code 1.'],
    "Err:1 http://security.ubuntu.com/ubuntu noble-security InRelease\n  Temporary failure resolving 'security.ubuntu.com'\nFailed to install browsers"), GATE, job('lint', 'success')] });
  assert.equal(v.infra, true, JSON.stringify(v));
  assert.deepEqual(v.detail.map((d) => d.job), ['render-smoke'], 'ci-gate is an aggregate and carries no cause of its own');
});

test('t/313 shape: a merge_group guard failed on "API rate limit already exceeded": INFRA via its annotation', () => {
  const v = classifyEjection({ jobs: [job('joint-gv-guard', 'failure', 'Enumerate the group and refuse if any PR carries joint-gv',
    ['Process completed with exit code 1.', 'get-merge-group-prs: could NOT read mergeQueue entries for main after 3 attempts -- API/INFRA failure or no queue configured. Last error: gh: API rate limit already exceeded for site ID installation.'])] });
  assert.equal(v.infra, true);
  assert.match(v.detail[0].why, /^annotation: /);
});

test('the agreed guard line (t/369, p/173#1) is INFRA', () => {
  const v = classifyEjection({ jobs: [job('consult-hold-guard', 'failure', 'Refuse merge while a consult-hold label is present',
    ['INFRA rate-limit: GitHub API quota exhausted (pool=core), resets=2026-11-11T14:40:00Z; not a policy verdict, re-run after the reset'])] });
  assert.equal(v.infra, true);
});

for (const [what, j] of [
  ['runner lost', job('test-powershell (3)', 'failure', 'Run Pester', ['The runner has received a shutdown signal.'])],
  ['cancelled job (batch cancelled / runner loss)', job('test-electron', 'cancelled', 'Install dependencies')],
  ['timed out', job('test-container', 'timed_out', 'Build image')],
  ['checkout failed on the network', job('lib-lint', 'failure', 'Run actions/checkout@v6', [], 'fatal: unable to access https://github.com/...: Failed to connect: Connection timed out')],
  ['pnpm install hit ECONNRESET', job('renderer-tsc', 'failure', 'Install dependencies (retry on transient nuget/network failures — t/2968)', [], 'ERR_PNPM_META_FETCH_FAIL GET https://registry.npmjs.org/x: request failed, reason: read ECONNRESET')],
  ['registry 503', job('test-python', 'failure', 'pip install -r requirements.txt', [], 'ERROR: HTTP error 503 while getting https://files.pythonhosted.org/... 503 Service Unavailable')],
]) {
  test(`INFRA: ${what}`, () => assert.equal(classifyEjection({ jobs: [j, GATE] }).infra, true));
}

test('NOT INFRA: a real test failure (even next to an infra one) is never re-armed', () => {
  const v = classifyEjection({ jobs: [job('render-smoke', 'failure', 'Install Chromium (Playwright)', [], 'Temporary failure resolving'), job('test-electron-vitest (2)', 'failure', 'Run vitest shard', ['AssertionError: expected 3 to equal 4']), GATE] });
  assert.equal(v.infra, false);
  assert.match(v.detail.find((d) => !d.infra).why, /test\/check failure in step: Run vitest shard/);
});

test('NOT INFRA (fail safe): an unreadable run, or no failed job besides the aggregate gate', () => {
  assert.equal(classifyEjection({ jobs: null }).infra, false);
  assert.equal(classifyEjection({ jobs: [GATE, job('lint', 'success')] }).infra, false);
  assert.equal(classifyEjection({ jobs: [] }).infra, false);
});

// Quality's probes (#5113 p/119#40, #42): a step NAME alone never makes a failure infra, and a
// NETWORK-looking annotation from a TEST step is the test's own failure (vitest reports as annotations).
for (const [what, j] of [
  ['a test step annotation "connect ETIMEDOUT"', job('test-electron-vitest (3)', 'failure', 'Run vitest shard', ['Error: connect ETIMEDOUT 10.0.0.5:443 ❯ src/main/net.test.ts:42'])],
  ['a test step annotation "TypeError: Failed to fetch"', job('test-electron-vitest (1)', 'failure', 'Run vitest shard', ['TypeError: Failed to fetch ❯ src/renderer/api.test.ts:17'])],
  ['an e2e test hitting a crashed server (ECONNREFUSED 127.0.0.1:3000)', job('render-smoke', 'failure', 'Run render smoke', ['Error: connect ECONNREFUSED 127.0.0.1:3000'])],
  ['a check printing "503 Service Unavailable"', job('test-server-prod-config', 'failure', 'Check /health', ['expected 200, got 503 Service Unavailable'])],
  ['DNS in a test step', job('test-python', 'failure', 'Run tests', ['curl: (6) Could not resolve host: pypi.org'])],
  ['a retried ECONNRESET followed by a real ETARGET in the same setup step', job('renderer-tsc', 'failure', 'Install dependencies (retry on transient nuget/network failures — t/2968)', [],
    'npm WARN fetch ECONNRESET registry.npmjs.org, will retry\nnpm http fetch GET 200 https://registry.npmjs.org/a\nnpm ERR! code ETARGET\nnpm ERR! notarget No matching version found for left-pad@9.9.9\n##[error]Process completed with exit code 1.')],
  ['pnpm install with ERR_PNPM_OUTDATED_LOCKFILE (#4968 today)', job('test-electron', 'failure', 'pnpm install --frozen-lockfile', ['Process completed with exit code 1.'], 'ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with package.json')],
  ['a test step named "Run cache invalidation tests"', job('test-electron-vitest (1)', 'failure', 'Run cache invalidation tests', ['AssertionError: expected stale entry to be evicted'])],
  ['a test step named "Run checkout flow e2e"', job('render-smoke', 'failure', 'Run checkout flow e2e', ['locator.click: Timeout 5000ms exceeded'])],
  ['Setup Python with a version that does not exist', job('test-python', 'failure', 'Setup Python 3.15', ['Version 3.15 was not found in the local cache'], 'Error: Version 3.15 was not found in the local cache')],
  ['a setup step whose log was not read', job('test-container', 'failure', 'Install buildx')],
]) {
  test(`NOT INFRA: ${what}`, () => {
    const v = classifyEjection({ jobs: [j, GATE] });
    assert.equal(v.infra, false, JSON.stringify(v.detail));
  });
}

test('NOT INFRA: a guard policy verdict (consult-hold present) is a real block', () => {
  assert.equal(classifyEjection({ jobs: [job('consult-hold-guard', 'failure', 'Refuse merge while a consult-hold label is present',
    ["consult-hold-guard: this PR carries the 'consult-hold' label"])] }).infra, false);
});

test('failingStepContext: only the lines before the first ##[error], retry announcements dropped', () => {
  const log = ['early: ECONNRESET in an unrelated earlier step', ...Array.from({ length: 30 }, (_, i) => `line ${i}`), 'ECONNRESET, retrying in 3s', 'npm ERR! code ETARGET', '##[error]Process completed with exit code 1.', 'Post job cleanup: Temporary failure resolving'].join('\n');
  const ctx = failingStepContext(log);
  assert.doesNotMatch(ctx, /early: ECONNRESET/, 'outside the last lines before the error');
  assert.doesNotMatch(ctx, /retrying in/, 'a retry announcement is not the cause');
  assert.doesNotMatch(ctx, /Post job cleanup/, 'after the error');
  assert.match(ctx, /ETARGET/);
});

test('settledBy: markers decide BEFORE any API call (Quality #5113 items 2-3)', () => {
  const H = 'a'.repeat(40), AT = Date.parse('2026-11-11T16:00:00Z');
  assert.deepEqual(settledBy([], H, AT), {}, 'nothing yet: classify');
  assert.equal(settledBy([{ body: `<!-- infra-rearm-notinfra head=${H} at=${AT} -->\nnot infra` }], H, AT).skip, true, 'notice for THIS ejection: skip, no API calls');
  assert.deepEqual(settledBy([{ body: `<!-- infra-rearm-notinfra head=${H} at=${AT - 3600e3} -->` }], H, AT), {}, 'a notice for an EARLIER ejection: the new one is classified');
  assert.deepEqual(settledBy([{ body: `<!-- infra-rearm-notinfra head=${'b'.repeat(40)} at=${AT} -->` }], H, AT), {}, 'another head');
  const twice = [{ body: `<!-- infra-rearm head=${H} n=1 -->` }, { body: `<!-- infra-rearm head=${H} n=2 -->` }];
  assert.deepEqual(settledBy(twice, H, AT), { action: 'cap' }, 'cap reached: post the CAP notice, no classification');
  assert.equal(settledBy([...twice, { body: `<!-- infra-rearm-cap head=${H} -->` }], H, AT).skip, true, 'CAP already posted: never twice');
  assert.deepEqual(settledBy([{ body: `<!-- infra-rearm head=${H} n=1 -->` }], H, AT), {}, 'one re-arm so far: classify again');
});

test('attempt cap: counted per head from comment markers; another head does not count', () => {
  const H = 'a'.repeat(40), OTHER = 'b'.repeat(40);
  const comments = [{ body: `<!-- infra-rearm head=${H} n=1 -->\nRe-armed` }, { body: `<!-- infra-rearm head=${OTHER} n=2 -->` }, { body: 'hi' }];
  assert.equal(rearmCount(comments, H), 1);
  assert.equal(rearmCount([...comments, { body: `<!-- infra-rearm head=${H} n=2 -->` }], H), MAX_PER_HEAD);
  assert.equal(rearmCount(comments, 'c'.repeat(40)), 0);
});

test('lastEjection: within 24h and not merged/manual; replay sees every earlier ejection of a since-merged PR', () => {
  const now = Date.parse('2026-11-11T18:00:00Z');
  const pr = { timelineItems: { nodes: [
    { __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-11-11T14:21:17Z', reason: 'FAILED_CHECKS' },
    { __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-11-11T18:11:10Z', reason: 'MERGED' },
  ] } };
  assert.equal(lastEjection(pr, now), null, 'the last removal was a merge');
  assert.deepEqual(ejectionsSince(pr, '2026-11-11T12:00:00Z').map((e) => e.reason), ['failed_checks']);
  const old = { timelineItems: { nodes: [{ __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-11-10T10:00:00Z', reason: 'FAILED_CHECKS' }] } };
  assert.equal(lastEjection(old, now), null, 'older than 24h');
  const manual = { timelineItems: { nodes: [{ __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-11-11T17:00:00Z', reason: 'MANUAL' }] } };
  assert.equal(lastEjection(manual, now), null, 'a person pulled it: respect that');
});

test('ejectingRun: the latest completed merge_group run for that PR before the removal (branch suffix is the base SHA)', () => {
  const at = Date.parse('2026-11-11T14:21:17Z');
  const r = (id, n, created, status = 'completed') => ({ id, head_branch: `gh-readonly-queue/main/pr-${n}-${'9'.repeat(40)}`, created_at: created, status });
  const runs = [r(1, 5063, '2026-11-11T13:20:00Z'), r(2, 5063, '2026-11-11T14:00:00Z'), r(3, 5063, '2026-11-11T14:30:00Z'), r(4, 50630, '2026-11-11T14:10:00Z'), r(5, 5063, '2026-11-11T14:15:00Z', 'in_progress')];
  assert.equal(ejectingRun(runs, 5063, at).id, 2);
  assert.equal(ejectingRun(runs, 1, at), null);
});
