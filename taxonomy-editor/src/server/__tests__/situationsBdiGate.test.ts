// @vitest-environment node

// t/3890 — BDI gate for PUT /api/taxonomy/situations.
//
// Tests confirm the five required cases from the ticket:
//   1. Changed situation with flat string interpretation → 400, nothing written
//   2. Changed situation with empty BDI field → 400, nothing written
//   3. Complete BDI change → 200, written
//   4. Untouched deprecated flat node + valid change → 200 (deprecated nodes exempt)
//   5. Old-file read failure (non-ENOENT) → 500, fails closed

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────

const { mockReadTaxonomy, mockWriteTaxonomy } = vi.hoisted(() => ({
  mockReadTaxonomy: vi.fn(),
  mockWriteTaxonomy: vi.fn(),
}));

vi.mock('../storage/fileIO.js', () => ({
  readTaxonomyFile: mockReadTaxonomy,
  // t/4229: prepareTaxonomyNodeWrite now reads via readTaxonomyFileWithVersion; delegate through
  // mockReadTaxonomy so each test's success/rejection setup still applies, wrapped with the version
  // that matches this file's fixed 'base-sha' If-Match.
  readTaxonomyFileWithVersion: async (pov: string) => ({ data: await mockReadTaxonomy(pov), version: 'base-sha' }),
  writeTaxonomyFile: mockWriteTaxonomy,
}));

const { mockIsAnonymousUser } = vi.hoisted(() => ({ mockIsAnonymousUser: vi.fn(() => false) }));
vi.mock('../security/userContext.js', () => ({ isAnonymousUser: mockIsAnonymousUser }));

vi.mock('../featureFlags.js', () => ({ getFlag: vi.fn(() => false) }));
vi.mock('../groundingReconcileHook.js', () => ({ enqueueGroundingReconcile: vi.fn() }));
vi.mock('../storage/editMeta.js', () => ({
  stampNodeAuthorship: vi.fn((_old: unknown[], incoming: unknown[]) => incoming),
  diffNodes: vi.fn((old: Array<{ id: string }>, incoming: Array<{ id: string }>) => {
    // Content-aware mock: unchanged nodes (same JSON) do NOT appear in modified
    const oldMap = new Map(old.map(n => [n.id, JSON.stringify(n)]));
    const newIds = new Set(incoming.map(n => n.id));
    const added = incoming.filter(n => !oldMap.has(n.id)).map(n => n.id);
    const modified = incoming.filter(n => oldMap.has(n.id) && oldMap.get(n.id) !== JSON.stringify(n)).map(n => n.id);
    const deleted = old.filter(n => !newIds.has(n.id)).map(n => n.id);
    return { added, modified, deleted };
  }),
}));

import { registerTaxonomyRoutes } from '../routes/taxonomy.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

type Handler = (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void> | void;

function makeRouter() {
  const handlers: Record<string, Handler> = {};
  const reg = (m: string) => (p: string, h: Handler) => { handlers[`${m} ${p}`] = h; };
  return {
    router: { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), del: reg('DELETE') },
    handlers,
  };
}

function fakeReq() {
  return { url: '/api/taxonomy/situations', headers: { 'if-match': '"base-sha"' } } as unknown as IncomingMessage;
}

function fakeRes() {
  const res = {
    writeHead: vi.fn((s: number) => { res._status = s; }),
    end: vi.fn((b?: string) => { res._body = b; }),
    setHeader: vi.fn(),
    _status: undefined as number | undefined,
    _body: undefined as string | undefined,
  } as unknown as ServerResponse & { _status?: number; _body?: string };
  return res;
}

function makeBdiNode(id: string, belief = 'A belief.', desire = 'A desire.', intention = 'An intention.') {
  return {
    id,
    label: `Node ${id}`,
    description: 'A situation.',
    interpretations: {
      accelerationist: { belief, desire, intention, summary: 'Summary.' },
      safetyist: { belief, desire, intention, summary: 'Summary.' },
      skeptic: { belief, desire, intention, summary: 'Summary.' },
    },
    linked_nodes: [],
    conflict_ids: [],
  };
}

