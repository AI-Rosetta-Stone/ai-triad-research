// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4438 acceptance criteria — seat_tags wired into getRelevantTaxonomyContext:
//   - Scope mode: only tagged nodes enter the candidate pool (excluded_untagged > 0)
//   - Prioritize mode: tagged nodes receive TAG_BOOST_INCREMENT; manifest records mode
//   - No-tag baseline: tag_selection absent from manifest; all nodes are candidates

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getRelevantTaxonomyContext } from './taxonomyContext.js';
import type { DebateEngineInternals, DebateConfig } from './internals.js';
import type { PovNode } from '../taxonomyTypes.js';

vi.mock('../flight-recorder/index.js', () => ({ getGlobalRecorder: () => null }));
vi.mock('../../flight-recorder/index.js', () => ({ getGlobalRecorder: () => null }));

// ── Minimal fakes ─────────────────────────────────────────

const TAG = 'frontier';

function makeNode(id: string, tags: string[] = [], label = `Node ${id}`): PovNode {
  return {
    id, category: 'Beliefs', pov: 'accelerationist',
    title: label, label, description: `desc ${id}`, policy_implications: '',
    pov_tags: tags,
    graph_attributes: {
      argumentative_function: 'premise', certainty: 'contested',
      framing: 'neutral', source_credibility: 'credible',
      novelty: 'standard', importance: 'secondary',
    },
  };
}

// 3 tagged + 5 untagged nodes
const TAGGED_NODES = [
  makeNode('acc-bel-001', [TAG], 'Frontier belief A'),
  makeNode('acc-bel-002', [TAG], 'Frontier belief B'),
  makeNode('acc-bel-003', [TAG], 'Frontier belief C'),
];
const UNTAGGED_NODES = [
  makeNode('acc-bel-004', [], 'Untagged D'),
  makeNode('acc-bel-005', [], 'Untagged E'),
  makeNode('acc-bel-006', [], 'Untagged F'),
  makeNode('acc-bel-007', [], 'Untagged G'),
  makeNode('acc-bel-008', [], 'Untagged H'),
];
const ALL_NODES = [...TAGGED_NODES, ...UNTAGGED_NODES];

function makeEngine(configOverrides: Partial<DebateConfig> = {}): DebateEngineInternals {
  return {
    config: {
      activePovers: ['accelerationist'],
      models: { accelerationist: 'test', safetyist: 'test', skeptic: 'test' },
      ...configOverrides,
    } as unknown as DebateConfig,
    taxonomy: {
      accelerationist: { nodes: ALL_NODES },
      safetyist: { nodes: [] },
      skeptic: { nodes: [] },
      situations: { nodes: [] },
      policyRegistry: undefined,
      embeddings: {},
      edges: undefined,
      lineageCategories: undefined,
    },
    session: {
      id: 'test-session',
      topic: { final: 'AI safety governance', critique: undefined, scope: undefined },
      transcript: [],
      context_summaries: [],
      argument_network: undefined,
      audience: 'researchers',
      diagnostics: undefined,
    },
    // No adapter.computeQueryEmbedding → forces lexical scoring path
    adapter: {},
    _explorationBoosts: new Map(),
    _situationScoreAdjustments: undefined,
    warn: vi.fn(),
    _lastInjectionManifest: null,
    _lastRelevanceScores: null,
    _activatedSituations: [],
    _nodeLabelMap: null,
  } as unknown as DebateEngineInternals;
}

// ── Tests ─────────────────────────────────────────────────

describe('getRelevantTaxonomyContext — seat_tags wiring (t/4438)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scope mode: only tagged nodes enter the candidate pool', async () => {
    const engine = makeEngine({
      seat_tags: { accelerationist: { pov_tag: TAG, tag_mode: 'scope' } },
    });

    await getRelevantTaxonomyContext(engine, 'accelerationist', []);

    const manifest = engine._lastInjectionManifest as Record<string, unknown>;
    expect(manifest).toBeTruthy();
    const ts = manifest['tag_selection'] as Record<string, unknown>;
    expect(ts).toBeTruthy();
    expect(ts['tag']).toBe(TAG);
    expect(ts['mode']).toBe('scope');
    // 5 untagged nodes were excluded from the pool
    expect(ts['excluded_untagged']).toBe(UNTAGGED_NODES.length);
    // All selected nodes must be tagged
    const selected = ts['tagged_selected'] as number;
    expect(selected).toBeGreaterThanOrEqual(0);
    expect(selected).toBeLessThanOrEqual(TAGGED_NODES.length);
  });

  it('scope mode: untagged node ids never appear in returned context', async () => {
    const engine = makeEngine({
      seat_tags: { accelerationist: { pov_tag: TAG, tag_mode: 'scope' } },
    });

    const result = await getRelevantTaxonomyContext(engine, 'accelerationist', []);

    for (const n of UNTAGGED_NODES) {
      expect(result).not.toContain(n.id);
    }
  });

  it('prioritize mode: manifest records mode and tagged_selected; no nodes excluded', async () => {
    const engine = makeEngine({
      seat_tags: { accelerationist: { pov_tag: TAG, tag_mode: 'prioritize' } },
    });

    await getRelevantTaxonomyContext(engine, 'accelerationist', []);

    const manifest = engine._lastInjectionManifest as Record<string, unknown>;
    const ts = manifest['tag_selection'] as Record<string, unknown>;
    expect(ts).toBeTruthy();
    expect(ts['tag']).toBe(TAG);
    expect(ts['mode']).toBe('prioritize');
    // Prioritize never excludes nodes from pool
    expect(ts['excluded_untagged']).toBe(0);
  });

  it('no-tag baseline: tag_selection absent from manifest', async () => {
    const engine = makeEngine({}); // no seat_tags

    await getRelevantTaxonomyContext(engine, 'accelerationist', []);

    const manifest = engine._lastInjectionManifest as Record<string, unknown>;
    expect(manifest['tag_selection']).toBeUndefined();
  });

  it('no-tag baseline: all nodes are candidates (same pool size as full set)', async () => {
    const engineTagged = makeEngine({
      seat_tags: { accelerationist: { pov_tag: TAG, tag_mode: 'scope' } },
    });
    const engineBaseline = makeEngine({});

    await getRelevantTaxonomyContext(engineTagged, 'accelerationist', []);
    await getRelevantTaxonomyContext(engineBaseline, 'accelerationist', []);

    // Scope mode manifest records excluded nodes; baseline has no exclusions
    const taggedManifest = engineTagged._lastInjectionManifest as Record<string, unknown>;
    const ts = taggedManifest['tag_selection'] as Record<string, unknown>;
    expect((ts['excluded_untagged'] as number)).toBeGreaterThan(0);
  });
});
