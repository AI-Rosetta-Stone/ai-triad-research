// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Calibration data point schema (ADR-007 file-size split, t/1686).
 *
 * The `CalibrationDataPoint` interface — the shape of one row appended to
 * calibration-log.jsonl — plus the browser-safe `AgentUtility` type re-export
 * for backward compatibility. Consumed by every calibrationLogger sub-module.
 */

import type { AgentUtility } from '../agentUtility.js';
export type { AgentUtility } from '../agentUtility.js';
import type { CruxMatchStats } from './extract-metrics.js';
export type { CruxMatchStats } from './extract-metrics.js';
import type { AffectProfile } from '../affectSignals.js';

// ── Calibration data point schema ──────────────────────────

export interface CalibrationDataPoint {
  /** Schema version for forward compat */
  schema_version: 1;
  /** Unique debate ID */
  debate_id: string;
  /** When the data point was recorded */
  timestamp: string;
  /** Where the debate ran — 'local' for Electron, userId or 'azure' for web */
  origin: string;
  /** Model used */
  model: string;
  /** Total rounds completed */
  rounds: number;
  /**
   * Synthetic-run marker (t/1770). `true` for fixture/smoke/batch runs produced by
   * the test harness (Invoke-DebateBatch, Test-AnonymousDebateFlow,
   * Invoke-TaxEditorSmokeTest, Test-PersonaEndpoints — wired in t/1812). Synthetic
   * entries are ROUTED to calibration/fixtures/ and never reach calibration/core/
   * (the optimizer + t/1668 replication-gate source of truth), so the production log
   * stays clean by *construction* — no consumer needs a `!synthetic` filter.
   *
   * Populated either explicitly on the data point OR from the
   * AI_TRIAD_SYNTHETIC_CALIBRATION env var read at the write funnel (appendCalibrationLog).
   * Additive/back-compat: absent on real debates and on all pre-t/1770 entries (those
   * ~14k fixtures are quarantined by CL's rounds-based backfill, not by this field).
   */
  synthetic?: boolean;

  // ── Preregistration-by-artifact provenance (t/1672) ──
  // Binds the instrument revision that produced this entry so a metric shift can
  // be attributed to prompt-vs-parameter-vs-model drift rather than left ambiguous.
  // Schema-only addition — no metric VALUES change (arXiv:2607.14399 §5 R-5).
  /** Prompt-builder revision active when this entry was produced (prompts.ts PROMPT_VERSION) */
  prompt_version: string;
  /** Config revision — content hash of calibration-config.json; '' if unreadable */
  config_revision: string;
  /** Git working-tree state when the run executed; 'unknown' when git is unavailable (e.g. server/Azure) */
  working_tree_state: 'clean' | 'dirty' | 'unknown';
  /**
   * Hash of declared behaviour-bearing source files, generated at build time (t/4166).
   * First 12 hex chars of SHA-256 over normalized (comments+whitespace stripped) content
   * of all files in behaviourRevisionFiles.ts, sorted by path. Changes when behaviour
   * changes; immune to comment or whitespace edits. Absent on legacy rows — those pool
   * under the empty-string segment of fixedConfigKey.
   *
   * Provenance field, not a config knob — widening fixedConfigKey with this is correct
   * (different behaviour hash = different instrument). Does NOT violate t/1668#2's bar
   * against temperature/situation_cap (those are run-varying params; this is instrument
   * identity). T1 additive-optional: no consumer may branch on this field until the
   * exemption lapses (the moment a consumer reads it for logic, not logging/display).
   */
  behaviour_revision?: string;
  /**
   * Model that produced this entry's neutral-evaluator metrics (t/1846). Crux metrics are
   * evaluator-model-relative (t/1835: MAD 0.625 across evaluator families), so the optimizer
   * only compares rows sharing this id. ABSENT on legacy rows, whose evaluator was the
   * debate's own model — those rows are permanently ineligible for the optimizer window
   * (evaluator-mixed by construction; TL t/1846#3).
   */
  evaluator_model_id?: string;

