// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type {
  DebateSession,
  SpeakerId,
  ArgumentNetworkNode,
  ArgumentNetworkEdge,
  CommitmentStore,
  EntryDiagnostics,
  ClaimExtractionTrace,
  ExtractionSummary,
} from '../../../types/debate';
import { POVER_INFO } from '../../../types/debate';
import { useTaxonomyStore } from '../../useTaxonomyStore';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { hashString, looksTruncated, parseAIJson } from '@lib/debate/helpers';
import { formatFactCheckContent } from './factCheckFormat';
import {
  extractClaimsPrompt,
  classifyClaimsPrompt,
  processExtractedClaims,
  updateUnansweredLedger,
} from '../../../prompts/argumentNetwork';
import { trace, newCallId, TraceEventName } from '../../../lib/trace';
import { updateConvergenceTracker } from '../../../utils/convergenceScoring';
import { computeQbafStrengths } from '@lib/debate/qbaf';
import type { QbafNode, QbafEdge } from '@lib/debate/qbaf';
import { factCheckToBaseStrength } from '@lib/debate/argumentNetwork';
import { normalizeSteelmanTarget, steelmanVerdict } from '@lib/debate/steelman';
import { validateFactCheckResult } from '@lib/debate/factCheckValidator';
import { needsGc, pruneArgumentNetwork, GC_TRIGGER, GC_TARGET } from '@lib/debate/networkGc';
import { computeConvergenceSignals } from '@lib/debate/convergenceSignals';
import { computeProcessReward } from '@lib/debate/processReward';
import type { ProcessRewardEntry, DebatePhase } from '@lib/debate/types';
import { updateCruxTracker } from '@lib/debate/cruxResolution';
import { evaluateLookaheadPerClaim, buildClaimAnalysis } from '@lib/debate/lookaheadGate';
import type { LookaheadDiagnostics, LookaheadGateResult, ClaimAnalysis, PerClaimResult } from '@lib/debate/lookaheadGate';
import type { MoveAnnotation } from '@lib/debate/helpers';
import { triggerManualDump } from '../../../lib/flightRecorderInit';
import { api } from '@bridge';
import type { GroundingCitation } from '../../../bridge/types';
import { pushWarning, recordDiagnostic } from './diagnostics';
import { getConfiguredModel } from './modelConfig';
import { buildFactCheckPrompt } from './prompts';
import { phaseGuardedSet } from './generation';

/** Maximum number of turn embeddings to retain (enough for recycling detection). */
const TURN_EMBEDDING_WINDOW = 30;

// ── updateExtractionSummary helpers ──────────────────────────────────────────

function detectPlateau(traces: ClaimExtractionTrace[]): {
  plateauDetected: boolean;
  plateauStartedAt: number | undefined;
  plateauLastAnId: string | undefined;
} {
  if (traces.length < 2) return { plateauDetected: false, plateauStartedAt: undefined, plateauLastAnId: undefined };
  let tailZero = 0;
  for (let i = traces.length - 1; i >= 0; i--) {
    if (traces[i].an_node_count_after === traces[i].an_node_count_before) tailZero++;
    else break;
  }
  if (tailZero < 2) return { plateauDetected: false, plateauStartedAt: undefined, plateauLastAnId: undefined };
  const firstZeroIdx = traces.length - tailZero;
  return {
    plateauDetected: true,
    plateauStartedAt: traces[firstZeroIdx]?.round,
    plateauLastAnId: traces[firstZeroIdx - 1]?.an_nodes_added_ids.slice(-1)[0],
  };
}

function sumAttributionCounts(traces: ClaimExtractionTrace[]): { attrTotal: number; attrUnattributed: number } {
  let attrTotal = 0;
  let attrUnattributed = 0;
  for (const t of traces) {
    if (t.attribution_attributed != null || t.attribution_unattributed != null) {
      attrTotal += (t.attribution_attributed ?? 0) + (t.attribution_unattributed ?? 0);
      attrUnattributed += t.attribution_unattributed ?? 0;
    }
  }
  return { attrTotal, attrUnattributed };
}

/** Incrementally refresh debate.extraction_summary given a new trace. */
function updateExtractionSummary(
  get: () => any,
  set: (partial: any) => void,
): void {
  const debate = get().activeDebate as DebateSession | null;
  if (!debate) return;

  const traces: ClaimExtractionTrace[] = [];
  const entries = debate.diagnostics?.entries ?? {};
  for (const entryDiag of Object.values(entries) as EntryDiagnostics[]) {
    if (entryDiag.extraction_trace) traces.push(entryDiag.extraction_trace);
  }
  traces.sort((a, b) => a.round - b.round);

  let totalProposed = 0;
  let totalAccepted = 0;
  let totalRejected = 0;
  const rejectionTotals: Record<string, number> = {};
  const growth: { round: number; cumulative_count: number }[] = [];
  for (const t of traces) {
    totalProposed += t.candidates_proposed;
    totalAccepted += t.candidates_accepted;
    totalRejected += t.candidates_rejected;
    for (const [k, v] of Object.entries(t.rejection_reasons)) {
      rejectionTotals[k] = (rejectionTotals[k] ?? 0) + v;
    }
    growth.push({ round: t.round, cumulative_count: t.an_node_count_after });
  }

  const { plateauDetected, plateauStartedAt, plateauLastAnId } = detectPlateau(traces);
  const { attrTotal, attrUnattributed } = sumAttributionCounts(traces);

  const summary: ExtractionSummary = {
    total_turns: traces.length,
    total_proposed: totalProposed,
    total_accepted: totalAccepted,
    total_rejected: totalRejected,
    acceptance_rate: totalProposed > 0 ? totalAccepted / totalProposed : 0,
    an_growth_series: growth,
    plateau_detected: plateauDetected,
    plateau_started_at_turn: plateauStartedAt,
    plateau_last_an_id: plateauLastAnId,
    rejection_reason_totals: rejectionTotals,
    unattributed_claim_ratio: attrTotal > 0 ? attrUnattributed / attrTotal : undefined,
  };

  set({ activeDebate: { ...debate, extraction_summary: summary } });
}

// ── AN commit instrumentation ─────────────────────────────
//
// Per-turn AN extractions run fire-and-forget, so two commits can race.
// `commitAnNodes` centralises the atomic mint-then-set pattern, asserts
// no ID collisions, and logs before/after state so any clobber is visible.

function snapshotAnLengths(get: () => any): { nodeCount: number; edgeCount: number; maxNodeId: number } {
  const d = get().activeDebate;
  const an = d?.argument_network ?? { nodes: [], edges: [] };
  let maxId = 0;
  for (const n of an.nodes) {
    const m = /^AN-(\d+)$/.exec(n.id);
    if (m) { const k = parseInt(m[1], 10); if (k > maxId) maxId = k; }
  }
  return { nodeCount: an.nodes.length, edgeCount: an.edges.length, maxNodeId: maxId };
}

function assertNoDuplicateAnIds(label: string, existing: { id: string }[], incoming: { id: string }[]): void {
  const existingIds = new Set(existing.map(n => n.id));
  const dupsWithExisting: string[] = [];
  const seenInIncoming = new Set<string>();
  const dupsInIncoming: string[] = [];
  for (const n of incoming) {
    if (existingIds.has(n.id)) dupsWithExisting.push(n.id);
    if (seenInIncoming.has(n.id)) dupsInIncoming.push(n.id);
    seenInIncoming.add(n.id);
  }
  if (dupsWithExisting.length || dupsInIncoming.length) {
    const msg = `[AN-INVARIANT] ${label} duplicate AN IDs detected — existing: [${dupsWithExisting.join(', ')}], within-batch: [${dupsInIncoming.join(', ')}]`;
    console.error(msg, { existingIds: [...existingIds], incomingIds: incoming.map(n => n.id) });
    throw new Error(msg);
  }
}

interface AnCommitResult {
  idBase: number;
  edgeIdBase: number;
  idMap: Record<string, string>;
  assignedNodeIds: string[];
}

/**
 * Run an AN-length invariant check after any set() that might have touched
 * argument_network. If the array shrunk, something clobbered it.
 */
function checkAnInvariants(label: string, get: () => any, expectedMinCount: number): void {
  const d = get().activeDebate;
  const count = d?.argument_network?.nodes?.length ?? 0;
  if (count < expectedMinCount) {
    console.error(`[AN-INVARIANT] ${label} AN shrank: was ≥${expectedMinCount}, now ${count}. Clobber detected.`);
  }
}

/**
 * Atomically mint AN-N / AE-N IDs from fresh state, assert no duplicates,
 * commit via set(), and return the id map for callers that need to remap
 * downstream references (e.g., diagnostic entries, pNode targets).
 *
 * Caller must supply `newNodes`/`newEdges` whose `.id` fields may be
 * tentative — they will be reassigned in place. Edges whose `.source`
 * references a tentative node id are remapped via the returned idMap.
 */
