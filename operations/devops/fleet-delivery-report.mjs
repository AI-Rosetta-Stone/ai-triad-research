// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Impure CLI for the weekly fleet-delivery report (t/4107). Fetches facts via `gh`, calls the
 * pure functions in `fleet-delivery-metrics.mjs`, and prints a Markdown report to stdout.
 *
 * This file does NOT post to Orca (no MCP access from a plain script, same reasoning as the
 * TL's daily PI-load digest, t/4107#5/#17) — the weekly Orca reminder wakes an agent, who runs
 * this CLI, optionally dumping t/4107's own comments to a file first (--pi-load-comments) for
 * the PI-load section, then posts the printed report as a comment on t/4091.
 *
 * Usage:
 *   node operations/devops/fleet-delivery-report.mjs [--since ISO] [--until ISO]
 *     [--repo owner/repo] [--pi-load-comments <path-to-json-dump-of-ticket-comments>]
 *
 * Defaults: --since = 7 days before --until, --until = now, --repo = AI-Rosetta-Stone/ai-triad-research.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  leadTimeLegs,
  attributePRsToDeploys,
  mainRedRate,
  deploymentFailureRate,
  mainRecoveryMinutes,
  deployRecoveryMinutes,
  reworkRate,
  approvalWaitByTier,
  splitT2ApprovalWait,
  findSoClearedAt,
  prSizeDistribution,
  openPRAgeDays,
  parsePILoadLines,
} from './fleet-delivery-metrics.mjs';
import { extractTier } from './tier-check-predicate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Shells out to t2-budget-metric.mjs's own CLI rather than re-deriving tier tallies here --
 * that module owns the epic-child (base != main) exclusion fix (t/4122#5/#6) and re-deriving it
 * independently risks repeating the exact bug it fixed. */
function fetchT2Budget(repo, since, until) {
  const windowDays = Math.max(1, Math.round((until - since) / 86_400_000));
  try {
    const raw = execFileSync(
      process.execPath,
      [path.join(__dirname, 't2-budget-metric.mjs'), repo, String(windowDays)],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 * 16 },
    );
    const out = JSON.parse(raw);
    if (!out.ok) return { verdict: null, warning: `t2-budget-metric failed: ${out.error}` };
    return { verdict: out.verdict, excludedNonMain: out.excludedNonMain, warning: null };
  } catch (e) {
    return { verdict: null, warning: `could not run t2-budget-metric: ${e.message}` };
  }
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
}

function parseArgs(argv) {
  const out = { repo: 'AI-Rosetta-Stone/ai-triad-research' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since') out.since = argv[++i];
    else if (a === '--until') out.until = argv[++i];
    else if (a === '--repo') out.repo = argv[++i];
    else if (a === '--pi-load-comments') out.piLoadCommentsPath = argv[++i];
  }
  out.until = out.until ? new Date(out.until) : new Date();
  out.since = out.since ? new Date(out.since) : new Date(out.until.getTime() - 7 * 86_400_000);
  return out;
}

/** Fetches merged PRs in [since, until) with the fields every metric needs. Returns [] + a
 * warning string on fetch failure, never throws -- a partial report must say what's missing. */
