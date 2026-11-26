// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Shared debate orchestration logic — extracted from useDebateStore and
 * debateEngine to eliminate dual-maintained code. Both consumers delegate
 * to these functions via callbacks for AI calls and state management.
 *
 * Follows the same pattern as turnPipeline.ts (StageGenerateFn callbacks).
 */

import type {
  SpeakerId,
  TranscriptEntry,
  ArgumentNetworkNode,
  ArgumentNetworkEdge,
  ConvergenceSignals,
  ModeratorState,
  ModeratorIntervention,
  SelectionResult,
  EngineValidationResult,
  DebateHealthScore,
  InterventionMetadata,
  InterventionMove,
  DebatePhase,
  DebateAudience,
  ModeratorMode,
  GapInjection,
  UnansweredClaimEntry,
  TurnPipelineResult,
  TurnValidation,
  TurnAttempt,
  TaxonomyRef,
  TurnValidationConfig,
  HintEffectiveness,
  HintSpecificity,
  HintSource,
  DialecticalDiagnostic,
} from './types.js';

import {
  initModeratorState,
  validateRecommendation,
  updateModeratorState,
  computeDebateHealthScore,
  updateSliBreaches,
  computeTriggerEvaluationContext,
  formatTriggerContext,
  buildIntervention,
  buildInterventionBriefInjection,
  getConcludingResponder,
  shouldFirePolicyChallenge,
  detectCruxFocusTrigger,
  buildCruxFocusInterventionText,
  getFocusedIds,
} from './moderator.js';

import {
  moderatorSelectionPrompt,
  moderatorInterventionPrompt,
  formatCriticalQuestions,
  selectReframingMetaphor,
} from './prompts.js';

import {
  formatArgumentNetworkContext,
  formatUnansweredClaimsHint,
  formatSpecifyHint,
} from './argumentNetwork.js';
import { effectiveCamp } from './argumentNetwork/utils.js';

import { parseAIJson } from './helpers.js';
import { parseJsonRobust, formatRecentTranscript, getMoveName } from './helpers.js';
import type { PoverResponseMeta, MoveAnnotation } from './helpers.js';
import type { TurnPipelineInput } from './turnPipeline.js';
import type { GenerateOptions } from './aiAdapter.js';
import { validateTurn, resolveTurnValidationConfig } from './turnValidator.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';
import { applyEngineFloor, checkModeratorDormancy, recordEnginePin } from './moderatorEngineTriggers.js';
import { inferBackend } from '../ai-client/registry.js';
import { DEFAULT_TEMPERATURE } from '../ai-client/defaults.js';
import { runPropositionalGate } from './revoiceGate.js';
import { priorCommitOpenings } from './commitOpenings.js';

const SLOW_BACKEND_TIMEOUT_MS = 180_000;
const DEFAULT_TIMEOUT_MS = 60_000;

