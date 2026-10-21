// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Canonical, framework-agnostic taxonomy relevance-selection pipeline (t/3248 / t/3257,
// relocation-first). ONE pure implementation called by BOTH the debate client (renderer
// thin-wrapper, T3) and the server endpoint (`POST /api/taxonomy/relevant-nodes`, T2) —
// parity holds by construction when inputs match (order-preserving; the T2 parity fixture
// asserts it). Extracted from the renderer `getRelevantTaxonomyContext` orchestration
// (taxonomyContext.ts) per Rosetta's extraction read (t/3258#3) + the TL-approved
// decomposition (t/3257#7/#8).
//
// PURITY CONTRACT (load-bearing — this is why it can be a second server caller):
//   • NO store reads, NO module-singleton caches (they break server determinism/multi-tenancy),
//     NO flight-recorder/console output. All state crosses via `input`; all diagnostics are the
//     CALLER's job (server→pino, client→FR+warnings) reconstructed from the returned result.
//   • `povNodes` is treated READ-ONLY — doctrinal anchoring runs on CLONES (see below), so the
//     server's cached taxonomy is never mutated across requests (W2, t/3257#10).
//   • Embedding IO is the injected `embed` cb (server: its computeEmbeddings; fixture: a
//     deterministic stub) — used ONLY for the doctrinal-boundary strings + the topic-query
//     fallback. The corpus `nodeEmbeddings` is pre-built by the caller.

import type { PovNode, SituationNode } from './taxonomyTypes.js';
import type { TagSelection } from './types/session.js';
import { TAG_BOOST_INCREMENT, TAG_SCOPE_MINIMUM_NODES } from './debateConfig.js';
import { cosineSimilarity } from '../embeddings/similarity.js';
import {
  scoreNodesViaAN,
  scoreNodeRelevanceMeanTopN,
  buildRelevanceQuery,
  selectRelevantNodes,
  selectRelevantSituationNodes,
  excludeWellTestedModeOptions,
  summarizeTestingSelection,
  type ANClaimEmbedding,
  type RelevanceOptions,
  type ScoredPovNode,
  type ScoredSituationNode,
} from './taxonomyRelevance.js';
import { computeDoctrinalAnchoring } from './doctrinalAnchoring.js';

/** Corpus embedding map (single vector + optional synthetic multi-vectors), keyed by node id. */
export type NodeEmbeddingMap = Record<string, { pov: string; vector: number[]; vectors?: number[][] }>;

/** Merge synthetic multi-vector embeddings into the base corpus map (pure). Moved from the renderer
 *  so server + client merge identically; the renderer re-exports it for its other consumers. */
export function mergeSyntheticVectors(
  base: Record<string, { pov: string; vector: number[] }>,
  syntheticVectors: Record<string, number[][]>,
): NodeEmbeddingMap {
  const merged: NodeEmbeddingMap = {};
  for (const [nodeId, entry] of Object.entries(base)) {
    const sv = syntheticVectors[nodeId];
    merged[nodeId] = sv ? { ...entry, vectors: sv } : entry;
  }
  return merged;
}

/**
 * Assemble the corpus embedding map both callers feed to `selectRelevantTaxonomy` — the SAME
 * implementation server-side (T2) and client-side (T3), so the corpus can't drift between them
 * (parity by construction; ServerAPI t/3257#21). Pure: builds `"label: description"` texts + ids
 * for every POV + situation node, embeds them via the injected `embed` cb, tags each with `pov`,
 * then merges synthetic multi-vectors when present. The CLIENT keeps its per-debate embed memo +
 * synthetic-vector fetch in a thin wrapper (a client optimization / bridge IO — out of lib); the
 * server passes its own embed + cached synthetic vectors.
 */
export async function assembleNodeEmbeddings(
  pov: string,
  povNodes: PovNode[],
  ccNodes: SituationNode[],
  embed: (texts: string[], ids?: string[]) => Promise<number[][]>,
  syntheticVectors?: Record<string, number[][]> | null,
): Promise<{ nodeEmbeddings: NodeEmbeddingMap; allNodeIds: string[] }> {
  const allNodeTexts = [
    ...povNodes.map(n => `${n.label}: ${n.description}`),
    ...ccNodes.map(n => `${n.label}: ${n.description}`),
  ];
  const allNodeIds = [
    ...povNodes.map(n => n.id),
    ...ccNodes.map(n => n.id),
  ];
  const vectors = await embed(allNodeTexts, allNodeIds);
  const base: Record<string, { pov: string; vector: number[] }> = {};
  for (let i = 0; i < allNodeIds.length; i++) base[allNodeIds[i]] = { pov, vector: vectors[i] };
  const nodeEmbeddings = syntheticVectors ? mergeSyntheticVectors(base, syntheticVectors) : base;
  return { nodeEmbeddings, allNodeIds };
}

