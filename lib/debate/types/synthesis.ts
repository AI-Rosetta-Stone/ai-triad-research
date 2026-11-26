// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { SpeakerId } from './phase.js';
import type { DialecticalScheme, DebateSession } from './session.js';
import type { ClaimCoverageEntry } from './validation.js';
import type { CruxResolutionState } from './convergence.js';
// FactVerdict lives in the zero-dependency './factVerdict.js' module (shared with
// argumentNetwork.ts, cycle-free); it is surfaced at the top level via the './types.js' barrel.
import type { FactVerdict } from './factVerdict.js';

export interface DebateSessionSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  phase: DebateSession['phase'];
  /** The effective topic text (topic.final ?? topic.original) for search/display. */
  topic_text?: string;
  /** AI model used for this debate (debate_model field). */
  model?: string;
  /** Number of statement/opening turns in the transcript. */
  turn_count?: number;
}

/**
 * Evidence-gated discrepancy qualifier (t/1701#1). Orthogonal to the verdict axis:
 * populated for `partially_accurate` (the core claim's direction holds but a detail is off),
 * optional-diagnostic on `disputed`/`false`. The anti-escape-hatch validator REQUIRES
 * `claimed` + `actual` + `source` (all non-empty) whenever the verdict is `partially_accurate`.
 */
export interface FactDiscrepancy {
  /**
   * Which axis of the detail is off:
   * `magnitude` (off-by-N count/percentage) | `temporal` (stale/wrong date) |
   * `attribution` (right fact, wrong actor/source) | `scope` (over/under-generalized) |
   * `existence` (phenomenon real, a specific instance wrong).
   */
  dimension: 'magnitude' | 'temporal' | 'attribution' | 'scope' | 'existence';
  /** What the speaker asserted (verbatim figure/detail). */
  claimed: string;
  /** What the evidence shows. */
  actual: string;
  /** The source that establishes `actual` — a node_id / conflict_id / url ref. */
  source: string;
  /** `minor` (does not change the claim's force) | `major` (materially weakens it, though direction holds). */
  severity: 'minor' | 'major';
}

export interface FactCheckResult {
  verdict: FactVerdict;
  explanation: string;
  sources: { node_id?: string; conflict_id?: string }[];
  checked_text: string;
  /** Populated (and required) when verdict === 'partially_accurate'; diagnostic otherwise. */
  discrepancy?: FactDiscrepancy;
  /** Pithy finding (t/763): one sentence, at most ~25 words, opening with the plain verdict word
   *  for the (resolved) verdict. Optional: absent on older fact checks and whenever malformed. */
  finding?: string;
  /** 1-3 supporting points, each at most ~25 words, sources named by title/publisher/author (t/763).
   *  Present only together with `finding`. */
  finding_points?: string[];
  /** Optional caveat, at most ~25 words, only for a real limitation (t/763). */
  limit?: string;
}

/** AIF attack on a claim — added in dolce-phase-3. */
export interface ArgumentAttack {
  claim_id: string;
  claim: string;
  claimant: SpeakerId | string;
  attack_type: 'rebut' | 'undercut' | 'undermine';
  scheme?: DialecticalScheme;
}

/** AIF support link (S-node) with warrant and critical questions. */
export interface SupportLink {
  claim_id: string;
  scheme?: DialecticalScheme;
  warrant?: string;
  critical_questions?: { question: string; addressed: boolean }[];
}

/** AIF claim node — added in dolce-phase-3. */
export interface ArgumentClaim {
  claim_id: string;
  claim: string;
  claimant: SpeakerId | string;
  type?: 'empirical' | 'normative' | 'definitional';
  /** Pre-P4: string[]. Post-P4: SupportLink[]. Check typeof [0]. */
  supported_by?: (string | SupportLink)[];
  attacked_by?: ArgumentAttack[];
}

export interface SynthesisResult {
  areas_of_agreement: { point: string; povers: SpeakerId[] }[];
  areas_of_disagreement: {
    point: string;
    positions: { pover: SpeakerId; stance: string }[];
    /** BDI layer classification — added in dolce-phase-1. Absent in older debates. */
    bdi_layer?: 'belief' | 'desire' | 'intention';
    /** How this disagreement could be resolved — added in dolce-phase-1. Absent in older debates. */
    resolvability?: 'resolvable_by_evidence' | 'negotiable_via_tradeoffs' | 'requires_term_clarification';
  }[];
  unresolved_questions: string[];
  taxonomy_coverage: { node_id: string; how_used: string }[];
  /** AIF argument map — added in dolce-phase-3. Absent in older debates. */
  argument_map?: ArgumentClaim[];
  /** Preference resolution — which arguments prevail and why. Absent in older debates. */
  preferences?: PreferenceEntry[];
  /** Policy implications — how disagreements affect concrete policy actions. */
  policy_implications?: PolicyImplication[];
  /** Coverage tracking — which source claims were discussed vs uncovered (CT-1). */
  claim_coverage?: ClaimCoverageEntry[];
  /** Cruxes — key questions whose answers would change a debater's position. Extracted by Phase 1 synthesis. */
  cruxes?: SynthesisCrux[];
}

