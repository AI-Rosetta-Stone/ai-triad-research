// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Calibration metric-block computations (ADR-007 file-size split, t/1686).
 *
 * Pure helper functions extracted from `extractCalibrationData` so extract.ts
 * stays under the ADR-007 budget. Each helper is a pure function of its explicit
 * inputs — it reads exactly the session/argument-network state it needs and
 * returns exactly the metric values it contributes, with no shared closure
 * state. Behavior (computation, order of operations, null handling, rounding)
 * is byte-for-byte identical to the pre-split inline blocks.
 */

import { getDebatePhase } from '../types.js';
import type { DebateSession, ArgumentNetworkNode, TrackedCrux } from '../types.js';
import type { CalibrationDataPoint } from './schema.js';
import type { NeutralEvaluation } from '../neutralEvaluator.js';
import { meanSentenceLength, lexicalDiversity, jargonDensity } from '../clarityMetrics.js';
import { computeAffectIntensity, computeAffectProfile, computeAffectAppropriateness, AFFECT_CATEGORIES } from '../affectSignals.js';
import type { AffectProfile } from '../affectSignals.js';
import { computeCampInsularityRate } from '../schemeStagnation.js';
import type { ConflictFile } from '../taxonomyLoader.js';
import type { ConvergenceSignals } from '../types/convergence.js';
import { extractCrossAgentOppositions } from '../aif/caExtraction.js';
import type { AifB5Metrics } from './schema.js';

type ArgNetwork = DebateSession['argument_network'];

/**
 * Utilization rates from context injection manifests.
 * Manifest stores povNodeIds (injected) and povPrimaryIds (primary).
 * Cross-reference with entry's taxonomy_refs to compute what was actually referenced.
 */
export function computeUtilizationRates(
  session: DebateSession,
): { totalUtil: number; totalPrimaryUtil: number; utilCount: number } {
  let totalUtil = 0, totalPrimaryUtil = 0, utilCount = 0;
  for (const entry of session.transcript) {
    if (entry.type !== 'opening' && entry.type !== 'statement') continue;
    const manifest = (entry.metadata as Record<string, unknown>)?.injection_manifest as {
      // New format (actual session structure)
      povNodeIds?: string[];
      povPrimaryIds?: string[];
      // Legacy format (pre-existing code)
      injected_count?: number;
      referenced_count?: number;
      primary_injected?: number;
      primary_referenced?: number;
    } | undefined;
    if (!manifest) continue;

    const referencedIds = new Set((entry.taxonomy_refs ?? []).map((r: { node_id: string }) => r.node_id));

    if (manifest.povNodeIds && manifest.povNodeIds.length > 0) {
      // New format: count array intersection
      const injected = manifest.povNodeIds.length;
      const referenced = manifest.povNodeIds.filter((id: string) => referencedIds.has(id)).length;
      totalUtil += referenced / injected;

      if (manifest.povPrimaryIds && manifest.povPrimaryIds.length > 0) {
        const primaryInjected = manifest.povPrimaryIds.length;
        const primaryReferenced = manifest.povPrimaryIds.filter((id: string) => referencedIds.has(id)).length;
        totalPrimaryUtil += primaryReferenced / primaryInjected;
      }
      utilCount++;
    } else if (manifest.injected_count && manifest.injected_count > 0) {
      // Legacy format
      totalUtil += (manifest.referenced_count ?? 0) / manifest.injected_count;
      if (manifest.primary_injected && manifest.primary_injected > 0) {
        totalPrimaryUtil += (manifest.primary_referenced ?? 0) / manifest.primary_injected;
      }
      utilCount++;
    }
  }
  return { totalUtil, totalPrimaryUtil, utilCount };
}

/** Validation error/warning rates — structural error and repetition counts over speaker turns. */
export function computeValidationRates(
  session: DebateSession,
): { totalTurns: number; structuralErrors: number; repetitionWarnings: number } {
  const validations = session.turn_validations ?? {};
  const validationEntries = Object.values(validations) as { final?: { issues?: string[] } }[];
  const totalTurns = session.transcript.filter((e: { type: string }) =>
    e.type === 'opening' || e.type === 'statement',
  ).length;
  let structuralErrors = 0, repetitionWarnings = 0;
  for (const v of validationEntries) {
    const issues = (v as any)?.final?.issues ?? (v as any)?.attempts?.flatMap((a: any) => a.issues ?? []) ?? [];
    for (const issue of issues) {
      const text = typeof issue === 'string' ? issue : (issue as any)?.message ?? '';
      if (/unknown move|schema|missing|move_types/i.test(text)) structuralErrors++;
      if (/repeat|repetition|same moves/i.test(text)) repetitionWarnings++;
    }
  }
  return { totalTurns, structuralErrors, repetitionWarnings };
}

/**
 * AN-structural metrics (Parameters 11-14): taxonomy mapping ratio, near-miss
 * duplicate count, borderline FIRE claim survival, and average branch cohesion.
 * All derived from the argument network + transcript taxonomy refs.
 */
