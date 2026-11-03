// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Calibration data extraction (ADR-007 file-size split, t/1686).
 *
 * `extractCalibrationData` — the pure function that reads a completed debate
 * session and computes one CalibrationDataPoint (~16 metric blocks). The
 * cohesive per-metric computations live in ./extract-metrics.ts as pure
 * helpers; this module wires them into the returned data point. No side
 * effects, no file I/O — behavior is byte-for-byte unchanged from the split.
 */

import type { DebateSession, ArgumentNetworkNode, SpeakerId, TrackedCrux, EntryDiagnostics, EntailmentRepairEvent } from '../types.js';
import type { NeutralEvaluation } from '../neutralEvaluator.js';
import { classifyClaimOutcomes, summarizeOutcomes } from '../claimOutcomes.js';
import { computeSourceAuthority } from '../sourceAuthority.js';
import type { DocMetaMap } from '../evidenceFromSummaries.js';
import type { ConflictFile } from '../taxonomyLoader.js';
import { PROMPT_VERSION } from '../prompts.js';
import { DEFAULT_ATTACK_WEIGHTS } from '../qbaf.js';
import { POLARITY_RESOLVED_THRESHOLD, SEMANTIC_RECYCLING_THRESHOLD, ATTACK_DEDUP_THRESHOLD } from '../constants.js';
import { weightedSituationScore, MID_DEBATE_WEIGHTS } from '../situationScoring.js';
import { DEFAULT_TEMPERATURE } from '../../ai-client/defaults.js';
import { computeAgentUtility } from '../agentUtility.js';
import type { AgentUtility } from '../agentUtility.js';
import { computeOperationalClosure } from '../operationalClosure.js';
import type { CalibrationDataPoint } from './schema.js';
import {
  computeUtilizationRates,
  computeValidationRates,
  computeAnStructuralMetrics,
  computeQbafConcordance,
  computeSituationAlignment,
  computeTopicCoherence,
  computeClarityMetrics,
  computeAffectSignals,
  computeAffectProfileByPhase,
  computeCampInsularity,
  computePeerReferencing,
  computeLocalSufficiency,
  computeCruxSemanticDivergence,
  computeFrameSurvivalMetrics,
  computeAifB5Metrics,
} from './extract-metrics.js';

// ── Shared types ─────────────────────────────────────────────

/** Closed union of all possible debate termination reasons (t/1671, t/3502, t/3585). */
export type TerminationReason =
  | 'natural_conclusion'
  | 'max_iterations'
  | 'situation_cap'
  | 'api_ceiling'
  | 'first_round_exit'
  | 'unknown';

// ── Extraction logic ────────────────────────────────────────

/**
 * Derive the termination reason from a completed debate session.
 * Pure function — no side effects. Used by extractCalibrationData and
 * runHeadlessDebate (t/3599) so the derivation is not duplicated.
 */
export function deriveTerminationReason(session: DebateSession): TerminationReason {
  const asd = (session as any).adaptive_staging_diagnostics as {
    phases?: { phase: string; rounds: number[]; exit_reason: string; force_active?: boolean }[];
  } | undefined;
  const rounds = session.transcript.filter((e: { type: string }) => e.type === 'statement').length;
  const hitApiCeiling = session.transcript.some((e: { content: string }) =>
    typeof e.content === 'string' && e.content.includes('API hard ceiling hit'),
  );
  const lastAsdPhase = asd?.phases && asd.phases.length > 0 ? asd.phases[asd.phases.length - 1] : undefined;
  if (hitApiCeiling) return 'api_ceiling';
  if (lastAsdPhase !== undefined && lastAsdPhase.force_active !== undefined) {
    return lastAsdPhase.force_active
      // t/4753: was /Max total rounds/i — missed the three per-phase hard-cap exits
      // ("Max thesis turns…", "Max exploration turns…", "Max synthesis turns…",
      // phaseTransitions.ts:692/750/816), which fell through to situation_cap. Every
      // genuine iteration/round-cap exit_reason starts with "Max "; no other
      // force_active reason string does (health collapse, network cap, soft budget,
      // fatigue, stall) — anchored prefix match has no overlap either direction.
      ? (/^Max /i.test(lastAsdPhase.exit_reason) ? 'max_iterations' : 'situation_cap')
      : 'natural_conclusion';
  }
  if (rounds <= 1) return 'first_round_exit';
  return 'unknown';
}

/**
 * Extract calibration data from a completed debate session.
 * Pure function — no side effects, no file I/O.
 */
