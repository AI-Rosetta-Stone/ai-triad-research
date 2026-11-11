import { describe, it, expect } from 'vitest';
import {
  resolveSyntheticPromptNodes,
  resolveGroundingOverrides,
} from './taxonomyContext.js';
import { formatTaxonomyContext, type TaxonomyContext } from '../taxonomyContext.js';
import type { DebateEngineInternals } from './internals.js';
import type { PovNode } from '../taxonomyTypes.js';

const node = (id: string, category: string, extra: Record<string, unknown> = {}): PovNode =>
  ({ id, category, label: id, description: `DOLCE ${id}`, graph_attributes: {}, ...extra }) as unknown as PovNode;

function engine(config: Record<string, boolean>, vectors: Record<string, { vectors?: number[][] }>, statements: Record<string, string[]>): DebateEngineInternals {
  return {
    config,
    session: { id: 'debate-test' },
    taxonomy: { embeddings: vectors, syntheticStatements: statements },
  } as unknown as DebateEngineInternals;
}

const QUERY = [1, 0];

describe('resolveSyntheticPromptNodes: no-embedding fallback (t/412 CL item 1)', () => {
  it('returns undefined with the flag off', () => {
    const e = engine({}, {}, {});
    expect(resolveSyntheticPromptNodes(e, [], [], new Map(), QUERY)).toBeUndefined();
  });

  it('marks the turn control-fallback when the flag is on and there is no query embedding', () => {
    const a = node('acc-data-001', 'data');
    const e = engine({ useSyntheticStatementGrounding: true }, { 'acc-data-001': { vectors: [[1, 0]] } }, { 'acc-data-001': ['stmt'] });
    const r = resolveSyntheticPromptNodes(e, [{ node: a, score: 0.9 }], [a], new Map([['acc-data-001', 0.9]]), null);
    expect(r).toEqual({ arm: 'control-fallback' });
  });

  it('does not use the synthetic overrides on a control-fallback turn', () => {
    const a = node('acc-data-001', 'data');
    const e = engine({ useSyntheticStatementGrounding: true, useDebateGrounding: false }, { 'acc-data-001': { vectors: [[1, 0]] } }, { 'acc-data-001': ['stmt'] });
    const synthetic = resolveSyntheticPromptNodes(e, [{ node: a, score: 0.9 }], [a], new Map(), null);
    expect(resolveGroundingOverrides(e, synthetic, [a])).toBeUndefined();
  });
});

describe('resolveSyntheticPromptNodes: zero-node case (TL decision, p/8#142)', () => {
  it('falls back to control-fallback when every selected node is skipped and none backfills', () => {
    const a = node('acc-data-001', 'data');
    const e = engine({ useSyntheticStatementGrounding: true }, { 'acc-data-001': { vectors: [[1, 0]] } }, {});
    const r = resolveSyntheticPromptNodes(e, [{ node: a, score: 0.9 }], [a], new Map([['acc-data-001', 0.9]]), QUERY);
    expect(r).toEqual({ arm: 'control-fallback' });
  });

  it('keeps the control path, so the prompt still has POV nodes (description path, debate_grounding if on)', () => {
    const a = node('acc-data-001', 'data', { graph_attributes: { debate_grounding: 'register text' } });
    const e = engine({ useSyntheticStatementGrounding: true, useDebateGrounding: true }, { 'acc-data-001': { vectors: [[1, 0]] } }, {});
    const r = resolveSyntheticPromptNodes(e, [{ node: a, score: 0.9 }], [a], new Map([['acc-data-001', 0.9]]), QUERY);
    expect(r?.arm).toBe('control-fallback');
    expect(resolveGroundingOverrides(e, r, [a])?.get('acc-data-001')).toBe('register text');
  });
});

describe('resolveGroundingOverrides: flag precedence (t/412 CL item 2)', () => {
  const withGrounding = node('acc-data-001', 'data', { graph_attributes: { debate_grounding: 'register text' } });

  it('uses synthetic statements, not debate_grounding, when the synthetic arm runs', () => {
    const e = engine({ useSyntheticStatementGrounding: true, useDebateGrounding: true }, { 'acc-data-001': { vectors: [[1, 0]] } }, { 'acc-data-001': ['synthetic text'] });
    const synthetic = resolveSyntheticPromptNodes(e, [{ node: withGrounding, score: 0.9 }], [withGrounding], new Map(), QUERY);
    const overrides = resolveGroundingOverrides(e, synthetic, [withGrounding]);
    expect(overrides?.get('acc-data-001')).toBe('synthetic text');
    expect([...(overrides?.values() ?? [])]).not.toContain('register text');
  });

  it('uses debate_grounding when the synthetic flag is off', () => {
    const e = engine({ useDebateGrounding: true }, {}, {});
    const synthetic = resolveSyntheticPromptNodes(e, [], [], new Map(), QUERY);
    expect(synthetic).toBeUndefined();
    expect(resolveGroundingOverrides(e, synthetic, [withGrounding])?.get('acc-data-001')).toBe('register text');
  });
});

describe('backfilled nodes in the prompt (t/412 CL item 2)', () => {
  it('formatTaxonomyContext orders a backfilled node by its score, not after the score-ordered nodes', () => {
    const backfilled = node('acc-data-002', 'data');
    const unselected = node('acc-data-003', 'data');
    const ctx = {
      povNodes: [unselected, backfilled],
      situationNodes: [],
      policyRegistry: {},
      nodeScores: new Map([['acc-data-002', 0.7], ['acc-data-003', 0.5]]),
    } as unknown as TaxonomyContext;
    const text = formatTaxonomyContext(ctx, 'accelerationist');
    expect(text.indexOf('[acc-data-002]')).toBeGreaterThan(-1);
    expect(text.indexOf('[acc-data-002]')).toBeLessThan(text.indexOf('[acc-data-003]'));
  });
});
