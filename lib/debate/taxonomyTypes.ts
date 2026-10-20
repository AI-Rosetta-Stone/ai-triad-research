// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Canonical taxonomy types — shared across all apps.
// TE's types/taxonomy.ts re-exports these; TE-only types stay there.

import type { PovKey } from './types.js';
// Type-only import (erased at runtime) — entities/types.ts already type-imports PovNode from here,
// so keeping this `import type` prevents a runtime cycle (t/3157). Link-ref shapes are homed in
// lib/entities (the entity contract) and reused by both BDI nodes and claim containers (t/3124).
import type { EntityLinkRef, ConceptLinkRef } from '../entities/types.js';
export type Pov = PovKey;
export type Category = 'Desires' | 'Beliefs' | 'Intentions';

export type FallacyTier = 'formal' | 'informal_structural' | 'informal_contextual' | 'cognitive_bias';

export interface PossibleFallacy {
  fallacy: string;
  /** Fallacy tier — required on new entries, absent on pre-standard data. */
  type?: FallacyTier;
  confidence: 'likely' | 'possible' | 'borderline';
  explanation: string;
}

export interface GraphAttributes {
  epistemic_type?: string;
  rhetorical_strategy?: string;
  assumes?: string[];
  falsifiability?: string;
  audience?: string;
  emotional_register?: string;
  policy_actions?: { policy_id?: string; action: string; framing: string }[];
  intellectual_lineage?: (string | { name: string; description?: string; url?: string; category?: string })[];
  /** Pre-Phase-6c: string. Post-Phase-6c: per-POV object. Check typeof. */
  steelman_vulnerability?: string | {
    from_accelerationist?: string;
    from_safetyist?: string;
    from_skeptic?: string;
  };
  possible_fallacies?: PossibleFallacy[];
  /** AIF node scope — added in dolce-phase-4. Absent in older nodes. */
  node_scope?: 'claim' | 'scheme' | 'bridging';
  attribution_text?: string;
  aphorism?: string;
  /** First-person present-tense own-voice declarative restatement of the node claim (1-2 sentences).
   *  Debate-grounding register (t/3367). Absent on most nodes until backfill (t/3366); loader treats
   *  absence as normal and falls back to description, as today. */
  debate_grounding?: string;
  /** LIVE transient dirty-flag: the renderer enrichment flow sets it mid-regen and clears it on
   *  completion (debateReflectionSlice), and AdminPanel surfaces stuck-pending nodes. Schema-of-record
   *  status: transient — legal-but-ephemeral, never long-lived in data (residue cleaned t/3451).
   *  Do NOT remove while that flow exists. */
  _phrase_regen_pending?: boolean;
  debate_tested?: DebateTestedRecord;
  /** Data-integrity provenance signal (t/3264). Absent = 'curated'. Used by formatTaxonomyContext
   *  to route ai-retrieved/unverified nodes to the RETRIEVED CONTEXT block instead of the
   *  debater's grounding block, preventing false-claim laundering via structural authority. */
  verification_status?: 'curated' | 'ai-retrieved' | 'unverified';
}

// ── Debate-Tested (t/1523, Phase 0) ──────────────────────────────────────

export type DebateTestedTier = 'untested' | 'cited' | 'contested' | 'well_tested';
export type DebateTestedVerdict = 'held' | 'weakened' | 'refined' | 'open' | 'cited';

export interface StrongestAttackEncountered {
  claim_id: string;
  strength: number;
  scheme: string;
  challenger_camp: string;
}

export interface DebateTestedClaimOutcomes {
  thrived: number;
  survived: number;
  died: number;
}

export interface DebateTestedConcession {
  type: 'full' | 'conditional' | 'tactical';
  turn: string;
}

export interface DebateTestedEntry {
  debate_id: string;
  date: string;
  pipeline_version: string;
  verdict: DebateTestedVerdict;
  strongest_attack_encountered: StrongestAttackEncountered | null;
  claim_outcomes: DebateTestedClaimOutcomes;
  concession: DebateTestedConcession | null;
}

export interface DebateTestedRevision {
  date: string;
  debate_id: string;
  held_since: boolean | null;
  prior_falsifiability?: string;
}