export function commitAnNodes<N extends { id: string }, E extends { id: string; source: string }>(
  get: () => any,
  set: (partial: any) => void,
  label: string,
  newNodes: N[],
  newEdges: E[],
  mergeExtras?: (fresh: any) => any,
): AnCommitResult {
  const before = snapshotAnLengths(get);
  const freshState = get().activeDebate;
  const freshAn = freshState?.argument_network || { nodes: [], edges: [] };
  const idBase = freshAn.nodes.length;
  const edgeIdBase = freshAn.edges.length;
  const idMap: Record<string, string> = {};

  // If existing IDs aren't dense 1..N (e.g., prior corruption), mint past the max.
  const safeBase = Math.max(idBase, before.maxNodeId);
  newNodes.forEach((n, i) => {
    const realId = `AN-${safeBase + i + 1}`;
    idMap[n.id] = realId;
    n.id = realId;
  });
  newEdges.forEach((e, i) => {
    e.id = `AE-${edgeIdBase + i + 1}`;
    if (idMap[e.source]) e.source = idMap[e.source];
  });

  assertNoDuplicateAnIds(label, freshAn.nodes, newNodes);

  const base = mergeExtras ? mergeExtras(freshState) : { ...freshState };
  const anUpdate = {
    ...base,
    argument_network: {
      nodes: [...freshAn.nodes, ...newNodes],
      edges: [...freshAn.edges, ...newEdges],
    },
  };
  // Phase-guarded: re-read current phase to prevent background AN commits
  // from clobbering 'closed' phase set by requestSynthesis (t/301).
  const currentPhase = (get().activeDebate as DebateSession | null)?.phase;
  if (currentPhase) anUpdate.phase = currentPhase;
  set({ activeDebate: anUpdate });

  const after = snapshotAnLengths(get);
  console.log(
    `[AN-COMMIT ${label}] before=${before.nodeCount}/${before.edgeCount} (maxId=${before.maxNodeId}) ` +
    `+${newNodes.length}n/${newEdges.length}e → after=${after.nodeCount}/${after.edgeCount} (maxId=${after.maxNodeId}) ` +
    `assigned=[${newNodes.map(n => n.id).join(', ')}]`,
  );

  if (after.nodeCount !== before.nodeCount + newNodes.length) {
    console.error(
      `[AN-INVARIANT] ${label} length mismatch — expected ${before.nodeCount + newNodes.length}, got ${after.nodeCount}. ` +
      `Something else wrote activeDebate between our read and set.`,
    );
  }

  return { idBase: safeBase, edgeIdBase, idMap, assignedNodeIds: newNodes.map(n => n.id) };
}

/**
 * Extract claims from a debater's statement and update the argument network.
 * Runs in the background after each turn — does not block the debate flow.
 */
/** Callback for lookahead-driven regeneration. Returns new statement + pre-extracted claims, or null to skip retry. */
export type LookaheadRegenCallback = (guidance: {
  strongFoundations?: ClaimAnalysis['strongFoundations'];
  avoidClaims?: ClaimAnalysis['avoidClaims'];
}) => Promise<{
  statement: string;
  debaterClaims?: { claim: string; targets: string[] }[];
} | null>;

/**
 * Detect zero-claim extraction despite having claim sketches (t/227).
 * Records a flight recorder error and auto-triggers a dump.
 */
export function detectZeroClaims(
  get: () => any, set: (partial: any) => void,
  debateId: string, entryId: string, speaker: SpeakerId,
  sketchCount: number, acceptedCount: number,
  reason: string, rejectionReasons?: Record<string, number>,
): void {
  if (sketchCount === 0 || acceptedCount > 0) return;
  const speakerLabel = POVER_INFO[speaker as Exclude<SpeakerId, 'user'>]?.label || speaker;
  const msg = `Claim extraction for ${speakerLabel} produced 0 claims from ${sketchCount} sketches (${reason})`;
  getGlobalRecorder()?.record({
    type: 'system.error',
    debate_id: debateId,
    component: 'claim-extraction-monitor',
    level: 'error',
    message: msg,
    data: { debate_id: debateId, turn_id: entryId, speaker, sketch_count: sketchCount, reason, rejection_reasons: rejectionReasons },
  });
  pushWarning(get, set, msg);
  // Auto-trigger flight recorder dump for diagnosis
  try { void triggerManualDump(); } catch { /* flight recorder dump — silent by design */ }
}

// ── extractClaimsAndUpdateAN sub-steps (t/1848 batch 3) ──────────────
// Behavior-preserving decomposition of the AN extraction hot-path. Bodies
// moved verbatim (line-slice transform); only signatures/calls hand-authored.
type _ProcessedClaims = Awaited<ReturnType<typeof processExtractedClaims>>;
type NewAnNode = _ProcessedClaims['newNodes'][number];
type NewAnEdge = _ProcessedClaims['newEdges'][number];
type PriorClaimList = Parameters<typeof extractClaimsPrompt>[2];
type ClaimExtractionResult = { claims?: { text: string; bdi_category?: string; base_strength?: number; bdi_sub_scores?: Record<string, number>; specificity?: string; steelman_of?: string | null; responds_to?: { prior_claim_id: string; relationship: string; attack_type?: string; weight?: number; scheme?: string; argumentation_scheme?: string; warrant?: string }[] }[] };

async function embedNewAnNodes(newNodes: NewAnNode[], debate: DebateSession): Promise<void> {
    // Embed new AN nodes for AN-based taxonomy relevance scoring (non-blocking)
    for (const node of newNodes) {
      try {
        const { vector } = await api.computeQueryEmbedding(node.text.slice(0, 300));
        if (vector && vector.length > 0) node.embedding = vector;
      } catch (e) { getGlobalRecorder()?.record({ type: 'system.error', debate_id: debate.id, component: 'debate-store', level: 'warn', message: 'AN node embedding failed', error: { name: (e as Error).name ?? 'Error', message: String(e), stack: (e as Error).stack } }); }
      if (node.attribution_text_genus) {
        try {
          const { vector } = await api.computeQueryEmbedding(node.attribution_text_genus.slice(0, 300));
          if (vector && vector.length > 0) node.attribution_embedding = vector;
        } catch (e) { getGlobalRecorder()?.record({ type: 'system.error', debate_id: debate.id, component: 'debate-store', level: 'warn', message: 'AN node genus embedding failed', error: { name: (e as Error).name ?? 'Error', message: String(e), stack: (e as Error).stack } }); }
      }
    }
}

async function computeTaxonomyAttribution(newNodes: NewAnNode[], speaker: SpeakerId, extractionTrace: ClaimExtractionTrace, debate: DebateSession): Promise<void> {
    // Per-claim taxonomy attribution (t/110): compare AN embeddings against same-POV nodes (all BDI categories)
    if (newNodes.length > 0) {
      const speakerPov = POVER_INFO[speaker as Exclude<SpeakerId, 'user'>]?.pov;
      if (speakerPov) {
        try {
          // t/3316 (t/3297 client half): attribution moved server/main-side — POST the newly-extracted
          // claims (id + embeddings) instead of assembling the corpus locally. The server/main runs the
          // SAME pure fn (computeClaimTaxonomyAttribution) over the shared corpus → parity by construction;
          // fixes the anon degradation (endpoint is free-tier gated) + drops the last synthetic-corpus fetch.
          const { attributions, summary } = await api.fetchClaimAttribution({
            pov: speakerPov,
            claims: newNodes.map(n => ({ id: n.id, embedding: n.embedding, attribution_embedding: n.attribution_embedding })),
          });
          // Re-apply per-claim attribution verbatim to each AN node (mirrors the old in-place mutation).
          for (const node of newNodes) {
            const attr = attributions[node.id];
            if (attr) node.claim_taxonomy_attribution = attr;
          }
          extractionTrace.attribution_attributed = summary.attributed;
          extractionTrace.attribution_unattributed = summary.unattributed;
          extractionTrace.attribution_missing_embedding = summary.missing_embedding;
          extractionTrace.attribution_novel_argument = summary.novel_argument;
          extractionTrace.attribution_decisions = summary.decisions;
        } catch (e) {
          getGlobalRecorder()?.record({ type: 'system.error', debate_id: debate.id, component: 'debate-store', level: 'warn', message: 'Claim taxonomy attribution failed', error: { name: (e as Error).name ?? 'Error', message: String(e), stack: (e as Error).stack } });
          // Attribution failure never blocks extraction
        }
      }
    }
}

// ── Lookahead gate helpers ────────────────────────────────────────────────────

