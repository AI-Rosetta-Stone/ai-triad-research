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
/** Constructs a TopicScope from a raw AI JSON response object. Pure — no side effects. */
function buildTopicScopeFromJson(scopeParsed: Record<string, unknown>, topic: string): TopicScope {
  const validRiskLevels: TopicScopeRiskLevel[] = ['low', 'medium', 'high', 'catastrophic', 'unspecified'];
  const toArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  return {
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
}

async function extractTopicScope(get: () => DebateStore, set: (partial: any) => void, activeDebate: DebateSession, model: string, topic: string): Promise<void> {
    // Topic scope extraction (t/336) — extract before openings so scope constraints are active
    if (!activeDebate.topic.scope) {
      try {
        set({ debateActivity: 'Extracting topic scope...' });
        const scopePrompt = topicScopeExtractionPrompt(topic);
        const { text: scopeText } = await api.generateText(scopePrompt, model);
        const scopeParsed = parseAIJson<Record<string, unknown>>(scopeText);
        if (scopeParsed && typeof scopeParsed === 'object') {
          const scope = buildTopicScopeFromJson(scopeParsed, topic);
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

async function processOneOpeningEmbedding(
  entry: TranscriptEntry,
  get: () => DebateStore,
  openingEmbeddings: Record<string, number[]>,
): Promise<void> {
  if (entry.type !== 'opening' || entry.speaker === 'system') return;
  try {
    const result = await api.computeQueryEmbedding(entry.content.slice(0, 1000));
    openingEmbeddings[entry.speaker] = result.vector;
  } catch (e) {
    getGlobalRecorder()?.record({ type: 'system.error', debate_id: get().activeDebate?.id, component: 'debate-store', level: 'warn', message: 'Opening embedding computation failed', error: { name: (e as Error).name ?? 'Error', message: String(e), stack: (e as Error).stack } });
  }
}

async function cacheOpeningEmbeddings(get: () => DebateStore, set: (partial: any) => void): Promise<void> {
    // Cache opening embeddings for position drift detection (non-blocking)
    try {
      const currentDebate = get().activeDebate;
      if (currentDebate) {
        const openingEmbeddings: Record<string, number[]> = {};
        for (const entry of currentDebate.transcript) {
          await processOneOpeningEmbedding(entry, get, openingEmbeddings);
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

function recordAdaptiveConfigAtStart(
  resolvedDebate: DebateSession | null | undefined,
  adaptive: DebateSession['adaptive_staging'],
  initialCrossRespondRounds: number,
): void {
  getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'info', debate_id: resolvedDebate?.id, message: 'Resolved adaptive config at debate start', data: { enabled: !!adaptive?.enabled, pacing: adaptive?.pacing ?? null, initial_cross_respond_rounds: initialCrossRespondRounds } });
}

/** Runs under the caller's run lease (t/3917): every turn is passed `lease`, and the loop
 *  exits `lease_lost` the moment the lease is superseded or lost to another window. */
async function runInitialCrossRespondRounds(get: () => DebateStore, set: (partial: any) => void, activeDebate: DebateSession, lease: RunLease): Promise<void> {
  const { initialCrossRespondRounds } = get();
  if (!activeDebate.user_is_pover) {
    const freshDebate = get().activeDebate;
    if (freshDebate?.protocol_id === 'socratic') return;

    // t/3782: back-compat for the legacy boolean shape (`adaptive_staging = true`)
    if (freshDebate && (freshDebate.adaptive_staging as unknown) === true) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-store', level: 'warn', debate_id: freshDebate.id, message: 'adaptive_staging was the legacy boolean form — coercing to {enabled:true, pacing:"moderate"}' });
      set({ activeDebate: { ...freshDebate, adaptive_staging: { enabled: true, pacing: 'moderate' } } });
    }

    const resolvedDebate = get().activeDebate;
    const adaptive = resolvedDebate?.adaptive_staging;
    recordAdaptiveConfigAtStart(resolvedDebate, adaptive, initialCrossRespondRounds);

    if (adaptive?.enabled) {
      await runAdaptiveLoop(get, set, lease, adaptive, resolvedDebate);
    } else if (initialCrossRespondRounds > 0) {
      await runWatchOnlyLoop(get, set, lease, initialCrossRespondRounds);
    }
  }
}

/** Selects the clarification prompt function appropriate for this debate's source type. */
function selectClarificationPrompt(activeDebate: DebateSession, lineageCtx: string): string {
  const { topic, source_type, source_content, audience } = activeDebate;
  const t = topic.final;
  if (source_type === 'situations') return situationClarificationPrompt(t, source_content, audience, lineageCtx);
  if (source_type === 'document' || source_type === 'url') return documentClarificationPrompt(t, source_content, audience, lineageCtx);
  return buildClarificationPrompt(t, source_content || undefined, audience, lineageCtx);
}

/** Parses clarifying questions out of raw AI text, normalising both array and object shapes. */
function parseClarificationResponse(text: string): string[] {
  const clarParsed = parseAIJson<{ questions?: unknown[] } | unknown[]>(text);
  if (clarParsed && typeof clarParsed === 'object' && 'questions' in clarParsed && Array.isArray(clarParsed.questions)) {
    return clarParsed.questions.slice(0, 3).map(normalizeClarificationQuestion);
  }
  if (Array.isArray(clarParsed)) {
    return clarParsed.slice(0, 3).map(normalizeClarificationQuestion);
  }
  return [text.trim()];
}

/**
 * Checks whether clarification generation should be skipped.
 * Returns the skip reason string (for recording) or null if generation should proceed.
 */
function checkClarificationGuards(
  debateGenerating: SpeakerId | null,
  transcript: TranscriptEntry[],
): 'already_generating' | 'clarification_exists' | null {
  if (debateGenerating) return 'already_generating';
  if (transcript.some(e => e.type === 'clarification')) return 'clarification_exists';
  return null;
}

// ── submitAnswersAndSynthesize helpers ────────────────────────────────

type TopicScoringOutcome =
  | { kind: 'accepted'; score: number; critique: ReturnType<typeof parseTopicCritique> }
  | { kind: 'rejected' }
  | { kind: 'failed' }
  | { kind: 'aborted' };

async function scoreRefinedTopicCandidate(
  model: string,
  candidate: string,
  baselineCritique: ReturnType<typeof parseTopicCritique>,
  baselineScore: number,
  isStillValid: () => boolean,
  set: (partial: any) => void,
  debateId: string | undefined,
): Promise<TopicScoringOutcome> {
  try {
    const critiquePrompt = critiqueTopicPrompt(candidate);
    const { text: critiqueText } = await generateTextWithProgress(critiquePrompt, model, `Scoring refined topic (${model})`, set);
    if (!isStillValid()) {
      getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'warn', debate_id: debateId, message: 'submitAnswersAndSynthesize aborted: guard failed after critique scoring' });
      return { kind: 'aborted' };
    }
    const candidateCritique = parseTopicCritique(critiqueText, baselineCritique.structural_score);
    if (candidateCritique.composite_score >= baselineScore) {
      console.log(`[TopicRefinement] Accepted: score ${candidateCritique.composite_score} >= baseline ${baselineScore}`);
      return { kind: 'accepted', score: candidateCritique.composite_score, critique: candidateCritique };
    }
    console.log(`[TopicRefinement] Rejected: score ${candidateCritique.composite_score} < baseline ${baselineScore}`);
    return { kind: 'rejected' };
  } catch (scoreErr) {
    getGlobalRecorder()?.record({
      type: 'system.error', debate_id: debateId, component: 'debate-store', level: 'warn',
      message: 'Topic refinement scoring failed, accepting candidate',
      error: { name: (scoreErr as Error).name ?? 'Error', message: String(scoreErr), stack: (scoreErr as Error).stack },
    });
    console.warn('[TopicRefinement] Scoring failed, accepting candidate:', scoreErr);
    return { kind: 'failed' };
  }
}

type RefinementResult = { bestTopic: string | null; bestScore: number; bestCritique: ReturnType<typeof parseTopicCritique> | null; aborted: boolean };

type RefinementAttemptOutcome =
  | { kind: 'aborted' }
  | { kind: 'accepted'; candidate: string; score: number; critique: ReturnType<typeof parseTopicCritique> }
  | { kind: 'use_candidate'; candidate: string }
  | { kind: 'next' }
  | { kind: 'break' };

async function scoreTopicRefinementAttempt(
  attempt: number,
  prompt: string,
  model: string,
  label: string,
  baselineCritique: ReturnType<typeof parseTopicCritique> | null,
  baselineScore: number,
  isStillValid: () => boolean,
  set: (partial: any) => void,
  debateId: string | undefined,
): Promise<RefinementAttemptOutcome> {
  try {
    const { text } = await generateTextWithProgress(prompt, model, label, set);
    if (!isStillValid()) {
      getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'warn', debate_id: debateId, message: 'submitAnswersAndSynthesize aborted: guard failed after topic refinement' });
      return { kind: 'aborted' };
    }
    const parsed = parseAIJson<{ refined_topic?: string }>(text);
    const candidate = parsed?.refined_topic || text.trim();
    if (baselineCritique) {
      const outcome = await scoreRefinedTopicCandidate(model, candidate, baselineCritique, baselineScore, isStillValid, set, debateId);
      if (outcome.kind === 'aborted') return { kind: 'aborted' };
      if (outcome.kind === 'accepted') return { kind: 'accepted', candidate, score: outcome.score, critique: outcome.critique };
      if (outcome.kind === 'failed') return { kind: 'use_candidate', candidate };
      return { kind: 'next' };
    }
    return { kind: 'use_candidate', candidate };
  } catch (genErr) {
    getGlobalRecorder()?.record({
      type: 'system.error', debate_id: debateId, component: 'debate-store', level: 'error',
      message: `Topic refinement attempt ${attempt + 1} generation failed`,
      error: { name: (genErr as Error).name ?? 'Error', message: String(genErr), stack: (genErr as Error).stack },
    });
    console.warn(`[TopicRefinement] Attempt ${attempt + 1} generation failed:`, genErr);
    return { kind: 'break' };
  }
}

async function runTopicRefinementLoop(
  model: string,
  activeDebate: DebateSession,
  clarifications: { speaker: string; questions: string[]; answers: string }[],
  baselineCritique: ReturnType<typeof parseTopicCritique> | null,
  baselineScore: number,
  isStillValid: () => boolean,
  set: (partial: any) => void,
): Promise<RefinementResult> {
  const MAX_REFINEMENT_ATTEMPTS = 3;
  let bestTopic: string | null = null;
  let bestScore = baselineScore;
  let bestCritique: ReturnType<typeof parseTopicCritique> | null = null;
  const debateId = activeDebate?.id;

  for (let attempt = 0; attempt < MAX_REFINEMENT_ATTEMPTS; attempt++) {
    const prompt = buildSynthesisPrompt(activeDebate.topic.original, clarifications, activeDebate.audience, baselineCritique);
    const label = attempt === 0
      ? `Synthesizing refined topic (${model})`
      : `Refining topic, attempt ${attempt + 1}/${MAX_REFINEMENT_ATTEMPTS} (${model})`;
    const result = await scoreTopicRefinementAttempt(attempt, prompt, model, label, baselineCritique, baselineScore, isStillValid, set, debateId);
    if (result.kind === 'aborted') return { bestTopic, bestScore, bestCritique, aborted: true };
    if (result.kind === 'accepted') { bestTopic = result.candidate; bestScore = result.score; bestCritique = result.critique; break; }
    if (result.kind === 'use_candidate') { bestTopic = result.candidate; break; }
    if (result.kind === 'break') break;
    // 'next' — continue to next attempt
  }
  return { bestTopic, bestScore, bestCritique, aborted: false };
}

async function extractAndStoreTopicClauses(
  model: string,
  refinedTopic: string,
  isStillValid: () => boolean,
  set: (partial: any) => void,
  get: () => DebateStore,
  debateId: string | undefined,
): Promise<void> {
  if (!refinedTopic?.trim()) return;
  try {
    const clausePrompt = decomposeResolutionPrompt(refinedTopic);
    const { text: clauseText } = await generateTextWithProgress(clausePrompt, model, `Decomposing topic into clauses (${model})`, set);
    if (isStillValid()) {
      const clauseParsed = parseAIJson<{ clauses?: unknown }>(clauseText);
      if (Array.isArray(clauseParsed?.clauses)) {
        const clauses = (clauseParsed.clauses as unknown[])
          .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
          .map(c => c.trim());
        if (clauses.length > 0) get().updateTopic({ clauses });
      }
    }
  } catch (clauseErr) {
    getGlobalRecorder()?.record({
      type: 'system.error', debate_id: debateId, component: 'debate-store', level: 'warn',
      message: 'Resolution clause decomposition failed (non-fatal)',
      error: { name: (clauseErr as Error).name ?? 'Error', message: String(clauseErr), stack: (clauseErr as Error).stack },
    });
  }
}

async function embedSingleClause(
  clause: string,
  clauseVectors: number[][],
  debateId: string | undefined,
): Promise<void> {
  try {
    const { vector: cv } = await api.computeQueryEmbedding(clause.slice(0, 500));
    if (cv?.length) clauseVectors.push(cv);
  } catch (cvErr) {
    getGlobalRecorder()?.record({ type: 'system.error', debate_id: debateId, component: 'debate-store', level: 'debug', message: 'Clause embedding failed', error: { name: (cvErr as Error).name ?? 'Error', message: String(cvErr), stack: (cvErr as Error).stack } });
  }
}

async function embedAndStoreClauses(
  currentClauses: string[],
  isStillValid: () => boolean,
  debateId: string | undefined,
  get: () => DebateStore,
): Promise<void> {
  const clauseVectors: number[][] = [];
  for (const clause of currentClauses) {
    await embedSingleClause(clause, clauseVectors, debateId);
  }
  if (clauseVectors.length === currentClauses.length && isStillValid()) get().updateTopic({ clause_embeddings: clauseVectors });
}

async function embedTopicResolution(
  get: () => DebateStore,
  set: (partial: any) => void,
  isStillValid: () => boolean,
  debateId: string | undefined,
): Promise<void> {
  try {
    const topicForEmbed = get().activeDebate?.topic.final;
    if (!topicForEmbed?.trim()) return;
    const { vector } = await api.computeQueryEmbedding(topicForEmbed.slice(0, 1000));
    if (vector?.length && isStillValid()) get().updateTopic({ embedding: vector });
    const currentClauses = get().activeDebate?.topic.clauses;
    if (currentClauses?.length && isStillValid()) {
      await embedAndStoreClauses(currentClauses, isStillValid, debateId, get);
    }
  } catch (embedErr) {
    getGlobalRecorder()?.record({
      type: 'system.error', debate_id: debateId, component: 'debate-store', level: 'warn',
      message: 'Resolution anchor embedding failed — ArCo drift signal unavailable',
      error: { name: (embedErr as Error).name ?? 'Error', message: String(embedErr), stack: (embedErr as Error).stack },
    });
  }
}

async function extractAndStoreUserSeedClaims(
  model: string,
  refinedTopic: string,
  clarifications: { speaker: string; questions: string[]; answers: string }[],
  activeDebate: DebateSession,
  isStillValid: () => boolean,
  set: (partial: any) => void,
  get: () => DebateStore,
  addTranscriptEntry: (entry: Omit<TranscriptEntry, 'id' | 'timestamp'>) => string,
): Promise<void> {
  try {
    let qaPairsForClaims = '';
    for (const c of clarifications) {
      qaPairsForClaims += `\nQuestions:\n`;
      for (const q of c.questions) qaPairsForClaims += `  - ${q}\n`;
      qaPairsForClaims += `User answered: ${c.answers}\n`;
    }
    const seedPrompt = userSeedClaimsPrompt(refinedTopic, qaPairsForClaims, activeDebate.audience);
    const { text: seedText } = await generateTextWithProgress(seedPrompt, model, `Extracting user positions (${model})`, set);
    if (!isStillValid()) return;
    const seedParsed = parseAIJson<{ claims?: { claim: string; bdi_category?: string }[] }>(seedText);
    if (seedParsed?.claims && seedParsed.claims.length > 0) {
      const debate = get().activeDebate!;
      const existingAN = debate.argument_network ?? { nodes: [], edges: [] };
      const sourceEntryId = debate.transcript.find(e => e.type === 'answer')?.id ?? '';
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
      set({ activeDebate: { ...debate, argument_network: { nodes: [...existingAN.nodes, ...seedNodes], edges: [...existingAN.edges] } } });
      addTranscriptEntry({
        type: 'system', speaker: 'system',
        content: `Extracted ${seedNodes.length} user position${seedNodes.length > 1 ? 's' : ''} into the argument network:\n${seedNodes.map(n => `- [${n.id}] ${n.text}`).join('\n')}`,
        taxonomy_refs: [],
        metadata: { user_seed_claims: seedNodes.map(n => ({ id: n.id, text: n.text, bdi_category: n.bdi_category })) },
      });
    }
  } catch (seedErr) {
    getGlobalRecorder()?.record({
      type: 'system.error', debate_id: activeDebate?.id, component: 'debate-store', level: 'warn',
      message: 'User seed claim extraction failed',
      error: { name: (seedErr as Error).name ?? 'Error', message: String(seedErr), stack: (seedErr as Error).stack },
    });
    console.warn('[debate] User seed claim extraction failed (non-fatal):', seedErr);
    pushWarning(get, set, 'User position extraction skipped — debaters will not see your stated positions in the graph');
  }
}

// ── beginDebate helpers ───────────────────────────────────────────────

function needsDocumentAnalysis(debate: DebateSession | null | undefined): debate is DebateSession {
  return !!debate && !debate.document_analysis &&
    (debate.source_type === 'document' || debate.source_type === 'url');
}

async function runDocumentAnalysis(
  get: () => DebateStore,
  set: (partial: any) => void,
  addTranscriptEntry: (entry: Omit<TranscriptEntry, 'id' | 'timestamp'>) => string,
  saveDebate: (ctx: string) => Promise<void>,
  activeDebate: DebateSession,
  model: string,
): Promise<void> {
  set({ debateGenerating: 'system' as SpeakerId, debateStepStartedAt: Date.now() });
  newAbortController();
  const isStillValid = createDebateGuard(get);
  try {
    const taxStore = useTaxonomyStore.getState();
    const taxonomySample = buildTaxonomySample({
      accelerationist: { nodes: (taxStore.accelerationist?.nodes ?? []) as PovNode[] },
      safetyist: { nodes: (taxStore.safetyist?.nodes ?? []) as PovNode[] },
      skeptic: { nodes: (taxStore.skeptic?.nodes ?? []) as unknown as PovNode[] },
      situations: { nodes: (taxStore.situations?.nodes ?? []) as SituationNode[] },
      policyRegistry: (taxStore.policyRegistry ?? []).map((p: { id: string; action: string }) => ({ id: p.id, action: p.action })),
    });
    const activePovers = activeDebate.active_povers
      .filter(p => p !== 'user')
      .map(p => POVER_INFO[p as Exclude<SpeakerId, 'user'>]?.pov)
      .filter(Boolean);
    const { prompt: analysisPrompt } = documentAnalysisPrompt(activeDebate.source_content, activeDebate.topic.final, activePovers, taxonomySample);
    const { text: analysisText } = await generateTextWithProgress(analysisPrompt, model, `Analyzing document claims (${model})`, set);
    if (!isStillValid()) {
      getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'error', debate_id: activeDebate?.id, message: 'beginDebate aborted: guard failed after document analysis — debate will stall', data: { source_type: activeDebate.source_type, phase: activeDebate.phase } });
      return;
    }
    const analysis = parseAIJson<DocumentAnalysis>(analysisText);
    if (analysis && analysis.i_nodes && analysis.i_nodes.length > 0) {
      addTranscriptEntry({ type: 'system', speaker: 'system', content: `Document analysis complete: ${analysis.i_nodes.length} claims extracted, ${analysis.tension_points.length} tension points identified.\n\n${analysis.claims_summary}`, taxonomy_refs: [] });
      const debate = get().activeDebate;
      if (debate) {
        const existingAN = debate.argument_network ?? { nodes: [], edges: [] };
        const sourceEntryId = debate.transcript.slice(-1)[0]?.id ?? '';
        const docNodes: ArgumentNetworkNode[] = analysis.i_nodes.map(inode => ({
          id: inode.id, text: inode.text,
          speaker: 'document' as ArgumentNetworkNode['speaker'],
          source_entry_id: sourceEntryId, taxonomy_refs: inode.taxonomy_refs, turn_number: 0,
        }));
        for (const node of docNodes) {
          try {
            const { vector } = await api.computeQueryEmbedding(node.text.slice(0, 300));
            if (vector && vector.length > 0) node.embedding = vector;
          } catch (e) { getGlobalRecorder()?.record({ type: 'system.error', debate_id: activeDebate?.id, component: 'debate-store', level: 'warn', message: 'Doc i-node embedding failed', error: { name: (e as Error).name ?? 'Error', message: String(e), stack: (e as Error).stack } }); }
        }
        set({ activeDebate: { ...debate, document_analysis: analysis, argument_network: { nodes: [...existingAN.nodes, ...docNodes], edges: [...existingAN.edges] } } });
      }
    }
  } catch (err) {
    if (isCancellationError(err)) return;
    getGlobalRecorder()?.record({ type: 'system.error', debate_id: activeDebate?.id, component: 'debate-store', level: 'error', message: 'Document analysis failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    console.warn('[debate] Document analysis failed:', err);
    pushWarning(get, set, 'Document analysis could not be completed');
    addTranscriptEntry({ type: 'system', speaker: 'system', content: `Document analysis skipped: ${mapErrorToUserMessage(err)}`, taxonomy_refs: [] });
  } finally {
    set({ debateGenerating: null });
    await saveDebate('beginDebate:docAnalysis');
  }
}

// ── _runOpeningStatementsLeased helpers ───────────────────────────────

/** Returns true when an opening entry has been fully delivered (has prose content). */
function isDeliveredOpening(e: TranscriptEntry): boolean {
  return e.type === 'opening' && e.speaker !== 'system' && !!e.content && e.content.trim().length > 0;
}

/** Live + snapshot check: true if this speaker already has a delivered opening. */
function isSpeakerAlreadyDelivered(get: () => DebateStore, existingOpenings: Set<string>, poverId: string): boolean {
  if (existingOpenings.has(poverId)) return true;
  return (get().activeDebate?.transcript ?? []).some(e => isDeliveredOpening(e) && e.speaker === poverId);
}

type OpeningContextData = {
  input: OpeningPipelineInput;
  taxonomyBlock: string;
  commitBlock: string;
  ctx: Awaited<ReturnType<typeof getRelevantTaxonomyContext>>;
  resolvedBriefModel: string;
  stageGenerate: ReturnType<typeof makeStageGenerate>;
};

async function buildOpeningContextForSpeaker(
  get: () => DebateStore,
  set: (partial: any) => void,
  activeDebate: DebateSession,
  poverId: string,
  topic: string,
  model: string,
  priorStatements: { speaker: string; statement: string }[],
  openingSouls: ReturnType<typeof seatSouls>,
): Promise<OpeningContextData> {
  const info = openingSouls.soul;
  const speakerModel = getSpeakerModel(activeDebate, poverId, model);
  const stageGenerate = makeStageGenerate(set as unknown as (partial: Record<string, unknown>) => void, speakerModel, servedTurnRecorder(get, set as unknown as (partial: any) => void, poverId));
  const recentText = priorStatements.map(ps => ps.statement).join('\n').slice(-500);
  const ctx = await getRelevantTaxonomyContext(info.pov, topic, recentText);
  const speakerClaims = (get().activeDebate?.argument_network?.nodes || []).filter(n => n.speaker === poverId);
  const commitBlock = formatCommitments(get().activeDebate?.commitments?.[poverId] || { asserted: [], conceded: [], challenged: [] }, speakerClaims);
  const allANNodes = (get().activeDebate?.argument_network?.nodes || []).map(n => ({ id: n.id, text: n.text, speaker: POVER_INFO[n.speaker as Exclude<SpeakerId, 'user'>]?.label || n.speaker }));
  const establishedBlock = formatEstablishedPoints(allANNodes, info.label, 10);
  const edgeBlock = formatDebaterEdgeContext(info.pov);
  const vocab = get().vocabularyTerms;
  const vocabBlock = vocab ? '\n' + formatVocabularyContext({ pov: info.pov, standardizedTerms: vocab.standardized, colloquialTerms: vocab.colloquial }) : '';
  const taxonomyBlock = formatTaxonomyContext(ctx, info.pov) + commitBlock + establishedBlock + edgeBlock + vocabBlock;
  let priorBlock = '';
  if (priorStatements.length > 0) {
    priorBlock = '\n\n=== PRIOR OPENING STATEMENTS ===\n';
    for (const ps of priorStatements) priorBlock += `\n${ps.speaker}:\n${ps.statement}\n`;
  }
  const userSeeds = (get().activeDebate?.argument_network?.nodes || []).filter(n => n.speaker === 'user' && n.id.startsWith('user-seed-')).map(n => ({ id: n.id, text: n.text, bdi_category: n.bdi_category }));
  const resolvedBriefModel = resolveBriefModel(activeDebate, poverId, model);
  const input: OpeningPipelineInput = {
    label: info.label, pov: info.pov, personality: info.personality,
    soul: openingSouls.soul, opponentSouls: openingSouls.opponentSouls,
    topic, taxonomyContext: taxonomyBlock, priorStatements: priorBlock,
    isFirst: priorStatements.length === 0,
    priorSpeakerLabels: priorStatements.length > 0 ? priorStatements.map(ps => ps.speaker) : undefined,
    sourceContent: activeDebate.document_analysis ? undefined : (activeDebate.source_content || undefined),
    documentAnalysis: activeDebate.document_analysis,
    audience: activeDebate.audience,
    model: speakerModel,
    draftModel: activeDebate.stage_models?.draft || undefined,
    briefModel: activeDebate.stage_models?.brief || undefined,
    planModel: activeDebate.stage_models?.plan || undefined,
    citeModel: activeDebate.stage_models?.cite || undefined,
    userSeedClaims: userSeeds.length > 0 ? userSeeds : undefined,
    availablePovNodeIds: [...getSelectableNodeIds()],
    background: activeDebate.topic?.background || undefined,
    narrativeVoicing: (() => {
      const voicing = get().activeDebate?.narrative_voicing;
      return voicing ? narrativeBlockForDebater(voicing.narratives, poverId as any) : undefined;
    })(),
    stageTimeoutMs: Math.max(getDefaultTimeout(speakerModel, aiModelsRegistry as unknown as ModelRegistry), getModelMinTimeout(speakerModel, aiModelsRegistry as unknown as ModelRegistry)),
  };
  return { input, taxonomyBlock, commitBlock, ctx, resolvedBriefModel, stageGenerate };
}

function buildOpeningDiagnosticRecord(
  draftDiag: { prompt?: string; raw_response?: string } | undefined,
  pipelineResult: Awaited<ReturnType<typeof runOpeningPipelineWithRepair>>,
  model: string,
  taxonomyBlock: string,
  commitBlock: string,
  get: () => DebateStore,
) {
  const topicAlignDiag = pipelineResult.topicAlignmentResult
    ? {
        topic_aligned: pipelineResult.topicAlignmentResult.topic_aligned,
        repaired: pipelineResult.topicAlignmentResult.repaired || undefined,
        draft_attempt: pipelineResult.topicAlignmentResult.draft_attempt,
        scope_used: get().activeDebate?.topic?.scope ?? null,
      }
    : undefined;
  return {
    prompt: draftDiag?.prompt ?? '',
    raw_response: draftDiag?.raw_response ?? '',
    model,
    response_time_ms: pipelineResult.total_time_ms,
    taxonomy_context: taxonomyBlock,
    commitment_context: commitBlock || undefined,
    stage_diagnostics: pipelineResult.stage_diagnostics,
    topic_alignment: topicAlignDiag,
    quality_gate: pipelineResult.qualityGateResult,
  };
}

async function deliverOpeningResult(
  get: () => DebateStore,
  set: (partial: any) => void,
  addTranscriptEntry: (entry: Omit<TranscriptEntry, 'id' | 'timestamp'>) => string,
  saveDebate: (ctx: string) => Promise<void>,
  activeDebate: DebateSession,
  slotId: string,
  poverId: string,
  info: ReturnType<typeof seatSouls>['soul'],
  pipelineResult: Awaited<ReturnType<typeof runOpeningPipelineWithRepair>>,
  model: string,
  taxonomyBlock: string,
  commitBlock: string,
  ctx: Awaited<ReturnType<typeof getRelevantTaxonomyContext>>,
  priorStatements: { speaker: string; statement: string }[],
): Promise<{ statement: string }> {
  const knownNodeIds = getAllKnownNodeIds();
  const { statement, taxonomyRefs, meta } = assembleOpeningPipelineResult(pipelineResult, knownNodeIds);
  const trimmedLen = statement?.trim().length ?? 0;
  if (!statement || trimmedLen < 50) {
    throw new Error(`Opening statement was empty or too short (${trimmedLen} chars). The AI may have returned only structural metadata without prose content.`);
  }
  recordNarrativeCheck(get, set, poverId as any, pipelineResult.draft as unknown as Record<string, unknown>);
  meta.policy_refs = enrichPolicyRefs(meta.policy_refs, pipelineResult.draft as unknown as Record<string, unknown>);
  if (ctx.nodeScores) {
    for (const ref of taxonomyRefs) {
      const score = ctx.nodeScores.get(ref.node_id);
      if (score != null) ref.relevance_score = score;
    }
  }
  const relevanceSources = serializeNodeSourceMap(ctx.nodeSourceMap, taxonomyRefs);
  get().updateTranscriptEntry(slotId, {
    status: 'done', errorMessage: undefined, content: statement, taxonomy_refs: taxonomyRefs,
    policy_refs: meta.policy_refs,
    metadata: { key_assumptions: meta.key_assumptions, my_claims: meta.my_claims, turn_symbols: meta.turn_symbols, relevance_sources: relevanceSources, injection_manifest: ctx.injectionManifest },
  });
  getGlobalRecorder()?.record({
    type: 'debate.opening_added', component: 'debate-store', level: 'info', debate_id: activeDebate.id,
    message: `Opening delivered for ${info.label}`,
    data: { speaker: poverId, entryId: slotId, prior_steelmans_count: pipelineResult.draft.prior_steelmans?.length ?? 0, is_first_speaker: priorStatements.length === 0 },
  });
  const lastEntry = get().activeDebate?.transcript.find(e => e.id === slotId);
  if (lastEntry) {
    const draftDiag = pipelineResult.stage_diagnostics.find(s => s.stage === 'draft');
    recordDiagnostic(get, set, lastEntry.id, buildOpeningDiagnosticRecord(draftDiag, pipelineResult, model, taxonomyBlock, commitBlock, get));
    await summarizeTranscriptEntry(lastEntry.id, statement, info.label, model, get, set);
    await saveDebate('runOpeningStatements:perStatement');
    void extractClaimsAndUpdateAN(statement, poverId as SpeakerId, lastEntry.id, taxonomyRefs.map(r => r.node_id), get, set, meta.my_claims);
  }
  return { statement };
}

type OpeningResult =
  | { kind: 'delivered'; statement: { speaker: string; statement: string } }
  | { kind: 'skipped' }
  | { kind: 'aborted' }
  | { kind: 'cancelled' }
  | { kind: 'daily_limit' }
  | { kind: 'retryable'; label: string; reason: string; backoffMs: number }
  | { kind: 'terminal_error'; label: string };

async function generateSingleSpeakerOpening(
  get: () => DebateStore,
  set: (partial: any) => void,
  addTranscriptEntry: (entry: Omit<TranscriptEntry, 'id' | 'timestamp'>) => string,
  saveDebate: (ctx: string) => Promise<void>,
  activeDebate: DebateSession,
  poverId: string,
  topic: string,
  model: string,
  priorStatements: { speaker: string; statement: string }[],
  isStillValid: () => boolean,
  existingOpenings: Set<string>,
  openingRetryPass: number,
): Promise<OpeningResult> {
  if (!isStillValid()) {
    getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'info', debate_id: activeDebate.id, message: 'runOpeningStatements stopped — run lease no longer valid', data: { next_speaker: poverId } });
    return { kind: 'aborted' };
  }
  if (isSpeakerAlreadyDelivered(get, existingOpenings, poverId)) return { kind: 'skipped' };

  set({ debateGenerating: poverId as SpeakerId, debateStepStartedAt: Date.now() });
  const openingSouls = seatSouls(activeDebate, poverId as any);
  const info = openingSouls.soul;
  const slotId = get().upsertTranscriptEntry({ type: 'opening', speaker: poverId as SpeakerId, status: 'generating', content: '', taxonomy_refs: [] });

  try {
    const ctx = await buildOpeningContextForSpeaker(get, set, activeDebate, poverId, topic, model, priorStatements, openingSouls);
    const onBriefEvent: BriefEventFn = (phase, data) => {
      if (phase === 'brief.timeout' || phase === 'brief.retrying') {
        emitBriefTimeout({ debateId: activeDebate.id, speaker: data.agent, attempt: data.attempt, maxAttempts: data.maxRetries, currentModel: ctx.resolvedBriefModel });
      } else if (phase === 'brief.retries_exhausted') {
        emitBriefRetriesExhausted({ debateId: activeDebate.id, speaker: data.agent, totalAttempts: data.attempt, currentModel: ctx.resolvedBriefModel });
      }
    };
    const pipelineResult = await runOpeningPipelineWithRepair(
      ctx.input, ctx.stageGenerate,
      (_stage, label) => set({ debateActivity: label }),
      onBriefEvent,
      (m) => getModelMinTimeout(m, aiModelsRegistry as unknown as ModelRegistry),
    );
    if (!isStillValid()) {
      console.warn(`[debate-store] Debate state changed after ${info.label} opening pipeline — remaining speakers will be skipped.`);
      addTranscriptEntry({ type: 'system', speaker: 'system', content: `Opening generation interrupted after ${info.label} — superseded by a model switch or a debate change.`, taxonomy_refs: [] });
      getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'info', debate_id: activeDebate?.id, message: 'runOpeningStatements aborted post-pipeline', data: { speaker: info.label } });
      return { kind: 'aborted' };
    }
    const { statement } = await deliverOpeningResult(get, set, addTranscriptEntry, saveDebate, activeDebate, slotId, poverId, info, pipelineResult, model, ctx.taxonomyBlock, ctx.commitBlock, ctx.ctx, priorStatements);
    return { kind: 'delivered', statement: { speaker: info.label, statement } };
  } catch (err) {
    if (isCancellationError(err)) {
      releaseDebateDriver();
      set({ debateGenerating: null, debateActivity: null, debateProgress: null });
      return { kind: 'cancelled' };
    }
    const httpStatus = (err as { httpStatus?: number }).httpStatus;
    const { retryable: isRetryable, reason: retryReason } = classifyAiRetry(err);
    const retryInMs = retryReason === 'rate_limit' ? parseRetryAfterMs(err) : undefined;
    console.error(`[debate] ${info.label} opening statement failed (status=${httpStatus ?? 'unknown'}, retry=${retryReason}):`, err);
    getGlobalRecorder()?.record({ type: 'system.error', debate_id: activeDebate?.id, component: 'debate-engine', level: 'error', message: `Opening statement failed: ${info.label} (status=${httpStatus ?? 'unknown'})`, data: { retry_reason: retryReason, retryable: isRetryable, retry_pass: openingRetryPass, ...(retryInMs !== undefined && { retry_in_ms: retryInMs }) }, error: { name: (err as Error).name ?? 'Error', message: (err as Error).message ?? String(err), stack: (err as Error).stack?.slice(0, 500) } });
    if (isDailyLimitError(err)) {
      get().updateTranscriptEntry(slotId, { status: 'error', errorMessage: DAILY_LIMIT_MESSAGE });
      addTranscriptEntry({ type: 'system', speaker: 'system', content: DAILY_LIMIT_MESSAGE, taxonomy_refs: [] });
      releaseDebateDriver();
      set({ debateGenerating: null, debateActivity: null, debateError: DAILY_LIMIT_MESSAGE, dailyLimitPaused: true });
      await saveDebate('runOpeningStatements:dailyLimit');
      return { kind: 'daily_limit' };
    }
    get().updateTranscriptEntry(slotId, isRetryable
      ? { status: 'retrying', errorMessage: `${info.label} ${retryReasonLabel(retryReason)} — retrying automatically…` }
      : { status: 'error', errorMessage: mapErrorToUserMessage(err) });
    if (isRetryable) {
      const backoffMs = retryReason === 'rate_limit' ? (retryInMs ?? 5000) : Math.min(5000 * 2 ** openingRetryPass, 30_000);
      return { kind: 'retryable', label: info.label, reason: retryReasonLabel(retryReason), backoffMs };
    }
    return { kind: 'terminal_error', label: info.label };
  }
}

