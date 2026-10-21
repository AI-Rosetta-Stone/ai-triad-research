// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// C1 (TopicPipeline) behavioral equivalence test — t/1300 condition 3.
// Runs a 2-round debate with a deterministic mock adapter and captures
// the session's topic.* fields written by TopicPipeline methods.
// The snapshot is compared across the extraction boundary.

import { describe, it, expect } from 'vitest';
import { DebateEngine } from '../debateEngine.js';
import type { DebateConfig } from '../debateEngine.js';
import type { ExtendedAIAdapter, GenerateOptions } from '../aiAdapter.js';
import type { LoadedTaxonomy } from '../taxonomyLoader.js';

function createDeterministicAdapter(): ExtendedAIAdapter {
  let callIndex = 0;
  const responses: Record<number, string> = {
    // Topic critique
    0: JSON.stringify({
      rating: 'good',
      composite_score: 14,
      strengths: ['Relevant to AI policy'],
      weaknesses: ['Could be more specific'],
      recommendations: ['Focus on specific regulations'],
      scope_additions: ['Include international perspectives'],
    }),
    // Topic scope extraction
    1: JSON.stringify({
      core_proposition: 'Should AI development be regulated?',
      relevant_disciplines: ['computer science', 'public policy'],
      on_scope_evidence: ['AI capabilities growing rapidly'],
      key_tensions: ['innovation vs safety'],
      off_scope_topics: ['quantum computing', 'social media regulation', 'space exploration'],
      drift_signatures: ['pivoting to unrelated tech policy', 'discussing non-AI automation'],
      example_ceiling: 'Self-driving cars as example of regulated AI',
      risk_level: 'medium',
      domain: 'technology policy',
      product_type: null,
      time_horizon: '5-10 years',
      excluded_scenarios: [],
      explicit_qualifiers: [],
      constraint_confidence: 'inferred',
    }),
    // Clarification questions
    2: JSON.stringify({
      questions: [
        { question: 'What type of regulation?', options: ['Hard law', 'Soft law', 'Industry self-regulation'] },
        { question: 'Which AI applications?', options: ['General purpose', 'Domain-specific', 'All'] },
      ],
    }),
    // Topic synthesis
    3: JSON.stringify({
      refined_topic: 'Should general-purpose AI systems be subject to mandatory safety regulations before deployment?',
    }),
    // Resolution clause decomposition
    4: JSON.stringify({
      clauses: [
        'General-purpose AI systems should be subject to safety regulations',
        'These regulations should be mandatory rather than voluntary',
        'Regulations should apply before deployment, not after',
      ],
    }),
  };

  return {
    async generateText(_prompt: string, _model: string, _options?: GenerateOptions) {
      const resp = responses[callIndex] ?? '{"response": "mock-fallback"}';
      callIndex++;
      return resp;
    },
    registry: { backends: [], models: [] },
  };
}

function createMinimalTaxonomy(): LoadedTaxonomy {
  return {
    accelerationist: {
      nodes: [
        { id: 'acc-beliefs-001', label: 'AI progress is net positive', description: 'Technology benefits society', category: 'beliefs' } as any,
      ],
    },
    safetyist: {
      nodes: [
        { id: 'saf-beliefs-001', label: 'AI poses existential risk', description: 'Advanced AI could be dangerous', category: 'beliefs' } as any,
      ],
    },
    skeptic: {
      nodes: [
        { id: 'skp-beliefs-001', label: 'AI hype is overblown', description: 'Current AI limited', category: 'beliefs' } as any,
      ],
    },
    situations: { nodes: [] },
    edges: null,
    embeddings: {},
    policyRegistry: [],
    allNodesById: new Map(),
    resolveNode: (_id: string) => undefined,
    allEdges: null,
  };
}

describe('C1 TopicPipeline equivalence', () => {
  it('produces expected topic.* session fields from deterministic mock adapter', async () => {
    const adapter = createDeterministicAdapter();
    const config: DebateConfig = {
      topic: 'Should AI development be regulated?',
      sourceType: 'topic',
      activePovers: ['accelerationist', 'safetyist', 'skeptic'],
      model: 'mock-model',
      rounds: 1,
      responseLength: 'short',
      enableClarification: true,
      enableWisdomEvaluation: true,
    };
    const taxonomy = createMinimalTaxonomy();
    const engine = new DebateEngine(config, adapter, taxonomy);

    const session = await engine.run();

    // Verify topic critique was computed (structural score is 0 with no embeddings,
    // so parseTopicCritique overrides the LLM rating based on composite)
    expect(session.topic.critique).toBeDefined();
    expect(session.topic.critique!.rating).toBeDefined();
    expect(typeof session.topic.critique!.composite_score).toBe('number');

    // Verify topic scope was extracted
    expect(session.topic.scope).toBeDefined();
    expect(session.topic.scope!.core_proposition).toBe('Should AI development be regulated?');
    expect(session.topic.scope!.risk_level).toBe('medium');
    expect(session.topic.scope!.off_scope_topics).toHaveLength(3);
    expect(session.topic.scope!.drift_signatures).toHaveLength(2);
    expect(session.topic.scope!.constraint_confidence).toBe('inferred');

    // Verify clarification ran and refined the topic
    expect(session.topic.refined).toBeDefined();
    expect(session.topic.final).toBe(
      'Should general-purpose AI systems be subject to mandatory safety regulations before deployment?',
    );

    // Verify resolution clauses
    expect(session.topic.clauses).toBeDefined();
    expect(session.topic.clauses).toHaveLength(3);
    expect(session.topic.clauses![0]).toContain('General-purpose AI');

    // Snapshot the full topic object for regression detection
    expect(session.topic.critique!.rating).toBeDefined();
    expect(session.topic.scope!.domain).toMatchInlineSnapshot(`"technology policy"`);
    expect(session.topic.clauses).toMatchInlineSnapshot(`
      [
        "General-purpose AI systems should be subject to safety regulations",
        "These regulations should be mandatory rather than voluntary",
        "Regulations should apply before deployment, not after",
      ]
    `);
  });
});
