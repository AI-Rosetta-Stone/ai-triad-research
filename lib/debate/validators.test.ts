import { describe, it, expect, beforeEach } from 'vitest';
import { checkEdgeDomainRange, checkReferentialIntegrity, checkBdiConsistency, validateTaxonomy } from './validators.js';
import { setCcToSitMapping } from './ccSitMapping.js';
import type { Edge } from './taxonomyTypes.js';

function makeEdge(overrides: Partial<Edge> = {}): Edge {
  return {
    source: 'acc-desires-001',
    target: 'acc-desires-002',
    type: 'SUPPORTS',
    bidirectional: false,
    confidence: 0.9,
    rationale: 'test edge',
    status: 'approved',
    discovered_at: '2026-01-01',
    model: 'test-model',
    ...overrides,
  };
}

describe('checkEdgeDomainRange', () => {
  const allNodeIds = new Set(['acc-desires-001', 'acc-desires-002', 'saf-beliefs-001', 'sit-001', 'skp-intentions-001']);
  const situationIds = new Set(['sit-001']);

  it('accepts canonical edge types without issues', () => {
    const edges: Edge[] = [
      makeEdge({ type: 'SUPPORTS' }),
      makeEdge({ type: 'CONTRADICTS' }),
      makeEdge({ type: 'WEAKENS' }),
      makeEdge({ type: 'ASSUMES' }),
      makeEdge({ type: 'RESPONDS_TO' }),
      makeEdge({ source: 'acc-desires-001', target: 'saf-beliefs-001', type: 'TENSION_WITH' }),
      makeEdge({ source: 'acc-desires-001', target: 'sit-001', type: 'INTERPRETS' }),
      makeEdge({ source: 'acc-desires-001', target: 'sit-001', type: 'CONVERGES_WITH' }),
    ];
    const result = checkEdgeDomainRange(edges, allNodeIds, situationIds);
    const unknowns = result.issues.filter(i => i.code === 'UNKNOWN_EDGE_TYPE');
    expect(unknowns).toHaveLength(0);
  });

  it('warns on unknown edge type', () => {
    const edges: Edge[] = [
      makeEdge({ type: 'MOTIVATES' as Edge['type'] }),
    ];
    const result = checkEdgeDomainRange(edges, allNodeIds, situationIds);
    expect(result.valid).toBe(true);
    const unknowns = result.issues.filter(i => i.code === 'UNKNOWN_EDGE_TYPE');
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0].severity).toBe('warning');
    expect(unknowns[0].message).toContain('MOTIVATES');
    expect(unknowns[0].message).toContain('canonical 8-type vocabulary');
    expect(unknowns[0].fix).toContain('Reclassify');
  });

  it('warns on multiple unknown edge types', () => {
    const edges: Edge[] = [
      makeEdge({ type: 'CONTRIBUES_TO' as Edge['type'] }),
      makeEdge({ type: 'IS_A' as Edge['type'] }),
      makeEdge({ type: 'SUPPORTS' }),
    ];
    const result = checkEdgeDomainRange(edges, allNodeIds, situationIds);
    const unknowns = result.issues.filter(i => i.code === 'UNKNOWN_EDGE_TYPE');
    expect(unknowns).toHaveLength(2);
  });

  it('unknown edge type is warning, not error — does not invalidate result', () => {
    const edges: Edge[] = [makeEdge({ type: 'FAKE_TYPE' as Edge['type'] })];
    const result = checkEdgeDomainRange(edges, allNodeIds, situationIds);
    expect(result.valid).toBe(true);
  });

  it('warns on INTERPRETS targeting non-situation node', () => {
    const edges: Edge[] = [
      makeEdge({ type: 'INTERPRETS', source: 'acc-desires-001', target: 'saf-beliefs-001' }),
    ];
    const result = checkEdgeDomainRange(edges, allNodeIds, situationIds);
    const issues = result.issues.filter(i => i.code === 'INTERPRETS_NON_SITUATION');
    expect(issues).toHaveLength(1);
  });

  it('warns on same-POV TENSION_WITH', () => {
    const edges: Edge[] = [
      makeEdge({ type: 'TENSION_WITH', source: 'acc-desires-001', target: 'acc-desires-002' }),
    ];
    const result = checkEdgeDomainRange(edges, allNodeIds, situationIds);
    const issues = result.issues.filter(i => i.code === 'SAME_POV_TENSION');
    expect(issues).toHaveLength(1);
  });

  it('warns on cross-POV SUPPORTS', () => {
    const edges: Edge[] = [
      makeEdge({ type: 'SUPPORTS', source: 'acc-desires-001', target: 'saf-beliefs-001' }),
    ];
    const result = checkEdgeDomainRange(edges, allNodeIds, situationIds);
    const issues = result.issues.filter(i => i.code === 'CROSS_POV_SUPPORT_CONTRADICT');
    expect(issues).toHaveLength(1);
  });

  it('skips edges with dangling references', () => {
    const edges: Edge[] = [
      makeEdge({ type: 'FAKE_TYPE' as Edge['type'], source: 'nonexistent-001', target: 'acc-desires-001' }),
    ];
    const result = checkEdgeDomainRange(edges, allNodeIds, situationIds);
    expect(result.issues).toHaveLength(0);
  });
});