/**
 * Per-node scoring provenance: whether the node was surfaced by AN-claim similarity or the topic
 * query, plus the best-matching AN claim. Relocated from the renderer debate-store types so BOTH
 * the lib fn and the server T2 caller can type against it without a renderer path (DebateTool
 * t/3257#14). The renderer `useDebateStore/types.ts` re-exports this (source of truth is here).
 */
export interface NodeScoringSource {
  source: 'an' | 'topic';
  anScore: number;
  topicScore: number;
  bestClaimId?: string;
  bestClaimText?: string;
  bestClaimSim?: number;
}

/** AN claim embedding + its text (text needed for `bestClaimText` provenance; `ANClaimEmbedding` alone lacks it). */
export type ANClaimInput = ANClaimEmbedding & { text?: string };
// Re-exported so the server T2 caller types against `@lib/debate/relevanceSelection` alone (ServerAPI t/3257#15).
export type { ANClaimEmbedding } from './taxonomyRelevance.js';

/**
 * Doctrinal-anchoring adjustment for one Belief node — the client thin-wrapper re-applies these to
 * the store (today's in-place side-effect: `doctrinally_anchored` + a confidence floor for anchored
 * Beliefs); the server passes them through and does not apply. `floorApplied` distinguishes an
 * anchored-but-not-floored node (confidence/evidential unchanged) from a floored one, so the
 * re-apply mirrors today's behaviour EXACTLY (only floored nodes get their confidence rewritten).
 */
export interface DoctrinalAdjustment {
  nodeId: string;
  doctrinallyAnchored: boolean;
  floorApplied: boolean;
  /** The (post-floor) confidence to write when floorApplied; the node's current value otherwise. */
  confidence: number;
  /** The pre-floor confidence preserved when floorApplied; equals `confidence` otherwise. */
  evidentialConfidence: number;
}

/**
 * Pure pre-flight: check how many POV nodes are in-scope for a given tag.
 * Never throws at runtime — callers act on `sufficient` + `reason`.
 *
 * Sufficiency rules (t/3965#13, CL ruling p/736#31, t/4009):
 *   - `none-tagged`: inScope === 0 (either mode) — nothing to ground on or boost.
 *   - `below-floor`: Scope mode, 0 < inScope < TAG_SCOPE_MINIMUM_NODES — too thin to answer.
 *   - null: sufficient.
 * Prioritize sufficiency floor is 1 (no minimum count — it excludes nothing).
 * Scope sufficiency floor is TAG_SCOPE_MINIMUM_NODES.
 *
 * When `embeddedIds` is provided (t/4009), the floor counts only groundable nodes
 * (tagged AND embedded). `unembeddedTaggedCount` reports how many tagged nodes were
 * excluded from the count due to missing embeddings — callers should WARN on > 0.
 */
export function checkTagScope(
  povNodes: PovNode[],
  tagSelection: TagSelection,
  embeddedIds?: Set<string>,
): { inScope: PovNode[]; excluded: PovNode[]; sufficient: boolean; reason: 'none-tagged' | 'below-floor' | null; unembeddedTaggedCount: number } {
  const tagged = povNodes.filter(n => (n.pov_tags ?? []).includes(tagSelection.tag));
  const excluded = povNodes.filter(n => !(n.pov_tags ?? []).includes(tagSelection.tag));
  const inScope = embeddedIds ? tagged.filter(n => embeddedIds.has(n.id)) : tagged;
  const unembeddedTaggedCount = tagged.length - inScope.length;
  if (inScope.length === 0) {
    return { inScope, excluded, sufficient: false, reason: 'none-tagged', unembeddedTaggedCount };
  }
  if (tagSelection.mode === 'scope' && inScope.length < TAG_SCOPE_MINIMUM_NODES) {
    return { inScope, excluded, sufficient: false, reason: 'below-floor', unembeddedTaggedCount };
  }
  return { inScope, excluded, sufficient: true, reason: null, unembeddedTaggedCount };
}

