// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { SeatTag } from '@lib/debate/types';
import type { SpeakerId } from '../../types/debate';

/** Options bag passed as the trailing argument of `createDebate()` — assembled from the
 *  New Debate setup form's field values. Extracted from NewDebateDialog to keep that file
 *  under the max-lines ceiling (t/1979). */
export type CreateDebateOptions = {
  title?: string;
  evaluatorModel?: string;
  pacing?: string;
  useAdaptiveStaging?: boolean;
  phaseBoundsOverride?: { maxConfrontationRounds?: number; maxArgumentationRounds?: number; maxConcludingRounds?: number };
  speakerModels?: Record<string, string>;
  /** t/4046 (SO condition on t/4040): the backends eligible for this multi-provider run —
   *  availableBackends ∩ tier's debateTiers map, the same population resolveMultiProviderModels
   *  draws speakerModels from. Threaded to sessionSlice for the calibration model_pool fingerprint. */
  eligibleBackends?: string[];
  modelTier?: 'basic' | 'advanced';
  stepMode?: boolean;
  stageModels?: { brief?: string; plan?: string; cite?: string };
  background?: string;
  excludeGreatestHits?: boolean;
  narrativeVoicing?: boolean;
  /** Per-seat POV tag (t/3958; spec §4). Absent ⇒ every seat untagged — never `{}` (t/3975
   *  derives "any seat tagged" from key presence; an empty object would read as tagged). */
  seatTags?: Partial<Record<SpeakerId, SeatTag>>;
};

/** t/3958: kept out of buildDebateOptions so it doesn't push that function's complexity
 *  over the ESLint complexity-budget threshold (t/3821). Absent ⇒ every seat untagged. */
function normalizeSeatTags(seatTags?: Partial<Record<SpeakerId, SeatTag>>): Partial<Record<SpeakerId, SeatTag>> | undefined {
  return seatTags && Object.keys(seatTags).length > 0 ? seatTags : undefined;
}

/** Map the setup form's raw field values into the createDebate options object. Pure. */
export function buildDebateOptions(p: {
  debateTitle: string;
  background: string;
  evaluatorModel: string;
  confrontationRounds: number;
  argumentationRounds: number;
  concludingRounds: number;
  stepMode: boolean;
  excludeGreatestHits: boolean;
  narrativeVoicing: boolean;
  stageModels: { brief: string; plan: string; cite: string };
  seatTags?: Partial<Record<SpeakerId, SeatTag>>;
}): CreateDebateOptions {
  return {
    title: p.debateTitle || undefined,
    background: p.background.trim() || undefined,
    evaluatorModel: p.evaluatorModel || undefined,
    useAdaptiveStaging: true,
    phaseBoundsOverride: {
      maxConfrontationRounds: p.confrontationRounds,
      maxArgumentationRounds: p.argumentationRounds,
      maxConcludingRounds: p.concludingRounds,
    },
    // t/4773: the New Debate dialog no longer offers multi-provider runs, so it never sets
    // speakerModels / eligibleBackends / modelTier. CreateDebateOptions keeps those fields
    // because sessionSlice still reads them when replaying older multi-provider debates.
    stepMode: p.stepMode || undefined,
    excludeGreatestHits: p.excludeGreatestHits || undefined,
    narrativeVoicing: p.narrativeVoicing || undefined,
    stageModels: (p.stageModels.brief || p.stageModels.plan || p.stageModels.cite)
      ? { ...(p.stageModels.brief && { brief: p.stageModels.brief }), ...(p.stageModels.plan && { plan: p.stageModels.plan }), ...(p.stageModels.cite && { cite: p.stageModels.cite }) }
      : undefined,
    seatTags: normalizeSeatTags(p.seatTags),
  };
}