  // ── Multi-provider model tracking (t/4040) ──
  /** Speaker model assignments at session init (multi-provider runs only). Absent on single-model rows and pre-t/4040 entries. */
  speaker_models?: Record<string, string>;
  /** Last failover per speaker (speaker → replacement model). Presence ⇒ excluded from replication count.
   *  Full failover history is in FR `ai.fallback` events. Absent when no failover occurred. */
  speaker_model_failovers?: Record<string, string>;
  /** Multi-provider model pool fingerprint: `"tierName|b1=registryId1:apiModelId1,..."` sorted by backend. Absent on single-model rows. */
  model_pool?: string;
  /** Single-model run fingerprint: `"registryId:apiModelId"` resolved at run time. Absent on multi-provider rows. */
  model_api_id?: string;
  /** Whether failover tracking was available for this run. 'tracked' = engine-path (failovers visible); 'unavailable' = renderer-path (failover below bridge, invisible). Absent on pre-t/4040 rows — treated as legacy (unchecked). */
  failover_tracking?: 'tracked' | 'unavailable';

  // ── Parameter 1: Exploration exit threshold ──
  /** Saturation score from the last signal_telemetry entry at debate end (unconditional last-round value; null when no telemetry). Field name is historical — the extraction is not transition-gated. */
  argumentative_saturation_at_transition: number | null;
  /** The argumentation_exit threshold that was active */
  argumentation_exit_threshold: number;
  /** Neutral evaluator: debate engaging real disagreement? */
  engaging_real_disagreement: boolean | null;
  /** Neutral evaluator: fraction of cruxes addressed */
  crux_addressed_ratio: number | null;
  /**
   * Neutral evaluator: observation-class 3-way tally of crux statuses (t/1796).
   * Additive/back-compat — absent on pre-t/1796 entries (and when there are no
   * cruxes to tally). `crux_addressed_ratio` semantics are unchanged: it remains
   * `addressed / total`. This exposes `partially_addressed` separately so it is no
   * longer scored identically to `unaddressed`.
   */
  crux_status_counts?: { addressed: number; partially_addressed: number; unaddressed: number };

  // ── Parameter 2: Embedding relevance threshold ──
  /** Average utilization rate across all turns: referenced / injected */
  avg_utilization_rate: number | null;
  /** Average primary node utilization: referenced_primary / injected_primary */
  avg_primary_utilization: number | null;
  /** The relevance threshold that was active (from config or default) */
  relevance_threshold: number;

  // ── Parameter 3: QBAF attack weights ──
  /** How often QBAF computed_strength ordering agrees with synthesis preferences */
  qbaf_preference_concordance: number | null;
  /** Attack weights used: [rebut, undercut, undermine] */
  attack_weights: [number, number, number];

  // ── Parameter 4: Draft temperature ──
  /** Schema/structural error rate: schema_errors / total_turns */
  structural_error_rate: number;
  /** Repetition warning rate: repetition_warnings / total_turns */
  repetition_rate: number;
  /** The draft temperature used */
  draft_temperature: number;

  // ── Parameter 5: Saturation signal weights ──
  /** Raw saturation signal values at transition point */
  argumentative_saturation_signals_at_transition: Record<string, number> | null;
  /** The signal weights that were active */
  argumentative_saturation_weights: Record<string, number>;

  // ── Parameter 6: Context compression window ──
  /** Fraction of claims that fell out of context and were never addressed */
  claims_forgotten_rate: number | null;
  /** RECENT_WINDOW value used */
  recent_window: number;

  // ── Parameter 7: GC trigger ──
  /** Argument network node count at synthesis time */
  an_nodes_at_synthesis: number;
  /** Number of GC runs during the debate */
  gc_runs: number;
  /** GC trigger threshold used */
  gc_trigger: number;

