#!/usr/bin/env node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/387 (t/385 cause 3): an infra failure in a merge-group run ejects the PR at the head of the
// queue and DISARMS it, and nothing re-armed it (9 approved green PRs sat unarmed on 2026-11-11
// until the TL re-armed them by hand). This sweep re-arms a PR ejected by an INFRA failure, and
// only then:
//   - candidates: open, non-draft PRs that are neither queued nor armed, removed from the merge
//     queue in the last 24h for a reason other than `merged` / `manual`;
//   - classification (classifyEjection): INFRA only if EVERY failed job of the PR's latest
//     merge_group CI run before the removal is infra by its step (setup/install/checkout/cache
//     failed WITH an infra signature in its log or annotations), its conclusion (cancelled / timed
//     out: runner loss, or a batch cancelled because another entry failed) or its annotations
//     (rate limit incl. the agreed `INFRA rate-limit:` line, DNS, network, runner shutdown). Anything else, or anything unreadable, is NOT infra: never
//     re-arm on doubt;
//   - re-arm through enqueue-pr.mjs, which enforces the tier guard, approvals at the head and
//     drafts, so this can never arm what a human couldn't; at most MAX_PER_HEAD times per head,
//     counted by a PR comment marker;
//   - not infra: one PR comment per head naming the failing job/step (owners see it in my-prs.mjs).
// Runs as a step of enqueue-sweep.yml on the App token (a GITHUB_TOKEN enqueue would not trigger
// merge_group CI). GitHub cost: 1 GraphQL query (all open PRs), 1 REST listing of recent
// merge_group CI runs, then per CANDIDATE 1 jobs call + up to MAX_ANNOTATION_CALLS annotation calls.
//
// Usage: node infra-rearm-sweep.mjs <owner/repo> [--dry-run] [--replay-since <ISO>]
//   --replay-since: evaluate every removal since <ISO> regardless of the PR's current armed state
//   and print decisions only (implies --dry-run). Evidence mode for t/387.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_PER_HEAD = 2;
export const WINDOW_MS = 24 * 3600 * 1000;
export const MAX_ANNOTATION_CALLS = 6;
const NOT_ACTIONABLE = new Set(['merged', 'manual']);
const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure']);
// Aggregate gates fail BECAUSE another job failed; they carry no cause of their own, so they are
// left out of the classification (their constituents decide).
export const AGGREGATE_JOBS = new Set(['ci-gate']);
// A setup/install step, by an ANCHORED name. Its failure is NOT infra on its own (a real
// ERR_PNPM_OUTDATED_LOCKFILE or a missing Python version fails here too, Quality #5113): it only
// tells the sweep to read that job's log for an INFRA_SIGNATURE_RE match.
export const SETUP_STEP_RE = /^(set up job|run actions\/checkout@\S+|checkout\b|install\b|setup\b|set up\b|restore\b|cache\b|(sudo )?(apt|apt-get|pnpm|npm|pip|pip3|corepack)\b)/i;
export const INFRA_SIGNATURE_RE = /INFRA rate-limit:|API rate limit (already )?exceeded|secondary rate limit|abuse detection|Temporary failure resolving|Temporary failure in name resolution|Could not resolve host|getaddrinfo (ENOTFOUND|EAI_AGAIN)|\bEAI_AGAIN\b|\bETIMEDOUT\b|\bECONNRESET\b|\bECONNREFUSED\b|503 Service Unavailable|HTTP 503\b|status code 503\b|Failed to fetch|Connection timed out|TLS handshake timeout|lost communication with the server|runner has received a shutdown signal|No space left on device|The hosted runner encountered an error/i;
export const MARKER_RE = /<!-- infra-rearm head=([0-9a-f]{40}) n=(\d+) -->/g;
export const NOTICE_RE = /<!-- infra-rearm-notinfra head=([0-9a-f]{40}) -->/;
export const CAP_RE = /<!-- infra-rearm-cap head=([0-9a-f]{40}) -->/;

/**
 * PURE. `jobs`: [{ name, conclusion, steps: [{ name, conclusion }], annotations: [{ message }] | null }].
 * Returns { infra, reason, detail: [per failed job] }. annotations === null means "not read".
 */
