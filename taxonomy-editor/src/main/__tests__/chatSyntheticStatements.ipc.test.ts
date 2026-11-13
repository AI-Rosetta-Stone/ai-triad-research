// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/416: direct test of the `chat-synthetic-statements` IPC handler (taxonomyHandlers.ts).
 * The pure core (chatSyntheticStatements.ts) is covered by chatSyntheticStatements.test.ts;
 * this file covers what the handler itself does: payload validation, POV → corpus-prefix
 * mapping, grouping/vector wiring, the corpus-unavailable fail-soft path, and that the output
 * carries statement text or null only. Mirrors fetchRelevantNodesLabelDedupWarn.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  recorded: [] as unknown[],
  corpus: null as unknown,
  corpusThrows: false,
  vectors: null as Record<string, { pov: string; vectors: number[][] }> | null,
  embedCalls: [] as string[][],
  corpusCalls: [] as string[],
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { h.handlers.set(ch, fn); } },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../fileIO.js', () => {
  const stub = (): undefined => undefined;
  return {
    readTaxonomyFile: (): unknown => ({ nodes: [] }),
    writeTaxonomyFile: stub, readAllConflictFiles: stub, readConflictClusters: stub,
    writeConflictFile: stub, createConflictFile: stub, deleteConflictFile: stub,
    readEdgesFile: stub, writeEdgesFile: stub, getTaxonomyDirs: stub,
    getActiveTaxonomyDirName: stub, setActiveTaxonomyDir: stub, buildNodeSourceIndex: stub,
    buildPolicySourceIndex: stub, readPolicyRegistry: (): unknown => ({ policies: [] }),
    readAggregatedCruxes: stub, readLineageCategories: (): unknown => ({ mapping: {} }),
    readLineageEnrichments: stub,
    loadSyntheticCorpus: (pov: string): unknown => {
      h.corpusCalls.push(pov);
      if (h.corpusThrows) throw new Error('corpus file unreadable');
      return h.corpus;
    },
    loadSyntheticEmbeddings: (): unknown => h.vectors,
    updateSyntheticEmbeddings: stub,
    getDataRootPath: (): string => '/tmp', loadDataConfig: (): { taxonomy_dir: string } => ({ taxonomy_dir: 'x' }),
  };
});

vi.mock('../../server/storage/editMeta.js', () => ({ stampNodeAuthorship: (_old: unknown, next: unknown) => next }));
vi.mock('../embeddings.js', () => ({
  computeEmbeddings: vi.fn(async () => []),
  // Unit axis [1, 0] so the statement whose vector is [1, 0] wins the argmax.
  computeQueryEmbedding: vi.fn(async (t: string) => { h.embedCalls.push([t]); return [1, 0]; }),
}));

vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: () => ({ record: (entry: unknown) => { h.recorded.push(entry); } }),
}));

vi.mock('../../../../lib/debate/relevanceSelection.js', () => ({
  assembleNodeEmbeddings: vi.fn(async () => ({ nodeEmbeddings: {} })),
  selectRelevantTaxonomy: vi.fn(async () => ({ injectionManifest: {} })),
}));

// Imported AFTER the mocks so taxonomyHandlers binds the mocked deps.
import { registerTaxonomyHandlers } from '../ipc/taxonomyHandlers.js';

type Handler = (...a: unknown[]) => Promise<unknown>;

function chatSynth(payload: unknown): Promise<unknown> {
  const fn = h.handlers.get('chat-synthetic-statements') as Handler | undefined;
  if (!fn) throw new Error('chat-synthetic-statements not registered');
  return fn({}, payload);
}

const WARN = (): string[] => h.recorded
  .map(r => (r as { message?: string }).message ?? '')
  .filter(m => m.startsWith('chat-synthetic-statements') || m.startsWith('chatSyntheticStatements'));

