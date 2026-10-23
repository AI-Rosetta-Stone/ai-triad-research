// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4439: reloadKeepingEdits — refresh stale untouched nodes from the rebased branch without losing unsaved
// edits (the save-bar Resync, t/4346). Every row of the approved merge table (t/4439#1-#3), the local-position
// rule, the all-or-nothing failure paths, and the end-to-end Resync case. Mock setup mirrors
// useTaxonomyStore.staleBranch.test.ts (vi.mock is file-scoped).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockApi, record, getSyncStatus, schema, extractPovErrors, validateTaxonomy } = vi.hoisted(() => ({
  mockApi: {
    loadTaxonomyFile: vi.fn().mockResolvedValue({ nodes: [] }),
    loadTaxonomyFileForEdit: vi.fn().mockResolvedValue({ nodes: [] }),
    loadTaxonomyFilesForEdit: vi.fn(),
    saveTaxonomyFile: vi.fn().mockResolvedValue(undefined),
    loadPolicyRegistry: vi.fn().mockResolvedValue({ policies: [] }),
    loadConflictFiles: vi.fn().mockResolvedValue([]),
    loadConflictClusters: vi.fn().mockResolvedValue({ clusters: [] }),
    loadAggregatedCruxes: vi.fn().mockResolvedValue({ cruxes: [] }),
    saveConflictFile: vi.fn().mockResolvedValue(undefined),
    syncCommit: vi.fn().mockResolvedValue({ commitSha: 'abc', filesCommitted: 1 }),
    updateNodeEmbeddings: vi.fn().mockResolvedValue(undefined),
    loadEdges: vi.fn().mockResolvedValue({ edges: [] }),
    loadAIModels: vi.fn().mockResolvedValue(null),
    computeEmbeddings: vi.fn().mockResolvedValue({ vectors: [] }),
    computeQueryEmbedding: vi.fn().mockResolvedValue({ vector: [] }),
    generateText: vi.fn().mockResolvedValue({ text: '{}' }),
    nliClassify: vi.fn().mockResolvedValue({ results: [] }),
    hasApiKey: vi.fn().mockResolvedValue(false),
    onGenerateTextProgress: vi.fn().mockReturnValue(() => {}),
    trackEvent: vi.fn(),
    saveEdges: vi.fn().mockResolvedValue(undefined),
  },
  record: vi.fn(),
  getSyncStatus: vi.fn(),
  schema: { safeParse: vi.fn() },
  extractPovErrors: vi.fn(),
  validateTaxonomy: vi.fn(),
}));

vi.mock('@bridge', () => ({ api: mockApi }));
vi.mock('@lib/debate', () => ({ normalizeNodeProperties: vi.fn() }));
vi.mock('@lib/debate/nodeIdUtils', () => ({
  nodeTypeFromId: vi.fn((id: string) => (id.startsWith('sit-') || id.startsWith('cc-') ? 'situation' : 'pov')),
}));
vi.mock('@lib/debate/types', () => ({ POV_KEYS: ['accelerationist', 'safetyist', 'skeptic'] }));
vi.mock('@lib/debate/validators', () => ({ validateTaxonomy }));
vi.mock('@lib/debate/validateNodeId', () => ({ validatePovNodeId: vi.fn().mockReturnValue({ valid: true }) }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: vi.fn().mockReturnValue({ record }) }));
vi.mock('../utils/validation', () => ({
  povTaxonomyFileSchema: schema,
  crossCuttingFileSchema: { safeParse: vi.fn().mockReturnValue({ success: true }) },
  conflictFileSchema: { safeParse: vi.fn().mockReturnValue({ success: true }) },
  extractPovErrors,
  extractConflictErrors: vi.fn().mockReturnValue({}),
  stripInvalidLogicalForm: vi.fn().mockReturnValue({ removed: false }),
}));
vi.mock('../utils/similarity', () => ({ rankBySimilarity: vi.fn().mockReturnValue([]) }));
vi.mock('../utils/errorMessages', () => ({ mapErrorToUserMessage: vi.fn((err: unknown) => String(err)) }));
vi.mock('../utils/syncApi', () => ({ getSyncStatus }));

