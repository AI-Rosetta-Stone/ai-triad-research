#!/usr/bin/env node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.
//
// t/4122 (from t/4103#3 / TL t/4107): if well over 10% of merged PRs declare Tier: T2, the R1
// path patterns are too broad and the T2-consult bottleneck returns. Computed from merged PR
// BODIES (extractTier, the same first-line Tier: Tn parse tier-check-predicate.mjs itself uses),
// never from the tier-check workflow's own runs -- so this metric survives whichever way t/4096
// Decision B lands (custom tier-check vs a native ruleset).

import { execFileSync } from 'node:child_process';
import { extractTier } from './tier-check-predicate.mjs';

// Co-located with its rationale (t/4122 acceptance criterion): t/4103#3 / TL t/4107 -- "well over
// 10%" is the signal that the R1 path-pattern list has grown too broad.
export const T2_ALERT_THRESHOLD_PCT = 10;

/** PURE. counts: {t0,t1,t2,none}. Returns shares + the alert decision. */
export function t2BudgetVerdict({ t0 = 0, t1 = 0, t2 = 0, none = 0, thresholdPct = T2_ALERT_THRESHOLD_PCT } = {}) {
  const total = t0 + t1 + t2 + none;
  const pct = (n) => (total > 0 ? (n / total) * 100 : 0);
  const t2Pct = pct(t2);
  return {
    total,
    t0: { count: t0, pct: pct(t0) },
    t1: { count: t1, pct: pct(t1) },
    t2: { count: t2, pct: t2Pct },
    none: { count: none, pct: pct(none) },
    alert: t2Pct > thresholdPct,
    thresholdPct,
  };
}

/** PURE. fileListsPerT2Pr: string[][] (each PR's changed-file paths). Returns top-N by frequency. */
export function topPathsByFrequency(fileListsPerT2Pr, topN = 5) {
  const freq = new Map();
  for (const files of fileListsPerT2Pr ?? []) {
    for (const f of files ?? []) {
      freq.set(f, (freq.get(f) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([path, count]) => ({ path, count }));
}

/**
 * PURE (t/4122 fix, TL correction t/4122#5/#6). An epic-child PR (base != main) is not a T2
 * LANDING -- it merges into the epic integration branch, not main, so counting it inflates the
 * share and can false-alarm on fragmentation of a single epic rather than real over-tiering
 * (the exact bug: 4 of 15 "T2" PRs in the first run were epic children of t4184-write-conflict-
 * fix, #3270/#3274/#3291/#3302 -- the real main-landing count was 11, ~8%, under threshold).
 * An unreadable/missing baseRefName is excluded (fail toward NOT counting an unverifiable base,
 * not toward inflating the share).
 */
export function filterMainMerges(prs, mainBranch = 'main') {
  return (prs ?? []).filter((pr) => pr.baseRefName === mainBranch);
}

/** PURE. Tallies a list of {body} PR objects into {t0,t1,t2,none} via extractTier. */
export function tallyTiers(prs) {
  const counts = { t0: 0, t1: 0, t2: 0, none: 0 };
  for (const pr of prs ?? []) {
    const tier = extractTier(pr.body);
    if (tier === 'T0') counts.t0++;
    else if (tier === 'T1') counts.t1++;
    else if (tier === 'T2') counts.t2++;
    else counts.none++;
  }
  return counts;
}

// ── CLI shim (impure) ───────────────────────────────────────────────────────────────────────
//   node t2-budget-metric.mjs <owner/repo> [windowDays]
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('operations/devops/t2-budget-metric.mjs')) {
  const repo = process.argv[2] || process.env.GITHUB_REPOSITORY;
  const windowDays = Number(process.argv[3] || 7);
  const gh = (args) => execFileSync('gh', args, { windowsHide: true, encoding: 'utf8', timeout: 60000 });
  const ghJson = (path) => JSON.parse(gh(['api', path]));

  let out;
  try {
    const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    // base:main (t/4122 fix, TL correction t/4122#5/#6): the search API's own scope, not just a
    // post-filter -- an epic-child PR (base != main) is not a T2 LANDING. Kept alongside the pure
    // filterMainMerges() backstop below rather than trusting the query alone (defense in depth:
    // a malformed/ignored qualifier degrading silently to "all merged PRs" must still be caught).
    const q = encodeURIComponent(`repo:${repo} is:pr is:merged base:main merged:>=${sinceIso}`);
    let items = [];
    for (let page = 1; page <= 10; page++) {
      const batch = ghJson(`search/issues?q=${q}&per_page=100&page=${page}`);
      const results = batch.items ?? [];
      items = items.concat(results);
      if (results.length < 100) break;
    }
    // search/issues doesn't reliably include the PR body or base ref across API versions;
    // re-fetch each PR's full detail explicitly rather than depending on an undocumented
    // search payload shape.
    const allPrs = items.map((it) => {
      try {
        const detail = ghJson(`repos/${repo}/pulls/${it.number}`);
        return { number: it.number, body: detail.body, baseRefName: detail.base?.ref ?? null };
      } catch {
        return { number: it.number, body: null, baseRefName: null };
      }
    });
    const prs = filterMainMerges(allPrs);

    const counts = tallyTiers(prs);
    const verdict = t2BudgetVerdict(counts);

    const t2Prs = prs.filter((pr) => extractTier(pr.body) === 'T2');
    const fileLists = t2Prs.map((pr) => {
      try {
        return ghJson(`repos/${repo}/pulls/${pr.number}/files?per_page=100`).map((f) => f.filename);
      } catch {
        return [];
      }
    });
    const topT2Paths = topPathsByFrequency(fileLists, 5);

    out = {
      ok: true, repo, windowDays, since: sinceIso,
      mainMergesChecked: prs.length,
      excludedNonMain: allPrs.length - prs.length,
      counts, verdict, topT2Paths,
    };
  } catch (e) {
    out = { ok: false, error: String((e && e.message) || e) };
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exitCode = out.ok ? 0 : 3;
}
