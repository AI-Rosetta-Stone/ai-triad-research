// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { StateCreator } from 'zustand';
import type { DebateStore } from '../types';
import { buildDebateResponsePrompt, formatGapHint } from '../shared/prompts';
import { seatSouls } from '../shared/seatSouls';
import type { ReflectionEdit, ReflectionResult } from '../types';
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
import type { ProcessRewardEntry } from '@lib/debate/types';
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
import { cosineSimilarity, scoreNodesLexical } from '../../../utils/taxonomyRelevance';
import { getConfiguredModel, getSpeakerModel } from '../shared/modelConfig';
import { generateTextWithProgress, phaseGuardedSet, summarizeTranscriptEntry, makeStageGenerate, routeTurnValidatorHintsIntoSuggestions, getSourceEvidenceIndex, getDocTitles } from '../shared/generation';
import { createDebateGuard, newAbortController, _abortController, claimDebateDriver, releaseDebateDriver, isDailyLimitError, DAILY_LIMIT_MESSAGE, isCancellationError } from '../shared/guards';
import { pushWarning, recordDiagnostic, recordSignalHistory, getSignalValue, movingAverageSignal, incrementGapInjectionCount, _gapInjectionCount } from '../shared/diagnostics';
import { runNeutralCheckpoint } from '../shared/neutralCheckpoint';
import { buildLineageContext, enrichPolicyRefs, serializeNodeSourceMap, formatEdgeContext, formatDebaterEdgeContext, getRelevantTaxonomyContext, getAllKnownNodeIds, getAllPolicyIds, findNodeMetaInStore, getTaxonomyContext } from '../shared/taxonomyContext';
import { extractClaimsAndUpdateAN, commitAnNodes, detectZeroClaims } from '../shared/argumentNetwork';

export interface DebateLoopSlice {
  askQuestion: (input: string) => Promise<void>;
  generateNewsReport: () => Promise<void>;
  clearEnrichmentStatus: (nodeId: string) => void;
}

