import { describe, it, expect, vi } from 'vitest';
import { chatSyntheticStatements } from '../chatSyntheticStatements.js';

// Vectors are unit-axis so cosine similarity picks the argmax deterministically.
const AXIS_A = [1, 0];
const AXIS_B = [0, 1];

function deps(over: Partial<Parameters<typeof chatSyntheticStatements>[1]> = {}) {
  const warn = vi.fn<(message: string) => void>();
  return {
    embed: vi.fn(async (texts: string[]) => texts.map(() => AXIS_A)),
    nodeStatements: {
      'acc-alpha-001': ['about axis B', 'about axis A'],
    } as Record<string, string[]>,
    nodeVectors: {
      'acc-alpha-001': { vectors: [AXIS_B, AXIS_A] },
    } as Record<string, { vectors?: number[][] }>,
    warn,
    ...over,
  };
}

describe('chatSyntheticStatements (t/348)', () => {
  it('returns the statement with the highest cosine to the query embedding', async () => {
    const d = deps();
    const out = await chatSyntheticStatements({ pov: 'accelerationist', queryText: 'axis A question', nodeIds: ['acc-alpha-001'] }, d);
    expect(out).toEqual({ 'acc-alpha-001': 'about axis A' });
    expect(d.warn).not.toHaveBeenCalled();
  });

  it('returns null with a no-usable-statements WARN for a node with no corpus entries', async () => {
    const d = deps();
    const out = await chatSyntheticStatements({ pov: 'accelerationist', queryText: 'q', nodeIds: ['acc-missing-002'] }, d);
    expect(out).toEqual({ 'acc-missing-002': null });
    expect(d.warn).toHaveBeenCalledTimes(1);
    expect(d.warn.mock.calls[0][0]).toContain('reason=no-usable-statements');
    expect(d.warn.mock.calls[0][0]).toContain('node=acc-missing-002');
  });

  it('treats a statement/vector count mismatch as no-usable-statements (never a wrong statement)', async () => {
    const d = deps({
      nodeVectors: { 'acc-alpha-001': { vectors: [AXIS_A] } },
    });
    const out = await chatSyntheticStatements({ pov: 'accelerationist', queryText: 'q', nodeIds: ['acc-alpha-001'] }, d);
    expect(out).toEqual({ 'acc-alpha-001': null });
    expect(d.warn.mock.calls[0][0]).toContain('reason=no-usable-statements');
  });

  it('returns null for every node with one embedding-unavailable WARN when embed throws, without throwing', async () => {
    const d = deps({ embed: vi.fn(async () => { throw new Error('model offline'); }) });
    const out = await chatSyntheticStatements({ pov: 'accelerationist', queryText: 'q', nodeIds: ['acc-alpha-001', 'acc-x-009'] }, d);
    expect(out).toEqual({ 'acc-alpha-001': null, 'acc-x-009': null });
    expect(d.warn).toHaveBeenCalledTimes(1);
    expect(d.warn.mock.calls[0][0]).toContain('reason=embedding-unavailable');
  });

  it('treats an empty query or an empty vector as embedding-unavailable', async () => {
    const d = deps({ embed: vi.fn(async () => [[]]) });
    const out = await chatSyntheticStatements({ pov: 'accelerationist', queryText: 'q', nodeIds: ['acc-alpha-001'] }, d);
    expect(out).toEqual({ 'acc-alpha-001': null });
    expect(d.warn.mock.calls[0][0]).toContain('reason=embedding-unavailable');

    const blank = deps();
    await chatSyntheticStatements({ pov: 'accelerationist', queryText: '   ', nodeIds: ['acc-alpha-001'] }, blank);
    expect(blank.embed).not.toHaveBeenCalled();
    expect(blank.warn.mock.calls[0][0]).toContain('reason=embedding-unavailable');
  });

  it('returns one entry per requested node id', async () => {
    const d = deps();
    const ids = ['acc-alpha-001', 'acc-b-002', 'acc-c-003'];
    const out = await chatSyntheticStatements({ pov: 'accelerationist', queryText: 'q', nodeIds: ids }, d);
    expect(Object.keys(out).sort()).toEqual([...ids].sort());
  });
});
