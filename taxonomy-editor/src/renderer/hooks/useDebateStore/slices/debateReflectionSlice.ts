// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { StateCreator } from 'zustand';
import type { DebateStore } from '../types';
import type { ReflectionEdit, ReflectionResult, ReflectionDecision } from '../types';
import { withReflectionDecision, appliedDecision, dismissedDecision } from './reflectionDecisions';
import { loadPovTagRegistry, validatePovTags } from '@lib/schema/povTags';
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
import type { PovNode, CrossCuttingNode as SituationNode, GraphAttributes, Category, Pov, Edge } from '../../../types/taxonomy';
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
import { newItemSuggestionsToProposals, filterNoOpReflectionEdits } from '@lib/debate/confidenceEvolution';
import type { RawNewItemSuggestion } from '@lib/debate/confidenceEvolution';
import type { NewPovItemProposal } from '@lib/debate/types/session';
import { checkDolceCompliance } from '../../../utils/dolceCompliance';
import { nodeTypeFromId } from '@lib/debate/nodeIdUtils';
import {
  computeNodeEngagement,
  validateEditEvidence,
  type NodeEngagement,
  type EngagementTranscriptEntry,
} from '@lib/debate/reflectionScope';
import type { ReflectionTaxonomyNode } from '@lib/debate/prompts/reflection';
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
import { getConfiguredModel, getSpeakerModel } from '../shared/modelConfig';
import { generateTextWithProgress, phaseGuardedSet, summarizeTranscriptEntry, makeStageGenerate, routeTurnValidatorHintsIntoSuggestions, getSourceEvidenceIndex, getDocTitles } from '../shared/generation';
import { createDebateGuard, newAbortController, _abortController, claimDebateDriver, releaseDebateDriver, isDailyLimitError, DAILY_LIMIT_MESSAGE, isCancellationError } from '../shared/guards';
import { pushWarning, recordDiagnostic, recordSignalHistory, getSignalValue, movingAverageSignal, incrementGapInjectionCount, _gapInjectionCount } from '../shared/diagnostics';
import { runNeutralCheckpoint } from '../shared/neutralCheckpoint';
import { seatSouls } from '../shared/seatSouls';
import { enrichPolicyRefs, serializeNodeSourceMap, formatEdgeContext, formatDebaterEdgeContext, getRelevantTaxonomyContext, getAllKnownNodeIds, getAllPolicyIds, findNodeMetaInStore, getTaxonomyContext } from '../shared/taxonomyContext';
import { extractClaimsAndUpdateAN, commitAnNodes, detectZeroClaims } from '../shared/argumentNetwork';

export interface DebateReflectionSlice {
  /** `fullTaxonomySweep` (t/3512) additionally offers the camp's never-engaged nodes — opt-in,
   *  because the debate provides no evidence about them. Default: engaged nodes only. */
  requestReflections: (options?: { fullTaxonomySweep?: boolean }) => Promise<void>;
  /** `allowUnsupportedEvidence` (t/3512) applies an edit the evidence check flagged — the caller
   *  must be an explicit human override; without it such an edit is refused. */
  applyReflectionEdit: (pover: string, editIndex: number, overrides?: { label?: string; description?: string }, options?: { regeneratePhrases?: boolean; allowUnsupportedEvidence?: boolean }) => Promise<{ ok: boolean; error?: string; enrichNodeId?: string }>;
  retryReflectionEditAfterFix: (pover: string, editIndex: number) => Promise<{ ok: boolean; error?: string }>;
  dismissReflectionEdit: (pover: string, editIndex: number) => void;
  /** Apply a `propose_new` proposal (t/1773): create the new POV node AND persist its
   *  proposed edges atomically (one save) — no orphaned node. Edge targets are
   *  re-validated against live node ids at apply time. */
  applyReflectionProposal: (pover: string, proposalIndex: number) => Promise<{ ok: boolean; error?: string; createdNodeId?: string }>;
  dismissReflectionProposal: (pover: string, proposalIndex: number) => void;
  retryEnrichment: (nodeId: string, pov: 'accelerationist' | 'safetyist' | 'skeptic') => Promise<void>;
}

/** Key for `newItemProposalStatus` — a propose_new item's disposition (t/1773). */
const proposalStatusKey = (pover: string, proposalIndex: number) => `${pover}#${proposalIndex}`;

type ReflectionSet = Parameters<StateCreator<DebateStore, [], [], DebateReflectionSlice>>[0];
type ReflectionGet = Parameters<StateCreator<DebateStore, [], [], DebateReflectionSlice>>[1];

/**
 * Provisional weight assignment (t/148) for a freshly-created reflection node — an
 * initial confidence/priority/operationality with a history entry, by BDI category.
 * Shared by the `add` edit path and the propose_new apply path (t/1773).
 */
function assignProvisionalWeight(povKey: Pov, nodeId: string, category: Category): void {
  const taxStore = useTaxonomyStore.getState();
  const createdNode = taxStore[povKey]?.nodes.find(n => n.id === nodeId);
  if (!createdNode) return;
  const today = new Date().toISOString().slice(0, 10);
  if (category === 'Beliefs') {
    const confidence = computeBeliefConfidence({
      epistemic_type: createdNode.graph_attributes?.epistemic_type,
      falsifiability: createdNode.graph_attributes?.falsifiability,
      source_doc_count: 0,
      debate_ref_count: createdNode.debate_refs?.length ?? 0,
      supports_received: 0,
      attacks_received: 0,
      assumes_received: 0,
    });
    taxStore.updatePovNode(povKey, nodeId, {
      confidence,
      confidence_history: [{ date: today, value: confidence, delta: 0, reason: 'provisional — reflection' }],
    });
  } else if (category === 'Desires') {
    const priority = computeTreePriority(createdNode);
    taxStore.updatePovNode(povKey, nodeId, {
      priority,
      priority_history: [{ date: today, value: priority, delta: 0, reason: 'provisional — reflection' }],
    });
  } else if (category === 'Intentions') {
    const operationality = computeOperationality(createdNode);
    taxStore.updatePovNode(povKey, nodeId, {
      operationality,
      operationality_history: [{ date: today, value: operationality, delta: 0, reason: 'provisional — reflection' }],
    });
  }
}

/**
 * Merge an AI enrichment response into a node's existing graph attributes — each field
 * copied only when present. Shared by the reflection-apply enrichment path and the
 * retryEnrichment path so both reach identical attribute fidelity.
 */
function buildEnrichedGraphAttributes(currentAttrs: GraphAttributes | undefined, enriched: any): GraphAttributes {
  return {
    ...currentAttrs,
    ...(enriched.epistemic_type && { epistemic_type: enriched.epistemic_type }),
    ...(enriched.rhetorical_strategy && { rhetorical_strategy: enriched.rhetorical_strategy }),
    ...(enriched.assumes?.length > 0 && { assumes: enriched.assumes }),
    ...(enriched.falsifiability && { falsifiability: enriched.falsifiability }),
    ...(enriched.audience && { audience: enriched.audience }),
    ...(enriched.emotional_register && { emotional_register: enriched.emotional_register }),
    ...(enriched.intellectual_lineage?.length > 0 && { intellectual_lineage: enriched.intellectual_lineage }),
    ...(enriched.steelman_vulnerability && { steelman_vulnerability: enriched.steelman_vulnerability }),
    ...(enriched.node_scope && { node_scope: enriched.node_scope }),
    ...(enriched.attribution_text && { attribution_text: enriched.attribution_text }),
  };
}

