// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { SpeakerId } from './phase.js';
import type { TopicScope } from './session.js';
import type { ConvergenceSignals } from './convergence.js';
import type { StageDiagnostics } from './pipeline.js';

// ── Diagnostics types ─────────────────────────────────

export interface EntryDiagnostics {
  prompt?: string;
  raw_response?: string;
  model?: string;
  response_time_ms?: number;
  taxonomy_context?: string;
  commitment_context?: string;
  extracted_claims?: {
    accepted: { text: string; id: string; overlap_pct: number }[];
    /**
     * `duplicate_of` / `duplicate_of_text` are set only when `reason === 'duplicate_claim'`:
     * the AN node id (e.g. `AN-12`) whose word-overlap triggered the rejection, and its text (t/1614).
     */
    rejected: { text: string; reason: string; overlap_pct: number; duplicate_of?: string; duplicate_of_text?: string }[];
  };
  /** Legacy claim-extraction capture — prompt, raw response, parse count, schemes. */
  claim_extraction?: {
    prompt: string;
    raw_response: string;
    response_time_ms: number;
    claims_parsed: number;
    schemes_classified: string[];
  };
  /** Full extraction-lifecycle trace — status, sizes, funnel, overlap distribution, AN delta. */
  extraction_trace?: ClaimExtractionTrace;
  edge_tensions?: string;
  argument_network_context?: string;
  selection_reasoning?: string;
  stage_diagnostics?: StageDiagnostics[];
  edges_used?: { source: string; target: string; type: string; confidence: number }[];
  convergence_signals?: ConvergenceSignals;
  evaluator_warning?: string;
  /** Lookahead gate diagnostics — move-quality evaluation between draft and commit (t/21). */
  lookahead?: import('../lookaheadGate.js').LookaheadDiagnostics;
  /** Tracks whether claim extraction has completed for this entry (t/226). */
  extraction_status?: 'pending' | 'complete' | 'failed';
  /** Total input tokens consumed across all stages in this entry. */
  input_tokens?: number;
  /** Total output tokens produced across all stages in this entry. */
  output_tokens?: number;
  /** Topic alignment diagnostics from draft quality gate (t/341). */
  topic_alignment?: {
    topic_aligned: boolean;
    repaired?: boolean;
    draft_attempt?: number;
    scope_used: TopicScope | null;
  };
  quality_gate?: {
    pre_repair: DraftQualityGateResult;
    post_repair?: DraftQualityGateResult;
    repair_outcome?: 'fixed' | 'partial' | 'unchanged';
  };
  entailment_repairs?: EntailmentRepairEvent[];
  extraction_coverage?: {
    total_elements: number;
    verifiable_elements: number;
    normative_elements: number;
    covered_verifiable: number;
    covered_normative: number;
    coverage_rate: number;
    uncovered_elements?: Array<{
      text: string;
      element_type: 'verifiable' | 'normative';
    }>;
  };
  scope_drift_warnings?: {
    debater: string;
    node_id: string;
    similarity: number;
    draft_excerpt: string;
  }[];
  scope_drift_check?: {
    checked: true;
    refs_checked: number;
    refs_with_exclusion_vector: number;
    warnings: { debater: string; node_id: string; similarity: number; draft_excerpt: string }[];
    threshold: number;
  };
  overgen?: import('../overgenPipeline.js').OvergenDiagnostics;
}

export interface DraftQualityGateResult {
  grounded: boolean;
  falsifiable: boolean;
  engages: boolean;
  topic_aligned: boolean;
  pass: boolean;
  weaknesses: string[];
}

export interface EntailmentRepairEvent {
  node_id: string;
  bdi_category: string;
  verdict: 'entailed' | 'partial' | 'not_entailed';
  explanation: string;
  original_text: string;
  repaired_text: string | null;
  overlap_pct: number;
}

/**
 * Per-turn trace for the claim-extraction pipeline. Used to diagnose
 * "AN nodes stop being registered" plateau failures.
 */
export interface ClaimExtractionTrace {
  entry_id: string;
  round: number;
  speaker: SpeakerId;

  /** Lifecycle outcome for the extraction call. */
  status:
    | 'ok'                // at least one claim accepted
    | 'no_new_nodes'      // extraction ran but zero accepted (all rejected or empty)
    | 'adapter_error'     // underlying AI call threw
    | 'parse_error'       // response received but JSON parse failed
    | 'empty_response'    // AI returned 0 candidates
    | 'truncated_response'// response body appears truncated
    | 'skipped';          // extraction intentionally bypassed
  error_message?: string;
  attempt_count: number;

  // Sizes — catches context-bloat failure mode
  prompt_chars: number;
  prompt_token_estimate: number;
  response_chars: number;
  response_truncated: boolean;
  model: string;
  response_time_ms: number;

