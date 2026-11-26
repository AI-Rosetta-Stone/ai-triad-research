// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/764 (docs/ux/debate-fact-check-card.md): pure helpers behind the fact-check card: the pill
// text, the finding and its fallback for old entries (§6), the points, the source links and the
// checked statement. No React, so each rule is testable on its own.

import type { FactVerdict } from '@lib/debate/types';
import { FACT_VERDICT_LABEL } from '@lib/debate/factCheckExport';

/** §3: the pill text, derived from the one label source the exports use (t/772), so the card and the
 *  exports can't drift. The word is always shown, so colour is never the only signal. */
export const FACT_PILL_TEXT: Record<FactVerdict | 'pending', string> = {
  supported: FACT_VERDICT_LABEL.supported.toUpperCase(),
  partially_accurate: FACT_VERDICT_LABEL.partially_accurate.toUpperCase(),
  disputed: FACT_VERDICT_LABEL.disputed.toUpperCase(),
  false: FACT_VERDICT_LABEL.false.toUpperCase(),
  unverifiable: FACT_VERDICT_LABEL.unverifiable.toUpperCase(),
  pending: 'CHECKING…',
};

export function pillTextOf(verdict: string | undefined): string {
  if (!verdict) return FACT_PILL_TEXT.pending;
  return (FACT_PILL_TEXT as Record<string, string>)[verdict] ?? verdict.toUpperCase();
}

/** The finding is one sentence of at most 25 words; the fallback for an old entry takes 30. */
const OLD_FINDING_MAX_WORDS = 30;

const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

/** The first sentence of `text`, or null when it has none that ends in terminal punctuation. */
function firstSentence(text: string): string | null {
  const m = text.trim().match(/^[^.!?]*[.!?](?=\s|$)/);
  return m ? m[0].trim() : null;
}

/** §6: an entry without `finding` uses the first sentence of `explanation` that isn't "This
 *  matters…" framing, if it is 30 words or fewer. Null means: show the explanation as today. */
export function fallbackFindingOf(explanation: string | undefined): string | null {
  if (!explanation) return null;
  const sentences = explanation.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [];
  for (const raw of sentences) {
    const s = raw.trim();
    if (/^this matters\b/i.test(s)) continue;
    return wordCount(s) <= OLD_FINDING_MAX_WORDS ? s : null;
  }
  return null;
}

/** The stored fields the new card reads. All optional: an old entry has none of them. */
export interface FactCheckFindingFields {
  finding?: unknown;
  finding_points?: unknown;
  limit?: unknown;
  explanation?: string;
}

const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** The finding line: the stored `finding`, else the §6 fallback, else null. */
export function findingOf(fc: FactCheckFindingFields | undefined): string | null {
  if (!fc) return null;
  if (nonEmptyString(fc.finding)) return fc.finding.trim();
  return fallbackFindingOf(fc.explanation);
}

/** §1.4: the evidence bullets, at most 3, from `finding_points`; a malformed value gives none. */
export function pointsOf(fc: FactCheckFindingFields | undefined): string[] {
  if (!fc || !Array.isArray(fc.finding_points)) return [];
  return fc.finding_points.filter(nonEmptyString).map(p => p.trim()).slice(0, 3);
}

/** §1.4: the one `Limit` bullet, or null. */
export function limitOf(fc: FactCheckFindingFields | undefined): string | null {
  return fc && nonEmptyString(fc.limit) ? fc.limit.trim() : null;
}

/** §1.6: how many source links show before `· +N`. */
export const SOURCE_LINKS_SHOWN = 3;

export interface SourceLink { label: string; uri: string; title: string }

function hostOf(uri: string): string | null {
  const m = uri.match(/^[a-z][a-z0-9+.-]*:\/\/([^/:?#]+)/i);
  return m ? m[1].replace(/^www\./i, '') : null;
}

/** A grounding title that is only a domain ("nature.com") says no more than the link does. */
const looksLikeDomain = (t: string): boolean => !/\s/.test(t) && /\.[a-z]{2,}$/i.test(t);

/** §1.6 (Design, t/764): a short title when the citation has a real one, else the publisher (the
 *  domain). A title is cut at 30 characters. The year shows when the title carries one. */
export function sourceLinksOf(citations: readonly { uri: string; title: string }[]): { shown: SourceLink[]; more: number } {
  const all = citations.map(c => {
    const host = c.uri ? hostOf(c.uri) : null;
    const title = (c.title ?? '').trim();
    const short = title.length > 30 ? `${title.slice(0, 29)}…` : title;
    const label = title && !looksLikeDomain(title) ? short : host ?? short;
    return { label: label || 'Source', uri: c.uri, title: title || c.uri };
  });
  return { shown: all.slice(0, SOURCE_LINKS_SHOWN), more: Math.max(0, all.length - SOURCE_LINKS_SHOWN) };
}

/** §1.2: the checked claim in typographic quotes. */
export function quotedClaim(text: string): string {
  const t = text.trim().replace(/^["“]+|["”]+$/g, '');
  return `“${t}”`;
}

/** The line a collapsed card shows (§4): the finding, else the start of the explanation, else
 *  the checked claim. Never empty when the entry has any text. */
export function collapsedFindingOf(fc: FactCheckFindingFields & { checked_text?: string } | undefined): string {
  const f = findingOf(fc);
  if (f) return f;
  const fromExplanation = fc?.explanation ? firstSentence(fc.explanation.replace(/\s+/g, ' ')) ?? fc.explanation.trim() : '';
  return fromExplanation || (fc?.checked_text ?? '');
}