function moderatorTimeoutMs(model: string): number {
  // An estimate, so an unknown id gets the default timeout rather than throwing (t/4101).
  const backend = inferBackend(model);
  return backend === 'deepseek' ? SLOW_BACKEND_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

// ── Callback Interfaces ─────────────────────────────────

export type GenerateFn = (
  prompt: string,
  model: string,
  options: GenerateOptions,
  label: string,
) => Promise<string>;

export interface ModeratorSelectionCallbacks {
  generate: GenerateFn;
  addEntry(entry: Omit<TranscriptEntry, 'id' | 'timestamp'>): string;
  progress(phase: string, speaker?: string, message?: string): void;
  warn(context: string, err: unknown, recovery: string): void;
  formatEdgeContext(activePovers: string[]): { text: string; edges_used?: unknown[] };
  isAborted?(): boolean;
  computeEmbedding?(text: string): Promise<number[]>;
}

// ── Input / Output Types ────────────────────────────────

export interface ModeratorSelectionInput {
  round: number;
  phase: DebatePhase;
  activePovers: Exclude<SpeakerId, 'user'>[];
  totalRounds: number;
  model: string;
  audience?: DebateAudience;
  /** Moderator strategy; absent means standard behavior. */
  moderatorMode?: ModeratorMode;
  /** Dialectical style — gates phase/orchestration behaviour (e.g. suppresses COMMIT in socratic). */
  dialecticalStyle?: import('./types/phase.js').DialecticalStyle;
  sourceDocSummary?: string;
  /** Final resolution text — used to anchor the moderator's interventions
   *  to the resolution's specific subjects rather than abstractions. */
  resolution?: string;
  /** Decomposition of the resolution into atomic clauses, set by
   *  runClarification. The moderator labels each intervention with the
   *  clause number it concerns. */
  resolutionClauses?: string[];
  /** Topic-drift state derived from recent convergence_signals. Surfaced to
   *  the moderator's selection prompt to bias toward REDIRECT when the
   *  debate has drifted from the resolution. */
  topicDriftState?: {
    /** Latest ArCo phase_mean across same-phase turns (0..1). */
    phaseMeanSimilarity?: number;
    /** True when phase_mean is below ARCO_DRIFT_THRESHOLD. */
    driftWarning: boolean;
    /** 1-based clause indices that have been engaged with in the last N turns. */
    coveredClauses: number[];
    /** 1-based clause indices that have NOT yet been engaged. */
    uncoveredClauses: number[];
    /** Count of recent consecutive turns with no_clause_engaged === true. */
    consecutiveOffClause: number;
  };
  transcript: ReadonlyArray<TranscriptEntry>;
  contextSummaries?: { up_to_entry_id: string; summary: string; tier?: string }[];
  argumentNetwork?: { nodes: ArgumentNetworkNode[]; edges: ArgumentNetworkEdge[] };
  convergenceSignals?: ConvergenceSignals[];
  unansweredLedger?: UnansweredClaimEntry[];
  gapInjections?: GapInjection[];
  commitments?: Record<string, { asserted?: unknown[]; conceded?: unknown[]; challenged?: unknown[] }>;
  existingModState?: ModeratorState | null;
  /** POV info lookup: poverId → { label, pov } */
  poverInfo: Record<string, { label: string; pov: string; personality?: string }>;
  /** Crux tracker from session — used by CRUX_FOCUS trigger detection. */
  cruxTracker?: ReadonlyArray<{ id: string; description: string; identified_turn: number; state: string; disagreement_type?: string; attacking_claim_ids: string[]; speakers_involved: SpeakerId[] }>;
  /** Claim text lookup for contested term extraction (AN node id → text). */
  claimTexts?: Record<string, string>;
  /** Taxonomy node embeddings for REVOICE propositional gate. */
  nodeEmbeddings?: Record<string, { vector: number[] }>;
}

export interface ModeratorSelectionResult {
  responder: Exclude<SpeakerId, 'user'>;
  focusPoint: string;
  addressing: string;
  agreementDetected: boolean;
  selectionResult: Partial<SelectionResult>;
  intervention?: ModeratorIntervention;
  engineValidation?: EngineValidationResult;
  interventionBriefInjection: string;
  /** Moderator state with health score appended but NOT yet updated for this round's intervention. Callers must call updateModeratorState() at end of round. */
  modState: ModeratorState;
  healthScore: DebateHealthScore;
  diagnostics: {
    selectionPrompt: string;
    selectionResponse: string;
    selectionElapsed: number;
    edgeContextLength: number;
    anContextLength: number;
    qbafContextLength: number;
    edgesUsed?: unknown[];
    recentScheme?: string | null;
    metaphorReframeOffered?: string | null;
  };
  /** null if the response was parsed successfully; set to the error if parsing failed */
  selectionParseError?: unknown;
  /** True if agreement was detected and a system entry was added */
  earlyReturn: boolean;
}

const DIALECTICAL_DISAGREEMENT_TYPES = new Set<DialecticalDiagnostic['disagreement_type']>([
  'empirical', 'causal', 'definitional', 'normative', 'mixed', 'unclear',
]);

/** Normalize untrusted moderator JSON into a complete, reviewable diagnostic. */
export function parseDialecticalDiagnostic(raw: unknown, fallbackCrux: string): DialecticalDiagnostic {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const optionalText = (candidate: unknown): string | null => {
    if (typeof candidate !== 'string') return null;
    const trimmed = candidate.trim();
    return trimmed.length > 0 ? trimmed.slice(0, 2_000) : null;
  };
  const focusedCrux = optionalText(value.focused_crux)
    ?? (fallbackCrux.trim() || 'No focused crux identified');
  const rawType = typeof value.disagreement_type === 'string'
    ? value.disagreement_type.trim().toLowerCase()
    : 'unclear';
  const disagreementType = DIALECTICAL_DISAGREEMENT_TYPES.has(rawType as DialecticalDiagnostic['disagreement_type'])
    ? rawType as DialecticalDiagnostic['disagreement_type']
    : 'unclear';

  return {
    focused_crux: focusedCrux.slice(0, 2_000),
    disagreement_type: disagreementType,
    premise_under_examination: optionalText(value.premise_under_examination),
    distinction_or_analogy_tested: optionalText(value.distinction_or_analogy_tested),
    unresolved_outcome: optionalText(value.unresolved_outcome),
  };
}

// ── Shared Helper: Build Moderator Context ──────────────

function buildQbafContext(an: { nodes: ArgumentNetworkNode[]; edges: ArgumentNetworkEdge[] }, poverInfo: Record<string, { label: string }>): string {
  if (!an.nodes.some(n => n.computed_strength != null)) return '';
  const addressed = new Set(an.edges.map(e => e.target));
  const unaddressed = an.nodes
    .filter(n => n.computed_strength != null && !addressed.has(n.id))
    .sort((a, b) => (b.computed_strength ?? 0) - (a.computed_strength ?? 0))
    .slice(0, 5);
  if (unaddressed.length === 0) return '';
  return '\n\n=== STRONGEST UNADDRESSED CLAIMS (by QBAF strength) ===\n'
    + 'Prioritize these — they are well-supported but no one has responded to them yet.\n'
    + 'Claims marked [unscored] have default strength (0.5) — their actual strength is unknown pending human review.\n'
    + 'Claims marked [low-confidence] are Belief claims where AI scoring reliability is poor — weight them carefully.\n'
    + unaddressed.map(n => {
      const unscoredTag = n.scoring_method === 'unscored' ? ' [unscored]' : '';
      const bdiTag = n.bdi_category ? ` ${n.bdi_category[0].toUpperCase()}` : '';
      const confTag = n.bdi_confidence != null && n.bdi_confidence < 0.5 ? ' [low-confidence]' : '';
      return `- ${n.id} (${poverInfo[effectiveCamp(n)]?.label ?? effectiveCamp(n)},${bdiTag}, strength ${n.computed_strength!.toFixed(2)}${unscoredTag}${confTag}): ${n.text}`;
    }).join('\n');
}

function buildGapHint(gapInjections?: GapInjection[]): string {
  if (!gapInjections || gapInjections.length === 0) return '';
  const last = gapInjections[gapInjections.length - 1];
  const transcriptEntry = last.transcript_entry_id;
  if (!transcriptEntry) return '';
  return `\n\n## Identified Debate Gaps (unaddressed)\nThe following gaps were identified mid-debate but have NOT yet been substantively addressed by any debater. Prioritize steering the conversation toward these:\n- Gap injection from round ${last.round ?? '?'}: See transcript for details.\n`;
}

function findRecentScheme(an?: { edges: ArgumentNetworkEdge[] }): string | null {
  if (!an) return null;
  return an.edges
    .filter(e => e.argumentation_scheme && e.argumentation_scheme !== 'OTHER')
    .slice(-1)[0]?.argumentation_scheme ?? null;
}

function checkMetaphorReframe(
  round: number,
  transcript: ReadonlyArray<TranscriptEntry>,
  an?: { edges: ArgumentNetworkEdge[] },
): ReturnType<typeof selectReframingMetaphor> {
  if (round < 4) return null;
  const last3Moves = transcript
    .filter(e => e.speaker !== 'system' && e.speaker !== 'user' && e.speaker !== 'moderator')
    .slice(-3)
    .flatMap(e => ((e.metadata as Record<string, unknown>)?.move_types as (string | MoveAnnotation)[] ?? []))
    .map(m => getMoveName(m));
  const concedeDist = last3Moves.filter(m => m === 'CONCEDE').length;
  const distinguishDist = last3Moves.filter(m => m === 'DISTINGUISH').length;
  const isStalling = (concedeDist >= 2 && distinguishDist >= 2) || last3Moves.length === 0;
  const recentAgreement = transcript
    .filter(e => e.speaker === 'system')
    .some(e => e.content.includes('agreement'));

  if (!isStalling && !recentAgreement) return null;

  const usedSources = (an?.edges ?? [])
    .filter(e => e.argumentation_scheme === 'ARGUMENT_FROM_METAPHOR')
    .map(e => e.warrant ?? '')
    .filter(Boolean);
  return selectReframingMetaphor(usedSources, round);
}

/** Build the moderator's topic-anchoring context block. Emits a section
 *  describing the resolution, its clauses, current ArCo phase mean, and which
 *  clauses are covered vs. uncovered — so the moderator can prefer REDIRECT
 *  to an unaddressed clause when the debate has drifted. */
function buildTopicAnchoringBlock(
  resolution: string | undefined,
  clauses: string[] | undefined,
  drift: ModeratorSelectionInput['topicDriftState'],
): string {
  if (!resolution) return '';
  const clauseLines = (clauses && clauses.length > 0)
    ? `\nClauses:\n${clauses.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}`
    : '';
  let driftLine = '';
  if (drift) {
    const phaseMean = drift.phaseMeanSimilarity != null ? drift.phaseMeanSimilarity.toFixed(2) : 'n/a';
    const warn = drift.driftWarning ? ' [DRIFT WARNING]' : '';
    const covered = drift.coveredClauses.length > 0 ? drift.coveredClauses.join(', ') : 'none';
    const uncovered = drift.uncoveredClauses.length > 0 ? drift.uncoveredClauses.join(', ') : 'none';
    driftLine = `\nDrift state: phase_mean_similarity=${phaseMean}${warn}; clauses covered=[${covered}]; clauses uncovered=[${uncovered}]; consecutive_off_clause_turns=${drift.consecutiveOffClause}`;
  }
  const directive = drift && (drift.driftWarning || drift.consecutiveOffClause >= 2) && drift.uncoveredClauses.length > 0
    ? `\n\nDIRECTIVE: The debate has drifted from the resolution. Strongly prefer a REDIRECT intervention targeting an uncovered clause (specifically: clause ${drift.uncoveredClauses[0]}). Do NOT simply summarize the current off-clause discussion as the new topic.`
    : '';
  return `\n=== TOPIC ANCHORING STATE ===\nResolution: "${resolution}"${clauseLines}${driftLine}${directive}\n`;
}

// ── Main Orchestration Function ─────────────────────────

export async function runModeratorSelection(
  input: ModeratorSelectionInput,
  callbacks: ModeratorSelectionCallbacks,
): Promise<ModeratorSelectionResult> {
  const {
    round, phase, activePovers, totalRounds, model,
    audience, moderatorMode, sourceDocSummary, resolution, resolutionClauses,
    topicDriftState, transcript, contextSummaries,
    argumentNetwork: an, convergenceSignals, unansweredLedger,
    gapInjections, commitments, existingModState, poverInfo,
  } = input;

  const activeLabels = activePovers.map(p => poverInfo[p].label);
  const recentTranscript = formatRecentTranscript(
    transcript as TranscriptEntry[], 8, contextSummaries,
    { includeTaxonomyRefs: false },
  );

  // Initialize or restore moderator state
  const modState: ModeratorState = existingModState
    ? { ...existingModState }
    : initModeratorState(totalRounds, activePovers);
  modState.round = round;
  modState.phase = phase;

  // Compute turn counts
  const turnCounts: Record<string, number> = {};
  for (const p of activePovers) turnCounts[p] = 0;
  for (const e of transcript) {
    if ((e.type === 'statement' || e.type === 'opening') && e.speaker !== 'system' && e.speaker !== 'moderator') {
      const key = turnCounts[e.speaker] != null ? e.speaker : poverInfo[e.speaker]?.label;
      if (key != null && turnCounts[key] != null) {
        turnCounts[key]++;
      } else if (e.speaker in turnCounts) {
        turnCounts[e.speaker]++;
      }
    }
  }

  // Compute debate health score
  const recentSignals = (convergenceSignals ?? []).slice(-3);
  const citedNodeIds = new Set(
    (transcript as TranscriptEntry[]).flatMap(e => (e.taxonomy_refs ?? []).map(r => r.node_id)),
  );
  const relevantNodeCount = Math.max(an?.nodes?.length ?? 1, 1);
  const healthScore = computeDebateHealthScore(recentSignals, turnCounts, citedNodeIds.size, relevantNodeCount);
  if (modState.health_history.length > 0) {
    const prev = modState.health_history[modState.health_history.length - 1];
    healthScore.trend = healthScore.value - prev.value;
  }
  healthScore.consecutive_decline = modState.consecutive_decline;
  modState.health_history.push(healthScore);
  updateSliBreaches(healthScore, modState);

  // Build context blocks
  const { text: edgeContext, edges_used: edgesUsed } = callbacks.formatEdgeContext(activeLabels);
  const anContext = (an && an.nodes.length > 0)
    ? formatArgumentNetworkContext(
      an.nodes.map(n => ({ id: n.id, text: n.text, speaker: poverInfo[n.speaker]?.label || n.speaker })),
      an.edges,
    )
    : '';
  const qbafContext = an ? buildQbafContext(an, poverInfo) : '';
  const ledgerHint = formatUnansweredClaimsHint(unansweredLedger ?? [], round);
  const specifyHint = an ? formatSpecifyHint(an.nodes, an.edges) : '';
  const gapHint = buildGapHint(gapInjections);
  const recentScheme = findRecentScheme(an);
  const metaphorReframe = checkMetaphorReframe(round, transcript, an);

  const triggerCtx = computeTriggerEvaluationContext(modState, turnCounts);
  const triggerBlock = formatTriggerContext(triggerCtx);

  // ── Synthesis COMMIT automation ──
  // Suppressed for socratic: aporia phase has no consensus telos, so forced COMMIT moves are wrong.
  const concludingTarget = phase === 'concluding' && input.dialecticalStyle !== 'socratic'
    ? getConcludingResponder(modState, activePovers, transcript as TranscriptEntry[])
    : null;

  if (phase === 'concluding' && input.dialecticalStyle !== 'socratic') {
    const commitReceivedBy = [...new Set(modState.intervention_history.filter(h => h.move === 'COMMIT').map(h => h.target))];
    getGlobalRecorder()?.record({
      type: 'debate.closure_eligible', component: 'orchestration', level: 'info',
      message: `closure_eligible: ${commitReceivedBy.length}/${activePovers.length} povers committed`,
      data: {
        commit_received_by: commitReceivedBy,
        total_povers: activePovers.length,
        eligible: concludingTarget === null,
      },
    });
  }

  let responder: Exclude<SpeakerId, 'user'> | null = null;
  let focusPoint = 'Continue the discussion';
  let addressing = 'general';
  let agreementDetected = false;
  let selectionResultObj: Partial<SelectionResult> = {};
  let activeIntervention: ModeratorIntervention | undefined;
  let engineValidation: EngineValidationResult | undefined;
  let interventionBriefInjection = '';
  let selectionPrompt = '';
  let selectionText = '';
  let selectionElapsed = 0;
  let selectionParseError: unknown;

  if (concludingTarget) {
    // Deterministic synthesis — skip Stage 1 LLM, fire COMMIT directly
    responder = concludingTarget as Exclude<SpeakerId, 'user'>;
    const topicRef = resolution ? ` on the question: "${resolution}"` : '';
    focusPoint = `Deliver your final verdict${topicRef}. State your answer to the original question, then your concessions, conditions for change, and sharpest remaining disagreements`;
    addressing = 'all';
    selectionResultObj = {
      responder: concludingTarget,
      addressing: 'general',
      focus_point: focusPoint,
      agreement_detected: false,
      intervene: true,
      suggested_move: 'COMMIT' as InterventionMove,
      target_debater: concludingTarget,
      trigger_reasoning: 'Automatic COMMIT in synthesis phase',
    };

    engineValidation = validateRecommendation(selectionResultObj as SelectionResult, modState);
    if (engineValidation.proceed) {
      try {
        const stage2Prompt = moderatorInterventionPrompt(
          engineValidation.validated_move,
          engineValidation.validated_family,
          poverInfo[engineValidation.validated_target]?.label ?? engineValidation.validated_target,
          'Automatic synthesis-phase COMMIT',
          undefined,
          formatRecentTranscript(transcript as TranscriptEntry[], 4, contextSummaries, { includeTaxonomyRefs: false }),
          audience,
          sourceDocSummary,
          resolution,
          resolutionClauses,
          priorCommitOpenings(transcript as TranscriptEntry[]),
        );
        const stage2Text = await callbacks.generate(
          stage2Prompt, model, { temperature: DEFAULT_TEMPERATURE, timeoutMs: moderatorTimeoutMs(model) },
          `Round ${round}: Moderator COMMIT → ${poverInfo[concludingTarget]?.label}`,
        );

        const stage2Parsed = parseJsonRobust(stage2Text) as Record<string, unknown>;
        const interventionText = typeof stage2Parsed.text === 'string' ? stage2Parsed.text : String(stage2Parsed.text ?? '');

        if (interventionText && interventionText.trim().length > 0) {
          activeIntervention = buildIntervention(
            engineValidation, interventionText,
            'Automatic synthesis-phase COMMIT',
            { signal: 'concluding_phase', round },
          );

          callbacks.addEntry({
            type: 'intervention',
            speaker: 'moderator',
            content: interventionText,
            taxonomy_refs: [],
            addressing: engineValidation.validated_target,
            intervention_metadata: {
              family: activeIntervention.family,
              move: activeIntervention.move,
              force: activeIntervention.force,
              burden: activeIntervention.burden,
              target_debater: activeIntervention.target_debater,
              trigger_reason: activeIntervention.trigger_reason,
              source_evidence: activeIntervention.source_evidence,
            },
          });

          callbacks.progress('debate', undefined, `Moderator: COMMIT → ${poverInfo[concludingTarget]?.label}`);
        }
      } catch (err) {
        getGlobalRecorder()?.record({ type: 'ai.error', component: 'orchestration', level: 'warn', message: 'Moderator synthesis COMMIT generation failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
        callbacks.warn('Moderator synthesis COMMIT generation', err, 'Proceeding without COMMIT intervention');
      }
    }
  } else if (await (async () => {
    // ── Policymaker POLICY_CHALLENGE automation ──
    // Count argumentation rounds
    const argRoundCount = (transcript as TranscriptEntry[])
      .filter(e => (e.type === 'statement') && e.metadata?.debate_phase === 'argumentation')
      .length;
    const intentionNodes = (an?.nodes ?? []).filter(n => n.bdi_category === 'intention');
    const policyChallengeTarget = shouldFirePolicyChallenge(
      {
        audience,
        phase,
        argumentationRoundCount: Math.floor(argRoundCount / activePovers.length),
        convergenceSignals: (convergenceSignals ?? []).slice(-3) as { move_polarity: { ratio: number } }[],
        intentionNodes,
      },
      modState,
      activePovers,
    );
    if (policyChallengeTarget) {
      responder = policyChallengeTarget as Exclude<SpeakerId, 'user'>;
      focusPoint = 'Address the implementation specifics: Who writes the regulation? Which agency enforces it? What is the budget? What happens when the first company challenges it in court?';
      addressing = policyChallengeTarget;
      selectionResultObj = {
        responder: policyChallengeTarget,
        addressing: policyChallengeTarget as SpeakerId,
        focus_point: focusPoint,
        agreement_detected: false,
        intervene: true,
        suggested_move: 'POLICY_CHALLENGE' as InterventionMove,
        target_debater: policyChallengeTarget,
        trigger_reasoning: 'Automatic POLICY_CHALLENGE: policymaker audience, high convergence but abstract intention claims',
      };
      engineValidation = validateRecommendation(selectionResultObj as SelectionResult, modState);
      if (engineValidation.proceed) {
        try {
          const stage2Prompt = moderatorInterventionPrompt(
            engineValidation.validated_move,
            engineValidation.validated_family,
            poverInfo[engineValidation.validated_target]?.label ?? engineValidation.validated_target,
            'Automatic policymaker POLICY_CHALLENGE — debaters converging on principles without addressing implementation',
            undefined,
            formatRecentTranscript(transcript as TranscriptEntry[], 4, contextSummaries, { includeTaxonomyRefs: false }),
            audience,
            sourceDocSummary,
            resolution,
            resolutionClauses,
          );
          const stage2Text = await callbacks.generate(
            stage2Prompt, model, { temperature: DEFAULT_TEMPERATURE, timeoutMs: moderatorTimeoutMs(model) },
            `Round ${round}: Moderator POLICY_CHALLENGE → ${poverInfo[policyChallengeTarget]?.label}`,
          );
          const stage2Parsed = parseJsonRobust(stage2Text) as Record<string, unknown>;
          const interventionText = typeof stage2Parsed.text === 'string' ? stage2Parsed.text : String(stage2Parsed.text ?? '');
          if (interventionText && interventionText.trim().length > 0) {
            activeIntervention = buildIntervention(
              engineValidation, interventionText,
              'Automatic policymaker POLICY_CHALLENGE',
              { signal: 'policy_challenge_trigger', round },
            );
            interventionBriefInjection = buildInterventionBriefInjection(
              activeIntervention, poverInfo[responder!]?.label ?? responder!,
            );
            callbacks.addEntry({
              type: 'intervention',
              speaker: 'moderator',
              content: interventionText,
              taxonomy_refs: [],
              addressing: engineValidation.validated_target,
              intervention_metadata: {
                family: activeIntervention.family,
                move: activeIntervention.move,
                force: activeIntervention.force,
                burden: activeIntervention.burden,
                target_debater: activeIntervention.target_debater,
                trigger_reason: activeIntervention.trigger_reason,
                source_evidence: activeIntervention.source_evidence,
              },
            });
            callbacks.progress('debate', undefined, `Moderator: POLICY_CHALLENGE → ${poverInfo[policyChallengeTarget]?.label}`);
          }
        } catch (err) {
          getGlobalRecorder()?.record({ type: 'ai.error', component: 'orchestration', level: 'warn', message: 'Moderator POLICY_CHALLENGE generation failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
          callbacks.warn('Moderator POLICY_CHALLENGE generation', err, 'Proceeding without POLICY_CHALLENGE intervention');
        }
      }
      return true;
    }
    return false;
  })()) {
    // POLICY_CHALLENGE handled above via IIFE
  } else if (await (async () => {
    // ── CRUX_FOCUS automation ──
    const cruxCandidate = input.cruxTracker
      ? detectCruxFocusTrigger(input.cruxTracker, round, modState, activePovers, input.claimTexts)
      : null;
    if (cruxCandidate) {
      try {
        const targetPov = cruxCandidate.speakersInvolved[0] as Exclude<SpeakerId, 'user'>;
        responder = targetPov;
        focusPoint = `Address this unresolved crux directly: ${cruxCandidate.description}`;
        addressing = targetPov;
        selectionResultObj = {
          responder: targetPov,
          addressing: targetPov as SpeakerId,
          focus_point: focusPoint,
          agreement_detected: false,
          intervene: true,
          suggested_move: 'CRUX_FOCUS' as InterventionMove,
          target_debater: targetPov,
          trigger_reasoning: `CRUX_FOCUS: ${cruxCandidate.disagreementType} crux "${cruxCandidate.description}" engaged for ${cruxCandidate.roundsEngaged} rounds without resolution`,
        };
        engineValidation = validateRecommendation(selectionResultObj as SelectionResult, modState);
        if (engineValidation.proceed) {
          const interventionText = buildCruxFocusInterventionText(
            cruxCandidate, poverInfo[targetPov]?.label ?? targetPov,
          );
          activeIntervention = buildIntervention(
            engineValidation, interventionText,
            `CRUX_FOCUS: ${cruxCandidate.disagreementType} crux engaged ${cruxCandidate.roundsEngaged} rounds`,
            { signal: 'crux_focus_trigger', node_id: cruxCandidate.cruxId, round },
          );
          interventionBriefInjection = buildInterventionBriefInjection(
            activeIntervention, poverInfo[responder]?.label ?? responder,
          );
          callbacks.addEntry({
            type: 'intervention',
            speaker: 'moderator',
            content: interventionText,
            taxonomy_refs: [],
            addressing: engineValidation.validated_target,
            intervention_metadata: {
              family: activeIntervention.family,
              move: activeIntervention.move,
              force: activeIntervention.force,
              burden: activeIntervention.burden,
              target_debater: activeIntervention.target_debater,
              trigger_reason: activeIntervention.trigger_reason,
              source_evidence: activeIntervention.source_evidence,
            },
          });
          // Track this crux as focused — fires at most once per crux.
          // getFocusedIds normalizes any {} from pre-fix saved sessions before we push.
          const existingFocused = getFocusedIds(modState);
          if (!existingFocused.includes(cruxCandidate.cruxId)) existingFocused.push(cruxCandidate.cruxId);
          modState.crux_focused_ids = existingFocused;
          callbacks.progress('debate', undefined, `Moderator: CRUX_FOCUS (${cruxCandidate.disagreementType}) → ${poverInfo[targetPov]?.label}`);
        }
        return true;
      } catch (err) {
        getGlobalRecorder()?.record({ type: 'ai.error', component: 'orchestration', level: 'warn', message: 'Moderator CRUX_FOCUS generation failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
        callbacks.warn('Moderator CRUX_FOCUS generation', err, 'Proceeding without CRUX_FOCUS intervention');
        return false;
      }
    }
    return false;
  })()) {
    // CRUX_FOCUS handled above via IIFE
  } else {
    // ── Stage 1: Enhanced moderator selection ──
    const topicAnchoringBlock = buildTopicAnchoringBlock(resolution, resolutionClauses, topicDriftState);
    selectionPrompt = moderatorSelectionPrompt(
      recentTranscript, activeLabels,
      edgeContext + anContext + qbafContext + ledgerHint + specifyHint + gapHint,
      triggerBlock,
      recentScheme ?? undefined, metaphorReframe, phase, audience,
      sourceDocSummary,
      topicAnchoringBlock,
      moderatorMode,
    );

    const selectionStart = Date.now();
    selectionText = await callbacks.generate(
      selectionPrompt, model, { temperature: DEFAULT_TEMPERATURE, timeoutMs: moderatorTimeoutMs(model) },
      `Round ${round}: Moderator selection`,
    );
    selectionElapsed = Date.now() - selectionStart;

    if (callbacks.isAborted?.()) {
      getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'orchestration', level: 'info', message: `Round ${round}: Moderator selection aborted after generate` });
      return buildEarlyReturn(modState, healthScore, activePovers[0], poverInfo);
    }

    try {
      const parsed = parseJsonRobust(selectionText) as Record<string, unknown>;
      const labelMap: Record<string, Exclude<SpeakerId, 'user'>> = {};
      for (const p of activePovers) {
        labelMap[p] = p;
        labelMap[poverInfo[p].label.toLowerCase()] = p;
        labelMap[poverInfo[p].label] = p;
      }
      responder = labelMap[String(parsed.responder ?? '').toLowerCase()] ?? null;
      focusPoint = (parsed.focus_point as string) ?? focusPoint;
      addressing = (parsed.addressing as string) ?? 'general';
      agreementDetected = !!parsed.agreement_detected;

      // Deterministic agreement gate: override LLM when structural conditions aren't met.
      // Concession on a sub-point != full position convergence.
      if (agreementDetected) {
        const MIN_ROUNDS_FOR_AGREEMENT = 4;
        const statementsCount = (transcript as TranscriptEntry[])
          .filter(e => e.type === 'statement').length;
        const roundsCompleted = Math.floor(statementsCount / Math.max(1, activePovers.length));

        // Gate 1: too early — positions aren't developed enough for genuine convergence
        if (roundsCompleted < MIN_ROUNDS_FOR_AGREEMENT) {
          agreementDetected = false;
          getGlobalRecorder()?.record({ type: 'debate.moderate', component: 'agreement-gate', level: 'info', message: `Agreement overridden: too early (round ${roundsCompleted} < ${MIN_ROUNDS_FOR_AGREEMENT})` });
        }

        // Gate 2: phase guard — agreement only valid during concluding phase
        if (agreementDetected && phase !== 'concluding') {
          agreementDetected = false;
          getGlobalRecorder()?.record({ type: 'debate.moderate', component: 'agreement-gate', level: 'info', message: `Agreement overridden: phase is '${phase}', not 'concluding'` });
        }

        // Gate 3: commitment-store check — require concessions from 2+ debaters
        if (agreementDetected && commitments) {
          const poversWithConcessions = activePovers.filter(p => {
            const c = commitments[p];
            return c && Array.isArray(c.conceded) && c.conceded.length > 0;
          });
          if (poversWithConcessions.length < 2) {
            agreementDetected = false;
            getGlobalRecorder()?.record({ type: 'debate.moderate', component: 'agreement-gate', level: 'info', message: `Agreement overridden: only ${poversWithConcessions.length} debater(s) have conceded (need 2+)` });
          }
        }

        // Gate 4: unanswered claims — can't agree while questions are outstanding
        if (agreementDetected && unansweredLedger && unansweredLedger.length > 0) {
          const outstanding = unansweredLedger.filter(u => u.addressed_round == null);
          if (outstanding.length > 0) {
            agreementDetected = false;
            getGlobalRecorder()?.record({ type: 'debate.moderate', component: 'agreement-gate', level: 'info', message: `Agreement overridden: ${outstanding.length} unanswered claim(s) outstanding` });
          }
        }
      }

      selectionResultObj = {
        responder: responder ?? activePovers[0],
        addressing: (addressing as SpeakerId | 'general') ?? 'general',
        focus_point: focusPoint,
        agreement_detected: agreementDetected,
        drift_detected: !!parsed.drift_detected,
        intervene: !!parsed.intervene,
        suggested_move: parsed.suggested_move as InterventionMove | undefined,
        target_debater: labelMap[String(parsed.target_debater ?? '').toLowerCase()] ?? undefined,
        trigger_reasoning: parsed.trigger_reasoning as string | undefined,
        trigger_evidence: parsed.trigger_evidence as SelectionResult['trigger_evidence'] | undefined,
        dialectical_diagnostic: (moderatorMode === 'talmudic' || moderatorMode === 'socratic')
          ? parseDialecticalDiagnostic(parsed.dialectical_diagnostic, focusPoint)
          : undefined,
      };

      if (agreementDetected) {
        callbacks.addEntry({
          type: 'system',
          speaker: 'system',
          content: `[Round ${round}] Moderator detected broad agreement. ${focusPoint ? `Focus: ${focusPoint}` : ''}`,
          taxonomy_refs: [],
        });

        updateModeratorState(modState, undefined, {
          proceed: false,
          validated_move: selectionResultObj.suggested_move ?? ('PIN' as InterventionMove),
          validated_family: 'elicitation',
          validated_target: responder ?? activePovers[0],
        }, round, phase);

        return {
          responder: responder ?? activePovers[0],
          focusPoint,
          addressing,
          agreementDetected: true,
          selectionResult: selectionResultObj,
          interventionBriefInjection: '',
          modState,
          healthScore,
          diagnostics: {
            selectionPrompt, selectionResponse: selectionText, selectionElapsed,
            edgeContextLength: edgeContext.length, anContextLength: anContext.length,
            qbafContextLength: qbafContext.length, edgesUsed,
            recentScheme, metaphorReframeOffered: metaphorReframe?.source ?? null,
          },
          earlyReturn: true,
        };
      }

      // ── Engine floor + dormancy check (t/3513) — see moderatorEngineTriggers.ts ──
      selectionResultObj = applyEngineFloor(selectionResultObj, {
        round, phase, moderatorMode, dialecticalStyle: input.dialecticalStyle,
        responder: selectionResultObj.responder ?? activePovers[0],
        convergenceSignals: convergenceSignals ?? [], unansweredLedger: unansweredLedger ?? [],
        modState, labelOf: id => poverInfo[id]?.label ?? id,
      });
      checkModeratorDormancy(modState, phase);

      // ── Engine validation (deterministic) ──
      if (selectionResultObj.intervene) {
        engineValidation = validateRecommendation(selectionResultObj as SelectionResult, modState);
        if (engineValidation.proceed) recordEnginePin(selectionResultObj, modState);

        if (engineValidation.proceed) {
          try {
            const stage2Prompt = moderatorInterventionPrompt(
              engineValidation.validated_move,
              engineValidation.validated_family,
              poverInfo[engineValidation.validated_target]?.label ?? engineValidation.validated_target,
              selectionResultObj.trigger_reasoning ?? '',
              selectionResultObj.trigger_evidence?.source_claim,
              formatRecentTranscript(transcript as TranscriptEntry[], 4, contextSummaries, { includeTaxonomyRefs: false }),
              audience,
              sourceDocSummary,
              resolution,
              resolutionClauses,
            );

            const stage2Text = await callbacks.generate(
              stage2Prompt, model, { temperature: DEFAULT_TEMPERATURE, timeoutMs: moderatorTimeoutMs(model) },
              `Round ${round}: Moderator intervention (${engineValidation.validated_move})`,
            );

            if (callbacks.isAborted?.()) {
              getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'orchestration', level: 'info', message: `Round ${round}: Moderator intervention aborted after generate` });
              return buildEarlyReturn(modState, healthScore, activePovers[0], poverInfo);
            }

            const stage2Parsed = parseJsonRobust(stage2Text) as Record<string, unknown>;
            let interventionText = typeof stage2Parsed.text === 'string' ? stage2Parsed.text : String(stage2Parsed.text ?? stage2Text);
            let effectiveValidation = engineValidation;

            // REVOICE propositional gate: validate that revoiced text preserves
            // propositional content before allowing the intervention through.
            if (engineValidation.validated_move === 'REVOICE' && interventionText?.trim()) {
              const originalClaimText = typeof stage2Parsed.original_claim_text === 'string' ? stage2Parsed.original_claim_text : '';
              if (originalClaimText && callbacks.computeEmbedding && input.nodeEmbeddings) {
                try {
                  const [origVec, revoicedVec] = await Promise.all([
                    callbacks.computeEmbedding(originalClaimText.slice(0, 300)),
                    callbacks.computeEmbedding(interventionText.slice(0, 300)),
                  ]);
                  const gateResult = runPropositionalGate({
                    originalText: originalClaimText,
                    revoicedText: interventionText,
                    originalEmbedding: origVec,
                    revoicedEmbedding: revoicedVec,
                    taxonomyEmbeddings: input.nodeEmbeddings,
                    anNodes: an?.nodes ?? [],
                    currentRound: round,
                  });
                  getGlobalRecorder()?.record({
                    type: 'debate.moderate', component: 'revoice-gate', level: 'info',
                    message: `REVOICE gate ${gateResult.passed ? 'passed' : 'failed'}: anchor=${gateResult.anchor_source}, overlap=${gateResult.taxonomy_overlap.overlap_count}/3`,
                    data: gateResult,
                  });
                  if (!gateResult.passed) {
                    // Downgrade to CHECK: "I want to make sure I understand your point..."
                    effectiveValidation = {
                      ...engineValidation,
                      validated_move: 'CHECK' as InterventionMove,
                      validated_family: 'repair' as import('./types.js').InterventionFamily,
                    };
                    interventionText = `I want to make sure I understand your point — ${originalClaimText}`;
                    callbacks.progress('debate', undefined,
                      `Moderator: REVOICE gate failed (${gateResult.entity_preservation.missing_entities.concat(gateResult.entity_preservation.missing_thresholds).join(', ') || 'anchor mismatch'}), downgrading to CHECK`);
                  }
                } catch (gateErr) {
                  getGlobalRecorder()?.record({ type: 'ai.error', component: 'revoice-gate', level: 'warn', message: 'REVOICE gate failed — proceeding without gate', error: { name: (gateErr as Error).name ?? 'Error', message: String(gateErr), stack: (gateErr as Error).stack } });
                }
              }
            }

            if (interventionText && interventionText.trim().length > 0) {
              activeIntervention = buildIntervention(
                effectiveValidation, interventionText,
                selectionResultObj.trigger_reasoning ?? 'Engine-validated intervention',
                {
                  signal: selectionResultObj.trigger_evidence?.signal_name,
                  claim: selectionResultObj.trigger_evidence?.source_claim,
                  round: selectionResultObj.trigger_evidence?.source_round ?? undefined,
                },
                stage2Parsed.original_claim_text as string | undefined,
              );

              responder = engineValidation.validated_target as Exclude<SpeakerId, 'user'>;

              interventionBriefInjection = buildInterventionBriefInjection(
                activeIntervention, poverInfo[responder]?.label ?? responder,
              );

              const interventionMeta: InterventionMetadata = {
                family: activeIntervention.family,
                move: activeIntervention.move,
                force: activeIntervention.force,
                burden: activeIntervention.burden,
                target_debater: activeIntervention.target_debater,
                trigger_reason: activeIntervention.trigger_reason,
                source_evidence: activeIntervention.source_evidence,
                prerequisite_applied: activeIntervention.prerequisite_applied,
                original_claim_text: activeIntervention.original_claim_text,
              };

              callbacks.addEntry({
                type: 'intervention',
                speaker: 'moderator',
                content: interventionText,
                taxonomy_refs: [],
                addressing: activeIntervention.target_debater as SpeakerId,
                intervention_metadata: interventionMeta,
              });

              callbacks.progress('debate', undefined,
                `Moderator: ${activeIntervention.move} → ${poverInfo[responder]?.label}`);
            }
          } catch (stage2Err) {
            getGlobalRecorder()?.record({ type: 'ai.error', component: 'orchestration', level: 'warn', message: 'Moderator Stage 2 intervention generation failed', error: { name: (stage2Err as Error).name ?? 'Error', message: String(stage2Err), stack: (stage2Err as Error).stack } });
            callbacks.warn('Moderator Stage 2 generation', stage2Err, 'Proceeding without intervention');
          }
        }
      }
    } catch (err) {
      selectionParseError = err;
      getGlobalRecorder()?.record({ type: 'system.error', component: 'orchestration', level: 'warn', message: 'Moderator selection parse failed — falling back to least-recently-spoken', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      callbacks.warn('Parsing moderator selection', err, 'Falling back to least-recently-spoken debater');
    }
  }

  // Enforce turn alternation: never select the last speaker
  const lastSpeakerEntry = [...transcript].reverse().find(
    (e) => (e.type === 'statement' || e.type === 'opening') && e.speaker !== 'user' && e.speaker !== 'system' && e.speaker !== 'moderator',
  );
  const lastSpeaker = lastSpeakerEntry?.speaker as Exclude<SpeakerId, 'user'> | undefined;

  // Participation floor: force-select any speaker below 50% of mean turn count after round 3
  if (round >= 3 && !activeIntervention) {
    const counts = activePovers.map(p => turnCounts[p] ?? 0);
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const threshold = Math.max(1, Math.floor(mean * 0.5));
    const underrepresented = activePovers
      .filter(p => (turnCounts[p] ?? 0) < threshold && p !== lastSpeaker);
    if (underrepresented.length > 0) {
      responder = underrepresented[0] as Exclude<SpeakerId, 'user'>;
    }
  }

  if (!responder || !activePovers.includes(responder) || (responder === lastSpeaker && !activeIntervention)) {
    const alternatives = activePovers.filter(p => p !== lastSpeaker);
    if (alternatives.length > 0) {
      // Pick least-recently-spoken
      const lastSpoke = new Map<string, number>();
      transcript.forEach((e, i) => {
        if (e.speaker !== 'user' && e.speaker !== 'system' && e.speaker !== 'moderator') lastSpoke.set(e.speaker, i);
      });
      responder = alternatives.reduce((best, p) =>
        (lastSpoke.get(p) ?? -1) < (lastSpoke.get(best) ?? -1) ? p : best,
      );
    } else {
      responder = activePovers[0];
    }
  }

  return {
    responder,
    focusPoint,
    addressing,
    agreementDetected,
    selectionResult: selectionResultObj,
    intervention: activeIntervention,
    engineValidation,
    interventionBriefInjection,
    modState,
    healthScore,
    diagnostics: {
      selectionPrompt, selectionResponse: selectionText, selectionElapsed,
      edgeContextLength: edgeContext.length, anContextLength: anContext.length,
      qbafContextLength: qbafContext.length, edgesUsed,
      recentScheme, metaphorReframeOffered: metaphorReframe?.source ?? null,
    },
    selectionParseError,
    earlyReturn: false,
  };
}

function buildEarlyReturn(
  modState: ModeratorState,
  healthScore: DebateHealthScore,
  fallbackResponder: Exclude<SpeakerId, 'user'>,
  _poverInfo: Record<string, { label: string }>,
): ModeratorSelectionResult {
  return {
    responder: fallbackResponder,
    focusPoint: '',
    addressing: 'general',
    agreementDetected: false,
    selectionResult: {},
    interventionBriefInjection: '',
    modState,
    healthScore,
    diagnostics: {
      selectionPrompt: '', selectionResponse: '', selectionElapsed: 0,
      edgeContextLength: 0, anContextLength: 0, qbafContextLength: 0,
    },
    earlyReturn: true,
  };
}


// ══════════════════════════════════════════════════════════
// Stage 2: Turn execution with validation retry loop
// ══════════════════════════════════════════════════════════

export interface TurnRetryCallbacks {
  runPipeline: (input: TurnPipelineInput) => Promise<TurnPipelineResult>;
  assembleResult: (result: TurnPipelineResult) => { statement: string; taxonomyRefs: TaxonomyRef[]; meta: PoverResponseMeta };
  callJudge: (prompt: string, label: string) => Promise<string>;
  callJudgeFallback?: (prompt: string, label: string) => Promise<string>;
  isAborted?: () => boolean;
}

export interface TurnRetryInput {
  pipelineInput: TurnPipelineInput;
  validationConfig?: TurnValidationConfig;
  model: string;
  speaker: SpeakerId;
  round: number;
  priorTurns: TranscriptEntry[];
  recentTurns: TranscriptEntry[];
  knownNodeIds: ReadonlySet<string>;
  policyIds: ReadonlySet<string>;
  audience?: DebateAudience;
  pendingIntervention?: ModeratorIntervention;
}

export interface TurnRetryResult {
  statement: string;
  taxonomyRefs: TaxonomyRef[];
  meta: PoverResponseMeta;
  validation: TurnValidation;
  attempts: TurnAttempt[];
  pipelineResult: TurnPipelineResult;
  aborted: boolean;
}

export async function executeTurnWithRetry(
  input: TurnRetryInput,
  callbacks: TurnRetryCallbacks,
): Promise<TurnRetryResult> {
  console.log(`[orchestration] *** executeTurnWithRetry ENTERED for ${input.speaker} round ${input.round} ***`);
  const vConfig = resolveTurnValidationConfig(input.validationConfig);
  const attempts: TurnAttempt[] = [];
  let attemptIdx = 0;
  // Track best attempt by score to avoid regression on retry
  let bestScore = -1;
  let bestStatement = '';
  let bestTaxonomyRefs: typeof taxonomyRefs = [];
  let bestMeta: typeof meta = {} as typeof meta;
  let bestValidation: TurnValidation | null = null;
  let bestPipelineResult: typeof pipelineResult | null = null;

  // Pipeline can throw on JSON parse failures (e.g., Brief stage malformed JSON).
  // Retry up to maxRetries times before propagating the error.
  let pipelineResult: Awaited<ReturnType<typeof callbacks.runPipeline>>;
  let pipelineError: Error | null = null;
  for (let pipelineAttempt = 0; pipelineAttempt <= vConfig.maxRetries; pipelineAttempt++) {
    try {
      pipelineResult = await callbacks.runPipeline(input.pipelineInput);
      pipelineError = null;
      break;
    } catch (err) {
      pipelineError = err instanceof Error ? err : new Error(String(err));
      getGlobalRecorder()?.record({ type: 'system.error', component: 'orchestration', level: 'warn', message: `Pipeline attempt ${pipelineAttempt + 1} failed`, error: { name: pipelineError.name, message: pipelineError.message, stack: pipelineError.stack } });
      if ((err as { limitType?: string })?.limitType === 'tokens_per_day') break;
      if (pipelineAttempt < vConfig.maxRetries) {
        console.warn(`[orchestration] Pipeline attempt ${pipelineAttempt + 1} failed: ${pipelineError.message.slice(0, 100)}. Retrying...`);
      }
    }
  }
  if (pipelineError || !pipelineResult!) {
    throw pipelineError ?? new Error('Pipeline failed after retries');
  }

  if (callbacks.isAborted?.()) {
    const a = callbacks.assembleResult(pipelineResult);
    return { ...a, validation: SKIPPED_VALIDATION, attempts: [], pipelineResult, aborted: true };
  }

  let assembled = callbacks.assembleResult(pipelineResult);
  let { statement, taxonomyRefs, meta } = assembled;
  let validation: TurnValidation;

  let currentInputHints: string[] | undefined; // hints that triggered the current attempt

  for (; ;) {
    // Check if citation bank validation passed (no warnings after scrub)
    const draftDiagForCitation = pipelineResult.stage_diagnostics.find(s => s.stage === 'draft');
    const citationRes = (draftDiagForCitation as Record<string, unknown> | undefined)?.citation_resolution as
      { bank_size?: number; warnings?: string[] } | undefined;
    const citationBankValidated = citationRes != null
      && citationRes.bank_size != null && citationRes.bank_size > 0
      && (citationRes.warnings?.length ?? 0) === 0;

    // Extract evidence context so the judge knows what evidence was available
    const evidenceDiagForJudge = pipelineResult.stage_diagnostics.find(s => s.stage === 'evidence');
    const evidenceWpForJudge = evidenceDiagForJudge?.work_product as Record<string, unknown> | undefined;
    let evidenceContext: string | undefined;
    if (evidenceWpForJudge) {
      const facts = (evidenceWpForJudge.facts as Array<{ claim?: string; doc_id?: string }>) ?? [];
      const kps = (evidenceWpForJudge.keyPoints as Array<{ point?: string; doc_id?: string }>) ?? [];
      if (facts.length > 0 || kps.length > 0) {
        const lines: string[] = [];
        for (const f of facts) lines.push(`- Fact: "${f.claim?.slice(0, 100)}" (${f.doc_id})`);
        for (const kp of kps) lines.push(`- Key point: "${kp.point?.slice(0, 100)}" (${kp.doc_id})`);
        evidenceContext = lines.join('\n');
      }
    }

    validation = await validateTurn({
      statement, taxonomyRefs, meta,
      phase: input.pipelineInput.phase,
      speaker: input.speaker,
      round: input.round,
      priorTurns: input.priorTurns,
      recentTurns: input.recentTurns,
      knownNodeIds: input.knownNodeIds,
      policyIds: input.policyIds,
      audience: input.audience,
      config: vConfig,
      callJudge: callbacks.callJudge,
      callJudgeFallback: callbacks.callJudgeFallback,
      pendingIntervention: input.pendingIntervention,
      citationBankValidated,
      evidenceContext,
    });

    const draftDiag = pipelineResult.stage_diagnostics.find(s => s.stage === 'draft');

    // Analyze hint effectiveness for retry attempts (compare against previous attempt)
    let hintEffectiveness: HintEffectiveness[] | undefined;
    if (attemptIdx > 0 && attempts.length > 0) {
      const prevAttempt = attempts[attempts.length - 1];
      const prevHints = prevAttempt.validation.repairHints ?? [];
      const prevStatement = prevAttempt.raw_response ?? '';
      const prevScore = prevAttempt.validation.process_reward ?? 0;
      const currentScore2 = validation.process_reward ?? 0;
      if (prevHints.length > 0) {
        hintEffectiveness = analyzeHintEffectiveness(
          prevHints, prevStatement, draftDiag?.raw_response ?? '',
          prevScore, currentScore2, prevAttempt.validation,
        );
        const fixed = hintEffectiveness.filter(h => h.resolution === 'fixed').length;
        const ignored = hintEffectiveness.filter(h => h.resolution === 'ignored').length;
        const worse = hintEffectiveness.filter(h => h.resolution === 'made_worse').length;
        console.log(`[orchestration] Hint effectiveness: ${fixed} fixed, ${ignored} ignored, ${worse} worse out of ${hintEffectiveness.length} hints`);
      }
    }

    attempts.push({
      attempt: attemptIdx,
      model: input.model,
      prompt_delta: '',
      raw_response: draftDiag?.raw_response ?? '',
      response_time_ms: pipelineResult.total_time_ms,
      validation,
      stage_diagnostics: pipelineResult.stage_diagnostics,
      hint_effectiveness: hintEffectiveness,
      input_repair_hints: currentInputHints,
    });

    // Track best attempt — retries can regress if the LLM introduces new problems.
    // The score field on TurnValidation is `process_reward`; the previous
    // `orchestrationScore` lookup silently returned undefined and left bestScore
    // permanently at -1, defeating best-of-N selection.
    const currentScore = validation.process_reward ?? 0;
    if (currentScore > bestScore) {
      bestScore = currentScore;
      bestStatement = statement;
      bestTaxonomyRefs = taxonomyRefs;
      bestMeta = meta;
      bestValidation = validation;
      bestPipelineResult = pipelineResult;
    }

    // Filter hints to those a debater can plausibly act on. Hints that demand
    // empirical evidence the corpus is unlikely to contain (cost-benefit data,
    // retrospective program-evaluation, feasibility studies) cause whack-a-mole
    // retries — the LLM swaps one unsourced claim for another with the same
    // gap. Filter those out of the retry gate; they remain on the displayed
    // validation.repairHints for transparency.
    const actionableHints = filterActionableHints(validation.repairHints ?? []);
    const hasActionableFeedback = actionableHints.length > 0;
    // Retry only when the score-based outcome says so — not on any feedback.
    // Data from 12-turn analysis showed retries improve only 8% of turns;
    // 92% of the time attempt 0 was the best. The "any feedback → retry" rule
    // caused 35 wasted pipeline runs in a single debate.
    const shouldRetry = validation.outcome === 'retry' && hasActionableFeedback;

    getGlobalRecorder()?.record({
      type: 'turn.orchestration.retry_decision', component: 'orchestration', level: 'info',
      message: `Retry decision: ${shouldRetry ? 'RETRY' : 'ACCEPT'} (attempt=${attemptIdx}, score=${currentScore.toFixed(3)}, judge=${validation.judge_quality_score?.toFixed(2) ?? 'n/a'}, trigger=${validation.retry_trigger})`,
      data: {
        attempt: attemptIdx,
        process_reward: currentScore,
        best_score: bestScore,
        stageA_score: validation.stageA_score,
        judge_quality_score: validation.judge_quality_score,
        judge_recommend: validation.judge_recommend,
        score_threshold: validation.score_threshold,
        retry_trigger: validation.retry_trigger,
        outcome: validation.outcome,
        should_retry: shouldRetry,
        max_retries: vConfig.maxRetries,
        total_hints: validation.repairHints?.length ?? 0,
        actionable_hints: actionableHints.length,
        hint_texts: actionableHints.slice(0, 3),
      },
    });

    if (!shouldRetry || attemptIdx >= vConfig.maxRetries) break;

    attemptIdx += 1;
    currentInputHints = [...actionableHints];
    try {
      // Determine which stages can be frozen based on hint targets.
      // If all actionable hints target cite, freeze Brief + Plan + Draft.
      // Otherwise, freeze Brief + Plan, re-run Draft + Cite.
      // Only pass hints for stages that will actually re-run — prevents
      // stale draft corrections from leaking into cite-only retries.
      const citeHints = actionableHints.filter(h => classifyHintTarget(h) === 'cite');
      const draftHints = actionableHints.filter(h => classifyHintTarget(h) !== 'cite');
      const isCiteOnly = draftHints.length === 0;

      // Preserve micro-fixed drafts across retries (t/316): when a micro-fix
      // succeeded and the retry is NOT triggered by draft-structural hints,
      // freeze the draft so the retry only re-runs cite.
      const hadSuccessfulMicroFix = pipelineResult.stage_diagnostics.some(
        d => d.stage === 'micro-fix' && (d.work_product as Record<string, unknown>)?.success === true,
      );
      const hasRealDraftHints = actionableHints.some(h => classifyHintTarget(h) === 'draft');
      const preserveMicroFix = hadSuccessfulMicroFix && !hasRealDraftHints;
      const freezeDraft = isCiteOnly || preserveMicroFix;

      if (preserveMicroFix) {
        getGlobalRecorder()?.record({
          type: 'turn.micro-fix-preserved', component: 'orchestration', level: 'info',
          message: 'Preserving micro-fixed draft across outer retry — retry trigger is not draft-structural',
          data: { attempt: attemptIdx, hint_targets: actionableHints.map(h => classifyHintTarget(h)) },
        });
      }

      // Save diagnostics for frozen stages — the retry pipeline skips them,
      // so their entries would otherwise be lost from stage_diagnostics.
      const frozenStageIds = new Set<string>(['brief', 'plan', 'evidence', 'micro-fix']);
      if (freezeDraft) frozenStageIds.add('draft');
      const carriedDiags = pipelineResult.stage_diagnostics.filter(
        s => frozenStageIds.has(s.stage),
      );
      pipelineResult = await callbacks.runPipeline({
        ...input.pipelineInput,
        repairHints: freezeDraft ? citeHints : actionableHints,
        frozenBrief: pipelineResult.brief,
        frozenPlan: pipelineResult.plan,
        frozenDraft: freezeDraft ? pipelineResult.draft : undefined,
        frozenEvidenceBlock: pipelineResult.evidenceBlock,
      });
      // Carry forward frozen stage diagnostics so the full pipeline trace is preserved
      pipelineResult.stage_diagnostics = [...carriedDiags, ...pipelineResult.stage_diagnostics];
    } catch (err) {
      // Pipeline parse failure on retry — treat as failed attempt, break with current validation
      getGlobalRecorder()?.record({ type: 'system.error', component: 'orchestration', level: 'warn', message: `Pipeline retry ${attemptIdx} failed`, error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      console.warn(`[orchestration] Pipeline retry ${attemptIdx} failed: ${err instanceof Error ? err.message.slice(0, 100) : err}`);
      break;
    }
    if (callbacks.isAborted?.()) {
      getGlobalRecorder()?.record({ type: 'debate.lifecycle', component: 'orchestration', level: 'info', message: `Turn retry loop aborted after attempt ${attemptIdx}` });
      return { statement, taxonomyRefs, meta, validation, attempts, pipelineResult, aborted: true };
    }
    assembled = callbacks.assembleResult(pipelineResult);
    ({ statement, taxonomyRefs, meta } = assembled);
  }

  // Use the best-scoring attempt, not the last one — retries can regress
  if (bestValidation && bestScore > (validation.process_reward ?? 0)) {
    console.log(`[orchestration] Using best attempt (score ${bestScore.toFixed(2)}) instead of last attempt (score ${(validation.process_reward ?? 0).toFixed(2)})`);
    return { statement: bestStatement, taxonomyRefs: bestTaxonomyRefs, meta: bestMeta, validation: bestValidation, attempts, pipelineResult: bestPipelineResult ?? pipelineResult, aborted: false };
  }
  return { statement, taxonomyRefs, meta, validation, attempts, pipelineResult, aborted: false };
}

/** Patterns identifying hints the debater cannot plausibly act on with the
 *  available evidence corpus. These typically demand empirical research the
 *  debater can't manufacture — cost-benefit data, retrospective program
 *  evaluations, technical feasibility studies, false-positive rates. Keep this
 *  list conservative: false positives (filtering an actually-actionable hint)
 *  are worse than false negatives (running an extra retry). */
const UNANSWERABLE_HINT_PATTERNS: RegExp[] = [
  /lacks?\s+(?:empirical\s+)?(?:evidence|case\s+stud|data|example|demonstrat)/i,
  /no\s+(?:empirical\s+)?(?:data|evidence)\s+(?:that|on|for|supporting)/i,
  /no\s+analysis\s+of\s+whether.*(?:achieved|reached|delivered)/i,
  /(?:false[- ]positive|false[- ]negative)\s+rates?/i,
  /(?:no\s+)?cost[- ]benefit\s+(?:data|analysis|evidence)/i,
  /scale\s+economics/i,
  /technical(?:ly)?\s+(?:vague|feasibility)\b.*\bwithout\s+(?:degrading|sacrificing|breaking)/i,
  /unclear\s+how.*without\s+degrading/i,
  /precedent\s+(?:validity|effectiveness)\s+unsubstantiated/i,
  // Citation bank-miss warnings — the scrub already handled these; retrying won't help.
  /not (?:found )?in (?:the )?(?:verified|citation) (?:sources|bank)/i,
  /ArXiv ID not in citation bank/i,
  /URL not in citation bank/i,
  /likely fabricated/i,
  /(?:fabricated|unverifiable)\s+(?:citation|reference|source)/i,
  /missing citation/i,
];

function filterActionableHints(hints: string[]): string[] {
  return hints.filter(h => {
    // Remove unanswerable hints (evidence the corpus doesn't have)
    if (UNANSWERABLE_HINT_PATTERNS.some(re => re.test(h))) return false;
    // Remove cite-targeted hints — they're actionable but by the cite stage, not draft.
    // Sending them to the draft retry wastes a retry attempt on something the draft can't fix.
    if (CITE_HINT_PATTERN.test(h)) return false;
    return true;
  });
}

/** Cite-specific hint pattern — matches hints targeting taxonomy_refs, policy_refs,
 *  relevance quality, and grounding_confidence (all addressed by the Cite stage). */
const CITE_HINT_PATTERN = /taxonomy_refs.*(?:filler|too-short|relevance)|No new taxonomy_refs|Unknown taxonomy node|Unknown policy_refs|grounding_confidence/i;

/** Classify which pipeline stage a repair hint targets.
 *  Used by orchestration retry to determine which stages can be frozen. */
function classifyHintTarget(hint: string): 'cite' | 'draft' | 'judge' {
  if (CITE_HINT_PATTERN.test(hint)) return 'cite';
  // Judge-internal hints (score calibration, parse issues) aren't actionable by any stage
  if (/judge.*(?:parse|fail|error)|process_reward/i.test(hint)) return 'judge';
  return 'draft';
}

// ── Hint effectiveness analysis ──────────────────────────

/** Classify hint specificity based on text patterns. */
function classifySpecificity(hint: string): HintSpecificity {
  // Concrete: references a specific fragment, quotes text, names a specific fix
  if (/['"][^'"]{5,}['"]/.test(hint) || /cut off|truncat|missing|malformed|empty/.test(hint)) {
    return 'concrete';
  }
  // Structural: asks questions, identifies gaps that need judgment
  if (/\?|who\s|what\s|how\s|where\s|undefined|unspecified|lacks\s/.test(hint)) {
    return 'structural';
  }
  // Evaluative: states weakness without specific fix
  return 'evaluative';
}

/** Classify hint source based on position in the repairHints array and content. */
function classifySource(hint: string, errorIssues: string[], warningIssues: string[]): HintSource {
  if (errorIssues.includes(hint)) return 'validation_error';
  if (warningIssues.includes(hint)) return 'validation_warning';
  return 'judge_weakness';
}

/** Extract a quoted or referenced text fragment from a hint. */
function extractCitedFragment(hint: string): string | undefined {
  // Match quoted text: 'fragment' or "fragment"
  const quoted = hint.match(/['"]([^'"]{5,})['"]/);
  if (quoted) return quoted[1];
  // Match after colon: "Incomplete citation: 'evocation hazards'..."
  const afterColon = hint.match(/:\s*['"]?([A-Z][^.;]{10,})/);
  if (afterColon) return afterColon[1].trim();
  return undefined;
}

/** Extract hint category from prefix (QUALITY, DRAFT, STRUCTURAL, etc.). */
function extractCategory(hint: string): string {
  // Hints from the judge are typically prefixed by the pipeline
  if (/^\[?DRAFT\]?/i.test(hint)) return 'DRAFT';
  if (/^\[?QUALITY\]?/i.test(hint)) return 'QUALITY';
  if (/^\[?STRUCTURAL\]?/i.test(hint)) return 'STRUCTURAL';
  if (/paragraph|hedge|duplication/i.test(hint)) return 'DRAFT';
  if (/node|taxonomy|grounding/i.test(hint)) return 'STRUCTURAL';
  return 'QUALITY';
}

/**
 * Analyze the effectiveness of repair hints by comparing pre-retry and post-retry statements.
 * Called after each retry to assess whether the hints were addressed.
 */
function analyzeHintEffectiveness(
  hints: string[],
  preStatement: string,
  postStatement: string,
  preScore: number,
  postScore: number,
  preValidation: TurnValidation,
): HintEffectiveness[] {
  const preErrors = preValidation.dimensions.schema.issues.concat(
    preValidation.dimensions.grounding.issues,
  );
  const preWarnings: string[] = []; // warnings are mixed into repairHints

  return hints.map(hint => {
    const specificity = classifySpecificity(hint);
    const source = classifySource(hint, preErrors, preWarnings);
    const category = extractCategory(hint);
    const citedFragment = extractCitedFragment(hint);

    // Check if the cited fragment still appears in the retry
    let fragmentPersists: boolean | undefined;
    if (citedFragment) {
      const fragLower = citedFragment.toLowerCase();
      fragmentPersists = postStatement.toLowerCase().includes(fragLower);
    }

    // Determine resolution
    let resolution: HintEffectiveness['resolution'] = 'pending';
    const scoreDelta = postScore - preScore;

    if (citedFragment && fragmentPersists === false) {
      // The specific problem text was removed — likely fixed
      resolution = scoreDelta >= 0 ? 'fixed' : 'partially_fixed';
    } else if (citedFragment && fragmentPersists === true) {
      // Same text still there
      resolution = scoreDelta < -0.05 ? 'made_worse' : 'ignored';
    } else {
      // No fragment to check — use score heuristic
      if (scoreDelta > 0.05) resolution = 'fixed';
      else if (scoreDelta > -0.02) resolution = 'partially_fixed';
      else if (scoreDelta < -0.05) resolution = 'made_worse';
      else resolution = 'ignored';
    }

    return {
      hint_text: hint,
      category,
      source,
      specificity,
      resolution,
      cited_fragment: citedFragment,
      fragment_persists: fragmentPersists,
      pre_score: Math.round(preScore * 100) / 100,
      post_score: Math.round(postScore * 100) / 100,
      score_delta: Math.round(scoreDelta * 100) / 100,
    };
  });
}

const SKIPPED_VALIDATION: TurnValidation = {
  outcome: 'skipped',
  process_reward: 1,
  dimensions: {
    schema: { pass: true, issues: [] },
    grounding: { pass: true, issues: [] },
    advancement: { pass: true, signals: [] },
    clarifies: { pass: true, signals: [] },
  },
  repairHints: [],
  clarifies_taxonomy: [],
  judge_used: false,
};
