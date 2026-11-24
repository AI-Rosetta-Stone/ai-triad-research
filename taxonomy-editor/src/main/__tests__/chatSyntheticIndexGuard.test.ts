// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/425: the index-mismatch guard. The text comes from the shared lookup and the index from a
// local argmax. If they disagree, the node must be null with a WARN, never a wrong index. This
// file mocks the shared lookup so it can return a text the argmax does not pick.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ lookupText: null as string | null }));

vi.mock('../../../../lib/debate/syntheticStatementLookup.js', () => ({
  bestMatchingSyntheticStatement: vi.fn(() => h.lookupText ?? undefined),
}));

import { chatSyntheticStatements } from '../chatSyntheticStatements.js';

const AXIS_A = [1, 0];
const AXIS_B = [0, 1];

beforeEach(() => {
  h.lookupText = null;
});

describe('chatSyntheticStatements index-mismatch guard (t/425)', () => {
  it('returns null and a WARN when the lookup text is not the argmax statement', async () => {
    // The argmax for query [1, 0] is row 1 ("about axis A"), but the lookup reports row 0.
    h.lookupText = 'about axis B';
    const warn = vi.fn<(message: string) => void>();
    const out = await chatSyntheticStatements(
      { pov: 'accelerationist', queryText: 'q', nodeIds: ['acc-alpha-001'] },
      {
        embed: async () => [AXIS_A],
        nodeStatements: { 'acc-alpha-001': ['about axis B', 'about axis A'] },
        nodeVectors: { 'acc-alpha-001': { vectors: [AXIS_B, AXIS_A] } },
        warn,
      },
    );
    expect(out).toEqual({ 'acc-alpha-001': null });
    const message = warn.mock.calls[0]?.[0] ?? '';
    expect(message).toContain('reason=index-mismatch');
    expect(message).toContain('node=acc-alpha-001');
  });

  it('returns the index when the lookup text agrees with the argmax', async () => {
    h.lookupText = 'about axis A';
    const warn = vi.fn<(message: string) => void>();
    const out = await chatSyntheticStatements(
      { pov: 'accelerationist', queryText: 'q', nodeIds: ['acc-alpha-001'] },
      {
        embed: async () => [AXIS_A],
        nodeStatements: { 'acc-alpha-001': ['about axis B', 'about axis A'] },
        nodeVectors: { 'acc-alpha-001': { vectors: [AXIS_B, AXIS_A] } },
        warn,
      },
    );
    expect(out).toEqual({ 'acc-alpha-001': { text: 'about axis A', index: 1 } });
    expect(warn).not.toHaveBeenCalled();
  });
});
