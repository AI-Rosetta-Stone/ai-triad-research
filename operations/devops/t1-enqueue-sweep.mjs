// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Enqueue T1 PRs once their CI gates are green (t/455, TL p/9#276).
//
// THE T1 APPROVAL REQUIREMENT IS REMOVED (t/455, the PI's decision, 2026-11-15). T1 PRs merge on
// CI and branch protection alone. This sweep no longer reads an approval, the t1-approval-guard
// check, or a reviewer-App review. It enqueues a T1 PR only when ALL of these hold:
//   1. sharedSkipReason (t0-enqueue-sweep.mjs) finds nothing, with `Tier: T1` declared: same-repo,
//      base main, not draft, not queued, not Dependabot, no consult-hold / joint-gv / no-auto-enqueue
//      label, not manually dequeued, no conflict, review data complete, no active changes-request,
//      Design gate passed when user-facing, and ci-gate / CodeQL Analysis / joint-gv-guard /
//      consult-hold-guard all green;
//   2. enqueuePR (enqueue-pr.mjs) pins the head checked here, and refuses a draft or a failed
//      required check at that head (the failing-row refusal, t/455).
//
// REPORT-ONLY UNTIL --enqueue. enqueue-sweep.yml passes no --enqueue for the T1 step by default.
// Without --enqueue the sweep only selects and logs every skip reason and `[enqueue off] would
// enqueue #N`. `--dry-run` wins over --enqueue.
//
//   GH_TOKEN=<app token> node operations/devops/t1-enqueue-sweep.mjs <owner>/<repo> [--dry-run] [--enqueue]

import { fileURLToPath } from 'node:url';
import { parseTier } from './t1-approval-guard-predicate.mjs';
import { sharedSkipReason, listOpenPRs, enqueueOne } from './t0-enqueue-sweep.mjs';

/** PURE. True when the PR body declares Tier: T1, parsed exactly as the sweeps parse it. */
export function declaresT1(body) {
  return parseTier(body) === 'T1';
}

/**
 * PURE. Splits open PRs into those to enqueue now and those to skip (with the reason). The only
 * T1 rule left is the shared one: a declared T1 PR with its CI gates green.
 */
export function selectT1Candidates(prs) {
  const enqueue = [];
  const skip = [];
  for (const pr of prs) {
    const reason = sharedSkipReason(pr, { declares: declaresT1, tierName: 'T1' });
    if (reason) skip.push({ number: pr.number, reason });
    else enqueue.push({ number: pr.number, headRefOid: pr.headRefOid, armed: pr.autoMergeRequest != null });
  }
  return { enqueue, skip };
}

/**
 * PURE. The CLI's arguments: `<owner>/<repo> [--dry-run] [--enqueue]`. The enqueue gate is on only
 * with the exact `--enqueue` flag.
 */
export function parseCliArgs(argv) {
  const args = argv ?? [];
  return {
    repo: args.find((a) => !a.startsWith('--')) ?? null,
    dryRun: args.includes('--dry-run'),
    enqueueEnabled: args.includes('--enqueue'),
  };
}

/**
 * One pass. `deps` replaces the listing and enqueueOne's own deps in tests. The gate
 * `enqueueEnabled` is off by default and turns on only for the boolean `true`, so a stray string
 * cannot enqueue. With it off the sweep only reports. `dryRun` wins over everything.
 */
export async function sweep(repo, { dryRun = false, enqueueEnabled = false, deps = {} } = {}) {
  const { list = listOpenPRs, enqueueDeps } = deps;
  const enqueueOn = enqueueEnabled === true;
  if (!dryRun) {
    console.log(`T1 sweep: enqueue is ${enqueueOn ? 'ON (--enqueue)' : 'OFF (no --enqueue)'}.` +
      (enqueueOn ? '' : ' This run only reports.'));
  }
  const prs = list(repo);
  const { enqueue, skip } = selectT1Candidates(prs);
  for (const s of skip) console.log(`skip #${s.number}: ${s.reason}`);
  if (enqueue.length === 0) console.log('no T1 PRs to enqueue.');

  const outcomes = {};
  const failures = [];
  for (const pr of enqueue) {
    if (dryRun) { console.log(`[dry-run] would enqueue #${pr.number} at ${pr.headRefOid}`); continue; }
    if (!enqueueOn) { console.log(`[enqueue off] would enqueue #${pr.number} at ${pr.headRefOid}`); continue; }
    outcomes[pr.number] = await enqueueOne(repo, pr, { enqueueOpts: { expectedHeadOid: pr.headRefOid }, deps: enqueueDeps });
    if (outcomes[pr.number] === 'failed') failures.push(pr.number);
  }
  if (failures.length) {
    throw new Error(
      `t1-enqueue-sweep: failed to enqueue ${failures.map((n) => `#${n}`).join(', ')} on ${repo}.\n` +
      '  Goal:       land green T1 PRs through the merge queue.\n' +
      '  Problem:    enqueue-pr.mjs could not get these PRs into the queue as the App.\n' +
      '  Location:   operations/devops/t1-enqueue-sweep.mjs (see the ::error:: lines above).\n' +
      "  Next steps: check each PR's mergeStateStatus; the next sweep retries automatically.",
    );
  }
  return outcomes;
}

const isCliEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCliEntry) {
  const { repo, dryRun, enqueueEnabled } = parseCliArgs(process.argv.slice(2));
  if (!repo) {
    console.error('Usage: node operations/devops/t1-enqueue-sweep.mjs <owner>/<repo> [--dry-run] [--enqueue]');
    process.exit(1);
  }
  sweep(repo, { dryRun, enqueueEnabled }).then(
    () => {},
    (err) => { console.error(err.message ?? err); process.exit(1); },
  );
}
