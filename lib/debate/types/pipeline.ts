// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { TaxonomyRef } from './session.js';
import type { DraftQualityGateResult } from './diagnostics.js';

// ── Turn pipeline types ──────────────────────────────

export type TurnStageId = 'brief' | 'plan' | 'draft' | 'postDraft' | 'draft_quality' | 'evidence' | 'cite' | 'micro-fix' | 'repair';

export interface TurnStageConfig {
  brief_temperature?: number;
  plan_temperature?: number;
  draft_temperature?: number;
  cite_temperature?: number;
}

export interface StageDiagnostics {
  [key: string]: unknown;
  stage: TurnStageId;
  prompt: string;
  raw_response: string;
  model: string;
  temperature: number;
  response_time_ms: number;
  work_product: Record<string, unknown>;
  parse_error?: string;
  /** When true, this stage was frozen from a prior pipeline run (not re-generated). */
  frozen?: boolean;
  /** What triggered this stage run: initial generation, per-stage retry, or orchestration rerun. */
  retry_trigger?: 'initial' | 'stage-retry' | 'orchestration-rerun';
  /** Repair hints that were active when this stage ran (only set when hints exist). */
  repair_hints_in?: string[];
  /** True when per-stage validation failed and triggered a retry. Enables easy FR event emission by callers. */
  validation_failed?: boolean;
  /** Validation error hints that caused the retry. Only set when validation_failed is true. */
  validation_errors?: string[];
  /** Per-component char counts for prompt growth forensics (t/221). */
  prompt_component_chars?: PromptComponentChars;
  /** Input tokens consumed by this stage's API call (from CacheUsage). */
  input_tokens?: number;
  /** Output tokens produced by this stage's API call (from CacheUsage). */
  output_tokens?: number;
  /** True when this stage's parse retries were exhausted and the turn was degraded gracefully (t/2229). */
  degraded?: true;
}

/** Per-component char counts for prompt growth forensics (t/221). */
export interface PromptComponentChars {
  taxonomy_chars: number;
  transcript_chars: number;
  hints_chars: number;
  edge_chars: number;
  commitment_chars: number;
  an_summary_chars: number;
}

/** Provenance metadata stamped on work products after LLM parsing.
 *  Added by pipeline code (not LLM-generated), stripped before downstream prompt injection. */
export interface StageProvenance {
  pipeline_run: number;
  stage: TurnStageId;
  attempt: number;
  model: string;
  timestamp: string;
}

/** Grounding node linking a claim/angle to a taxonomy node. */
export interface GroundingRef {
  node_id: string;
  label?: string;
  why: string;
  /** Belief confidence (0.0–1.0). Present for Belief grounding nodes. */
  confidence?: number;
  /** Desire priority (1–5). Present for Desire grounding nodes. */
  priority?: number;
  /** Intention operationality (1–5). Present for Intention grounding nodes. */
  operationality?: number;
}

export interface BriefWorkProduct {
  situation_assessment: string;
  key_claims_to_address: { claim: string; speaker: string; an_id?: string; grounding?: GroundingRef[] }[];
  relevant_commitments: { speaker: string; commitment: string; type: string }[];
  edge_tensions: { edge: string; relevance: string }[];
  phase_considerations: string;
}

export interface PlanWorkProduct {
  strategic_goal: string;
  planned_moves: { move: string; target?: string; detail: string }[];
  target_claims: string[];
  argument_sketch: string;
  anticipated_responses: string[];
  target_nodes?: string[];
  /** When a moderator directive preceded this turn, how the debater plans to address it. */
  directive_response?: { directive: string; how_addressed: string };
}

export interface TurnSymbol {
  symbol: string;
  tooltip: string;
}

