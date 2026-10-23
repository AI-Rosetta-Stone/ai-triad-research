// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import test from 'node:test';
import assert from 'node:assert/strict';
import { collectFailedFullNames, diffNewFailures, formatSummary } from './future-clock-diff-predicate.mjs';

function report(entries) {
  return { testResults: [{ assertionResults: entries }] };
}

test('collectFailedFullNames: only failed assertions are collected', () => {
  const r = report([
    { fullName: 'a passes', status: 'passed' },
    { fullName: 'b fails', status: 'failed' },
    { fullName: 'c skipped', status: 'skipped' },
  ]);
  assert.deepEqual([...collectFailedFullNames(r)], ['b fails']);
});

test('collectFailedFullNames: null report (crashed run) returns an empty set, not a throw', () => {
  assert.deepEqual([...collectFailedFullNames(null)], []);
});

test('diffNewFailures: a failure present in both baseline and future is NOT new', () => {
  const baseline = new Set(['pre-existing failure']);
  const future = new Set(['pre-existing failure', 'genuinely new failure']);
  const { newFailures } = diffNewFailures(baseline, future, []);
  assert.deepEqual(newFailures, ['genuinely new failure']);
});

test('diffNewFailures: a future-only failure matching a known harness artifact is excluded, with its reason carried', () => {
  const baseline = new Set();
  const future = new Set(['slow grep test', 'real time bomb']);
  const artifacts = [{ fullName: 'slow grep test', reason: 'times out under fake timers, not clock-dependent' }];
  const { newFailures, excludedArtifacts } = diffNewFailures(baseline, future, artifacts);
  assert.deepEqual(newFailures, ['real time bomb']);
  assert.deepEqual(excludedArtifacts, [{ fullName: 'slow grep test', reason: 'times out under fake timers, not clock-dependent' }]);
});

test('diffNewFailures: a stale exclusion entry that matches nothing produces no excludedArtifacts entry (visible by absence)', () => {
  const baseline = new Set();
  const future = new Set(['real time bomb']);
  const artifacts = [{ fullName: 'no-longer-failing test', reason: 'was flagged once, since fixed' }];
  const { newFailures, excludedArtifacts } = diffNewFailures(baseline, future, artifacts);
  assert.deepEqual(newFailures, ['real time bomb']);
  assert.deepEqual(excludedArtifacts, []);
});

test('formatSummary: clean diff reports no new failures', () => {
  const out = formatSummary({ newFailures: [], excludedArtifacts: [] }, { baselineCrashed: false, futureCrashed: false });
  assert.match(out, /No new failures/);
});

test('formatSummary: new failures are each listed by name', () => {
  const out = formatSummary({ newFailures: ['a test', 'b test'], excludedArtifacts: [] }, { baselineCrashed: false, futureCrashed: false });
  assert.match(out, /2 new failure/);
  assert.match(out, /`a test`/);
  assert.match(out, /`b test`/);
});

test('formatSummary: excluded artifacts are listed with their reason, under a collapsed details block', () => {
  const out = formatSummary(
    { newFailures: [], excludedArtifacts: [{ fullName: 'slow test', reason: 'timeout artifact' }] },
    { baselineCrashed: false, futureCrashed: false },
  );
  assert.match(out, /1 known harness artifact/);
  assert.match(out, /slow test/);
  assert.match(out, /timeout artifact/);
});

test('formatSummary: a crashed leg is surfaced as a WARN, not silently read as a clean diff', () => {
  const out = formatSummary({ newFailures: [], excludedArtifacts: [] }, { baselineCrashed: true, futureCrashed: false });
  assert.match(out, /WARN/);
  assert.match(out, /real-clock baseline/);
  assert.match(out, /NOT evaluable/);
});

test('formatSummary: both legs crashing names both in the WARN', () => {
  const out = formatSummary({ newFailures: [], excludedArtifacts: [] }, { baselineCrashed: true, futureCrashed: true });
  assert.match(out, /real-clock baseline and the future-clock/);
});