interface SingleRegenAttemptResult {
  regenClaims: _ProcessedClaims;
  retryResult: LookaheadGateResult;
  retryPerClaim: PerClaimResult[];
  retryAnalysis: ClaimAnalysis;
}

async function processOneRegenAttempt(
  regenResult: { statement: string; debaterClaims?: { claim: string; targets: string[] }[] },
  speakerLabel: string,
  priorClaims: PriorClaimList,
  an: { nodes: ArgumentNetworkNode[]; edges: ArgumentNetworkEdge[] },
  speaker: SpeakerId,
  debate: DebateSession,
  entryId: string,
  taxonomyRefs: string[],
  turnNumber: number,
  model: string,
  parsed: ClaimExtractionResult,
): Promise<SingleRegenAttemptResult | null> {
  const regenPrompt = regenResult.debaterClaims && regenResult.debaterClaims.length > 0
    ? classifyClaimsPrompt(regenResult.statement, speakerLabel, regenResult.debaterClaims, priorClaims)
    : extractClaimsPrompt(regenResult.statement, speakerLabel, priorClaims);
  try {
    const { text: regenText } = await api.generateText(regenPrompt, model);
    const regenParsed = parseAIJson<{ claims?: typeof parsed.claims }>(regenText);
    if (!regenParsed?.claims || !Array.isArray(regenParsed.claims) || regenParsed.claims.length === 0) {
      return null;
    }
    const taxEdgesRetry = useTaxonomyStore.getState().edgesFile?.edges;
    const regenClaims = await processExtractedClaims(
      {
        claims: regenParsed.claims,
        statement: regenResult.statement,
        speaker,
        entryId,
        taxonomyRefIds: taxonomyRefs,
        turnNumber,
        existingNodes: an.nodes,
        existingEdgeCount: an.edges.length,
        startNodeId: an.nodes.length + 1,
        taxonomyEdges: taxEdgesRetry,
      },
      { groundingOverlapThreshold: 0.3, isClassifyPath: !!(regenResult.debaterClaims && regenResult.debaterClaims.length > 0) },
    );
    if (regenClaims.newNodes.length === 0) return null;
    await embedNewAnNodes(regenClaims.newNodes, debate);
    const { batchResult: retryResult, perClaim: retryPerClaim } = evaluateLookaheadPerClaim({
      speaker,
      existingNodes: an.nodes,
      existingEdges: an.edges,
      tentativeClaims: regenClaims.newNodes.map(n => ({ text: n.text, base_strength: n.base_strength ?? 0.5 })),
      tentativeEdges: regenClaims.newEdges,
      cruxes: debate.crux_tracker,
    });
    const retryAnalysis = buildClaimAnalysis(retryPerClaim);
    return { regenClaims, retryResult, retryPerClaim, retryAnalysis };
  } catch (regenErr) {
    getGlobalRecorder()?.record({
      type: 'system.error', debate_id: debate.id, component: 'debate-store', level: 'warn',
      message: 'Lookahead regen attempt extraction failed',
      error: { name: (regenErr as Error).name ?? 'Error', message: String(regenErr), stack: (regenErr as Error).stack },
    });
    console.warn('[Lookahead] Regen attempt extraction failed:', regenErr);
    return null;
  }
}

interface RegenLoopResult {
  bestResult: LookaheadGateResult;
  bestPerClaim: PerClaimResult[];
  bestNodes: NewAnNode[];
  bestEdges: NewAnEdge[];
  bestStatement: string | null;
  regenAttempts: LookaheadGateResult[];
  perClaimAnalysisLog: { perClaim: PerClaimResult[]; analysis: ClaimAnalysis }[];
}

function mergePerClaimGuidance(
  analysis: ClaimAnalysis,
  cumulativeStrong: ClaimAnalysis['strongFoundations'],
  cumulativeAvoid: ClaimAnalysis['avoidClaims'],
): void {
  const seenStrong = new Set(cumulativeStrong.map(s => s.text));
  for (const s of analysis.strongFoundations) {
    if (!seenStrong.has(s.text)) { cumulativeStrong.push(s); seenStrong.add(s.text); }
  }
  const seenAvoid = new Set(cumulativeAvoid.map(a => a.text));
  for (const a of analysis.avoidClaims) {
    if (!seenAvoid.has(a.text)) { cumulativeAvoid.push(a); seenAvoid.add(a.text); }
  }
}

async function executeRegenAttempts(
  firstResult: LookaheadGateResult,
  firstPerClaim: PerClaimResult[],
  newNodes: NewAnNode[],
  newEdges: NewAnEdge[],
  regenCallback: LookaheadRegenCallback,
  an: { nodes: ArgumentNetworkNode[]; edges: ArgumentNetworkEdge[] },
  speaker: SpeakerId,
  debate: DebateSession,
  entryId: string,
  speakerLabel: string,
  priorClaims: PriorClaimList,
  taxonomyRefs: string[],
  turnNumber: number,
  model: string,
  parsed: ClaimExtractionResult,
): Promise<RegenLoopResult> {
  const firstAnalysis = buildClaimAnalysis(firstPerClaim);
  const cumulativeStrong = [...firstAnalysis.strongFoundations];
  const cumulativeAvoid = [...firstAnalysis.avoidClaims];
  const perClaimAnalysisLog: { perClaim: PerClaimResult[]; analysis: ClaimAnalysis }[] = [{ perClaim: firstPerClaim, analysis: firstAnalysis }];
  const regenAttempts: LookaheadGateResult[] = [];
  let bestResult = firstResult;
  let bestPerClaim = firstPerClaim;
  let bestNodes = [...newNodes];
  let bestEdges = [...newEdges];
  let bestStatement: string | null = null;
  const MAX_REGEN_ATTEMPTS = 3;

  for (let attempt = 0; attempt < MAX_REGEN_ATTEMPTS; attempt++) {
    console.log(`[Lookahead] Gate failed (Δu=${bestResult.utility_delta.toFixed(3)}), requesting regen ${attempt + 1}/${MAX_REGEN_ATTEMPTS} (${cumulativeStrong.length} strong, ${cumulativeAvoid.length} avoid)`);
    getGlobalRecorder()?.record({ type: 'lookahead.regen', component: 'argument-network-extraction', level: 'info', debate_id: debate.id, turn_id: entryId, speaker, message: `Lookahead gate failed, triggering regen attempt ${attempt + 1}`, data: { attempt: attempt + 1, utility_delta: bestResult.utility_delta, threshold: bestResult.threshold, strong_count: cumulativeStrong.length, avoid_count: cumulativeAvoid.length } });
    const regenResult = await regenCallback({
      strongFoundations: cumulativeStrong.length > 0 ? cumulativeStrong : undefined,
      avoidClaims: cumulativeAvoid.length > 0 ? cumulativeAvoid : undefined,
    });
    if (!regenResult) break;
    const attempted = await processOneRegenAttempt(regenResult, speakerLabel, priorClaims, an, speaker, debate, entryId, taxonomyRefs, turnNumber, model, parsed);
    if (!attempted) {
      regenAttempts.push({ ...bestResult, pass: false, tentative_claims: [], tentative_network_size: { nodes: 0, edges: 0 } });
      continue;
    }
    regenAttempts.push(attempted.retryResult);
    mergePerClaimGuidance(attempted.retryAnalysis, cumulativeStrong, cumulativeAvoid);
    perClaimAnalysisLog.push({ perClaim: attempted.retryPerClaim, analysis: attempted.retryAnalysis });
    if (attempted.retryResult.pass || attempted.retryResult.utility_delta > bestResult.utility_delta) {
      bestResult = attempted.retryResult;
      bestPerClaim = attempted.retryPerClaim;
      bestNodes = attempted.regenClaims.newNodes;
      bestEdges = attempted.regenClaims.newEdges;
      bestStatement = regenResult.statement;
      console.log(`[Lookahead] Attempt ${attempt + 1} improved: Δu=${attempted.retryResult.utility_delta.toFixed(3)} (was ${firstResult.utility_delta.toFixed(3)})`);
    }
    if (attempted.retryResult.pass) break;
  }
  return { bestResult, bestPerClaim, bestNodes, bestEdges, bestStatement, regenAttempts, perClaimAnalysisLog };
}

