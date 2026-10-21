// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { StateCreator } from 'zustand';
import type { DebateStore } from '../types';
import { buildClarificationPrompt, buildSynthesisPrompt } from '../shared/prompts';
import { seatSouls } from '../shared/seatSouls';
import type {
  DebateSession,
  SpeakerId,
  TranscriptEntry,
  DocumentAnalysis,
  ArgumentNetworkNode,
} from '../../../types/debate';
import { POVER_INFO, AI_POVERS } from '../../../types/debate';
import type { TopicScope, TopicScopeRiskLevel } from '@lib/debate/types';
import type { PovNode, CrossCuttingNode as SituationNode } from '../../../types/taxonomy';
import type { StandardizedTerm, ColloquialTerm } from '@lib/dictionary/types';
import type { OpeningPipelineInput, BriefEventFn } from '@lib/debate/turnPipeline';
import { api, emitBriefTimeout, emitBriefRetriesExhausted } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { generateId, nowISO, parseAIJson, parsePoverResponse, formatRecentTranscript } from '@lib/debate/helpers';
import { formatTaxonomyContext } from '../../../utils/taxonomyContext';
import { classifyAiRetry, retryReasonLabel, parseRetryAfterMs } from '../../../utils/retryClassifier';
import { formatCommitments, formatEstablishedPoints } from '../../../prompts/argumentNetwork';
import { formatVocabularyContext } from '@lib/debate/vocabularyContext';
import {
  situationClarificationPrompt,
  documentClarificationPrompt,
  userSeedClaimsPrompt,
} from '../../../prompts/debate';
import { critiqueTopicPrompt, parseTopicCritique } from '@lib/debate/topicCritique';
import { decomposeResolutionPrompt, topicScopeExtractionPrompt, setTopicScope } from '@lib/debate/prompts';
import { documentAnalysisPrompt, buildTaxonomySample } from '@lib/debate/documentAnalysis';
import { runOpeningPipelineWithRepair, assembleOpeningPipelineResult } from '@lib/debate/turnPipeline';
import { getModelMinTimeout, getDefaultTimeout } from '@lib/ai-client/index';
import type { ModelRegistry } from '@lib/ai-client/registry';
import aiModelsRegistry from '../../../../../../ai-models.json';
import { loadProvisionalWeights, effectiveRoundCap, maxTurnCeiling } from '@lib/debate/phaseTransitions';
import type { PhaseTransitionConfig } from '@lib/debate/types';
import { useTaxonomyStore } from '../../useTaxonomyStore';
import { mapErrorToUserMessage } from '../../../utils/errorMessages';
import { isLineageDataLoaded } from '../../../data/lineageCategories';
import { getConfiguredModel, getSpeakerModel, resolveBriefModel } from '../shared/modelConfig';
import { generateTextWithProgress, summarizeTranscriptEntry, makeStageGenerate, servedTurnRecorder } from '../shared/generation';
import { createDebateGuard, newAbortController, _abortController, claimDebateDriver, releaseDebateDriver, isDailyLimitError, DAILY_LIMIT_MESSAGE, isCancellationError } from '../shared/guards';
import type { RunLease } from '../shared/debateRunLease';
import { isCompressionDue } from '../shared/compressionTrigger';
import { pushWarning, recordDiagnostic } from '../shared/diagnostics';
import { runNeutralCheckpoint } from '../shared/neutralCheckpoint';
import { runNarrativeVoicing, recordNarrativeCheck, finalizeNarrativeReference } from '../shared/narrativeVoicing';
import { narrativeBlockForDebater } from '@lib/debate/narrativeVoicing';
import { buildLineageContext, getRelevantTaxonomyContext, formatDebaterEdgeContext, enrichPolicyRefs, serializeNodeSourceMap, getAllKnownNodeIds, getSelectableNodeIds } from '../shared/taxonomyContext';
import { extractClaimsAndUpdateAN } from '../shared/argumentNetwork';

/** The AI's clarification response is spec'd as `questions: string[]`, but some models return
 *  structured items (`{ question, options }`) instead — normalize to a display string rather
 *  than let template interpolation produce "[object Object]" (t/3753). */
function normalizeClarificationQuestion(q: unknown): string {
  if (typeof q === 'string') return q;
  if (q !== null && typeof q === 'object' && 'question' in q) return String((q as Record<string, unknown>).question);
  return String(q);
}

export interface ClarificationSlice {
  runClarification: () => Promise<void>;
  submitAnswersAndSynthesize: (answers: string) => Promise<void>;
  beginDebate: () => Promise<void>;
  updateClaim: (claimId: string, newText: string) => void;
  deleteClaim: (claimId: string) => void;
  proceedToOpening: () => void;
  /**
   * Openings, then the auto cross-respond loop, as ONE run under the debate's run lease
   * (t/3917). `caller` names the trigger in the flight recorder. A second call while a run
   * owns the debate is refused. `supersedeLocal` replaces this window's own run (model-switch retry).
   */
  runOpeningStatements: (caller?: string, opts?: { supersedeLocal?: boolean }) => Promise<void>;
  /** Internal — the unguarded openings+loop body. Call `runOpeningStatements`, never this. */
  _runOpeningStatementsLeased: (lease: RunLease) => Promise<void>;
  submitUserOpening: (statement: string) => Promise<void>;
}

