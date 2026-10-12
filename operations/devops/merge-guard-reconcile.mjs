// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Merge-guard advisory-cycle reconciler (t/3695#25-27). The blocking flip of pre-self-merge-verify
// is gated on Live-Fire Proof from its own execution record (.gate-telemetry/merge-guard.jsonl):
//   - every MANUAL merge in the window appears in the record (coverage),
//   - ≥10 judged merges with 0 false positives, ≥1 true positive.
// This module answers the coverage half mechanically and lists every block for a human FP/TP call.
//
// Pure core (`reconcileMergeGuardCoverage`) + an impure CLI shim (GitHub fetch + file read), so the
// core is unit-tested in merge-guard-predicate.test.mjs under the CI floor (t/3871).
//
//   node operations/devops/merge-guard-reconcile.mjs --since 2026-10-07T00:00:00Z \
//     [--until <iso>] [--repos jpsnover/ai-triad-research,jpsnover/ai-triad-data] [--file <jsonl>]

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Reuse t/4131's own constant + regex for "GitHub merges instantly with no arm event" rather
// than re-deriving a second copy of the same threshold (t/3695#30).
import { ARM_EVENT_RE, MERGE_EQUIVALENT_WINDOW_SECONDS } from './stuck-pr-classifier.mjs';

// Clause reasons that mean "a real merge was attempted" — the population coverage is about.
// disable-auto/help never merge. t/3695#30: --auto without a pin is now ALSO a judged attempt
// (it used to be exempt; t/4131 showed it can merge instantly with no arm event).
const JUDGED = new Set(['guarded', 'missing-match-head-commit', 'auto-missing-match-head-commit']);
const BLOCKING_REASONS = new Set(['missing-match-head-commit', 'auto-missing-match-head-commit']);

// PURE. t/4131's exact arm-equivalent shape, reused here so the reconciler and the sweep
// detector never drift into two separate thresholds for the same GitHub behavior.
export function isArmEquivalentMerge({ readyAt, mergedAt, hasArmEventBetween }) {
  if (!readyAt || !mergedAt || hasArmEventBetween) return false;
  const deltaSeconds = (Date.parse(mergedAt) - Date.parse(readyAt)) / 1000;
  return deltaSeconds >= 0 && deltaSeconds <= MERGE_EQUIVALENT_WINDOW_SECONDS;
}

// '22' or 'https://github.com/o/r/pull/22' → { repo, number }
export function parsePrRefKey(prRef, repo) {
  if (prRef == null) return null;
  const url = String(prRef).match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/);
  if (url) return { repo: url[1], number: Number(url[2]) };
  if (/^\d+$/.test(String(prRef))) return { repo: repo || null, number: Number(prRef) };
  return null;
}

/**
 * PURE. records: parsed merge-guard.jsonl lines. mergedPrs: [{ repo, number, mergedAt, autoMerge,
 * armEquivalent }] where autoMerge = a real auto_*_enabled event exists, and armEquivalent =
 * ready_for_review -> merged with NO arm event within the window (t/4131's exact shape: what
 * `gh pr merge --auto` produces on an already-green PR, with no arm event at all to show for it).
 * outOfBandRefs: [{ repo, number }] — PRs the caller has cross-referenced to a KNOWN t/3716
 * sweeper incident; a judgment call, not mechanically derivable from events alone.
 *
 * Returns counts plus the lists a reviewer needs:
 *   manual             — merged PRs in the window that were NOT a real auto-merge (the population)
 *   covered            — manual merges WITH a judged clause in the record
 *   missing            — manual merges with NO judged clause, split three ways (t/3695#30):
 *     .autoImmediate   — armEquivalent and not a known sweeper incident: GitHub's own instant
 *                        --auto path, covered by design, not a gap.
 *     .outOfBand       — in outOfBandRefs: a KNOWN t/3716 sweeper incident, tracked there already.
 *     .uncovered       — everything else: the REAL gaps. Criterion 1 (Live-Fire Proof) applies
 *                        only to this bucket.
 *   unparseableRefs    — judged clauses whose PR ref could not be parsed (TL condition 2: own count)
 *   ambiguous          — judged clauses with a bare number and no -R that match PRs in >1 repo
 *   legacyRecords      — in-window records written before per-clause fields existed (no `clauses`)
 *   blocks             — every judged clause the guard would have blocked, for the FP/TP call
 */