import { useTaxonomyStore } from './useTaxonomyStore';
import { markFilesAsBaseline, __resetBaselineNodesForTests } from './useTaxonomyStore/slices/staleBranchHint';
import { mergeNodes, conflictNote } from './useTaxonomyStore/slices/reloadKeepingEdits';
import { EMPTY_HELD, __resetSupersededCacheForTests } from './useTaxonomyStore/superseded';
import type { PovTaxonomyFile, PovNode } from '../types/taxonomy';

const node = (id: string, label = `label ${id}`, over: Partial<PovNode> = {}): PovNode =>
  ({ id, category: 'Beliefs', label, description: 'd', parent_id: null, children: [], situation_refs: [], ...over } as PovNode);
const povFile = (nodes: PovNode[]): PovTaxonomyFile => ({ pov: 'accelerationist', last_modified: '2026-01-01', nodes } as PovTaxonomyFile);
const ids = (ns: { id: string }[]) => ns.map(n => n.id);
/** A fresh copy, as a re-read from the server would give (new objects, same values). */
const reread = (ns: PovNode[]) => ns.map(n => ({ ...n }));

beforeEach(() => {
  vi.clearAllMocks();
  __resetBaselineNodesForTests();
  __resetSupersededCacheForTests();
});

describe('mergeNodes: the approved table (t/4439#1, #3)', () => {
  it('untouched + upstream present → fresh', () => {
    const a = node('acc-beliefs-001');
    markFilesAsBaseline([povFile([a])]);
    const fresh = [node('acc-beliefs-001', 'changed upstream')];
    const r = mergeNodes([a], fresh);
    expect(r.nodes[0]).toBe(fresh[0]);
    expect(r.counts).toMatchObject({ refreshed: 1, kept: 0 });
    expect(r.conflicts).toEqual([]);
  });

  it('untouched + upstream gone → dropped', () => {
    const a = node('acc-beliefs-001'); const b = node('acc-beliefs-002');
    markFilesAsBaseline([povFile([a, b])]);
    const r = mergeNodes([a, b], reread([a]));
    expect(ids(r.nodes)).toEqual(['acc-beliefs-001']);
    expect(r.counts.dropped).toBe(1);
  });

  it('edited + upstream unchanged → local kept, no conflict', () => {
    const a = node('acc-beliefs-001');
    markFilesAsBaseline([povFile([a])]);
    const mine = { ...a, label: 'my edit' };
    const r = mergeNodes([mine], reread([a]));
    expect(r.nodes[0]).toBe(mine);
    expect(r.conflicts).toEqual([]);
  });

  it('edited + upstream also changed → local kept, conflict reported', () => {
    const a = node('acc-beliefs-001');
    markFilesAsBaseline([povFile([a])]);
    const mine = { ...a, label: 'my edit' };
    const r = mergeNodes([mine], [node('acc-beliefs-001', 'their edit')]);
    expect(r.nodes[0]).toBe(mine);
    expect(r.conflicts).toEqual([{ id: 'acc-beliefs-001', kind: 'edited-also-changed-upstream' }]);
  });

  it('edited + deleted upstream → local kept, conflict reported', () => {
    const a = node('acc-beliefs-001'); const b = node('acc-beliefs-002');
    markFilesAsBaseline([povFile([a, b])]);
    const mine = { ...b, label: 'my edit' };
    const r = mergeNodes([a, mine], reread([a]));
    expect(ids(r.nodes)).toEqual(['acc-beliefs-001', 'acc-beliefs-002']);
    expect(r.nodes[1]).toBe(mine);
    expect(r.conflicts).toEqual([{ id: 'acc-beliefs-002', kind: 'edited-deleted-upstream' }]);
  });

  it('deleted locally + upstream unchanged → stays deleted, no conflict', () => {
    const a = node('acc-beliefs-001'); const b = node('acc-beliefs-002');
    markFilesAsBaseline([povFile([a, b])]);
    const r = mergeNodes([a], reread([a, b]));
    expect(ids(r.nodes)).toEqual(['acc-beliefs-001']);
    expect(r.counts.keptDeleted).toBe(1);
    expect(r.conflicts).toEqual([]);
  });

  it('deleted locally + upstream changed → stays deleted, conflict reported', () => {
    const a = node('acc-beliefs-001'); const b = node('acc-beliefs-002');
    markFilesAsBaseline([povFile([a, b])]);
    const r = mergeNodes([a], [...reread([a]), node('acc-beliefs-002', 'their edit')]);
    expect(ids(r.nodes)).toEqual(['acc-beliefs-001']);
    expect(r.conflicts).toEqual([{ id: 'acc-beliefs-002', kind: 'deleted-also-changed-upstream' }]);
  });

  it('new upstream → added', () => {
    const a = node('acc-beliefs-001');
    markFilesAsBaseline([povFile([a])]);
    const r = mergeNodes([a], [...reread([a]), node('acc-beliefs-009')]);
    expect(ids(r.nodes)).toEqual(['acc-beliefs-001', 'acc-beliefs-009']);
    expect(r.counts.added).toBe(1);
  });

  it('a value-equal re-serialization (different key order) is not "changed upstream"', () => {
    const a = node('acc-beliefs-001');
    markFilesAsBaseline([povFile([a])]);
    const mine = { ...a, label: 'my edit' };
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as unknown as PovNode;
    expect(mergeNodes([mine], [reordered]).conflicts).toEqual([]);
  });
});

