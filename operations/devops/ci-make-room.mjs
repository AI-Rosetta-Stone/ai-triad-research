// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/705 (TL ask t/512#4): the incident fast lane. One CI run creates 44 to 59 jobs against a limit of about 60, so an incident fix's
// checks wait behind every other PR's run. Today the only way to make room is cancelling other runs by hand. This lists them, and on
// the TL's go cancels them.
//
//   node operations/devops/ci-make-room.mjs [--repo=owner/name]
//       LIST ONLY (the default). Queued and in-progress `pull_request` runs of ci.yml whose head branch is not incident/*: PR, branch,
//       age and job count, newest first. Nothing is cancelled.
//   node operations/devops/ci-make-room.mjs --cancel --incident=t/N --by=<TL collaborator id> [--repo=owner/name]
//       Cancels exactly those runs. Refuses without an --incident ticket reference and a --by id. Prints each run it cancelled and the
//       command that re-runs it. Never touches merge_group, push, schedule or dispatch runs, any other workflow (the guards), or a run
//       of an incident/* branch.
//
// What this cannot check: that t/N is an OPEN ticket titled INCIDENT, or that --by is the Tech Lead. A script cannot read the tickets app,
// so those are the TL's go, recorded in the printed line; `--incident` and `--by` make the cancel attributable, they do not authorise it.
// Fail closed: if the run list cannot be read, nothing is listed and nothing is cancelled.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const WORKFLOW = 'ci.yml';
export const STATUSES = Object.freeze(['queued', 'in_progress']);

/** PURE. Parses argv: { cancel, incident, by, repo } or { error }. */
export function parseArgs(argv) {
  const out = { cancel: false, incident: null, by: null, repo: null };
  for (const a of argv) {
    if (a === '--cancel') { out.cancel = true; continue; }
    const m = /^--(incident|by|repo)=(.*)$/.exec(a);
    if (!m) return { error: `unknown argument: ${a}` };
    out[m[1]] = m[2];
  }
  if (out.incident !== null && !/^t\/[1-9]\d{0,6}$/.test(out.incident)) return { error: `--incident must be a ticket reference like t/705, got "${out.incident}"` };
  if (out.by !== null && !/^[A-Za-z0-9-]{8,64}$/.test(out.by)) return { error: '--by must be a collaborator id' };
  if (out.repo !== null && !/^[\w.-]+\/[\w.-]+$/.test(out.repo)) return { error: `--repo must be owner/name, got "${out.repo}"` };
  if (out.cancel && (!out.incident || !out.by)) return { error: '--cancel needs --incident=t/N (the open INCIDENT ticket) and --by=<the TL\'s collaborator id>' };
  if (!out.cancel && (out.incident || out.by)) return { error: '--incident and --by only apply with --cancel (the default is list-only)' };
  return out;
}

