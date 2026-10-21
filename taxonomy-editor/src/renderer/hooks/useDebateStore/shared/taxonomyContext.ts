// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { PovNode, CrossCuttingNode as SituationNode } from '../../../types/taxonomy';
import { POV_KEYS } from '../../../types/debate';
import { useTaxonomyStore } from '../../useTaxonomyStore';
// Circular import — safe because all references are at call-time, never at module init
import { useDebateStore } from '../store';
import type { NodeScoringSource, RelevanceSourceEntry } from '../types';

import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { nodeTypeFromId } from '@lib/debate/nodeIdUtils';
import { computeLineageDistribution, formatLineageContext } from '@lib/debate/topicCritique';
// t/3257: the relevance-selection pipeline moved to lib-pure; this file is now the thin CLIENT
// wrapper (build corpus embeddings + fetch greatest-hits + assemble session state → call the pure
// fn → re-apply anchoring + emit diagnostics + map the result). The server calls the SAME fn (T2).
// t/3258 (T3): the client no longer calls selectRelevantTaxonomy locally — it delegates to the
// server/main via api.fetchRelevantNodes (both run the SAME lib fn → parity by construction).
// assembleNodeEmbeddings stays for buildNodeEmbeddingMap, which the t/3165 corpus-dedup regression
// test still exercises (the production corpus-fetch path is now dead — cleanup deferred to a
// follow-up, gated on this flip being parity-GV-proven so the old path stays as rollback).
import { assembleNodeEmbeddings } from '@lib/debate/relevanceSelection';
import type { ANClaimInput } from '@lib/debate/relevanceSelection';
// t/3257#21: corpus assembly + synthetic merge relocated to lib so the server (T2) + client build
// the corpus map identically (parity by construction). Re-exported here for argumentNetwork.ts.
export { mergeSyntheticVectors } from '@lib/debate/relevanceSelection';
import type { TaxonomyContext } from '../../../utils/taxonomyContext';
import { getGreatestHits } from './getGreatestHits';
import { getLineageMapping, getL2Categories, isLineageDataLoaded } from '../../../data/lineageCategories';
import { api } from '@bridge';

export type { TaxonomyContext };

// ── Synthetic embeddings cache ───────────────────────────────────────
// Loaded once per session from synthetic_embeddings.json via the bridge.
let _syntheticVectorsCache: Record<string, number[][]> | null = null;
let _syntheticVectorsLoaded = false;

/** Reset doctrinal anchoring cache (call when debate changes or taxonomy reloads). */
/** Reset the session embedding caches (call when the debate changes or the taxonomy reloads).
 *  t/3257: doctrinal anchoring is now stateless in the lib fn (re-applied idempotently per call),
 *  so there is no longer an anchoring cache to clear — only the synthetic-vector cache remains. */
export function resetDoctrinalAnchoringCache(): void {
  _syntheticVectorsCache = null;
  _syntheticVectorsLoaded = false;
}

export async function loadSyntheticVectors(): Promise<Record<string, number[][]> | null> {
  if (_syntheticVectorsLoaded) return _syntheticVectorsCache;
  try {
    const raw = await api.loadSyntheticEmbeddings();
    if (raw) {
      _syntheticVectorsCache = {};
      for (const [nodeId, entry] of Object.entries(raw)) {
        if (entry.vectors?.length) _syntheticVectorsCache[nodeId] = entry.vectors;
      }
      console.log(`[taxonomy] Loaded synthetic embeddings for ${Object.keys(_syntheticVectorsCache).length} nodes`);
    }
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-store', level: 'warn', message: 'Failed to load synthetic embeddings', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
  }
  _syntheticVectorsLoaded = true;
  return _syntheticVectorsCache;
}

