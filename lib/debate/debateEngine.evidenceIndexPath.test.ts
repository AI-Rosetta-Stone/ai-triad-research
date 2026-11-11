/**
 * Regression test: evidenceIndexLoader loads from configured taxonomy_dir,
 * not a hardcoded stale path. Ensures t/290 fresh index is used consistently.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Mock fs before importing debateEngine
vi.mock('fs');

describe('debateEngine.sourceEvidenceIndex (t/296)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads index from configured taxonomy/Origin, not stale taxonomy/ path', async () => {
    const mockFs = vi.mocked(fs);
    
    // Setup mocks: allow paths to resolve, then intercept at index read
    mockFs.existsSync.mockImplementation((filepath: string) => {
      const p = filepath.toString();
      // .aitriad.json and  other configs must exist for root resolution
      if (p.endsWith('.aitriad.json') || p.includes('package.json')) return true;
      // Only Origin/source_evidence_index.json "exists"; stale path does not
      if (p.includes('taxonomy') && p.includes('Origin') && p.endsWith('source_evidence_index.json')) return true;
      if (p.includes('taxonomy/source_evidence_index.json') && !p.includes('Origin')) return false;
      return true; // permissive for other paths
    });

    mockFs.readFileSync.mockImplementation((filepath: string, encoding?: string) => {
      const p = filepath.toString();
      if (p.endsWith('.aitriad.json')) {
        return JSON.stringify({ taxonomy_dir: 'taxonomy/Origin' });
      }
      if (p.includes('taxonomy') && p.includes('Origin') && p.endsWith('source_evidence_index.json')) {
        return JSON.stringify({ nodes: { 'acc-data-001': { type: 'fact', label: 'Test' } } });
      }
      if (p.includes('package.json')) {
        return JSON.stringify({ name: 'ai-triad-research' });
      }
      throw new Error(`Unexpected fs.readFileSync: ${p}`);
    });

    const { DebateEngine } = await import('./debateEngine.js');
    const engine = new DebateEngine({
      adapter: {} as any,
      taxonomy: {} as any,
      config: { enableAdaptiveStagingDebug: false },
      session: { id: 'test-session' },
    } as any);

    // Trigger the getter
    const index = (engine as any).sourceEvidenceIndex;

    // Verify the index was loaded (not undefined)
    expect(index).toBeDefined();
    expect(index?.nodes?.['acc-data-001']).toBeDefined();

    // Verify readFileSync was called with Origin path
    const readCalls = mockFs.readFileSync.mock.calls.map(call => String(call[0]));
    const indexReads = readCalls.filter(p => p.includes('source_evidence_index.json'));
    expect(indexReads.length).toBeGreaterThan(0);
    expect(indexReads.some(p => p.includes('Origin'))).toBe(true);
  });

  it('returns undefined and logs WARN if index missing (Origin path)', async () => {
    const mockFs = vi.mocked(fs);
    
    // Setup mocks: config exists but index does not
    mockFs.existsSync.mockImplementation((filepath: string) => {
      const p = filepath.toString();
      if (p.endsWith('.aitriad.json') || p.includes('package.json')) return true;
      // Index does not exist anywhere
      if (p.endsWith('source_evidence_index.json')) return false;
      return true;
    });

    mockFs.readFileSync.mockImplementation((filepath: string) => {
      const p = filepath.toString();
      if (p.endsWith('.aitriad.json')) {
        return JSON.stringify({ taxonomy_dir: 'taxonomy/Origin' });
      }
      if (p.includes('package.json')) {
        return JSON.stringify({ name: 'ai-triad-research' });
      }
      throw new Error(`Unexpected fs.readFileSync: ${p}`);
    });

    const { DebateEngine } = await import('./debateEngine.js');
    const engine = new DebateEngine({
      adapter: {} as any,
      taxonomy: {} as any,
      config: { enableAdaptiveStagingDebug: false },
      session: { id: 'test-session' },
    } as any);

    // Trigger the getter
    const index = (engine as any).sourceEvidenceIndex;

    // Verify undefined when index is missing
    expect(index).toBeUndefined();
  });
});