function fetchMergedPRs(repo, since, until) {
  const search = `is:merged merged:${since.toISOString()}..${until.toISOString()}`;
  let basics;
  try {
    const raw = gh([
      'pr', 'list', '-R', repo, '--state', 'merged', '--search', search, '--limit', '500',
      '--json', 'number,title,headRefName,createdAt,mergedAt,additions,deletions,changedFiles,body',
    ]);
    basics = JSON.parse(raw);
  } catch (e) {
    return { prs: [], warning: `could not fetch merged PRs: ${e.message}` };
  }

  // The first-commit date and the actual changed-file PATHS (reworkRate needs real paths for
  // its file-overlap check -- `pr list --json changedFiles` is a COUNT, not a path list, a bug
  // caught live-firing this CLI: `new Set(3)` threw "number is not iterable") both need each
  // PR's own detail, which GraphQL's node-budget rejects when bulk-requested alongside hundreds
  // of PRs in one `pr list` call (observed: "requesting up to 1,000,000 possible nodes...
  // exceeds the maximum limit of 500,000"). Fetched per-PR instead -- fine at weekly volumes
  // (tens, not hundreds, of merged PRs per window). A single PR's failure degrades that PR's
  // firstCommitAt/changedFilePaths to null/[], not the whole report.
  const warnings = [];
  const prs = basics.map((pr) => {
    let firstCommitAt = null;
    let changedFilePaths = [];
    let ciGreenAt = null;
    try {
      const draw = gh(['pr', 'view', String(pr.number), '-R', repo, '--json', 'commits,files,statusCheckRollup']);
      const detail = JSON.parse(draw);
      const commits = detail.commits ?? [];
      if (commits.length > 0) firstCommitAt = commits[0].committedDate ?? commits[0].authoredDate ?? null;
      changedFilePaths = (detail.files ?? []).map((f) => f.path).filter(Boolean);
      // "CI green" = both required contexts pr-triage.yml's own nudge waits on (ci-gate AND
      // CodeQL) completed successfully -- the later of the two completedAt times. Either
      // missing or non-SUCCESS leaves ciGreenAt null, which approvalWaitByTier's `continue`
      // on a falsy ciGreenAt already excludes cleanly (no fake zero, no crash).
      const rollup = detail.statusCheckRollup ?? [];
      const ciGate = rollup.find((c) => c.name === 'ci-gate');
      const codeQL = rollup.find((c) => c.name === 'CodeQL');
      if (ciGate?.conclusion === 'SUCCESS' && codeQL?.conclusion === 'SUCCESS') {
        const t1 = new Date(ciGate.completedAt).getTime();
        const t2 = new Date(codeQL.completedAt).getTime();
        ciGreenAt = new Date(Math.max(t1, t2)).toISOString();
      }
    } catch (e) {
      warnings.push(`PR #${pr.number}: could not fetch commits/files/statusCheckRollup (${e.message})`);
    }
    // soClearedAt (t/4520): only T2 PRs need the agent-vs-human wait split, so comments are
    // fetched only for those -- avoids an extra API call per T0/T1 PR (the large majority).
    let soClearedAt = null;
    if (extractTier(pr.body) === 'T2') {
      try {
        const craw = gh(['pr', 'view', String(pr.number), '-R', repo, '--json', 'comments']);
        const commentsDetail = JSON.parse(craw).comments ?? [];
        soClearedAt = findSoClearedAt(commentsDetail.map((c) => ({ body: c.body, createdAt: c.createdAt })));
      } catch (e) {
        warnings.push(`PR #${pr.number}: could not fetch comments for T2 wait-split (${e.message})`);
      }
    }
    return {
      number: pr.number,
      title: pr.title,
      headRefName: pr.headRefName,
      createdAt: pr.createdAt,
      mergedAt: pr.mergedAt,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles, // count, used only by prSizeDistribution
      changedFilePaths, // actual paths, used only by reworkRate
      body: pr.body,
      firstCommitAt,
      ciGreenAt,
      soClearedAt,
    };
  });
  return { prs, warning: warnings.length > 0 ? `${warnings.length} PR(s) missing firstCommitAt/changedFilePaths (see individual errors, omitted here for brevity)` : null };
}

/** Fetches currently-open PRs' createdAt (a live snapshot, not windowed). */
function fetchOpenPRs(repo) {
  try {
    const raw = gh(['pr', 'list', '-R', repo, '--state', 'open', '--limit', '200', '--json', 'createdAt']);
    return { openPRs: JSON.parse(raw), warning: null };
  } catch (e) {
    return { openPRs: [], warning: `could not fetch open PRs: ${e.message}` };
  }
}

