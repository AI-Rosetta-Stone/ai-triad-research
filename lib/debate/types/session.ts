// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { SpeakerId, PhaseState, PhaseBoundsOverride, AdaptiveStagingDiagnostics } from './phase.js';
import type {
  ConvergenceSignals,
  ProcessRewardEntry,
  ConvergenceTracker,
  TrackedCrux,
} from './convergence.js';
import type { TurnValidationTrail, QbafTimelineEntry, ClaimCoverageEntry } from './validation.js';
import type {
  DocumentAnalysis,
  ArgumentNetworkNode,
  ArgumentNetworkEdge,
  ANMutation,
  CommitmentStore,
} from './argumentNetwork.js';
import type { DebateDiagnostics, ExtractionSummary, ContextRotMetrics } from './diagnostics.js';
import type {
  UnansweredClaimEntry,
  DriftSnapshot,
  PerClaimDriftSnapshot,
  MissingArgument,
  TaxonomySuggestion,
  ModeratorState,
  InterventionMetadata,
  DialecticalDiagnosticRecord,
} from './moderator.js';
import type { PovKey } from './synthesis.js';
import type { CanonicalEdgeType, Category } from '../taxonomyTypes.js';
import type { DocMetaMap } from '../evidenceFromSummaries.js';

export type DialecticalScheme =
  | 'DISTINGUISH'         // Accept evidence, deny applicability to this context
  | 'COUNTEREXAMPLE'      // Concrete case challenging a general claim
  | 'CONCEDE-AND-PIVOT'   // Genuine concession + redirect to what it misses
  | 'REFRAME'             // Shift frame to reveal hidden structure (subsumes EXPOSE-ASSUMPTION)
  | 'EMPIRICAL CHALLENGE' // Dispute factual basis with counter-evidence (subsumes GROUND-CHECK)
  | 'EXTEND'              // Build on another's point with new substance (subsumes STEEL-BUILD)
  | 'UNDERCUT'            // Attack the warrant (reasoning link), not evidence or conclusion
  | 'SPECIFY'             // Force falsifiable predictions / name the crux (subsumes IDENTIFY-CRUX, NARROW)
  | 'INTEGRATE'           // Synthesize multiple perspectives into novel position (subsumes CONDITIONAL-AGREE)
  | 'BURDEN-SHIFT';       // Challenge who bears the burden of proof

/** Walton-derived argumentation scheme taxonomy for AI policy discourse (t/183). */
export type ArgumentationScheme =
  // Evidence-Based
  | 'ARGUMENT_FROM_EVIDENCE'
  | 'ARGUMENT_FROM_EXPERT_OPINION'
  | 'ARGUMENT_FROM_PRECEDENT'
  // Reasoning
  | 'ARGUMENT_FROM_CONSEQUENCES'
  | 'ARGUMENT_FROM_ANALOGY'
  | 'PRACTICAL_REASONING'
  | 'ARGUMENT_FROM_DEFINITION'
  // Value
  | 'ARGUMENT_FROM_VALUES'
  | 'ARGUMENT_FROM_FAIRNESS'
  // Meta-Argumentative
  | 'ARGUMENT_FROM_IGNORANCE'
  | 'SLIPPERY_SLOPE'
  | 'ARGUMENT_FROM_RISK'
  // Figurative
  | 'ARGUMENT_FROM_METAPHOR'
  | 'OTHER';

export interface TaxonomyRef {
  node_id: string;
  /** Human-readable node label. Populated by enrichTaxonomyRefs from the taxonomy. */
  label?: string;
  relevance: string;
  /** Cosine similarity score [0,1] from context injection. Absent in pre-scoring debates. */
  relevance_score?: number;
  /** True if this node was in the top-5 per BDI category (primary tier). */
  primary?: boolean;
}