async function runLookaheadGate(speaker: SpeakerId, an: { nodes: ArgumentNetworkNode[]; edges: ArgumentNetworkEdge[] }, newNodes: NewAnNode[], newEdges: NewAnEdge[], debate: DebateSession, regenCallback: LookaheadRegenCallback | undefined, entryId: string, speakerLabel: string, priorClaims: PriorClaimList, taxonomyRefs: string[], turnNumber: number, model: string, get: () => any, set: (partial: any) => void, extractionTrace: ClaimExtractionTrace, parsed: ClaimExtractionResult): Promise<{ lookaheadDiag: LookaheadDiagnostics | undefined; bestPerClaim: PerClaimResult[] | undefined }> {
  let lookaheadDiag: LookaheadDiagnostics | undefined;
  let bestPerClaim: PerClaimResult[] | undefined;
  try {
    const lookaheadStart = Date.now();
    const lookaheadInput = {
      speaker,
      existingNodes: an.nodes,
      existingEdges: an.edges,
      tentativeClaims: newNodes.map(n => ({ text: n.text, base_strength: n.base_strength ?? 0.5 })),
      tentativeEdges: newEdges,
      cruxes: debate.crux_tracker,
    };
    const { batchResult: firstResult, perClaim: firstPerClaim } = evaluateLookaheadPerClaim(lookaheadInput);
    bestPerClaim = firstPerClaim;

    if (!firstResult.pass && regenCallback) {
      const regenLoopResult = await executeRegenAttempts(firstResult, firstPerClaim, newNodes, newEdges, regenCallback, an, speaker, debate, entryId, speakerLabel, priorClaims, taxonomyRefs, turnNumber, model, parsed);
      if (regenLoopResult.bestResult !== firstResult) {
        newNodes.length = 0; newNodes.push(...regenLoopResult.bestNodes);
        newEdges.length = 0; newEdges.push(...regenLoopResult.bestEdges);
        extractionTrace.candidates_accepted = newNodes.length;
        if (regenLoopResult.bestStatement) {
          const currDebate = get().activeDebate as DebateSession | null;
          if (currDebate) {
            const updatedTranscript = currDebate.transcript.map(e =>
              e.id === entryId ? { ...e, content: regenLoopResult.bestStatement!, metadata: { ...(e.metadata as Record<string, unknown>), lookahead_regenerated: true, lookahead_regen_attempts: regenLoopResult.regenAttempts.length } } : e,
            );
            phaseGuardedSet(get, set, { transcript: updatedTranscript });
          }
        }
      }
      bestPerClaim = regenLoopResult.bestPerClaim;
      lookaheadDiag = {
        stage: 'lookahead',
        first_attempt: firstResult,
        regen_triggered: true,
        regen_attempt: regenLoopResult.regenAttempts[regenLoopResult.regenAttempts.length - 1],
        regen_attempts: regenLoopResult.regenAttempts,
        per_claim_analysis: regenLoopResult.perClaimAnalysisLog,
        final_pass: regenLoopResult.bestResult !== firstResult && (regenLoopResult.bestResult.pass || regenLoopResult.bestResult.utility_delta > firstResult.utility_delta),
        elapsed_ms: Date.now() - lookaheadStart,
      };
    } else {
      const firstAnalysis = buildClaimAnalysis(firstPerClaim);
      lookaheadDiag = {
        stage: 'lookahead',
        first_attempt: firstResult,
        regen_triggered: false,
        per_claim_analysis: [{ perClaim: firstPerClaim, analysis: firstAnalysis }],
        final_pass: firstResult.pass,
        elapsed_ms: Date.now() - lookaheadStart,
      };
    }
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      debate_id: debate.id,
      component: 'debate-store',
      level: 'warn',
      message: 'Lookahead pre-commit gate evaluation failed',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    console.warn('[Lookahead] Pre-commit gate evaluation failed (non-blocking):', err);
  }
  return { lookaheadDiag, bestPerClaim };
}

function filterWeakClaims(lookaheadDiag: LookaheadDiagnostics | undefined, bestPerClaim: PerClaimResult[] | undefined, newNodes: NewAnNode[], newEdges: NewAnEdge[], extractionTrace: ClaimExtractionTrace, debate: DebateSession): void {
    // Filter WEAK claims from passing batches before commit (t/459)
    if (lookaheadDiag?.final_pass && debate.lookahead_filter_weak !== false && bestPerClaim) {
      const weakIndices = new Set(
        bestPerClaim.filter(pc => pc.classification === 'WEAK').map(pc => pc.index),
      );
      if (weakIndices.size > 0) {
        const filteredTexts = [...weakIndices].map(i => newNodes[i]?.text).filter(Boolean);
        const removedIds = new Set(newNodes.filter((_, i) => weakIndices.has(i)).map(n => n.id));
        newNodes.splice(0, newNodes.length, ...newNodes.filter((_, i) => !weakIndices.has(i)));
        newEdges.splice(0, newEdges.length, ...newEdges.filter(e => !removedIds.has(e.source) && !removedIds.has(e.target)));
        extractionTrace.candidates_accepted = newNodes.length;
        lookaheadDiag.filtered_weak_claims = filteredTexts;
        getGlobalRecorder()?.record({
          type: 'debate.lookahead.filter',
          debate_id: debate.id,
          component: 'debate-store',
          level: 'info',
          message: `Filtered ${weakIndices.size} WEAK claim(s) from passing lookahead batch`,
          data: { filtered_count: weakIndices.size, remaining_count: newNodes.length },
        });
      }
    }
}

// ── Post-extraction analytics helpers ────────────────────────────────────────

async function computeConvergenceAndReward(
  baseDebate: any,
  entryId: string,
  speaker: SpeakerId,
  patches: Record<string, any>,
  currentNodes: ArgumentNetworkNode[],
  currentEdges: ArgumentNetworkEdge[],
  qbafResult: ReturnType<typeof computeQbafStrengths>,
  get: () => any,
  set: (partial: any) => void,
): Promise<void> {
  try {
    let turnEmbeddings: Map<string, number[]> | undefined;
    const cachedEmbeddings = { ...(baseDebate.turn_embeddings ?? {}) };
    try {
      const currentEntry = baseDebate.transcript.find((e: { id: string }) => e.id === entryId);
      if (currentEntry) {
        const { vector } = await api.computeQueryEmbedding(currentEntry.content.slice(0, 1000));
        cachedEmbeddings[entryId] = vector;
      }
      turnEmbeddings = new Map(Object.entries(cachedEmbeddings));
    } catch (e) {
      getGlobalRecorder()?.record({ type: 'system.error', debate_id: baseDebate.id, component: 'debate-store', level: 'warn', message: 'Convergence turn embedding failed', error: { name: (e as Error).name ?? 'Error', message: String(e), stack: (e as Error).stack } });
      if (Object.keys(cachedEmbeddings).length > 0) {
        turnEmbeddings = new Map(Object.entries(cachedEmbeddings));
      }
    }
    // Prune stale turn embeddings — keep only the most recent N entries
    const recentEntryIds = new Set(
      baseDebate.transcript.slice(-TURN_EMBEDDING_WINDOW).map((e: { id: string }) => e.id),
    );
    for (const key of Object.keys(cachedEmbeddings)) {
      if (!recentEntryIds.has(key)) delete cachedEmbeddings[key];
    }
    patches.turn_embeddings = cachedEmbeddings;

    const sig = computeConvergenceSignals(
      entryId,
      speaker,
      baseDebate.transcript,
      currentNodes,
      currentEdges,
      baseDebate.convergence_signals ?? [],
      turnEmbeddings,
      qbafResult.strengths,
      baseDebate.topic?.embedding,
      baseDebate.topic?.clause_embeddings,
    );
    patches.convergence_signals = [...(get().activeDebate?.convergence_signals ?? []), sig];
    getGlobalRecorder()?.record({ type: 'debate.signal', component: 'convergence-signals', level: 'info', debate_id: baseDebate.id, turn_id: entryId, speaker, message: 'Convergence signals computed', data: { round: sig.round, move_polarity: sig.move_polarity?.ratio, dialectical_engagement: sig.dialectical_engagement?.ratio, argument_redundancy: sig.argument_redundancy?.avg_self_overlap, crux_engagement_rate: sig.crux_engagement_rate?.cumulative_count } });

    // 4b. Process reward — continuous turn quality score (PRM-adjacent signal)
    const turnTrail = get().activeDebate?.turn_validations?.[entryId];
    const turnValidation = turnTrail?.final;
    if (turnValidation) {
      const currentEntry = baseDebate.transcript.find((e: { id: string }) => e.id === entryId);
      const entryMeta = currentEntry?.metadata as Record<string, unknown> | undefined;
      const moveTypes = (entryMeta?.move_types as (string | MoveAnnotation)[]) ?? [];
      const phase = ((entryMeta?.debate_phase as string) ?? 'argumentation') as DebatePhase;

      // Count prior turn's distinct moves for diversity comparison
      const priorSpeakerEntry = baseDebate.transcript
        .filter((e: { speaker: string; type: string }) => e.speaker === speaker && e.type === 'statement')
        .slice(-2)[0]; // second-to-last statement by this speaker
      const priorMeta = priorSpeakerEntry?.metadata as Record<string, unknown> | undefined;
      const priorMoves = (priorMeta?.move_types as (string | MoveAnnotation)[]) ?? [];

      const pr = computeProcessReward({
        convergenceSignals: sig,
        turnValidation,
        phase,
        moveCount: moveTypes.length,
        priorMoveCount: priorMoves.length > 0 ? priorMoves.length : undefined,
        taxonomyRefCount: currentEntry?.taxonomy_refs?.length ?? 0,
      });

      const prEntry: ProcessRewardEntry = {
        entry_id: entryId,
        round: sig.round,
        speaker,
        phase,
        score: pr.score,
        components: pr.components,
      };
      patches.process_rewards = [...(get().activeDebate?.process_rewards ?? []), prEntry];
      getGlobalRecorder()?.record({ type: 'debate.signal', component: 'process-reward', level: 'info', debate_id: baseDebate.id, turn_id: entryId, speaker, message: `Process reward: ${pr.score.toFixed(3)}`, data: { score: pr.score, ...pr.components } });
    }
  } catch (convErr) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      debate_id: baseDebate.id,
      component: 'debate-store',
      level: 'warn',
      message: 'Convergence signal computation failed',
      error: { name: (convErr as Error).name ?? 'Error', message: String(convErr), stack: (convErr as Error).stack },
    });
    console.warn('[Convergence] Signal computation failed (non-blocking):', convErr);
    pushWarning(get, set, 'Convergence analysis skipped this turn');
  }
}