type PassOutcome = { allDone: boolean; retryable: boolean; lastReason: string; backoffMs: number; failedLabels: string[] };

async function runSingleOpeningPass(
  get: () => DebateStore,
  set: (partial: any) => void,
  addTranscriptEntry: (entry: Omit<TranscriptEntry, 'id' | 'timestamp'>) => string,
  saveDebate: (ctx: string) => Promise<void>,
  activeDebate: DebateSession,
  aiPovers: readonly string[],
  priorStatements: { speaker: string; statement: string }[],
  existingOpenings: Set<string>,
  isStillValid: () => boolean,
  passNumber: number,
): Promise<PassOutcome | null> {
  // Returns null when the run should terminate immediately (aborted/cancelled/daily_limit)
  const failedLabels: string[] = [];
  let retryable = false;
  let lastReason = retryReasonLabel('non_retryable');
  let backoffMs = 5000;

  for (const poverId of aiPovers) {
    const result = await generateSingleSpeakerOpening(get, set, addTranscriptEntry, saveDebate, activeDebate, poverId, activeDebate.topic.final, getConfiguredModel(), priorStatements, isStillValid, existingOpenings, passNumber);
    if (result.kind === 'aborted' || result.kind === 'cancelled') return null;
    if (result.kind === 'daily_limit') return null;
    if (result.kind === 'skipped') continue;
    if (result.kind === 'delivered') { priorStatements.push(result.statement); continue; }
    if (result.kind === 'retryable') { failedLabels.push(result.label); retryable = true; lastReason = result.reason; backoffMs = result.backoffMs; break; }
    failedLabels.push(result.label);
  }
  return { allDone: failedLabels.length === 0, retryable, lastReason, backoffMs, failedLabels };
}