export interface TranscriptEntry {
  id: string;
  timestamp: string;
  type:
    | 'clarification'
    | 'answer'
    | 'opening'
    | 'statement'
    | 'question'
    | 'concluding'
    | 'probing'
    | 'fact-check'
    | 'reflection'
    | 'system'
    | 'intervention';
  speaker: SpeakerId | 'system' | 'moderator';
  content: string;
  taxonomy_refs: TaxonomyRef[];
  /** Pre-CQ: bare string IDs. Post-CQ: objects with relevance. Check typeof. */
  policy_refs?: (string | { policy_id: string; relevance: string })[];
  metadata?: Record<string, unknown>;
  addressing?: SpeakerId | 'all';
  /** Cached AI-generated summaries at different detail tiers (DT-2). */
  summaries?: {
    brief: string;   // 2-3 sentences: core claim + strongest reasoning
    medium: string;  // 1-2 paragraphs: main argument + key evidence
  };
  /** Which detail tier to display by default. Absent = show full content. */
  display_tier?: 'claims' | 'brief' | 'medium' | 'detailed' | 'reasoning' | 'convergence' | 'terms' | 'lineage' | 'why';
  /** Present when type === 'intervention'. Metadata about the moderator move. */
  intervention_metadata?: InterventionMetadata;
  /** Unresolved judge weaknesses from the final retry attempt — substantive limitations
   *  of the argument that couldn't be fixed without changing the debater's position.
   *  Surfaced to readers as "Caveats" alongside the statement. */
  caveats?: string[];
  model?: string;
  /**
   * Provider's own model string from the response header, if reported (t/4195).
   * Distinct from `model` (registry id): use for forensic dating of silent provider
   * model swaps, not for routing or gating.
   * ADDITIVE-OPTIONAL — NO consumer may branch on this field until the exemption lapses
   * (the moment a consumer uses it for routing or gating logic, not logging/display).
   */
  provider_model?: string;
  /** True when this turn's brief or plan parse retries were exhausted and degraded gracefully (t/2229). */
  degraded?: boolean;
  /**
   * Opening-slot lifecycle (t/2907). Only `opening` entries use these — the slot is
   * inserted `status:'generating'` when generation begins and mutated in place through
   * retrying/error/done, so a retry updates one card instead of appending new panels.
   * Absent on every other entry type and on legacy openings (back-compat).
   */
  status?: 'generating' | 'retrying' | 'error' | 'done';
  /** User-facing message shown inline on the card in the 'retrying'/'error' states (t/2907). */
  errorMessage?: string;
}

/** One camp's story as voiced by the moderator before the openings (h3). */
export interface CampNarrative {
  speaker: Exclude<SpeakerId, 'user'>;
  fears_losing: string;
  history_carried: string;
  /** 3-4 sentences in the moderator's conditional first person ("If I were a Safetyist, …"). */
  narrative: string;
  /** The debater's own check of this account, taken from its opening DRAFT stage. */
  acknowledgment?: { verdict: 'affirm' | 'amend'; amendment?: string };
  /** all-MiniLM-L6-v2 embedding of the narrative plus any amendment. Set after openings. */
  embedding?: number[];
}

/** Moderator's opening narrative voicing (h3) and its use as a per-camp drift reference. */
export interface NarrativeVoicing {
  /** Transcript entry that displays the voicing (type 'system', speaker 'moderator'). */
  entry_id: string;
  model: string;
  narratives: CampNarrative[];
  /**
   * Mean paragraph cosine similarity of each debater turn to that debater's own camp
   * narrative, keyed by transcript entry id. Openings are the baseline; later turns show drift.
   */
  similarity_series?: Record<string, number>;
}

export type ModelTier = 'basic' | 'advanced';

export interface ContextSummary {
  up_to_entry_id: string;
  summary: string;
  tier?: 'recent' | 'medium' | 'distant';
}

export type DebateSourceType = 'topic' | 'document' | 'url' | 'situations' | 'other';

export type DebateAudience =
  | 'policymakers'
  | 'technical_researchers'
  | 'industry_leaders'
  | 'academic_community'
  | 'general_public';

export const DEBATE_AUDIENCES: { id: DebateAudience; label: string }[] = [
  { id: 'policymakers', label: 'Policymakers' },
  { id: 'technical_researchers', label: 'Technical Researchers' },
  { id: 'industry_leaders', label: 'Industry Leaders' },
  { id: 'academic_community', label: 'Academic Community' },
  { id: 'general_public', label: 'General Public' },
];

// ── Topic Scope (t/336) ─────────────────────────────────

export type TopicScopeRiskLevel = 'low' | 'medium' | 'high' | 'catastrophic' | 'unspecified';

export interface TopicScope {
  core_proposition: string;
  relevant_disciplines: string[];
  on_scope_evidence: string[];
  key_tensions: string[];
  off_scope_topics: string[];
  drift_signatures: string[];
  example_ceiling: string;

  risk_level: TopicScopeRiskLevel;
  domain: string;
  product_type: string | null;
  time_horizon: string | null;
  excluded_scenarios: string[];
  explicit_qualifiers: string[];

  constraint_confidence: 'explicit' | 'inferred';
}

// ── Mid-Debate Gap Injection ────────────────────────────
export interface GapArgument {
  argument: string;
  why_missing: string;
  gap_type: 'cross_cutting' | 'compromise' | 'blind_spot' | 'unstated_assumption';
  relevant_povs: string[];
  bdi_layer: 'belief' | 'desire' | 'intention';
}

export interface GapResponse {
  pover: string;
  entry_id: string;
  engaged: boolean;
  stance: 'compatible' | 'opposed' | 'partial' | 'reframed';
}

export interface GapInjection {
  round: number;
  arguments: GapArgument[];
  transcript_entry_id: string;
  responses: GapResponse[];
  trigger: 'scheduled' | 'responsive';
  focus_nodes?: string[];
}