export function reconcileMergeGuardCoverage({ records = [], mergedPrs = [], since, until, outOfBandRefs = [] } = {}) {
  const inWin = (ts) => !!ts && (!since || ts >= since) && (!until || ts <= until);
  const manual = mergedPrs.filter((p) => inWin(p.mergedAt) && !p.autoMerge);

  let legacyRecords = 0;
  const judged = [];
  for (const r of records) {
    if (!r || r.mode !== 'head-guard' || !inWin(r.ts)) continue;
    if (!Array.isArray(r.clauses)) { legacyRecords++; continue; }
    for (const c of r.clauses) if (JUDGED.has(c.reason)) judged.push({ ts: r.ts, ...c });
  }

  const unparseableRefs = [];
  const ambiguous = [];
  const coveredKeys = new Set();
  for (const c of judged) {
    const key = parsePrRefKey(c.prRef, c.repo);
    if (!key) { unparseableRefs.push(c); continue; }
    const hits = mergedPrs.filter((p) => p.number === key.number && (!key.repo || p.repo === key.repo));
    if (!key.repo && new Set(hits.map((p) => p.repo)).size > 1) { ambiguous.push(c); continue; }
    for (const p of hits) coveredKeys.add(`${p.repo}#${p.number}`);
  }

  const covered = manual.filter((p) => coveredKeys.has(`${p.repo}#${p.number}`));
  const missingAll = manual.filter((p) => !coveredKeys.has(`${p.repo}#${p.number}`));
  const outOfBandKeys = new Set((outOfBandRefs ?? []).map((r) => `${r.repo}#${r.number}`));
  const missing = {
    all: missingAll,
    outOfBand: missingAll.filter((p) => outOfBandKeys.has(`${p.repo}#${p.number}`)),
    autoImmediate: missingAll.filter((p) => p.armEquivalent && !outOfBandKeys.has(`${p.repo}#${p.number}`)),
    uncovered: missingAll.filter((p) => !p.armEquivalent && !outOfBandKeys.has(`${p.repo}#${p.number}`)),
  };
  const blocks = judged.filter((c) => BLOCKING_REASONS.has(c.reason));
  return {
    judged: judged.length,
    manual: manual.length,
    covered: covered.length,
    missing,
    unparseableRefs,
    ambiguous,
    legacyRecords,
    blocks,
  };
}

// ── CLI shim (impure): read the record, fetch merged PRs + auto-merge evidence from GitHub ──
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('merge-guard-reconcile.mjs')) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
  };
  const since = arg('--since', null);
  if (!since) {
    console.error('usage: merge-guard-reconcile.mjs --since <iso> [--until <iso>] [--repos o/r,o/r] [--file <jsonl>] [--out-of-band o/r#N,N,...]');
    process.exit(2);
  }
  const until = arg('--until', null);
  const repos = arg('--repos', 'jpsnover/ai-triad-research,jpsnover/ai-triad-data').split(',');
  const file = arg('--file', fileURLToPath(new URL('./.gate-telemetry/merge-guard.jsonl', import.meta.url)));
  // t/3716 sweeper incidents the caller has already attributed by hand -- a judgment call, not
  // mechanically derivable from events alone (t/3695#30). Format: o/r#N,o/r#N or bare N (default repo).
  const outOfBandRefs = arg('--out-of-band', '').split(',').filter(Boolean).map((ref) => {
    const m = ref.match(/^(.+)#(\d+)$/);
    return m ? { repo: m[1], number: Number(m[2]) } : { repo: repos[0], number: Number(ref) };
  });
  const gh = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }));

  let records = [];
  try {
    records = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    });
  } catch (e) {
    console.error(`cannot read record ${file}: ${e.message}`);
    process.exit(2);
  }

  const mergedPrs = [];
  for (const repo of repos) {
    const day = since.slice(0, 10);
    const list = gh(['pr', 'list', '-R', repo, '--state', 'merged', '--search', `merged:>=${day}`,
      '--limit', '500', '--json', 'number,mergedAt']);
    for (const p of list) {
      if (!(p.mergedAt >= since) || (until && p.mergedAt > until)) continue;
      // --paginate concatenates JSON pages, so filter per page with --jq instead of parsing the whole.
      // The REST event name carries the merge method: auto_squash_enabled / auto_merge_enabled /
      // auto_rebase_enabled (observed: #2933 has only auto_squash_enabled).
      const events = gh(['api', '--paginate', `repos/${repo}/issues/${p.number}/events?per_page=100`]);
      const autoMerge = events.some((e) => ARM_EVENT_RE.test(e.event));
      // t/3695#30: a merge with NO arm event can still be GitHub's own instant --auto path
      // (t/4131) -- the ready_for_review -> merged shape, not a real coverage gap.
      const readyEvents = events.filter((e) => e.event === 'ready_for_review').map((e) => e.created_at);
      const readyAt = readyEvents.length ? readyEvents[readyEvents.length - 1] : null;
      const armEquivalent = !autoMerge && isArmEquivalentMerge({ readyAt, mergedAt: p.mergedAt, hasArmEventBetween: autoMerge });
      mergedPrs.push({ repo, number: p.number, mergedAt: p.mergedAt, autoMerge, armEquivalent });
    }
  }

  const r = reconcileMergeGuardCoverage({ records, mergedPrs, since, until, outOfBandRefs });
  console.log(JSON.stringify({ since, until, repos, ...r }, null, 2));
  // t/3695#30: Criterion 1 (Live-Fire Proof) applies only to UNCOVERED gaps -- auto-immediate
  // and out-of-band entries are explained, not coverage failures. Exit 1 iff any remain uncovered.
  process.exit(r.missing.uncovered.length ? 1 : 0);
}
