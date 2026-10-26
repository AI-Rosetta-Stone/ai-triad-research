// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/4107 (t/4091 measure-after): pure metrics for the weekly fleet-delivery report. Definitions
 * are the Lead-reviewed, tightened set from t/4107#1/#4/#6/#8/#9 — not the original #3 baseline
 * proxies, which were superseded. This file does no I/O: `fleet-delivery-report.mjs` fetches
 * facts (gh api/gh run list/gh pr list) and calls these functions; everything here is testable
 * from plain JS objects.
 *
 * Reuses operations/devops/t2-budget-metric.mjs (t/4122) for T2 share — do not reimplement it
 * here; that module is the one place the >10% alert threshold is co-located with its rationale.
 * Reuses operations/devops/tier-check-predicate.mjs's extractTier for the per-tier approval-wait
 * split, same first-line `Tier: Tn` parse tier-check itself uses.
 */

import { extractTier } from './tier-check-predicate.mjs';

// ── Lead time (t/4107#4 item 1 — three legs, not just PR-open-to-merge) ────────────────────

/**
 * PURE. prs: [{ firstCommitAt, mergedAt, createdAt }] (ISO strings).
 * deploys: [{ sha, deployedAt }] successful production deploys, sorted ascending by deployedAt.
 * Returns the four distributions: (a) first-commit→merge, (b) merge→deployed, (c) a+b (the DORA
 * number), plus the PR-open→merge sub-metric. (b)/(c) are computed per-PR by
 * attributePRsToDeploys first (see below) — pass its output as `attributed`.
 */
export function leadTimeLegs(prs, attributed) {
  const toHours = (ms) => ms / 3_600_000;
  const aMs = [];
  const openMs = [];
  for (const pr of prs ?? []) {
    if (pr.firstCommitAt && pr.mergedAt) aMs.push(new Date(pr.mergedAt) - new Date(pr.firstCommitAt));
    if (pr.createdAt && pr.mergedAt) openMs.push(new Date(pr.mergedAt) - new Date(pr.createdAt));
  }
  const bMs = (attributed ?? []).filter((x) => x.mergeToDeployMs != null).map((x) => x.mergeToDeployMs);
  const cMs = (attributed ?? []).filter((x) => x.firstCommitToDeployMs != null).map((x) => x.firstCommitToDeployMs);
  return {
    firstCommitToMergeHours: distribution(aMs.map(toHours)),
    mergeToDeployedHours: distribution(bMs.map(toHours)),
    firstCommitToDeployedHours: distribution(cMs.map(toHours)),
    prOpenToMergeHours: distribution(openMs.map(toHours)),
    unattributed: (attributed ?? []).filter((x) => x.mergeToDeployMs == null).length,
  };
}

/**
 * PURE. For each merged PR, find the earliest successful deploy whose SHA is at-or-after the
 * PR's merge commit in main's linear history (approximated here by deploy timestamp being the
 * first deploy with deployedAt >= pr.mergedAt — callers pass pre-sorted ascending deploys and
 * have already resolved ancestry via `git merge-base --is-ancestor` upstream if exact ancestry
 * is needed; the timestamp approximation matches t/4107#6's method and is stated, not hidden).
 * prs: [{ mergedAt, firstCommitAt }]. deploys: [{ deployedAt }] ascending.
 */
export function attributePRsToDeploys(prs, deploys) {
  const sorted = [...(deploys ?? [])].sort((a, b) => new Date(a.deployedAt) - new Date(b.deployedAt));
  return (prs ?? []).map((pr) => {
    const merged = pr.mergedAt ? new Date(pr.mergedAt) : null;
    const deploy = merged ? sorted.find((d) => new Date(d.deployedAt) >= merged) : undefined;
    if (!merged || !deploy) return { ...pr, mergeToDeployMs: null, firstCommitToDeployMs: null };
    const mergeToDeployMs = new Date(deploy.deployedAt) - merged;
    const firstCommitToDeployMs = pr.firstCommitAt ? new Date(deploy.deployedAt) - new Date(pr.firstCommitAt) : null;
    return { ...pr, mergeToDeployMs, firstCommitToDeployMs };
  });
}

