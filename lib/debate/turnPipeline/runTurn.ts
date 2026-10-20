// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { StageDiagnostics, BriefWorkProduct, PlanWorkProduct, DraftWorkProduct, CiteWorkProduct, TurnPipelineResult, PromptComponentChars, DraftQualityGateResult, EditingMeta } from '../types.js';
import { ActionableError } from '../errors.js';
import { getGlobalRecorder } from '../../flight-recorder/index.js';
import { validateDraftStage, validateCiteStage, validatePlanStage, isFillerRelevance, parseDraftQualityResult, resolveMoveName } from '../turnValidator.js';
import { wordOverlap, getMoveName } from '../helpers.js';
import type { MoveAnnotation } from '../helpers.js';
import { briefStagePrompt, briefStagePromptV2, planStagePrompt, draftStagePrompt, citeStagePrompt, citeRetryPrompt, draftQualityCheckPrompt, assumptionsExtractionPrompt, classifyOffScopeDrift, offScopeRepairHint } from '../prompts.js';
import { flattenEnvelope } from '../cacheTypes.js';
import { briefStageEnvelope, planStageEnvelope, draftStageEnvelope, citeStageEnvelope } from '../envelopes.js';
import { inferBackend } from '../../ai-client/registry.js';
import { buildCitationBank, buildScopedCitationBank, formatCitationBank, scrubCitations, validateCitationsAgainstBank, extractCitationMatches } from '../citationResolution.js';
import type { CitationBankEntry, CitationResolutionDiagnostics } from '../citationResolution.js';
import type { DocMetaMap } from '../evidenceFromSummaries.js';
import { sanitizeNodeIds } from '../nodeIdUtils.js';
import { classifyUrl } from '../urlClassify.js';
import { buildStageInput, parseStageResponse, tagProvenance, toPromptJson } from './runTurn-stages.js';
import { splitIntoParagraphs, classifyDraftHintFields, buildFieldFreezeBlock, mergeFrozenDraftFields, ALL_DRAFT_FIELDS } from './repair.js';
import type { DraftField } from './repair.js';
import { buildRepairBlock, trySpecificityMicroFix, tryInterventionMicroFix, tryDirectiveMicroFix } from './microFix.js';
import { extractDraftMeta } from './assemble.js';
import { DEFAULT_STAGE_TEMPERATURES } from './types.js';
import type { TurnPipelineInput, StageGenerateFn, StageProgressFn, EnvelopeGenerateFn } from './types.js';
import { runReadabilityEditPass } from './readabilityEditPass.js';