export function classifyEjection({ jobs }) {
  if (!Array.isArray(jobs)) return { infra: false, reason: 'merge_group run unreadable', detail: [] };
  const failed = jobs.filter((j) => FAILED.has(String(j.conclusion)) && !AGGREGATE_JOBS.has(j.name));
  if (!failed.length) return { infra: false, reason: 'no failed job in the merge_group run (another check ejected it)', detail: [] };
  const detail = failed.map((j) => {
    const step = (j.steps ?? []).find((s) => FAILED.has(String(s.conclusion)));
    const ann = (j.annotations ?? []).map((a) => String(a.message ?? '')).find((m) => INFRA_SIGNATURE_RE.test(m));
    const logHit = typeof j.log === 'string' ? (j.log.match(INFRA_SIGNATURE_RE) ?? [])[0] : null;
    const setup = !!step && SETUP_STEP_RE.test(step.name);
    let why = null;
    if (ann) why = `annotation: ${ann.slice(0, 120)}`;
    else if (j.conclusion === 'cancelled' || j.conclusion === 'timed_out' || j.conclusion === 'startup_failure') why = `job ${j.conclusion}`;
    else if (setup && logHit) why = `setup step "${step.name}" failed with "${logHit}" in its log`;
    const notWhy = setup ? `setup step "${step.name}" failed without an infra signature (a real install/config failure)` : `test/check failure in step: ${step?.name ?? '(unknown step)'}`;
    return { job: j.name, step: step?.name ?? null, infra: !!why, why: why ?? notWhy };
  });
  const infra = detail.every((d) => d.infra);
  return { infra, reason: infra ? 'every failed job is infra' : 'a real failure', detail };
}

/** PURE. Re-arms already made for `headSha`, from the PR's comment markers. */
export function rearmCount(comments, headSha) {
  let n = 0;
  for (const c of comments ?? []) for (const m of String(c.body ?? '').matchAll(MARKER_RE)) if (m[1] === headSha) n = Math.max(n, Number(m[2]));
  return n;
}

/** PURE. The latest qualifying removal of a PR within the window, or null. */
export function lastEjection(pr, now, since = null) {
  const removals = (pr.timelineItems?.nodes ?? []).filter((e) => e.__typename === 'RemovedFromMergeQueueEvent');
  const last = removals.at(-1);
  if (!last) return null;
  const at = Date.parse(last.createdAt);
  if (since ? at < Date.parse(since) : now - at > WINDOW_MS) return null;
  if (NOT_ACTIONABLE.has(String(last.reason).toLowerCase())) return null;
  return { at, reason: String(last.reason).toLowerCase() };
}

/** PURE. Replay: every qualifying removal of a PR since `since` (a merged PR's earlier infra ejections). */
export function ejectionsSince(pr, since) {
  return (pr.timelineItems?.nodes ?? [])
    .filter((e) => e.__typename === 'RemovedFromMergeQueueEvent' && Date.parse(e.createdAt) >= Date.parse(since) && !NOT_ACTIONABLE.has(String(e.reason).toLowerCase()))
    .map((e) => ({ at: Date.parse(e.createdAt), reason: String(e.reason).toLowerCase() }));
}

/** PURE. The merge_group CI run that ejected PR #n: the latest completed one created before `at`. */
export function ejectingRun(runs, n, at) {
  return runs
    .filter((r) => new RegExp(`/pr-${n}-[0-9a-f]{40}$`).test(r.head_branch) && Date.parse(r.created_at) <= at && r.status === 'completed')
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null;
}

// ── I/O ───────────────────────────────────────────────────────────────────────────────────────
const gh = (args, input) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 28, input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
const ghJson = (p) => JSON.parse(gh(['api', p]));

function openPrs(repo, replay = false) {
  const [owner, name] = repo.split('/');
  const q = `query($o:String!,$n:String!){repository(owner:$o,name:$n){pullRequests(states:${replay ? "[OPEN,MERGED,CLOSED]" : "OPEN"},first:100,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number isDraft headRefOid isInMergeQueue autoMergeRequest{enabledAt} timelineItems(last:10,itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT,ADDED_TO_MERGE_QUEUE_EVENT]){nodes{__typename ... on RemovedFromMergeQueueEvent{createdAt reason}}} comments(last:40){nodes{body}}}}}}`;
  return JSON.parse(gh(['api', 'graphql', '-f', `query=${q}`, '-f', `o=${owner}`, '-f', `n=${name}`])).data.repository.pullRequests.nodes;
}