export function computeAnStructuralMetrics(
  session: DebateSession,
  an: ArgNetwork,
): {
  taxonomyMappedRatio: number | null;
  nearMissDups: number | null;
  borderlineSurvival: number | null;
  avgBranchCohesion: number | null;
} {
  // ── Parameter 11: Cluster quality — taxonomy mapping ratio ──
  // What fraction of AN nodes have taxonomy_refs (mapped to existing taxonomy nodes)?
  let taxonomyMappedRatio: number | null = null;
  if (an && an.nodes.length > 0) {
    const allRefIds = new Set<string>();
    for (const entry of session.transcript) {
      for (const ref of entry.taxonomy_refs ?? []) allRefIds.add(ref.node_id);
    }
    // Nodes whose speaker references match taxonomy = mapped
    const mapped = an.nodes.filter((n: ArgumentNetworkNode) => {
      const entryRefs = session.transcript
        .filter((e: { id: string }) => e.id === n.source_entry_id)
        .flatMap((e: { taxonomy_refs?: { node_id: string }[] }) => e.taxonomy_refs ?? []);
      return entryRefs.length > 0;
    }).length;
    taxonomyMappedRatio = mapped / an.nodes.length;
  }

  // ── Parameter 12: Near-miss duplicates ──
  // Count AN node pairs with high text similarity that weren't merged
  let nearMissDups: number | null = null;
  if (an && an.nodes.length >= 2 && an.nodes.length <= 100) {
    let count = 0;
    for (let i = 0; i < an.nodes.length; i++) {
      for (let j = i + 1; j < an.nodes.length; j++) {
        const a = an.nodes[i].text.toLowerCase().split(/\s+/);
        const b = an.nodes[j].text.toLowerCase().split(/\s+/);
        const shared = a.filter((w: string) => b.includes(w)).length;
        const overlap = shared / Math.max(a.length, b.length);
        if (overlap >= 0.7 && overlap < 0.85) count++; // Near-miss range
      }
    }
    nearMissDups = count;
  }

  // ── Parameter 13: Borderline FIRE claim survival ──
  // Claims with extraction_confidence near the acceptance threshold — did they survive debate?
  let borderlineSurvival: number | null = null;
  if (an && an.nodes.length > 0) {
    const borderline = an.nodes.filter((n: ArgumentNetworkNode) =>
      n.extraction_confidence != null &&
      n.extraction_confidence >= 0.5 && n.extraction_confidence <= 0.7,
    );
    if (borderline.length >= 2) {
      const refuted = borderline.filter((n: ArgumentNetworkNode) =>
        (n.computed_strength ?? n.base_strength ?? 0.5) < 0.25,
      ).length;
      borderlineSurvival = 1 - refuted / borderline.length;
    }
  }

  // ── Parameter 14: Branch cohesion — avg base_strength of taxonomy-grounded nodes ──
  let avgBranchCohesion: number | null = null;
  if (an && an.nodes.length > 0) {
    const grounded = an.nodes.filter((n: ArgumentNetworkNode) => n.base_strength != null);
    if (grounded.length >= 3) {
      avgBranchCohesion = grounded.reduce((s: number, n: ArgumentNetworkNode) => s + (n.base_strength ?? 0.5), 0) / grounded.length;
    }
  }

  return { taxonomyMappedRatio, nearMissDups, borderlineSurvival, avgBranchCohesion };
}

/**
 * QBAF concordance with synthesis preferences.
 * Synthesis preferences use internal claim IDs (C1, C2...) not AN IDs (AN-1, AN-2...).
 * The argument_map maps C-IDs to claim text. We match claim text to AN nodes by word overlap.
 */
export function computeQbafConcordance(session: DebateSession, an: ArgNetwork): number | null {
  let concordance: number | null = null;
  const synthEntry = session.transcript.find((e: { type: string }) => e.type === 'concluding');
  const synthMeta = (synthEntry?.metadata as Record<string, unknown>)?.synthesis as {
    preferences?: { prevails?: string; claim_ids?: string[]; conflict?: string }[];
    argument_map?: { claim_id?: string; claim?: string; claimant?: string }[];
  } | undefined;
  if (synthMeta?.preferences && synthMeta.argument_map && an && an.nodes.length > 0) {
    // Build C-ID → claim text lookup from argument_map (which is an array)
    const argMapEntries = Array.isArray(synthMeta.argument_map) ? synthMeta.argument_map : [];
    const claimTextById = new Map<string, string>();
    for (const entry of argMapEntries) {
      if (entry.claim_id && entry.claim) claimTextById.set(entry.claim_id, entry.claim);
    }

    // For each preference with 2+ claim_ids, find the best AN node match for each claim
    let matches = 0, total = 0;
    for (const pref of synthMeta.preferences) {
      if (!pref.claim_ids || pref.claim_ids.length < 2 || pref.prevails === 'undecidable') continue;
      // Find AN nodes matching each claim by text word overlap
      const claimStrengths: number[] = [];
      for (const cid of pref.claim_ids) {
        const claimText = claimTextById.get(cid);
        if (!claimText) continue;
        const claimWords = new Set(claimText.toLowerCase().split(/\s+/).filter(w => w.length > 3));
        let bestScore = 0, bestStrength = 0.5;
        for (const node of an.nodes) {
          const nodeWords = node.text.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
          const overlap = nodeWords.filter((w: string) => claimWords.has(w)).length / Math.max(claimWords.size, 1);
          if (overlap > bestScore) {
            bestScore = overlap;
            bestStrength = node.computed_strength ?? node.base_strength ?? 0.5;
          }
        }
        if (bestScore > 0.2) claimStrengths.push(bestStrength); // Only count if reasonable text match
      }
      if (claimStrengths.length >= 2) {
        total++;
        // Does the QBAF strength ordering match the preference verdict?
        const maxStr = Math.max(...claimStrengths);
        const prevailsIdx = pref.prevails ? pref.claim_ids.indexOf(pref.prevails) : -1;
        if (prevailsIdx >= 0 && prevailsIdx < claimStrengths.length && claimStrengths[prevailsIdx] === maxStr) matches++;
      }
    }
    concordance = total > 0 ? matches / total : null;
  }
  return concordance;
}

/**
 * Situation effectiveness — injected/referenced counts + crux alignment.
 * How many injected situation nodes align with the debate's actual cruxes?
 */