// ── runOpeningStatements sub-steps (t/1848 batch 4) ──────────────────
// Behavior-preserving extraction of the escape-free blocks (topic-scope,
// opening-embedding cache, auto-run cross-respond). Bodies moved verbatim.
// The per-speaker retry engine (method-exiting returns/breaks) is left for
// a follow-up — it needs a return-protocol refactor, higher risk.
async function extractTopicScope(get: () => DebateStore, set: (partial: any) => void, activeDebate: DebateSession, model: string, topic: string): Promise<void> {
    // Topic scope extraction (t/336) — extract before openings so scope constraints are active
    if (!activeDebate.topic.scope) {
      try {
        set({ debateActivity: 'Extracting topic scope...' });
        const scopePrompt = topicScopeExtractionPrompt(topic);
        const { text: scopeText } = await api.generateText(scopePrompt, model);
        const scopeParsed = parseAIJson<Record<string, unknown>>(scopeText);
        if (scopeParsed && typeof scopeParsed === 'object') {
          const validRiskLevels: TopicScopeRiskLevel[] = ['low', 'medium', 'high', 'catastrophic', 'unspecified'];
          const toArr = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
          const scope: TopicScope = {
            core_proposition: typeof scopeParsed.core_proposition === 'string' ? scopeParsed.core_proposition : topic,
            relevant_disciplines: toArr(scopeParsed.relevant_disciplines),
            on_scope_evidence: toArr(scopeParsed.on_scope_evidence),
            key_tensions: toArr(scopeParsed.key_tensions),
            off_scope_topics: toArr(scopeParsed.off_scope_topics),
            drift_signatures: toArr(scopeParsed.drift_signatures),
            example_ceiling: typeof scopeParsed.example_ceiling === 'string' ? scopeParsed.example_ceiling : '',
            risk_level: validRiskLevels.includes(scopeParsed.risk_level as TopicScopeRiskLevel) ? scopeParsed.risk_level as TopicScopeRiskLevel : 'unspecified',
            domain: typeof scopeParsed.domain === 'string' ? scopeParsed.domain : '',
            product_type: typeof scopeParsed.product_type === 'string' ? scopeParsed.product_type : null,
            time_horizon: typeof scopeParsed.time_horizon === 'string' ? scopeParsed.time_horizon : null,
            excluded_scenarios: toArr(scopeParsed.excluded_scenarios),
            explicit_qualifiers: toArr(scopeParsed.explicit_qualifiers),
            constraint_confidence: scopeParsed.constraint_confidence === 'explicit' ? 'explicit' : 'inferred',
          };
          setTopicScope(scope);
          const fresh = get().activeDebate;
          if (fresh) {
            set({ activeDebate: { ...fresh, topic: { ...fresh.topic, scope } } });
            await get().saveDebate('extractTopicScope');
          }
          getGlobalRecorder()?.record({
            type: 'topic_scope_extracted', debate_id: activeDebate?.id, component: 'debate-store', level: 'info',
            message: `Topic scope extracted (${scope.constraint_confidence})`,
            data: { core_proposition: scope.core_proposition, risk_level: scope.risk_level, off_scope_count: scope.off_scope_topics.length },
          });
        }
      } catch (err) {
        getGlobalRecorder()?.record({
          type: 'system.error', debate_id: activeDebate?.id, component: 'debate-store', level: 'warn',
          message: 'Topic scope extraction failed',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
      }
      set({ debateActivity: null });
    } else {
      setTopicScope(activeDebate.topic.scope);
    }
}

async function cacheOpeningEmbeddings(get: () => DebateStore, set: (partial: any) => void): Promise<void> {
    // Cache opening embeddings for position drift detection (non-blocking)
    try {
      const currentDebate = get().activeDebate;
      if (currentDebate) {
        const openingEmbeddings: Record<string, number[]> = {};
        for (const entry of currentDebate.transcript) {
          if (entry.type !== 'opening' || entry.speaker === 'system') continue;
          try {
            const result = await api.computeQueryEmbedding(entry.content.slice(0, 1000));
            openingEmbeddings[entry.speaker] = result.vector;
          } catch (e) { getGlobalRecorder()?.record({ type: 'system.error', debate_id: get().activeDebate?.id, component: 'debate-store', level: 'warn', message: 'Opening embedding computation failed', error: { name: (e as Error).name ?? 'Error', message: String(e), stack: (e as Error).stack } }); }
        }
        // Store on session metadata for cross-respond access
        if (Object.keys(openingEmbeddings).length > 0) {
          const d = get().activeDebate;
          if (d) {
            if (!d.metadata) d.metadata = {};
            d.metadata._openingEmbeddings = openingEmbeddings;
            set({ activeDebate: { ...d } });
          }
        }
      }
    } catch (e) { getGlobalRecorder()?.record({ type: 'system.error', debate_id: get().activeDebate?.id, component: 'debate-store', level: 'warn', message: 'Opening embeddings caching failed', error: { name: (e as Error).name ?? 'Error', message: String(e), stack: (e as Error).stack } }); }
}

/** Ceiling for the non-adaptive watch-only auto-run loop (t/3760) — matches the adaptive
 *  branch's default 'moderate' maxTotalRounds and the round count observed completing a
 *  full situation debate. Separate from `initialCrossRespondRounds`, which is also read
 *  elsewhere as a phase-labeling divisor and must stay small for that purpose. */
const WATCH_ONLY_MAX_CROSS_RESPOND_ROUNDS = 12;

/** The user-configurable opening order (randomized at proceedToOpening).
 *  Priority: Zustand state > persisted on the debate object > default order. */
function resolveOpeningOrder(openingOrder: readonly string[], debate: DebateSession): readonly string[] {
  if (openingOrder.length > 0) return openingOrder;
  if (debate.opening_order && debate.opening_order.length > 0) return debate.opening_order;
  return AI_POVERS;
}

/** t/3937: the adaptive loop's caps, in turns. `effectiveCap` is the engine's round cap
 *  (Σ phase bounds × speakers when a phaseBoundsOverride is set, else the preset).
 *  `turnCeiling` adds the scaled minimum concluding rounds, so a debate force-transitioned
 *  into concluding at the cap can still finish it. It's the engine's real terminate point
 *  and the loop's iteration limit. Normal endings come from phase_terminated. */
function resolveLoopCaps(
  presetMax: number,
  phaseBoundsOverride: PhaseTransitionConfig['phaseBoundsOverride'],
  debate: DebateSession | null | undefined,
): { presetMax: number; effectiveCap: number; turnCeiling: number; speakers: number } {
  const speakers = (debate?.active_povers ?? []).filter(p => (AI_POVERS as readonly string[]).includes(p)).length;
  const config = { maxTotalRounds: presetMax, phaseBoundsOverride } as PhaseTransitionConfig; // the only fields the cap functions read
  return { presetMax, effectiveCap: effectiveRoundCap(config, speakers), turnCeiling: maxTurnCeiling(config, speakers), speakers };
}

/** t/3917: an openings run is valid only while BOTH its abort guard and its run lease hold.
 *  A superseded lease then stops the run at every existing isStillValid() check: after
 *  voicing, after a retry backoff, and after each speaker's pipeline, before delivery. Without
 *  it, a superseded run re-delivers an opening and re-completes the openings phase alongside
 *  its replacement, the dump's duplicate-opening shape. */
function guardWithLease(debateGuard: () => boolean, lease: RunLease): () => boolean {
  return () => debateGuard() && lease.isValid();
}

/** t/3917: during an automatic run, the lease holder compresses between rounds. The UI effect
 *  stands down while a run lease exists, and the owner window may not even mount the workspace
 *  (a popped-out debate is driven by the main window under Option A), so without this a
 *  popped-out run would produce no context summaries. Live run 2 showed exactly that. */
async function compressIfDue(get: () => DebateStore, lease: RunLease): Promise<void> {
  const d = get().activeDebate;
  if (!d || !lease.isValid() || get().debateGenerating || !isCompressionDue(d)) return;
  await get().compressOldTranscript();
}

/** Runs under the caller's run lease (t/3917): every turn is passed `lease`, and the loop
 *  exits `lease_lost` the moment the lease is superseded or lost to another window. */
async function runInitialCrossRespondRounds(get: () => DebateStore, set: (partial: any) => void, activeDebate: DebateSession, lease: RunLease): Promise<void> {
    // Auto-run initial cross-respond rounds if configured
    const { initialCrossRespondRounds } = get();
    if (!activeDebate.user_is_pover) {
      const freshDebate = get().activeDebate;
      if (freshDebate?.protocol_id === 'socratic') return; // user-driven (ask/probe/summarize); no auto cross-respond loop

      // t/3782: back-compat for the legacy boolean shape (`adaptive_staging = true`) written
      // by SituationDebatePanel before its fix — coerce rather than treat as malformed, so an
      // existing broken session isn't left silently stuck on the dead non-adaptive path even
      // after the write-site fix lands (TL ruling, t/3782#2). Retire this once no persisted
      // session carries the boolean form.
      if (freshDebate && (freshDebate.adaptive_staging as unknown) === true) {
        getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-store', level: 'warn', debate_id: freshDebate.id, message: 'adaptive_staging was the legacy boolean form — coercing to {enabled:true, pacing:"moderate"}' });
        set({ activeDebate: { ...freshDebate, adaptive_staging: { enabled: true, pacing: 'moderate' } } });
      }

      const resolvedDebate = get().activeDebate;
      const adaptive = resolvedDebate?.adaptive_staging;
      // t/3782 AC: record the resolved adaptive config at debate start so a report of this
      // shape (a config setting that appeared to have no effect) is answerable from the dump.
      getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'info', debate_id: resolvedDebate?.id, message: 'Resolved adaptive config at debate start', data: { enabled: !!adaptive?.enabled, pacing: adaptive?.pacing ?? null, initial_cross_respond_rounds: initialCrossRespondRounds } });

      if (adaptive?.enabled) {
        // Adaptive: run until phase transitions signal termination (up to maxTotalRounds)
        const weights = loadProvisionalWeights();
        const pacingPresetName = adaptive.pacing ?? 'moderate';
        const pacingPreset = weights.pacing_presets[pacingPresetName] ?? weights.pacing_presets.moderate;
        // t/3937: loop to the engine's real terminate point (turns), not the pacing preset.
        const caps = resolveLoopCaps(pacingPreset?.maxTotalRounds ?? 12, adaptive.phase_bounds_override, resolvedDebate);
        const maxRounds = caps.turnCeiling;
        const loopDebateId = freshDebate?.id;
        getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'adaptive-loop', level: 'info', debate_id: loopDebateId, message: 'Adaptive loop started', data: { pacing: pacingPresetName, maxTotalRounds: caps.presetMax, effectiveCap: caps.effectiveCap, turnCeiling: caps.turnCeiling, speakers: caps.speakers, argumentationExit: pacingPreset?.argumentationExit, concludingExit: pacingPreset?.concludingExit } });
        let loopExitReason = 'maxRounds_exhausted';
        let loopIterations = 0;
        let consecutiveNoStatement = 0;
        for (let i = 0; i < maxRounds; i++) {
          loopIterations = i + 1;
          const d = get().activeDebate;
          if (!d) { loopExitReason = 'debate_null'; break; }
          if (!lease.isValid()) { loopExitReason = 'lease_lost'; break; }
          // Stop if phase reached termination
          if (d.adaptive_staging?.phase_state?.current_phase === 'terminated') { loopExitReason = 'phase_terminated'; break; }
          const preLen = d.transcript.length;
          try {
            await get().crossRespond({ lease, caller: 'adaptive-loop' });
          } catch (loopErr) {
            console.error(`[debate] Adaptive loop iteration ${i} failed:`, loopErr);
            getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-store', level: 'error', debate_id: d.id, message: `Adaptive loop failed at iteration ${i}`, data: { iteration: i, error: String(loopErr), stack: (loopErr as Error).stack?.slice(0, 500) } });
            if (isDailyLimitError(loopErr)) {
              set({ debateError: DAILY_LIMIT_MESSAGE, dailyLimitPaused: true });
              loopExitReason = 'daily_token_limit';
            } else {
              set({ debateError: `Cross-respond failed: ${(loopErr as Error).message?.slice(0, 200) ?? String(loopErr)}` });
              loopExitReason = 'crossRespond_error';
            }
            break;
          }
          if (get().dailyLimitPaused) { loopExitReason = 'daily_token_limit'; break; }
          const post = get().activeDebate;
          if (!post) { loopExitReason = 'post_debate_null'; break; }
          if (post.transcript.length === preLen) {
            loopExitReason = `no_transcript_growth(preLen=${preLen},postLen=${post.transcript.length})`;
            getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'adaptive-loop', level: 'warn', debate_id: loopDebateId, message: 'Loop break: no transcript growth', data: { iteration: i, preLen, postLen: post.transcript.length, phase: post.adaptive_staging?.phase_state?.current_phase } });
            break;
          }
          // If only system entries were added (moderator deliberation, phase transitions,
          // compression markers), continue — the debater didn't speak this iteration but
          // the loop should not exit prematurely. Break only after 3 consecutive rounds
          // without a debater statement to catch genuine stalls.
          if (!post.transcript.slice(preLen).some(e => e.type === 'statement')) {
            consecutiveNoStatement++;
            const newEntryTypes = post.transcript.slice(preLen).map(e => e.type);
            if (consecutiveNoStatement >= 3) {
              loopExitReason = `consecutive_no_statement(count=${consecutiveNoStatement},types=${newEntryTypes.join(',')})`;
              getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'adaptive-loop', level: 'warn', debate_id: loopDebateId, message: 'Loop break: 3 consecutive rounds without debater statement', data: { iteration: i, consecutiveNoStatement, preLen, postLen: post.transcript.length, newEntryTypes, phase: post.adaptive_staging?.phase_state?.current_phase } });
              break;
            }
            getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'adaptive-loop', level: 'debug', debate_id: loopDebateId, message: 'No statement in new entries — continuing', data: { iteration: i, consecutiveNoStatement, newEntryTypes, phase: post.adaptive_staging?.phase_state?.current_phase } });
            continue;
          }
          consecutiveNoStatement = 0;
          await compressIfDue(get, lease);
        }
        // Log loop completion with full context
        const finalDebate = get().activeDebate;
        const finalPhase = finalDebate?.adaptive_staging?.phase_state?.current_phase;
        getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'adaptive-loop', level: 'info', debate_id: loopDebateId, message: `Adaptive loop ended: ${loopExitReason}`, data: { exit_reason: loopExitReason, iterations: loopIterations, maxRounds, final_phase: finalPhase, transcript_length: finalDebate?.transcript?.length, an_nodes: finalDebate?.argument_network?.nodes?.length } });
        getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'info', debate_id: loopDebateId, message: 'debate.ended', data: { reason: 'adaptive_loop_complete', exit_reason: loopExitReason, iterations: loopIterations } });
        // Always run synthesis when the loop exits with enough debater content.
        // Normal path: phase reached 'terminated'. Abnormal: loop exhausted, consecutive
        // system-only rounds, errors, etc. — still synthesize what we have.
        const statementsInTranscript = finalDebate?.transcript.filter(e => e.type === 'statement').length ?? 0;
        if (finalDebate && statementsInTranscript >= 3 && loopExitReason !== 'daily_token_limit') {
          if (finalPhase !== 'terminated') {
            getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'adaptive-loop', level: 'warn', debate_id: loopDebateId, message: `Forcing synthesis: loop exited before termination (${loopExitReason})`, data: { exit_reason: loopExitReason, iterations: loopIterations, maxRounds, final_phase: finalPhase, statements: statementsInTranscript } });
          }
          await get().requestSynthesis();
        }
      } else if (initialCrossRespondRounds > 0) {
        // t/3760: a watch-only debate has no user to click "Cross-respond" again, so this
        // must not stop after a small fixed count — loop up to a much higher ceiling
        // instead of the small initialCrossRespondRounds count (which is also used
        // elsewhere as a phase-labeling divisor and must stay small for that purpose).
        // Exit checks below (daily-limit pause / no transcript growth / no debater
        // statement) are the same three this branch already had; NOT porting the adaptive
        // branch's `phase_state?.current_phase === 'terminated'` exit — non-adaptive
        // debates have no adaptive_staging.phase_state, so that check would be a dead
        // optional-chain-to-undefined here, not a fourth working exit (TL, p/336#517).
        for (let i = 0; i < WATCH_ONLY_MAX_CROSS_RESPOND_ROUNDS; i++) {
          const d = get().activeDebate;
          if (!d || get().dailyLimitPaused || !lease.isValid()) break;
          const preLen = d.transcript.length;
          await get().crossRespond({ lease, caller: 'watch-only-loop' });
          if (get().dailyLimitPaused) break;
          const post = get().activeDebate;
          if (!post || post.transcript.length === preLen) break;
          const hasStatement = post.transcript.slice(preLen).some(e => e.type === 'statement');
          const onlySystemEntries = post.transcript.slice(preLen).every(e => e.type === 'system');
          if (!hasStatement && !onlySystemEntries) break;
        }
      }
    }
}

