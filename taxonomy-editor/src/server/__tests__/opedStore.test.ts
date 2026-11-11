// @vitest-environment node
// Tests for opedStore.ts — t/2572 (base) + t/2579 (quota enforcement)

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock backend ──────────────────────────────────────────────────────

const { _store, mockBackend } = vi.hoisted(() => {
  const _store = new Map<string, string>();
  const readFile = vi.fn(async (p: string) => _store.get(p) ?? null);
  const writeFile = vi.fn(async (p: string, c: string) => { _store.set(p, c); });
  const deleteFile = vi.fn(async (p: string) => { _store.delete(p); });
  const listDirectory = vi.fn(async (dir: string) => {
    const prefix = dir.endsWith('/') ? dir : dir + '/';
    return [..._store.keys()]
      .filter(k => k.startsWith(prefix))
      .map(k => k.slice(prefix.length).split('/')[0])
      .filter((v, i, a) => a.indexOf(v) === i);
  });
  const fileExists = vi.fn(async (p: string) => _store.has(p));
  const mockBackend = {
    readFile, writeFile, deleteFile, listDirectory, fileExists,
    readBinaryFile: vi.fn(), writeBinaryFile: vi.fn(),
  };
  return { _store, mockBackend };
});

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../config.js', () => ({
  resolveDataPath: (rel: string) => `/data/${rel}`,
  getDataRoot: () => '/data',
}));

vi.mock('../logger.js', () => ({
  log: { server: { info: vi.fn(), warn: vi.fn() } },
}));

vi.mock('../security/userContext.js', () => ({
  getStorageUserId: vi.fn(() => 'user-abc'),
  isAnonymousUser: vi.fn(() => false),
}));

vi.mock('../security/quotas.js', () => ({
  checkQuota: vi.fn((resource: string, count: number) => ({
    allowed: count < 10,
    resource,
    current: count,
    limit: 10,
  })),
}));

vi.mock('../storage/fileIO.js', () => ({
  getUserContentBackend: () => mockBackend,
  assertSafeId: (value: string, label: string) => {
    if (!value || !/^[a-zA-Z0-9_-]+$/.test(value))
      throw Object.assign(new Error(`Invalid ${label}: "${value}"`), { statusCode: 400 });
  },
}));

const { unpublishOpedShareMock } = vi.hoisted(() => ({
  unpublishOpedShareMock: vi.fn(async () => false),
}));
vi.mock('../storage/opedShareStore.js', () => ({
  unpublishOpedShare: (...args: unknown[]) => unpublishOpedShareMock(...args),
}));

import {
  listOpedSets,
  loadOpedSet,
  saveOpedSetInProgress,
  loadOpedSetInProgress,
  finalizeOpedSet,
  deleteOpedSet,
  getOpedSetsQuotaStatus,
} from '../storage/opedStore.js';
import type { OpEdSet } from '../../../../lib/oped/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSet(id: string, overrides: Partial<OpEdSet> = {}): OpEdSet {
  return {
    schema_version: 1,
    set_id: id,
    topic: 'AI Safety policy',
    params: { wordCount: 800, model: 'claude-sonnet-5' },
    created_at: '2026-08-13T10:00:00.000Z',
    opeds: [
      { pov: 'accelerationist', status: 'complete', headline: 'H1', subtitle: 'S1', body: 'B1', wordCount: 800, grounding: [], byline: '', disclosure: '', rhetorical_meta: '' },
      { pov: 'safetyist', status: 'complete', headline: 'H2', subtitle: 'S2', body: 'B2', wordCount: 800, grounding: [], byline: '', disclosure: '', rhetorical_meta: '' },
    ],
    ...overrides,
  };
}

const DIR = '/data/users/user-abc/oped-sets';

beforeEach(() => {
  _store.clear();
  vi.clearAllMocks();
  mockBackend.readFile.mockImplementation(async (p: string) => _store.get(p) ?? null);
});

// ── 1. Round-trip ─────────────────────────────────────────────────────────────

