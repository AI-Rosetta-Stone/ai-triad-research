// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDrift, formatFinding } from './check-merge-head-drift.mjs';

test('a file untouched by mainline with matching blobs is clean', () => {
  const r = computeDrift({ 'a.ts': { headBlob: 'abc', mergeBlob: 'abc', touchedByMainline: false } });
  assert.deepEqual(r, { drifted: [], skippedConcurrent: [], unreadable: [] });
});

test('REAL INCIDENT SHAPE (t/4858): a file untouched by mainline with mismatched blobs is real drift', () => {
  const r = computeDrift({
    'scripts/AITriad/Public/Invoke-IssueTypeClassification.ps1': {
      headBlob: '33f522d0', mergeBlob: '3fc90f00', touchedByMainline: false,
    },
  });
  assert.deepEqual(r.drifted, ['scripts/AITriad/Public/Invoke-IssueTypeClassification.ps1']);
  assert.deepEqual(r.skippedConcurrent, []);
});

test('FALSE-POSITIVE GUARD: a hot file mainline also touched, with mismatched blobs, is skipped not flagged', () => {
  // This is the exact shape the first version of the script got wrong: ci.yml/AGENTS.md
  // legitimately differ between a PR's own head and the squash result once mainline has
  // also touched the same file -- that is not evidence the PR's own change was dropped.
  const r = computeDrift({ '.github/workflows/ci.yml': { headBlob: 'aaa', mergeBlob: 'bbb', touchedByMainline: true } });
  assert.deepEqual(r.drifted, []);
  assert.deepEqual(r.skippedConcurrent, ['.github/workflows/ci.yml']);
});

test('a file mainline touched but blobs still match is clean (not reported at all)', () => {
  const r = computeDrift({ 'x.ts': { headBlob: 'same', mergeBlob: 'same', touchedByMainline: true } });
  // Still routed to skippedConcurrent (can't attribute equality to "no drift" vs "coincidence"
  // either), but never to drifted -- matching blobs are never a false alarm.
  assert.deepEqual(r.drifted, []);
});

test('a blob that could not be read on either side is unreadable, never silently clean', () => {
  const r = computeDrift({ 'y.ts': { headBlob: null, mergeBlob: 'zzz', touchedByMainline: false } });
  assert.deepEqual(r.unreadable, ['y.ts']);
  assert.deepEqual(r.drifted, []);
});

test('formatFinding names the PR, the drifted files, and never silently drops a skipped/unreadable list', () => {
  const out = formatFinding({
    number: 4489, headRefOid: '4f9ba173e2dc', mergeCommitOid: '0de478093a17',
    drifted: ['a.ps1'], skippedConcurrent: ['b.yml'], unreadable: ['c.ts'],
  });
  assert.match(out, /PR #4489/);
  assert.match(out, /DRIFTED.*a\.ps1/);
  assert.match(out, /skipped.*b\.yml/);
  assert.match(out, /UNREADABLE.*c\.ts/);
});
