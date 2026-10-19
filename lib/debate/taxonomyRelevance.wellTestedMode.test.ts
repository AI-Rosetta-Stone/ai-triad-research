// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Exclude-well-tested mode (the `exclude_greatest_hits` flag): well-tested hard exclusion wired into
// both selection paths, the under-tested boost, and the `testing_selection` manifest summary.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  selectRelevantNodes,
  excludeWellTestedModeOptions,
  summarizeTestingSelection,
  type ScoredPovNode,
  type UnderTestedBoostResult,
  type LineageBoostResult,
} from './taxonomyRelevance.js';
import { selectRelevantTaxonomy, type NodeEmbeddingMap } from './relevanceSelection.js';
import { UNDER_TESTED_BOOST } from './debateTested.js';
import type { PovNode, Category, DebateTestedTier } from './taxonomyTypes.js';

const NOW = new Date('2026-07-30');

function makeNode(id: string, category: Category = 'Beliefs', tier?: DebateTestedTier): PovNode {
  const node = { id, label: `Node ${id}`, description: `Description for ${id}`, category } as PovNode;
  if (!tier) return node;
  // Two challenger camps + recent test → a well_tested node is NOT re-eligible at NOW.
  return {
    ...node,
    graph_attributes: {
      debate_tested: {
        tier, sort_key: 3.5, engagements: 5, challenges: 5, held: 5, weakened: 0, revisions: [],
        last_tested: '2026-07-29', description_hash: 'abc',
        record: [
          { debate_id: 'd1', date: '2026-07-10', pipeline_version: '1.0', verdict: 'held',
            strongest_attack_encountered: { claim_id: 'c1', strength: 0.8, scheme: 'ad_rem', challenger_camp: 'safetyist' },
            claim_outcomes: { thrived: 1, survived: 0, died: 0 }, concession: null },
          { debate_id: 'd2', date: '2026-07-20', pipeline_version: '1.0', verdict: 'held',
            strongest_attack_encountered: { claim_id: 'c2', strength: 0.7, scheme: 'ad_rem', challenger_camp: 'skeptic' },
            claim_outcomes: { thrived: 1, survived: 0, died: 0 }, concession: null },
        ],
      },
    },
  } as unknown as PovNode;
}

const ids = (r: ScoredPovNode[]) => r.map(s => s.node.id);
const boostDiag = (r: ScoredPovNode[]) => (r as ScoredPovNode[] & { _underTestedBoost?: UnderTestedBoostResult })._underTestedBoost;

describe('selectRelevantNodes — underTestedBoost', () => {
  const base = { threshold: 0.5, minPerCategory: 0, minPerPov: 0 };

  it('promotes a near-miss untested node over an equally scored contested node', () => {
    const nodes = [makeNode('acc-beliefs-001', 'Beliefs', 'contested'), makeNode('acc-beliefs-002')];
    const scores = new Map([['acc-beliefs-001', 0.47], ['acc-beliefs-002', 0.47]]);
    const result = selectRelevantNodes(nodes, scores, { ...base, underTestedBoost: {} });
    expect(ids(result)).toEqual(['acc-beliefs-002']);
    expect(result[0].score).toBeCloseTo(0.47 + UNDER_TESTED_BOOST.MAX_BOOST, 6);
    expect(boostDiag(result)!.promotedNodeIds).toEqual(['acc-beliefs-002']);
  });

  it('boosts cited nodes by the 0.7 deficit weight', () => {
    const nodes = [makeNode('acc-beliefs-001', 'Beliefs', 'cited')];
    const result = selectRelevantNodes(nodes, new Map([['acc-beliefs-001', 0.6]]), { ...base, underTestedBoost: {} });
    expect(result[0].score).toBeCloseTo(0.6 + UNDER_TESTED_BOOST.MAX_BOOST * 0.7, 6);
  });

  it('does not boost nodes below the near-miss window, nor contested/well_tested nodes', () => {
    const nodes = [
      makeNode('acc-beliefs-001'),
      makeNode('acc-beliefs-002', 'Beliefs', 'contested'),
      makeNode('acc-beliefs-003', 'Beliefs', 'well_tested'),
    ];
    const scores = new Map([['acc-beliefs-001', 0.43], ['acc-beliefs-002', 0.6], ['acc-beliefs-003', 0.6]]);
    const result = selectRelevantNodes(nodes, scores, { ...base, underTestedBoost: {} });
    expect(boostDiag(result)!.boostedNodeIds).toEqual([]);
    expect(ids(result)).not.toContain('acc-beliefs-001');
  });

  it('is inert when the option is absent', () => {
    const nodes = [makeNode('acc-beliefs-001')];
    const result = selectRelevantNodes(nodes, new Map([['acc-beliefs-001', 0.6]]), base);
    expect(result[0].score).toBe(0.6);
    expect(boostDiag(result)).toBeUndefined();
  });
});