// ── Cross-Cutting Node Promotion ────────────────────────
export interface CrossCuttingProposal {
  agreement_text: string;
  proposed_label: string;
  proposed_description: string;
  interpretations: {
    accelerationist: { belief: string; desire: string; intention: string; summary: string };
    safetyist: { belief: string; desire: string; intention: string; summary: string };
    skeptic: { belief: string; desire: string; intention: string; summary: string };
  };
  linked_nodes: string[];
  rationale: string;
  maps_to_existing?: string;
}

// ── Taxonomy Gap Analysis ───────────────────────────────
export interface PovCoverage {
  total_nodes: number;
  injected_nodes: number;
  referenced_nodes: number;
  utilization_rate: number;
  unreferenced_relevant: string[];
  never_injected: string[];
  category_breakdown: Record<string, { injected: number; referenced: number }>;
}

export interface BdiBalance {
  beliefs: { node_count: number; cited_count: number; argument_count: number };
  desires: { node_count: number; cited_count: number; argument_count: number };
  intentions: { node_count: number; cited_count: number; argument_count: number };
  weakest_category: string;
  recommendation: string;
}

export interface CrossPovGap {
  description: string;
  evidence_entries: string[];
  suggested_bdi: string;
  suggested_pov: string;
}

export interface UnmappedArgument {
  an_node_id: string;
  text: string;
  speaker: string;
  closest_taxonomy_node?: string;
  similarity?: number;
  gap_type: 'novel_argument' | 'cross_cutting' | 'refinement_needed';
}

export interface GapSummary {
  overall_coverage_pct: number;
  most_underserved_pov: string;
  most_underserved_bdi: string;
  unmapped_argument_count: number;
  cross_pov_gap_count: number;
  recommendation: string;
}

export interface TaxonomyGapAnalysis {
  pov_coverage: Record<string, PovCoverage>;
  cross_pov_gaps: CrossPovGap[];
  bdi_balance: Record<string, BdiBalance>;
  unmapped_arguments: UnmappedArgument[];
  summary: GapSummary;
}

/** How a seat's POV tag selects POV items (t/3955; spec §4). `scope` = only items carrying the tag
 *  (untagged items are excluded); `prioritize` = tagged items get a ranking boost. */
export type TagMode = 'scope' | 'prioritize';

/** One seat's POV tag. `tag_mode` is required whenever a tag is set: there is no default mode. */
export interface SeatTag {
  /** A tag id registered for this seat's POV in lib/debate/soul-docs/pov-tags.json. */
  pov_tag: string;
  tag_mode: TagMode;
}

/** Resolved tag selection passed into the selection pipeline (t/3957). Derived from `SeatTag`; the
 *  pipeline never reads `seat_tags` directly — callers derive this from `session.seat_tags[speaker]`. */
export type TagSelection = { tag: string; mode: TagMode };

