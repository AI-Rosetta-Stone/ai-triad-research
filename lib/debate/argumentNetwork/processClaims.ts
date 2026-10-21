// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// ── Shared claim processing ──────────────────────────────────

import { SUPPORT_MOVES, wordOverlap, bestOverlapMatch, lookupTaxonomyEdgeWeight } from '../helpers.js';
import type { ArgumentNetworkNode, ArgumentNetworkEdge } from '../types.js';
import { retrieveEvidence } from '../evidenceRetriever.js';
import { buildEvidenceQbaf } from '../evidenceQbaf.js';
import type { AIAdapter } from '../aiAdapter.js';
import { detectAmbiguityCollapse, findSourcePassage } from '../ambiguityDetector.js';
import { fuzzyCorrectNodeId } from '../nodeIdUtils.js';
import { disambiguateTerms } from '../vocabularyDisambiguation.js';
import type { CampOrigin } from '../../dictionary/types.js';
import { getGlobalRecorder } from '../../flight-recorder/index.js';
import { normalizeSteelmanTarget } from '../steelman.js';

/** Normalize an extracted steelman_of to a camp id (t/3514); log what gets dropped and why. */
function normalizeClaimSteelmanTarget(raw: string | null | undefined, speaker: string, nodeId: string): string | undefined {
  const { target, rejected } = normalizeSteelmanTarget(raw, speaker);
  if (rejected) {
    getGlobalRecorder()?.record({
      type: 'an.extract', component: 'argument-network', level: 'warn',
      message: `Dropped steelman_of "${raw}" on ${nodeId}: ${rejected === 'self_steelman' ? 'a debater cannot steelman themselves' : 'not a camp'}`,
      data: { node_id: nodeId, raw, speaker, reason: rejected },
    });
  }
  return target ?? undefined;
}
import {
  BELIEF_SPECIFICITY_MAP,
  beliefVerificationToStrength,
  normalizeExtractedClaim,
  overlapToExtractionConfidence,
} from './strength.js';

/** ThinkPRM-style 4-step verification chain for Belief claims (t/455 Stage 3).
 *  Each sub-step is a self-contained judgment the model can perform reliably. */
export interface BeliefVerification {
  /** What specific evidence does the claim cite? */
  evidence_cited: string;
  /** Is the cited evidence present in the source document? */
  source_located: 'found' | 'not_found' | 'no_source';
  /** Does the cited evidence actually support the claim? */
  evidence_supports: 'strongly' | 'partially' | 'weakly' | 'contradicts';
  /** Does the source contain information contradicting the claim? */
  counter_evidence: 'none' | 'minor' | 'significant';
  /** Does this extraction resolve an ambiguity the source left open? */
  ambiguity_resolved?: 'none' | 'acknowledged' | 'collapsed';
}

export interface RawExtractedClaim {
  text: string;
  attribution_text?: string;
  canonical_proposition?: string;
  extraction_confidence?: number;
  bdi_category?: string;
  base_strength?: number | string;
  bdi_sub_scores?: Record<string, number | string>;
  specificity?: string;
  steelman_of?: string | null;
  /** ThinkPRM verification chain for Belief claims (t/455 Stage 3). */
  belief_verification?: BeliefVerification;
  /** Policymaker debates only: political salience classification. */
  political_salience?: 'high' | 'medium' | 'low';
  /** Topic scope relevance when topic constraints are active. */
  topic_relevance?: 'on_topic' | 'adjacent' | 'off_topic';
  responds_to?: {
    prior_claim_id: string;
    relationship: string;
    attack_type?: string;
    /** Legacy float format */
    weight?: number | string;
    /** NLI-style discrete category (decisive/substantial/tangential) */
    strength?: string;
    scheme?: string;
    argumentation_scheme?: string;
    warrant?: string;
  }[];
}

export interface ProcessClaimsOptions {
  groundingOverlapThreshold: number;
  duplicateOverlapThreshold?: number;
  maxClaims?: number;
  isClassifyPath: boolean;
  /** Path to sources directory for evidence retrieval (t/455 Stage 2).
   *  When provided together with `adapter`, Belief claims get QBAF-adjusted
   *  base_strength from retrieved evidence with LLM polarity classification.
   *  Requires Node.js filesystem access. */
  sourcesDir?: string;
  /** AI adapter for LLM-based evidence polarity classification in Stage 2.
   *  Required alongside `sourcesDir` — without it Stage 2 is skipped. */
  adapter?: AIAdapter;
  /** Model to use for evidence classification. Defaults to debate model. */
  evidenceModel?: string;
  /** Colloquial terms for post-extraction vocabulary disambiguation. When provided,
   *  bare terms in claim text are resolved to canonical forms based on speaker POV. */
  colloquialTerms?: import('../../dictionary/types.js').ColloquialTerm[];
}

