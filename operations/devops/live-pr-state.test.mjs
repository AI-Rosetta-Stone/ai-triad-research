// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Run: node --test operations/devops/live-pr-state.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveEnqueueVerdict } from './live-pr-state.mjs';

const open = { state: 'OPEN', isInMergeQueue: false, isDraft: false, headRefOid: 'abc123456789' };

test('an open, unqueued, non-draft PR at the evaluated head may be enqueued', () => {
  assert.deepEqual(liveEnqueueVerdict(open, 'abc123456789'), { ok: true });
});

test('a PR that moved on by itself is skipped as a race, not a failure', () => {
  const cases = [
    [{ ...open, state: 'MERGED' }, /already merged/],       // the #4441 case
    [{ ...open, state: 'CLOSED' }, /state is CLOSED/],
    [{ ...open, isInMergeQueue: true }, /already in merge queue/],
    [{ ...open, isDraft: true }, /converted to draft/],
    [{ ...open, headRefOid: 'def999999999' }, /head moved abc12345 -> def99999/],
  ];
  for (const [live, re] of cases) {
    const v = liveEnqueueVerdict(live, 'abc123456789');
    assert.equal(v.ok, false);
    assert.equal(v.raced, true, re.source);
    assert.match(v.reason, re);
  }
});

test('unavailable live state is not ok and not a race (fails closed, counted as a failure)', () => {
  assert.deepEqual(liveEnqueueVerdict(null, 'abc'), { ok: false, reason: 'live state unavailable', raced: false });
});