describe('checkBdiConsistency', () => {
  it('warns on bdi_layer/resolvability mismatch', () => {
    const result = checkBdiConsistency([
      { point: 'test', bdi_layer: 'belief', resolvability: 'negotiable_via_tradeoffs' },
    ]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('BDI_RESOLVABILITY_MISMATCH');
  });

  it('passes when bdi_layer/resolvability align', () => {
    const result = checkBdiConsistency([
      { point: 'test', bdi_layer: 'belief', resolvability: 'resolvable_by_evidence' },
    ]);
    expect(result.issues).toHaveLength(0);
  });

  it('skips entries without bdi_layer or resolvability', () => {
    const result = checkBdiConsistency([
      { point: 'test' },
      { point: 'test2', bdi_layer: 'belief' },
    ]);
    expect(result.issues).toHaveLength(0);
  });
});

describe('checkReferentialIntegrity', () => {
  const baseTaxonomy = {
    accelerationist: { nodes: [{ id: 'acc-desires-001', parent_id: null, children: [], situation_refs: [] }] },
    safetyist: { nodes: [] },
    skeptic: { nodes: [] },
    situations: { nodes: [{ id: 'sit-001', linked_nodes: [] }] },
    edges: [],
  };

  it('detects dangling edge source', () => {
    const data = {
      ...baseTaxonomy,
      edges: [makeEdge({ source: 'nonexistent-001', target: 'acc-desires-001' })],
    };
    // @ts-expect-error — simplified test data
    const result = checkReferentialIntegrity(data);
    const issues = result.issues.filter(i => i.code === 'EDGE_DANGLING_SOURCE');
    expect(issues).toHaveLength(1);
  });

  it('detects dangling edge target', () => {
    const data = {
      ...baseTaxonomy,
      edges: [makeEdge({ source: 'acc-desires-001', target: 'nonexistent-002' })],
    };
    // @ts-expect-error — simplified test data
    const result = checkReferentialIntegrity(data);
    const issues = result.issues.filter(i => i.code === 'EDGE_DANGLING_TARGET');
    expect(issues).toHaveLength(1);
  });

  it('accepts cc- IDs in situation_refs when mapping is loaded', () => {
    // Set up the cc-to-sit mapping
    setCcToSitMapping({ 'cc-001': 'sit-001', 'cc-002': 'sit-002' });

    const data = {
      ...baseTaxonomy,
      accelerationist: {
        nodes: [
          { id: 'acc-desires-001', parent_id: null, children: [], situation_refs: ['cc-001'] },
          { id: 'acc-desires-002', parent_id: null, children: [], situation_refs: ['cc-002', 'sit-001'] },
        ],
      },
    };
    // @ts-expect-error — simplified test data
    const result = checkReferentialIntegrity(data);
    const ccIssues = result.issues.filter(i => i.code === 'DANGLING_SITUATION_REF');
    expect(ccIssues).toHaveLength(0);
  });

  it('rejects unknown IDs in situation_refs even with cc mapping loaded', () => {
    setCcToSitMapping({ 'cc-001': 'sit-001' });

    const data = {
      ...baseTaxonomy,
      accelerationist: {
        nodes: [
          { id: 'acc-desires-001', parent_id: null, children: [], situation_refs: ['unknown-999'] },
        ],
      },
    };
    // @ts-expect-error — simplified test data
    const result = checkReferentialIntegrity(data);
    const issues = result.issues.filter(i => i.code === 'DANGLING_SITUATION_REF');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('unknown-999');
  });
});