export function extractCalibrationData(
  session: DebateSession,
  origin: string,
  config: {
    argumentationExitThreshold?: number;
    relevanceThreshold?: number;
    draftTemperature?: number;
    attackWeights?: [number, number, number];
    argumentativeSaturationWeights?: Record<string, number>;
    recentWindow?: number;
    gcTrigger?: number;
    polarityResolvedThreshold?: number;
    maxNodesCap?: number;
    semanticRecyclingThreshold?: number;
    clusterMinSimilarity?: number;
    duplicateSimilarityThreshold?: number;
    fireConfidenceThreshold?: number;
    cohesionClearTheme?: number;
    kpDivisor?: number;
    budgetHardMultiplier?: number;
    situationMaxNodes?: number;
    explorationSummary?: import('../explorationSummary.js').ExplorationSummary;
    docMeta?: DocMetaMap;
    insularityInterventions?: { speaker: string; round: number; injected_node_id: string; target_camp: string }[];
    conflicts?: readonly ConflictFile[];
  } = {},
): CalibrationDataPoint {
  const now = new Date().toISOString();

  // ── Neutral evaluator metrics ──
  // An evaluation marked evaluation_invalid (truncated/salvaged/unparseable response,
  // t/1846) is treated as ABSENT here: every evaluator-derived metric below reads null,
  // never a fake 0-crux / fabricated-engaging value. Display paths still show the raw one.
  const finalEvalRaw = (session.neutral_evaluations ?? [])
    .find((e: NeutralEvaluation) => e.checkpoint === 'final');
  const finalEval = finalEvalRaw && finalEvalRaw.evaluation_invalid !== true
    ? finalEvalRaw
    : undefined;
  const engaging = finalEval?.overall_assessment.debate_is_engaging_real_disagreement ?? null;
  const cruxRatio = finalEval
    ? finalEval.cruxes.length > 0
      ? finalEval.cruxes.filter((c: { status: string }) => c.status === 'addressed').length / finalEval.cruxes.length
      : null
    : null;
  // Observation-class 3-way tally (t/1796). Additive: does NOT alter cruxRatio above.
  // Match the ratio's null-handling — omitted (undefined) whenever cruxRatio is null
  // (no finalEval, or no cruxes to tally), so the two never disagree.
  const cruxStatusCounts = finalEval && finalEval.cruxes.length > 0
    ? finalEval.cruxes.reduce(
        (acc: { addressed: number; partially_addressed: number; unaddressed: number }, c: { status: string }) => {
          if (c.status === 'addressed') acc.addressed++;
          else if (c.status === 'partially_addressed') acc.partially_addressed++;
          else if (c.status === 'unaddressed') acc.unaddressed++;
          return acc;
        },
        { addressed: 0, partially_addressed: 0, unaddressed: 0 },
      )
    : undefined;

  // ── Utilization rates from context injection manifests ──
  const { totalUtil, totalPrimaryUtil, utilCount } = computeUtilizationRates(session);

  // ── Validation error/warning rates ──
  const { totalTurns, structuralErrors, repetitionWarnings } = computeValidationRates(session);

  // ── QBAF concordance with synthesis preferences ──
  const an = session.argument_network;
  const concordance = computeQbafConcordance(session, an);

  // ── Saturation signals at transition ──
  // Read from adaptive_staging_diagnostics.signal_telemetry (the actual session structure)
  const asd = (session as any).adaptive_staging_diagnostics as {
    signal_telemetry?: {
      round: number;
      phase: string;
      composite?: { argumentative_saturation_score?: number; convergence_score?: number };
      signals?: Record<string, number>;
    }[];
    phases?: { phase: string; rounds: number[]; exit_reason: string; force_active?: boolean }[];
  } | undefined;
  let argumentativeSaturationAtTransition: number | null = null;
  let convergenceScoreAtTermination: number | null = null;
  let signalsAtTransition: Record<string, number> | null = null;
  if (asd?.signal_telemetry && asd.signal_telemetry.length > 0) {
    const telemetry = asd.signal_telemetry;
    // Find the last entry before phase changed (closest to transition)
    const last = telemetry[telemetry.length - 1];
    argumentativeSaturationAtTransition = last.composite?.argumentative_saturation_score ?? null;
    convergenceScoreAtTermination = last.composite?.convergence_score ?? null;
    signalsAtTransition = last.signals ?? null;
  }
  // ── Round count ── (still needed by affect signals below; also derived inside deriveTerminationReason)
  const rounds = session.transcript.filter((e: { type: string }) => e.type === 'statement').length;
  // ── Termination reason (t/1671, t/3502) — delegated to shared pure function ──
  const terminationReason = deriveTerminationReason(session);
  // ── API ceiling flag — also needed at line hit_api_ceiling output field ──
  const hitApiCeiling = session.transcript.some((e: { content: string }) =>
    typeof e.content === 'string' && e.content.includes('API hard ceiling hit'),
  );

  // ── Parameter 6: Compression window — claims forgotten rate ──
  const ledger = session.unanswered_claims_ledger ?? [];
  const totalClaims = an?.nodes.length ?? 0;
  const forgottenClaims = ledger.filter((c: { addressed_round?: number }) => !c.addressed_round).length;
  const claimsForgottenRate = totalClaims > 0 ? forgottenClaims / totalClaims : null;

  // ── Parameter 7: GC metrics ──
  const anNodesAtSynthesis = an?.nodes.length ?? 0;
  const gcEvents = (session as any).adaptive_staging_diagnostics?.gc_events;
  const gcRuns = typeof gcEvents === 'number' ? gcEvents : (Array.isArray(gcEvents) ? gcEvents.length : 0);

  // ── Parameter 8: Crux resolution divergence (semantic matching, t/1853) ──
  // crux_tracker on the session is an array of crux entries (not an object with .cruxes).
  // Engine and evaluator cruxes are matched by embedding similarity, never by list
  // position (the positional walk confounded status disagreement with list-order
  // disagreement — t/1846 §E defect 2). Symmetric diagnostic; neither side privileged.
  const rawCruxTracker = (session as any).crux_tracker;
  const engineCruxes = Array.isArray(rawCruxTracker) ? rawCruxTracker as { id?: string; state?: string; status?: string; description?: string }[] : [];
  const { cruxDivergenceRate, cruxMatchStats } = computeCruxSemanticDivergence(
    engineCruxes,
    finalEval?.cruxes ?? [],
    an,
  );

  // ── Crux undecided rate (t/1676) ──
  // Share of tracked cruxes that terminated in the `undecided` verdict — surfaced but never
  // adjudicated (cap reached, or never cross-engaged). Reads the LITERAL `state` set by the
  // debate-end finalization sweep (not re-derived). Provenance: STIPULATED at introduction;
  // promotes to derived only after CL's AC#2 golden-set absorption (t/1669).
  const cruxStatesForUndecided = Array.isArray(rawCruxTracker)
    ? (rawCruxTracker as { state?: string }[])
    : [];
  const cruxUndecidedRate = cruxStatesForUndecided.length > 0
    ? cruxStatesForUndecided.filter(c => c.state === 'undecided').length / cruxStatesForUndecided.length
    : null;

  // ── Counterfactual type distribution (RATIO 2024, t/1115) ──
  const cfTypeDist: { interventional: number; backtracking: number; normative: number; none: number } | null =
    engineCruxes.length > 0
      ? engineCruxes.reduce(
          (acc, c) => {
            const ct = (c as Record<string, unknown>).counterfactual_type;
            if (ct === 'interventional') acc.interventional++;
            else if (ct === 'backtracking') acc.backtracking++;
            else if (ct === 'normative') acc.normative++;
            else if (ct === 'none') acc.none++;
            return acc;
          },
          { interventional: 0, backtracking: 0, normative: 0, none: 0 },
        )
      : null;

  // ── Parameter 9: Node cap — relevance score variance ──
  let relevanceVariance: number | null = null;
  const allRelevanceScores: number[] = [];
  for (const entry of session.transcript) {
    const manifest = (entry.metadata as Record<string, unknown>)?.injection_manifest as {
      node_scores?: number[];
    } | undefined;
    if (manifest?.node_scores) {
      allRelevanceScores.push(...manifest.node_scores);
    }
  }
  if (allRelevanceScores.length > 2) {
    const mean = allRelevanceScores.reduce((a, b) => a + b, 0) / allRelevanceScores.length;
    relevanceVariance = allRelevanceScores.reduce((s, v) => s + (v - mean) ** 2, 0) / allRelevanceScores.length;
  }

  // ── Parameter 10: Recycling/novelty agreement ──
  let recyclingAgreement: number | null = null;
  const recyclingFlags: boolean[] = [];
  const noveltyFlags: boolean[] = [];
  for (const entry of session.transcript) {
    if (entry.type !== 'statement') continue;
    const meta = entry.metadata as Record<string, unknown> | undefined;
    const recycled = meta?.recycling_detected === true;
    const noNewRefs = meta?.no_new_refs === true;
    recyclingFlags.push(recycled);
    noveltyFlags.push(noNewRefs);
  }
  if (recyclingFlags.length > 0) {
    let agreements = 0;
    for (let i = 0; i < recyclingFlags.length; i++) {
      if (recyclingFlags[i] === noveltyFlags[i]) agreements++;
    }
    recyclingAgreement = agreements / recyclingFlags.length;
  }

  // ── Parameters 11-14: AN-structural metrics ──
  const { taxonomyMappedRatio, nearMissDups, borderlineSurvival, avgBranchCohesion } =
    computeAnStructuralMetrics(session, an);

  // ── Parameter 15: Extraction density — claims per source document or transcript length ──
  let claimsPer1k: number | null = null;
  const docAnalysis = (session as any).document_analysis as { word_count?: number } | undefined;
  if (docAnalysis?.word_count && an && an.nodes.length > 0) {
    // Document-sourced: claims per 1k source words
    claimsPer1k = (an.nodes.length / docAnalysis.word_count) * 1000;
  } else if (an && an.nodes.length > 0) {
    // Topic-sourced: claims per 1k transcript words (measures extraction density from debate text)
    const transcriptWords = session.transcript
      .filter((e: { type: string }) => e.type === 'opening' || e.type === 'statement')
      .reduce((sum: number, e: { content: string }) => sum + (e.content?.split(/\s+/).length ?? 0), 0);
    if (transcriptWords > 0) {
      claimsPer1k = (an.nodes.length / transcriptWords) * 1000;
    }
  }

  // ── Situation effectiveness — crux alignment ──
  const { sitNodesInjected, sitNodesReferenced, sitCruxAlignment } = computeSituationAlignment(session, finalEval);

  // ── Anti-exploit metrics ──
  // Low-value claims rejected is tracked in argument_network diagnostics
  const lowValueRejected = ((session as any).argument_network_diagnostics?.rejectionReasons?.low_marginal_value as number) ?? 0;

  // Topic coherence per speaker: mean embedding similarity of each speaker's claims to crux centroid
  const topicCoherencePerSpeaker = computeTopicCoherence(session, an);

  // ── Agent utilities ──
  let agentUtilities: Record<string, AgentUtility> | null = null;
  if (an && an.nodes.length > 0) {
    const speakers = [...new Set(an.nodes.map((n: ArgumentNetworkNode) => n.speaker).filter((s): s is SpeakerId => s !== 'system' && s !== 'document'))];
    const cruxes = (session as any).crux_tracker as TrackedCrux[] | undefined;
    if (speakers.length > 0) {
      agentUtilities = {};
      for (const sp of speakers) {
        agentUtilities[sp] = computeAgentUtility(sp, an.nodes, an.edges, cruxes ?? []);
      }
    }
  }

  // ── Premature concession cascading ──
  // Detect sequential concessions by different agents within a 2-turn window.
  const signals = session.convergence_signals ?? [];
  let concessionCascades = 0;
  if (signals.length > 0) {
    // Find turns where concession was used
    const concessionTurns: { speaker: string; index: number }[] = [];
    for (let i = 0; i < signals.length; i++) {
      if (signals[i].concession_opportunity?.concession_used) {
        concessionTurns.push({ speaker: signals[i].speaker, index: i });
      }
    }
    // Check for cascades: different speaker concedes within 2 entries of a prior concession
    for (let i = 1; i < concessionTurns.length; i++) {
      const prev = concessionTurns[i - 1];
      const curr = concessionTurns[i];
      if (curr.speaker !== prev.speaker && (curr.index - prev.index) <= 2) {
        concessionCascades++;
      }
    }
  }

  // ── Prompt size tracking (t/219) ──
  let maxPromptChars: number | null = null;
  let meanPromptChars: number | null = null;
  const promptCharSamples: number[] = [];
  const diagEntries = session.diagnostics?.entries ?? {};
  for (const entryDiag of Object.values(diagEntries)) {
    const stages = (entryDiag as { stage_diagnostics?: { prompt?: string }[] }).stage_diagnostics;
    if (stages) {
      for (const sd of stages) {
        if (sd.prompt) promptCharSamples.push(sd.prompt.length);
      }
    }
    const et = (entryDiag as { extraction_trace?: { prompt_chars?: number } }).extraction_trace;
    if (et?.prompt_chars) promptCharSamples.push(et.prompt_chars);
  }
  if (promptCharSamples.length > 0) {
    maxPromptChars = Math.max(...promptCharSamples);
    meanPromptChars = Math.round(promptCharSamples.reduce((a, b) => a + b, 0) / promptCharSamples.length);
  }

  // ── Grounding confidence (t/281) ──
  const groundingConfidences: number[] = [];
  for (const entryDiag3 of Object.values(diagEntries)) {
    const stages3 = (entryDiag3 as { stage_diagnostics?: { stage: string; work_product: Record<string, unknown> }[] }).stage_diagnostics;
    if (!stages3) continue;
    for (const sd of stages3) {
      if (sd.stage === 'cite' && typeof sd.work_product?.grounding_confidence === 'number') {
        groundingConfidences.push(sd.work_product.grounding_confidence);
      }
    }
  }

  // ── Per-component prompt breakdown (t/221) ──
  let maxComponentChars: CalibrationDataPoint['max_component_chars'] = null;
  for (const entryDiag2 of Object.values(diagEntries)) {
    const stages2 = (entryDiag2 as { stage_diagnostics?: { prompt_component_chars?: { taxonomy_chars: number; transcript_chars: number; hints_chars: number; edge_chars: number; commitment_chars: number; an_summary_chars: number } }[] }).stage_diagnostics;
    if (!stages2) continue;
    for (const sd of stages2) {
      const cc = sd.prompt_component_chars;
      if (!cc) continue;
      if (!maxComponentChars) {
        maxComponentChars = { ...cc };
      } else {
        maxComponentChars.taxonomy_chars = Math.max(maxComponentChars.taxonomy_chars, cc.taxonomy_chars);
        maxComponentChars.transcript_chars = Math.max(maxComponentChars.transcript_chars, cc.transcript_chars);
        maxComponentChars.hints_chars = Math.max(maxComponentChars.hints_chars, cc.hints_chars);
        maxComponentChars.edge_chars = Math.max(maxComponentChars.edge_chars, cc.edge_chars);
        maxComponentChars.commitment_chars = Math.max(maxComponentChars.commitment_chars, cc.commitment_chars);
        maxComponentChars.an_summary_chars = Math.max(maxComponentChars.an_summary_chars, cc.an_summary_chars);
      }
    }
  }

  // ── Clarity metrics (Wachsmuth: Clarity, t/1120) ──
  const { clarityMSL, clarityLD, clarityJD } = computeClarityMetrics(session, an);

  // ── Affect signals (Wachsmuth: Emotional Appeal, t/1121) ──
  const { affectIntensityMean, affectIntensityVariance, affectAppropMean } = computeAffectSignals(session, rounds);
  const affectProfileByPhase = computeAffectProfileByPhase(session, rounds);

  // ── Source authority (Wachsmuth: Credibility, t/1122) ──
  // Fall back to session-stamped provenance (t/1769) when the caller didn't pass
  // docMeta — the renderer/main-save and server write paths don't have FS-derived
  // doc titles, so without this fallback source_authority/recency come out null.
  const srcAuth = computeSourceAuthority(session.argument_network?.nodes ?? [], config.docMeta ?? session.doc_meta);

  // ── Camp insularity (BEA: Reflective User Engagement, t/1117) ──
  const speakers = new Set<string>();
  for (const entry of session.transcript ?? []) {
    if (entry.type !== 'opening' && entry.type !== 'statement') continue;
    speakers.add(entry.speaker);
  }
  const { campInsularityRate, campInsularityMax } = computeCampInsularity(session, speakers);

  // ── Peer referencing rate (Marandi: peer-referencing ↔ diversity, t/1279) ──
  // Fraction of speaker turns with ≥1 cross-POV dialectical edge in the AN.
  const anNodes = session.argument_network?.nodes ?? [];
  const anEdges = session.argument_network?.edges ?? [];
  const { peerRefPerSpeaker, peerRefValues, peerReferencingRate } = computePeerReferencing(session, speakers);

  // ── Local sufficiency (Wachsmuth: Local Sufficiency, t/1341) ──
  const { localSufficiencyMean, unsupportedClaimRate, localSufficiencyBySpeaker } =
    computeLocalSufficiency(session, an, anEdges);

  return {
    schema_version: 1,
    debate_id: session.id,
    timestamp: now,
    origin,
    model: (session as any).debate_model ?? (session as any).config?.model ?? (session as any).model ?? 'unknown',
    rounds,

    // Preregistration-by-artifact provenance (t/1672). prompt_version is pure (imported
    // constant); config_revision + working_tree_state are placeholders here and get stamped
    // with real runtime values by appendCalibrationLog (the I/O funnel) — extractor stays pure.
    prompt_version: PROMPT_VERSION,
    config_revision: '',
    working_tree_state: 'unknown',
    // Same-evaluator comparison window key (t/1846); omitted on sessions that predate the pin.
    ...(session.evaluator_model_id ? { evaluator_model_id: session.evaluator_model_id } : {}),

    // Multi-provider model tracking (t/4040); omitted on single-model rows and pre-t/4040 sessions.
    ...(session.initial_speaker_models ? { speaker_models: session.initial_speaker_models } : {}),
    ...(session.speaker_model_failovers ? { speaker_model_failovers: session.speaker_model_failovers } : {}),
    ...(session.model_pool ? { model_pool: session.model_pool } : {}),
    ...(session.model_api_id ? { model_api_id: session.model_api_id } : {}),
    ...(session.failover_tracking ? { failover_tracking: session.failover_tracking } : {}),

    argumentative_saturation_at_transition: argumentativeSaturationAtTransition,
    argumentation_exit_threshold: config.argumentationExitThreshold ?? 0.65,
    engaging_real_disagreement: engaging,
    crux_addressed_ratio: cruxRatio,
    ...(cruxStatusCounts ? { crux_status_counts: cruxStatusCounts } : {}),

    avg_utilization_rate: utilCount > 0 ? totalUtil / utilCount : null,
    avg_primary_utilization: utilCount > 0 ? totalPrimaryUtil / utilCount : null,
    relevance_threshold: config.relevanceThreshold ?? 0.45,

    qbaf_preference_concordance: concordance,
    attack_weights: config.attackWeights ?? [DEFAULT_ATTACK_WEIGHTS.rebut, DEFAULT_ATTACK_WEIGHTS.undercut, DEFAULT_ATTACK_WEIGHTS.undermine],

    structural_error_rate: totalTurns > 0 ? structuralErrors / totalTurns : 0,
    repetition_rate: totalTurns > 0 ? repetitionWarnings / totalTurns : 0,
    draft_temperature: config.draftTemperature ?? DEFAULT_TEMPERATURE,

    argumentative_saturation_signals_at_transition: signalsAtTransition,
    argumentative_saturation_weights: config.argumentativeSaturationWeights ?? {
      recycling_pressure: 0.30, crux_maturity: 0.25, concession_plateau: 0.15,
      engagement_fatigue: 0.15, pragmatic_convergence: 0.05, scheme_stagnation: 0.10,
    },

    claims_forgotten_rate: claimsForgottenRate,
    recent_window: config.recentWindow ?? 8,

    an_nodes_at_synthesis: anNodesAtSynthesis,
    gc_runs: gcRuns,
    gc_trigger: config.gcTrigger ?? 175,

    crux_resolution_divergence_rate: cruxDivergenceRate,
    crux_match_stats: cruxMatchStats,
    crux_undecided_rate: cruxUndecidedRate,
    counterfactual_type_distribution: cfTypeDist,
    polarity_resolved_threshold: config.polarityResolvedThreshold ?? POLARITY_RESOLVED_THRESHOLD,

    relevance_score_variance: relevanceVariance,
    max_nodes_cap: config.maxNodesCap ?? 50,

    recycling_novelty_agreement: recyclingAgreement,
    semantic_recycling_threshold: config.semanticRecyclingThreshold ?? SEMANTIC_RECYCLING_THRESHOLD,

    taxonomy_mapped_ratio: taxonomyMappedRatio,
    cluster_min_similarity: config.clusterMinSimilarity ?? 0.55,

    near_miss_duplicate_count: nearMissDups,
    duplicate_similarity_threshold: config.duplicateSimilarityThreshold ?? ATTACK_DEDUP_THRESHOLD,

    borderline_claim_survival_rate: borderlineSurvival,
    fire_confidence_threshold: config.fireConfidenceThreshold ?? 0.7,

    avg_branch_cohesion: avgBranchCohesion,
    cohesion_clear_theme: config.cohesionClearTheme ?? 0.60,

    claims_per_1k_words: claimsPer1k,
    kp_divisor: config.kpDivisor ?? 500,

    hit_api_ceiling: hitApiCeiling,
    termination_reason: terminationReason,
    convergence_score_at_termination: convergenceScoreAtTermination,
    total_api_calls: session.diagnostics?.overview?.total_ai_calls ?? 0,
    budget_hard_multiplier: config.budgetHardMultiplier ?? 15,

    situation_nodes_injected: sitNodesInjected,
    situation_nodes_referenced: sitNodesReferenced,
    situation_crux_alignment: sitCruxAlignment,
    situation_reference_rate: sitNodesInjected > 0 ? sitNodesReferenced / sitNodesInjected : null,
    situation_max_nodes: config.explorationSummary?.recommended_config?.situation_cap ?? config.situationMaxNodes ?? 8,
    situation_component_scores: (() => {
      const scoreMap = session.situation_score_map;
      if (!scoreMap || Object.keys(scoreMap).length === 0) return null;
      const referencedSitIds = new Set(
        session.transcript.flatMap(e => e.taxonomy_refs ?? []).map(r => r.node_id).filter(id => id.startsWith('sit-')),
      );
      return Object.entries(scoreMap).map(([node_id, comp]) => ({
        node_id,
        composite: weightedSituationScore(comp, MID_DEBATE_WEIGHTS),
        referenced: referencedSitIds.has(node_id),
        relevance: comp.relevance,
        diversity: comp.diversity,
        freshness: comp.freshness,
        bdi_entropy: comp.bdi_entropy,
        conflict_openness: comp.conflict_openness,
      }));
    })(),

    agent_utilities: agentUtilities,
    low_value_claims_rejected: lowValueRejected,
    topic_coherence_per_speaker: topicCoherencePerSpeaker,
    concession_asymmetry_per_speaker: agentUtilities
      ? Object.fromEntries(Object.entries(agentUtilities).map(([k, v]) => [k, v.concession_asymmetry]))
      : null,
    concession_cascades: concessionCascades,

    topic_wisdom_total: session.topic.critique?.composite_score ?? null,
    topic_reframed: session.topic.critique?.reframe_applied ?? false,
    topic_weakest: (() => {
      const critique = session.topic.critique;
      if (!critique) return [];
      const weak: string[] = [];
      const ss = critique.structural_score;
      if (ss.crux_density === 0) weak.push('crux_density');
      if (ss.evidence_coverage === 0) weak.push('evidence_coverage');
      if (ss.bdi_heterogeneity === 0) weak.push('bdi_heterogeneity');
      if (ss.abstraction_level === 0) weak.push('abstraction_level');
      if (ss.situation_activation === 0) weak.push('situation_activation');
      if (critique.frame_score) {
        if (critique.frame_score.conditionality === 0) weak.push('conditionality');
        if (critique.frame_score.mechanism === 0) weak.push('mechanism');
        if (critique.frame_score.stakeholder === 0) weak.push('stakeholder');
        if (critique.frame_score.tension === 0) weak.push('tension');
        if (critique.frame_score.scope === 0) weak.push('scope');
      }
      return weak;
    })(),
    lineage_frame: session.topic.critique?.lineage_frame ?? null,
    lineage_effectiveness: (() => {
      const allBoosted = new Set<string>();
      const allPromoted = new Set<string>();
      const allInjected = new Set<string>();
      const allReferenced = new Set<string>();

      for (const entry of session.transcript) {
        if (entry.type !== 'opening' && entry.type !== 'statement') continue;
        const manifest = (entry.metadata as Record<string, unknown>)?.injection_manifest as {
          lineage_boost?: { boostedNodeIds?: string[]; promotedNodeIds?: string[] };
          povNodeIds?: string[];
        } | undefined;
        if (!manifest) continue;

        const refs = new Set((entry.taxonomy_refs ?? []).map((r: { node_id: string }) => r.node_id));
        for (const id of refs) allReferenced.add(id);
        for (const id of manifest.povNodeIds ?? []) allInjected.add(id);

        const lb = manifest.lineage_boost;
        if (lb) {
          for (const id of lb.boostedNodeIds ?? []) allBoosted.add(id);
          for (const id of lb.promotedNodeIds ?? []) allPromoted.add(id);
        }
      }

      if (allBoosted.size === 0) return null;

      const promotedReferenced = [...allPromoted].filter(id => allReferenced.has(id)).length;
      const promotedRefRate = allPromoted.size > 0 ? promotedReferenced / allPromoted.size : 0;
      const baselineRefRate = allInjected.size > 0 ? allReferenced.size / allInjected.size : 0;

      return {
        boosted_node_count: allBoosted.size,
        promoted_node_count: allPromoted.size,
        promoted_referenced_count: promotedReferenced,
        promoted_reference_rate: Math.round(promotedRefRate * 1000) / 1000,
        baseline_reference_rate: Math.round(baselineRefRate * 1000) / 1000,
      };
    })(),

    sycophancy_guard_fired: (session.transcript ?? []).some(e => e.type === 'system' && e.content.includes('[Sycophancy guard]')),
    max_sycophancy_score: (session.per_claim_drift ?? []).reduce((max, s) => Math.max(max, s.sycophancy_score), 0),
    claims_abandoned_rate: (() => {
      const snapshots = session.per_claim_drift ?? [];
      if (snapshots.length === 0) return 0;
      // Use latest snapshot per speaker
      const bySpeaker = new Map<string, typeof snapshots[0]>();
      for (const s of snapshots) bySpeaker.set(s.speaker, s);
      let total = 0, abandoned = 0;
      for (const s of bySpeaker.values()) {
        total += s.claims.length;
        abandoned += s.claims.filter(c => c.status === 'abandoned').length;
      }
      return total > 0 ? abandoned / total : 0;
    })(),

    qbaf_oscillation_detected: (session.qbaf_runs_oscillated ?? 0) > 0,
    qbaf_iterations: session.last_qbaf_result?.iterations ?? 0,
    qbaf_damping_level: session.max_qbaf_damping_level ?? 0,
    qbaf_oscillation_rate: (session.qbaf_runs_total ?? 0) > 0
      ? (session.qbaf_runs_oscillated ?? 0) / session.qbaf_runs_total!
      : 0,

    claim_outcome_summary: (() => {
      const an = session.argument_network;
      if (!an || an.nodes.length === 0) return null;
      const outcomes = classifyClaimOutcomes(an.nodes, an.edges);
      return summarizeOutcomes(outcomes);
    })(),

    confidence_deferrals: session.adaptive_staging_diagnostics?.confidence_deferrals ?? 0,
    confidence_escalations: (() => {
      const telemetry = session.adaptive_staging_diagnostics?.signal_telemetry ?? [];
      return telemetry.filter((t: { confidence?: { global?: number } }) =>
        t.confidence?.global !== undefined
      ).reduce((count: number, t: { predicate_result?: { components?: Record<string, number> } }) => {
        const ef = t.predicate_result?.components?.effective_floor;
        return ef !== undefined && ef < 0.40 ? count + 1 : count;
      }, 0);
    })(),
    confidence_bottleneck: (() => {
      const telemetry = session.adaptive_staging_diagnostics?.signal_telemetry ?? [];
      let extLow = 0, stabLow = 0;
      for (const t of telemetry) {
        const conf = (t as { confidence?: { extraction?: number; stability?: number } }).confidence;
        if (conf) {
          if ((conf.extraction ?? 1) < (conf.stability ?? 1)) extLow++;
          else if ((conf.stability ?? 1) < (conf.extraction ?? 1)) stabLow++;
        }
      }
      if (extLow === 0 && stabLow === 0) return 'none' as const;
      return extLow >= stabLow ? 'extraction' as const : 'stability' as const;
    })(),

    // Process reward series + summary stats
    process_reward_series: (() => {
      const prs = session.process_rewards;
      if (!prs || prs.length === 0) return null;
      return prs.map(pr => ({
        round: pr.round,
        speaker: pr.speaker,
        score: pr.score,
        components: pr.components,
      }));
    })(),
    process_reward_mean: (() => {
      const prs = session.process_rewards;
      if (!prs || prs.length === 0) return null;
      return prs.reduce((s, pr) => s + pr.score, 0) / prs.length;
    })(),
    process_reward_stddev: (() => {
      const prs = session.process_rewards;
      if (!prs || prs.length === 0) return null;
      const mean = prs.reduce((s, pr) => s + pr.score, 0) / prs.length;
      const variance = prs.reduce((s, pr) => s + (pr.score - mean) ** 2, 0) / prs.length;
      return Math.sqrt(variance);
    })(),
    process_reward_min: (() => {
      const prs = session.process_rewards;
      if (!prs || prs.length === 0) return null;
      return Math.min(...prs.map(pr => pr.score));
    })(),

    topic_scope_extracted: !!session.topic.scope,
    topic_scope_confidence: session.topic.scope?.constraint_confidence ?? null,
    topic_scope_disciplines: session.topic.scope?.relevant_disciplines.length ?? null,
    topic_scope_off_topics: session.topic.scope?.off_scope_topics.length ?? null,
    topic_scope_drift_sigs: session.topic.scope?.drift_signatures.length ?? null,
    topic_alignment_rate: (() => {
      const diagEntries = session.diagnostics?.entries ?? {};
      const entries = session.transcript?.filter(e => diagEntries[e.id]?.topic_alignment) ?? [];
      if (entries.length === 0) return null;
      const aligned = entries.filter(e => diagEntries[e.id]!.topic_alignment!.topic_aligned).length;
      return Math.round((aligned / entries.length) * 1000) / 1000;
    })(),
    scope_extraction_populated: (() => {
      const s = session.topic?.scope;
      if (!s) return null;
      const fields = [
        s.core_proposition,
        s.relevant_disciplines?.length,
        s.key_tensions?.length,
        s.off_scope_topics?.length,
        s.drift_signatures?.length,
        s.example_ceiling,
      ];
      return Math.round((fields.filter(v => v != null && v !== '' && v !== 0).length / fields.length) * 1000) / 1000;
    })(),
    // Fraction of turns that triggered a regen (repaired=true). Higher means more drafts needed repair — does NOT penalize successful repairs vs never-needed ones for TopicHealthScore purposes.
    draft_repair_rate: (() => {
      const diagEntries = session.diagnostics?.entries ?? {};
      const entries = session.transcript?.filter(e => diagEntries[e.id]?.topic_alignment) ?? [];
      if (entries.length === 0) return null;
      const repaired = entries.filter(e => diagEntries[e.id]!.topic_alignment!.repaired).length;
      return Math.round((repaired / entries.length) * 1000) / 1000;
    })(),
    taxonomy_demotion_rate: (() => {
      const diagEntries = session.diagnostics?.entries ?? {};
      let totalInjected = 0;
      let totalDemoted = 0;
      for (const e of session.transcript ?? []) {
        const sft = (diagEntries[e.id]?.stage_diagnostics ?? [])
          .find((sd: { stage: string }) => sd.stage === 'brief')
          ?.work_product as Record<string, unknown> | undefined;
        const manifest = (e.metadata as Record<string, unknown>)?.injection_manifest as Record<string, unknown> | undefined;
        const filterTrace = manifest?.scope_filter_trace as { demoted?: unknown[] } | undefined;
        const povNodes = manifest?.povNodeIds as string[] | undefined;
        if (povNodes?.length) totalInjected += povNodes.length;
        if (filterTrace?.demoted?.length) totalDemoted += filterTrace.demoted.length;
      }
      return totalInjected > 0 ? Math.round((totalDemoted / totalInjected) * 1000) / 1000 : null;
    })(),
    demoted_node_reference_rate: (() => {
      const diagEntries = session.diagnostics?.entries ?? {};
      const allDemoted = new Set<string>();
      const referencedDemoted = new Set<string>();
      for (const e of session.transcript ?? []) {
        const manifest = (e.metadata as Record<string, unknown>)?.injection_manifest as Record<string, unknown> | undefined;
        const filterTrace = manifest?.scope_filter_trace as { demoted?: { nodeId: string }[] } | undefined;
        if (filterTrace?.demoted) {
          for (const d of filterTrace.demoted) allDemoted.add(d.nodeId);
          const refs = new Set((e.taxonomy_refs ?? []).map((r: { node_id: string }) => r.node_id));
          for (const d of filterTrace.demoted) {
            if (refs.has(d.nodeId)) referencedDemoted.add(d.nodeId);
          }
        }
      }
      return allDemoted.size > 0 ? Math.round((referencedDemoted.size / allDemoted.size) * 1000) / 1000 : null;
    })(),
    moderator_drift_intervention_rate: (() => {
      const modEntries = (session.transcript ?? []).filter(e =>
        (e.metadata as Record<string, unknown>)?.moderator_trace != null);
      if (modEntries.length === 0) return null;
      let driftCount = 0;
      for (const me of modEntries) {
        const trace = (me.metadata as Record<string, unknown>).moderator_trace as Record<string, unknown>;
        if (trace.drift_detected) driftCount++;
      }
      return Math.round((driftCount / modEntries.length) * 1000) / 1000;
    })(),

    max_prompt_chars: maxPromptChars,
    mean_prompt_chars: meanPromptChars,

    avg_grounding_confidence: groundingConfidences.length > 0
      ? groundingConfidences.reduce((a, b) => a + b, 0) / groundingConfidences.length
      : null,
    min_grounding_confidence: groundingConfidences.length > 0
      ? Math.min(...groundingConfidences)
      : null,

    max_component_chars: maxComponentChars,

    // ── Extraction coverage (t/391) ──
    ...(() => {
      const coverageSamples: number[] = [];
      let sampleCount = 0;
      for (const entryDiag of Object.values(diagEntries)) {
        const ec = (entryDiag as EntryDiagnostics).extraction_coverage;
        if (ec) {
          coverageSamples.push(ec.coverage_rate);
          sampleCount++;
        }
      }
      return {
        extraction_coverage_rate: coverageSamples.length > 0
          ? Math.round((coverageSamples.reduce((a, b) => a + b, 0) / coverageSamples.length) * 1000) / 1000
          : null,
        extraction_coverage_samples: sampleCount,
      };
    })(),

    // ── Extraction quality (t/379, t/380) ──
    ...(() => {
      const confidences = (an?.nodes ?? [])
        .map((n: ArgumentNetworkNode) => n.extraction_confidence)
        .filter((c): c is number => c != null);
      const meanConf = confidences.length > 0
        ? confidences.reduce((a, b) => a + b, 0) / confidences.length
        : null;
      const lowConfRate = confidences.length > 0
        ? confidences.filter(c => c < 0.6).length / confidences.length
        : null;

      const allRepairs: EntailmentRepairEvent[] = [];
      let totalAnNodes = an?.nodes.length ?? 0;
      for (const entryDiag of Object.values(diagEntries)) {
        const repairs = (entryDiag as EntryDiagnostics).entailment_repairs;
        if (repairs) allRepairs.push(...repairs);
      }
      const entailPassRate = allRepairs.length > 0
        ? allRepairs.filter(r => r.verdict === 'entailed').length / allRepairs.length
        : null;
      const entailRepairRate = allRepairs.length > 0
        ? allRepairs.filter(r => r.repaired_text != null).length / allRepairs.length
        : null;
      const entailSamplingCoverage = totalAnNodes > 0
        ? Math.round((allRepairs.length / totalAnNodes) * 1000) / 1000
        : null;

      return {
        mean_extraction_confidence: meanConf != null ? Math.round(meanConf * 1000) / 1000 : null,
        low_confidence_claims_rate: lowConfRate != null ? Math.round(lowConfRate * 1000) / 1000 : null,
        entailment_pass_rate: entailPassRate != null ? Math.round(entailPassRate * 1000) / 1000 : null,
        entailment_repair_rate: entailRepairRate != null ? Math.round(entailRepairRate * 1000) / 1000 : null,
        entailment_sampling_coverage: entailSamplingCoverage,
      };
    })(),

    // ── Clarity metrics (Wachsmuth: Clarity, t/1120) ──
    clarity_mean_sentence_length: clarityMSL != null ? Math.round(clarityMSL * 100) / 100 : null,
    clarity_lexical_diversity: clarityLD != null ? Math.round(clarityLD * 1000) / 1000 : null,
    clarity_jargon_density: clarityJD != null ? Math.round(clarityJD * 1000) / 1000 : null,

    // ── Affect signals (Wachsmuth: Emotional Appeal, t/1121) ──
    affect_intensity_mean: affectIntensityMean != null ? Math.round(affectIntensityMean * 1000) / 1000 : null,
    affect_intensity_variance: affectIntensityVariance != null ? Math.round(affectIntensityVariance * 1000) / 1000 : null,
    affect_appropriateness: affectAppropMean != null ? Math.round(affectAppropMean * 1000) / 1000 : null,
    affect_profile_by_phase: affectProfileByPhase,

    // ── Source authority (Wachsmuth: Credibility, t/1122) ──
    source_authority_mean: srcAuth.source_authority_mean != null ? Math.round(srcAuth.source_authority_mean * 1000) / 1000 : null,
    source_recency_mean: srcAuth.source_recency_mean != null ? Math.round(srcAuth.source_recency_mean * 1000) / 1000 : null,
    evidence_breadth_per_claim: srcAuth.evidence_breadth_per_claim != null ? Math.round(srcAuth.evidence_breadth_per_claim * 100) / 100 : null,

    // ── Camp insularity (BEA: Reflective User Engagement, t/1117) ──
    camp_insularity_rate: campInsularityRate != null ? Math.round(campInsularityRate * 1000) / 1000 : null,
    camp_insularity_max: campInsularityMax != null ? Math.round(campInsularityMax * 1000) / 1000 : null,
    insularity_interventions: config.insularityInterventions?.length
      ? config.insularityInterventions.map(iv => {
          const engaged = session.transcript.some(e =>
            e.speaker === iv.speaker
            && e.type !== 'opening'
            && ((e.metadata as Record<string, unknown>)?.round as number ?? 0) > iv.round
            && (e.taxonomy_refs ?? []).some(r => r.node_id === iv.injected_node_id),
          );
          return { ...iv, engaged };
        })
      : null,

    // ── Peer referencing (Marandi: peer-referencing ↔ diversity, t/1279) ──
    peer_referencing_rate: peerReferencingRate != null ? Math.round(peerReferencingRate * 1000) / 1000 : null,
    peer_referencing_per_speaker: anNodes.length > 0 && peerRefValues.length > 0
      ? Object.fromEntries(Object.entries(peerRefPerSpeaker).map(([k, v]) => [k, Math.round(v * 1000) / 1000]))
      : null,

    // ── Local sufficiency (Wachsmuth: Local Sufficiency, t/1341) ──
    local_sufficiency_mean: localSufficiencyMean != null ? Math.round(localSufficiencyMean * 1000) / 1000 : null,
    unsupported_claim_rate: unsupportedClaimRate != null ? Math.round(unsupportedClaimRate * 1000) / 1000 : null,
    local_sufficiency_by_speaker: localSufficiencyBySpeaker
      ? Object.fromEntries(Object.entries(localSufficiencyBySpeaker).map(([k, v]) => [k, Math.round(v * 1000) / 1000]))
      : null,

    // ── Operational closure (autopoiesis, t/1537) ──
    ...(() => {
      const oc = computeOperationalClosure(anNodes, anEdges);
      return {
        operational_closure_rate: oc.debateMean,
        operational_closure_per_speaker: Object.keys(oc.perSpeaker).length > 0 ? oc.perSpeaker : null,
      };
    })(),

    // ── Exploration seeding ──
    ...(config.explorationSummary ? {
      exploration_source_id: config.explorationSummary.source_debate_id,
      exploration_source_model: config.explorationSummary.source_model,
      seeded_crux_count: config.explorationSummary.cruxes.length,
      seeded_effective_situation_count: config.explorationSummary.effective_situations.length,
      seeded_ineffective_situation_count: config.explorationSummary.ineffective_situations.length,
      seeded_an_node_count: config.explorationSummary.argument_sketch.nodes.length,
    } : {}),

    // ── Frame survival (t/2045) ──
    ...(() => {
      const fs = computeFrameSurvivalMetrics(session, finalEval, an);
      return {
        frames_declared_per_speaker: Object.keys(fs.framesDeclaredPerSpeaker).length > 0 ? fs.framesDeclaredPerSpeaker : undefined,
        frame_persistence_per_speaker: Object.keys(fs.framePersistencePerSpeaker).length > 0 ? fs.framePersistencePerSpeaker : undefined,
        frame_engagement_per_speaker: Object.keys(fs.frameEngagementPerSpeaker).length > 0 ? fs.frameEngagementPerSpeaker : undefined,
        frame_crux_alignment: fs.frameCruxAlignment,
        frame_reframe_targeted_count: fs.frameReframeTargetedCount,
        frame_survival: fs.frameSurvival,
      };
    })(),

    // ── Drift telemetry shadow log (t/3603) ──────────────────
    drift_telemetry_series: session.drift_telemetry && session.drift_telemetry.length > 0
      ? session.drift_telemetry
      : null,

    // ── AIF B5 metrics (t/3715) ─────────────────────────────
    aif_b5_metrics: (() => {
      const nodes = an?.nodes ?? [];
      if (nodes.length === 0 || !config.conflicts) return null;
      return computeAifB5Metrics(nodes, config.conflicts, session.convergence_signals);
    })(),
  };
}
