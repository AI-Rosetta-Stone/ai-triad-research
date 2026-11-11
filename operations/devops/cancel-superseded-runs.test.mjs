// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/391: what the superseded-run canceller may and may not cancel.
// Run: node --test operations/devops/cancel-superseded-runs.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectRunsToCancel } from './cancel-superseded-runs.mjs';

const REPO = 'o/r';
const pr = (number, sha, ref = `b${number}`, repo = REPO) => ({ number, head: { sha, ref, repo: { full_name: repo } } });
let nextId = 1;
const run = (o) => ({ id: nextId++, name: 'CI', event: 'pull_request', status: 'queued', head_repository: { full_name: REPO }, pull_requests: [], ...o });
const pick = (runs, openPrs, selfRunId = null) => selectRunsToCancel({ runs, openPrs, selfRunId }).map((x) => x.run.id);

test('cancels a run for an old head of an open PR; keeps the current head', () => {
  const old = run({ head_sha: 'old', head_branch: 'b7', pull_requests: [{ number: 7 }] });
  const cur = run({ head_sha: 'new', head_branch: 'b7', pull_requests: [{ number: 7 }] });
  const r = selectRunsToCancel({ runs: [old, cur], openPrs: [pr(7, 'new')], selfRunId: null });
  assert.deepEqual(r.map((x) => x.run.id), [old.id]);
  assert.match(r[0].reason, /^superseded: PR #7 head is new/);
});

test('cancels in_progress as well as queued', () => {
  const r = run({ status: 'in_progress', head_sha: 'old', pull_requests: [{ number: 7 }] });
  assert.deepEqual(pick([r], [pr(7, 'new')]), [r.id]);
});

test('cancels runs of a closed PR (linked number not open)', () => {
  const r = run({ head_sha: 'x', head_branch: 'gone', pull_requests: [{ number: 9 }] });
  const out = selectRunsToCancel({ runs: [r], openPrs: [pr(7, 'new')], selfRunId: null });
  assert.equal(out[0].reason, 'PR #9 is closed');
});

test('NEVER cancels merge_group, push, schedule, workflow_dispatch or pull_request_target runs', () => {
  const runs = ['merge_group', 'push', 'schedule', 'workflow_dispatch', 'pull_request_target']
    .map((event) => run({ event, head_sha: 'old', head_branch: 'b7', pull_requests: [{ number: 7 }] }));
  assert.deepEqual(pick(runs, [pr(7, 'new')]), []);
});

test('NEVER cancels completed runs or its own run', () => {
  const done = run({ status: 'completed', head_sha: 'old', pull_requests: [{ number: 7 }] });
  const self = run({ head_sha: 'old', pull_requests: [{ number: 7 }] });
  assert.deepEqual(pick([done, self], [pr(7, 'new')], self.id), []);
});

test('a fork PR run (no pull_requests link) is matched by head repo + branch', () => {
  const fork = run({ head_sha: 'old', head_branch: 'feature', head_repository: { full_name: 'someone/r' } });
  assert.deepEqual(pick([fork], [pr(8, 'new', 'feature', 'someone/r')]), [fork.id]);
  const sameBranchOtherRepo = run({ head_sha: 'old', head_branch: 'feature', head_repository: { full_name: 'other/r' } });
  assert.deepEqual(pick([sameBranchOtherRepo], [pr(8, 'new', 'feature', 'someone/r')]), [], 'a same-named branch in another fork is not that PR');
});

test('fail-safe: an unattributable run (no link, no open PR on its branch) is left alone', () => {
  const orphan = run({ head_sha: 'x', head_branch: 'deleted' });
  assert.deepEqual(pick([orphan], [pr(7, 'new')]), []);
});