/**
 * Apply tag selection to a POV node set (pure).
 * SCOPE mode: returns only tagged nodes; boostIds is empty.
 * PRIORITIZE mode: returns all nodes; boostIds lists the tagged node IDs to boost.
 */
export function applyTagSelection(
  povNodes: PovNode[],
  tagSelection: TagSelection,
): { filteredNodes: PovNode[]; excludedCount: number; boostIds: string[] } {
  if (tagSelection.mode === 'scope') {
    const tagged = povNodes.filter(n => (n.pov_tags ?? []).includes(tagSelection.tag));
    return { filteredNodes: tagged, excludedCount: povNodes.length - tagged.length, boostIds: [] };
  }
  const boostIds = povNodes
    .filter(n => (n.pov_tags ?? []).includes(tagSelection.tag))
    .map(n => n.id);
  return { filteredNodes: povNodes, excludedCount: 0, boostIds };
}

export interface SelectRelevantTaxonomyInput {
  // ── static (server-derivable; the client passes them from its store) ──
  povNodes: PovNode[];
  situationNodes: SituationNode[];
  policyRegistry: { id: string; action: string; source_povs?: string[] }[];
  /** Corpus map, caller-built (incl. synthetic multi-vector merge). */
  nodeEmbeddings: NodeEmbeddingMap;
  /** Static lineage name→L2 map. `undefined` ⇒ no lineage boost (subsumes the old `isLineageDataLoaded()`). */
  lineageMapping?: Record<string, { l2: string }>;
  /** The current POV's doctrinal boundary strings (from POVER_INFO). Embedded inside via `embed`. */
  doctrinalBoundaries?: { strings: string[]; isRejection?: boolean[] };
  // ── per-session (MUST cross the wire — the server cannot reconstruct these) ──
  session: {
    /** `argument_network.nodes[]` with embeddings — the PRIMARY scoring signal; `text` for provenance. */
    anClaimEmbeddings: ANClaimInput[];
    lineageFrame?: { cluster_id: string; label?: string }[];
    /** `debate.source_type`; lineage frame is only "expected" for `'topic'` debates. */
    sourceType?: string;
    excludeGreatestHits?: boolean;
    /** Fetched by the caller (renderer: bridge; server: its own) and passed as an array. */
    greatestHitsList?: string[];
  };
  params: {
    pov: string;
    topic: string;
    recentTranscript: string;
    threshold?: number;      // default 0.45
    minPerCategory?: number; // default 3
    maxTotal?: number;       // default 35
    topN?: number;           // mean-top-N for multi-vector nodes; default 3
    scoringMode?: 'embedding' | 'lexical';
    /** POV tag selection: SCOPE filters to tagged nodes only; PRIORITIZE boosts tagged nodes (t/3957). */
    tagSelection?: TagSelection;
    // NOTE: `minPerPov` is deliberately NOT a param — selectRelevantNodes reads `opts.minPerPov ?? 2`,
    // so leaving it unset keeps BOTH callers at the default 2 (ServerAPI parity note, t/3257#15).
  };
  /** Injected embedding fn — boundary strings + topic-query fallback ONLY (never the corpus). */
  embed: (texts: string[], ids?: string[]) => Promise<number[][]>;
}

export interface RelevantTaxonomyResult {
  /** Selected POV nodes, IN `selectRelevantNodes` ORDER (W3 — the client injects in this order). */
  povNodes: { nodeId: string; score: number }[];
  situationNodes: { nodeId: string; score: number }[];
  policyRegistry: { id: string; action: string; source_povs?: string[] }[];
  /** Per-node provenance — a plain object (a Map serializes to `{}` over the wire; ServerAPI t/3257#15). */
  nodeSourceMap: Record<string, NodeScoringSource>;
  injectionManifest: Record<string, unknown>;
  /** Doctrinal-anchoring adjustments for the client to re-apply; server passes through. */
  anchoring: DoctrinalAdjustment[];
}

/** Doctrinal anchoring WITHOUT mutating the input `povNodes` (W2): clone the Beliefs, let
 *  computeDoctrinalAnchoring mutate the clones in place, and derive explicit adjustments. */
