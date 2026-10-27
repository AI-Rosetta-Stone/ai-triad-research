// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Scheduled-workflow health (t/4058) — the gap main-ci-monitor leaves open.
 *
 * main-ci-monitor answers "is the tip of `main` broken?" by observing PUSH-event runs. Scheduled
 * workflows never run on push, so they were unmonitored: deploy-drift-check crashed (exit 141) on 7
 * consecutive runs, compliance-live failed every day since its first run (its token was never
 * provisioned), dependabot-weekly failed every Monday, cluster-conflicts every Sunday for 6 weeks —
 * all with nothing escalating (t/4058#1). This module judges each DECLARED scheduled workflow from
 * its recent `schedule`-event runs; main-ci-monitor's scheduled path feeds it and routes problems
 * through the existing `alert-escalated` latch, which DevOps' hourly r/23 bridge surfaces.
 *
 * DECLARED, not inferred (scheduled-workflows.json): each entry carries its own silence budget, and
 * the lint in the test suite fails when a workflow with `schedule:` is missing from the list — an
 * unlisted scheduled workflow is the surviving vector, so the list is checked, not trusted.
 *
 * Two failure shapes:
 *   - FAILING: the most recent >= FAIL_STREAK completed scheduled runs all concluded failure-like.
 *     One red is tolerated (a transient blip); two in a row is a pattern.
 *   - SILENT:  no scheduled run created within maxSilentHours (GitHub throttles cron hard — a
 *     `*\/15` workflow was observed 6h between runs — and auto-disables a schedule after 60 days of
 *     repo inactivity), or never any scheduled run at all.
 * PURE: no I/O.
 */

export const FAIL_STREAK = 2;
const FAILURE_LIKE = new Set(['failure', 'timed_out', 'startup_failure']);

/**
 * @param {object} p
 * @param {string} p.file                 workflow file name (e.g. deploy-drift-check.yml)
 * @param {Array<{conclusion: string|null, createdAt: string}>} p.runs  schedule-event runs, NEWEST FIRST
 * @param {number} p.maxSilentHours       declared silence budget for this workflow
 * @param {number} p.nowMs
 * @param {number} [p.failStreak]
 * @returns {{file: string, status: 'ok'|'failing'|'silent', streak: number, lastRunAt: string|null, reason: string}}
 */
export function scheduledWorkflowVerdict({ file, runs = [], maxSilentHours, nowMs, failStreak = FAIL_STREAK }) {
  if (!runs.length) {
    return { file, status: 'silent', streak: 0, lastRunAt: null, reason: 'no scheduled run on record' };
  }
  const lastRunAt = runs[0].createdAt;
  const ageH = (nowMs - Date.parse(lastRunAt)) / 3_600_000;

  // Streak over COMPLETED runs only (an in-progress run has conclusion null and says nothing yet).
  let streak = 0;
  for (const r of runs) {
    if (r.conclusion == null) continue;
    if (FAILURE_LIKE.has(r.conclusion)) streak++;
    else break;
  }

  if (streak >= failStreak) {
    return { file, status: 'failing', streak, lastRunAt, reason: `last ${streak} scheduled runs failed` };
  }
  if (ageH > maxSilentHours) {
    return { file, status: 'silent', streak, lastRunAt, reason: `no scheduled run for ${ageH.toFixed(1)}h (budget ${maxSilentHours}h)` };
  }
  return { file, status: 'ok', streak, lastRunAt, reason: 'healthy' };
}

/** Stable fingerprint of the problem set: changes iff a different set of workflows/statuses is wrong. */
export function problemFingerprint(verdicts) {
  return verdicts.filter(v => v.status !== 'ok').map(v => `${v.file}:${v.status}`).sort().join(',');
}

/** Workflow files whose YAML declares a `schedule:` trigger. `files` = [{name, text}]. */
export function scheduledWorkflowFiles(files) {
  return files.filter(f => /^\s*schedule:\s*$/m.test(f.text)).map(f => f.name).sort();
}

/**
 * t/4347: a push-event run with ZERO jobs and `conclusion: failure` means GitHub rejected the
 * workflow file structurally (bad YAML, an invalid `permissions:` key, etc.) -- GitHub evaluates
 * every workflow file's triggers on every push regardless of whether that file declares a
 * `push:` trigger itself (environment-branch-policy-check.yml had none, yet got exactly this
 * kind of run). Distinct from a JOB inside the workflow failing, which has jobCount > 0.
 * `runs` = run summaries {conclusion, jobCount, runId, event?}, NEWEST FIRST, ANY trigger type
 * (t/4508: was push-event only -- a workflow whose normal trigger is schedule/workflow_dispatch
 * can go months without a fresh push-event run, so filtering to push alone kept citing a single
 * ancient failure as current forever; GitHub rejects a structurally-invalid file identically
 * regardless of what triggered the run, so the newest run of any kind is equally valid evidence).
 * PURE: no I/O.
 * @param {object} p
 * @param {string} p.file
 * @param {Array<{conclusion: string|null, jobCount: number, runId?: number, event?: string}>} p.runs
 * @returns {{file: string, invalid: boolean, reason: string, runId?: number}}
 */
export function invalidWorkflowFileVerdict({ file, runs = [] }) {
  if (!runs.length) {
    return { file, invalid: false, reason: 'no run on record' };
  }
  const newest = runs[0];
  if (newest.conclusion === 'failure' && newest.jobCount === 0) {
    const trigger = newest.event ? `${newest.event}-event` : 'a';
    return {
      file,
      invalid: true,
      reason: `${trigger} run has 0 jobs and conclusion failure -- GitHub rejected the file structurally, not a job failure`,
      runId: newest.runId,
    };
  }
  return { file, invalid: false, reason: 'ok' };
}
