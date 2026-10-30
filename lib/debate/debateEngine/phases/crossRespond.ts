// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { DebateEngineInternals } from '../internals.js';
import path from 'path';
import { type ExtendedAIAdapter } from '../../aiAdapter.js';
import { type SpeakerId, type ArgumentNetworkNode, type EntryDiagnostics, type DebatePhase, POVER_INFO, getDebatePhase, type DraftWorkProduct, type InterventionMove } from '../../types.js';
import { loadProvisionalWeights, evaluatePhaseTransition, applyTransition, advanceRound, buildPhaseContext, buildSignalTelemetry, computeSaturationScore, computeConvergenceScore } from '../../phaseTransitions.js';
import { updateConfidenceState } from '../../signalConfidence.js';
import { pruneArgumentNetwork, needsGc } from '../../networkGc.js';
import { formatCriticalQuestions, extractSpeakerVocabulary, formatVocabularyExclusion } from '../../prompts.js';
import { formatConcessionCandidatesHint } from '../../argumentNetwork.js';
import { computeStrategicHints } from '../../strategicHints.js';
import { evaluateLookahead, type LookaheadDiagnostics } from '../../lookaheadGate.js';
import { runOvergenPipeline, type OvergenDiagnostics } from '../../overgenPipeline.js';
import { formatCruxResolutionContext } from '../../cruxResolution.js';
import { formatVocabularyContext } from '../../vocabularyContext.js';
import { parseJsonRobust, formatRecentTranscript, getMoveName } from '../../helpers.js';
import { checkDraftScopeBoundary, SCOPE_BOUNDARY_THRESHOLD } from '../../exclusionGuard.js';
import { computeCampInsularityRate, isInsularityCritical, selectCrossCampNode } from '../../schemeStagnation.js';
import { nodePovFromId } from '../../nodeIdUtils.js';
import { effectiveCamp } from '../../argumentNetwork/utils.js';
import { resolveTurnValidationConfig } from '../../turnValidator.js';
import { updateModeratorState, computeDebateHealthScore, buildInterventionBriefInjection, MOVE_RESPONSE_CONFIG, DIRECT_RESPONSE_PATTERNS, updateCruxEngagement } from '../../moderator.js';
import { runModeratorSelection, executeTurnWithRetry, type ModeratorSelectionCallbacks, type ModeratorSelectionInput, type TurnRetryCallbacks, type TurnRetryInput } from '../../orchestration.js';
import { pruneSessionData, pruneModeratorState } from '../../sessionPruning.js';
import type { DriftTelemetryEntry } from '../../calibrationLogger/schema.js';
import { getGlobalRecorder } from '../../../flight-recorder/index.js';
import { runTurnPipeline, assemblePipelineResult, type TurnPipelineInput } from '../../turnPipeline.js';
import { DEFAULT_TEMPERATURE } from '../../../ai-client/defaults.js';
import { resolveStageModel, resolveModelForSpeaker, recordRateLimit, clearRateLimitBackoff, isRateLimitError } from '../modelResolution.js';
import { _rescoreSituations, buildSignalContext, recordSignalHistory, updatePeakTracker, accumulateContextManifest } from '../adaptiveStaging.js';
import { enrichTaxonomyRefs, getRelevantTaxonomyContext, formatDebaterEdgeContext, formatModeratorEdgeContext, routeTurnValidatorHints } from '../taxonomyContext.js';
import { getCommitmentContext, getEstablishedPointsContext } from '../context.js';
import {
  MIDPOINT_NEUTRAL_EVAL_ROUND_CAP,
  COMPRESSION_TRIGGER_TRANSCRIPT_LENGTH,
  SOURCE_DOC_SUMMARY_CHAR_LIMIT,
  CONCESSION_CANDIDATE_MIN_QBAF_STRENGTH,
  RECENT_TRANSCRIPT_WINDOW_TURNS,
  PRIOR_MOVES_DIVERSITY_WINDOW,
  CROSS_POV_CITATION_ACTIVATION_ROUND,
  CROSS_POV_NODE_DIVERSITY_LIMIT,
  INSULARITY_INTERVENTION_COOLDOWN_ROUNDS,
  INSULARITY_INTERVENTION_PER_SPEAKER_CAP,
  JUDGE_TIMEOUT_MS,
  OVERGEN_TRANSCRIPT_WINDOW_TURNS,
} from '../../debateConfig.js';
import { injectPerturbation } from '../perturbation.js';
import { shouldTriggerDiversityRound, runDiversityRound } from './diversityInjection.js';
import { runProbingQuestions } from './probingQuestions.js';
import { updateNarrativeSimilarity } from './narrativeVoicing.js';
import { retrieveTalmudicReference, formatTalmudicSourceDirective, validateTalmudicReferenceResponse } from '../../talmudicReferences.js';
import type { TalmudicReferenceSelection } from '../../types.js';

// ── Phase: Cross-respond round ─────────────────────────────

export async function runFixedCrossRespond(engine: DebateEngineInternals): Promise<void> {
  const midpointRound = Math.min(MIDPOINT_NEUTRAL_EVAL_ROUND_CAP, Math.ceil(engine.config.rounds / 2));
  const w = loadProvisionalWeights();
  let gcRan = false;

  for (let round = 1; round <= engine.config.rounds; round++) {
    engine.checkAborted();
    const phase = getDebatePhase(round, engine.config.rounds);
    engine.progress('debate', undefined, `Cross-respond round ${round}/${engine.config.rounds} [${phase}]`, round);
    await runCrossRespondRound(engine, round, phase);

    // Perturbation injection (evaluation/benchmark only)
    if (engine.config.perturbation && round === engine.config.perturbation.inject_at_turn) {
      injectPerturbation(engine, round);
    }

    // Network GC — same topology-aware pruning as adaptive mode
    const an = engine.session.argument_network;
    if (an && !gcRan && needsGc(an.nodes.length, w.network.gc_trigger)) {
      const gcResult = pruneArgumentNetwork(an.nodes, an.edges, w.network.gc_target);
      an.nodes = gcResult.nodes;
      an.edges = gcResult.edges;
      gcRan = true;
      engine.progress('debate', undefined,
        `Network GC: ${gcResult.before} → ${gcResult.after} nodes`);
    }

    engine.checkAborted();
    const gapRound = engine.config.gapInjectionRound ?? Math.ceil(engine.config.rounds / 2) + 1;
    if (gapRound > 0 && round === gapRound && engine._claimPipeline.gapInjectionCount === 0) {
      await engine._claimPipeline.runGapInjection(round, 'scheduled');
    } else if (gapRound > 0) {
      await engine._claimPipeline.runResponsiveGapCheck(round, gapRound);
    }

    if (round === midpointRound && !engine._midpointEvalDone) {
      await engine._synthesisPipeline.runNeutralCheckpoint('midpoint');
      engine._midpointEvalDone = true;
    }

    if (engine.config.enableProbing && engine.config.probingInterval &&
        round % engine.config.probingInterval === 0 && round < engine.config.rounds) {
      await runProbingQuestions(engine, round);
    }

    if (engine.session.transcript.length >= COMPRESSION_TRIGGER_TRANSCRIPT_LENGTH) {
      await engine._synthesisPipeline.compressContext();
    }

    engine.emitSnapshot('round_complete');

    if (shouldTriggerDiversityRound(engine, round, phase)) {
      await runDiversityRound(engine, round + 1);
    }
  }
}

