/**
 * Regression test: sourceEvidenceIndex getter uses configured taxonomy_dir from .aitriad.json,
 * not a hardcoded path. Ensures fresh evidence index from t/290 is used consistently.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn((filepath: string) => {
      // Only return true for the fresh index path
      return filepath.includes('taxonomy') && filepath.includes('Origin') && filepath.endsWith('source_evidence_index.json');
    }),
    readFileSync: vi.fn((filepath: string, encoding?: string) => {
      if (filepath.endsWith('.aitriad.json')) {
        return JSON.stringify({ taxonomy_dir: 'taxonomy/Origin' });
      }
      if (filepath.includes('taxonomy') && filepath.includes('Origin') && filepath.endsWith('source_evidence_index.json')) {
        return JSON.stringify({ nodes: { 'acc-data-001': { type: 'fact' } } });
      }
      throw new Error(`Unexpected read: ${filepath}`);
    }),
  };
});

describe('debateEngine.sourceEvidenceIndex', () => {
  it('reads source evidence index from configured taxonomy_dir (taxonomy/Origin)', async () => {
    const { DebateEngine } = await import('./debateEngine.js');
    const fs = await import('fs');
    
    const engine = new DebateEngine({
      adapter: {} as any,
      taxonomy: {} as any,
      config: { enableAdaptiveStagingDebug: false },
      session: { id: 'test-session' },
    } as any);

    const index = (engine as any).sourceEvidenceIndex;

    // Verify it called readFileSync with .aitriad.json
    expect(fs.readFileSync).toHaveBeenCalledWith(expect.stringContaining('.aitriad.json'), expect.any(String));

    // Verify it only attempted to read the fresh index path (containing 'Origin')
    const readCalls = (fs.readFileSync as any).mock.calls.map((call: any[]) => String(call[0]));
    const indexReadCalls = readCalls.filter(p => p.endsWith('source_evidence_index.json'));
    
    expect(indexReadCalls).toHaveLength(1);
    expect(indexReadCalls[0]).toContain('Origin');
  });

  it('returns undefined if index file does not exist', async () => {
    const fs = await import('fs');
    (fs.existsSync as any).mockReturnValue(false);

    const { DebateEngine } = await import('./debateEngine.js');
    const engine = new DebateEngine({
      adapter: {} as any,
      taxonomy: {} as any,
      config: { enableAdaptiveStagingDebug: false },
      session: { id: 'test-session' },
    } as any);

    const index = (engine as any).sourceEvidenceIndex;
    expect(index).toBeUndefined();
  });
});
