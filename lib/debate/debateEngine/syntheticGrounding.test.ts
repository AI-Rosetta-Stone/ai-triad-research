import { describe, it, expect } from 'vitest';
import { selectSyntheticGroundedPovNodes } from './syntheticGrounding.js';
import type { PovNode } from '../taxonomyTypes.js';

const node = (id: string, category: string): PovNode =>
  ({ id, category, label: id, description: `DOLCE ${id}` }) as unknown as PovNode;

const QUERY = [1, 0];

describe('selectSyntheticGroundedPovNodes (t/412)', () => {
  it('uses the best-matching synthetic statement per node, never the description', () => {
    const a = node('acc-data-001', 'data');
    const r = selectSyntheticGroundedPovNodes({
      selected: [{ node: a, score: 0.9 }],
      pool: [{ node: a, score: 0.9 }],
      queryVector: QUERY,
      nodeVectors: { 'acc-data-001': { vectors: [[0, 1], [1, 0]] } },
      nodeStatements: { 'acc-data-001': ['off-topic', 'on-topic'] },
    });
    expect(r.nodes.map(n => n.id)).toEqual(['acc-data-001']);
    expect(r.overrides.get('acc-data-001')).toBe('on-topic');
    expect(r.overrides.get('acc-data-001')).not.toContain('DOLCE');
    expect(r.skipped).toEqual([]);
  });

  it('skips a node with no usable statement and backfills from the next-scored node in its category', () => {
    const a = node('acc-data-001', 'data');
    const b = node('acc-data-002', 'data');
    const c = node('acc-data-003', 'data');
    const other = node('acc-goals-001', 'goals');
    const r = selectSyntheticGroundedPovNodes({
      selected: [{ node: a, score: 0.9 }, { node: other, score: 0.8 }],
      pool: [
        { node: a, score: 0.9 },
        { node: other, score: 0.8 },
        { node: c, score: 0.5 },
        { node: b, score: 0.7 },
      ],
      queryVector: QUERY,
      nodeVectors: {
        'acc-data-002': { vectors: [[1, 0]] },
        'acc-data-003': { vectors: [[1, 0]] },
        'acc-goals-001': { vectors: [[1, 0]] },
      },
      nodeStatements: {
        'acc-data-002': ['b-statement'],
        'acc-data-003': ['c-statement'],
        'acc-goals-001': ['g-statement'],
      },
    });
    expect(r.skipped).toEqual(['acc-data-001']);
    expect(r.backfilled).toEqual(['acc-data-002']);
    expect(r.nodes.map(n => n.id)).toEqual(['acc-goals-001', 'acc-data-002']);
    expect(r.overrides.has('acc-data-001')).toBe(false);
    expect([...r.overrides.values()]).not.toContain('DOLCE acc-data-001');
  });

  it('treats a blank statement as unusable and does not backfill from another category', () => {
    const a = node('skp-risk-001', 'risk');
    const r = selectSyntheticGroundedPovNodes({
      selected: [{ node: a, score: 0.9 }],
      pool: [{ node: a, score: 0.9 }, { node: node('skp-data-001', 'data'), score: 0.4 }],
      queryVector: QUERY,
      nodeVectors: { 'skp-risk-001': { vectors: [[1, 0]] }, 'skp-data-001': { vectors: [[1, 0]] } },
      nodeStatements: { 'skp-risk-001': ['   '], 'skp-data-001': ['data-statement'] },
    });
    expect(r.skipped).toEqual(['skp-risk-001']);
    expect(r.backfilled).toEqual([]);
    expect(r.nodes).toEqual([]);
  });
});
