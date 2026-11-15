// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/348 (chat cap): the optional per-node statement override. Default output must not change.

import { describe, it, expect } from 'vitest';
import { formatTaxonomyContext, type TaxonomyContext } from './taxonomyContext.js';
import type { PovNode } from './taxonomyTypes.js';

const node = (id: string, label: string, description: string, extra: Record<string, unknown> = {}): PovNode =>
  ({ id, category: 'Beliefs', label, description, graph_attributes: {}, ...extra }) as unknown as PovNode;

function ctx(povNodes: PovNode[]): TaxonomyContext {
  return { povNodes, situationNodes: [], policyRegistry: {} } as unknown as TaxonomyContext;
}

const NODES = [
  node('acc-data-001', 'Compute scaling', 'DOLCE formal description one'),
  node('acc-data-002', 'Data quality', 'DOLCE formal description two'),
];

describe('formatTaxonomyContext statementFor (t/348)', () => {
  it('default output is unchanged: no statementFor equals a statementFor that returns nothing', () => {
    const base = formatTaxonomyContext(ctx(NODES), 'accelerationist');
    const withEmpty = formatTaxonomyContext(ctx(NODES), 'accelerationist', undefined, { statementFor: () => undefined });
    expect(withEmpty).toBe(base);
    expect(base).toContain('DOLCE formal description one');
  });

  it('uses the statement in place of the description for a node that returns one', () => {
    const out = formatTaxonomyContext(ctx(NODES), 'accelerationist', undefined, {
      statementFor: id => (id === 'acc-data-001' ? 'A plain statement about compute.' : undefined),
    });
    expect(out).toContain('"Compute scaling" — A plain statement about compute.');
    expect(out).not.toContain('DOLCE formal description one');
    expect(out).toContain('DOLCE formal description two');
  });

  it('takes precedence over debate_grounding for that node', () => {
    const out = formatTaxonomyContext(ctx(NODES), 'accelerationist', undefined, {
      statementFor: id => (id === 'acc-data-001' ? 'Statement wins.' : undefined),
      debateGroundingOverrides: new Map([['acc-data-001', 'Register text.']]),
    });
    expect(out).toContain('Statement wins.');
    expect(out).not.toContain('Register text.');
  });
});
