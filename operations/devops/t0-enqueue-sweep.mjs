// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Enqueue T0 PRs that are green and idle but were never put in the merge queue.
//
// WHY: AGENTS.md asks authors to arm T0 PRs at creation, and they often don't. Over the
// five days after the merge queue launched, 9 T0 PRs waited 1-14h (about 35h in total)
// with green checks and nothing enqueued (e.g. #4077-#4084, ~3h each). This sweep does
// the arming: it runs as the GitHub App (GITHUB_TOKEN-initiated auto-merge never entered
// the queue, see dependabot-enqueue-sweep.mjs) and enqueues through enqueue-pr.mjs,
// which pins the head and verifies queue entry.
//
// A PR is enqueued only when ALL of these hold (PI decision, 2026-11-02):
//   - the body's first non-empty line declares `Tier: T0`, base is main, not a draft,
//     not already queued, not authored by Dependabot (that flow has its own sweep);
//   - no hold or opt-out label: consult-hold, joint-gv, no-auto-enqueue;
//   - no merge conflict, and every REQUIRED_GREEN context passed on the head;
//   - IDLE: nothing pushed for IDLE_MINUTES. Pushing to a queued PR is refused, so an
//     author still adding commits must not be cut off. The push time is taken as the
//     earliest check-run start on the head (CI starts within seconds of a push; GitHub's
//     commit pushedDate is deprecated and usually null).
//
// Pure core (`selectT0Candidates`) is unit-tested in t0-enqueue-sweep.test.mjs.
//
//   GH_TOKEN=<app token> node operations/devops/t0-enqueue-sweep.mjs <owner>/<repo> [--dry-run]

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enqueuePR } from './enqueue-pr.mjs';
import { checkVerdict } from './dependabot-enqueue-sweep.mjs';

export const IDLE_MINUTES = 15;
export const REQUIRED_CONTEXTS = ['ci-gate', 'CodeQL Analysis', 'joint-gv-guard', 'consult-hold-guard'];
export const BLOCKING_LABELS = ['consult-hold', 'joint-gv', 'no-auto-enqueue'];

/** PURE. True when the first non-empty line of a PR body declares Tier: T0 (AGENTS.md format). */
export function declaresT0(body) {
  const first = String(body ?? '').split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  return /^\s*Tier:\s*T0\b/i.test(first);
}

/** PURE. Earliest check-run start on the head, as a push-time proxy; null when unknown. */
export function headPushedAt(contexts) {
  const starts = (contexts ?? []).map((c) => Date.parse(c.startedAt ?? '')).filter((t) => !Number.isNaN(t));
  return starts.length ? Math.min(...starts) : null;
}

