// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Parse the post-turn summarization response (DT-2; structured Brief, t/700).
 *
 * `brief` and `medium` are required, as before. `brief_claim` and `brief_points` are optional:
 * when present and well formed they are kept; when malformed they are dropped and the strings
 * are kept, so the renderer falls back to the `brief` paragraph (docs/ux/debate-statement-density.md §1).
 */

export interface EntrySummaries {
  brief: string;
  medium: string;
  brief_claim?: string;
  brief_points?: string[];
}

export interface ParsedEntrySummaries {
  /** Undefined when `brief` or `medium` is missing: the entry shows full text only. */
  summaries?: EntrySummaries;
  /** Why the structured Brief was dropped, when it was. The caller logs it as a WARN. */
  structuredDropped?: string;
}

/** Per-point word cap from the spec ("about 25 words or fewer"), with slack so a 27-word point isn't thrown away. */
export const BRIEF_POINT_MAX_WORDS = 40;

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const words = (s: string) => s.trim().split(/\s+/).length;

function structuredBriefProblem(claim: unknown, points: unknown): string | undefined {
  if (!nonEmpty(claim)) return 'brief_claim missing or empty';
  if (!Array.isArray(points)) return 'brief_points is not an array';
  if (points.length < 2 || points.length > 3) return `brief_points has ${points.length} items (want 2-3)`;
  const bad = points.findIndex(p => !nonEmpty(p));
  if (bad >= 0) return `brief_points[${bad}] is not a non-empty string`;
  const long = (points as string[]).findIndex(p => words(p) > BRIEF_POINT_MAX_WORDS);
  if (long >= 0) return `brief_points[${long}] has ${words((points as string[])[long])} words (cap ${BRIEF_POINT_MAX_WORDS})`;
  return undefined;
}

/** Parse the model's raw text. Throws only on unparseable JSON (the caller already catches that). */
export function parseEntrySummaries(raw: string): ParsedEntrySummaries {
  const cleaned = raw.replace(/```json?\s*/g, '').replace(/```\s*/g, '').trim();
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;
  if (!nonEmpty(parsed.brief) || !nonEmpty(parsed.medium)) return {};

  const summaries: EntrySummaries = { brief: parsed.brief.trim(), medium: parsed.medium.trim() };
  // The old shape (strings only) still parses. Only responses to the current prompt reach this
  // parser (stored summaries are never re-parsed), so absent fields mean the model skipped them.
  const hasAny = parsed.brief_claim !== undefined || parsed.brief_points !== undefined;
  if (!hasAny) return { summaries, structuredDropped: 'brief_claim and brief_points absent' };

  const problem = structuredBriefProblem(parsed.brief_claim, parsed.brief_points);
  if (problem) return { summaries, structuredDropped: problem };

  summaries.brief_claim = (parsed.brief_claim as string).trim();
  summaries.brief_points = (parsed.brief_points as string[]).map(p => p.trim());
  return { summaries };
}
