// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Opening narrative voicing (h3, css-policybrief-010).
 *
 * Before the openings, the moderator retells each camp's story (what it fears losing,
 * what history it carries) without judgment. The voicing is:
 *   1. shown in the transcript as a `system` entry spoken by the moderator, so claim
 *      extraction, the neutral evaluator, calibration metrics and formatRecentTranscript
 *      all skip it (they already skip `system` entries);
 *   2. injected into each debater's opening BRIEF and DRAFT prompts, where the debater
 *      affirms or amends its own camp's account;
 *   3. embedded after the openings as a per-camp reference for measuring drift.
 *
 * Pure helpers only. Engine and renderer each own their generation/persistence wiring.
 */

import type { CampNarrative, SpeakerId } from './types.js';
import { POVER_INFO } from './poverInfo.js';
import { parseAIJson } from './helpers.js';
import { narrativeVoicingDebaterBlock } from './prompts/narrative.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';

type PoverId = Exclude<SpeakerId, 'user'>;

/** Transcript metadata marker for the voicing entry. */
export const NARRATIVE_VOICING_KIND = 'narrative_voicing';

/** Per-camp cap on taxonomy material sent to the voicing prompt. */
export const MAX_NARRATIVE_MATERIAL_CHARS = 8_000;

export function truncateNarrativeMaterial(context: string): string {
  return context.length > MAX_NARRATIVE_MATERIAL_CHARS
    ? context.slice(0, MAX_NARRATIVE_MATERIAL_CHARS) + '\n[…truncated]'
    : context;
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Parse the moderator's voicing response. Returns one narrative per active debater, or null
 * when the response is unusable or any active debater is missing: a voicing that leaves out
 * a camp would be worse than none.
 */
export function parseNarrativeVoicing(text: string, activePovers: readonly PoverId[]): CampNarrative[] | null {
  const parsed = parseAIJson<{ narratives?: unknown }>(text);
  const raw = Array.isArray(parsed?.narratives) ? parsed!.narratives as Record<string, unknown>[] : [];

  const byPov = new Map<PoverId, CampNarrative>();
  for (const r of raw) {
    const pov = typeof r?.pov === 'string' ? r.pov.trim().toLowerCase() : '';
    if (!(activePovers as readonly string[]).includes(pov)) continue;
    if (!nonEmpty(r.narrative)) continue;
    byPov.set(pov as PoverId, {
      speaker: pov as PoverId,
      fears_losing: nonEmpty(r.fears_losing) ? r.fears_losing.trim() : '',
      history_carried: nonEmpty(r.history_carried) ? r.history_carried.trim() : '',
      narrative: r.narrative.trim(),
    });
  }

  const missing = activePovers.filter(p => !byPov.has(p));
  if (missing.length > 0) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'narrative-voicing', level: 'warn',
      message: `Narrative voicing unusable — missing ${missing.join(', ')}; debate proceeds without it`,
      data: { missing, parsed_count: byPov.size, raw_head: text.slice(0, 300), raw_tail: text.slice(-200) },
    });
    return null;
  }
  return activePovers.map(p => byPov.get(p)!);
}

/** Transcript text for the moderator's voicing entry. */
export function formatNarrativeVoicingEntry(narratives: CampNarrative[]): string {
  const intro = 'Before any argument, I want to tell each camp\'s story the way its own people would tell it: what it fears losing, and what history it carries.';
  return [intro, ...narratives.map(n => n.narrative)].join('\n\n');
}

/** Prompt block for one debater's opening: its own camp's voicing plus the others'. */
export function narrativeBlockForDebater(narratives: CampNarrative[], speaker: PoverId): string {
  const toItem = (n: CampNarrative) => ({ label: POVER_INFO[n.speaker]?.label ?? n.speaker, narrative: n.narrative });
  const own = narratives.find(n => n.speaker === speaker);
  const others = narratives.filter(n => n.speaker !== speaker);
  return narrativeVoicingDebaterBlock(own ? toItem(own) : undefined, others.map(toItem));
}

/** Read the debater's affirm/amend check from its opening DRAFT work product. */
export function extractNarrativeCheck(draft: Record<string, unknown> | undefined): CampNarrative['acknowledgment'] | undefined {
  const check = draft?.narrative_check as Record<string, unknown> | undefined;
  if (!check || typeof check !== 'object') return undefined;
  const verdict = typeof check.verdict === 'string' ? check.verdict.trim().toLowerCase() : '';
  if (verdict === 'amend' && nonEmpty(check.amendment)) {
    return { verdict: 'amend', amendment: check.amendment.trim() };
  }
  if (verdict === 'affirm') return { verdict: 'affirm' };
  // 'amend' without text, or an unknown verdict: nothing usable to record.
  return undefined;
}

/** Text that becomes the camp's drift reference: the voicing as corrected by the camp itself. */
export function narrativeReferenceText(n: CampNarrative): string {
  return n.acknowledgment?.verdict === 'amend' && n.acknowledgment.amendment
    ? `${n.narrative} ${n.acknowledgment.amendment}`
    : n.narrative;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 0 ? dot / d : 0;
}

/**
 * Mean cosine similarity of a turn's paragraphs to a camp narrative. Paragraph-level so
 * long turns aren't truncated by the 256-token embedding window. Null when nothing
 * comparable (no paragraphs, or dimension mismatch).
 */
export function meanParagraphSimilarity(reference: number[], paragraphVectors: number[][]): number | null {
  const comparable = paragraphVectors.filter(v => v.length === reference.length && v.length > 0);
  if (comparable.length === 0) return null;
  return comparable.reduce((s, v) => s + cosine(reference, v), 0) / comparable.length;
}

export function splitParagraphs(content: string): string[] {
  return content.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0);
}

/** Batch text embedder. The engine passes its adapter embed (debateEngine/embedTexts.ts, t/561); the renderer passes its bridge call. */
export type EmbedTextsFn = (texts: string[]) => Promise<number[][]>;

/** Embed each camp's (possibly amended) narrative in place as its drift reference. */
export async function embedNarrativeReferences(narratives: CampNarrative[], embed: EmbedTextsFn): Promise<void> {
  const vecs = await embed(narratives.map(narrativeReferenceText));
  narratives.forEach((n, i) => { if (vecs[i]?.length) n.embedding = vecs[i]; });
}

/** Similarity of one debater turn to that debater's own camp narrative, or null if not scorable. */
export async function scoreTurnAgainstNarrative(
  narratives: CampNarrative[],
  speaker: string,
  content: string,
  embed: EmbedTextsFn,
): Promise<number | null> {
  const ref = narratives.find(n => n.speaker === speaker)?.embedding;
  if (!ref) return null;
  const paras = splitParagraphs(content);
  if (paras.length === 0) return null;
  return meanParagraphSimilarity(ref, await embed(paras));
}