export interface DebateTestedRecord {
  tier: DebateTestedTier;
  sort_key: number;
  engagements: number;
  challenges: number;
  held: number;
  weakened: number;
  revisions: DebateTestedRevision[];
  last_tested: string;
  description_hash: string;
  record: DebateTestedEntry[];
}

export type ParentRelationship = 'is_a' | 'part_of' | 'specializes';

/** Entry in a node's confidence or priority change history. */
export interface WeightHistoryEntry {
  date: string;
  value: number;
  delta: number;
  reason: string;
  /** Debate ID of superseded prior update (cross-debate dedup). */
  supersedes?: string;
  /** AN claim text that drove the confidence change. */
  attack_claim?: string;
  /** Cross-model confirmation count (≥2 means multi-model agreement). */
  robustness?: number;
  /** Models that independently confirmed this attack. */
  model_confirmations?: string[];
}

export type TextEditSource = 'interactive' | 'debate_reflection' | 'batch_audit' | 'initial';

export interface TextHistoryEntry {
  date: string;
  previous?: string;
  value: string;
  source: TextEditSource;
  debate_id?: string;
  reason?: string;
}

export interface NodeEditMeta {
  last_edited_by: string;
  last_edited_at: string;
  created_by?: string;
  created_at?: string;
}

export interface EditHistoryEntry {
  user: string;
  timestamp: string;
  fields_changed: string[];
  summary?: string;
  source?: TextEditSource;
  debate_id?: string;
  reason?: string;
}

export interface PovNode {
  id: string;
  category: Category;
  label: string;
  description: string;
  parent_id: string | null;
  parent_relationship?: ParentRelationship | null;
  parent_rationale?: string | null;
  children: string[];
  situation_refs: string[];
  conflict_ids?: string[];
  graph_attributes?: GraphAttributes;
  debate_refs?: string[];
  /** Belief confidence (0.0-1.0). Multi-signal formula. Absent in pre-weighted nodes. */
  confidence?: number;
  /** Confidence change log. Absent in pre-weighted nodes. */
  confidence_history?: WeightHistoryEntry[];
  /** True if this Belief is cosine-similar to its POV's doctrinal boundaries. Absent in pre-weighted nodes. */
  doctrinally_anchored?: boolean;
  /** Pre-floor evidential confidence. When doctrinally_anchored, confidence may be raised to the floor — this preserves the original evidential score. */
  evidential_confidence?: number;
  /** Desire priority (1-5). Absent in pre-weighted nodes and non-Desire categories. */
  priority?: number;
  /** Priority change log. Absent in pre-weighted nodes. */
  priority_history?: WeightHistoryEntry[];
  /** Intention operationality (1-5). Absent in pre-weighted nodes and non-Intention categories. */
  operationality?: number;
  /** Operationality change log. Absent in pre-weighted nodes. */
  operationality_history?: WeightHistoryEntry[];
  /** Concession history — tracks cross-debate concessions affecting this node. Absent in pre-tracking nodes. */
  concession_history?: ConcessionRecord[];
  label_history?: TextHistoryEntry[];
  description_history?: TextHistoryEntry[];
  /** Last 5 modifications to this node (FIFO). */
  change_history?: ChangeHistoryEntry[];
  /** POV tags (t/3955): ids from this node's own POV in lib/debate/soul-docs/pov-tags.json. Curated,
   *  editor-owned. Absent or empty = untagged, which means EXCLUDED under a tag in Scope mode. Validate
   *  with validatePovTags (lib/schema/povTags.ts). Always an array; never a bare string. */
  pov_tags?: string[];
  /** Auto-generated plain-language version of description (display-only, never sent to debate prompts). */
  plain_description?: string | null;
  /** Model+prompt version string (e.g., "flash-lite:v1") for staleness detection. */
  plain_description_version?: string | null;
  /** Forward grounding links to register entities (t/3157, epic t/3156 §13). Optional; absent = no
   *  links. Each is an {@link EntityLinkRef} carrying method/status so a confirmed link is never
   *  confused with a speculative embedding proposal. Written by the resolution pass (G2/G3); the
   *  reverse map is entities' used_by_nodes. */
  entity_refs?: EntityLinkRef[];
  /** Forward grounding links to dictionary concepts (term:*) (t/3157). Optional; {@link ConceptLinkRef}
   *  (no match_level — a concept ref already names a kind). */
  concept_refs?: ConceptLinkRef[];
  /** ID of the node that supersedes this one. Selection skips superseded nodes; resolveNode still
   *  returns them. Chains resolve to the final non-superseded node; cycles and dangling targets
   *  resolve to the node itself. See taxonomyLoader.ts › loadTaxonomy. */
  superseded_by?: string;
  _edit_meta?: NodeEditMeta;
  _edit_history?: EditHistoryEntry[];
}