async function runOpeningRetryLoop(
  get: () => DebateStore,
  set: (partial: any) => void,
  addTranscriptEntry: (entry: Omit<TranscriptEntry, 'id' | 'timestamp'>) => string,
  saveDebate: (ctx: string) => Promise<void>,
  activeDebate: DebateSession,
  aiPovers: readonly string[],
  priorStatements: { speaker: string; statement: string }[],
  existingOpenings: Set<string>,
  isStillValid: () => boolean,
  openingStartedAt: number,
): Promise<string> {
  const MAX_OPENING_RETRIES = 2;
  const OPENING_RETRY_BUDGET_MS = 8 * 60 * 1000;
  let pass = 0;
  let lastReason = retryReasonLabel('non_retryable');

  while (pass <= MAX_OPENING_RETRIES) {
    const result = await runSingleOpeningPass(get, set, addTranscriptEntry, saveDebate, activeDebate, aiPovers, priorStatements, existingOpenings, isStillValid, pass);
    if (!result) return lastReason;
    if (result.allDone || !result.retryable) break;
    lastReason = result.lastReason;
    pass++;
    if (Date.now() - openingStartedAt + result.backoffMs > OPENING_RETRY_BUDGET_MS) break;
    console.log(`[debate-store] Opening retry pass ${pass} — waiting ${result.backoffMs}ms`);
    set({ debateActivity: `A speaker ${lastReason} — retrying openings in ${Math.ceil(result.backoffMs / 1000)}s...` });
    await new Promise(resolve => setTimeout(resolve, result.backoffMs));
    if (!isStillValid()) break;
  }
  return lastReason;
}

