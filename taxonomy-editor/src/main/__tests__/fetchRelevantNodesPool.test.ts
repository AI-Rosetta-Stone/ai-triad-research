// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/424: pool-sizing pass-through (minPerCategory, maxTotal) for the relevant-nodes handler.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';


const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  selectCalls: [] as { minPerCategory?: number; maxTotal?: number }[],
  recorded: [] as unknown[],
  selectResult: { injectionManifest: {} as Record<string, unknown> },
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
    readLineageEnrichments: stub, loadSyntheticCorpus: stub, loadSyntheticEmbeddings: (): null => null,
    updateSyntheticEmbeddings: stub,
    getDataRootPath: (): string => '/tmp', loadDataConfig: (): { taxonomy_dir: string } => ({ taxonomy_dir: 'x' }),
  };
});

vi.mock('../../server/storage/editMeta.js', () => ({ stampNodeAuthorship: (_old: unknown, next: unknown) => next }));
vi.mock('../embeddings.js', () => ({ computeEmbeddings: vi.fn(async () => []), computeQueryEmbedding: vi.fn(async () => []) }));

vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: () => ({ record: (entry: unknown) => { h.recorded.push(entry); } }),
}));

// Mocked so only the handler's label_dedup → WARN routing is under test, not real selection.
vi.mock('../../../../lib/debate/relevanceSelection.js', () => ({
  assembleNodeEmbeddings: vi.fn(async () => ({ nodeEmbeddings: {} })),
  selectRelevantTaxonomy: vi.fn(async (args: { params: { minPerCategory?: number; maxTotal?: number } }) => { h.selectCalls.push({ minPerCategory: args.params.minPerCategory, maxTotal: args.params.maxTotal }); return h.selectResult; }),
}));

// Imported AFTER the mocks so taxonomyHandlers binds the mocked deps.
import { registerTaxonomyHandlers } from '../ipc/taxonomyHandlers.js';

function fetchRelevantNodes(payload: unknown): unknown {
  const fn = h.handlers.get('fetch-relevant-nodes');
  if (!fn) throw new Error('fetch-relevant-nodes not registered');
  return fn({}, payload);
}

beforeEach(() => {
  h.handlers.clear();
  h.recorded = [];
  h.selectResult = { injectionManifest: {} };
  registerTaxonomyHandlers();
});


describe('fetch-relevant-nodes IPC: pool sizing (t/424)', () => {
  beforeEach(() => {
    h.handlers.clear();
    h.recorded = [];
    h.selectResult = { injectionManifest: {} };
    h.selectCalls.length = 0;
    registerTaxonomyHandlers();
  });

  it('debate callers (no pool fields) reach the lib with undefined, so the defaults (3 / 35) still apply', async () => {
    await fetchRelevantNodes({ pov: 'accelerationist', topic: 't', recentTranscript: 'r' });
    expect(h.selectCalls).toHaveLength(1);
    expect(h.selectCalls[0].minPerCategory).toBeUndefined();
    expect(h.selectCalls[0].maxTotal).toBeUndefined();
  });

  it('chat can request the full pool: minPerCategory and maxTotal reach the lib', async () => {
    await fetchRelevantNodes({ pov: 'accelerationist', topic: 't', recentTranscript: 'r', minPerCategory: 10, maxTotal: 500 });
    expect(h.selectCalls[0].minPerCategory).toBe(10);
    expect(h.selectCalls[0].maxTotal).toBe(500);
  });

  it('refuses a non-positive or non-integer pool size before any selection runs', async () => {
    await expect(fetchRelevantNodes({ pov: 'accelerationist', topic: 't', recentTranscript: 'r', maxTotal: 0 })).rejects.toThrow(/Invalid maxTotal/);
    await expect(fetchRelevantNodes({ pov: 'accelerationist', topic: 't', recentTranscript: 'r', minPerCategory: 2.5 })).rejects.toThrow(/Invalid minPerCategory/);
    await expect(fetchRelevantNodes({ pov: 'accelerationist', topic: 't', recentTranscript: 'r', minPerCategory: 11 })).rejects.toThrow(/Invalid minPerCategory/);
    await expect(fetchRelevantNodes({ pov: 'accelerationist', topic: 't', recentTranscript: 'r', maxTotal: 501 })).rejects.toThrow(/Invalid maxTotal/);
    expect(h.selectCalls).toHaveLength(0);
  });
});
