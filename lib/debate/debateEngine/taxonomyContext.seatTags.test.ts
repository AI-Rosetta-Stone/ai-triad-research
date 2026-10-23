// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4438 acceptance criteria — seat_tags wired into getRelevantTaxonomyContext:
//   - Scope mode: only tagged nodes enter the candidate pool (excluded_untagged > 0)
//   - Scope mode on embedding path: same exclusion applies when computeQueryEmbedding is available
//   - Prioritize mode: tagged nodes receive TAG_BOOST_INCREMENT; manifest records mode
//   - Prioritize displacement: boost actually reverses ordering of a tagged node below an untagged one
//   - Untagged differential: output is byte-identical regardless of seat_tags on other POVs
//   - No-tag baseline: tag_selection absent from manifest; all nodes are candidates
//   - Scope 0-node WARN: engine.warn fires when Scope leaves zero POV nodes

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getRelevantTaxonomyContext } from './taxonomyContext.js';
import * as taxonomyRelevance from '../taxonomyRelevance.js';
import type { DebateEngineInternals, DebateConfig } from './internals.js';
import type { PovNode } from '../taxonomyTypes.js';
import { TAG_BOOST_INCREMENT } from '../debateConfig.js';

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

// Unit vector for embedding tests (384-dim; only [0]=1 for simplicity)
const MOCK_VECTOR = Object.freeze(Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)));