export type ChangeAction = 'created' | 'modified' | 'deprecated';

export interface ChangeHistoryEntry {
  date: string;
  action: ChangeAction;
  fields: string[];
}

export type ConcessionType = 'full' | 'conditional' | 'tactical';

export interface ConcessionRecord {
  debate_id: string;
  speaker: string;
  text: string;
  turn: number;
  conceded_to: string;
  concession_type: ConcessionType;
  bdi_impact: 'belief' | 'desire' | 'intention';
}

/** BDI-decomposed interpretation — separates empirical claims, normative commitments, and strategic reasoning. */
export interface BdiInterpretation {
  /** Empirical claim(s) this POV makes about the situation. */
  belief: string;
  /** Normative commitment(s) this POV holds regarding the situation. */
  desire: string;
  /** Strategic reasoning this POV applies to the situation. */
  intention: string;
  /** 1-2 sentence summary for UI display and backward compatibility. */
  summary: string;
}

/** Raw interpretation as stored on disk — either a legacy plain string or BDI-decomposed object. */
export type RawInterpretation = string | BdiInterpretation;

/** Strict interpretation type — BDI-decomposed only, for validated code paths. */
export type Interpretation = BdiInterpretation;

/** Extract the display text from an interpretation (handles both formats). */
export function interpretationText(interp: RawInterpretation | undefined): string {
  if (!interp) return '';
  if (typeof interp === 'string') return interp;
  return interp.summary;
}

/** Check if an interpretation is BDI-decomposed. */
export function isBdiInterpretation(interp: RawInterpretation | undefined): interp is BdiInterpretation {
  return typeof interp === 'object' && interp !== null && 'belief' in interp;
}

// Whole-value null sentinels (case-insensitive) — from t/3018.
const NULL_SENTINELS = new Set(['null', 'none', 'n/a', 'tbd', '-']);

/**
 * Check a single interpretation value for BDI compliance — matches Test-SituationBdiCompliance exactly.
 * Checks belief, desire, intention (not summary). Returns a violation reason string, or null if compliant.
 */
export function validateBdiFields(interp: unknown): string | null {
  if (typeof interp !== 'object' || interp === null) return 'not-object';
  const obj = interp as Record<string, unknown>;
  for (const field of ['belief', 'desire', 'intention'] as const) {
    const val = typeof obj[field] === 'string' ? (obj[field] as string).trim() : '';
    if (!val || NULL_SENTINELS.has(val.toLowerCase())) {
      return `${field}: blank or sentinel`;
    }
  }
  return null;
}

/**
 * Validate a set of situation nodes for BDI compliance, matching PS Test-SituationBdiCompliance exactly.
 * Nodes whose description starts with [DEPRECATED] (after trimming leading whitespace) are exempted.
 * Returns an array of violations — empty means all nodes are compliant.
 */
export function findSituationBdiViolations(
  nodes: SituationNode[],
): Array<{ id: string; pov: string; reason: string }> {
  const out: Array<{ id: string; pov: string; reason: string }> = [];
  for (const node of nodes) {
    if (node.description.trimStart().startsWith('[DEPRECATED]')) continue;
    for (const pov of ['accelerationist', 'safetyist', 'skeptic'] as const) {
      const reason = validateBdiFields(node.interpretations[pov]);
      if (reason) out.push({ id: node.id, pov, reason });
    }
  }
  return out;
}