export interface DebateSession {
  id: string;
  /** Execution run — regenerated each time the debate loop starts or resumes. */
  run_id?: string;
  title: string;
  created_at: string;
  updated_at: string;
  /** Monotonic optimistic-concurrency counter for delta saves (t/1634 / HLD delta-debate-save).
   *  Incremented in the document on every accepted save. A delta declares the
   *  `baseVersion` it was computed against; the server accepts it only if the stored
   *  `_saveVersion` matches. Absent = 0 (lazy migration; first save is always a full PUT). */
  _saveVersion?: number;
  /** App version that created this debate session. */
  app_version?: string;
  /** Target audience for tone, language, and concern prioritization. */
  audience?: DebateAudience;
  /** Moderator mode used for this session ('standard' | 'talmudic'). Optional for back-compat with pre-Talmudic sessions. */
  moderator_mode?: string;
  /** Talmudic corpus metadata stamped at session creation — present when moderatorMode is 'talmudic' and a corpus was loaded. */
  talmudic_references?:
    | { enabled: true; corpus_name: string; corpus_path: string; corpus_version: string }
    | { enabled: false };
  phase: 'setup' | 'clarification' | 'edit-claims' | 'opening' | 'debate' | 'closed' | 'cancelled';
  topic: {
    original: string;
    refined: string | null;
    final: string;
    /** Optional supporting context provided by the user — separate from the debate question. */
    background?: string;
    /** Decomposition of `final` into N atomic clauses. Set by runClarification.
     *  Used by the moderator prompt to keep interventions anchored to the
     *  resolution's specific clauses rather than drifting to abstractions. */
    clauses?: string[];
    /** Embedding of `final`. Computed once at debate setup and reused for
     *  per-turn ArCo (Argument Coherence) drift detection in
     *  computeConvergenceSignals. */
    embedding?: number[];
    /** Embeddings of `clauses`, parallel-indexed. Used for per-turn
     *  clause-coverage signal — which clause of the resolution each turn
     *  most closely engages with. */
    clause_embeddings?: number[][];
    /** Pre-debate topic quality critique (wisdom-generating scoring). Set once before clarification. */
    critique?: import('../topicCritique.js').TopicCritique;
    /** Post-refinement topic critique — scores the refined topic for old-vs-new comparison. */
    refined_critique?: import('../topicCritique.js').TopicCritique;
    /** Critique of the AI-suggested rewrite (for side-by-side comparison in the critique card). */
    suggested_critique?: import('../topicCritique.js').TopicCritique;
    /** Structured scope extracted from topic string for alignment enforcement (t/336). */
    scope?: TopicScope;
  };
  source_type: DebateSourceType;
  /** For document: file path; for url: the URL; for topic: empty */
  source_ref: string;
  /** For document/url: the loaded text content for prompt injection */
  source_content: string;
  active_povers: SpeakerId[];
  /** Persisted opening speaker order (shuffled at proceedToOpening). Survives app restarts. */
  opening_order?: Exclude<SpeakerId, 'user'>[];
  user_is_pover: boolean;
  transcript: TranscriptEntry[];
  context_summaries: ContextSummary[];
  /** Tracks which prompt generation produced this session. Absent in pre-migration debates. */
  generated_with_prompt_version?: string;
  /** Debate-specific AI model override. If set, used instead of the global model for this debate only. */
  debate_model?: string;
  /** Evaluator model for claim extraction/classification. Cross-vendor split recommended. */
  evaluator_model?: string;
  speaker_models?: Record<string, string>;
  /** Speaker model assignments captured at session init — never overwritten by failover (t/4040). Absent on pre-t/4040 sessions. */
  initial_speaker_models?: Record<string, string>;
  /** Per-speaker failover history: speaker → final replacement model (t/4040). Absent when no failover occurred. */
  speaker_model_failovers?: Record<string, string>;
  /** Multi-provider model pool fingerprint: `"tierName|b1=registryId1:apiModelId1,..."` sorted by backend (t/4040). Absent on single-model runs. */
  model_pool?: string;
  /** Single-model run fingerprint: `"registryId:apiModelId"` resolved at run time (t/4040). Absent on multi-provider runs. */
  model_api_id?: string;
  /** Whether failover tracking was available: 'tracked' = engine stamped (can observe failovers); 'unavailable' = renderer path (failover below bridge). Absent on pre-t/4040 and legacy rows. */
  failover_tracking?: 'tracked' | 'unavailable';
  /** Internal latch for computing failover_tracking. Only the debate store branches on it;
   *  the calibration gate reads failover_tracking, never this field (SO e/281#2 condition 3).
   *  Set to true the first time a speaker turn returns without servedModel, or on load for
   *  a session whose earlier speaker turns were never observed; never cleared.
   *  Exempt from the SO loop because only the debate store reads it. THE EXEMPTION LAPSES
   *  the moment any consumer other than the debate store reads this field. */
  failover_untracked?: boolean;
  /** Fully-resolved per-stage model map (9 keys: brief, plan, draft, cite, evaluator, scope, summary, moderator, crux). */
  stage_models?: Record<string, string>;
  model_tier?: ModelTier;
  /** Debate protocol format. Absent in older debates (defaults to 'structured'). */
  protocol_id?: string;
  /** Exclude greatest-hits (retread) nodes from selection for this debate (t/1438). Absent ⇒ false. */
  exclude_greatest_hits?: boolean;
  /** Per-seat POV tag (t/3955; spec §2.3). Absent, or no entry for a seat ⇒ that seat is untagged, so every
   *  existing saved debate loads unchanged. One map beside `active_povers` rather than parallel optionals. */
  seat_tags?: Partial<Record<SpeakerId, SeatTag>>;
  /** Soul file provenance at session start, keyed by SpeakerId string. Set for every active seat (tagged and base).
   *  Used by the pilot (t/3963) to compare old and new umbrella runs. Absent in pre-t/4007 saved debates (t/4007). */
  soul_provenance?: Partial<Record<string, import('../soulDocSchema.js').SoulProvenance>>;
  /** Moderator voices each camp's story before the openings (h3). Absent ⇒ false. */
  narrative_voicing_enabled?: boolean;
  /** Result of the h3 narrative voicing. Absent when disabled or when generation failed. */
  narrative_voicing?: NarrativeVoicing;
  /** Legacy config object from older saved debates. */
  config?: Record<string, unknown>;
  /** AI temperature for this debate (0.0-1.0). Absent uses system default. */
  debate_temperature?: number;
  /** Adaptive staging configuration. Absent means fixed-round mode. */
  adaptive_staging?: {
    enabled: boolean;
    pacing: 'tight' | 'moderate' | 'thorough';
    /** Step mode: user advances one round at a time and manually sets the debate phase. */
    step_mode?: boolean;
    /** Persisted phase state for GUI round-by-round execution. Initialized on first crossRespond. */
    phase_state?: PhaseState;
    phase_bounds_override?: PhaseBoundsOverride;
  };
  /** Diagnostic data captured when diagnostics mode is enabled. */
  diagnostics?: DebateDiagnostics;
  /** Incremental argument network built during debate */
  argument_network?: {
    nodes: ArgumentNetworkNode[];
    edges: ArgumentNetworkEdge[];
    mutations?: ANMutation[];
  };
  /** Per-debater commitment stores */
  commitments?: Record<string, CommitmentStore>;
  /** Convergence radar tracker — updated after each AN extraction */
  convergence_tracker?: ConvergenceTracker;
  /** Pre-analysis of source document — extracted i-nodes, tensions, and summary. Absent for topic-only debates. */
  document_analysis?: DocumentAnalysis;
  /** QBAF strength snapshots after each turn — for timeline visualization. Absent in pre-QBAF debates. */
  qbaf_timeline?: QbafTimelineEntry[];
  /** Coverage tracking — which source claims have been discussed. Absent for topic-only debates or pre-coverage debates. */
  claim_coverage?: ClaimCoverageEntry[];
  /** Persona-free neutral evaluations at up to 3 checkpoints. Absent in pre-evaluator debates. */
  neutral_evaluations?: import('../neutralEvaluator.js').NeutralEvaluation[];
  /** Speaker mapping used for neutral evaluator (randomized per debate). Absent in pre-evaluator debates. */
  neutral_speaker_mapping?: import('../neutralEvaluator.js').SpeakerMapping;
  /**
   * The model that produced this session's neutral evaluations (t/1846). Stamped when the
   * first neutral checkpoint runs; flows into CalibrationDataPoint.evaluator_model_id so the
   * optimizer can enforce same-evaluator-only comparison windows. Absent on pre-pin sessions,
   * whose evaluator was the debate's own model (evaluator-mixed by construction).
   */
  evaluator_model_id?: string;
  /** Unanswered claims ledger — persistent tracking across the 8-entry compression window. */
  unanswered_claims_ledger?: UnansweredClaimEntry[];
  /** Position drift snapshots per round — embedding similarity tracking for sycophancy detection. */
  position_drift?: DriftSnapshot[];
  /** Per-claim drift tracking — decomposed position drift with sycophancy scoring. */
  per_claim_drift?: PerClaimDriftSnapshot[];
  /** Missing arguments identified post-synthesis by a fresh LLM with no transcript context. */
  missing_arguments?: MissingArgument[];
  /** Post-debate taxonomy refinement suggestions with before/after descriptions. */
  taxonomy_suggestions?: TaxonomySuggestion[];
  /** Post-debate dialectic traces explaining why positions prevailed — argument chains from the AN graph. */
  dialectic_traces?: import('../dialecticTrace.js').DialecticTrace[];
  /** Session-level aggregate of claim-extraction health — computed incrementally after each extraction turn. */
  extraction_summary?: ExtractionSummary;
  /** Per-entry turn-validation trail. Keyed by transcript entry id. See docs/debate-turn-validation.md. */
  turn_validations?: Record<string, TurnValidationTrail>;
  /** Per-turn convergence diagnostic signals — computed after claim extraction. */
  convergence_signals?: ConvergenceSignals[];
  /** Per-turn process reward scores — continuous quality signal computed after convergence signals + turn validation. */
  process_rewards?: ProcessRewardEntry[];
  /** Per-turn drift telemetry shadow log (t/3603). Observations only — no behaviour change. */
  drift_telemetry?: DriftTelemetryEntry[];
  /** Cached turn embeddings for semantic recycling detection. Keyed by transcript entry id. */
  turn_embeddings?: Record<string, number[]>;
  /** Frame embeddings indexed by speaker, computed at opening finalization (t/2045). */
  frame_embeddings?: Record<string, {
    model: string;
    dim: number;
    frames: { frame: string; embedding: number[] }[];
  }>;
  /** Per-(frame,turn) raw cosine similarity series for frame survival metrics (t/2045).
   * Keyed by frame-owner speaker; sims span ALL speakers' statement entries. */
  frame_similarity_series?: Record<string, { frame: string; sims: Record<string, number> }[]>;
  /** Mid-debate gap injections — cross-cutting arguments surfaced by the "fourth voice" analyzer. */
  gap_injections?: GapInjection[];
  /** Cross-cutting node proposals — candidate situation nodes from areas of three-way agreement. */
  cross_cutting_proposals?: CrossCuttingProposal[];
  /** Post-debate taxonomy gap diagnostics — coverage analysis across POVs and BDI categories. */
  taxonomy_gap_analysis?: TaxonomyGapAnalysis;
  /** Post-debate situation ref extraction (t/193) — maps sit- IDs to debate references for write-back. */
  situation_debate_refs?: {
    refs: Record<string, import('../situationRefs.js').SituationDebateRef>;
    stats: {
      situations_checked: number;
      situations_matched: number;
      explicit_citations: number;
      semantic_matches: number;
      both: number;
    };
  };
  /** Context-rot metrics measured during this debate — tracks information loss at each pipeline stage. */
  context_rot?: ContextRotMetrics;
  /** Transient runtime metadata (e.g., opening embeddings for drift detection). Not persisted. */
  metadata?: Record<string, unknown>;
  /** Active moderator state — tracks budget, cooldown, burden, health trajectory, and intervention history. */
  moderator_state?: ModeratorState;
  /** Adaptive staging diagnostics — signal telemetry, phase transitions, GC events. Present when useAdaptiveStaging is enabled. */
  adaptive_staging_diagnostics?: AdaptiveStagingDiagnostics;
  /** Last QBAF computation result metadata (oscillation detection, iteration count). */
  last_qbaf_result?: { iterations: number; converged: boolean; oscillationDetected?: boolean; dampingLevel?: number };
  /** Peak damping level across all QBAF runs in this debate (0 = no oscillation ever triggered). */
  max_qbaf_damping_level?: number;
  /** Total QBAF runs in this debate (one per round). */
  qbaf_runs_total?: number;
  /** Number of QBAF runs where progressive damping activated (dampingLevel > 0). */
  qbaf_runs_oscillated?: number;
  /** Per-crux resolution tracking — state machine tracking crux lifecycle. Absent in pre-crux-resolution debates. */
  crux_tracker?: TrackedCrux[];
  /** How this debate was created: 'cli' (headless runner), 'gui' (Electron app), or absent (pre-origin debates). */
  origin?: {
    mode: 'cli' | 'gui';
    /** CLI-only: the command line and arguments used to launch the debate. */
    command?: string;
    /** CLI-only: the resolved config values. */
    config_summary?: Record<string, unknown>;
  };
  /** Perturbation testing result — present only for evaluation/benchmark debates with perturbation injection. */
  perturbation_result?: PerturbationResult;
  /** When true (default), individual WEAK-classified claims are filtered from passing lookahead batches before AN commit. */
  lookahead_filter_weak?: boolean;
  /** Decomposed topic structure — core proposition, structural premises, scope constraints. Set at Phase 0.75 for structured topics. */
  topic_structure?: import('../topicStructure.js').TopicStructure;
  /** Exploration summary extracted from a prior exploration-protocol debate. Used to seed production debates. */
  exploration_summary?: import('../explorationSummary.js').ExplorationSummary;
  /** ID of the exploration debate that seeded this production debate. */
  exploration_source_id?: string;
  /** Persisted when a window closes mid-generation. Cleared on next load after surfacing a notification. */
  interrupted_turn?: {
    speaker: string;
    phase: string;
    round: number;
    timestamp: string;
  };
  /** Round at which a diversity-injection round fired (max 1 per debate). Absent if never triggered. */
  diversity_round_fired?: number;
  /** Per-situation component scores from mid-debate re-scoring (last-write-wins across rounds). Populated when adaptive staging re-scores situations. Only includes scored situation nodes. */
  situation_score_map?: Record<string, import('../situationScoring.js').SituationScoreComponents>;
  /** Crux-to-situation promotion candidates with BDI-enriched drafts (populated post-debate). */
  promotion_candidates?: Array<{
    crux_id: string;
    draft: import('../cruxTaxonomyFeedback.js').DraftSituationNode;
    irreducible_count: number;
  }>;
  /** Human-gated taxonomy evolution proposals from post-debate reflection (machine proposes, human disposes). */
  reflection_proposals?: ReflectionProposal[];
  /** Per-round Talmudic dialectical diagnostics — populated when moderatorMode is 'talmudic'. */
  dialectical_diagnostics?: DialecticalDiagnosticRecord[];
  /**
   * Provenance carrier for source-authority scoring (t/1769). Maps source-id →
   * { title, resolved_url?, provenance_label? }. Stamped at debate-run / save time
   * so credibility (venue tier) and recency calibration signals resolve on every
   * write path — not just the in-process engine path that has FS-derived doc titles.
   * Optional / back-compat: absent in pre-t/1769 debates, in which case calibration
   * falls back to config-supplied docMeta (or leaves source_authority null).
   */
  doc_meta?: DocMetaMap;
}

