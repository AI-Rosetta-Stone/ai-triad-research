// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Pure presentation helpers for the Inquiry UI (t/3583). No metric-labelling logic here beyond
// mapping a closed enum to display text — trust verdicts and reasons render verbatim from the
// data (t/3583#1/#2), never re-derived.

import type { Camp, Fidelity, InquiryResult, TrustVerdict } from '@lib/inquiry';

export const CAMP_LABELS: Record<Camp, string> = {
  acc: 'Accelerationist',
  saf: 'Safetyist',
  skp: 'Skeptic',
  cc: 'Cross-Cutting',
};

export const FIDELITY_LABELS: Record<Fidelity, string> = {
  quick: 'Quick',
  standard: 'Standard',
  deep: 'Deep',
};

export const FIDELITY_DESCRIPTIONS: Record<Fidelity, string> = {
  quick: 'A first read on how the perspectives divide. Good for scoping a question.',
  standard: 'Full debate with situation injection and neutral evaluation.',
  deep: 'Extended argumentation where cruxes need room to resolve.',
};

/** "censored" is the correct internal/technical term (matches the t/1671 gate + calibration
 *  vocabulary) — the label ONLY translates it for a researcher audience (TL t/3583#2). Never
 *  re-derive whether a metric is trustworthy; that verdict is `TrustState.verdict` verbatim. */
export function trustVerdictLabel(verdict: TrustVerdict): string {
  return verdict === 'censored' ? 'incomplete' : 'trust';
}

const STAGE_ORDER = ['grounding', 'debating', 'judging', 'synthesizing'] as const;
export const STAGE_META: Record<(typeof STAGE_ORDER)[number], { title: string; sub: string }> = {
  grounding: { title: 'Ground', sub: 'Mining the corpus for how each camp frames the question.' },
  debating: { title: 'Debate', sub: 'Perspectives arguing, situations injected.' },
  judging: { title: 'Judge', sub: 'Neutral evaluator scores cruxes, claims, engagement.' },
  synthesizing: { title: 'Synthesize', sub: 'Assembling the answer and reading the calibration.' },
};

/** Per-stage status for the running view — 'done' | 'live' | 'wait' — derived from the job's
 *  current status enum. `queued` renders all four stages as waiting. */
export function stageStatus(current: string | null, stage: (typeof STAGE_ORDER)[number]): 'done' | 'live' | 'wait' {
  if (current === null || current === 'queued') return 'wait';
  const currentIdx = STAGE_ORDER.indexOf(current as (typeof STAGE_ORDER)[number]);
  const stageIdx = STAGE_ORDER.indexOf(stage);
  if (currentIdx === -1) return 'wait';
  if (stageIdx < currentIdx) return 'done';
  if (stageIdx === currentIdx) return 'live';
  return 'wait';
}
export { STAGE_ORDER };

/** ADR-001 graceful-empty makes "found nothing" and "never looked" arrive identically (TL
 *  t/3583#4 point 2) — a terminal result with no substantive content needs its OWN treatment,
 *  not a blank answer page that reads as broken. */
export function isZeroResult(result: InquiryResult): boolean {
  return result.campVerdicts.length === 0
    && result.convergences.length === 0
    && result.evidenceLayers.length === 0;
}