  // Funnel
  candidates_proposed: number;
  candidates_accepted: number;
  candidates_rejected: number;
  rejection_reasons: Record<string, number>;

  // Overlap distribution — catches "AN saturated" failure mode
  rejected_overlap_pcts: number[];
  max_overlap_vs_existing: number;

  // Cumulative state
  an_node_count_before: number;
  an_node_count_after: number;
  an_nodes_added_ids: string[];

  // Drift signals
  prompt_hash: string;
  extraction_prompt_version: string;

  // Per-claim taxonomy attribution (t/110)
  attribution_attributed?: number;
  attribution_unattributed?: number;
  attribution_missing_embedding?: number;
  attribution_novel_argument?: number;
  attribution_decisions?: {
    claim_id: string;
    primary_ref: string | null;
    attribution_confidence: number;
    secondary_refs_count: number;
    unattributed_reason?: 'novel_argument' | 'no_embedding' | 'direction_mismatch';
  }[];

  exclusion_violations?: {
    claim_id: string;
    claim_text: string;
    node_id: string;
    similarity_main: number;
    similarity_exclusion: number;
  }[];
  exclusion_guard?: {
    checked: number;
    refs_with_exclusion_vector: number;
    violations: {
      claim_id: string;
      claim_text: string;
      node_id: string;
      similarity_main: number;
      similarity_exclusion: number;
    }[];
    threshold: number;
  };
}

/** Session-level aggregate of extraction health, computed incrementally. */
export interface ExtractionSummary {
  total_turns: number;
  total_proposed: number;
  total_accepted: number;
  total_rejected: number;
  acceptance_rate: number;
  /** Per-round AN node counts (cumulative). */
  an_growth_series: { round: number; cumulative_count: number }[];
  /** True if 2+ consecutive turns produced zero new AN nodes. */
  plateau_detected: boolean;
  /** Turn index where plateau first began (1-based). Absent if no plateau. */
  plateau_started_at_turn?: number;
  /** AN node ID of last successful addition before plateau (e.g. "AN-11"). */
  plateau_last_an_id?: string;
  /** Aggregate rejection reasons across the session. */
  rejection_reason_totals: Record<string, number>;
  /** Ratio of AN claims that could not be attributed to any taxonomy Belief node (0-1). >0.50 signals systemic issue. */
  unattributed_claim_ratio?: number;
}

export interface DebateOverviewDiagnostics {
  total_ai_calls: number;
  total_response_time_ms: number;
  claims_accepted: number;
  claims_rejected: number;
  move_type_counts: Record<string, number>;
  disagreement_type_counts: Record<string, number>;
  /** Total input tokens consumed across all entries in the debate. */
  total_input_tokens?: number;
  /** Total output tokens produced across all entries in the debate. */
  total_output_tokens?: number;
  /** Wall-clock elapsed time for the resume/run pipeline (ms). */
  total_elapsed_ms?: number;
  /** Situation citation tracking (t/192). Counts how many debate turns cited at least one sit- ID. */
  situation_citations?: {
    /** Number of debate turns that cited at least one sit- ID in taxonomy_refs. */
    turns_with_sit_refs: number;
    /** Total debate turns (excludes system/moderator entries). */
    total_debate_turns: number;
    /** Ratio of turns citing sit- IDs (0-1). */
    citation_rate: number;
    /** All unique sit- IDs cited across the debate. */
    unique_sit_ids_cited: string[];
  };
  /**
   * Feeds the t/4304 broken-injection detector. NO consumer branches on `lexical_turn_count`
   * or `embedding_turn_count` outside lib/debate — T0-exempt while that holds.
   */
  /** Number of debate turns that scored taxonomy nodes via lexical fallback. */
  lexical_turn_count?: number;
  /** Number of debate turns that scored taxonomy nodes via embedding similarity. */
  embedding_turn_count?: number;
}

export interface DebateDiagnostics {
  enabled: boolean;
  entries: Record<string, EntryDiagnostics>;
  overview: DebateOverviewDiagnostics;
}

// ── Context-rot instrumentation ─────────────────────────

/** Per-stage measurement of information entering and leaving a processing step. */
export interface ContextRotStage {
  stage: string;
  in_units: string;
  in_count: number;
  out_units: string;
  out_count: number;
  ratio: number;
  flags: Record<string, number | string>;
}

/** Aggregate context-rot metrics for a full pipeline run (summary or debate). */
export interface ContextRotMetrics {
  schema_version: 1;
  pipeline: 'summary' | 'debate';
  doc_id: string;
  measured_at: string;
  stages: ContextRotStage[];
  cumulative_retention: number;
}