// ── Drift telemetry entry (t/3603) ──────────────────────────

/**
 * One per completed debater turn. Observations only — all fields are direct reads,
 * no new computation. Provenance: t/3603#2 (CL-reviewed).
 */
export interface DriftTelemetryEntry {
  round: number;
  speaker: string;
  /**
   * Fixed-rule action taken on this turn's draft.
   * 'accepted'          — draft passed quality gate on first try (no repair path taken).
   * 'repair_fixed'      — repair triggered, post-repair gate passed fully.
   * 'repair_partial'    — repair triggered, post-repair gate improved but not fully fixed.
   * 'repair_unchanged'  — repair triggered, no gate improvement.
   * 'no_gate'           — quality gate was not run (skipped or stage not reached).
   * Source: runTurn.ts qualityGateResult.repair_outcome.
   */
  quality_action: 'accepted' | 'repair_fixed' | 'repair_partial' | 'repair_unchanged' | 'no_gate';
  /**
   * Whether the draft passed the topic alignment check. Null when no TopicScope was extracted.
   * Source: runTurn.ts topicAlignmentResult.topic_aligned.
   */
  topic_aligned: boolean | null;
  /**
   * Whether the alignment-repair path was triggered for this turn.
   * Source: runTurn.ts topicAlignmentResult.repaired.
   */
  alignment_repair_triggered: boolean;
  /**
   * Whether this turn engaged a tracked crux. Null when no convergence signal is available.
   * Source: session.convergence_signals[-1].crux_engagement_rate.used_this_turn (convergenceSignals.ts:254).
   * Observation (direct read) — no new computation.
   */
  crux_engaged: boolean | null;
  /**
   * Total tokens consumed across all pipeline stages for this turn (sum of inputTokens +
   * outputTokens per stage). Null only when ZERO stages reported usage — a silently partial
   * sum is never emitted as complete (see t/3603#2 q5). Source: stage_diagnostics per-stage
   * usage fields (ProviderResult.usage.inputTokens + outputTokens).
   */
  tokens_total: number | null;
  /** Wall-clock latency for the full turn pipeline (ms). Source: runTurn.ts total_time_ms. */
  latency_ms_total: number;
  /**
   * Topical state estimate from CL's t/3630 estimator. Null until that estimator ships.
   * Vocabulary confirmed at t/3603#2: 'core' = on topic, 'adjacent' = related but drifting,
   * 'drifted' = off-topic. CL owns this field's population via t/3630.
   */
  topical_state: 'core' | 'adjacent' | 'drifted' | null;
  /**
   * Continuous (threshold-free) topical drift score from CL's t/3630 estimator.
   * Null until that estimator ships. Lets shadow logging start before t/3630 tunes bands.
   * Added per CL review t/3603#2 q4.
   */
  topical_drift_score: number | null;
}