describe('mergeNodes: local position for new local nodes (t/4439#3)', () => {
  const a = node('acc-beliefs-001'); const b = node('acc-beliefs-002'); const c = node('acc-beliefs-003');
  beforeEach(() => markFilesAsBaseline([povFile([a, b, c])]));
  const n1 = node('acc-beliefs-101'); const n2 = node('acc-beliefs-102');

  it('first', () => expect(ids(mergeNodes([n1, a, b, c], reread([a, b, c])).nodes)).toEqual(['acc-beliefs-101', 'acc-beliefs-001', 'acc-beliefs-002', 'acc-beliefs-003']));
  it('mid-file', () => expect(ids(mergeNodes([a, n1, b, c], reread([a, b, c])).nodes)).toEqual(['acc-beliefs-001', 'acc-beliefs-101', 'acc-beliefs-002', 'acc-beliefs-003']));
  it('last', () => expect(ids(mergeNodes([a, b, c, n1], reread([a, b, c])).nodes)).toEqual(['acc-beliefs-001', 'acc-beliefs-002', 'acc-beliefs-003', 'acc-beliefs-101']));
  it('two adjacent keep their order', () => expect(ids(mergeNodes([a, n1, n2, b, c], reread([a, b, c])).nodes)).toEqual(['acc-beliefs-001', 'acc-beliefs-101', 'acc-beliefs-102', 'acc-beliefs-002', 'acc-beliefs-003']));
  it('after a preceding neighbour that was dropped upstream: the next surviving one', () => {
    // b is untouched and deleted upstream, so n1 lands after a (b's predecessor in the result).
    expect(ids(mergeNodes([a, b, n1, c], reread([a, c])).nodes)).toEqual(['acc-beliefs-001', 'acc-beliefs-101', 'acc-beliefs-003']);
  });
});

describe('conflictNote', () => {
  it('is null with no conflicts, and names each id otherwise', () => {
    expect(conflictNote([])).toBeNull();
    const note = conflictNote([{ id: 'acc-beliefs-002', kind: 'deleted-also-changed-upstream' }]);
    expect(note).toContain('acc-beliefs-002');
    expect(note).toContain('your delete was kept');
  });
});

