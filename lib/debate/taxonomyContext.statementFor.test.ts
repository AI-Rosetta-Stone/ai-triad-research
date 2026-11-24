// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/348 (chat cap): the optional per-node statement hook. Default output must not change. With the hook
// set, a node is rendered with its statement or omitted with a WARN, in both the POV and RETRIEVED blocks.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const recorder = vi.hoisted(() => ({ record: vi.fn() }));

vi.mock('../flight-recorder/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../flight-recorder/index.js')>()),
  getGlobalRecorder: () => recorder,
}));

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

beforeEach(() => {
  recorder.record.mockClear();
});

describe('formatTaxonomyContext statementFor (t/348)', () => {
  it('default output is byte-identical with no hook, or with the hook explicitly undefined', () => {
    const base = formatTaxonomyContext(ctx(NODES), 'accelerationist');
    const explicitUndefined = formatTaxonomyContext(ctx(NODES), 'accelerationist', undefined, { statementFor: undefined });
    expect(explicitUndefined).toBe(base);
    expect(base).toContain('DOLCE formal description one');
    expect(base).toContain('DOLCE formal description two');
  });

  it('renders the statement in place of the description for a node that resolves', () => {
    const out = formatTaxonomyContext(ctx(NODES), 'accelerationist', undefined, {
      statementFor: id => (id === 'acc-data-001' ? 'A plain statement about compute.' : id === 'acc-data-002' ? 'A plain statement about data.' : undefined),
    });
    expect(out).toContain('"Compute scaling" — A plain statement about compute.');
    expect(out).not.toContain('DOLCE formal description one');
  });

  it('omits an unresolved node when the hook is set, with no description leak, and WARNs', () => {
    const out = formatTaxonomyContext(ctx(NODES), 'accelerationist', undefined, {
      statementFor: id => (id === 'acc-data-001' ? 'Only this one resolves.' : undefined),
    });
    expect(out).toContain('Only this one resolves.');
    expect(out).not.toContain('DOLCE formal description two');
    expect(out).not.toContain('Data quality');
    expect(recorder.record).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warn',
      message: expect.stringContaining('acc-data-002'),
    }));
  });

  it('takes precedence over debate_grounding for a resolved node', () => {
    const out = formatTaxonomyContext(ctx(NODES), 'accelerationist', undefined, {
      statementFor: id => (id === 'acc-data-001' ? 'Statement wins.' : id === 'acc-data-002' ? 'Second statement.' : undefined),
      debateGroundingOverrides: new Map([['acc-data-001', 'Register text.']]),
    });
    expect(out).toContain('Statement wins.');
    expect(out).not.toContain('Register text.');
  });

  it('RETRIEVED block: a retrieved node never leaks its description when the hook is set', () => {
    const retrieved = node('acc-ret-001', 'Retrieved claim', 'RETRIEVED DESCRIPTION LEAK', { graph_attributes: { verification_status: 'ai-retrieved' } });
    const out = formatTaxonomyContext(ctx([retrieved]), 'accelerationist', undefined, { statementFor: () => undefined });
    expect(out).not.toContain('RETRIEVED DESCRIPTION LEAK');
    expect(out).not.toContain('Retrieved claim');
  });

  it('RETRIEVED block: uses the statement when the hook resolves it', () => {
    const retrieved = node('acc-ret-001', 'Retrieved claim', 'RETRIEVED DESCRIPTION LEAK', { graph_attributes: { verification_status: 'ai-retrieved' } });
    const out = formatTaxonomyContext(ctx([retrieved]), 'accelerationist', undefined, { statementFor: () => 'Retrieved statement.' });
    expect(out).toContain('Retrieved statement.');
    expect(out).not.toContain('RETRIEVED DESCRIPTION LEAK');
  });

  it('RETRIEVED block: default still prints description when no hook is set', () => {
    const retrieved = node('acc-ret-001', 'Retrieved claim', 'RETRIEVED DESCRIPTION', { graph_attributes: { verification_status: 'ai-retrieved' } });
    const out = formatTaxonomyContext(ctx([retrieved]), 'accelerationist');
    expect(out).toContain('RETRIEVED DESCRIPTION');
  });
});
