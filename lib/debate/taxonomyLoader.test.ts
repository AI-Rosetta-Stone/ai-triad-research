import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockFetchUrlForPrompt = vi.fn();

vi.mock('../url-fetch/fetchUrlForPrompt.js', () => ({
  fetchUrlForPrompt: (...args: unknown[]) => mockFetchUrlForPrompt(...args),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(),
  },
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(),
}));

vi.mock('../npy.js', () => ({
  parseNpy: vi.fn(),
  extractNodeVectors: vi.fn(() => ({})),
}));

const mockRecord = vi.fn();
vi.mock('../flight-recorder/index.js', () => ({
  getGlobalRecorder: () => ({ record: (...args: unknown[]) => mockRecord(...args) }),
}));

import { loadConflicts, fetchUrlContent, loadTaxonomy } from './taxonomyLoader.js';

const FAKE_DATA_ROOT = path.resolve('/fake/data');
const FAKE_ROOT = '/fake/repo';
const FAKE_CONFIG = {
  data_root: '../ai-triad-data',
  taxonomy_dir: 'taxonomy',
  conflicts_dir: 'conflicts',
  debates_dir: 'debates',
};

function setupFsMocks(conflictsFileContent: unknown | null) {
  mockExistsSync.mockImplementation((p: string) => {
    if (p === FAKE_DATA_ROOT) return true;
    if (p.endsWith('.aitriad.json')) return true;
    if (p.endsWith('conflicts.json')) return conflictsFileContent !== null;
    return false;
  });

  mockReadFileSync.mockImplementation((p: string) => {
    if (p.endsWith('.aitriad.json')) return JSON.stringify(FAKE_CONFIG);
    if (p.endsWith('conflicts.json') && conflictsFileContent !== null) {
      return JSON.stringify(conflictsFileContent);
    }
    throw new Error(`ENOENT: ${p}`);
  });
}

describe('loadConflicts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AI_TRIAD_DATA_ROOT = FAKE_DATA_ROOT;
  });

  afterEach(() => {
    delete process.env.AI_TRIAD_DATA_ROOT;
  });

  it('returns conflicts array from conflicts.json wrapper', () => {
    const conflicts = [
      { claim_id: 'c1', claim_label: 'Test', description: 'Desc', status: 'open', linked_taxonomy_nodes: [], instances: [] },
      { claim_id: 'c2', claim_label: 'Test2', description: 'Desc2', status: 'resolved', linked_taxonomy_nodes: ['acc-B-001'], instances: [] },
    ];
    setupFsMocks({ _schema_version: '2.0', conflict_count: 2, conflicts });

    const result = loadConflicts(FAKE_ROOT);
    expect(result).toEqual(conflicts);
    expect(result).toHaveLength(2);
  });

  it('returns empty array when conflicts.json does not exist', () => {
    setupFsMocks(null);
    const result = loadConflicts(FAKE_ROOT);
    expect(result).toEqual([]);
  });

  it('returns empty array when conflicts key is missing', () => {
    setupFsMocks({ _schema_version: '2.0', something_else: [] });
    const result = loadConflicts(FAKE_ROOT);
    expect(result).toEqual([]);
  });

  it('returns empty array when conflicts key is not an array', () => {
    setupFsMocks({ _schema_version: '2.0', conflicts: 'not-an-array' });
    const result = loadConflicts(FAKE_ROOT);
    expect(result).toEqual([]);
  });

  it('returns empty array when file is malformed JSON', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === FAKE_DATA_ROOT) return true;
      if (p.endsWith('.aitriad.json')) return true;
      if (p.endsWith('conflicts.json')) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p: string) => {
      if (p.endsWith('.aitriad.json')) return JSON.stringify(FAKE_CONFIG);
      if (p.endsWith('conflicts.json')) return '{not valid json';
      throw new Error(`ENOENT: ${p}`);
    });

    const result = loadConflicts(FAKE_ROOT);
    expect(result).toEqual([]);
  });

  it('reads from the correct path (conflicts_dir/conflicts.json)', () => {
    setupFsMocks({ _schema_version: '2.0', conflicts: [] });
    loadConflicts(FAKE_ROOT);

    const existsCalls = mockExistsSync.mock.calls.map((c: unknown[]) => c[0] as string);
    const conflictsCall = existsCalls.find((p: string) => p.includes('conflicts.json'));
    expect(conflictsCall).toMatch(/conflicts[/\\]conflicts\.json$/);
  });
});

