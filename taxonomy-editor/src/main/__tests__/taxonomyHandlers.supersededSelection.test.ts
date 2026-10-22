// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/4432 (t/4424 audit): `fetch-relevant-nodes` and `compute-attribution` read raw POV files
 * and must exclude superseded nodes before offering them as new-selection/attribution
 * candidates (SO C1, t/4355) — the same rule `lib/debate/taxonomyLoader.ts`'s `loadTaxonomy`
 * already applies elsewhere. Mirrors fetchRelevantNodesDoctrinalBoundaries.test.ts's scaffold:
 * only the file-read side of taxonomyHandlers.ts is faked; the real `selectablePovNodes`
 * filter (lib/debate/supersession.js) is NOT mocked, since that's exactly what's under test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  povFileNodes: [] as unknown[],
  lastSelectArgs: undefined as { povNodes?: { id: string }[] } | undefined,
  lastAssembleArgs: undefined as { pov?: string; povNodes?: { id: string }[] } | undefined,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { h.handlers.set(ch, fn); } },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../fileIO.js', () => {
  const stub = (): undefined => undefined;
  return {
    readTaxonomyFile: (pov: string): unknown => (pov === 'situations' ? { nodes: [] } : { nodes: h.povFileNodes }),
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

// Spies capturing exactly what reaches the real selection/attribution libs — the handler's own
// embedding/scoring logic doesn't run. selectablePovNodes (lib/debate/supersession.js) is real.
vi.mock('../../../../lib/debate/relevanceSelection.js', () => ({
  assembleNodeEmbeddings: vi.fn((pov: string, povNodes: { id: string }[]) => {
    h.lastAssembleArgs = { pov, povNodes };
    return { nodeEmbeddings: {} };
  }),
  selectRelevantTaxonomy: vi.fn((args: { povNodes?: { id: string }[] }) => {
    h.lastSelectArgs = args;
    return { selectedNodes: [], injectionManifest: {} };
  }),
}));

vi.mock('../../../../lib/debate/argumentNetwork/attribution.js', () => ({
  computeClaimTaxonomyAttribution: vi.fn(() => ({ attributions: [] })),
}));

// Imported AFTER the mocks so taxonomyHandlers binds the mocked deps.
import { registerTaxonomyHandlers } from '../ipc/taxonomyHandlers.js';
import { computeClaimTaxonomyAttribution } from '../../../../lib/debate/argumentNetwork/attribution.js';

function fetchRelevantNodes(payload: unknown): unknown {
  const fn = h.handlers.get('fetch-relevant-nodes');
  if (!fn) throw new Error('fetch-relevant-nodes not registered');
  return fn({}, payload);
}

function computeAttribution(payload: unknown): unknown {
  const fn = h.handlers.get('compute-attribution');
  if (!fn) throw new Error('compute-attribution not registered');
  return fn({}, payload);
}

const LIVE = { id: 'acc-desires-100', label: 'Live node', description: 'd' };
const SUPERSEDED = { id: 'acc-desires-099', label: 'Old node', description: 'd', superseded_by: 'acc-desires-100' };

beforeEach(() => {
  h.handlers.clear();
  h.povFileNodes = [SUPERSEDED, LIVE];
  h.lastSelectArgs = undefined;
  h.lastAssembleArgs = undefined;
  registerTaxonomyHandlers();
});

describe('fetch-relevant-nodes: excludes superseded nodes from selection (t/4432)', () => {
  it('neither selectRelevantTaxonomy nor assembleNodeEmbeddings see the superseded node', async () => {
    await fetchRelevantNodes({ pov: 'accelerationist', topic: 't', recentTranscript: 'r' });

    expect(h.lastAssembleArgs?.povNodes?.map(n => n.id)).toEqual(['acc-desires-100']);
    expect(h.lastSelectArgs?.povNodes?.map(n => n.id)).toEqual(['acc-desires-100']);
  });

  it('the live node still reaches both', async () => {
    await fetchRelevantNodes({ pov: 'accelerationist', topic: 't', recentTranscript: 'r' });

    expect(h.lastAssembleArgs?.povNodes?.some(n => n.id === 'acc-desires-100')).toBe(true);
    expect(h.lastSelectArgs?.povNodes?.some(n => n.id === 'acc-desires-100')).toBe(true);
  });
});

describe('compute-attribution: excludes superseded nodes from candidate ids (t/4432)', () => {
  it('candidateNodeIds passed to computeClaimTaxonomyAttribution excludes the superseded node', async () => {
    await computeAttribution({ pov: 'accelerationist', claims: [{ id: 'claim-1' }] });

    const mockFn = computeClaimTaxonomyAttribution as unknown as { mock: { calls: unknown[][] } };
    const [, , , candidateNodeIds] = mockFn.mock.calls[0] as [unknown, unknown, unknown, Set<string>];
    expect(candidateNodeIds.has('acc-desires-099')).toBe(false);
    expect(candidateNodeIds.has('acc-desires-100')).toBe(true);
  });

  it('assembleNodeEmbeddings also excludes the superseded node', async () => {
    await computeAttribution({ pov: 'accelerationist', claims: [{ id: 'claim-1' }] });
    expect(h.lastAssembleArgs?.povNodes?.map(n => n.id)).toEqual(['acc-desires-100']);
  });
});
