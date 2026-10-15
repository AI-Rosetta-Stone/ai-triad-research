// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { DebateEngineInternals } from '../internals.js';
import { type DebatePhase } from '../../types.js';
import { formatRecentTranscript, getMoveName } from '../../helpers.js';
import { resolveTurnValidationConfig } from '../../turnValidator.js';
import { executeTurnWithRetry, type TurnRetryCallbacks, type TurnRetryInput } from '../../orchestration.js';
import { getGlobalRecorder } from '../../../flight-recorder/index.js';
import { runTurnPipeline, assemblePipelineResult, type TurnPipelineInput } from '../../turnPipeline.js';
import { resolveModelForSpeaker, recordRateLimit, clearRateLimitBackoff, isRateLimitError } from '../modelResolution.js';
import { enrichTaxonomyRefs, getRelevantTaxonomyContext, formatDebaterEdgeContext } from '../taxonomyContext.js';
import { getCommitmentContext, getEstablishedPointsContext } from '../context.js';
import {
  DIVERSITY_MIN_ACTIVATION_ROUND,
  DIVERSITY_REPETITION_RATE_THRESHOLD,
  PRIOR_MOVES_DIVERSITY_WINDOW,
  JUDGE_TIMEOUT_MS,
} from '../../debateConfig.js';

// ── Diversity-injection round (t/1280) ─────────────────────

export function shouldTriggerDiversityRound(engine: DebateEngineInternals, round: number, phase: string): boolean {
  if (!engine.config.enableDiversityRound) return false;
  if (phase !== 'argumentation') return false;
  if (engine.session.diversity_round_fired != null) return false;
  if (round < DIVERSITY_MIN_ACTIVATION_ROUND) return false;

  const signals = engine.session.convergence_signals ?? [];
  const recentSignals = signals.filter(s => s.round >= round - 1);
  if (recentSignals.length < 2) return false;
  const recycledCount = recentSignals.filter(
    s => s.argument_redundancy?.semantically_recycled === true,
  ).length;
  const repetitionRate = recycledCount / recentSignals.length;
  if (repetitionRate < DIVERSITY_REPETITION_RATE_THRESHOLD) return false;

  const diag = engine.session.diagnostics;
  if (!diag) return false;
  const traces: { round: number; an_nodes_added_ids: string[] }[] = [];
  for (const entryDiag of Object.values(diag.entries)) {
    if (entryDiag.extraction_trace) {
      traces.push({
        round: entryDiag.extraction_trace.round,
        an_nodes_added_ids: entryDiag.extraction_trace.an_nodes_added_ids,
      });
    }
  }
  const recentTraces = traces
    .filter(t => t.round >= round - 1)
    .sort((a, b) => b.round - a.round);
  if (recentTraces.length < 2) return false;
  const noNewAN = recentTraces.slice(0, 2).every(t => t.an_nodes_added_ids.length === 0);
  if (!noNewAN) return false;

  return true;
}