export interface ProcessClaimsInput {
  claims: RawExtractedClaim[];
  statement: string;
  speaker: string;
  entryId: string;
  taxonomyRefIds: string[];
  turnNumber: number;
  existingNodes: ArgumentNetworkNode[];
  existingEdgeCount: number;
  startNodeId: number;
  taxonomyEdges?: { source: string; target: string; weight?: number }[];
  /** Known valid node IDs for taxonomy ref sanitization. When provided, invalid refs are corrected or stripped. */
  knownNodeIds?: Set<string>;
  /** Resolve a node ID to its canonical survivor. Called after knownNodeIds validation so superseded IDs are
   *  accepted (not fuzzy-corrected to unrelated nodes) and then silently redirected to their live successor. */
  resolveRef?: (id: string) => string;
  /** IDs of nodes identified as crux nodes. Used by marginal value filter to exempt crux-connected claims. */
  cruxNodeIds?: Set<string>;
  /** Activated situation nodes for claim-level grounding. When provided, claims with sufficient word overlap
   *  get sit- IDs added to taxonomy_refs — bridging situation context into AN structure. */
  activatedSituations?: { id: string; text: string }[];
  /** Debate audience — when 'policymakers', political_salience is extracted and QBAF boost applied. */
  audience?: string;
}

export interface ProcessClaimsResult {
  newNodes: ArgumentNetworkNode[];
  newEdges: ArgumentNetworkEdge[];
  accepted: { text: string; id: string; overlap_pct: number }[];
  /** `duplicate_of`/`duplicate_of_text` set only when `reason === 'duplicate_claim'` (t/1614). */
  rejected: { text: string; reason: string; overlap_pct: number; duplicate_of?: string; duplicate_of_text?: string }[];
  commitments: { asserted: string[]; conceded: string[]; challenged: string[] };
  rejectionReasons: Record<string, number>;
  rejectedOverlapPcts: number[];
  maxOverlapVsExisting: number;
  /** Number of claims rejected by the marginal value filter (anti-filibustering). */
  lowValueClaimsRejected: number;
}

const VALID_ATTACK_TYPES = new Set(['rebut', 'undercut', 'undermine']);

