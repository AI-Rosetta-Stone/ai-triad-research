#!/usr/bin/env node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/385 / t/397 (TL p/9#90, p/9#91): the PR-volume metric, reported at 12:00Z and 18:00Z.
//   - PRs created and merged in the last 24h (search API totals, 2 calls);
//   - median size (additions + deletions) of the PRs merged in the last 24h (1 GraphQL search);
//   - peak parallel jobs per UTC hour over the window: every job's [started_at, completed_at]
//     interval from the jobs of each run created in the window, swept per hour. This is the
//     t/386 throttle signal: GitHub ran us at 1 job from ~16:15Z on 2026-11-11, and the TL closes
//     t/386 once it is back above 5.
// The jobs loop is bounded: --max-job-calls (default 1200) and a gh-budget.mjs check first (t/396),
// so it can never drain a shared pool. Run it on the reviewer App token (separate pool).
// Usage: node pr-volume-metric.mjs <owner/repo> [--hours 6] [--max-job-calls 1200]

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBudget, refusalError } from './gh-budget.mjs';

/** PURE. Median of numbers (null for none). */
export function median(xs) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * PURE. Peak number of simultaneously running jobs per UTC hour.
 * `jobs`: [{ started_at, completed_at|null, runner_name }]. Only jobs that got a RUNNER count: a job
 * cancelled while still queued has started_at..completed_at spanning its queue time, not runner time
 * (a 504 "peak" under the 1-job throttle on 2026-11-11 was exactly that).
 * `now`: ms, the end for still-running jobs. Returns [{ hour: 'YYYY-MM-DDTHH', peak }] sorted.
 */
export function peakParallelByHour(jobs, now) {
  const ev = [];
  for (const j of jobs) {
    if (!j.runner_name) continue;
    const s = Date.parse(j.started_at);
    if (!Number.isFinite(s)) continue;
    const e = j.completed_at ? Date.parse(j.completed_at) : now;
    if (!(e > s)) continue;
    ev.push([s, +1], [e, -1]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // an end before a start at the same instant
  const peaks = new Map();
  let cur = 0;
  const bump = (t) => { const h = new Date(t).toISOString().slice(0, 13); peaks.set(h, Math.max(peaks.get(h) ?? 0, cur)); };
  for (let i = 0; i < ev.length; i++) {
    const [t, d] = ev[i];
    // A job running across an hour boundary counts in every hour it spans.
    if (i > 0 && cur > 0) {
      for (let h = Math.floor(ev[i - 1][0] / 3600e3) + 1; h <= Math.floor(t / 3600e3); h++) bump(h * 3600e3);
    }
    cur += d;
    bump(t);
  }
  return [...peaks].sort().map(([hour, peak]) => ({ hour, peak }));
}

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
const ghJson = (p) => JSON.parse(gh(['api', p]));

async function main() {
  const argv = process.argv.slice(2);
  const repo = argv[0];
  const opt = (k, d) => (argv.includes(k) ? Number(argv[argv.indexOf(k) + 1]) : d);
  const hours = opt('--hours', 6), maxJobCalls = opt('--max-job-calls', 1200);
  if (!repo || !repo.includes('/')) throw new Error('usage: pr-volume-metric.mjs <owner/repo> [--hours 6] [--max-job-calls 1200]');
  const now = Date.now();
  const day = new Date(now - 24 * 3600e3).toISOString().replace(/\.\d+Z$/, 'Z');
  const created = ghJson(`search/issues?q=${encodeURIComponent(`repo:${repo} is:pr created:>=${day}`)}&per_page=1`).total_count;
  const merged = ghJson(`search/issues?q=${encodeURIComponent(`repo:${repo} is:pr is:merged merged:>=${day}`)}&per_page=1`).total_count;
  const q = `query($q:String!){search(query:$q,type:ISSUE,first:100){nodes{... on PullRequest{additions deletions}}}}`;
  const sizes = JSON.parse(gh(['api', 'graphql', '-f', `query=${q}`, '-f', `q=repo:${repo} is:pr is:merged merged:>=${day}`])).data.search.nodes.map((n) => n.additions + n.deletions);

  const from = new Date(now - hours * 3600e3);
  const runs = [];
  for (let h = from.getTime(); h < now; h += 3600e3) { // the runs API caps a filtered listing at 1000
    const a = new Date(h).toISOString().replace(/\.\d+Z$/, 'Z'), z = new Date(Math.min(h + 3599e3, now)).toISOString().replace(/\.\d+Z$/, 'Z');
    for (let page = 1; page <= 10; page++) {
      const b = ghJson(`repos/${repo}/actions/runs?created=${a}..${z}&per_page=100&page=${page}`);
      runs.push(...b.workflow_runs);
      if (b.workflow_runs.length < 100) break;
    }
  }
  // Newest first: if the call cap truncates, the recent hours (the live t/386 signal) stay complete.
  const started = runs.filter((r) => r.run_started_at).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const want = Math.min(started.length, maxJobCalls);
  const budget = checkBudget({ need: want, floor: 1000, pool: 'core', rateLimitJson: gh(['api', 'rate_limit']) });
  if (!budget.ok) throw refusalError(budget);
  const jobs = [];
  for (const r of started.slice(0, want)) {
    try { jobs.push(...ghJson(`repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`).jobs); } catch { /* one unreadable run: its jobs are missing from the peak */ }
  }
  const peaks = peakParallelByHour(jobs, now);
  const partial = started.length > want ? ` (partial: jobs of ${want}/${started.length} runs read, --max-job-calls ${maxJobCalls})` : '';
  const at = new Date(now).toISOString().slice(0, 16) + 'Z';
  console.log(`**PR-volume metric ${at}** (t/385, method: operations/devops/pr-volume-metric.mjs)`);
  console.log(`- PRs created in the last 24h: **${created}**; merged: **${merged}**`);
  console.log(`- Median size of PRs merged in the last 24h: **${median(sizes) ?? 'n/a'}** lines changed (additions + deletions, n=${sizes.length})`);
  console.log(`- Peak parallel jobs per hour, last ${hours}h${partial}: ${peaks.map((p) => `${p.hour.slice(11)}Z **${p.peak}**`).join(', ') || 'no jobs ran'}`);
  const latest = peaks.at(-1);
  console.log(`- t/386 (1-job throttle), latest hour ${latest ? `${latest.hour.slice(11)}Z peak ${latest.peak}` : 'n/a'}: ${latest && latest.peak > 5 ? 'ABOVE 5: tell the TL' : 'at or below 5: still throttled'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.log(`::error::pr-volume-metric: ${e.message}`); process.exit(1); });
}
