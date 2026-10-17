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
    const q = encodeURIComponent(`repo:${repo} is:pr is:merged merged:>=${sinceIso}`);
    let items = [];
    for (let page = 1; page <= 10; page++) {
      const batch = ghJson(`search/issues?q=${q}&per_page=100&page=${page}`);
      const results = batch.items ?? [];
      items = items.concat(results);
      if (results.length < 100) break;
    }
    // search/issues doesn't include the PR body reliably for all fields across API versions;
    // re-fetch each PR's body explicitly to avoid depending on an undocumented search payload shape.
    const prs = items.map((it) => {
      let body = it.body;
      if (body === undefined) {
        try { body = ghJson(`repos/${repo}/pulls/${it.number}`).body; } catch { body = null; }
      }
      return { number: it.number, body };
    });

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

    out = { ok: true, repo, windowDays, since: sinceIso, counts, verdict, topT2Paths };
  } catch (e) {
    out = { ok: false, error: String((e && e.message) || e) };
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exitCode = out.ok ? 0 : 3;
}