  // ── Parameter 8: Crux resolution thresholds ──
  /**
   * Symmetric engine↔evaluator crux disagreement DIAGNOSTIC (redefined, t/1846 §E):
   * share of semantically matched crux pairs (t/1853) whose resolution status
   * disagrees. Neither side is privileged — high values mean "the two crux views
   * differ; look at both", never "the engine is wrong". Permanently excluded from
   * config-writing objectives (CRUX_AXIS_PARAMS). Null when either side has no
   * embedding-bearing cruxes (legacy rows: positional comparison; not comparable
   * with matched-pair rows).
   */
  crux_resolution_divergence_rate: number | null;
  /**
   * Match/coverage accounting behind crux_resolution_divergence_rate (t/1853).
   * `engine_unmatched`/`evaluator_unmatched` are an UPPER BOUND on real coverage
   * asymmetry — not a clean signal. Matcher recall ≈0.43 at θ=0.5 (t/1853 golden-set
   * validation: prereg FAIL), so ~57% of unmatched pairs are register-mismatch artifact
   * (engine embeds one-sided claim text; evaluator writes neutral "whether X or Y"
   * statements). See analyses/t1853-crux-match-threshold/REPORT.md. Null when semantic
   * matching was impossible (no embeddings on one side). Optional: rows written before
   * t/1853 omit it.
   */
  crux_match_stats?: CruxMatchStats | null;
  /**
   * Share of tracked cruxes that terminated `undecided` — surfaced but never adjudicated
   * (t/1676). STIPULATED provenance until CL's AC#2 golden-set absorption (t/1669) promotes
   * it to derived. Distinct from the preference-layer `undecidable`. Optional/nullable:
   * calibration entries written before this field existed omit it.
   */
  crux_undecided_rate?: number | null;
  /** Distribution of counterfactual types across tracked cruxes (RATIO 2024). */
  counterfactual_type_distribution: { interventional: number; backtracking: number; normative: number; none: number } | null;
  /** POLARITY_RESOLVED_THRESHOLD used */
  polarity_resolved_threshold: number;

  // ── Parameter 9: Node selection caps ──
  /** Variance of relevance scores across injected nodes (low = narrow topic) */
  relevance_score_variance: number | null;
  /** Total nodes injected vs referenced (for cap tuning) */
  max_nodes_cap: number;

  // ── Parameter 10: Semantic recycling threshold ──
  /** Agreement rate between recycling detector and turn validator novelty signal */
  recycling_novelty_agreement: number | null;
  /** SEMANTIC_RECYCLING_THRESHOLD used */
  semantic_recycling_threshold: number;

  // ── Parameter 11: Cluster MinSimilarity ──
  /** How many AN nodes map to taxonomy nodes vs are orphaned (proxy for cluster quality) */
  taxonomy_mapped_ratio: number | null;
  /** Cluster MinSimilarity used in hierarchy proposals */
  cluster_min_similarity: number;

  // ── Parameter 12: Duplicate claim similarity ──
  /** Number of near-miss claim pairs (similarity in [threshold-0.05, threshold]) */
  near_miss_duplicate_count: number | null;
  /** Duplicate similarity threshold used */
  duplicate_similarity_threshold: number;

  // ── Parameter 13: FIRE confidence threshold ──
  /** Fraction of FIRE-accepted claims (confidence 0.7-0.75) that survived debate without being refuted */
  borderline_claim_survival_rate: number | null;
  /** FIRE confidence threshold used */
  fire_confidence_threshold: number;

  // ── Parameter 14: Hierarchy cohesion thresholds ──
  /** Average cohesion score of taxonomy branches referenced in the debate */
  avg_branch_cohesion: number | null;
  /** Cohesion "clear theme" threshold */
  cohesion_clear_theme: number;

  // ── Parameter 15: Extraction density quotas ──
  /** Claims per 1000 words across source documents in the debate */
  claims_per_1k_words: number | null;
  /** KP divisor (wordCount / divisor = key points) */
  kp_divisor: number;

  // ── Parameter 16: API budget hard multiplier ──
  /** Whether the debate was terminated by the API hard ceiling */
  hit_api_ceiling: boolean;
  /** Total API calls used */
  total_api_calls: number;
  /** Hard multiplier used (rounds × multiplier = ceiling) */
  budget_hard_multiplier: number;

  // ── Situation effectiveness ──
  /** Number of situation nodes injected into debater context */
  situation_nodes_injected: number;
  /** Number of situation nodes actually referenced in taxonomy_refs */
  situation_nodes_referenced: number;
  /** Fraction of neutral evaluator cruxes that share vocabulary with injected situation nodes (word-overlap proxy; not a measure of substantive engagement) */
  situation_crux_alignment: number | null;
  /** Fraction of injected situation nodes actually referenced by debaters in taxonomy_refs; null when no situations injected */
  situation_reference_rate: number | null;
  /** Max situation nodes cap used */
  situation_max_nodes: number;
  /**
   * Per-injected-situation component scores from the final mid-debate re-scoring snapshot
   * (last-write-wins — not averaged across rounds). bdi_entropy and conflict_openness are
   * always 0 in mid-debate context. composite = weightedSituationScore(components, MID_DEBATE_WEIGHTS).
   * Null when adaptive staging did not run or no situations were scored.
   */
  situation_component_scores: Array<{
    node_id: string;
    composite: number;
    referenced: boolean;
    relevance: number;
    diversity: number;
    freshness: number;
    bdi_entropy: number;
    conflict_openness: number;
  }> | null;

