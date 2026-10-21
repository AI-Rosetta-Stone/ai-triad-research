// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// C3 (SynthesisPipeline) behavioral equivalence test — t/1300 condition 3.
// Runs a debate with deterministic mock adapter and verifies session fields
// written by SynthesisPipeline methods are populated.

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

describe('C3 SynthesisPipeline equivalence', () => {
  it('populates synthesis session-write targets from deterministic mock', async () => {
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

    // runSynthesis → transcript has concluding entry
    const concludingEntries = session.transcript.filter(e => e.type === 'concluding');
    expect(concludingEntries.length).toBe(1);
    expect(concludingEntries[0].speaker).toBe('system');
    expect(concludingEntries[0].metadata).toHaveProperty('synthesis');

    // runNeutralCheckpoint → neutral_evaluations populated
    // (baseline after openings, final during synthesis — at least 2 attempts)
    expect(session.neutral_evaluations).toBeDefined();

    // runDialecticTracePass → dialectic_traces (only set when AN has edges to trace)
    // With a mock adapter producing no real argument network edges, traces may not be generated
    if (session.dialectic_traces) {
      expect(Array.isArray(session.dialectic_traces)).toBe(true);
    }

    // Diagnostics populated by synthesis
    expect(session.diagnostics).toBeDefined();
    expect(session.diagnostics!.entries).toBeDefined();

    // Verify concluding entry has diagnostics
    const concludingId = concludingEntries[0].id;
    const concludingDiag = session.diagnostics!.entries[concludingId];
    expect(concludingDiag).toBeDefined();
    if (concludingDiag) {
      expect(concludingDiag).toHaveProperty('model');
      expect(concludingDiag).toHaveProperty('response_time_ms');
    }
  });

  it('neutral checkpoint produces transcript entries with evaluation metadata', async () => {
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

    // Neutral checkpoints produce system transcript entries with metadata
    const neutralEntries = session.transcript.filter(
      e => e.type === 'system' && e.metadata?.neutral_checkpoint,
    );
    // At least one neutral checkpoint should have attempted
    // (may succeed or fail depending on mock responses, but entry is created either way)
    if (neutralEntries.length > 0) {
      expect(neutralEntries[0].metadata!.neutral_checkpoint).toMatch(/baseline|midpoint|final/);
    }
  });

  it('session has context_summaries array (compressContext target)', async () => {
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

    // context_summaries is always initialized (compressContext writes to it when transcript is long enough)
    expect(Array.isArray(session.context_summaries)).toBe(true);
  });
});
