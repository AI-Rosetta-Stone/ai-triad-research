// @vitest-environment node

/**
 * t/665 (t/500): anonymous op-ed sets at anon-oped/<uuid>/, a last-access stamp, expiry at 24 h after the owner last
 * opened the set, and the sweep. The tests the TL required (t/500#49) plus the location and sweep scope (t/500#36).
 * Store-level, with an in-memory user-content backend; the route-level 404 is t/666's.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { _store, mockBackend, norm } = vi.hoisted(() => {
  const _store = new Map<string, string>();
  // path.join uses backslashes on Windows; the store keys are posix, as on the Linux server.
  const norm = (p: string) => p.split(String.fromCharCode(92)).join('/');
  const mockBackend = {
    readFile: vi.fn(async (p: string) => _store.get(norm(p)) ?? null),
    writeFile: vi.fn(async (p: string, c: string) => { _store.set(norm(p), c); }),
    deleteFile: vi.fn(async (p: string) => { _store.delete(norm(p)); }),
    listDirectory: vi.fn(async (dir: string) => {
      const d = norm(dir); const prefix = d.endsWith('/') ? d : d + '/';
      return [..._store.keys()].filter(k => k.startsWith(prefix))
        .map(k => k.slice(prefix.length).split('/')[0]).filter((v, i, a) => a.indexOf(v) === i);
    }),
    fileExists: vi.fn(async (p: string) => _store.has(norm(p))),
    readBinaryFile: vi.fn(), writeBinaryFile: vi.fn(),
  };
  return { _store, mockBackend, norm };
});

const { ctx } = vi.hoisted(() => ({ ctx: { storageUserId: '_local', anonymous: true } }));

vi.mock('../config.js', () => ({ resolveDataPath: (rel: string) => `/data/${rel}`, getDataRoot: () => '/data' }));
vi.mock('../logger.js', () => ({ log: { server: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } }));
vi.mock('../security/userContext.js', () => ({
  getStorageUserId: () => ctx.storageUserId,
  isAnonymousUser: () => ctx.anonymous,
}));
vi.mock('../security/quotas.js', () => ({
  checkQuota: (resource: string, count: number) => ({ allowed: count < 10, resource, current: count, limit: 10 }),
}));
vi.mock('../storage/fileIO.js', () => ({
  getUserContentBackend: () => mockBackend,
  assertSafeId: (value: string, label: string) => {
    if (!value || !/^[a-zA-Z0-9_-]+$/.test(value)) throw Object.assign(new Error(`Invalid ${label}: "${value}"`), { statusCode: 400 });
  },
}));
vi.mock('../storage/opedShareStore.js', () => ({ unpublishOpedShare: async () => false }));
vi.mock('../runtimeConfig.js', () => ({ getConfig: () => ({ sessions: {} }) }));

import {
  listOpedSets, loadOpedSet, finalizeOpedSet, deleteOpedSet, saveOpedSetInProgress,
  sweepExpiredAnonOpedSets, resetAnonOpedSweepCursorForTests, getAnonOpEdRetentionMs,
} from '../storage/opedStore.js';
import type { OpEdSet } from '../../../../lib/oped/types.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-9222-222222222222';
const DIR_A = `/data/anon-oped/${UUID_A}`;
const H = 60 * 60 * 1000;
const T0 = Date.parse('2026-11-25T00:00:00.000Z');

function makeSet(id: string): OpEdSet {
  return {
    schema_version: 1, set_id: id, topic: 'AI Safety policy',
    params: { wordCount: 800, model: 'claude-sonnet-5' }, created_at: '2026-11-25T00:00:00.000Z',
    opeds: [{ pov: 'safetyist', status: 'complete', headline: 'H', subtitle: 'S', body: 'B', wordCount: 800, grounding: [], byline: '', disclosure: '', rhetorical_meta: '' }],
  } as OpEdSet;
}

function as(storageUserId: string, anonymous = true): void { ctx.storageUserId = storageUserId; ctx.anonymous = anonymous; }
const stampIn = (p: string) => (JSON.parse(_store.get(p)!) as { last_accessed_at?: string }).last_accessed_at;

beforeEach(() => {
  _store.clear();
  vi.clearAllMocks();
  // clearAllMocks resets these implementations too; put the in-memory backend back.
  mockBackend.readFile.mockImplementation(async (p: string) => _store.get(norm(p)) ?? null);
  mockBackend.writeFile.mockImplementation(async (p: string, c: string) => { _store.set(norm(p), c); });
  mockBackend.deleteFile.mockImplementation(async (p: string) => { _store.delete(norm(p)); });
  mockBackend.listDirectory.mockImplementation(async (dir: string) => {
    const d = norm(dir); const prefix = d.endsWith('/') ? d : d + '/';
    return [..._store.keys()].filter(k => k.startsWith(prefix))
      .map(k => k.slice(prefix.length).split('/')[0]).filter((v, i, a) => a.indexOf(v) === i);
  });
  resetAnonOpedSweepCursorForTests();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  as(`anon-${UUID_A}`);
});
afterEach(() => { vi.useRealTimers(); });

describe('location (t/500#36)', () => {
  it('a verified anonymous visitor writes under anon-oped/<uuid>/, never users/', async () => {
    await finalizeOpedSet(makeSet('s1'));
    expect(_store.has(`${DIR_A}/oped-set-s1.json`)).toBe(true);
    expect(_store.has(`${DIR_A}/_index.json`)).toBe(true);
    expect([..._store.keys()].some(k => k.includes('/users/') || k.includes('/oped-sets/'))).toBe(false);
  });

  it('an anonymous request without a verified key (_local, or not a uuid v4) stores and reads nothing', async () => {
    for (const id of ['_local', 'anon-not-a-uuid', `anon-${UUID_A.replace('4111', '1111')}`]) {
      as(id);
      await finalizeOpedSet(makeSet('s1'));
      await saveOpedSetInProgress('s1', { x: 1 });
      expect(await listOpedSets()).toEqual([]);
      expect(await loadOpedSet('s1')).toBeNull();
    }
    expect(_store.size).toBe(0);
  });

  it('the stamp never reaches the client: list and load return the documents without last_accessed_at', async () => {
    await finalizeOpedSet(makeSet('s1'));
    expect(stampIn(`${DIR_A}/oped-set-s1.json`)).toBe(new Date(T0).toISOString());
    expect(await loadOpedSet('s1')).not.toHaveProperty('last_accessed_at');
    expect((await listOpedSets())[0]).not.toHaveProperty('last_accessed_at');
  });

  it('retention is runtime config sessions.anonOpEdRetentionMs, defaulting to 24 h', () => {
    expect(getAnonOpEdRetentionMs()).toBe(24 * H);
  });
});

describe('expiry from the last access (t/500#47, #49)', () => {
  it('a read at 23 h 59 m keeps the set and resets the clock', async () => {
    await finalizeOpedSet(makeSet('s1'));
    vi.setSystemTime(T0 + 24 * H - 60_000);
    expect(await loadOpedSet('s1')).not.toBeNull();
    vi.setSystemTime(T0 + 2 * (24 * H - 60_000)); // 47 h 58 m after creation, 23 h 59 m after the read
    expect(await loadOpedSet('s1')).not.toBeNull();
  });

  it('a read past 24 h returns null, and the set blob and its index entry are gone', async () => {
    await finalizeOpedSet(makeSet('s1'));
    await saveOpedSetInProgress('s1', { partial: true });
    vi.setSystemTime(T0 + 24 * H + 1);
    expect(await loadOpedSet('s1')).toBeNull();
    expect(_store.has(`${DIR_A}/oped-set-s1.json`)).toBe(false);
    expect(_store.has(`${DIR_A}/oped-set-s1.json.inprogress`)).toBe(false);
    expect(JSON.parse(_store.get(`${DIR_A}/_index.json`)!)).toEqual([]);
  });

  it('list drops and deletes expired sets', async () => {
    await finalizeOpedSet(makeSet('old'));
    vi.setSystemTime(T0 + 12 * H);
    await finalizeOpedSet(makeSet('new'));
    vi.setSystemTime(T0 + 24 * H + 1);
    expect((await listOpedSets()).map(s => s.set_id)).toEqual(['new']);
    expect(_store.has(`${DIR_A}/oped-set-old.json`)).toBe(false);
  });

  it('the stamp is written at most hourly', async () => {
    await finalizeOpedSet(makeSet('s1'));
    const writes = () => mockBackend.writeFile.mock.calls.filter(c => String(c[0]).endsWith('oped-set-s1.json')).length;
    const before = writes();
    vi.setSystemTime(T0 + 30 * 60_000);
    await loadOpedSet('s1');
    expect(writes()).toBe(before); // under an hour: no rewrite
    vi.setSystemTime(T0 + H + 1);
    await loadOpedSet('s1');
    expect(writes()).toBe(before + 1);
    expect(stampIn(`${DIR_A}/oped-set-s1.json`)).toBe(new Date(T0 + H + 1).toISOString());
  });
});

describe('nothing but the owner\'s own read extends the set (t/500#49 test 4)', () => {
  it('another session, a signed-in or admin request, the owner\'s list and the sweep leave the stamp alone', async () => {
    await finalizeOpedSet(makeSet('s1'));
    vi.setSystemTime(T0 + 20 * H);
    as(`anon-${UUID_B}`);
    expect(await loadOpedSet('s1')).toBeNull(); // another visitor sees nothing, and stamps nothing
    as('admin-user', false);
    expect(await loadOpedSet('s1')).toBeNull(); // a signed-in (admin) read resolves to its own users/ dir
    as(`anon-${UUID_A}`);
    await listOpedSets(); // the owner's list
    await sweepExpiredAnonOpedSets(); // the sweep
    expect(stampIn(`${DIR_A}/oped-set-s1.json`)).toBe(new Date(T0).toISOString());
    vi.setSystemTime(T0 + 24 * H + 1);
    expect(await loadOpedSet('s1')).toBeNull(); // so it still expires 24 h after creation
  });
});

describe('the sweep (t/665)', () => {
  it('deletes an unread expired set and keeps a live one', async () => {
    await finalizeOpedSet(makeSet('old'));
    vi.setSystemTime(T0 + 12 * H);
    await finalizeOpedSet(makeSet('new'));
    vi.setSystemTime(T0 + 24 * H + 1);
    expect(await sweepExpiredAnonOpedSets()).toEqual({ dirsScanned: 1, setsDeleted: 1 });
    expect(_store.has(`${DIR_A}/oped-set-old.json`)).toBe(false);
    expect(_store.has(`${DIR_A}/oped-set-new.json`)).toBe(true);
  });

  it('removes the index too when a visitor\'s last set expires', async () => {
    await finalizeOpedSet(makeSet('only'));
    vi.setSystemTime(T0 + 24 * H + 1);
    await sweepExpiredAnonOpedSets();
    expect([..._store.keys()].filter(k => k.startsWith(DIR_A))).toEqual([]);
  });

  it('walks anon-oped/ only and only full uuid v4 names: users/anon-foo and odd names are never touched', async () => {
    const userFile = '/data/users/anon-foo/oped-sets/oped-set-x.json';
    const oddFile = '/data/anon-oped/not-a-uuid/_index.json';
    _store.set(userFile, JSON.stringify({ set_id: 'x', created_at: '2020-01-01T00:00:00Z' }));
    _store.set(oddFile, JSON.stringify([{ set_id: 'x', created_at: '2020-01-01T00:00:00Z' }]));
    vi.setSystemTime(T0 + 365 * 24 * H);
    expect(await sweepExpiredAnonOpedSets()).toEqual({ dirsScanned: 0, setsDeleted: 0 });
    expect(_store.has(userFile)).toBe(true);
    expect(_store.has(oddFile)).toBe(true);
    expect(mockBackend.listDirectory.mock.calls.map(c => norm(String(c[0])))).toEqual(['/data/anon-oped']);
  });

  it('visits at most maxDirs directories per run, and the next run continues where the last stopped', async () => {
    const uuids = ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-a444-444444444444', '55555555-5555-4555-b555-555555555555'];
    for (const u of uuids) { as(`anon-${u}`); await finalizeOpedSet(makeSet('s')); }
    vi.setSystemTime(T0 + 24 * H + 1);
    expect(await sweepExpiredAnonOpedSets({ maxDirs: 2 })).toEqual({ dirsScanned: 2, setsDeleted: 2 });
    expect(await sweepExpiredAnonOpedSets({ maxDirs: 2 })).toMatchObject({ setsDeleted: 1 });
    expect([..._store.keys()].filter(k => k.endsWith('oped-set-s.json'))).toEqual([]);
  });
});

describe('signed-in users are unchanged', () => {
  it('a signed-in user\'s sets stay under users/<id>/oped-sets with no stamp and no expiry', async () => {
    as('user-abc', false);
    await finalizeOpedSet(makeSet('s1'));
    const p = '/data/users/user-abc/oped-sets/oped-set-s1.json';
    expect(_store.has(norm(p))).toBe(true);
    expect(stampIn(p)).toBeUndefined();
    vi.setSystemTime(T0 + 365 * 24 * H);
    expect(await loadOpedSet('s1')).not.toBeNull();
    await deleteOpedSet('s1');
    expect(_store.has(norm(p))).toBe(false);
  });
});
