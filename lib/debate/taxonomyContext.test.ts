// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { formatTaxonomyContext } from './taxonomyContext.js';
import { formatDebaterEdgeContext } from './debateEngine/taxonomyContext.js';
import type { SituationStatements } from './taxonomyContext.js';
import type { PovNode, SituationNode } from './taxonomyTypes.js';
import type { DebateEngineInternals } from './debateEngine/internals.js';

function makeSit(id: string, label: string, parentId?: string | null): SituationNode {
  return {
    id, label, description: `Desc for ${id}`,
    parent_id: parentId ?? null,
    interpretations: { accelerationist: 'a-interp', safetyist: 's-interp', skeptic: 'k-interp' },
    linked_nodes: [], conflict_ids: [],
  };
}

describe('formatTaxonomyContext — hierarchy-grouped situations', () => {
  it('groups situations by parent category with Lost-in-the-Middle ordering (4 categories)', () => {
    // 4 root categories with 1 child each, scored in descending order
    const nodes = [
      makeSit('sit-A', 'Category A', null),
      makeSit('sit-A1', 'Child A1', 'sit-A'),
      makeSit('sit-B', 'Category B', null),
      makeSit('sit-B1', 'Child B1', 'sit-B'),
      makeSit('sit-C', 'Category C', null),
      makeSit('sit-C1', 'Child C1', 'sit-C'),
      makeSit('sit-D', 'Category D', null),
      makeSit('sit-D1', 'Child D1', 'sit-D'),
    ];

    const nodeScores = new Map<string, number>([
      ['sit-A', 0.90], ['sit-A1', 0.88],  // #1 highest
      ['sit-B', 0.80], ['sit-B1', 0.78],  // #2
      ['sit-C', 0.70], ['sit-C1', 0.68],  // #3
      ['sit-D', 0.60], ['sit-D1', 0.58],  // #4 lowest
    ]);

    const output = formatTaxonomyContext(
      { povNodes: [], situationNodes: nodes, nodeScores },
      'accelerationist',
      50,
    );

    // LitM ordering: #1(A) first, #2(B) last, #3(C) second, #4(D) third
    // So headers should appear in order: A, C, D, B
    const headerPositions = [
      { label: 'Category A', pos: output.indexOf('## Category A') },
      { label: 'Category B', pos: output.indexOf('## Category B') },
      { label: 'Category C', pos: output.indexOf('## Category C') },
      { label: 'Category D', pos: output.indexOf('## Category D') },
    ];

    for (const h of headerPositions) {
      expect(h.pos).toBeGreaterThan(-1);
    }

    // Verify LitM order: A < C < D < B
    expect(headerPositions[0].pos).toBeLessThan(headerPositions[2].pos); // A before C
    expect(headerPositions[2].pos).toBeLessThan(headerPositions[3].pos); // C before D
    expect(headerPositions[3].pos).toBeLessThan(headerPositions[1].pos); // D before B
  });

  it('renders root nodes within their category group', () => {
    const nodes = [
      makeSit('sit-100', 'Root Category', null),
      makeSit('sit-001', 'Child Node', 'sit-100'),
    ];
    const nodeScores = new Map([['sit-100', 0.60], ['sit-001', 0.55]]);
    const output = formatTaxonomyContext(
      { povNodes: [], situationNodes: nodes, nodeScores },
      'accelerationist',
      50,
    );

    // Root node should appear in the output (not dropped)
    expect(output).toContain('[sit-100]');
    expect(output).toContain('[sit-001]');
    expect(output).toContain('## Root Category');
  });

  it('handles null confidence/priority/operationality without throwing (t/1243)', () => {
    const povNodes: PovNode[] = [
      {
        id: 'acc-beliefs-001', label: 'Null-confidence belief', description: 'desc',
        pov: 'accelerationist', category: 'Beliefs', bdi_layer: 'belief',
        parent_id: null, children: [], situation_refs: [],
        confidence: null as unknown as number,
      },
      {
        id: 'acc-desires-001', label: 'Null-priority desire', description: 'desc',
        pov: 'accelerationist', category: 'Desires', bdi_layer: 'desire',
        parent_id: null, children: [], situation_refs: [],
        priority: null as unknown as number,
      },
      {
        id: 'acc-intentions-001', label: 'Null-operationality intention', description: 'desc',
        pov: 'accelerationist', category: 'Intentions', bdi_layer: 'intention',
        parent_id: null, children: [], situation_refs: [],
        operationality: null as unknown as number,
      },
    ];
    const nodeScores = new Map([
      ['acc-beliefs-001', 0.8], ['acc-desires-001', 0.7], ['acc-intentions-001', 0.6],
    ]);

    expect(() => formatTaxonomyContext(
      { povNodes, situationNodes: [], nodeScores },
      'accelerationist',
      50,
    )).not.toThrow();

    const output = formatTaxonomyContext(
      { povNodes, situationNodes: [], nodeScores },
      'accelerationist',
      50,
    );
    expect(output).toContain('[acc-beliefs-001]');
    expect(output).not.toContain('confidence:');
    expect(output).not.toContain('priority:');
    expect(output).not.toContain('operationality:');
  });

  it('falls back to flat rendering when nodes lack parent_id', () => {
    const nodes = [
      makeSit('sit-001', 'Flat Node A', null),
      makeSit('sit-002', 'Flat Node B', null),
    ];
    // Remove parent_id to simulate legacy data
    delete (nodes[0] as Record<string, unknown>).parent_id;
    delete (nodes[1] as Record<string, unknown>).parent_id;

    const nodeScores = new Map([['sit-001', 0.60], ['sit-002', 0.55]]);
    const output = formatTaxonomyContext(
      { povNodes: [], situationNodes: nodes, nodeScores },
      'accelerationist',
      50,
    );

    // Should render without category headers
    expect(output).toContain('[sit-001]');
    expect(output).toContain('[sit-002]');
    expect(output).not.toContain('## ');
  });
});