async function runPostExtractionAnalytics(get: () => any, set: (partial: any) => void, entryId: string, speaker: SpeakerId): Promise<void> {
    // ── Post-extraction analytics (batched into a single set() to avoid re-render storm) ──
    const baseDebate = get().activeDebate;
    if (baseDebate?.argument_network) {
      const an = baseDebate.argument_network;
      const patches: Partial<typeof baseDebate> = {};

      // 1. QBAF strength propagation — computed ONCE, reused by convergence signals and GC
      const qNodes: QbafNode[] = an.nodes.map((n: ArgumentNetworkNode) => ({ id: n.id, base_strength: n.base_strength ?? 0.5 }));
      const qEdges: QbafEdge[] = an.edges.map((e: ArgumentNetworkEdge) => ({
        source: e.source, target: e.target,
        type: e.type as 'attacks' | 'supports',
        weight: e.weight ?? 0.5,
        attack_type: e.attack_type,
      }));
      const qbafResult = computeQbafStrengths(qNodes, qEdges);
      getGlobalRecorder()?.record({ type: 'an.qbaf', component: 'qbaf', level: 'info', debate_id: baseDebate.id, turn_id: entryId, message: `QBAF propagation: ${qbafResult.iterations} iterations`, data: { iterations: qbafResult.iterations, converged: qbafResult.converged, node_count: qNodes.length } });
      let currentNodes = an.nodes.map((n: ArgumentNetworkNode) => ({
        ...n,
        computed_strength: qbafResult.strengths.get(n.id) ?? n.computed_strength,
      }));
      let currentEdges = an.edges;

      // 2. Convergence tracker
      const getLabelForId = useTaxonomyStore.getState().getLabelForId;
      const turnNumber = an.nodes.length;
      patches.convergence_tracker = updateConvergenceTracker(
        baseDebate.convergence_tracker,
        { ...an, nodes: currentNodes },
        baseDebate.commitments || {},
        turnNumber,
        getLabelForId,
      );

      // 3. Unanswered claims ledger
      patches.unanswered_claims_ledger = updateUnansweredLedger(
        baseDebate.unanswered_claims_ledger ?? [],
        currentNodes,
        currentEdges,
        baseDebate.transcript.length,
      );

      // 4. Convergence signals + process reward
      if (entryId) {
        await computeConvergenceAndReward(baseDebate, entryId, speaker, patches, currentNodes, currentEdges, qbafResult, get, set);
      }

      // 5. Network GC (uses QBAF-updated computed_strength already on nodes)
      if (needsGc(currentNodes.length, GC_TRIGGER)) {
        const gcResult = pruneArgumentNetwork(currentNodes, currentEdges, GC_TARGET);
        if (gcResult.prunedNodes.length > 0) {
          currentNodes = gcResult.nodes;
          currentEdges = gcResult.edges;
          console.info(`[AN-GC] Pruned ${gcResult.before} → ${gcResult.after} nodes`);
          getGlobalRecorder()?.record({ type: 'an.gc', component: 'argument-network-extraction', level: 'info', debate_id: baseDebate.id, message: `Network GC: ${gcResult.before} → ${gcResult.after} nodes`, data: { nodes_before: gcResult.before, nodes_after: gcResult.after, edges_removed: gcResult.prunedNodes.length } });
        }
      }

      // 6. Crux resolution tracking
      try {
        patches.crux_tracker = updateCruxTracker(
          baseDebate.crux_tracker,
          currentNodes,
          currentEdges,
          baseDebate.commitments ?? {},
          turnNumber,
        );
      } catch (cruxErr) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          debate_id: baseDebate.id,
          component: 'debate-store',
          level: 'warn',
          message: 'Crux resolution tracker update failed',
          error: { name: (cruxErr as Error).name ?? 'Error', message: String(cruxErr), stack: (cruxErr as Error).stack },
        });
        console.warn('[CruxResolution] Tracker update failed (non-blocking):', cruxErr);
        pushWarning(get, set, 'Crux resolution tracking skipped');
      }

      // Single batched state update — re-read fresh state to avoid clobbering
      // concurrent writes (turn_validations, position_drift, adaptive_staging)
      // from the main crossRespond flow which runs in parallel.
      const freshForBatch = get().activeDebate;
      if (freshForBatch) {
        set({
          activeDebate: {
            ...freshForBatch,
            ...patches,
            argument_network: { ...an, nodes: currentNodes, edges: currentEdges },
          },
        });
      }
    }
}

// ── Steelman validation helpers ───────────────────────────────────────────────

function handleSteelmanDivergence(
  sNode: NewAnNode,
  speaker: SpeakerId,
  targetPover: string,
  asserted: string[],
  maxEntailment: number,
  get: () => any,
  set: (partial: any) => void,
): void {
  const targetLabel = POVER_INFO[targetPover as Exclude<SpeakerId, 'user'>]?.label ?? targetPover;
  const speakerLbl = POVER_INFO[speaker as Exclude<SpeakerId, 'user'>]?.label ?? speaker;
  const topAssertions = asserted.slice(-3).map(a => `"${a}"`).join('; ');
  const addEntry = get().addTranscriptEntry;
  if (addEntry) {
    const steelEntryId = addEntry({
      type: 'system',
      speaker: 'system',
      content: `[Steelman check] ${speakerLbl}'s steelman of ${targetLabel}'s position (max entailment: ${maxEntailment.toFixed(2)}) diverges from their actual assertions. ${targetLabel} actually asserted: ${topAssertions}`,
      taxonomy_refs: [],
    });
    recordDiagnostic(get, set, steelEntryId, {
      raw_response: JSON.stringify({ steelman_text: sNode.text, target_pover: targetPover, max_entailment: maxEntailment, nli_results: [] }),
      model: 'nli',
    });
  }
}

async function runSteelmanValidation(newNodes: NewAnNode[], get: () => any, set: (partial: any) => void, speaker: SpeakerId, debate: DebateSession): Promise<void> {
    // Steelman validation (non-blocking). t/3514: the target is normalized first — label values
    // ("Safetyist") used to miss the id-keyed commitments lookup and skip every steelman silently.
    // Every steelman now gets a persisted verdict (faithful / diverges / unchecked + reason).
    const steelmanNodes = newNodes.filter(n => n.steelman_of);
    if (steelmanNodes.length > 0) {
      try {
        for (const sNode of steelmanNodes) {
          const targetPover = normalizeSteelmanTarget(sNode.steelman_of, speaker).target;
          const asserted = targetPover
            ? ((get().activeDebate?.commitments?.[targetPover] as CommitmentStore | undefined)?.asserted ?? []).slice(-10)
            : [];
          if (!targetPover || asserted.length === 0) {
            sNode.steelman_check = { verdict: 'unchecked', reason: targetPover ? 'Target has no recorded assertions yet' : `"${sNode.steelman_of}" is not a steelman target` };
            continue;
          }

          const pairs = asserted.map(assertion => ({ text_a: sNode.text, text_b: assertion }));
          const nliResult = await api.nliClassify(pairs);
          sNode.steelman_check = steelmanVerdict(asserted, nliResult.results.map(r => r.nli_entailment));
          const maxEntailment = sNode.steelman_check.max_entailment ?? 0;

          if (sNode.steelman_check.verdict === 'diverges') {
            handleSteelmanDivergence(sNode, speaker, targetPover, asserted, maxEntailment, get, set);
          }
        }
      } catch (nliErr) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          debate_id: debate.id,
          component: 'debate-store',
          level: 'warn',
          message: 'Steelman NLI validation failed',
          error: { name: (nliErr as Error).name ?? 'Error', message: String(nliErr), stack: (nliErr as Error).stack },
        });
        console.warn('[Steelman] NLI validation failed (non-blocking):', nliErr);
        for (const sNode of steelmanNodes) {
          sNode.steelman_check ??= { verdict: 'unchecked', reason: 'NLI check failed this turn' };
        }
        pushWarning(get, set, 'Steelman validation skipped this turn');
      }
      phaseGuardedSet(get, set, {}); // re-render: verdicts were written onto committed nodes
    }
}

