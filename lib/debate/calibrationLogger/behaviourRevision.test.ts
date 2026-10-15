// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeBehaviourRevision, normalizeSource } from './genBehaviourRevision.js';
import { getBehaviourFiles } from './behaviourRevisionFiles.js';
import { BEHAVIOUR_REVISION } from './behaviourRevision.generated.js';

const thisDir = path.dirname(fileURLToPath(import.meta.url));

describe('normalizeSource', () => {
  it('comment-only edit produces the same normalized string', () => {
    const original = `
      export function foo() {
        // This is a comment
        return 42;
      }
    `;
    const edited = `
      export function foo() {
        // This is a DIFFERENT comment
        return 42;
      }
    `;
    expect(normalizeSource(original)).toBe(normalizeSource(edited));
  });

  it('block comment edit produces the same normalized string', () => {
    const original = `
      /* old block comment */
      export const x = 1;
    `;
    const edited = `
      /* new block comment with more words */
      export const x = 1;
    `;
    expect(normalizeSource(original)).toBe(normalizeSource(edited));
  });

  it('whitespace-only edit produces the same normalized string', () => {
    const original = `export function foo() {    return    42;   }`;
    const edited = `export function foo() { return 42; }`;
    expect(normalizeSource(original)).toBe(normalizeSource(edited));
  });

  it('code edit produces a different normalized string', () => {
    const original = `export function foo() { return 42; }`;
    const edited = `export function foo() { return 43; }`;
    expect(normalizeSource(original)).not.toBe(normalizeSource(edited));
  });

  it('// inside a string literal is not stripped', () => {
    const withUrl = `const url = "http://example.com";`;
    const withOther = `const url = "https://example.com";`;
    expect(normalizeSource(withUrl)).not.toBe(normalizeSource(withOther));
  });

  it('// inside a template literal is not stripped', () => {
    const withSlashes = 'const s = `prefix // not a comment`;';
    const withoutSlashes = 'const s = `prefix`;';
    expect(normalizeSource(withSlashes)).not.toBe(normalizeSource(withoutSlashes));
  });

  it('// after code on a line is stripped like a comment', () => {
    const withComment = `return 42; // inline comment`;
    const withoutComment = `return 42;`;
    expect(normalizeSource(withComment)).toBe(normalizeSource(withoutComment));
  });
});

describe('computeBehaviourRevision', () => {
  it('comment-only edit to a listed file produces the same revision', () => {
    // Simulate a comment-only edit by swapping a comment in the first file.
    const files = getBehaviourFiles();
    const firstFile = files[0];
    const originalContent = readFileSync(firstFile, 'utf-8');

    const withCommentEdited = originalContent + '\n// Added trailing comment\n';

    // Temporarily override readFileSync for just this computation.
    // We do this by passing a modified file list — can't easily swap fs.
    // Instead, verify via normalizeSource: same normalized → same hash.
    const original = computeBehaviourRevision(files);

    // Recompute with comment replaced (by writing, computing, restoring).
    writeFileSync(firstFile, withCommentEdited, 'utf-8');
    try {
      const afterCommentEdit = computeBehaviourRevision(files);
      expect(afterCommentEdit).toBe(original);
    } finally {
      writeFileSync(firstFile, originalContent, 'utf-8');
    }
  });

  it('code edit to a listed file produces a different revision', () => {
    const files = getBehaviourFiles();
    const firstFile = files[0];
    const originalContent = readFileSync(firstFile, 'utf-8');

    const withCodeEdited = originalContent + '\nexport const _BEHAVIOUR_REVISION_TEST_SENTINEL = 1;\n';

    writeFileSync(firstFile, withCodeEdited, 'utf-8');
    try {
      const after = computeBehaviourRevision(files);
      const before = computeBehaviourRevision(files.map(f => f === firstFile ? firstFile : f));
      // Recompute before from original
      writeFileSync(firstFile, originalContent, 'utf-8');
      const beforeRestored = computeBehaviourRevision(files);
      expect(after).not.toBe(beforeRestored);
    } finally {
      writeFileSync(firstFile, originalContent, 'utf-8');
    }
  });
});

describe('behaviourRevision staleness guard (CI gate)', () => {
  it('generated BEHAVIOUR_REVISION matches freshly computed hash', () => {
    // This test fails if any listed file was edited without running gen:behaviour-revision.
    // It is the CI staleness gate for t/4166.
    const files = getBehaviourFiles();
    const fresh = computeBehaviourRevision(files);
    expect(BEHAVIOUR_REVISION).toBe(fresh);
  });

  it('generated file is at expected path', () => {
    const generatedPath = path.join(thisDir, 'behaviourRevision.generated.ts');
    const content = readFileSync(generatedPath, 'utf-8');
    expect(content).toContain(`export const BEHAVIOUR_REVISION = '${BEHAVIOUR_REVISION}'`);
  });
});