/**
 * Clear the `_phrase_regen_pending` dirty flag once attributes + embeddings are fully
 * persisted, then save. No-op if the flag is already gone. Shared by both enrichment paths.
 */
async function clearPhraseRegenPending(povKey: Pov, nodeId: string): Promise<void> {
  const finalNode = useTaxonomyStore.getState()[povKey]?.nodes.find(n => n.id === nodeId);
  if (finalNode?.graph_attributes?._phrase_regen_pending) {
    const finalAttrs = { ...finalNode.graph_attributes };
    delete finalAttrs._phrase_regen_pending;
    useTaxonomyStore.getState().updatePovNode(povKey, nodeId, { graph_attributes: finalAttrs });
    await useTaxonomyStore.getState().save();
  }
}

/** Format a taxonomy save error with its per-field validation details (shared by the three apply paths). */
function formatSaveError(saveError: string, validationErrors: Record<string, string> | null | undefined): string {
  const errorDetails = Object.entries(validationErrors ?? {});
  return errorDetails.length > 0
    ? `${saveError}\n${errorDetails.map(([field, msg]) => `• ${field}: ${msg}`).join('\n')}`
    : saveError;
}

/** Mark one reflection edit `approved` in-place, re-reading the freshest reflections (shared by apply + retry-after-fix). */
function markReflectionEditApproved(pover: string, editIndex: number, set: ReflectionSet, get: ReflectionGet): void {
  const freshReflections = get().reflections;
  const updated = freshReflections.map(r => {
    if (r.pover !== pover) return r;
    return {
      ...r,
      edits: r.edits.map((e, i) => i === editIndex ? { ...e, status: 'approved' as const } : e),
    };
  });
  set({ reflections: updated });
}

/**
 * Save a reflection decision into the debate file's reflection snapshot (t/4214 R-5), so the M2 override rate
 * can be measured from saved debates. A missing snapshot (an older debate) is logged and skipped; the
 * in-memory decision stands either way.
 */
async function persistReflectionDecision(
  pover: string, target: { kind: 'edit' | 'proposal'; index: number }, decision: ReflectionDecision,
  set: ReflectionSet, get: ReflectionGet,
): Promise<void> {
  const debate = get().activeDebate;
  const updated = debate ? withReflectionDecision(debate, pover, target, decision) : null;
  if (!updated) {
    getGlobalRecorder()?.record({
      type: 'state.error', component: 'reflection-decision', level: 'warn',
      message: 'reflection decision not saved: the debate has no reflection snapshot for this seat',
      data: { pover, ...target, outcome: decision.outcome },
    });
    return;
  }
  set({ activeDebate: updated });
  await get().saveDebate('reflectionDecision');
}

/**
 * Mark an applied edit approved and save the decision (shared by apply and retry-after-fix). An edit the evidence
 * check flagged can only have been applied through the evidence override, so it is recorded as `overridden`.
 */
async function recordEditApplied(pover: string, editIndex: number, edit: ReflectionEdit, set: ReflectionSet, get: ReflectionGet): Promise<void> {
  markReflectionEditApproved(pover, editIndex, set, get);
  const overrides = edit.evidence_supported === false ? ['evidence' as const] : undefined;
  await persistReflectionDecision(pover, { kind: 'edit', index: editIndex }, appliedDecision(overrides), set, get);
}

/** Fire-and-forget form for the synchronous dismiss actions; a failure is recorded, never thrown. */
function persistReflectionDecisionInBackground(
  pover: string, target: { kind: 'edit' | 'proposal'; index: number }, decision: ReflectionDecision,
  set: ReflectionSet, get: ReflectionGet,
): void {
  persistReflectionDecision(pover, target, decision, set, get).catch((err: unknown) => {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'reflection-decision', level: 'error',
      message: 'saving a dismissed reflection decision failed',
      data: { pover, ...target },
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  });
}

/**
 * The tag a new node from this seat gets (t/4214 R-4, spec t/4211 §3.1): the tagged seat's own tag. An untagged
 * seat on a POV that has tags leaves the node untagged and records a coverage-gap WARN, so the node can't drop
 * out of Scope unnoticed. A POV with no tags (Accelerationist, Safetyist today) is unaffected.
 */
function proposalNodeTags(povKey: Pov, nodeId: string, pover: string, get: ReflectionGet): string[] | undefined {
  const seatTag = get().activeDebate?.seat_tags?.[pover as SpeakerId]?.pov_tag;
  const povHasTags = (loadPovTagRegistry().povs[povKey as keyof ReturnType<typeof loadPovTagRegistry>['povs']] ?? []).length > 0;
  if (!seatTag) {
    if (povHasTags) {
      getGlobalRecorder()?.record({
        type: 'state.change', component: 'reflection-proposal', level: 'warn',
        message: 'reflection.new_node_untagged: an untagged seat created a node on a POV that has tags; it is a coverage gap for the tag-proposal pipeline',
        data: { node_id: nodeId, pov: povKey, pover },
      });
    }
    return undefined;
  }
  const problems = validatePovTags(nodeId, [seatTag]);
  if (problems.length > 0) {
    getGlobalRecorder()?.record({
      type: 'state.error', component: 'reflection-proposal', level: 'warn',
      message: 'reflection.new_node_tag_invalid: the seat tag failed validatePovTags; the node is left untagged',
      data: { node_id: nodeId, pov: povKey, seat_tag: seatTag, problems },
    });
    return undefined;
  }
  return [seatTag];
}

type TaxStore = ReturnType<typeof useTaxonomyStore.getState>;
type AddNodeResult = { ok: true; nodeId: string } | { ok: false; error: string };

/**
 * The `add` edit branch of applyReflectionEdit: create a fresh POV node (with the t/1564
 * collision backstop and a loadAll retry when the pov file isn't resident), stamp its
 * label/description/attrs, and assign a provisional weight (t/148). Returns the new node id
 * or an actionable error the caller re-returns verbatim.
 */
async function createReflectionAddNode(
  opts: { povKey: Pov; edit: ReflectionEdit; finalLabel: string; finalDescription: string; startTime: number; pover: string; editIndex: number },
  taxStore: TaxStore,
  get: ReflectionGet,
): Promise<AddNodeResult> {
  const { povKey, edit, finalLabel, finalDescription, startTime, pover, editIndex } = opts;
  // t/1564 backstop: snapshot existing IDs before creation so we can detect collisions
  const preExistingIds = new Set<string>();
  for (const p of ['accelerationist', 'safetyist', 'skeptic'] as const) {
    for (const n of (useTaxonomyStore.getState()[p]?.nodes ?? []) as { id: string }[]) preExistingIds.add(n.id);
  }
  let newId = taxStore.createPovNode(povKey, edit.category);
  if (!newId && !useTaxonomyStore.getState()[povKey]) {
    await taxStore.loadAll(true);
    newId = taxStore.createPovNode(povKey, edit.category);
  }
  if (!newId) {
    const duration = Math.round(performance.now() - startTime);
    getGlobalRecorder()?.record({ type: 'state.error', component: 'reflection-edit', level: 'error', message: 'applyReflectionEdit.result', data: { ok: false, error: 'createPovNode returned empty', pover, editIndex, pov_loaded: !!useTaxonomyStore.getState()[povKey], duration_ms: duration } });
    return { ok: false, error: 'Failed to create taxonomy node. Taxonomy data may not be loaded.' };
  }
  if (preExistingIds.has(newId)) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'reflection-edit', level: 'error', message: 'createPovNode generated colliding ID', data: { newId, pover } });
    return { ok: false, error: `Generated ID ${newId} already exists — refusing to overwrite. Please retry.` };
  }
  const debateId = get().activeDebateId;
  taxStore.updatePovNode(povKey, newId, {
    label: finalLabel,
    description: finalDescription,
    graph_attributes: defaultGraphAttributes(povKey, edit.category),
    debate_refs: debateId ? [debateId] : [],
  }, { source: 'debate_reflection', debateId: debateId ?? undefined, reason: edit.rationale || undefined });
  // Provisional weight assignment (t/148) — new nodes get an initial weight immediately
  assignProvisionalWeight(povKey, newId, edit.category);
  return { ok: true, nodeId: newId };
}