export function enrichPolicyRefs(
  policyRefs: (string | { policy_id: string; relevance: string })[] | undefined,
  draftWorkProduct: Record<string, unknown> | undefined,
): (string | { policy_id: string; relevance: string })[] | undefined {
  if (!policyRefs || policyRefs.length === 0) return policyRefs;
  const draftPolicyRefs = draftWorkProduct?.policy_refs as { policy_id: string; relevance: string }[] | undefined;
  if (!Array.isArray(draftPolicyRefs) || draftPolicyRefs.length === 0) return policyRefs;

  // Build lookup from draft's rich policy refs
  const draftMap = new Map<string, string>();
  for (const dp of draftPolicyRefs) {
    if (dp && typeof dp === 'object' && dp.policy_id && dp.relevance) {
      draftMap.set(dp.policy_id, dp.relevance);
    }
  }
  if (draftMap.size === 0) return policyRefs;

  return policyRefs.map(ref => {
    if (typeof ref === 'string') {
      const relevance = draftMap.get(ref);
      return relevance ? { policy_id: ref, relevance } : ref;
    }
    return ref;
  });
}

export function getAllKnownNodeIds(): Set<string> {
  const s = new Set<string>();
  const state = useTaxonomyStore.getState();
  for (const pov of POV_KEYS) {
    for (const n of state[pov]?.nodes ?? []) s.add(n.id);
  }
  for (const n of state.situations?.nodes ?? []) s.add(n.id);
  return s;
}

export function getAllPolicyIds(): Set<string> {
  const s = new Set<string>();
  for (const p of useTaxonomyStore.getState().policyRegistry ?? []) s.add(p.id);
  return s;
}

export function findNodeMetaInStore(nodeId: string): { label: string; pov: string; description: string } | undefined {
  const state = useTaxonomyStore.getState();
  for (const pov of POV_KEYS) {
    const n = state[pov]?.nodes.find(x => x.id === nodeId);
    if (n) return { label: n.label, pov, description: n.description };
  }
  const sit = state.situations?.nodes.find(x => x.id === nodeId);
  if (sit) return { label: sit.label, pov: 'situations', description: sit.description };
  return undefined;
}

/** Get taxonomy data from the taxonomy store for a given POV */
export function getTaxonomyContext(pov: string): TaxonomyContext {
  const state = useTaxonomyStore.getState();

  const povFile = state[pov as 'accelerationist' | 'safetyist' | 'skeptic'];
  const povNodes: PovNode[] = povFile?.nodes ?? [];
  const situationNodes: SituationNode[] = state.situations?.nodes ?? [];
  const policyRegistry = (state.policyRegistry ?? []).map(p => ({ id: p.id, action: p.action, source_povs: p.source_povs }));

  return { povNodes, situationNodes, policyRegistry };
}

interface TaxonomyContextWithSources extends TaxonomyContext {
  nodeSourceMap?: Map<string, NodeScoringSource>;
  injectionManifest?: Record<string, unknown>;
}

/** Serialize nodeSourceMap to an array for storage on transcript entry metadata. Only includes refs actually used. */
export function serializeNodeSourceMap(
  sourceMap: Map<string, NodeScoringSource> | undefined,
  refs: { node_id: string }[],
): RelevanceSourceEntry[] | undefined {
  if (!sourceMap || sourceMap.size === 0) return undefined;
  const result: RelevanceSourceEntry[] = [];
  for (const ref of refs) {
    const src = sourceMap.get(ref.node_id);
    if (src) {
      result.push({
        node_id: ref.node_id,
        source: src.source,
        an_score: src.anScore,
        topic_score: src.topicScore,
        best_claim_id: src.bestClaimId,
        best_claim_text: src.bestClaimText,
        best_claim_sim: src.bestClaimSim,
      });
    }
  }
  return result.length > 0 ? result : undefined;
}

// ── getRelevantTaxonomyContext phase helpers (t/1848) ────────────────
// getRelevantTaxonomyContext was a single 80-complexity async pipeline.
// Its cohesive phases are extracted here as helpers (bodies moved verbatim;
// see ADR-007 split pattern) so the orchestrator stays readable and each
// phase is independently testable.
type NodeEmbeddingMap = Record<string, { pov: string; vector: number[]; vectors?: number[][] }>;