export function computeSituationAlignment(
  session: DebateSession,
  finalEval: NeutralEvaluation | undefined,
): { sitNodesInjected: number; sitNodesReferenced: number; sitCruxAlignment: number | null } {
  // Pass 1: collect all injected situation node IDs
  const injectedSitIds = new Set<string>();
  for (const entry of session.transcript) {
    const manifest = (entry.metadata as Record<string, unknown>)?.injection_manifest as {
      situationNodeIds?: string[];
    } | undefined;
    if (manifest?.situationNodeIds) {
      for (const id of manifest.situationNodeIds) injectedSitIds.add(id);
    }
  }
  // Pass 2: count distinct injected sit IDs referenced across the transcript
  const referencedInjected = new Set<string>();
  for (const entry of session.transcript) {
    for (const ref of entry.taxonomy_refs ?? []) {
      if (typeof ref.node_id === 'string' && injectedSitIds.has(ref.node_id)) {
        referencedInjected.add(ref.node_id);
      }
    }
  }
  const sitNodesInjected = injectedSitIds.size;
  const sitNodesReferenced = referencedInjected.size;

  // Situation-crux alignment: do the neutral evaluator's cruxes match injected situation nodes?
  // Uses word overlap between crux descriptions and situation node labels/descriptions.
  let sitCruxAlignment: number | null = null;
  if (finalEval && finalEval.cruxes.length > 0 && injectedSitIds.size > 0) {
    // We don't have situation node text here, but we can check if crux descriptions
    // mention situation-related terms by matching against taxonomy_refs that are sit- IDs.
    // Better approach: check if sit- refs appear in entries that address each crux's topic.
    // Simplest viable: for each crux, check if any sit- ID was referenced in the same
    // round(s) where that crux's speakers are active.
    const cruxSpeakers = finalEval.cruxes.map((c: { speakers_involved: string[] }) =>
      new Set(c.speakers_involved.map((s: string) => s.toLowerCase())),
    );

    // Map speaker labels (A/B/C) back to POV names via neutral_speaker_mapping
    const reverseMap = (session as any).neutral_speaker_mapping?.reverse as Record<string, string> | undefined;

    let alignedCruxes = 0;
    for (const crux of finalEval.cruxes) {
      // Get the POV names for speakers involved in this crux
      const cruxPovs = new Set<string>();
      for (const s of crux.speakers_involved) {
        const label = `Speaker ${s}`;
        const poverId = reverseMap?.[label];
        if (poverId) cruxPovs.add(poverId);
      }

      // Check if any entry by these speakers referenced a sit- node
      let hasSitRef = false;
      for (const entry of session.transcript) {
        if (entry.type !== 'statement' && entry.type !== 'opening') continue;
        if (!cruxPovs.has(entry.speaker)) continue;
        const sitRef = (entry.taxonomy_refs ?? []).some(
          (r: { node_id: string }) => r.node_id.startsWith('sit-') && injectedSitIds.has(r.node_id),
        );
        if (sitRef) { hasSitRef = true; break; }
      }
      if (hasSitRef) alignedCruxes++;
    }
    sitCruxAlignment = alignedCruxes / finalEval.cruxes.length;
  }

  return { sitNodesInjected, sitNodesReferenced, sitCruxAlignment };
}

/**
 * Topic coherence per speaker: mean embedding similarity of each speaker's claims
 * to the crux centroid (1.0 = perfectly on-topic).
 */
export function computeTopicCoherence(session: DebateSession, an: ArgNetwork): Record<string, number> | null {
  let topicCoherencePerSpeaker: Record<string, number> | null = null;
  if (an && an.nodes.length > 0) {
    const cruxes = (session as any).crux_tracker as TrackedCrux[] | undefined;
    if (cruxes && cruxes.length > 0) {
      const cruxEmbeddings = cruxes
        .map(c => an.nodes.find((n: ArgumentNetworkNode) => n.id === c.id)?.embedding)
        .filter((e): e is number[] => !!e);
      if (cruxEmbeddings.length > 0) {
        const dim = cruxEmbeddings[0].length;
        const centroid = new Array(dim).fill(0) as number[];
        for (const emb of cruxEmbeddings) {
          for (let i = 0; i < dim; i++) centroid[i] += emb[i];
        }
        for (let i = 0; i < dim; i++) centroid[i] /= cruxEmbeddings.length;

        topicCoherencePerSpeaker = {};
        const speakers = [...new Set(an.nodes.map((n: ArgumentNetworkNode) => n.speaker).filter(s => s !== 'system' && s !== 'document'))];
        for (const sp of speakers) {
          const spNodes = an.nodes.filter((n: ArgumentNetworkNode) => n.speaker === sp && n.embedding);
          if (spNodes.length === 0) continue;
          let simSum = 0;
          for (const n of spNodes) {
            let dot = 0, normA = 0, normB = 0;
            for (let i = 0; i < dim; i++) {
              dot += n.embedding![i] * centroid[i];
              normA += n.embedding![i] * n.embedding![i];
              normB += centroid[i] * centroid[i];
            }
            const denom = Math.sqrt(normA) * Math.sqrt(normB);
            simSum += denom > 0 ? dot / denom : 0;
          }
          topicCoherencePerSpeaker[sp] = simSum / spNodes.length;
        }
      }
    }
  }
  return topicCoherencePerSpeaker;
}

