// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/385: the PR-volume metric's pure parts (median, peak parallel jobs per hour).
// Run: node --test operations/devops/pr-volume-metric.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median, peakParallelByHour } from './pr-volume-metric.mjs';

const j = (s, e) => ({ started_at: `2026-11-11T${s}Z`, completed_at: e ? `2026-11-11T${e}Z` : null });

test('median: odd, even, empty, non-numbers ignored', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([NaN, 7]), 7);
});

test('the 1-job throttle: strictly sequential jobs peak at 1', () => {
  const p = peakParallelByHour([j('16:20:00', '16:25:00'), j('16:25:00', '16:30:00'), j('16:31:00', '16:40:00')], Date.parse('2026-11-11T17:00:00Z'));
  assert.deepEqual(p, [{ hour: '2026-11-11T16', peak: 1 }], 'a job ending exactly when the next starts is not overlap');
});

test('overlapping jobs: the peak is the maximum simultaneous count, per hour', () => {
  const p = peakParallelByHour([j('12:00:00', '12:10:00'), j('12:05:00', '12:20:00'), j('12:06:00', '12:07:00'), j('13:00:00', '13:01:00')], Date.parse('2026-11-11T14:00:00Z'));
  assert.deepEqual(p, [{ hour: '2026-11-11T12', peak: 3 }, { hour: '2026-11-11T13', peak: 1 }]);
});

test('a job spanning an hour boundary counts in every hour it runs; a running job ends at now; queued jobs are ignored', () => {
  const now = Date.parse('2026-11-11T15:30:00Z');
  const p = peakParallelByHour([j('13:50:00', '15:10:00'), j('15:20:00', null), { started_at: null, completed_at: null }], now);
  assert.deepEqual(p, [{ hour: '2026-11-11T13', peak: 1 }, { hour: '2026-11-11T14', peak: 1 }, { hour: '2026-11-11T15', peak: 1 }]);
});