// Per-debate base-embedding memo (t/3165 blast-radius mitigation — DEFENSE-IN-DEPTH, not the root
// fix). getRelevantTaxonomyContext runs once per speaker (acc/saf/skp); each call re-embeds
// current-POV nodes + ALL situations, and the ~443 situations are identical across all 3 speakers,
// so they recompute 3×. Each ~800-text recompute is what starves the event loop when prod's
// embeddings.json is stale vs the taxonomy data (the real driver — DevOps-owned coverage/reseed).
// Memoizing base vectors by node-id within a debate embeds the shared corpus ONCE, not per speaker.
// Behaviour-equivalent: embeddings are a deterministic fn of text; the memo keys on node-id and is
// scoped to the active debate (cleared when the debate id changes), so a node whose text changed
// between debates is re-embedded.
const corpusEmbedMemo = new Map<string, number[]>();
let corpusEmbedMemoDebateId: string | null = null;

/**
 * Embed all POV+CC nodes into a combined map, merging synthetic multi-vectors when available.
 * Exported for the t/3165 corpus-dedup regression test.
 */
export async function buildNodeEmbeddingMap(pov: string, allPovNodes: PovNode[], allCCNodes: SituationNode[]): Promise<{ nodeEmbeddings: NodeEmbeddingMap; allNodeIds: string[] }> {
  // Reset the per-debate memo when the active debate changes.
  const debateId = useDebateStore.getState().activeDebate?.id ?? null;
  if (debateId !== corpusEmbedMemoDebateId) {
    corpusEmbedMemo.clear();
    corpusEmbedMemoDebateId = debateId;
  }
  // Memoizing corpus-embed adapter: embed ONLY the ids not yet seen this debate (the shared
  // situations are embedded on the first speaker, resolved from the memo for the rest — t/3165),
  // returning every id's vector in order. This client optimization stays out of the pure lib fn.
  const corpusEmbed = async (texts: string[], ids?: string[]): Promise<number[][]> => {
    const idList = ids ?? [];
    const missIdx: number[] = [];
    for (let i = 0; i < idList.length; i++) if (!corpusEmbedMemo.has(idList[i])) missIdx.push(i);
    if (missIdx.length > 0) {
      const { vectors } = await api.computeEmbeddings(missIdx.map(i => texts[i]), missIdx.map(i => idList[i]));
      for (let k = 0; k < missIdx.length; k++) corpusEmbedMemo.set(idList[missIdx[k]], vectors[k]);
    }
    return idList.map(id => corpusEmbedMemo.get(id) as number[]);
  };
  const synVecs = await loadSyntheticVectors();
  // Shared lib assembly → the server (T2) and client build the corpus map identically (t/3257#21).
  return assembleNodeEmbeddings(pov, allPovNodes, allCCNodes, corpusEmbed, synVecs);
}

/** Build the lineage→node map (intellectual_lineage graph attribute) for the given nodes. */
function buildLineageByNode(nodes: PovNode[]): Record<string, string[]> {
  const lineageByNode: Record<string, string[]> = {};
  for (const node of nodes) {
    const ga = (node as { graph_attributes?: { intellectual_lineage?: (string | { name: string })[] } }).graph_attributes;
    const lineage = ga?.intellectual_lineage;
    if (lineage && lineage.length > 0) {
      lineageByNode[node.id] = lineage.map(v => typeof v === 'string' ? v : v.name);
    }
  }
  return lineageByNode;
}

/** Build the name→L2-cluster map from the lineage mapping. */
function buildNameToCluster(mapping: ReturnType<typeof getLineageMapping>): Record<string, string> {
  const nameToCluster: Record<string, string> = {};
  for (const [name, val] of Object.entries(mapping)) {
    nameToCluster[name] = val.l2;
  }
  return nameToCluster;
}

/**
 * Emit the per-turn lineage boost-check diagnostic. A topic-specific lineage frame is only
 * computed during topic critique, so for URL/document/situations debates no frame is ever
 * produced and the check has nothing to report — suppress it there as pure noise (t/2271).
 */
