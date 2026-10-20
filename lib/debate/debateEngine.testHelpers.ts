// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Shared fixtures for the debateEngine.*.test.ts split (t/1686). No behavior change —
// these are the four top-level fixtures formerly inlined at the head of debateEngine.test.ts.

import type { DebateConfig } from './debateEngine.js';
import type { ExtendedAIAdapter, GenerateOptions } from './aiAdapter.js';
import type { LoadedTaxonomy } from './taxonomyLoader.js';

// ── Mock adapter ──────────────────────────────────────────

export function createMockAdapter(responses: string[] = []): ExtendedAIAdapter {
  let callIndex = 0;
  return {
    async generateText(_prompt: string, _model: string, _options?: GenerateOptions) {
      return responses[callIndex++] || '{"response": "mock"}';
    },
    // t/3614: required AIAdapter member — mock never runs floor logic, so an empty registry is correct.
    registry: { backends: [], models: [] },
  };
}

export function createThrowingAdapter(error: Error): ExtendedAIAdapter {
  return {
    async generateText() {
      throw error;
    },
    // t/3614: required AIAdapter member — mock never runs floor logic, so an empty registry is correct.
    registry: { backends: [], models: [] },
  };
}

// ── Minimal taxonomy fixture ──────────────────────────────

export function createMinimalTaxonomy(): LoadedTaxonomy {
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
    resolveNode: (id: string) => undefined,
    selectableEdges: null,
  };
}

// ── Default config fixture ────────────────────────────────

export function createDefaultConfig(overrides: Partial<DebateConfig> = {}): DebateConfig {
  return {
    topic: 'Should AI development be regulated?',
    sourceType: 'topic',
    activePovers: ['accelerationist', 'safetyist', 'skeptic'],
    model: 'gemini-2.0-flash',
    rounds: 5,
    responseLength: 'medium',
    ...overrides,
  };
}