describe('fetchUrlContent (L10 SSRF regression — t/2528)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns text from fetchUrlForPrompt on success', async () => {
    mockFetchUrlForPrompt.mockResolvedValue({ ok: true, text: 'Hello world', title: undefined, finalUrl: 'https://example.com', truncated: false });
    const result = await fetchUrlContent('https://example.com');
    expect(result).toBe('Hello world');
    expect(mockFetchUrlForPrompt).toHaveBeenCalledWith('https://example.com');
  });

  it('throws ActionableError when fetchUrlForPrompt blocks a private/SSRF URL', async () => {
    mockFetchUrlForPrompt.mockResolvedValue({ ok: false, reason: 'ssrf' });
    await expect(fetchUrlContent('http://169.254.169.254/latest/meta-data/')).rejects.toMatchObject({
      goal: 'Fetch debate source URL',
    });
  });

  it('throws ActionableError on network failure', async () => {
    mockFetchUrlForPrompt.mockResolvedValue({ ok: false, reason: 'network' });
    await expect(fetchUrlContent('https://unreachable.example.com')).rejects.toMatchObject({
      goal: 'Fetch debate source URL',
    });
  });
});

// ── loadTaxonomy — supersession (t/4354) ─────────────────────────────────────

function makeAccNode(id: string, label: string, superseded_by?: string): object {
  return {
    id, label, category: 'Beliefs',
    description: 'A Beliefs within accelerationist discourse that does something.',
    parent_id: null, children: [], situation_refs: [],
    ...(superseded_by !== undefined ? { superseded_by } : {}),
  };
}

function setupTaxonomyMocks(
  accNodes: object[],
  embeddings: Record<string, { pov: string; vector: number[] }> = {},
  edges: object[] = [],
) {
  const taxDir = '/fake/data/taxonomy';
  mockExistsSync.mockImplementation((p: string) => {
    if (p === FAKE_DATA_ROOT) return true;
    if (p.endsWith('.aitriad.json')) return true;
    if (p.endsWith('accelerationist.json')) return true;
    if (p.endsWith('embeddings.json')) return true;
    if (p.endsWith('edges.json')) return edges.length > 0;
    return false; // safetyist, skeptic, situations, policy, lineage, synthetic — all missing
  });
  mockReadFileSync.mockImplementation((p: string) => {
    if (p.endsWith('.aitriad.json')) return JSON.stringify(FAKE_CONFIG);
    if (p.endsWith('accelerationist.json')) return JSON.stringify({ nodes: accNodes });
    if (p.endsWith('embeddings.json')) return JSON.stringify({ nodes: embeddings });
    if (p.endsWith('edges.json')) return JSON.stringify({
      _schema_version: '1', _doc: '', last_modified: '', edge_types: [],
      edges,
    });
    return '{}';
  });
}

