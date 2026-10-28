// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { StateCreator } from 'zustand';
import type { DebateStore } from '../types';
import type { ReflectionEdit, ReflectionResult } from '../types';
import { formatGapHint } from '../shared/prompts';
import { seatSouls } from '../shared/seatSouls';
import type {
  DebateSession,
  SpeakerId,
  TranscriptEntry,
  ArgumentNetworkNode,
  ArgumentNetworkEdge,
  GapInjection,
  CrossCuttingProposal,
} from '../../../types/debate';
import { POVER_INFO, AI_POVERS, POV_KEYS } from '../../../types/debate';
import type { PovNode, CrossCuttingNode as SituationNode, GraphAttributes, Category, Pov } from '../../../types/taxonomy';
import type { ModeratorState, SelectionResult, ModeratorIntervention, InterventionMetadata, DebatePhase } from '@lib/debate/types';
import type { PoverResponseMeta, MoveAnnotation } from '@lib/debate/helpers';
import type { PhaseState, PhaseTransitionConfig, SignalContext, Signal } from '@lib/debate/types';
import type { ProcessRewardEntry, GapArgument } from '@lib/debate/types';
import type { ModeratorSelectionCallbacks, ModeratorSelectionInput, TurnRetryCallbacks, TurnRetryInput } from '@lib/debate/orchestration';
import type { TurnPipelineInput } from '@lib/debate/turnPipeline';
import type { TurnAttempt, TurnValidation, TurnValidationTrail, TaxonomySuggestion } from '../../../types/debate';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { trackDebateTurn, trackDebateExtraction } from '../../../lib/analyticsEmitter';
import { triggerManualDump } from '../../../lib/flightRecorderInit';
import { generateId, nowISO, stripCodeFences, parseAIJson, parseAtMention, formatRecentTranscript, parsePoverResponse, hashString, looksTruncated, defaultGraphAttributes } from '@lib/debate/helpers';
import { getMoveName, SUPPORT_MOVES } from '@lib/debate/helpers';
import { formatTaxonomyContext } from '../../../utils/taxonomyContext';
import { formatArgumentNetworkContext, formatCommitments, formatEstablishedPoints, updateUnansweredLedger, formatConcessionCandidatesHint, computeClaimTaxonomyAttribution } from '../../../prompts/argumentNetwork';
import { formatVocabularyContext } from '@lib/debate/vocabularyContext';
import {
  debateResponsePrompt,
  crossRespondPrompt,
  reflectionPrompt,
  dolceComplianceRetryPrompt,
  midDebateGapPrompt,
  crossCuttingNodePrompt,
} from '../../../prompts/debate';
import { checkDolceCompliance } from '../../../utils/dolceCompliance';
import { nodeTypeFromId } from '@lib/debate/nodeIdUtils';
import { computeQbafStrengths } from '@lib/debate/qbaf';
import type { QbafNode, QbafEdge } from '@lib/debate/qbaf';
import { factCheckToBaseStrength } from '@lib/debate/argumentNetwork';
import { needsGc, pruneArgumentNetwork, GC_TRIGGER, GC_TARGET } from '@lib/debate/networkGc';
import { getDebatePhase } from '@lib/debate/types';
import { resolveTurnValidationConfig } from '@lib/debate/turnValidator';
import { computeConvergenceSignals } from '@lib/debate/convergenceSignals';
import { computeProcessReward } from '@lib/debate/processReward';
import { updateCruxTracker } from '@lib/debate/cruxResolution';
import { computeTaxonomyGapAnalysis } from '@lib/debate/taxonomyGapAnalysis';
import {
  updateModeratorState,
  MOVE_RESPONSE_CONFIG,
  DIRECT_RESPONSE_PATTERNS,
  computeDebateHealthScore,
} from '@lib/debate/moderator';
import { runModeratorSelection, executeTurnWithRetry } from '@lib/debate/orchestration';
import { pruneSessionData, pruneModeratorState } from '@lib/debate/sessionPruning';
import {
  loadProvisionalWeights,
  initPhaseState,
  evaluatePhaseTransition,
  advanceRound,
  applyTransition,
  buildSignalRegistry,
  computeSaturationScore,
  computeConvergenceScore,
  detectCruxNodes,
  buildPhaseContext,
  buildSignalTelemetry,
  initAdaptiveDiagnostics, effectiveRoundCap,
} from '@lib/debate/phaseTransitions';
import { runTurnPipeline, assemblePipelineResult } from '@lib/debate/turnPipeline';
import { evaluateLookaheadPerClaim, buildClaimAnalysis } from '@lib/debate/lookaheadGate';
import type { LookaheadDiagnostics, LookaheadGateResult, ClaimAnalysis, PerClaimResult } from '@lib/debate/lookaheadGate';
import { shouldRunGapCheck, findUnengagedHighRelevanceNodes, collectEngagedNodeIds, MAX_GAP_INJECTIONS } from '@lib/debate/gapCheck';
import { computeBeliefConfidence } from '@lib/debate/beliefConfidence';
import { computeTreePriority } from '@lib/debate/desirePriority';
import { computeOperationality } from '@lib/debate/intentionOperationality';
import { useTaxonomyStore } from '../../useTaxonomyStore';
import { usePromptConfigStore } from '../../usePromptConfigStore';
import { mapErrorToUserMessage } from '../../../utils/errorMessages';
import { classifyAiRetry, parseRetryAfterMs } from '../../../utils/retryClassifier';
import { cosineSimilarity, scoreNodesLexical } from '../../../utils/taxonomyRelevance';
import { getConfiguredModel, getSpeakerModel } from '../shared/modelConfig';
import { generateTextWithProgress, phaseGuardedSet, summarizeTranscriptEntry, makeStageGenerate, servedTurnRecorder, routeTurnValidatorHintsIntoSuggestions, getSourceEvidenceIndex, getDocTitles } from '../shared/generation';
import { createDebateGuard, newAbortController, _abortController, claimDebateDriver, releaseDebateDriver, isDailyLimitError, DAILY_LIMIT_MESSAGE, isCancellationError } from '../shared/guards';
import { pushWarning, recordDiagnostic, recordSignalHistory, getSignalValue, movingAverageSignal, incrementGapInjectionCount, _gapInjectionCount } from '../shared/diagnostics';
import { runNeutralCheckpoint } from '../shared/neutralCheckpoint';
import { updateNarrativeSimilarity } from '../shared/narrativeVoicing';
import { enrichPolicyRefs, serializeNodeSourceMap, formatEdgeContext, formatDebaterEdgeContext, getRelevantTaxonomyContext, getAllKnownNodeIds, getSelectableNodeIds, getAllPolicyIds, findNodeMetaInStore, getTaxonomyContext } from '../shared/taxonomyContext';
import { extractClaimsAndUpdateAN, commitAnNodes, detectZeroClaims } from '../shared/argumentNetwork';

export interface DebatePhaseSlice {
  _crossRespondLeased: () => Promise<void>; // the unguarded turn body; call `crossRespond` (runLeaseSlice, t/3917), never this
}

function resolveEngineValidation(
  modResult: _ModResult,
  intervention: _ModResult['intervention'],
  selectionResult: SelectionResult | null,
  responderPover: _AiPover,
): import('@lib/debate/types').EngineValidationResult {
  return modResult.engineValidation
    ?? (intervention
      ? { proceed: true, validated_move: intervention.move, validated_family: intervention.family, validated_target: intervention.target_debater } as import('@lib/debate/types').EngineValidationResult
      : { proceed: false, validated_move: (selectionResult?.suggested_move ?? 'PIN') as import('@lib/debate/types').InterventionMove, validated_family: 'elicitation' as import('@lib/debate/types').InterventionFamily, validated_target: responderPover } as import('@lib/debate/types').EngineValidationResult);
}

