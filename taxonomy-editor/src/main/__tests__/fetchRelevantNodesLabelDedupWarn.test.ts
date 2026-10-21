// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/4369 gap 3 (Electron leg): relevanceSelection.ts's per-camp label dedup writes
 * `injectionManifest.label_dedup` when it skips a duplicate-label node, but nothing logged it
 * (`git grep label_dedup` hit only the lib/debate test). The `fetch-relevant-nodes` IPC handler
 * — the main-process mirror of the server's `routes/relevantNodes.ts` — must record a WARN
 * naming the skipped ids so a dropped twin is diagnosable from a flight-recorder dump, not just
 * a manual diff. Mirrors the scaffold in fetchRelevantNodesDoctrinalBoundaries.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
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
  selectRelevantTaxonomy: vi.fn(async () => h.selectResult),
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

describe('fetch-relevant-nodes IPC: label_dedup WARN (t/4369 gap 3)', () => {
  it('records a warn when injectionManifest.label_dedup is non-empty', async () => {
    h.selectResult = { injectionManifest: { label_dedup: ['skp-intentions-153 (dup of skp-intentions-146: "Same label")'] } };
    await fetchRelevantNodes({ pov: 'accelerationist', topic: 't', recentTranscript: 'r' });

    expect(h.recorded).toHaveLength(1);
    const entry = h.recorded[0] as { level: string; message: string; data: { labelDedup: string[] } };
    expect(entry.level).toBe('warn');
    expect(entry.message).toContain('label-duplicate');
    expect(entry.data.labelDedup).toEqual(['skp-intentions-153 (dup of skp-intentions-146: "Same label")']);
  });

  it('records nothing when label_dedup is absent', async () => {
    h.selectResult = { injectionManifest: {} };
    await fetchRelevantNodes({ pov: 'accelerationist', topic: 't', recentTranscript: 'r' });
    expect(h.recorded).toHaveLength(0);
  });

  it('records nothing when label_dedup is an empty array', async () => {
    h.selectResult = { injectionManifest: { label_dedup: [] } };
    await fetchRelevantNodes({ pov: 'accelerationist', topic: 't', recentTranscript: 'r' });
    expect(h.recorded).toHaveLength(0);
  });
});