  // ── Per-claim drift / sycophancy ──
  /** Whether the per-claim sycophancy guard fired during this debate */
  sycophancy_guard_fired: boolean;
  /** Highest per-claim sycophancy score across all speakers */
  max_sycophancy_score: number;
  /** Fraction of all opening claims that ended as 'abandoned' */
  claims_abandoned_rate: number;

  // ── QBAF oscillation ──
  /** Whether any QBAF run in this debate required progressive damping. */
  qbaf_oscillation_detected: boolean;
  /** QBAF iterations in the final computation */
  qbaf_iterations: number;
  /** Peak progressive damping level across all rounds (0 = none, 3 = max schedule) */
  qbaf_damping_level: number;
  /** Fraction of QBAF runs that triggered damping (oscillated_runs / total_runs). */
  qbaf_oscillation_rate: number;

  // ── Claim outcomes (t/278 Phase 1) ──
  /** Aggregate claim outcome stats: thrived/survived/died */
  claim_outcome_summary: { total: number; thrived: number; survived: number; died: number; thrived_rate: number; died_rate: number } | null;

  // ── Confidence escalation ──
  /** Total confidence deferrals during this debate */
  confidence_deferrals: number;
  /** Times the confidence floor was lowered (escalations) */
  confidence_escalations: number;
  /** Predominant bottleneck: extraction, stability, or none */
  confidence_bottleneck: 'extraction' | 'stability' | 'none';

  // ── Agent utility (game theory Layer 4) ──
  /** Per-agent utility scores computed from argument network state. */
  agent_utilities: Record<string, AgentUtility> | null;
  /** Number of claims rejected by the marginal value filter (anti-filibustering). */
  low_value_claims_rejected: number;
  /** Per-speaker mean embedding similarity to crux centroid (1.0 = perfectly on-topic). */
  topic_coherence_per_speaker: Record<string, number> | null;
  /** Per-agent concession asymmetry (attack target strength - conceded strength). */
  concession_asymmetry_per_speaker: Record<string, number> | null;
  /** Premature concession cascades: sequential concessions by different agents within 2 turns. */
  concession_cascades: number;

  // ── Topic wisdom evaluation ──
  /** Composite topic wisdom score (0-20). Null if evaluation was skipped. */
  topic_wisdom_total: number | null;
  /** Whether topic reframing was applied. */
  topic_reframed: boolean;
  /** Dimensions that scored 0 (weakest areas). */
  topic_weakest: string[];
  /** Dominant intellectual traditions from lineage distribution (top 3 at 15%+). Null if unavailable. */
  lineage_frame: { cluster_id: string; label: string; percentage: number }[] | null;
  /** Lineage boost effectiveness: how often boosted/promoted nodes are actually referenced. */
  lineage_effectiveness: {
    boosted_node_count: number;
    promoted_node_count: number;
    promoted_referenced_count: number;
    promoted_reference_rate: number;
    baseline_reference_rate: number;
  } | null;

  // ── Topic alignment (t/336, t/341) ──
  /** Whether TopicScope was extracted for this debate. */
  topic_scope_extracted: boolean;
  /** constraint_confidence from TopicScope. Null if scope not extracted. */
  topic_scope_confidence: 'explicit' | 'inferred' | null;
  /** Number of relevant_disciplines in the extracted scope. Null if no scope. */
  topic_scope_disciplines: number | null;
  /** Number of off_scope_topics identified. Null if no scope. */
  topic_scope_off_topics: number | null;
  /** Number of drift_signatures identified. Null if no scope. */
  topic_scope_drift_sigs: number | null;
  /** Fraction of turns where topic_aligned was true in draft quality gate. Null if no scope or no quality gate data. */
  topic_alignment_rate: number | null;
  /** Fraction of TopicScope fields that are non-empty/non-default. Null if scope not extracted. */
  scope_extraction_populated: number | null;
  /** Fraction of entries where topic alignment required repair retry. Null if no quality gate data. */
  draft_repair_rate: number | null;
  /** Fraction of injected taxonomy nodes demoted by scope filter. Null if no scope filter data. */
  taxonomy_demotion_rate: number | null;
  /** Fraction of demoted nodes that debaters referenced anyway. Null if no demoted nodes. */
  demoted_node_reference_rate: number | null;
  /** Fraction of moderator turns where a drift pattern was triggered. Null if no moderator data. */
  moderator_drift_intervention_rate: number | null;

