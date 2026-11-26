// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Relevance order for the synthesis lists (t/769, t/770). The card shows the top 3 of each list, so the
 * most important items must come first. A deterministic, stable sort runs before the markdown is built
 * and in every export, so the model's own order is only the tie-break. Rules (Design, t/769, t/770):
 *
 * - Agreements: `answers_question` first; then held by all three camps; then converged / conceded; then model order.
 * - Disagreements: the one the model flagged `decisive` first; then more camps with a position; then model
 *   order. (No ranking by resolution type: how it could be settled is not how important it is.)
 * - Cruxes: the one flagged `decisive` first; then model order.
 *
 * The model sets `answers_question` and `decisive` (t/770 replaced a word-overlap match against
 * `topic_resolution.what_would_resolve_it`, which never fired on a real synthesis because that field is
 * a long paragraph). Old syntheses without the flags order the same way with each flag treated as false.
 * Guard (Design): no key depends on WHICH camp, only on how many.
 */

import { getGlobalRecorder } from '../flight-recorder/index.js';

type Item = Record<string, unknown>;

/** Stable sort by a tuple of numeric keys (lower first); equal tuples keep input order. */
function stableSortBy<T>(items: T[], keys: (item: T) => number[]): T[] {
  return items
    .map((item, i) => ({ item, i, k: keys(item) }))
    .sort((a, b) => {
      for (let j = 0; j < a.k.length; j++) if (a.k[j] !== b.k[j]) return a.k[j] - b.k[j];
      return a.i - b.i;
    })
    .map(x => x.item);
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const distinctCount = (v: unknown) => (Array.isArray(v) ? new Set(v.map(String)).size : 0);
const flagged = (x: Item, key: string) => (x[key] === true ? 0 : 1);

export function orderAgreements(items: Item[]): Item[] {
  return stableSortBy(items, a => [
    flagged(a, 'answers_question'),
    distinctCount(a.povers) >= 3 ? 0 : 1,
    a.converged === true || str(a.conceded_by).trim() !== '' ? 0 : 1,
  ]);
}

export function orderDisagreements(items: Item[]): Item[] {
  return stableSortBy(items, d => [
    flagged(d, 'decisive'),
    -(Array.isArray(d.positions) ? new Set((d.positions as Item[]).map(p => String(p?.pover))).size : 0),
  ]);
}

export function orderCruxes(items: Item[]): Item[] {
  return stableSortBy(items, c => [flagged(c, 'decisive')]);
}

/**
 * Return a copy of a synthesis object with the three lists in relevance order. Lists that are absent
 * or not arrays are left as they are. Safe to call more than once (the order is a fixed point).
 */
export function orderSynthesisLists<T extends Item | undefined>(data: T): T {
  if (!data) return data;
  const out: Item = { ...data };
  if (Array.isArray(data.areas_of_agreement)) out.areas_of_agreement = orderAgreements(data.areas_of_agreement as Item[]);
  if (Array.isArray(data.areas_of_disagreement)) out.areas_of_disagreement = orderDisagreements(data.areas_of_disagreement as Item[]);
  if (Array.isArray(data.cruxes)) out.cruxes = orderCruxes(data.cruxes as Item[]);
  return out as T;
}

/** Counts from normalising one boolean flag across a list, for one WARN by the caller. */
export interface FlagCounts { missing: number; invalid: number; extra: number }

/**
 * Normalise a model-set boolean flag on fresh output: keep a boolean, drop anything else. With
 * `atMostOne`, only the first `true` in model order is kept and later ones are set to false (`extra`).
 */
export function normaliseFlag(items: unknown, key: string, atMostOne = false): FlagCounts {
  const counts: FlagCounts = { missing: 0, invalid: 0, extra: 0 };
  if (!Array.isArray(items)) return counts;
  let seen = false;
  for (const x of items as Item[]) {
    if (!x || typeof x !== 'object') continue;
    if (!(key in x)) { counts.missing++; continue; }
    if (typeof x[key] !== 'boolean') { counts.invalid++; delete x[key]; continue; }
    if (atMostOne && x[key] === true) {
      if (seen) { x[key] = false; counts.extra++; } else seen = true;
    }
  }
  return counts;
}

/** t/769 name kept for callers and tests: `answers_question` on agreements (several may be true). */
export function normaliseAnswersQuestion(agreements: unknown): { missing: number; invalid: number } {
  const { missing, invalid } = normaliseFlag(agreements, 'answers_question');
  return { missing, invalid };
}

function warnFlag(list: string, key: string, c: FlagCounts, debateId?: string): void {
  if (c.missing + c.invalid + c.extra === 0) return;
  const extra = c.extra ? `; ${c.extra} extra true value(s) set to false (first kept)` : '';
  getGlobalRecorder()?.record({
    type: 'ai.fallback', component: 'synthesis-pipeline', level: 'warn', debate_id: debateId,
    message: `Synthesis ${list}: ${key} missing on ${c.missing}, invalid on ${c.invalid}${extra}; treated as false for ordering`,
    data: { list, key, ...c },
  });
}

/**
 * Fresh model output: normalise the flags (one WARN per list that needed it), then order the lists.
 * Called once by SynthesisPipeline before the markdown and the stored metadata are built.
 */
export function prepareSynthesisLists(data: Item, debateId?: string): Item {
  warnFlag('agreements', 'answers_question', normaliseFlag(data.areas_of_agreement, 'answers_question'), debateId);
  warnFlag('disagreements', 'decisive', normaliseFlag(data.areas_of_disagreement, 'decisive', true), debateId);
  warnFlag('cruxes', 'decisive', normaliseFlag(data.cruxes, 'decisive', true), debateId);
  return orderSynthesisLists(data);
}