export async function runTurnPipeline(
  input: TurnPipelineInput,
  generate: StageGenerateFn,
  onProgress?: StageProgressFn,
  envelopeGenerate?: EnvelopeGenerateFn,
  preCheckGenerate?: StageGenerateFn,
): Promise<TurnPipelineResult> {
  // Default pre-check to the main generate callback so callers that don't
  // explicitly pass it still get the quality gate (t/317).
  const effectivePreCheckGenerate = preCheckGenerate ?? generate;

  const temps = {
    ...DEFAULT_STAGE_TEMPERATURES,
    ...input.stageTemperatures,
  };
  const briefModel = input.briefModel ?? input.model;
  const planModel = input.planModel ?? input.model;
  const draftModel = input.draftModel ?? input.model;
  const citeModel = input.citeModel ?? input.model;
  const stageInput = buildStageInput(input);
  const stageDiags: StageDiagnostics[] = [];
  const pipelineStart = Date.now();
  const isOuterRetry = (input.repairHints?.length ?? 0) > 0;
  const MAX_STAGE_RETRIES = isOuterRetry ? 0 : 3;
  let degradedTurn = false;
  let step = 0;
  const totalStages =
    6  // always: brief, plan, evidence, draft, postDraft, cite
    + ((!isOuterRetry && !input.skipPreCheck && input.preCheckModel) ? 1 : 0); // draft_quality

  // Per-component char counts for prompt growth forensics (t/221)
  const hintsChars =
    (input.concessionHint?.length ?? 0) +
    (input.strategicHints?.reduce((sum, h) => sum + h.length, 0) ?? 0) +
    (input.priorFlaggedHints?.reduce((sum, h) => sum + h.length, 0) ?? 0);
  const promptComponentChars: PromptComponentChars = {
    taxonomy_chars: input.taxonomyContext?.length ?? 0,
    transcript_chars: input.recentTranscript?.length ?? 0,
    hints_chars: hintsChars,
    edge_chars: input.edgeContext?.length ?? 0,
    commitment_chars: input.commitmentContext?.length ?? 0,
    an_summary_chars: input.establishedPoints?.length ?? 0,
  };

  // ── Stage 1: BRIEF ──
  let brief!: BriefWorkProduct;
  let briefJson!: string;
  let t0: number;
  let elapsed: number;

  if (input.frozenBrief) {
    // Frozen from prior pipeline run — skip generation, reuse output
    brief = input.frozenBrief;
    briefJson = toPromptJson(brief);
    console.log(`[pipeline] Brief stage FROZEN — reusing prior output`);
  } else {
    for (let briefAttempt = 0; briefAttempt <= MAX_STAGE_RETRIES; briefAttempt++) {
      onProgress?.('brief', `${input.label} is briefing${briefAttempt > 0 ? ` (retry ${briefAttempt})` : ''}...`, briefAttempt === 0 ? { step: ++step, total: totalStages } : undefined);
      getGlobalRecorder()?.record({
        type: 'turn.stage', component: 'turn-pipeline', level: 'info',
        speaker: input.label, debate_id: (input as any).debate_id, turn_id: (input as any).turn_id,
        message: `${input.label} entering BRIEF stage (attempt ${briefAttempt})`,
        data: { stage: 'brief', action: 'enter', attempt: briefAttempt },
      });
      let briefPrompt: string;
      let briefRaw: string;
      let briefUsage: { inputTokens: number; outputTokens: number } | undefined;
      t0 = Date.now();
      if (envelopeGenerate) {
        const env = briefStageEnvelope(stageInput);
        briefPrompt = flattenEnvelope(env);
        const resp = await envelopeGenerate({ envelope: env, model: briefModel, options: { temperature: temps.brief_temperature } }, `${input.label} brief`);
        briefRaw = resp.text;
        briefUsage = resp.usage;
      } else {
        briefPrompt = stageInput.useBackgroundPrompt ? briefStagePromptV2(stageInput) : briefStagePrompt(stageInput);
        briefRaw = await generate(briefPrompt, briefModel, { temperature: temps.brief_temperature }, `${input.label} brief`);
      }
      elapsed = Date.now() - t0;
      const briefParsed = parseStageResponse<BriefWorkProduct>(briefRaw, 'brief');
      stageDiags.push({
        stage: 'brief', prompt: briefPrompt, raw_response: briefRaw,
        model: briefModel, temperature: temps.brief_temperature,
        response_time_ms: elapsed, work_product: briefParsed.product as unknown as Record<string, unknown>,
        parse_error: briefParsed.error,
        retry_trigger: isOuterRetry ? 'orchestration-rerun' : briefAttempt > 0 ? 'stage-retry' : 'initial',
        prompt_component_chars: promptComponentChars,
        input_tokens: briefUsage?.inputTokens,
        output_tokens: briefUsage?.outputTokens,
      });
      if (briefParsed.error) {
        if (briefAttempt < MAX_STAGE_RETRIES) {
          getGlobalRecorder()?.record({
            type: 'turn.repair', component: 'turn-pipeline', level: 'warn',
            speaker: input.label,
            message: `BRIEF parse failed (attempt ${briefAttempt}), retrying`,
            data: { stage: 'brief', attempt: briefAttempt, error: briefParsed.error },
          });
          console.log(`[pipeline] Brief parse failed (attempt ${briefAttempt}), retrying: ${briefParsed.error}`);
          continue;
        }
        // Retries exhausted — degrade the turn rather than aborting the debate (t/2229).
        getGlobalRecorder()?.record({
          type: 'turn.repair', component: 'turn-pipeline', level: 'warn',
          speaker: input.label,
          message: `BRIEF exhausted after ${briefAttempt + 1} attempt(s) — degrading turn`,
          data: { stage: 'brief', attempt: briefAttempt, error: briefParsed.error },
        });
        console.log(`[pipeline] Brief stage exhausted after ${briefAttempt + 1} attempt(s) — degrading turn`);
        const lastBriefDiag = stageDiags[stageDiags.length - 1];
        (lastBriefDiag as Record<string, unknown>).degraded = true;
        brief = briefParsed.product;
        briefJson = '{}';
        degradedTurn = true;
        break;
      }
      brief = tagProvenance(briefParsed.product, {
        pipeline_run: isOuterRetry ? 1 : 0,
        stage: 'brief', attempt: briefAttempt,
        model: briefModel, timestamp: new Date().toISOString(),
      });
      briefJson = toPromptJson(brief);
      getGlobalRecorder()?.record({
        type: 'turn.stage', component: 'turn-pipeline', level: 'info',
        speaker: input.label, duration_ms: elapsed,
        message: `${input.label} completed BRIEF stage (attempt ${briefAttempt})`,
        data: { stage: 'brief', action: 'exit', attempt: briefAttempt, duration_ms: elapsed },
      });
      break;
    }
  }

  // ── Stage 1.5: BRIEF node ID sanitization ──
  // LLMs sometimes hallucinate node ID prefixes (e.g., sit-cc-040 instead of cc-040).
  // Validate and correct all node IDs in the BRIEF output BEFORE they cascade into PLAN/DRAFT/CITE.
  const knownNodeIds = new Set(input.availablePovNodeIds ?? []);
  if (knownNodeIds.size > 0 && brief.key_claims_to_address) {
    let briefCorrected = false;
    for (const claim of brief.key_claims_to_address) {
      if (!claim.grounding?.length) continue;
      const groundingIds = claim.grounding.map(g => g.node_id);
      const result = sanitizeNodeIds(groundingIds, knownNodeIds);
      if (result.corrections.length > 0 || result.removed.length > 0) {
        briefCorrected = true;
        for (const c of result.corrections) {
          console.log(`[pipeline] Brief ID correction: ${c.from} → ${c.to}`);
        }
        for (const r of result.removed) {
          console.log(`[pipeline] Brief ID removed (unknown): ${r}`);
        }
        // Rebuild grounding with corrected IDs only
        claim.grounding = claim.grounding
          .map(g => {
            const correction = result.corrections.find(c => c.from === g.node_id);
            if (correction) return { ...g, node_id: correction.to };
            if (result.removed.includes(g.node_id)) return null;
            return g;
          })
          .filter((g): g is NonNullable<typeof g> => g !== null);
      }
    }
    if (briefCorrected) {
      // Re-serialize so downstream stages (PLAN/DRAFT) see the corrected IDs
      briefJson = toPromptJson(brief);
    }
  }

  // ── Stage 2: PLAN (with per-stage validation + retry) ──
  const isFirstRound = (input.priorMoves ?? []).length === 0;
  let plan: PlanWorkProduct | undefined;
  let planJson = '';

  if (input.frozenPlan) {
    // Frozen from prior pipeline run — skip generation, reuse output
    plan = input.frozenPlan;
    planJson = toPromptJson(plan);
    console.log(`[pipeline] Plan stage FROZEN — reusing prior output`);
  } else {
    let planRepairHints: string[] = [];
    for (let planAttempt = 0; planAttempt <= MAX_STAGE_RETRIES; planAttempt++) {
      onProgress?.('plan', `${input.label} is planning${planAttempt > 0 ? ` (retry ${planAttempt})` : ''}...`, planAttempt === 0 ? { step: ++step, total: totalStages } : undefined);
      getGlobalRecorder()?.record({
        type: 'turn.stage', component: 'turn-pipeline', level: 'info',
        speaker: input.label,
        message: `${input.label} entering PLAN stage (attempt ${planAttempt})`,
        data: { stage: 'plan', action: 'enter', attempt: planAttempt },
      });
      let planPromptText: string;
      let planRaw: string;
      let planUsage: { inputTokens: number; outputTokens: number } | undefined;
      t0 = Date.now();
      if (envelopeGenerate) {
        const env = planStageEnvelope(stageInput, briefJson);
        if (planRepairHints.length > 0) {
          env.layer4_variable += `\n\n=== REPAIR HINTS (from prior failed attempt) ===\n${planRepairHints.map(h => '- ' + h).join('\n')}\nAddress these issues in your revised plan.`;
        }
        planPromptText = flattenEnvelope(env);
        const resp = await envelopeGenerate({ envelope: env, model: planModel, options: { temperature: temps.plan_temperature } }, `${input.label} plan`);
        planRaw = resp.text;
        planUsage = resp.usage;
      } else {
        planPromptText = planStagePrompt(stageInput, briefJson);
        if (planRepairHints.length > 0) {
          planPromptText += `\n\n=== REPAIR HINTS (from prior failed attempt) ===\n${planRepairHints.map(h => '- ' + h).join('\n')}\nAddress these issues in your revised plan.`;
        }
        planRaw = await generate(planPromptText, planModel, { temperature: temps.plan_temperature }, `${input.label} plan`);
      }
      elapsed = Date.now() - t0;
      const planParsed = parseStageResponse<PlanWorkProduct>(planRaw, 'plan');
      stageDiags.push({
        stage: 'plan', prompt: planPromptText, raw_response: planRaw,
        model: planModel, temperature: temps.plan_temperature,
        response_time_ms: elapsed, work_product: planParsed.product as unknown as Record<string, unknown>,
        parse_error: planParsed.error,
        retry_trigger: isOuterRetry ? 'orchestration-rerun' : planAttempt > 0 ? 'stage-retry' : 'initial',
        repair_hints_in: planRepairHints.length > 0 ? planRepairHints : undefined,
        prompt_component_chars: promptComponentChars,
        input_tokens: planUsage?.inputTokens,
        output_tokens: planUsage?.outputTokens,
      });
      if (planParsed.error) {
        if (planAttempt < MAX_STAGE_RETRIES) {
          getGlobalRecorder()?.record({
            type: 'turn.repair', component: 'turn-pipeline', level: 'warn',
            speaker: input.label,
            message: `PLAN parse failed (attempt ${planAttempt}), retrying`,
            data: { stage: 'plan', attempt: planAttempt, error: planParsed.error },
          });
          console.log(`[pipeline] Plan parse failed (attempt ${planAttempt}), retrying: ${planParsed.error}`);
          continue;
        }
        // Retries exhausted — degrade the turn rather than aborting the debate (t/2229).
        getGlobalRecorder()?.record({
          type: 'turn.repair', component: 'turn-pipeline', level: 'warn',
          speaker: input.label,
          message: `PLAN exhausted after ${planAttempt + 1} attempt(s) — degrading turn`,
          data: { stage: 'plan', attempt: planAttempt, error: planParsed.error },
        });
        console.log(`[pipeline] Plan stage exhausted after ${planAttempt + 1} attempt(s) — degrading turn`);
        const lastPlanDiag = stageDiags[stageDiags.length - 1];
        (lastPlanDiag as Record<string, unknown>).degraded = true;
        plan = planParsed.product;
        planJson = '{}';
        degradedTurn = true;
        break;
      }

      // Validate plan
      const planVal = validatePlanStage({ plan: planParsed.product, isFirstRound });
      const lastPlanDiag = stageDiags[stageDiags.length - 1];
      (lastPlanDiag as Record<string, unknown>).stage_validation = { pass: planVal.pass, hints: planVal.repairHints, details: planVal.details };

      if (planVal.errorHints.length > 0 && planAttempt < MAX_STAGE_RETRIES) {
        planRepairHints = planVal.errorHints;
        (lastPlanDiag as Record<string, unknown>).validation_failed = true;
        (lastPlanDiag as Record<string, unknown>).validation_errors = [...planVal.errorHints];
        getGlobalRecorder()?.record({
          type: 'turn.repair', component: 'turn-pipeline', level: 'warn',
          speaker: input.label,
          message: `PLAN repair attempt ${planAttempt}: ${planVal.errorHints.length} error(s)`,
          data: { stage: 'plan', attempt: planAttempt, hints: planVal.errorHints },
        });
        console.log(`[pipeline] Plan validation errors (attempt ${planAttempt}), retrying: ${planVal.errorHints.join('; ')}`);
        continue;
      }

      plan = tagProvenance(planParsed.product, {
        pipeline_run: isOuterRetry ? 1 : 0,
        stage: 'plan', attempt: planAttempt,
        model: planModel, timestamp: new Date().toISOString(),
      });
      planJson = toPromptJson(plan);
      getGlobalRecorder()?.record({
        type: 'turn.stage', component: 'turn-pipeline', level: 'info',
        speaker: input.label, duration_ms: elapsed,
        message: `${input.label} completed PLAN stage (attempt ${planAttempt})`,
        data: { stage: 'plan', action: 'exit', attempt: planAttempt, duration_ms: elapsed },
      });
      break;
    }
  }
  if (!plan) {
    plan = {} as PlanWorkProduct;
    planJson = '{}';
  }

  // ── Stage 2.1: PLAN target_nodes sanitization ──
  // Same as BRIEF — validate target_nodes against knownNodeIds before DRAFT/CITE.
  if (knownNodeIds.size > 0 && plan.target_nodes?.length) {
    const planIdResult = sanitizeNodeIds(plan.target_nodes, knownNodeIds);
    if (planIdResult.corrections.length > 0 || planIdResult.removed.length > 0) {
      for (const c of planIdResult.corrections) {
        console.log(`[pipeline] Plan target_nodes correction: ${c.from} → ${c.to}`);
      }
      for (const r of planIdResult.removed) {
        console.log(`[pipeline] Plan target_nodes removed (unknown): ${r}`);
      }
      plan.target_nodes = planIdResult.sanitized;
      planJson = toPromptJson(plan);
    }
  }

  // ── Stages 2.5–3.5: EVIDENCE → DRAFT → PRE-CHECK ──
  // When frozenDraft is provided, skip evidence retrieval, draft generation,
  // linkification, citation verification, and quality pre-check entirely.
  let draft: DraftWorkProduct | undefined;
  let draftJson = '';
  let evidenceBlock = '';
  const evidenceDocIds = new Set<string>();
  const ignoredEvidenceDocIds: string[] = [];

  let topicAlignmentResult: { topic_aligned: boolean; repaired: boolean; draft_attempt: number } | undefined;
  let qualityGateResult: { pre_repair: DraftQualityGateResult; post_repair?: DraftQualityGateResult; repair_outcome?: 'fixed' | 'partial' | 'unchanged' } | undefined;
  let editingMeta: TurnPipelineResult['editing_meta'];

  if (input.frozenDraft) {
    draft = input.frozenDraft;
    draftJson = toPromptJson(draft);
    evidenceBlock = input.frozenEvidenceBlock ?? '';
    console.log(`[pipeline] Draft stage FROZEN — reusing prior output (skipping evidence, linkification, pre-check)`);
  } else {

  // ── Stage 2.5: EVIDENCE (deterministic — no LLM call) ──
  // Retrieve source document evidence for the plan's target nodes.
  onProgress?.('evidence', `${input.label} retrieving evidence...`, { step: ++step, total: totalStages });
  // Produces a compact evidence brief injected into the DRAFT prompt.
  if (input.frozenEvidenceBlock != null) {
    evidenceBlock = input.frozenEvidenceBlock;
    console.log(`[pipeline] Evidence stage FROZEN — reusing prior output (${evidenceBlock.length} chars)`);
  } else if (input.sourceEvidenceIndex && plan.target_nodes && plan.target_nodes.length > 0) {
    try {
      const { retrieveSourceEvidence } = await import('../evidenceFromSummaries.js');
      const evidenceBrief = retrieveSourceEvidence(
        plan.target_nodes as string[],
        input.pov,
        input.sourceEvidenceIndex,
        3, // max facts
        2, // max key points
        input.docTitles,
        input.ignoredEvidenceDocIds?.length
          ? { ignoredDocIds: new Set(input.ignoredEvidenceDocIds) }
          : undefined,
      );
      // Collect doc IDs for scoped citation bank
      for (const f of evidenceBrief.facts) evidenceDocIds.add(f.doc_id);
      for (const kp of evidenceBrief.keyPoints) evidenceDocIds.add(kp.doc_id);
      console.log(`[pipeline] EVIDENCE retrieved: ${evidenceBrief.facts.length} facts, ${evidenceBrief.keyPoints.length} keyPoints, block=${evidenceBrief.formattedBlock.length} chars`);
      getGlobalRecorder()?.record({
        type: 'turn.evidence', component: 'turn-pipeline', level: 'info',
        speaker: input.label,
        message: `Evidence: ${evidenceBrief.facts.length} facts, ${evidenceBrief.keyPoints.length} keyPoints`,
        data: {
          facts_count: evidenceBrief.facts.length,
          keypoints_count: evidenceBrief.keyPoints.length,
          candidate_pool: evidenceBrief.totalCandidates,
          ...(evidenceBrief.diversity ? {
            dedup_removed: evidenceBrief.diversity.dedup_removed,
            source_diversity: evidenceBrief.diversity.source_diversity,
            has_dispute: evidenceBrief.diversity.has_dispute,
            temporal_range: evidenceBrief.diversity.temporal_range,
          } : {}),
        },
      });
      if (evidenceBrief.formattedBlock) {
        evidenceBlock = '\n\n' + evidenceBrief.formattedBlock;
        stageDiags.push({
          stage: 'evidence',
          prompt: `target_nodes: ${(plan.target_nodes as string[]).join(', ')}`,
          raw_response: evidenceBrief.formattedBlock,
          model: 'deterministic',
          temperature: 0,
          response_time_ms: 0,
          work_product: {
            facts: evidenceBrief.facts as unknown as Record<string, unknown>[],
            keyPoints: evidenceBrief.keyPoints as unknown as Record<string, unknown>[],
            nodesCovered: evidenceBrief.nodesCovered,
            totalCandidates: evidenceBrief.totalCandidates,
            ...(evidenceBrief.diversity ? {
              raw_count: evidenceBrief.diversity.raw_count,
              candidate_count: evidenceBrief.diversity.candidate_count,
              dedup_removed: evidenceBrief.diversity.dedup_removed,
              source_diversity: evidenceBrief.diversity.source_diversity,
              has_dispute: evidenceBrief.diversity.has_dispute,
              temporal_range: evidenceBrief.diversity.temporal_range,
            } : {}),
          } as unknown as Record<string, unknown>,
        });
      }
    } catch (err) {
      // Evidence retrieval failure is non-fatal — proceed without evidence
      getGlobalRecorder()?.record({ type: 'system.error', component: 'turn-pipeline', level: 'warn', debate_id: (input as any).debate_id, message: 'Evidence retrieval failed — proceeding without evidence', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      console.warn(`[pipeline] Evidence retrieval failed: ${err instanceof Error ? err.message.slice(0, 100) : err}`);
    }
  }

  // ── Stage 2.6: CITATION BANK (deterministic — no LLM call) ──
  // Build citation bank from evidence index for citation validation.
  // Path A (all backends for now): inject bank into prompt + post-draft scrub.
  // Path B (gemini/claude tool-calling) requires multi-turn provider support — future enhancement.
  let citationBank: CitationBankEntry[] = [];
  let citationBankBlock = '';
  // A diagnostic label only (the path used is fixed below), so an unknown id must not throw (t/4101).
  const citationBackend = inferBackend(input.model);
  const citationPathIntended = (citationBackend === 'gemini' || citationBackend === 'claude') ? 'B' : 'A';
  const citationPathUsed: 'tool-calling' | 'bank-scrub' = 'bank-scrub'; // Path B requires multi-turn provider support (future)
  let citationBankBuildTime = 0;

  if (input.sourceEvidenceIndex) {
    try {
      const bankT0 = Date.now();
      const docMeta: DocMetaMap = {};
      if (input.docTitles) {
        for (const [id, entry] of Object.entries(input.docTitles)) {
          docMeta[id] = typeof entry === 'string' ? { title: entry } : entry;
        }
      }
      citationBank = buildCitationBank(input.sourceEvidenceIndex, docMeta, input.policyRegistry);
      // Scope the prompt-injected bank to turn-relevant sources (saves ~8-9K tokens)
      // Full bank is kept for scrub/validation (catches fabrications from any corpus source)
      const priorCitedDocIds = new Set<string>();
      if (input.priorRefs && input.sourceEvidenceIndex) {
        for (const nodeId of input.priorRefs) {
          const nodeEntry = input.sourceEvidenceIndex[nodeId];
          if (!nodeEntry) continue;
          for (const f of nodeEntry.facts ?? []) priorCitedDocIds.add(f.doc_id);
          for (const kp of nodeEntry.keyPoints ?? []) priorCitedDocIds.add(kp.doc_id);
        }
      }
      const scopedBank = buildScopedCitationBank(citationBank, {
        evidenceDocIds,
        priorCitedDocIds: priorCitedDocIds.size > 0 ? priorCitedDocIds : undefined,
        targetNodeIds: plan.target_nodes as string[] | undefined,
        evidenceIndex: input.sourceEvidenceIndex,
      });
      citationBankBuildTime = Date.now() - bankT0;
      if (scopedBank.length > 0) {
        citationBankBlock = '\n\n' + formatCitationBank(scopedBank);
        console.log(`[pipeline] Citation bank built: ${scopedBank.length} scoped / ${citationBank.length} full entries, path=${citationPathUsed} (intended=${citationPathIntended}), ${citationBankBuildTime}ms`);
        getGlobalRecorder()?.record({
          type: 'turn.citation_bank', component: 'turn-pipeline', level: 'info',
          speaker: input.label,
          message: `Citation bank: ${scopedBank.length} scoped / ${citationBank.length} full`,
          data: { scoped_entries: scopedBank.length, full_entries: citationBank.length, tokens_saved_est: Math.round((citationBank.length - scopedBank.length) * 25) },
        });
      }
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'turn-pipeline', level: 'warn', debate_id: (input as any).debate_id, message: 'Citation bank build failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      console.warn(`[pipeline] Citation bank build failed: ${err instanceof Error ? err.message.slice(0, 100) : err}`);
    }
  }

  // ── Stage 3: DRAFT (with per-stage validation + retry) ──
  let draftRepairHints: string[] = input.repairHints?.filter(h =>
    !/taxonomy_refs.*(?:filler|too-short|relevance)|No new taxonomy_refs|Unknown taxonomy node|Unknown policy_refs|grounding_confidence/i.test(h)
  ) ?? [];

  const MAX_DRAFT_RETRIES = isOuterRetry ? 1 : 2; // outer retry gets 1 inner retry; normal gets up to 2
  for (let draftAttempt = 0; draftAttempt <= MAX_DRAFT_RETRIES; draftAttempt++) {
    onProgress?.('draft', `${input.label} is drafting${draftAttempt > 0 ? ` (retry ${draftAttempt})` : ''}...`, draftAttempt === 0 ? { step: ++step, total: totalStages } : undefined);
    getGlobalRecorder()?.record({
      type: 'turn.stage', component: 'turn-pipeline', level: 'info',
      speaker: input.label,
      message: `${input.label} entering DRAFT stage (attempt ${draftAttempt})`,
      data: { stage: 'draft', action: 'enter', attempt: draftAttempt },
    });
    let draftPromptText: string;
    let draftRaw: string;
    let draftUsage: { inputTokens: number; outputTokens: number } | undefined;
    t0 = Date.now();
    // Build targeted repair block from prior failure — translates hints into
    // specific prompt modifications placed in the recency window, not generic appendix.
    const failedDraftStatement = draftRepairHints.length > 0 && draft?.statement ? draft.statement : undefined;
    // Field-level freeze: when hints target only specific fields, instruct the LLM
    // to preserve unflagged fields from the prior draft (prevents unnecessary regression).
    const targetedFields = draftRepairHints.length > 0 ? classifyDraftHintFields(draftRepairHints) : new Set<DraftField>();
    const repairBlock = buildRepairBlock(draftRepairHints, failedDraftStatement, draft, targetedFields);
    const fieldFreezeBlock = draft && targetedFields.size > 0 && targetedFields.size < ALL_DRAFT_FIELDS.length
      ? buildFieldFreezeBlock(draft, targetedFields)
      : '';

    if (envelopeGenerate) {
      const env = draftStageEnvelope(stageInput, briefJson, planJson);
      // Inject repair block in primacy position (after identity/MUST, before SITUATION BRIEF)
      if (repairBlock) {
        env.layer4_variable = env.layer4_variable.replace(
          /=== SITUATION BRIEF ===/,
          `${repairBlock}\n\n=== SITUATION BRIEF ===`,
        );
        if (!env.layer4_variable.includes('CORRECTIONS REQUIRED') && !env.layer4_variable.includes('MANDATORY CORRECTION')) {
          env.layer4_variable += repairBlock;
        }
      }
      // Inject field-freeze block (preserve unflagged fields from prior draft)
      if (fieldFreezeBlock) {
        env.layer4_variable = env.layer4_variable.replace(
          /Respond ONLY with a JSON/,
          `${fieldFreezeBlock}\nRespond ONLY with a JSON`,
        );
      }
      // Inject source evidence — right before the output schema (Lost-in-the-Middle mitigation)
      if (evidenceBlock) {
        env.layer4_variable = env.layer4_variable.replace(
          /Respond ONLY with a JSON/,
          `${evidenceBlock}\n\nYou MUST cite at least one source from the evidence above by title in your statement.\n\nRespond ONLY with a JSON`,
        );
      }
      // Inject citation bank after evidence (constrains LLM to verified sources)
      if (citationBankBlock) {
        env.layer4_variable = env.layer4_variable.replace(
          /Respond ONLY with a JSON/,
          `${citationBankBlock}\n\nRespond ONLY with a JSON`,
        );
      }
      draftPromptText = flattenEnvelope(env);
      const resp = await envelopeGenerate({ envelope: env, model: draftModel, options: { temperature: temps.draft_temperature } }, `${input.label} draft`);
      draftRaw = resp.text;
      draftUsage = resp.usage;
    } else {
      draftPromptText = draftStagePrompt(stageInput, briefJson, planJson);
      // Inject repair block in primacy position (after identity/MUST, before SITUATION BRIEF)
      if (repairBlock) {
        draftPromptText = draftPromptText.replace(
          /=== SITUATION BRIEF ===/,
          `${repairBlock}\n\n=== SITUATION BRIEF ===`,
        );
        if (!draftPromptText.includes('CORRECTIONS REQUIRED') && !draftPromptText.includes('MANDATORY CORRECTION')) {
          draftPromptText += repairBlock;
        }
      }
      // Inject field-freeze block (preserve unflagged fields from prior draft)
      if (fieldFreezeBlock) {
        draftPromptText = draftPromptText.replace(
          /Respond ONLY with a JSON/,
          `${fieldFreezeBlock}\nRespond ONLY with a JSON`,
        );
      }
      // Inject source evidence — right before the output schema
      if (evidenceBlock) {
        draftPromptText = draftPromptText.replace(
          /Respond ONLY with a JSON/,
          `${evidenceBlock}\n\nYou MUST cite at least one source from the evidence above by title in your statement.\n\nRespond ONLY with a JSON`,
        );
      }
      // Inject citation bank after evidence (constrains LLM to verified sources)
      if (citationBankBlock) {
        draftPromptText = draftPromptText.replace(
          /Respond ONLY with a JSON/,
          `${citationBankBlock}\n\nRespond ONLY with a JSON`,
        );
      }
      draftRaw = await generate(draftPromptText, draftModel, { temperature: temps.draft_temperature }, `${input.label} draft`);
    }
    elapsed = Date.now() - t0;
    // Record prompt size for diagnostics
    getGlobalRecorder()?.record({
      type: 'turn.prompt_size', component: 'turn-pipeline', level: 'info',
      speaker: input.label,
      message: `Draft prompt: ${draftPromptText.length} chars`,
      data: {
        stage: 'draft',
        total_chars: draftPromptText.length,
        tokens_est: Math.round(draftPromptText.length / 4),
        components: {
          taxonomy: stageInput.taxonomyContext?.length ?? 0,
          transcript: stageInput.recentTranscript?.length ?? 0,
          evidence: evidenceBlock.length,
          hints: repairBlock?.length ?? 0,
          citation_bank: citationBankBlock.length,
        },
      },
    });
    const priorDraft = draft; // save before reassign for field-level merge
    const draftParsed = parseStageResponse<DraftWorkProduct>(draftRaw, 'draft');

    // Fallback: if JSON parse failed but raw has substantial text, use it as the statement.
    // The LLM sometimes produces prose instead of JSON — salvage the content.
    if (draftParsed.error && !draftParsed.product.statement && draftRaw.length > 100) {
      // Strip markdown fences if present
      let salvaged = draftRaw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      // If it starts with a quote or letter (not { ), it's prose — use it directly
      if (salvaged.length > 50 && !salvaged.startsWith('{')) {
        draftParsed.product.statement = salvaged;
        console.log(`[pipeline] Draft JSON parse failed — salvaged ${salvaged.length} chars of prose as statement`);
      }
    }
    stageDiags.push({
      stage: 'draft', prompt: draftPromptText, raw_response: draftRaw,
      model: draftModel, temperature: temps.draft_temperature,
      response_time_ms: elapsed, work_product: draftParsed.product as unknown as Record<string, unknown>,
      parse_error: draftParsed.error,
      retry_trigger: draftAttempt === 0 && !isOuterRetry ? 'initial' : draftAttempt > 0 ? 'stage-retry' : 'orchestration-rerun',
      repair_hints_in: draftRepairHints.length > 0 ? [...draftRepairHints] : undefined,
      prompt_component_chars: promptComponentChars,
      input_tokens: draftUsage?.inputTokens,
      output_tokens: draftUsage?.outputTokens,
    });
    draft = tagProvenance(draftParsed.product, {
      pipeline_run: isOuterRetry ? 1 : 0,
      stage: 'draft', attempt: draftAttempt,
      model: input.model, timestamp: new Date().toISOString(),
    });

    // Merge frozen fields from prior draft to guarantee stability —
    // LLMs don't always follow field-freeze instructions perfectly.
    if (draft && priorDraft && fieldFreezeBlock) {
      draft = mergeFrozenDraftFields(draft, priorDraft, targetedFields);
      console.log(`[pipeline] Draft field-level merge: froze ${ALL_DRAFT_FIELDS.filter(f => !targetedFields.has(f)).join(', ')}, regenerated ${[...targetedFields].join(', ')}`);
    }

    // Emit draft-field coverage event (t/3769) — _covered:true makes absence distinguishable from present-but-zero.
    if (draft) {
      getGlobalRecorder()?.record({
        type: 'debate.stage_draft_fields',
        component: 'turn-pipeline',
        level: 'info',
        speaker: input.label,
        phase: input.phase,
        data: {
          stage: 'draft',
          claim_sketches: draft.claim_sketches?.length ?? 0,
          prior_steelmans: draft.prior_steelmans?.length ?? 0,
          turn_symbols: draft.turn_symbols?.length ?? 0,
          statement_chars: draft.statement?.length ?? 0,
          position_update: !!draft.position_update,
          commitment: !!draft.commitment,
          _covered: true,
        },
      });
    }

    // Backfill empty claim_sketches targets from prior draft — LLMs drop AN-ID
    // targets when regenerating claims because they focus on text, not ID mappings.
    if (draft?.claim_sketches && priorDraft?.claim_sketches) {
      let backfilled = 0;
      for (const claim of draft.claim_sketches) {
        if (!claim.targets || claim.targets.length === 0) {
          // Find best-matching prior claim by text overlap
          const best = priorDraft.claim_sketches
            .filter(pc => pc.targets && pc.targets.length > 0)
            .map(pc => ({ pc, overlap: wordOverlap(claim.claim, pc.claim) }))
            .sort((a, b) => b.overlap - a.overlap)[0];
          if (best && best.overlap >= 0.3) {
            claim.targets = best.pc.targets;
            backfilled++;
          }
        }
      }
      if (backfilled > 0) console.log(`[pipeline] Backfilled ${backfilled} claim target(s) from prior draft`);
    }

    // Per-stage draft validation
    if (draft) {
      const meta = extractDraftMeta(draft);
      const draftVal = validateDraftStage({
        statement: draft.statement ?? '',
        meta,
        phase: stageInput.phase ?? 'argumentation',
        round: typeof (stageInput as Record<string, unknown>).round === 'number' ? (stageInput as Record<string, unknown>).round as number : 3,
        priorTurns: (input as Record<string, unknown>).priorTurns as import('../types.js').TranscriptEntry[] ?? [],
        audience: stageInput.audience,
        pendingIntervention: stageInput.pendingIntervention as import('../types.js').ModeratorIntervention | undefined,
        suppressedHints: input.suppressedHints,
        speaker: input.pov as import('../types.js').SpeakerId,
        soul: stageInput.soul!,
      });
      // Record validation result on the stage diagnostic
      const lastDiag = stageDiags[stageDiags.length - 1];
      (lastDiag as Record<string, unknown>).stage_validation = {
        pass: draftVal.pass,
        hints: draftVal.repairHints,
        details: draftVal.details,
        directive_compliance: draftVal.directive_compliance,
      };

      // First draft: any feedback (errors + warnings) triggers retry — address everything.
      // Subsequent drafts: only errors trigger retry — don't chase diminishing returns.
      // Directive failures get an extra attempt (max 2 retries) since they're structural.
      const isDirectiveFailure = draftVal.failedDimension === 'directive';
      const maxDraftRetries = isDirectiveFailure ? 2 : MAX_STAGE_RETRIES;
      const draftShouldRetry = draftAttempt === 0
        ? draftVal.repairHints.length > 0
        : draftVal.errorHints.length > 0;
      if (draftShouldRetry && draftAttempt < maxDraftRetries) {
        // ── Micro-fix passes: try targeted fixes before full retry ──
        onProgress?.('micro-fix', `${input.label} refining...`, { step, total: totalStages });
        const specFix = await trySpecificityMicroFix(
          draft, draftVal.repairHints ?? [], stageDiags, input, generate,
          evidenceBlock, citationBankBlock,
        );
        if (specFix.shouldBreak) break;

        const intFix = await tryInterventionMicroFix(
          draft, draftVal, stageDiags, input, generate,
          stageInput.pendingIntervention,
        );
        if (intFix.shouldBreak) break;

        const dirFix = await tryDirectiveMicroFix(
          draft, draftVal, stageDiags, input, generate,
          stageInput.pendingIntervention,
        );
        if (dirFix.shouldBreak) break;

        draftRepairHints = draftAttempt === 0 ? draftVal.repairHints : draftVal.errorHints;
        // Find the actual draft diagnostic (skip any micro-fix entries that were pushed after it)
        const lastDraftDiag = [...stageDiags].reverse().find(s => s.stage === 'draft') ?? stageDiags[stageDiags.length - 1];
        (lastDraftDiag as Record<string, unknown>).validation_failed = true;
        (lastDraftDiag as Record<string, unknown>).validation_errors = [...draftRepairHints];
        getGlobalRecorder()?.record({
          type: 'turn.repair', component: 'turn-pipeline', level: 'warn',
          speaker: input.label,
          message: `DRAFT repair attempt ${draftAttempt}: ${draftRepairHints.length} hint(s)`,
          data: { stage: 'draft', attempt: draftAttempt, hints: draftRepairHints, frozen_fields: fieldFreezeBlock ? ALL_DRAFT_FIELDS.filter(f => !targetedFields.has(f)) : [] },
        });
        console.log(`[pipeline] Draft validation feedback (attempt ${draftAttempt}), retrying: ${draftRepairHints.join('; ')}`);
        continue;
      }
    }
    // ── PLAN→DRAFT move consistency check (warning only) ──
    // Compare draft's actual moves against plan's intended moves.
    // This is a quality signal — the LLM sometimes ignores the plan.
    if (draft?.move_types && plan?.planned_moves?.length) {
      const plannedMoves = plan.planned_moves.map(pm => resolveMoveName(pm.move));
      const draftMoves = (draft.move_types as Array<string | MoveAnnotation>).map(mt => resolveMoveName(getMoveName(mt)));
      const plannedSet = new Set(plannedMoves);
      const draftSet = new Set(draftMoves);
      const missingFromDraft = plannedMoves.filter(m => !draftSet.has(m));
      const addedInDraft = draftMoves.filter(m => !plannedSet.has(m));
      if (missingFromDraft.length > 0 || addedInDraft.length > 0) {
        const lastDraftDiag = stageDiags[stageDiags.length - 1];
        const moveConsistency = {
          planned: plannedMoves,
          actual: draftMoves,
          missing: missingFromDraft,
          added: addedInDraft,
        };
        (lastDraftDiag as Record<string, unknown>).move_consistency = moveConsistency;
        console.log(`[pipeline] PLAN→DRAFT move divergence: planned=[${plannedMoves.join(',')}] actual=[${draftMoves.join(',')}] missing=[${missingFromDraft.join(',')}] added=[${addedInDraft.join(',')}]`);
      }
    }

    // Draft passed validation — clear repair hints so they don't persist
    // as stale noise into subsequent orchestration retry cycles.
    draftRepairHints = [];
    break;
  }

  // ── Post-draft readability edit pass ──
  onProgress?.('postDraft', `${input.label} post-processing draft...`, { step: ++step, total: totalStages });
  if (draft?.statement) {
    const editResult = await runReadabilityEditPass(draft.statement, input.audience, generate, input.model, `${input.label}`);
    (draft as Record<string, unknown>).statement = editResult.statement;
    editingMeta = editResult.editing_meta;
  }

  // ── Post-Draft assumptions extraction (lightweight LLM call) ──
  // Deferred from Draft to reduce cognitive load during generation (t/298).
  // Opening turns already produce key_assumptions — only extract for non-opening turns.
  if (draft?.statement && !draft.key_assumptions?.length) {
    try {
      const assumptionsPrompt = assumptionsExtractionPrompt(draft.statement);
      const assumptionsRaw = await generate(assumptionsPrompt, input.model, { temperature: 0 }, `${input.label} assumptions`);
      const assumptionsParsed = parseStageResponse<{ key_assumptions?: { assumption: string; if_wrong: string }[] }>(assumptionsRaw, 'postDraft');
      if (assumptionsParsed.product?.key_assumptions?.length) {
        (draft as Record<string, unknown>).key_assumptions = assumptionsParsed.product.key_assumptions;
      }
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'ai.error', component: 'turn-pipeline', level: 'warn', debate_id: (input as any).debate_id, message: 'Post-draft assumptions extraction failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    }
  }

  // ── Post-Draft deterministic processing (postDraft stage) ──
  // 6 steps: paragraph split, citation scrub, linkification, evidence utilization, ungrounded claims, citation validation.
  // Instrumented separately from Draft LLM generation for observability.
  const postDraftT0 = Date.now();

  // ── Post-draft paragraph auto-split ──
  // Single-paragraph statements are a formatting issue, not a content issue.
  // Deterministic splitting saves a full 30K-token LLM retry.
  let autoSplitApplied = false;
  let autoSplitParagraphs = 0;
  if (draft?.statement && !draft.statement.includes('\n\n') && draft.statement.length > 300) {
    const splitResult = splitIntoParagraphs(draft.statement);
    if (splitResult !== draft.statement) {
      autoSplitParagraphs = splitResult.split(/\n\s*\n/).length;
      draft.statement = splitResult;
      autoSplitApplied = true;
      getGlobalRecorder()?.record({
        type: 'turn.repair', component: 'turn-pipeline', level: 'info',
        speaker: input.label,
        message: `Auto-split single paragraph into ${autoSplitParagraphs} paragraphs`,
        data: { original_length: draft.statement.length, paragraph_count: autoSplitParagraphs },
      });
      console.log(`[pipeline] Auto-split single paragraph into ${autoSplitParagraphs} paragraphs`);
    }
  }

  // ── Post-draft citation scrub ──
  // Deterministically remove fabricated citations not in the citation bank.
  let citationScrubResult: import('../citationResolution.js').ScrubResult | undefined;
  let citationScrubOriginal: string | undefined;
  if (citationBank.length > 0 && draft?.statement) {
    citationScrubOriginal = draft.statement; // preserve pre-scrub text for Diff Viewer
    const scrub = scrubCitations(draft.statement, citationBank);
    if (scrub.removed.length > 0) {
      draft.statement = scrub.cleanedDraft;
      citationScrubResult = scrub;
      console.log(`[pipeline] Citation scrub: removed ${scrub.removed.length} fabricated citation(s): ${scrub.removed.join(', ')}`);
    }
  }

  draftJson = toPromptJson(draft);

  // ── Post-draft linkification: replace title mentions with clickable links ──
  let linkificationApplied = false;
  let preLinkStatement = '';
  if (draft?.statement && input.docTitles) {
    preLinkStatement = draft.statement;
    const { linkifyEvidenceCitations } = await import('../evidenceFromSummaries.js');
    draft.statement = linkifyEvidenceCitations(draft.statement, input.docTitles);
    linkificationApplied = draft.statement !== preLinkStatement;
  }

  // ── Evidence citation verification ──
  // Check if the debater actually cited any source documents from the evidence brief.
  if (evidenceBlock && draft?.statement) {
    const evidenceDiag = stageDiags.find(d => d.stage === 'evidence');
    if (evidenceDiag) {
      const wp = evidenceDiag.work_product as Record<string, unknown>;
      const facts = (wp?.facts as Array<{ doc_id?: string }>) ?? [];
      const keyPoints = (wp?.keyPoints as Array<{ doc_id?: string }>) ?? [];
      const allDocIds = [...new Set([...facts.map(f => f.doc_id), ...keyPoints.map(kp => kp.doc_id)].filter(Boolean))] as string[];
      const statementLower = draft.statement.toLowerCase();
      const docMeta = input.docTitles as import('../evidenceFromSummaries.js').DocTitleMap | import('../evidenceFromSummaries.js').DocMetaMap | undefined;
      const citedDocs: Array<{ doc_id: string; title?: string; match_type: string }> = [];
      for (const docId of allDocIds) {
        const slug = docId.replace(/-\d{4}(-\d+)?$/, '').replace(/-/g, ' ');
        const entry = docMeta?.[docId];
        const title = typeof entry === 'string' ? entry : entry?.title;
        const titleLower = title?.toLowerCase();
        const resolvedUrl = typeof entry === 'object' ? entry?.resolved_url : undefined;
        // Check for markdown link pattern: [Title](url)
        if (resolvedUrl && draft.statement.includes(`](${resolvedUrl})`)) {
          citedDocs.push({ doc_id: docId, title, match_type: 'markdown_link' });
        } else if (statementLower.includes(docId)) {
          citedDocs.push({ doc_id: docId, title, match_type: 'exact_id' });
        } else if (statementLower.includes(slug)) {
          citedDocs.push({ doc_id: docId, title, match_type: 'slug' });
        } else if (titleLower && statementLower.includes(titleLower)) {
          citedDocs.push({ doc_id: docId, title, match_type: 'title_exact' });
        } else if (titleLower) {
          const titleWords = titleLower.split(/\s+/).filter((w: string) => w.length > 3);
          if (titleWords.length >= 3) {
            const trigram = titleWords.slice(0, 4).join(' ');
            if (statementLower.includes(trigram)) {
              citedDocs.push({ doc_id: docId, title, match_type: 'title_partial' });
            }
          }
        }
      }
      const utilizationRate = allDocIds.length > 0 ? citedDocs.length / allDocIds.length : 0;
      (wp as Record<string, unknown>).evidence_utilization = {
        total_docs: allDocIds.length,
        cited_docs: citedDocs,
        utilization_rate: Math.round(utilizationRate * 100),
      };
      // Build per-doc citation pipeline trace
      const docMetaForPipeline = input.docTitles;
      const pipelineTrace = allDocIds.map(docId => {
        const metaEntry = docMetaForPipeline?.[docId];
        const meta = typeof metaEntry === 'string' ? { title: metaEntry } : metaEntry;
        const cited = citedDocs.find(cd => cd.doc_id === docId);
        return {
          doc_id: docId,
          resolved_title: meta?.title ?? docId,
          resolved_url: (meta as { resolved_url?: string })?.resolved_url ?? null,
          url_type: classifyUrl((meta as { resolved_url?: string })?.resolved_url ?? ''),
          provenance_label: (meta as { provenance_label?: string })?.provenance_label ?? null,
          cited: !!cited,
          match_type: cited?.match_type ?? null,
          linkified: linkificationApplied && cited?.match_type !== null,
        };
      });
      (wp as Record<string, unknown>).citation_pipeline = pipelineTrace;

      if (citedDocs.length > 0) {
        console.log(`[pipeline] Evidence utilization: ${citedDocs.length}/${allDocIds.length} source docs cited (${Math.round(utilizationRate * 100)}%)`);
      } else {
        console.log(`[pipeline] Evidence utilization: 0/${allDocIds.length} — debater did not cite any source documents from evidence brief`);
      }
    }
  }

  // ── Ungrounded claims detection ──
  // Find specific factual claims in the statement that don't match any source in the
  // evidence block or evidence index. These are from the LLM's parametric knowledge.
  if (draft?.statement) {
    const evidenceDiagForGrounding = stageDiags.find(d => d.stage === 'evidence');
    const evidenceWpForGrounding = evidenceDiagForGrounding?.work_product as Record<string, unknown> | undefined;

    // Build a set of "grounded" text fragments from the evidence
    const groundedFragments = new Set<string>();
    const evidenceFacts = (evidenceWpForGrounding?.facts as Array<{ claim?: string }>) ?? [];
    const evidenceKPs = (evidenceWpForGrounding?.keyPoints as Array<{ point?: string; verbatim?: string }>) ?? [];
    for (const f of evidenceFacts) {
      if (f.claim) {
        // Extract key phrases (3+ word sequences with a named entity or number)
        const words = f.claim.toLowerCase().split(/\s+/);
        for (let w = 0; w <= words.length - 4; w++) {
          groundedFragments.add(words.slice(w, w + 4).join(' '));
        }
      }
    }
    for (const kp of evidenceKPs) {
      for (const text of [kp.point, kp.verbatim]) {
        if (!text) continue;
        const words = text.toLowerCase().split(/\s+/);
        for (let w = 0; w <= words.length - 4; w++) {
          groundedFragments.add(words.slice(w, w + 4).join(' '));
        }
      }
    }

    // Extract specific factual assertions from the statement
    // (sentences with named entities, numbers, dates, or specific references)
    const sentences = draft.statement
      .replace(/\n+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .filter(s => s.length > 30);

    const specificPattern = /(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+.*(?:study|report|found|showed|documented|revealed))|(?:(?:a|the)\s+\d{4}\s+(?:study|report|survey|analysis))|(?:[A-Z][a-z]+'s?\s+(?:scrapped|hiring|recruiting|algorithm))/;

    const ungroundedClaims: Array<{ claim: string; reason: string }> = [];
    for (const sentence of sentences) {
      if (!specificPattern.test(sentence)) continue;

      // Check if any 4-word sequence from this sentence matches the evidence
      const sentWords = sentence.toLowerCase().split(/\s+/);
      let isGrounded = false;
      for (let w = 0; w <= sentWords.length - 4; w++) {
        if (groundedFragments.has(sentWords.slice(w, w + 4).join(' '))) {
          isGrounded = true;
          break;
        }
      }

      if (!isGrounded) {
        ungroundedClaims.push({
          claim: sentence.length > 150 ? sentence.slice(0, 147) + '...' : sentence,
          reason: 'Not found in evidence block or source corpus — from model general knowledge',
        });
      }
    }

    if (ungroundedClaims.length > 0) {
      // Store on the evidence work product for diagnostics
      const evidenceWpToUpdate = evidenceDiagForGrounding?.work_product as Record<string, unknown> | undefined;
      if (evidenceWpToUpdate) {
        evidenceWpToUpdate.ungrounded_claims = ungroundedClaims;
      }
      const claimSnippets = ungroundedClaims.map(c => c.claim.slice(0, 120)).join('; ');
      console.log(`[pipeline] Ungrounded claims: ${ungroundedClaims.length} factual assertions not traceable to source corpus — ${claimSnippets}`);
    }
  }

  // ── Post-draft citation validation (both paths) ──
  // Validate all citation-like strings against the bank.
  // Warnings are recorded in diagnostics for the UI/judge.
  let citationWarnings: string[] = [];
  if (citationBank.length > 0 && draft?.statement) {
    const warnings = validateCitationsAgainstBank(draft.statement, citationBank);
    if (warnings.length > 0) {
      citationWarnings = warnings.map(w => `${w.citation}: ${w.reason}`);
      console.log(`[pipeline] Citation validation: ${warnings.length} warning(s): ${citationWarnings.join('; ')}`);
    }
  }

  // Record rich citation resolution diagnostics on the draft stage diagnostic
  if (citationBank.length > 0) {
    const draftDiag = [...stageDiags].reverse().find(d => d.stage === 'draft');
    if (draftDiag) {
      const citationResolutionT0 = Date.now();
      const citationMatches = draft?.statement
        ? extractCitationMatches(draft.statement, citationBank)
        : [];
      const citationFabrications = citationScrubResult?.fabrications ?? [];
      const citationResolutionTime = citationBankBuildTime + (Date.now() - citationResolutionT0);

      const diagnostics: CitationResolutionDiagnostics = {
        path: citationPathUsed,
        bank_size: citationBank.length,
        bank_sources: citationBank.map(e => e.doc_id),
        citations_extracted: citationMatches.length + citationFabrications.length,
        citations_matched: citationMatches.length,
        citations_fabricated: citationFabrications.length,
        resolution_time_ms: citationResolutionTime,
        matches: citationMatches,
        fabrications: citationFabrications,
        warnings: citationWarnings,
      };

      // Path A scrub diff
      if (citationScrubOriginal && citationScrubResult) {
        const origLines = citationScrubOriginal.split('\n');
        const cleanedLines = citationScrubResult.cleanedDraft.split('\n');
        let linesRemoved = 0;
        let linesModified = 0;
        const maxLen = Math.max(origLines.length, cleanedLines.length);
        for (let li = 0; li < maxLen; li++) {
          if (li >= cleanedLines.length) { linesRemoved++; continue; }
          if (li >= origLines.length) continue;
          if (origLines[li] !== cleanedLines[li]) linesModified++;
        }
        diagnostics.scrub_diff = {
          lines_removed: linesRemoved,
          lines_modified: linesModified,
          original_length: citationScrubOriginal.length,
          cleaned_length: citationScrubResult.cleanedDraft.length,
        };
        diagnostics.scrub_original = citationScrubOriginal;
      }

      (draftDiag as Record<string, unknown>).citation_resolution = diagnostics;

      // Compute ignored evidence: docs we supplied but the draft didn't cite
      const citedDocIds = new Set(citationMatches.map(m => m.doc_id));
      for (const docId of evidenceDocIds) {
        if (!citedDocIds.has(docId)) ignoredEvidenceDocIds.push(docId);
      }
    }
  }

  // ── Record postDraft diagnostics ──
  const postDraftElapsed = Date.now() - postDraftT0;
  stageDiags.push({
    stage: 'postDraft',
    prompt: '',
    raw_response: '',
    model: input.model,
    temperature: 0,
    response_time_ms: postDraftElapsed,
    work_product: {
      auto_split: autoSplitApplied,
      auto_split_paragraphs: autoSplitApplied ? autoSplitParagraphs : 0,
      citations_scrubbed: citationScrubResult?.removed?.length ?? 0,
      scrubbed_citations: citationScrubResult?.removed ?? [],
      links_added: linkificationApplied ? 1 : 0,
      citation_warnings: citationWarnings.length,
      citation_warning_details: citationWarnings,
      ignored_evidence_docs: ignoredEvidenceDocIds.length,
      ignored_evidence_titles: ignoredEvidenceDocIds.map(id => {
        const entry = (input.docTitles as import('../evidenceFromSummaries.js').DocTitleMap | import('../evidenceFromSummaries.js').DocMetaMap | undefined)?.[id];
        return typeof entry === 'string' ? entry : entry?.title ?? id;
      }),
    },
  });

  // ── Stage 3.5: DRAFT QUALITY PRE-CHECK ──
  // Lightweight 3-question LLM evaluation: grounded, falsifiable, engages.
  // Only on first draft attempt within the per-stage loop, non-outer-retry, when pre-check is enabled.
  if (
    !isOuterRetry &&
    !input.skipPreCheck &&
    effectivePreCheckGenerate &&
    input.preCheckModel &&
    draft?.statement
  ) {
    onProgress?.('draft_quality', `${input.label} is quality-checking draft...`, { step: ++step, total: totalStages });
    const preCheckPromptText = draftQualityCheckPrompt(
      draft.statement,
      input.lastOpponentStatement,
      input.label,
      input.pov,
      input.phase,
      typeof (stageInput as Record<string, unknown>).round === 'number'
        ? (stageInput as Record<string, unknown>).round as number
        : 3,
      plan?.planned_moves,
    );
    const preCheckT0 = Date.now();
    try {
      const preCheckRaw = await effectivePreCheckGenerate(
        preCheckPromptText,
        input.preCheckModel,
        { temperature: 0.1 },
        `${input.label} draft-quality-check`,
      );
      const preCheckElapsed = Date.now() - preCheckT0;
      const preCheckResult = parseDraftQualityResult(preCheckRaw);
      stageDiags.push({
        stage: 'draft_quality',
        prompt: preCheckPromptText,
        raw_response: preCheckRaw,
        model: input.preCheckModel,
        temperature: 0.1,
        response_time_ms: preCheckElapsed,
        work_product: preCheckResult as unknown as Record<string, unknown>,
        prompt_component_chars: promptComponentChars,
      });

      const topicAligned = preCheckResult.topic_aligned !== false;
      const engages = preCheckResult.engages ?? true; // No opponent on opening turn — auto-pass
      const allPass = preCheckResult.grounded && preCheckResult.falsifiable && engages && topicAligned;
      const topicRepairHint = !topicAligned && input.topicScope
        ? offScopeRepairHint(classifyOffScopeDrift(preCheckResult.weaknesses, input.topicScope), input.topicScope)
        : undefined;
      const allWeaknesses = topicRepairHint
        ? [...preCheckResult.weaknesses, topicRepairHint]
        : preCheckResult.weaknesses;
      const triggeredRegen = !allPass && allWeaknesses.length > 0;
      topicAlignmentResult = { topic_aligned: topicAligned, repaired: triggeredRegen, draft_attempt: 1 };
      const preRepairGate: DraftQualityGateResult = {
        grounded: preCheckResult.grounded,
        falsifiable: preCheckResult.falsifiable,
        engages,
        topic_aligned: topicAligned,
        pass: allPass,
        weaknesses: allWeaknesses,
      };
      qualityGateResult = { pre_repair: preRepairGate };
      getGlobalRecorder()?.record({
        type: 'turn.quality_gate', component: 'turn-pipeline', level: allPass ? 'info' : 'warn',
        speaker: input.label,
        message: `Draft quality gate ${allPass ? 'passed' : 'failed'}`,
        data: {
          ...preRepairGate,
          triggered_regen: triggeredRegen,
        },
      });
      if (triggeredRegen) {
        console.log(`[pipeline] Draft quality pre-check failed: ${allWeaknesses.join('; ')}`);
        // Re-run just the draft with quality weaknesses as repair hints
        draftRepairHints = allWeaknesses;
        const repairBlock = buildRepairBlock(draftRepairHints, draft.statement);
        let retryDraftPrompt: string;
        let retryDraftRaw: string;
        let retryDraftUsage: { inputTokens: number; outputTokens: number } | undefined;
        const retryT0 = Date.now();
        if (envelopeGenerate) {
          const env = draftStageEnvelope(stageInput, briefJson, planJson);
          if (repairBlock) {
            env.layer4_variable = env.layer4_variable.replace(
              /Respond ONLY with a JSON/,
              `${repairBlock}\nRespond ONLY with a JSON`,
            );
            if (!env.layer4_variable.includes('CORRECTIONS REQUIRED') && !env.layer4_variable.includes('MANDATORY CORRECTION')) {
              env.layer4_variable += repairBlock;
            }
          }
          // Inject citation bank in quality retry
          if (citationBankBlock) {
            env.layer4_variable = env.layer4_variable.replace(
              /Respond ONLY with a JSON/,
              `${citationBankBlock}\n\nRespond ONLY with a JSON`,
            );
          }
          retryDraftPrompt = flattenEnvelope(env);
          const resp = await envelopeGenerate({ envelope: env, model: draftModel, options: { temperature: temps.draft_temperature } }, `${input.label} draft (quality retry)`);
          retryDraftRaw = resp.text;
          retryDraftUsage = resp.usage;
        } else {
          retryDraftPrompt = draftStagePrompt(stageInput, briefJson, planJson);
          if (repairBlock) {
            retryDraftPrompt = retryDraftPrompt.replace(
              /Respond ONLY with a JSON/,
              `${repairBlock}\nRespond ONLY with a JSON`,
            );
            if (!retryDraftPrompt.includes('CORRECTIONS REQUIRED') && !retryDraftPrompt.includes('MANDATORY CORRECTION')) {
              retryDraftPrompt += repairBlock;
            }
          }
          // Inject citation bank in quality retry
          if (citationBankBlock) {
            retryDraftPrompt = retryDraftPrompt.replace(
              /Respond ONLY with a JSON/,
              `${citationBankBlock}\n\nRespond ONLY with a JSON`,
            );
          }
          retryDraftRaw = await generate(retryDraftPrompt, draftModel, { temperature: temps.draft_temperature }, `${input.label} draft (quality retry)`);
        }
        const retryElapsed = Date.now() - retryT0;
        const retryDraftParsed = parseStageResponse<DraftWorkProduct>(retryDraftRaw, 'draft');
        stageDiags.push({
          stage: 'draft', prompt: retryDraftPrompt, raw_response: retryDraftRaw,
          model: draftModel, temperature: temps.draft_temperature,
          response_time_ms: retryElapsed, work_product: retryDraftParsed.product as unknown as Record<string, unknown>,
          parse_error: retryDraftParsed.error,
          prompt_component_chars: promptComponentChars,
          input_tokens: retryDraftUsage?.inputTokens,
          output_tokens: retryDraftUsage?.outputTokens,
        });
        if (!retryDraftParsed.error && retryDraftParsed.product?.statement) {
          draft = tagProvenance(retryDraftParsed.product, {
            pipeline_run: isOuterRetry ? 1 : 0,
            stage: 'draft', attempt: 1, // quality retry is always attempt 1
            model: input.model, timestamp: new Date().toISOString(),
          });
          draftJson = toPromptJson(draft);
          console.log(`[pipeline] Draft quality retry produced new draft`);
        }

        // ── Post-repair quality re-check (t/393) ──
        // Re-run quality gate on the regenerated draft to verify repair effectiveness.
        if (draft?.statement) {
          const postCheckPrompt = draftQualityCheckPrompt(
            draft.statement,
            input.lastOpponentStatement!,
            input.label,
            input.pov,
            input.phase,
            typeof (stageInput as Record<string, unknown>).round === 'number'
              ? (stageInput as Record<string, unknown>).round as number
              : 3,
            plan?.planned_moves,
          );
          const postCheckT0 = Date.now();
          try {
            const postCheckRaw = await effectivePreCheckGenerate(
              postCheckPrompt,
              input.preCheckModel!,
              { temperature: 0.1 },
              `${input.label} draft-quality-recheck`,
            );
            const postCheckElapsed = Date.now() - postCheckT0;
            const postCheckParsed = parseDraftQualityResult(postCheckRaw);
            stageDiags.push({
              stage: 'draft_quality',
              prompt: postCheckPrompt,
              raw_response: postCheckRaw,
              model: input.preCheckModel!,
              temperature: 0.1,
              response_time_ms: postCheckElapsed,
              work_product: postCheckParsed as unknown as Record<string, unknown>,
              prompt_component_chars: promptComponentChars,
            });

            const postTopicAligned = postCheckParsed.topic_aligned !== false;
            const postEngages = postCheckParsed.engages ?? true;
            const postAllPass = postCheckParsed.grounded && postCheckParsed.falsifiable && postEngages && postTopicAligned;
            const postRepairGate: DraftQualityGateResult = {
              grounded: postCheckParsed.grounded,
              falsifiable: postCheckParsed.falsifiable,
              engages: postEngages,
              topic_aligned: postTopicAligned,
              pass: postAllPass,
              weaknesses: postCheckParsed.weaknesses,
            };

            const prePassCount = [preRepairGate.grounded, preRepairGate.falsifiable, preRepairGate.engages, preRepairGate.topic_aligned].filter(Boolean).length;
            const postPassCount = [postAllPass ? 4 : [postCheckParsed.grounded, postCheckParsed.falsifiable, postEngages, postTopicAligned].filter(Boolean).length][0];
            const repairOutcome: 'fixed' | 'partial' | 'unchanged' =
              postAllPass ? 'fixed' :
              postPassCount > prePassCount ? 'partial' :
              'unchanged';

            qualityGateResult = { pre_repair: preRepairGate, post_repair: postRepairGate, repair_outcome: repairOutcome };
            if (postTopicAligned) {
              topicAlignmentResult = { topic_aligned: true, repaired: true, draft_attempt: 2 };
            }

            getGlobalRecorder()?.record({
              type: 'turn.quality_gate_repair', component: 'turn-pipeline',
              level: postAllPass ? 'info' : 'warn',
              speaker: input.label,
              message: `Post-repair quality gate: ${repairOutcome}`,
              data: {
                repair_outcome: repairOutcome,
                pre: preRepairGate,
                post: postRepairGate,
              },
            });
          } catch (err) {
            getGlobalRecorder()?.record({ type: 'ai.error', component: 'turn-pipeline', level: 'warn', debate_id: (input as any).debate_id, message: 'Post-repair quality re-check failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
          }
        }
      }
    } catch (err) {
      // Pre-check failure is non-fatal — proceed to cite
      getGlobalRecorder()?.record({ type: 'ai.error', component: 'turn-pipeline', level: 'warn', debate_id: (input as any).debate_id, message: 'Draft quality pre-check failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      console.warn(`[pipeline] Draft quality pre-check failed: ${err instanceof Error ? err.message.slice(0, 100) : err}`);
    }
  }

  } // end frozenDraft else

  // ── Stage 4: CITE (with per-stage validation + retry) ──
  let citeRepairHints: string[] = input.repairHints?.filter(h =>
    /taxonomy_refs.*(?:filler|too-short|relevance)|No new taxonomy_refs|Unknown taxonomy node|Unknown policy_refs|grounding_confidence/i.test(h)
  ) ?? [];
  let citeParsed: ReturnType<typeof parseStageResponse<CiteWorkProduct>>;
  let citeStep = 0; // captured on first attempt; filler-retry re-emits the same step (TL t/3845#1)

  for (let citeAttempt = 0; citeAttempt <= MAX_STAGE_RETRIES; citeAttempt++) {
    onProgress?.('cite', `${input.label} is citing${citeAttempt > 0 ? ` (retry ${citeAttempt})` : ''}...`, citeAttempt === 0 ? { step: (citeStep = ++step), total: totalStages } : { step: citeStep, total: totalStages });
    getGlobalRecorder()?.record({
      type: 'turn.stage', component: 'turn-pipeline', level: 'info',
      speaker: input.label,
      message: `${input.label} entering CITE stage (attempt ${citeAttempt})`,
      data: { stage: 'cite', action: 'enter', attempt: citeAttempt },
    });
    let citePromptText: string;
    let citeRaw: string;
    let citeUsage: { inputTokens: number; outputTokens: number } | undefined;
    t0 = Date.now();
    if (envelopeGenerate) {
      const env = citeStageEnvelope(stageInput, planJson, draftJson);
      if (citeRepairHints.length > 0) {
        env.layer4_variable += `\n\n=== CITATION REPAIR HINTS (from prior failed attempt) ===\n${citeRepairHints.map(h => '- ' + h).join('\n')}\nAddress these issues in your taxonomy references.`;
      }
      citePromptText = flattenEnvelope(env);
      const resp = await envelopeGenerate({ envelope: env, model: citeModel, options: { temperature: temps.cite_temperature } }, `${input.label} cite`);
      citeRaw = resp.text;
      citeUsage = resp.usage;
    } else {
      citePromptText = citeStagePrompt(stageInput, planJson, draftJson);
      if (citeRepairHints.length > 0) {
        citePromptText += `\n\n=== CITATION REPAIR HINTS (from prior failed attempt) ===\n${citeRepairHints.map(h => '- ' + h).join('\n')}\nAddress these issues in your taxonomy references.`;
      }
      citeRaw = await generate(citePromptText, citeModel, { temperature: temps.cite_temperature }, `${input.label} cite`);
    }
    elapsed = Date.now() - t0;
    citeParsed = parseStageResponse<CiteWorkProduct>(citeRaw, 'cite');
    stageDiags.push({
      stage: 'cite', prompt: citePromptText, raw_response: citeRaw,
      model: citeModel, temperature: temps.cite_temperature,
      response_time_ms: elapsed, work_product: citeParsed.product as unknown as Record<string, unknown>,
      parse_error: citeParsed.error,
      retry_trigger: isOuterRetry ? 'orchestration-rerun' : citeAttempt > 0 ? 'stage-retry' : 'initial',
      repair_hints_in: citeRepairHints.length > 0 ? [...citeRepairHints] : undefined,
      prompt_component_chars: promptComponentChars,
      input_tokens: citeUsage?.inputTokens,
      output_tokens: citeUsage?.outputTokens,
    });

    // Per-stage cite validation
    if (citeParsed.product) {
      const citeVal = validateCiteStage({
        taxonomyRefs: (citeParsed.product.taxonomy_refs ?? []) as import('../types.js').TaxonomyRef[],
        policyRefs: citeParsed.product.policy_refs as (string | { policy_id: string; relevance?: string })[] | undefined,
        knownNodeIds: new Set(input.availablePovNodeIds ?? []),
        policyIds: new Set(input.availablePolicyIds ?? []),
        priorTurns: (input as Record<string, unknown>).priorTurns as import('../types.js').TranscriptEntry[] ?? [],
        speaker: input.label,
        targetNodes: plan?.target_nodes,
      });
      const lastDiag = stageDiags[stageDiags.length - 1];
      (lastDiag as Record<string, unknown>).stage_validation = { pass: citeVal.pass, hints: citeVal.repairHints };

      if (citeVal.errorHints.length > 0 && citeAttempt < MAX_STAGE_RETRIES) {
        citeRepairHints = citeVal.errorHints;
        const lastCiteDiag = stageDiags[stageDiags.length - 1];
        (lastCiteDiag as Record<string, unknown>).validation_failed = true;
        (lastCiteDiag as Record<string, unknown>).validation_errors = [...citeVal.errorHints];
        getGlobalRecorder()?.record({
          type: 'turn.repair', component: 'turn-pipeline', level: 'warn',
          speaker: input.label,
          message: `CITE repair attempt ${citeAttempt}: ${citeVal.errorHints.length} error(s)`,
          data: { stage: 'cite', attempt: citeAttempt, hints: citeVal.errorHints },
        });
        console.log(`[pipeline] Cite validation errors (attempt ${citeAttempt}), retrying: ${citeVal.errorHints.join('; ')}`);
        continue;
      }
    }
    break;
  }
  let cite = citeParsed!.product;

  // ── Cite filler retry: strengthen or drop weak refs ──
  const weakRefs = (cite.taxonomy_refs ?? []).filter(
    r => (r.relevance ?? '').trim().length < 40 || isFillerRelevance((r.relevance ?? '').trim()),
  );
  if (weakRefs.length > 0) {
    console.log(`[pipeline] ${weakRefs.length} weak taxonomy_refs detected, running cite retry for: ${weakRefs.map(r => r.node_id).join(', ')}`);
    onProgress?.('cite', `${input.label} is strengthening refs...`, { step: citeStep, total: totalStages });
    const retryPrompt = citeRetryPrompt(
      weakRefs.map(r => ({ node_id: r.node_id, relevance: r.relevance ?? '' })),
      draftJson,
      stageInput.taxonomyContext,
    );
    t0 = Date.now();
    const retryRaw = await generate(retryPrompt, citeModel, { temperature: temps.cite_temperature }, `${input.label} cite-retry`);
    elapsed = Date.now() - t0;
    const retryParsed = parseStageResponse<{ taxonomy_refs: import('../types.js').TaxonomyRef[] }>(retryRaw, 'cite');
    stageDiags.push({
      stage: 'cite', prompt: retryPrompt, raw_response: retryRaw,
      model: citeModel, temperature: temps.cite_temperature,
      response_time_ms: elapsed, work_product: retryParsed.product as unknown as Record<string, unknown>,
      parse_error: retryParsed.error,
      prompt_component_chars: promptComponentChars,
    });

    if (!retryParsed.error && retryParsed.product?.taxonomy_refs) {
      const strengthened = new Map(retryParsed.product.taxonomy_refs.map(r => [r.node_id, r]));
      const weakIds = new Set(weakRefs.map(r => r.node_id));
      // Keep non-weak refs as-is, replace weak refs with strengthened versions (or drop if not returned)
      cite = {
        ...cite,
        taxonomy_refs: [
          ...cite.taxonomy_refs.filter(r => !weakIds.has(r.node_id)),
          ...retryParsed.product.taxonomy_refs,
        ],
      };
    }
  }

  // Record cite quality summary
  if (cite?.taxonomy_refs) {
    const refs = cite.taxonomy_refs as import('../types.js').TaxonomyRef[];
    const novelRefs = refs.filter(r => !(input.priorRefs ?? []).includes(r.node_id));
    const fillerCount = refs.filter(r => isFillerRelevance((r.relevance ?? '').trim())).length;
    getGlobalRecorder()?.record({
      type: 'turn.cite_quality', component: 'turn-pipeline', level: 'info',
      speaker: input.label,
      message: `Cite quality: ${refs.length} refs, ${novelRefs.length} novel, ${fillerCount} filler`,
      data: {
        refs_count: refs.length,
        novel_refs: novelRefs.length,
        filler_strengthened: weakRefs?.length ?? 0,
        filler_dropped: fillerCount,
      },
    });
  }

  return {
    brief,
    plan,
    draft: draft!,
    cite,
    evidenceBlock,
    ignoredEvidenceDocIds: ignoredEvidenceDocIds.length > 0 ? ignoredEvidenceDocIds : undefined,
    stage_diagnostics: stageDiags,
    total_time_ms: Date.now() - pipelineStart,
    editing_meta: editingMeta,
    topicAlignmentResult,
    qualityGateResult,
    degraded_turn: degradedTurn || undefined,
  };
}