export interface SynthesisCrux {
  question: string;
  if_yes?: string;
  if_no?: string;
  type?: 'EMPIRICAL' | 'VALUES' | 'DEFINITIONAL';
  /** Counterfactual reasoning type (RATIO 2024): interventional (Pearl do-calculus), backtracking (Lewis), or normative (value/rule change). */
  counterfactual_type?: 'interventional' | 'backtracking' | 'normative' | 'none';
  /**
   * Convergence-layer crux verdict (t/1676). `undecided` = the debate terminated without
   * establishing whether the crux is resolvable (never surfaced, or cap reached before
   * sufficient evidence). Distinct from the preference-layer `undecidable`
   * (PreferenceEntry.prevails) which means two claims' strength cannot be ordered — do not conflate.
   */
  resolution_status?: 'resolved' | 'irreducible' | 'active' | 'undecided';
  resolution_evidence?: string;
  /** Which debaters are involved in this crux. */
  speakers?: SpeakerId[];
}

// ── Cross-debate crux aggregation types ──────────────

/** A single debate's contribution to an aggregated crux. */
export interface CruxSource {
  debate_id: string;
  debate_topic: string;
  /** AN node ID within that debate's crux tracker. */
  crux_tracker_id: string;
  identified_turn: number;
  final_state: CruxResolutionState;
}

/** Aggregated crux across multiple debates. */
export interface AggregatedCrux {
  /** Stable ID, e.g. "crux-001". */
  id: string;
  /** Canonical phrasing (best statement across source debates). */
  statement: string;
  type: 'empirical' | 'values' | 'definitional';
  /** Backpointers to individual debate cruxes. */
  sources: CruxSource[];
  /** Taxonomy node IDs involved. */
  linked_node_ids: string[];
  /** Conflict pair IDs if applicable. */
  linked_conflict_ids?: string[];
  /** How many debates surfaced this crux. */
  frequency: number;
  resolution_summary: {
    resolved: number;
    active: number;
    irreducible: number;
    /**
     * Cruxes that terminated undecided — never surfaced or cap-reached before sufficiency (t/1676).
     * Optional for back-compat: aggregation artifacts written before this field existed omit it;
     * read as `?? 0`. Not folded into `active` (TL cond 2).
     */
    undecided?: number;
  };
}

export interface PreferenceEntry {
  conflict: string;
  claim_ids?: string[];
  prevails: string;
  criterion: string;
  rationale: string;
  what_would_change_this?: string;
}

export interface PolicyImplication {
  disagreement: string;
  policy_refs: string[];
  positions: { pover: string; stance: string }[];
  implication: string;
}

/** POVer display metadata */
/** Voice specification for a debate character — how they argue, not what they conclude. */
export interface VoiceSpec {
  disposition: string;
  style: string;
  reasoning: string;
  evidence: string;
  signature: string;
  prose_style: string;
  voice_hygiene: string;
  prose_style_short: string;
  voice_hygiene_short: string;
}

export interface PovBoundaries {
  hardcoded: string[];
  softcoded: string[];
}

export interface PovInfo {
  label: string;
  pov: string;
  color: string;
  personality: string;
  voice: VoiceSpec;
  anti_patterns: string[];
  boundaries: PovBoundaries;
  value_hierarchy: string[];
  epistemic_stance: string[];
  doctrinal_boundaries?: string[];
}

export { POVER_INFO } from '../poverInfo.js';

/** The three AI debater IDs (excludes 'user'). Single source of truth — use instead of literal arrays. */
export const AI_POVERS = ['accelerationist', 'safetyist', 'skeptic'] as const satisfies readonly Exclude<SpeakerId, 'user'>[];

/** The three taxonomy POV keys. Single source of truth — use instead of literal arrays. */
export const POV_KEYS = ['accelerationist', 'safetyist', 'skeptic'] as const;

/** Taxonomy POV key type derived from the canonical array. */
export type PovKey = typeof POV_KEYS[number];