export async function runAdaptiveCrossRespond(engine: DebateEngineInternals): Promise<void> {
  const config = engine._adaptiveConfig!;
  const signals = engine._signalRegistry!;
  const diag = engine._adaptiveDiagnostics!;
  const w = loadProvisionalWeights();
  let state = engine._phaseState!;

  let round = 0;
  let terminated = false;
  let currentPhaseStartRound = 1;
  let currentPhaseExitReason = '';

  const midpointRound = Math.min(MIDPOINT_NEUTRAL_EVAL_ROUND_CAP, Math.ceil(config.maxTotalRounds / 2));

  while (!terminated) {
    engine.checkAborted();
    round++;
    state = advanceRound(state);
    state.api_calls_used = engine.apiCallCount;
    engine._phaseState = state;

    const phase = state.current_phase;
    engine.progress('debate', undefined,
      `Round ${round} [${phase}] (adaptive)`, round);

    // Run the cross-respond round
    await runCrossRespondRound(engine, round, phase);

    // Perturbation injection (evaluation/benchmark only)
    if (engine.config.perturbation && round === engine.config.perturbation.inject_at_turn) {
      injectPerturbation(engine, round);
    }

    // Update peak trackers after claims extraction
    const thisRoundStatements = engine.session.transcript
      .filter(e => e.type === 'statement' && (e.metadata as Record<string, unknown>)?.round === round);
    const claimsThisRound = thisRoundStatements.reduce((sum, e) => {
      const meta = e.metadata as Record<string, unknown> | undefined;
      return sum + ((meta?.extracted_claims_accepted as number) ?? 0);
    }, 0);
    updatePeakTracker(engine, '_peak_claims_per_round', claimsThisRound);

    const lastConvSignal = (engine.session.convergence_signals ?? []).slice(-1)[0];
    if (lastConvSignal) {
      updatePeakTracker(engine, '_peak_engagement_ratio', lastConvSignal.dialectical_engagement.ratio);
    }

    // Record peak trackers into signal history so priorSignals.get() works
    for (const [key, val] of engine._peakTrackers) {
      recordSignalHistory(engine, key, round, val);
    }

    // Build signal context and evaluate phase transition
    const predicateStart = Date.now();
    const ctx = buildSignalContext(engine, round);

    // Compute scores for telemetry
    const coldStart = state.rounds_in_phase < (
      state.current_phase === 'confrontation' ? w.phase_bounds.min_confrontation_rounds
      : state.current_phase === 'argumentation' ? w.phase_bounds.min_argumentation_rounds
      : w.phase_bounds.min_concluding_rounds
    );
    const satScore = computeSaturationScore(signals, ctx, coldStart);
    const convScore = computeConvergenceScore(ctx, coldStart);

    // Record composite scores in signal history
    recordSignalHistory(engine, '_argumentative_saturation_score', round, satScore);
    recordSignalHistory(engine, '_convergence_score', round, convScore);

    // Record individual signal values
    for (const signal of signals) {
      if (!signal.enabled) continue;
      try {
        const val = Math.max(0, Math.min(1, signal.compute(ctx)));
        recordSignalHistory(engine, signal.id, round, val);
      } catch { /* telemetry — silent by design: individual signal computation is best-effort */ }
    }

    // Health score for early termination
    const recentHealthSignals = (engine.session.convergence_signals ?? []).slice(-3);
    const turnCounts: Record<string, number> = {};
    for (const p of engine.config.activePovers) turnCounts[p] = 0;
    for (const e of engine.session.transcript) {
      if (e.type === 'statement' && e.speaker !== 'system' && e.speaker !== 'moderator') {
        turnCounts[e.speaker] = (turnCounts[e.speaker] ?? 0) + 1;
      }
    }
    const referencedIds = new Set<string>();
    for (const e of engine.session.transcript.slice(-6)) {
      for (const ref of e.taxonomy_refs) referencedIds.add(ref.node_id);
    }
    const relevantNodeCount = Math.max(1, (engine.taxonomy.accelerationist?.nodes?.length ?? 0) +
      (engine.taxonomy.safetyist?.nodes?.length ?? 0) +
      (engine.taxonomy.skeptic?.nodes?.length ?? 0));
    const healthScore = computeDebateHealthScore(recentHealthSignals, turnCounts, referencedIds.size, relevantNodeCount);

    // Evaluate phase transition predicate
    const result = evaluatePhaseTransition(state, ctx, signals, config, healthScore);
    const predicateMs = Date.now() - predicateStart;

    // Record telemetry
    diag.total_predicate_evaluations++;
    if (result.confidence_deferred) diag.confidence_deferrals++;
    if (result.veto_active) diag.vetoes_fired++;
    if (result.force_active) diag.forces_fired++;
    diag.network_size_peak = Math.max(diag.network_size_peak, ctx.network.nodeCount);

    const phaseCtx = buildPhaseContext(state, config, satScore, convScore);
    const telemetry = buildSignalTelemetry(state, ctx, signals, result, phaseCtx.phase_progress, predicateMs);
    diag.signal_telemetry.push(telemetry);

    // Update confidence escalation state
    state.confidence_state = updateConfidenceState(
      state.confidence_state ?? { consecutiveDeferrals: 0, effectiveFloor: 0.40 },
      result.confidence_deferred,
    );

    // Apply transition
    const prevPhase = state.current_phase;
    state = applyTransition(state, result);
    state.api_calls_used = engine.apiCallCount;
    engine._phaseState = state;
    // Persist after each round so single-step GUI can hydrate on next invocation (t/3761).
    // adaptive_staging is guaranteed present by hydratePhaseState (debateEngine/hydrateState.ts).
    if (engine.session.adaptive_staging) {
      engine.session.adaptive_staging.phase_state = state;
    }

    if (result.action === 'transition' || result.action === 'force_transition') {
      diag.phases.push({
        phase: prevPhase,
        rounds: Array.from({ length: round - currentPhaseStartRound + 1 }, (_, i) => currentPhaseStartRound + i),
        exit_reason: result.reason,
        force_active: result.force_active,
      });
      currentPhaseStartRound = round + 1;
      currentPhaseExitReason = result.reason;

      engine.progress('debate', undefined,
        `Phase transition: ${prevPhase} → ${state.current_phase} (${result.reason})`);

      // Add system entry for transition
      engine.addEntry({
        type: 'system', speaker: 'system',
        content: `[Phase transition] ${prevPhase} → ${state.current_phase}: ${result.reason}`,
        taxonomy_refs: [],
        metadata: { adaptive_transition: true, from_phase: prevPhase, to_phase: state.current_phase, reason: result.reason },
      });

      // Adaptive situation re-scoring: re-score situations against emerging cruxes
      _rescoreSituations(engine);
    }

    if (result.action === 'regress') {
      const cruxId = Object.keys(result.components).find(k => k.startsWith('crux_')) ?? 'unknown';
      diag.regressions.push({
        from_round: round,
        crux_id: cruxId,
        threshold_after: state.argumentation_exit_threshold,
      });

      engine.progress('debate', undefined,
        `Regression: synthesis → exploration (${result.reason})`);

      engine.addEntry({
        type: 'system', speaker: 'system',
        content: `[Phase regression] synthesis → exploration: ${result.reason}. Threshold ratcheted to ${(state.argumentation_exit_threshold * 100).toFixed(0)}%.`,
        taxonomy_refs: [],
        metadata: { adaptive_regression: true, reason: result.reason, new_threshold: state.argumentation_exit_threshold },
      });
      currentPhaseStartRound = round + 1;
    }

    if (result.action === 'terminate') {
      terminated = true;
      diag.phases.push({
        phase: state.current_phase,
        rounds: Array.from({ length: round - currentPhaseStartRound + 1 }, (_, i) => currentPhaseStartRound + i),
        exit_reason: result.reason,
        force_active: result.force_active,
      });

      engine.addEntry({
        type: 'system', speaker: 'system',
        content: `[Debate terminated] ${result.reason}`,
        taxonomy_refs: [],
        metadata: { adaptive_termination: true, reason: result.reason },
      });
    }

    // Network GC check
    const an = engine.session.argument_network!;
    if (needsGc(an.nodes.length, w.network.gc_trigger) && !state.gc_ran_this_phase) {
      const gcResult = pruneArgumentNetwork(an.nodes, an.edges, w.network.gc_target);
      an.nodes = gcResult.nodes;
      an.edges = gcResult.edges;
      state.gc_ran_this_phase = true;
      diag.gc_events.push({
        round, before: gcResult.before,
        after: gcResult.after, pruned: gcResult.before - gcResult.after,
      });
      engine.progress('debate', undefined,
        `Network GC: ${gcResult.before} → ${gcResult.after} nodes`);
    }

    // Mid-round hooks (gap injection, neutral eval, probing, compression)
    engine.checkAborted();
    const gapRound = engine.config.gapInjectionRound ?? Math.ceil(config.maxTotalRounds / 2) + 1;
    if (gapRound > 0 && round === gapRound && engine._claimPipeline.gapInjectionCount === 0) {
      await engine._claimPipeline.runGapInjection(round, 'scheduled');
    } else if (gapRound > 0) {
      await engine._claimPipeline.runResponsiveGapCheck(round, gapRound);
    }

    if (round === midpointRound && !engine._midpointEvalDone) {
      await engine._synthesisPipeline.runNeutralCheckpoint('midpoint');
      engine._midpointEvalDone = true;
    }

    if (engine.config.enableProbing && engine.config.probingInterval &&
        round % engine.config.probingInterval === 0 && !terminated) {
      await runProbingQuestions(engine, round);
    }

    if (engine.session.transcript.length >= COMPRESSION_TRIGGER_TRANSCRIPT_LENGTH) {
      await engine._synthesisPipeline.compressContext();
    }

    engine.emitSnapshot('round_complete');

    if (!terminated && shouldTriggerDiversityRound(engine, round, state.current_phase)) {
      await runDiversityRound(engine, round + 1);
    }
  }

  // Store adaptive diagnostics on session
  engine.session.adaptive_staging_diagnostics = diag;
}