/** PURE. Splits open PRs into those to enqueue now and those to skip (with the reason). */
export function selectT0Candidates(prs, nowMs, { idleMinutes = IDLE_MINUTES } = {}) {
  const enqueue = [];
  const skip = [];
  for (const pr of prs) {
    const labels = pr.labels ?? [];
    const blocking = BLOCKING_LABELS.find((l) => labels.includes(l));
    let reason = null;
    if (!declaresT0(pr.body)) reason = 'not declared Tier: T0';
    else if (pr.baseRefName !== 'main') reason = `base is ${pr.baseRefName}, not main`;
    else if (pr.isDraft) reason = 'draft';
    else if (pr.isInMergeQueue) reason = 'already in merge queue';
    else if (/dependabot/i.test(pr.author ?? '')) reason = 'Dependabot PR (handled by dependabot-enqueue-sweep)';
    else if (blocking) reason = `label ${blocking}`;
    else if (pr.mergeStateStatus === 'DIRTY') reason = 'merge conflict';
    else {
      for (const name of REQUIRED_CONTEXTS) {
        const v = checkVerdict(pr.contexts, name);
        if (v !== 'success') { reason = `${name} is ${v}`; break; }
      }
      if (!reason) {
        const pushed = headPushedAt(pr.contexts);
        if (pushed == null) reason = 'push time unknown (no check runs with a start time)';
        else {
          const idle = (nowMs - pushed) / 60000;
          if (idle < idleMinutes) reason = `idle ${Math.floor(idle)}m < ${idleMinutes}m since last push`;
        }
      }
    }
    if (reason) skip.push({ number: pr.number, reason });
    else enqueue.push({ number: pr.number, headRefOid: pr.headRefOid, armed: pr.autoMergeRequest != null });
  }
  return { enqueue, skip };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function listOpenPRs(repo) {
  const query = `query($q:String!,$cursor:String){search(query:$q,type:ISSUE,first:50,after:$cursor){
    pageInfo{hasNextPage endCursor}
    nodes{... on PullRequest{
      number body headRefOid baseRefName isDraft isInMergeQueue mergeStateStatus
      author{login} labels(first:30){nodes{name}} autoMergeRequest{enabledAt}
      commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{
        ... on CheckRun{name status conclusion startedAt} ... on StatusContext{context state}}}}}}}}}}}`;
  const prs = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `q=repo:${repo} is:pr is:open base:main`];
    if (cursor) args.push('-f', `cursor=${cursor}`);
    const r = JSON.parse(gh(args)).data.search;
    for (const n of r.nodes) {
      prs.push({
        number: n.number, body: n.body, headRefOid: n.headRefOid, baseRefName: n.baseRefName,
        isDraft: n.isDraft, isInMergeQueue: n.isInMergeQueue, mergeStateStatus: n.mergeStateStatus,
        author: n.author?.login ?? '', labels: n.labels.nodes.map((l) => l.name),
        autoMergeRequest: n.autoMergeRequest,
        contexts: n.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [],
      });
    }
    if (!r.pageInfo.hasNextPage) break;
    cursor = r.pageInfo.endCursor;
  }
  return prs;
}

export async function sweep(repo, { dryRun = false } = {}) {
  const { enqueue, skip } = selectT0Candidates(listOpenPRs(repo), Date.now());
  for (const s of skip) console.log(`skip #${s.number}: ${s.reason}`);
  if (enqueue.length === 0) { console.log('No T0 PRs to enqueue.'); return; }

  const failures = [];
  for (const pr of enqueue) {
    if (dryRun) { console.log(`[dry-run] would enqueue #${pr.number} at ${pr.headRefOid}`); continue; }
    try {
      // An arm that never reached the queue (the silent-miss class, t/4740) is a no-op to
      // re-arm, so clear it first.
      if (pr.armed) gh(['pr', 'merge', String(pr.number), '-R', repo, '--disable-auto']);
      const result = await enqueuePR(repo, pr.number);
      console.log(`enqueued #${pr.number} (usedFallback=${result.usedFallback})`);
    } catch (err) {
      failures.push(pr.number);
      console.error(`::error::#${pr.number}: ${err.message ?? err}`);
    }
  }
  if (failures.length) {
    throw new Error(
      `t0-enqueue-sweep: failed to enqueue ${failures.map((n) => `#${n}`).join(', ')} on ${repo}.\n` +
      '  Goal:       land green, idle T0 PRs through the merge queue.\n' +
      '  Problem:    enqueue-pr.mjs could not get these PRs into the queue as the App.\n' +
      '  Location:   operations/devops/t0-enqueue-sweep.mjs (see the ::error:: lines above).\n' +
      "  Next steps: check each PR's mergeStateStatus; the next sweep retries automatically.",
    );
  }
}

const isCliEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCliEntry) {
  const repo = process.argv[2];
  if (!repo) {
    console.error('Usage: node operations/devops/t0-enqueue-sweep.mjs <owner>/<repo> [--dry-run]');
    process.exit(1);
  }
  sweep(repo, { dryRun: process.argv.includes('--dry-run') }).then(
    () => {},
    (err) => { console.error(err.message ?? err); process.exit(1); },
  );
}