// ── Change fail rate / recovery time — split and honestly named (t/4107#4 item 2) ──────────

/** PURE. mainPushes: [{ conclusion: 'success'|'failure'|..., pushedAt }]. "Main-red rate", a
 * CI-health metric, NOT the DORA number — name it that way in the report. */
export function mainRedRate(mainPushes) {
  const total = (mainPushes ?? []).length;
  const red = (mainPushes ?? []).filter((p) => p.conclusion === 'failure').length;
  return { total, red, pct: total > 0 ? (red / total) * 100 : 0 };
}

/**
 * PURE. deploys: [{ conclusion, jobName }] where jobName distinguishes a 'preflight' block
 * (never shipped) from a 'deploy' job that shipped and then rolled back (a REAL failure). Only
 * failures whose failing job is the deploy job itself (not preflight) count toward the DORA
 * deployment-failure-rate; the rest are "caught before shipping" (t/4107#6).
 */
export function deploymentFailureRate(deploys) {
  const total = (deploys ?? []).length;
  const failed = (deploys ?? []).filter((d) => d.conclusion === 'failure');
  const realRollbacks = failed.filter((d) => d.jobName === 'deploy');
  const preflightBlocks = failed.filter((d) => d.jobName === 'preflight');
  return {
    total,
    dispatchFailures: { count: failed.length, pct: total > 0 ? (failed.length / total) * 100 : 0 },
    realRollbacks: { count: realRollbacks.length, pct: total > 0 ? (realRollbacks.length / total) * 100 : 0 },
    preflightBlocks: { count: preflightBlocks.length },
  };
}

/** PURE. mainPushes sorted ascending by pushedAt. Returns the red→green recovery distribution
 * (minutes), matching each failure to the next success after it. */
export function mainRecoveryMinutes(mainPushes) {
  const sorted = [...(mainPushes ?? [])].sort((a, b) => new Date(a.pushedAt) - new Date(b.pushedAt));
  const recoveries = [];
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].conclusion !== 'failure') continue;
    const next = sorted.slice(i + 1).find((p) => p.conclusion === 'success');
    if (next) recoveries.push((new Date(next.pushedAt) - new Date(sorted[i].pushedAt)) / 60_000);
  }
  return distribution(recoveries);
}

/** PURE. realRollbacks: [{ failedAt, recoveredAt }] (already paired with the next successful
 * deploy). Reported individually when n is too small to aggregate (t/4107#6/#7 — n=2). */
export function deployRecoveryMinutes(realRollbacks) {
  const minutes = (realRollbacks ?? [])
    .filter((r) => r.failedAt && r.recoveredAt)
    .map((r) => (new Date(r.recoveredAt) - new Date(r.failedAt)) / 60_000);
  return { n: minutes.length, minutes, aggregate: minutes.length >= 5 ? distribution(minutes) : null };
}

// ── Rework rate — tightened (t/4107#4 item 3) ───────────────────────────────────────────────