describe('loadTaxonomy — supersession (t/4354)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecord.mockReset();
    process.env.AI_TRIAD_DATA_ROOT = FAKE_DATA_ROOT;
  });
  afterEach(() => {
    delete process.env.AI_TRIAD_DATA_ROOT;
  });

  it('superseded node is absent from selectable nodes and embeddings, present in allNodesById', () => {
    setupTaxonomyMocks(
      [makeAccNode('acc-beliefs-001', 'Active'), makeAccNode('acc-beliefs-002', 'Retired', 'acc-beliefs-001')],
      { 'acc-beliefs-001': { pov: 'acc', vector: [1, 0] }, 'acc-beliefs-002': { pov: 'acc', vector: [0, 1] } },
    );
    const result = loadTaxonomy(FAKE_ROOT);
    const selectableIds = result.accelerationist.nodes.map(n => n.id);
    expect(selectableIds).toContain('acc-beliefs-001');
    expect(selectableIds).not.toContain('acc-beliefs-002');
    expect(result.allNodesById.has('acc-beliefs-002')).toBe(true);
    expect(result.embeddings['acc-beliefs-001']).toBeDefined();
    expect(result.embeddings['acc-beliefs-002']).toBeUndefined();
  });

  it('resolveNode returns non-superseded node for a normal node', () => {
    setupTaxonomyMocks([makeAccNode('acc-beliefs-001', 'Active')]);
    const result = loadTaxonomy(FAKE_ROOT);
    expect(result.resolveNode('acc-beliefs-001')?.id).toBe('acc-beliefs-001');
    expect(result.resolveNode('unknown-id')).toBeUndefined();
  });

  it('resolveNode follows a supersession chain to the final non-superseded node', () => {
    // Chain: 003 → 002 → 001 (001 is the active endpoint)
    setupTaxonomyMocks([
      makeAccNode('acc-beliefs-001', 'Active'),
      makeAccNode('acc-beliefs-002', 'Mid', 'acc-beliefs-001'),
      makeAccNode('acc-beliefs-003', 'Old', 'acc-beliefs-002'),
    ]);
    const result = loadTaxonomy(FAKE_ROOT);
    expect(result.resolveNode('acc-beliefs-003')?.id).toBe('acc-beliefs-001');
    expect(result.resolveNode('acc-beliefs-002')?.id).toBe('acc-beliefs-001');
    expect(result.resolveNode('acc-beliefs-001')?.id).toBe('acc-beliefs-001');
    // Chain members are absent from selectable nodes
    expect(result.accelerationist.nodes.map(n => n.id)).toEqual(['acc-beliefs-001']);
    // WARN emitted for the chain (length ≥ 3)
    const warnCalls: string[] = mockRecord.mock.calls
      .filter((c: unknown[]) => (c[0] as { level: string }).level === 'warn')
      .map((c: unknown[]) => (c[0] as { message: string }).message);
    expect(warnCalls.some(m => m.includes('chain') && m.includes('acc-beliefs-003'))).toBe(true);
  });

  it('cycle: both members absent from selection, resolveNode returns each node itself', () => {
    // Cycle: 001 → 002 → 001
    setupTaxonomyMocks([
      makeAccNode('acc-beliefs-001', 'CycleA', 'acc-beliefs-002'),
      makeAccNode('acc-beliefs-002', 'CycleB', 'acc-beliefs-001'),
    ]);
    const result = loadTaxonomy(FAKE_ROOT);
    expect(result.accelerationist.nodes).toHaveLength(0);
    expect(result.resolveNode('acc-beliefs-001')?.id).toBe('acc-beliefs-001');
    expect(result.resolveNode('acc-beliefs-002')?.id).toBe('acc-beliefs-002');
    // WARN emitted for the cycle; no throw
    const warnCalls: string[] = mockRecord.mock.calls
      .filter((c: unknown[]) => (c[0] as { level: string }).level === 'warn')
      .map((c: unknown[]) => (c[0] as { message: string }).message);
    expect(warnCalls.some(m => m.includes('cycle'))).toBe(true);
  });

  it('dangling target: node excluded from selection, resolveNode returns node itself', () => {
    setupTaxonomyMocks([makeAccNode('acc-beliefs-001', 'Dangling', 'acc-beliefs-MISSING')]);
    const result = loadTaxonomy(FAKE_ROOT);
    expect(result.accelerationist.nodes).toHaveLength(0);
    expect(result.resolveNode('acc-beliefs-001')?.id).toBe('acc-beliefs-001');
    // WARN emitted for the dangling target
    const warnCalls: string[] = mockRecord.mock.calls
      .filter((c: unknown[]) => (c[0] as { level: string }).level === 'warn')
      .map((c: unknown[]) => (c[0] as { message: string }).message);
    expect(warnCalls.some(m => m.includes('acc-beliefs-MISSING'))).toBe(true);
  });

  it('selectableEdges excludes edges with a superseded endpoint', () => {
    setupTaxonomyMocks(
      [makeAccNode('acc-beliefs-001', 'Active'), makeAccNode('acc-beliefs-002', 'Retired', 'acc-beliefs-001')],
      {},
      [
        { source: 'acc-beliefs-001', target: 'acc-beliefs-002', type: 'SUPPORTS', bidirectional: false, confidence: 0.8, rationale: '', status: 'approved', discovered_at: '', model: 'test' },
        { source: 'acc-beliefs-001', target: 'acc-beliefs-001', type: 'SUPPORTS', bidirectional: false, confidence: 0.9, rationale: '', status: 'approved', discovered_at: '', model: 'test' },
      ],
    );
    const result = loadTaxonomy(FAKE_ROOT);
    expect(result.selectableEdges).toHaveLength(1);
    expect(result.selectableEdges![0].source).toBe('acc-beliefs-001');
    expect(result.selectableEdges![0].target).toBe('acc-beliefs-001');
    // Full edge set is unchanged
    expect(result.edges!.edges).toHaveLength(2);
  });
});