/** Inverse of idGenerator's CATEGORY_SLUG — maps the genus word used in the mandated
 *  genus-differentia description format (Line 1: "A Belief/Desire/Intention within...")
 *  back to the taxonomy's plural Category value. */
const GENUS_TO_CATEGORY: Record<string, Category> = {
  belief: 'Beliefs',
  desire: 'Desires',
  intention: 'Intentions',
};

/** Parse the proposed category out of a reflection edit's description text (t/3492).
 *  `edit.category` reflects the node's CURRENT category for edit_existing edits — the
 *  reflection prompt never updates it when a QUALIFY/REVISE changes the genus word — so the
 *  only signal for a category change is the mandated Line 1 genus-differentia opening.
 *  Returns null when the description doesn't match the format (graceful no-op, not an error). */
function parseProposedCategory(description: string): Category | null {
  const match = description.trimStart().match(/^An?\s+(Belief|Desire|Intention)\b/i);
  if (!match) return null;
  return GENUS_TO_CATEGORY[match[1].toLowerCase()] ?? null;
}

/**
 * The `edit_existing` branch of applyReflectionEdit: revise/qualify updates label+description;
 * deprecate prefixes a `[DEPRECATED]` marker when no explicit description is supplied.
 * If the proposed description's genus word implies a different BDI category than the node's
 * current one, cascades the rename via `movePovNodeCategory` (t/3492) and returns the new node
 * id so the caller can enrich/track the renamed node instead of the now-stale old id.
 */
function applyReflectionEditToExistingNode(
  povKey: Pov, edit: ReflectionEdit, finalLabel: string, finalDescription: string,
  taxStore: TaxStore, get: ReflectionGet,
): string | null {
  if (!edit.node_id) return null;
  const reflectionSource = { source: 'debate_reflection' as const, debateId: get().activeDebateId ?? undefined, reason: edit.rationale || undefined };
  if (edit.edit_type === 'deprecate') {
    const deprecatedDesc = finalDescription || `[DEPRECATED] ${edit.current_description || ''}`;
    taxStore.updatePovNode(povKey, edit.node_id, {
      label: finalLabel || edit.current_label || '',
      description: deprecatedDesc,
    }, reflectionSource);
    return null;
  }
  taxStore.updatePovNode(povKey, edit.node_id, {
    label: finalLabel || edit.current_label || '',
    description: finalDescription,
  }, reflectionSource);

  const proposedCategory = parseProposedCategory(finalDescription);
  if (proposedCategory && proposedCategory !== edit.category) {
    return taxStore.movePovNodeCategory(povKey, edit.node_id, proposedCategory);
  }
  return null;
}

/** Gather all live node ids (every POV file, plus situations when requested) for anti-orphan edge validation / collision detection. */
function collectKnownNodeIds(includeSituations = true): Set<string> {
  const ids = new Set<string>();
  for (const p of POV_KEYS) {
    const f = useTaxonomyStore.getState()[p];
    if (f) for (const n of f.nodes) ids.add(n.id);
  }
  if (includeSituations) {
    const situations = useTaxonomyStore.getState().situations;
    if (situations) for (const n of situations.nodes) ids.add(n.id);
  }
  return ids;
}

/**
 * Create the new POV node for an applied propose_new proposal (t/1773) — same collision
 * backstop + loadAll retry as the add path, but proposal-scoped logging. Stamps
 * label/description/attrs and assigns a provisional weight (t/148). Returns the new node id
 * or an actionable error the caller re-returns verbatim.
 */
async function createProposalNode(
  povKey: Pov, proposal: NewPovItemProposal, taxStore: TaxStore, get: ReflectionGet, pover: string, proposalIndex: number,
): Promise<AddNodeResult> {
  // Create the new POV node (mirrors the add path; t/1564 collision backstop).
  const preExistingIds = collectKnownNodeIds(false);
  let newId = taxStore.createPovNode(povKey, proposal.category);
  if (!newId && !useTaxonomyStore.getState()[povKey]) {
    await taxStore.loadAll(true);
    newId = taxStore.createPovNode(povKey, proposal.category);
  }
  if (!newId) {
    getGlobalRecorder()?.record({ type: 'state.error', component: 'reflection-proposal', level: 'error', message: 'applyReflectionProposal.result', data: { ok: false, error: 'createPovNode returned empty', pover, proposalIndex } });
    return { ok: false, error: 'Failed to create taxonomy node. Taxonomy data may not be loaded.' };
  }
  if (preExistingIds.has(newId)) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'reflection-proposal', level: 'error', message: 'createPovNode generated colliding ID', data: { newId, pover } });
    return { ok: false, error: `Generated ID ${newId} already exists — refusing to overwrite. Please retry.` };
  }
  const debateId = get().activeDebateId;
  const povTags = proposalNodeTags(povKey, newId, pover, get);
  taxStore.updatePovNode(povKey, newId, {
    label: proposal.label,
    description: proposal.description,
    graph_attributes: defaultGraphAttributes(povKey, proposal.category),
    debate_refs: debateId ? [debateId] : [],
    ...(povTags ? { pov_tags: povTags } : {}),
  }, { source: 'debate_reflection', debateId: debateId ?? undefined, reason: proposal.rationale || undefined });
  assignProvisionalWeight(povKey, newId, proposal.category);
  return { ok: true, nodeId: newId };
}

/**
 * Enrich a reflection-applied node with AI-generated graph attributes + synthetic
 * embeddings. Shared by the `add`/`revise`/`qualify` edit path and the propose_new
 * apply path (t/1773) so new nodes reach the taxonomy with the same fidelity. Awaits
 * the dirty-flag pre-save, then runs the enrichment itself detached (fire-and-forget):
 * a `_phrase_regen_pending` flag makes an incomplete enrichment detectable across
 * sessions, and enrichmentStatus drives the in-session UI.
 */