// ── Delta / incremental debate save (t/1470; HLD docs/hld-delta-debate-save.md) ──
//
// Interface-First contract shipped by DebateTool (ticket A) so Server Storage (B),
// ServerAPI (C), and Taxonomy Editor (D) build against one frozen shape in parallel.
// The merge function is `applyDebateDelta` in ./applyDebateDelta.ts.

/** Metadata surface a delta may shallow-merge onto the session root. */
export type DebateSessionMeta = Pick<DebateSession, 'title' | 'updated_at' | 'phase'>;

/**
 * Incremental save payload: only what changed since the client's last successful
 * save, plus the `_saveVersion` it was computed against (`baseVersion`). Web-only —
 * the Electron local path stays full-save (no upload leg to optimize).
 *
 * Merge order is load-bearing (see `applyDebateDelta`): `changedFields` is a generic
 * shallow-overlay for per-turn analytics fields that have no dedicated structured
 * surface; the structured surfaces below (transcript / nodes / edges / mutations /
 * meta / `_saveVersion`) are applied AFTER and therefore always win over the overlay.
 * Any `_saveVersion` inside `changedFields` is ignored — the version is authoritative
 * from the guard + increment, never client-supplied.
 */
export interface DebateDelta {
  debateId: string;
  /** The `_saveVersion` this delta was computed against; server accepts only on exact match. */
  baseVersion: number;
  /** Appended to `transcript` (append-only tail beyond base). */
  newTranscriptEntries: TranscriptEntry[];
  /** Upserted by id into `argument_network.nodes` (last-wins). */
  changedNodes: ArgumentNetworkNode[];
  /** Upserted by id into `argument_network.edges` (last-wins). */
  changedEdges: ArgumentNetworkEdge[];
  /** Node ids to drop from `argument_network.nodes`; removal wins over a same-id upsert. */
  removedNodeIds?: string[];
  /** Edge ids to drop from `argument_network.edges`; removal wins over a same-id upsert. */
  removedEdgeIds?: string[];
  /** Appended to `argument_network.mutations`. */
  newMutations: ANMutation[];
  /** Shallow-merged onto the session root. */
  meta?: Partial<DebateSessionMeta>;
  /**
   * Generic shallow-overlay for per-turn analytics fields carried by none of the
   * structured surfaces (`convergence_tracker`, `qbaf_timeline`, `position_drift`,
   * etc. — t/1634#3 Case 3). Applied FIRST; structured surfaces override.
   * `_saveVersion` within it is ignored. Note: `turn_embeddings` no longer rides
   * here — it has a dedicated append-by-key surface (`newTurnEmbeddings`) below.
   */
  changedFields?: Partial<DebateSession>;
  /**
   * Append/upsert-by-key onto `turn_embeddings` — new keys only (transcript-entry
   * id → 384-dim vector). Merged AFTER the `changedFields` overlay so it wins over
   * any whole-map an old client sent through it. A key removal is unrepresentable
   * here, so the client full-PUTs instead.
   */
  newTurnEmbeddings?: Record<string, number[]>;
}

