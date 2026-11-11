#!/usr/bin/env node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/391 (t/385): cancel `pull_request` runs nobody will read. Every push to a PR queues ~50 jobs,
// and the runs for the previous head keep queuing and running to completion even though no gate
// reads a non-head SHA. With ~210k runner-minutes in 11 days, GitHub now runs us one job at a
// time (t/386). This cancels a queued or in-progress run when:
//   - SUPERSEDED: its PR is open and the PR's current head is a different SHA; or
//   - CLOSED: its PR is no longer open.
// Never touched: merge_group, push, schedule and workflow_dispatch runs (event != pull_request),
// pull_request_target runs (their head_sha is the BASE, so "superseded" can't be judged), and any
// run we can't attribute to a PR (fail-safe: leave it). Required contexts are only ever read at
// the PR's current head, so cancelling old-head runs can't block a merge; this is why it lives
// outside the guards (workflow-lint R4 forbids per-PR concurrency groups on required contexts).
//
// Order matters (see collect()): runs are listed BEFORE open PRs, and each PR is re-read just
// before its run is cancelled (executeCancellations()), so a push racing this job can never get
// its new head's run cancelled.
// GitHub cost per invocation: one listing per run status (queued, in_progress, pending, waiting),
// one page of open PRs, and per candidate one PR re-read plus one cancel POST.
// Usage (workflow): GITHUB_TOKEN=... GITHUB_REPOSITORY=o/r node cancel-superseded-runs.mjs [--dry-run]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withGitHubRetry } from './github-retry.mjs';

export const ACTIVE_STATUSES = ['queued', 'in_progress', 'pending', 'waiting'];

/**
 * PURE. `runs`: REST workflow-run objects. `openPrs`: REST pull objects (state open).
 * Returns [{ run, reason }] for the runs to cancel; `selfRunId` (this canceller's own run) is never
 * returned.
 */
export function selectRunsToCancel({ runs, openPrs, selfRunId, openPrsTruncated = false }) {
  const byNumber = new Map(openPrs.map((p) => [p.number, p]));
  const byHead = new Map(openPrs.map((p) => [`${p.head?.repo?.full_name}:${p.head?.ref}`, p]));
  const out = [];
  for (const run of runs) {
    if (run.event !== 'pull_request' || run.status === 'completed' || run.id === selfRunId) continue;
    const linked = (run.pull_requests ?? []).map((p) => p.number);
    let pr = linked.map((n) => byNumber.get(n)).find(Boolean);
    if (!pr) pr = byHead.get(`${run.head_repository?.full_name}:${run.head_branch}`);
    if (!pr) {
      // Linked to a PR number that is not open any more: closed or merged. An unlinked run with
      // no open PR on its branch (fork, deleted ref) is left alone: we can't prove it's dead.
      // With a truncated open-PR list, "not in the list" proves nothing, so nothing counts as closed.
      if (linked.length && !openPrsTruncated) out.push({ run, prNumber: linked[0], reason: `PR #${linked[0]} is closed` });
      continue;
    }
    if (pr.head?.sha && run.head_sha !== pr.head.sha) {
      out.push({ run, prNumber: pr.number, reason: `superseded: PR #${pr.number} head is ${pr.head.sha.slice(0, 9)}, this run is ${String(run.head_sha).slice(0, 9)}` });
    }
  }
  return out;
}

/**
 * The listings, in the only safe order: RUNS FIRST, then open PRs. A push between the two calls
 * then shows the PR at its newer head while the run list can only hold older heads, so a new
 * head's run is never mistaken for a superseded one (Quality, #5109 p/119#36).
 */
export async function collect({ listRuns, listOpenPrs }) {
  const runs = await listRuns();
  const { items: openPrs, truncated } = await listOpenPrs();
  return { runs, openPrs, openPrsTruncated: truncated };
}