function recordLineageBoostCheck(lineageFrame: { cluster_id: string }[] | undefined, frameExpected: boolean): void {
  if (!frameExpected && !(lineageFrame && lineageFrame.length > 0)) return;
  getGlobalRecorder()?.record({
    type: 'lineage.boost-check',
    component: 'debate-store',
    level: 'debug',
    message: 'Lineage boost check',
    data: {
      has_lineage_frame: !!lineageFrame,
      frame_count: lineageFrame?.length ?? 0,
      lineage_data_loaded: isLineageDataLoaded(),
      frame_expected: frameExpected,
    },
  });
}

/**
 * Surface a user-visible debate warning when greatest-hits exclusion was requested but
 * not applied (t/1998 loud-degrade). Store-touching companion to the store-free
 * applyGreatestHitsExclusion; de-duped so a multi-turn debate raises it at most once.
 */
function surfaceGreatestHitsWarning(outcome: { requested: boolean; applied: boolean }): void {
  if (!outcome.requested || outcome.applied) return;
  const s = useDebateStore.getState();
  const warning = 'Well-tested exclusion is On, but the curated greatest-hits list is unavailable — well-tested nodes are still excluded, but the list\'s extra nodes were NOT filtered for this debate.';
  if (s.debateWarnings.length < 50 && !s.debateWarnings.includes(warning)) {
    useDebateStore.setState({ debateWarnings: [...s.debateWarnings, warning] });
  }
}

/** Log the lineage-boost promotion outcome from the lib fn's returned injectionManifest (the
 *  manifest is built pure inside selectRelevantTaxonomy now; this is the client-side FR logging). */
function logLineageBoostResult(injectionManifest: Record<string, unknown>, totalSelected: number, totalCandidates: number): void {
  const lb = injectionManifest.lineage_boost as { boosted: number; promoted: number; promotedNodeIds: string[] } | undefined;
  if (!lb) return;
  getGlobalRecorder()?.record({
    type: 'lineage.boost-result',
    component: 'debate-store',
    level: lb.promoted > 0 ? 'info' : 'debug',
    message: lb.promoted > 0 ? `Lineage boost promoted ${lb.promoted} nodes` : 'Lineage boost applied but promoted 0 nodes',
    data: { boosted_count: lb.boosted, promoted_count: lb.promoted, promoted_node_ids: lb.promotedNodeIds?.slice(0, 10), total_selected: totalSelected, total_candidates: totalCandidates },
  });
}

/** t/4369 gap 3: WARN when per-turn selection skipped label twins. Each `label_dedup` entry, set by
 *  lib's selectRelevantTaxonomy, names the skipped id, the twin it duplicates and their shared label.
 *  The skip is correct; the WARN is how duplicate taxonomy nodes stay visible until they're merged (t/4278). */
export function logLabelDedup(injectionManifest: Record<string, unknown>): void {
  const skipped = injectionManifest.label_dedup;
  if (!Array.isArray(skipped) || skipped.length === 0) return;
  getGlobalRecorder()?.record({
    type: 'state.change',
    component: 'debate-store',
    level: 'warn',
    message: `Relevance selection skipped ${skipped.length} node(s) with a duplicate label: ${skipped.slice(0, 3).join('; ')}${skipped.length > 3 ? ` + ${skipped.length - 3} more` : ''}`,
    data: { label_dedup: skipped.slice(0, 20), skipped_count: skipped.length },
  });
}

/** Log what the exclude-well-tested mode did, from the manifest's `testing_selection`. WARN when the
 *  mode was on but well-tested nodes are still the majority of the selection (re-eligible leak-in). */
function logTestingSelection(injectionManifest: Record<string, unknown>, totalSelected: number): void {
  const ts = injectionManifest.testing_selection as {
    selected_tiers: Record<string, number>;
    well_tested_excluded: number;
    greatest_hits_excluded: number;
    under_tested_promoted: number;
  } | undefined;
  if (!ts) return;
  const wellTestedSelected = ts.selected_tiers.well_tested ?? 0;
  getGlobalRecorder()?.record({
    type: 'turn.taxonomy_inject',
    component: 'debate-store',
    level: wellTestedSelected * 2 > totalSelected ? 'warn' : 'info',
    message: `Exclude-well-tested: ${ts.well_tested_excluded} well-tested + ${ts.greatest_hits_excluded} greatest-hits pre-filtered, ${ts.under_tested_promoted} under-tested promoted; ${wellTestedSelected}/${totalSelected} selected are well-tested`,
    data: { ...ts },
  });
}

