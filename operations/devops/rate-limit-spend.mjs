// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/563 step 2: GITHUB_TOKEN installation API spend per workflow and per job, from the snapshot lines
// the guards log at job start (t/563, rate-limit-snapshot-start-step.yml) and job end (t/314,
// rate-limit-snapshot-step.yml).
//
// WHAT A NUMBER MEANS: a job's delta is the change of the SHARED pool between its first and last
// step. Concurrent jobs spend the same pool, so a delta is an upper bound on that job's own spend,
// not the spend itself; summed over many runs it still ranks the heavy spenders. A pair whose window
// reset in between is DISCARDED and counted: for REST core, the start and end reset times differ;
// for GraphQL, `used` went down.
//
// Reading the logs spends the CALLER's token (one listing page per 100 runs, one log download per
// run), not the installation's GITHUB_TOKEN pool. Check `node operations/devops/gh-budget.mjs --need N`
// first; --max-runs bounds it.
//
//   node operations/devops/rate-limit-spend.mjs [--hours 24] [--repo owner/name] [--max-runs 400] [--json]
//
// Pure core: parseSnapshots, pairDeltas, aggregate, formatReport. Impure shim: collect (gh injectable).

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_TARGETS } from './rate-limit-snapshot-targets.mjs';

const START_RE = /t\/563 rate-limit-start: workflow=(.+?) job=(\S+) core used=(\d+) reset=(\S+) graphql used=(\d+) graphql_reset=(\d+)/;
const END_RE = /t\/314 rate-limit: workflow=(.+?) job=(\S+) core used=(\d+) remaining=\d+ limit=\d+ reset=(\S+) graphql used=(\d+) remaining=\d+ limit=\d+/;

/**
 * PURE. The snapshot lines in one run's log text, keyed by job id (a job runs once per run; a matrix
 * job's legs share the id, so each leg's lines are paired in order). Returns
 * [{ workflow, job, start?: {...}, end?: {...} }].
 */
export function parseSnapshots(logText) {
  const byJob = new Map();
  const slot = (workflow, job) => {
    if (!byJob.has(job)) byJob.set(job, []);
    const list = byJob.get(job);
    return { list, workflow };
  };
  for (const line of String(logText ?? '').split(/\r?\n/)) {
    let m = START_RE.exec(line);
    if (m) {
      const { list } = slot(m[1], m[2]);
      list.push({ workflow: m[1], job: m[2], start: { coreUsed: +m[3], coreReset: m[4], gqlUsed: +m[5], gqlReset: m[6] } });
      continue;
    }
    m = END_RE.exec(line);
    if (m) {
      const { list } = slot(m[1], m[2]);
      const open = list.find((e) => !e.end);
      const end = { coreUsed: +m[3], coreReset: m[4], gqlUsed: +m[5] };
      if (open) open.end = end; else list.push({ workflow: m[1], job: m[2], end });
    }
  }
  return [...byJob.values()].flat();
}

/** PURE. Per-pair deltas, with the reason a side was discarded. */
export function pairDeltas(entries) {
  return entries.map((e) => {
    const out = { workflow: e.workflow, job: e.job, core: null, gql: null, coreSkip: null, gqlSkip: null };
    if (!e.start || !e.end) {
      out.coreSkip = out.gqlSkip = e.start ? 'no end line' : 'no start line';
      return out;
    }
    if (e.start.coreReset !== e.end.coreReset) out.coreSkip = 'core window reset during the job';
    else if (e.end.coreUsed < e.start.coreUsed) out.coreSkip = 'core used went down';
    else out.core = e.end.coreUsed - e.start.coreUsed;
    if (e.end.gqlUsed < e.start.gqlUsed) out.gqlSkip = 'graphql window reset during the job';
    else out.gql = e.end.gqlUsed - e.start.gqlUsed;
    return out;
  });
}

/** PURE. Totals per workflow and per workflow:job, plus discard counts. */
export function aggregate(deltas) {
  const add = (map, key, d) => {
    const r = map.get(key) ?? { key, core: 0, coreN: 0, gql: 0, gqlN: 0 };
    if (d.core !== null) { r.core += d.core; r.coreN++; }
    if (d.gql !== null) { r.gql += d.gql; r.gqlN++; }
    map.set(key, r);
  };
  const perWorkflow = new Map();
  const perJob = new Map();
  let coreDiscarded = 0;
  let gqlDiscarded = 0;
  for (const d of deltas) {
    if (d.core === null) coreDiscarded++;
    if (d.gql === null) gqlDiscarded++;
    add(perWorkflow, d.workflow, d);
    add(perJob, `${d.workflow}:${d.job}`, d);
  }
  const sorted = (m, k) => [...m.values()].sort((a, b) => b[k] - a[k] || a.key.localeCompare(b.key));
  return {
    pairs: deltas.length, coreDiscarded, gqlDiscarded,
    perWorkflowCore: sorted(perWorkflow, 'core'), perWorkflowGql: sorted(perWorkflow, 'gql'),
    perJobCore: sorted(perJob, 'core'), perJobGql: sorted(perJob, 'gql'),
  };
}