export const createDebatePhaseSlice: StateCreator<DebateStore, [], [], DebatePhaseSlice> = (set, get) => ({
  _crossRespondLeased: async () => {

    const { activeDebate, addTranscriptEntry, saveDebate } = get();
    if (!activeDebate) {
      getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'warn', message: 'crossRespond called with no activeDebate — exiting' });
      return;
    }
    if (!claimDebateDriver()) {
      set({ debateError: 'Another window is already running this debate.' });
      getGlobalRecorder()?.record({ type: 'lifecycle', component: 'debate-store', level: 'warn', debate_id: activeDebate.id, message: 'Debate driver claim denied — another window owns it' });
      return;
    }
    getGlobalRecorder()?.record({ type: 'debate.round', component: 'debate-store', level: 'debug', debate_id: activeDebate?.id, message: 'crossRespond entered', data: { protocol_id: activeDebate?.protocol_id, phase: activeDebate?.phase, transcript_length: activeDebate?.transcript.length, adaptive_phase: activeDebate?.adaptive_staging?.phase_state?.current_phase } });

    // Guard: if openings completed but abort guard prevented phase transition, fix it now
    fixOpeningPhaseTransition(activeDebate, get);

    newAbortController();
    const isStillValid = createDebateGuard(get);
    set({ debateError: null, debateWarnings: [] });

    // Lazy-load edges for moderator context
    await ensureEdgesLoaded();

    const model = getConfiguredModel();
    const topic = activeDebate.topic.final;
    const aiPovers = AI_POVERS.filter((p) => activeDebate.active_povers.includes(p));

    if (aiPovers.length < 2) {
      releaseDebateDriver();
      set({ debateError: 'Need at least 2 AI debaters for cross-response' });
      getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'warn', debate_id: activeDebate.id, message: 'crossRespond exiting — fewer than 2 AI debaters', data: { aiPovers: aiPovers.length } });
      return;
    }

    const recentTranscript = formatRecentTranscript(activeDebate.transcript, 8, activeDebate.context_summaries);
    const poverLabels = aiPovers.map((p) => POVER_INFO[p].label);

    // Bypass moderator when debate is already terminated/closed — pick missing debater directly
    if (await runPostTerminationTurn(activeDebate, aiPovers, topic, model, get, set, isStillValid, addTranscriptEntry, saveDebate)) return;

    // Step 1: Active moderator — delegate to shared orchestration
    set({ debateGenerating: 'system' as SpeakerId, debateActivity: 'Moderator selection...', debateStepStartedAt: Date.now() });

    const { crossRespondRound, phase, totalRoundsForPhase } = computeRoundAndPhase(activeDebate, aiPovers, get, set);

    const sourceDocSummary = activeDebate.document_analysis?.claims_summary
      ?? (activeDebate.source_content ? activeDebate.source_content.slice(0, 2000) : undefined);

    const selectionCallbacks: ModeratorSelectionCallbacks = {
      generate: async (prompt, _model, _options, label) => {
        const { text } = await generateTextWithProgress(prompt, model, label, set);
        return text;
      },
      addEntry: (entry) => addTranscriptEntry(entry),
      progress: (_phase, _speaker, message) => set({ debateActivity: message ?? null }),
      warn: (context, err, _recovery) => console.warn(`[Moderator] ${context}:`, err),
      formatEdgeContext: (activeLabels) => ({ text: formatEdgeContext(activeLabels) }),
      isAborted: () => !isStillValid(),
    };

    const selectionInput: ModeratorSelectionInput = {
      round: crossRespondRound,
      phase,
      activePovers: aiPovers,
      totalRounds: totalRoundsForPhase * 3,
      model,
      audience: activeDebate.audience,
      sourceDocSummary,
      transcript: activeDebate.transcript,
      contextSummaries: activeDebate.context_summaries,
      argumentNetwork: activeDebate.argument_network ?? undefined,
      convergenceSignals: activeDebate.convergence_signals,
      unansweredLedger: activeDebate.unanswered_claims_ledger,
      gapInjections: activeDebate.gap_injections,
      commitments: activeDebate.commitments,
      existingModState: activeDebate.moderator_state,
      poverInfo: POVER_INFO as Record<string, { label: string; pov: string; personality?: string }>,
    };

    const modResult = await runModeratorStep(selectionInput, selectionCallbacks, activeDebate, crossRespondRound, phase, isStillValid, get, set, saveDebate);
    if (!modResult) return;

    const responderPover = modResult.responder;
    const focusPoint = modResult.focusPoint;
    const addressingLabel = modResult.addressing;
    const intervention = modResult.intervention;
    const interventionBriefInjection = modResult.interventionBriefInjection;
    const healthScore = modResult.healthScore;
    const selectionResult = modResult.selectionResult as SelectionResult | null;

    // Update moderator state after selection/intervention
    const modState = modResult.modState;
    const engineValidation = resolveEngineValidation(modResult, intervention, selectionResult, responderPover);
    updateModeratorState(modState, intervention, engineValidation, crossRespondRound, phase);
    getGlobalRecorder()?.record({ type: 'debate.moderate', component: 'moderator', level: 'info', debate_id: activeDebate.id, message: intervention ? `Moderator intervention: ${intervention.move}` : `Moderator selected: ${responderPover}`, data: { responder: responderPover, intervention_move: intervention?.move ?? null, budget_remaining: modState.budget_remaining, health_score: healthScore?.value, health_trend: healthScore?.trend } });

    // Persist moderator state on the session
    persistModeratorStateUpdate(get, set, modState);

    const moderatorTrace = buildModeratorTrace(activeDebate, aiPovers, responderPover, focusPoint, modResult, modState, engineValidation, selectionResult, healthScore);

    // Step 2: Generate the cross-response
    const { info, ctx, taxonomyBlock, commitBlock, concessionCandidateIds, pipelineInput, stageGenerate } =
      await buildTurnPipelineContext(responderPover, activeDebate, topic, model, intervention, interventionBriefInjection, focusPoint, addressingLabel, phase, get, set);

    try {

      // ── Per-turn validation + retry loop ──
      const activeSnapshot = get().activeDebate;
      const vConfig = resolveTurnValidationConfig(undefined);

      const retryCallbacks: TurnRetryCallbacks = {
        runPipeline: (input) => runTurnPipeline(
          input, stageGenerate,
          (_stage, label) => set({ debateActivity: label }),
        ),
        assembleResult: (result) => assemblePipelineResult(result, getAllKnownNodeIds()),
        callJudge: async (jp: string, label: string) => {
          const r = await generateTextWithProgress(jp, vConfig.judgeModel, label, set);
          return r.text;
        },
        isAborted: () => !isStillValid(),
      };

      const retryInput: TurnRetryInput = {
        pipelineInput,
        model,
        speaker: responderPover,
        round: crossRespondRound,
        priorTurns: (activeSnapshot?.transcript ?? [])
          .filter(e => e.speaker === responderPover && e.type !== 'opening')
          .slice(-2),
        recentTurns: (activeSnapshot?.transcript ?? [])
          .filter(e => e.speaker !== 'system' && e.speaker !== 'user')
          .slice(-2),
        knownNodeIds: getAllKnownNodeIds(),
        policyIds: getAllPolicyIds(),
        audience: get().audience,
        pendingIntervention: intervention,
      };

      const turnResult = await executeTurnWithRetry(retryInput, retryCallbacks);
      if (turnResult.aborted) {
        getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'info', debate_id: activeDebate.id, message: 'crossRespond aborted post-turn — debate terminated during pipeline', data: { round: crossRespondRound, speaker: responderPover } });
        releaseDebateDriver(); return;
      }
      const { statement, taxonomyRefs, meta, validation, attempts, pipelineResult } = turnResult;

      // Enrich taxonomy refs with relevance scores from context injection
      enrichTaxonomyRefScores(ctx, taxonomyRefs);

      // Serialize source tracking for diagnostics display
      const relevanceSources = serializeNodeSourceMap(ctx.nodeSourceMap, taxonomyRefs);

      // Extract caveats: quality hints only, plus ungrounded claims from evidence stage
      const caveats = buildCaveatsFromValidation(validation, pipelineResult);

      addTranscriptEntry({
        type: 'statement',
        speaker: responderPover,
        content: statement,
        taxonomy_refs: taxonomyRefs,
        policy_refs: enrichPolicyRefs(meta.policy_refs, pipelineResult.draft as unknown as Record<string, unknown>),
        addressing: 'all',
        caveats,
        metadata: buildCrossRespondEntryMetadata(
          crossRespondRound, focusPoint, addressingLabel, moderatorTrace, meta as PoverResponseMeta & Record<string, unknown>,
          relevanceSources, validation, attempts, concessionCandidateIds, ctx,
        ),
      });

      trackDebateTurn(activeDebate.id, crossRespondRound, responderPover);

      // Persist validation trail + route clarifies_taxonomy hints
      persistValidationTrail(get, set, validation, attempts, get().activeDebate?.transcript.slice(-1)[0]?.id);

      await recordLastEntryDiagnosticsAndDrift(
        get().activeDebate?.transcript.slice(-1)[0],
        get, set, addTranscriptEntry, pipelineResult, model, taxonomyBlock, commitBlock,
        statement, responderPover, crossRespondRound, info, activeDebate,
        stageGenerate, pipelineInput, taxonomyRefs, meta,
      );
      // ── Neutral evaluation: midpoint checkpoint ──
      checkNeutralMidpointCheckpoint(get, set as any, addTranscriptEntry, crossRespondRound, activeDebate);

      await runGapInjectionCheck(get, set, addTranscriptEntry, activeDebate);
    } catch (err) {
      // User cancel / model switch (t/2508) — bail quietly, no error toast (helper logged info).
      if (isCancellationError(err)) { releaseDebateDriver(); set({ debateGenerating: null, debateActivity: null }); return; }
      handleTurnPipelineError(get, set, addTranscriptEntry, activeDebate, info, responderPover, crossRespondRound, err);
    }

    getGlobalRecorder()?.record({ type: 'debate.round', component: 'debate-store', level: 'debug', debate_id: activeDebate.id, message: `Cross-respond turn complete, entering post-processing`, data: { round: crossRespondRound, speaker: responderPover, transcript_length: get().activeDebate?.transcript.length } });

    runPostRoundProcessing(get, set, addTranscriptEntry, aiPovers, crossRespondRound);

    // Auto-probing disabled — probing questions are available on demand via requestProbingQuestions()

    releaseDebateDriver();
    set({ debateGenerating: null });
    getGlobalRecorder()?.record({ type: 'debate.round', component: 'debate-store', level: 'info', debate_id: activeDebate.id, message: `Cross-respond round ${crossRespondRound} end` , data: { round: crossRespondRound } });
    await saveDebate('crossRespond:end');
  },
});



// ── crossRespond decomposition helpers (t/1848): behavior-preserving extraction ──
type _Set = Parameters<StateCreator<DebateStore, [], [], DebatePhaseSlice>>[0];
type _Get = Parameters<StateCreator<DebateStore, [], [], DebatePhaseSlice>>[1];
type _AiPover = typeof AI_POVERS[number];
type _AddEntry = DebateStore['addTranscriptEntry'];
type _SaveDebate = DebateStore['saveDebate'];
type _PoverInfo = typeof POVER_INFO[_AiPover];
type _ModResult = Awaited<ReturnType<typeof runModeratorSelection>>;

// ── runPostRoundProcessing phase helpers (t/1848) ────────────────────
// runPostRoundProcessing was a single 73-complexity adaptive-staging hot-path.
// Its phases are extracted here as helpers (bodies moved verbatim; see ADR-007
// split pattern). ADR-003 record() calls stay inline in every catch. The
// adaptive_staging guard lives in runPostRoundProcessing; evaluateAdaptiveStaging
// runs only when it holds, so `!` non-null assertions there are sound.

function buildConcessionOpportunityCtx(lastConvSignal: any) {
  const co = lastConvSignal?.concession_opportunity;
  return { outcome: co?.outcome ?? 'none', strong_attacks_faced: co?.strong_attacks_faced ?? 0 };
}

function buildArgRedundancyCtx(signal: any) {
  const ar = signal?.argument_redundancy;
  return { avg_self_overlap: ar?.avg_self_overlap ?? 0, semantic_max_similarity: ar?.semantic_max_similarity };
}

function buildConvergenceSignalsCtx(lastConvSignal: any): SignalContext['convergenceSignals'] {
  return {
    argument_redundancy: buildArgRedundancyCtx(lastConvSignal),
    dialectical_engagement: { ratio: lastConvSignal?.dialectical_engagement?.ratio ?? 1 },
    position_drift: { drift: lastConvSignal?.position_drift?.drift ?? 0 },
    concession_opportunity: buildConcessionOpportunityCtx(lastConvSignal),
  };
}

/** Assemble the SignalContext from session data; also returns last-round claim count + last convergence signal. */
function buildPhaseSignalContext(
  postDebate: DebateSession,
  advanced: PhaseState,
  aiPovers: _AiPover[],
  crossRespondRound: number,
  an: { nodes: any[]; edges: any[] },
  recentConvSignals: any[],
): { signalCtx: SignalContext; lastClaimsAccepted: number; lastConvSignal: any } {
  const lastConvSignal = recentConvSignals.length > 0 ? recentConvSignals[recentConvSignals.length - 1] : null;
  const allStatements = postDebate.transcript
    .filter(e => e.type === 'statement' || e.type === 'opening')
    .map(e => {
      const meta = e.metadata as Record<string, unknown> | undefined;
      return {
        round: (meta?.round as number) ?? 0,
        speaker: e.speaker,
        text: e.content,
        extraction_status: 'ok' as const,
        claims_accepted: (meta?.extracted_claims_accepted as number) ?? 0,
        claims_rejected: 0,
        category_validity_ratio: 1.0,
      };
    });
  const lastRoundStatements = allStatements.filter(s => s.round === crossRespondRound);
  const lastClaimsAccepted = lastRoundStatements.reduce((sum, s) => sum + s.claims_accepted, 0);

  const signalCtx: SignalContext = {
    network: {
      nodes: an.nodes.map(n => ({
        id: n.id, speaker: n.speaker,
        computed_strength: n.computed_strength ?? 0.5,
        base_strength: n.base_strength,
        base_strength_category: n.bdi_category,
        argumentation_scheme: (an.edges.find(e => e.source === n.id))?.argumentation_scheme,
        taxonomy_refs: n.taxonomy_refs.map((id: unknown) => ({
          node_id: typeof id === 'string' ? id : (id as unknown as { node_id: string }).node_id,
          relevance: 'medium',
        })),
        turn_number: n.turn_number,
      })),
      edges: an.edges.filter(e => e.type === 'supports' || e.type === 'attacks').map(e => ({
        id: e.id, source: e.source, target: e.target, type: e.type as 'supports' | 'attacks',
        attack_type: e.attack_type, weight: e.weight ?? 0.5,
        scheme: e.scheme, argumentation_scheme: e.argumentation_scheme,
      })),
      nodeCount: an.nodes.length,
    },
    transcript: {
      currentRound: crossRespondRound,
      roundsInPhase: advanced.rounds_in_phase,
      activePovsCount: aiPovers.length,
      lastNRounds: (n: number) => {
        const maxRound = crossRespondRound;
        const minRound = Math.max(1, maxRound - n + 1);
        return allStatements.filter(s => s.round >= minRound && s.round <= maxRound);
      },
    },
    priorSignals: {
      get: (signalId: string, roundsBack: number) => getSignalValue(signalId, roundsBack),
      movingAverage: (signalId: string, windowSize: number) => movingAverageSignal(signalId, windowSize),
    },
    convergenceSignals: buildConvergenceSignalsCtx(lastConvSignal),
    processRewards: (postDebate.process_rewards ?? []).slice(-12).map(pr => ({
      round: pr.round, score: pr.score,
    })),
    phase: {
      current: advanced.current_phase,
      allPovsResponded: true,
      cruxNodes: detectCruxNodes(
        an.nodes.map(n => ({ id: n.id, speaker: n.speaker, computed_strength: n.computed_strength ?? 0.5, taxonomy_refs: [], turn_number: n.turn_number })),
        an.edges.filter(e => e.type === 'supports' || e.type === 'attacks').map(e => ({ id: e.id, source: e.source, target: e.target, type: e.type as 'supports' | 'attacks', weight: e.weight ?? 0.5 })),
      ),
      cruxResolution: (postDebate.crux_tracker ?? []).map(c => ({ id: c.id, state: c.state, support_polarity: c.support_polarity })),
      priorCruxClusters: advanced.prior_crux_clusters,
      regressionCount: advanced.regression_count,
      argumentationExitThreshold: advanced.argumentation_exit_threshold,
      concludingExitThreshold: advanced.concluding_exit_threshold,
    },
    extraction: {
      lastRoundStatus: 'ok',
      lastRoundClaimsAccepted: lastClaimsAccepted,
      lastRoundCategoryValidityRatio: 1.0,
    },
  };
  return { signalCtx, lastClaimsAccepted, lastConvSignal };
}