export async function processExtractedClaims(
  input: ProcessClaimsInput,
  options: ProcessClaimsOptions,
): Promise<ProcessClaimsResult> {
  const {
    claims, statement, speaker, entryId,
    turnNumber, existingNodes, existingEdgeCount, startNodeId, taxonomyEdges,
    knownNodeIds, resolveRef,
  } = input;

  // Sanitize taxonomy ref IDs — final safety net against hallucinated IDs
  let taxonomyRefIds = input.taxonomyRefIds;
  if (knownNodeIds && knownNodeIds.size > 0) {
    taxonomyRefIds = taxonomyRefIds.map(id => {
      let accepted: string;
      if (knownNodeIds.has(id)) {
        accepted = id;
      } else {
        const corrected = fuzzyCorrectNodeId(id, knownNodeIds);
        if (corrected) {
          console.log(`[AN] Taxonomy ref ID correction: ${id} → ${corrected}`);
          accepted = corrected;
        } else {
          console.log(`[AN] Taxonomy ref ID removed (unknown): ${id}`);
          return null;
        }
      }
      if (resolveRef) {
        const resolved = resolveRef(accepted);
        if (resolved !== accepted) {
          console.log(`[AN] Taxonomy ref ID superseded: ${accepted} → ${resolved}`);
          return resolved;
        }
      }
      return accepted;
    }).filter((id): id is string => id !== null);
  }

  const maxClaims = options.maxClaims ?? 6;
  const dupThreshold = options.duplicateOverlapThreshold ?? 0.30;
  const groundingThreshold = options.groundingOverlapThreshold;

  const newNodes: ArgumentNetworkNode[] = [];
  const newEdges: ArgumentNetworkEdge[] = [];
  const accepted: ProcessClaimsResult['accepted'] = [];
  const rejected: ProcessClaimsResult['rejected'] = [];
  const commitments = { asserted: [] as string[], conceded: [] as string[], challenged: [] as string[] };
  const rejectionReasons: Record<string, number> = {};
  const rejectedOverlapPcts: number[] = [];
  let maxOverlap = 0;

  const allNodes = [...existingNodes];
  const priorIds = new Set(existingNodes.map(n => n.id));
  let nextNodeId = startNodeId;
  let nextEdgeId = existingEdgeCount + 1;

  const bdiConfidenceMap: Record<string, number> = { belief: 0.3, desire: 0.65, intention: 0.71 };

  for (const rawClaim of claims.slice(0, maxClaims)) {
    const claim = normalizeExtractedClaim(rawClaim);
    if (!claim.text || claim.text.length < 10) {
      // t/1616: never drop a candidate silently. Empty and too-short candidates
      // both get a rejected record + reason-counter bump so the extraction-trace
      // invariant candidates_proposed === candidates_accepted + candidates_rejected holds.
      const reason = claim.text ? 'too_short' : 'empty';
      rejected.push({ text: claim.text ?? '', reason, overlap_pct: 0 });
      rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
      continue;
    }

    const debaterNodes = allNodes.filter(n => n.speaker !== 'document');
    const { overlap: overlapVsAN, node: dupNode } = bestOverlapMatch(claim.text, debaterNodes);
    if (overlapVsAN > maxOverlap) maxOverlap = overlapVsAN;

    if (overlapVsAN >= dupThreshold) {
      const pct = Math.round(overlapVsAN * 100);
      rejected.push({
        text: claim.text,
        reason: 'duplicate_claim',
        overlap_pct: pct,
        duplicate_of: dupNode?.id,
        duplicate_of_text: dupNode?.text,
      });
      rejectionReasons['duplicate_claim'] = (rejectionReasons['duplicate_claim'] ?? 0) + 1;
      rejectedOverlapPcts.push(pct);
      continue;
    }

    const overlap = wordOverlap(claim.text, statement);
    if (overlap < groundingThreshold) {
      const pct = Math.round(overlap * 100);
      rejected.push({ text: claim.text, reason: 'low_overlap', overlap_pct: pct });
      rejectionReasons['low_overlap'] = (rejectionReasons['low_overlap'] ?? 0) + 1;
      rejectedOverlapPcts.push(pct);
      continue;
    }

    const nodeId = `AN-${nextNodeId++}`;
    const node: ArgumentNetworkNode = {
      id: nodeId,
      text: claim.text,
      attribution_text_genus: claim.attribution_text || undefined,
      canonical_proposition: claim.canonical_proposition || undefined,
      speaker: speaker as ArgumentNetworkNode['speaker'],
      source_entry_id: entryId,
      taxonomy_refs: taxonomyRefIds,
      turn_number: turnNumber,
      base_strength: typeof claim.base_strength === 'number' ? claim.base_strength : 0.5,
      scoring_method: typeof claim.base_strength === 'number'
        ? 'bdi_criteria'
        : (claim.bdi_category === 'belief' ? 'unscored' : 'bdi_criteria'),
      bdi_sub_scores: claim.bdi_sub_scores && typeof claim.bdi_sub_scores === 'object'
        ? claim.bdi_sub_scores as ArgumentNetworkNode['bdi_sub_scores'] : undefined,
      bdi_confidence: bdiConfidenceMap[claim.bdi_category ?? ''] ?? 0.5,
      bdi_category: claim.bdi_category as ArgumentNetworkNode['bdi_category'],
      specificity: claim.specificity as ArgumentNetworkNode['specificity'],
      steelman_of: normalizeClaimSteelmanTarget(claim.steelman_of, String(speaker), nodeId),
      extraction_confidence: overlapToExtractionConfidence(overlap),
    };

    if (typeof claim.extraction_confidence !== 'number') {
      getGlobalRecorder()?.record({
        type: 'an.extraction_confidence_missing', component: 'argument-network', level: 'debug',
        speaker,
        message: `LLM output missing extraction_confidence for claim "${claim.text.slice(0, 80)}" — computed server-side from wordOverlap (${Math.round(overlap * 100)}%)`,
        data: { node_id: nodeId, overlap, computed_confidence: node.extraction_confidence },
      });
    } else {
      const delta = Math.abs(claim.extraction_confidence - node.extraction_confidence!);
      if (delta >= 0.3) {
        getGlobalRecorder()?.record({
          type: 'an.extraction_confidence_delta', component: 'argument-network', level: 'info',
          speaker,
          message: `extraction_confidence: LLM=${claim.extraction_confidence.toFixed(2)} vs server=${node.extraction_confidence!.toFixed(2)} (delta=${delta.toFixed(2)}) for "${claim.text.slice(0, 80)}"`,
          data: { node_id: nodeId, llm_confidence: claim.extraction_confidence, server_confidence: node.extraction_confidence, delta, overlap },
        });
      }
    }

    // BDI composite scoring: for Desires and Intentions with sub-scores,
    // use the mean of the 3 calibrated criteria as base_strength (Q-0: r=0.65/0.71).
    if (node.bdi_category === 'desire' && node.bdi_sub_scores) {
      const { values_grounding, tradeoff_acknowledgment, precedent_citation } = node.bdi_sub_scores;
      if (values_grounding != null || tradeoff_acknowledgment != null || precedent_citation != null) {
        const vg = Number.isFinite(values_grounding) ? values_grounding! : 0.5;
        const ta = Number.isFinite(tradeoff_acknowledgment) ? tradeoff_acknowledgment! : 0.5;
        const pc = Number.isFinite(precedent_citation) ? precedent_citation! : 0.5;
        node.base_strength = (vg + ta + pc) / 3;
        node.scoring_method = 'bdi_composite';
      }
    } else if (node.bdi_category === 'intention' && node.bdi_sub_scores) {
      const { mechanism_specificity, scope_bounding, failure_mode_addressing } = node.bdi_sub_scores;
      if (mechanism_specificity != null || scope_bounding != null || failure_mode_addressing != null) {
        const ms = Number.isFinite(mechanism_specificity) ? mechanism_specificity! : 0.5;
        const sb = Number.isFinite(scope_bounding) ? scope_bounding! : 0.5;
        const fm = Number.isFinite(failure_mode_addressing) ? failure_mode_addressing! : 0.5;
        node.base_strength = (ms + sb + fm) / 3;
        node.scoring_method = 'bdi_composite';
      }
    } else if (node.bdi_category === 'belief') {
      // ── Belief scoring pipeline (t/455) ──
      // Priority: ThinkPRM verification (Stage 3) > evidence QBAF (Stage 2)
      //         > specificity proxy (Stage 1) > generic
      let beliefScored = false;

      // Stage 3: ThinkPRM 4-step verification chain
      // The extraction prompt decomposes "evidence quality" into 4 tractable sub-steps.
      // Each sub-step is self-contained — the model doesn't need external access.
      if (claim.belief_verification
        && claim.belief_verification.source_located
        && claim.belief_verification.evidence_supports) {
        // Override LLM self-reported ambiguity_resolved with structural detector.
        // The model that collapsed an ambiguity can't reliably detect its own collapse.
        const sourcePassage = findSourcePassage(statement, claim.text);
        const ambiguityResult = detectAmbiguityCollapse(sourcePassage, claim.text);
        claim.belief_verification.ambiguity_resolved = ambiguityResult.resolution;

        node.base_strength = beliefVerificationToStrength(claim.belief_verification);
        node.scoring_method = 'belief_verification';
        beliefScored = true;
      }

      // Stage 2: Evidence-retrieval-augmented scoring via QBAF with LLM polarity classification.
      // Retrieves evidence, classifies each item as support/contradict/irrelevant via LLM,
      // then builds a QBAF sub-graph. Requires both sourcesDir and adapter — cosine similarity
      // alone is polarity-blind (a negated proposition embeds near its affirmative twin).
      // Only runs if Stage 3 (ThinkPRM) didn't already score the claim.
      if (!beliefScored && options.sourcesDir && options.adapter) {
        try {
          const evidence = retrieveEvidence(node.text, options.sourcesDir, { topK: 5 });
          if (evidence.length > 0) {
            const specStrength = BELIEF_SPECIFICITY_MAP[node.specificity ?? ''] ?? 0.50;
            const qbafResult = await buildEvidenceQbaf(
              node.text,
              evidence,
              options.adapter,
              options.evidenceModel ?? 'gemini-3.5-flash-lite',
              { claimBaseStrength: specStrength },
            );
            node.base_strength = qbafResult.computed_strength;
            node.scoring_method = 'evidence_qbaf';
            beliefScored = true;
          }
        } catch {
          // Evidence retrieval or LLM classification failed — fall through to Stage 1
        }
      } else if (!beliefScored && options.sourcesDir && !options.adapter) {
        getGlobalRecorder()?.record({
          type: 'an.evidence_qbaf_skipped', component: 'argument-network', level: 'warn',
          speaker,
          message: 'Stage 2 evidence QBAF skipped: sourcesDir provided but no adapter — polarity classification requires an adapter',
          data: { node_id: nodeId },
        });
      }

      // Stage 1: Specificity proxy fallback
      if (!beliefScored) {
        const specStrength = BELIEF_SPECIFICITY_MAP[node.specificity ?? ''];
        if (specStrength != null) {
          node.base_strength = specStrength;
          node.scoring_method = 'belief_specificity';
        }
      }
    }

    // Anti-filibustering: reject low-value claims that don't connect to cruxes or introduce novel schemes
    const nodeStrength = node.base_strength ?? 0.5;
    if (nodeStrength < 0.25) {
      const cruxIds = input.cruxNodeIds;
      const connectsToCrux = cruxIds && cruxIds.size > 0 && (claim.responds_to ?? []).some(
        rel => rel.prior_claim_id && cruxIds.has(rel.prior_claim_id),
      );
      const recentSchemes = new Set(
        allNodes.slice(-10).flatMap(n => {
          const edges = newEdges.filter(e => e.source === n.id || e.target === n.id);
          return edges.map(e => e.argumentation_scheme).filter(Boolean) as string[];
        }),
      );
      const scheme = (claim.responds_to ?? []).find(r => r.scheme || r.argumentation_scheme);
      const isNovelScheme = scheme && !recentSchemes.has(scheme.scheme ?? scheme.argumentation_scheme ?? '');
      if (!connectsToCrux && !isNovelScheme) {
        rejected.push({ text: claim.text, reason: 'low_marginal_value', overlap_pct: Math.round(overlap * 100) });
        rejectionReasons['low_marginal_value'] = (rejectionReasons['low_marginal_value'] ?? 0) + 1;
        continue;
      }
    }

    // Post-extraction vocabulary disambiguation
    if (options.colloquialTerms && options.colloquialTerms.length > 0) {
      const vocab = disambiguateTerms(node.text, speaker as CampOrigin, options.colloquialTerms);
      const resolved = vocab.terms.filter(t => !t.ambiguous);
      if (resolved.length > 0) {
        node.vocabulary_tags = resolved.map(t => ({
          colloquial: t.bare, canonical: t.canonical, offset: t.offset,
        }));
      }
    }

    // Topic relevance: carry forward from extraction when topic constraints are active.
    if (claim.topic_relevance && (claim.topic_relevance === 'on_topic' || claim.topic_relevance === 'adjacent' || claim.topic_relevance === 'off_topic')) {
      node.topic_relevance = claim.topic_relevance;
    }

    // Policymaker political salience: carry forward from extraction and apply QBAF boost.
    // Only fires on explicit 'high', never on undefined. +0.10 boost capped at 1.0.
    if (input.audience === 'policymakers' && claim.political_salience) {
      const salience = claim.political_salience as 'high' | 'medium' | 'low';
      if (salience === 'high' || salience === 'medium' || salience === 'low') {
        node.political_salience = salience;
        if (salience === 'high') {
          node.base_strength = Math.min(1.0, (node.base_strength ?? 0.5) + 0.10);
        }
      }
    }

    // Situation grounding: propagate sit- refs from activated situation nodes
    // when the claim text has sufficient word overlap with the situation description.
    // The cite stage rarely produces sit- IDs (its prompt focuses on POV nodes),
    // so this bridges situation context into AN structure for QBAF visibility.
    if (input.activatedSituations && input.activatedSituations.length > 0) {
      const existingRefs = new Set(node.taxonomy_refs);
      for (const sit of input.activatedSituations) {
        if (existingRefs.has(sit.id)) continue;
        if (wordOverlap(claim.text, sit.text) >= 0.15) {
          node.taxonomy_refs = [...node.taxonomy_refs, sit.id];
          existingRefs.add(sit.id);
        }
      }
    }

    newNodes.push(node);
    allNodes.push(node);
    priorIds.add(nodeId);

    commitments.asserted.push(claim.text);
    accepted.push({ text: claim.text, id: nodeId, overlap_pct: Math.round(overlap * 100) });

    for (const rel of claim.responds_to ?? []) {
      if (!rel.prior_claim_id || !priorIds.has(rel.prior_claim_id)) continue;

      let edgeWeight: number | undefined = typeof rel.weight === 'number'
        ? Math.max(0, Math.min(1, rel.weight)) : undefined;
      if (edgeWeight === undefined) {
        const targetNode = allNodes.find(n => n.id === rel.prior_claim_id);
        edgeWeight = lookupTaxonomyEdgeWeight(taxonomyRefIds, targetNode?.taxonomy_refs ?? [], taxonomyEdges);
      }

      const raw = (rel.attack_type ?? '').toLowerCase();
      const edge: ArgumentNetworkEdge = {
        id: `AE-${nextEdgeId++}`,
        source: nodeId,
        target: rel.prior_claim_id,
        type: rel.relationship === 'attacks' ? 'attacks' : 'supports',
        attack_type: rel.relationship === 'attacks'
          ? (VALID_ATTACK_TYPES.has(raw) ? raw as 'rebut' | 'undercut' | 'undermine' : 'rebut')
          : undefined,
        weight: edgeWeight,
        strength: rel.strength as ArgumentNetworkEdge['strength'],
        scheme: rel.scheme as ArgumentNetworkEdge['scheme'],
        warrant: rel.warrant,
        argumentation_scheme: rel.argumentation_scheme as ArgumentNetworkEdge['argumentation_scheme'],
      };
      newEdges.push(edge);

      if (rel.scheme) {
        const normalized = rel.scheme.toUpperCase().replace(/[_]/g, '-').trim();
        if (SUPPORT_MOVES.has(normalized) || SUPPORT_MOVES.has(normalized.replace(/-/g, ' '))) {
          const targetNode = allNodes.find(n => n.id === rel.prior_claim_id);
          // Only count as concession if supporting an OPPONENT's claim
          if (targetNode && targetNode.speaker !== speaker && !commitments.conceded.includes(targetNode.text)) {
            commitments.conceded.push(targetNode.text);
            getGlobalRecorder()?.record({
              type: 'an.commitment_update', component: 'argument-network', level: 'info',
              speaker,
              message: `Commitment: conceded "${targetNode.text.slice(0, 80)}"`,
              data: { type: 'conceded', claim_text: targetNode.text, target_node_id: rel.prior_claim_id, trigger_scheme: rel.scheme, target_speaker: targetNode.speaker },
            });
          }
        }
      }
      if (rel.relationship === 'attacks') {
        const targetNode = allNodes.find(n => n.id === rel.prior_claim_id);
        if (targetNode && !commitments.challenged.includes(targetNode.text)) {
          commitments.challenged.push(targetNode.text);
          getGlobalRecorder()?.record({
            type: 'an.commitment_update', component: 'argument-network', level: 'info',
            speaker,
            message: `Commitment: challenged "${targetNode.text.slice(0, 80)}"`,
            data: { type: 'challenged', claim_text: targetNode.text, target_node_id: rel.prior_claim_id, trigger_scheme: rel.scheme, target_speaker: targetNode.speaker },
          });
        }
      }
    }
  }

  // t/1616: candidates beyond maxClaims are dropped without evaluation by the
  // `claims.slice(0, maxClaims)` cap above. Record each as a `truncated` rejection
  // so it flows into candidates_rejected and the invariant
  // candidates_proposed === candidates_accepted + candidates_rejected holds
  // universally. `truncated` is a distinct, labeled reason in rejectionReasons —
  // the drop is now visible in the extraction trace rather than silently absorbed.
  for (const rawTruncated of claims.slice(maxClaims)) {
    const truncated = normalizeExtractedClaim(rawTruncated);
    rejected.push({ text: truncated.text ?? '', reason: 'truncated', overlap_pct: 0 });
    rejectionReasons['truncated'] = (rejectionReasons['truncated'] ?? 0) + 1;
  }

  return {
    newNodes, newEdges, accepted, rejected, commitments,
    rejectionReasons, rejectedOverlapPcts, maxOverlapVsExisting: maxOverlap,
    lowValueClaimsRejected: 0,
  };
}