describe('formatTaxonomyContext — flag-gated situation register-statement injection (t/1450)', () => {
  // Sidecar-shaped statements keyed by situation id, with own-POV (accelerationist)
  // and opponent-POV (safetyist/skeptic) blocks carrying distinctive markers so we
  // can assert own-only injection.
  const statements: SituationStatements = {
    'sit-100': {
      ok: true,
      statements: {
        accelerationist: {
          belief_statement: 'ACC-BELIEF-MARKER',
          desire_statement: 'ACC-DESIRE-MARKER',
          intention_statement: 'ACC-INTENTION-MARKER',
        },
        safetyist: {
          belief_statement: 'SAF-BELIEF-MARKER',
          desire_statement: 'SAF-DESIRE-MARKER',
          intention_statement: 'SAF-INTENTION-MARKER',
        },
        skeptic: {
          belief_statement: 'SKP-BELIEF-MARKER',
          desire_statement: 'SKP-DESIRE-MARKER',
          intention_statement: 'SKP-INTENTION-MARKER',
        },
      },
    },
  };

  function fixture(): { povNodes: PovNode[]; situationNodes: SituationNode[]; nodeScores: Map<string, number> } {
    const nodes = [
      makeSit('sit-100', 'Root Category', null),
      makeSit('sit-001', 'Child Node', 'sit-100'),
    ];
    const nodeScores = new Map([['sit-100', 0.60], ['sit-001', 0.55]]);
    return { povNodes: [], situationNodes: nodes, nodeScores };
  }

  it('flag off (no situationStatements config) leaves output free of register statements (AC2)', () => {
    const output = formatTaxonomyContext(fixture(), 'accelerationist', undefined);
    expect(output).toContain('[sit-100]');
    expect(output).not.toContain('Register statements (your voice):');
    expect(output).not.toContain('ACC-BELIEF-MARKER');
  });

  it('flag on injects own-POV BDI-labeled statements only, never opponents (AC2)', () => {
    const output = formatTaxonomyContext(
      fixture(),
      'accelerationist',
      undefined,
      { situationStatements: statements },
    );

    // Own-POV register block, BDI-labeled.
    expect(output).toContain('Register statements (your voice):');
    expect(output).toContain('Belief: ACC-BELIEF-MARKER');
    expect(output).toContain('Desire: ACC-DESIRE-MARKER');
    expect(output).toContain('Intention: ACC-INTENTION-MARKER');

    // Opponents' register statements must never be injected.
    expect(output).not.toContain('SAF-BELIEF-MARKER');
    expect(output).not.toContain('SAF-DESIRE-MARKER');
    expect(output).not.toContain('SAF-INTENTION-MARKER');
    expect(output).not.toContain('SKP-BELIEF-MARKER');
    expect(output).not.toContain('SKP-DESIRE-MARKER');
    expect(output).not.toContain('SKP-INTENTION-MARKER');
  });

  it('empty sidecar ({}) is a silent no-op (AC1)', () => {
    const output = formatTaxonomyContext(
      fixture(),
      'accelerationist',
      undefined,
      { situationStatements: {} },
    );
    expect(output).toContain('[sit-100]');
    expect(output).not.toContain('Register statements (your voice):');
  });

  it('entry with ok:false is skipped (AC1)', () => {
    const output = formatTaxonomyContext(
      fixture(),
      'accelerationist',
      undefined,
      { situationStatements: { 'sit-100': { ok: false, statements: statements['sit-100'].statements } } },
    );
    expect(output).not.toContain('Register statements (your voice):');
    expect(output).not.toContain('ACC-BELIEF-MARKER');
  });
});

