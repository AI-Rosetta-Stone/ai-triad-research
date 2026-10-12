// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Replication gate + metric distributions (ADR-007 file-size split, t/1686; logic t/1668).
 *
 * Turns a regression from a post-hoc excuse into a pre-condition: a regression
 * may only be acted on when a fixed config has been replicated n ≥ MIN_N times,
 * and the metric is reported as a robust distribution, never a single draw.
 */

import type { CalibrationDataPoint } from './schema.js';
import { getGlobalRecorder } from '../../flight-recorder/index.js';

// ── Replication gate + metric distributions (t/1668, R-1) ──────────────────
//
// Instrument-effects review (arXiv:2607.14399) F-1: our >5%/7-day regression
// trigger fires on what may be a single draw from a non-stable distribution
// (3 of 4 fixed configs were non-stable at n=10 in the paper). This gate turns
// root-cause class 5 ("Stochastic — within expected variance") from a post-hoc
// excuse into a pre-condition: a regression may only be acted on when the fixed
// config has been replicated n ≥ REPLICATION_GATE_MIN_N times, and the metric is
// reported as a distribution (median + spread), never a single point.
//
// Provenance: n=10 is STIPULATED (borrowed from the paper; re-derive our own
// stability threshold once replication data exists — t/1668 AC#3, CL's register).

/** Minimum clean-tree replications of a fixed config before a regression may fire. */
export const REPLICATION_GATE_MIN_N = 10;

/**
 * Identity of one "instrument" (Bronder's sense): the t/1672 provenance triple.
 * Runs sharing a fixedConfigKey are replications of the same committed config.
 * Endorsed by CL (t/1668#2) — do NOT widen with temperature/situation_cap; if a
 * run varies those without a config_revision bump, that is a provenance-binding
 * gap to fix in t/1672, not by widening this key.
 *
 * 5th segment: behaviour_revision (t/4166) — first 12 hex of SHA-256 over declared
 * behaviour-bearing source files (see behaviourRevisionFiles.ts), generated at build time.
 * Absent on legacy rows, which pool under the empty-string segment exactly as they did
 * before this key widened. Rows with different behaviour_revision values are different
 * instruments and must not pool.
 */
export function fixedConfigKey(dp: CalibrationDataPoint): string {
  return [
    dp.config_revision,
    dp.prompt_version,
    dp.model,
    dp.model_pool ?? dp.model_api_id ?? '',
    dp.behaviour_revision ?? '',
  ].join('|');
}

/** A metric's value for one run; null/undefined means "not measured for this run". */
export type MetricSelector = (dp: CalibrationDataPoint) => number | null | undefined;

/** Robust distribution summary of a metric over a replication set. */
export interface MetricDistribution {
  /** Count of runs contributing a finite value. */
  n: number;
  median: number;
  /** Inter-quartile range (Q3 − Q1) — robust spread. */
  iqr: number;
  /** Median absolute deviation from the median — robust spread. */
  mad: number;
  min: number;
  max: number;
}

/** Result of gating one metric on one fixed config's replication set. */
export interface ReplicationGateResult {
  fixed_config_key: string;
  /** Number of clean-tree replications of this fixed config. */
  replication_count: number;
  /** True iff replication_count ≥ REPLICATION_GATE_MIN_N — the trigger may fire. */
  fire_permitted: boolean;
  /** Metric distribution over the replication set; null if no finite values. */
  distribution: MetricDistribution | null;
}

/** Median of a pre-sorted ascending array. Caller guarantees non-empty. */
export function medianSorted(sorted: number[]): number {
  const n = sorted.length;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Linear-interpolation quantile of a pre-sorted ascending array (type-7, the
 * NumPy/R default). q in [0,1]. Caller guarantees non-empty.
 */
export function quantileSorted(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const frac = pos - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Compute a robust distribution summary from raw metric values. Non-finite
 * values (null/undefined/NaN) are dropped. Returns null if nothing finite
 * remains, so callers report "no distribution" rather than a fabricated point.
 */
export function computeDistribution(values: Array<number | null | undefined>): MetricDistribution | null {
  const finite = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const median = medianSorted(sorted);
  const iqr = quantileSorted(sorted, 0.75) - quantileSorted(sorted, 0.25);
  const absDev = sorted.map(v => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = medianSorted(absDev);
  return { n: sorted.length, median, iqr, mad, min: sorted[0], max: sorted[sorted.length - 1] };
}

/**
 * The replication set for a fixed config: clean-tree runs only. A dirty/unknown
 * working tree is not a reproducible replication of the committed instrument, so
 * it must not count toward n (endorsed by CL, t/1668#2).
 */
export function replicationSet(entries: CalibrationDataPoint[], key: string): CalibrationDataPoint[] {
  return entries.filter(e => {
    if (e.working_tree_state !== 'clean') return false;
    if (fixedConfigKey(e) !== key) return false;
    if (e.speaker_model_failovers) return false;
    // 'unavailable' is an explicit opt-out: the recording layer cannot observe
    // failover on this path. Exclude regardless of fingerprint — an unfingerprinted
    // row with this claim would otherwise skip the isFingerprinted branch and be
    // counted in the legacy group (t/4040).
    if (e.failover_tracking === 'unavailable') return false;
    // Fingerprinted rows require explicit 'tracked' claim — absent means the
    // recording layer didn't opt in, so failover visibility is unknown (t/4040).
    const isFingerprinted = Boolean(e.model_pool ?? e.model_api_id);
    if (isFingerprinted && e.failover_tracking !== 'tracked') {
      if (e.failover_tracking === undefined) {
        getGlobalRecorder()?.record({
          type: 'system.info',
          component: 'replication-gate',
          level: 'warn',
          message: `replication-gate: fingerprinted row missing failover_tracking — excluded from replication set (debate_id=${e.debate_id})`,
        });
      }
      return false;
    }
    return true;
  });
}

/**
 * Gate one metric on one fixed config. The trigger may fire only when the config
 * has ≥ REPLICATION_GATE_MIN_N clean replications; the metric is summarised as a
 * distribution over that set, never a single draw (t/1668 AC#1, AC#2).
 */
export function evaluateReplicationGate(
  entries: CalibrationDataPoint[],
  key: string,
  metric: MetricSelector,
): ReplicationGateResult {
  const set = replicationSet(entries, key);
  return {
    fixed_config_key: key,
    replication_count: set.length,
    fire_permitted: set.length >= REPLICATION_GATE_MIN_N,
    distribution: computeDistribution(set.map(metric)),
  };
}

/**
 * Evaluate the replication gate for one metric across every fixed config present
 * in the clean-tree entries. One ReplicationGateResult per distinct config,
 * sorted by descending replication_count (most-replicated instruments first).
 */
export function replicationGateByConfig(
  entries: CalibrationDataPoint[],
  metric: MetricSelector,
): ReplicationGateResult[] {
  const keys = new Set<string>();
  for (const e of entries) {
    if (e.working_tree_state === 'clean') keys.add(fixedConfigKey(e));
  }
  return [...keys]
    .map(key => evaluateReplicationGate(entries, key, metric))
    .sort((a, b) => b.replication_count - a.replication_count);
}