export async function runDiversityRound(engine: DebateEngineInternals, round: number): Promise<void> {
  engine.session.diversity_round_fired = round;
  const phase: DebatePhase = 'argumentation';

  engine.addEntry({
    type: 'system',
    speaker: 'system',
    content: `[Diversity round] Stagnation detected — running independent generation (round ${round}). Each POV generates without peer context to surface suppressed arguments.`,
    taxonomy_refs: [],
    metadata: { diversity_round: true, trigger_round: round },
  });
  engine.progress('debate', undefined, `Diversity-injection round ${round} (independent generation)`);

  for (const pov of engine.config.activePovers) {
    if ((pov as string) === 'user') continue;
    engine.checkAborted();

    const info = engine.getSoulForSpeaker(pov);
    engine.progress('debate', pov, `${info.label} — independent exploration (diversity round)`);

    const priorRefs = engine.session.transcript
      .filter(e => e.speaker === pov && e.type !== 'opening')
      .slice(-2)
      .flatMap(e => (e.taxonomy_refs ?? []).map(r => r.node_id));

    const taxonomyContext = await getRelevantTaxonomyContext(engine, info.pov, priorRefs);
    const commitmentContext = getCommitmentContext(engine, pov);
    const establishedPoints = getEstablishedPointsContext(engine, pov);
    const { text: edgeContext } = formatDebaterEdgeContext(engine, info.pov);

    const selfTranscript = engine.session.transcript.filter(
      e => e.speaker === pov || e.speaker === 'system' || e.speaker === 'user' || e.type === 'opening',
    );
    const recentTranscript = formatRecentTranscript(selfTranscript, 8, engine.session.context_summaries);

    const debaterTurns = engine.session.transcript
      .filter(e => e.speaker === pov && (e.type === 'opening' || e.type === 'statement'));
    const priorMoves = debaterTurns
      .filter(e => e.metadata)
      .flatMap(e => ((e.metadata as Record<string, unknown>)?.move_types as (string | import('../../helpers.js').MoveAnnotation)[]) ?? [])
      .map(m => getMoveName(m))
      .slice(-PRIOR_MOVES_DIVERSITY_WINDOW);
    let turnsSinceLastConcession = debaterTurns.length;
    for (let i = debaterTurns.length - 1; i >= 0; i--) {
      const moves = ((debaterTurns[i].metadata as Record<string, unknown>)?.move_types as (string | import('../../helpers.js').MoveAnnotation)[]) ?? [];
      if (moves.some(m => getMoveName(m).includes('CONCEDE'))) {
        turnsSinceLastConcession = debaterTurns.length - 1 - i;
        break;
      }
    }

    const taxMap = engine.taxonomy as unknown as Record<string, { nodes?: { id: string }[] } | undefined>;
    const povFile = taxMap[info.pov];
    const availablePovNodeIds = [
      ...(povFile?.nodes?.map(n => n.id) ?? []),
      ...(taxMap.situations?.nodes?.map(n => n.id) ?? []),
    ];

    const pipelineInput: TurnPipelineInput = {
      label: info.label,
      pov: info.pov,
      soul: info,
      personality: info.personality,
      opponentSouls: Object.fromEntries(
        engine.config.activePovers
          .filter(id => id !== pov && (id as string) !== 'user')
          .map(id => [id, engine.getSoulForSpeaker(id)]),
      ),
      topic: engine.session.topic.final,
      background: engine.session.topic.background || undefined,
      taxonomyContext,
      commitmentContext,
      establishedPoints,
      edgeContext,
      concessionHint: '',
      recentTranscript,
      focusPoint: 'Explore fresh perspectives and under-represented arguments from your worldview that have not yet been raised in this debate.',
      addressing: 'general',
      phase,
      priorMoves,
      turnsSinceLastConcession,
      priorRefs,
      availablePovNodeIds,
      availablePolicyIds: [...engine.getPolicyIds()],
      topicScope: engine.session.topic.scope ?? undefined,
      topicStructure: engine.session.topic_structure ?? undefined,
      salienceBeacon: engine.config.salienceBeacon ?? false,
      sourceContent: engine.session.document_analysis ? undefined : engine.config.sourceContent,
      documentAnalysis: engine.session.document_analysis,
      audience: engine.config.audience,
      model: resolveModelForSpeaker(engine, pov),
      briefModel: engine.config.stageModels?.brief,
      planModel: engine.config.stageModels?.plan,
      draftModel: engine.config.stageModels?.draft,
      citeModel: engine.config.stageModels?.cite,
      useBackgroundPrompt: engine.config.useBackgroundPrompt,
      ...(engine.config.temperature != null ? {
        stageTemperatures: {
          brief_temperature: engine.config.temperature,
          plan_temperature: engine.config.temperature,
          draft_temperature: engine.config.temperature,
          cite_temperature: engine.config.temperature,
        },
      } : {}),
    };

    const boundStageGenerate = engine.stageGenerate.bind(engine);
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

    const knownIds = engine.getKnownNodeIds();
    const vConfig = resolveTurnValidationConfig(engine.config.turnValidation);
    const preCheckGenerate = !vConfig.skipPreCheck ? boundStageGenerate : undefined;
    pipelineInput.preCheckModel = vConfig.preCheckModel;
    pipelineInput.skipPreCheck = vConfig.skipPreCheck;

    const retryCallbacks: TurnRetryCallbacks = {
      runPipeline: (input) => runTurnPipeline(
        input, boundStageGenerate,
        (_stage, label) => engine.progress('generating', pov, label),
        envelopeGenerate,
        preCheckGenerate,
      ),
      assembleResult: (result) => assemblePipelineResult(result, knownIds),
      callJudge: (p, l) => engine.generateWithModel(p, l, vConfig.judgeModel, JUDGE_TIMEOUT_MS),
      callJudgeFallback: engine.config.model !== vConfig.judgeModel
        ? (p, l) => engine.generateWithModel(p, l, engine.config.model, 20000)
        : undefined,
    };

    const retryInput: TurnRetryInput = {
      pipelineInput,
      validationConfig: engine.config.turnValidation,
      model: resolveModelForSpeaker(engine, pov),
      speaker: pov,
      round,
      priorTurns: engine.session.transcript
        .filter(e => e.speaker === pov && e.type !== 'opening')
        .slice(-2),
      recentTurns: engine.session.transcript
        .filter(e => e.speaker !== 'system' && e.speaker !== 'user')
        .slice(-2),
      knownNodeIds: engine.getKnownNodeIds(),
      policyIds: engine.getPolicyIds(),
      audience: engine.config.audience,
    };

    engine.checkAborted();
    getGlobalRecorder()?.setEventContext({
      debate_id: engine.session.id,
      run_id: engine.session.run_id,
      speaker: pov,
      phase,
      round,
      turn_index: engine.session.transcript.length,
    });

    const turnResult = await engine.executeWithModelFailover(pov, async (model) => {
      pipelineInput.model = model;
      retryInput.model = model;
      return executeTurnWithRetry(retryInput, retryCallbacks);
    });
    const { statement, taxonomyRefs, meta, validation, pipelineResult } = turnResult;
    enrichTaxonomyRefs(engine, taxonomyRefs);
    engine.updateHintStreaks(pov, validation.repairHints ?? []);

    const caveats = [...(validation.repairHints ?? [])];
    const evidenceDiag = pipelineResult.stage_diagnostics.find(s => s.stage === 'evidence');
    const ungrounded = (evidenceDiag?.work_product as Record<string, unknown>)?.ungrounded_claims as
      Array<{ claim: string; reason: string }> | undefined;
    if (ungrounded?.length) {
      for (const uc of ungrounded) caveats.push(`[Ungrounded] ${uc.claim}`);
    }

    const entry = engine.addEntry({
      type: 'statement',
      speaker: pov,
      content: statement,
      taxonomy_refs: taxonomyRefs,
      policy_refs: meta.policy_refs,
      addressing: 'all',
      caveats: caveats.length > 0 ? caveats : undefined,
      model: engine.config.speakerModels ? resolveModelForSpeaker(engine, pov) : undefined,
      provider_model: engine.adapter.lastProviderModel,
      metadata: {
        round,
        debate_phase: phase,
        move_types: meta.move_types ?? [],
        diversity_round: true,
        extracted_claims_accepted: (meta as Record<string, unknown>).extracted_claims_accepted ?? 0,
      },
      degraded: pipelineResult.degraded_turn,
    });

    engine.checkAborted();
    await engine._claimPipeline.extractClaims(statement, pov, entry.id, taxonomyRefs.map(r => r.node_id), meta.my_claims);
  }

  engine.emitSnapshot('round_complete');
}
