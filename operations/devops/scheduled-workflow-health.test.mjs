// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4058 — both arms of the scheduled-workflow verdict, plus the list-completeness lint that keeps
// the declared list honest (an unlisted `schedule:` workflow would be silently unmonitored).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scheduledWorkflowVerdict, problemFingerprint, scheduledWorkflowFiles, invalidWorkflowFileVerdict } from './scheduled-workflow-health.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const NOW = Date.parse('2026-10-07T12:00:00Z');
const at = (h) => new Date(NOW - h * 3_600_000).toISOString();
const run = (conclusion, hAgo) => ({ conclusion, createdAt: at(hAgo) });

test('ok: recent successful scheduled runs', () => {
  const v = scheduledWorkflowVerdict({ file: 'x.yml', runs: [run('success', 1), run('success', 4)], maxSilentHours: 18, nowMs: NOW });
  assert.equal(v.status, 'ok');
});

test('one failure is tolerated (transient), two consecutive is FAILING', () => {
  const one = scheduledWorkflowVerdict({ file: 'x.yml', runs: [run('failure', 1), run('success', 4)], maxSilentHours: 18, nowMs: NOW });
  assert.equal(one.status, 'ok');
  const two = scheduledWorkflowVerdict({ file: 'x.yml', runs: [run('failure', 1), run('failure', 4), run('success', 7)], maxSilentHours: 18, nowMs: NOW });
  assert.equal(two.status, 'failing');
  assert.equal(two.streak, 2);
});

test('t/3905 replay: 7 consecutive failures (exit 141) is FAILING even though runs are recent', () => {
  const runs = Array.from({ length: 7 }, (_, i) => run('failure', 1 + i * 3));
  const v = scheduledWorkflowVerdict({ file: 'deploy-drift-check.yml', runs, maxSilentHours: 18, nowMs: NOW });
  assert.equal(v.status, 'failing');
  assert.equal(v.streak, 7);
});

test('timed_out and startup_failure count as failure-like; cancelled breaks the streak', () => {
  const v = scheduledWorkflowVerdict({ file: 'x.yml', runs: [run('timed_out', 1), run('startup_failure', 2)], maxSilentHours: 18, nowMs: NOW });
  assert.equal(v.status, 'failing');
  const c = scheduledWorkflowVerdict({ file: 'x.yml', runs: [run('failure', 1), run('cancelled', 2), run('failure', 3)], maxSilentHours: 18, nowMs: NOW });
  assert.equal(c.status, 'ok');
});

test('an in-progress newest run (conclusion null) is skipped, not counted as a break', () => {
  const v = scheduledWorkflowVerdict({ file: 'x.yml', runs: [run(null, 0.1), run('failure', 3), run('failure', 6)], maxSilentHours: 18, nowMs: NOW });
  assert.equal(v.status, 'failing');
});

test('SILENT: newest scheduled run older than the budget (schedule throttled / auto-disabled)', () => {
  const v = scheduledWorkflowVerdict({ file: 'x.yml', runs: [run('success', 19)], maxSilentHours: 18, nowMs: NOW });
  assert.equal(v.status, 'silent');
  assert.match(v.reason, /budget 18h/);
});

test('FAIL-SAFE: no scheduled run on record is SILENT, never ok', () => {
  const v = scheduledWorkflowVerdict({ file: 'x.yml', runs: [], maxSilentHours: 60, nowMs: NOW });
  assert.equal(v.status, 'silent');
});

test('fingerprint changes only when the problem set changes', () => {
  const a = [{ file: 'a.yml', status: 'failing' }, { file: 'b.yml', status: 'ok' }];
  const b = [{ file: 'b.yml', status: 'ok' }, { file: 'a.yml', status: 'failing' }];
  const c = [{ file: 'a.yml', status: 'silent' }];
  assert.equal(problemFingerprint(a), problemFingerprint(b));
  assert.notEqual(problemFingerprint(a), problemFingerprint(c));
  assert.equal(problemFingerprint([{ file: 'a.yml', status: 'ok' }]), '');
});

test('scheduledWorkflowFiles detects a `schedule:` trigger and ignores mentions elsewhere', () => {
  const files = [
    { name: 'a.yml', text: 'on:\n  schedule:\n    - cron: "0 1 * * *"\n' },
    { name: 'b.yml', text: 'on:\n  push:\n# a comment about schedule: here\n' },
  ];
  assert.deepEqual(scheduledWorkflowFiles(files), ['a.yml']);
});

// ── t/4347: a zero-job push-failure run means GitHub rejected the file structurally ──────────────
test('invalidWorkflowFileVerdict: 0 jobs + conclusion failure is INVALID (t/4347, PR #3527 / run 39478983829)', () => {
  const v = invalidWorkflowFileVerdict({ file: 'environment-branch-policy-check.yml', runs: [{ conclusion: 'failure', jobCount: 0, runId: 39478983829 }] });
  assert.equal(v.invalid, true);
  assert.equal(v.runId, 39478983829);
});

