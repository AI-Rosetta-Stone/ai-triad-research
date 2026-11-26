// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Fact-check result validator — the STRUCTURAL anti-escape-hatch gate (t/1701 AC#3,
// TL-approved t/1701#2). A `partially_accurate` verdict ("core claim right, a detail is
// off") is INVALID unless it carries a `discrepancy` that NAMES the error (`claimed`) and
// SOURCES the truth (`actual` + `source`). A classifier that merely *feels* a claim is
// "mostly right" but cannot name+source the specific discrepancy cannot reach for this
// bucket — it must fall back. This is what stops `partially_accurate` from becoming a
// no-lose lazy default.

import { normalizeVerdict, FACT_VERDICTS, type FactVerdict } from './types/factVerdict.js';
import type { FactCheckResult, FactDiscrepancy } from './types/synthesis.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';
import { parseFactCheckFinding } from './factCheckFinding.js';

/**
 * Deterministic fallback when a `partially_accurate` verdict fails the discrepancy gate.
 * Per t/1701#1 the classifier "must choose `supported` (nothing off) or
 * `disputed`/`unverifiable`". We cannot re-run the check here, so we pick the conservative
 * option — `unverifiable` — which is also the existing parse-failure default at the live
 * fact-check parse site (synthesisSlice: `parseAIJson` → `{ verdict: 'unverifiable' }`).
 * "Do not invent behavior": this reuses that established default.
 */
export const PARTIALLY_ACCURATE_FALLBACK: FactVerdict = 'unverifiable';

/**
 * True only when the discrepancy names the error and sources the truth (all three non-empty).
 * Returns a plain `boolean` (not a type predicate) on purpose: an incomplete-but-present
 * discrepancy is still a `FactDiscrepancy` at runtime, so narrowing to `never` on the false
 * branch would be incorrect.
 */
export function isDiscrepancyComplete(d: FactDiscrepancy | undefined): boolean {
  return (
    !!d &&
    typeof d.claimed === 'string' && d.claimed.trim().length > 0 &&
    typeof d.actual === 'string' && d.actual.trim().length > 0 &&
    typeof d.source === 'string' && d.source.trim().length > 0
  );
}

/**
 * Apply the structural anti-escape-hatch gate to a (verdict, discrepancy) pair.
 * Returns the verdict that survives validation:
 * - `partially_accurate` with a complete discrepancy → unchanged.
 * - `partially_accurate` WITHOUT a complete discrepancy → the deterministic fallback
 *   (`PARTIALLY_ACCURATE_FALLBACK`); the rejection is recorded on the flight recorder.
 * - every other verdict → unchanged.
 *
 * @param debateId optional debate id for flight-recorder correlation.
 */
export function resolveFactVerdict(
  verdict: FactVerdict,
  discrepancy: FactDiscrepancy | undefined,
  debateId?: string,
): FactVerdict {
  if (verdict !== 'partially_accurate') return verdict;
  if (isDiscrepancyComplete(discrepancy)) return verdict;

  // Escape-hatch attempt: "mostly right" with no named, sourced error. Reject → fall back.
  getGlobalRecorder()?.record({
    type: 'system.error',
    component: 'debate-engine',
    level: 'warn',
    debate_id: debateId,
    message: `Rejected 'partially_accurate' verdict lacking a complete discrepancy (claimed+actual+source); falling back to '${PARTIALLY_ACCURATE_FALLBACK}'`,
    data: {
      gate: 'partially_accurate_requires_sourced_discrepancy',
      discrepancy_present: !!discrepancy,
      has_claimed: !!discrepancy?.claimed,
      has_actual: !!discrepancy?.actual,
      has_source: !!discrepancy?.source,
    },
  });
  return PARTIALLY_ACCURATE_FALLBACK;
}

/** Shape a raw discrepancy object into a FactDiscrepancy, or undefined if unusable. */
function coerceDiscrepancy(raw: unknown): FactDiscrepancy | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const d = raw as Record<string, unknown>;
  const dimension = d.dimension as FactDiscrepancy['dimension'];
  const severity = d.severity as FactDiscrepancy['severity'];
  return {
    dimension,
    claimed: typeof d.claimed === 'string' ? d.claimed : '',
    actual: typeof d.actual === 'string' ? d.actual : '',
    source: typeof d.source === 'string' ? d.source : '',
    severity: severity === 'major' ? 'major' : 'minor',
  };
}

/**
 * Parse + validate a raw fact-check response into a well-formed `FactCheckResult`.
 *
 * - normalizes the verdict (legacy `verified` → `supported`); an unrecognized verdict
 *   falls back to `unverifiable` (existing parse-failure default).
 * - enforces the structural anti-escape-hatch gate via {@link resolveFactVerdict}: a
 *   `partially_accurate` without a complete `discrepancy` is downgraded to the fallback
 *   verdict, and the (incomplete) discrepancy is dropped from the result.
 *
 * @param raw the parsed JSON object from the classifier (already run through parseAIJson).
 * @param debateId optional debate id for flight-recorder correlation.
 */
export function validateFactCheckResult(raw: unknown, debateId?: string): FactCheckResult {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const rawVerdict = typeof obj.verdict === 'string' ? normalizeVerdict(obj.verdict) : 'unverifiable';
  const verdict: FactVerdict = (FACT_VERDICTS as readonly string[]).includes(rawVerdict)
    ? (rawVerdict as FactVerdict)
    : 'unverifiable';

  const discrepancy = coerceDiscrepancy(obj.discrepancy);
  const resolvedVerdict = resolveFactVerdict(verdict, discrepancy, debateId);

  // Keep the discrepancy only if it survived the gate (verdict stayed partially_accurate)
  // or is attached diagnostically to disputed/false with a complete payload.
  const keepDiscrepancy =
    resolvedVerdict === 'partially_accurate'
      ? isDiscrepancyComplete(discrepancy)
      : (resolvedVerdict === 'disputed' || resolvedVerdict === 'false') && isDiscrepancyComplete(discrepancy);

  const sources = Array.isArray(obj.sources)
    ? (obj.sources as unknown[]).filter((s): s is { node_id?: string; conflict_id?: string } => !!s && typeof s === 'object')
    : [];

  // t/763: the pithy finding, checked against the verdict that survived the gate.
  const finding = parseFactCheckFinding(obj, resolvedVerdict);
  if (finding.dropped) {
    getGlobalRecorder()?.record({
      type: 'ai.fallback', component: 'fact-check-validator', level: 'warn', debate_id: debateId,
      message: `Fact-check finding dropped (${finding.dropped}); the card falls back to the explanation`,
      data: { verdict: resolvedVerdict, reason: finding.dropped },
    });
  }

  return {
    verdict: resolvedVerdict,
    explanation: typeof obj.explanation === 'string' ? obj.explanation : '',
    sources,
    checked_text: typeof obj.checked_text === 'string' ? obj.checked_text : '',
    ...(keepDiscrepancy ? { discrepancy } : {}),
    ...(finding.value ?? {}),
  };
}