async function finalizeOpeningStatements(
  get: () => DebateStore,
  set: (partial: any) => void,
  addTranscriptEntry: (entry: Omit<TranscriptEntry, 'id' | 'timestamp'>) => string,
  saveDebate: (ctx: string) => Promise<void>,
  activeDebate: DebateSession,
  aiPovers: readonly string[],
  openingStartedAt: number,
  lastRetryReason: string,
  lease: RunLease,
): Promise<void> {
  const currentDebate = get().activeDebate;
  const deliveredSpeakers = new Set((currentDebate?.transcript ?? []).filter(e => e.type === 'opening' && e.content?.trim()).map(e => e.speaker));
  const missingSpeakers = aiPovers.filter(p => !deliveredSpeakers.has(p as SpeakerId));
  if (missingSpeakers.length > 0) {
    const missingLabels = missingSpeakers.map(p => POVER_INFO[p as Exclude<SpeakerId, 'user'>]?.label ?? p);
    const elapsedSec = Math.round((Date.now() - openingStartedAt) / 1000);
    const elapsedStr = elapsedSec >= 60 ? `~${Math.round(elapsedSec / 60)} min` : `~${elapsedSec}s`;
    set({ debateActivity: null, debateError: `Opening statements failed for ${missingLabels.join(', ')} (${elapsedStr}).` });
    getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'warn', debate_id: activeDebate?.id, message: 'runOpeningStatements partial failure', data: { missingSpeakers, last_retry_reason: lastRetryReason, elapsed_ms: Date.now() - openingStartedAt } });
    await saveDebate('runOpeningStatements:partialFailure');
    return;
  }
  if (!activeDebate.user_is_pover) {
    get().updatePhase('debate');
    addTranscriptEntry({ type: 'system', speaker: 'system', content: 'Opening statements complete. The floor is open.', taxonomy_refs: [] });
  }
  await cacheOpeningEmbeddings(get, set);
  await finalizeNarrativeReference(get, set);
  void runNeutralCheckpoint('baseline', get, set as any, addTranscriptEntry as Parameters<typeof runNeutralCheckpoint>[3]);
  await saveDebate('runOpeningStatements:end');
  await runInitialCrossRespondRounds(get, set, activeDebate, lease);
}