async function main() {
  const argv = process.argv.slice(2);
  const repo = argv[0];
  const since = argv.includes('--replay-since') ? argv[argv.indexOf('--replay-since') + 1] : null;
  const dryRun = argv.includes('--dry-run') || !!since;
  if (!repo || !repo.includes('/')) throw new Error('usage: infra-rearm-sweep.mjs <owner/repo> [--dry-run] [--replay-since <ISO>]');
  const now = Date.now();
  const prs = openPrs(repo, !!since);
  const candidates = since
    ? prs.flatMap((pr) => ejectionsSince(pr, since).map((ej) => ({ pr, ej })))
    : prs.map((pr) => ({ pr, ej: lastEjection(pr, now) })).filter(({ pr, ej }) => ej && !pr.isDraft && !pr.isInMergeQueue && !pr.autoMergeRequest);
  console.log(`infra-rearm: ${prs.length} ${since ? 'recently updated' : 'open'} PRs; ${candidates.length} ejected ${since ? `since ${since} (replay)` : 'in the last 24h and unarmed'}.`);
  if (!candidates.length) return;

  const oldest = new Date(Math.min(...candidates.map((c) => c.ej.at)) - 6 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  const runs = [];
  for (let page = 1; page <= 5; page++) {
    const b = ghJson(`repos/${repo}/actions/workflows/ci.yml/runs?event=merge_group&created=>=${oldest}&per_page=100&page=${page}`);
    runs.push(...b.workflow_runs);
    if (b.workflow_runs.length < 100) break;
  }

  for (const { pr, ej } of candidates) {
    const n = pr.number, head = pr.headRefOid;
    const run = ejectingRun(runs, n, ej.at);
    let verdict;
    if (!run) verdict = classifyEjection({ jobs: null });
    else {
      let jobs;
      try { jobs = ghJson(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`).jobs; } catch { jobs = null; }
      let annCalls = 0;
      for (const j of jobs ?? []) {
        if (!FAILED.has(String(j.conclusion))) continue;
        if (annCalls >= MAX_ANNOTATION_CALLS) { j.annotations = null; continue; }
        try { j.annotations = ghJson(`repos/${repo}/check-runs/${j.id}/annotations?per_page=50`); annCalls++; } catch { j.annotations = null; }
        const failedStep = (j.steps ?? []).find((s) => FAILED.has(String(s.conclusion)));
        if (failedStep && SETUP_STEP_RE.test(failedStep.name) && annCalls < MAX_ANNOTATION_CALLS) {
          try { j.log = gh(['api', `repos/${repo}/actions/jobs/${j.id}/logs`]).slice(-65536); annCalls++; } catch { j.log = null; }
        }
      }
      verdict = classifyEjection({ jobs });
    }
    const done = rearmCount(pr.comments?.nodes, head);
    const label = `#${n} @ ${head.slice(0, 9)} (removed ${new Date(ej.at).toISOString()}, ${ej.reason}; run ${run?.id ?? 'none'})`;
    const why = verdict.detail.map((d) => `${d.job}: ${d.why}`).join('; ') || verdict.reason;
    if (!verdict.infra) {
      console.log(`NOT INFRA ${label}: ${why}`);
      if (!dryRun && !(pr.comments?.nodes ?? []).some((c) => (c.body ?? '').match(NOTICE_RE)?.[1] === head)) {
        gh(['pr', 'comment', String(n), '--repo', repo, '--body-file', '-'],
          `<!-- infra-rearm-notinfra head=${head} -->\n**Merge queue ejection, not re-armed (t/387):** the merge-group run ${run ? run.html_url : '(not found)'} failed for a reason that is not infra: ${why}. Fix it and re-arm with \`node operations/devops/enqueue-pr.mjs ${repo} ${n}\`.`);
      }
      continue;
    }
    if (done >= MAX_PER_HEAD) {
      console.log(`CAP ${label}: already re-armed ${done}x at this head; leaving it (${why})`);
      if (!dryRun && !(pr.comments?.nodes ?? []).some((c) => (c.body ?? '').match(CAP_RE)?.[1] === head)) {
        gh(['pr', 'comment', String(n), '--repo', repo, '--body-file', '-'],
          `<!-- infra-rearm-cap head=${head} -->\n**Not re-armed again (t/387):** this head was already re-armed ${done}x after infra ejections and was ejected again (${why}). It may not be infra after all: check the run ${run?.html_url ?? ''}, then re-arm by hand with \`node operations/devops/enqueue-pr.mjs ${repo} ${n}\`.`);
      }
      continue;
    }
    if (dryRun) { console.log(`WOULD RE-ARM ${label} (attempt ${done + 1}/${MAX_PER_HEAD}): ${why}`); continue; }
    try {
      const out = execFileSync('node', [path.join(path.dirname(fileURLToPath(import.meta.url)), 'enqueue-pr.mjs'), repo, String(n)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      console.log(`RE-ARMED ${label}: ${out.trim().split('\n').at(-1)}`);
      gh(['pr', 'comment', String(n), '--repo', repo, '--body-file', '-'],
        `<!-- infra-rearm head=${head} n=${done + 1} -->\n**Re-armed after an infra ejection (t/387), attempt ${done + 1}/${MAX_PER_HEAD} at this head:** ${why}. Run: ${run.html_url}`);
    } catch (e) {
      // enqueue-pr refused (approvals, tier guard, draft) or failed: report, never force.
      console.log(`::warning::infra-rearm: enqueue-pr refused or failed for ${label}: ${String(e.stdout ?? '').trim().split('\n').slice(-2).join(' ') || e.message}`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.log(`::error::infra-rearm: ${e.message}`); process.exit(1); });
}