/** Emit the situation interpretation-divergence summary — surfaces interpretation alignment at debate setup. */
function recordSituationDivergence(filteredCC: SituationNode[], allCCNodes: SituationNode[]): void {
  const withDiv = filteredCC.filter(n => n.interpretation_divergence != null && !isNaN(n.interpretation_divergence!));
  if (withDiv.length > 0) {
    const high = withDiv.filter(n => n.interpretation_divergence! > 0.40).length;
    const medium = withDiv.filter(n => n.interpretation_divergence! >= 0.20 && n.interpretation_divergence! <= 0.40).length;
    const low = withDiv.filter(n => n.interpretation_divergence! < 0.20).length;
    const mean = withDiv.reduce((s, n) => s + n.interpretation_divergence!, 0) / withDiv.length;
    const deprioritized = allCCNodes.filter(n => n.interpretation_divergence != null && n.interpretation_divergence < 0.20).length - low;
    getGlobalRecorder()?.record({
      type: 'situation.divergence-summary',
      component: 'debate-store',
      level: low > 0 ? 'warn' : 'info',
      message: `Situation divergence: ${high} high, ${medium} moderate, ${low} low (mean ${mean.toFixed(2)})`,
      data: {
        activated_count: withDiv.length,
        high_divergence: high,
        medium_divergence: medium,
        low_divergence: low,
        mean_divergence: Math.round(mean * 100) / 100,
        deprioritized_count: deprioritized > 0 ? deprioritized : 0,
      },
    });
  }
}