async function startReflectionNodeEnrichment(
  opts: { povKey: Pov; nodeId: string; label: string; description: string; category: Category; editType: string; regeneratePhrases: boolean },
  set: ReflectionSet,
  get: ReflectionGet,
): Promise<void> {
  const { povKey, nodeId, label, description, category, editType, regeneratePhrases } = opts;
  // Set dirty flag before starting enrichment
  const preNode = useTaxonomyStore.getState()[povKey]?.nodes.find(n => n.id === nodeId);
  if (preNode) {
    useTaxonomyStore.getState().updatePovNode(povKey, nodeId, {
      graph_attributes: { ...preNode.graph_attributes, _phrase_regen_pending: true },
    });
    await useTaxonomyStore.getState().save();
  }
  set({ enrichmentStatus: { ...get().enrichmentStatus, [nodeId]: { status: 'pending' } } });
  const enrichStartTime = performance.now();
  getGlobalRecorder()?.record({ type: 'state.change', component: 'reflection-enrichment', level: 'info', message: 'enrichment.start', data: { node_id: nodeId, pov: povKey, edit_type: editType, regeneratePhrases } });

  void (async () => {
    try {
      const { reflectionNodeEnrichmentPrompt } = await import('../../../prompts/analysis');
      const enrichPrompt = reflectionNodeEnrichmentPrompt({
        id: nodeId,
        label,
        description,
        category,
        pov: povKey,
      });
      const enrichModel = getConfiguredModel();
      const { text } = await api.generateText(enrichPrompt, enrichModel);
      const enriched = JSON.parse(stripCodeFences(text));
      const currentTaxStore = useTaxonomyStore.getState();
      const currentNode = currentTaxStore[povKey]?.nodes.find(n => n.id === nodeId);
      if (!currentNode) return;
      // Keep dirty flag until embeddings are also done
      currentTaxStore.updatePovNode(povKey, nodeId, { graph_attributes: buildEnrichedGraphAttributes(currentNode.graph_attributes, enriched) });
      await currentTaxStore.save();

      // Clear dirty flag only after attributes + embeddings are fully done
      await clearPhraseRegenPending(povKey, nodeId);

      const enrichDuration = Math.round(performance.now() - enrichStartTime);
      getGlobalRecorder()?.record({ type: 'state.change', component: 'reflection-enrichment', level: 'info', message: 'enrichment.complete', duration_ms: enrichDuration, data: { node_id: nodeId, pov: povKey, fields: Object.keys(enriched), regeneratePhrases } });
      set({ enrichmentStatus: { ...get().enrichmentStatus, [nodeId]: { status: 'success' } } });
    } catch (err) {
      const enrichDuration = Math.round(performance.now() - enrichStartTime);
      getGlobalRecorder()?.record({ type: 'system.error', component: 'reflection-enrichment', level: 'error', message: 'enrichment.failed', duration_ms: enrichDuration, error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack }, data: { node_id: nodeId, pov: povKey, edit_type: editType } });
      set({ enrichmentStatus: { ...get().enrichmentStatus, [nodeId]: { status: 'error', error: String(err) } } });
    }
  })();
}

/** Raw reflection edit as parsed from the model response (pre-grounding). */
interface RawReflectionEdit {
  disposition?: string;
  edit_type: string;
  node_id: string | null;
  category: string;
  current_label: string | null;
  proposed_label: string;
  current_description: string | null;
  proposed_description: string;
  rationale: string;
  confidence?: string;
  evidence_entries?: string[];
}

/**
 * Assemble the per-camp prompt context blocks for a reflection: the argument-network summary,
 * the camp's commitments, and the recent convergence-signal digest. Any block is `undefined`
 * when its underlying data is absent.
 */
function buildReflectionContextBlocks(
  activeDebate: DebateSession,
  pover: Exclude<SpeakerId, 'user'>,
): { anBlock: string | undefined; commitBlock: string; convBlock: string | undefined } {
  const an = activeDebate.argument_network;
  const anBlock = an
    ? formatArgumentNetworkContext(
        an.nodes.map(n => ({ id: n.id, text: n.text, speaker: POVER_INFO[n.speaker as Exclude<SpeakerId, 'user'>]?.label || n.speaker })),
        an.edges,
      )
    : undefined;

  const speakerClaims = (an?.nodes || []).filter(n => n.speaker === pover);
  const commitBlock = formatCommitments(
    activeDebate.commitments?.[pover] || { asserted: [], conceded: [], challenged: [] },
    speakerClaims,
  );

  const convSignals = activeDebate.convergence_signals;
  const convBlock = convSignals && convSignals.length > 0
    ? convSignals.slice(-5).map(s =>
        `Turn ${s.entry_id} (${POVER_INFO[s.speaker as Exclude<SpeakerId, 'user'>]?.label || s.speaker}): ` +
        `move_polarity=${s.move_polarity?.ratio?.toFixed(2) ?? 'N/A'}, ` +
        `dialectical_engagement=${s.dialectical_engagement?.ratio?.toFixed(2) ?? 'N/A'}, ` +
        `argument_redundancy=${s.argument_redundancy?.max_self_overlap?.toFixed(2) ?? 'N/A'}`
      ).join('\n')
    : undefined;

  return { anBlock, commitBlock, convBlock };
}

/**
 * Map raw edit_existing reflection edits into ReflectionEdit records, grounding
 * current_label/current_description against the live taxonomy to prevent hallucinated labels
 * (t/1564). propose_new entries are excluded upstream; `add` node_ids are cleared (t/1564).
 */
/** Camp → node-id prefix (the inverse of POV_PREFIXES, which is keyed by prefix). */
const POV_PREFIX_BY_KEY: Record<Pov, string> = {
  accelerationist: 'acc-',
  safetyist: 'saf-',
  skeptic: 'skp-',
};

/**
 * Build the reflector's node list (t/3512). Only nodes THIS debate engaged — injected, cited, or
 * referenced by an argument-network claim — ranked by engagement, each carrying its debate record.
 * `fullTaxonomySweep` additionally passes the never-engaged remainder as a clearly-marked block.
 *
 * Fallback: a camp with zero engaged nodes (nothing injected or cited — e.g. a debate that failed
 * relevance selection) falls back to the full taxonomy and records a WARN, since reflecting on
 * nothing is worse than reflecting unscoped.
 */
function buildReflectionNodes(
  activeDebate: DebateSession,
  povNodes: PovNode[],
  povPrefix: string,
  fullTaxonomySweep: boolean,
): { nodes: ReflectionTaxonomyNode[]; unengaged?: ReflectionTaxonomyNode[]; engagementById: Map<string, NodeEngagement> } {
  const engagements = computeNodeEngagement({
    transcript: activeDebate.transcript as unknown as EngagementTranscriptEntry[],
    anNodes: activeDebate.argument_network?.nodes ?? [],
    anEdges: activeDebate.argument_network?.edges ?? [],
  }, povPrefix);
  const engagementById = new Map(engagements.map(e => [e.nodeId, e]));
  const byId = new Map(povNodes.map(n => [n.id, n]));
  const toPromptNode = (n: PovNode, e?: NodeEngagement): ReflectionTaxonomyNode => ({
    id: n.id,
    category: n.category,
    label: n.label,
    description: n.description,
    ...(e ? { engagement: { injected: e.injected, citations: e.citations, claimIds: e.claimIds, attackedClaimIds: e.attackedClaimIds, strongestAttack: e.strongestAttack } } : {}),
  });

  // Engaged, in rank order; skip ids that no longer exist in the POV file.
  const nodes = engagements
    .map(e => { const n = byId.get(e.nodeId); return n ? toPromptNode(n, e) : null; })
    .filter((n): n is ReflectionTaxonomyNode => n !== null);

  if (nodes.length === 0) {
    getGlobalRecorder()?.record({
      type: 'state.change', component: 'debate-store', level: 'warn',
      message: 'Reflection scope: no engaged nodes for this camp — falling back to the full taxonomy',
      data: { pov_prefix: povPrefix, debate_id: activeDebate.id, pov_node_count: povNodes.length, reason: 'no_injected_or_cited_nodes' },
    });
    return { nodes: povNodes.map(n => toPromptNode(n)), engagementById };
  }

  const unengaged = fullTaxonomySweep
    ? povNodes.filter(n => !engagementById.has(n.id)).map(n => toPromptNode(n))
    : undefined;

  getGlobalRecorder()?.record({
    type: 'state.change', component: 'debate-store', level: 'info',
    message: `Reflection scope: ${nodes.length} engaged node(s) of ${povNodes.length}${unengaged ? ` (+${unengaged.length} swept)` : ''}`,
    data: { pov_prefix: povPrefix, engaged: nodes.length, total: povNodes.length, swept: unengaged?.length ?? 0, top_engaged: nodes.slice(0, 5).map(n => n.id) },
  });
  return { nodes, unengaged, engagementById };
}