function sumPovNodeCounts(taxState: ReturnType<typeof useTaxonomyStore.getState>): number {
  return (taxState.accelerationist?.nodes?.length ?? 0) +
    (taxState.safetyist?.nodes?.length ?? 0) +
    (taxState.skeptic?.nodes?.length ?? 0);
}

/** Sum POV taxonomy nodes across camps (floored at 1) for the health-score denominator. */
function computeRelevantNodeCount(): number {
  return Math.max(1, sumPovNodeCounts(useTaxonomyStore.getState()));
}

/** Health score for early termination — per-speaker turn balance, recent taxonomy coverage, convergence. */
function computeAsHealthScore(postDebate: DebateSession, aiPovers: _AiPover[], recentConvSignals: any[]) {
  const turnCounts: Record<string, number> = {};
  for (const p of aiPovers) turnCounts[p] = 0;
  for (const e of postDebate.transcript) {
    if (e.type === 'statement' && e.speaker !== 'system' && e.speaker !== 'moderator') {
      turnCounts[e.speaker] = (turnCounts[e.speaker] ?? 0) + 1;
    }
  }
  const referencedIds = new Set<string>();
  for (const e of postDebate.transcript.slice(-6)) {
    for (const ref of e.taxonomy_refs) referencedIds.add(ref.node_id);
  }
  return computeDebateHealthScore(recentConvSignals.slice(-3), turnCounts, referencedIds.size, computeRelevantNodeCount());
}

function recordPeakTrackers(crossRespondRound: number, lastConvSignal: any, lastClaimsAccepted: number): void {
  if (lastConvSignal) {
    const peakEngagement = getSignalValue('_peak_engagement_ratio', 0) ?? 0;
    const currentEngagement = lastConvSignal.dialectical_engagement?.ratio ?? 0;
    if (currentEngagement > peakEngagement) {
      recordSignalHistory('_peak_engagement_ratio', crossRespondRound, currentEngagement);
    }
  }
  const peakClaims = getSignalValue('_peak_claims_per_round', 0) ?? 0;
  if (lastClaimsAccepted > peakClaims) {
    recordSignalHistory('_peak_claims_per_round', crossRespondRound, lastClaimsAccepted);
  }
}

function recordIndividualSignalValues(postDebate: DebateSession, signals: Signal[], signalCtx: SignalContext, crossRespondRound: number): void {
  for (const signal of signals) {
    if (!signal.enabled) continue;
    try {
      const val = Math.max(0, Math.min(1, signal.compute(signalCtx)));
      recordSignalHistory(signal.id, crossRespondRound, val);
    } catch (e) { getGlobalRecorder()?.record({ type: 'system.error', debate_id: postDebate.id, component: 'debate-store', level: 'warn', message: 'Phase signal computation failed', error: { name: (e as Error).name ?? 'Error', message: String(e), stack: (e as Error).stack } }); }
  }
}

/** Record signal-history entries (saturation/convergence, peak trackers, per-signal values) + per-round telemetry. */
function recordPhaseSignals(
  postDebate: DebateSession, signals: Signal[], signalCtx: SignalContext, advanced: PhaseState,
  crossRespondRound: number, lastConvSignal: any, lastClaimsAccepted: number,
  satScore: number, convScore: number, asHealthScore: ReturnType<typeof computeAsHealthScore>, result: any, config: PhaseTransitionConfig,
): void {
  recordSignalHistory('_argumentative_saturation_score', crossRespondRound, satScore);
  recordSignalHistory('_convergence_score', crossRespondRound, convScore);
  recordPeakTrackers(crossRespondRound, lastConvSignal, lastClaimsAccepted);
  recordIndividualSignalValues(postDebate, signals, signalCtx, crossRespondRound);

  // Flight recorder telemetry — per-round state snapshot for diagnostics
  getGlobalRecorder()?.record({
    type: 'debate.round', component: 'adaptive-staging', level: 'info',
    debate_id: postDebate.id,
    message: `Phase evaluation: ${advanced.current_phase} R${crossRespondRound}`,
    data: {
      round: crossRespondRound, phase: advanced.current_phase,
      rounds_in_phase: advanced.rounds_in_phase,
      total_rounds_elapsed: advanced.total_rounds_elapsed,
      saturation_score: satScore, convergence_score: convScore,
      argumentation_exit_threshold: advanced.argumentation_exit_threshold,
      concluding_exit_threshold: advanced.concluding_exit_threshold,
      health_score: asHealthScore, action: result.action,
      reason: result.reason, confidence_deferred: result.confidence_deferred,
      network_nodes: signalCtx.network.nodeCount,
      network_edges: signalCtx.network.edgeCount,
      api_calls_used: advanced.api_calls_used,
      maxTotalRounds: config.maxTotalRounds,
      transcript_length: postDebate.transcript.length,
    },
  });
}

function applyNonStepTransitionEntries(
  addTranscriptEntry: _AddEntry, prevPhase: string, newState: PhaseState, result: any,
): void {
  if (result.action === 'transition' || result.action === 'force_transition') {
    addTranscriptEntry({
      type: 'system', speaker: 'system',
      content: `[Phase transition] ${prevPhase} → ${newState.current_phase}: ${result.reason}`,
      taxonomy_refs: [],
      metadata: { adaptive_transition: true, from_phase: prevPhase, to_phase: newState.current_phase, reason: result.reason },
    });
  } else if (result.action === 'regress') {
    addTranscriptEntry({
      type: 'system', speaker: 'system',
      content: `[Phase regression] concluding → argumentation: ${result.reason}. Threshold ratcheted to ${(newState.argumentation_exit_threshold * 100).toFixed(0)}%.`,
      taxonomy_refs: [],
      metadata: { adaptive_regression: true, reason: result.reason, new_threshold: newState.argumentation_exit_threshold },
    });
  } else if (result.action === 'terminate') {
    addTranscriptEntry({
      type: 'system', speaker: 'system',
      content: `[Adaptive termination] ${result.reason}`,
      taxonomy_refs: [],
      metadata: { adaptive_termination: true, reason: result.reason },
    });
    newState.current_phase = 'terminated';
  }
}

/** Apply the phase-transition result (transcript entries + persist UI fields); skipped in step mode. */
function applyPhaseTransitionResult(
  get: _Get, set: _Set, addTranscriptEntry: _AddEntry,
  advanced: PhaseState, result: any, config: PhaseTransitionConfig, isStepMode: boolean | undefined, speakers: number,
): void {
  const prevPhase = advanced.current_phase;
  const newState = isStepMode ? advanced : applyTransition(advanced, result);

  if (!isStepMode) {
    applyNonStepTransitionEntries(addTranscriptEntry, prevPhase, newState, result);
  }

  // Persist updated phase state + UI convenience fields
  const freshPostDebate = get().activeDebate;
  if (freshPostDebate?.adaptive_staging) {
    freshPostDebate.adaptive_staging.phase_state = newState;
    // Write UI-facing fields for PhaseProgressBar
    const asObj = freshPostDebate.adaptive_staging as Record<string, unknown>;
    asObj.current_phase = newState.current_phase;
    asObj.rounds_in_phase = newState.rounds_in_phase;
    asObj.phase_progress = newState.total_rounds_elapsed / effectiveRoundCap(config, speakers); // t/3937: the engine's cap, not the preset
    asObj.approaching_transition = result.action === 'transition' || result.action === 'force_transition';
    asObj.rationale = result.reason;
    set({ activeDebate: { ...freshPostDebate } });
  }
}

function recordPhaseTransitionEntry(
  diag: ReturnType<typeof initAdaptiveDiagnostics>, result: any, advanced: PhaseState,
  crossRespondRound: number, currentPhaseStartRound: number,
): void {
  if (result.action === 'transition' || result.action === 'force_transition' || result.action === 'terminate') {
    diag.phases.push({
      phase: advanced.current_phase,
      rounds: Array.from({ length: crossRespondRound - currentPhaseStartRound + 1 }, (_, i) => currentPhaseStartRound + i),
      exit_reason: result.reason,
      force_active: result.force_active,
    });
  } else if (result.action === 'regress') {
    diag.regressions.push({ from_round: crossRespondRound, crux_id: 'unknown', threshold_after: advanced.argumentation_exit_threshold });
  }
}

function accumulateAdaptiveDiagnostics(
  postDebate: DebateSession, result: any, advanced: PhaseState, config: PhaseTransitionConfig,
  crossRespondRound: number, signalCtx: SignalContext, signals: Signal[], satScore: number, convScore: number,
): void {
  if (!postDebate.adaptive_staging_diagnostics) {
    postDebate.adaptive_staging_diagnostics = initAdaptiveDiagnostics();
  }
  const diag = postDebate.adaptive_staging_diagnostics;
  const currentPhaseStartRound = diag.phases.length > 0
    ? Math.max(...diag.phases[diag.phases.length - 1].rounds) + 1
    : 1;
  diag.total_predicate_evaluations++;
  if (result.confidence_deferred) diag.confidence_deferrals++;
  if (result.veto_active) diag.vetoes_fired++;
  if (result.force_active) diag.forces_fired++;
  diag.network_size_peak = Math.max(diag.network_size_peak, signalCtx.network.nodeCount);
  const phaseCtx = buildPhaseContext(advanced, config, satScore, convScore);
  diag.signal_telemetry.push(buildSignalTelemetry(advanced, signalCtx, signals, result, phaseCtx.phase_progress, 0));
  // `advanced.current_phase` is the phase we're exiting (the transition is applied below).
  recordPhaseTransitionEntry(diag, result, advanced, crossRespondRound, currentPhaseStartRound);
}

