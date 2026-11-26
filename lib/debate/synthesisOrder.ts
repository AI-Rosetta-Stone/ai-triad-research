// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Relevance order for the synthesis lists (t/769). The card shows the top 3 of each list, so the most
 * important items must come first. A deterministic, stable sort runs before the markdown is built and
 * in every export, so the model's own order is only the tie-break. Rules (Design, t/769):
 *
 * - Agreements: `answers_question` first; then held by all three camps; then converged / conceded; then model order.
 * - Disagreements: the one matching `topic_resolution.what_would_resolve_it` first; then more camps with a
 *   position; then model order. (No ranking by resolution type: how it could be settled is not how important it is.)
 * - Cruxes: the one matching `what_would_resolve_it` first; then model order.
 *
 * Guard (Design): no key depends on WHICH camp, only on how many. Old syntheses without
 * `answers_question` order the same way, with that key treated as false.
 */

import { getGlobalRecorder } from '../flight-recorder/index.js';

type Item = Record<string, unknown>;

/** Content words for the decisive-crux match: lower-case alphanumeric tokens of 4+ letters, minus stop words. */
const STOP = new Set(['that', 'this', 'with', 'from', 'would', 'should', 'could', 'which', 'whether', 'what', 'their', 'there', 'have', 'been', 'more', 'than', 'into', 'about', 'they', 'them', 'does', 'will']);
function contentWords(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !STOP.has(w)));
}

/** Overlap of a with b over the smaller set (0..1). */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / Math.min(a.size, b.size);
}

/** Minimum overlap for an item to count as the decisive crux. */
export const DECISIVE_MATCH_MIN = 0.5;

/** Index of the single item whose text best matches `decisive` (at least DECISIVE_MATCH_MIN), or -1. First wins ties. */
export function decisiveIndex(texts: string[], decisive: string | undefined): number {
  if (!decisive) return -1;
  const d = contentWords(decisive);
  let best = -1;
  let bestScore = -1;
  texts.forEach((t, i) => {
    const s = overlap(contentWords(t), d);
    if (s >= DECISIVE_MATCH_MIN && s > bestScore) { best = i; bestScore = s; }
  });
  return best;
}

/** Stable sort by a tuple of numeric keys (lower first); equal tuples keep input order. */
function stableSortBy<T>(items: T[], keys: (item: T, index: number) => number[]): T[] {
  return items
    .map((item, i) => ({ item, i, k: keys(item, i) }))
    .sort((a, b) => {
      for (let j = 0; j < a.k.length; j++) if (a.k[j] !== b.k[j]) return a.k[j] - b.k[j];
      return a.i - b.i;
    })
    .map(x => x.item);
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const distinctCount = (v: unknown) => (Array.isArray(v) ? new Set(v.map(String)).size : 0);

export function orderAgreements(items: Item[]): Item[] {
  return stableSortBy(items, a => [
    a.answers_question === true ? 0 : 1,
    distinctCount(a.povers) >= 3 ? 0 : 1,
    a.converged === true || str(a.conceded_by).trim() !== '' ? 0 : 1,
  ]);
}

export function orderDisagreements(items: Item[], decisive: string | undefined): Item[] {
  const top = decisiveIndex(items.map(d => str(d.point)), decisive);
  return stableSortBy(items, (d, i) => [
    i === top ? 0 : 1,
    -(Array.isArray(d.positions) ? new Set((d.positions as Item[]).map(p => String(p?.pover))).size : 0),
  ]);
}

export function orderCruxes(items: Item[], decisive: string | undefined): Item[] {
  const top = decisiveIndex(items.map(c => str(c.question)), decisive);
  return stableSortBy(items, (_c, i) => [i === top ? 0 : 1]);
}

/**
 * Return a copy of a synthesis object with the three lists in relevance order. Lists that are absent
 * or not arrays are left as they are. Safe to call more than once (the order is a fixed point).
 */
export function orderSynthesisLists<T extends Item | undefined>(data: T): T {
  if (!data) return data;
  const decisive = str((data.topic_resolution as Item | undefined)?.what_would_resolve_it) || undefined;
  const out: Item = { ...data };
  if (Array.isArray(data.areas_of_agreement)) out.areas_of_agreement = orderAgreements(data.areas_of_agreement as Item[]);
  if (Array.isArray(data.areas_of_disagreement)) out.areas_of_disagreement = orderDisagreements(data.areas_of_disagreement as Item[], decisive);
  if (Array.isArray(data.cruxes)) out.cruxes = orderCruxes(data.cruxes as Item[], decisive);
  return out as T;
}

/**
 * Fresh model output: normalise `answers_question` (one WARN if any were missing or invalid), then order
 * the lists. Called once by SynthesisPipeline before the markdown and the stored metadata are built.
 */
export function prepareSynthesisLists(data: Item, debateId?: string): Item {
  const { missing, invalid } = normaliseAnswersQuestion(data.areas_of_agreement);
  if (missing + invalid > 0) {
    getGlobalRecorder()?.record({
      type: 'ai.fallback', component: 'synthesis-pipeline', level: 'warn', debate_id: debateId,
      message: `Synthesis agreements: answers_question missing on ${missing}, invalid on ${invalid}; treated as false for ordering`,
      data: { missing, invalid },
    });
  }
  return orderSynthesisLists(data);
}

/**
 * Normalise `answers_question` on fresh model output (t/769): keep a boolean, drop anything else.
 * Returns how many agreements were missing it or had a non-boolean, for one WARN by the caller.
 */
export function normaliseAnswersQuestion(agreements: unknown): { missing: number; invalid: number } {
  let missing = 0;
  let invalid = 0;
  if (!Array.isArray(agreements)) return { missing, invalid };
  for (const a of agreements as Item[]) {
    if (!a || typeof a !== 'object') continue;
    if (!('answers_question' in a)) missing++;
    else if (typeof a.answers_question !== 'boolean') { invalid++; delete a.answers_question; }
  }
  return { missing, invalid };
}
