// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Steelman target normalization + verdicts (t/3514).
//
// Debaters must steelman before critiquing (STEELMAN_INSTRUCTION), and claim extraction tags such
// claims with `steelman_of`. A validator then compares each steelman against what the target camp
// actually asserted (NLI entailment) — an ideological Turing test. It never ran: the extraction
// prompt asked for the opponent's NAME ("Safetyist"), the validators looked up commitments by camp
// ID ("safetyist"), so every lookup missed and every steelman was skipped silently. Zero
// "[Steelman check]" warnings in any debate, ever. The tag also carried non-camp values
// ("AN-18", "D-7").
//
// This module owns the target normalization (at ingestion, for both the app and engine paths) and
// the verdict shape persisted on the claim node so the UI can show it. Pure; no IO.

import type { SpeakerId } from './types/phase.js';
import type { ArgumentNetworkNode } from './types/argumentNetwork.js';

export type CampId = Exclude<SpeakerId, 'user'>;

const CAMP_IDS: ReadonlySet<string> = new Set(['accelerationist', 'safetyist', 'skeptic']);

/** Persona names the debaters use in prose, mapped to their camp. */
const PERSONA_TO_CAMP: Record<string, CampId> = {
  prometheus: 'accelerationist',
  sentinel: 'safetyist',
  cassandra: 'skeptic',
};

/** Entailment at or above this means the steelman states something the target actually asserted. */
export const STEELMAN_ENTAILMENT_THRESHOLD = 0.6;

export interface SteelmanTargetResult {
  /** Normalized camp id, or null when the raw value is not a usable steelman target. */
  target: CampId | null;
  /** Why a non-empty raw value was rejected (for the flight recorder). */
  rejected?: 'not_a_camp' | 'self_steelman';
}

/**
 * Normalize an extracted `steelman_of` to a camp id. Accepts ids, display labels
 * ("Safetyist", "the Skeptic"), and persona names; rejects claim/document ids and a debater
 * steelmanning themselves.
 */
export function normalizeSteelmanTarget(raw: unknown, speaker: string): SteelmanTargetResult {
  if (raw == null) return { target: null };
  const s = String(raw).trim().toLowerCase().replace(/^the\s+/, '').replace(/['’]s$/, '');
  if (!s || s === 'null' || s === 'none') return { target: null };
  const camp = (CAMP_IDS.has(s) ? s : PERSONA_TO_CAMP[s]) as CampId | undefined;
  if (!camp) return { target: null, rejected: 'not_a_camp' };
  if (camp === speaker) return { target: null, rejected: 'self_steelman' };
  return { target: camp };
}

/** Verdict persisted on a steelman claim node (`ArgumentNetworkNode.steelman_check`). */
export interface SteelmanCheck {
  /** faithful: the target actually asserted something the steelman entails.
   *  diverges: nothing the target asserted is entailed — the steelman misrepresents them.
   *  unchecked: the check could not run (see reason). */
  verdict: 'faithful' | 'diverges' | 'unchecked';
  /** Highest NLI entailment against the target's recent assertions (absent when unchecked). */
  max_entailment?: number;
  /** The target assertion with the highest entailment — what the steelman best matches. */
  best_match?: string;
  /** Why the check did not run, or other context. */
  reason?: string;
}

/** Turn NLI results for (steelman, assertion) pairs into a verdict. */
export function steelmanVerdict(
  assertions: ReadonlyArray<string>,
  nliEntailments: ReadonlyArray<number | undefined>,
): SteelmanCheck {
  if (assertions.length === 0) return { verdict: 'unchecked', reason: 'Target has no recorded assertions yet' };
  let best = -1;
  let bestIdx = 0;
  nliEntailments.forEach((e, i) => { const v = e ?? 0; if (v > best) { best = v; bestIdx = i; } });
  if (best < 0) return { verdict: 'unchecked', reason: 'NLI returned no results' };
  return {
    verdict: best >= STEELMAN_ENTAILMENT_THRESHOLD ? 'faithful' : 'diverges',
    max_entailment: Math.round(best * 1000) / 1000,
    best_match: assertions[bestIdx],
  };
}

/** Display label for a steelman target that may be a camp id, a legacy label, or junk. */
export function steelmanTargetLabel(raw: string | undefined, labelOf: (camp: CampId) => string): string | null {
  if (!raw) return null;
  const { target } = normalizeSteelmanTarget(raw, '');
  return target ? labelOf(target) : null;
}

/** A steelman AN node offered to a plan as an attack reference (t/388). */
export interface SteelmanRefOffer { id: string; steelman_of: string; text: string }

/**
 * Steelman AN nodes from earlier entries that target a camp other than the speaker's (t/388).
 * At plan time the current entry has no id and none of its nodes are minted, so every node with a
 * source entry is from an earlier entry.
 * Most recent first, capped at max.
 */
export function offeredSteelmanRefs(nodes: ArgumentNetworkNode[], speakerCamp: string, max = 6): SteelmanRefOffer[] {
  const out: SteelmanRefOffer[] = [];
  for (let i = nodes.length - 1; i >= 0 && out.length < max; i--) {
    const n = nodes[i];
    if (!n.steelman_of || n.steelman_of === speakerCamp) continue;
    if (!n.source_entry_id) continue;
    out.push({ id: n.id, steelman_of: n.steelman_of, text: n.text });
  }
  return out;
}