// ── Reflection proposals (human-gated taxonomy evolution) ──

export type WeightChangeSource =
  | 'confidence_evolution'
  | 'priority_evolution'
  | 'operationality_evolution'
  | 'crux_weight_adjustment';

export type ReflectionProposalSource =
  | WeightChangeSource
  | 'situation_interpretation'
  | 'reflection_new_item';

interface ReflectionProposalBase {
  source: ReflectionProposalSource;
  node_id: string;
  reason: string;
  debate_id: string;
  requires_human_review: boolean;
  gate?: Record<string, unknown>;
}

export interface WeightChangeProposal extends ReflectionProposalBase {
  /** Discriminant (t/1772): modifies an existing node's weight. */
  kind: 'edit_existing';
  source: WeightChangeSource;
  field: 'confidence' | 'priority' | 'operationality';
  delta: number;
  new_value: number;
  floor_violation: { floor: number; raw_value: number } | null;
}

export interface InterpretationRevisionProposal extends ReflectionProposalBase {
  /** Discriminant (t/1772): revises an existing situation node's interpretation. */
  kind: 'edit_existing';
  source: 'situation_interpretation';
  camp: 'accelerationist' | 'safetyist' | 'skeptic';
  current_interpretation: string;
  attacking_claims: Array<{
    claim_id: string;
    speaker: string;
    strength: number;
  }>;
  post_approval_action: 'regenerate_debate_register';
}