// ── Inline fact-check helpers ─────────────────────────────────────────────────

function buildFactCheckAnPair(
  verdict: string,
  explanation: string,
  pNode: NewAnNode,
  entryId: string,
  cur: DebateSession,
  get: () => any,
  set: (partial: any) => void,
): void {
  const attackType = verdict === 'disputed' ? 'attacks' : 'supports';
  const factCheckEntryId = cur.transcript[cur.transcript.length - 1]?.id || entryId;
  const fcNode: ArgumentNetworkNode = {
    id: 'pending-fc-node',
    text: `Fact-check (${verdict}): ${explanation}`,
    speaker: 'system',
    source_entry_id: factCheckEntryId,
    taxonomy_refs: [],
    turn_number: cur.transcript.length,
    base_strength: attackType === 'attacks' ? 0.7 : 0.6,
    scoring_method: 'bdi_criteria',
    bdi_category: 'belief',
    specificity: 'precise',
  };
  const fcEdge: ArgumentNetworkEdge = {
    id: 'pending-fc-edge',
    source: 'pending-fc-node',
    target: pNode.id,
    type: attackType,
    attack_type: attackType === 'attacks' ? 'rebut' : undefined,
    scheme: attackType === 'attacks' ? 'EMPIRICAL CHALLENGE' : 'EXTEND',
    warrant: `Inline fact-check evidence (web search): ${String(explanation).slice(0, 100)}`,
    argumentation_scheme: 'ARGUMENT_FROM_EVIDENCE',
  };
  commitAnNodes(get, set, `factcheck(inline,pNode=${pNode.id})`, [fcNode], [fcEdge]);
}

function recordFactCheckTranscriptEntry(
  verdict: string,
  explanation: string,
  pNode: NewAnNode,
  webContext: string,
  webQueries: string[],
  webCitations: GroundingCitation[],
  get: () => any,
  set: (partial: any) => void,
  entryId: string,
): void {
  const addEntry = get().addTranscriptEntry;
  const hasWeb = !!webContext && webContext !== '(Web search unavailable)';
  const webNote = webQueries.length > 0
    ? `\n\n*Web sources consulted: ${webQueries.slice(0, 3).join(', ')}*`
    : hasWeb
      ? '\n\n*Verified against web search results*'
      : '';
  const verdictLabel = verdict === 'disputed' ? 'Disputed' : 'Supported';
  if (addEntry) {
    addEntry({
      type: 'fact-check',
      speaker: 'system',
      content: formatFactCheckContent(verdictLabel, pNode.text, explanation, webNote),
      taxonomy_refs: [],
      metadata: {
        fact_check: {
          verdict,
          explanation,
          checked_text: pNode.text,
          web_search_used: hasWeb,
          web_search_queries: webQueries.length ? webQueries : undefined,
          web_search_evidence: hasWeb ? webContext : undefined,
          web_search_citations: webCitations.length ? webCitations : undefined,
          target_an_id: pNode.id,
        },
      },
    });
  }
  const cur = get().activeDebate as DebateSession | null;
  if (cur) {
    buildFactCheckAnPair(verdict, explanation, pNode, entryId, cur, get, set);
  }
}

function performFactCheckVerdict(
  pNode: NewAnNode,
  vParsed: { verdict?: string; explanation?: string; evidence?: string; confidence?: string; discrepancy?: unknown },
  webContext: string,
  webQueries: string[],
  webCitations: GroundingCitation[],
  get: () => any,
  set: (partial: any) => void,
  entryId: string,
  debateId: string,
): boolean {
  if (!vParsed.verdict) return false;
  const explanation = vParsed.explanation || vParsed.evidence || '';
  // Gate + normalize the auto-verification verdict (t/1828): unsourced
  // `partially_accurate` → `unverifiable`, legacy `verified` → `supported`, so the
  // verdict that reaches factCheckToBaseStrength (and verification_status) is correct.
  const validated = validateFactCheckResult({ ...vParsed, explanation }, debateId);
  const verdict = validated.verdict;
  const fcConfidence = vParsed.confidence as string | undefined;

  pNode.verification_status = verdict;
  pNode.verification_evidence = explanation;
  pNode.base_strength = factCheckToBaseStrength(verdict, fcConfidence);
  pNode.scoring_method = 'fact_check';
  phaseGuardedSet(get, set, {});  // trigger re-render without clobbering phase

  if (verdict === 'disputed' || verdict === 'supported') {
    recordFactCheckTranscriptEntry(verdict, explanation, pNode, webContext, webQueries, webCitations, get, set, entryId);
  }
  return true;
}

async function runInlineFactCheck(newNodes: NewAnNode[], get: () => any, set: (partial: any) => void, entryId: string, debate: DebateSession): Promise<void> {
    // Inline empirical claim verification (non-blocking)
    // Uses the same two-pass approach as the manual factCheckSelection path:
    //   Pass 1: grounded web search for evidence
    //   Pass 2: structured verdict analysis with the evidence
    const preciseBeliefs = newNodes.filter(n => n.bdi_category === 'belief' && n.specificity === 'precise');
    let factCheckMutated = false;
    for (const pNode of preciseBeliefs.slice(0, 2)) {
      try {
        const fcModel = getConfiguredModel();

        // Pass 1: web search for evidence (same as manual path)
        let webContext = '';
        let webQueries: string[] = [];
        let webCitations: GroundingCitation[] = [];
        try {
          const searchResult = await api.generateTextWithSearch(
            `Fact-check this claim from an AI policy debate. Find recent, authoritative sources that support or contradict it. Be specific about what evidence you found.\n\nClaim: "${pNode.text}"`,
            fcModel,
          );
          webContext = searchResult.text;
          webQueries = searchResult.searchQueries || [];
          webCitations = searchResult.citations || [];
        } catch (searchErr) {
          getGlobalRecorder()?.record({
            type: 'system.error',
            debate_id: debate.id,
            component: 'debate-store',
            level: 'warn',
            message: `Inline verify web search failed for ${pNode.id}`,
            error: { name: (searchErr as Error).name ?? 'Error', message: String(searchErr), stack: (searchErr as Error).stack },
          });
          console.warn(`[Verify] Web search failed for ${pNode.id}, proceeding without:`, searchErr);
          pushWarning(get, set, 'Web verification unavailable for some claims');
          webContext = '(Web search unavailable)';
        }

        // Pass 2: structured verdict analysis with all evidence
        const verdictPrompt = buildFactCheckPrompt(
          pNode.text,
          pNode.text,
          '',
          webContext && webContext !== '(Web search unavailable)' ? `=== WEB SEARCH RESULTS ===\n${webContext}` : '',
          get().activeDebate?.audience,
        );
        const { text: vText } = await api.generateText(verdictPrompt, fcModel);
        let vParsed = parseAIJson<{ verdict?: string; explanation?: string; evidence?: string; confidence?: string; discrepancy?: unknown }>(vText);
        if (!vParsed) {
          vParsed = { verdict: 'unverifiable', evidence: vText.trim() };
        }
        const mutated = performFactCheckVerdict(pNode, vParsed, webContext, webQueries, webCitations, get, set, entryId, debate.id);
        if (mutated) factCheckMutated = true;
      } catch (verifyErr) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          debate_id: debate.id,
          component: 'debate-store',
          level: 'warn',
          message: `Inline verification failed for ${pNode.id}`,
          error: { name: (verifyErr as Error).name ?? 'Error', message: String(verifyErr), stack: (verifyErr as Error).stack },
        });
        console.warn(`[Verify] Inline verification failed for ${pNode.id} (non-blocking):`, verifyErr);
        pushWarning(get, set, 'Claim verification skipped');
        pNode.verification_status = 'pending';
      }
    }
    void factCheckMutated; // preserved for future use
}

// ── extractClaimsAndUpdateAN helpers ─────────────────────────────────────────

