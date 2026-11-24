// @vitest-environment node
// t/475 (PI decision, TL p/16#239): an anonymous visitor deletes their own op-ed, from their own storage key only.
// The store is the real opedStore.deleteOpedSet over an in-memory backend keyed by path, so "another visitor's id
// is not found" is checked against where files actually live (users/<storageUserId>/...).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithUser } from '../security/userContext.js';

const files = vi.hoisted(() => new Map<string, string>());
// path.join builds backslash paths on Windows; the in-memory keys use forward slashes. Normalise both.
const key = (p: string) => p.replace(/\\/g, '/');
vi.mock('../storage/fileIO.js', () => ({
  getUserContentBackend: () => ({
    readFile: async (p: string) => (files.has(key(p)) ? files.get(key(p))! : null),
    writeFile: async (p: string, c: string) => { files.set(key(p), c); return { version: 'v' }; },
    deleteFile: async (p: string) => { files.delete(key(p)); },
    listDirectory: async () => [],
  }),
  assertSafeId: () => {},
}));
vi.mock('../storage/opedShareStore.js', () => ({
  unpublishOpedShare: vi.fn(async () => undefined),
  publishOpedShare: vi.fn(async () => undefined),
  refreshOpedShareIfShared: vi.fn(async () => undefined),
}));
vi.mock('../config.js', () => ({ resolveDataPath: (p: string) => `/data/${p}` }));
vi.mock('../logger.js', () => ({ log: { server: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } }));

import { deleteOpedSet } from '../storage/opedStore.js';
import { unpublishOpedShare } from '../storage/opedShareStore.js';

const VISITOR_A = 'anon-0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11';
const VISITOR_B = 'anon-7b1d2c3e-4f50-4a61-8b72-9c83d4e5f601';
const SET = 'set-visitor-a';

/** Run `fn` as an anonymous visitor with the given storage key (what server.ts sets for a keyed anonymous request). */
function asAnon<T>(storageUserId: string, fn: () => T): T {
  return runWithUser(
    { principalName: '', idp: '_local', storageUserId, stableId: undefined, isAnonymous: true, anonymousSessionId: storageUserId.slice(5) },
    fn,
  );
}

beforeEach(() => {
  files.clear();
  vi.mocked(unpublishOpedShare).mockClear();
  // Visitor A's own op-ed set, in visitor A's own store.
  files.set(`/data/users/${VISITOR_A}/oped-sets/oped-set-${SET}.json`, JSON.stringify({ set_id: SET }));
});

describe('t/475 (PI): an anonymous visitor deletes their own op-ed, from their own key only', () => {
  it('a visitor deletes their own op-ed: it is removed and the store reports true', async () => {
    const removed = await asAnon(VISITOR_A, () => deleteOpedSet(SET));
    expect(removed).toBe(true);
    expect(files.has(`/data/users/${VISITOR_A}/oped-sets/oped-set-${SET}.json`)).toBe(false);
  });

  it('another visitor’s id is NOT FOUND: the store returns false and visitor A’s set is untouched', async () => {
    const removed = await asAnon(VISITOR_B, () => deleteOpedSet(SET));
    expect(removed).toBe(false);
    expect(files.has(`/data/users/${VISITOR_A}/oped-sets/oped-set-${SET}.json`)).toBe(true);
  });

  it('an unknown id is not found for an anonymous visitor', async () => {
    expect(await asAnon(VISITOR_A, () => deleteOpedSet('no-such-set'))).toBe(false);
  });

  it('an anonymous delete never reaches the public share revocation (an anonymous visitor cannot publish)', async () => {
    await asAnon(VISITOR_A, () => deleteOpedSet(SET));
    expect(unpublishOpedShare).not.toHaveBeenCalled();
  });

  it('a signed-in delete keeps its behaviour: the share is revoked and the store reports true', async () => {
    files.set(`/data/users/alice/oped-sets/oped-set-signed.json`, JSON.stringify({ set_id: 'signed' }));
    const removed = await runWithUser(
      { principalName: 'alice', idp: 'github', storageUserId: 'alice', stableId: 'github:1', isAnonymous: false },
      () => deleteOpedSet('signed'),
    );
    expect(removed).toBe(true);
    expect(unpublishOpedShare).toHaveBeenCalledWith('signed');
  });
});