function makeNode(id: string, label: string, desc: string, verificationStatus?: 'curated' | 'ai-retrieved' | 'unverified'): PovNode {
  return {
    id, category: 'Beliefs', label, description: desc,
    parent_id: null, children: [], situation_refs: [],
    graph_attributes: verificationStatus ? { verification_status: verificationStatus } : undefined,
  };
}

describe('formatTaxonomyContext — RETRIEVED CONTEXT block (t/3264)', () => {
  it('renders no RETRIEVED CONTEXT block when all nodes are curated (absent verification_status)', () => {
    const ctx = {
      povNodes: [makeNode('acc-bel-001', 'Curated Node', 'curated desc')],
      situationNodes: [],
    };
    const output = formatTaxonomyContext(ctx, 'accelerationist');
    expect(output).not.toContain('RETRIEVED CONTEXT');
  });

  it('routes ai-retrieved node to RETRIEVED CONTEXT block, not grounding block (AC1)', () => {
    const ctx = {
      povNodes: [
        makeNode('acc-bel-001', 'Curated Node', 'curated desc'),
        makeNode('acc-bel-002', 'Retrieved Node', 'retrieved desc', 'ai-retrieved'),
      ],
      situationNodes: [],
    };
    const output = formatTaxonomyContext(ctx, 'accelerationist');
    expect(output).toContain('RETRIEVED CONTEXT');
    expect(output).toContain('acc-bel-002');
    expect(output).toContain('ai-retrieved');
    // Grounding block should contain curated but not retrieved node
    const groundingSection = output.split('RETRIEVED CONTEXT')[0];
    expect(groundingSection).toContain('acc-bel-001');
    expect(groundingSection).not.toContain('acc-bel-002');
  });

  it('routes unverified node to RETRIEVED CONTEXT block', () => {
    const ctx = {
      povNodes: [makeNode('acc-bel-003', 'Unverified Node', 'unverified desc', 'unverified')],
      situationNodes: [],
    };
    const output = formatTaxonomyContext(ctx, 'accelerationist');
    expect(output).toContain('RETRIEVED CONTEXT');
    expect(output).toContain('acc-bel-003');
    expect(output).toContain('unverified');
  });

  it('keeps curated nodes (explicit) in grounding block only', () => {
    const ctx = {
      povNodes: [makeNode('acc-bel-004', 'Explicit Curated', 'curated desc', 'curated')],
      situationNodes: [],
    };
    const output = formatTaxonomyContext(ctx, 'accelerationist');
    expect(output).not.toContain('RETRIEVED CONTEXT');
    expect(output).toContain('acc-bel-004');
  });

  it('retrievedContextEnabled:false disables the split — all nodes go to grounding block', () => {
    const ctx = {
      povNodes: [
        makeNode('acc-bel-001', 'Curated', 'curated desc'),
        makeNode('acc-bel-002', 'Retrieved', 'retrieved desc', 'ai-retrieved'),
      ],
      situationNodes: [],
    };
    const output = formatTaxonomyContext(ctx, 'accelerationist', undefined, { retrievedContextEnabled: false });
    expect(output).not.toContain('RETRIEVED CONTEXT');
    expect(output).toContain('acc-bel-001');
    expect(output).toContain('acc-bel-002');
  });

  it('RETRIEVED CONTEXT block appears after BDI grounding section and before SITUATIONS', () => {
    const ctx = {
      povNodes: [makeNode('acc-bel-002', 'Retrieved', 'retrieved desc', 'ai-retrieved')],
      situationNodes: [makeSit('sit-001', 'Test Situation')],
    };
    const output = formatTaxonomyContext(ctx, 'accelerationist');
    const retrievedIdx = output.indexOf('RETRIEVED CONTEXT');
    const situationsIdx = output.indexOf('SITUATIONS');
    expect(retrievedIdx).toBeGreaterThan(-1);
    expect(situationsIdx).toBeGreaterThan(retrievedIdx);
  });
});