function mergeCommitmentsFromExtraction(
  speakerCommits: CommitmentStore,
  commits: { asserted: string[]; conceded: string[]; challenged: string[] },
): void {
  for (const t of commits.asserted) { if (!speakerCommits.asserted.includes(t)) speakerCommits.asserted.push(t); }
  for (const t of commits.conceded) { if (!speakerCommits.conceded.includes(t)) speakerCommits.conceded.push(t); }
  for (const t of commits.challenged) { if (!speakerCommits.challenged.includes(t)) speakerCommits.challenged.push(t); }
}

function remapDiagnosticIds(diagAccepted: { id: string }[], idMap: Record<string, string>): void {
  for (const a of diagAccepted) {
    if (idMap[a.id]) a.id = idMap[a.id];
  }
}

function broadcastDiagnosticsState(get: () => any): void {
  try {
    api.sendDiagnosticsState({ debate: get().activeDebate, selectedEntry: get().selectedDiagEntry });
  } catch (e) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-store', level: 'warn', message: 'Diagnostics state broadcast failed', error: { name: (e as Error).name ?? 'Error', message: String(e), stack: (e as Error).stack } });
  }
}

async function performExtractionCall(
  prompt: string,
  model: string,
  callId: string,
  entryId: string,
  speaker: SpeakerId,
  debate: DebateSession,
  extractionTrace: ClaimExtractionTrace,
): Promise<string> {
  const callStartedAt = Date.now();
  trace(TraceEventName.AI_CALL_START, {
    debate_id: debate.id,
    turn_id: entryId,
    call_id: callId,
    speaker,
    model,
    purpose: 'claim_extraction',
    prompt_chars: prompt.length,
  });
  try {
    const { text } = await api.generateText(prompt, model);
    extractionTrace.response_time_ms = Date.now() - callStartedAt;
    extractionTrace.response_chars = text.length;
    extractionTrace.response_truncated = looksTruncated(text);
    trace(TraceEventName.AI_CALL_COMPLETE, {
      debate_id: debate.id,
      turn_id: entryId,
      call_id: callId,
      speaker,
      model,
      purpose: 'claim_extraction',
      duration_ms: Date.now() - callStartedAt,
      response_chars: text.length,
    });
    return text;
  } catch (callErr) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      debate_id: debate.id,
      component: 'debate-store',
      level: 'error',
      message: 'Claim extraction AI call failed',
      error: { name: (callErr as Error).name ?? 'Error', message: String(callErr), stack: (callErr as Error).stack },
    });
    extractionTrace.response_time_ms = Date.now() - callStartedAt;
    extractionTrace.status = 'adapter_error';
    extractionTrace.error_message = String(callErr);
    trace(TraceEventName.AI_CALL_FAILED, {
      debate_id: debate.id,
      turn_id: entryId,
      call_id: callId,
      speaker,
      model,
      purpose: 'claim_extraction',
      duration_ms: Date.now() - callStartedAt,
      error: String(callErr),
    });
    throw callErr;
  }
}

function handleExtractionParseFailure(
  text: string,
  extractionTrace: ClaimExtractionTrace,
  debate: DebateSession,
  debaterClaims: { claim: string; targets: string[] }[] | undefined,
  sketchCount: number,
  commitTrace: () => void,
): ClaimExtractionResult {
  const terminalStatus = extractionTrace.response_truncated ? 'truncated_response' : 'parse_error';
  const HEAD_TAIL_CHARS = 500;
  const failureData: Record<string, unknown> = {
    response_chars: text.length,
    response_truncated: extractionTrace.response_truncated,
    terminal_status: terminalStatus,
    has_debater_claims: sketchCount > 0,
    sketch_count: sketchCount,
    response_head: text.slice(0, HEAD_TAIL_CHARS),
    response_tail: text.length > HEAD_TAIL_CHARS ? text.slice(-HEAD_TAIL_CHARS) : '',
  };
  if (debaterClaims && debaterClaims.length > 0) {
    // AC1 (t/1626): JSON recovery failed, but the debater already supplied claim sketches
    // upstream. Fall back to those sketches instead of dropping every claim to zero.
    getGlobalRecorder()?.record({
      type: 'system.error',
      debate_id: debate.id,
      component: 'debate-store',
      level: 'warn',
      message: `Claim extraction JSON parse failed — recovering ${sketchCount} debater sketch(es)`,
      data: failureData,
      error: { name: 'SyntaxError', message: `Claim extraction JSON recovery failed (raw length: ${text.length}); recovered from debater sketches` },
    });
    extractionTrace.error_message = `JSON recovery failed (${terminalStatus}); recovered ${sketchCount} claim(s) from debater sketches`;
    return { claims: debaterClaims.map((s) => ({ text: s.claim })) };
  }
  const parseErr = new SyntaxError('Claim extraction JSON recovery failed');
  getGlobalRecorder()?.record({
    type: 'system.error',
    debate_id: debate.id,
    component: 'debate-store',
    level: 'error',
    message: 'Claim extraction JSON parse failed',
    data: failureData,
    error: { name: parseErr.name, message: `${parseErr.message} (raw length: ${text.length})`, stack: parseErr.stack },
  });
  extractionTrace.status = terminalStatus;
  extractionTrace.error_message = String(parseErr);
  commitTrace();
  throw parseErr;
}