beforeEach(() => {
  h.handlers.clear();
  h.recorded.length = 0;
  h.corpusCalls.length = 0;
  h.embedCalls.length = 0;
  h.corpusThrows = false;
  // acc-alpha-001: two statements, row-aligned vectors; the [1, 0] row must win.
  h.corpus = {
    entries: [
      { node_id: 'acc-alpha-001', statement: 'off-axis statement' },
      { node_id: 'acc-alpha-001', statement: 'pruned, must be skipped', pruned: true },
      { node_id: 'acc-alpha-001', statement: 'on-axis statement' },
    ],
  };
  h.vectors = {
    'acc-alpha-001': { pov: 'acc', vectors: [[0, 1], [1, 0]] },
  };
  registerTaxonomyHandlers();
});

describe('chat-synthetic-statements IPC handler (t/416)', () => {
  it('is registered on the channel name the web route and preload use', () => {
    expect(h.handlers.has('chat-synthetic-statements')).toBe(true);
  });

  it('rejects a missing or unknown pov before touching the corpus', async () => {
    await expect(chatSynth({ pov: 'nope', queryText: 'q', nodeIds: ['acc-alpha-001'] })).rejects.toThrow(/Invalid or missing pov/);
    await expect(chatSynth({ queryText: 'q', nodeIds: [] })).rejects.toThrow(/Invalid or missing pov/);
    expect(h.corpusCalls).toEqual([]);
  });

  it('rejects a non-string queryText or non-string nodeIds', async () => {
    await expect(chatSynth({ pov: 'accelerationist', queryText: 1, nodeIds: [] })).rejects.toThrow(/Missing queryText\/nodeIds/);
    await expect(chatSynth({ pov: 'accelerationist', queryText: 'q', nodeIds: 'acc-alpha-001' })).rejects.toThrow(/Missing queryText\/nodeIds/);
    await expect(chatSynth({ pov: 'accelerationist', queryText: 'q', nodeIds: [42] })).rejects.toThrow(/Missing queryText\/nodeIds/);
  });

  it('maps the POV to its corpus prefix (accelerationist → acc, safetyist → saf, skeptic → skp)', async () => {
    await chatSynth({ pov: 'accelerationist', queryText: 'q', nodeIds: [] });
    await chatSynth({ pov: 'safetyist', queryText: 'q', nodeIds: [] });
    await chatSynth({ pov: 'skeptic', queryText: 'q', nodeIds: [] });
    expect(h.corpusCalls).toEqual(['acc', 'saf', 'skp']);
  });

  it('returns the best-matching non-pruned statement per node, text only', async () => {
    const out = await chatSynth({ pov: 'accelerationist', queryText: 'on the axis', nodeIds: ['acc-alpha-001'] });
    expect(out).toEqual({ 'acc-alpha-001': 'on-axis statement' });
    expect(h.embedCalls).toEqual([['on the axis']]);
  });

  it('returns null with a no-usable-statements WARN for a node with no corpus entries', async () => {
    const out = await chatSynth({ pov: 'accelerationist', queryText: 'q', nodeIds: ['acc-missing-009'] });
    expect(out).toEqual({ 'acc-missing-009': null });
    expect(WARN().some(m => m.includes('reason=no-usable-statements') && m.includes('acc-missing-009'))).toBe(true);
  });

  it('fails soft with all nulls and a corpus-unavailable WARN when the corpus load throws', async () => {
    h.corpusThrows = true;
    const out = await chatSynth({ pov: 'accelerationist', queryText: 'q', nodeIds: ['acc-alpha-001', 'acc-x-002'] });
    expect(out).toEqual({ 'acc-alpha-001': null, 'acc-x-002': null });
    expect(WARN().some(m => m.includes('reason=corpus-unavailable'))).toBe(true);
    expect(h.embedCalls).toEqual([]);
  });

  it('never returns vectors or corpus fields, only string or null values', async () => {
    const out = await chatSynth({ pov: 'accelerationist', queryText: 'q', nodeIds: ['acc-alpha-001', 'acc-missing-009'] }) as Record<string, unknown>;
    for (const v of Object.values(out)) {
      expect(v === null || typeof v === 'string').toBe(true);
    }
  });
});