/** Unfiltered fallback context when relevance scoring fails — first 21 POV + 10 CC nodes, no scores. */
function buildUnfilteredFallback(
  state: ReturnType<typeof useTaxonomyStore.getState>,
  allPovNodes: PovNode[],
  allCCNodes: SituationNode[],
  err: unknown,
): TaxonomyContextWithSources {
  console.warn('[taxonomy] Relevance scoring failed, using unfiltered:', err);
  try {
    const s = useDebateStore.getState();
    if (s.debateWarnings.length < 50) {
      useDebateStore.setState({ debateWarnings: [...s.debateWarnings, 'Taxonomy relevance scoring unavailable'] });
    }
  } catch (e) { getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-store', level: 'warn', message: 'Store not ready during relevance scoring fallback', error: { name: (e as Error).name ?? 'Error', message: String(e), stack: (e as Error).stack } }); }
  const policyRegistry = (state.policyRegistry ?? []).map(p => ({ id: p.id, action: p.action, source_povs: p.source_povs }));
  // Fallback: first 21 POV nodes + first 10 CC nodes
  return {
    povNodes: allPovNodes.slice(0, 21),
    situationNodes: allCCNodes.slice(0, 10),
    policyRegistry,
  };
}

/**
 * Get taxonomy context filtered by relevance to the debate topic.
 * Falls back to unfiltered if embeddings unavailable.
 */
export async function getRelevantTaxonomyContext(
  pov: string,
  topic: string,
  recentTranscript: string,
  threshold: number = 0.45,
): Promise<TaxonomyContextWithSources> {
  const state = useTaxonomyStore.getState();
  const povFile = state[pov as 'accelerationist' | 'safetyist' | 'skeptic'];
  const allPovNodes: PovNode[] = povFile?.nodes ?? [];
  const allCCNodes: SituationNode[] = state.situations?.nodes ?? [];

  try {
    const debate = useDebateStore.getState().activeDebate;

    // ── T3 (t/3258): assemble ONLY the per-session state that crosses the wire. The server/main side
    // derives everything static itself — the corpus (assembleNodeEmbeddings), taxonomy nodes,
    // policyRegistry, lineage L2 map and doctrinal boundaries — then runs the SAME shared lib fn
    // (selectRelevantTaxonomy) → parity by construction. The client no longer fetches the corpus to
    // score locally (the t/3165 architectural fast-follow). ──
    const anClaimEmbeddings: ANClaimInput[] = (debate?.argument_network?.nodes ?? [])
      .filter(n => n.embedding && n.embedding.length > 0)
      .map(n => ({ id: n.id, vector: n.embedding!, strength: n.computed_strength, text: n.text }));
    const lineageFrame = debate?.topic?.critique?.lineage_frame;
    const excludeGreatestHits = !!debate?.exclude_greatest_hits;
    // Greatest-hits is per-debate session state the server can't reconstruct — fetch client-side and
    // send it (Set→string[]) or the exclusion silently no-ops server-side (TL D3, t/3256#2).
    const greatestHitsList = excludeGreatestHits ? await getGreatestHits() : undefined;

    recordLineageBoostCheck(lineageFrame, debate?.source_type === 'topic');

    // Single transport call — web: REST POST /api/taxonomy/relevant-nodes; electron: IPC → a main
    // handler mirroring the server route. Returns the full RelevantTaxonomyResult (W1) — the client
    // presentation below (anchoring re-apply, diagnostics, id→node mapping) is unchanged.
    const result = await api.fetchRelevantNodes({
      pov,
      topic,
      recentTranscript,
      threshold,
      session: { anClaimEmbeddings, lineageFrame, sourceType: debate?.source_type, excludeGreatestHits, greatestHitsList },
    });

    // ── ADR-001 graceful-empty guard (t/3258, TL t/3258#14) ──
    // A real debate never legitimately selects 0 nodes, so an empty selection means the endpoint's
    // github-api-backed read returned empty (a data-read FAILURE), not "no relevant nodes." Make it
    // observable + degrade to the unfiltered fallback rather than silently shipping empty grounding to
    // the debate (make-degradation-observable rule). Worst case is observable-unfiltered, never
    // silent-empty — this keeps the hard client-swap safe regardless of the endpoint's deploy state.
    if (result.povNodes.length === 0 && result.situationNodes.length === 0) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'debate-store', level: 'warn',
        message: 'relevant-nodes returned 0 selected on a real debate — suspected server-side data-read gap (ADR-001 graceful-empty); using unfiltered fallback',
        data: { pov, candidatePovNodes: allPovNodes.length, candidateCcNodes: allCCNodes.length, anClaims: anClaimEmbeddings.length, sourceType: debate?.source_type },
      });
      return buildUnfilteredFallback(state, allPovNodes, allCCNodes, new Error('relevant-nodes returned empty selection (suspected data-read failure)'));
    }

    // ── Re-apply the doctrinal-anchoring side-effect to the store's Belief nodes ──
    // (mirrors the old in-place mutation EXACTLY: doctrinally_anchored always; confidence floor
    // only when applied — that's why DoctrinalAdjustment carries floorApplied, t/3257#16 Δ1.)
    const povById = new Map(allPovNodes.map(n => [n.id, n] as const));
    for (const adj of result.anchoring) {
      const node = povById.get(adj.nodeId);
      if (!node) continue;
      node.doctrinally_anchored = adj.doctrinallyAnchored || undefined;
      if (adj.floorApplied) {
        node.evidential_confidence = adj.evidentialConfidence;
        node.confidence = adj.confidence;
      }
    }

    // Greatest-hits loud-degrade warning (t/1998): requested but the list was unavailable.
    surfaceGreatestHitsWarning({ requested: excludeGreatestHits, applied: !!(greatestHitsList && greatestHitsList.length > 0) });

    // ── Map the lib result (ids + scores) back to full node objects + the consumer-facing maps ──
    const ccById = new Map(allCCNodes.map(n => [n.id, n] as const));
    const filteredPov = result.povNodes.map(r => povById.get(r.nodeId)).filter((n): n is PovNode => !!n);
    const filteredCC = result.situationNodes.map(r => ccById.get(r.nodeId)).filter((n): n is SituationNode => !!n);
    const nodeScores = new Map<string, number>();
    for (const r of result.povNodes) nodeScores.set(r.nodeId, r.score);
    for (const r of result.situationNodes) nodeScores.set(r.nodeId, r.score);
    const nodeSourceMap = new Map(Object.entries(result.nodeSourceMap));

    console.log(`[taxonomy] Relevance-filtered: ${filteredPov.length} POV nodes (from ${allPovNodes.length}), ${filteredCC.length} CC nodes (from ${allCCNodes.length})`);
    logLineageBoostResult(result.injectionManifest, filteredPov.length, allPovNodes.length);
    logLabelDedup(result.injectionManifest);
    logTestingSelection(result.injectionManifest, result.povNodes.length);
    recordSituationDivergence(filteredCC, allCCNodes);

    return { povNodes: filteredPov, situationNodes: filteredCC, policyRegistry: result.policyRegistry, nodeScores, nodeSourceMap, injectionManifest: result.injectionManifest };
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'debate-store',
      level: 'warn',
      message: 'Taxonomy relevance scoring failed, using unfiltered fallback',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return buildUnfilteredFallback(state, allPovNodes, allCCNodes, err);
  }
}