function handleExtractionFailure(
  err: unknown,
  extractionTrace: ClaimExtractionTrace,
  commitTrace: () => void,
  debate: DebateSession,
  entryId: string,
  speaker: SpeakerId,
  sketchCount: number,
  extractStartedAt: number,
  get: () => any,
  set: (partial: any) => void,
): void {
  getGlobalRecorder()?.record({
    type: 'system.error',
    component: 'debate-store',
    level: 'error',
    message: 'Claim extraction failed',
    error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
  });
  console.warn('[AN] Claim extraction failed (non-blocking):', err);
  pushWarning(get, set, 'Argument extraction skipped this turn');
  if (!extractionTrace.error_message) extractionTrace.error_message = String(err);
  if (extractionTrace.status === 'ok') extractionTrace.status = 'adapter_error';
  try { commitTrace(); } catch (e) { getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-store', level: 'warn', message: 'commitTrace failed during error recovery', error: { name: (e as Error).name ?? 'Error', message: String(e), stack: (e as Error).stack } }); }
  recordDiagnostic(get, set, entryId, { extraction_status: 'failed' as const });
  detectZeroClaims(get, set, debate.id, entryId, speaker, sketchCount, 0, 'extraction_failed');
  trace(TraceEventName.AN_EXTRACT_FAILED, {
    debate_id: debate.id,
    turn_id: entryId,
    speaker,
    duration_ms: Date.now() - extractStartedAt,
    error: String(err),
  });
}

export async function extractClaimsAndUpdateAN(
  statement: string,
  speaker: SpeakerId,
  entryId: string,
  taxonomyRefs: string[],
  get: () => any,
  set: (partial: any) => void,
  debaterClaims?: { claim: string; targets: string[] }[],
  regenCallback?: LookaheadRegenCallback,
): Promise<void> {
  const debate = get().activeDebate as DebateSession | null;
  if (!debate) return;

  const model = getConfiguredModel();
  const an = debate.argument_network || { nodes: [], edges: [] };
  const priorClaims = an.nodes.map(n => ({ id: n.id, text: n.text, speaker: POVER_INFO[n.speaker as Exclude<SpeakerId, 'user'>]?.label || n.speaker }));
  const speakerLabel = POVER_INFO[speaker as Exclude<SpeakerId, 'user'>]?.label || speaker;

  const sketchCount = debaterClaims?.length ?? 0;

  const extractStartedAt = Date.now();
  const anCountBefore = an.nodes.length;
  const turnRound = (debate.transcript?.length ?? 0) + 1;
  const EXTRACTION_PROMPT_VERSION = 'v1.4';
  recordDiagnostic(get, set, entryId, { extraction_status: 'pending' as const });
  trace(TraceEventName.AN_EXTRACT_START, {
    debate_id: debate.id,
    turn_id: entryId,
    speaker,
    prior_claim_count: priorClaims.length,
    has_debater_claims: !!(debaterClaims && debaterClaims.length > 0),
  });

  // Seed trace — progressively filled in as the extraction lifecycle proceeds.
  const extractionTrace: ClaimExtractionTrace = {
    entry_id: entryId,
    round: turnRound,
    speaker,
    status: 'ok',
    attempt_count: 1,
    prompt_chars: 0,
    prompt_token_estimate: 0,
    response_chars: 0,
    response_truncated: false,
    model,
    response_time_ms: 0,
    candidates_proposed: 0,
    candidates_accepted: 0,
    candidates_rejected: 0,
    rejection_reasons: {},
    rejected_overlap_pcts: [],
    max_overlap_vs_existing: 0,
    an_node_count_before: anCountBefore,
    an_node_count_after: anCountBefore,
    an_nodes_added_ids: [],
    prompt_hash: '',
    extraction_prompt_version: EXTRACTION_PROMPT_VERSION,
  };

  const commitTrace = () => {
    recordDiagnostic(get, set, entryId, { extraction_trace: { ...extractionTrace } });
    updateExtractionSummary(get, set);
  };

  try {
    // Hybrid approach: if debater supplied claims, use classifyClaimsPrompt (lighter).
    // Otherwise fall back to full extractClaimsPrompt (backward compat with older models).
    const prompt = debaterClaims && debaterClaims.length > 0
      ? classifyClaimsPrompt(statement, speakerLabel, debaterClaims, priorClaims)
      : extractClaimsPrompt(statement, speakerLabel, priorClaims);
    extractionTrace.prompt_chars = prompt.length;
    extractionTrace.prompt_token_estimate = Math.round(prompt.length / 4);
    extractionTrace.prompt_hash = hashString(prompt);

    const callId = newCallId();
    const text = await performExtractionCall(prompt, model, callId, entryId, speaker, debate, extractionTrace);

    let parsed = parseAIJson<ClaimExtractionResult>(text);
    if (!parsed) {
      parsed = handleExtractionParseFailure(text, extractionTrace, debate, debaterClaims, sketchCount, commitTrace);
    }
    if (!Array.isArray(parsed.claims)) {
      extractionTrace.status = 'empty_response';
      commitTrace();
      recordDiagnostic(get, set, entryId, { extraction_status: 'complete' as const });
      detectZeroClaims(get, set, debate.id, entryId, speaker, sketchCount, 0, 'no_claims_array');
      trace(TraceEventName.AN_EXTRACT_COMPLETE, {
        debate_id: debate.id,
        turn_id: entryId,
        speaker,
        accepted: 0,
        rejected: 0,
        edges_added: 0,
        duration_ms: Date.now() - extractStartedAt,
        reason: 'no_claims_array',
      });
      return;
    }
    extractionTrace.candidates_proposed = parsed.claims.length;

    const turnNumber = debate.transcript.length;
    const commitments = debate.commitments || {};
    const speakerCommits: CommitmentStore = commitments[speaker] || { asserted: [], conceded: [], challenged: [] };

    const taxEdges = useTaxonomyStore.getState().edgesFile?.edges;
    const claimsResult = await processExtractedClaims(
      {
        claims: parsed.claims,
        statement,
        speaker,
        entryId,
        taxonomyRefIds: taxonomyRefs,
        turnNumber,
        existingNodes: an.nodes,
        existingEdgeCount: an.edges.length,
        startNodeId: an.nodes.length + 1,
        taxonomyEdges: taxEdges,
      },
      {
        groundingOverlapThreshold: 0.3,
        isClassifyPath: !!(debaterClaims && debaterClaims.length > 0),
      },
    );

    const { newNodes, newEdges } = claimsResult;
    const diagAccepted = claimsResult.accepted;
    const diagRejected = claimsResult.rejected;

    mergeCommitmentsFromExtraction(speakerCommits, claimsResult.commitments);

    extractionTrace.candidates_accepted = newNodes.length;
    extractionTrace.candidates_rejected = diagRejected.length;
    Object.assign(extractionTrace.rejection_reasons, claimsResult.rejectionReasons);
    extractionTrace.rejected_overlap_pcts.push(...claimsResult.rejectedOverlapPcts);
    extractionTrace.max_overlap_vs_existing = claimsResult.maxOverlapVsExisting;

    if (newNodes.length === 0) {
      extractionTrace.status = 'no_new_nodes';
      extractionTrace.an_node_count_after = anCountBefore;
      commitTrace();
      recordDiagnostic(get, set, entryId, { extraction_status: 'complete' as const });
      detectZeroClaims(get, set, debate.id, entryId, speaker, sketchCount, 0, 'all_claims_rejected', extractionTrace.rejection_reasons);
      trace(TraceEventName.AN_EXTRACT_COMPLETE, {
        debate_id: debate.id,
        turn_id: entryId,
        speaker,
        accepted: 0,
        rejected: diagRejected.length,
        edges_added: 0,
        duration_ms: Date.now() - extractStartedAt,
        reason: 'all_claims_rejected_or_empty',
      });
      return;
    }

    await embedNewAnNodes(newNodes, debate);

    await computeTaxonomyAttribution(newNodes, speaker, extractionTrace, debate);

    const { lookaheadDiag, bestPerClaim } = await runLookaheadGate(speaker, an, newNodes, newEdges, debate, regenCallback, entryId, speakerLabel, priorClaims, taxonomyRefs, turnNumber, model, get, set, extractionTrace, parsed);
    filterWeakClaims(lookaheadDiag, bestPerClaim, newNodes, newEdges, extractionTrace, debate);

    if (lookaheadDiag) recordDiagnostic(get, set, entryId, { lookahead: lookaheadDiag });

    extractionTrace.status = 'ok';

    const commitResult = commitAnNodes(
      get, set,
      `extract[speaker=${speaker},entry=${entryId.slice(-6)}]`,
      newNodes, newEdges,
      (fresh) => ({
        ...fresh,
        commitments: {
          ...(fresh?.commitments ?? commitments),
          [speaker]: speakerCommits,
        },
      }),
    );

    remapDiagnosticIds(diagAccepted, commitResult.idMap);
    extractionTrace.an_node_count_after = commitResult.idBase + newNodes.length;
    extractionTrace.an_nodes_added_ids = commitResult.assignedNodeIds;
    const expectedMinAnCount = commitResult.idBase + newNodes.length;

    await get().saveDebate('extractClaimsAndUpdateAN');
    checkAnInvariants(`post-save(extract,${entryId.slice(-6)})`, get, expectedMinAnCount);

    console.log(`[AN] Extracted ${newNodes.length} claims, ${newEdges.length} edges from ${speakerLabel}'s turn`);
    getGlobalRecorder()?.record({ type: 'an.commit', component: 'argument-network-extraction', level: 'info', debate_id: debate.id, turn_id: entryId, speaker, message: `Committed ${newNodes.length} nodes, ${newEdges.length} edges`, data: {
      new_nodes: newNodes.length, new_edges: newEdges.length, node_ids: commitResult.assignedNodeIds, an_nodes_after: commitResult.idBase + newNodes.length, rejected: diagRejected.length, rejection_reasons: claimsResult.rejectionReasons,
      // t/3763: per-node summary so a dump answers "what did node AN-30 claim, and who was
      // it steelmanning?" in one event read instead of cross-referencing the turn embedding
      // event for the source text. assignedNodeIds is index-parallel to newNodes (both are
      // the batch committed by this turn, in extraction order).
      nodes: newNodes.map((n, i) => ({
        id: commitResult.assignedNodeIds[i], claim_preview: n.text.slice(0, 80), steelman_of: n.steelman_of ?? null,
        pov: n.steelman_of ?? speaker, // FR records effective pov (steelmanned camp), not speaker pov
      })),
    } });
    trace(TraceEventName.AN_EXTRACT_COMPLETE, {
      debate_id: debate.id,
      turn_id: entryId,
      speaker,
      accepted: newNodes.length,
      rejected: diagRejected.length,
      edges_added: newEdges.length,
      duration_ms: Date.now() - extractStartedAt,
    });

    await runPostExtractionAnalytics(get, set, entryId, speaker);

    await runSteelmanValidation(newNodes, get, set, speaker, debate);

    await runInlineFactCheck(newNodes, get, set, entryId, debate);
    try { await get().saveDebate('extractClaimsAndUpdateAN:postAnalytics'); } catch (saveErr) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        debate_id: debate.id,
        component: 'debate-store',
        level: 'warn',
        message: 'Failed to persist post-extraction analytics',
        error: { name: (saveErr as Error).name ?? 'Error', message: String(saveErr), stack: (saveErr as Error).stack },
      });
      console.warn('[Extract] Failed to persist post-extraction analytics:', saveErr);
      pushWarning(get, set, 'Post-extraction data could not be saved');
    }

    // Record claim extraction diagnostics
    recordDiagnostic(get, set, entryId, {
      extracted_claims: { accepted: diagAccepted, rejected: diagRejected },
      extraction_status: 'complete' as const,
    });
    commitTrace();

    // Broadcast updated state to popout
    broadcastDiagnosticsState(get);
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', debate_id: debate.id, component: 'debate-store', level: 'error', message: 'Claim extraction failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    handleExtractionFailure(err, extractionTrace, commitTrace, debate, entryId, speaker, sketchCount, extractStartedAt, get, set);
  }
}