function makeAnnotatedNode(id: string, label: string): PovNode {
  return {
    id, category: 'Beliefs', label, description: 'desc',
    parent_id: null, children: [], situation_refs: [],
    graph_attributes: { epistemic_type: 'empirical_claim', steelman_vulnerability: 'key vulnerability here' },
  };
}

describe('formatTaxonomyContext — classification default-drop (t/3269)', () => {
  it('absent verification_status drops classification guidance (default-drop)', () => {
    const ctx = { povNodes: [makeAnnotatedNode('acc-bel-020', 'No Status')], situationNodes: [] };
    const output = formatTaxonomyContext(ctx, 'accelerationist');
    expect(output).not.toContain('ARGUE:');
    expect(output).not.toContain('VULNERABLE:');
    expect(output).toContain('[acc-bel-020]');
  });

  it('verification_status=curated drops classification guidance (all classifications AI-generated)', () => {
    const node: PovNode = { ...makeAnnotatedNode('acc-bel-021', 'Curated'), graph_attributes: { epistemic_type: 'empirical_claim', steelman_vulnerability: 'sv', verification_status: 'curated' } };
    const ctx = { povNodes: [node], situationNodes: [] };
    const output = formatTaxonomyContext(ctx, 'accelerationist');
    expect(output).not.toContain('ARGUE:');
    expect(output).not.toContain('VULNERABLE:');
    expect(output).toContain('[acc-bel-021]');
  });

  it('verification_status=ai-retrieved drops classification guidance (default-drop)', () => {
    const node: PovNode = { ...makeAnnotatedNode('acc-bel-022', 'AI-Retrieved'), graph_attributes: { epistemic_type: 'empirical_claim', steelman_vulnerability: 'sv', verification_status: 'ai-retrieved' } };
    const ctx = { povNodes: [node], situationNodes: [] };
    const output = formatTaxonomyContext(ctx, 'accelerationist');
    expect(output).not.toContain('ARGUE:');
    expect(output).not.toContain('VULNERABLE:');
    expect(output).toContain('[acc-bel-022]');
  });

  it('verification_status=unverified drops classification guidance (default-drop)', () => {
    const node: PovNode = { ...makeAnnotatedNode('acc-bel-023', 'Unverified'), graph_attributes: { epistemic_type: 'empirical_claim', steelman_vulnerability: 'sv', verification_status: 'unverified' } };
    const ctx = { povNodes: [node], situationNodes: [] };
    const output = formatTaxonomyContext(ctx, 'accelerationist');
    expect(output).not.toContain('ARGUE:');
    expect(output).not.toContain('VULNERABLE:');
    expect(output).toContain('[acc-bel-023]');
  });
});

function makeTagNode(id: string, label: string, category: 'Beliefs' | 'Desires' | 'Intentions' = 'Beliefs'): PovNode {
  return { id, label, category, description: `desc for ${id}`, parent_id: null, children: [], situation_refs: [] };
}