async function computeAnchoringAdjustments(
  povNodes: PovNode[],
  nodeEmbeddings: NodeEmbeddingMap,
  doctrinalBoundaries: SelectRelevantTaxonomyInput['doctrinalBoundaries'],
  embed: SelectRelevantTaxonomyInput['embed'],
): Promise<DoctrinalAdjustment[]> {
  if (!doctrinalBoundaries || doctrinalBoundaries.strings.length === 0) return [];
  const boundaryVectors = await embed(doctrinalBoundaries.strings);
  if (boundaryVectors.length === 0) return [];

  const beliefs = povNodes.filter(n => n.category === 'Beliefs');
  // Shallow clone is sufficient: computeDoctrinalAnchoring only writes scalar fields
  // (doctrinally_anchored, confidence, evidential_confidence) on the node objects.
  const clones = beliefs.map(n => ({ ...n }));
  const results = computeDoctrinalAnchoring(
    clones, boundaryVectors, nodeEmbeddings, undefined, undefined, doctrinalBoundaries.isRejection,
  );

  const adjustments: DoctrinalAdjustment[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const clone = clones[i]; // clones are all Beliefs → 1:1 with results, in order
    if (!r.anchored && !r.floorApplied) continue;
    adjustments.push({
      nodeId: r.nodeId,
      doctrinallyAnchored: r.anchored,
      floorApplied: r.floorApplied,
      confidence: clone.confidence ?? 0,
      evidentialConfidence: r.floorApplied ? (clone.evidential_confidence ?? clone.confidence ?? 0) : (clone.confidence ?? 0),
    });
  }
  return adjustments;
}

/** Score nodes: AN-claim similarity (primary, with per-node provenance) when AN claim embeddings
 *  exist, else the topic-query fallback. Mirrors the renderer computeRelevanceScores exactly. */
async function computeScores(
  anClaimEmbeddings: ANClaimInput[],
  nodeEmbeddings: NodeEmbeddingMap,
  allNodeIds: string[],
  params: SelectRelevantTaxonomyInput['params'],
  embed: SelectRelevantTaxonomyInput['embed'],
): Promise<{ scores: Map<string, number>; nodeSourceMap: Record<string, NodeScoringSource> }> {
  const embedded = anClaimEmbeddings.filter(n => n.vector && n.vector.length > 0);
  const query = buildRelevanceQuery(params.topic, params.recentTranscript);
  const [queryVector] = await embed([query]);
  const topN = params.topN ?? 3;

  if (embedded.length > 0) {
    const scores = scoreNodesViaAN(embedded, nodeEmbeddings, undefined, true);
    const topicScores = scoreNodeRelevanceMeanTopN(queryVector, nodeEmbeddings, topN);
    const nodeSourceMap = buildNodeSourceMap(allNodeIds, scores, topicScores, nodeEmbeddings, embedded);
    return { scores, nodeSourceMap };
  }
  // No AN claims yet (pre-opening) — single topic query, no provenance.
  const scores = scoreNodeRelevanceMeanTopN(queryVector, nodeEmbeddings, topN);
  return { scores, nodeSourceMap: {} };
}

/** Per-node provenance: best-matching AN claim + AN-vs-topic comparison. Pure (moved verbatim from
 *  the renderer buildNodeSourceMap; returns a plain object instead of a Map for wire-serialization). */
function buildNodeSourceMap(
  allNodeIds: string[],
  scores: Map<string, number>,
  topicScores: Map<string, number>,
  nodeEmbeddings: NodeEmbeddingMap,
  claimEmbeddings: ANClaimInput[],
): Record<string, NodeScoringSource> {
  const out: Record<string, NodeScoringSource> = {};
  for (const nodeId of allNodeIds) {
    const anScore = scores.get(nodeId) ?? 0;
    const topicScore = topicScores.get(nodeId) ?? 0;
    const entry = nodeEmbeddings[nodeId];
    if (!entry?.vector) continue;
    let bestSim = 0;
    let bestClaim: ANClaimInput | null = null;
    for (const claim of claimEmbeddings) {
      const sim = cosineSimilarity(entry.vector, claim.vector);
      if (sim > bestSim) { bestSim = sim; bestClaim = claim; }
    }
    out[nodeId] = {
      source: anScore >= topicScore * 0.5 ? 'an' : 'topic',
      anScore,
      topicScore,
      bestClaimId: bestClaim?.id,
      bestClaimText: bestClaim?.text,
      bestClaimSim: bestSim,
    };
  }
  return out;
}