/** Clarity metrics (Wachsmuth: Clarity, t/1120) — mean sentence length, lexical diversity, jargon density. */
export function computeClarityMetrics(
  session: DebateSession,
  an: ArgNetwork,
): { clarityMSL: number | null; clarityLD: number | null; clarityJD: number | null } {
  const speakerTexts = (session.transcript ?? [])
    .filter(e => (e.type === 'opening' || e.type === 'statement') && e.content)
    .map(e => e.content);
  const clarityMSL = speakerTexts.length > 0
    ? speakerTexts.reduce((sum, t) => sum + meanSentenceLength(t), 0) / speakerTexts.length
    : null;
  const clarityLD = speakerTexts.length > 0
    ? speakerTexts.reduce((sum, t) => sum + lexicalDiversity(t), 0) / speakerTexts.length
    : null;
  const domainTerms = new Set<string>();
  for (const entry of an?.nodes ?? []) {
    for (const w of entry.text.toLowerCase().match(/[a-z'-]+/g) ?? []) {
      if (w.length >= 6) domainTerms.add(w);
    }
  }
  const clarityJD = speakerTexts.length > 0 && domainTerms.size > 0
    ? speakerTexts.reduce((sum, t) => sum + jargonDensity(t, domainTerms), 0) / speakerTexts.length
    : null;
  return { clarityMSL, clarityLD, clarityJD };
}

/** Affect signals (Wachsmuth: Emotional Appeal, t/1121) — intensity mean/variance and appropriateness. */
export function computeAffectSignals(
  session: DebateSession,
  rounds: number,
): { affectIntensityMean: number | null; affectIntensityVariance: number | null; affectAppropMean: number | null } {
  const affectIntensities: number[] = [];
  const affectAppropScores: number[] = [];
  for (const entry of session.transcript ?? []) {
    if (entry.type !== 'opening' && entry.type !== 'statement') continue;
    if (entry.speaker === 'system' || entry.speaker === 'moderator') continue;
    if (!entry.content) continue;
    const intensity = computeAffectIntensity(entry.content);
    if (intensity != null) affectIntensities.push(intensity);
    const profile = computeAffectProfile(entry.content);
    if (profile) {
      const entryRound = (entry.metadata as Record<string, unknown>)?.round as number ?? 1;
      const phase = getDebatePhase(entryRound, rounds);
      const approp = computeAffectAppropriateness(profile, phase);
      if (approp != null) affectAppropScores.push(approp);
      if (phase === 'concluding' && approp != null && approp < 0.40 && profile.outrage > 0.50) {
        console.warn(`[calibration] concluding-phase turn has low affect_appropriateness (${approp.toFixed(3)}) with high outrage (${profile.outrage.toFixed(3)}) — debate ${session.id}`);
      }
    }
  }
  const affectIntensityMean = affectIntensities.length > 0
    ? affectIntensities.reduce((a, b) => a + b, 0) / affectIntensities.length
    : null;
  const affectIntensityVariance = affectIntensities.length > 0
    ? affectIntensities.reduce((sum, v) => sum + (v - affectIntensityMean!) ** 2, 0) / affectIntensities.length
    : null;
  const affectAppropMean = affectAppropScores.length > 0
    ? affectAppropScores.reduce((a, b) => a + b, 0) / affectAppropScores.length
    : null;
  return { affectIntensityMean, affectIntensityVariance, affectAppropMean };
}

/** Per-phase share-normalized affect profile aggregate (t/2676). Re-fit input for AFFECT_PHASE_BASELINES. */
export function computeAffectProfileByPhase(
  session: DebateSession,
  rounds: number,
): Partial<Record<'confrontation' | 'argumentation' | 'concluding', { profile_mean: AffectProfile; n_turns: number }>> | undefined {
  type PhaseKey = 'confrontation' | 'argumentation' | 'concluding';
  const PHASE_KEYS: PhaseKey[] = ['confrontation', 'argumentation', 'concluding'];
  const zero = (): AffectProfile => ({ urgency: 0, fear: 0, hope: 0, outrage: 0, empathy: 0 });
  const sums: Record<PhaseKey, AffectProfile> = { confrontation: zero(), argumentation: zero(), concluding: zero() };
  const counts: Record<PhaseKey, number> = { confrontation: 0, argumentation: 0, concluding: 0 };
  for (const entry of session.transcript ?? []) {
    if (entry.type !== 'opening' && entry.type !== 'statement') continue;
    if (entry.speaker === 'system' || entry.speaker === 'moderator') continue;
    if (!entry.content) continue;
    const profile = computeAffectProfile(entry.content);
    if (!profile) continue;
    const total = AFFECT_CATEGORIES.reduce((s, c) => s + profile[c], 0);
    if (total <= 0) continue; // mirror computeAffectAppropriateness: skip zero-affect turns
    const entryRound = (entry.metadata as Record<string, unknown>)?.round as number ?? 1;
    const phase = getDebatePhase(entryRound, rounds);
    if (phase === 'terminated' || !(phase in sums)) continue;
    const ph = phase as PhaseKey;
    for (const cat of AFFECT_CATEGORIES) sums[ph][cat] += profile[cat] / total;
    counts[ph]++;
  }
  const result: Partial<Record<PhaseKey, { profile_mean: AffectProfile; n_turns: number }>> = {};
  for (const ph of PHASE_KEYS) {
    const n = counts[ph];
    if (n === 0) continue;
    const profile_mean = {} as AffectProfile;
    for (const cat of AFFECT_CATEGORIES) {
      profile_mean[cat] = Math.round((sums[ph][cat] / n) * 10000) / 10000;
    }
    result[ph] = { profile_mean, n_turns: n };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Camp insularity (BEA: Reflective User Engagement, t/1117) — mean and max same-camp citation rate. */
export function computeCampInsularity(
  session: DebateSession,
  speakers: Set<string>,
): { campInsularityRate: number | null; campInsularityMax: number | null } {
  const speakerInsularityRates: number[] = [];
  for (const speaker of speakers) {
    if (speaker === 'system' || speaker === 'moderator' || speaker === 'user') continue;
    const nodeIds = (session.transcript ?? [])
      .filter((e: { type: string; speaker: string }) =>
        (e.type === 'opening' || e.type === 'statement') && e.speaker === speaker)
      .flatMap((e: { taxonomy_refs?: { node_id: string }[] }) =>
        (e.taxonomy_refs ?? []).map(r => r.node_id));
    if (nodeIds.length > 0) {
      const rate = computeCampInsularityRate(nodeIds, speaker);
      if (rate != null) speakerInsularityRates.push(rate);
    }
  }
  const campInsularityRate = speakerInsularityRates.length > 0
    ? speakerInsularityRates.reduce((a, b) => a + b, 0) / speakerInsularityRates.length
    : null;
  const campInsularityMax = speakerInsularityRates.length > 0
    ? Math.max(...speakerInsularityRates)
    : null;
  return { campInsularityRate, campInsularityMax };
}

/**
 * Peer referencing rate (Marandi: peer-referencing ↔ diversity, t/1279).
 * Fraction of speaker turns with ≥1 cross-POV dialectical edge in the AN.
 */
export function computePeerReferencing(
  session: DebateSession,
  speakers: Set<string>,
): { peerRefPerSpeaker: Record<string, number>; peerRefValues: number[]; peerReferencingRate: number | null } {
  const anNodes = session.argument_network?.nodes ?? [];
  const anEdges = session.argument_network?.edges ?? [];
  const nodeSpeaker = new Map<string, string>();
  for (const n of anNodes) {
    if (typeof n.speaker === 'string') nodeSpeaker.set(n.id, n.speaker);
  }
  // Collect source_entry_ids of turns that have cross-POV engagement
  const engagedEntryIds = new Set<string>();
  for (const edge of anEdges) {
    if (edge.type === 'revoice_of') continue;
    const srcSpeaker = nodeSpeaker.get(edge.source);
    const tgtSpeaker = nodeSpeaker.get(edge.target);
    if (srcSpeaker && tgtSpeaker && srcSpeaker !== tgtSpeaker) {
      const srcNode = anNodes.find(n => n.id === edge.source);
      if (srcNode?.source_entry_id) engagedEntryIds.add(srcNode.source_entry_id);
    }
  }
  // Per-speaker: engaged turns / total turns
  const peerRefPerSpeaker: Record<string, number> = {};
  const debaterSpeakers = [...speakers].filter(s => s !== 'system' && s !== 'moderator' && s !== 'user');
  for (const speaker of debaterSpeakers) {
    const speakerEntries = (session.transcript ?? [])
      .filter((e: { type: string; speaker: string; id?: string }) =>
        (e.type === 'opening' || e.type === 'statement') && e.speaker === speaker);
    const totalTurnsSpeaker = speakerEntries.length;
    if (totalTurnsSpeaker === 0) continue;
    const engagedTurns = speakerEntries.filter((e: { id?: string }) =>
      e.id != null && engagedEntryIds.has(e.id)).length;
    peerRefPerSpeaker[speaker] = engagedTurns / totalTurnsSpeaker;
  }
  const peerRefValues = Object.values(peerRefPerSpeaker);
  const peerReferencingRate = anNodes.length > 0 && peerRefValues.length > 0
    ? peerRefValues.reduce((a, b) => a + b, 0) / peerRefValues.length
    : null;
  return { peerRefPerSpeaker, peerRefValues, peerReferencingRate };
}

/**
 * Local sufficiency (Wachsmuth: Local Sufficiency, t/1341).
 * Mean per-claim sufficiency over eligible claims, bare-assertion rate, and
 * per-speaker means. Excludes final-round claims (maturity window).
 */
export function computeLocalSufficiency(
  session: DebateSession,
  an: ArgNetwork,
  anEdges: NonNullable<ArgNetwork>['edges'],
): {
  localSufficiencyMean: number | null;
  unsupportedClaimRate: number | null;
  localSufficiencyBySpeaker: Record<string, number> | null;
} {
  let localSufficiencyMean: number | null = null;
  let unsupportedClaimRate: number | null = null;
  let localSufficiencyBySpeaker: Record<string, number> | null = null;
  if (an && an.nodes.length > 0) {
    const entryRoundMap = new Map<string, number>();
    let maxRound = 0;
    for (const entry of session.transcript ?? []) {
      const round = (entry.metadata as Record<string, unknown>)?.round as number ?? 0;
      if (entry.id) entryRoundMap.set(entry.id, round);
      if (round > maxRound) maxRound = round;
    }

    // Weight-derived fallback since 2026-07-09 (t/1434); pre-change values used constant 0.7.
    const WEIGHT_TO_STRENGTH: Record<number, 'decisive' | 'substantial' | 'tangential'> = {
      1.0: 'decisive', 0.7: 'substantial', 0.3: 'tangential',
    };
    const strengthMult = (s?: 'decisive' | 'substantial' | 'tangential', w?: number): number => {
      const category = s ?? (w !== undefined ? WEIGHT_TO_STRENGTH[w] : undefined);
      if (category === 'decisive') return 1.0;
      if (category === 'substantial') return 0.7;
      if (category === 'tangential') return 0.3;
      return 0.7;
    };

    const eligibleClaims = an.nodes.filter(n => {
      if (n.speaker === 'system' || n.speaker === 'document') return false;
      if (maxRound > 1) {
        const round = entryRoundMap.get(n.source_entry_id) ?? 0;
        if (round >= maxRound) return false;
      }
      return true;
    });

    if (eligibleClaims.length > 0) {
      const incomingSupports = new Map<string, typeof anEdges>();
      for (const edge of anEdges) {
        if (edge.type !== 'supports') continue;
        const existing = incomingSupports.get(edge.target) ?? [];
        existing.push(edge);
        incomingSupports.set(edge.target, existing);
      }

      const perSpeakerScores: Record<string, number[]> = {};
      let unsupportedCount = 0;
      const scores: number[] = [];

      for (const claim of eligibleClaims) {
        const supports = incomingSupports.get(claim.id) ?? [];
        if (supports.length === 0) {
          unsupportedCount++;
          scores.push(0);
          (perSpeakerScores[claim.speaker] ??= []).push(0);
          continue;
        }
        const weightedSupport = supports.reduce((sum, e) => {
          const w = e.weight ?? 0.5;
          const sm = strengthMult(e.strength, e.weight);
          const warrantBonus = e.warrant?.trim() ? 1.25 : 1.0;
          return sum + w * sm * warrantBonus;
        }, 0);
        const s = Math.min(1, weightedSupport / 1.0);
        scores.push(s);
        (perSpeakerScores[claim.speaker] ??= []).push(s);
      }

      localSufficiencyMean = scores.reduce((a, b) => a + b, 0) / scores.length;
      unsupportedClaimRate = unsupportedCount / eligibleClaims.length;
      const bySpeaker: Record<string, number> = {};
      for (const [speaker, vals] of Object.entries(perSpeakerScores)) {
        bySpeaker[speaker] = vals.reduce((a, b) => a + b, 0) / vals.length;
      }
      if (Object.keys(bySpeaker).length > 0) localSufficiencyBySpeaker = bySpeaker;
    }
  }
  return { localSufficiencyMean, unsupportedClaimRate, localSufficiencyBySpeaker };
}

// ── Semantic crux matching (Parameter 8, t/1853) ─────────────────────────────

/**
 * Minimum cosine similarity for an engine crux and an evaluator crux to count as
 * descriptions of the SAME crux. Provenance: STIPULATED at introduction (t/1853;
 * register row in research/comp-linguist/docs/metric-provenance-register.md).
 * Matched-divergence readings are not trusted until the threshold is validated
 * against a hand-matched golden set of engine↔evaluator crux pairs (t/1853 AC).
 */
export const CRUX_MATCH_SIMILARITY_THRESHOLD = 0.5;

/** Frame co-presence gate: sim(frame, paragraph) ≥ threshold → frame is present in that turn (t/2045). */
export const FRAME_PRESENCE_THRESHOLD = 0.50;
/** Frame ↔ opening-claim-sketch link gate: cosine ≥ threshold → node is frame-linked for REFRAME counting (t/2045). */
export const FRAME_LINK_THRESHOLD = 0.60;

/** Coverage/match accounting for the semantic crux comparison — see schema.ts `crux_match_stats`. */
export interface CruxMatchStats {
  engine_total: number;
  evaluator_total: number;
  engine_embeddable: number;
  evaluator_embeddable: number;
  matched: number;
  engine_unmatched: number;
  evaluator_unmatched: number;
  mean_match_similarity: number | null;
  match_threshold: number;
}

export function cosineSim(a: number[], b: number[]): number | null {
  // Different dims = different embedding spaces (e.g. MiniLM 384 vs Gemini 768) —
  // cosine across spaces is meaningless, so the pair is simply not comparable.
  if (a.length !== b.length || a.length === 0) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : null;
}

/**
 * Parameter 8 (redefined, t/1846 §E + t/1853): symmetric engine↔evaluator crux
 * disagreement diagnostic over SEMANTICALLY MATCHED crux pairs.
 *
 * Replaces the original positional walk, which confounded status disagreement with
 * list-order disagreement (a mere permutation of identical cruxes read as divergence
 * — t/1846 §E defect 2). Matching: greedy 1:1 by descending cosine similarity between
 * the engine crux's AN-node embedding and the evaluator crux's description embedding,
 * gated by CRUX_MATCH_SIMILARITY_THRESHOLD. Unmatched cruxes on either side are
 * reported separately in the stats — coverage asymmetry is itself a signal, not noise.
 *
 * Returns nulls when either side has no embedding-bearing cruxes (legacy sessions,
 * no embedding backend): "instrument absent" is never conflated with non-coverage.
 * The rate stays a DIAGNOSTIC — permanently excluded from config-writing objectives
 * (CRUX_AXIS_PARAMS, t/1846); neither side is privileged as ground truth.
 */
export function computeCruxSemanticDivergence(
  engineCruxes: { id?: string; state?: string; status?: string; description?: string }[],
  evalCruxes: { status: string; embedding?: number[] }[],
  an: ArgNetwork,
): { cruxDivergenceRate: number | null; cruxMatchStats: CruxMatchStats | null } {
  // Engine crux embeddings live on the AN node with the same id (as in computeTopicCoherence).
  const engineSide = engineCruxes
    .map((c) => {
      const vec = c.id ? an?.nodes.find((n: ArgumentNetworkNode) => n.id === c.id)?.embedding : undefined;
      const st = c.state ?? c.status;
      return vec ? { resolved: st === 'resolved' || st === 'addressed', vec } : null;
    })
    .filter((e): e is { resolved: boolean; vec: number[] } => e !== null);
  const evalSide = evalCruxes
    .filter((c): c is { status: string; embedding: number[] } => Array.isArray(c.embedding) && c.embedding.length > 0)
    .map((c) => ({ addressed: c.status === 'addressed', vec: c.embedding }));

  if (engineSide.length === 0 || evalSide.length === 0) {
    return { cruxDivergenceRate: null, cruxMatchStats: null };
  }

  // All comparable pairs above threshold, then greedy 1:1 from the most similar down.
  const candidates: { e: number; v: number; sim: number }[] = [];
  for (let e = 0; e < engineSide.length; e++) {
    for (let v = 0; v < evalSide.length; v++) {
      const sim = cosineSim(engineSide[e].vec, evalSide[v].vec);
      if (sim !== null && sim >= CRUX_MATCH_SIMILARITY_THRESHOLD) {
        candidates.push({ e, v, sim });
      }
    }
  }
  candidates.sort((a, b) => b.sim - a.sim);

  const usedEngine = new Set<number>();
  const usedEval = new Set<number>();
  let divergences = 0;
  let simSum = 0;
  for (const { e, v, sim } of candidates) {
    if (usedEngine.has(e) || usedEval.has(v)) continue;
    usedEngine.add(e);
    usedEval.add(v);
    simSum += sim;
    if (engineSide[e].resolved !== evalSide[v].addressed) divergences++;
  }

  const matched = usedEngine.size;
  const cruxMatchStats: CruxMatchStats = {
    engine_total: engineCruxes.length,
    evaluator_total: evalCruxes.length,
    engine_embeddable: engineSide.length,
    evaluator_embeddable: evalSide.length,
    matched,
    engine_unmatched: engineSide.length - matched,
    evaluator_unmatched: evalSide.length - matched,
    mean_match_similarity: matched > 0 ? Math.round((simSum / matched) * 1000) / 1000 : null,
    match_threshold: CRUX_MATCH_SIMILARITY_THRESHOLD,
  };

  return {
    cruxDivergenceRate: matched > 0 ? divergences / matched : null,
    cruxMatchStats,
  };
}

// ── Censoring analysis (t/1671) ──────────────────────────────────────────────

const CENSORED_REASONS: ReadonlySet<string> = new Set([
  'max_iterations', 'situation_cap', 'api_ceiling',
]);

/** Reasons excluded from both convergence pools alongside 'unknown' (t/3502). 'fixed_rounds_completed' (t/580): no convergence logic ran. */
const EXCLUDED_REASONS: ReadonlySet<string> = new Set([
  'unknown', 'first_round_exit', 'fixed_rounds_completed',
]);

/** Result of computing a convergence metric conditioned on termination status (t/1671). */
export interface CensoredConvergenceResult {
  /** n_censored / (n_completed + n_censored) — unknown rows excluded from denominator. */
  censoring_rate: number;
  n_completed: number;
  n_censored: number;
  /** Legacy rows (termination_reason absent or 'unknown') excluded from both pools. */
  n_unknown: number;
  /** Headline: metric mean over natural-conclusion runs only. Null if no completed runs. */
  metric_over_completed: number | null;
  /** Informational: metric mean over completed + censored combined. Null if neither pool has values. */
  metric_over_all: number | null;
}

/**
 * Compute a convergence metric conditioned on termination status (t/1671).
 *
 * Censored  = termination_reason ∈ {max_iterations, situation_cap, api_ceiling}.
 * Completed = termination_reason === 'natural_conclusion'.
 * Excluded  = absent, 'unknown', 'first_round_exit' or 'fixed_rounds_completed' — excluded from both pools; counted in n_unknown.
 *
 * selector may return number | null | boolean. Boolean is coerced (true→1, false→0).
 */
export function computeConvergenceWithCensoring(
  entries: CalibrationDataPoint[],
  selector: (entry: CalibrationDataPoint) => number | null | boolean,
): CensoredConvergenceResult {
  let nCompleted = 0;
  let nCensored = 0;
  let nUnknown = 0;
  const completedValues: number[] = [];
  const allValues: number[] = [];

  for (const entry of entries) {
    const reason = entry.termination_reason;
    if (!reason || EXCLUDED_REASONS.has(reason)) {
      nUnknown++;
      continue;
    }
    const raw = selector(entry);
    const val = typeof raw === 'boolean' ? (raw ? 1 : 0) : raw;
    if (CENSORED_REASONS.has(reason)) {
      nCensored++;
      if (val !== null) allValues.push(val);
    } else {
      nCompleted++;
      if (val !== null) {
        completedValues.push(val);
        allValues.push(val);
      }
    }
  }

  const denominator = nCompleted + nCensored;
  return {
    censoring_rate: denominator > 0 ? nCensored / denominator : 0,
    n_completed: nCompleted,
    n_censored: nCensored,
    n_unknown: nUnknown,
    metric_over_completed: completedValues.length > 0
      ? completedValues.reduce((a, b) => a + b, 0) / completedValues.length
      : null,
    metric_over_all: allValues.length > 0
      ? allValues.reduce((a, b) => a + b, 0) / allValues.length
      : null,
  };
}

// ── Unknown-rate monitor (t/3503) ────────────────────────────────────────────

/** Threshold above which the unknown_rate is considered a logging-coverage gap (t/3503). */
export const UNKNOWN_RATE_WARN_THRESHOLD = 0.20;

/**
 * Compute the fraction of entries (with termination_reason present) that recorded 'unknown'.
 * Used to monitor logging-coverage gaps (t/3503). Optionally restricts to a rolling window.
 *
 * Returns n_with_field=0 / unknown_rate=0 when no qualifying entries exist in the window.
 */
export function computeUnknownRate(
  entries: CalibrationDataPoint[],
  windowDays?: number,
): { unknown_rate: number; n_with_field: number; n_unknown: number } {
  let filtered = entries;
  if (windowDays !== undefined) {
    const cutoffMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    const cutoff = new Date(cutoffMs).toISOString();
    filtered = entries.filter(e => e.timestamp >= cutoff);
  }
  const withField = filtered.filter(e => e.termination_reason !== undefined);
  const nUnknown = withField.filter(e => e.termination_reason === 'unknown').length;
  const rate = withField.length > 0 ? nUnknown / withField.length : 0;
  return { unknown_rate: rate, n_with_field: withField.length, n_unknown: nUnknown };
}

// ── Frame survival metric family (t/2045) ────────────────────────────────────

/**
 * Compute the frame-survival metric family from session diagnostics (t/2045).
 *
 * Construct boundary: measures topical persistence/spread (embedding co-presence) and
 * contest events (structural REFRAME count) ONLY. Makes no claim about reframe *success*.
 * All fields carry zero optimizer weight until human-validated (CRUX_AXIS_PARAMS treatment).
 *
 * Null policy: null (never 0) when framing_choices absent/unparseable for a speaker,
 * speaker has <2 post-opening statement turns, or embeddings unavailable/mismatched.
 */
export function computeFrameSurvivalMetrics(
  session: DebateSession,
  finalEval: NeutralEvaluation | undefined,
  an: ArgNetwork,
): {
  framesDeclaredPerSpeaker: Record<string, number>;
  framePersistencePerSpeaker: Record<string, number | null>;
  frameEngagementPerSpeaker: Record<string, number | null>;
  frameCruxAlignment: number | null;
  frameReframeTargetedCount: number | undefined;
  frameSurvival: number | null;
} {
  const frameEmb = session.frame_embeddings;
  const frameSeries = session.frame_similarity_series;

  // frames_declared_per_speaker
  const framesDeclaredPerSpeaker: Record<string, number> = {};
  if (frameEmb) {
    for (const [sp, data] of Object.entries(frameEmb)) {
      framesDeclaredPerSpeaker[sp] = data.frames.length;
    }
  }

  // T_s and T_¬s are post-opening statement-type entries only (spec §3)
  const statementEntries = (session.transcript ?? []).filter(e => e.type === 'statement');

  const framePersistencePerSpeaker: Record<string, number | null> = {};
  const frameEngagementPerSpeaker: Record<string, number | null> = {};

  if (frameEmb) {
    for (const speaker of Object.keys(frameEmb)) {
      const series = frameSeries?.[speaker];
      if (!series || series.length === 0) {
        framePersistencePerSpeaker[speaker] = null;
        frameEngagementPerSpeaker[speaker] = null;
        continue;
      }

      const ownIds = statementEntries.filter(e => e.speaker === speaker).map(e => e.id);
      const otherIds = statementEntries.filter(e => e.speaker !== speaker).map(e => e.id);

      // Persistence (T_s): null when speaker has <2 post-opening turns.
      // Denominator = measured turns only (entries present in fr.sims); unmeasured turns
      // are excluded so partial embedding failure does not silently depress the metric.
      if (ownIds.length < 2) {
        framePersistencePerSpeaker[speaker] = null;
      } else {
        const perFrame: number[] = [];
        for (const fr of series) {
          const measured = ownIds.filter(id => id in fr.sims);
          if (measured.length < 2) continue; // own-turns: same <2 coarse-denominator rule as speaker level
          const present = measured.filter(id => fr.sims[id] >= FRAME_PRESENCE_THRESHOLD).length;
          perFrame.push(present / measured.length);
        }
        framePersistencePerSpeaker[speaker] = perFrame.length > 0
          ? perFrame.reduce((a, b) => a + b, 0) / perFrame.length
          : null;
      }

      // Engagement (T_¬s): null when no other-speaker statement entries.
      // Same denominator-exclusion rule as persistence.
      if (otherIds.length === 0) {
        frameEngagementPerSpeaker[speaker] = null;
      } else {
        const perFrame: number[] = [];
        for (const fr of series) {
          const measured = otherIds.filter(id => id in fr.sims);
          if (measured.length === 0) continue;
          const present = measured.filter(id => fr.sims[id] >= FRAME_PRESENCE_THRESHOLD).length;
          perFrame.push(present / measured.length);
        }
        frameEngagementPerSpeaker[speaker] = perFrame.length > 0
          ? perFrame.reduce((a, b) => a + b, 0) / perFrame.length
          : null;
      }
    }
  }

  // frame_crux_alignment: fraction of evaluator cruxes aligned with any declared frame
  let frameCruxAlignment: number | null = null;
  if (finalEval && !finalEval.evaluation_invalid && finalEval.cruxes.length > 0 && frameEmb) {
    const allFrameVecs: number[][] = [];
    for (const data of Object.values(frameEmb)) {
      for (const fr of data.frames) allFrameVecs.push(fr.embedding);
    }
    if (allFrameVecs.length > 0) {
      let embeddable = 0;
      let aligned = 0;
      for (const crux of finalEval.cruxes) {
        if (!Array.isArray(crux.embedding) || crux.embedding.length === 0) continue;
        embeddable++;
        const maxSim = allFrameVecs.reduce<number>((best, fv) => {
          const sim = cosineSim(crux.embedding as number[], fv);
          return sim !== null && sim > best ? sim : best;
        }, 0);
        if (maxSim >= FRAME_PRESENCE_THRESHOLD) aligned++;
      }
      if (embeddable > 0) frameCruxAlignment = aligned / embeddable;
    }
  }

  // frame_reframe_targeted_count: REFRAME edges whose target is frame-linked.
  // undefined (absent) when frame_embeddings is absent — legacy/pre-implementation sessions.
  const openingEntryIds = new Set(
    (session.transcript ?? []).filter(e => e.type === 'opening').map(e => e.id),
  );
  let frameReframeTargetedCount: number | undefined;
  if (frameEmb) {
    frameReframeTargetedCount = 0;
    const anEdges = an?.edges ?? [];
    const anNodes = an?.nodes ?? [];
    for (const edge of anEdges) {
      if (edge.scheme !== 'REFRAME') continue;
      const targetNode = anNodes.find(n => n.id === edge.target);
      if (!targetNode) continue;
      if (!openingEntryIds.has(targetNode.source_entry_id)) continue;
      if (!Array.isArray(targetNode.embedding) || targetNode.embedding.length === 0) continue;
      const speakerFrames = frameEmb[targetNode.speaker as string];
      if (!speakerFrames) continue;
      let linked = false;
      for (const fr of speakerFrames.frames) {
        const sim = cosineSim(fr.embedding, targetNode.embedding as number[]);
        if (sim !== null && sim >= FRAME_LINK_THRESHOLD) { linked = true; break; }
      }
      if (linked) frameReframeTargetedCount++;
    }
  }

  // frame_survival: unweighted mean of non-null persistence values
  const persistVals = Object.values(framePersistencePerSpeaker).filter((v): v is number => v !== null);
  const frameSurvival = persistVals.length > 0
    ? persistVals.reduce((a, b) => a + b, 0) / persistVals.length
    : null;

  return {
    framesDeclaredPerSpeaker,
    framePersistencePerSpeaker,
    frameEngagementPerSpeaker,
    frameCruxAlignment,
    frameReframeTargetedCount,
    frameSurvival,
  };
}

// ── AIF B5 metrics (t/3715) ────────────────────────────────────────────────

/** Version string — bump when the metric definition changes (AC5). */
export const AIF_B5_METRIC_DEF_VERSION = 'aif-b5-v1';

/**
 * Compute AIF B5 metrics: crux-from-AIF (spec §1) + 2-signal convergence_score (spec §2).
 * Provisional / shadow only — AC6, gates nothing.
 *
 * crux_count / crux_set: sustained cross-agent CA-nodes (opposition recurring across ≥2 rounds).
 * convergence_score: 0.5 * Signal_A + 0.5 * Signal_B — stipulated equal weighting (no empirical
 * basis; declared stipulated in register per AC5). Null when total_turns = 0 (no valid denominator).
 */
export function computeAifB5Metrics(
  nodes: ArgumentNetworkNode[],
  conflicts: readonly ConflictFile[],
  convergenceSignals: ConvergenceSignals[] | undefined,
): AifB5Metrics {
  // ── crux-from-AIF ──────────────────────────────────────────
  const { oppositions } = extractCrossAgentOppositions(nodes, conflicts);

  // Build nodeId → round (turn_number) lookup.
  const nodeRound = new Map<string, number>(nodes.map(n => [n.id, n.turn_number]));

  // Group oppositions by conflictClaimId; collect distinct rounds from both endpoints.
  const roundsByConflict = new Map<string, Set<number>>();
  for (const opp of oppositions) {
    let rounds = roundsByConflict.get(opp.conflictClaimId);
    if (!rounds) { rounds = new Set(); roundsByConflict.set(opp.conflictClaimId, rounds); }
    const ra = nodeRound.get(opp.attackerNodeId);
    const rt = nodeRound.get(opp.targetNodeId);
    if (ra != null) rounds.add(ra);
    if (rt != null) rounds.add(rt);
  }

  // A CA-node is a crux iff its opposition spans ≥2 distinct rounds (sustained).
  const cruxSet: string[] = [];
  for (const [conflictId, rounds] of roundsByConflict) {
    if (rounds.size >= 2) cruxSet.push(conflictId);
  }

  // ── 2-signal convergence_score ─────────────────────────────
  // Guard: null when no signals (total_turns = 0 → no valid denominator; never NaN).
  const totalTurns = convergenceSignals?.length ?? 0;
  let convergenceScore: number | null = null;
  if (totalTurns > 0) {
    const signals = convergenceSignals!;
    const taken = signals.filter(s => s.concession_opportunity.outcome === 'taken').length;
    const missed = signals.filter(s => s.concession_opportunity.outcome === 'missed').length;
    const signalA = taken / totalTurns;          // concession accumulation (rising)
    const signalB = 1 - missed / totalTurns;     // retained-hold reduction (falling)
    convergenceScore = Math.round((0.5 * signalA + 0.5 * signalB) * 1000) / 1000;
  }

  return {
    metric_def_version: AIF_B5_METRIC_DEF_VERSION,
    crux_count: cruxSet.length,
    crux_set: cruxSet,
    convergence_score: convergenceScore,
  };
}
