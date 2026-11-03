// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Helpers split from debatePhaseSlice.ts (file-length pass, PR #4089).
// Two cohesive groups: position-drift chain + _crossRespondLeased decomposition helpers.
// All logic is verbatim — pure structural extraction, no behavioral changes.

import type { _Get, _Set, _AddEntry, _AiPover, _PoverInfo } from './debatePhaseSlice';
import type {
  DebateSession,
  TranscriptEntry,
  TurnAttempt,
  TurnValidation,
  TurnValidationTrail,
  SpeakerId,
} from '../../../types/debate';
import { POVER_INFO } from '../../../types/debate';
import type { ModeratorState } from '@lib/debate/types';
import type { PoverResponseMeta } from '@lib/debate/helpers';
import type { TurnPipelineInput } from '@lib/debate/turnPipeline';
import { runTurnPipeline, assemblePipelineResult } from '@lib/debate/turnPipeline';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { cosineSimilarity } from '../../../utils/taxonomyRelevance';
import { isCancellationError, isDailyLimitError, DAILY_LIMIT_MESSAGE, releaseDebateDriver } from '../shared/guards';
import { mapErrorToUserMessage } from '../../../utils/errorMessages';
import { runNeutralCheckpoint } from '../shared/neutralCheckpoint';
import { routeTurnValidatorHintsIntoSuggestions, summarizeTranscriptEntry, makeStageGenerate } from '../shared/generation';
import { recordDiagnostic } from '../shared/diagnostics';
import { extractClaimsAndUpdateAN } from '../shared/argumentNetwork';
import { getAllKnownNodeIds } from '../shared/taxonomyContext';
import { updateNarrativeSimilarity } from '../shared/narrativeVoicing';
import { useTaxonomyStore } from '../../useTaxonomyStore';

// ── Position-drift chain (internal — only used by recordLastEntryDiagnosticsAndDrift) ──

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

// ── _crossRespondLeased decomposition helpers (CC-reduction pass, PR #4089) ──
// Ten focused helpers extracted from _crossRespondLeased to bring it from CC≈33 to CC≈9.
// Behavior preserved verbatim — pure structural extraction, no logic changes.

export function fixOpeningPhaseTransition(activeDebate: DebateSession, get: _Get): void {
  if (activeDebate.phase === 'opening' && activeDebate.transcript.some(e => e.type === 'opening')) {
    get().updatePhase('debate');
  }
}

export async function ensureEdgesLoaded(): Promise<void> {
  const taxState = useTaxonomyStore.getState();
  if (!taxState.edgesFile) {
    await useTaxonomyStore.getState().loadEdges();
  }
}

export function persistModeratorStateUpdate(get: _Get, set: _Set, modState: ModeratorState): void {
  const freshDebate = get().activeDebate;
  if (freshDebate) {
    set({ activeDebate: { ...freshDebate, moderator_state: modState } });
  }
}

export function enrichTaxonomyRefScores(
  ctx: { nodeScores?: Map<string, number> },
  taxonomyRefs: { node_id: string; relevance_score?: number }[],
): void {
  if (!ctx.nodeScores) return;
  for (const ref of taxonomyRefs) {
    const score = ctx.nodeScores.get(ref.node_id);
    if (score != null) ref.relevance_score = score;
  }
}

export function buildCaveatsFromValidation(
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

export function buildCrossRespondEntryMetadata(
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

export function persistValidationTrail(
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

export async function recordLastEntryDiagnosticsAndDrift(
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

export function checkNeutralMidpointCheckpoint(
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

export function handleTurnPipelineError(
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