// ── runInitialCrossRespondRounds helpers ─────────────────────────────

type AdaptiveIterResult =
  | { kind: 'continue'; consecutiveNoStatement: number }
  | { kind: 'break'; reason: string }
  | { kind: 'daily_limit' };

async function processAdaptiveIteration(
  get: () => DebateStore,
  set: (partial: any) => void,
  i: number,
  loopDebateId: string | undefined,
  lease: RunLease,
  consecutiveNoStatement: number,
): Promise<{ result: AdaptiveIterResult; loopExitReason: string }> {
  const d = get().activeDebate;
  if (!d) return { result: { kind: 'break', reason: 'debate_null' }, loopExitReason: 'debate_null' };
  if (!lease.isValid()) return { result: { kind: 'break', reason: 'lease_lost' }, loopExitReason: 'lease_lost' };
  if (d.adaptive_staging?.phase_state?.current_phase === 'terminated') return { result: { kind: 'break', reason: 'phase_terminated' }, loopExitReason: 'phase_terminated' };
  const preLen = d.transcript.length;
  try {
    await get().crossRespond({ lease, caller: 'adaptive-loop' });
  } catch (loopErr) {
    console.error(`[debate] Adaptive loop iteration ${i} failed:`, loopErr);
    getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-store', level: 'error', debate_id: d.id, message: `Adaptive loop failed at iteration ${i}`, data: { iteration: i, error: String(loopErr), stack: (loopErr as Error).stack?.slice(0, 500) } });
    if (isDailyLimitError(loopErr)) {
      set({ debateError: DAILY_LIMIT_MESSAGE, dailyLimitPaused: true });
      return { result: { kind: 'daily_limit' }, loopExitReason: 'daily_token_limit' };
    }
    set({ debateError: `Cross-respond failed: ${(loopErr as Error).message?.slice(0, 200) ?? String(loopErr)}` });
    return { result: { kind: 'break', reason: 'crossRespond_error' }, loopExitReason: 'crossRespond_error' };
  }
  if (get().dailyLimitPaused) return { result: { kind: 'daily_limit' }, loopExitReason: 'daily_token_limit' };
  const post = get().activeDebate;
  if (!post) return { result: { kind: 'break', reason: 'post_debate_null' }, loopExitReason: 'post_debate_null' };
  if (post.transcript.length === preLen) {
    const reason = `no_transcript_growth(preLen=${preLen},postLen=${post.transcript.length})`;
    getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'adaptive-loop', level: 'warn', debate_id: loopDebateId, message: 'Loop break: no transcript growth', data: { iteration: i, preLen, postLen: post.transcript.length, phase: post.adaptive_staging?.phase_state?.current_phase } });
    return { result: { kind: 'break', reason }, loopExitReason: reason };
  }
  if (!post.transcript.slice(preLen).some(e => e.type === 'statement')) {
    const newCount = consecutiveNoStatement + 1;
    const newEntryTypes = post.transcript.slice(preLen).map(e => e.type);
    if (newCount >= 3) {
      const reason = `consecutive_no_statement(count=${newCount},types=${newEntryTypes.join(',')})`;
      getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'adaptive-loop', level: 'warn', debate_id: loopDebateId, message: 'Loop break: 3 consecutive rounds without debater statement', data: { iteration: i, consecutiveNoStatement: newCount, preLen, postLen: post.transcript.length, newEntryTypes, phase: post.adaptive_staging?.phase_state?.current_phase } });
      return { result: { kind: 'break', reason }, loopExitReason: reason };
    }
    getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'adaptive-loop', level: 'debug', debate_id: loopDebateId, message: 'No statement in new entries — continuing', data: { iteration: i, consecutiveNoStatement: newCount, newEntryTypes, phase: post.adaptive_staging?.phase_state?.current_phase } });
    return { result: { kind: 'continue', consecutiveNoStatement: newCount }, loopExitReason: '' };
  }
  return { result: { kind: 'continue', consecutiveNoStatement: 0 }, loopExitReason: '' };
}

