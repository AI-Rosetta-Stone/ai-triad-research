// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.
/**
 * Pure debate orchestration engine — no UI, Zustand, or Electron dependencies.
 * Runs a full structured debate using the AIAdapter interface.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { AIAdapter, ExtendedAIAdapter } from './aiAdapter.js';
import type { LoadedTaxonomy } from './taxonomyLoader.js';
import type {
  DebateSession,
  DebateSourceType,
  SpeakerId,
  TranscriptEntry,
  TaxonomyRef,
  ContextSummary,
  ArgumentNetworkNode,
  ArgumentNetworkEdge,
  CommitmentStore,
  EntryDiagnostics,
  DebateDiagnostics,
  DebatePhase,
  ClaimExtractionTrace,
  ExtractionSummary,
  GapArgument,
  CrossCuttingProposal,
  PhaseTransitionConfig,
  PhaseState,
  PhaseContext,
  SignalContext,
  Signal,
  PredicateResult,
  AdaptiveStagingDiagnostics,
  DebatePacing,
  ConvergenceSignals as ConvergenceSignalsType,
  ProcessRewardEntry,
  TopicScope,
  EntailmentRepairEvent,
  TalmudicCorpus,
} from './types.js';
import { POVER_INFO, getDebatePhase, POV_KEYS, type PovKey, type PovInfo } from './types.js';
import {
  loadProvisionalWeights,
  buildSignalRegistry,
  evaluatePhaseTransition,
  applyTransition,
  advanceRound,
  buildPhaseContext,
  buildSignalTelemetry,
  initAdaptiveDiagnostics,
  detectCruxNodes,
  computeSaturationScore,
  computeConvergenceScore,
} from './phaseTransitions.js';
import { updateConfidenceState } from './signalConfidence.js';
import { pruneArgumentNetwork, needsGc } from './networkGc.js';
import type { PovNode, SituationNode } from './taxonomyTypes.js';
import type { TaxonomyContext } from './taxonomyContext.js';
import {
  crossRespondSelectionPrompt,
  formatCriticalQuestions,
  selectReframingMetaphor,
  probingQuestionsPrompt,
  entrySummarizationPrompt,
  midDebateGapPrompt,
  crossCuttingNodePrompt,
  moderatorSelectionPrompt,
  moderatorInterventionPrompt,
  setPromptCompact,
  isCompactModel,
  setTopicScope,
  extractSpeakerVocabulary,
  formatVocabularyExclusion,
  entailmentRepairPrompt,
  cruxRefreshPrompt,
} from './prompts.js';
import { extractClaimsPrompt, classifyClaimsPrompt, formatArgumentNetworkContext, formatCommitments, formatEstablishedPoints, updateUnansweredLedger, formatUnansweredClaimsHint, formatSpecifyHint, formatConcessionCandidatesHint, processExtractedClaims, factCheckToBaseStrength, computeClaimTaxonomyAttribution, sampleNodesForEntailment, type RawExtractedClaim } from './argumentNetwork.js';
import { embedDoctrinalBoundaries, computeDoctrinalAnchoring, checkThresholdAnomalies, type BoundaryEmbeddings, type DoctrinalAnchoringConfig } from './doctrinalAnchoring.js';
import { extractCalibrationData, appendCalibrationLog, readCalibrationLog } from './calibrationLogger.js';
import { DEFAULT_ATTACK_WEIGHTS } from './qbaf.js';
import { DEFAULT_AI_TIMEOUT_MS, DEFAULT_RELEVANCE_THRESHOLD } from './constants.js';
import { CLAIM_VERIFY_SETTLE_TIMEOUT_MS, EVALUATOR_TEMPERATURE, SUMMARIZATION_TEMPERATURE, SUMMARIZATION_MAX_TOKENS, SUMMARIZATION_TIMEOUT_MS } from './debateConfig.js';
import { computeStrategicHints } from './strategicHints.js';
import { resolveSouls } from './debateEngine/soulResolution.js';
import { computeSituationCitations } from './debateEngine/diagnostics.js';
import { evaluateLookahead, type LookaheadDiagnostics } from './lookaheadGate.js';
import { runOvergenPipeline, type OvergenDiagnostics } from './overgenPipeline.js';
import { classifyTopicComplexity, extractTopicStructure } from './topicStructure.js';
import { resolveRepoRoot, resolveDataRoot, resolveSourcesDir, loadSituationStatements, loadConflicts } from './taxonomyLoader.js';
import { updateCruxTracker, formatCruxResolutionContext, detectConcessionCascade, transitionCrux, finalizeUndecidedCruxes } from './cruxResolution.js';
import { persistDebateCruxes, loadRegistry, findRelevantPriorCruxes, formatPriorCruxContext } from './cruxRegistry.js';
import { findAndEnrichPromotionCandidates, computeWeightAdjustments, weightAdjustmentsToProposals } from './cruxTaxonomyFeedback.js';
import { computeConfidenceUpdates, computePriorityUpdates, confidenceUpdatesToProposals, priorityUpdatesToProposals } from './confidenceEvolution.js';
import { computeOperationalityUpdates, operationalityUpdatesToProposals } from './operationalityEvolution.js';
import { computeInterpretationRevisionProposals } from './situationInterpretationEvolution.js';
import { formatTaxonomyContext, computeInjectionManifest } from './taxonomyContext.js';
import { formatVocabularyContext } from './vocabularyContext.js';
import { disambiguateTerms } from './vocabularyDisambiguation.js';
import type { CampOrigin } from '../dictionary/types.js';
import type { ContextInjectionManifest } from './taxonomyContext.js';
import { documentAnalysisPrompt, buildTaxonomySample } from './documentAnalysis.js';
import type { DocumentAnalysis, ReflectionProposal, DraftWorkProduct } from './types.js';
import {
  cosineSimilarity,
  scoreNodeRelevance,
  scoreNodesLexical,
  scoreNodesViaAN,
  selectRelevantNodes,
  selectRelevantSituationNodes,
  buildRelevanceQuery,
  computePolicymakerRelevanceBoost,
  type RelevanceOptions,
  type ANClaimEmbedding,
  type ScoredPovNode,
  reScoreSituationsForCruxes,
  filterByTopicConstraints,
} from './taxonomyRelevance.js';
import {
  generateId,
  nowISO,
  parseJsonRobust,
  formatRecentTranscript,
  parsePoverResponse,
  getMoveName,
  wordOverlap,
} from './helpers.js';
import { computeCoverageMap, computeStrengthWeightedCoverage } from './coverageTracker.js';
import { loadCoverageMap } from './corpusCoverage.js';
import { computeTaxonomyGapAnalysis } from './taxonomyGapAnalysis.js';
import { checkClaimExclusionBoundary, checkDraftScopeBoundary, filterByExclusionAbsolute, EXCLUSION_RATIO_THRESHOLD, SCOPE_BOUNDARY_THRESHOLD } from './exclusionGuard.js';
import { ActionableError } from './errors.js';
import { computeCampInsularityRate, isInsularityCritical, selectCrossCampNode, type InsularityInjection } from './schemeStagnation.js';
import { nodePovFromId } from './nodeIdUtils.js';
import type { ContextManifestEntry } from './taxonomyGapAnalysis.js';
import { resolveTurnValidationConfig, classifyHintKey } from './turnValidator.js';
import type { TurnValidation, ModeratorState, ModeratorIntervention, SelectionResult, InterventionMove } from './types.js';
import { MOVE_TO_FAMILY, FAMILY_BURDEN_WEIGHT, MOVE_TO_FORCE, HINT_SUPPRESSION_THRESHOLD } from './types.js';
import {
  validateRecommendation,
  updateModeratorState,
  computeDebateHealthScore,
  updateSliBreaches,
  computeTriggerEvaluationContext,
  formatTriggerContext,
  buildIntervention,
  buildInterventionBriefInjection,
  checkInterventionCompliance,
  getConcludingResponder,
  MOVE_RESPONSE_CONFIG,
  DIRECT_RESPONSE_PATTERNS,
  updateCruxEngagement,
} from './moderator.js';
import { runModeratorSelection, executeTurnWithRetry } from './orchestration.js';
import type { ModeratorSelectionCallbacks, ModeratorSelectionInput, TurnRetryCallbacks, TurnRetryInput } from './orchestration.js';
import { pruneSessionData, pruneModeratorState } from './sessionPruning.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';
import { computeModelFingerprint } from './debateEngine/modelFingerprint.js';
import { resolveBackground } from './debateEngine/backgroundIngestion.js';
import { callByUsage } from '../ai-client/usageRegistry.js';
import { DEFAULT_TEMPERATURE } from '../ai-client/defaults.js';
import { runTurnPipeline, assemblePipelineResult, runOpeningPipeline, assembleOpeningPipelineResult, getOpeningRepairHints, type TurnPipelineInput, type OpeningPipelineInput } from './turnPipeline.js';
import { TopicPipeline } from './topicPipeline.js';
import { ClaimExtractionPipeline } from './claimExtractionPipeline.js';
import { SynthesisPipeline } from './synthesisPipeline.js';
import type { DebateEngineInternals, DebateConfig, DebateProgress, LifecycleStage } from './debateEngine/internals.js';
import { resolveStageModel, resolveModelForSpeaker, buildFailoverChain, recordRateLimit, clearRateLimitBackoff, isRateLimitError } from './debateEngine/modelResolution.js';
import { computePerturbationResult } from './debateEngine/perturbation.js';
import { setupDoctrinalAnchoring } from './debateEngine/doctrinal.js';
import { seedExplorationSummary, applyExplorationConfigDefaults } from './debateEngine/explorationSeeding.js';
import { runDocumentAnalysis } from './debateEngine/phases/documentPreAnalysis.js';
import { runOpeningStatements } from './debateEngine/phases/opening.js';
import { runFixedCrossRespond, runAdaptiveCrossRespond } from './debateEngine/phases/crossRespond.js';
import { hydrateModeratorState, hydratePhaseState } from './debateEngine/hydrateState.js';
import { _rescoreSituations } from './debateEngine/adaptiveStaging.js';
export { modelTierRank } from './debateEngine/modelResolution.js';
export type { DebateConfig, DebateProgress, LifecycleStage } from './debateEngine/internals.js';
import { initTalmudicCorpusFromConfig } from './talmudicReferences.js';

// ── Engine ────────────────────────────────────────────────

export class DebateEngine {
  /** @internal Narrow accessor exposing the members the extracted phase/helper
   *  modules need (ADR-007 split). Returns `this` typed to the internal contract;
   *  NOT part of the supported public API. */
  get _internal(): DebateEngineInternals {
    return this as unknown as DebateEngineInternals;
  }

  // ── Test-facing delegators (ADR-007 split, t/1778) ─────────────────────────
  // These helpers were extracted to sibling modules; thin delegators preserve the
  // private instance-method surface that existing unit tests exercise directly via
  // `(engine as any).x()`. Production/orchestrator code calls the module functions.
  private resolveStageModel(key: keyof NonNullable<DebateConfig['stageModels']>): string {
    return resolveStageModel(this._internal, key);
  }
  private buildFailoverChain(primaryModel: string): string[] {
    return buildFailoverChain(this._internal, primaryModel);
  }
  private _rescoreSituations(): void {
    _rescoreSituations(this._internal);
  }
  private async runOpeningStatements(): Promise<void> {
    return runOpeningStatements(this._internal);
  }
  private recordRateLimit(): void {
    recordRateLimit(this._internal);
  }
  private clearRateLimitBackoff(): void {
    clearRateLimitBackoff(this._internal);
  }
  private isRateLimitError(err: unknown): boolean {
    return isRateLimitError(err);
  }
  private seedExplorationSummary(summary: import('./explorationSummary.js').ExplorationSummary): void {
    seedExplorationSummary(this._internal, summary);
  }

  private config: DebateConfig;
  private adapter: AIAdapter;
  private taxonomy: LoadedTaxonomy;
  private session!: DebateSession;
  private onProgress?: (p: DebateProgress) => void;
  private apiCallCount = 0;
  private totalResponseTimeMs = 0;
  private lastApiCallTime = 0;
  /** Last computed injection manifest — stored on transcript entries for usage analysis. */
  private _lastInjectionManifest: ContextInjectionManifest | null = null;
  /** Full relevance score map (POV + situation nodes) from last context build. */
  private _lastRelevanceScores: Map<string, number> | null = null;
  /** Activated situation nodes from last context injection — for AN situation grounding (t/243). */
  private _activatedSituations: { id: string; text: string }[] = [];
  /** Speaker mapping for neutral evaluator — built once, reused across checkpoints. */

  /** Whether the midpoint neutral evaluation has already run this debate. */
  private _midpointEvalDone = false;
  // _openingEmbeddings, _openingClaims, _gapInjectionCount → moved to ClaimExtractionPipeline (t/1300 C2)
  /** Perturbation injection transcript entry ID — set when perturbation fires. */
  private _perturbationEntryId: string | null = null;
  /** Accumulated context manifests across turns — for taxonomy gap analysis. */
  private _contextManifests: ContextManifestEntry[] = [];
  /** Adaptive situation score adjustments from crux re-scoring at phase transitions. */
  private _situationScoreAdjustments: Map<string, number> | null = null;
  /** Lazy-built set of every taxonomy node id in the loaded taxonomy. */
  private _knownNodeIds: Set<string> | null = null;
  /** Lazy-built set of every policy id in the loaded policy registry. */
  private _policyIds: Set<string> | null = null;
  /** Active moderator state — tracks budget, cooldown, burden, and intervention history. */
  private _moderatorState: ModeratorState | null = null;
  private _adaptiveConfig: PhaseTransitionConfig | null = null;
  private _phaseState: PhaseState | null = null;
  private _signalRegistry: Signal[] | null = null;
  private _adaptiveDiagnostics: AdaptiveStagingDiagnostics | null = null;
  /** Cached doctrinal boundary embeddings (computed once at debate setup). */
  private _boundaryEmbeddings: BoundaryEmbeddings | null = null;
  private _signalHistory: Map<string, { round: number; value: number }[]> = new Map();
  private _peakTrackers: Map<string, number> = new Map();
  /** Debate-wide hint failure streaks — global (not per-speaker); suppressibility is model-wide. */
  private _hintStreaks = new Map<string, import('./types.js').HintStreak>();
  /** Cached prior crux context string — seeded from registry at debate start, injected into Brief stage. */
  private _priorCruxContext: string = '';
  /** Situation score adjustments from exploration summary (effective → boost, ineffective → penalty). */
  private _explorationBoosts: Map<string, number> = new Map();
  /** Formatted exploration priming text (AN sketch + convergence areas) for Brief prompt injection. */
  private _explorationPriming: string = '';
  /** Insularity interventions fired during this debate (for calibration logging). */
  private _insularityInterventions: { speaker: string; round: number; injected_node_id: string; target_camp: string }[] = [];
  /** Whether any turn's over-gen coherence gate missed during this debate. */
  private _overgenCoherenceGateMiss = false;
  /** Adaptive backoff (ms) imposed after a 429 rate-limit error is detected. */
  private _rateLimitBackoffMs = 0;
  /** Timestamp of the last 429 detection — used with _rateLimitBackoffMs in throttle(). */
  private _lastRateLimitTime = 0;
  /** Extracted TopicPipeline collaborator — owns topic critique, scope, clarification, and drift. */
  private _topicPipeline!: TopicPipeline;
  /** Extracted ClaimExtractionPipeline collaborator — owns claim extraction, drift tracking, gap injection, and post-debate analysis. */
  private _claimPipeline!: ClaimExtractionPipeline;
  private _synthesisPipeline!: SynthesisPipeline;
  private _talmudicCorpus: TalmudicCorpus | null = null;
  private _resolvedSouls: Partial<Record<string, PovInfo>> = {};
  private _soulProvenance: Partial<Record<string, { file: string; hash: string }>> = {};

  /** t/1781: fire-and-forget claim verifications; settled before calibration extract to make source_authority deterministic. */
  private _pendingClaimVerifications: Promise<void>[] = [];

  getSoulForSpeaker = (poverId: string): PovInfo => this._resolvedSouls[poverId] ?? POVER_INFO[poverId as keyof typeof POVER_INFO];

  /** Get the set of hint keys currently suppressed for this debate. */
  private getSuppressedHints(): Set<string> {
    const suppressed = new Set<string>();
    for (const [key, streak] of this._hintStreaks) {
      if (streak.suppressed) suppressed.add(key);
    }
    return suppressed;
  }

  /** Update hint streaks after a turn completes. Hints that fired increment; hints that didn't reset. */
  private updateHintStreaks(speaker: string, firedHints: string[]): void {
    const firedKeys = new Set(firedHints.map(h => classifyHintKey(h)));

    // Increment streaks for fired hints
    for (const key of firedKeys) {
      if (key === 'other') continue; // don't track unclassified hints
      const existing = this._hintStreaks.get(key);
      if (existing) {
        existing.consecutive_failures++;
        if (!existing.suppressed && existing.consecutive_failures >= HINT_SUPPRESSION_THRESHOLD) {
          existing.suppressed = true;
          getGlobalRecorder()?.record({
            type: 'turn.hint-suppressed', component: 'debate-engine', level: 'warn',
            speaker,
            message: `Suppressed hint "${key}" after ${existing.consecutive_failures} consecutive failures`,
            data: { hint_key: key, consecutive_failures: existing.consecutive_failures },
          });
        }
      } else {
        this._hintStreaks.set(key, { hint_key: key, consecutive_failures: 1, suppressed: false });
      }
    }

    // Reset streaks for hints that didn't fire this turn
    for (const [key, streak] of this._hintStreaks) {
      if (!firedKeys.has(key)) {
        streak.consecutive_failures = 0;
        streak.suppressed = false;
      }
    }
  }

  private getKnownNodeIds(): Set<string> {
    if (this._knownNodeIds) return this._knownNodeIds;
    const s = new Set<string>();
    for (const pov of POV_KEYS) {
      for (const n of this.taxonomy[pov]?.nodes ?? []) s.add(n.id);
    }
    for (const n of this.taxonomy.situations?.nodes ?? []) s.add(n.id);
    this._knownNodeIds = s;
    return s;
  }

  private getPolicyIds(): Set<string> {
    if (this._policyIds) return this._policyIds;
    const s = new Set<string>();
    for (const p of this.taxonomy.policyRegistry ?? []) s.add(p.id);
    this._policyIds = s;
    return s;
  }

  private async generateWithModel(
    prompt: string, label: string, model: string, timeoutMs?: number, temperature?: number,
  ): Promise<string> {
    await this.throttle();
    this.progress('generating', undefined, label);
    const start = Date.now();
    try {
      const text = await this.adapter.generateText(prompt, model, {
        temperature: temperature ?? 0,
        timeoutMs: timeoutMs ?? DEFAULT_AI_TIMEOUT_MS,
        signal: this.config.signal,
      });
      this.lastApiCallTime = Date.now();
      this.apiCallCount++;
      this.totalResponseTimeMs += Date.now() - start;
      clearRateLimitBackoff(this._internal);
      return text;
    } catch (err) {
      this.lastApiCallTime = Date.now();
      if (isRateLimitError(err)) recordRateLimit(this._internal);
      throw err;
    }
  }

  constructor(config: DebateConfig, adapter: AIAdapter | ExtendedAIAdapter, taxonomy: LoadedTaxonomy) {
    const merged: DebateConfig['stageModels'] = { ...config.stageModels };

    if (config.evaluatorModel && !merged.evaluator) {
      merged.evaluator = config.evaluatorModel;
      console.warn('[debate-engine] evaluatorModel is deprecated — use stageModels.evaluator instead');
    }
    if (config.utilityModels) {
      const uMap: Record<string, keyof NonNullable<DebateConfig['stageModels']>> = {
        summary: 'summary', scope: 'scope', moderator: 'moderator', crux: 'crux',
      };
      for (const [uKey, sKey] of Object.entries(uMap)) {
        const val = config.utilityModels[uKey as keyof typeof config.utilityModels];
        if (val && !merged[sKey]) {
          merged[sKey] = val;
          console.warn(`[debate-engine] utilityModels.${uKey} is deprecated — use stageModels.${sKey} instead`);
        }
      }
    }

    const derivedModeratorMode = config.moderatorMode ?? (config.protocolId === 'socratic' ? 'socratic' : undefined);
    const derivedDialecticalStyle = config.dialecticalStyle ?? (config.protocolId === 'socratic' ? 'socratic' : undefined);
    this.config = { ...config, stageModels: merged, moderatorMode: derivedModeratorMode, dialecticalStyle: derivedDialecticalStyle };
    this._talmudicCorpus = initTalmudicCorpusFromConfig(this.config);
    this.adapter = adapter;
    this.taxonomy = taxonomy;
    applyExplorationConfigDefaults(this._internal);
  }

  async run(onProgress?: (p: DebateProgress) => void): Promise<DebateSession> {
    this.onProgress = onProgress;
    if (this.adapter.onRetryProgress === undefined) {
      this.adapter.onRetryProgress = (info) => {
        this.onProgress?.({
          phase: 'retry',
          message: `Retry attempt ${info.attempt}/${info.maxRetries}, waiting ${info.backoffSeconds}s...`,
          retry: { attempt: info.attempt, maxRetries: info.maxRetries, backoffSeconds: info.backoffSeconds },
        });
      };
    }
    // Socratic protocol is a dyad: exactly one interlocutor under examination.
    // Checked here (run entry) so load/view of saved debates is unaffected (t/2514).
    if (this.config.protocolId === 'socratic' && this.config.activePovers.length !== 1) {
      throw new ActionableError({
        goal: 'Run a Socratic debate',
        problem: `Socratic protocol requires exactly one active POV (the interlocutor under examination), but ${this.config.activePovers.length} were provided: ${this.config.activePovers.join(', ')}.`,
        location: 'DebateEngine.run()',
        nextSteps: [
          'Select a single debater as the interlocutor when using protocolId "socratic" (e.g. activePovers: ["safetyist"]).',
          'The moderator acts as the questioner — no second debater is needed.',
        ],
      });
    }

    this.config.background = await resolveBackground(this.config.background);

    // Soul resolution: resolve once per seat before initSession() (t/4007). See debateEngine/soulResolution.ts.
    const { resolvedSouls, soulProv } = resolveSouls(this.config, this.taxonomy);
    this._resolvedSouls = resolvedSouls;
    this._soulProvenance = soulProv;

    this.initSession();

    // Route prompt directives based on model capability (t/331)
    setPromptCompact(isCompactModel(this.config.model));

    // Embed doctrinal boundaries + compute anchoring (t/114)
    await setupDoctrinalAnchoring(this._internal);

    // Construct TopicPipeline collaborator (Cluster 1 — t/1300)
    this._topicPipeline = new TopicPipeline({
      session: this.session,
      config: this.config,
      adapter: this.adapter,
      taxonomy: this.taxonomy,
      sourceEvidenceIndex: this.sourceEvidenceIndex,
      generate: (prompt, label) => this.generate(prompt, label),
      generateViaUsage: (usageId, prompt, label) => this.generateViaUsage(usageId, prompt, label),
      generateWithModel: (prompt, label, model) => this.generateWithModel(prompt, label, model),
      resolveStageModel: (key) => resolveStageModel(this._internal, key as keyof NonNullable<DebateConfig['stageModels']>),
      addEntry: (entry) => this.addEntry(entry),
      recordDiagnostic: (entryId, data) => this.recordDiagnostic(entryId, data),
      progress: (phase, speaker, message) => this.progress(phase, speaker, message),
      warn: (operation, error, recovery) => this.warn(operation, error, recovery),
    });

    try {
      // Phase 0.5: Topic critique (free-form topics only, before clarification)
      if (this.config.enableWisdomEvaluation !== false &&
        this.config.sourceType !== 'document' && this.config.sourceType !== 'url' && this.config.sourceType !== 'situations') {
        await this._topicPipeline.runTopicCritique();
      }

      // Phase 0.75: Topic scope extraction (t/336 — foundation for topic-alignment enforcement)
      await this._topicPipeline.extractTopicScope();
      setTopicScope(this.session.topic.scope ?? null);

      // Phase 0.76: Topic structure extraction for structured topics (t/1050)
      if (!this.session.topic_structure && classifyTopicComplexity(this.session.topic.final) === 'structured') {
        this.progress('setup', undefined, 'Extracting topic structure');
        try {
          const structureModel = resolveStageModel(this._internal, 'scope');
          this.session.topic_structure = await extractTopicStructure(
            this.session.topic.final,
            (prompt, label) => this.generateWithModel(prompt, label, structureModel),
          );
          const premises = this.session.topic_structure.structural_premises.length;
          const constraints = this.session.topic_structure.scope_constraints?.length ?? 0;
          this.progress('setup', undefined, `Topic structure extracted (${premises} premises, ${constraints} constraints)`);
          getGlobalRecorder()?.record({
            type: 'topic_structure_extracted', component: 'debate-engine', level: 'info',
            message: `Topic structure extracted (${premises} premises, ${constraints} constraints)`,
            data: { complexity: 'structured', premises, constraints },
          });
        } catch (err) {
          getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: this.session?.id, message: 'Topic structure extraction failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
          this.warn('Topic structure extraction', err, 'Structure extraction skipped — debate continues without decomposition');
        }
      }

      // Phase 0.8: Seed prior crux context from registry (t/367)
      if (this.config.embedFn) {
        try {
          const __engineDir = path.dirname(fileURLToPath(import.meta.url));
          const repoRoot = resolveRepoRoot(__engineDir);
          const dataRoot = resolveDataRoot(repoRoot);
          const registry = loadRegistry(dataRoot);
          if (registry.entries.length > 0) {
            const topicEmbedding = await this.config.embedFn(this.session.topic.final);
            const relevant = findRelevantPriorCruxes(topicEmbedding, registry);
            this._priorCruxContext = formatPriorCruxContext(relevant);
          }
        } catch (err) {
          getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: this.session?.id, message: 'Crux registry seeding failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
        }
      }

      // Phase 0.9: Exploration summary seeding (t/986)
      if (this.config.explorationSummary) {
        seedExplorationSummary(this._internal, this.config.explorationSummary);
      }

      // Phase 1: Clarification (optional)
      if (this.config.enableClarification) {
        await this._topicPipeline.runClarification();
      }

      // Phase 1.5: Document pre-analysis
      if (this.config.sourceType === 'document' || this.config.sourceType === 'url') {
        await runDocumentAnalysis(this._internal);
      }

      // Phase 2: Opening statements
      await runOpeningStatements(this._internal);

      // Cache opening embeddings for position drift detection
      await this._claimPipeline.cacheOpeningEmbeddings();
      await this._claimPipeline.cacheOpeningClaims();

      // Neutral evaluator: baseline checkpoint (after openings, before cross-respond)
      await this._synthesisPipeline.runNeutralCheckpoint('baseline');

      // Ensure phase transitions to 'debate' even if openings were partial
      if (this.session.phase === 'opening') {
        this.session.phase = 'debate';
      }

      // Phase 3: Cross-respond rounds
      if (this.config.useAdaptiveStaging && this._adaptiveConfig && this._phaseState) {
        await runAdaptiveCrossRespond(this._internal);
      } else {
        await runFixedCrossRespond(this._internal);
      }

      // Phase 3b: Finalize undecided cruxes (t/1676; engagement gate t/1818) — mark any crux
      // still `identified` and not cross-engaged as terminal `undecided` BEFORE synthesis so
      // all downstream observers see one consistent state. Idempotent — safe on resume().
      const finalizeAN = this.session.argument_network;
      this.session.crux_tracker = finalizeUndecidedCruxes(
        this.session.crux_tracker,
        this.session.transcript.length,
        finalizeAN?.nodes ?? [],
        finalizeAN?.edges ?? [],
        this.session.transcript,
      );

      // Phase 4: Synthesis + final neutral evaluation in parallel
      // Socratic debates aim at aporia (productive irresolution), not consensus — skip synthesis.
      if (this.config.dialecticalStyle !== 'socratic') {
        await Promise.all([
          this._synthesisPipeline.runSynthesis(),
          this._synthesisPipeline.runNeutralCheckpoint('final'),
        ]);

        // Phase 4b: Missing arguments pass (needs synthesis output, so runs after)
        await this._synthesisPipeline.runMissingArgumentsPass();

        // Phase 4c: Taxonomy refinement suggestions (needs synthesis + argument network)
        await this._synthesisPipeline.runTaxonomyRefinementPass();

        // Phase 4d: Dialectic trace generation (needs synthesis preferences + argument network)
        this._synthesisPipeline.runDialecticTracePass();

        // Phase 4e: Cross-cutting node promotion (needs synthesis areas_of_agreement)
        await this._claimPipeline.runCrossCuttingProposalPass();
      } else {
        // Socratic: run neutral checkpoint only (no consensus framing)
        await this._synthesisPipeline.runNeutralCheckpoint('final');
      }

      // Phase 4f: Taxonomy gap analysis (deterministic — needs transcript, AN, taxonomy, manifests)
      this._claimPipeline.runTaxonomyGapAnalysisPass();

      // Phase 4g: Situation debate_refs extraction (t/193 — deterministic, needs transcript + situations)
      this._claimPipeline.runSituationRefExtraction();

      // Phase 4h: Perturbation result computation (evaluation/benchmark only)
      computePerturbationResult(this._internal);
    } catch (err) {
      // If the debate was cancelled via AbortSignal, set phase to cancelled and return partial session
      if (this.config.signal?.aborted) {
        this.session.phase = 'cancelled';
        this.session.updated_at = nowISO();
        this.session.diagnostics!.overview.total_ai_calls = this.apiCallCount;
        this.session.diagnostics!.overview.total_response_time_ms = this.totalResponseTimeMs;
        getGlobalRecorder()?.record({ type: 'lifecycle', component: 'debate-engine', level: 'info', debate_id: this.session.id, message: 'Debate cancelled via AbortSignal' });
        return this.session;
      }
      this.emitSnapshot('error');
      getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'error', debate_id: this.session?.id, message: 'Debate run failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      throw err;
    }

    // Finalize
    this.session.updated_at = nowISO();
    this.session.diagnostics!.overview.total_ai_calls = this.apiCallCount;
    this.session.diagnostics!.overview.total_response_time_ms = this.totalResponseTimeMs;

    // Compute cumulative context-rot retention
    if (this.session.context_rot && this.session.context_rot.stages.length > 0) {
      this.session.context_rot.measured_at = nowISO();
      this.session.context_rot.cumulative_retention = this.session.context_rot.stages
        .filter(s => s.in_units === s.out_units)
        .reduce((acc, s) => acc * (s.ratio > 0 && s.ratio <= 1 ? s.ratio : 1), 1);
      this.session.context_rot.cumulative_retention = Math.round(this.session.context_rot.cumulative_retention * 10000) / 10000;
    }

    // Compute extraction coverage on sampled turns (t/391)
    await this._synthesisPipeline.runExtractionCoverage();

    // Stamp source provenance for source-authority calibration on all write paths (t/1769).
    // Additive: only set when we have titles and the session doesn't already carry them.
    if (this.docTitles && !this.session.doc_meta) {
      this.session.doc_meta = this.docTitles;
    }

    // Log calibration data point (non-blocking, never fails the debate)
    try {
      // ── ASYNC-ORDERING GUARANTEE (settle-gate) ─────────────────────────────
      // Awaits pending claim-verifications (t/1781 fire-and-forget) before
      // extractCalibrationData reads the argument network. Bounded by
      // CLAIM_VERIFY_SETTLE_TIMEOUT_MS; ADR-001 partial recovery extracts
      // with evidence-so-far on timeout. Phase modules enqueue onto this
      // engine's _pendingClaimVerifications via _internal — new post-completion
      // async work must do the same; do not scatter the ordering contract.
      if (this._pendingClaimVerifications.length > 0) {
        const settled = await Promise.race([
          Promise.allSettled(this._pendingClaimVerifications).then(() => true),
          new Promise<false>(res => setTimeout(() => res(false), CLAIM_VERIFY_SETTLE_TIMEOUT_MS)),
        ]);
        if (!settled) {
          getGlobalRecorder()?.record({
            type: 'system.error', component: 'debate-engine', level: 'warn',
            debate_id: this.session?.id,
            message: 'Claim verifications did not settle before calibration extract; extracting with evidence-so-far (t/1781)',
          });
        }
        this._pendingClaimVerifications = [];
      }

      const weights = loadProvisionalWeights();
      const repoRoot = resolveRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
      const dataRoot = resolveDataRoot(repoRoot), conflicts = loadConflicts(repoRoot);
      const dataPoint = extractCalibrationData(this.session, 'local', {
        argumentationExitThreshold: weights.thresholds.argumentation_exit,
        relevanceThreshold: DEFAULT_RELEVANCE_THRESHOLD,
        draftTemperature: DEFAULT_TEMPERATURE,
        attackWeights: [DEFAULT_ATTACK_WEIGHTS.rebut, DEFAULT_ATTACK_WEIGHTS.undercut, DEFAULT_ATTACK_WEIGHTS.undermine],
        argumentativeSaturationWeights: weights.argumentative_saturation,
        explorationSummary: this.config.explorationSummary,
        docMeta: this.docTitles,
        insularityInterventions: this._insularityInterventions.length > 0 ? this._insularityInterventions : undefined,
        conflicts,
      });
      if (this._overgenCoherenceGateMiss) {
        dataPoint.coherence_gate_miss = true;
      }
      appendCalibrationLog(dataPoint, this.config.calibrationDataRoot ?? dataRoot);

      // Post-debate adaptive threshold write-back
      this._claimPipeline.runPostDebateCalibration(dataRoot);

      // Persist unresolved cruxes to cross-debate registry (t/367)
      if (this.config.embedFn && this.session.crux_tracker?.length) {
        try {
          const generateFn = (prompt: string) => this.generateWithEvaluator(prompt, 'Crux decontextualization');
          const cruxResult = await persistDebateCruxes(this.session, dataRoot, this.config.embedFn, generateFn);

          if ((cruxResult.merged > 0 || cruxResult.created > 0) && this.config.usageDeps) {
            try {
              const registry = loadRegistry(dataRoot);
              const enrichFn = async (values: Record<string, string>) => {
                const result = await callByUsage('enrichment.situation-bdi-decomposition', values, this.config.usageDeps!);
                return result.text;
              };
              const candidates = await findAndEnrichPromotionCandidates(registry, enrichFn);
              if (candidates.length > 0) {
                this.session.promotion_candidates = candidates.map(c => ({
                  crux_id: c.entry.id,
                  draft: c.draft_situation,
                  irreducible_count: c.irreducible_count,
                }));
              }
            } catch (enrichErr) {
              getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: this.session?.id, message: 'Crux promotion enrichment failed', error: { name: (enrichErr as Error).name ?? 'Error', message: String(enrichErr), stack: (enrichErr as Error).stack } });
            }
          }
        } catch (err) {
          getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: this.session?.id, message: 'Crux registry persistence failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
        }
      }

      // Post-debate reflection proposals (human-gated taxonomy evolution)
      try {
        const an = this.session.argument_network;
        if (an && an.nodes.length > 0) {
          const proposals: ReflectionProposal[] = [];
          const allPovNodes = [
            ...this.taxonomy.accelerationist.nodes,
            ...this.taxonomy.safetyist.nodes,
            ...this.taxonomy.skeptic.nodes,
          ];
          const beliefs = new Map<string, PovNode>();
          const desires = new Map<string, PovNode>();
          const intentions = new Map<string, PovNode>();
          for (const n of allPovNodes) {
            if (n.category === 'Beliefs') beliefs.set(n.id, n);
            else if (n.category === 'Desires') desires.set(n.id, n);
            else if (n.category === 'Intentions') intentions.set(n.id, n);
          }

          const initialConfidences = new Map<string, number>();
          for (const [id, b] of beliefs) initialConfidences.set(id, b.confidence ?? 0.5);
          const initialOperationalities = new Map<string, number>();
          for (const [id, i] of intentions) initialOperationalities.set(id, i.operationality ?? 3);

          const debateId = this.session.id;

          // 1. Confidence evolution
          const confResult = computeConfidenceUpdates({
            debate_id: debateId, nodes: an.nodes, edges: an.edges,
            beliefs, initial_confidences: initialConfidences,
          });
          proposals.push(...confidenceUpdatesToProposals(confResult.updates));

          // 2. Priority evolution (from concessions + crux desires)
          const concessions: { desire_id: string }[] = [];
          const cruxDesireIds = new Set<string>();
          for (const [, store] of Object.entries(this.session.commitments ?? {})) {
            for (const text of store.conceded ?? []) {
              for (const [id, d] of desires) {
                if (d.label && text.toLowerCase().includes(d.label.toLowerCase())) {
                  concessions.push({ desire_id: id });
                }
              }
            }
          }
          const priorityUpdates = computePriorityUpdates(concessions, cruxDesireIds, desires, debateId);
          proposals.push(...priorityUpdatesToProposals(priorityUpdates));

          // 3. Operationality evolution
          const opUpdates = computeOperationalityUpdates({
            debate_id: debateId, nodes: an.nodes, edges: an.edges,
            intentions, initial_operationalities: initialOperationalities,
          });
          proposals.push(...operationalityUpdatesToProposals(opUpdates));

          // 4. Crux weight adjustments (if registry available)
          if (this.config.embedFn && this.session.crux_tracker?.length) {
            try {
              const __engineDir = path.dirname(fileURLToPath(import.meta.url));
              const cruxDataRoot = resolveDataRoot(resolveRepoRoot(__engineDir));
              const registry = loadRegistry(cruxDataRoot);
              const adjustments = computeWeightAdjustments(registry);
              if (adjustments.length > 0) {
                const currentValues = new Map<string, number>();
                for (const a of adjustments) {
                  const belief = beliefs.get(a.node_id);
                  const desire = desires.get(a.node_id);
                  if (belief && belief.confidence != null) currentValues.set(a.node_id, belief.confidence);
                  if (desire && desire.priority != null) currentValues.set(a.node_id, desire.priority);
                }
                proposals.push(...weightAdjustmentsToProposals(adjustments, debateId, currentValues));
              }
            } catch (cruxErr) {
              getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: this.session?.id, message: 'Crux weight adjustment proposals failed', error: { name: (cruxErr as Error).name ?? 'Error', message: String(cruxErr), stack: (cruxErr as Error).stack } });
            }
          }

          // 5. Situation interpretation revision proposals
          const sitNodes = (this.taxonomy as unknown as Record<string, { nodes?: SituationNode[] }>).situations?.nodes ?? [];
          if (sitNodes.length > 0) {
            try {
              const interpProposals = computeInterpretationRevisionProposals({
                nodes: an.nodes, edges: an.edges, situations: sitNodes, debateId,
              });
              proposals.push(...interpProposals);
            } catch (sitErr) {
              getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: this.session?.id, message: 'Situation interpretation proposals failed', error: { name: (sitErr as Error).name ?? 'Error', message: String(sitErr), stack: (sitErr as Error).stack } });
            }
          }

          if (proposals.length > 0) {
            this.session.reflection_proposals = proposals;
          }
        }
      } catch (reflErr) {
        getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: this.session?.id, message: 'Reflection proposal generation failed', error: { name: (reflErr as Error).name ?? 'Error', message: String(reflErr), stack: (reflErr as Error).stack } });
      }
    } catch (calErr) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: this.session?.id, message: 'Calibration logging failed', error: { name: (calErr as Error).name ?? 'Error', message: String(calErr), stack: (calErr as Error).stack } });
      this.warn('Calibration logging', calErr, 'Non-critical — debate results unaffected');
    }

    return this.session;
  }

  // ── Resume from checkpoint ──────────────────────────────

  /** Resume from checkpoint — runs only the missing tail: synthesis + post-synthesis passes. */
  static async resume(
    checkpoint: DebateSession,
    config: DebateConfig,
    adapter: AIAdapter | ExtendedAIAdapter,
    taxonomy: LoadedTaxonomy,
    onProgress?: (p: DebateProgress) => void,
  ): Promise<DebateSession> {
    const engine = new DebateEngine(config, adapter, taxonomy);
    engine.session = checkpoint;
    engine.onProgress = onProgress;
    if (adapter.onRetryProgress === undefined) {
      adapter.onRetryProgress = (info) => {
        engine.onProgress?.({
          phase: 'retry',
          message: `Retry attempt ${info.attempt}/${info.maxRetries}, waiting ${info.backoffSeconds}s...`,
          retry: { attempt: info.attempt, maxRetries: info.maxRetries, backoffSeconds: info.backoffSeconds },
        });
      };
    }

    // Restore API call counts from the checkpoint diagnostics
    engine.apiCallCount = checkpoint.diagnostics?.overview.total_ai_calls ?? 0;
    engine.totalResponseTimeMs = checkpoint.diagnostics?.overview.total_response_time_ms ?? 0;

    // Stamp a new run_id so resumed sessions are distinguishable
    engine.session.run_id = generateId();

    // Construct ClaimExtractionPipeline for post-debate analysis methods
    engine._claimPipeline = new ClaimExtractionPipeline({
      session: engine.session,
      config: engine.config,
      adapter: engine.adapter as ExtendedAIAdapter,
      taxonomy: engine.taxonomy,
      contextManifests: engine._contextManifests,
      generate: (prompt, label) => engine.generate(prompt, label),
      generateViaUsage: (usageId, prompt, label) => engine.generateViaUsage(usageId, prompt, label),
      generateWithModel: (prompt, label, model) => engine.generateWithModel(prompt, label, model),
      generateWithEvaluator: (prompt, label, timeoutMs?) => engine.generateWithEvaluator(prompt, label, timeoutMs),
      resolveStageModel: (key) => resolveStageModel(engine._internal, key as keyof NonNullable<DebateConfig['stageModels']>),
      addEntry: (entry) => engine.addEntry(entry as Omit<TranscriptEntry, 'id' | 'timestamp'>),
      recordDiagnostic: (entryId, data) => engine.recordDiagnostic(entryId, data),
      progress: (phase, speaker, message) => engine.progress(phase, speaker, message),
      warn: (operation, error, recovery) => engine.warn(operation, error, recovery),
      incrementApiCallCount: () => { engine.apiCallCount++; },
      getKnownNodeIds: () => engine.getKnownNodeIds(),
      getActivatedSituations: () => engine._activatedSituations,
    });

    engine._synthesisPipeline = new SynthesisPipeline({
      session: engine.session,
      config: engine.config,
      taxonomy: engine.taxonomy,
      adapter: engine.adapter,
      generate: (prompt, label, timeoutMs?) => engine.generate(prompt, label, timeoutMs),
      generateWithEvaluator: (prompt, label) => engine.generateWithEvaluator(prompt, label),
      addEntry: (entry) => engine.addEntry(entry),
      recordDiagnostic: (entryId, data) => engine.recordDiagnostic(entryId, data),
      progress: (phase, speaker, message) => engine.progress(phase, speaker, message),
      warn: (operation, error, recovery) => engine.warn(operation, error, recovery),
      checkAborted: () => engine.checkAborted(),
    });

    setPromptCompact(isCompactModel(config.model));

    const hasSynthesis = checkpoint.transcript.some(
      e => e.type === 'concluding' && (e.metadata as Record<string, unknown>)?.synthesis,
    );

    const stop = config.stopAfterStage;
    const isSynthesisStop = stop === 'synthesis-p1' || stop === 'synthesis-p2' || stop === 'synthesis-p3';
    const maxPhase = stop === 'synthesis-p1' ? 1
      : stop === 'synthesis-p2' ? 2 : undefined;

    getGlobalRecorder()?.record({
      type: 'lifecycle', component: 'debate-engine', level: 'info',
      debate_id: checkpoint.id,
      message: `Resuming debate from checkpoint (hasSynthesis=${hasSynthesis}${stop ? `, stopAfterStage=${stop}` : ''})`,
    });

    const resumeStart = Date.now();

    try {
      if (!hasSynthesis) {
        if (isSynthesisStop) {
          await engine._synthesisPipeline.runSynthesis(maxPhase);
        } else {
          await Promise.all([
            engine._synthesisPipeline.runSynthesis(),
            engine._synthesisPipeline.runNeutralCheckpoint('final'),
          ]);
        }
        if (isSynthesisStop) return engine.earlyReturn(resumeStart);
      } else if (isSynthesisStop) {
        return engine.earlyReturn(resumeStart);
      }

      await engine._synthesisPipeline.runMissingArgumentsPass();
      if (stop === 'missing-arguments') return engine.earlyReturn(resumeStart);

      await engine._synthesisPipeline.runTaxonomyRefinementPass();
      if (stop === 'taxonomy-refinement') return engine.earlyReturn(resumeStart);

      engine._synthesisPipeline.runDialecticTracePass();
      await engine._claimPipeline.runCrossCuttingProposalPass();
      engine._claimPipeline.runTaxonomyGapAnalysisPass();
      engine._claimPipeline.runSituationRefExtraction();
      computePerturbationResult(engine._internal);

      await engine._synthesisPipeline.runExtractionCoverage();
      if (stop === 'extraction-coverage') return engine.earlyReturn(resumeStart);
    } catch (err) {
      if (config.signal?.aborted) {
        engine.session.phase = 'cancelled';
        engine.session.updated_at = nowISO();
        engine.session.diagnostics!.overview.total_ai_calls = engine.apiCallCount;
        engine.session.diagnostics!.overview.total_response_time_ms = engine.totalResponseTimeMs;
        getGlobalRecorder()?.record({ type: 'lifecycle', component: 'debate-engine', level: 'info', debate_id: engine.session.id, message: 'Resume cancelled via AbortSignal' });
        return engine.session;
      }
      getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'error', debate_id: engine.session?.id, message: 'Debate resume failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      throw err;
    }

    // Finalize
    engine.session.updated_at = nowISO();
    engine.session.diagnostics!.overview.total_ai_calls = engine.apiCallCount;
    engine.session.diagnostics!.overview.total_response_time_ms = engine.totalResponseTimeMs;
    engine.session.diagnostics!.overview.total_elapsed_ms = Date.now() - resumeStart;

    return engine.session;
  }

  private _computeModelFingerprint(): { model_pool?: string; model_api_id?: string } {
    const isMultiProvider = Boolean(this.config.speakerModels);
    return computeModelFingerprint(this.adapter.registry,
      isMultiProvider ? this.config.modelTier : undefined,
      isMultiProvider ? this.config.eligibleBackends : undefined,
      this.config.model,
      this.config.stageModels ? (Object.fromEntries(Object.entries(this.config.stageModels).filter((e): e is [string, string] => e[1] != null)) as Record<string, string>) : undefined,
    );
  }

  private initSession(): void {
    const id = generateId();
    const now = nowISO();
    const title = this.config.name ??
      (this.config.topic.length > 60 ? this.config.topic.slice(0, 57) + '...' : this.config.topic);

    this.session = {
      id,
      title,
      created_at: now,
      updated_at: now,
      app_version: this.config.appVersion,
      audience: this.config.audience,
      moderator_mode: this.config.moderatorMode ?? 'standard',
      talmudic_references: this._talmudicCorpus ? { enabled: true, corpus_name: this._talmudicCorpus.name, corpus_path: path.resolve(this.config.talmudicReferences!.corpusPath), corpus_version: String(this._talmudicCorpus.version) } : { enabled: false },
      phase: 'setup',
      topic: {
        original: this.config.topic,
        refined: null,
        final: this.config.topic,
        background: this.config.background || undefined,
      },
      source_type: this.config.sourceType,
      source_ref: this.config.sourceRef ?? '',
      source_content: this.config.sourceContent ?? '',
      active_povers: [...this.config.activePovers],
      user_is_pover: false,
      transcript: [],
      context_summaries: [],
      generated_with_prompt_version: 'cli-l2',
      debate_model: this.config.model,
      evaluator_model: this.config.evaluatorModel,
      speaker_models: this.config.speakerModels ? { ...this.config.speakerModels } : undefined,
      initial_speaker_models: this.config.speakerModels ? { ...this.config.speakerModels } : undefined,
      ...this._computeModelFingerprint(),
      failover_tracking: 'tracked' as const,
      stage_models: {
        brief: resolveStageModel(this._internal, 'brief'),
        plan: resolveStageModel(this._internal, 'plan'),
        draft: resolveStageModel(this._internal, 'draft'),
        cite: resolveStageModel(this._internal, 'cite'),
        evaluator: resolveStageModel(this._internal, 'evaluator'),
        scope: resolveStageModel(this._internal, 'scope'),
        summary: resolveStageModel(this._internal, 'summary'),
        moderator: resolveStageModel(this._internal, 'moderator'),
        crux: resolveStageModel(this._internal, 'crux'),
      },
      model_tier: this.config.modelTier,
      protocol_id: this.config.protocolId ?? 'structured',
      ...(this.config.excludeGreatestHits ? { exclude_greatest_hits: true } : {}),
      diagnostics: {
        enabled: true,
        entries: {},
        overview: {
          total_ai_calls: 0,
          total_response_time_ms: 0,
          claims_accepted: 0,
          claims_rejected: 0,
          move_type_counts: {},
          disagreement_type_counts: {},
        },
      },
      argument_network: { nodes: [], edges: [] },
      commitments: {},
      ...(this.config.seat_tags ? { seat_tags: this.config.seat_tags } : {}),
      ...(Object.keys(this._soulProvenance).length > 0 ? { soul_provenance: { ...this._soulProvenance } } : {}),
    };

    // Initialize commitment stores
    for (const pover of this.config.activePovers) {
      this.session.commitments![pover] = { asserted: [], conceded: [], challenged: [] };
    }

    this._moderatorState = hydrateModeratorState(this.session, this.config.rounds, this.config.activePovers);

    if (resolveStageModel(this._internal, 'evaluator') === this.config.model) {
      this.recordDiagnostic('session_init', {
        evaluator_warning: 'Evaluator model matches debate model — self-preference bias is unmitigated. Cross-vendor split recommended.',
      });
    }

    if (this.config.speakerModels) {
      getGlobalRecorder()?.record({
        type: 'debate.config', component: 'debate-engine', level: 'info',
        debate_id: id,
        message: 'Multi-provider mode enabled',
        data: { tier: this.config.modelTier, speakerModels: this.config.speakerModels },
      });
    }

    // Initialize adaptive staging (if enabled)
    if (this.config.useAdaptiveStaging) {
      const w = loadProvisionalWeights();
      const pacing = this.config.pacing ?? 'moderate';
      const preset = w.pacing_presets[pacing] ?? w.pacing_presets.moderate;

      this._adaptiveConfig = {
        useAdaptiveStaging: true,
        maxTotalRounds: this.config.maxTotalRounds ?? preset.maxTotalRounds,
        pacing,
        dialecticalStyle: this.config.dialecticalStyle ?? 'adversarial',
        argumentationExitThreshold: this.config.argumentationExitThreshold ?? (this.config.dialecticalStyle === 'socratic' ? 0.80 : preset.argumentationExit),
        concludingExitThreshold: this.config.concludingExitThreshold ?? preset.concludingExit,
        allowEarlyTermination: this.config.allowEarlyTermination ?? true,
        phaseBoundsOverride: this.config.dialecticalStyle === 'socratic'
          ? { maxConcludingRounds: 1, ...this.config.phaseBoundsOverride }
          : this.config.phaseBoundsOverride,
      };
      this._phaseState = hydratePhaseState(this.session, this._adaptiveConfig);
      this._signalRegistry = buildSignalRegistry(this.config.dialecticalStyle);
      this._adaptiveDiagnostics = initAdaptiveDiagnostics();
    }

    // Construct ClaimExtractionPipeline collaborator (Cluster 2 — t/1300)
    this._claimPipeline = new ClaimExtractionPipeline({
      session: this.session,
      config: this.config,
      adapter: this.adapter as ExtendedAIAdapter,
      taxonomy: this.taxonomy,
      contextManifests: this._contextManifests,
      generate: (prompt, label) => this.generate(prompt, label),
      generateViaUsage: (usageId, prompt, label) => this.generateViaUsage(usageId, prompt, label),
      generateWithModel: (prompt, label, model) => this.generateWithModel(prompt, label, model),
      generateWithEvaluator: (prompt, label, timeoutMs?) => this.generateWithEvaluator(prompt, label, timeoutMs),
      resolveStageModel: (key) => resolveStageModel(this._internal, key as keyof NonNullable<DebateConfig['stageModels']>),
      addEntry: (entry) => this.addEntry(entry as Omit<TranscriptEntry, 'id' | 'timestamp'>),
      recordDiagnostic: (entryId, data) => this.recordDiagnostic(entryId, data),
      progress: (phase, speaker, message) => this.progress(phase, speaker, message),
      warn: (operation, error, recovery) => this.warn(operation, error, recovery),
      incrementApiCallCount: () => { this.apiCallCount++; },
      getKnownNodeIds: () => this.getKnownNodeIds(),
      getActivatedSituations: () => this._activatedSituations,
    });

    // Construct SynthesisPipeline collaborator (Cluster 3 — t/1300)
    this._synthesisPipeline = new SynthesisPipeline({
      session: this.session,
      config: this.config,
      taxonomy: this.taxonomy,
      adapter: this.adapter,
      generate: (prompt, label, timeoutMs?) => this.generate(prompt, label, timeoutMs),
      generateWithEvaluator: (prompt, label) => this.generateWithEvaluator(prompt, label),
      addEntry: (entry) => this.addEntry(entry),
      recordDiagnostic: (entryId, data) => this.recordDiagnostic(entryId, data),
      progress: (phase, speaker, message) => this.progress(phase, speaker, message),
      warn: (operation, error, recovery) => this.warn(operation, error, recovery),
      checkAborted: () => this.checkAborted(),
    });
  }

  // ── AI call wrapper ────────────────────────────────────────

  private async throttle(): Promise<void> {
    if (this._rateLimitBackoffMs > 0 && this._lastRateLimitTime > 0) {
      const sinceRateLimit = Date.now() - this._lastRateLimitTime;
      if (sinceRateLimit < this._rateLimitBackoffMs) {
        const waitMs = this._rateLimitBackoffMs - sinceRateLimit;
        this.progress('generating', undefined, `Rate-limited — waiting ${Math.ceil(waitMs / 1000)}s`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
    const delay = this.config.throttleMs ?? 0;
    if (delay > 0 && this.lastApiCallTime > 0) {
      const elapsed = Date.now() - this.lastApiCallTime;
      if (elapsed < delay) {
        await new Promise(r => setTimeout(r, delay - elapsed));
      }
    }
  }

  private async stageGenerate(prompt: string, model: string, options: { temperature?: number; timeoutMs?: number }, label: string): Promise<string> {
    await this.throttle();
    this.progress('generating', undefined, label);
    const start = Date.now();
    try {
      const text = await this.adapter.generateText(prompt, model, { ...options, timeoutMs: options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS });
      this.lastApiCallTime = Date.now();
      this.apiCallCount++;
      this.totalResponseTimeMs += Date.now() - start;
      clearRateLimitBackoff(this._internal);
      return text;
    } catch (err) {
      this.lastApiCallTime = Date.now();
      if (isRateLimitError(err)) recordRateLimit(this._internal);
      throw err;
    }
  }

  private async generate(prompt: string, label: string, timeoutMs?: number): Promise<string> {
    await this.throttle();
    this.progress('generating', undefined, label);
    const start = Date.now();
    try {
      const text = await this.adapter.generateText(prompt, this.config.model, {
        temperature: this.config.temperature ?? DEFAULT_TEMPERATURE,
        timeoutMs: timeoutMs ?? DEFAULT_AI_TIMEOUT_MS,
        signal: this.config.signal,
      });
      const elapsed = Date.now() - start;
      this.lastApiCallTime = Date.now();
      this.apiCallCount++;
      this.totalResponseTimeMs += elapsed;
      clearRateLimitBackoff(this._internal);
      return text;
    } catch (err) {
      this.lastApiCallTime = Date.now();
      if (isRateLimitError(err)) recordRateLimit(this._internal);
      throw err;
    }
  }

  private async generateViaUsage(usageId: string, prompt: string, label: string): Promise<string> {
    const deps = this.config.usageDeps;
    if (!deps) return this.generate(prompt, label);
    await this.throttle();
    this.progress('generating', undefined, label);
    const start = Date.now();
    try {
      const result = await callByUsage(usageId, { prompt }, deps);
      const elapsed = Date.now() - start;
      this.lastApiCallTime = Date.now();
      this.apiCallCount++;
      this.totalResponseTimeMs += elapsed;
      clearRateLimitBackoff(this._internal);
      return result.text;
    } catch (err) {
      this.lastApiCallTime = Date.now();
      if (isRateLimitError(err)) recordRateLimit(this._internal);
      throw err;
    }
  }

  private async executeWithModelFailover<T>(
    speaker: string,
    execute: (model: string) => Promise<T>,
  ): Promise<T> {
    const primaryModel = resolveModelForSpeaker(this._internal, speaker);
    const chain = buildFailoverChain(this._internal, primaryModel);
    if (chain.length <= 1) return execute(primaryModel);

    let lastFailureReason = '';
    for (let i = 0; i < chain.length; i++) {
      try {
        const result = await execute(chain[i]);
        if (i > 0) {
          if (!this.config.speakerModels) this.config.speakerModels = {};
          this.config.speakerModels[speaker] = chain[i];
          if (this.session) {
            if (!this.session.speaker_models) this.session.speaker_models = {};
            this.session.speaker_models[speaker] = chain[i];
            if (!this.session.speaker_model_failovers) this.session.speaker_model_failovers = {};
            this.session.speaker_model_failovers[speaker] = chain[i];
          }
          getGlobalRecorder()?.record({
            type: 'ai.fallback',
            component: 'debateEngine',
            level: 'warn',
            debate_id: this.session?.id,
            message: `Speaker ${speaker} failover: ${primaryModel} → ${chain[i]}`,
            data: { characterId: speaker, originalModel: primaryModel, failureReason: lastFailureReason, newModel: chain[i], attemptedChain: chain.slice(0, i + 1) },
          });
        }
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const lower = msg.toLowerCase();
        const isHardFailure =
          lower.includes('403') || lower.includes('401') ||
          lower.includes('500') || lower.includes('empty') ||
          lower.includes('failed after') || lower.includes('permission') ||
          lower.includes('unauthorized') || lower.includes('forbidden');

        if (isHardFailure && i < chain.length - 1) {
          lastFailureReason = msg.slice(0, 300);
          getGlobalRecorder()?.record({
            type: 'system.error',
            component: 'debateEngine',
            level: 'warn',
            debate_id: this.session?.id,
            message: `Speaker ${speaker} model ${chain[i]} hard failure, trying ${chain[i + 1]}`,
            error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
          });
          this.warn(`Speaker ${speaker} model ${chain[i]}`, err, `Trying fallback ${chain[i + 1]}`);
          continue;
        }
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'debateEngine',
          level: 'error',
          debate_id: this.session?.id,
          message: `Speaker ${speaker} model ${chain[i]} failed (no more fallbacks)`,
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        throw err;
      }
    }
    throw new Error(`All models failed for speaker ${speaker}`);
  }

  private async generateWithEvaluator(prompt: string, label: string, timeoutMs?: number): Promise<string> {
    await this.throttle();
    const evalModel = resolveStageModel(this._internal, 'evaluator');
    this.progress('generating', undefined, label);
    const start = Date.now();
    try {
      const text = await this.adapter.generateText(prompt, evalModel, {
        temperature: EVALUATOR_TEMPERATURE,
        timeoutMs: timeoutMs ?? DEFAULT_AI_TIMEOUT_MS,
        signal: this.config.signal,
      });
      const elapsed = Date.now() - start;
      this.lastApiCallTime = Date.now();
      this.apiCallCount++;
      this.totalResponseTimeMs += elapsed;
      clearRateLimitBackoff(this._internal);
      return text;
    } catch (err) {
      this.lastApiCallTime = Date.now();
      if (isRateLimitError(err)) recordRateLimit(this._internal);
      throw err;
    }
  }

  private progress(phase: string, speaker?: string, message?: string, round?: number): void {
    this.onProgress?.({
      phase,
      speaker,
      round,
      totalRounds: this.config.rounds,
      message: message ?? phase,
    });
  }

  briefProgress(phase: string, speaker: string | undefined, message: string, brief: import('./debateEngine/internals.js').DebateProgress['brief']): void {
    this.onProgress?.({ phase, speaker, totalRounds: this.config.rounds, message, brief });
  }

  private emitSnapshot(trigger: 'round_complete' | 'error'): void {
    try {
      this.config.onSnapshot?.(this.session, trigger);
    } catch (snapshotErr) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'debate-engine', level: 'warn',
        debate_id: this.session?.id,
        message: `Snapshot callback failed (trigger=${trigger})`,
        error: { name: (snapshotErr as Error).name ?? 'Error', message: String(snapshotErr), stack: (snapshotErr as Error).stack },
      });
    }
  }

  /** Log a non-fatal warning — records in diagnostics, flight recorder, and emits progress */
  private warn(operation: string, error: unknown, recovery: string): void {
    const msg = error instanceof Error ? error.message : String(error);
    const warning = `[WARNING] ${operation}: ${msg}. Recovery: ${recovery}`;
    process.stderr.write(`[debate-engine] ${warning}\n`);
    this.onProgress?.({ phase: 'warning', message: warning });
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'debate-engine', level: 'warn',
      debate_id: this.session?.id,
      message: `${operation}: ${msg}`,
      error: { name: error instanceof Error ? error.name : 'Warning', message: msg, stack: error instanceof Error ? error.stack : undefined },
    });
  }

  /** Check if the debate has been cancelled via AbortSignal. Throws ActionableError if aborted. */
  private checkAborted(): void {
    if (this.config.signal?.aborted) {
      throw new ActionableError({
        goal: 'Continue debate execution',
        problem: 'Debate was cancelled by user',
        location: 'DebateEngine.checkAborted',
        nextSteps: ['Start a new debate if desired'],
      });
    }
  }

  /** Enrich taxonomy refs with relevance scores and primary flags from the last injection manifest. */
  private _nodeLabelMap?: Map<string, string>;

  /** Pre-loaded source evidence index (lazy). */
  private _sourceEvidenceIndex?: import('./evidenceFromSummaries.js').SourceEvidenceIndex;
  private _docTitles?: import('./evidenceFromSummaries.js').DocMetaMap;

  private get sourceEvidenceIndex(): import('./evidenceFromSummaries.js').SourceEvidenceIndex | undefined {
    if (this._sourceEvidenceIndex !== undefined) return this._sourceEvidenceIndex;
    try {
      const __dir = path.dirname(fileURLToPath(import.meta.url));
      const root = resolveRepoRoot(__dir);
      const dataRoot = resolveDataRoot(root);
      const indexPath = path.join(dataRoot, 'taxonomy', 'source_evidence_index.json');
      if (fs.existsSync(indexPath)) {
        this._sourceEvidenceIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        return this._sourceEvidenceIndex;
      }
    } catch (err) { getGlobalRecorder()?.record({ type: 'state.error', component: 'debate-engine', level: 'warn', debate_id: this.session?.id, message: 'Source evidence index unavailable', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); }
    this._sourceEvidenceIndex = undefined as unknown as import('./evidenceFromSummaries.js').SourceEvidenceIndex;
    return undefined;
  }

  /** Map of doc_id → source metadata with title, URL, provenance (lazy). */
  private get docTitles(): import('./evidenceFromSummaries.js').DocMetaMap | undefined {
    if (this._docTitles !== undefined) return this._docTitles;
    try {
      const __dir = path.dirname(fileURLToPath(import.meta.url));
      const root = resolveRepoRoot(__dir);
      const configPath = path.join(root, '.aitriad.json');
      if (!fs.existsSync(configPath)) return undefined;
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const sourcesRoot = config.sources_root ? path.resolve(root, config.sources_root) : null;
      if (!sourcesRoot || !fs.existsSync(sourcesRoot)) return undefined;
      const metaMap: Record<string, { title: string; resolved_url?: string; provenance_label?: string }> = {};
      for (const entry of fs.readdirSync(sourcesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const metaPath = path.join(sourcesRoot, entry.name, 'metadata.json');
        if (!fs.existsSync(metaPath)) continue;
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          if (meta.title) {
            const docMeta: { title: string; resolved_url?: string; provenance_label?: string } = { title: meta.title };
            if (meta.resolved_url) docMeta.resolved_url = meta.resolved_url;
            if (meta.provenance?.length > 0 && meta.provenance[0].id) docMeta.provenance_label = meta.provenance[0].id;
            if (!docMeta.resolved_url && meta.url) docMeta.resolved_url = meta.url;
            metaMap[entry.name] = docMeta;
          }
        } catch { /* telemetry — silent by design: per-file meta parse is best-effort */ }
      }
      this._docTitles = Object.keys(metaMap).length > 0 ? metaMap : undefined;
      return this._docTitles;
    } catch (err) { getGlobalRecorder()?.record({ type: 'state.error', component: 'debate-engine', level: 'warn', debate_id: this.session?.id, message: 'Doc titles loading failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); return undefined; }
  }

  /** Post-turn summarization (DT-2): generate brief + medium summaries. Non-blocking — failure is logged, not thrown. */
  private async summarizeEntry(entry: TranscriptEntry): Promise<void> {
    // Only summarize substantive entries (openings, statements, fact-checks)
    if (!['opening', 'statement', 'fact-check'].includes(entry.type)) return;
    // Skip if already summarized
    if (entry.summaries) return;

    try {
      const speaker = (POVER_INFO as Record<string, { label: string }>)[entry.speaker]?.label ?? entry.speaker;
      const prompt = entrySummarizationPrompt(entry.content, speaker);
      const raw = await this.adapter.generateText(prompt, resolveStageModel(this._internal, 'summary'), {
        temperature: SUMMARIZATION_TEMPERATURE,
        maxTokens: SUMMARIZATION_MAX_TOKENS,
        timeoutMs: SUMMARIZATION_TIMEOUT_MS,
      });
      this.apiCallCount++;

      // Parse JSON response
      const cleaned = raw.replace(/```json?\s*/g, '').replace(/```\s*/g, '').trim();
      const parsed = JSON.parse(cleaned) as { brief?: string; medium?: string };
      if (parsed.brief && parsed.medium) {
        entry.summaries = { brief: parsed.brief, medium: parsed.medium };
      }
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'ai.error', component: 'debate-engine', level: 'warn', debate_id: this.session?.id, message: 'Entry summarization failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      this.warn('summarizeEntry', err, 'Entry will display at full detail only');
    }
  }

  private addEntry(entry: Omit<TranscriptEntry, 'id' | 'timestamp'>): TranscriptEntry {
    // Guard: reject duplicate opening statements per speaker (defense-in-depth for t/919)
    if (entry.type === 'opening' && entry.speaker !== 'system') {
      const existing = this.session.transcript.find(
        e => e.type === 'opening' && e.speaker === entry.speaker,
      );
      if (existing) {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'debate-engine', level: 'warn',
          debate_id: this.session?.id,
          message: `Duplicate opening blocked for ${entry.speaker} — already has opening ${existing.id}`,
        });
        return existing;
      }
    }

    const full: TranscriptEntry = { id: generateId(), timestamp: nowISO(), ...entry };
    this.session.transcript.push(full);

    // Post-hoc vocabulary disambiguation for debater statements
    if (this.config.vocabulary?.colloquialTerms &&
      (full.type === 'opening' || full.type === 'statement') &&
      full.speaker !== 'system' && full.speaker !== 'moderator' && full.speaker !== 'user') {
      const result = disambiguateTerms(
        full.content,
        full.speaker as CampOrigin,
        this.config.vocabulary.colloquialTerms,
      );
      if (result.terms.length > 0) {
        full.metadata = full.metadata ?? {};
        full.metadata.vocabulary_resolutions = result.terms
          .filter(t => !t.ambiguous)
          .map(t => ({ colloquial: t.bare, canonical: t.canonical, confidence: t.confidence, offset: t.offset }));
        if (result.ambiguousCount > 0) {
          full.metadata.vocabulary_ambiguities = result.terms
            .filter(t => t.ambiguous)
            .map(t => ({ colloquial: t.bare, offset: t.offset }));
        }
      }
    }

    return full;
  }

  private recordDiagnostic(entryId: string, data: Partial<EntryDiagnostics>): void {
    const diag = this.session.diagnostics!;
    diag.entries[entryId] = { ...diag.entries[entryId], ...data };

    // Aggregate per-stage token counts into entry-level totals
    const stages = data.stage_diagnostics;
    if (stages && stages.length > 0) {
      let entryInput = 0;
      let entryOutput = 0;
      let hasTokens = false;
      for (const s of stages) {
        if (s.input_tokens != null) { entryInput += s.input_tokens; hasTokens = true; }
        if (s.output_tokens != null) { entryOutput += s.output_tokens; hasTokens = true; }
      }
      if (hasTokens) {
        diag.entries[entryId].input_tokens = entryInput;
        diag.entries[entryId].output_tokens = entryOutput;
        // Accumulate into overview totals
        diag.overview.total_input_tokens = (diag.overview.total_input_tokens ?? 0) + entryInput;
        diag.overview.total_output_tokens = (diag.overview.total_output_tokens ?? 0) + entryOutput;
      }
    }
  }

  /** Update situation citation tracking (t/192). Recomputes from full transcript each turn. */
  private updateSituationCitations(_currentRefs: TaxonomyRef[]): void {
    computeSituationCitations(this.session);
  }

  // ── Early return (stopAfterStage) ──────────────────────────
  private earlyReturn(startTime: number): DebateSession {
    this.session.updated_at = nowISO();
    if (this.session.diagnostics) {
      this.session.diagnostics.overview.total_ai_calls = this.apiCallCount;
      this.session.diagnostics.overview.total_response_time_ms = this.totalResponseTimeMs;
      this.session.diagnostics.overview.total_elapsed_ms = Date.now() - startTime;
    }
    return this.session;
  }
}
