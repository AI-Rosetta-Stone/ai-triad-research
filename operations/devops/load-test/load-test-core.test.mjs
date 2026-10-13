// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  percentile,
  summarizeStep,
  stepVerdict,
  findBreakingPoint,
  LOAD_TEST_THRESHOLDS,
} from './load-test-core.mjs';

test('percentile: empty input is 0, not NaN', () => {
  assert.equal(percentile([], 95), 0);
});

test('percentile: single sample returns itself for any p', () => {
  assert.equal(percentile([42], 50), 42);
  assert.equal(percentile([42], 99), 42);
});

test('percentile: p50/p95 on a known distribution', () => {
  const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  assert.equal(percentile(values, 50), 50.5);
  assert.ok(Math.abs(percentile(values, 95) - 95.05) < 1e-9);
});

test('summarizeStep: zero requests yields 0 error rate and 0 rps, not NaN/Infinity', () => {
  const s = summarizeStep({ latenciesMs: [], errorCount: 0, requestCount: 0, durationMs: 0 });
  assert.equal(s.errorRatePct, 0);
  assert.equal(s.rps, 0);
  assert.equal(s.p50Ms, 0);
  assert.equal(s.p95Ms, 0);
});

test('summarizeStep: computes error rate and rps correctly', () => {
  const s = summarizeStep({
    latenciesMs: [100, 200, 300, 400],
    errorCount: 1,
    requestCount: 100,
    durationMs: 10_000,
  });
  assert.equal(s.errorRatePct, 1);
  assert.equal(s.rps, 10);
});

test('stepVerdict: breaches only on p95 over threshold', () => {
  const v = stepVerdict({ p95Ms: 2001, errorRatePct: 0 });
  assert.equal(v.breached, true);
  assert.equal(v.p95Breach, true);
  assert.equal(v.errorBreach, false);
});

test('stepVerdict: breaches only on error rate over threshold', () => {
  const v = stepVerdict({ p95Ms: 100, errorRatePct: 1.01 });
  assert.equal(v.breached, true);
  assert.equal(v.errorBreach, true);
});

test('stepVerdict: at-threshold values do not breach (strictly greater-than)', () => {
  const v = stepVerdict({ p95Ms: LOAD_TEST_THRESHOLDS.p95Ms, errorRatePct: LOAD_TEST_THRESHOLDS.errorRatePct });
  assert.equal(v.breached, false);
});

test('findBreakingPoint: returns null when nothing in the ramp breaches', () => {
  const steps = [
    { level: 5, profile: 'reader', p95Ms: 100, errorRatePct: 0 },
    { level: 10, profile: 'reader', p95Ms: 200, errorRatePct: 0 },
  ];
  assert.equal(findBreakingPoint(steps), null);
});

test('findBreakingPoint: finds the first breaching level in ascending order, regardless of input order', () => {
  const steps = [
    { level: 100, profile: 'editor', p95Ms: 5000, errorRatePct: 0 },
    { level: 10, profile: 'reader', p95Ms: 100, errorRatePct: 0 },
    { level: 50, profile: 'debater', p95Ms: 2500, errorRatePct: 0 }, // breaches first
    { level: 25, profile: 'editor', p95Ms: 300, errorRatePct: 0 },
  ];
  const breaking = findBreakingPoint(steps);
  assert.equal(breaking.level, 50);
  assert.equal(breaking.profile, 'debater');
  assert.equal(breaking.p95Breach, true);
});

test('findBreakingPoint: picks the lowest breaching level even when a later profile at that level is fine', () => {
  const steps = [
    { level: 10, profile: 'reader', p95Ms: 100, errorRatePct: 0 },
    { level: 25, profile: 'editor', p95Ms: 100, errorRatePct: 2 }, // error-rate breach
    { level: 25, profile: 'reader', p95Ms: 100, errorRatePct: 0 },
  ];
  const breaking = findBreakingPoint(steps);
  assert.equal(breaking.level, 25);
  assert.equal(breaking.errorBreach, true);
});