async function runAdaptiveLoop(
  get: () => DebateStore,
  set: (partial: any) => void,
  lease: RunLease,
  adaptive: NonNullable<DebateSession['adaptive_staging']>,
  resolvedDebate: DebateSession | null | undefined,
): Promise<void> {
  const weights = loadProvisionalWeights();
  const pacingPresetName = adaptive.pacing ?? 'moderate';
  const pacingPreset = weights.pacing_presets[pacingPresetName] ?? weights.pacing_presets.moderate;
  const caps = resolveLoopCaps(pacingPreset?.maxTotalRounds ?? 12, adaptive.phase_bounds_override, resolvedDebate);
  const maxRounds = caps.turnCeiling;
  const loopDebateId = resolvedDebate?.id;
  getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'adaptive-loop', level: 'info', debate_id: loopDebateId, message: 'Adaptive loop started', data: { pacing: pacingPresetName, maxTotalRounds: caps.presetMax, effectiveCap: caps.effectiveCap, turnCeiling: caps.turnCeiling, speakers: caps.speakers, argumentationExit: pacingPreset?.argumentationExit, concludingExit: pacingPreset?.concludingExit } });
  let loopExitReason = 'maxRounds_exhausted';
  let loopIterations = 0;
  let consecutiveNoStatement = 0;

  for (let i = 0; i < maxRounds; i++) {
    loopIterations = i + 1;
    const { result, loopExitReason: reason } = await processAdaptiveIteration(get, set, i, loopDebateId, lease, consecutiveNoStatement);
    if (result.kind === 'break') { loopExitReason = reason; break; }
    if (result.kind === 'daily_limit') { loopExitReason = 'daily_token_limit'; break; }
    consecutiveNoStatement = result.consecutiveNoStatement;
    await compressIfDue(get, lease);
  }

  const finalDebate = get().activeDebate;
  const finalPhase = finalDebate?.adaptive_staging?.phase_state?.current_phase;
  getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'adaptive-loop', level: 'info', debate_id: loopDebateId, message: `Adaptive loop ended: ${loopExitReason}`, data: { exit_reason: loopExitReason, iterations: loopIterations, maxRounds, final_phase: finalPhase, transcript_length: finalDebate?.transcript?.length, an_nodes: finalDebate?.argument_network?.nodes?.length } });
  getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'info', debate_id: loopDebateId, message: 'debate.ended', data: { reason: 'adaptive_loop_complete', exit_reason: loopExitReason, iterations: loopIterations } });
  const statementsInTranscript = finalDebate?.transcript.filter(e => e.type === 'statement').length ?? 0;
  if (finalDebate && statementsInTranscript >= 3 && loopExitReason !== 'daily_token_limit') {
    if (finalPhase !== 'terminated') {
      getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'adaptive-loop', level: 'warn', debate_id: loopDebateId, message: `Forcing synthesis: loop exited before termination (${loopExitReason})`, data: { exit_reason: loopExitReason, iterations: loopIterations, maxRounds, final_phase: finalPhase, statements: statementsInTranscript } });
    }
    await get().requestSynthesis();
  }
}