function makeEmbeddings(nodes: PovNode[]): Record<string, { pov: string; vector: number[] }> {
  const out: Record<string, { pov: string; vector: number[] }> = {};
  for (const n of nodes) out[n.id] = { pov: 'accelerationist', vector: [...MOCK_VECTOR] };
  return out;
}

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
    // No adapter.computeQueryEmbedding → forces lexical scoring path by default
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
    vi.restoreAllMocks();
  });

  // ── Scope mode ──────────────────────────────────────────

  it('scope mode: only tagged nodes enter the candidate pool', async () => {
    const engine = makeEngine({
      seat_tags: { accelerationist: { pov_tag: TAG, tag_mode: 'scope' } },
    });

    await getRelevantTaxonomyContext(engine, 'accelerationist', []);

    const ts = (engine._lastInjectionManifest as Record<string, unknown>)['tag_selection'] as Record<string, unknown>;
    expect(ts).toBeTruthy();
    expect(ts['tag']).toBe(TAG);
    expect(ts['mode']).toBe('scope');
    expect(ts['excluded_untagged']).toBe(UNTAGGED_NODES.length);
    expect(ts['tagged_selected'] as number).toBeGreaterThanOrEqual(0);
    expect(ts['tagged_selected'] as number).toBeLessThanOrEqual(TAGGED_NODES.length);
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

  it('scope mode on embedding path: untagged nodes still excluded when computeQueryEmbedding available', async () => {
    const engine = makeEngine({
      seat_tags: { accelerationist: { pov_tag: TAG, tag_mode: 'scope' } },
    });
    // Switch to embedding path: supply adapter + embeddings for all nodes
    (engine.adapter as Record<string, unknown>)['computeQueryEmbedding'] = vi.fn().mockResolvedValue({ vector: [...MOCK_VECTOR] });
    (engine.taxonomy as Record<string, unknown>)['embeddings'] = makeEmbeddings(ALL_NODES);

    const result = await getRelevantTaxonomyContext(engine, 'accelerationist', []);

    // Verify the embedding path was actually taken (adapter was called)
    expect((engine.adapter as Record<string, unknown>)['computeQueryEmbedding']).toHaveBeenCalled();

    const ts = (engine._lastInjectionManifest as Record<string, unknown>)['tag_selection'] as Record<string, unknown>;
    expect(ts['excluded_untagged']).toBe(UNTAGGED_NODES.length);
    for (const n of UNTAGGED_NODES) {
      expect(result).not.toContain(n.id);
    }
  });

  it('scope mode: engine.warn fires when Scope leaves 0 POV nodes selected', async () => {
    const engine = makeEngine({
      seat_tags: { accelerationist: { pov_tag: 'nonexistent-tag', tag_mode: 'scope' } },
    });
    // All nodes are untagged for 'nonexistent-tag' → pool is empty

    await getRelevantTaxonomyContext(engine, 'accelerationist', []);

    expect(engine.warn).toHaveBeenCalledWith(
      expect.stringContaining('nonexistent-tag'),
      null,
      expect.any(String),
    );
  });

  // ── Prioritize mode ──────────────────────────────────────

  it('prioritize mode: manifest records mode and excluded_untagged:0', async () => {
    const engine = makeEngine({
      seat_tags: { accelerationist: { pov_tag: TAG, tag_mode: 'prioritize' } },
    });

    await getRelevantTaxonomyContext(engine, 'accelerationist', []);

    const ts = (engine._lastInjectionManifest as Record<string, unknown>)['tag_selection'] as Record<string, unknown>;
    expect(ts).toBeTruthy();
    expect(ts['tag']).toBe(TAG);
    expect(ts['mode']).toBe('prioritize');
    expect(ts['excluded_untagged']).toBe(0);
  });

  it('prioritize mode: boost displaces an untagged node that was just above the cut', async () => {
    // Two nodes: tagged starts at 0.46, untagged at 0.50 (gap 0.04 < TAG_BOOST_INCREMENT 0.08)
    // After boost: tagged = 0.54 > untagged 0.50 → ordering reversed
    const taggedNode = makeNode('acc-bel-001', [TAG], 'Tagged node');
    const untaggedNode = makeNode('acc-bel-002', [], 'Untagged node');

    const mockScores = new Map([
      ['acc-bel-001', 0.46],
      ['acc-bel-002', 0.50],
    ]);
    vi.spyOn(taxonomyRelevance, 'scoreNodesLexical').mockReturnValueOnce(mockScores);

    const engine = makeEngine({
      seat_tags: { accelerationist: { pov_tag: TAG, tag_mode: 'prioritize' } },
    });
    (engine.taxonomy as Record<string, unknown>)['accelerationist'] = { nodes: [taggedNode, untaggedNode] };

    await getRelevantTaxonomyContext(engine, 'accelerationist', []);

    const scores = engine._lastRelevanceScores!;
    const taggedFinal = scores.get('acc-bel-001')!;
    const untaggedFinal = scores.get('acc-bel-002')!;

    // Tagged node should have received exactly TAG_BOOST_INCREMENT more than its base
    expect(taggedFinal).toBeCloseTo(0.46 + TAG_BOOST_INCREMENT, 5);
    // Untagged node unchanged
    expect(untaggedFinal).toBeCloseTo(0.50, 5);
    // The boost reversed the ordering: tagged (0.54) > untagged (0.50)
    expect(taggedFinal).toBeGreaterThan(untaggedFinal);
  });

  // ── Untagged differential ────────────────────────────────

  it('untagged seats: output is byte-identical whether seat_tags is absent or set only for other POVs', async () => {
    const engineNoTags = makeEngine({});
    // Tags on safetyist only — accelerationist is untagged; must see identical output
    const engineOtherTagged = makeEngine({
      seat_tags: { safetyist: { pov_tag: 'alignment', tag_mode: 'scope' } },
    });

    const resultNoTags = await getRelevantTaxonomyContext(engineNoTags, 'accelerationist', []);
    const resultOtherTagged = await getRelevantTaxonomyContext(engineOtherTagged, 'accelerationist', []);

    expect(resultNoTags).toBe(resultOtherTagged);
  });

  // ── No-tag baseline ──────────────────────────────────────

  it('no-tag baseline: tag_selection absent from manifest', async () => {
    const engine = makeEngine({});

    await getRelevantTaxonomyContext(engine, 'accelerationist', []);

    const manifest = engine._lastInjectionManifest as Record<string, unknown>;
    expect(manifest['tag_selection']).toBeUndefined();
  });

  it('no-tag baseline: scope exclusion count > 0 when tags ARE configured (confirms baseline pool is larger)', async () => {
    const engineTagged = makeEngine({
      seat_tags: { accelerationist: { pov_tag: TAG, tag_mode: 'scope' } },
    });
    await getRelevantTaxonomyContext(engineTagged, 'accelerationist', []);

    const ts = (engineTagged._lastInjectionManifest as Record<string, unknown>)['tag_selection'] as Record<string, unknown>;
    expect((ts['excluded_untagged'] as number)).toBeGreaterThan(0);
  });
});
