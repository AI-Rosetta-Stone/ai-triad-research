// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Full-pipeline structural equivalence test — t/1300 AC#4 closing evidence.
// Runs a complete engine.run() with deterministic mock adapter and verifies
// the structural shape of the session: phase sequence, transcript entry
// count/roles, diagnostics presence, session field population.
// This proves the orchestration seams are intact across all 3 cluster extractions.

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
        { id: 'acc-D-001', label: 'Maximize AI capabilities', description: 'Push the frontier of AI research', category: 'desires' } as any,
      ],
    },
    safetyist: {
      nodes: [
        { id: 'saf-B-001', label: 'AI poses existential risk', description: 'Advanced AI systems could be dangerous', category: 'beliefs' } as any,
        { id: 'saf-D-001', label: 'Ensure AI safety', description: 'Prioritize safety research', category: 'desires' } as any,
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
    allEdges: null,
  };
}

describe('Full-pipeline structural equivalence (t/1300 AC#4)', () => {
  it('deterministic mock run produces structurally complete session', async () => {
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

    // ── Phase sequence ──────────────────────────────────────
    // Session should end in a terminal phase
    expect(['debate', 'synthesis', 'complete']).toContain(session.phase);

    // ── Transcript structure ────────────────────────────────
    expect(session.transcript.length).toBeGreaterThan(0);

    // Must have opening entries (one per active pover)
    const openings = session.transcript.filter(e => e.type === 'opening');
    expect(openings.length).toBe(3);
    const openingSpeakers = new Set(openings.map(e => e.speaker));
    expect(openingSpeakers).toEqual(new Set(['accelerationist', 'safetyist', 'skeptic']));

    // Must have concluding entry (synthesis)
    const concluding = session.transcript.filter(e => e.type === 'concluding');
    expect(concluding.length).toBe(1);
    expect(concluding[0].speaker).toBe('system');

    // Must have system entries (neutral checkpoints, etc.)
    const systemEntries = session.transcript.filter(e => e.type === 'system');
    expect(systemEntries.length).toBeGreaterThan(0);

    // Every transcript entry has required fields
    for (const entry of session.transcript) {
      expect(entry.id).toBeDefined();
      expect(entry.timestamp).toBeDefined();
      expect(entry.type).toBeDefined();
      expect(entry.speaker).toBeDefined();
      expect(typeof entry.content).toBe('string');
    }

    // ── C1 fields (TopicPipeline) ───────────────────────────
    expect(session.topic).toBeDefined();
    expect(session.topic.original).toBe('Should AI development be regulated?');
    expect(session.topic.final).toBeDefined();
    expect(session.topic.critique).toBeDefined();
    expect(session.topic.scope).toBeDefined();

    // ── C2 fields (ClaimExtractionPipeline) ─────────────────
    expect(session.argument_network).toBeDefined();
    expect(Array.isArray(session.argument_network!.nodes)).toBe(true);
    expect(Array.isArray(session.argument_network!.edges)).toBe(true);
    expect(session.crux_tracker).toBeDefined();
    expect(session.commitments).toBeDefined();

    // ── C3 fields (SynthesisPipeline) ───────────────────────
    // Synthesis metadata present on concluding entry
    expect(concluding[0].metadata).toHaveProperty('synthesis');

    // Diagnostics populated across all pipelines
    expect(session.diagnostics).toBeDefined();
    expect(session.diagnostics!.entries).toBeDefined();
    const diagEntryCount = Object.keys(session.diagnostics!.entries).length;
    expect(diagEntryCount).toBeGreaterThan(0);

    // context_summaries initialized
    expect(Array.isArray(session.context_summaries)).toBe(true);

    // ── Session metadata ────────────────────────────────────
    expect(session.id).toBeDefined();
    expect(session.created_at).toBeDefined();
    expect(session.updated_at).toBeDefined();
  });

  it('two deterministic runs produce equivalent structural shape', async () => {
    const config: DebateConfig = {
      topic: 'Should AI development be regulated?',
      sourceType: 'topic',
      activePovers: ['accelerationist', 'safetyist', 'skeptic'],
      model: 'mock-model',
      rounds: 1,
      responseLength: 'short',
    };
    const taxonomy = createMinimalTaxonomy();

    const session1 = await new DebateEngine(config, createMockAdapter(), taxonomy).run();
    const session2 = await new DebateEngine(config, createMockAdapter(), taxonomy).run();

    // Both reach a terminal phase
    expect(['debate', 'synthesis', 'complete']).toContain(session1.phase);
    expect(['debate', 'synthesis', 'complete']).toContain(session2.phase);

    // Both have the same entry types present (count may vary due to retry timing)
    const types1 = new Set(session1.transcript.map(e => e.type));
    const types2 = new Set(session2.transcript.map(e => e.type));
    expect(types1).toEqual(types2);

    // Both have 3 openings (one per pover)
    const openings1 = session1.transcript.filter(e => e.type === 'opening');
    const openings2 = session2.transcript.filter(e => e.type === 'opening');
    expect(openings1.length).toBe(3);
    expect(openings2.length).toBe(3);

    // Both have exactly one concluding entry
    expect(session1.transcript.filter(e => e.type === 'concluding').length).toBe(1);
    expect(session2.transcript.filter(e => e.type === 'concluding').length).toBe(1);

    // Same topic structure
    expect(session1.topic.final).toBe(session2.topic.final);

    // Both have argument networks
    expect(session1.argument_network).toBeDefined();
    expect(session2.argument_network).toBeDefined();

    // Both populate the same set of top-level session fields
    const fieldPresence = (s: any) =>
      ['topic', 'argument_network', 'crux_tracker', 'commitments',
       'diagnostics', 'context_summaries', 'neutral_evaluations']
        .map(f => [f, s[f] !== undefined] as const);
    expect(fieldPresence(session1)).toEqual(fieldPresence(session2));
  });
});