/**
 * Cancels each pick only after re-reading its PR immediately before the cancel (TL p/9#75): skip
 * it if the PR's head is now the run's own SHA (a push or force-push back), cancel it if the PR is
 * closed or its head is another SHA. `getPr(n)` → REST pull or throws; `cancel(run)` → throws
 * (err.status) on failure. Returns per-pick outcomes.
 */
export async function executeCancellations({ picks, getPr, cancel, log = console.log }) {
  const outcomes = [];
  for (const { run, prNumber, reason } of picks) {
    const label = `${run.name} #${run.id} (${run.status})`;
    let pr;
    try { pr = await getPr(prNumber); } catch (e) {
      log(`::warning::cancel-superseded-runs: could not re-read PR #${prNumber} before cancelling ${label} (${e.message}); left running.`);
      outcomes.push({ id: run.id, outcome: 'skipped-unverified' });
      continue;
    }
    if (pr.state === 'open' && pr.head?.sha === run.head_sha) {
      log(`skip ${label}: PR #${prNumber} head is now this run's SHA ${String(run.head_sha).slice(0, 9)}`);
      outcomes.push({ id: run.id, outcome: 'skipped-current-head' });
      continue;
    }
    try {
      await cancel(run);
      log(`cancelled ${label}: ${reason}`);
      outcomes.push({ id: run.id, outcome: 'cancelled' });
    } catch (e) {
      // 409: it finished or was cancelled between the listing and now. Anything else: WARN and go
      // on; a run we fail to cancel just runs to completion, as it would have without this job.
      if (e.status === 409) { log(`skip ${label}: already finished`); outcomes.push({ id: run.id, outcome: 'skipped-finished' }); }
      else { log(`::warning::cancel-superseded-runs: could not cancel ${label} (${e.message}); it will run to completion.`); outcomes.push({ id: run.id, outcome: 'failed' }); }
    }
  }
  return outcomes;
}

async function api(token, method, url) {
  return withGitHubRetry(`${method} ${url}`, async () => {
    const res = await fetch(`https://api.github.com/${url}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!res.ok) {
      const err = new Error(`${method} ${url}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 202 || res.status === 204 ? null : res.json();
  });
}

async function listAll(token, url, key) {
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const body = await api(token, 'GET', `${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const batch = key ? body[key] : body;
    items.push(...batch);
    if (batch.length < 100) return { items, truncated: false };
  }
  console.log(`::warning::cancel-superseded-runs: ${url} has more than 1000 entries; only the first 1000 were considered.`);
  return { items, truncated: true };
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const dryRun = process.argv.includes('--dry-run');
  if (!token || !repo) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');
  const selfRunId = Number(process.env.GITHUB_RUN_ID) || null;

  const { runs, openPrs, openPrsTruncated } = await collect({
    listRuns: async () => {
      const all = [];
      for (const status of ACTIVE_STATUSES) {
        all.push(...(await listAll(token, `repos/${repo}/actions/runs?event=pull_request&status=${status}`, 'workflow_runs')).items);
      }
      return all;
    },
    listOpenPrs: () => listAll(token, `repos/${repo}/pulls?state=open`),
  });
  const picks = selectRunsToCancel({ runs, openPrs, selfRunId, openPrsTruncated });
  let cancelled = 0;
  if (dryRun) for (const { run, reason } of picks) console.log(`would cancel ${run.name} #${run.id} (${run.status}): ${reason}`);
  else {
    const outcomes = await executeCancellations({
      picks,
      getPr: (n) => api(token, 'GET', `repos/${repo}/pulls/${n}`),
      cancel: (run) => api(token, 'POST', `repos/${repo}/actions/runs/${run.id}/cancel`),
    });
    cancelled = outcomes.filter((o) => o.outcome === 'cancelled').length;
  }
  const summary = `cancel-superseded-runs: ${runs.length} active pull_request runs, ${openPrs.length} open PRs; ${dryRun ? `${picks.length} would be cancelled (dry run)` : `${cancelled}/${picks.length} cancelled`}.`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.log(`::error::cancel-superseded-runs: ${e.message}`); process.exit(1); });
}