/** Evaluate + apply the adaptive-staging phase transition for one completed round. */
function evaluateAdaptiveStaging(get: _Get, set: _Set, addTranscriptEntry: _AddEntry, aiPovers: _AiPover[], crossRespondRound: number, postDebate: DebateSession): void {
  const asState = postDebate.adaptive_staging!.phase_state!;
  const weights = loadProvisionalWeights();
  const pacingPreset = weights.pacing_presets[postDebate.adaptive_staging!.pacing] ?? weights.pacing_presets.moderate;
  const config: PhaseTransitionConfig = {
    useAdaptiveStaging: true,
    maxTotalRounds: pacingPreset.maxTotalRounds,
    pacing: postDebate.adaptive_staging!.pacing,
    dialecticalStyle: 'adversarial',
    argumentationExitThreshold: asState.argumentation_exit_threshold,
    concludingExitThreshold: asState.concluding_exit_threshold,
    allowEarlyTermination: true,
    phaseBoundsOverride: postDebate.adaptive_staging!.phase_bounds_override,
  };

  // Advance round counter
  const advanced = advanceRound(asState);
  advanced.api_calls_used = (advanced.api_calls_used ?? 0) + 1;

  // Build signal context from session data
  const an = postDebate.argument_network ?? { nodes: [], edges: [] };
  const recentConvSignals = postDebate.convergence_signals ?? [];
  const { signalCtx, lastClaimsAccepted, lastConvSignal } = buildPhaseSignalContext(postDebate, advanced, aiPovers, crossRespondRound, an, recentConvSignals);

  const signals = buildSignalRegistry();
  const asHealthScore = computeAsHealthScore(postDebate, aiPovers, recentConvSignals);

  const result = evaluatePhaseTransition(advanced, signalCtx, signals, config, asHealthScore);
  getGlobalRecorder()?.record({ type: 'debate.round', component: 'adaptive-staging', level: 'debug', debate_id: postDebate.id, message: `Phase evaluation computed`, data: { round: crossRespondRound, action: result.action, reason: result.reason } });

  // Compute and record signal scores for history tracking
  const coldStart = advanced.rounds_in_phase < 2;
  const satScore = computeSaturationScore(signals, signalCtx, coldStart);
  const convScore = computeConvergenceScore(signalCtx, coldStart);
  recordPhaseSignals(postDebate, signals, signalCtx, advanced, crossRespondRound, lastConvSignal, lastClaimsAccepted, satScore, convScore, asHealthScore, result, config);

  // Accumulate adaptive_staging_diagnostics for the GUI per-round path (t/2423). The engine
  // batch loop (runAdaptiveCrossRespond) writes `diag` once at loop end, but GUI debates run
  // round-by-round through this function — so without accumulating here, the session never
  // carries adaptive_staging_diagnostics and termination_reason / convergence_score_at_termination
  // stay unpopulated on live sessions. Mutations land on postDebate, which applyPhaseTransitionResult
  // writes back in the same set().
  accumulateAdaptiveDiagnostics(postDebate, result, advanced, config, crossRespondRound, signalCtx, signals, satScore, convScore);

  // Apply transition (skipped in step mode — user controls phase manually)
  applyPhaseTransitionResult(get, set, addTranscriptEntry, advanced, result, config, postDebate.adaptive_staging!.step_mode, aiPovers.length);
}

function runPostRoundProcessing(get: _Get, set: _Set, addTranscriptEntry: _AddEntry, aiPovers: _AiPover[], crossRespondRound: number): void {
  const postDebate = get().activeDebate;
  if (!postDebate) return;
  try {
    pruneSessionData(postDebate);
    if (postDebate.moderator_state) pruneModeratorState(postDebate.moderator_state);

    // ── Adaptive staging: evaluate phase transition after each round ──
    if (postDebate.adaptive_staging?.enabled && postDebate.adaptive_staging.phase_state) {
      evaluateAdaptiveStaging(get, set, addTranscriptEntry, aiPovers, crossRespondRound, postDebate);
    } else {
      set({ activeDebate: { ...postDebate } });
    }
  } catch (postErr) {
    console.error('[crossRespond] Post-processing failed:', postErr);
    getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-store', level: 'error', debate_id: postDebate.id, message: 'Cross-respond post-processing failed', data: { error: String(postErr), stack: (postErr as Error).stack?.slice(0, 500) } });
  }
}

async function computeGapTrigger(
  gapDebate: DebateSession, gapRound: number, currentRound: number,
): Promise<{ triggerType: 'scheduled' | 'responsive' | null; focusNodes: { id: string; label: string; description: string }[] | undefined }> {
  if (currentRound === gapRound && _gapInjectionCount === 0) {
    return { triggerType: 'scheduled', focusNodes: undefined };
  }
  if (!shouldRunGapCheck(currentRound, gapRound, _gapInjectionCount)) {
    return { triggerType: null, focusNodes: undefined };
  }
  const anNodes = gapDebate.argument_network?.nodes ?? [];
  const engagedIds = collectEngagedNodeIds(
    anNodes.map(n => ({ taxonomy_refs: (n.taxonomy_refs ?? []).map(id => ({ node_id: typeof id === 'string' ? id : (id as unknown as { node_id: string }).node_id })) })),
    gapDebate.transcript.map(e => ({ taxonomy_refs: (e.taxonomy_refs ?? []).map(r => ({ node_id: r.node_id })) })),
  );
  const allTaxNodes: { id: string; label: string; description: string }[] = [];
  for (const pov of POV_KEYS) {
    const ctx = getTaxonomyContext(pov);
    for (const n of ctx.povNodes) {
      allTaxNodes.push({ id: n.id, label: n.label, description: n.description });
    }
  }
  const recentText = formatRecentTranscript(gapDebate.transcript, 8, gapDebate.context_summaries);
  const query = `${gapDebate.topic.final}\n\n${recentText}`.slice(0, 500);
  const scores = scoreNodesLexical(query, allTaxNodes, []);
  const unengaged = findUnengagedHighRelevanceNodes(allTaxNodes, engagedIds, scores);
  if (unengaged.length > 0) {
    return { triggerType: 'responsive', focusNodes: unengaged.slice(0, 5) };
  }
  return { triggerType: null, focusNodes: undefined };
}

async function executeGapInjection(
  gapDebate: DebateSession, triggerType: 'scheduled' | 'responsive',
  focusNodes: { id: string; label: string; description: string }[] | undefined,
  currentRound: number, get: _Get, set: _Set, addTranscriptEntry: _AddEntry, activeDebate: DebateSession,
): Promise<void> {
  const gapModel = getConfiguredModel();
  const gapTranscript = formatRecentTranscript(gapDebate.transcript, 20, gapDebate.context_summaries);
  const gapSummaryLines: string[] = [];
  for (const pov of POV_KEYS) {
    const ctx = getTaxonomyContext(pov);
    for (const n of ctx.povNodes) {
      gapSummaryLines.push(`[${n.id}] ${n.label} (${n.category ?? 'unknown'}) — ${pov}`);
    }
  }
  const anTexts = (gapDebate.argument_network?.nodes || []).map(n => n.text);
  const gapPrompt = midDebateGapPrompt(gapDebate.topic.final, gapTranscript, gapSummaryLines.slice(0, 80).join('\n'), anTexts, focusNodes);
  const { text: gapText } = await api.generateText(gapPrompt, gapModel);
  const gapParsed = parseAIJson<{ gap_arguments: GapArgument[] }>(gapText);
  const gapArgs = gapParsed?.gap_arguments ?? [];
  if (gapArgs.length > 0) {
    const header = triggerType === 'scheduled' ? 'Mid-Debate Gap Analysis' : 'Responsive Gap Analysis';
    const gapContent = gapArgs.map((g, i) => `**Gap ${i + 1} (${g.gap_type}):** ${g.argument}\n*Why missing:* ${g.why_missing}`).join('\n\n');
    const gapEntryId = addTranscriptEntry({
      type: 'system', speaker: 'system',
      content: `## ${header}\n\n${gapContent}`,
      taxonomy_refs: [],
      metadata: { gap_analysis: true, gap_arguments: gapArgs, trigger: triggerType, focus_nodes: focusNodes?.map(n => n.id) },
    });
    incrementGapInjectionCount();
    const injection: GapInjection = {
      round: currentRound, arguments: gapArgs, transcript_entry_id: gapEntryId, responses: [], trigger: triggerType,
      ...(focusNodes && { focus_nodes: focusNodes.map(n => n.id) }),
    };
    const freshGapDebate = get().activeDebate;
    if (freshGapDebate) {
      const existing = freshGapDebate.gap_injections ?? [];
      set({ activeDebate: { ...freshGapDebate, gap_injections: [...existing, injection] }, gapInjections: [...existing, injection] });
    }
    recordDiagnostic(get, set, gapEntryId, { prompt: gapPrompt, raw_response: gapText, model: gapModel });
    getGlobalRecorder()?.record({ type: 'state.change', debate_id: activeDebate?.id, component: 'gap-injection', level: 'info', message: `gap.${triggerType}`, data: { round: currentRound, args: gapArgs.length, focus: focusNodes?.length ?? 0, total_injections: _gapInjectionCount } });
  }
}

async function runGapInjectionCheck(get: _Get, set: _Set, addTranscriptEntry: _AddEntry, activeDebate: DebateSession): Promise<void> {
  try {
    const gapDebate = get().activeDebate;
    if (gapDebate) {
      const totalRounds = get().initialCrossRespondRounds || 5;
      const gapRound = Math.ceil(totalRounds / 2) + 1;
      const currentRound = gapDebate.transcript.filter(e => e.type === 'statement').length;
      const { triggerType, focusNodes } = await computeGapTrigger(gapDebate, gapRound, currentRound);
      if (triggerType) {
        await executeGapInjection(gapDebate, triggerType, focusNodes, currentRound, get, set, addTranscriptEntry, activeDebate);
      }
    }
  } catch (gapErr) {
    getGlobalRecorder()?.record({
      type: 'system.error', debate_id: activeDebate?.id, component: 'debate-store', level: 'warn',
      message: 'Gap injection analysis failed',
      error: { name: (gapErr as Error).name ?? 'Error', message: String(gapErr), stack: (gapErr as Error).stack },
    });
    console.warn('[Gap Injection] Gap analysis failed (non-blocking):', gapErr);
    pushWarning(get, set, 'Gap analysis skipped this turn');
  }
}

function resolveOpponentLabel(driftingToward: string): string {
  return POVER_INFO[driftingToward as Exclude<SpeakerId, 'user'>]?.label ?? driftingToward;
}

type _DriftEntry = { round: number; speaker: string; self_similarity: number; opponent_similarities: Record<string, number> };

function detectSycophancyEntry(
  drift: _DriftEntry[], currentD: DebateSession | null | undefined,
  responderPover: _AiPover, info: _PoverInfo, addTranscriptEntry: _AddEntry,
): void {
  const speakerDrift = drift.filter(d => d.speaker === responderPover);
  if (speakerDrift.length < 3) return;
  const recent = speakerDrift.slice(-3);
  const selfDecreasing = recent.every((d, i) => i === 0 || d.self_similarity < recent[i - 1].self_similarity);
  const opponents = Object.keys(recent[0].opponent_similarities);
  const driftingToward = opponents.find(opp =>
    recent.every((d, i) => i === 0 || (d.opponent_similarities[opp] ?? 0) > (recent[i - 1].opponent_similarities[opp] ?? 0)),
  );
  const concessions = currentD?.commitments?.[responderPover]?.conceded ?? [];
  if (selfDecreasing && driftingToward && concessions.length === 0) {
    addTranscriptEntry({
      type: 'system', speaker: 'system',
      content: `[Sycophancy guard] ${info.label} appears to be drifting toward ${resolveOpponentLabel(driftingToward)}'s position over the last 3 turns without explicit concession. Self-similarity: ${recent.map(d => d.self_similarity.toFixed(2)).join(' → ')}.`,
      taxonomy_refs: [],
    });
  }
}

