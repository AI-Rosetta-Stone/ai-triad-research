// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Pithy fact-check finding (t/763, docs/ux/debate-fact-check-card.md §1.3 and §5).
 *
 * The model returns `finding`, `finding_points` and an optional `limit` alongside the existing
 * verdict/explanation/discrepancy/sources. They are kept only when well formed AND when the
 * finding's opening verdict word matches the verdict that survived the discrepancy gate, so the
 * card's words can never contradict its pill. Anything else is dropped with a reason the caller
 * logs as a WARN; the card then falls back to the explanation (§6).
 */

import type { FactVerdict } from './types/factVerdict.js';

/** The plain verdict words a finding may open with, per resolved verdict (§1.3). `Overstated.`
 *  is the partly-accurate wording for an over-claim (a magnitude or scope discrepancy). */
export const FINDING_VERDICT_WORDS: Readonly<Record<FactVerdict, readonly string[]>> = {
  supported: ['Accurate.'],
  partially_accurate: ['Partly accurate.', 'Overstated.'],
  disputed: ['Disputed.'],
  false: ['False.'],
  unverifiable: ["Can't be verified."],
};

/** Hard cap per text, with slack over the spec's ~25 words so a 27-word line isn't thrown away. */
export const FINDING_MAX_WORDS = 40;

/** Raw identifiers that must not appear in a finding: arXiv-style ids, POV node ids, conflict ids, URLs. */
export const RAW_ID = /\b\d{4}\.\d{4,5}(?:v\d+)?\b|\b(?:acc|saf|skp|cc)-[a-z]+-\d{3}\b|\bconflict-[a-z0-9-]{6,}|https?:\/\/\S+/i;

/** A finding must say something after the verdict word (a bare "Can't be verified." repeats the pill). */
export const FINDING_MIN_WORDS_AFTER_VERDICT = 4;

export interface FactCheckFinding {
  finding: string;
  finding_points: string[];
  limit?: string;
}

export interface ParsedFactCheckFinding {
  value?: FactCheckFinding;
  /** Why the finding was dropped, when it was. The caller logs it as a WARN. */
  dropped?: string;
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const words = (s: string) => s.trim().split(/\s+/).length;
// Typographic apostrophes are common in model output; compare on the ASCII form.
const asciiQuote = (s: string) => s.replace(/[‘’]/g, "'");

function findingProblem(finding: unknown, verdict: FactVerdict): string | undefined {
  if (!nonEmpty(finding)) return 'finding missing or empty';
  if (words(finding) > FINDING_MAX_WORDS) return `finding has ${words(finding)} words (cap ${FINDING_MAX_WORDS})`;
  const text = asciiQuote(finding.trim());
  const allowed = FINDING_VERDICT_WORDS[verdict];
  const opener = allowed.find(w => text.startsWith(w));
  if (!opener) return `finding does not open with the verdict word for '${verdict}' (${allowed.join(' or ')})`;
  // The verdict word alone is the pill's job; the finding must say what the evidence shows (t/763 sample).
  const rest = text.slice(opener.length).trim();
  if (!rest || words(rest) < FINDING_MIN_WORDS_AFTER_VERDICT) {
    return `finding has no statement after the verdict word (want ${FINDING_MIN_WORDS_AFTER_VERDICT}+ words)`;
  }
  // Design ruling (t/763): a raw id may appear in a point, as the speaker's, but never in the finding.
  const id = RAW_ID.exec(text);
  if (id) return `finding contains a raw identifier ('${id[0]}')`;
  return undefined;
}

function problem(obj: Record<string, unknown>, verdict: FactVerdict): string | undefined {
  const { finding_points: points, limit } = obj;
  const f = findingProblem(obj.finding, verdict);
  if (f) return f;
  if (!Array.isArray(points)) return 'finding_points is not an array';
  if (points.length < 1 || points.length > 3) return `finding_points has ${points.length} items (want 1-3)`;
  const bad = points.findIndex(p => !nonEmpty(p));
  if (bad >= 0) return `finding_points[${bad}] is not a non-empty string`;
  const long = (points as string[]).findIndex(p => words(p) > FINDING_MAX_WORDS);
  if (long >= 0) return `finding_points[${long}] has ${words((points as string[])[long])} words (cap ${FINDING_MAX_WORDS})`;
  if (limit !== undefined && limit !== null && limit !== '') {
    if (!nonEmpty(limit)) return 'limit is not a string';
    if (words(limit) > FINDING_MAX_WORDS) return `limit has ${words(limit)} words (cap ${FINDING_MAX_WORDS})`;
  }
  return undefined;
}

/**
 * Validate the finding fields of a raw fact-check object against the verdict that survived the
 * gate. An object with none of the three fields returns `{ dropped: 'finding fields absent' }`.
 */
export function parseFactCheckFinding(raw: unknown, verdict: FactVerdict): ParsedFactCheckFinding {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (obj.finding === undefined && obj.finding_points === undefined && obj.limit === undefined) {
    return { dropped: 'finding fields absent' };
  }
  const why = problem(obj, verdict);
  if (why) return { dropped: why };
  const value: FactCheckFinding = {
    finding: asciiQuote((obj.finding as string).trim()),
    finding_points: (obj.finding_points as string[]).map(p => p.trim()),
  };
  if (nonEmpty(obj.limit)) value.limit = obj.limit.trim();
  return { value };
}