/**
 * A single edge a `propose_new` reflection proposal wants to create between the
 * new POV item and an EXISTING persisted taxonomy node (t/1772).
 */
export interface ProposedReflectionEdge {
  /** An existing persisted taxonomy node id: a pov node, or a situation node (sit- or
   *  cc- prefix). Never an ephemeral AN claim id (AN-) or a crux-registry id — those
   *  are rejected at validation. */
  target_node_id: string;
  /** One of the 8 canonical edge types. */
  edge_type: CanonicalEdgeType;
  /** Whether the newly proposed node is the `source` or `target` endpoint of this edge. */
  new_node_role: 'source' | 'target';
  rationale: string;
  confidence?: number;
}

/**
 * Proposal to create a NEW POV taxonomy item (t/1772). Leaves all existing nodes
 * untouched — the `propose_new` half of the unified reflection proposal. Because
 * the node does not yet exist, `node_id` (from the base) is the empty string until
 * a persisted id is minted on human approval.
 */
export interface NewPovItemProposal extends ReflectionProposalBase {
  /** Discriminant (t/1772): creates a new node instead of editing an existing one. */
  kind: 'propose_new';
  source: 'reflection_new_item';
  pov: PovKey;
  category: Category;
  label: string;
  description: string;
  interpretations?: string[];
  rationale: string;
  proposed_edges: ProposedReflectionEdge[];
}

export type ReflectionProposal =
  | WeightChangeProposal
  | InterpretationRevisionProposal
  | NewPovItemProposal;

// ── Perturbation testing (HDE Section B2) ───────────────

/** Configuration for adversarial perturbation injection during evaluation debates. */
export interface PerturbationConfig {
  /** Round at which to inject the adversarial prompt (1-indexed). */
  inject_at_turn: number;
  /** The adversarial prompt text to inject. */
  prompt: string;
  /** Number of turns after injection to measure recovery over. Default: 3. */
  measure_recovery_window?: number;
}

/** Result of perturbation testing — SysAR (System Argumentation Resilience). */
export interface PerturbationResult {
  /** The injected perturbation prompt. */
  prompt: string;
  /** Round at which perturbation was injected. */
  injected_at_round: number;
  /** Transcript entry ID of the perturbation injection. */
  injection_entry_id: string;
  /** Mean ArCo over the window before injection (baseline). */
  pre_arco: number;
  /** Mean ArCo over the recovery window after injection. */
  post_arco: number;
  /** SysAR = post_arco / pre_arco. Values near 1.0 indicate full recovery. */
  sysar: number;
  /** Number of turns in the recovery window. */
  recovery_window: number;
  /** Whether the system showed resilience (SysAR >= 0.8). */
  resilient: boolean;
}