async function recordDriftMeasurements(
  get: _Get, set: _Set, crossRespondRound: number, responderPover: _AiPover,
  info: _PoverInfo, currentD: DebateSession | null | undefined,
  addTranscriptEntry: _AddEntry, statement: string, openingEmbeds: Record<string, number[]>,
): Promise<void> {
  const responseEmbed = await api.computeQueryEmbedding(statement.slice(0, 1000));
  const selfSim = cosineSimilarity(responseEmbed.vector, openingEmbeds[responderPover]);
  const opponentSims: Record<string, number> = {};
  for (const [pov, embed] of Object.entries(openingEmbeds)) {
    if (pov !== responderPover) opponentSims[pov] = cosineSimilarity(responseEmbed.vector, embed);
  }
  // Re-read fresh state — the await above yielded to the event loop,
  // so concurrent commits (e.g., fire-and-forget extractClaimsAndUpdateAN)
  // may have landed in between. Spreading the stale `currentD` would
  // clobber their writes (notably argument_network).
  const freshD = get().activeDebate;
  const drift = freshD?.position_drift ?? [];
  drift.push({ round: crossRespondRound, speaker: responderPover, self_similarity: selfSim, opponent_similarities: opponentSims });
  if (freshD) {
    set({ activeDebate: { ...freshD, position_drift: drift } });
  }
  detectSycophancyEntry(drift, currentD, responderPover, info, addTranscriptEntry);
}

async function detectPositionDrift(get: _Get, set: _Set, addTranscriptEntry: _AddEntry, activeDebate: DebateSession, responderPover: _AiPover, info: _PoverInfo, crossRespondRound: number, statement: string): Promise<void> {
  try {
    const currentD = get().activeDebate;
    const openingEmbeds = currentD?.metadata?._openingEmbeddings as Record<string, number[]> | undefined;
    if (openingEmbeds && openingEmbeds[responderPover]) {
      await recordDriftMeasurements(get, set, crossRespondRound, responderPover, info, currentD, addTranscriptEntry, statement, openingEmbeds);
    }
  } catch (e) { getGlobalRecorder()?.record({ type: 'system.error', debate_id: activeDebate?.id, component: 'debate-store', level: 'warn', message: 'Position drift detection failed', error: { name: (e as Error).name ?? 'Error', message: String(e), stack: (e as Error).stack } }); }
}

function computeRoundAndPhase(activeDebate: DebateSession, aiPovers: _AiPover[], get: _Get, set: _Set): { crossRespondRound: number; phase: DebatePhase; totalRoundsForPhase: number } {
    const crossRespondRound = activeDebate.transcript.filter(e => e.type === 'statement').length + 1;
    const adaptiveStaging = activeDebate.adaptive_staging;
    let totalRoundsForPhase: number;
    let phase: DebatePhase;
    if (adaptiveStaging?.enabled) {
      const weights = loadProvisionalWeights();
      const pacingPreset = weights.pacing_presets[adaptiveStaging.pacing] ?? weights.pacing_presets.moderate;
      const config: PhaseTransitionConfig = {
        useAdaptiveStaging: true,
        maxTotalRounds: pacingPreset.maxTotalRounds,
        pacing: adaptiveStaging.pacing,
        dialecticalStyle: 'adversarial',
        argumentationExitThreshold: pacingPreset.argumentationExit,
        concludingExitThreshold: pacingPreset.concludingExit,
        allowEarlyTermination: true,
        phaseBoundsOverride: adaptiveStaging.phase_bounds_override,
      };
      totalRoundsForPhase = effectiveRoundCap(config, aiPovers.length); // t/3937: the engine's cap, in turns
      if (!adaptiveStaging.phase_state) { // initialize phase state on first round
        adaptiveStaging.phase_state = initPhaseState(config);
        set({ activeDebate: { ...activeDebate } });
      }
      phase = adaptiveStaging.phase_state.current_phase;
    } else {
      totalRoundsForPhase = get().initialCrossRespondRounds || 5;
      phase = getDebatePhase(crossRespondRound, totalRoundsForPhase * 3);
    }
    getGlobalRecorder()?.record({ type: 'debate.round', component: 'debate-store', level: 'info', debate_id: activeDebate.id, message: `Cross-respond round ${crossRespondRound} start`, data: { round: crossRespondRound, phase, speakers: aiPovers } });
  return { crossRespondRound, phase, totalRoundsForPhase };
}

// ── runPostTerminationTurn phase helpers (t/1848) ────────────────────
// runPostTerminationTurn was a single 55-complexity terminated-debate final-statement
// fast path. Its phases are extracted here as helpers (bodies moved verbatim; see
// ADR-007 split pattern). Control flow uses early returns; the two `return true`
// exit points (debate-switched abort + normal completion) are preserved.

/** True when the debate is already terminated/closed (eligible for a final-statement fast path). */
function isPostTerminationEligible(activeDebate: DebateSession): boolean {
  return !!(activeDebate.phase === 'closed'
    || (activeDebate as unknown as Record<string, unknown>).adaptive_staging
      && ((activeDebate as unknown as Record<string, unknown>).adaptive_staging as Record<string, unknown>)?.phase_state
      && ((activeDebate as unknown as Record<string, unknown>).adaptive_staging as Record<string, unknown> & { phase_state: { current_phase: string } }).phase_state.current_phase === 'terminated');
}

