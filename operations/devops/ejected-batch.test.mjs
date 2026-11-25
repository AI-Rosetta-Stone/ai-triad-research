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
    pushedAt: Date.parse('2026-11-14T00:00:00Z'),
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
    pushedAt: Date.parse('2026-11-14T00:00:00Z'),
    runs: [run(10, 42, '2026-11-14T12:00:00Z')],
    readJobs: () => [{ id: 100, conclusion: 'failure' }],
    readLog: () => PLAIN_FAIL_LOG,
  });
  assert.equal(v.verdict, 'not_ejected');
});

test('NOT skipped: only an OLDER queue entry was ejected and the latest entry is clean', () => {
  // Run 10 belongs to an older queue commit (different head_branch); run 11 is the latest entry.
  const older = run(10, 42, '2026-11-14T10:00:00Z', { head_branch: 'gh-readonly-queue/main/pr-42-oldsha' });
  const latest = run(11, 42, '2026-11-14T12:00:00Z');
  const v = ejectedBatchVerdict({
    prNumber: 42,
    pushedAt: Date.parse('2026-11-14T00:00:00Z'),
    runs: [older, latest],
    readJobs: (id) => (id === 10 ? [{ id: 100, conclusion: 'failure' }] : [{ id: 200, conclusion: 'success' }]),
    readLog: () => EJECT_LOG,
  });
  assert.equal(v.verdict, 'not_ejected', 'the rule is the latest queue entry, not any entry');
  assert.equal(v.runId, 11);
});

// SO t/423 fault: CI and CodeQL are two runs of one queue entry, created in the same second.
// The EJECTED line is printed by the CI run. Both orders must skip.
const SAME_SECOND = '2026-11-14T12:00:00Z';
const CI_RUN = (id, extra = {}) => run(id, 42, SAME_SECOND, { name: 'CI', ...extra });
const CODEQL_RUN = (id) => run(id, 42, SAME_SECOND, { name: 'CodeQL' });
const jobsFor = (id) => (id === 10 ? [{ id: 100, conclusion: 'failure' }] : [{ id: 200, conclusion: 'failure' }]);
const logsFor = (jobId) => (jobId === 100 ? EJECT_LOG : PLAIN_FAIL_LOG);

test('SKIP: same-second entry, CodeQL listed first, CI (EJECTED) second', () => {
  const v = ejectedBatchVerdict({
    prNumber: 42,
    pushedAt: Date.parse('2026-11-14T00:00:00Z'),
    runs: [CODEQL_RUN(11), CI_RUN(10)],
    readJobs: jobsFor,
    readLog: logsFor,
  });
  assert.equal(v.verdict, 'ejected', 'the ejection on the non-newest run of the entry must count');
  assert.equal(v.runId, 10);
});

test('SKIP: same-second entry, CI (EJECTED) listed first, CodeQL second', () => {
  const v = ejectedBatchVerdict({
    prNumber: 42,
    pushedAt: Date.parse('2026-11-14T00:00:00Z'),
    runs: [CI_RUN(10), CODEQL_RUN(11)],
    readJobs: jobsFor,
    readLog: logsFor,
  });
  assert.equal(v.verdict, 'ejected');
  assert.equal(v.runId, 10);
});

test('NOT skipped: same-second entry where neither run printed EJECTED', () => {
  const v = ejectedBatchVerdict({
    prNumber: 42,
    pushedAt: Date.parse('2026-11-14T00:00:00Z'),
    runs: [CODEQL_RUN(11), CI_RUN(10)],
    readJobs: jobsFor,
    readLog: () => PLAIN_FAIL_LOG,
  });
  assert.equal(v.verdict, 'not_ejected');
});

test('NOT skipped: same-second entry still running on one run (fail open, decided next sweep)', () => {
  const v = ejectedBatchVerdict({
    prNumber: 42,
    pushedAt: Date.parse('2026-11-14T00:00:00Z'),
    runs: [CODEQL_RUN(11), CI_RUN(10, { status: 'in_progress' })],
    readJobs: jobsFor,
    readLog: logsFor,
  });
  assert.equal(v.verdict, 'not_ejected');
});

test('unknown (never skip) when a same-second run cannot be read', () => {
  const v = ejectedBatchVerdict({
    prNumber: 42,
    pushedAt: Date.parse('2026-11-14T00:00:00Z'),
    runs: [CODEQL_RUN(11), CI_RUN(10)],
    readJobs: (id) => { if (id === 11) throw new Error('boom'); return jobsFor(id); },
    readLog: logsFor,
  });
  assert.equal(v.verdict, 'unknown');
});