function mapRawEditsToReflectionEdits(rawEdits: RawReflectionEdit[], taxState: TaxStore): ReflectionEdit[] {
  return rawEdits.filter(e => e.disposition !== 'propose_new').map(e => {
    // Ground-truth: override AI-provided current_label/current_description
    // with actual taxonomy values to prevent hallucinated labels.
    let currentLabel = e.current_label;
    let currentDescription = e.current_description;
    // t/1564: AI sometimes hallucinates existing node IDs for add edits
    if (e.edit_type === 'add') e.node_id = null;
    if (e.node_id) {
      const realLabel = taxState.getLabelForId(e.node_id);
      const realDesc = taxState.getDescriptionForId(e.node_id);
      if (realLabel && realLabel !== e.node_id) currentLabel = realLabel;
      if (realDesc) currentDescription = realDesc;
    }
    return {
      edit_type: (e.edit_type || 'revise') as ReflectionEdit['edit_type'],
      node_id: e.node_id ?? null,
      category: (e.category || 'Beliefs') as ReflectionEdit['category'],
      current_label: currentLabel,
      proposed_label: e.proposed_label || '',
      current_description: currentDescription,
      proposed_description: e.proposed_description || '',
      rationale: e.rationale || '',
      confidence: (['high', 'medium', 'low'].includes(e.confidence || '') ? e.confidence : 'medium') as ReflectionEdit['confidence'],
      evidence_entries: Array.isArray(e.evidence_entries) ? e.evidence_entries : [],
      status: 'pending' as const,
    };
  });
}

/**
 * Attach the evidence check + engagement record to each edit (t/3512). An edit whose cited claims
 * do not reference the node it edits is FLAGGED (`evidence_supported: false`), not dropped — the
 * reflection may still be right, but `applyReflectionEdit` refuses it without an explicit override.
 */
function annotateEditEvidence(
  edits: ReflectionEdit[],
  anNodes: ArgumentNetworkNode[],
  engagementById: Map<string, NodeEngagement>,
  pover: string,
): ReflectionEdit[] {
  for (const edit of edits) {
    const check = validateEditEvidence(edit.node_id, edit.evidence_entries, anNodes);
    edit.evidence_supported = check.supported;
    edit.evidence_note = check.reason;
    const e = edit.node_id ? engagementById.get(edit.node_id) : undefined;
    edit.engagement = e
      ? { injected: e.injected, citations: e.citations, claim_count: e.claimIds.length, attacked_count: e.attackedClaimIds.length }
      : { injected: false, citations: 0, claim_count: 0, attacked_count: 0 };
    if (!check.supported) {
      getGlobalRecorder()?.record({
        type: 'state.change', component: 'debate-store', level: 'warn',
        message: `Reflection edit flagged unsupported: ${edit.node_id ?? '(new node)'} — ${check.reason}`,
        data: { pover, node_id: edit.node_id, edit_type: edit.edit_type, evidence_entries: edit.evidence_entries, unrelated_claims: check.unrelatedClaimIds, unresolved: check.unresolvedEntries, engagement: edit.engagement },
      });
    }
  }
  return edits;
}

/**
 * Generate validated propose_new node proposals (t/1773). Edges are validated against real
 * node ids; a proposal with no valid edge is dropped (anti-orphan, t/1725). NON-FATAL: this
 * must never break the edit_existing flow — on any failure it returns no proposals.
 */
function generateNewItemProposals(rawEdits: RawReflectionEdit[], povKey: Pov, debateId: string): NewPovItemProposal[] {
  try {
    return newItemSuggestionsToProposals({
      suggestions: rawEdits as unknown as RawNewItemSuggestion[],
      pov: povKey,
      debateId,
      knownNodeIds: collectKnownNodeIds(true),
    });
  } catch (genErr) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-store', level: 'warn', message: 'propose_new proposal generation failed (non-fatal)', error: { name: (genErr as Error).name ?? 'Error', message: String(genErr), stack: (genErr as Error).stack } });
    return [];
  }
}

/**
 * DOLCE-compliance retry loop: for each edit with an error-severity violation, ask the model
 * to fix the description up to 3 times (mutates edits in place). Returns `true` if the debate
 * guard invalidated mid-flight (caller must abort the whole run).
 */
async function runDolceComplianceRetries(
  edits: ReflectionEdit[],
  model: string,
  info: { label: string },
  activeDebate: DebateSession,
  set: ReflectionSet,
  isStillValid: () => boolean,
): Promise<boolean> {
  for (let ei = 0; ei < edits.length; ei++) {
    const edit = edits[ei];
    const MAX_DOLCE_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_DOLCE_RETRIES; attempt++) {
      const violations = checkDolceCompliance(edit.proposed_description, edit.node_id || '');
      const errors = violations.filter(v => v.severity === 'error');
      if (errors.length === 0) break;
      if (!isStillValid()) return true;

      set({ debateActivity: `${info.label}: fixing DOLCE compliance (attempt ${attempt}/${MAX_DOLCE_RETRIES})…` });
      try {
        const retryPrompt = dolceComplianceRetryPrompt(edit, violations, attempt);
        const { text: retryText } = await api.generateText(retryPrompt, model);
        const fixed = parseAIJson<{
          proposed_description?: string;
          proposed_label?: string;
        }>(retryText);
        if (fixed?.proposed_description) {
          edit.proposed_description = fixed.proposed_description;
          if (fixed.proposed_label) edit.proposed_label = fixed.proposed_label;
        }
      } catch (retryErr) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          debate_id: activeDebate?.id,
          component: 'debate-store',
          level: 'warn',
          message: `DOLCE compliance retry ${attempt} failed for edit ${ei}`,
          error: { name: (retryErr as Error).name ?? 'Error', message: String(retryErr), stack: (retryErr as Error).stack },
        });
        console.warn(`[debate] DOLCE retry ${attempt} failed for edit ${ei}:`, retryErr);
        break;
      }
    }
  }
  return false;
}

/**
 * After a successful applyReflectionEdit save, enrich the affected node (new node OR edited
 * node; deprecations are skipped since they're being retired). Returns the enriched node id,
 * or null when there is nothing to enrich.
 */
async function enrichAppliedEditNode(
  povKey: Pov, edit: ReflectionEdit, createdNodeId: string | null,
  finalLabel: string, finalDescription: string, regenerateOverride: boolean,
  set: ReflectionSet, get: ReflectionGet,
): Promise<string | null> {
  const enrichNodeId = createdNodeId ?? (edit.node_id && edit.edit_type !== 'deprecate' ? edit.node_id : null);
  if (!enrichNodeId) return null;
  const shouldRegeneratePhrases = edit.edit_type === 'add' || regenerateOverride;
  await startReflectionNodeEnrichment({
    povKey,
    nodeId: enrichNodeId,
    label: finalLabel || edit.current_label || '',
    description: finalDescription,
    category: edit.category,
    editType: edit.edit_type,
    regeneratePhrases: shouldRegeneratePhrases,
  }, set, get);
  return enrichNodeId;
}

