// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Run: node --test operations/devops/ejected-batch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEjectedLog, queueRunsForPR, ejectedBatchVerdict } from './ejected-batch.mjs';

const EJECT_LOG = [
  '2026-11-14T15:00:00Z ##[error]get-merge-group-prs: EJECTED -- PR #42 at merge_group head abc123: mergeQueue entries for main is EMPTY, so this batch\'s entry was removed from the queue. Exit 3 (never a pass).',
  '2026-11-14T15:00:01Z Process completed with exit code 3.',
].join('\n');
const PLAIN_FAIL_LOG = '2026-11-14T15:00:00Z ##[error]Process completed with exit code 1.';
const run = (id, prNumber, created, extra = {}) => ({
  id, event: 'merge_group', head_branch: `gh-readonly-queue/main/pr-${prNumber}-deadbeef`,
  created_at: created, status: 'completed', ...extra,
});

test('isEjectedLog: true only for the EJECTED line of this PR with exit 3', () => {
  assert.equal(isEjectedLog(EJECT_LOG, 42), true);
  assert.equal(isEjectedLog(EJECT_LOG, 7), false, 'a different PR number must not match');
  assert.equal(isEjectedLog(PLAIN_FAIL_LOG, 42), false, 'an ordinary failure is not an ejection');
  assert.equal(isEjectedLog('', 42), false);
  assert.equal(isEjectedLog(null, 42), false);
});

test('queueRunsForPR: keeps only this PR\'s merge_group runs, newest first', () => {
  const runs = [
    run(1, 42, '2026-11-14T10:00:00Z'),
    run(2, 42, '2026-11-14T12:00:00Z'),
    run(3, 7, '2026-11-14T13:00:00Z'),
    { id: 4, event: 'pull_request', head_branch: 'gh-readonly-queue/main/pr-42-x', created_at: '2026-11-14T14:00:00Z' },
    { id: 5, event: 'merge_group', head_branch: 'refs/heads/gh-readonly-queue/main/pr-42-y', created_at: '2026-11-14T11:00:00Z' },
  ];
  assert.deepEqual(queueRunsForPR(runs, 42).map((r) => r.id), [2, 5, 1]);
});

test('SKIP: latest queue run has a failing job that printed the EJECTED exit-3 line', () => {
  const v = ejectedBatchVerdict({
    prNumber: 42,
    runs: [run(10, 42, '2026-11-14T12:00:00Z')],
    readJobs: () => [{ id: 100, conclusion: 'failure' }],
    readLog: () => EJECT_LOG,
  });
  assert.equal(v.verdict, 'ejected');
  assert.equal(v.runId, 10);
});

test('NOT skipped: latest queue run failed for an ordinary reason', () => {
  const v = ejectedBatchVerdict({
    prNumber: 42,
    runs: [run(10, 42, '2026-11-14T12:00:00Z')],
    readJobs: () => [{ id: 100, conclusion: 'failure' }],
    readLog: () => PLAIN_FAIL_LOG,
  });
  assert.equal(v.verdict, 'not_ejected');
});

test('NOT skipped: only an OLDER run was ejected and the latest run is clean', () => {
  const runs = [run(10, 42, '2026-11-14T10:00:00Z'), run(11, 42, '2026-11-14T12:00:00Z')];
  const v = ejectedBatchVerdict({
    prNumber: 42,
    runs,
    readJobs: (id) => (id === 10 ? [{ id: 100, conclusion: 'failure' }] : [{ id: 200, conclusion: 'success' }]),
    readLog: () => EJECT_LOG,
  });
  assert.equal(v.verdict, 'not_ejected', 'the rule is the latest run, not any run');
  assert.equal(v.runId, 11);
});

test('NOT skipped: latest queue run still running (not a confirmed exit 3)', () => {
  const v = ejectedBatchVerdict({
    prNumber: 42,
    runs: [run(10, 42, '2026-11-14T12:00:00Z', { status: 'in_progress' })],
    readJobs: () => { throw new Error('must not read jobs of a running run'); },
    readLog: () => EJECT_LOG,
  });
  assert.equal(v.verdict, 'not_ejected');
});

test('NOT skipped: no merge-queue run for the PR', () => {
  const v = ejectedBatchVerdict({ prNumber: 42, runs: [], readJobs: () => [], readLog: () => '' });
  assert.equal(v.verdict, 'not_ejected');
});

test('FAIL OPEN: the run list cannot be read (verdict unknown, never a skip)', () => {
  // The caller passes runs only after a successful read; a thrown read is handled in the sweep
  // (ejectedCheck) and yields 'unknown'. Here we check the job read failing mid-way.
  const v = ejectedBatchVerdict({
    prNumber: 42,
    runs: [run(10, 42, '2026-11-14T12:00:00Z')],
    readJobs: () => { throw new Error('HTTP 502'); },
    readLog: () => EJECT_LOG,
  });
  assert.equal(v.verdict, 'unknown');
  assert.notEqual(v.verdict, 'ejected');
});

test('FAIL OPEN: the log read fails (verdict unknown, never a skip)', () => {
  const v = ejectedBatchVerdict({
    prNumber: 42,
    runs: [run(10, 42, '2026-11-14T12:00:00Z')],
    readJobs: () => [{ id: 100, conclusion: 'failure' }],
    readLog: () => { throw new Error('logs expired'); },
  });
  assert.equal(v.verdict, 'unknown');
  assert.notEqual(v.verdict, 'ejected');
});