describe('formatTaxonomyContext — tagSelection (t/3996)', () => {
  it('tagged nodes receive ▲ prefix and appear before untagged nodes', () => {
    const tagged = makeTagNode('acc-bel-100', 'Tagged Node');
    const untagged = makeTagNode('acc-bel-101', 'Untagged Node');
    const ctx = { povNodes: [untagged, tagged], situationNodes: [] };
    const output = formatTaxonomyContext(ctx, 'accelerationist', undefined, {
      tagSelection: { taggedIds: new Set(['acc-bel-100']), mode: 'prioritize' },
    });
    expect(output).toContain('▲ [acc-bel-100]');
    expect(output).not.toContain('▲ [acc-bel-101]');
    const taggedIdx = output.indexOf('▲ [acc-bel-100]');
    const untaggedIdx = output.indexOf('acc-bel-101');
    expect(taggedIdx).toBeLessThan(untaggedIdx);
  });

  it('legend shows ▲ = tagged for this seat when tagSelection is set', () => {
    const ctx = { povNodes: [makeTagNode('acc-bel-102', 'A Node')], situationNodes: [] };
    const output = formatTaxonomyContext(ctx, 'accelerationist', undefined, {
      tagSelection: { taggedIds: new Set(['acc-bel-102']), mode: 'prioritize' },
    });
    expect(output).toContain('▲ = tagged for this seat');
  });

  it('tagged node gets full detail (isPrimary behavior)', () => {
    const nodes = Array.from({ length: 5 }, (_, i) =>
      makeTagNode(`acc-bel-11${i}`, `Node ${i}`)
    );
    const ctx = { povNodes: nodes, situationNodes: [] };
    const output = formatTaxonomyContext(ctx, 'accelerationist', undefined, {
      tagSelection: { taggedIds: new Set(['acc-bel-114']), mode: 'prioritize' },
      primaryCount: 1,
    });
    // acc-bel-114 is tagged — must show full label/description line
    expect(output).toMatch(/▲ \[acc-bel-114\]/);
    expect(output).toContain('"Node 4"');
  });

  it('without tagSelection: output is unchanged (no ▲, no legend)', () => {
    const ctx = { povNodes: [makeTagNode('acc-bel-120', 'Plain Node')], situationNodes: [] };
    const output = formatTaxonomyContext(ctx, 'accelerationist');
    expect(output).not.toContain('▲');
    expect(output).not.toContain('tagged for this seat');
  });

  it('tagSelection and nodeScores coexist: tagged sort first, both legends shown', () => {
    const tagged = makeTagNode('acc-bel-130', 'Tagged');
    const highScore = makeTagNode('acc-bel-131', 'High Score');
    const lowScore = makeTagNode('acc-bel-132', 'Low Score');
    const ctx = {
      povNodes: [highScore, lowScore, tagged],
      situationNodes: [],
      nodeScores: new Map([['acc-bel-130', 0.1], ['acc-bel-131', 0.9], ['acc-bel-132', 0.2]]),
    };
    const output = formatTaxonomyContext(ctx, 'accelerationist', undefined, {
      tagSelection: { taggedIds: new Set(['acc-bel-130']), mode: 'prioritize' },
      primaryCount: 1,
    });
    expect(output).toContain('▲ [acc-bel-130]');
    expect(output).toContain('▲ = tagged for this seat');
    expect(output).toContain('★ = most relevant to current topic');
    // tagged comes before highScore
    const taggedIdx = output.indexOf('[acc-bel-130]');
    const highIdx = output.indexOf('[acc-bel-131]');
    expect(taggedIdx).toBeLessThan(highIdx);
  });
});

// ── C1 edge-default: consumer-level proof (t/4354) ───────────────────────────

describe('formatDebaterEdgeContext — edges default is selectable-only (t/4354 C1)', () => {
  function makeEngine(edgeArray: { source: string; target: string; type: string; bidirectional: boolean; confidence: number; status: string; discovered_at: string; model: string }[]): DebateEngineInternals {
    return {
      taxonomy: {
        edges: { _schema_version: '1', _doc: '', last_modified: '', edge_types: [], edges: edgeArray },
      },
    } as unknown as DebateEngineInternals;
  }

  it('never emits a superseded-endpoint ID when edges contains only selectable edges', () => {
    // loadTaxonomy already removed the superseded-endpoint edge from edges.
    // This confirms the consumer (formatDebaterEdgeContext) only ever sees the selectable set.
    const selectableEdge = { source: 'acc-beliefs-001', target: 'saf-beliefs-001', type: 'CONTRADICTS', bidirectional: false, confidence: 0.9, status: 'approved', discovered_at: '', model: 'test' };
    const engine = makeEngine([selectableEdge]);
    const { text } = formatDebaterEdgeContext(engine, 'accelerationist');
    expect(text).not.toContain('acc-beliefs-RETIRED');
    expect(text).toContain('acc-beliefs-001');
  });
});