/** PURE. Which runs make room: ci.yml pull_request runs, queued or in progress, not on an incident/* branch. */
export function selectRuns(runs) {
  return runs
    .filter((r) => r?.event === 'pull_request'
      && r?.path?.endsWith(`/${WORKFLOW}`) === true
      && STATUSES.includes(r?.status)
      && typeof r?.head_branch === 'string' && r.head_branch !== '' && !r.head_branch.startsWith('incident/'))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export function ageOf(createdAt, now) {
  const ms = now - Date.parse(createdAt);
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const m = Math.floor(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/** PURE. One line per run. `jobs` may be null (the job count could not be read). */
export function formatRun(run, jobs, now) {
  const pr = run.pull_requests?.[0]?.number;
  return `run ${run.id}  ${run.status.padEnd(11)} PR ${pr ? `#${pr}` : '(none)'}  ${run.head_branch}  age ${ageOf(run.created_at, now)}  jobs ${jobs ?? '?'}`;
}

/** PURE. The command that re-runs a cancelled run. */
export function rerunCommand(run, repo) {
  return `gh run rerun ${run.id} --repo ${repo}`;
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
}

export function repoSlugFromOrigin(url) {
  const m = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/.exec(String(url ?? '').trim());
  return m ? m[1] : null;
}

/** Reads the candidate runs (both statuses, paged). Throws on any failure: nothing is listed or cancelled then. */
export function readRuns(repo, ghFn = gh) {
  const all = [];
  for (const status of STATUSES) {
    const out = ghFn(['api', '--paginate', `repos/${repo}/actions/workflows/${WORKFLOW}/runs?status=${status}&event=pull_request&per_page=100`, '--jq', '.workflow_runs[] | @json']);
    for (const line of out.split(/\r?\n/).filter((l) => l.trim())) all.push(JSON.parse(line));
  }
  return all;
}

function jobCount(repo, id, ghFn) {
  try {
    const n = Number(ghFn(['api', `repos/${repo}/actions/runs/${id}/jobs?per_page=1`, '--jq', '.total_count']).trim());
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Lists, or (with `cancel`) cancels. Returns { listed, cancelled, failed }. Never throws for a single cancel failure (it is reported and the
 * rest continue); a failure to read the run list throws and nothing is cancelled.
 */
export function makeRoom({ repo, cancel = false, incident = null, by = null, ghFn = gh, now = Date.now(), log = console.log }) {
  const runs = selectRuns(readRuns(repo, ghFn));
  log(`ci-make-room: ${runs.length} queued or in-progress pull_request ${WORKFLOW} run(s) not on an incident/* branch (${repo}, newest first)`);
  const listed = runs.map((r) => ({ run: r, jobs: jobCount(repo, r.id, ghFn) }));
  for (const { run, jobs } of listed) log(`  ${formatRun(run, jobs, now)}`);
  const total = listed.reduce((s, x) => s + (x.jobs ?? 0), 0);
  log(`ci-make-room: ${total} job(s) across them${listed.some((x) => x.jobs === null) ? ' (some counts unreadable)' : ''}`);
  if (!cancel) {
    log('ci-make-room: list only; nothing was cancelled. To cancel on the TL\'s go: --cancel --incident=t/N --by=<TL id>');
    return { listed: listed.map((x) => x.run.id), cancelled: [], failed: [] };
  }
  const cancelled = [];
  const failed = [];
  for (const { run } of listed) {
    try {
      ghFn(['api', '-X', 'POST', `repos/${repo}/actions/runs/${run.id}/cancel`]);
      cancelled.push(run.id);
      log(`ci-make-room: CANCELLED run ${run.id} (PR ${run.pull_requests?.[0]?.number ? `#${run.pull_requests[0].number}` : '(none)'}, ${run.head_branch}) for ${incident} by ${by}. Re-run it with: ${rerunCommand(run, repo)}`);
    } catch (err) {
      failed.push(run.id);
      log(`ci-make-room: could not cancel run ${run.id}: ${String(err?.message ?? err).split('\n')[0].slice(0, 160)}`);
    }
  }
  log(`ci-make-room: cancelled ${cancelled.length} of ${listed.length} for ${incident} by ${by}${failed.length ? `; ${failed.length} could not be cancelled` : ''}`);
  return { listed: listed.map((x) => x.run.id), cancelled, failed };
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`ci-make-room: ${args.error}\n  Usage: node operations/devops/ci-make-room.mjs [--repo=owner/name]   (list only)\n         node operations/devops/ci-make-room.mjs --cancel --incident=t/N --by=<TL id> [--repo=owner/name]`);
    process.exit(2);
  }
  try {
    const repo = args.repo ?? repoSlugFromOrigin(execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', windowsHide: true }));
    if (!repo) throw new Error('origin is not a GitHub repository; pass --repo=owner/name');
    const r = makeRoom({ repo, cancel: args.cancel, incident: args.incident, by: args.by });
    process.exit(r.failed.length ? 1 : 0);
  } catch (err) {
    console.error(`ci-make-room: could not read the run list; nothing was listed or cancelled (${String(err?.message ?? err).split('\n')[0]}).`);
    process.exit(1);
  }
}