const FIX_TYPE_RE = /^(fix|revert)(\(|:)/i;
const REVERT_RE = /^revert\b/i;

/**
 * PURE. prs: [{ title, headRefName, mergedAt, changedFiles: string[] }], all merged, ascending
 * or any order (sorted internally). Window: a fix-typed PR counts as rework only if it touches a
 * file also touched by a PR merged in the prior `windowHours` (default 72h) — not merely sharing
 * a ticket number (the old proxy over-counted intentional same-feature batching).
 */
export function reworkRate(prs, windowHours = 72) {
  const all = [...(prs ?? [])].sort((a, b) => new Date(a.mergedAt) - new Date(b.mergedAt));
  const reverts = all.filter((pr) => REVERT_RE.test(pr.title ?? '') || REVERT_RE.test(pr.headRefName ?? ''));
  const windowMs = windowHours * 3_600_000;

  const fixOverlaps = all.filter((pr) => {
    const isFixTyped = FIX_TYPE_RE.test(pr.title ?? '') || FIX_TYPE_RE.test(pr.headRefName ?? '');
    if (!isFixTyped) return false;
    const myFiles = new Set(pr.changedFiles ?? []);
    if (myFiles.size === 0) return false;
    const mergedAt = new Date(pr.mergedAt);
    return all.some((other) => {
      if (other === pr) return false;
      const otherMerged = new Date(other.mergedAt);
      if (otherMerged >= mergedAt || mergedAt - otherMerged > windowMs) return false;
      return (other.changedFiles ?? []).some((f) => myFiles.has(f));
    });
  });

  const combined = new Set([...reverts, ...fixOverlaps]);
  const total = all.length;
  const pct = (n) => (total > 0 ? (n / total) * 100 : 0);
  return {
    total,
    reverts: { count: reverts.length, pct: pct(reverts.length) },
    fixOverlaps: { count: fixOverlaps.length, pct: pct(fixOverlaps.length) },
    combined: { count: combined.size, pct: pct(combined.size) },
  };
}

// ── Approval wait by tier (kept as defined, t/4107#4) ───────────────────────────────────────

/** PURE. prs: [{ body, ciGreenAt, mergedAt }]. Splits by extractTier(body); 'none' bucket for
 * PRs with no Tier: line (pre-policy or non-compliant). */
export function approvalWaitByTier(prs) {
  const buckets = { T0: [], T1: [], T2: [], none: [] };
  for (const pr of prs ?? []) {
    if (!pr.ciGreenAt || !pr.mergedAt) continue;
    const minutes = (new Date(pr.mergedAt) - new Date(pr.ciGreenAt)) / 60_000;
    const tier = extractTier(pr.body) ?? 'none';
    (buckets[tier] ?? buckets.none).push(minutes);
  }
  return Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, distribution(v)]));
}

// ── T2 approval-wait split: agent-controllable vs human-approval (t/4520, TL p/702#83) ──────
//
// The combined "CI-green → merge" wait for a T2 PR conflates two different things (confirmed by
// hand against this week's 37 T2 PRs, t/4091#40): the SO round (agent-controllable -- the thing
// t/4093's <=2h target is meant to measure) and PI/TL sign-off latency (human-controllable,
// outside agent scope). A T2 PR's own SO-clearing comment is the boundary between the two legs.
//
// Known approximation (documented, not hidden -- same class of heuristic as t1-approval-guard's
// owner-slug self-approval check): SO_CLEARED_RE matches the literal "SO cleared"/"SO clearing"/
// "SO did not review" phrasing this repo's own T2 comments already use (root AGENTS.md Change
// Tiers: "the SO did not review" is the exact fallback phrase; real PR comments observed in
// practice use "SO clearing comment" as often as "SO cleared it" -- verified against PR #3423's
// actual thread, t/4520). A PR whose SO-clearing comment doesn't match this phrasing falls into
// `unclassified` rather than being silently mis-bucketed. Does NOT match "SO re-confirmation...
// Not cleared yet" (confirmed: "SO" isn't immediately followed by a clear* word there).
// Exported (t/4533) so stuck-pr-classifier.mjs's consult-hold-aged detection reuses the SAME
// detector rather than re-deriving the phrasing independently.
export const SO_CLEARED_RE = /\bSO (?:cleared|clearing|did not review)\b/i;

/** PURE helper: the LAST comment matching SO_CLEARED_RE (re-confirmations across rebases push
 * the boundary later, matching the real #3386 shape from t/4091#40). comments: [{ body, createdAt }]. */
export function findSoClearedAt(comments) {
  let latest = null;
  for (const c of comments ?? []) {
    if (!SO_CLEARED_RE.test(c.body ?? '')) continue;
    const t = new Date(c.createdAt).getTime();
    if (!Number.isNaN(t) && (latest == null || t > latest)) latest = t;
  }
  return latest == null ? null : new Date(latest).toISOString();
}

/** PURE. prs: [{ body, ciGreenAt, mergedAt, soClearedAt }] -- T2 only (others are ignored, same
 * as approvalWaitByTier's bucketing). A PR with no detected soClearedAt goes to `unclassified`
 * (its wait is real but can't be split) rather than guessed into either leg. */