export const createDebateReflectionSlice: StateCreator<DebateStore, [], [], DebateReflectionSlice> = (set, get) => ({
  requestReflections: async (options) => {
    const { activeDebate, saveDebate } = get();
    if (!activeDebate) return;
    const fullTaxonomySweep = options?.fullTaxonomySweep ?? false;

    const isStillValid = createDebateGuard(get);
    set({ debateError: null, debateWarnings: [], reflections: [], newItemProposalStatus: {} });

    const model = getConfiguredModel();
    const fullTranscript = formatRecentTranscript(activeDebate.transcript, 50);
    const povers = (activeDebate.active_povers ?? []).filter(p => p !== 'user') as Exclude<SpeakerId, 'user'>[];
    const results: ReflectionResult[] = [];

    for (const pover of povers) {
      if (!isStillValid()) return;
      if (!POVER_INFO[pover]) continue;
      const info = seatSouls(activeDebate, pover).soul; // t/3975

      set({ debateGenerating: pover as SpeakerId, debateStepStartedAt: Date.now() });

      const taxState = useTaxonomyStore.getState();
      const povKey = info.pov as 'accelerationist' | 'safetyist' | 'skeptic';
      const povFile = taxState[povKey];
      // t/3512 — the reflector sees the nodes THIS debate engaged, ranked, with their debate
      // record; the full taxonomy is an opt-in sweep. Previously it received every node in the
      // camp (207-361), so it edited nodes the debate never touched.
      const { nodes, unengaged, engagementById } = buildReflectionNodes(
        activeDebate,
        povFile?.nodes ?? [],
        POV_PREFIX_BY_KEY[povKey],
        fullTaxonomySweep,
      );

      const { anBlock, commitBlock, convBlock } = buildReflectionContextBlocks(activeDebate, pover);

      // Pass prior reflections so later camps don't duplicate earlier proposals
      const priorReflections = results.map(r => ({
        pov: r.pover,
        edits: r.edits.map(e => ({
          edit_type: e.edit_type,
          proposed_label: e.proposed_label,
          category: e.category,
        })),
      }));

      const prompt = reflectionPrompt(
        info.label,
        info.pov,
        info.personality,
        activeDebate.topic.final,
        nodes,
        fullTranscript,
        anBlock || undefined,
        commitBlock || undefined,
        convBlock,
        activeDebate.audience,
        priorReflections.length > 0 ? priorReflections : undefined,
        unengaged,
        info, // t/3975: the seat's resolved soul (base soul when untagged)
      );

      try {
        const { text } = await generateTextWithProgress(prompt, model, `${info.label} is reflecting...`, set, 120_000);
        if (!isStillValid()) return;

        const parsed = parseAIJson<{
          reflection_summary?: string;
          edits?: RawReflectionEdit[];
        }>(text);

        // Partition by disposition (t/1773): edit_existing entries flow through the
        // existing ReflectionEdit mapping unchanged (no-regression). propose_new entries
        // were silently mangled into 'revise' edits before — they are excluded here and
        // routed to newItemSuggestionsToProposals below. `add` is retired at the prompt
        // (t/1820), so edit_existing is revise/qualify/deprecate only.
        const rawEdits = parsed?.edits ?? [];
        // t/3813: drop edit_existing proposals whose description is unchanged from current
        // (whitespace-normalized) before they reach the UI — the QUALIFY/REVISE generator has
        // no way to decline, so it can emit a no-op proposal that renders as fully approvable.
        const filteredRawEdits = filterNoOpReflectionEdits(rawEdits, activeDebate.id);
        const edits: ReflectionEdit[] = annotateEditEvidence(
          mapRawEditsToReflectionEdits(filteredRawEdits, useTaxonomyStore.getState()),
          activeDebate.argument_network?.nodes ?? [],
          engagementById,
          pover,
        );

        // Validated new-node proposals (t/1773 front-half): wire the shared generator
        // (previously zero production callers) so propose_new suggestions actually
        // materialize. Edges are validated against real node ids; a proposal with no valid
        // edge is dropped (anti-orphan, t/1725). Accept/apply + UI land in the follow-on.
        const newItemProposals = generateNewItemProposals(rawEdits, povKey, activeDebate.id);

        // DOLCE compliance retry — fix non-compliant descriptions up to 3 times
        if (await runDolceComplianceRetries(edits, model, info, activeDebate, set, isStillValid)) return;

        results.push({
          pover: povKey,
          label: info.label,
          reflection_summary: parsed?.reflection_summary || '',
          edits,
          new_item_proposals: newItemProposals,
        });

        set({ reflections: [...results] });
      } catch (err) {
        // User cancel / model switch (t/2508) — stop the reflection loop quietly, don't push
        // a spurious "Error:" reflection entry (helper already logged the info event).
        if (isCancellationError(err)) return;
        getGlobalRecorder()?.record({
          type: 'system.error',
          debate_id: activeDebate?.id,
          component: 'debate-store',
          level: 'error',
          message: `Reflection generation failed for ${info.label}`,
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        results.push({
          pover: povKey,
          label: info.label,
          reflection_summary: `Error: ${mapErrorToUserMessage(err)}`,
          edits: [],
        });
        set({ reflections: [...results] });
      }
    }

    // Cross-camp consensus clustering of new-node proposals was RETIRED here (t/1773,
    // ruling B). It merged EDGELESS `add` proposals into one shared situation node — but
    // `add` is retired (t/1820) and propose_new nodes carry their own camp-specific edges
    // (t/1725), so merging camps' proposals into a situation would destroy exactly those
    // edges. propose_new now applies per-camp, independently (applyReflectionProposal).
    // Convergence detection, if re-homed, is a separate additive/edge-based feature
    // (CONVERGES_WITH between persisted camp nodes) — DebateTool owns; not a t/1773 concern.

    // Add a transcript entry for the reflection
    const summaryLines = results.map(r => {
      const proposalCount = r.new_item_proposals?.length ?? 0;
      const proposalNote = proposalCount > 0
        ? `, ${proposalCount} new item${proposalCount !== 1 ? 's' : ''} proposed`
        : '';
      return `**${r.label}:** ${r.reflection_summary} (${r.edits.length} edit${r.edits.length !== 1 ? 's' : ''} proposed${proposalNote})`;
    });
    const reflEntry: TranscriptEntry = {
      id: generateId(),
      speaker: 'system',
      type: 'reflection',
      content: `## Reflections\n\n${summaryLines.join('\n\n')}`,
      timestamp: nowISO(),
      taxonomy_refs: [],
      metadata: { reflection_results: results },
    };
    set({
      debateGenerating: null,
      activeDebate: {
        ...get().activeDebate!,
        transcript: [...get().activeDebate!.transcript, reflEntry],
        updated_at: nowISO(),
      },
    });
    await saveDebate('requestReflections');
  },

  applyReflectionEdit: async (pover: string, editIndex: number, overrides?: { label?: string; description?: string }, options?: { regeneratePhrases?: boolean; allowUnsupportedEvidence?: boolean }) => {
    const startTime = performance.now();
    const { reflections } = get();
    const reflection = reflections.find(r => r.pover === pover);
    const edit = reflection?.edits[editIndex];
    getGlobalRecorder()?.record({ type: 'state.change', component: 'reflection-edit', level: 'info', message: 'applyReflectionEdit.called', data: { pover, editIndex, edit_type: edit?.edit_type, node_id: edit?.node_id, hasOverrides: !!overrides } });
    if (!reflection || !edit) { getGlobalRecorder()?.record({ type: 'state.error', component: 'reflection-edit', level: 'warn', message: 'applyReflectionEdit.result', data: { ok: false, error: 'Edit not found', pover, editIndex } }); return { ok: false, error: 'Edit not found' }; }

    // Evidence gate (t/3512): an edit whose cited claims do not reference the node it edits is not
    // applied. The debate did not test that node, so the edit has no warrant — the human can still
    // override deliberately (ReflectionsPanel asks first), which is recorded.
    if (edit.evidence_supported === false && !options?.allowUnsupportedEvidence) {
      getGlobalRecorder()?.record({
        type: 'state.error', component: 'reflection-edit', level: 'warn',
        message: 'applyReflectionEdit.refused_unsupported_evidence',
        data: { pover, editIndex, node_id: edit.node_id, evidence_entries: edit.evidence_entries, engagement: edit.engagement, note: edit.evidence_note },
      });
      return { ok: false, error: `Unsupported by debate evidence — ${edit.evidence_note ?? 'no cited claim references this node'}. Review the rationale; apply anyway to override.` };
    }
    if (edit.evidence_supported === false && options?.allowUnsupportedEvidence) {
      getGlobalRecorder()?.record({
        type: 'state.change', component: 'reflection-edit', level: 'warn',
        message: 'applyReflectionEdit.unsupported_evidence_overridden',
        data: { pover, editIndex, node_id: edit.node_id, note: edit.evidence_note },
      });
    }

    const finalLabel = overrides?.label ?? edit.proposed_label;
    const finalDescription = overrides?.description ?? edit.proposed_description;
    const taxStore = useTaxonomyStore.getState();
    const povKey = pover as 'accelerationist' | 'safetyist' | 'skeptic';

    let createdNodeId: string | null = null;
    if (edit.edit_type === 'add') {
      const addResult = await createReflectionAddNode({ povKey, edit, finalLabel, finalDescription, startTime, pover, editIndex }, taxStore, get);
      if (!addResult.ok) return { ok: false, error: addResult.error };
      createdNodeId = addResult.nodeId;
    } else if (edit.node_id) {
      createdNodeId = applyReflectionEditToExistingNode(povKey, edit, finalLabel, finalDescription, taxStore, get);
    }

    await taxStore.save();

    // Only mark as approved if save succeeded — include specific validation errors
    const { saveError, validationErrors } = useTaxonomyStore.getState();
    const duration = Math.round(performance.now() - startTime);
    if (saveError) {
      const detailedError = formatSaveError(saveError, validationErrors);
      getGlobalRecorder()?.record({ type: 'state.error', component: 'reflection-edit', level: 'error', message: 'applyReflectionEdit.result', data: { ok: false, error: saveError, validationErrors, pover, editIndex, duration_ms: duration } });
      return { ok: false, error: detailedError };
    }

    // t/1567: force-reload taxonomy from disk so the accepting window's store
    // is fully consistent (embeddings, situations, etc.) for subsequent debates.
    await useTaxonomyStore.getState().loadAll(true);

    // Enrich with AI-generated graph attributes + synthetic embeddings.
    // Runs for new nodes AND edited nodes (skip deprecations — those are being retired).
    // Uses a dirty flag (_phrase_regen_pending) so incomplete enrichments are detectable across sessions.
    const enrichNodeId = await enrichAppliedEditNode(povKey, edit, createdNodeId, finalLabel, finalDescription, !!options?.regeneratePhrases, set, get);

    getGlobalRecorder()?.record({ type: 'state.change', component: 'reflection-edit', level: 'info', message: 'applyReflectionEdit.result', data: { ok: true, pover, editIndex, edit_type: edit.edit_type, node_id: edit.node_id, enrichNodeId, duration_ms: duration } });
    trackDebateExtraction(get().activeDebateId ?? undefined, edit.edit_type, edit.node_id ?? '');
    await recordEditApplied(pover, editIndex, edit, set, get);
    return { ok: true, enrichNodeId: enrichNodeId ?? undefined };
  },

  // "Fix it" recovery: a prior applyReflectionEdit already mutated the node in memory but
  // its save was rejected by the taxonomy integrity check (e.g. dangling CONVERGES_WITH
  // edges left over from consensus acceptance). Auto-remove the dangling references, then
  // re-save the still-pending change — no node is re-created, so 'add' edits can't duplicate.
  retryReflectionEditAfterFix: async (pover: string, editIndex: number) => {
    const { reflections } = get();
    const reflection = reflections.find(r => r.pover === pover);
    const edit = reflection?.edits[editIndex];
    if (!reflection || !edit) return { ok: false, error: 'Edit not found' };

    const taxStore = useTaxonomyStore.getState();
    taxStore.fixIntegrityErrors();
    await useTaxonomyStore.getState().save();

    const { saveError, validationErrors } = useTaxonomyStore.getState();
    if (saveError) {
      const detailedError = formatSaveError(saveError, validationErrors);
      getGlobalRecorder()?.record({ type: 'state.error', component: 'reflection-edit', level: 'error', message: 'retryReflectionEditAfterFix.result', data: { ok: false, error: saveError, pover, editIndex } });
      return { ok: false, error: detailedError };
    }

    getGlobalRecorder()?.record({ type: 'state.change', component: 'reflection-edit', level: 'info', message: 'retryReflectionEditAfterFix.result', data: { ok: true, pover, editIndex, edit_type: edit.edit_type, node_id: edit.node_id } });
    await recordEditApplied(pover, editIndex, edit, set, get);
    return { ok: true };
  },

  dismissReflectionEdit: (pover: string, editIndex: number) => {
    const { reflections } = get();
    const updated = reflections.map(r => {
      if (r.pover !== pover) return r;
      return {
        ...r,
        edits: r.edits.map((e, i) => i === editIndex ? { ...e, status: 'dismissed' as const } : e),
      };
    });
    set({ reflections: updated });
    persistReflectionDecisionInBackground(pover, { kind: 'edit', index: editIndex }, dismissedDecision(), set, get);
  },

  // Apply a propose_new proposal (t/1773, ruling B): create the new POV node AND persist
  // its proposed edges atomically — per-camp, independent, no consensus integration.
  applyReflectionProposal: async (pover: string, proposalIndex: number) => {
    const startTime = performance.now();
    const { reflections } = get();
    const reflection = reflections.find(r => r.pover === pover);
    const proposal = reflection?.new_item_proposals?.[proposalIndex];
    getGlobalRecorder()?.record({ type: 'state.change', component: 'reflection-proposal', level: 'info', message: 'applyReflectionProposal.start', data: { pover, proposalIndex, category: proposal?.category, edgeCount: proposal?.proposed_edges.length, edgesFileLoaded: !!useTaxonomyStore.getState().edgesFile } });
    if (!reflection || !proposal) { getGlobalRecorder()?.record({ type: 'state.error', component: 'reflection-proposal', level: 'warn', message: 'applyReflectionProposal.result', data: { ok: false, error: 'Proposal not found', pover, proposalIndex } }); return { ok: false, error: 'Proposal not found' }; }

    const taxStore = useTaxonomyStore.getState();
    const povKey: Pov = proposal.pov;

    // Re-validate edge targets against LIVE node ids at apply time (t/1773 AC2, anti-orphan).
    // The generator validated against a snapshot; a target could have been deleted/renamed
    // since. Keep only edges whose target still resolves to a persisted node (pov/situation).
    const knownNodeIds = collectKnownNodeIds(true);
    const liveEdges = proposal.proposed_edges.filter(e => knownNodeIds.has(e.target_node_id));
    if (liveEdges.length < 1) {
      getGlobalRecorder()?.record({ type: 'state.error', component: 'reflection-proposal', level: 'warn', message: 'applyReflectionProposal.result', data: { ok: false, error: 'no live edge targets', pover, proposalIndex } });
      return { ok: false, error: 'All proposed edge targets no longer exist — cannot create an unconnected node.' };
    }

    // t/2055: the edges file MUST be loaded before we create the node. loadEdges() is
    // lazy — triggered on turn generation (debatePhaseSlice) or the Related Edges panel —
    // so a RESUMED debate opened straight to reflections (no new turns) never triggered it:
    // edgesFile stayed null and the proposal's edges were silently dropped AFTER the node
    // was already created. Load it here and bail BEFORE createProposalNode, so a load
    // failure never leaves a node persisted without its edges (AC3).
    let currentEdgesFile = useTaxonomyStore.getState().edgesFile;
    if (!currentEdgesFile) {
      await useTaxonomyStore.getState().loadEdges();
      currentEdgesFile = useTaxonomyStore.getState().edgesFile;
    }
    if (!currentEdgesFile) {
      getGlobalRecorder()?.record({ type: 'state.error', component: 'reflection-proposal', level: 'error', message: 'applyReflectionProposal.result', data: { ok: false, error: 'edges file not loaded', pover, proposalIndex } });
      return { ok: false, error: 'Edges file not loaded — cannot persist proposed edges.' };
    }

    const createResult = await createProposalNode(povKey, proposal, taxStore, get, pover, proposalIndex);
    if (!createResult.ok) return { ok: false, error: createResult.error };
    const newId = createResult.nodeId;

    // Build the proposed edges, substituting the freshly-minted node id for the new-node
    // endpoint (new_node_role). Persist them together with the node in ONE save() call — both
    // the pov file (marked dirty by createPovNode/updatePovNode) and the edges file are
    // written in the same save, so there is never an orphaned node on disk (t/1725 AC2).
    // `currentEdgesFile` was loaded + null-checked above, before node creation (t/2055).
    const newEdges: Edge[] = liveEdges.map(pe => {
      const confidence = typeof pe.confidence === 'number' ? pe.confidence : 0.7;
      return {
        source: pe.new_node_role === 'source' ? newId : pe.target_node_id,
        target: pe.new_node_role === 'target' ? newId : pe.target_node_id,
        type: pe.edge_type,
        bidirectional: false,
        confidence,
        weight: confidence,
        rationale: pe.rationale,
        // Write-together invariant (t/2975, marker spec): this is the debate-reflection edge
        // writer, so stamp `rationale_source = 'reflection'` in the SAME write that sets a
        // non-empty `rationale`. An absent/empty rationale leaves the field absent — never
        // coerced to null/empty (absent≠null contract, t/2943).
        ...(pe.rationale ? { rationale_source: 'reflection' as const } : {}),
        status: 'proposed',
        discovered_at: nowISO(),
        model: 'debate-reflection',
      };
    });
    const updatedEdgesFile = {
      ...currentEdgesFile,
      last_modified: nowISO(),
      edges: [...currentEdgesFile.edges, ...newEdges],
    };
    const dirty = new Set(useTaxonomyStore.getState().dirty);
    dirty.add('edges');
    useTaxonomyStore.setState({ edgesFile: updatedEdgesFile, dirty });

    // Atomic persist — node + edges in one save().
    await taxStore.save();
    const { saveError, validationErrors } = useTaxonomyStore.getState();
    const duration = Math.round(performance.now() - startTime);
    if (saveError) {
      const detailedError = formatSaveError(saveError, validationErrors);
      getGlobalRecorder()?.record({ type: 'state.error', component: 'reflection-proposal', level: 'error', message: 'applyReflectionProposal.result', data: { ok: false, error: saveError, validationErrors, pover, proposalIndex, duration_ms: duration } });
      return { ok: false, error: detailedError };
    }

    // t/1567: force-reload so the accepting window is fully consistent for subsequent debates.
    await useTaxonomyStore.getState().loadAll(true);

    // Enrich the new node (attributes + synthetic embeddings) — same fidelity as an add edit.
    await startReflectionNodeEnrichment({
      povKey,
      nodeId: newId,
      label: proposal.label,
      description: proposal.description,
      category: proposal.category,
      editType: 'propose_new',
      regeneratePhrases: true,
    }, set, get);

    getGlobalRecorder()?.record({ type: 'state.change', component: 'reflection-proposal', level: 'info', message: 'applyReflectionProposal.result', data: { ok: true, pover, proposalIndex, createdNodeId: newId, edges: newEdges.length, duration_ms: duration } });
    trackDebateExtraction(get().activeDebateId ?? undefined, 'propose_new', newId);
    set({ newItemProposalStatus: { ...get().newItemProposalStatus, [proposalStatusKey(pover, proposalIndex)]: 'approved' } });
    await persistReflectionDecision(pover, { kind: 'proposal', index: proposalIndex }, appliedDecision(undefined), set, get);
    return { ok: true, createdNodeId: newId };
  },

  dismissReflectionProposal: (pover: string, proposalIndex: number) => {
    set({ newItemProposalStatus: { ...get().newItemProposalStatus, [proposalStatusKey(pover, proposalIndex)]: 'dismissed' } });
    persistReflectionDecisionInBackground(pover, { kind: 'proposal', index: proposalIndex }, dismissedDecision(), set, get);
  },

  retryEnrichment: async (nodeId: string, pov: 'accelerationist' | 'safetyist' | 'skeptic') => {
    const taxStore = useTaxonomyStore.getState();
    const node = taxStore[pov]?.nodes.find(n => n.id === nodeId);
    if (!node) return;

    // Ensure dirty flag is set before starting so a crash mid-retry is detectable
    useTaxonomyStore.getState().updatePovNode(pov, nodeId, {
      graph_attributes: { ...node.graph_attributes, _phrase_regen_pending: true },
    });
    await useTaxonomyStore.getState().save();

    set({ enrichmentStatus: { ...get().enrichmentStatus, [nodeId]: { status: 'pending' } } });
    const startTime = performance.now();
    getGlobalRecorder()?.record({ type: 'state.change', component: 'reflection-enrichment', level: 'info', message: 'enrichment.retry', data: { node_id: nodeId, pov } });

    try {
      const { reflectionNodeEnrichmentPrompt } = await import('../../../prompts/analysis');
      const enrichPrompt = reflectionNodeEnrichmentPrompt({
        id: nodeId,
        label: node.label,
        description: node.description,
        category: node.category,
        pov,
      });
      const enrichModel = getConfiguredModel();
      const { text } = await api.generateText(enrichPrompt, enrichModel);
      const enriched = JSON.parse(stripCodeFences(text));
      const currentNode = useTaxonomyStore.getState()[pov]?.nodes.find(n => n.id === nodeId);
      if (!currentNode) return;
      // Keep dirty flag until embeddings are also done
      useTaxonomyStore.getState().updatePovNode(pov, nodeId, { graph_attributes: buildEnrichedGraphAttributes(currentNode.graph_attributes, enriched) });
      await useTaxonomyStore.getState().save();

      // Clear dirty flag only after attributes + embeddings are fully done
      await clearPhraseRegenPending(pov, nodeId);

      const duration = Math.round(performance.now() - startTime);
      getGlobalRecorder()?.record({ type: 'state.change', component: 'reflection-enrichment', level: 'info', message: 'enrichment.retry.complete', duration_ms: duration, data: { node_id: nodeId, pov, fields: Object.keys(enriched) } });
      set({ enrichmentStatus: { ...get().enrichmentStatus, [nodeId]: { status: 'success' } } });
    } catch (err) {
      const duration = Math.round(performance.now() - startTime);
      getGlobalRecorder()?.record({ type: 'system.error', component: 'reflection-enrichment', level: 'error', message: 'enrichment.retry.failed', duration_ms: duration, error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack }, data: { node_id: nodeId, pov } });
      set({ enrichmentStatus: { ...get().enrichmentStatus, [nodeId]: { status: 'error', error: String(err) } } });
    }
  },

});