describe('store.reloadKeepingEdits', () => {
  const empty = { nodes: [] };
  function loadState(nodes: PovNode[]) {
    const loaded = povFile(nodes);
    markFilesAsBaseline([loaded]);
    useTaxonomyStore.setState({
      accelerationist: loaded, safetyist: null, skeptic: null, situations: null, supersededNodes: EMPTY_HELD,
      dirty: new Set(['accelerationist']), saveError: null, staleBranchHint: null, validationErrors: {},
    } as never);
    return loaded;
  }

  beforeEach(() => {
    schema.safeParse.mockReturnValue({ success: true });
    extractPovErrors.mockReturnValue({});
    validateTaxonomy.mockReturnValue({ issues: [] });
  });

  it('keeps the edit, refreshes the untouched node, leaves dirty alone', async () => {
    const [stale, mine] = loadState([node('acc-beliefs-001', 'stale'), node('acc-beliefs-002')]).nodes;
    const edited = { ...mine, label: 'my edit' };
    useTaxonomyStore.setState({ accelerationist: povFile([stale, edited]) } as never);
    mockApi.loadTaxonomyFilesForEdit.mockResolvedValue([povFile([node('acc-beliefs-001', 'fresh'), node('acc-beliefs-002')]), empty, empty, empty]);

    const report = await useTaxonomyStore.getState().reloadKeepingEdits();
    const s = useTaxonomyStore.getState();
    expect(report).toMatchObject({ ok: true, message: null, counts: { refreshed: 1, kept: 1 } });
    expect(s.accelerationist?.nodes.map(n => n.label)).toEqual(['fresh', 'my edit']);
    expect(s.accelerationist?.nodes[1]).toBe(edited);
    expect([...s.dirty]).toEqual(['accelerationist']);
    expect(mockApi.loadTaxonomyFilesForEdit).toHaveBeenCalledWith(['accelerationist', 'safetyist', 'skeptic', 'situations']);
  });

  it('a read failure changes nothing and returns a message', async () => {
    const loaded = loadState([node('acc-beliefs-001')]);
    mockApi.loadTaxonomyFilesForEdit.mockRejectedValue(new Error('offline'));
    const report = await useTaxonomyStore.getState().reloadKeepingEdits();
    expect(report.ok).toBe(false);
    expect(report.message).toContain('offline');
    expect(useTaxonomyStore.getState().accelerationist).toBe(loaded);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ type: 'system.error', level: 'error' }));
  });

  it('a file without nodes is refused (never read as "everything deleted upstream")', async () => {
    const loaded = loadState([node('acc-beliefs-001')]);
    mockApi.loadTaxonomyFilesForEdit.mockResolvedValue([null, empty, empty, empty]);
    const report = await useTaxonomyStore.getState().reloadKeepingEdits();
    expect(report.ok).toBe(false);
    expect(report.message).toContain('accelerationist');
    expect(useTaxonomyStore.getState().accelerationist).toBe(loaded);
  });

  it('end to end: a stale-node save fails, reload, and the retried save validates with the edit intact', async () => {
    getSyncStatus.mockResolvedValue({ enabled: true, session_branch: 'session/jdoe-123', behind_by: 3 });
    // The schema rejects the stale value on the untouched node.
    schema.safeParse.mockImplementation((f: PovTaxonomyFile) => (f.nodes.some(n => n.label === 'stale') ? { success: false, error: {} } : { success: true }));
    extractPovErrors.mockReturnValue({ 'nodes.acc-beliefs-001.label': 'invalid' });
    const [stale, mine] = loadState([node('acc-beliefs-001', 'stale'), node('acc-beliefs-002')]).nodes;
    useTaxonomyStore.setState({ accelerationist: povFile([stale, { ...mine, label: 'my edit' }]) } as never);

    await useTaxonomyStore.getState().save();
    expect(useTaxonomyStore.getState().staleBranchHint?.untouchedNodeIds).toEqual(['acc-beliefs-001']);
    expect(mockApi.saveTaxonomyFile).not.toHaveBeenCalled();

    mockApi.loadTaxonomyFilesForEdit.mockResolvedValue([povFile([node('acc-beliefs-001', 'fresh'), node('acc-beliefs-002')]), empty, empty, empty]);
    await useTaxonomyStore.getState().reloadKeepingEdits();
    useTaxonomyStore.getState().dismissSaveError();
    await useTaxonomyStore.getState().save();

    expect(useTaxonomyStore.getState().saveError).toBeNull();
    const saved = mockApi.saveTaxonomyFile.mock.calls.find(c => c[0] === 'accelerationist')?.[1] as PovTaxonomyFile;
    expect(saved.nodes.map(n => n.label)).toEqual(['fresh', 'my edit']);
  });
});