/** PURE. A markdown report: per workflow, per job, top 10, for REST core and GraphQL separately. */
export function formatReport(agg, { hours, runs, from, to } = {}) {
  const table = (rows, k, n, label) => {
    const lines = [`| ${label} | ${k === 'core' ? 'REST core' : 'GraphQL'} spend | jobs measured |`, '|---|---|---|'];
    for (const r of rows.slice(0, n)) lines.push(`| ${r.key} | ${r[k]} | ${r[k === 'core' ? 'coreN' : 'gqlN']} |`);
    return lines.join('\n');
  };
  return [
    `## GITHUB_TOKEN installation spend (t/563)${hours ? `, last ${hours} h` : ''}`,
    '',
    `${runs ?? '?'} runs read${from ? `, ${from} to ${to}` : ''}; ${agg.pairs} job snapshot pairs; discarded (window reset or a missing line): core ${agg.coreDiscarded}, GraphQL ${agg.gqlDiscarded}.`,
    'A delta is the shared pool\'s change during the job: concurrent jobs blur it, so it is an upper bound on that job\'s own spend.',
    '',
    '### Top 10 jobs, REST core', table(agg.perJobCore, 'core', 10, 'workflow:job'),
    '', '### Top 10 jobs, GraphQL', table(agg.perJobGql, 'gql', 10, 'workflow:job'),
    '', '### Per workflow, REST core', table(agg.perWorkflowCore, 'core', 50, 'workflow'),
    '', '### Per workflow, GraphQL', table(agg.perWorkflowGql, 'gql', 50, 'workflow'),
    '',
  ].join('\n');
}

/** The workflow files that carry the snapshot steps (only their runs are read). */
export const TARGET_WORKFLOW_FILES = Object.freeze([...new Set(SNAPSHOT_TARGETS.map(([f]) => f))]);

/**
 * Impure (gh injectable). Lists completed runs of the target workflows created in the window, then
 * downloads each run's log and parses it. A failed log download is counted and skipped (WARN), so
 * one unreadable run cannot hide the rest; the count is in the report.
 */
export function collect({ repo, hours, maxRuns, gh, nowMs = Date.now(), warn = (m) => console.warn(m) }) {
  const since = new Date(nowMs - hours * 3600 * 1000).toISOString();
  const runs = [];
  for (const file of TARGET_WORKFLOW_FILES) {
    // Only runs that executed: a skipped or cancelled run has no job log (most guard runs are skipped
    // by their job-level `if:`), so reading it would only spend a call.
    const out = gh(['api', '-X', 'GET', '--paginate', `repos/${repo}/actions/workflows/${file}/runs?status=completed&created=>=${since}&per_page=100`,
      '--jq', '.workflow_runs[] | select(.conclusion == "success" or .conclusion == "failure") | [.id, .created_at] | @tsv']);
    for (const line of String(out).split('\n').filter(Boolean)) {
      const [id, createdAt] = line.split('\t');
      runs.push({ id, createdAt, file });
    }
  }
  runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const picked = runs.slice(0, maxRuns);
  let failed = 0;
  const entries = [];
  for (const r of picked) {
    try {
      entries.push(...parseSnapshots(gh(['run', 'view', r.id, '--repo', repo, '--log'])));
    } catch (err) {
      failed++;
      warn(`WARN rate-limit-spend: could not read the log of run ${r.id} (${r.file}): ${String(err?.message ?? err).split('\n')[0]}; skipped.`);
    }
  }
  const times = picked.map((r) => r.createdAt).sort();
  return { entries, runs: picked.length, listed: runs.length, failed, from: times[0], to: times[times.length - 1] };
}

const isCliEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCliEntry) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
  const repo = opt('--repo', 'AI-Rosetta-Stone/ai-triad-research');
  const hours = Number(opt('--hours', '24'));
  const maxRuns = Number(opt('--max-runs', '400'));
  const gh = (a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const c = collect({ repo, hours, maxRuns, gh });
  const agg = aggregate(pairDeltas(c.entries));
  if (args.includes('--json')) console.log(JSON.stringify({ ...c, entries: undefined, ...agg }));
  else console.log(formatReport(agg, { hours, runs: `${c.runs} of ${c.listed}${c.failed ? ` (${c.failed} unreadable)` : ''}`, from: c.from, to: c.to }));
}
