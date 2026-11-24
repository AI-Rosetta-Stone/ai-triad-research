// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/423 (split from t/422#20): the t0 sweep skips a PR whose merge-queue batch was EJECTED, so the
// cascade ends instead of re-enqueueing a PR the queue already dropped.
//
// SIGNAL: the PR's LATEST merge_group run (head_branch gh-readonly-queue/<base>/pr-<N>-<sha>), and
// only that run. Its failing job must print the EJECTED line that get-merge-group-prs.sh emits
// immediately before `exit 3` (t/422#20a, PR #5149). A confirmed match is 'ejected' -> skip.
//
// FAIL OPEN (TL p/9#192): anything not confirmed is NOT a skip. A failed read returns 'unknown'
// with a WARN, and the sweep proceeds as it did before this check. A pending, passed or missing
// queue run returns 'not_ejected'. Only an exit-3 line on the latest run skips a PR.
//
// Read-only: lists runs, jobs and logs. No write permission is used.

// The line get-merge-group-prs.sh prints before `exit 3` (see its EJECTED branch).
export function ejectedLinePattern(prNumber) {
  // Matches the raw '::error::' form and the '##[error]' form GitHub writes into job logs.
  return new RegExp(`get-merge-group-prs: EJECTED -- PR #${prNumber} `);
}

// PURE. True only when the log carries the EJECTED line for this PR AND the exit-3 wording.
export function isEjectedLog(log, prNumber) {
  if (typeof log !== 'string' || !log) return false;
  return ejectedLinePattern(prNumber).test(log) && /\bExit 3\b/.test(log);
}

// PURE. The merge_group runs for this PR's queue entries, newest first. head_branch is
// 'gh-readonly-queue/<base>/pr-<N>-<sha>' (the API may also prefix 'refs/heads/').
export function queueRunsForPR(runs, prNumber, base = 'main') {
  const want = new RegExp(`^(refs/heads/)?gh-readonly-queue/${base}/pr-${prNumber}-`);
  return (runs ?? [])
    .filter((r) => r && r.event === 'merge_group' && want.test(r.head_branch ?? ''))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

// The queue entry is one merge-queue commit: every run that shares the newest run's head_branch.
// A batch runs more than one workflow (CI and CodeQL), created in the same second, so the verdict
// must look at all of them, not only the newest (SO t/423 fault on fcd5f7654). The EJECTED line is
// printed by one of them; the others can never skip alone.
export function queueEntryRuns(runs, prNumber, base = 'main') {
  const all = queueRunsForPR(runs, prNumber, base);
  if (all.length === 0) return [];
  const branch = all[0].head_branch;
  return all.filter((r) => r.head_branch === branch);
}

// PURE core: decide from the latest queue entry and its readers. Readers are injected so tests
// can fake them. Any thrown read -> 'unknown' (fail open).
// pushedAt (epoch ms, the PR's last push) makes the skip one-shot: an EJECTED entry that predates
// the last push is about an old head, so it must not block the fixed head (SO t/423#12). The
// entry's time is its newest run. With no push time it does not skip.
export function ejectedBatchVerdict({ prNumber, runs, base = 'main', pushedAt = null, readJobs, readLog }) {
  const entry = queueEntryRuns(runs, prNumber, base);
  if (entry.length === 0) return { verdict: 'not_ejected', reason: 'no merge-queue run for this PR' };
  const newestId = entry[0].id;
  if (entry.some((r) => r.status && r.status !== 'completed')) {
    return { verdict: 'not_ejected', runId: newestId, reason: 'latest queue entry still running' };
  }
  const entryAt = Math.max(...entry.map((r) => Date.parse(r.created_at ?? '')));
  if (pushedAt == null || Number.isNaN(entryAt) || entryAt <= pushedAt) {
    return { verdict: 'not_ejected', runId: newestId, reason: 'latest queue entry is not newer than the last push' };
  }
  for (const run of entry) {
    let jobs;
    try {
      jobs = readJobs(run.id);
    } catch (err) {
      return { verdict: 'unknown', runId: run.id, reason: `could not read jobs: ${err.message ?? err}` };
    }
    const failing = (jobs ?? []).filter((j) => j.conclusion === 'failure');
    for (const job of failing) {
      let log;
      try {
        log = readLog(job.id);
      } catch (err) {
        return { verdict: 'unknown', runId: run.id, reason: `could not read log of job ${job.id}: ${err.message ?? err}` };
      }
      if (isEjectedLog(log, prNumber)) {
        return { verdict: 'ejected', runId: run.id, jobId: job.id, reason: `EJECTED exit 3 on run ${run.id} of the latest queue entry` };
      }
    }
  }
  return { verdict: 'not_ejected', runId: newestId, reason: 'latest queue entry did not exit 3' };
}

// Real readers (gh, read-only). Bounded: one page of merge_group runs, one page of jobs per run.
export function listMergeGroupRuns(repo, ghFn) {
  const out = ghFn(['api', `repos/${repo}/actions/runs?event=merge_group&per_page=100`, '--jq', '.workflow_runs']);
  return JSON.parse(out);
}

export function listRunJobs(repo, runId, ghFn) {
  const out = ghFn(['api', `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, '--jq', '.jobs']);
  return JSON.parse(out);
}

export function readJobLog(repo, jobId, ghFn) {
  return ghFn(['api', `repos/${repo}/actions/jobs/${jobId}/logs`]);
}