describe('selectRelevantNodes — exclude-well-tested mode options', () => {
  it('excludes well_tested nodes and boosts under-tested ones', () => {
    const nodes = [
      makeNode('acc-beliefs-001', 'Beliefs', 'well_tested'),
      makeNode('acc-beliefs-002', 'Beliefs', 'contested'),
      makeNode('acc-beliefs-003'),
    ];
    const scores = new Map([['acc-beliefs-001', 0.9], ['acc-beliefs-002', 0.55], ['acc-beliefs-003', 0.52]]);
    const result = selectRelevantNodes(nodes, scores, {
      threshold: 0.5, minPerCategory: 3, minPerPov: 2, ...excludeWellTestedModeOptions(NOW),
    });
    expect(ids(result)).toEqual(['acc-beliefs-003', 'acc-beliefs-002']);

    const summary = summarizeTestingSelection(result)!;
    expect(summary.well_tested_excluded).toBe(1);
    expect(summary.well_tested_excluded_ids).toEqual(['acc-beliefs-001']);
    expect(summary.under_tested_boosted).toBe(1);
    expect(summary.selected_tiers).toEqual({ untested: 1, contested: 1 });
  });

  it('summary is undefined when the mode is off', () => {
    const result = selectRelevantNodes([makeNode('acc-beliefs-001')], new Map([['acc-beliefs-001', 0.9]]), { threshold: 0.5 });
    expect(summarizeTestingSelection(result)).toBeUndefined();
  });

  it('diagnostics survive the exclusion-ratio filter rebuilding the result array', () => {
    const nodes = [makeNode('acc-beliefs-001'), makeNode('acc-beliefs-002')];
    const scores = new Map([['acc-beliefs-001', 0.8], ['acc-beliefs-002', 0.8]]);
    const query = [1, 0, 0];
    const nodeEmbeddings = {
      // 001 passes (exclusion vector orthogonal to the query); 002 is demoted (exclusion vector == query).
      'acc-beliefs-001': { pov: 'accelerationist', vector: [1, 0, 0], exclusion_vector: [0, 1, 0] },
      'acc-beliefs-002': { pov: 'accelerationist', vector: [0.6, 0.8, 0], exclusion_vector: [1, 0, 0] },
    };
    const result = selectRelevantNodes(nodes, scores, {
      threshold: 0.5, minPerCategory: 0, minPerPov: 0, nodeEmbeddings, queryVector: query,
      underTestedBoost: {},
      lineageBoost: { traditions: ['t1'], boost: 0.08, lineageByNode: { 'acc-beliefs-001': ['n'] }, nameToCluster: { n: 't1' } },
    });
    expect(ids(result)).toEqual(['acc-beliefs-001']);
    expect(boostDiag(result)).toBeDefined();
    expect((result as ScoredPovNode[] & { _lineageBoost?: LineageBoostResult })._lineageBoost).toBeDefined();
  });
});

describe('selectRelevantTaxonomy — exclude-well-tested mode (app/server path)', () => {
  // selectRelevantTaxonomy calls excludeWellTestedModeOptions() with no `now`, falling back to
  // new Date(). Pin the clock to NOW so the well_tested fixture never ages past re-eligibility.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());

  const povNodes = [
    makeNode('acc-beliefs-001', 'Beliefs', 'well_tested'),
    makeNode('acc-beliefs-002', 'Beliefs', 'contested'),
    makeNode('acc-desires-001', 'Desires'),
  ];
  const nodeEmbeddings: NodeEmbeddingMap = {
    'acc-beliefs-001': { pov: 'accelerationist', vector: [1, 0, 0] },
    'acc-beliefs-002': { pov: 'accelerationist', vector: [0.9, 0.3, 0] },
    'acc-desires-001': { pov: 'accelerationist', vector: [0.8, 0.5, 0] },
  };
  const run = (session: { excludeGreatestHits?: boolean; greatestHitsList?: string[] }) => selectRelevantTaxonomy({
    povNodes, situationNodes: [], policyRegistry: [], nodeEmbeddings,
    session: { anClaimEmbeddings: [], ...session },
    params: { pov: 'accelerationist', topic: 't', recentTranscript: '' },
    embed: async (texts) => texts.map(() => [1, 0, 0]),
  });

  it('excludes well_tested nodes even when no greatest-hits list is passed', async () => {
    const result = await run({ excludeGreatestHits: true });
    expect(result.povNodes.map(n => n.nodeId)).not.toContain('acc-beliefs-001');
    const ts = result.injectionManifest.testing_selection as { well_tested_excluded: number };
    expect(ts.well_tested_excluded).toBe(1);
  });

  it('unions the curated greatest-hits list with the tier exclusion', async () => {
    const result = await run({ excludeGreatestHits: true, greatestHitsList: ['acc-beliefs-002'] });
    expect(result.povNodes.map(n => n.nodeId)).toEqual(['acc-desires-001']);
  });

  it('leaves selection and manifest untouched when the flag is off', async () => {
    const result = await run({ excludeGreatestHits: false, greatestHitsList: ['acc-beliefs-002'] });
    expect(result.povNodes.map(n => n.nodeId)).toContain('acc-beliefs-001');
    expect(result.povNodes.map(n => n.nodeId)).toContain('acc-beliefs-002');
    expect(result.injectionManifest.testing_selection).toBeUndefined();
  });
});