  // ── Process reward (PRM-adjacent signal) ──
  /** Per-turn process reward scores for correlation with convergence signals */
  process_reward_series: { round: number; speaker: string; score: number; components: Record<string, number> }[] | null;
  /** Mean process reward across all turns */
  process_reward_mean: number | null;
  /** Standard deviation of process rewards */
  process_reward_stddev: number | null;
  /** Minimum process reward (identifies weakest turns) */
  process_reward_min: number | null;

  // ── Prompt size tracking (t/219) ──
  /** Maximum prompt chars across all pipeline stages in this debate */
  max_prompt_chars: number | null;
  /** Mean prompt chars across all pipeline stages in this debate */
  mean_prompt_chars: number | null;

  // ── Grounding confidence (t/281) ──
  /** Average grounding_confidence across all Cite stages in this debate. Null if no Cite data. */
  avg_grounding_confidence: number | null;
  /** Minimum grounding_confidence across all Cite stages in this debate. Null if no Cite data. */
  min_grounding_confidence: number | null;

  // ── Per-component prompt breakdown (t/221) ──
  /** Maximum per-component char counts across all stages (null if no data). */
  max_component_chars: {
    taxonomy_chars: number;
    transcript_chars: number;
    hints_chars: number;
    edge_chars: number;
    commitment_chars: number;
    an_summary_chars: number;
  } | null;

  // ── Extraction coverage (t/391) ──
  /** Mean coverage_rate across sampled turns (covered_verifiable / verifiable_elements). */
  extraction_coverage_rate: number | null;
  /** Number of turns sampled for extraction coverage measurement. */
  extraction_coverage_samples: number;

  // ── Extraction quality (t/379, t/380) ──
  /** Mean extraction_confidence across all AN nodes. */
  mean_extraction_confidence: number | null;
  /** Fraction of AN nodes with extraction_confidence < 0.6. */
  low_confidence_claims_rate: number | null;
  /** Fraction of entailment checks with verdict 'entailed'. */
  entailment_pass_rate: number | null;
  /** Fraction of entailment checks that resulted in text repair (partial or not_entailed with repaired_text). */
  entailment_repair_rate: number | null;
  /** Fraction of AN nodes that were sampled for entailment checking. */
  entailment_sampling_coverage: number | null;

  // ── Clarity metrics (Wachsmuth: Clarity, t/1120) ──
  /** Per-debate mean words-per-sentence across speaker turns. */
  clarity_mean_sentence_length: number | null;
  /** Per-debate mean type-token ratio across speaker turns. */
  clarity_lexical_diversity: number | null;
  /** Per-debate mean domain-jargon ratio across speaker turns. */
  clarity_jargon_density: number | null;

  // ── Affect signals (Wachsmuth: Emotional Appeal, t/1121) ──
  /** Mean affect intensity across speaker turns [0,1]. */
  affect_intensity_mean: number | null;
  /** Population variance of per-turn affect intensity. */
  affect_intensity_variance: number | null;
  /** Mean affect appropriateness score (deviation from phase baseline). */
  affect_appropriateness: number | null;
  /**
   * Per-phase share-normalized affect profile aggregate (t/2676). Re-fit input for
   * deriving AFFECT_PHASE_BASELINES from corpus data. Each phase entry holds the
   * mean of per-turn share-normalized profiles (profile[cat]/total) for turns in
   * that phase, plus n_turns (the weight for corpus aggregation). Absent on legacy
   * rows and when no qualifying turns exist. Values at 4dp.
   * Provenance: stipulated → derived once CL re-fits on ≥N post-t/2677 debates.
   */
  affect_profile_by_phase?: Partial<Record<'confrontation' | 'argumentation' | 'concluding', {
    profile_mean: AffectProfile;
    n_turns: number;
  }>>;

  // ── Source authority (Wachsmuth: Credibility, t/1122) ──
  /** Mean venue tier score of cited sources [0,1]. */
  source_authority_mean: number | null;
  /** Mean recency score of cited sources (exponential decay, half-life 5yr). Computed relative to the calendar year at scoring time; not stable across re-scoring runs in later years. */
  source_recency_mean: number | null;
  /** Mean distinct source documents per AN node. */
  evidence_breadth_per_claim: number | null;