describe('round-trip (t/2572)', () => {
  it('finalizeOpedSet then loadOpedSet returns deep-equal doc', async () => {
    const set = makeSet('set-001');
    await finalizeOpedSet(set);
    const loaded = await loadOpedSet('set-001');
    expect(loaded).toEqual(set);
  });
});

// t/172: per-stage raw prompts/outputs (t/171) must survive save → load; old sets stay unchanged.
describe('stages persistence (t/172)', () => {
  const STAGES = [
    { stage: 'generation', attempt: 1, model: 'claude-sonnet-5', prompt: 'SYS\n\n---\n\nUSER', output: 'RAW' },
    { stage: 'readability-edit', attempt: 2, model: 'claude-sonnet-5', prompt: 'EDIT', output: '', error: 'timeout' },
  ];

  it('finalizeOpedSet then loadOpedSet round-trips a member\'s stages, in order, including attempt and error', async () => {
    const base = makeSet('set-stages');
    const set = { ...base, opeds: [{ ...base.opeds[0], stages: STAGES }, base.opeds[1]] } as unknown as OpEdSet;
    await finalizeOpedSet(set);
    const loaded = await loadOpedSet('set-stages') as OpEdSet;
    expect((loaded.opeds[0] as { stages?: unknown }).stages).toEqual(STAGES);
    expect(loaded).toEqual(set);
  });

  it('a set without stages (pre-t/171) loads unchanged, with no stages key invented', async () => {
    await finalizeOpedSet(makeSet('set-old'));
    const loaded = await loadOpedSet('set-old') as OpEdSet;
    expect(loaded).toEqual(makeSet('set-old'));
    for (const m of loaded.opeds) expect(m).not.toHaveProperty('stages');
  });
});

// ── 2. Partial-set persists ───────────────────────────────────────────────────

describe('partial-set (t/2572)', () => {
  it('finalizes a set with failed/cancelled members and lists it correctly', async () => {
    const set = makeSet('set-002', {
      opeds: [
        { pov: 'accelerationist', status: 'complete', headline: 'H', subtitle: 'S', body: 'B', wordCount: 700, grounding: [] },
        { pov: 'safetyist', status: 'failed', headline: '', subtitle: '', body: '', wordCount: 0, grounding: [] },
        { pov: 'skeptic', status: 'cancelled', headline: '', subtitle: '', body: '', wordCount: 0, grounding: [] },
      ],
    });
    await finalizeOpedSet(set);
    const list = await listOpedSets();
    const entry = list.find(e => e.set_id === 'set-002');
    expect(entry).toBeDefined();
    expect(entry!.voice_count).toBe(3);
    expect(entry!.camps).toContain('accelerationist');
    expect(entry!.camps).toContain('safetyist');
    expect(entry!.camps).toContain('skeptic');
  });
});

// ── 3. List does not load individual docs ─────────────────────────────────────

describe('list without full-doc load (t/2572)', () => {
  it('listOpedSets succeeds even when individual set-doc reads would throw', async () => {
    const set = makeSet('set-003');
    await finalizeOpedSet(set);

    const setDocPath = `${DIR}/oped-set-set-003.json`;
    mockBackend.readFile.mockImplementation(async (p: string) => {
      if (p === setDocPath) throw new Error('Should not read individual set doc');
      return _store.get(p) ?? null;
    });

    const list = await listOpedSets();
    const entry = list.find(e => e.set_id === 'set-003');
    expect(entry).toBeDefined();
    expect(entry!.topic).toBe('AI Safety policy');
  });
});

// ── 4. In-progress lifecycle ──────────────────────────────────────────────────

describe('in-progress lifecycle (t/2572)', () => {
  it('saveOpedSetInProgress → loadOpedSetInProgress → finalizeOpedSet → null', async () => {
    const partial = { set_id: 'set-004', opeds: [{ pov: 'accelerationist', status: 'complete' }] };
    await saveOpedSetInProgress('set-004', partial);
    const loaded = await loadOpedSetInProgress('set-004');
    expect(loaded).toEqual(partial);

    const set = makeSet('set-004');
    await finalizeOpedSet(set);
    await new Promise(r => setTimeout(r, 10));

    const inprogPath = `${DIR}/oped-set-set-004.json.inprogress`;
    expect(_store.has(inprogPath)).toBe(false);
  });
});

