// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License.

// t/561: the engine's phases embed only through the host adapter, so a host that owns an
// embedding session (the server's worker) serves them and no second ONNX session loads.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const onnx = vi.hoisted(() => ({
  computeEmbeddings: vi.fn(async (texts: string[]) => texts.map(() => [9, 9])),
}));
vi.mock('../../embeddings/onnxEmbedding.js', () => onnx);

import { embedTexts, embedRoute, adapterEmbedder } from './embedTexts.js';
import { finalizeNarrativeReference, updateNarrativeSimilarity } from './phases/narrativeVoicing.js';
import type { AIAdapter } from '../aiAdapter.js';
import type { DebateEngineInternals } from './internals.js';

const base = { generateText: async () => '', registry: {} } as unknown as AIAdapter;

describe('embedTexts routing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the adapter batch method when present and never touches the in-process ONNX session', async () => {
    const computeEmbeddings = vi.fn(async (t: string[]) => t.map((_, i) => [i, 1]));
    const computeQueryEmbedding = vi.fn(async () => ({ vector: [0, 0] }));
    const adapter = { ...base, computeEmbeddings, computeQueryEmbedding } as AIAdapter;
    expect(embedRoute(adapter)).toBe('adapter-batch');
    expect(await embedTexts(adapter, ['a', 'b'])).toEqual([[0, 1], [1, 1]]);
    expect(computeEmbeddings).toHaveBeenCalledWith(['a', 'b']);
    expect(computeQueryEmbedding).not.toHaveBeenCalled();
    expect(onnx.computeEmbeddings).not.toHaveBeenCalled();
  });

  it('falls back to per-text computeQueryEmbedding, in order, without loading ONNX', async () => {
    const computeQueryEmbedding = vi.fn(async (t: string) => ({ vector: [t.length] }));
    const adapter = { ...base, computeQueryEmbedding } as AIAdapter;
    expect(embedRoute(adapter)).toBe('adapter-query');
    expect(await embedTexts(adapter, ['x', 'yyy'])).toEqual([[1], [3]]);
    expect(onnx.computeEmbeddings).not.toHaveBeenCalled();
  });

  it('uses the direct ONNX call only when the adapter has no embed method, and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(embedRoute(base)).toBe('direct-onnx');
    expect(await embedTexts(base, ['a'])).toEqual([[9, 9]]);
    expect(onnx.computeEmbeddings).toHaveBeenCalledWith(['a']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('WARN embedTexts'));
    warn.mockRestore();
  });

  it('returns [] for no texts without calling anything', async () => {
    const computeEmbeddings = vi.fn();
    expect(await embedTexts({ ...base, computeEmbeddings } as AIAdapter, [])).toEqual([]);
    expect(computeEmbeddings).not.toHaveBeenCalled();
  });

  it('adapterEmbedder binds the adapter', async () => {
    const computeEmbeddings = vi.fn(async (t: string[]) => t.map(() => [7]));
    expect(await adapterEmbedder({ ...base, computeEmbeddings } as AIAdapter)(['q'])).toEqual([[7]]);
  });

  it('throws when the embedder returns a different number of vectors than texts (t/570)', async () => {
    const short = { ...base, computeEmbeddings: vi.fn(async () => [[1]]) } as AIAdapter;
    await expect(embedTexts(short, ['a', 'b'])).rejects.toThrow(/route adapter-batch.*1 vectors for 2 texts/);
    const notArray = { ...base, computeEmbeddings: vi.fn(async () => undefined as unknown as number[][]) } as AIAdapter;
    await expect(embedTexts(notArray, ['a'])).rejects.toThrow(/undefined vectors for 1 texts/);
  });
});

describe('engine phases embed through the adapter (one session per process)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('narrative reference and drift scoring use the adapter batch embed, not ONNX', async () => {
    const computeEmbeddings = vi.fn(async (t: string[]) => t.map(s => (s.includes('saf') ? [0, 1] : [1, 0])));
    const opening = { id: 'o1', timestamp: 't', type: 'opening', speaker: 'safetyist', content: 'saf para', taxonomy_refs: [] };
    const engine = {
      adapter: { ...base, computeEmbeddings },
      session: {
        id: 'd1',
        transcript: [opening],
        narrative_voicing: {
          entry_id: 'e0', model: 'm',
          narratives: [
            { speaker: 'accelerationist', fears_losing: 'f', history_carried: 'h', narrative: 'acc story' },
            { speaker: 'safetyist', fears_losing: 'f', history_carried: 'h', narrative: 'saf story' },
          ],
        },
      },
    } as unknown as DebateEngineInternals;

    await finalizeNarrativeReference(engine);
    await updateNarrativeSimilarity(engine, { ...opening, id: 's1', type: 'statement' } as never);

    expect(computeEmbeddings).toHaveBeenCalled();
    expect(onnx.computeEmbeddings).not.toHaveBeenCalled();
    expect(engine.session.narrative_voicing!.similarity_series).toMatchObject({ o1: 1, s1: 1 });
  });

  it('no engine module outside embedTexts.ts imports the in-process ONNX embedder', () => {
    // Structural guard: a new direct import would load a second session on the server again (t/520).
    const root = path.dirname(fileURLToPath(import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && e.name !== 'embedTexts.ts'
          && /embeddings\/onnxEmbedding/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(root, p));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