/** Build relevance-selection options, applying the lineage-tradition boost when a frame + static
 *  lineage map are present. Pure (lineage comes from params, not renderer singletons; no logging). */
function buildOptions(
  threshold: number,
  params: SelectRelevantTaxonomyInput['params'],
  povNodes: PovNode[],
  lineageFrame: SelectRelevantTaxonomyInput['session']['lineageFrame'],
  lineageMapping: SelectRelevantTaxonomyInput['lineageMapping'],
): RelevanceOptions {
  const opts: RelevanceOptions = {
    threshold,
    minPerCategory: params.minPerCategory ?? 3,
    maxTotal: params.maxTotal ?? 35,
    // minPerPov intentionally unset → selectRelevantNodes defaults it to 2 (parity, t/3257#15).
  };
  if (params.scoringMode) opts.scoringMode = params.scoringMode;
  if (lineageFrame && lineageFrame.length > 0 && lineageMapping) {
    const lineageByNode: Record<string, string[]> = {};
    for (const node of povNodes) {
      const lineage = (node as { graph_attributes?: { intellectual_lineage?: (string | { name: string })[] } })
        .graph_attributes?.intellectual_lineage;
      if (lineage && lineage.length > 0) {
        lineageByNode[node.id] = lineage.map(v => (typeof v === 'string' ? v : v.name));
      }
    }
    const nameToCluster: Record<string, string> = {};
    for (const [name, val] of Object.entries(lineageMapping)) nameToCluster[name] = val.l2;
    opts.lineageBoost = {
      traditions: lineageFrame.map(f => f.cluster_id),
      boost: 0.08,
      lineageByNode,
      nameToCluster,
    };
  }
  return opts;
}

/** Diagnostics-free injection manifest (the FR/console logging that wrapped this in the renderer is
 *  the caller's job now; the `_lineageBoost` promotion data ships in the manifest for that). */
function buildManifest(
  scoredPov: ScoredPovNode[],
  scoredCC: ScoredSituationNode[],
  threshold: number,
): Record<string, unknown> {
  const lb = (scoredPov as unknown as { _lineageBoost?: { boostedNodeIds: string[]; promotedNodeIds: string[]; promotedCount: number } })._lineageBoost;
  const manifest: Record<string, unknown> = {
    povNodeIds: scoredPov.map(s => s.node.id),
    povPrimaryIds: scoredPov.filter(s => s.score >= threshold + 0.1).map(s => s.node.id).slice(0, 5),
    situationNodeIds: scoredCC.map(s => s.node.id),
  };
  if (lb && lb.boostedNodeIds.length > 0) {
    manifest.lineage_boost = {
      boosted: lb.boostedNodeIds.length,
      promoted: lb.promotedCount,
      boostedNodeIds: lb.boostedNodeIds.slice(0, 20),
      promotedNodeIds: lb.promotedNodeIds.slice(0, 20),
    };
  }
  const testingSelection = summarizeTestingSelection(scoredPov);
  if (testingSelection) manifest.testing_selection = testingSelection;
  return manifest;
}

/**
 * The single relevance-selection pipeline. Deterministic given its inputs; the T2 parity fixture
 * asserts server selection === today's client selection (same nodes, same ORDER, same
 * nodeSourceMap/injectionManifest).
 */