// ── 5. assertSafeId at entry points ──────────────────────────────────────────

describe('assertSafeId guards (t/2572)', () => {
  const ops: Array<[string, () => Promise<unknown>]> = [
    ['loadOpedSet', () => loadOpedSet('../evil')],
    ['saveOpedSetInProgress', () => saveOpedSetInProgress('../evil', {})],
    ['loadOpedSetInProgress', () => loadOpedSetInProgress('../evil')],
    ['finalizeOpedSet', () => finalizeOpedSet(makeSet('../evil'))],
    ['deleteOpedSet', () => deleteOpedSet('../evil')],
  ];

  for (const [name, op] of ops) {
    it(`${name} rejects unsafe setId`, async () => {
      await expect(op()).rejects.toMatchObject({ statusCode: 400 });
    });
  }
});

// ── 6. Delete round-trip ──────────────────────────────────────────────────────

describe('delete round-trip (t/2572)', () => {
  it('deleteOpedSet removes doc from load and list; no throw if .inprogress absent', async () => {
    const set = makeSet('set-006');
    await finalizeOpedSet(set);
    await deleteOpedSet('set-006');
    await new Promise(r => setTimeout(r, 10));

    expect(await loadOpedSet('set-006')).toBeNull();
    const list = await listOpedSets();
    expect(list.find(e => e.set_id === 'set-006')).toBeUndefined();
  });

  it('deleteOpedSet revokes any share before deletion (t/4893)', async () => {
    const set = makeSet('set-share-revoke');
    await finalizeOpedSet(set);
    unpublishOpedShareMock.mockClear();
    await deleteOpedSet('set-share-revoke');

    expect(unpublishOpedShareMock).toHaveBeenCalledWith('set-share-revoke');
    expect(await loadOpedSet('set-share-revoke')).toBeNull();
  });
});

// ── 7. Quota status (t/2579) ──────────────────────────────────────────────────

describe('getOpedSetsQuotaStatus (t/2579)', () => {
  it('returns allowed=true when below cap and counts only finalized docs', async () => {
    // .inprogress and _index.json must not count
    _store.set(`${DIR}/oped-set-q1.json`, '{}');
    _store.set(`${DIR}/oped-set-q2.json`, '{}');
    _store.set(`${DIR}/oped-set-q3.json.inprogress`, '{}');
    _store.set(`${DIR}/_index.json`, '[]');

    const q = await getOpedSetsQuotaStatus();
    expect(q.resource).toBe('opeds');
    expect(q.current).toBe(2);  // only the two finalized docs
    expect(q.allowed).toBe(true);
  });
});

// ── 8. finalizeOpedSet quota enforcement (t/2579) ────────────────────────────

describe('finalizeOpedSet quota enforcement (t/2579)', () => {
  it('blocks a NEW set when quota exceeded (statusCode 429 + quotaInfo)', async () => {
    // Seed 10 finalized sets to hit the cap (mock limit = 10)
    for (let i = 0; i < 10; i++) {
      _store.set(`${DIR}/oped-set-existing-${i}.json`, '{}');
    }

    await expect(finalizeOpedSet(makeSet('set-new'))).rejects.toMatchObject({
      statusCode: 429,
      quotaInfo: expect.objectContaining({ allowed: false, resource: 'opeds' }),
    });
  });

  it('does NOT block re-finalizing an EXISTING set even when quota exceeded', async () => {
    // Finalize set once (under quota)
    await finalizeOpedSet(makeSet('set-existing'));

    // Seed 9 more to push over cap (total = 10 finalized)
    for (let i = 0; i < 9; i++) {
      _store.set(`${DIR}/oped-set-extra-${i}.json`, '{}');
    }

    // Re-finalize the existing set — must not throw
    await expect(finalizeOpedSet(makeSet('set-existing', { topic: 'Updated' }))).resolves.toBeUndefined();
  });
});