/** Format cross-POV tensions for injection into a specific debater's prompt */
export function formatDebaterEdgeContext(debaterPov: string): string {
  const edgesFile = useTaxonomyStore.getState().edgesFile;
  if (!edgesFile?.edges) return '';

  const povPrefixes: Record<string, string> = {
    accelerationist: 'acc-', safetyist: 'saf-', skeptic: 'skp-',
  };

  const myPrefix = povPrefixes[debaterPov];
  if (!myPrefix) return '';

  const otherPrefixes = Object.entries(povPrefixes)
    .filter(([pov]) => pov !== debaterPov)
    .map(([, prefix]) => prefix);

  const signalTypes = new Set(['CONTRADICTS', 'TENSION_WITH', 'WEAKENS']);

  // Find edges connecting this debater's POV to other POVs
  const relevantEdges = edgesFile.edges.filter(e => {
    if (!signalTypes.has(e.type)) return false;
    if (e.status !== 'approved' && e.confidence < 0.75) return false;
    const srcIsMine = e.source.startsWith(myPrefix);
    const tgtIsMine = e.target.startsWith(myPrefix);
    const srcIsOther = otherPrefixes.some(p => e.source.startsWith(p));
    const tgtIsOther = otherPrefixes.some(p => e.target.startsWith(p));
    return (srcIsMine && tgtIsOther) || (tgtIsMine && srcIsOther);
  });

  if (relevantEdges.length === 0) return '';

  // Take top 5-15 by confidence
  const top = relevantEdges
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 15);

  // Resolve node labels for readability
  const getLabel = (id: string): string => {
    const state = useTaxonomyStore.getState();
    for (const pov of POV_KEYS) {
      const node = state[pov]?.nodes?.find(n => n.id === id);
      if (node) return node.label;
    }
    return id;
  };

  const lines = [
    '',
    '=== KNOWN TENSIONS WITH OPPOSING POSITIONS ===',
    'These are documented structural disagreements between your position and other perspectives.',
    'Use these to target your arguments at real fault lines rather than talking past opponents.',
  ];
  for (const e of top) {
    const srcLabel = getLabel(e.source);
    const tgtLabel = getLabel(e.target);
    lines.push(`${e.source} (${srcLabel}) ${e.type} ${e.target} (${tgtLabel})`);
    if (e.rationale) {
      lines.push(`  ${e.rationale.slice(0, 150)}`);
    }
  }
  return lines.join('\n');
}