/** POVers who have not spoken in the last round (walking the transcript back to the last phase/round marker). */
function findLastRoundMissingResponders(activeDebate: DebateSession, aiPovers: _AiPover[]): _AiPover[] {
  const lastRoundSpeakers = new Set<string>();
  for (let j = activeDebate.transcript.length - 1; j >= 0; j--) {
    const e = activeDebate.transcript[j];
    if ((e.type as string) === 'statement') lastRoundSpeakers.add(e.speaker);
    else if (e.type === 'system' && /\[Phase|Moderator|Round/.test(e.content)) break;
    else if ((e.type as string) !== 'statement' && e.type !== 'system') break;
  }
  return aiPovers.filter(p => !lastRoundSpeakers.has(p));
}

/** Turns since the responder last played a CONCEDE move (its total turn count if never). */
function countTurnsSinceLastConcession(activeDebate: DebateSession, responderPover: _AiPover): number {
  const ptDebaterTurns = activeDebate.transcript
    .filter(e => e.speaker === responderPover && ((e.type as string) === 'statement' || e.type === 'opening'));
  let ptTurnsSinceLastConcession = ptDebaterTurns.length;
  for (let i = ptDebaterTurns.length - 1; i >= 0; i--) {
    const moves = ((ptDebaterTurns[i].metadata as Record<string, unknown>)?.move_types as (string | MoveAnnotation)[]) ?? [];
    if (moves.some(m => getMoveName(m).includes('CONCEDE'))) {
      ptTurnsSinceLastConcession = ptDebaterTurns.length - 1 - i;
      break;
    }
  }
  return ptTurnsSinceLastConcession;
}

/** Per-stage model overrides for a debate (undefined when unset). */
function resolveStageModels(activeDebate: DebateSession) {
  return {
    briefModel: activeDebate.stage_models?.brief || undefined,
    planModel: activeDebate.stage_models?.plan || undefined,
    citeModel: activeDebate.stage_models?.cite || undefined,
  };
}

function buildPtConcessionHint(activeDebate: DebateSession, responderPover: _AiPover): { concessionHint: string; priorConceded: string[] } {
  const priorConceded = activeDebate.commitments?.[responderPover]?.conceded ?? [];
  const concessionAN = activeDebate.argument_network;
  const concessionHint = concessionAN
    ? formatConcessionCandidatesHint(concessionAN.nodes, concessionAN.edges, responderPover, priorConceded)
    : '';
  return { concessionHint, priorConceded };
}

/** Build the prompt-context blocks for a responder's post-termination turn. */
function buildPostTerminationContextBlocks(
  activeDebate: DebateSession,
  responderPover: _AiPover,
  info: typeof POVER_INFO[_AiPover],
  ctx: Awaited<ReturnType<typeof getRelevantTaxonomyContext>>,
  get: _Get,
): { commitBlock: string; establishedBlock: string; edgeBlock: string; concessionHint: string; taxonomyBlock: string } {
  const speakerClaims = (activeDebate.argument_network?.nodes || []).filter(n => n.speaker === responderPover);
  const commitBlock = formatCommitments(
    activeDebate.commitments?.[responderPover] || { asserted: [], conceded: [], challenged: [] },
    speakerClaims,
  );
  const allANNodes = (activeDebate.argument_network?.nodes || []).map(n => ({
    id: n.id, text: n.text, speaker: POVER_INFO[n.speaker as Exclude<SpeakerId, 'user'>]?.label || n.speaker,
  }));
  const establishedBlock = formatEstablishedPoints(allANNodes, info.label, 10);
  const edgeBlock = formatDebaterEdgeContext(info.pov);
  const { concessionHint } = buildPtConcessionHint(activeDebate, responderPover);
  const crVocab = get().vocabularyTerms;
  const crVocabBlock = crVocab
    ? '\n' + formatVocabularyContext({ pov: info.pov, standardizedTerms: crVocab.standardized, colloquialTerms: crVocab.colloquial })
    : '';
  const taxonomyBlock = formatTaxonomyContext(ctx, info.pov) + crVocabBlock;
  return { commitBlock, establishedBlock, edgeBlock, concessionHint, taxonomyBlock };
}

/** Assemble the TurnPipelineInput for a responder's post-termination final statement. */
async function buildPostTerminationPipelineInput(
  activeDebate: DebateSession,
  responderPover: _AiPover,
  info: typeof POVER_INFO[_AiPover],
  topic: string,
  model: string,
  currentTranscript: string,
  ctx: Awaited<ReturnType<typeof getRelevantTaxonomyContext>>,
  phase: DebatePhase,
  focusPoint: string,
  addressingLabel: string,
  get: _Get,
): Promise<{ pipelineInput: TurnPipelineInput; taxonomyBlock: string; commitBlock: string }> {
  const { commitBlock, establishedBlock, edgeBlock, concessionHint, taxonomyBlock } = buildPostTerminationContextBlocks(activeDebate, responderPover, info, ctx, get);
  const crDocAnalysis = activeDebate.document_analysis;
  const priorMoves = activeDebate.transcript
    .filter(e => e.speaker === responderPover && e.metadata)
    .flatMap(e => {
      const mt = (e.metadata as Record<string, unknown>)?.move_types;
      return Array.isArray(mt) ? mt.map(m => getMoveName(m)) : [];
    })
    .slice(-6);
  const priorRefs = activeDebate.transcript
    .filter(e => e.speaker === responderPover && e.type !== 'opening')
    .slice(-2)
    .flatMap(e => (e.taxonomy_refs ?? []).map(r => r.node_id));
  const availablePovNodeIds = [...getSelectableNodeIds()]; // t/4355: offer selectable ids only
  const debaterGapHint = formatGapHint(activeDebate.gap_injections);
  const [evidenceIndex, docTitles] = await Promise.all([getSourceEvidenceIndex(), getDocTitles()]);
  const ptTurnsSinceLastConcession = countTurnsSinceLastConcession(activeDebate, responderPover);
  const stageModels = resolveStageModels(activeDebate);

  const pipelineInput: TurnPipelineInput = {
    label: info.label,
    pov: info.pov,
    personality: info.personality,
    ...seatSouls(activeDebate, responderPover), // t/3975: soul + opponentSouls
    topic,
    taxonomyContext: taxonomyBlock,
    commitmentContext: commitBlock,
    establishedPoints: establishedBlock,
    edgeContext: edgeBlock,
    concessionHint: concessionHint + debaterGapHint,
    recentTranscript: currentTranscript,
    focusPoint,
    addressing: addressingLabel,
    phase,
    priorMoves,
    priorRefs,
    availablePovNodeIds,
    turnsSinceLastConcession: ptTurnsSinceLastConcession,
    pendingIntervention: undefined,
    sourceContent: crDocAnalysis ? undefined : (activeDebate.source_content || undefined),
    documentAnalysis: crDocAnalysis,
    audience: activeDebate.audience,
    model: getSpeakerModel(activeDebate, responderPover, model),
    briefModel: stageModels.briefModel,
    planModel: stageModels.planModel,
    citeModel: stageModels.citeModel,
    sourceEvidenceIndex: evidenceIndex as TurnPipelineInput['sourceEvidenceIndex'],
    docTitles: docTitles as TurnPipelineInput['docTitles'],
    background: activeDebate.topic?.background || undefined,
  };
  return { pipelineInput, taxonomyBlock, commitBlock };
}

/** Record per-entry diagnostics for a completed post-termination turn. */
function recordPostTerminationDiagnostics(
  get: _Get, set: _Set, lastEntryId: string,
  pipelineResult: Awaited<ReturnType<typeof runTurnPipeline>>,
  model: string, taxonomyBlock: string, commitBlock: string,
): void {
  const draftDiag = pipelineResult.stage_diagnostics.find(s => s.stage === 'draft');
  const topicAlignDiagTerm = pipelineResult.topicAlignmentResult
    ? {
      topic_aligned: pipelineResult.topicAlignmentResult.topic_aligned,
      repaired: pipelineResult.topicAlignmentResult.repaired || undefined,
      draft_attempt: pipelineResult.topicAlignmentResult.draft_attempt,
      scope_used: get().activeDebate?.topic?.scope ?? null,
    }
    : undefined;
  recordDiagnostic(get, set, lastEntryId, {
    prompt: draftDiag?.raw_response ?? pipelineResult.final_text,
    raw_response: pipelineResult.final_text,
    model,
    taxonomy_context: taxonomyBlock,
    commitment_context: commitBlock || undefined,
    stage_diagnostics: pipelineResult.stage_diagnostics,
    topic_alignment: topicAlignDiagTerm,
    quality_gate: pipelineResult.qualityGateResult,
  });
}

function enrichPtTaxonomyRefs(ctx: Awaited<ReturnType<typeof getRelevantTaxonomyContext>>, taxonomyRefs: { node_id: string; relevance_score?: number }[]): void {
  if (ctx.nodeScores) {
    for (const ref of taxonomyRefs) {
      const score = ctx.nodeScores.get(ref.node_id);
      if (score != null) ref.relevance_score = score;
    }
  }
}

async function runPostTerminationTurn(activeDebate: DebateSession, aiPovers: _AiPover[], topic: string, model: string, get: _Get, set: _Set, isStillValid: () => boolean, addTranscriptEntry: _AddEntry, saveDebate: _SaveDebate): Promise<boolean> {
  if (!isPostTerminationEligible(activeDebate)) return false;
  // Find debaters who haven't spoken in the last round
  const missingPovers = findLastRoundMissingResponders(activeDebate, aiPovers);
  if (missingPovers.length === 0) return false;

  // Use the first missing pover and jump straight to step 2 (response generation)
  const responderPover = missingPovers[0];
  const crossRespondRound = activeDebate.transcript.filter(e => e.type === 'statement').length + 1;
  const phase = 'concluding';
  const focusPoint = 'Give your final statement on this debate.';
  const addressingLabel = 'all';
  set({ debateGenerating: responderPover, debateActivity: `${POVER_INFO[responderPover].label} is preparing...`, debateStepStartedAt: Date.now() });

  const info = seatSouls(activeDebate, responderPover).soul; // t/3975
  const currentTranscript = formatRecentTranscript(get().activeDebate!.transcript, 8, get().activeDebate!.context_summaries);
  const ctx = await getRelevantTaxonomyContext(info.pov, topic, currentTranscript);
  const { pipelineInput, taxonomyBlock, commitBlock } = await buildPostTerminationPipelineInput(activeDebate, responderPover, info, topic, model, currentTranscript, ctx, phase, focusPoint, addressingLabel, get);

  const stageGenerate = makeStageGenerate(set as (partial: Record<string, unknown>) => void, getSpeakerModel(activeDebate, responderPover, model), servedTurnRecorder(get, set, responderPover));
  const pipelineResult = await runTurnPipeline(pipelineInput, stageGenerate);
  if (!isStillValid()) { releaseDebateDriver(); set({ debateGenerating: null }); getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'info', debate_id: activeDebate.id, message: 'debate.ended', data: { reason: 'debate_switched' } }); return true; }

  const { statement, taxonomyRefs, meta } = parsePoverResponse(pipelineResult.final_text ?? '');
  enrichPtTaxonomyRefs(ctx, taxonomyRefs);
  const relevanceSources = serializeNodeSourceMap(ctx.nodeSourceMap, taxonomyRefs);
  addTranscriptEntry({
    type: 'statement',
    speaker: responderPover,
    content: statement,
    taxonomy_refs: taxonomyRefs,
    policy_refs: meta.policy_refs,
    addressing: addressingLabel,
    metadata: { ...meta, round: crossRespondRound, moderator_trace: { selected: info.label, selection_reason: 'post_termination_final_statement' }, relevance_sources: relevanceSources, injection_manifest: ctx.injectionManifest },
  });
  const lastEntry = get().activeDebate?.transcript.slice(-1)[0];
  if (lastEntry) {
    recordPostTerminationDiagnostics(get, set, lastEntry.id, pipelineResult, model, taxonomyBlock, commitBlock);
    void extractClaimsAndUpdateAN(statement, responderPover, lastEntry.id, taxonomyRefs.map(r => r.node_id), get, set, meta.my_claims);
    await summarizeTranscriptEntry(lastEntry.id, statement, info.label, model, get, set);
  }
  releaseDebateDriver();
  set({ debateGenerating: null });
  getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'info', debate_id: activeDebate.id, message: 'debate.ended', data: { reason: 'post_termination_complete' } });
  await saveDebate('crossRespond:postTermination');
  return true;
}


// ── buildTurnPipelineContext helpers ─────────────────────────────────────────

function buildSpeakerAndNetworkData(activeDebate: DebateSession, responderPover: _AiPover) {
  const anNodes = activeDebate.argument_network?.nodes || [];
  const speakerClaims = anNodes.filter(n => n.speaker === responderPover);
  const allANNodes = anNodes.map(n => ({
    id: n.id, text: n.text,
    speaker: POVER_INFO[n.speaker as Exclude<SpeakerId, 'user'>]?.label || n.speaker,
  }));
  const commitmentRecord = activeDebate.commitments?.[responderPover] || { asserted: [], conceded: [], challenged: [] };
  const priorConceded = commitmentRecord.conceded ?? [];
  return { speakerClaims, allANNodes, commitmentRecord, priorConceded };
}

function resolveTopicFields(activeDebate: DebateSession) {
  return {
    background: activeDebate.topic?.background || undefined,
    topicScope: activeDebate.topic?.scope ?? undefined,
  };
}

function resolveSourceContent(crDocAnalysis: DebateSession['document_analysis'], activeDebate: DebateSession): string | undefined {
  return crDocAnalysis ? undefined : (activeDebate.source_content || undefined);
}

async function buildTurnPipelineContext(responderPover: _ModResult['responder'], activeDebate: DebateSession, topic: string, model: string, intervention: _ModResult['intervention'], interventionBriefInjection: _ModResult['interventionBriefInjection'], focusPoint: _ModResult['focusPoint'], addressingLabel: _ModResult['addressing'], phase: DebatePhase, get: _Get, set: _Set) {
  set({ debateGenerating: responderPover, debateActivity: `${POVER_INFO[responderPover].label} is preparing...`, debateStepStartedAt: Date.now() });

  const crSouls = seatSouls(activeDebate, responderPover); // t/3975
  const info = crSouls.soul;
  const currentTranscript = formatRecentTranscript(get().activeDebate!.transcript, 8, get().activeDebate!.context_summaries);
  const ctx = await getRelevantTaxonomyContext(info.pov, topic, currentTranscript);
  const { speakerClaims, allANNodes, commitmentRecord, priorConceded } = buildSpeakerAndNetworkData(activeDebate, responderPover);
  const commitBlock = formatCommitments(commitmentRecord, speakerClaims);
  const establishedBlock = formatEstablishedPoints(allANNodes, info.label, 10);
  const edgeBlock = formatDebaterEdgeContext(info.pov);

  const concessionAN = activeDebate.argument_network;
  const concessionHint = concessionAN
    ? formatConcessionCandidatesHint(concessionAN.nodes, concessionAN.edges, responderPover, priorConceded)
    : '';
  const concessionCandidateIds = concessionHint
    ? concessionAN!.nodes
        .filter(n => n.speaker !== responderPover)
        .filter(n => (n.computed_strength ?? n.base_strength ?? 0) >= 0.65)
        .filter(n => !concessionAN!.edges.some(e => e.type === 'attacks' && concessionAN!.nodes.find(x => x.id === e.source)?.speaker === responderPover && e.target === n.id))
        .filter(n => !priorConceded.includes(n.id) && !priorConceded.includes(n.text))
        .sort((a, b) => (b.computed_strength ?? 0) - (a.computed_strength ?? 0))
        .slice(0, 2)
        .map(n => n.id)
    : [];

  const crVocab = get().vocabularyTerms;
  const crVocabBlock = crVocab
    ? '\n' + formatVocabularyContext({ pov: info.pov, standardizedTerms: crVocab.standardized, colloquialTerms: crVocab.colloquial })
    : '';
  const taxonomyBlock = formatTaxonomyContext(ctx, info.pov) + crVocabBlock;
  const crDocAnalysis = activeDebate.document_analysis;

  const priorMoves = activeDebate.transcript
    .filter(e => e.speaker === responderPover && e.metadata)
    .flatMap(e => {
      const mt = (e.metadata as Record<string, unknown>)?.move_types;
      return Array.isArray(mt) ? mt.map(m => getMoveName(m)) : [];
    })
    .slice(-6);

  const priorRefs = activeDebate.transcript
    .filter(e => e.speaker === responderPover && e.type !== 'opening')
    .slice(-2)
    .flatMap(e => (e.taxonomy_refs ?? []).map(r => r.node_id));

  const availablePovNodeIds = [...getSelectableNodeIds()]; // t/4355: offer selectable ids only
  const debaterGapHint = formatGapHint(activeDebate.gap_injections);
  const pendingInterventionData = intervention ? (() => {
    const moveConfig = MOVE_RESPONSE_CONFIG[intervention.move as keyof typeof MOVE_RESPONSE_CONFIG];
    const targetLabel = POVER_INFO[intervention.target_debater as Exclude<SpeakerId, 'user'>]?.label ?? intervention.target_debater;
    const isTargeted = targetLabel.toLowerCase() === info.label.toLowerCase();
    return {
      move: intervention.move,
      family: intervention.family,
      targetDebater: targetLabel,
      responseField: moveConfig?.field ?? undefined,
      responseSchema: moveConfig?.schema ?? undefined,
      directResponsePattern: DIRECT_RESPONSE_PATTERNS[intervention.move as keyof typeof DIRECT_RESPONSE_PATTERNS] ?? undefined,
      isTargeted,
    };
  })() : undefined;

  const [evidenceIndex, docTitles] = await Promise.all([getSourceEvidenceIndex(), getDocTitles()]);

  const lastOpponentEntry = (activeDebate.transcript ?? [])
    .filter(e => e.speaker !== responderPover && e.speaker !== 'system' && e.speaker !== 'user' && e.type !== 'opening')
    .slice(-1)[0];
  const lastOpponentStatement = lastOpponentEntry
    ? (typeof lastOpponentEntry.content === 'string' ? lastOpponentEntry.content : JSON.stringify(lastOpponentEntry.content))
    : undefined;

  const crTurnsSinceLastConcession = countTurnsSinceLastConcession(activeDebate, responderPover);
  const { background, topicScope } = resolveTopicFields(activeDebate);

  const pipelineInput: TurnPipelineInput = {
    label: info.label,
    pov: info.pov,
    personality: info.personality,
    ...crSouls, // t/3975: soul + opponentSouls
    topic,
    taxonomyContext: taxonomyBlock,
    commitmentContext: commitBlock,
    establishedPoints: establishedBlock,
    edgeContext: edgeBlock,
    concessionHint: concessionHint + debaterGapHint + interventionBriefInjection,
    recentTranscript: currentTranscript,
    focusPoint,
    addressing: addressingLabel,
    phase,
    priorMoves,
    priorRefs,
    availablePovNodeIds,
    turnsSinceLastConcession: crTurnsSinceLastConcession,
    pendingIntervention: pendingInterventionData,
    sourceContent: resolveSourceContent(crDocAnalysis, activeDebate),
    documentAnalysis: crDocAnalysis,
    audience: activeDebate.audience,
    model: getSpeakerModel(activeDebate, responderPover, model),
    ...resolveStageModels(activeDebate),
    sourceEvidenceIndex: evidenceIndex as TurnPipelineInput['sourceEvidenceIndex'],
    docTitles: docTitles as TurnPipelineInput['docTitles'],
    background,
    topicScope,
    preCheckModel: resolveTurnValidationConfig(undefined).preCheckModel,
    lastOpponentStatement,
  };

  const stageGenerate = makeStageGenerate(set as (partial: Record<string, unknown>) => void, getSpeakerModel(activeDebate, responderPover, model), servedTurnRecorder(get, set, responderPover));
  return { info, ctx, taxonomyBlock, commitBlock, concessionCandidateIds, pipelineInput, stageGenerate };
}