  // ── Camp insularity (BEA: Reflective User Engagement, t/1117) ──
  /** Mean same-camp citation rate across speakers [0,1]. Higher = more insular. */
  camp_insularity_rate: number | null;
  /** Max same-camp citation rate across speakers — faithful trigger for per-speaker intervention. */
  camp_insularity_max: number | null;
  /** Cross-camp node injections triggered by camp insularity (BEA RUE, t/1130). */
  insularity_interventions: { speaker: string; round: number; injected_node_id: string; target_camp: string; engaged: boolean }[] | null;

  // ── Peer referencing (Marandi: peer-referencing ↔ diversity trade-off, t/1279) ──
  /** Fraction of speaker turns with ≥1 cross-POV dialectical edge (attack/support targeting another POV's claim). Mean across speakers. */
  peer_referencing_rate: number | null;
  /** Per-speaker peer referencing rates. */
  peer_referencing_per_speaker: Record<string, number> | null;

  // ── Local sufficiency (Wachsmuth: Local Sufficiency, t/1341) ──
  /** Mean per-claim sufficiency score over eligible claims [0,1]. Excludes final-round claims (maturity window). */
  local_sufficiency_mean: number | null;
  /** Fraction of eligible claims with zero incoming 'supports' edges (bare assertion rate). */
  unsupported_claim_rate: number | null;
  /** Per-speaker mean sufficiency score. */
  local_sufficiency_by_speaker: Record<string, number> | null;

  // ── Operational closure (autopoiesis, t/1537) ──
  /** Mean operational closure rate across speakers [0,1]. Higher = more self-sealing. Null if no dialectical edges. */
  operational_closure_rate: number | null;
  /** Per-speaker operational closure stats. Null if no dialectical edges. */
  operational_closure_per_speaker: Record<string, { closure_rate: number; closure_edges: number; coupling_edges: number; standalone_rate: number }> | null;

  // ── Exploration seeding (t/990) ──
  /** Debate ID of the exploration run that seeded this debate. */
  exploration_source_id?: string;
  /** Model used for the exploration run. */
  exploration_source_model?: string;
  /** Number of cruxes seeded from exploration. */
  seeded_crux_count?: number;
  /** Number of effective situations identified in exploration. */
  seeded_effective_situation_count?: number;
  /** Number of ineffective situations identified in exploration. */
  seeded_ineffective_situation_count?: number;
  /** Number of AN nodes primed from exploration. */
  seeded_an_node_count?: number;

  // ── POV tag selection (t/3957) ──
  /** POV tag active for this debate's accelerationist seat (absent ⇒ untagged). */
  pov_tag?: string;
  /** Tag mode for the active tag ('scope' | 'prioritize'). */
  tag_mode?: string;
  /** POV nodes that carried the active tag (SCOPE pre-filter count). */
  in_scope_count?: number;
  /** Selected POV nodes that carried the active tag. */
  tagged_selected_count?: number;
  /** POV nodes excluded because they lacked the active tag (SCOPE mode only; 0 in PRIORITIZE). */
  excluded_untagged_count?: number;

  // ── Over-generate/select/rewrite pipeline (t/1581) ──
  /** Whether a coherence gate miss occurred (rewrite failed to preserve ≥3/4 selected claims). */
  coherence_gate_miss?: boolean;

  // ── Termination classification (t/1671) ──
  /**
   * How the debate ended, derived from phases[].force_active stamped in crossRespond.ts.
   * 'natural_conclusion': force_active=false — convergence/saturation threshold reached naturally.
   * 'max_iterations': force_active=true AND exit_reason matches /Max total rounds/i.
   * 'situation_cap': force_active=true, any other forced cap (health, synthesis stall, etc.).
   * 'api_ceiling': API hard ceiling hit (detected via transcript content; overrides force_active).
   * 'first_round_exit': debate exited with ≤1 statement, no ASD phases — early failure before convergence logic ran (t/3502).
   * 'unknown': legacy rows without force_active — excluded from censoring pools.
   * Absent on pre-t/1671 rows; treated as 'unknown' by computeConvergenceWithCensoring.
   */
  termination_reason?: 'natural_conclusion' | 'max_iterations' | 'situation_cap' | 'api_ceiling' | 'first_round_exit' | 'unknown';
  /**
   * Last composite convergence_score from adaptive_staging_diagnostics.signal_telemetry.
   * Same extraction point as argumentative_saturation_at_transition. Null when no telemetry.
   */
  convergence_score_at_termination?: number | null;