test('invalidWorkflowFileVerdict: a job inside the workflow failing (jobCount > 0) is NOT structurally invalid', () => {
  const v = invalidWorkflowFileVerdict({ file: 'ci.yml', runs: [{ conclusion: 'failure', jobCount: 12, runId: 1 }] });
  assert.equal(v.invalid, false);
});

test('invalidWorkflowFileVerdict: a successful run with 0 jobs (e.g. every job skipped by if:) is NOT flagged', () => {
  const v = invalidWorkflowFileVerdict({ file: 'x.yml', runs: [{ conclusion: 'success', jobCount: 0, runId: 1 }] });
  assert.equal(v.invalid, false);
});

test('invalidWorkflowFileVerdict: no run on record is NOT flagged (e.g. a workflow that has never run)', () => {
  const v = invalidWorkflowFileVerdict({ file: 'x.yml', runs: [] });
  assert.equal(v.invalid, false);
});

test('invalidWorkflowFileVerdict: only the NEWEST run matters -- a fixed file with an old 0-job failure is not re-flagged', () => {
  const v = invalidWorkflowFileVerdict({ file: 'x.yml', runs: [{ conclusion: 'success', jobCount: 3, runId: 2 }, { conclusion: 'failure', jobCount: 0, runId: 1 }] });
  assert.equal(v.invalid, false);
});

// ── t/4508: the real recurrence -- a schedule/dispatch-triggered workflow's only PUSH run is
// months-old and will never be superseded by a new push, even though every schedule/dispatch run
// in the meantime proves the file is fine. 6 occurrences (#3821/#3828/#3843/#3863/#3896) all cited
// the SAME ancient push failure as "current" because the caller fetched push-event runs only. The
// fix is at the call site (fetch the newest run of ANY event type), but this proves the pure
// function itself was never the problem: given the broader, correct feed -- the newest run overall,
// regardless of event -- it already classifies correctly.
test('invalidWorkflowFileVerdict: t/4508 -- a recent successful schedule-event run clears an old push-event structural failure', () => {
  const v = invalidWorkflowFileVerdict({
    file: 'deploy-azure.yml',
    runs: [{ conclusion: 'success', jobCount: 5, runId: 2, event: 'schedule' }],
  });
  assert.equal(v.invalid, false);
});

test('invalidWorkflowFileVerdict: reason text names the actual trigger event, not always "push-event" (t/4508)', () => {
  const v = invalidWorkflowFileVerdict({
    file: 'x.yml',
    runs: [{ conclusion: 'failure', jobCount: 0, runId: 1, event: 'workflow_dispatch' }],
  });
  assert.equal(v.invalid, true);
  assert.match(v.reason, /^workflow_dispatch-event run has 0 jobs/);
});

// ── LINT: the declared list must cover EVERY scheduled workflow in the repo, and only real files ──
const listPath = join(here, 'scheduled-workflows.json');
const declared = JSON.parse(readFileSync(listPath, 'utf8')).workflows;
const wfDir = join(repoRoot, '.github', 'workflows');
const actual = scheduledWorkflowFiles(readdirSync(wfDir).filter(n => /\.ya?ml$/.test(n))
  .map(n => ({ name: n, text: readFileSync(join(wfDir, n), 'utf8') })));

test('LINT: every workflow with a `schedule:` trigger is in scheduled-workflows.json (t/4058)', () => {
  const listed = new Set(declared.map(w => w.file));
  const missing = actual.filter(f => !listed.has(f));
  assert.deepEqual(missing, [], `scheduled workflows NOT monitored — add them to operations/devops/scheduled-workflows.json: ${missing.join(', ')}`);
});

test('LINT: every declared entry is a real scheduled workflow with a positive silence budget', () => {
  assert.ok(actual.length >= 15, `population floor: expected >=15 scheduled workflows, found ${actual.length} (a broken detector would pass the lint vacuously)`);
  for (const w of declared) {
    assert.ok(existsSync(join(wfDir, w.file)), `${w.file} is declared but does not exist`);
    assert.ok(actual.includes(w.file), `${w.file} is declared but has no schedule: trigger`);
    // Floor lowered 12->10 (t/4501#8, PR #3835, TL-approved): health-monitor.yml/
    // main-ci-monitor.yml/sources-index.yml deliberately set to 10h (2x measured p95 gap).
    assert.ok(Number.isFinite(w.maxSilentHours) && w.maxSilentHours >= 10, `${w.file}: maxSilentHours must be >= 10`);
  }
});