// ── buildModeratorTrace / runModeratorStep helpers ──────────────────────────

function buildInterventionTrace(
  selectionResult: SelectionResult | null,
  engineValidation: import('@lib/debate/types').EngineValidationResult,
): Record<string, unknown> {
  return {
    intervention_recommended: selectionResult?.intervene ?? false,
    intervention_source: selectionResult?.intervene ? (selectionResult.trigger_source ?? 'moderator') : null,
    intervention_move: selectionResult?.suggested_move ?? null,
    intervention_validated: engineValidation?.proceed ?? false,
    intervention_suppressed_reason: engineValidation?.suppressed_reason ?? null,
    intervention_suppression_explanation: engineValidation?.suppression_explanation ?? null,
    intervention_target: selectionResult?.target_debater ?? null,
    trigger_reasoning: selectionResult?.trigger_reasoning ?? null,
    trigger_evidence: selectionResult?.trigger_evidence ?? null,
  };
}

function buildCandidateScores(
  anNodes: NonNullable<DebateSession['argument_network']>['nodes'],
  aiPovers: _AiPover[],
  lastSpeaker: Exclude<SpeakerId, 'user'> | undefined,
) {
  return aiPovers
    .filter(p => p !== lastSpeaker)
    .map((p, i) => {
      const poverClaims = anNodes.filter(n => n.speaker === p);
      const scoredClaims = poverClaims.filter(n => n.computed_strength != null);
      const avgStrength = scoredClaims.length > 0
        ? scoredClaims.reduce((sum, n) => sum + n.computed_strength!, 0) / scoredClaims.length
        : null;
      return { debater: POVER_INFO[p].label, computed_strength: avgStrength, claim_count: poverClaims.length, scored_count: scoredClaims.length, rank: i + 1 };
    });
}

function buildCommitmentSnapshot(
  aiPovers: _AiPover[],
  commitments: DebateSession['commitments'],
): Record<string, unknown> {
  return Object.fromEntries(
    aiPovers.map(p => [
      POVER_INFO[p].label,
      {
        asserted: (commitments?.[p]?.asserted ?? []).length,
        conceded: (commitments?.[p]?.conceded ?? []).length,
        challenged: (commitments?.[p]?.challenged ?? []).length,
      },
    ])
  );
}

function resolveLastSpeakerLabel(lastSpeaker: Exclude<SpeakerId, 'user'> | undefined): string | null {
  if (!lastSpeaker) return null;
  return POVER_INFO[lastSpeaker]?.label ?? lastSpeaker;
}

function resolveConvergenceScore(activeDebate: DebateSession): number | null {
  return activeDebate.convergence_tracker?.issues?.[0]?.convergence ?? null;
}

function shouldRetryModerator(retryable: boolean, err: unknown, modPass: number, cooldownMs: number, remainingMs: number, maxRetries: number, retryCap: number): boolean {
  return retryable && !isDailyLimitError(err) && modPass < maxRetries && cooldownMs <= remainingMs && cooldownMs <= retryCap;
}

function handleModeratorTerminalError(err: unknown, activeDebate: DebateSession, get: _Get, set: _Set): null {
  getGlobalRecorder()?.record({
    type: 'system.error',
    debate_id: activeDebate?.id,
    component: 'debate-store',
    level: 'error',
    message: 'Cross-respond moderator selection failed',
    error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
  });
  releaseDebateDriver();
  set({ debateProgress: null });
  if (isDailyLimitError(err)) {
    set({ debateError: DAILY_LIMIT_MESSAGE, dailyLimitPaused: true, debateGenerating: null });
    getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'info', debate_id: activeDebate.id, message: 'debate.paused', data: { reason: 'daily_token_limit' } });
  } else {
    set({ debateError: `Cross-respond selection failed: ${mapErrorToUserMessage(err)}`, debateRetryAction: 'crossRespond', debateGenerating: null });
    getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'info', debate_id: activeDebate.id, message: 'debate.ended', data: { reason: 'error', error: String(err) } });
  }
  return null;
}

async function handleModeratorAgreementEarly(
  activeDebate: DebateSession, crossRespondRound: number, phase: DebatePhase,
  modResult: Awaited<ReturnType<typeof runModeratorSelection>>,
  get: _Get, set: _Set, saveDebate: _SaveDebate,
): Promise<null> {
  getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'info', debate_id: activeDebate.id, message: 'Agreement detected — skipping debater turn', data: { round: crossRespondRound, phase, focus: modResult.focusPoint } });
  const freshDebate = get().activeDebate;
  if (freshDebate) {
    set({ activeDebate: { ...freshDebate, moderator_state: modResult.modState } });
  }
  releaseDebateDriver();
  set({ debateGenerating: null });
  getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'info', debate_id: activeDebate.id, message: 'debate.ended', data: { reason: 'agreement_detected', round: crossRespondRound } });
  await saveDebate('crossRespond:agreement');
  return null;
}

function buildModeratorTrace(activeDebate: DebateSession, aiPovers: _AiPover[], responderPover: _ModResult['responder'], focusPoint: _ModResult['focusPoint'], modResult: _ModResult, modState: ModeratorState, engineValidation: import('@lib/debate/types').EngineValidationResult, selectionResult: SelectionResult | null, healthScore: _ModResult['healthScore']): Record<string, unknown> {
  const anNodes = activeDebate.argument_network?.nodes ?? [];
  const lastSpeakerEntry = [...activeDebate.transcript].reverse().find(
    (e) => (e.type === 'statement' || e.type === 'opening') && e.speaker !== 'user' && e.speaker !== 'system',
  );
  const lastSpeaker = lastSpeakerEntry?.speaker as Exclude<SpeakerId, 'user'> | undefined;
  return {
    selected: POVER_INFO[responderPover].label,
    excluded_last_speaker: resolveLastSpeakerLabel(lastSpeaker),
    candidates: buildCandidateScores(anNodes, aiPovers, lastSpeaker),
    convergence_score: resolveConvergenceScore(activeDebate),
    convergence_triggered: false,
    commitment_snapshot: buildCommitmentSnapshot(aiPovers, activeDebate.commitments),
    selection_reason: 'moderator_ai_selection',
    focus_point: focusPoint,
    selection_prompt: modResult.diagnostics.selectionPrompt,
    selection_response: modResult.diagnostics.selectionResponse,
    health_score: healthScore.value,
    health_components: healthScore.components,
    health_trend: healthScore.trend,
    ...buildInterventionTrace(selectionResult, engineValidation),
    budget_remaining: modState.budget_remaining,
    budget_total: modState.budget_total,
    cooldown_rounds_left: Math.max(0, modState.required_gap - modState.rounds_since_last_intervention),
    burden_per_debater: { ...modState.burden_per_debater },
  };
}

async function runModeratorStep(selectionInput: ModeratorSelectionInput, selectionCallbacks: ModeratorSelectionCallbacks, activeDebate: DebateSession, crossRespondRound: number, phase: DebatePhase, isStillValid: () => boolean, get: _Get, set: _Set, saveDebate: _SaveDebate): Promise<_ModResult | null> {
  // t/3053: bounded backoff loop around moderator selection.
  const MAX_MOD_RETRIES = 2;
  const MOD_RETRY_BUDGET_MS = 2 * 60 * 1000;
  const MOD_RETRY_CAP_MS = 30_000;
  const modStartedAt = Date.now();
  let modResult!: Awaited<ReturnType<typeof runModeratorSelection>>;
  for (let modPass = 0; ; modPass++) {
    try {
      modResult = await runModeratorSelection(selectionInput, selectionCallbacks);
      if (!isStillValid()) {
        getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'info', debate_id: activeDebate.id, message: 'crossRespond aborted post-moderator — debate no longer valid' });
        releaseDebateDriver(); set({ debateProgress: null }); return null;
      }
      set({ debateProgress: null });
      break;
    } catch (err) {
      if (isCancellationError(err)) { releaseDebateDriver(); set({ debateGenerating: null, debateActivity: null, debateProgress: null }); return null; }
      const { retryable } = classifyAiRetry(err);
      const cooldownMs = parseRetryAfterMs(err) ?? 5000;
      const remainingMs = MOD_RETRY_BUDGET_MS - (Date.now() - modStartedAt);
      if (shouldRetryModerator(retryable, err, modPass, cooldownMs, remainingMs, MAX_MOD_RETRIES, MOD_RETRY_CAP_MS)) {
        getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'warn', debate_id: activeDebate.id, message: 'Cross-respond moderator selection rate-limited — backing off', data: { round: crossRespondRound, attempt: modPass + 1, retry_in_ms: cooldownMs } });
        set({ debateProgress: { attempt: modPass + 1, maxRetries: MAX_MOD_RETRIES, backoffSeconds: Math.ceil(cooldownMs / 1000), phase: 'retry' } });
        await new Promise(resolve => setTimeout(resolve, cooldownMs));
        if (!isStillValid()) { releaseDebateDriver(); set({ debateGenerating: null, debateProgress: null }); return null; }
        continue;
      }
      return handleModeratorTerminalError(err, activeDebate, get, set);
    }
  }
  if (modResult.earlyReturn && modResult.agreementDetected) {
    return handleModeratorAgreementEarly(activeDebate, crossRespondRound, phase, modResult, get, set, saveDebate);
  }
  return modResult;
}