export async function selectRelevantTaxonomy(input: SelectRelevantTaxonomyInput): Promise<RelevantTaxonomyResult> {
  const { povNodes, situationNodes, policyRegistry, nodeEmbeddings, lineageMapping, doctrinalBoundaries, session, params, embed } = input;
  const threshold = params.threshold ?? 0.45;

  // 0. Tag selection: SCOPE filters povNodes before scoring; PRIORITIZE keeps all and collects boost targets.
  let effectivePovNodes = povNodes;
  let tagBoostIds: string[] = [];
  let tagExcludedCount = 0;
  if (params.tagSelection) {
    const applied = applyTagSelection(povNodes, params.tagSelection);
    effectivePovNodes = applied.filteredNodes;
    tagBoostIds = applied.boostIds;
    tagExcludedCount = applied.excludedCount;
  }

  // 1. Doctrinal anchoring on the full povNodes (not filtered — anchoring is pre-selection, W2).
  const anchoring = await computeAnchoringAdjustments(povNodes, nodeEmbeddings, doctrinalBoundaries, embed);

  // 2. Relevance scores on the effective (possibly filtered) pov set + all situation nodes.
  const allNodeIds = [...effectivePovNodes.map(n => n.id), ...situationNodes.map(n => n.id)];
  const { scores, nodeSourceMap } = await computeScores(session.anClaimEmbeddings, nodeEmbeddings, allNodeIds, params, embed);

  // Apply tag boost for PRIORITIZE mode (after base scores are computed).
  for (const id of tagBoostIds) {
    const existing = scores.get(id) ?? 0;
    scores.set(id, existing + TAG_BOOST_INCREMENT);
  }

  // 3. Selection options (+ lineage boost) and the exclude-well-tested mode.
  const opts = buildOptions(threshold, params, effectivePovNodes, session.lineageFrame, lineageMapping);
  if (session.excludeGreatestHits) {
    Object.assign(opts, excludeWellTestedModeOptions());
    if (session.greatestHitsList && session.greatestHitsList.length > 0) {
      opts.greatestHitsExclude = new Set(session.greatestHitsList);
    }
  }

  // Pre-deduplicate by normalized label per camp (t/4369): filter the candidate pool BEFORE
  // selectRelevantNodes applies category/POV floors, so floors can backfill from unique-label
  // candidates. Keyed on (pov_prefix\x00normLabel) to avoid cross-POV collisions.
  // Keeps the highest-scored twin per (camp, label) — same ordering selectRelevantNodes uses.
  const labelDupSkipped: Array<{ skippedId: string; keptId: string; label: string }> = [];
  const dedupedPovNodes: PovNode[] = [];
  {
    const bestPerKey = new Map<string, { nodeId: string; score: number }>();
    for (const node of effectivePovNodes) {
      const pov = node.id.split('-')[0];
      const key = `${pov}\x00${node.label.trim().toLowerCase()}`;
      const score = scores.get(node.id) ?? 0;
      const existing = bestPerKey.get(key);
      if (!existing || score > existing.score) {
        bestPerKey.set(key, { nodeId: node.id, score });
      }
    }
    for (const node of effectivePovNodes) {
      const pov = node.id.split('-')[0];
      const key = `${pov}\x00${node.label.trim().toLowerCase()}`;
      if (bestPerKey.get(key)?.nodeId === node.id) {
        dedupedPovNodes.push(node);
      } else {
        const keptId = bestPerKey.get(key)!.nodeId;
        labelDupSkipped.push({ skippedId: node.id, keptId, label: node.label });
      }
    }
  }

  // 4. Order-preserving selection (W3) on the deduplicated candidate pool.
  const scoredPov = selectRelevantNodes(dedupedPovNodes, scores, opts);
  const scoredCC = selectRelevantSituationNodes(situationNodes, scores, threshold, 3, 15);

  const manifest = buildManifest(scoredPov, scoredCC, threshold);
  if (labelDupSkipped.length > 0) {
    // Callers must WARN when label_dedup is non-empty (t/4369): client FR in taxonomyContext.ts
    // (next to logLineageBoostResult), server Pino in relevantNodes.ts.
    manifest.label_dedup = labelDupSkipped.map(d => `${d.skippedId} (dup of ${d.keptId}: "${d.label}")`);
  }
  if (params.tagSelection) {
    const taggedSelectedCount = scoredPov.filter(s =>
      (s.node.pov_tags ?? []).includes(params.tagSelection!.tag),
    ).length;
    manifest.tag_selection = {
      tag: params.tagSelection.tag,
      mode: params.tagSelection.mode,
      excluded_untagged: tagExcludedCount,
      tagged_selected: taggedSelectedCount,
    };
  }

  return {
    povNodes: scoredPov.map(s => ({ nodeId: s.node.id, score: s.score })),
    situationNodes: scoredCC.map(s => ({ nodeId: s.node.id, score: s.score })),
    policyRegistry,
    nodeSourceMap,
    injectionManifest: manifest,
    anchoring,
  };
}