export const createClarificationSlice: StateCreator<DebateStore, [], [], ClarificationSlice> = (set, get) => ({
  runClarification: async () => {
    const { activeDebate, addTranscriptEntry, saveDebate, debateGenerating } = get();
    if (!activeDebate) return;

    // t/3032 (DebateTool follow-up): the situation_debate.* observability events are
    // situations-specific — gate them so they don't fire for document/url/topic clarification.
    const isSituation = activeDebate.source_type === 'situations';

    // Guard: don't run if already generating or if clarification already exists.
    // t/3032: emit a skipped marker at each guard so a dump distinguishes
    // "trigger fired but declined to generate (with reason)" from "never fired".
    if (debateGenerating) {
      if (isSituation) getGlobalRecorder()?.record({ type: 'situation_debate.generation_skipped', component: 'debate-store', level: 'info', debate_id: activeDebate.id, message: 'situation_debate.generation_skipped', data: { reason: 'already_generating' } });
      return;
    }
    if (activeDebate.transcript.some(e => e.type === 'clarification')) {
      if (isSituation) getGlobalRecorder()?.record({ type: 'situation_debate.generation_skipped', component: 'debate-store', level: 'info', debate_id: activeDebate.id, message: 'situation_debate.generation_skipped', data: { reason: 'clarification_exists' } });
      return;
    }

    const isStillValid = createDebateGuard(get);
    set({ debateError: null, debateWarnings: [] });
    const model = getConfiguredModel();
    const topic = activeDebate.topic.final;

    set({ debateGenerating: 'system' as SpeakerId, debateStepStartedAt: Date.now() });
    const lineageCtx = buildLineageContext();
    const prompt = activeDebate.source_type === 'situations'
      ? situationClarificationPrompt(topic, activeDebate.source_content, activeDebate.audience, lineageCtx)
      : (activeDebate.source_type === 'document' || activeDebate.source_type === 'url')
        ? documentClarificationPrompt(topic, activeDebate.source_content, activeDebate.audience, lineageCtx)
        : buildClarificationPrompt(topic, activeDebate.source_content || undefined, activeDebate.audience, lineageCtx);
    try {
      // t/3032: the clarification trigger point — emitted immediately before the first AI call
      // dispatches, so a dump shows the trigger fired (vs. never firing → absent ai.request).
      if (isSituation) getGlobalRecorder()?.record({ type: 'situation_debate.generation_trigger', component: 'debate-store', level: 'info', debate_id: activeDebate.id, message: 'situation_debate.generation_trigger', data: { model, phase: 'clarification' } });
      const { text } = await generateTextWithProgress(prompt, model, `Generating clarifying questions (${model})`, set);
      if (!isStillValid()) { getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'warn', debate_id: activeDebate?.id, message: 'runClarification aborted: guard failed after question generation' }); return; }
      let questions: string[];
      const clarParsed = parseAIJson<{ questions?: unknown[] } | unknown[]>(text);
      if (clarParsed && typeof clarParsed === 'object' && 'questions' in clarParsed && Array.isArray(clarParsed.questions)) {
        questions = clarParsed.questions.slice(0, 3).map(normalizeClarificationQuestion);
      } else if (Array.isArray(clarParsed)) {
        questions = clarParsed.slice(0, 3).map(normalizeClarificationQuestion);
      } else {
        questions = [text.trim()];
      }
      if (questions.length > 0) {
        addTranscriptEntry({
          type: 'clarification',
          speaker: 'system',
          content: questions.map((q, i) => `${i + 1}. ${q}`).join('\n'),
          taxonomy_refs: [],
          metadata: { questions },
        });
      }
    } catch (err) {
      // User cancel / model switch (t/2508) — bail quietly, no toast (helper logged info).
      if (isCancellationError(err)) { set({ debateGenerating: null, debateActivity: null }); return; }
      getGlobalRecorder()?.record({
        type: 'system.error',
        debate_id: activeDebate?.id,
        component: 'debate-store',
        level: 'error',
        message: 'Failed to generate clarifying questions',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      // t/3032: dedicated observability marker (greppable by type) so a dump distinguishes
      // trigger-fired-and-failed from trigger-never-fired. The ADR-003 system.error above
      // carries the stack; this marker carries the spec's { debate_id, error.name, error.message }.
      if (isSituation) getGlobalRecorder()?.record({ type: 'situation_debate.generation_error', component: 'debate-store', level: 'error', debate_id: activeDebate?.id, message: 'situation_debate.generation_error', error: { name: (err as Error).name ?? 'Error', message: String(err) } });
      addTranscriptEntry({
        type: 'system',
        speaker: 'system',
        content: `Failed to generate clarifying questions: ${mapErrorToUserMessage(err)}`,
        taxonomy_refs: [],
      });
    }

    set({ debateGenerating: null });
    get().updatePhase('clarification');
    await saveDebate('runClarification');
  },

  submitAnswersAndSynthesize: async (answers: string) => {
    const { activeDebate, addTranscriptEntry, saveDebate } = get();
    if (!activeDebate) return;

    newAbortController();
    const isStillValid = createDebateGuard(get);

    addTranscriptEntry({
      type: 'answer',
      speaker: 'user',
      content: answers,
      taxonomy_refs: [],
    });

    set({ debateError: null, debateWarnings: [], debateGenerating: 'system' as SpeakerId });

    const clarifications: { speaker: string; questions: string[]; answers: string }[] = [];
    const clarEntries = get().activeDebate!.transcript.filter((e) => e.type === 'clarification');
    for (const entry of clarEntries) {
      const rawQs = entry.metadata?.questions;
      // Handle both old format (string[]) and new format ({question, options}[])
      const qs: string[] = Array.isArray(rawQs)
        ? rawQs.map((q: unknown) => typeof q === 'string' ? q : (q as { question: string }).question ?? String(q))
        : [entry.content];
      clarifications.push({
        speaker: POVER_INFO[entry.speaker as Exclude<SpeakerId, 'user'>]?.label || entry.speaker,
        questions: qs,
        answers,
      });
    }

    const model = getConfiguredModel();
    const baselineCritique = activeDebate.topic.critique;
    const baselineScore = baselineCritique?.composite_score ?? 0;

    // Quality gate: retry refinement if the new topic scores lower than the original
    const MAX_REFINEMENT_ATTEMPTS = 3;
    let bestTopic: string | null = null;
    let bestScore = baselineScore;
    let bestCritique: ReturnType<typeof parseTopicCritique> | null = null;

    for (let attempt = 0; attempt < MAX_REFINEMENT_ATTEMPTS; attempt++) {
      const prompt = buildSynthesisPrompt(activeDebate.topic.original, clarifications, activeDebate.audience, baselineCritique);
      const label = attempt === 0
        ? `Synthesizing refined topic (${model})`
        : `Refining topic, attempt ${attempt + 1}/${MAX_REFINEMENT_ATTEMPTS} (${model})`;
      try {
        const { text } = await generateTextWithProgress(prompt, model, label, set);
        if (!isStillValid()) { getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'warn', debate_id: activeDebate?.id, message: 'submitAnswersAndSynthesize aborted: guard failed after topic refinement' }); set({ debateGenerating: null }); return; }
        const parsed = parseAIJson<{ refined_topic?: string }>(text);
        const candidate = parsed?.refined_topic || text.trim();

        // Score the candidate if we have a baseline to compare against
        if (baselineCritique) {
          try {
            const critiquePrompt = critiqueTopicPrompt(candidate);
            const { text: critiqueText } = await generateTextWithProgress(critiquePrompt, model, `Scoring refined topic (${model})`, set);
            if (!isStillValid()) { getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'warn', debate_id: activeDebate?.id, message: 'submitAnswersAndSynthesize aborted: guard failed after critique scoring' }); set({ debateGenerating: null }); return; }
            const candidateCritique = parseTopicCritique(critiqueText, baselineCritique.structural_score);

            if (candidateCritique.composite_score >= baselineScore) {
              bestTopic = candidate;
              bestScore = candidateCritique.composite_score;
              bestCritique = candidateCritique;
              console.log(`[TopicRefinement] Attempt ${attempt + 1}: score ${candidateCritique.composite_score} >= baseline ${baselineScore} — accepted`);
              break;
            }
            console.log(`[TopicRefinement] Attempt ${attempt + 1}: score ${candidateCritique.composite_score} < baseline ${baselineScore} — discarding`);
          } catch (scoreErr) {
            getGlobalRecorder()?.record({
              type: 'system.error',
              debate_id: activeDebate?.id,
              component: 'debate-store',
              level: 'warn',
              message: 'Topic refinement scoring failed, accepting candidate',
              error: { name: (scoreErr as Error).name ?? 'Error', message: String(scoreErr), stack: (scoreErr as Error).stack },
            });
            // Scoring failed — accept the candidate rather than blocking refinement
            console.warn('[TopicRefinement] Scoring failed, accepting candidate:', scoreErr);
            bestTopic = candidate;
            break;
          }
        } else {
          // No baseline critique — accept the first candidate
          bestTopic = candidate;
          break;
        }
      } catch (genErr) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          debate_id: activeDebate?.id,
          component: 'debate-store',
          level: 'error',
          message: `Topic refinement attempt ${attempt + 1} generation failed`,
          error: { name: (genErr as Error).name ?? 'Error', message: String(genErr), stack: (genErr as Error).stack },
        });
        console.warn(`[TopicRefinement] Attempt ${attempt + 1} generation failed:`, genErr);
        break;
      }
    }

    // If all attempts scored lower, keep the existing topic
    const refinedTopic = bestTopic ?? activeDebate.topic.final;
    const keptOriginal = bestTopic === null && baselineCritique != null;

    try {
      get().updateTopic({ refined: refinedTopic, final: refinedTopic, ...(bestCritique ? { refined_critique: bestCritique } : {}) });

      addTranscriptEntry({
        type: 'system',
        speaker: 'system',
        content: keptOriginal
          ? `Topic refinement: all ${MAX_REFINEMENT_ATTEMPTS} attempts scored below baseline (${baselineScore}/20). Keeping original topic.`
          : `Refined topic: "${refinedTopic}"${bestScore > baselineScore ? ` (score: ${bestScore}/20, was ${baselineScore}/20)` : ''}`,
        taxonomy_refs: [],
        metadata: { refined_topic: refinedTopic, refinement_kept_original: keptOriginal || undefined, refinement_score: bestScore || undefined },
      });

      // ── Clause decomposition (t/181) — decompose refined topic into atomic clauses ──
      try {
        if (refinedTopic && refinedTopic.trim().length > 0) {
          const clausePrompt = decomposeResolutionPrompt(refinedTopic);
          const { text: clauseText } = await generateTextWithProgress(clausePrompt, model, `Decomposing topic into clauses (${model})`, set);
          if (isStillValid()) {
            const clauseParsed = parseAIJson<{ clauses?: unknown }>(clauseText);
            if (Array.isArray(clauseParsed?.clauses)) {
              const clauses = (clauseParsed.clauses as unknown[])
                .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
                .map(c => c.trim());
              if (clauses.length > 0) {
                get().updateTopic({ clauses });
              }
            }
          }
        }
      } catch (clauseErr) {
        getGlobalRecorder()?.record({
          type: 'system.error', debate_id: activeDebate?.id, component: 'debate-store', level: 'warn',
          message: 'Resolution clause decomposition failed (non-fatal)',
          error: { name: (clauseErr as Error).name ?? 'Error', message: String(clauseErr), stack: (clauseErr as Error).stack },
        });
      }

      // ── Resolution anchor embeddings (t/181) — for ArCo drift detection ──
      try {
        const topicForEmbed = get().activeDebate?.topic.final;
        if (topicForEmbed && topicForEmbed.trim().length > 0) {
          const { vector } = await api.computeQueryEmbedding(topicForEmbed.slice(0, 1000));
          if (vector && vector.length > 0 && isStillValid()) {
            get().updateTopic({ embedding: vector });
          }

          // Embed each clause for per-turn clause-coverage signal
          const currentClauses = get().activeDebate?.topic.clauses;
          if (currentClauses && currentClauses.length > 0 && isStillValid()) {
            const clauseVectors: number[][] = [];
            for (const clause of currentClauses) {
              try {
                const { vector: cv } = await api.computeQueryEmbedding(clause.slice(0, 500));
                if (cv && cv.length > 0) clauseVectors.push(cv);
              } catch (cvErr) {
                getGlobalRecorder()?.record({
                  type: 'system.error', debate_id: get().activeDebate?.id, component: 'debate-store', level: 'debug',
                  message: `Clause embedding failed for clause ${currentClauses.indexOf(clause)}`,
                  error: { name: (cvErr as Error).name ?? 'Error', message: String(cvErr), stack: (cvErr as Error).stack },
                });
              }
            }
            if (clauseVectors.length === currentClauses.length && isStillValid()) {
              get().updateTopic({ clause_embeddings: clauseVectors });
            }
          }
        }
      } catch (embedErr) {
        getGlobalRecorder()?.record({
          type: 'system.error', debate_id: activeDebate?.id, component: 'debate-store', level: 'warn',
          message: 'Resolution anchor embedding failed — ArCo drift signal unavailable',
          error: { name: (embedErr as Error).name ?? 'Error', message: String(embedErr), stack: (embedErr as Error).stack },
        });
      }

      // Extract user seed claims from Q&A and inject into argument network
      try {
        let qaPairsForClaims = '';
        for (const c of clarifications) {
          qaPairsForClaims += `\nQuestions:\n`;
          for (const q of c.questions) qaPairsForClaims += `  - ${q}\n`;
          qaPairsForClaims += `User answered: ${c.answers}\n`;
        }
        const seedPrompt = userSeedClaimsPrompt(refinedTopic, qaPairsForClaims, activeDebate.audience);
        const { text: seedText } = await generateTextWithProgress(seedPrompt, model, `Extracting user positions (${model})`, set);
        if (isStillValid()) {
          const seedParsed = parseAIJson<{ claims?: { claim: string; bdi_category?: string }[] }>(seedText);
          if (seedParsed?.claims && seedParsed.claims.length > 0) {
            const debate = get().activeDebate!;
            const existingAN = debate.argument_network ?? { nodes: [], edges: [] };
            const answerEntry = debate.transcript.find(e => e.type === 'answer');
            const sourceEntryId = answerEntry?.id ?? '';

            const seedNodes: ArgumentNetworkNode[] = seedParsed.claims.slice(0, 5).map((c, i) => ({
              id: `user-seed-${String(i + 1).padStart(3, '0')}`,
              text: c.claim,
              speaker: 'user' as ArgumentNetworkNode['speaker'],
              source_entry_id: sourceEntryId,
              taxonomy_refs: [],
              turn_number: 0,
              bdi_category: (['belief', 'desire', 'intention'].includes(c.bdi_category ?? '') ? c.bdi_category : undefined) as ArgumentNetworkNode['bdi_category'],
              base_strength: 0.5,
            }));

            set({
              activeDebate: {
                ...debate,
                argument_network: {
                  nodes: [...existingAN.nodes, ...seedNodes],
                  edges: [...existingAN.edges],
                },
              },
            });

            addTranscriptEntry({
              type: 'system',
              speaker: 'system',
              content: `Extracted ${seedNodes.length} user position${seedNodes.length > 1 ? 's' : ''} into the argument network:\n${seedNodes.map(n => `- [${n.id}] ${n.text}`).join('\n')}`,
              taxonomy_refs: [],
              metadata: { user_seed_claims: seedNodes.map(n => ({ id: n.id, text: n.text, bdi_category: n.bdi_category })) },
            });
          }
        }
      } catch (seedErr) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          debate_id: activeDebate?.id,
          component: 'debate-store',
          level: 'warn',
          message: 'User seed claim extraction failed',
          error: { name: (seedErr as Error).name ?? 'Error', message: String(seedErr), stack: (seedErr as Error).stack },
        });
        console.warn('[debate] User seed claim extraction failed (non-fatal):', seedErr);
        pushWarning(get, set, 'User position extraction skipped — debaters will not see your stated positions in the graph');
      }

      // Synthesis succeeded — auto-advance to the debate
      set({ debateGenerating: null });
      await saveDebate('submitAnswersAndSynthesize');
      await get().beginDebate();
      return;
    } catch (err) {
      // User cancel / model switch (t/2508) — bail quietly (finally clears state); no toast.
      if (isCancellationError(err)) return;
      getGlobalRecorder()?.record({
        type: 'system.error',
        debate_id: activeDebate?.id,
        component: 'debate-store',
        level: 'error',
        message: 'Topic synthesis failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      set({ debateError: `Topic synthesis failed: ${mapErrorToUserMessage(err)}` });
    } finally {
      set({ debateGenerating: null });
      await saveDebate('submitAnswersAndSynthesize:finally');
    }

  },

  beginDebate: async () => {
    const { activeDebate, updatePhase, saveDebate, addTranscriptEntry } = get();

    // Lineage pipeline status check — surfaces misconfiguration instantly
    if (activeDebate) {
      const lineageFrame = activeDebate.topic?.critique?.lineage_frame;
      const lineageDataLoaded = isLineageDataLoaded();
      const frameComputed = !!lineageFrame && lineageFrame.length > 0;
      const boostWillBeApplied = frameComputed && lineageDataLoaded;
      // A topic-specific lineage frame is only computed during topic critique. URL/document/
      // situations debates run no critique, so having no frame is expected — not a
      // misconfiguration. Reserve the warn for topic debates that should have a frame but
      // don't (data unloaded or empty distribution); everything else is info (t/2271).
      const frameExpected = activeDebate.source_type === 'topic';
      const expectedNoFrame = !frameExpected && !frameComputed;
      getGlobalRecorder()?.record({
        type: 'lineage.pipeline-status',
        component: 'debate-store',
        level: boostWillBeApplied || expectedNoFrame ? 'info' : 'warn',
        debate_id: activeDebate.id,
        message: boostWillBeApplied
          ? 'Lineage pipeline ready'
          : expectedNoFrame
            ? 'Lineage pipeline: no topic-specific frame (expected for URL/document/situations debate)'
            : 'Lineage pipeline incomplete',
        data: {
          lineage_data_loaded: lineageDataLoaded,
          lineage_frame_computed: frameComputed,
          lineage_frame_expected: frameExpected,
          lineage_frame_traditions: lineageFrame?.map((f: { cluster_id: string; label?: string }) => f.label ?? f.cluster_id) ?? [],
          boost_configured: boostWillBeApplied,
          source_type: activeDebate.source_type,
          code_path: 'useDebateStore',
        },
      });
    }

    // Document pre-analysis: extract i-nodes, tension points, and claims summary
    // Runs here so it executes whether the user submitted answers or skipped clarification
    if (activeDebate && !activeDebate.document_analysis &&
        (activeDebate.source_type === 'document' || activeDebate.source_type === 'url')) {
      set({ debateGenerating: 'system' as SpeakerId, debateStepStartedAt: Date.now() });
      const model = getConfiguredModel();
      newAbortController();
      const isStillValid = createDebateGuard(get);
      try {
        const taxStore = useTaxonomyStore.getState();
        const taxonomySample = buildTaxonomySample({
          accelerationist: { nodes: (taxStore.accelerationist?.nodes ?? []) as PovNode[] },
          safetyist: { nodes: (taxStore.safetyist?.nodes ?? []) as PovNode[] },
          skeptic: { nodes: (taxStore.skeptic?.nodes ?? []) as PovNode[] },
          situations: { nodes: (taxStore.situations?.nodes ?? []) as SituationNode[] },
          policyRegistry: (taxStore.policyRegistry ?? []).map(p => ({ id: p.id, action: p.action })),
        });

        const activePovers = activeDebate.active_povers
          .filter(p => p !== 'user')
          .map(p => POVER_INFO[p as Exclude<SpeakerId, 'user'>]?.pov)
          .filter(Boolean);

        const { prompt: analysisPrompt } = documentAnalysisPrompt(
          activeDebate.source_content,
          activeDebate.topic.final,
          activePovers,
          taxonomySample,
        );

        const { text: analysisText } = await generateTextWithProgress(
          analysisPrompt, model, `Analyzing document claims (${model})`, set,
        );
        if (!isStillValid()) { getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'error', debate_id: activeDebate?.id, message: 'beginDebate aborted: guard failed after document analysis — debate will stall', data: { source_type: activeDebate.source_type, phase: activeDebate.phase } }); return; }

        const analysis = parseAIJson<DocumentAnalysis>(analysisText);
        if (analysis && analysis.i_nodes && analysis.i_nodes.length > 0) {
          addTranscriptEntry({
            type: 'system',
            speaker: 'system',
            content: `Document analysis complete: ${analysis.i_nodes.length} claims extracted, ${analysis.tension_points.length} tension points identified.\n\n${analysis.claims_summary}`,
            taxonomy_refs: [],
          });

          // Seed argument network with document i-nodes
          const debate = get().activeDebate;
          if (debate) {
            const existingAN = debate.argument_network ?? { nodes: [], edges: [] };
            const lastEntry = debate.transcript.slice(-1)[0];
            const sourceEntryId = lastEntry?.id ?? '';
            const docNodes: ArgumentNetworkNode[] = analysis.i_nodes.map(inode => ({
              id: inode.id,
              text: inode.text,
              speaker: 'document' as ArgumentNetworkNode['speaker'],
              source_entry_id: sourceEntryId,
              taxonomy_refs: inode.taxonomy_refs,
              turn_number: 0,
            }));

            // Embed doc i-nodes for AN-based taxonomy relevance scoring (non-blocking)
            for (const node of docNodes) {
              try {
                const { vector } = await api.computeQueryEmbedding(node.text.slice(0, 300));
                if (vector && vector.length > 0) node.embedding = vector;
              } catch (e) { getGlobalRecorder()?.record({ type: 'system.error', debate_id: activeDebate?.id, component: 'debate-store', level: 'warn', message: 'Doc i-node embedding failed', error: { name: (e as Error).name ?? 'Error', message: String(e), stack: (e as Error).stack } }); }
            }

            set({
              activeDebate: {
                ...debate,
                document_analysis: analysis,
                argument_network: {
                  nodes: [...existingAN.nodes, ...docNodes],
                  edges: [...existingAN.edges],
                },
              },
            });
          }
        }
      } catch (err) {
        // User cancel / model switch (t/2508) — bail quietly (finally clears state); no toast.
        if (isCancellationError(err)) return;
        getGlobalRecorder()?.record({
          type: 'system.error',
          debate_id: activeDebate?.id,
          component: 'debate-store',
          level: 'error',
          message: 'Document analysis failed',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        console.warn('[debate] Document analysis failed:', err);
        pushWarning(get, set, 'Document analysis could not be completed');
        addTranscriptEntry({
          type: 'system',
          speaker: 'system',
          content: `Document analysis skipped: ${mapErrorToUserMessage(err)}`,
          taxonomy_refs: [],
        });
      } finally {
        set({ debateGenerating: null });
        await saveDebate('beginDebate:docAnalysis');
      }
    }

    // Load vocabulary terms for standardized term enforcement
    try {
      const dict = await api.loadDictionary();
      if (dict.standardized.length > 0) {
        set({ vocabularyTerms: { standardized: dict.standardized as StandardizedTerm[], colloquial: dict.colloquial as ColloquialTerm[] } });
      }
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        debate_id: get().activeDebate?.id,
        component: 'debate-store',
        level: 'warn',
        message: 'Vocabulary loading failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      console.warn('[debate] Vocabulary loading failed, debates will use bare terms:', err);
      pushWarning(get, set, 'Vocabulary dictionary unavailable — debates will use bare terms');
    }

    // If document analysis produced claims, let the user review/edit them before opening
    const freshDebate = get().activeDebate;
    if (freshDebate?.document_analysis?.i_nodes?.length) {
      updatePhase('edit-claims');
      await saveDebate('beginDebate:editClaims');
      return;
    }

    // No claims to edit — proceed directly to opening
    get().proceedToOpening();
    await saveDebate('beginDebate:proceed');
  },

  // ── Phase 2.5: Edit Claims ──────────────────────────────

  updateClaim: (claimId: string, newText: string) => {
    const debate = get().activeDebate;
    if (!debate?.document_analysis) return;

    const updatedINodes = debate.document_analysis.i_nodes.map(n =>
      n.id === claimId ? { ...n, text: newText } : n,
    );
    const updatedAN = debate.argument_network
      ? {
          ...debate.argument_network,
          nodes: debate.argument_network.nodes.map(n =>
            n.id === claimId ? { ...n, text: newText } : n,
          ),
        }
      : undefined;

    set({
      activeDebate: {
        ...debate,
        document_analysis: { ...debate.document_analysis, i_nodes: updatedINodes },
        ...(updatedAN ? { argument_network: updatedAN } : {}),
      },
    });
  },

  deleteClaim: (claimId: string) => {
    const debate = get().activeDebate;
    if (!debate?.document_analysis) return;

    const updatedINodes = debate.document_analysis.i_nodes.filter(n => n.id !== claimId);
    const updatedTensions = debate.document_analysis.tension_points.map(tp => ({
      ...tp,
      i_node_ids: tp.i_node_ids.filter(id => id !== claimId),
    })).filter(tp => tp.i_node_ids.length > 0);
    const updatedAN = debate.argument_network
      ? {
          ...debate.argument_network,
          nodes: debate.argument_network.nodes.filter(n => n.id !== claimId),
          edges: debate.argument_network.edges.filter(e => e.source !== claimId && e.target !== claimId),
        }
      : undefined;

    set({
      activeDebate: {
        ...debate,
        document_analysis: {
          ...debate.document_analysis,
          i_nodes: updatedINodes,
          tension_points: updatedTensions,
        },
        ...(updatedAN ? { argument_network: updatedAN } : {}),
      },
    });
  },

  proceedToOpening: () => {
    const { activeDebate, updatePhase, addTranscriptEntry, saveDebate } = get();
    if (!activeDebate) return;

    updatePhase('opening');
    getGlobalRecorder()?.record({ type: 'debate.phase', component: 'debate-store', level: 'info', debate_id: activeDebate.id, message: 'Phase: opening', data: { phase: 'opening' } });

    // Only shuffle if no order has been set yet (preserves user customization from setup screen)
    const { openingOrder: existingOrder } = get();
    if (existingOrder.length === 0) {
      const aiPovers = AI_POVERS.filter((p) => activeDebate.active_povers.includes(p));
      const shuffled = [...aiPovers];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      set({ openingOrder: shuffled });
    }

    // Persist on the debate object so it survives app restarts
    const freshDebate = get().activeDebate;
    const finalOrder = get().openingOrder;
    if (freshDebate) {
      set({ activeDebate: { ...freshDebate, opening_order: finalOrder } });
    }

    const claimCount = activeDebate.document_analysis?.i_nodes?.length;
    addTranscriptEntry({
      type: 'system',
      speaker: 'system',
      content: `The debate begins${claimCount ? ` with ${claimCount} source claims` : ''}. Opening statements will follow.`,
      taxonomy_refs: [],
    });

    void saveDebate('proceedToOpening');
  },

  // ── Phase 3: Opening Statements ─────────────────────────

  runOpeningStatements: async (caller = 'unspecified', opts) => {
    if (!get().activeDebate) { getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'warn', message: 'runOpeningStatements called with no activeDebate', data: { caller } }); return; }
    // t/3917: the lease covers openings AND the loop. The 09-30 dump had two concurrent
    // openings runs in one window (a double press on "Resume Opening Statements" while
    // the openings were really running in the main window); each fell into its own loop.
    // A loop-only lease would have let both reach the loop.
    await get().runUnderDebateLease(`runOpeningStatements:${caller}`, lease => get()._runOpeningStatementsLeased(lease), opts);
  },

  _runOpeningStatementsLeased: async (lease) => {
    const { activeDebate, addTranscriptEntry, saveDebate } = get();
    if (!activeDebate) { getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'warn', message: 'runOpeningStatements called with no activeDebate' }); return; }
    if (get().debateGenerating) { getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'warn', debate_id: activeDebate.id, message: 'runOpeningStatements skipped — already generating' }); return; }
    if (!claimDebateDriver()) {
      set({ debateError: 'Another window is already running this debate.' });
      getGlobalRecorder()?.record({ type: 'lifecycle', component: 'debate-store', level: 'warn', debate_id: activeDebate.id, message: 'Debate driver claim denied — another window owns it (openings)' });
      return;
    }

    newAbortController();
    const isStillValid = guardWithLease(createDebateGuard(get), lease);
    set({ debateError: null, debateWarnings: [] });
    const model = getConfiguredModel();
    const topic = activeDebate.topic.final;

    await extractTopicScope(get, set, activeDebate, model, topic);

    // h3: moderator voices each camp's story before any argument (flag-gated, idempotent)
    await runNarrativeVoicing(get, set, addTranscriptEntry, model);
    if (!isStillValid()) {
      getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'info', debate_id: activeDebate.id, message: 'runOpeningStatements aborted after narrative voicing' });
      return;
    }

    const resolvedOrder = resolveOpeningOrder(get().openingOrder, activeDebate);
    const aiPovers = (resolvedOrder as readonly (typeof AI_POVERS[number])[]).filter(
      (p) => activeDebate.active_povers.includes(p),
    );

    // Idempotency: collect prior statements from DELIVERED openings (supports resume
    // after interruption). Slot-first (t/2907) means a speaker can have an in-progress
    // opening slot with empty content ('generating'/'retrying'/'error') — those are NOT
    // delivered and must not suppress (re)generation, so "delivered" requires prose.
    const isDeliveredOpening = (e: TranscriptEntry): boolean =>
      e.type === 'opening' && e.speaker !== 'system' && !!e.content && e.content.trim().length > 0;
    const existingOpenings = new Set(
      activeDebate.transcript.filter(isDeliveredOpening).map(e => e.speaker),
    );
    const priorStatements: { speaker: string; statement: string }[] = [];
    for (const poverId of aiPovers) {
      const existing = activeDebate.transcript.find(e => isDeliveredOpening(e) && e.speaker === poverId);
      if (existing) {
        const info = POVER_INFO[poverId];
        priorStatements.push({ speaker: info.label, statement: existing.content });
      }
    }

    console.log(`[debate-store] Opening statements: aiPovers=${JSON.stringify(aiPovers)}, existingOpenings=${JSON.stringify([...existingOpenings])}, resolvedOrder=${JSON.stringify(resolvedOrder)}`);

    // Auto-retry policy (t/2492): transient failures (429 / 5xx / timeout / network) retry up to
    // MAX_OPENING_RETRIES with expo backoff, bounded by a total-elapsed budget so a multi-minute
    // timeout × N passes can't strand the user before the honest exhaustion banner.
    const MAX_OPENING_RETRIES = 2;
    const OPENING_RETRY_BUDGET_MS = 8 * 60 * 1000; // 8 min total across all passes
    const openingStartedAt = Date.now();
    let openingRetryPass = 0;
    let failedSpeakers: string[] = [];
    let hasRetryableFailure = false;
    let retryBackoffMs = 5000;
    let lastRetryReason = retryReasonLabel('non_retryable');

    while (openingRetryPass <= MAX_OPENING_RETRIES) {
      if (openingRetryPass > 0) {
        // Budget guard: don't launch another pass if we'd blow the total-elapsed budget.
        if (Date.now() - openingStartedAt + retryBackoffMs > OPENING_RETRY_BUDGET_MS) {
          console.log(`[debate-store] Opening retry budget (${OPENING_RETRY_BUDGET_MS}ms) exhausted — stopping`);
          break;
        }
        console.log(`[debate-store] Opening retry pass ${openingRetryPass} — waiting ${retryBackoffMs}ms`);
        set({ debateActivity: `A speaker ${lastRetryReason} — retrying openings in ${Math.ceil(retryBackoffMs / 1000)}s...` });
        await new Promise(resolve => setTimeout(resolve, retryBackoffMs));
        if (!isStillValid()) break;
      }

      failedSpeakers = [];
      hasRetryableFailure = false;

    for (const poverId of aiPovers) {
      if (!lease.isValid()) {
        // Superseded between speakers: start no new pipeline (and no AI spend) for a dead run.
        getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'info', debate_id: activeDebate.id, message: 'runOpeningStatements stopped — run lease no longer valid', data: { next_speaker: poverId } });
        return;
      }
      const freshTranscript = get().activeDebate?.transcript ?? [];
      if (freshTranscript.some(e => isDeliveredOpening(e) && e.speaker === poverId)) {
        console.log(`[debate-store] Skipping ${poverId} — already has a delivered opening (live check)`);
        continue;
      }
      // Skip POVers who already delivered an opening (idempotency after interruption)
      if (existingOpenings.has(poverId)) {
        console.log(`[debate-store] Skipping ${poverId} — already has opening`);
        continue;
      }

      set({ debateGenerating: poverId, debateStepStartedAt: Date.now() });
      const openingSouls = seatSouls(activeDebate, poverId); // t/3975
      const info = openingSouls.soul;
      // Slot-first (t/2907): insert (or reuse) this speaker's opening panel NOW in
      // 'generating' state, so the transcript shows ONE card that mutates through
      // retrying/error/done — instead of a fresh card + a system retry-toast per pass.
      const slotId = get().upsertTranscriptEntry({ type: 'opening', speaker: poverId, status: 'generating', content: '', taxonomy_refs: [] });

      try {
        const stageGenerate = makeStageGenerate(set as (partial: Record<string, unknown>) => void, getSpeakerModel(activeDebate, poverId, model), servedTurnRecorder(get, set, poverId));
        const recentText = priorStatements.map(ps => ps.statement).join('\n').slice(-500);
        const ctx = await getRelevantTaxonomyContext(info.pov, topic, recentText);
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
        const vocab = get().vocabularyTerms;
        const vocabBlock = vocab
          ? '\n' + formatVocabularyContext({ pov: info.pov, standardizedTerms: vocab.standardized, colloquialTerms: vocab.colloquial })
          : '';
        const taxonomyBlock = formatTaxonomyContext(ctx, info.pov) + commitBlock + establishedBlock + edgeBlock + vocabBlock;

        const docAnalysis = activeDebate.document_analysis;

        let priorBlock = '';
        if (priorStatements.length > 0) {
          priorBlock = '\n\n=== PRIOR OPENING STATEMENTS ===\n';
          for (const ps of priorStatements) {
            priorBlock += `\n${ps.speaker}:\n${ps.statement}\n`;
          }
        }

        const userSeeds = (get().activeDebate?.argument_network?.nodes || [])
          .filter(n => n.speaker === 'user' && n.id.startsWith('user-seed-'))
          .map(n => ({ id: n.id, text: n.text, bdi_category: n.bdi_category }));

        // This is the SAME model the brief actually runs with (stage override, else
        // speaker/base model) — used below for the timeout toast/dialog.
        const resolvedBriefModel = resolveBriefModel(activeDebate, poverId, model);

        const speakerModel = getSpeakerModel(activeDebate, poverId, model);
        const pipelineInput: OpeningPipelineInput = {
          label: info.label,
          pov: info.pov,
          personality: info.personality,
          soul: openingSouls.soul,
          opponentSouls: openingSouls.opponentSouls,
          topic,
          taxonomyContext: taxonomyBlock,
          priorStatements: priorBlock,
          isFirst: priorStatements.length === 0,
          // t/3755: must mirror debateEngine/phases/opening.ts. The field is OPTIONAL, so
          // omitting it here compiles clean and silently falls back to a single
          // '<prior speaker>' example — the desktop path would keep the exact bug t/3755 fixes.
          priorSpeakerLabels: priorStatements.length > 0 ? priorStatements.map(ps => ps.speaker) : undefined,
          sourceContent: docAnalysis ? undefined : (activeDebate.source_content || undefined),
          documentAnalysis: docAnalysis,
          audience: activeDebate.audience,
          model: speakerModel,
          draftModel: activeDebate.stage_models?.draft || undefined,
          briefModel: activeDebate.stage_models?.brief || undefined,
          planModel: activeDebate.stage_models?.plan || undefined,
          citeModel: activeDebate.stage_models?.cite || undefined,
          userSeedClaims: userSeeds.length > 0 ? userSeeds : undefined,
          availablePovNodeIds: [...getSelectableNodeIds()], // t/4355: offer selectable ids only
          background: activeDebate.topic?.background || undefined,
          narrativeVoicing: (() => {
            const voicing = get().activeDebate?.narrative_voicing;
            return voicing ? narrativeBlockForDebater(voicing.narratives, poverId) : undefined;
          })(),
          // t/3521: briefTimeoutMs floor is no longer computed here — runOpeningPipelineWithRepair
          // applies Math.max(DEFAULT_BRIEF_TIMEOUT_MS, getMinTimeout(model)) internally, the single
          // source of truth shared with the engine path (t/3518's escape was this floor computed
          // independently in two places and drifting).
          // t/3612: plan/draft/cite floor. Computed HERE (not left to the pipeline's getMinTimeout
          // callback) because on desktop that callback resolves to electronAIAdapter's stubbed
          // getModelMinTimeout => 0 (t/3612#2/#4) — the renderer is the only desktop call site with
          // the real registry, same reason briefTimeoutMs already works this way. Raise semantics
          // (Math.max with the real adapter default), not a replacement — a floor below the backend
          // base must never lower the timeout (t/3612#4).
          stageTimeoutMs: Math.max(
            getDefaultTimeout(speakerModel, aiModelsRegistry as unknown as ModelRegistry),
            getModelMinTimeout(speakerModel, aiModelsRegistry as unknown as ModelRegistry),
          ),
        };

        // Emit on the renderer-local brief-timeout bus (t/2307). Both builds: the
        // opening pipeline runs in this renderer, so emit and the same-window toast
        // consumer share @bridge's bus — no IPC. Previously web-only; the Electron
        // path routed through an unfed IPC channel and never fired.
        // resolvedBriefModel (computed above) is what the brief actually runs with (stage
        // override, else speaker/base model) — what the timeout toast/dialog must display so
        // "Switch model" is an informed choice (t/2504). onBriefEvent is created per-speaker
        // inside the aiPovers loop, so poverId/model already resolve the timed-out speaker
        // (data.agent).
        const onBriefEvent: BriefEventFn = (phase, data) => {
          if (phase === 'brief.timeout' || phase === 'brief.retrying') {
            emitBriefTimeout({ debateId: activeDebate.id, speaker: data.agent, attempt: data.attempt, maxAttempts: data.maxRetries, currentModel: resolvedBriefModel });
          } else if (phase === 'brief.retries_exhausted') {
            emitBriefRetriesExhausted({ debateId: activeDebate.id, speaker: data.agent, totalAttempts: data.attempt, currentModel: resolvedBriefModel });
          }
        };

        // t/3521: floor computation + repair-retry sequence now live in one place
        // (turnPipeline/opening.ts's runOpeningPipelineWithRepair), shared with the engine
        // path — the exact seam that caused t/3518's escape. onProgress fires the same
        // 'retrying (N issues)' message before the internal repair retry that this call
        // site used to set manually, so debateActivity keeps updating during repairs.
        const pipelineResult = await runOpeningPipelineWithRepair(
          pipelineInput,
          stageGenerate,
          (_stage, label) => set({ debateActivity: label }),
          onBriefEvent,
          (m) => getModelMinTimeout(m, aiModelsRegistry as unknown as ModelRegistry),
        );
        if (!isStillValid()) {
          console.warn(`[debate-store] Debate state changed after ${info.label} opening pipeline — remaining speakers will be skipped. activeDebateId: ${get().activeDebateId}, aborted: ${_abortController?.signal.aborted}`);
          addTranscriptEntry({ type: 'system', speaker: 'system', content: `Opening generation interrupted after ${info.label} — superseded by a model switch or a debate change.`, taxonomy_refs: [] });
          getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'info', debate_id: activeDebate?.id, message: 'runOpeningStatements aborted post-pipeline', data: { speaker: info.label } });
          return;
        }

        const knownNodeIds = getAllKnownNodeIds();
        const { statement, taxonomyRefs, meta } = assembleOpeningPipelineResult(pipelineResult, knownNodeIds);

        // Guard: reject empty or trivially short opening statements
        if (!statement || statement.trim().length < 50) {
          console.error(`[debate] ${info.label} opening produced empty/trivial statement (${statement.length} chars) — treating as failure`);
          throw new Error(`Opening statement was empty or too short (${statement.trim().length} chars). The AI may have returned only structural metadata without prose content.`);
        }

        // h3: record this debater's affirm/amend check of its own camp's narrative
        recordNarrativeCheck(get, set, poverId, pipelineResult.draft as unknown as Record<string, unknown>);

        // Enrich policy refs with per-policy relevance from draft stage
        meta.policy_refs = enrichPolicyRefs(meta.policy_refs, pipelineResult.draft as unknown as Record<string, unknown>);

        // Enrich taxonomy refs with relevance scores from context injection
        if (ctx.nodeScores) {
          for (const ref of taxonomyRefs) {
            const score = ctx.nodeScores.get(ref.node_id);
            if (score != null) ref.relevance_score = score;
          }
        }

        // Serialize source tracking for diagnostics display
        const relevanceSources = serializeNodeSourceMap(ctx.nodeSourceMap, taxonomyRefs);

        // Slot-first success (t/2907): complete the existing 'generating' slot in place
        // rather than appending a new entry — one card, no duplicate panel. Clearing
        // errorMessage wipes any retry note from a prior failed pass.
        get().updateTranscriptEntry(slotId, {
          status: 'done',
          errorMessage: undefined,
          content: statement,
          taxonomy_refs: taxonomyRefs,
          policy_refs: meta.policy_refs,
          metadata: {
            key_assumptions: meta.key_assumptions,
            my_claims: meta.my_claims,
            turn_symbols: meta.turn_symbols,
            relevance_sources: relevanceSources,
            injection_manifest: ctx.injectionManifest,
          },
        });
        // t/3762: the sessionSlice.addTranscriptEntry `debate.opening_added` event fires at
        // slot-creation (upsertTranscriptEntry, t/2907) — before the pipeline runs, so it can
        // never carry prior_steelmans data. Emit the enriched event here instead, where the
        // draft is actually known, so a dump answers "did steelmans fire?" in one event read
        // rather than a 2881-line grep for the field name.
        getGlobalRecorder()?.record({
          type: 'debate.opening_added', component: 'debate-store', level: 'info',
          debate_id: activeDebate.id,
          message: `Opening delivered for ${info.label}`,
          data: {
            speaker: poverId, entryId: slotId,
            prior_steelmans_count: pipelineResult.draft.prior_steelmans?.length ?? 0,
            is_first_speaker: priorStatements.length === 0,
          },
        });
        // Key diagnostics/summary/claim-extraction off the SLOT id, not slice(-1):
        // the slot is not necessarily the last entry under slot-first (t/2907).
        const lastEntry = get().activeDebate?.transcript.find(e => e.id === slotId);

        // Record diagnostics with full stage data
        if (lastEntry) {
          const draftDiag = pipelineResult.stage_diagnostics.find(s => s.stage === 'draft');
          const topicAlignDiagOpen = pipelineResult.topicAlignmentResult
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
            topic_alignment: topicAlignDiagOpen,
            quality_gate: pipelineResult.qualityGateResult,
          });
        }

        priorStatements.push({ speaker: info.label, statement });

        // Summarize for detail tiers (awaited so summaries persist with save)
        if (lastEntry) {
          await summarizeTranscriptEntry(lastEntry.id, statement, info.label, model, get, set);
        }

        // Save after each statement so progress persists
        await saveDebate('runOpeningStatements:perStatement');

        // Extract claims in background (non-blocking)
        if (lastEntry) {
          void extractClaimsAndUpdateAN(statement, poverId, lastEntry.id, taxonomyRefs.map(r => r.node_id), get, set, meta.my_claims);
        }
      } catch (err) {
        // Deliberate cancel / model switch mid-brief (t/2508): the shared generation helper
        // already recorded the info event. Bail quietly — no error toast, no auto-retry —
        // instead of classifying it as a transient failure. t/2505's retryWithModel starts a
        // fresh run on the new model immediately after aborting this one.
        if (isCancellationError(err)) {
          releaseDebateDriver();
          set({ debateGenerating: null, debateActivity: null, debateProgress: null });
          return;
        }
        const httpStatus = (err as { httpStatus?: number }).httpStatus;
        // Broadened classification (t/2492): transient timeout/5xx/network now auto-retry, not just 429.
        const { retryable: isRetryable, reason: retryReason } = classifyAiRetry(err);
        // t/3048: surface the server's advertised retry window structured in FR data (not just the message string).
        const retryInMs = retryReason === 'rate_limit' ? parseRetryAfterMs(err) : undefined;
        console.error(`[debate] ${info.label} opening statement failed (status=${httpStatus ?? 'unknown'}, retry=${retryReason}):`, err);
        getGlobalRecorder()?.record({ type: 'system.error', debate_id: activeDebate?.id, component: 'debate-engine', level: 'error', message: `Opening statement failed: ${info.label} (status=${httpStatus ?? 'unknown'})`, data: { retry_reason: retryReason, retryable: isRetryable, retry_pass: openingRetryPass, ...(retryInMs !== undefined && { retry_in_ms: retryInMs }) }, error: { name: (err as Error).name ?? 'Error', message: (err as Error).message ?? String(err), stack: (err as Error).stack?.slice(0, 500) } });
        if (isDailyLimitError(err)) {
          // Terminal for the whole run: settle this speaker's slot to 'error' so its
          // spinner doesn't stick (t/2907), and keep the run-level system notice + banner.
          get().updateTranscriptEntry(slotId, { status: 'error', errorMessage: DAILY_LIMIT_MESSAGE });
          addTranscriptEntry({
            type: 'system',
            speaker: 'system',
            content: DAILY_LIMIT_MESSAGE,
            taxonomy_refs: [],
          });
          releaseDebateDriver();
          set({ debateGenerating: null, debateActivity: null, debateError: DAILY_LIMIT_MESSAGE, dailyLimitPaused: true });
          await saveDebate('runOpeningStatements:dailyLimit');
          return;
        }
        // Slot-first (t/2907): reflect the failure ON the speaker's own opening card
        // instead of appending a system toast entry (the transcript-clutter source).
        // Retryable → 'retrying' with the reason; terminal → 'error' with a friendly
        // message (t/2906 mapping). One card, mutated in place.
        get().updateTranscriptEntry(slotId, isRetryable
          ? { status: 'retrying', errorMessage: `${info.label} ${retryReasonLabel(retryReason)} — retrying automatically…` }
          : { status: 'error', errorMessage: mapErrorToUserMessage(err) });
        failedSpeakers.push(info.label);
        if (isRetryable) {
          hasRetryableFailure = true;
          lastRetryReason = retryReasonLabel(retryReason);
          if (retryReason === 'rate_limit') {
            // Honor the server's advertised Retry-After when present (parsed once above, t/3048).
            retryBackoffMs = retryInMs ?? 5000;
          } else {
            // Exponential backoff for transient timeout/5xx/network (5s, 10s, …), capped at 30s.
            retryBackoffMs = Math.min(5000 * 2 ** openingRetryPass, 30_000);
          }
          break;
        }
      }
    }

      if (!hasRetryableFailure || failedSpeakers.length === 0) break;
      openingRetryPass++;
    }

    releaseDebateDriver();
    set({ debateGenerating: null });

    // Check if all expected AI openings were delivered
    const currentDebate = get().activeDebate;
    const deliveredOpenings = (currentDebate?.transcript ?? []).filter(
      e => e.type === 'opening' && e.content && e.content.trim().length > 0,
    );
    const deliveredSpeakers = new Set(deliveredOpenings.map(e => e.speaker));
    const missingSpeakers = aiPovers.filter(p => !deliveredSpeakers.has(p));

    if (missingSpeakers.length > 0) {
      const missingLabels = missingSpeakers.map(p => POVER_INFO[p].label);
      set({
        debateActivity: null,
        debateError: (() => {
          const elapsedSec = Math.round((Date.now() - openingStartedAt) / 1000);
          const elapsedStr = elapsedSec >= 60 ? `~${Math.round(elapsedSec / 60)} min` : `~${elapsedSec}s`;
          const attempts = openingRetryPass + 1;
          return `Opening statements failed for ${missingLabels.join(', ')} after ${attempts} attempt${attempts > 1 ? 's' : ''} (${elapsedStr}).`;
        })(),
      });
      getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'warn', debate_id: activeDebate?.id, message: 'runOpeningStatements partial failure', data: { missingSpeakers, retry_passes: openingRetryPass, last_retry_reason: lastRetryReason, elapsed_ms: Date.now() - openingStartedAt } });
      await saveDebate('runOpeningStatements:partialFailure');
      return;
    }

    // All openings delivered — advance to debate phase (unless user is a POVer)
    if (!activeDebate.user_is_pover) {
      get().updatePhase('debate');
      addTranscriptEntry({
        type: 'system',
        speaker: 'system',
        content: 'Opening statements complete. The floor is open.',
        taxonomy_refs: [],
      });
    }

    await cacheOpeningEmbeddings(get, set);
    await finalizeNarrativeReference(get, set);

    // Neutral evaluation: baseline checkpoint (after openings, before cross-respond)
    void runNeutralCheckpoint('baseline', get, set as any, addTranscriptEntry as Parameters<typeof runNeutralCheckpoint>[3]);

    await saveDebate('runOpeningStatements:end');

    await runInitialCrossRespondRounds(get, set, activeDebate, lease);
  },

  submitUserOpening: async (statement: string) => {
    const { addTranscriptEntry, updatePhase, saveDebate } = get();

    addTranscriptEntry({
      type: 'opening',
      speaker: 'user',
      content: statement,
      taxonomy_refs: [],
    });

    updatePhase('debate');

    addTranscriptEntry({
      type: 'system',
      speaker: 'system',
      content: 'Opening statements complete. The floor is open.',
      taxonomy_refs: [],
    });

    await saveDebate('submitUserOpening');
  },
});
