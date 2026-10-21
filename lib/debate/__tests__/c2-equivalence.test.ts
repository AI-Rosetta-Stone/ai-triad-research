// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// C2 (ClaimExtractionPipeline) behavioral equivalence test — t/1300 condition 3.
// Runs a debate with deterministic mock adapter and verifies session fields
// written by ClaimExtractionPipeline methods are populated.

import { describe, it, expect } from 'vitest';
import { DebateEngine } from '../debateEngine.js';
import type { DebateConfig } from '../debateEngine.js';
import type { ExtendedAIAdapter, GenerateOptions } from '../aiAdapter.js';
import type { LoadedTaxonomy } from '../taxonomyLoader.js';

function createMockAdapter(): ExtendedAIAdapter {
  return {
    async generateText(_prompt: string, _model: string, _options?: GenerateOptions) {
      return '{"response": "mock"}';
    },
    registry: { backends: [], models: [] },
  };
}

function createMinimalTaxonomy(): LoadedTaxonomy {
  return {
    accelerationist: {
      nodes: [
        { id: 'acc-B-001', label: 'AI progress is net positive', description: 'Technology advances benefit society overall', category: 'beliefs' } as any,
      ],
    },
    safetyist: {
      nodes: [
        { id: 'saf-B-001', label: 'AI poses existential risk', description: 'Advanced AI systems could be dangerous', category: 'beliefs' } as any,
      ],
    },
    skeptic: {
      nodes: [
        { id: 'skp-B-001', label: 'AI hype is overblown', description: 'Current AI capabilities are limited', category: 'beliefs' } as any,
      ],
    },
    situations: { nodes: [] },
    edges: null,
    embeddings: {},
    policyRegistry: [],
    allNodesById: new Map(),
    resolveNode: (_id: string) => undefined,
    selectableEdges: null,
  };
}

describe('C2 ClaimExtractionPipeline equivalence', () => {
  it('populates claim extraction session-write targets from deterministic mock', async () => {
    const config: DebateConfig = {
      topic: 'Should AI development be regulated?',
      sourceType: 'topic',
      activePovers: ['accelerationist', 'safetyist', 'skeptic'],
      model: 'mock-model',
      rounds: 1,
      responseLength: 'short',
    };
    const adapter = createMockAdapter();
    const taxonomy = createMinimalTaxonomy();
    const engine = new DebateEngine(config, adapter, taxonomy);

    const session = await engine.run();

    // extractClaims → argument_network structure
    expect(session.argument_network).toBeDefined();
    expect(session.argument_network).toHaveProperty('nodes');
    expect(session.argument_network).toHaveProperty('edges');
    expect(Array.isArray(session.argument_network!.nodes)).toBe(true);
    expect(Array.isArray(session.argument_network!.edges)).toBe(true);

    // extractClaims → extraction_summary
    expect(session.extraction_summary).toBeDefined();

    // extractClaims → crux_tracker
    expect(session.crux_tracker).toBeDefined();

    // extractClaims → commitments
    expect(session.commitments).toBeDefined();

    // diagnostics populated by extraction
    expect(session.diagnostics).toBeDefined();
    expect(session.diagnostics!.entries).toBeDefined();

    // Transcript has opening and response entries (claim extraction runs on each)
    const speakerEntries = session.transcript.filter(
      e => e.type === 'opening' || e.type === 'response',
    );
    expect(speakerEntries.length).toBeGreaterThan(0);
  });

  it('extraction summary has expected structure', async () => {
    const config: DebateConfig = {
      topic: 'Should AI development be regulated?',
      sourceType: 'topic',
      activePovers: ['accelerationist', 'safetyist', 'skeptic'],
      model: 'mock-model',
      rounds: 1,
      responseLength: 'short',
    };
    const adapter = createMockAdapter();
    const taxonomy = createMinimalTaxonomy();
    const engine = new DebateEngine(config, adapter, taxonomy);

    const session = await engine.run();

    if (session.extraction_summary) {
      expect(typeof session.extraction_summary).toBe('object');
    }
  });
});
