// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * How a fact-check transcript entry reads outside the card: in the text and Markdown exports, in the
 * PDF export (Electron prints debateToHtml, which is built from debateToMarkdown) and in
 * formatDebateMarkdown (t/771). Since t/766 an app fact check's `content` holds only the
 * checked claim and the explanation; the verdict lives in `metadata.fact_check`. Exports that print
 * `content` therefore lost the verdict. Everything here reads the stored fields instead, and prints
 * the verdict exactly once, whichever shape the entry has:
 *
 * - app entry, new (metadata.fact_check, content without a title line): built from the fields;
 * - app entry, old (content starts "**Fact Check: <Label>**"): content as stored, already labelled;
 * - engine entry (gapAndDrift: metadata.verdict, content "Claim <id> — <verdict>: ..."): content as stored.
 */

import { normalizeVerdict, type FactVerdict } from './types/factVerdict.js';

/** Reader-facing verdict labels. The card's pill text is the upper-case form of these (t/771). */
export const FACT_VERDICT_LABEL: Readonly<Record<FactVerdict, string>> = {
  supported: 'Supported',
  partially_accurate: 'Partly accurate',
  disputed: 'Disputed',
  false: 'False',
  unverifiable: "Can't verify",
};

type Meta = Record<string, unknown>;
interface FactCheckEntryLike { content: string; metadata?: Record<string, unknown> }

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** An old app entry's first line: `**Fact Check: Supported**`. */
const LEGACY_TITLE = /^\s*\*\*Fact Check:\s*[^*\n]+\*\*\s*(?:\n|$)/i;
/** The label inside that title line. */
const LEGACY_TITLE_LABEL = /^\s*\*\*Fact Check:\s*([^*\n]+)\*\*/i;
/** An engine (CLI) entry's content: `Claim AN-3 — supported: ...`. */
const ENGINE_CONTENT = /^\s*Claim \S+ — [a-z_]+:/i;

export interface FactCheckExportView {
  /** The normalised verdict, or the raw string when it isn't one of the five. */
  verdict: string;
  /** Reader-facing label: FACT_VERDICT_LABEL, or the raw verdict, or 'Unknown'. */
  label: string;
  /** True when `content` already states the verdict (old app entry or engine entry): print it as stored. */
  contentCarriesVerdict: boolean;
  checked?: string;
  finding?: string;
  points: string[];
  limit?: string;
  explanation?: string;
  /** Titles of the web citations, deduplicated, in order. Never ids or URLs. */
  sources: string[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const optional = (v: unknown): string | undefined => str(v) || undefined;

/** Citation titles, deduplicated, from either entry shape. Never ids or URLs. */
function citationTitles(fc: Meta, meta: Meta): string[] {
  const list = Array.isArray(fc.web_search_citations) ? fc.web_search_citations : meta.web_search_citations;
  return Array.isArray(list) ? [...new Set((list as Meta[]).map(c => str(c?.title)).filter(Boolean))] : [];
}

function verdictOf(fc: Meta, meta: Meta, content: string): { verdict: string; label: string } {
  const raw = str(fc.verdict) || str(meta.verdict);
  if (!raw) {
    // An old app entry with no stored verdict still names it in its title line; keep that label (Quality, #5600).
    const title = LEGACY_TITLE_LABEL.exec(content)?.[1]?.trim();
    return title ? { verdict: '', label: title } : { verdict: '', label: 'Unknown' };
  }
  const verdict = normalizeVerdict(raw);
  return { verdict, label: (FACT_VERDICT_LABEL as Record<string, string>)[verdict] ?? raw };
}

export function factCheckExportView(entry: FactCheckEntryLike): FactCheckExportView {
  const meta = (entry.metadata ?? {}) as Meta;
  const fc = (meta.fact_check && typeof meta.fact_check === 'object' ? meta.fact_check : {}) as Meta;
  return {
    ...verdictOf(fc, meta, entry.content),
    contentCarriesVerdict: LEGACY_TITLE.test(entry.content) || ENGINE_CONTENT.test(entry.content),
    checked: optional(fc.checked_text) ?? optional(meta.claim_text),
    finding: optional(fc.finding),
    points: strings(fc.finding_points),
    limit: optional(fc.limit),
    explanation: optional(fc.explanation),
    sources: citationTitles(fc, meta),
  };
}

/**
 * The export lines for a fact-check entry (Design, t/771):
 * `Fact check: <label>`, `Checked: "<claim>"`, then the finding with its points and `Limit:`,
 * or the explanation when there is no finding, then `Sources:`. Entries whose content already
 * states the verdict are returned as stored, so the verdict is never printed twice.
 */
export function factCheckExportLines(entry: FactCheckEntryLike, style: 'markdown' | 'text'): string[] {
  const v = factCheckExportView(entry);
  if (v.contentCarriesVerdict) return [entry.content];
  const md = style === 'markdown';
  const lines = [md ? `**Fact check: ${v.label}**` : `Fact check: ${v.label}`];
  if (v.checked) lines.push(`Checked: "${v.checked}"`);
  lines.push('');
  if (v.finding) {
    lines.push(v.finding);
    for (const p of v.points) lines.push(`- ${p}`);
    if (v.limit) lines.push(`Limit: ${v.limit}`);
  } else {
    // No structured finding: the stored explanation, else whatever content holds (claim + explanation).
    lines.push(v.explanation ?? entry.content);
  }
  if (v.sources.length) {
    lines.push('');
    lines.push(`Sources: ${v.sources.join('; ')}`);
  }
  return lines;
}

/** One line for a summary list: the label once, then the finding, the explanation or the content without a title line. */
export function factCheckSummaryText(entry: FactCheckEntryLike, maxChars = 240): { label: string; text: string } {
  const v = factCheckExportView(entry);
  // The label is printed once by the caller, so strip any verdict the stored content repeats.
  const body = v.finding ?? v.explanation ?? entry.content.replace(LEGACY_TITLE, '').replace(/^(\s*Claim \S+) — [a-z_]+:/i, '$1:').trim();
  return { label: v.label, text: body.slice(0, maxChars) };
}
