// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Pure core for health-monitor.yml's consecutive-failure heartbeat (t/4340 follow-up, TL
// p/331#2582). Detects a scheduled job that fires on schedule every time but fails every
// time -- the AADSTS700213 incident shape, where the staleness check (which only catches
// a cron that stopped firing) never fires because the cron itself is healthy.
//
// Impure shim (health-monitor.yml) supplies `runs`: the last N completed `event: 'schedule'`
// workflow runs for the watched file, each with its jobs' name+conclusion already resolved.
// This module never calls the GitHub API itself -- it is unit-tested in
// consecutive-failure.test.mjs.

/**
 * PURE. Returns an alarm message if every one of `runs` (already filtered to the watched
 * workflow's last N scheduled runs, oldest-to-newest order doesn't matter) failed on the
 * named job, or null if there's no alarm.
 *
 * @param {{file: string, job: string, n: number}} watch
 * @param {Array<{jobs: Array<{name: string, conclusion: string|null}>}>} runs
 * @returns {string|null}
 */
export function consecutiveFailureVerdict(watch, runs) {
  if (runs.length < watch.n) return null; // not enough history yet -- don't false-alarm a new/young workflow
  const conclusions = runs.map((run) => {
    const job = run.jobs.find((j) => j.name === watch.job);
    return job ? job.conclusion : 'job-not-found';
  });
  if (conclusions.every((c) => c && c !== 'success')) {
    return `${watch.file} / ${watch.job}: last ${watch.n} scheduled runs all failed (${conclusions.join(', ')})`;
  }
  return null;
}

/**
 * PURE. Runs consecutiveFailureVerdict over every watched entry (paired by index with
 * `runsByWatch`, already fetched by the impure shim) and returns the collected alarm
 * messages (empty array when nothing is alarming).
 *
 * @param {Array<{file: string, job: string, n: number}>} watchList
 * @param {Array<Array<{jobs: Array<{name: string, conclusion: string|null}>}>>} runsByWatch
 * @returns {string[]}
 */
export function evaluateWatchList(watchList, runsByWatch) {
  const alarms = [];
  for (let i = 0; i < watchList.length; i++) {
    const verdict = consecutiveFailureVerdict(watchList[i], runsByWatch[i] ?? []);
    if (verdict) alarms.push(verdict);
  }
  return alarms;
}