// ── _crossRespondLeased decomposition helpers (CC-reduction pass, PR #4089) ──
// Ten focused helpers extracted from _crossRespondLeased to bring it from CC≈33 to CC≈9.
// Behavior preserved verbatim — pure structural extraction, no logic changes.

function fixOpeningPhaseTransition(activeDebate: DebateSession, get: _Get): void {
  if (activeDebate.phase === 'opening' && activeDebate.transcript.some(e => e.type === 'opening')) {
    get().updatePhase('debate');
  }
}

async function ensureEdgesLoaded(): Promise<void> {
  const taxState = useTaxonomyStore.getState();
  if (!taxState.edgesFile) {
    await useTaxonomyStore.getState().loadEdges();
  }
}

function persistModeratorStateUpdate(get: _Get, set: _Set, modState: ModeratorState): void {
  const freshDebate = get().activeDebate;
  if (freshDebate) {
    set({ activeDebate: { ...freshDebate, moderator_state: modState } });
  }
}

function enrichTaxonomyRefScores(
  ctx: { nodeScores?: Map<string, number> },
  taxonomyRefs: { node_id: string; relevance_score?: number }[],
): void {
  if (!ctx.nodeScores) return;
  for (const ref of taxonomyRefs) {
    const score = ctx.nodeScores.get(ref.node_id);
    if (score != null) ref.relevance_score = score;
  }
}

function buildCaveatsFromValidation(
  validation: { repairHints?: string[] },
  pipelineResult: { stage_diagnostics: { stage: string; work_product?: unknown }[] },
): string[] | undefined {
  const CITE_RE = /taxonomy_refs.*(?:filler|too-short|relevance)|No new taxonomy_refs|Unknown taxonomy node|Unknown policy_refs|grounding_confidence/i;
  const DRAFT_RE = /move_types|my_claims|paragraph|statement|hedge|constructive|pin_response|probe_response|challenge_response|clarification|check_response|revoice|reflection|compressed_thesis|commitment/i;
  const caveats = (validation.repairHints ?? []).filter((h: string) =>
    !CITE_RE.test(h) && !DRAFT_RE.test(h)
  );
  const evidenceDiag = pipelineResult.stage_diagnostics.find((s: { stage: string }) => s.stage === 'evidence');
  const ungroundedClaims = (evidenceDiag?.work_product as Record<string, unknown>)?.ungrounded_claims as
    Array<{ claim: string; reason: string }> | undefined;
  if (ungroundedClaims?.length) {
    for (const uc of ungroundedClaims) {
      caveats.push(`[Ungrounded] ${uc.claim}`);
    }
  }
  return caveats.length > 0 ? caveats : undefined;
}

function buildCrossRespondEntryMetadata(
  crossRespondRound: number,
  focusPoint: string | undefined,
  addressingLabel: string | undefined,
  moderatorTrace: Record<string, unknown>,
  meta: PoverResponseMeta & Record<string, unknown>,
  relevanceSources: unknown,
  validation: { outcome: string; score?: number },
  attempts: TurnAttempt[],
  concessionCandidateIds: string[],
  ctx: { injectionManifest?: unknown },
): Record<string, unknown> {
  return {
    cross_respond: true, round: crossRespondRound,
    focus_point: focusPoint, addressing_label: addressingLabel,
    moderator_trace: moderatorTrace, ...meta,
    relevance_sources: relevanceSources,
    turn_validation_outcome: validation.outcome,
    turn_validation_score: validation.score,
    turn_validation_attempts: attempts.length,
    turn_validation_flagged: validation.outcome === 'accept_with_flag' ? true : undefined,
    concession_candidates_offered: concessionCandidateIds.length > 0 ? concessionCandidateIds : undefined,
    concession_considered: (meta as Record<string, unknown>)?.concession_considered as string | undefined,
    injection_manifest: ctx.injectionManifest,
  };
}

function persistValidationTrail(
  get: _Get,
  set: _Set,
  validation: TurnValidation,
  attempts: TurnAttempt[],
  lastId: string | undefined,
): void {
  if (!lastId) return;
  const curr = get().activeDebate;
  if (!curr) return;
  const trail: TurnValidationTrail = { attempts, final: validation };
  const trails = { ...(curr.turn_validations ?? {}), [lastId]: trail };
  let suggestions = curr.taxonomy_suggestions;
  if (validation.clarifies_taxonomy.length > 0) {
    suggestions = routeTurnValidatorHintsIntoSuggestions(validation, lastId, suggestions);
  }
  set({ activeDebate: { ...curr, turn_validations: trails, taxonomy_suggestions: suggestions } });
}

async function recordLastEntryDiagnosticsAndDrift(
  lastEntry: TranscriptEntry | undefined,
  get: _Get,
  set: _Set,
  addTranscriptEntry: _AddEntry,
  pipelineResult: Awaited<ReturnType<typeof runTurnPipeline>>,
  model: string,
  taxonomyBlock: string,
  commitBlock: string,
  statement: string,
  responderPover: _AiPover,
  crossRespondRound: number,
  info: _PoverInfo,
  activeDebate: DebateSession,
  stageGenerate: ReturnType<typeof makeStageGenerate>,
  pipelineInput: TurnPipelineInput,
  taxonomyRefs: { node_id: string }[],
  meta: PoverResponseMeta,
): Promise<void> {
  if (!lastEntry) return;
  const draftDiag = pipelineResult.stage_diagnostics.find(s => s.stage === 'draft');
  const topicAlignDiag = pipelineResult.topicAlignmentResult
    ? {
      topic_aligned: pipelineResult.topicAlignmentResult.topic_aligned,
      repaired: pipelineResult.topicAlignmentResult.repaired || undefined,
      draft_attempt: pipelineResult.topicAlignmentResult.draft_attempt,
      scope_used: get().activeDebate?.topic?.scope ?? null,
    }
    : undefined;
  recordDiagnostic(get, set, lastEntry.id, {
    prompt: draftDiag?.prompt ?? '',
    raw_response: draftDiag?.raw_response ?? '',
    model,
    response_time_ms: pipelineResult.total_time_ms,
    taxonomy_context: taxonomyBlock,
    commitment_context: commitBlock || undefined,
    stage_diagnostics: pipelineResult.stage_diagnostics,
    topic_alignment: topicAlignDiag,
    quality_gate: pipelineResult.qualityGateResult,
  });
  void extractClaimsAndUpdateAN(statement, responderPover, lastEntry.id, taxonomyRefs.map(r => r.node_id), get, set, meta.my_claims,
    async (guidance) => {
      try {
        const regenPipelineInput = {
          ...pipelineInput,
          frozenBrief: pipelineResult.brief,
          strongFoundations: guidance.strongFoundations,
          avoidClaims: guidance.avoidClaims,
        };
        const regenPipelineResult = await runTurnPipeline(regenPipelineInput as TurnPipelineInput, stageGenerate, (_stage, label) => set({ debateActivity: `Regenerating: ${label}` }));
        const regenAssembled = assemblePipelineResult(regenPipelineResult, getAllKnownNodeIds());
        if (!regenAssembled) return null;
        const { statement: newStatement, meta: newMeta } = regenAssembled;
        return { statement: newStatement, debaterClaims: newMeta.my_claims };
      } catch (err) {
        if (isCancellationError(err)) throw err;
        getGlobalRecorder()?.record({
          type: 'system.error',
          debate_id: activeDebate?.id,
          component: 'debate-store',
          level: 'warn',
          message: 'Lookahead response regeneration failed',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        console.warn('[Lookahead] Response regeneration failed:', err);
        return null;
      }
    },
  );
  await summarizeTranscriptEntry(lastEntry.id, statement, info.label, model, get, set);
  await detectPositionDrift(get, set, addTranscriptEntry, activeDebate, responderPover, info, crossRespondRound, statement);
  await updateNarrativeSimilarity(get, set, lastEntry.id, responderPover, statement);
}

function checkNeutralMidpointCheckpoint(
  get: _Get,
  set: _Set,
  addTranscriptEntry: _AddEntry,
  crossRespondRound: number,
  activeDebate: DebateSession,
): void {
  try {
    const midDebate = get().activeDebate;
    if (midDebate && !(midDebate.neutral_evaluations ?? []).some(e => e.checkpoint === 'midpoint')) {
      const midTotal = get().initialCrossRespondRounds || 5;
      const midRound = Math.ceil(midTotal / 2) + 1;
      const curRound = midDebate.transcript.filter(e => e.type === 'statement').length;
      if (curRound === midRound) {
        void runNeutralCheckpoint('midpoint', get, set as any, addTranscriptEntry as Parameters<typeof runNeutralCheckpoint>[3]);
      }
    }
  } catch (e) {
    getGlobalRecorder()?.record({ type: 'system.error', debate_id: activeDebate?.id, component: 'debate-store', level: 'warn', message: 'Neutral midpoint checkpoint failed', error: { name: (e as Error).name ?? 'Error', message: String(e), stack: (e as Error).stack } });
  }
}

function handleTurnPipelineError(
  get: _Get,
  set: _Set,
  addTranscriptEntry: _AddEntry,
  activeDebate: DebateSession,
  info: _PoverInfo,
  responderPover: _AiPover,
  crossRespondRound: number,
  err: unknown,
): void {
  getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-store', level: 'error', debate_id: activeDebate.id, message: `Pipeline failed for ${responderPover} R${crossRespondRound}`, data: { round: crossRespondRound, speaker: responderPover, error: String(err), stack: (err as Error).stack?.slice(0, 500), transcript_length: get().activeDebate?.transcript.length } });
  if (isDailyLimitError(err)) {
    addTranscriptEntry({ type: 'system', speaker: 'system', content: DAILY_LIMIT_MESSAGE, taxonomy_refs: [] });
    releaseDebateDriver();
    set({ debateGenerating: null, debateActivity: null, debateError: DAILY_LIMIT_MESSAGE, dailyLimitPaused: true });
    getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'info', debate_id: activeDebate.id, message: 'debate.paused', data: { reason: 'daily_token_limit', round: crossRespondRound, speaker: responderPover } });
    return;
  }
  // t/3053: idempotent per-round turn-failure marker (mirror t/2907 slot-lifecycle). Each retry
  // for a failed turn adds no statement — refresh ONE marker for this round instead of appending.
  const turnFailureContent = `${info.label} failed to cross-respond: ${mapErrorToUserMessage(err)}`;
  const existingFailure = get().activeDebate?.transcript.find(
    e => e.type === 'system'
      && (e.metadata as Record<string, unknown> | undefined)?.turn_failure === true
      && (e.metadata as Record<string, unknown> | undefined)?.round === crossRespondRound,
  );
  if (existingFailure) {
    get().updateTranscriptEntry(existingFailure.id, { content: turnFailureContent, metadata: { turn_failure: true, round: crossRespondRound } });
  } else {
    addTranscriptEntry({ type: 'system', speaker: 'system', content: turnFailureContent, taxonomy_refs: [], metadata: { turn_failure: true, round: crossRespondRound } });
  }
  getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'error', debate_id: activeDebate.id, message: 'debate.turn_failed', data: { reason: 'pipeline_error', round: crossRespondRound, speaker: responderPover, error: String(err) } });
}