export async function runCrossRespondRound(engine: DebateEngineInternals, round: number, phase: DebatePhase = 'argumentation'): Promise<void> {
  engine.checkAborted();

  const sourceDocSummary = engine.session.document_analysis?.claims_summary
    ?? (engine.session.source_content ? engine.session.source_content.slice(0, SOURCE_DOC_SUMMARY_CHAR_LIMIT) : undefined);

  const moderatorModel = resolveStageModel(engine, 'moderator');
  const selectionCallbacks: ModeratorSelectionCallbacks = {
    generate: async (prompt, _model, options, label) => engine.generateWithModel(prompt, label, moderatorModel, options?.timeoutMs, engine.config.temperature ?? DEFAULT_TEMPERATURE),
    addEntry: (entry) => engine.addEntry(entry).id,
    progress: (ph, speaker, message) => engine.progress(ph, speaker, message),
    warn: (context, err, recovery) => engine.warn(context, err, recovery),
    formatEdgeContext: () => {
      const result = formatModeratorEdgeContext(engine);
      return { text: result.text, edges_used: result.edges_used };
    },
    computeEmbedding: engine.adapter.computeQueryEmbedding
      ? async (text: string) => {
        const { vector } = await engine.adapter.computeQueryEmbedding!(text);
        return vector;
      }
      : undefined,
  };

  const selectionInput: ModeratorSelectionInput = {
    round,
    phase,
    activePovers: engine.config.activePovers,
    totalRounds: engine.config.rounds,
    model: moderatorModel,
    audience: engine.config.audience,
    sourceDocSummary,
    resolution: engine.session.topic.final,
    resolutionClauses: engine.session.topic.clauses,
    topicDriftState: engine._topicPipeline.computeTopicDriftState(),
    transcript: engine.session.transcript,
    contextSummaries: engine.session.context_summaries,
    argumentNetwork: engine.session.argument_network ?? undefined,
    convergenceSignals: engine.session.convergence_signals,
    unansweredLedger: engine.session.unanswered_claims_ledger,
    gapInjections: engine.session.gap_injections,
    commitments: engine.session.commitments,
    existingModState: engine._moderatorState,
    poverInfo: POVER_INFO as Record<string, { label: string; pov: string; personality?: string }>,
    cruxTracker: engine.session.crux_tracker as unknown as ModeratorSelectionInput['cruxTracker'],
    claimTexts: engine.session.argument_network
      ? Object.fromEntries(engine.session.argument_network.nodes.map(n => [n.id, n.text]))
      : undefined,
    nodeEmbeddings: engine.taxonomy.embeddings as Record<string, { vector: number[] }> | undefined,
    moderatorMode: engine.config.moderatorMode as import('../../types.js').ModeratorMode | undefined,
    dialecticalStyle: engine.config.dialecticalStyle,
  };

  const modResult = await runModeratorSelection(selectionInput, selectionCallbacks);
  engine._moderatorState = modResult.modState;

  const { responder, focusPoint, addressing, agreementDetected, selectionResult,
    intervention: activeIntervention, interventionBriefInjection, healthScore, diagnostics } = modResult;

  // Record moderator deliberation as a system entry with full diagnostics
  const an = engine.session.argument_network;
  const modEntry = engine.addEntry({
    type: 'system',
    speaker: 'system',
    content: `[Round ${round}] Moderator: ${POVER_INFO[responder]?.label ?? responder} → ${addressing} on: ${focusPoint}${activeIntervention ? ` [${activeIntervention.move}]` : ''}`,
    taxonomy_refs: [],
    metadata: {
      moderator_trace: {
        selected: responder,
        focus_point: focusPoint,
        addressing,
        debate_phase: phase,
        agreement_detected: agreementDetected,
        recent_scheme: diagnostics.recentScheme ?? null,
        critical_questions: diagnostics.recentScheme ? (formatCriticalQuestions(diagnostics.recentScheme) || null) : null,
        metaphor_reframe_offered: diagnostics.metaphorReframeOffered ?? null,
        metaphor_reframe_used: false,
        drift_detected: selectionResult.drift_detected ?? false,
        drift_reasoning: selectionResult.trigger_reasoning ?? null,
        intervention_recommended: selectionResult.intervene ?? false,
        intervention_source: selectionResult.intervene ? (selectionResult.trigger_source ?? 'moderator') : null,
        intervention_move: activeIntervention?.move ?? modResult.engineValidation?.validated_move ?? null,
        intervention_validated: !!activeIntervention,
        suppressed_reason: modResult.engineValidation?.suppressed_reason ?? null,
        suppression_explanation: modResult.engineValidation?.suppression_explanation ?? null,
        health_score: healthScore.value,
        budget_remaining: modResult.modState.budget_remaining,
        argument_network_snapshot: an ? {
          total_claims: an.nodes.length,
          total_edges: an.edges.length,
          unaddressed_claims: an.nodes.filter(n => !an.edges.some(e => e.target === n.id)).length,
          strongest_unaddressed: an.nodes
            .filter(n => n.computed_strength != null && !an.edges.some(e => e.target === n.id))
            .sort((a, b) => (b.computed_strength ?? 0) - (a.computed_strength ?? 0))
            .slice(0, 3)
            .map(n => ({ id: n.id, speaker: n.speaker, strength: n.computed_strength, text: n.text.slice(0, 100) })),
        } : null,
        edge_context_length: diagnostics.edgeContextLength,
        an_context_length: diagnostics.anContextLength,
        qbaf_context_length: diagnostics.qbafContextLength,
      },
    },
  });
  engine.recordDiagnostic(modEntry.id, {
    prompt: diagnostics.selectionPrompt,
    raw_response: diagnostics.selectionResponse,
    model: engine.config.model,
    response_time_ms: diagnostics.selectionElapsed,
    edges_used: diagnostics.edgesUsed as { source: string; target: string; type: string; confidence: number }[] | undefined,
  });

  // ── Talmudic dialectical state ────────────────────────
  const dialecticalDiag = selectionResult.dialectical_diagnostic;
  let _talmudicSelection: TalmudicReferenceSelection | undefined;
  let _talmudicCardEntryId: string | undefined;

  if (dialecticalDiag) {
    const modTrace = (modEntry.metadata as Record<string, unknown>)?.moderator_trace as Record<string, unknown> | undefined;
    if (modTrace) modTrace.dialectical_diagnostic = dialecticalDiag;
  }

  if ((selectionResult.intervene ?? false) && !activeIntervention && !modResult.engineValidation?.suppressed_reason) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'debate-engine', level: 'error',
      debate_id: engine.session?.id,
      message: 'Intervention recommended but neither executed nor suppressed — missing suppression reason',
      data: { round, selectionResult },
    });
  }

  // Generate response
  const info = engine.getSoulForSpeaker(responder);
  engine.progress('debate', responder, `${info.label} responding (round ${round})`);

  // priorRefs is also fed to the prompt below; computing it here lets
  // retrieval diversify AGAINST recently-cited nodes as well.
  const priorRefsEarly = engine.session.transcript
    .filter(e => e.speaker === responder && e.type !== 'opening')
    .slice(-2)
    .flatMap(e => (e.taxonomy_refs ?? []).map(r => r.node_id));

  const taxonomyContext = await getRelevantTaxonomyContext(engine, info.pov, priorRefsEarly);
  const commitmentContext = getCommitmentContext(engine, responder);
  const establishedPoints = getEstablishedPointsContext(engine, responder);
  const { text: debaterEdgeContext, edges_used: responderEdgesUsed } = formatDebaterEdgeContext(engine, info.pov);

  // QBAF-grounded concession hint: surface strong opposing claims this debater
  // hasn't attacked or already conceded. Counterbalances the rotation rule
  // that blocks consecutive CONCEDE openings.
  const concessionAN = engine.session.argument_network;
  const priorConceded = engine.session.commitments?.[responder]?.conceded ?? [];
  const concessionHint = concessionAN
    ? formatConcessionCandidatesHint(concessionAN.nodes, concessionAN.edges, responder, priorConceded)
    : '';
  const concessionCandidateIds = concessionHint
    ? (concessionAN!.nodes
        .filter(n => effectiveCamp(n) !== responder)
        .filter(n => (n.computed_strength ?? n.base_strength ?? 0) >= CONCESSION_CANDIDATE_MIN_QBAF_STRENGTH)
        .filter(n => !concessionAN!.edges.some(e => e.type === 'attacks' && e.source && concessionAN!.nodes.find(x => x.id === e.source)?.speaker === responder && e.target === n.id))
        .filter(n => !priorConceded.includes(n.id) && !priorConceded.includes(n.text))
        .sort((a, b) => (b.computed_strength ?? 0) - (a.computed_strength ?? 0))
        .slice(0, 2)
        .map(n => n.id))
    : [];
  const updatedTranscript = formatRecentTranscript(engine.session.transcript, RECENT_TRANSCRIPT_WINDOW_TURNS, engine.session.context_summaries);

  // Collect this debater's prior move_types for diversity enforcement
  const debaterTurns = engine.session.transcript
    .filter(e => e.speaker === responder && (e.type === 'opening' || e.type === 'statement'));
  const priorMoves = debaterTurns
    .filter(e => e.metadata)
    .flatMap(e => ((e.metadata as Record<string, unknown>)?.move_types as (string | import('../../helpers.js').MoveAnnotation)[]) ?? [])
    .map(m => getMoveName(m))
    .slice(-PRIOR_MOVES_DIVERSITY_WINDOW); // Last 3 turns × ~2 moves each

  // Count turns since this debater last used a CONCEDE move
  let turnsSinceLastConcession = debaterTurns.length; // default: never conceded
  for (let i = debaterTurns.length - 1; i >= 0; i--) {
    const moves = ((debaterTurns[i].metadata as Record<string, unknown>)?.move_types as (string | import('../../helpers.js').MoveAnnotation)[]) ?? [];
    if (moves.some(m => getMoveName(m).includes('CONCEDE'))) {
      turnsSinceLastConcession = debaterTurns.length - 1 - i;
      break;
    }
  }

  // Reuse priorRefsEarly (computed before retrieval) for prompt-side rotation guidance.
  const priorRefs = priorRefsEarly;
  const taxMap = engine.taxonomy as unknown as Record<string, { nodes?: { id: string }[] } | undefined>;
  const povFile = taxMap[info.pov];
  const availablePovNodeIds = [
    ...(povFile?.nodes?.map(n => n.id) ?? []),
    ...(taxMap.situations?.nodes?.map(n => n.id) ?? []),
  ];

  // Gather cross-POV node IDs for late-round citation diversity (Rec 3)
  const crossPovNodeIds = round >= CROSS_POV_CITATION_ACTIVATION_ROUND
    ? Object.entries(taxMap)
        .filter(([key]) => key !== info.pov && key !== 'policyRegistry')
        .flatMap(([, file]) => file?.nodes?.map(n => n.id) ?? [])
        .filter(id => !priorRefsEarly.includes(id))
        .sort(() => Math.random() - 0.5)
        .slice(0, CROSS_POV_NODE_DIVERSITY_LIMIT)
    : undefined;

  // ── Insularity intervention (BEA RUE, t/1130) ──
  let insularityInjection = '';
  if (engine.config.enableInsularityIntervention) {
    const allSpeakerRefs = engine.session.transcript
      .filter(e => e.speaker === responder && e.type !== 'opening')
      .flatMap(e => (e.taxonomy_refs ?? []).map(r => r.node_id));

    const insRate = computeCampInsularityRate(allSpeakerRefs, info.pov);
    const campSpecificCount = allSpeakerRefs.filter(id => {
      const p = nodePovFromId(id);
      return p && p !== 'situations' && p !== 'conflicts';
    }).length;

    if (insRate != null && isInsularityCritical(insRate, campSpecificCount)) {
      const speakerInterventions = engine._insularityInterventions.filter(i => i.speaker === responder);
      const lastRoundForSpeaker = speakerInterventions.length > 0
        ? Math.max(...speakerInterventions.map(i => i.round))
        : -Infinity;
      const cooldownOk = round - lastRoundForSpeaker >= INSULARITY_INTERVENTION_COOLDOWN_ROUNDS;
      const capOk = speakerInterventions.length < INSULARITY_INTERVENTION_PER_SPEAKER_CAP;

      if (cooldownOk && capOk) {
        const allCampNodes = Object.entries(
          engine.taxonomy as unknown as Record<string, { nodes?: { id: string; label: string; description?: string }[] } | undefined>,
        )
          .filter(([key]) => key !== info.pov && key !== 'policyRegistry' && key !== 'situations' && key !== 'embeddings' && key !== 'lineageCategories')
          .flatMap(([, file]) => file?.nodes ?? []);

        const injection = selectCrossCampNode(info.pov, allSpeakerRefs, allCampNodes, engine._lastRelevanceScores ?? undefined);
        if (injection) {
          insularityInjection = `\n\n=== CROSS-CAMP PERSPECTIVE ===\nThe following perspective from the ${injection.target_camp} camp may offer a productive contrast to your current line of reasoning. Consider engaging with it:\n- [${injection.node_id}] ${injection.node_label}`;
          engine._insularityInterventions.push({
            speaker: responder,
            round,
            injected_node_id: injection.node_id,
            target_camp: injection.target_camp,
          });
          availablePovNodeIds.push(injection.node_id);
          getGlobalRecorder()?.record({
            type: 'turn.insularity_intervention', component: 'debate-engine', level: 'info',
            debate_id: engine.session?.id,
            message: `Insularity intervention: injected ${injection.node_id} (${injection.target_camp}) for ${responder}`,
            data: { speaker: responder, round, ...injection },
          });
        }
      }
    }
  }

  // Rec 6: Carry forward repair hints from prior accept_with_flag turns
  let priorFlaggedHints: string[] | undefined;
  if (engine.session.turn_validations) {
    const priorSpeakerEntries = engine.session.transcript
      .filter(e => e.speaker === responder && e.type !== 'opening');
    const lastEntry = priorSpeakerEntries[priorSpeakerEntries.length - 1];
    if (lastEntry) {
      const trail = engine.session.turn_validations[lastEntry.id];
      if (trail?.final?.outcome === 'accept_with_flag' && trail.final.repairHints?.length) {
        priorFlaggedHints = trail.final.repairHints;
      }
    }
  }

  // ── 4-stage pipeline: BRIEF → PLAN → DRAFT → CITE ──
  const turnVocabContext = engine.config.vocabulary
    ? '\n' + formatVocabularyContext({ pov: info.pov, ...engine.config.vocabulary })
    : '';
  // Inject moderator intervention context into the debater's BRIEF stage
  const interventionInjection = activeIntervention
    ? buildInterventionBriefInjection(activeIntervention)
    : '';

  // Extract last opponent statement for the draft quality pre-check
  const lastOpponentEntry = engine.session.transcript
    .filter(e => e.speaker !== responder && e.speaker !== 'system' && e.speaker !== 'user' && e.type !== 'opening')
    .slice(-1)[0];
  const lastOpponentStatement = lastOpponentEntry
    ? (typeof lastOpponentEntry.content === 'string' ? lastOpponentEntry.content : JSON.stringify(lastOpponentEntry.content))
    : undefined;

  // Opponent-aware strategic hints (t/20): computed from AN + commitments, no LLM calls
  const anForHints = engine.session.argument_network;
  const hintsResult = anForHints && engine.session.commitments
    ? computeStrategicHints(
        responder,
        anForHints.nodes,
        anForHints.edges,
        engine.session.commitments,
        round,
      )
    : undefined;
  const strategicHints = hintsResult?.hints;
  if (hintsResult && hintsResult.dropped > 0) {
    console.log(`[strategic-hints] Dropped ${hintsResult.dropped} hint(s) due to char budget`);
  }

  // Read prior turn's ignored evidence so the pipeline can penalise those docs
  const priorSamePoV = engine.session.transcript
    .filter(e => e.speaker === responder && e.type === 'statement')
    .slice(-1)[0];
  const priorIgnoredDocIds = (priorSamePoV?.metadata as Record<string, unknown> | undefined)
    ?.ignored_evidence_doc_ids as string[] | undefined;

  const vocabTerms = extractSpeakerVocabulary(engine.session.transcript, responder);
  const vocabularyExclusion = formatVocabularyExclusion(vocabTerms);

  const pipelineInput: TurnPipelineInput = {
    label: info.label,
    pov: info.pov,
    soul: info,
    personality: info.personality,
    opponentSouls: Object.fromEntries(
      engine.config.activePovers
        .filter(id => id !== responder && (id as string) !== 'user')
        .map(id => [id, engine.getSoulForSpeaker(id)]),
    ),
    topic: engine.session.topic.final,
    background: engine.session.topic.background || undefined,
    taxonomyContext: taxonomyContext + turnVocabContext + interventionInjection + insularityInjection,
    commitmentContext,
    establishedPoints,
    edgeContext: debaterEdgeContext,
    concessionHint,
    recentTranscript: updatedTranscript,
    focusPoint,
    addressing,
    phase,
    priorMoves,
    turnsSinceLastConcession,
    priorRefs,
    availablePovNodeIds,
    availablePolicyIds: [...engine.getPolicyIds()],
    crossPovNodeIds,
    priorFlaggedHints,
    vocabularyExclusion,
    priorCruxContext: engine._priorCruxContext || undefined,
    currentCruxContext: engine.session.crux_tracker?.length
      ? formatCruxResolutionContext(engine.session.crux_tracker)
      : undefined,
    explorationPriming: engine._explorationPriming || undefined,
    useBackgroundPrompt: engine.config.useBackgroundPrompt,
    topicScope: engine.session.topic.scope ?? undefined,
    topicStructure: engine.session.topic_structure ?? undefined,
    salienceBeacon: engine.config.salienceBeacon ?? false,
    sourceContent: engine.session.document_analysis ? undefined : engine.config.sourceContent,
    documentAnalysis: engine.session.document_analysis,
    audience: engine.config.audience,
    model: resolveModelForSpeaker(engine, responder),
    briefModel: engine.config.stageModels?.brief,
    planModel: engine.config.stageModels?.plan,
    draftModel: engine.config.stageModels?.draft,
    citeModel: engine.config.stageModels?.cite,
    ...(activeIntervention ? {
      pendingIntervention: {
        move: activeIntervention.move,
        family: activeIntervention.family,
        targetDebater: activeIntervention.target_debater,
        responseField: MOVE_RESPONSE_CONFIG[activeIntervention.move]?.field ?? undefined,
        responseSchema: MOVE_RESPONSE_CONFIG[activeIntervention.move]?.schema ?? undefined,
        directResponsePattern: DIRECT_RESPONSE_PATTERNS[activeIntervention.move] ?? undefined,
        isTargeted: activeIntervention.target_debater === responder,
      },
    } : {}),
    lastOpponentStatement,
    strategicHints: strategicHints?.length ? strategicHints : undefined,
    sourceEvidenceIndex: engine.sourceEvidenceIndex,
    docTitles: engine.docTitles as unknown as import('../../evidenceFromSummaries.js').DocTitleMap | undefined,
    ignoredEvidenceDocIds: priorIgnoredDocIds,
    suppressedHints: engine.getSuppressedHints(),
    ...(engine.config.temperature != null ? {
      stageTemperatures: {
        brief_temperature: engine.config.temperature,
        plan_temperature: engine.config.temperature,
        draft_temperature: engine.config.temperature,
        cite_temperature: engine.config.temperature,
      },
    } : {}),
    ...(engine._phaseState && engine._adaptiveConfig ? {
      phaseContext: (() => {
        const w = loadProvisionalWeights();
        const coldStart = engine._phaseState!.rounds_in_phase < (
          engine._phaseState!.current_phase === 'confrontation' ? w.phase_bounds.min_confrontation_rounds
          : engine._phaseState!.current_phase === 'argumentation' ? w.phase_bounds.min_argumentation_rounds
          : w.phase_bounds.min_concluding_rounds
        );
        const satScore = engine._signalRegistry
          ? computeSaturationScore(engine._signalRegistry, buildSignalContext(engine, round), coldStart) : 0;
        const convScore = engine._signalRegistry
          ? computeConvergenceScore(buildSignalContext(engine, round), coldStart) : 0;
        const pc = buildPhaseContext(engine._phaseState!, engine._adaptiveConfig!, satScore, convScore);
        return { rationale: pc.rationale, phase_progress: pc.phase_progress, approaching_transition: pc.approaching_transition };
      })(),
    } : {}),
  };

  // ── Talmudic source card injection (requires pipelineInput + info to be defined) ──
  if (dialecticalDiag && engine._talmudicCorpus) {
    const usedCardIds = new Set<string>(
      (engine.session.dialectical_diagnostics ?? [])
        .map(d => d.reference_selection?.selected_card?.id)
        .filter((id): id is string => !!id)
    );
    _talmudicSelection = retrieveTalmudicReference({
      corpus: engine._talmudicCorpus,
      resolution: engine.session.topic.final,
      diagnostic: dialecticalDiag,
      recentScheme: diagnostics.recentScheme ?? null,
      usedCardIds,
      minScore: engine.config.talmudicReferences?.minScore,
    });
    if (_talmudicSelection.selected_card) {
      const directive = formatTalmudicSourceDirective(_talmudicSelection, info.label);
      const cardEntry = engine.addEntry({ type: 'system', speaker: 'system', content: directive, taxonomy_refs: [] });
      _talmudicCardEntryId = cardEntry.id;
      pipelineInput.talmudicReferenceDirective = directive;
      pipelineInput.talmudicReferenceCardId = _talmudicSelection.selected_card.id;
    }
  }

  const envelopeGenerate = engine.adapter.generate
    ? async (request: import('../../cacheTypes.js').GenerateRequest, label: string) => {
        await engine.throttle();
        engine.progress('generating', undefined, label);
        const start = Date.now();
        try {
          const resp = await engine.adapter.generate!(request);
          engine.lastApiCallTime = Date.now();
          engine.apiCallCount++;
          engine.totalResponseTimeMs += Date.now() - start;
          clearRateLimitBackoff(engine);
          return resp;
        } catch (err) {
          engine.lastApiCallTime = Date.now();
          if (isRateLimitError(err)) recordRateLimit(engine);
          throw err;
        }
      }
    : undefined;

  // ── Cross-respond with per-turn validation + retry loop ──
  const knownIds = engine.getKnownNodeIds();
  const vConfig = resolveTurnValidationConfig(engine.config.turnValidation);

  // Pre-check generate uses the same adapter but with the pre-check model
  const boundStageGenerate = engine.stageGenerate.bind(engine);
  const preCheckGenerate = !vConfig.skipPreCheck
    ? boundStageGenerate
    : undefined;

  // Inject pre-check config into pipeline input
  pipelineInput.preCheckModel = vConfig.preCheckModel;
  pipelineInput.skipPreCheck = vConfig.skipPreCheck;

  const retryCallbacks: TurnRetryCallbacks = {
    runPipeline: (input) => runTurnPipeline(
      input, boundStageGenerate,
      (_stage, label) => engine.progress('generating', responder, label),
      envelopeGenerate,
      preCheckGenerate,
    ),
    assembleResult: (result) => assemblePipelineResult(result, knownIds),
    callJudge: (p, l) => engine.generateWithModel(p, l, vConfig.judgeModel, JUDGE_TIMEOUT_MS),
    callJudgeFallback: engine.config.model !== vConfig.judgeModel
      ? (p, l) => engine.generateWithModel(p, l, engine.config.model, JUDGE_TIMEOUT_MS)
      : undefined,
  };

  const retryInput: TurnRetryInput = {
    pipelineInput,
    validationConfig: engine.config.turnValidation,
    model: resolveModelForSpeaker(engine, responder),
    speaker: responder,
    round,
    priorTurns: engine.session.transcript
      .filter(e => e.speaker === responder && e.type !== 'opening')
      .slice(-2),
    recentTurns: engine.session.transcript
      .filter(e => e.speaker !== 'system' && e.speaker !== 'user')
      .slice(-2),
    knownNodeIds: engine.getKnownNodeIds(),
    policyIds: engine.getPolicyIds(),
    audience: engine.config.audience,
    pendingIntervention: activeIntervention,
  };

  engine.checkAborted();
  getGlobalRecorder()?.setEventContext({
    debate_id: engine.session.id,
    run_id: engine.session.run_id,
    speaker: responder,
    phase,
    round,
    turn_index: engine.session.transcript.length,
  });
  const turnResult = await engine.executeWithModelFailover(responder, async (model) => {
    pipelineInput.model = model;
    retryInput.model = model;
    return executeTurnWithRetry(retryInput, retryCallbacks);
  });
  let { statement, taxonomyRefs, meta, validation, attempts, pipelineResult } = turnResult;
  enrichTaxonomyRefs(engine, taxonomyRefs);

  // ── Over-generate/select/rewrite pipeline (t/1581) ──
  let overgenDiagnostics: OvergenDiagnostics | undefined;
  let overgenCoherenceMiss = false;
  if (engine.config.experiment_overgen_select_rewrite && engine.config.embedFn) {
    try {
      const draftDiagnostic = pipelineResult.stage_diagnostics.find(s => s.stage === 'draft');
      const draftPromptText = draftDiagnostic?.prompt;
      const draftModel = engine.config.stageModels?.draft ?? resolveModelForSpeaker(engine, responder);
      const draftTemp = engine.config.temperature ?? DEFAULT_TEMPERATURE;

      if (draftPromptText) {
        const embedFn = engine.config.embedFn;
        const draftFn = async () => {
          const raw = await engine.stageGenerate(
            draftPromptText, draftModel,
            { temperature: draftTemp },
            `${responder} overgen-draft`,
          );
          const parsed = parseJsonRobust(raw) as Record<string, unknown>;
          return {
            statement: (parsed.statement as string) ?? '',
            turn_symbols: Array.isArray(parsed.turn_symbols) ? parsed.turn_symbols : [],
            claim_sketches: Array.isArray(parsed.claim_sketches) ? parsed.claim_sketches : [],
            key_assumptions: Array.isArray(parsed.key_assumptions) ? parsed.key_assumptions : [],
            disagreement_type: (parsed.disagreement_type as string) ?? '',
          } as DraftWorkProduct;
        };

        const rewriteGenerateFn = async (prompt: string) =>
          engine.stageGenerate(prompt, draftModel, { temperature: draftTemp }, `${responder} overgen-rewrite`);

        const poverInfo = engine.getSoulForSpeaker(responder);
        const overgenResult = await runOvergenPipeline(
          draftFn, rewriteGenerateFn, embedFn,
          {
            speaker: responder,
            existingNodes: engine.session.argument_network?.nodes ?? [],
            existingEdges: engine.session.argument_network?.edges ?? [],
            cruxes: engine.session.crux_tracker,
            label: poverInfo.label,
            pov: poverInfo.pov,
            topic: engine.session.topic.final,
            recentTranscript: formatRecentTranscript(engine.session.transcript, OVERGEN_TRANSCRIPT_WINDOW_TURNS, engine.session.context_summaries),
            audience: engine.config.audience,
            currentCruxContext: engine.session.crux_tracker?.length
              ? engine.session.crux_tracker.map(c => `- ${c.description} [${c.state}]`).join('\n')
              : undefined,
            topicScope: engine.session.topic.scope,
          },
        );

        overgenDiagnostics = overgenResult.diagnostics;
        overgenCoherenceMiss = overgenResult.coherence_gate_miss;
        if (overgenCoherenceMiss) engine._overgenCoherenceGateMiss = true;
        statement = overgenResult.draft.statement;

        getGlobalRecorder()?.record({
          type: 'system.info', component: 'overgen-pipeline', level: 'info',
          speaker: responder, debate_id: engine.session?.id,
          message: `Over-gen pipeline complete: ${overgenResult.diagnostics.claims_pooled} pooled → ${overgenResult.diagnostics.claims_after_dedup} deduped → ${overgenResult.diagnostics.claims_selected} selected`,
          data: overgenResult.diagnostics as unknown as Record<string, unknown>,
        });
      }
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'overgen-pipeline', level: 'warn',
        debate_id: engine.session?.id, speaker: responder,
        message: 'Over-gen pipeline failed — using original draft',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }
  }

  // Update per-speaker hint streaks for hopeless hint suppression.
  // Uses the final validation's repairHints — these are the hints that persisted
  // through all retry attempts (i.e., the model couldn't fix them).
  engine.updateHintStreaks(responder, validation.repairHints ?? []);

  // Extract caveats: all validation hints + ungrounded claims.
  // Surfaced to readers as "Caveats" alongside the statement.
  const caveats = [...(validation.repairHints ?? [])];

  // Add ungrounded claims from the evidence work product
  const evidenceDiagForCaveats = pipelineResult.stage_diagnostics.find(s => s.stage === 'evidence');
  const ungroundedClaims = (evidenceDiagForCaveats?.work_product as Record<string, unknown>)?.ungrounded_claims as
    Array<{ claim: string; reason: string }> | undefined;
  if (ungroundedClaims?.length) {
    for (const uc of ungroundedClaims) {
      caveats.push(`[Ungrounded] ${uc.claim}`);
    }
  }

  // Draft scope boundary check (t/451): flag when draft drifts into excluded scope
  let scopeDriftWarnings: { debater: string; node_id: string; similarity: number; draft_excerpt: string }[] | undefined;
  let scopeDriftCheck: EntryDiagnostics['scope_drift_check'] | undefined;
  const adapterForScope = engine.adapter as ExtendedAIAdapter;
  if (adapterForScope.computeQueryEmbedding && statement) {
    try {
      const { vector: draftVec } = await adapterForScope.computeQueryEmbedding(statement.slice(0, 500));
      if (draftVec?.length) {
        const refIds = taxonomyRefs.map(r => r.node_id);
        const refsWithExclusionVector = refIds.filter(id => (engine.taxonomy.embeddings[id] as { exclusion_vector?: number[] })?.exclusion_vector).length;
        const warnings = checkDraftScopeBoundary(
          draftVec, refIds, engine.taxonomy.embeddings, responder, statement,
        );
        scopeDriftCheck = {
          checked: true,
          refs_checked: refIds.length,
          refs_with_exclusion_vector: refsWithExclusionVector,
          warnings: warnings,
          threshold: SCOPE_BOUNDARY_THRESHOLD,
        };
        if (warnings.length > 0) {
          scopeDriftWarnings = warnings;
          for (const w of warnings) {
            caveats.push(`[Scope drift] Draft may overlap excluded scope of ${w.node_id} (similarity=${w.similarity.toFixed(2)})`);
          }
          getGlobalRecorder()?.record({
            type: 'turn.scope_drift', component: 'debate-engine', level: 'warn',
            speaker: responder, debate_id: engine.session?.id,
            message: `${warnings.length} scope drift warning(s)`,
            data: { warnings },
          });
        }
      }
    } catch { /* scope check is advisory — never block turn commit */ }
  }

  const entry = engine.addEntry({
    type: 'statement',
    speaker: responder,
    content: statement,
    taxonomy_refs: taxonomyRefs,
    policy_refs: meta.policy_refs,
    addressing: addressing as SpeakerId | 'all',
    caveats: caveats.length > 0 ? caveats : undefined,
    model: engine.config.speakerModels ? resolveModelForSpeaker(engine, responder) : undefined,
    provider_model: engine.adapter.lastProviderModel,
    metadata: {
      cross_respond: true,
      round,
      focus_point: focusPoint,
      addressing_label: addressing,
      move_types: meta.move_types,
      disagreement_type: meta.disagreement_type,
      my_claims: meta.my_claims,
      key_assumptions: meta.key_assumptions?.length ? meta.key_assumptions : undefined,
      turn_symbols: meta.turn_symbols,
      injection_manifest: engine._lastInjectionManifest ?? undefined,
      debate_phase: phase,
      position_update: meta.position_update,
      turn_validation_outcome: validation.outcome,
      turn_validation_score: validation.process_reward,
      turn_validation_attempts: attempts.length,
      turn_validation_flagged: validation.outcome === 'accept_with_flag' ? true : undefined,
      concession_candidates_offered: concessionCandidateIds.length > 0 ? concessionCandidateIds : undefined,
      concession_considered: (meta as Record<string, unknown>)?.concession_considered as string | undefined,
      anticipated_responses: pipelineResult.plan.anticipated_responses?.length
        ? pipelineResult.plan.anticipated_responses : undefined,
      ignored_evidence_doc_ids: pipelineResult.ignoredEvidenceDocIds,
    },
    degraded: pipelineResult.degraded_turn,
  });

  // ── Talmudic reference response + dialectical diagnostic record ──
  if (dialecticalDiag) {
    let referenceSelection: import('../../types.js').DialecticalDiagnosticRecord['reference_selection'];
    if (_talmudicSelection?.selected_card) {
      const rawResponse = pipelineResult.draft.talmudic_reference_response;
      const validatedResponse = validateTalmudicReferenceResponse(rawResponse, _talmudicSelection, statement);
      (entry.metadata as Record<string, unknown>).talmudic_reference_response = validatedResponse;
      referenceSelection = {
        selected_card: _talmudicSelection.selected_card,
        response: validatedResponse,
        moderator_entry_id: _talmudicCardEntryId,
        responding_entry_id: entry.id,
      };
    } else if (_talmudicSelection) {
      referenceSelection = { selected_card: undefined };
    }
    engine.session.dialectical_diagnostics ??= [];
    engine.session.dialectical_diagnostics.push({
      round,
      moderator_mode: engine.config.moderatorMode ?? 'talmudic',
      moderator_entry_id: modEntry.id,
      focused_crux: dialecticalDiag.focused_crux,
      disagreement_type: dialecticalDiag.disagreement_type,
      premise_under_examination: dialecticalDiag.premise_under_examination,
      distinction_or_analogy_tested: dialecticalDiag.distinction_or_analogy_tested,
      unresolved_outcome: dialecticalDiag.unresolved_outcome,
      reference_selection: referenceSelection,
    });
  }

  // Compute per-(frame,turn) cosine similarity series for frame survival metrics — t/2045
  if (engine.session.frame_embeddings && Object.keys(engine.session.frame_embeddings).length > 0) {
    try {
      const { computeEmbeddings } = await import('../../../embeddings/onnxEmbedding.js');
      const paras = entry.content.split(/\n\n+/).filter(p => p.trim().length > 0);
      const paraVecs = paras.length > 0 ? await computeEmbeddings(paras) : [];
      engine.session.frame_similarity_series ??= {};
      for (const [speakerKey, frameData] of Object.entries(engine.session.frame_embeddings)) {
        engine.session.frame_similarity_series[speakerKey] ??= frameData.frames.map(f => ({ frame: f.frame, sims: {} as Record<string, number> }));
        const series = engine.session.frame_similarity_series[speakerKey];
        for (let fi = 0; fi < frameData.frames.length; fi++) {
          const fv = frameData.frames[fi].embedding;
          let maxSim = 0;
          for (const pv of paraVecs) {
            if (pv.length !== fv.length) continue;
            let dot = 0, na = 0, nb = 0;
            for (let i = 0; i < fv.length; i++) { dot += fv[i] * pv[i]; na += fv[i] * fv[i]; nb += pv[i] * pv[i]; }
            const d = Math.sqrt(na) * Math.sqrt(nb);
            const s = d > 0 ? dot / d : 0;
            if (s > maxSim) maxSim = s;
          }
          // Only write when ≥1 paragraph was actually compared — guards empty content and full dim-mismatch
          const anyCompared = paraVecs.some(pv => pv.length === fv.length);
          if (series[fi] && anyCompared) series[fi].sims[entry.id] = maxSim;
        }
      }
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: engine.session?.id, message: 'Frame similarity series update failed', error: { name: (err as Error).name ?? 'Error', message: String(err) } });
    }
  }

  // h3: similarity of this turn to the speaker's own camp narrative (drift from the opening baseline)
  await updateNarrativeSimilarity(engine, entry);

  // Accumulate context manifest for taxonomy gap analysis
  accumulateContextManifest(engine, round, responder, info.pov, taxonomyRefs.map(r => r.node_id));

  engine.session.turn_validations ||= {};
  engine.session.turn_validations[entry.id] = { attempts, final: validation };

  if (validation.clarifies_taxonomy.length > 0) {
    routeTurnValidatorHints(engine, validation, entry.id);
  }

  const draftDiag = pipelineResult.stage_diagnostics.find(s => s.stage === 'draft');
  engine.recordDiagnostic(entry.id, {
    prompt: draftDiag?.prompt ?? '',
    raw_response: draftDiag?.raw_response ?? '',
    model: resolveModelForSpeaker(engine, responder),
    response_time_ms: pipelineResult.total_time_ms,
    taxonomy_context: taxonomyContext,
    commitment_context: commitmentContext,
    stage_diagnostics: pipelineResult.stage_diagnostics,
    edges_used: responderEdgesUsed,
    topic_alignment: pipelineResult.topicAlignmentResult
      ? {
          topic_aligned: pipelineResult.topicAlignmentResult.topic_aligned,
          repaired: pipelineResult.topicAlignmentResult.repaired || undefined,
          draft_attempt: (pipelineResult.topicAlignmentResult as Record<string, unknown>).draft_attempt as number | undefined,
          scope_used: engine.session.topic.scope ?? null,
        }
      : undefined,
    quality_gate: pipelineResult.qualityGateResult,
    scope_drift_warnings: scopeDriftWarnings,
    scope_drift_check: scopeDriftCheck,
    overgen: overgenDiagnostics,
  });

  // Drift telemetry shadow log (t/3603) — observations only, no behaviour change
  {
    const qr = pipelineResult.qualityGateResult;
    let quality_action: DriftTelemetryEntry['quality_action'];
    if (!qr) {
      quality_action = 'no_gate';
    } else if (!qr.post_repair) {
      quality_action = 'accepted';
    } else {
      quality_action =
        qr.repair_outcome === 'fixed' ? 'repair_fixed' :
        qr.repair_outcome === 'partial' ? 'repair_partial' :
        'repair_unchanged';
    }

    // Token sum: add input+output per stage; null only when zero stages have usage data
    let tokenSum = 0;
    let stagesWithUsage = 0;
    for (const d of pipelineResult.stage_diagnostics) {
      const diag = d as Record<string, unknown>;
      const inp = typeof diag.input_tokens === 'number' ? diag.input_tokens : 0;
      const out = typeof diag.output_tokens === 'number' ? diag.output_tokens : 0;
      if (typeof diag.input_tokens === 'number' || typeof diag.output_tokens === 'number') {
        stagesWithUsage++;
      }
      tokenSum += inp + out;
    }

    // crux_engaged: last convergence signal for this speaker (pushed by claimExtractionPipeline)
    const lastConvSig = engine.session.convergence_signals?.slice(-1)[0];
    const crux_engaged = lastConvSig?.crux_engagement_rate.used_this_turn ?? null;

    const entry: DriftTelemetryEntry = {
      round,
      speaker: responder,
      quality_action,
      topic_aligned: pipelineResult.topicAlignmentResult?.topic_aligned ?? null,
      alignment_repair_triggered: pipelineResult.topicAlignmentResult?.repaired ?? false,
      crux_engaged,
      tokens_total: stagesWithUsage > 0 ? tokenSum : null,
      latency_ms_total: pipelineResult.total_time_ms,
      topical_state: null,   // populated by CL's t/3630 estimator when it ships
      topical_drift_score: null,
    };
    (engine.session.drift_telemetry ??= []).push(entry);
  }

  // Track move types and disagreement types
  if (meta.move_types) {
    for (const m of meta.move_types) {
      const name = getMoveName(m);
      engine.session.diagnostics!.overview.move_type_counts[name] = (engine.session.diagnostics!.overview.move_type_counts[name] ?? 0) + 1;
    }
  }
  if (meta.disagreement_type) {
    engine.session.diagnostics!.overview.disagreement_type_counts[meta.disagreement_type] =
      (engine.session.diagnostics!.overview.disagreement_type_counts[meta.disagreement_type] ?? 0) + 1;
  }

  // Track situation citation rate (t/192)
  engine.updateSituationCitations(taxonomyRefs);

  // Extract claims
  engine.checkAborted();
  const anNodesBefore = engine.session.argument_network!.nodes.length;
  await engine._claimPipeline.extractClaims(statement, responder, entry.id, taxonomyRefs.map(r => r.node_id), meta.my_claims);
  const newNodes = engine.session.argument_network!.nodes.slice(anNodesBefore);

  // Conditional AN linkage: if debater confirmed a REVOICE, add the
  // revoiced text as a linked node with a revoice_of edge.
  if (activeIntervention?.move === 'REVOICE' || activeIntervention?.move === 'CHECK') {
    const revoiceResp = (meta as Record<string, unknown>).revoice_response as { accurate?: boolean } | undefined;
    if (revoiceResp?.accurate === true && activeIntervention.original_claim_text && activeIntervention.text) {
      const an = engine.session.argument_network!;
      const revoiceNodeId = `revoice-${an.nodes.length}`;
      const revoiceNode: import('../../types.js').ArgumentNetworkNode = {
        id: revoiceNodeId,
        text: activeIntervention.text,
        speaker: 'system' as import('../../types.js').SpeakerId,
        source_entry_id: entry.id,
        taxonomy_refs: [],
        turn_number: round,
      };
      const originalNodeId = an.nodes.find(n => n.text === activeIntervention!.original_claim_text)?.id;
      if (originalNodeId) {
        an.nodes.push(revoiceNode);
        an.edges.push({
          id: `${revoiceNodeId}-revoice-${originalNodeId}`,
          source: revoiceNodeId,
          target: originalNodeId,
          type: 'revoice_of',
          weight: 1.0,
        });
        getGlobalRecorder()?.record({
          type: 'debate.moderate', component: 'revoice-linkage', level: 'info',
          message: `REVOICE confirmed: linked ${revoiceNodeId} → ${originalNodeId}`,
        });
      }
    }
  }

  // Lookahead gate: evaluate move quality of extracted claims (t/21)
  if (newNodes.length > 0) {
    const lookaheadStart = Date.now();
    try {
      const anNow = engine.session.argument_network!;
      const existingNodes = anNow.nodes.slice(0, anNodesBefore);
      const existingEdges = anNow.edges.filter(e => {
        const newIds = new Set(newNodes.map(n => n.id));
        return !newIds.has(e.source) && !newIds.has(e.target);
      });
      const tentativeEdges = anNow.edges.filter(e => {
        const newIds = new Set(newNodes.map(n => n.id));
        return newIds.has(e.source) || newIds.has(e.target);
      });
      const gateResult = evaluateLookahead({
        speaker: responder,
        existingNodes,
        existingEdges,
        tentativeClaims: newNodes.map(n => ({ text: n.text, base_strength: n.base_strength ?? 0.5 })),
        tentativeEdges,
        cruxes: engine.session.crux_tracker,
      });
      const lookaheadDiag: LookaheadDiagnostics = {
        stage: 'lookahead',
        first_attempt: gateResult,
        regen_triggered: false,
        final_pass: gateResult.pass,
        elapsed_ms: Date.now() - lookaheadStart,
      };
      engine.recordDiagnostic(entry.id, { lookahead: lookaheadDiag });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: engine.session?.id, message: 'Lookahead gate failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      engine.warn('Lookahead gate', err, 'Lookahead evaluation skipped — does not affect debate flow');
    }
  }

  // Post-extraction interventions (non-blocking)
  if (newNodes.length > 0) {
    engine._claimPipeline.validateSteelmans(newNodes, responder).catch(err => engine.warn('Steelman validation', String(err), 'Steelman check skipped'));
    // t/1781: non-awaited (latency stays off the turn path) but tracked so the
    // completion path can settle it before the calibration extract. .catch()
    // makes the tracked promise resolve on failure (no unhandled rejection).
    engine._pendingClaimVerifications.push(engine._claimPipeline.verifyPreciseClaims(newNodes).catch(err => { engine.warn('Precise claims', String(err), 'Precision check skipped'); }));
  }

  // Position drift detection (non-blocking)
  engine._claimPipeline.trackPositionDrift(responder, statement, round).catch(err => engine.warn('Position drift', String(err), 'Drift tracking skipped'));
  engine._claimPipeline.trackPerClaimDrift(responder, round).catch(err => engine.warn('Per-claim drift', String(err), 'Per-claim drift tracking skipped'));

  // Post-turn summarization (DT-2)
  engine.summarizeEntry(entry).catch(err => engine.warn('Summarization', String(err), 'Entry summarization skipped'));

  // ── Update active moderator state for next round ──
  if (engine.session.crux_tracker && engine.session.crux_tracker.length > 0) {
    updateCruxEngagement(engine._moderatorState!, engine.session.crux_tracker as unknown as ReadonlyArray<{ id: string; speakers_involved: SpeakerId[]; attacking_claim_ids: string[] }>, engine.config.activePovers, an!.nodes);
  }
  const validationResult = activeIntervention
    ? { proceed: true, validated_move: activeIntervention.move, validated_family: activeIntervention.family, validated_target: activeIntervention.target_debater } as import('../../types.js').EngineValidationResult
    : { proceed: false, validated_move: 'PIN' as InterventionMove, validated_family: 'elicitation' as import('../../types.js').InterventionFamily, validated_target: responder } as import('../../types.js').EngineValidationResult;
  updateModeratorState(engine._moderatorState!, activeIntervention, validationResult, round, phase);
  engine.session.moderator_state = engine._moderatorState!;

  pruneSessionData(engine.session);
  pruneModeratorState(engine._moderatorState!);
}
