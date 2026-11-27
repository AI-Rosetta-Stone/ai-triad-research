// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Synthesis v2 data (t/808, spec docs/ux/debate-synthesis-v2.md §2, §8, §9). The panel shows each
 * disagreement once with its verdict on the same card, so it needs a join the model's free text can't give:
 *
 * - `areas_of_disagreement[].id`: assigned here, in code, in model order (`d1`, `d2`, ...). The model is not
 *   asked for ids: a code-assigned id is unique by construction and stays on the item through ordering.
 * - `preferences[].disagreement_id`: the model copies the id from the disagreements list it is shown. When it
 *   is missing or unknown we fall back to a normalised text match of `conflict` against `point`, and WARN.
 *   A preference that matches nothing keeps no id (the panel renders it as its own card, never drops it).
 * - `unresolved_question_themes`: a parallel array beside the unchanged `unresolved_questions: string[]`
 *   (same length, '' for no theme), so every existing reader of the questions keeps working. The model
 *   returns `{question, theme}` objects; this module splits them. Absent when no question has a theme.
 *
 * Everything is optional: debates saved before t/808 have none of it and stay readable.
 */

import { matchPointIndex } from './synthesisView.js';

type Item = Record<string, unknown>;
type Warn = (operation: string, problem: string, recovery: string) => void;

const isItem = (v: unknown): v is Item => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Give every disagreement a unique string `id`. Keeps a valid, unique id already present; otherwise assigns
 * `d<n>` (n = 1-based position). Mutates the items; returns how many were assigned.
 */
export function assignDisagreementIds(disagreements: unknown): number {
  if (!Array.isArray(disagreements)) return 0;
  const used = new Set<string>();
  const items = disagreements.filter(isItem);
  for (const d of items) {
    if (typeof d.id === 'string' && d.id.trim() !== '' && !used.has(d.id)) used.add(d.id);
    else delete d.id;
  }
  let assigned = 0;
  let n = 0;
  for (const d of items) {
    if (typeof d.id === 'string') continue;
    do n++; while (used.has(`d${n}`));
    d.id = `d${n}`;
    used.add(`d${n}`);
    assigned++;
  }
  return assigned;
}

export interface PreferenceLinkCounts { total: number; kept: number; matched: number; unmatched: number }

/**
 * Make every preference's `disagreement_id` point at a real disagreement id. A model-given id that exists is
 * kept; a missing or unknown one is replaced by a text match, or dropped when nothing matches. One WARN per
 * synthesis when any preference needed the fallback. Mutates the items.
 */
export function linkPreferencesToDisagreements(
  preferences: unknown,
  disagreements: unknown,
  warn?: Warn,
): PreferenceLinkCounts {
  const counts: PreferenceLinkCounts = { total: 0, kept: 0, matched: 0, unmatched: 0 };
  if (!Array.isArray(preferences)) return counts;
  const ds = (Array.isArray(disagreements) ? disagreements : []).filter(isItem).filter(d => typeof d.id === 'string');
  const ids = new Set(ds.map(d => d.id as string));
  for (const p of preferences) {
    if (!isItem(p)) continue;
    counts.total++;
    if (typeof p.disagreement_id === 'string' && ids.has(p.disagreement_id)) { counts.kept++; continue; }
    delete p.disagreement_id;
    const at = typeof p.conflict === 'string' ? matchPointIndex(p.conflict, ds.map(d => (typeof d.point === 'string' ? d.point : ''))) : -1;
    const id = at >= 0 ? (ds[at].id as string) : undefined;
    if (id) { p.disagreement_id = id; counts.matched++; } else counts.unmatched++;
  }
  if (counts.matched + counts.unmatched > 0) {
    warn?.(
      'Synthesis preferences link',
      `disagreement_id missing or unknown on ${counts.matched + counts.unmatched} of ${counts.total} preferences; ${counts.matched} matched by text, ${counts.unmatched} left unlinked`,
      'Preferences keep their free-text conflict; the panel shows unlinked ones as their own card',
    );
  }
  return counts;
}

/**
 * Split model-returned unresolved questions (`string` or `{question, theme?}`) into the stored shape:
 * `unresolved_questions` stays `string[]`; `unresolved_question_themes` is added only when at least one
 * question has a theme. An entry in neither shape is kept as it is (never dropped) with no theme.
 * Mutates `data`; returns the number of questions that carry a theme.
 */
export function splitUnresolvedQuestions(data: Item): number {
  const raw = data.unresolved_questions;
  if (!Array.isArray(raw)) return 0;
  const questions: unknown[] = [];
  const themes: string[] = [];
  for (const q of raw) {
    if (isItem(q) && typeof q.question === 'string') {
      questions.push(q.question);
      themes.push(typeof q.theme === 'string' ? q.theme.trim() : '');
    } else {
      questions.push(q);
      themes.push('');
    }
  }
  data.unresolved_questions = questions;
  const themed = themes.filter(t => t !== '').length;
  if (themed > 0) data.unresolved_question_themes = themes;
  else delete data.unresolved_question_themes;
  return themed;
}