test('NOT skipped: latest queue run still running (not a confirmed exit 3)', () => {
  const v = ejectedBatchVerdict({
    prNumber: 42,
    pushedAt: Date.parse('2026-11-14T00:00:00Z'),
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
    pushedAt: Date.parse('2026-11-14T00:00:00Z'),
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
    pushedAt: Date.parse('2026-11-14T00:00:00Z'),
    runs: [run(10, 42, '2026-11-14T12:00:00Z')],
    readJobs: () => [{ id: 100, conclusion: 'failure' }],
    readLog: () => { throw new Error('logs expired'); },
  });
  assert.equal(v.verdict, 'unknown');
  assert.notEqual(v.verdict, 'ejected');
});

// t/423 condition (Quality t/423#7): test the match against the REAL get-merge-group-prs.sh output,
// not a copied string. The script runs with a fake gh that returns an empty queue, which is the
// EJECTED path (exit 3). It needs jq and the part A wording (PR #5149). Until part A is on main,
// the script has no EJECTED branch and this test is skipped, so the skip never fires (fail safe).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_SCRIPT = resolve(HERE, 'get-merge-group-prs.sh');
const scriptHasEjected = existsSync(REAL_SCRIPT) && readFileSync(REAL_SCRIPT, 'utf8').includes('EJECTED');
const jqPresent = (() => { try { execFileSync('jq', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const gitBash = ['C:/Program Files/Git/bin/bash.exe', '/bin/bash'].find((p) => existsSync(p));

test('real get-merge-group-prs.sh EJECTED output is matched by isEjectedLog (t/423)', {
  skip: !scriptHasEjected ? 'part A (PR #5149, EJECTED branch) is not on main yet'
    : !jqPresent ? 'jq is not installed on this host (Linux CI has it)'
    : !gitBash ? 'no bash found' : false,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ejected-real-'));
  // Fake gh: the script's only gh call is the mergeQueue GraphQL read; an empty queue is EJECTED.
  const fakeGh = join(dir, 'gh');
  writeFileSync(fakeGh, '#!/usr/bin/env bash\necho "[]"\n');
  chmodSync(fakeGh, 0o755);
  const run = spawnSync(gitBash, [REAL_SCRIPT, 'AI-Rosetta-Stone/ai-triad-research', 'refs/heads/gh-readonly-queue/main/pr-42-abcdef', 'abc123'], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir },
    encoding: 'utf8',
  });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert.equal(run.status, 3, `the real script must exit 3 on EJECTED, got ${run.status}: ${out.slice(0, 300)}`);
  assert.equal(isEjectedLog(out, 42), true, 'the match must catch the real script output');
  assert.equal(isEjectedLog(out, 7), false, 'and must not match another PR');
});

test("NOT skipped: the ejected run is OLDER than the PR's last push (fixed head is not blocked)", () => {
  const pushedAt = Date.parse('2026-11-14T13:00:00Z');
  const v = ejectedBatchVerdict({
    prNumber: 42,
    runs: [run(10, 42, '2026-11-14T12:00:00Z')],
    pushedAt,
    readJobs: () => [{ id: 100, conclusion: 'failure' }],
    readLog: () => EJECT_LOG,
  });
  assert.equal(v.verdict, 'not_ejected');
  assert.match(v.reason, /not newer than the last push/);
});

test('SKIP: the ejected run is NEWER than the last push', () => {
  const pushedAt = Date.parse('2026-11-14T11:00:00Z');
  const v = ejectedBatchVerdict({
    prNumber: 42,
    runs: [run(10, 42, '2026-11-14T12:00:00Z')],
    pushedAt,
    readJobs: () => [{ id: 100, conclusion: 'failure' }],
    readLog: () => EJECT_LOG,
  });
  assert.equal(v.verdict, 'ejected');
});

test('NOT skipped: no push time, so the run cannot be shown newer', () => {
  const v = ejectedBatchVerdict({
    prNumber: 42,
    runs: [run(10, 42, '2026-11-14T12:00:00Z')],
    pushedAt: null,
    readJobs: () => [{ id: 100, conclusion: 'failure' }],
    readLog: () => EJECT_LOG,
  });
  assert.equal(v.verdict, 'not_ejected');
});