  // ── Frame survival (frame_survival metric family, t/2045) ──
  /** Count of parseable declared frames per speaker. Observation. */
  frames_declared_per_speaker?: Record<string, number>;
  /**
   * Mean over f∈F_s of (fraction of T_s where f is present at FRAME_PRESENCE_THRESHOLD).
   * Null when framing_choices absent/unparseable, speaker has <2 post-opening turns,
   * or embeddings unavailable. Stipulated.
   */
  frame_persistence_per_speaker?: Record<string, number | null>;
  /**
   * Mean over f∈F_s of (fraction of T_¬s where f is present at FRAME_PRESENCE_THRESHOLD).
   * Null same conditions as frame_persistence_per_speaker. Stipulated.
   */
  frame_engagement_per_speaker?: Record<string, number | null>;
  /**
   * Fraction of *embeddable* evaluator cruxes whose max similarity to any declared frame ≥ FRAME_PRESENCE_THRESHOLD.
   * Null when eval absent/invalid or no crux embeddings available. Stipulated.
   */
  frame_crux_alignment?: number | null;
  /**
   * Count of validated REFRAME moves whose target AN node is frame-linked (cosine ≥ FRAME_LINK_THRESHOLD).
   * Stipulated (threshold-conditional count). Zero when no REFRAME edges exist.
   */
  frame_reframe_targeted_count?: number;
  /**
   * Headline: unweighted mean of non-null frame_persistence_per_speaker values.
   * Null when all speakers have null persistence. Stipulated.
   */
  frame_survival?: number | null;

  // ── Drift telemetry shadow log (t/3603) ──
  /**
   * Per-turn drift telemetry series. Shadow mode — NO behaviour change. Additive-optional.
   * Three reachable, distinct states (TL ruling t/3603#3):
   *   - `undefined` (absent) — pre-t/3603 entry; NO instrumentation ran. Do NOT treat as
   *     zero drift — using `series ?? []` collapses this with null and silently biases any
   *     aggregate computed over historical entries.
   *   - `null` — t/3603+ session where instrumentation ran but zero turns were recorded
   *     (e.g. debate ended before any cross-responses). Distinct from absent: this entry
   *     WAS produced by instrumented code.
   *   - `DriftTelemetryEntry[]` — one entry per completed debater turn.
   * CL field definitions confirmed at t/3603#2.
   */
  drift_telemetry_series?: DriftTelemetryEntry[] | null;

  // ── AIF B5 metrics (t/3715) ──────────────────────────────
  /**
   * AIF-derived B5 metrics: crux-from-AIF (§1) + 2-signal convergence_score (§2).
   * Provisional / shadow only — gates nothing (AC6, b5-build-spec.md).
   * Additive-optional:
   *   - `undefined` (absent) — pre-t/3715 entry; B5 did not run.
   *   - `null` — B5 ran but no argument-network nodes were available.
   *   - `AifB5Metrics` — computed values with metric_def_version (AC5).
   */
  aif_b5_metrics?: AifB5Metrics | null;
}

/**
 * AIF B5 metric bundle (t/3715, b5-build-spec.md). Provisional / shadow (AC6).
 */
export interface AifB5Metrics {
  /** Definition version for cross-time comparison (AC5). Change when metric definition changes. */
  metric_def_version: string;
  /**
   * Count of sustained cross-agent CA-nodes (crux-from-AIF, spec §1).
   * A crux = a cross-agent opposition (conflict_claim_id) that recurs across ≥2 distinct rounds.
   * Aggregate only — t/3587 over-determination constraint: per-crux claims are unreliable.
   */
  crux_count: number;
  /** conflict_claim_ids of the crux set (one per sustained CA opposition). */
  crux_set: string[];
  /**
   * 2-signal convergence score (spec §2). Signal A = concession accumulation (rising);
   * Signal B = retained-hold reduction (falling). Stipulated equal 0.5/0.5 weighting.
   * Null when convergence_signals is absent or empty (total_turns = 0 → no valid denominator).
   */
  convergence_score: number | null;
}

// DriftTelemetryEntry lives in types/session.ts (session-side type; avoids the
// calibrationLogger → neutralEvaluator → aiAdapter transitive import into the
// renderer-safe comments.ts graph — importGraph test guard t/2550).
import type { DriftTelemetryEntry } from '../types/session.js';
export type { DriftTelemetryEntry } from '../types/session.js';