/** Fetches ci.yml push-to-main runs in [since, until). */
function fetchMainPushes(repo, since, until) {
  try {
    const raw = gh([
      'run', 'list', '-R', repo, '--workflow', 'ci.yml', '--event', 'push', '--branch', 'main',
      '--limit', '200', '--json', 'conclusion,createdAt',
    ]);
    const runs = JSON.parse(raw).filter((r) => {
      const t = new Date(r.createdAt);
      return t >= since && t < until && r.conclusion; // drop still-running/null-conclusion rows
    });
    return { mainPushes: runs.map((r) => ({ conclusion: r.conclusion, pushedAt: r.createdAt })), warning: null };
  } catch (e) {
    return { mainPushes: [], warning: `could not fetch main-push CI runs: ${e.message}` };
  }
}

/** Fetches deploy-azure.yml production runs in [since, until), with per-run job breakdown so
 * deploymentFailureRate can split a real deploy-job rollback from a preflight block. */
function fetchDeploys(repo, since, until) {
  try {
    const raw = gh([
      'run', 'list', '-R', repo, '--workflow', 'deploy-azure.yml',
      '--limit', '100', '--json', 'databaseId,conclusion,createdAt,updatedAt',
    ]);
    const runs = JSON.parse(raw).filter((r) => {
      const t = new Date(r.createdAt);
      return t >= since && t < until && r.conclusion;
    });
    const deploys = [];
    const warnings = [];
    for (const r of runs) {
      let jobName = null;
      if (r.conclusion === 'failure') {
        try {
          const jraw = gh(['run', 'view', String(r.databaseId), '-R', repo, '--json', 'jobs']);
          const jobs = JSON.parse(jraw).jobs ?? [];
          const failedJob = jobs.find((j) => j.conclusion === 'failure');
          jobName = failedJob?.name?.toLowerCase().includes('preflight') ? 'preflight'
            : failedJob?.name?.toLowerCase().includes('deploy') ? 'deploy'
              : failedJob?.name ?? null;
        } catch (e) {
          warnings.push(`could not fetch job breakdown for run ${r.databaseId}: ${e.message}`);
        }
      }
      deploys.push({
        conclusion: r.conclusion,
        jobName,
        deployedAt: r.updatedAt ?? r.createdAt,
        failedAt: r.conclusion === 'failure' ? r.createdAt : null,
      });
    }
    return { deploys, warning: warnings.length > 0 ? warnings.join('; ') : null };
  } catch (e) {
    return { deploys: [], warning: `could not fetch deploy-azure runs: ${e.message}` };
  }
}

/** Pairs each real (deploy-job, not preflight) rollback with the next successful deploy. */
function pairRealRollbacks(deploys) {
  const sorted = [...deploys].sort((a, b) => new Date(a.deployedAt) - new Date(b.deployedAt));
  const pairs = [];
  for (let i = 0; i < sorted.length; i++) {
    const d = sorted[i];
    if (d.conclusion !== 'failure' || d.jobName !== 'deploy') continue;
    const next = sorted.slice(i + 1).find((x) => x.conclusion === 'success');
    if (next) pairs.push({ failedAt: d.failedAt, recoveredAt: next.deployedAt });
  }
  return pairs;
}

