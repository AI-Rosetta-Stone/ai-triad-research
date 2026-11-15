/**
 * t/296: DebateEngine's sourceEvidenceIndex getter must read the index from the
 * configured taxonomy_dir (taxonomy/Origin), not the stale taxonomy/ copy, and
 * must WARN when the index is missing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { DebateEngine } from './debateEngine.js';
import { setGlobalRecorder, clearGlobalRecorder } from '../flight-recorder/index.js';

const INDEX_NAME = 'source_evidence_index.json';

// Only existsSync/readFileSync are mocked; each test fakes .aitriad.json and the index file.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const existsSync = vi.fn();
  const readFileSync = vi.fn();
  return { ...actual, default: { ...actual, existsSync, readFileSync }, existsSync, readFileSync };
});

const norm = (p: unknown): string => String(p).replace(/\\/g, '/');

function fakeFs(indexExistsAt: (p: string) => boolean): void {
  vi.mocked(fs.existsSync).mockImplementation((p) => {
    const s = norm(p);
    if (s.endsWith(INDEX_NAME)) return indexExistsAt(s);
    return true;
  });
  vi.mocked(fs.readFileSync).mockImplementation(((p: unknown) => {
    const s = norm(p);
    if (s.endsWith('.aitriad.json')) {
      return JSON.stringify({ data_root: '.', taxonomy_dir: 'taxonomy/Origin' });
    }
    if (s.endsWith(INDEX_NAME)) return JSON.stringify({ nodes: { 'acc-data-001': {} } });
    throw new Error(`unexpected readFileSync: ${s}`);
  }) as typeof fs.readFileSync);
}

function engineStub(): { sourceEvidenceIndex: unknown } {
  const engine = Object.create(DebateEngine.prototype);
  engine.session = { id: 'sess-t296' };
  return engine;
}

describe('DebateEngine.sourceEvidenceIndex (t/296)', () => {
  const record = vi.fn();

  beforeEach(() => {
    record.mockReset();
    setGlobalRecorder({ record } as never);
  });
  afterEach(() => clearGlobalRecorder());

  it('reads the index from taxonomy/Origin, not the stale taxonomy/ copy', () => {
    fakeFs((s) => s.includes('/taxonomy/Origin/'));
    const index = engineStub().sourceEvidenceIndex as { nodes: Record<string, unknown> };

    expect(index?.nodes?.['acc-data-001']).toBeDefined();
    const reads = vi.mocked(fs.readFileSync).mock.calls.map((c) => norm(c[0])).filter((s) => s.endsWith(INDEX_NAME));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain('/taxonomy/Origin/');
  });

  it('returns undefined and records a WARN naming the Origin path when the index is missing', () => {
    fakeFs(() => false);

    expect(engineStub().sourceEvidenceIndex).toBeUndefined();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        debate_id: 'sess-t296',
        message: expect.stringMatching(/Source evidence index not found at .*taxonomy[\\/]Origin[\\/]source_evidence_index\.json/),
      }),
    );
  });
});