export const createDebateLoopSlice: StateCreator<DebateStore, [], [], DebateLoopSlice> = (set, get) => ({
  askQuestion: async (input: string) => {
    const { activeDebate, addTranscriptEntry, saveDebate } = get();
    if (!activeDebate || !input.trim()) return;

    const isStillValid = createDebateGuard(get);
    set({ debateError: null, debateWarnings: [] });

    // Parse @-mentions to determine targets
    const { targets, cleanedInput } = parseAtMention(input);

    // Validate targets are active POVers
    for (const t of targets) {
      if (!activeDebate.active_povers.includes(t)) {
        const label = t === 'user' ? 'You' : POVER_INFO[t as Exclude<SpeakerId, 'user'>]?.label || t;
        set({ debateError: `${label} is not in this debate` });
        return;
      }
    }

    // Add user's question to transcript
    addTranscriptEntry({
      type: 'question',
      speaker: 'user',
      content: input,
      taxonomy_refs: [],
      addressing: targets.length === 1 ? targets[0] : 'all',
    });

    const model = getConfiguredModel();
    const topic = activeDebate.topic.final;

    // Determine which AI POVers should respond
    const aiPovers = AI_POVERS.filter((p) => activeDebate.active_povers.includes(p));
    const respondingPovers = targets.length > 0
      ? aiPovers.filter((p) => targets.includes(p)) // Targeted: only mentioned POVers
      : aiPovers; // All active AI POVers

    if (respondingPovers.length === 0) {
      // User targeted themselves or no AI POVers — nothing to generate
      await saveDebate('askQuestion:noResponders');
      return;
    }

    const recentTranscript = formatRecentTranscript(get().activeDebate!.transcript, 8, get().activeDebate!.context_summaries);

    // Generate responses sequentially so each sees prior responses
    for (const poverId of respondingPovers) {
      set({ debateGenerating: poverId, debateStepStartedAt: Date.now() });

      const souls = seatSouls(activeDebate, poverId); // t/3975: tag-aware soul for this seat
      const info = souls.soul;
      const currentTranscriptForRelevance = formatRecentTranscript(get().activeDebate!.transcript, 4, get().activeDebate!.context_summaries);
      const ctx = await getRelevantTaxonomyContext(info.pov, topic, currentTranscriptForRelevance);
      const speakerClaims = (get().activeDebate?.argument_network?.nodes || []).filter(n => n.speaker === poverId);
      const commitBlock = formatCommitments(
        get().activeDebate?.commitments?.[poverId] || { asserted: [], conceded: [], challenged: [] },
        speakerClaims,
      );
      const allANNodes = (get().activeDebate?.argument_network?.nodes || []).map(n => ({
        id: n.id, text: n.text, speaker: POVER_INFO[n.speaker as Exclude<SpeakerId, 'user'>]?.label || n.speaker,
      }));
      const establishedBlock = formatEstablishedPoints(allANNodes, info.label, 10);
      const edgeBlock = formatDebaterEdgeContext(info.pov);
      const taxonomyBlock = formatTaxonomyContext(ctx, info.pov) + commitBlock + establishedBlock + edgeBlock;

      // Use the most current transcript (includes responses from prior POVers in this round)
      const currentTranscript = formatRecentTranscript(get().activeDebate!.transcript, 8, get().activeDebate!.context_summaries);

      const drDocAnalysis = activeDebate.document_analysis;
      const prompt = buildDebateResponsePrompt(
        souls,
        topic,
        taxonomyBlock,
        currentTranscript,
        cleanedInput,
        targets.length > 0 ? poverId : 'all',
        drDocAnalysis ? undefined : (activeDebate.source_content || undefined),
        get().responseLength,
        drDocAnalysis,
        activeDebate.audience,
        buildLineageContext(),
      );

      try {
        const speakerModel = getSpeakerModel(activeDebate, poverId, model);
        const t0 = Date.now();
        const { text } = await generateTextWithProgress(prompt, speakerModel, `${POVER_INFO[poverId].label} is responding (${speakerModel})`, set);
        const responseTime = Date.now() - t0;
        if (!isStillValid()) return;
        const { statement, taxonomyRefs, meta } = parsePoverResponse(text);

        // Enrich taxonomy refs with relevance scores from context injection
        if (ctx.nodeScores) {
          for (const ref of taxonomyRefs) {
            const score = ctx.nodeScores.get(ref.node_id);
            if (score != null) ref.relevance_score = score;
          }
        }

        // Serialize source tracking for diagnostics display
        const relevanceSources = serializeNodeSourceMap(ctx.nodeSourceMap, taxonomyRefs);

        addTranscriptEntry({
          type: 'statement',
          speaker: poverId,
          content: statement,
          taxonomy_refs: taxonomyRefs,
          policy_refs: meta.policy_refs,
          addressing: 'user',
          metadata: { ...meta, relevance_sources: relevanceSources, injection_manifest: ctx.injectionManifest },
        });

        const lastEntry = get().activeDebate?.transcript.slice(-1)[0];
        if (lastEntry) {

          recordDiagnostic(get, set, lastEntry.id, {
            prompt,
            raw_response: text,
            model,
            response_time_ms: responseTime,
            taxonomy_context: taxonomyBlock,
            commitment_context: commitBlock || undefined,
          });
          void extractClaimsAndUpdateAN(statement, poverId, lastEntry.id, taxonomyRefs.map(r => r.node_id), get, set, meta.my_claims);
          await summarizeTranscriptEntry(lastEntry.id, statement, info.label, model, get, set);
        }
      } catch (err) {
        // User cancel / model switch (t/2508) — bail quietly, no error toast (helper logged info).
        if (isCancellationError(err)) { set({ debateGenerating: null }); return; }
        getGlobalRecorder()?.record({
          type: 'system.error',
          debate_id: activeDebate?.id,
          component: 'debate-store',
          level: 'error',
          message: `${info.label} failed to respond (user prompt)`,
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        addTranscriptEntry({
          type: 'system',
          speaker: 'system',
          content: `${info.label} failed to respond: ${mapErrorToUserMessage(err, { kind: 'ai' })}`,
          taxonomy_refs: [],
        });
      }

      // Socratic step mode (t/2516): one AI response per user question. Break after the
      // first responder so generation pauses for the user's next question instead of
      // letting the remaining respondingPovers auto-run. Placed at the end of the loop
      // body (after the try/catch) so exactly one turn is produced even if it errored.
      // protocol_id + step_mode are set at debate creation and don't change mid-turn.
      if (activeDebate.adaptive_staging?.step_mode && activeDebate.protocol_id === 'socratic') {
        break;
      }
    }

    set({ debateGenerating: null });
    await saveDebate('askQuestion:end');
  },

  generateNewsReport: async () => {
    const { activeDebate } = get();
    if (!activeDebate) return;
    const hasSynthesis = activeDebate.transcript.some(e => (e.type as string) === 'synthesis' || e.type === 'concluding');
    if (!hasSynthesis) {
      set({ newsReportError: 'A synthesis must exist before generating a news report.' });
      return;
    }
    set({ newsReportLoading: true, newsReportError: null, newsReport: null });
    try {
      const result = await api.generateNewsReport(activeDebate.id);
      set({ newsReport: result.article, newsReportLoading: false });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isMissingSynthesis = /synthesis must exist/i.test(errMsg);

      getGlobalRecorder()?.record({
        type: 'system.error',
        debate_id: activeDebate?.id,
        component: 'debate-store',
        level: isMissingSynthesis ? 'warn' : 'error',
        message: isMissingSynthesis ? 'News report failed — synthesis not persisted, attempting save & retry' : 'News report generation failed',
        error: { name: (err as Error).name ?? 'Error', message: errMsg, stack: (err as Error).stack },
      });

      if (isMissingSynthesis) {
        try {
          await get().saveDebate('news-report-save-retry');
          const retryResult = await api.generateNewsReport(activeDebate.id);
          set({ newsReport: retryResult.article, newsReportLoading: false });
          return;
        } catch (retryErr) {
          getGlobalRecorder()?.record({
            type: 'system.error',
            debate_id: activeDebate?.id,
            component: 'debate-store',
            level: 'error',
            message: 'News report save & retry failed',
            error: { name: (retryErr as Error).name ?? 'Error', message: String(retryErr), stack: (retryErr as Error).stack },
          });
          set({
            newsReportError: 'Your debate synthesis wasn\'t saved to the server. The auto-save attempt failed — please save the debate manually and try again.',
            newsReportLoading: false,
          });
          return;
        }
      }

      set({ newsReportError: `News report generation failed: ${errMsg}`, newsReportLoading: false });
    }
  },


  clearEnrichmentStatus: (nodeId: string) => {
    const current = { ...get().enrichmentStatus };
    delete current[nodeId];
    set({ enrichmentStatus: current });
  },
});