export function splitT2ApprovalWait(prs) {
  const agentControllable = [];
  const humanApproval = [];
  const unclassified = [];
  for (const pr of prs ?? []) {
    if (extractTier(pr.body) !== 'T2') continue;
    if (!pr.ciGreenAt || !pr.mergedAt) continue;
    const ciGreen = new Date(pr.ciGreenAt).getTime();
    const merged = new Date(pr.mergedAt).getTime();
    if (!pr.soClearedAt) {
      unclassified.push((merged - ciGreen) / 60_000);
      continue;
    }
    const soCleared = new Date(pr.soClearedAt).getTime();
    // Clamp at 0: a re-confirmation comment can postdate CI-green by construction, but a stale
    // first-pass SO comment could theoretically predate it -- never report a negative wait.
    agentControllable.push(Math.max(0, soCleared - ciGreen) / 60_000);
    humanApproval.push(Math.max(0, merged - soCleared) / 60_000);
  }
  return {
    agentControllable: distribution(agentControllable),
    humanApproval: distribution(humanApproval),
    unclassified: distribution(unclassified),
  };
}

// ── PR size / open-PR age ───────────────────────────────────────────────────────────────────

/** PURE. prs: [{ additions, deletions, changedFiles }] (changedFiles: number or string[]). */
export function prSizeDistribution(prs) {
  const lines = (prs ?? []).map((pr) => (pr.additions ?? 0) + (pr.deletions ?? 0));
  const files = (prs ?? []).map((pr) => (Array.isArray(pr.changedFiles) ? pr.changedFiles.length : pr.changedFiles ?? 0));
  return { lines: distribution(lines), files: distribution(files) };
}

/** PURE. openPRs: [{ createdAt }]. now: Date (injectable for tests). */
export function openPRAgeDays(openPRs, now = new Date()) {
  const ages = (openPRs ?? []).map((pr) => (now - new Date(pr.createdAt)) / 86_400_000);
  return distribution(ages);
}

// ── PI load (parsed from t/4107's own digest comments, TL t/4107#5 format) ─────────────────

const PI_LOAD_RE =
  /^PI-load (\d{4}-\d{2}-\d{2}): asks=(\d+) new=(\d+) carried=(\d+) oldest_open_days=(\d+) answered_since_last=(\d+) other_tl_pings_to_pi=(\d+)/;

/** PURE. comments: [{ body, createdAt }] (ticket comments, any order). Returns parsed lines
 * within [sinceISO, untilISO), sorted ascending by date. A non-matching comment is skipped, not
 * an error — this ticket also carries non-digest discussion comments. */
export function parsePILoadLines(comments, sinceISO, untilISO) {
  const since = sinceISO ? new Date(sinceISO) : null;
  const until = untilISO ? new Date(untilISO) : null;
  const rows = [];
  for (const c of comments ?? []) {
    const m = PI_LOAD_RE.exec((c.body ?? '').trim());
    if (!m) continue;
    const date = new Date(m[1]);
    if (since && date < since) continue;
    if (until && date >= until) continue;
    rows.push({
      date: m[1],
      asks: Number(m[2]),
      new: Number(m[3]),
      carried: Number(m[4]),
      oldestOpenDays: Number(m[5]),
      answeredSinceLast: Number(m[6]),
      otherTlPingsToPi: Number(m[7]),
    });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

// ── shared helper ────────────────────────────────────────────────────────────────────────────

/** PURE. values: number[]. Returns n/median/p90/mean/max, or nulls for an empty input (never
 * NaN — a report must say "no data", not print NaN). */
export function distribution(values) {
  const v = (values ?? []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return { n: 0, median: null, p90: null, mean: null, max: null };
  const pick = (p) => v[Math.min(n - 1, Math.floor(p * n))];
  const mean = v.reduce((a, b) => a + b, 0) / n;
  return { n, median: pick(0.5), p90: pick(0.9), mean, max: v[n - 1] };
}