describe('fixedConfigKey integration', () => {
  it('rows with different behaviour_revision values do not pool', async () => {
    const { fixedConfigKey } = await import('./replicationGate.js');
    const base = {
      config_revision: 'abc',
      prompt_version: '1.0',
      model: 'test-model',
      schema_version: 1 as const,
      debate_id: 'test',
      timestamp: '',
      origin: 'local',
      rounds: 1,
      argumentative_saturation_at_transition: null,
      argumentation_exit_threshold: 0.8,
      engaging_real_disagreement: null,
      crux_addressed_ratio: null,
      avg_utilization_rate: null,
      avg_primary_utilization: null,
      relevance_threshold: 0.5,
      qbaf_preference_concordance: null,
      attack_weights: [1, 1, 1] as [number, number, number],
      structural_error_rate: 0,
      repetition_rate: 0,
      draft_temperature: 0.7,
      argumentative_saturation_signals_at_transition: null,
      argumentative_saturation_weights: {},
      claims_forgotten_rate: null,
      recent_window: 5,
      an_nodes_at_synthesis: 0,
      gc_runs: 0,
      gc_trigger: 50,
      crux_resolution_divergence_rate: null,
      counterfactual_type_distribution: null,
      polarity_resolved_threshold: 0.5,
      relevance_score_variance: null,
      max_nodes_cap: 10,
      recycling_novelty_agreement: null,
      semantic_recycling_threshold: 0.8,
      taxonomy_mapped_ratio: null,
      cluster_min_similarity: 0.5,
      near_miss_duplicate_count: null,
      duplicate_similarity_threshold: 0.95,
      borderline_claim_survival_rate: null,
      fire_confidence_threshold: 0.7,
      avg_branch_cohesion: null,
      cohesion_clear_theme: 0.7,
      claims_per_1k_words: null,
      kp_divisor: 150,
      hit_api_ceiling: false,
      total_api_calls: 10,
      budget_hard_multiplier: 2,
      situation_nodes_injected: 0,
      situation_nodes_referenced: 0,
      situation_crux_alignment: null,
      situation_reference_rate: null,
      situation_max_nodes: 3,
      situation_component_scores: null,
      sycophancy_guard_fired: false,
      max_sycophancy_score: 0,
      claims_abandoned_rate: 0,
      qbaf_oscillation_detected: false,
      qbaf_iterations: 1,
      qbaf_damping_level: 0,
      qbaf_oscillation_rate: 0,
      claim_outcome_summary: null,
      confidence_deferrals: 0,
      confidence_escalations: 0,
      confidence_bottleneck: 'none' as const,
      agent_utilities: null,
      low_value_claims_rejected: 0,
      topic_coherence_per_speaker: null,
      concession_asymmetry_per_speaker: null,
      concession_cascades: 0,
      topic_wisdom_total: null,
      topic_reframed: false,
      topic_weakest: [],
      lineage_frame: null,
      lineage_effectiveness: null,
      topic_scope_extracted: false,
      topic_scope_confidence: null,
      topic_scope_disciplines: null,
      topic_scope_off_topics: null,
      topic_scope_drift_sigs: null,
      topic_alignment_rate: null,
      scope_extraction_populated: null,
      draft_repair_rate: null,
      taxonomy_demotion_rate: null,
      demoted_node_reference_rate: null,
      moderator_drift_intervention_rate: null,
      process_reward_series: null,
      process_reward_mean: null,
      process_reward_stddev: null,
      process_reward_min: null,
      max_prompt_chars: null,
      mean_prompt_chars: null,
      avg_grounding_confidence: null,
      min_grounding_confidence: null,
      max_component_chars: null,
      extraction_coverage_rate: null,
      extraction_coverage_samples: 0,
      mean_extraction_confidence: null,
      low_confidence_claims_rate: null,
      entailment_pass_rate: null,
      entailment_repair_rate: null,
      entailment_sampling_coverage: null,
      clarity_mean_sentence_length: null,
      clarity_lexical_diversity: null,
      clarity_jargon_density: null,
      affect_intensity_mean: null,
      affect_intensity_variance: null,
      affect_appropriateness: null,
      source_authority_mean: null,
      source_recency_mean: null,
      evidence_breadth_per_claim: null,
      camp_insularity_rate: null,
      camp_insularity_max: null,
      insularity_interventions: null,
      peer_referencing_rate: null,
      peer_referencing_per_speaker: null,
      local_sufficiency_mean: null,
      unsupported_claim_rate: null,
      local_sufficiency_by_speaker: null,
      operational_closure_rate: null,
      operational_closure_per_speaker: null,
      working_tree_state: 'clean' as const,
    };

    const withRevA = { ...base, behaviour_revision: 'aaaaaaaaaaaa' };
    const withRevB = { ...base, behaviour_revision: 'bbbbbbbbbbbb' };
    const withoutRev = { ...base };

    expect(fixedConfigKey(withRevA)).not.toBe(fixedConfigKey(withRevB));
    expect(fixedConfigKey(withoutRev)).toBe('abc|1.0|test-model||');
    expect(fixedConfigKey(withRevA)).toBe('abc|1.0|test-model||aaaaaaaaaaaa');
  });
});
