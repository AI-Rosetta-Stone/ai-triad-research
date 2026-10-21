// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4325 (child of t/4324): a save that fails validation on nodes the user never edited, while the session
// branch is behind main, names the stale branch; every save.validation event carries session_branch and
// behind_by. Mock setup mirrors useTaxonomyStore.saveConflict.test.ts (vi.mock is file-scoped).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockApi, record, getSyncStatus, schema, extractPovErrors, validateTaxonomy } = vi.hoisted(() => ({
  mockApi: {
    loadTaxonomyFile: vi.fn().mockResolvedValue({ nodes: [] }),
    loadTaxonomyFileForEdit: vi.fn().mockResolvedValue({ nodes: [] }),
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
import type { PovTaxonomyFile, PovNode } from '../types/taxonomy';

const makePovNode = (overrides: Partial<PovNode> = {}): PovNode => ({
  id: 'acc-beliefs-001', category: 'Beliefs', label: 'Test node', description: 'A test belief node',
  parent_id: null, children: [], situation_refs: [], ...overrides,
} as PovNode);
const makePovFile = (nodes: PovNode[]): PovTaxonomyFile =>
  ({ pov: 'accelerationist', last_modified: '2026-01-01', nodes } as PovTaxonomyFile);

const validationEvents = () => record.mock.calls.map(c => c[0]).filter(e => e.message === 'save.validation');
const STALE = { enabled: true, session_branch: 'session/jdoe-123', behind_by: 3 };

/** A loaded file with one stale (untouched, invalid) node and one node the user edited. */
function loadWithStaleNode() {
  const stale = makePovNode({ id: 'acc-beliefs-001' });
  const mine = makePovNode({ id: 'acc-beliefs-002' });
  const loaded = makePovFile([stale, mine]);
  markFilesAsBaseline([loaded]);
  const edited = makePovFile([stale, { ...mine, label: 'edited by user' }]);
  useTaxonomyStore.setState({ accelerationist: edited, dirty: new Set(['accelerationist']) });
}

const failSchemaOn = (keys: Record<string, string>) => {
  schema.safeParse.mockReturnValue({ success: false, error: {} });
  extractPovErrors.mockReturnValue(keys);
};

describe('save validation on a stale session branch (t/4325)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetBaselineNodesForTests();
    schema.safeParse.mockReturnValue({ success: true });
    extractPovErrors.mockReturnValue({});
    validateTaxonomy.mockReturnValue({ issues: [] });
    getSyncStatus.mockResolvedValue(STALE);
    useTaxonomyStore.setState({ accelerationist: null, dirty: new Set(), saveError: null, staleBranchHint: null, validationErrors: {} });
  });

  it('schema errors on an untouched node while behind: the banner names the branch and sets the hint', async () => {
    loadWithStaleNode();
    failSchemaOn({ 'nodes.acc-beliefs-001.operationality': 'out of range' });
    await useTaxonomyStore.getState().save();
    const s = useTaxonomyStore.getState();
    expect(s.saveError).toContain('session/jdoe-123');
    expect(s.saveError).toContain('3 commits behind main');
    expect(s.saveError).toContain('acc-beliefs-001');
    expect(s.staleBranchHint).toEqual({ sessionBranch: 'session/jdoe-123', behindBy: 3, untouchedNodeIds: ['acc-beliefs-001'] });
    expect(s.validationErrors).toEqual({ 'nodes.acc-beliefs-001.operationality': 'out of range' });
    expect(mockApi.saveTaxonomyFile).not.toHaveBeenCalled();
  });

  it('the save.validation event carries session_branch and behind_by', async () => {
    loadWithStaleNode();
    failSchemaOn({ 'nodes.acc-beliefs-001.operationality': 'out of range' });
    await useTaxonomyStore.getState().save();
    expect(validationEvents()).toHaveLength(1);
    expect(validationEvents()[0].data).toMatchObject({
      stage: 'schema', session_branch: 'session/jdoe-123', behind_by: 3, untouched_error_node_count: 1, stale_branch_hint: true,
    });
  });

  it('errors only on the node the user edited: the usual message, no hint, branch context still recorded', async () => {
    loadWithStaleNode();
    failSchemaOn({ 'nodes.acc-beliefs-002.label': 'too long' });
    await useTaxonomyStore.getState().save();
    const s = useTaxonomyStore.getState();
    expect(s.saveError).toBe('Validation failed. Fix errors before saving.');
    expect(s.staleBranchHint).toBeNull();
    expect(validationEvents()[0].data).toMatchObject({ session_branch: 'session/jdoe-123', behind_by: 3, stale_branch_hint: false });
  });

  it('branch up to date: no hint even for an untouched node', async () => {
    getSyncStatus.mockResolvedValue({ ...STALE, behind_by: 0 });
    loadWithStaleNode();
    failSchemaOn({ 'nodes.acc-beliefs-001.operationality': 'out of range' });
    await useTaxonomyStore.getState().save();
    expect(useTaxonomyStore.getState().staleBranchHint).toBeNull();
    expect(validationEvents()[0].data).toMatchObject({ behind_by: 0 });
  });

  it('fault arm: sync status unavailable (sync off or server down) falls back to the usual message', async () => {
    getSyncStatus.mockResolvedValue({ enabled: false, session_branch: null, unsynced_count: 0 });
    loadWithStaleNode();
    failSchemaOn({ 'nodes.acc-beliefs-001.operationality': 'out of range' });
    await useTaxonomyStore.getState().save();
    expect(useTaxonomyStore.getState().saveError).toBe('Validation failed. Fix errors before saving.');
    expect(validationEvents()[0].data).toMatchObject({ session_branch: null, behind_by: null });
  });

  it('integrity errors on an untouched node while behind: the stale-branch lines lead the integrity summary', async () => {
    useTaxonomyStore.setState({ safetyist: makePovFile([]), skeptic: makePovFile([]), situations: { nodes: [] } as never, edgesFile: { edges: [] } as never });
    loadWithStaleNode();
    validateTaxonomy.mockReturnValue({ issues: [{ severity: 'error', code: 'DANGLING_REF', entityId: 'acc-beliefs-001', message: 'x' }] });
    await useTaxonomyStore.getState().save();
    const s = useTaxonomyStore.getState();
    expect(s.saveError).toMatch(/^Save blocked: .*session\/jdoe-123/s);
    expect(s.saveError).toContain('Integrity check failed (1 error)');
    expect(validationEvents()[0].data).toMatchObject({ stage: 'integrity', session_branch: 'session/jdoe-123', behind_by: 3 });
  });

  it('dismissing the error, or a clean save, clears the hint; a saved node becomes the new baseline', async () => {
    loadWithStaleNode();
    failSchemaOn({ 'nodes.acc-beliefs-001.operationality': 'out of range' });
    await useTaxonomyStore.getState().save();
    useTaxonomyStore.getState().dismissSaveError();
    expect(useTaxonomyStore.getState().staleBranchHint).toBeNull();

    // A clean save of the edited node makes it baseline: a later failure on it reads as untouched.
    schema.safeParse.mockReturnValue({ success: true });
    await useTaxonomyStore.getState().save();
    expect(useTaxonomyStore.getState().dirty.size).toBe(0);
    useTaxonomyStore.setState({ dirty: new Set(['accelerationist']) });
    failSchemaOn({ 'nodes.acc-beliefs-002.label': 'too long' });
    await useTaxonomyStore.getState().save();
    expect(useTaxonomyStore.getState().staleBranchHint?.untouchedNodeIds).toEqual(['acc-beliefs-002']);
  });
});