/** Format relevant edges between active debaters' nodes for the moderator */
export function formatEdgeContext(activePovers: string[]): string {
  const edgesFile = useTaxonomyStore.getState().edgesFile;
  if (!edgesFile?.edges) return '';

  // Map pover labels to POV prefixes
  const povPrefixes: Record<string, string> = {
    accelerationist: 'acc-', safetyist: 'saf-', skeptic: 'skp-',
  };
  const labelToPov: Record<string, string> = {
    Accelerationist: 'accelerationist', Safetyist: 'safetyist', Skeptic: 'skeptic',
    Prometheus: 'accelerationist', Sentinel: 'safetyist', Cassandra: 'skeptic',
  };

  // Find cross-POV edges of high-signal types
  const signalTypes = new Set(['CONTRADICTS', 'TENSION_WITH', 'WEAKENS', 'RESPONDS_TO']);
  const activePovs = activePovers.map(l => labelToPov[l]).filter(Boolean);
  const activePrefixes = activePovs.map(p => povPrefixes[p]).filter(Boolean);

  const relevantEdges = edgesFile.edges.filter(e => {
    if (!signalTypes.has(e.type)) return false;
    if (e.status !== 'approved' && e.confidence < 0.75) return false;
    // Must be cross-POV
    const srcPrefix = activePrefixes.find(p => e.source.startsWith(p));
    const tgtPrefix = activePrefixes.find(p => e.target.startsWith(p));
    return srcPrefix && tgtPrefix && srcPrefix !== tgtPrefix;
  });

  if (relevantEdges.length === 0) return '';

  // Take top edges by confidence
  const top = relevantEdges
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 15);

  const lines = ['', '=== KNOWN TENSIONS BETWEEN POSITIONS ==='];
  for (const e of top) {
    lines.push(`${e.source} ${e.type} ${e.target} (confidence: ${(e.confidence ?? 0).toFixed(2)})`);
  }
  return lines.join('\n');
}

/** Fallback lineage frame computed from all taxonomy nodes (document/situation debates without a topic critique). */
function computeFallbackLineageContext(): string | undefined {
  if (!isLineageDataLoaded()) return undefined;
  const taxState = useTaxonomyStore.getState();
  const mapping = getLineageMapping();
  const l2Cats = getL2Categories();

  const allNodeIds: string[] = [];
  const allNodes: PovNode[] = [];
  for (const pov of ['accelerationist', 'safetyist', 'skeptic'] as const) {
    const file = taxState[pov];
    if (!file?.nodes) continue;
    for (const node of file.nodes) {
      allNodeIds.push(node.id);
      allNodes.push(node);
    }
  }

  const lineageByNode = buildLineageByNode(allNodes);
  const nameToCluster = buildNameToCluster(mapping);
  const clusterLabels: Record<string, string> = {};
  for (const cat of l2Cats) {
    clusterLabels[cat.id] = cat.label;
  }

  const frame = computeLineageDistribution({ activatedNodeIds: allNodeIds, lineageByNode, nameToCluster, clusterLabels });
  if (frame.length === 0) return undefined;
  return formatLineageContext(frame);
}

/** Build lineage context string from pre-computed critique or fallback from all taxonomy nodes. */
export function buildLineageContext(): string | undefined {
  const debate = useDebateStore.getState().activeDebate;
  const lineageFrame = debate?.topic?.critique?.lineage_frame;
  if (lineageFrame && lineageFrame.length > 0) {
    return formatLineageContext(lineageFrame);
  }
  return computeFallbackLineageContext();
}

/** Helper to get node label for fact check (standalone, no React hooks) */
export function getNodeLabelForFactCheck(nodeId: string): string {
  const state = useTaxonomyStore.getState();
  if (nodeTypeFromId(nodeId) === 'situation') {
    const node = state.situations?.nodes?.find((n: { id: string }) => n.id === nodeId);
    return node?.label || nodeId;
  }
  const povMap: Record<string, string> = { 'acc-': 'accelerationist', 'saf-': 'safetyist', 'skp-': 'skeptic' };
  for (const [prefix, pov] of Object.entries(povMap)) {
    if (nodeId.startsWith(prefix)) {
      const povFile = state[pov as 'accelerationist' | 'safetyist' | 'skeptic'];
      const node = povFile?.nodes?.find((n: { id: string }) => n.id === nodeId);
      return node?.label || nodeId;
    }
  }
  return nodeId;
}
