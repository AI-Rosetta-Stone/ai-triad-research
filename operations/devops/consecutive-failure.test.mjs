// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Run: node --test operations/devops/consecutive-failure.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consecutiveFailureVerdict, evaluateWatchList } from './consecutive-failure.mjs';

const WATCH = { file: 'health-monitor.yml', job: 'health-check', n: 3 };
const run = (conclusion, { otherJobConclusion = 'success' } = {}) => ({
  jobs: [
    { name: 'health-check', conclusion },
    { name: 'known-good-liveness', conclusion: otherJobConclusion },
  ],
});

test('3 consecutive failures: alarms', () => {
  const v = consecutiveFailureVerdict(WATCH, [run('failure'), run('failure'), run('failure')]);
  assert.match(v, /last 3 scheduled runs all failed \(failure, failure, failure\)/);
});

test('failure, failure, success: no alarm (the streak was broken)', () => {
  const v = consecutiveFailureVerdict(WATCH, [run('failure'), run('failure'), run('success')]);
  assert.equal(v, null);
});

test('an unrelated job failing in the same run does not count: no alarm', () => {
  const v = consecutiveFailureVerdict(WATCH, [
    run('success', { otherJobConclusion: 'failure' }),
    run('success', { otherJobConclusion: 'failure' }),
    run('success', { otherJobConclusion: 'failure' }),
  ]);
  assert.equal(v, null);
});

test('fewer than 3 runs on record: no alarm (not enough history, do not false-alarm a young workflow)', () => {
  const v = consecutiveFailureVerdict(WATCH, [run('failure'), run('failure')]);
  assert.equal(v, null);
});

test('a missing job on a run (job-not-found) counts as a non-success, contributing to the alarm', () => {
  const v = consecutiveFailureVerdict(WATCH, [
    { jobs: [{ name: 'known-good-liveness', conclusion: 'success' }] },
    run('failure'),
    run('failure'),
  ]);
  assert.match(v, /job-not-found, failure, failure/);
});

test('evaluateWatchList: aggregates alarms across multiple watched entries, skipping clean ones', () => {
  const watchList = [WATCH, { file: 'other.yml', job: 'other-job', n: 2 }];
  const runsByWatch = [
    [run('failure'), run('failure'), run('failure')],
    [{ jobs: [{ name: 'other-job', conclusion: 'success' }] }, { jobs: [{ name: 'other-job', conclusion: 'success' }] }],
  ];
  const alarms = evaluateWatchList(watchList, runsByWatch);
  assert.equal(alarms.length, 1);
  assert.match(alarms[0], /health-monitor\.yml \/ health-check/);
});