function fmtDist(d, unit = '') {
  if (!d || d.n === 0) return 'no data';
  const r = (x) => (x == null ? '—' : Number(x).toFixed(2));
  return `n=${d.n} median=${r(d.median)}${unit} p90=${r(d.p90)}${unit} mean=${r(d.mean)}${unit} max=${r(d.max)}${unit}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const warnings = [];

  const { prs, warning: w1 } = fetchMergedPRs(args.repo, args.since, args.until);
  if (w1) warnings.push(w1);
  const { openPRs, warning: w2 } = fetchOpenPRs(args.repo);
  if (w2) warnings.push(w2);
  const { mainPushes, warning: w3 } = fetchMainPushes(args.repo, args.since, args.until);
  if (w3) warnings.push(w3);
  const { deploys, warning: w4 } = fetchDeploys(args.repo, args.since, args.until);
  if (w4) warnings.push(w4);

  const successfulDeploys = deploys.filter((d) => d.conclusion === 'success').map((d) => ({ deployedAt: d.deployedAt }));
  const attributed = attributePRsToDeploys(prs, successfulDeploys);
  const leadTime = leadTimeLegs(prs, attributed);
  const mainRed = mainRedRate(mainPushes);
  const deployFail = deploymentFailureRate(deploys);
  const mainRecovery = mainRecoveryMinutes(mainPushes);
  const realRollbackPairs = pairRealRollbacks(deploys);
  const deployRecovery = deployRecoveryMinutes(realRollbackPairs);
  const rework = reworkRate(prs.map((pr) => ({ ...pr, changedFiles: pr.changedFilePaths })));
  const approvalWait = approvalWaitByTier(
    prs.map((pr) => ({ body: pr.body, mergedAt: pr.mergedAt, ciGreenAt: pr.ciGreenAt })),
  );
  const t2WaitSplit = splitT2ApprovalWait(
    prs.map((pr) => ({ body: pr.body, mergedAt: pr.mergedAt, ciGreenAt: pr.ciGreenAt, soClearedAt: pr.soClearedAt })),
  );
  const prSize = prSizeDistribution(prs);
  const openAge = openPRAgeDays(openPRs);
  const { verdict: t2Verdict, warning: w5 } = fetchT2Budget(args.repo, args.since, args.until);
  if (w5) warnings.push(w5);

  let piLoadSection = '_PI load: not provided this run (needs t/4107\'s own comments — pass --pi-load-comments)._';
  if (args.piLoadCommentsPath) {
    try {
      const comments = JSON.parse(fs.readFileSync(args.piLoadCommentsPath, 'utf8'));
      const rows = parsePILoadLines(comments, args.since.toISOString(), args.until.toISOString());
      piLoadSection = rows.length === 0
        ? '_PI load: no digest lines found in this window._'
        : rows.map((r) => `- ${r.date}: asks=${r.asks} new=${r.new} carried=${r.carried} oldest_open_days=${r.oldestOpenDays} answered_since_last=${r.answeredSinceLast} other_tl_pings_to_pi=${r.otherTlPingsToPi}`).join('\n');
    } catch (e) {
      piLoadSection = `_PI load: could not read/parse --pi-load-comments: ${e.message}_`;
    }
  }

  const lines = [];
  lines.push(`## Fleet delivery report: ${args.since.toISOString().slice(0, 10)} to ${args.until.toISOString().slice(0, 10)}`);
  lines.push('');
  if (warnings.length > 0) {
    lines.push('**Fetch warnings (report is partial where noted):**');
    for (const w of warnings) lines.push(`- ${w}`);
    lines.push('');
  }
  lines.push('### Lead time (DORA)');
  lines.push(`- First commit → merge: ${fmtDist(leadTime.firstCommitToMergeHours, 'h')}`);
  lines.push(`- Merge → deployed: ${fmtDist(leadTime.mergeToDeployedHours, 'h')}`);
  lines.push(`- **First commit → deployed (DORA number): ${fmtDist(leadTime.firstCommitToDeployedHours, 'h')}**`);
  lines.push(`- PR open → merge (sub-metric): ${fmtDist(leadTime.prOpenToMergeHours, 'h')}`);
  lines.push(`- Unattributed PRs (no deploy found after merge): ${leadTime.unattributed}`);
  lines.push('');
  lines.push('### Change fail rate / recovery');
  lines.push(`- Main-red rate (CI-health, not DORA): ${mainRed.red}/${mainRed.total} (${mainRed.pct.toFixed(1)}%)`);
  lines.push(`- Main red→green recovery: ${fmtDist(mainRecovery, 'min')}`);
  lines.push(`- **Deployment failure rate (DORA):** dispatch failures ${deployFail.dispatchFailures.count}/${deployFail.total} (${deployFail.dispatchFailures.pct.toFixed(1)}%); **true rollbacks** ${deployFail.realRollbacks.count}/${deployFail.total} (${deployFail.realRollbacks.pct.toFixed(1)}%); preflight-blocked (never shipped) ${deployFail.preflightBlocks.count}`);
  lines.push(`- Deploy-rollback recovery: n=${deployRecovery.n}${deployRecovery.aggregate ? `, ${fmtDist(deployRecovery.aggregate, 'min')}` : deployRecovery.n > 0 ? ` (too few to aggregate: ${deployRecovery.minutes.map((m) => m.toFixed(0)).join(', ')}min)` : ''}`);
  lines.push('');
  lines.push('### Rework rate (tightened definition)');
  lines.push(`- Reverts: ${rework.reverts.count}/${rework.total} (${rework.reverts.pct.toFixed(1)}%)`);
  lines.push(`- Fix-typed PRs overlapping a file from a PR merged in the prior 72h: ${rework.fixOverlaps.count}/${rework.total} (${rework.fixOverlaps.pct.toFixed(1)}%)`);
  lines.push(`- **Combined: ${rework.combined.count}/${rework.total} (${rework.combined.pct.toFixed(1)}%)**`);
  lines.push('');
  lines.push('### Approval wait (CI-green → merge), by tier');
  for (const tier of ['T0', 'T1', 'T2', 'none']) {
    lines.push(`- ${tier}: ${fmtDist(approvalWait[tier], 'min')}`);
  }
  lines.push('');
  lines.push('### T2 approval-wait split (t/4520): agent-controllable vs human-approval');
  lines.push('_Combined T2 figure above is CI-green → merge. Split at the SO-clearing comment (a known'
    + ' approximation — a PR whose clearing comment doesn\'t match the literal "SO cleared"/"SO did not'
    + ' review" phrasing falls into `unclassified`, not a guessed bucket). **The t/4093 ≤2h target is'
    + ' measured against agent-controllable, not the combined figure.**_');
  lines.push(`- Agent-controllable (CI-green → SO-cleared): ${fmtDist(t2WaitSplit.agentControllable, 'min')}`);
  lines.push(`- Human-approval (SO-cleared → merge): ${fmtDist(t2WaitSplit.humanApproval, 'min')}`);
  lines.push(`- Unclassified (no SO-cleared comment detected): ${fmtDist(t2WaitSplit.unclassified, 'min')}`);
  lines.push('');
  lines.push('### PR size / open-PR age');
  lines.push(`- Lines changed: ${fmtDist(prSize.lines)}`);
  lines.push(`- Files changed: ${fmtDist(prSize.files)}`);
  lines.push(`- Open-PR age (days, current snapshot): ${fmtDist(openAge, 'd')}`);
  lines.push('');
  lines.push('### T2 share');
  if (t2Verdict) {
    lines.push(`- T0=${t2Verdict.t0.count} (${t2Verdict.t0.pct.toFixed(1)}%) T1=${t2Verdict.t1.count} (${t2Verdict.t1.pct.toFixed(1)}%) T2=${t2Verdict.t2.count} (${t2Verdict.t2.pct.toFixed(1)}%) none=${t2Verdict.none.count} (${t2Verdict.none.pct.toFixed(1)}%)`);
    lines.push(`- **T2 share: ${t2Verdict.t2.pct.toFixed(1)}%** (alert threshold ${t2Verdict.thresholdPct}%) — ${t2Verdict.alert ? '**OVER THRESHOLD**' : 'within budget'}`);
  } else {
    lines.push('- _not computed this run — see fetch warnings above_');
  }
  lines.push('');
  lines.push('### PI load');
  lines.push(piLoadSection);
  lines.push('');

  console.log(lines.join('\n'));
}

main();