export interface SituationNode {
  id: string;
  label: string;
  description: string;
  parent_id?: string | null;
  parent_relationship?: ParentRelationship | null;
  interpretations: {
    accelerationist: RawInterpretation;
    safetyist: RawInterpretation;
    skeptic: RawInterpretation;
  };
  linked_nodes: string[];
  conflict_ids: string[];
  graph_attributes?: GraphAttributes;
  /** Cross-POV disagreement classification — added in dolce-phase-4. Absent in older nodes. */
  disagreement_type?: 'definitional' | 'interpretive' | 'structural';
  debate_refs?: string[];
  /** Mean pairwise cosine distance across the three POV interpretation embeddings (0–1). */
  interpretation_divergence?: number;
  parent_rationale?: string | null;
  /** Present when this situation node was created from debate consensus detection (t/510). */
  convergence_source?: {
    debate_id: string;
    convergence_type: 'full' | 'partial' | 'conditional';
    original_proposals: Record<string, {
      proposed_label: string;
      evidence_entries: string[];
    }>;
    similarity_scores: Record<string, number>;
  };
  /** Auto-generated plain-language version of description (display-only, never sent to debate prompts). */
  plain_description?: string | null;
  /** Model+prompt version string (e.g., "flash-lite:v1") for staleness detection. */
  plain_description_version?: string | null;
  _edit_meta?: NodeEditMeta;
}

/** @deprecated Use SituationNode. Kept for backward compatibility. */
export type CrossCuttingNode = SituationNode;

// ── Edge types (from taxonomy/Origin/edges.json) ─────────

export type EdgeStatus = 'proposed' | 'approved' | 'rejected';

/** Canonical edge types (AIF-aligned, Phase 5). Legacy types still appear in pre-migration data. */
export type CanonicalEdgeType =
  | 'SUPPORTS'
  | 'CONTRADICTS'
  | 'ASSUMES'
  | 'WEAKENS'
  | 'RESPONDS_TO'
  | 'TENSION_WITH'
  | 'INTERPRETS'
  | 'CONVERGES_WITH';

/** Accept both canonical and legacy edge types — backward-compat handler (kept permanently). */
export type EdgeType = CanonicalEdgeType | (string & {});

/**
 * Provenance of an edge's `rationale` (t/2943, CL design edge-rationale-source-marker.md).
 * Closed vocabulary; absent = legacy/unknown (the pre-marker era):
 *   - `discovery`          — LLM classification at edge-discovery time (contemporaneous)
 *   - `embedding-template` — templated from similarity; no LLM justified it
 *   - `reflection`         — emitted by a debate reflection proposal
 *   - `restore`            — original discovery-time text git-restored after a data-loss event
 *   - `backfill`           — post-hoc LLM reconstruction from node content (last resort; t/2679, now void)
 *   - `human`              — manually authored/edited by a curator
 * No validation gate here — that's the separate prospective-gate tranche (t/2444 plan 2a).
 */
export type EdgeRationaleSource =
  | 'discovery'
  | 'embedding-template'
  | 'reflection'
  | 'restore'
  | 'backfill'
  | 'human';

export interface Edge {
  source: string;
  target: string;
  type: EdgeType;
  bidirectional: boolean;
  confidence: number;
  weight?: number;
  /** Weight modulated by endpoint confidence/priority. Computed by modulateEdgeWeights.ts. */
  modulated_weight?: number;
  rationale?: string;
  /**
   * Provenance of `rationale` (t/2943). One of {@link EdgeRationaleSource}; absent = legacy/unknown.
   * `(string & {})` keeps the closed vocabulary as documentation/autocomplete while tolerating any
   * value (no validation gate yet — prospective-gate tranche). Invariant (writers): set alongside a
   * non-empty `rationale` in the same write; a rationale without a source is valid only for legacy rows.
   */
  rationale_source?: EdgeRationaleSource | (string & {});
  status: EdgeStatus;
  discovered_at: string;
  model: string;
  strength?: 'strong' | 'moderate' | 'weak';
  notes?: string;
  direction_flag?: 'ok' | 'suspect' | null;
}

export interface EdgeTypeDefinition {
  type: EdgeType;
  bidirectional: boolean;
  definition: string;
  llm_proposed?: boolean;
}

export interface EdgesFile {
  _schema_version: string;
  _doc: string;
  last_modified: string;
  edge_types: EdgeTypeDefinition[];
  edges: Edge[];
  discovery_log?: unknown[];
}