function makeOldFileWith(nodes: unknown[]) {
  return { nodes };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('PUT /api/taxonomy/situations BDI gate (t/3890)', () => {
  let handlers: Record<string, Handler>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAnonymousUser.mockReturnValue(false);
    mockWriteTaxonomy.mockResolvedValue({ version: 'abc123' });

    const r = makeRouter();
    registerTaxonomyRoutes(r.router as never, {
      ensureSessionBranch: vi.fn(),
    } as never);
    handlers = r.handlers;
  });

  it('changed situation with flat string interpretation → 400, nothing written', async () => {
    const oldNode = makeBdiNode('sit-001');
    mockReadTaxonomy.mockResolvedValue(makeOldFileWith([oldNode]));

    // Incoming: same id but flat string interpretation (non-BDI)
    const flatNode = {
      ...oldNode,
      interpretations: {
        accelerationist: 'Legacy string — not BDI',
        safetyist: oldNode.interpretations.safetyist,
        skeptic: oldNode.interpretations.skeptic,
      },
    };

    const res = fakeRes();
    await handlers['PUT /api/taxonomy/:pov'](fakeReq(), res, { nodes: [flatNode] });
    expect(res._status).toBe(400);
    expect(mockWriteTaxonomy).not.toHaveBeenCalled();
  });

  it('changed situation with empty BDI field → 400, nothing written', async () => {
    const oldNode = makeBdiNode('sit-002');
    mockReadTaxonomy.mockResolvedValue(makeOldFileWith([oldNode]));

    const emptyBeliefNode = makeBdiNode('sit-002', ''); // empty belief
    const res = fakeRes();
    await handlers['PUT /api/taxonomy/:pov'](fakeReq(), res, { nodes: [emptyBeliefNode] });
    expect(res._status).toBe(400);
    expect(mockWriteTaxonomy).not.toHaveBeenCalled();
  });

  it('complete BDI change → 200, written', async () => {
    const oldNode = makeBdiNode('sit-003', 'Old belief.', 'Old desire.', 'Old intention.');
    mockReadTaxonomy.mockResolvedValue(makeOldFileWith([oldNode]));

    const updatedNode = makeBdiNode('sit-003', 'New belief.', 'New desire.', 'New intention.');
    const res = fakeRes();
    await handlers['PUT /api/taxonomy/:pov'](fakeReq(), res, { nodes: [updatedNode] });
    expect(res._status).toBe(200);
    expect(mockWriteTaxonomy).toHaveBeenCalledOnce();
  });

  it('untouched deprecated flat node alongside valid BDI change → 200', async () => {
    const deprecatedNode = {
      id: 'sit-154',
      label: 'Deprecated',
      description: '[DEPRECATED] Legacy node.',
      interpretations: {
        accelerationist: 'flat string',
        safetyist: 'flat string',
        skeptic: 'flat string',
      },
      linked_nodes: [],
      conflict_ids: [],
    };
    const validNode = makeBdiNode('sit-010');
    // Old file has both; incoming has both unchanged (so sit-154 is NOT in the diff)
    mockReadTaxonomy.mockResolvedValue(makeOldFileWith([deprecatedNode, validNode]));

    // Updated node only — deprecated node unchanged
    const updatedValid = makeBdiNode('sit-010', 'New belief.', 'New desire.', 'New intention.');
    const res = fakeRes();
    await handlers['PUT /api/taxonomy/:pov'](fakeReq(), res, {
      nodes: [deprecatedNode, updatedValid],
    });
    expect(res._status).toBe(200);
    expect(mockWriteTaxonomy).toHaveBeenCalledOnce();
  });

  it('untouched LIVE flat node alongside valid BDI change → 200 (proves changed-only)', async () => {
    // A live (non-deprecated) flat node that is UNCHANGED must not trigger validation.
    // Only the modified valid node should be checked.
    const liveFlat = {
      id: 'sit-020',
      label: 'Live flat',
      description: 'A live situation with a legacy interpretation.',
      interpretations: {
        accelerationist: 'legacy flat string',
        safetyist: 'legacy flat string',
        skeptic: 'legacy flat string',
      },
      linked_nodes: [],
      conflict_ids: [],
    };
    const validNode = makeBdiNode('sit-021');
    mockReadTaxonomy.mockResolvedValue(makeOldFileWith([liveFlat, validNode]));

    // Incoming: liveFlat unchanged (identical JSON), validNode content-changed
    const updatedValid = makeBdiNode('sit-021', 'Updated belief.', 'Updated desire.', 'Updated intention.');
    const res = fakeRes();
    await handlers['PUT /api/taxonomy/:pov'](fakeReq(), res, { nodes: [liveFlat, updatedValid] });
    expect(res._status).toBe(200);
    expect(mockWriteTaxonomy).toHaveBeenCalledOnce();
  });

  it('ENOENT (first write) with a valid node → 200', async () => {
    const enoentErr = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    mockReadTaxonomy.mockRejectedValue(enoentErr);

    const res = fakeRes();
    await handlers['PUT /api/taxonomy/:pov'](fakeReq(), res, { nodes: [makeBdiNode('sit-030')] });
    expect(res._status).toBe(200);
    expect(mockWriteTaxonomy).toHaveBeenCalledOnce();
  });

  it('old-file read failure (non-ENOENT) → 500, fails closed, nothing written', async () => {
    const ioErr = Object.assign(new Error('disk I/O error'), { code: 'EIO' });
    mockReadTaxonomy.mockRejectedValue(ioErr);

    const res = fakeRes();
    await handlers['PUT /api/taxonomy/:pov'](fakeReq(), res, { nodes: [makeBdiNode('sit-005')] });
    expect(res._status).toBe(500);
    expect(mockWriteTaxonomy).not.toHaveBeenCalled();
  });
});
