// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4180 — pure core for the staging load-test harness. No I/O: given raw per-request
// samples collected by the impure driver (run-load-test.mjs), compute the percentile
// summary and the pass/fail verdict against the ticket's own acceptance bar (p95 > 2s
// or error rate > 1%). Kept separate from the driver so the threshold logic is
// unit-testable without a network.

/** Linear-interpolation percentile (p in [0,100]) over an array of ms values. Empty input
 *  returns 0 rather than NaN so a zero-sample step reports as "nothing happened", not a
 *  poisoned threshold comparison. */
export function percentile(valuesMs, p) {
  if (!Array.isArray(valuesMs) || valuesMs.length === 0) return 0;
  const sorted = [...valuesMs].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

/**
 * Summarize one ramp step's raw samples into the headline numbers the ticket asks for.
 * @param {{ latenciesMs: number[], errorCount: number, requestCount: number, durationMs: number }} raw
 */
export function summarizeStep(raw) {
  const { latenciesMs, errorCount, requestCount, durationMs } = raw;
  const errorRatePct = requestCount > 0 ? (errorCount / requestCount) * 100 : 0;
  return {
    p50Ms: percentile(latenciesMs, 50),
    p95Ms: percentile(latenciesMs, 95),
    errorRatePct,
    requestCount,
    errorCount,
    rps: durationMs > 0 ? requestCount / (durationMs / 1000) : 0,
  };
}

/** Thresholds locked by the ticket's own acceptance criteria — kept here, not inlined at
 *  each call site, so the pass bar can't drift between the harness and the report. */
export const LOAD_TEST_THRESHOLDS = Object.freeze({ p95Ms: 2000, errorRatePct: 1 });

/**
 * Pure pass/fail verdict for one summarized step against LOAD_TEST_THRESHOLDS.
 * @param {{ p95Ms: number, errorRatePct: number }} summary
 */
export function stepVerdict(summary, thresholds = LOAD_TEST_THRESHOLDS) {
  const p95Breach = summary.p95Ms > thresholds.p95Ms;
  const errorBreach = summary.errorRatePct > thresholds.errorRatePct;
  return {
    breached: p95Breach || errorBreach,
    p95Breach,
    errorBreach,
  };
}

/**
 * Walk the ramp's per-level, per-profile summaries (already annotated with `level` and
 * `profile`) and find the FIRST level (ascending) at which any profile breaches. Returns
 * null if nothing in the ramp breached (the harness should then say so plainly, not report
 * a ceiling it never measured).
 * @param {Array<{ level: number, profile: string, p95Ms: number, errorRatePct: number }>} steps
 */
export function findBreakingPoint(steps) {
  const byLevel = [...steps].sort((a, b) => a.level - b.level);
  for (const step of byLevel) {
    const verdict = stepVerdict(step);
    if (verdict.breached) {
      return { level: step.level, profile: step.profile, ...verdict, summary: step };
    }
  }
  return null;
}
