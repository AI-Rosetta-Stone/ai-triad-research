// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4939 step 1: both arms -- an unapproved T1 member fails the group; an approved T1 or a
// T0/T2 member passes (and a mixed batch is only as good as its worst member).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMergeGroupApprovals } from './t1-approval-guard-merge-group-predicate.mjs';

test('an unapproved T1 member fails the whole group', () => {
  const result = classifyMergeGroupApprovals([
    { number: 101, result: { pass: true, tier: 'T0', reason: 'not-t1' } },
    { number: 102, result: { pass: false, tier: 'T1', reason: 'no-post-push-approval' } },
  ]);
  assert.deepEqual(result, { pass: false, failingNumbers: [102] });
});

test('an approved T1 member passes', () => {
  const result = classifyMergeGroupApprovals([
    { number: 201, result: { pass: true, tier: 'T1', reason: 'approved-after-push' } },
  ]);
  assert.deepEqual(result, { pass: true, failingNumbers: [] });
});

test('a T0 member passes without needing approval', () => {
  const result = classifyMergeGroupApprovals([
    { number: 301, result: { pass: true, tier: 'T0', reason: 'not-t1' } },
  ]);
  assert.deepEqual(result, { pass: true, failingNumbers: [] });
});

test('a T2 member passes this gate (T2 is gated by consult-hold elsewhere)', () => {
  const result = classifyMergeGroupApprovals([
    { number: 401, result: { pass: true, tier: 'T2', reason: 'not-t1' } },
  ]);
  assert.deepEqual(result, { pass: true, failingNumbers: [] });
});

test('a mixed batch is only as good as its worst member -- multiple failures are all named', () => {
  const result = classifyMergeGroupApprovals([
    { number: 501, result: { pass: true, tier: 'T0', reason: 'not-t1' } },
    { number: 502, result: { pass: false, tier: 'T1', reason: 'no-post-push-approval' } },
    { number: 503, result: { pass: true, tier: 'T1', reason: 'approved-after-push' } },
    { number: 504, result: { pass: false, tier: 'T1', reason: 'no-post-push-approval' } },
  ]);
  assert.deepEqual(result, { pass: false, failingNumbers: [502, 504] });
});

test('an empty batch passes vacuously (the enumeration script itself fails closed on zero PRs)', () => {
  assert.deepEqual(classifyMergeGroupApprovals([]), { pass: true, failingNumbers: [] });
});
