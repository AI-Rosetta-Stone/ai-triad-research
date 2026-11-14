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

// PURE core: decide from the latest queue run and its readers. Readers are injected so tests
// can fake them. Any thrown read -> 'unknown' (fail open).
// pushedAt (epoch ms, the PR's last push) makes the skip one-shot: an EJECTED run that predates
// the last push is about an old head, so it must not block the fixed head (SO t/423#12). With no
// push time, a run cannot be shown to be newer, so it does not skip.
export function ejectedBatchVerdict({ prNumber, runs, base = 'main', pushedAt = null, readJobs, readLog }) {
  const latest = queueRunsForPR(runs, prNumber, base)[0];
  if (!latest) return { verdict: 'not_ejected', reason: 'no merge-queue run for this PR' };
  if (latest.status && latest.status !== 'completed') {
    return { verdict: 'not_ejected', runId: latest.id, reason: 'latest queue run still running' };
  }
  const runAt = Date.parse(latest.created_at ?? '');
  if (pushedAt == null || Number.isNaN(runAt) || runAt <= pushedAt) {
    return { verdict: 'not_ejected', runId: latest.id, reason: 'latest queue run is not newer than the last push' };
  }
  let jobs;
  try {
    jobs = readJobs(latest.id);
  } catch (err) {
    return { verdict: 'unknown', runId: latest.id, reason: `could not read jobs: ${err.message ?? err}` };
  }
  const failing = (jobs ?? []).filter((j) => j.conclusion === 'failure');
  for (const job of failing) {
    let log;
    try {
      log = readLog(job.id);
    } catch (err) {
      return { verdict: 'unknown', runId: latest.id, reason: `could not read log of job ${job.id}: ${err.message ?? err}` };
    }
    if (isEjectedLog(log, prNumber)) {
      return { verdict: 'ejected', runId: latest.id, jobId: job.id, reason: `EJECTED exit 3 on run ${latest.id}` };
    }
  }
  return { verdict: 'not_ejected', runId: latest.id, reason: 'latest queue run did not exit 3' };
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