export interface DraftWorkProduct {
  [key: string]: unknown;
  statement: string;
  turn_symbols: TurnSymbol[];
  claim_sketches: { claim: string; targets: string[]; steelman_of?: string }[];
  /** Non-first-speaker openings: one entry per prior speaker, strongest version in their own terms. */
  prior_steelmans?: { speaker: string; steelman_claim: string }[];
  key_assumptions: { assumption: string; if_wrong: string }[];
  disagreement_type: string;
  position_update?: string;
  pin_response?: Record<string, unknown>;
  probe_response?: Record<string, unknown>;
  challenge_response?: Record<string, unknown>;
  clarification?: Record<string, unknown>;
  check_response?: Record<string, unknown>;
  revoice_response?: Record<string, unknown>;
  reflection?: Record<string, unknown>;
  compressed_thesis?: string;
  commitment?: Record<string, unknown>;
}

export interface CiteWorkProduct {
  taxonomy_refs: TaxonomyRef[];
  policy_refs: string[];
  move_annotations: { move: string; target?: string; detail: string }[];
  grounding_confidence: number;
}

export interface EditingMeta {
  edited: boolean;
  fk_before: number;
  fk_after: number;
  checks_failed_after: boolean;
  edit_notes?: string;
}

export interface TurnPipelineResult {
  brief: BriefWorkProduct;
  plan: PlanWorkProduct;
  draft: DraftWorkProduct;
  cite: CiteWorkProduct;
  /** Evidence block injected into the DRAFT prompt. Returned so orchestration can freeze it on retry. */
  evidenceBlock?: string;
  /** Doc IDs from evidence that were supplied but not cited — penalised next turn. */
  ignoredEvidenceDocIds?: string[];
  stage_diagnostics: StageDiagnostics[];
  total_time_ms: number;
  editing_meta?: EditingMeta;
  /** Topic alignment result from draft quality gate (t/341). */
  topicAlignmentResult?: {
    topic_aligned: boolean;
    repaired: boolean;
    draft_attempt?: number;
  };
  qualityGateResult?: {
    pre_repair: DraftQualityGateResult;
    post_repair?: DraftQualityGateResult;
    repair_outcome?: 'fixed' | 'partial' | 'unchanged';
  };
  final_text?: string;
  /** True when brief or plan parse retries were exhausted and the turn degraded gracefully (t/2229). */
  degraded_turn?: boolean;
}

// ── Opening pipeline types ───────────────────────────

export interface OpeningBriefWorkProduct {
  situation_assessment: string;
  strongest_angles: { angle: string; why: string; grounding?: GroundingRef[] }[];
  key_tensions: { tension: string; opportunity: string }[];
  document_claims_to_engage?: { d_id: string; claim: string; stance: string; why: string; grounding?: GroundingRef[] }[];
  prior_positions_to_address?: { speaker: string; position: string; response_strategy: string }[];
}

export interface OpeningPlanWorkProduct {
  strategic_goal: string;
  core_thesis: string;
  argument_structure: { point: string; evidence: string; taxonomy_anchor: string }[];
  framing_choices: { frame: string; why: string }[];
  anticipated_challenges: string[];
  target_nodes?: string[];
  /** t/388: the steelman AN ids offered to this plan. ATTACK [id] tags use only these. */
  steelman_refs_offered?: string[];
}

export interface OpeningCiteWorkProduct {
  taxonomy_refs: TaxonomyRef[];
  policy_refs: string[];
  grounding_confidence: number;
}

export interface OpeningPipelineResult {
  brief: OpeningBriefWorkProduct;
  plan: OpeningPlanWorkProduct;
  draft: DraftWorkProduct;
  cite: OpeningCiteWorkProduct;
  stage_diagnostics: StageDiagnostics[];
  total_time_ms: number;
  topicAlignmentResult?: {
    topic_aligned: boolean;
    repaired: boolean;
    draft_attempt?: number;
  };
  qualityGateResult?: {
    pre_repair: DraftQualityGateResult;
    post_repair?: DraftQualityGateResult;
    repair_outcome?: 'fixed' | 'partial' | 'unchanged';
  };
  editing_meta?: EditingMeta;
}
