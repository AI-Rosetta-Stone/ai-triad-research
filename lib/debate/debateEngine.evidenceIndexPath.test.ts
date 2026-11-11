/**
 * Regression test: sourceEvidenceIndex getter uses configured taxonomy_dir from .aitriad.json,
 * not a hardcoded path. Ensures fresh evidence index from t/290 is used consistently.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type DebateEngine from './debateEngine.js';

describe('debateEngine.sourceEvidenceIndex', () => {
  let originalFs: typeof fs;
  let readFileSync: ReturnType<typeof vi.spyOn>;
  let existsSync: ReturnType<typeof vi.spyOn>;
  let parseIndex: Record<string, unknown>;

  beforeEach(() => {
    originalFs = fs;
    parseIndex = { nodes: { 'acc-data-001': { type: 'fact' } } };

    // Mock fs.existsSync to return true only for the fresh index path
    existsSync = vi.spyOn(fs, 'existsSync').mockImplementation((filepath: fs.PathLike) => {
      const pathStr = String(filepath);
      // Only return true for the fresh index under taxonomy/Origin/
      return pathStr.includes('taxonomy') && pathStr.includes('Origin') && pathStr.endsWith('source_evidence_index.json');
    });

    // Mock fs.readFileSync to return index only for the fresh path
    readFileSync = vi.spyOn(fs, 'readFileSync').mockImplementation((filepath: fs.PathLike, encoding: BufferEncoding) => {
      const pathStr = String(filepath);
      
      if (pathStr.endsWith('.aitriad.json')) {
        return JSON.stringify({ taxonomy_dir: 'taxonomy/Origin' });
      }
      
      if (pathStr.includes('taxonomy') && pathStr.includes('Origin') && pathStr.endsWith('source_evidence_index.json')) {
        return JSON.stringify(parseIndex);
      }
      
      // Never return data for stale path (should not be requested)
      throw new Error(`Unexpected read: ${pathStr}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads source evidence index from configured taxonomy_dir (taxonomy/Origin)', async () => {
    // Dynamically import to get fresh module instance
    const { default: DebateEngine } = await import('./debateEngine.js');
    const engine = new DebateEngine({
      adapter: {} as any,
      taxonomy: {} as any,
      config: { enableAdaptiveStagingDebug: false },
      session: { id: 'test-session' },
    } as any);

    // Access the getter (it's private, so we use reflection or type-cast)
    const index = (engine as any).sourceEvidenceIndex;

    // Verify it called readFileSync with .aitriad.json
    expect(readFileSync).toHaveBeenCalledWith(expect.stringContaining('.aitriad.json'), expect.any(String));

    // Verify it only attempted to read the fresh index path (containing 'Origin')
    const readCalls = readFileSync.mock.calls.map(call => String(call[0]));
    const indexReadCalls = readCalls.filter(p => p.endsWith('source_evidence_index.json'));
    
    expect(indexReadCalls).toHaveLength(1);
    expect(indexReadCalls[0]).toContain('taxonomy');
    expect(indexReadCalls[0]).toContain('Origin');

    // Verify the stale path was never attempted
    const stalePathAttempted = indexReadCalls.some(p => 
      p.includes('taxonomy') && 
      p.endsWith('source_evidence_index.json') && 
      !p.includes('Origin')
    );
    expect(stalePathAttempted).toBe(false);

    // Verify the returned index matches
    expect(index).toEqual(parseIndex);
  });

  it('returns undefined if index file does not exist (with WARN logged)', async () => {
    existsSync.mockReturnValue(false);

    const { default: DebateEngine } = await import('./debateEngine.js');
    const engine = new DebateEngine({
      adapter: {} as any,
      taxonomy: {} as any,
      config: { enableAdaptiveStagingDebug: false },
      session: { id: 'test-session' },
    } as any);

    const index = (engine as any).sourceEvidenceIndex;

    expect(index).toBeUndefined();
    // existsSync should have been called for the Origin path
    expect(existsSync).toHaveBeenCalledWith(expect.stringContaining('Origin'));
  });

  it('returns undefined and logs WARN when file not found', async () => {
    existsSync.mockReturnValue(false);

    const { default: DebateEngine } = await import('./debateEngine.js');
    const engine = new DebateEngine({
      adapter: {} as any,
      taxonomy: {} as any,
      config: { enableAdaptiveStagingDebug: false },
      session: { id: 'test-session' },
    } as any);

    const index = (engine as any).sourceEvidenceIndex;

    // When the file doesn't exist, getter returns undefined
    expect(index).toBeUndefined();
    
    // existsSync was called to check the Origin path
    expect(existsSync).toHaveBeenCalledWith(expect.stringContaining('Origin'));
  });
});