async function runWatchOnlyLoop(
  get: () => DebateStore,
  set: (partial: any) => void,
  lease: RunLease,
  initialCrossRespondRounds: number,
): Promise<void> {
  if (initialCrossRespondRounds <= 0) return;
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

async function runClarificationCore(
  get: () => DebateStore,
  set: (partial: any) => void,
  activeDebate: DebateSession,
  addTranscriptEntry: (entry: Omit<TranscriptEntry, 'id' | 'timestamp'>) => string,
  isStillValid: () => boolean,
  model: string,
  prompt: string,
  isSituation: boolean,
): Promise<void> {
  if (isSituation) getGlobalRecorder()?.record({ type: 'situation_debate.generation_trigger', component: 'debate-store', level: 'info', debate_id: activeDebate.id, message: 'situation_debate.generation_trigger', data: { model, phase: 'clarification' } });
  const { text } = await generateTextWithProgress(prompt, model, `Generating clarifying questions (${model})`, set);
  if (!isStillValid()) {
    getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'warn', debate_id: activeDebate?.id, message: 'runClarification aborted: guard failed after question generation' });
    return;
  }
  const questions = parseClarificationResponse(text);
  if (questions.length > 0) {
    addTranscriptEntry({
      type: 'clarification',
      speaker: 'system',
      content: questions.map((q, i) => `${i + 1}. ${q}`).join('\n'),
      taxonomy_refs: [],
      metadata: { questions },
    });
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
    const skipReason = checkClarificationGuards(debateGenerating, activeDebate.transcript);
    if (skipReason) {
      if (isSituation) getGlobalRecorder()?.record({ type: 'situation_debate.generation_skipped', component: 'debate-store', level: 'info', debate_id: activeDebate.id, message: 'situation_debate.generation_skipped', data: { reason: skipReason } });
      return;
    }

    const isStillValid = createDebateGuard(get);
    set({ debateError: null, debateWarnings: [] });
    const model = getConfiguredModel();

    set({ debateGenerating: 'system' as SpeakerId, debateStepStartedAt: Date.now() });
    const lineageCtx = buildLineageContext() ?? '';
    const prompt = selectClarificationPrompt(activeDebate, lineageCtx);
    try {
      // t/3032: the clarification trigger point and question generation.
      await runClarificationCore(get, set, activeDebate, addTranscriptEntry, isStillValid, model, prompt, isSituation);
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
    const MAX_REFINEMENT_ATTEMPTS = 3;

    try {
      const { bestTopic, bestScore, bestCritique, aborted } = await runTopicRefinementLoop(
        model, activeDebate, clarifications, baselineCritique ?? null, baselineScore, isStillValid, set,
      );
      if (aborted) return;

      const refinedTopic = bestTopic ?? activeDebate.topic.final;
      const keptOriginal = bestTopic === null && baselineCritique != null;

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

      await extractAndStoreTopicClauses(model, refinedTopic, isStillValid, set, get, activeDebate?.id);
      await embedTopicResolution(get, set, isStillValid, activeDebate?.id);
      await extractAndStoreUserSeedClaims(model, refinedTopic, clarifications, activeDebate, isStillValid, set, get, addTranscriptEntry);

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

    if (needsDocumentAnalysis(activeDebate)) {
      const model = getConfiguredModel();
      await runDocumentAnalysis(get, set, addTranscriptEntry, saveDebate, activeDebate, model);
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
    await runNarrativeVoicing(get, set, addTranscriptEntry, model);
    if (!isStillValid()) {
      getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'debate-store', level: 'info', debate_id: activeDebate.id, message: 'runOpeningStatements aborted after narrative voicing' });
      return;
    }

    const resolvedOrder = resolveOpeningOrder(get().openingOrder, activeDebate);
    const aiPovers = (resolvedOrder as readonly (typeof AI_POVERS[number])[]).filter(
      (p) => activeDebate.active_povers.includes(p),
    );

    const existingOpenings = new Set(
      activeDebate.transcript.filter(isDeliveredOpening).map(e => e.speaker as string),
    ) as Set<string>;
    const priorStatements: { speaker: string; statement: string }[] = [];
    for (const poverId of aiPovers) {
      const existing = activeDebate.transcript.find(e => isDeliveredOpening(e) && e.speaker === poverId);
      if (existing) priorStatements.push({ speaker: POVER_INFO[poverId].label, statement: existing.content });
    }

    const openingStartedAt = Date.now();
    const lastRetryReason = await runOpeningRetryLoop(get, set, addTranscriptEntry, saveDebate, activeDebate, aiPovers, priorStatements, existingOpenings, isStillValid, openingStartedAt);

    releaseDebateDriver();
    set({ debateGenerating: null });

    // Skip finalization when the run was superseded (lease invalid) or hit a daily limit —
    // the superseding run handles its own finalization, and the daily limit handler already
    // set debateError/dailyLimitPaused. Original code relied on inline `return` statements
    // for these paths; extracting to runOpeningRetryLoop removed that implicit guard.
    if (isStillValid() && !get().dailyLimitPaused) {
      await finalizeOpeningStatements(get, set, addTranscriptEntry, saveDebate, activeDebate, aiPovers, openingStartedAt, lastRetryReason, lease);
    }
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
