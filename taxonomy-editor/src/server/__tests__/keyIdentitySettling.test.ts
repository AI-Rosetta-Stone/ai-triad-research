// @vitest-environment node
// t/501 settling test (TL p/16#278 step 1). Which identity does the key lookup use, for three callers?
// The request contexts below are built with the same rule as server.ts (principal = principalName || '_local';
// isAnonymous = !principalName; storageUserId = anon-<uuid> for anonymous, else the derived id). This runs
// the real key lookup (config.getApiKey / getApiKeys) under those contexts and records the userId the key
// store is asked for. It is not an HTTP-level run of server.ts; see t/501 for what that would add.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ backend: string; userId: string }>,
  keysByUser: {} as Record<string, string[]>,
}));

vi.mock('../security/keyStore.js', () => ({
  getKeyStore: () => ({
    getKeys: async (backend: string, userId: string) => {
      h.calls.push({ backend, userId });
      return h.keysByUser[userId] ?? [];
    },
    addKey: async () => [], removeKey: async () => [], set: async () => undefined, delete: async () => undefined,
  }),
}));
vi.mock('../logger.js', () => ({
  log: { server: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { runWithUser } from '../security/userContext.js';
import * as config from '../config.js';

// server.ts:894-900 for an anonymous request with cookie uuid U: principal '_local', isAnonymous true.
const ANON = { principalName: '_local', idp: '', storageUserId: 'anon-0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11', stableId: undefined, isAnonymous: true, anonymousSessionId: '0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11' };
// A signed-in GitHub user: principal = login, storage id = derived from the login.
const ALICE = { principalName: 'alice', idp: 'github', storageUserId: 'alice', stableId: 'github:1', isAnonymous: false };

beforeEach(() => {
  h.calls.length = 0;
  h.keysByUser = { _local: ['LOCAL-SLOT-KEY-NOT-PRINTED'] }; // the owner's _local slot holds a key
  delete process.env.GEMINI_API_KEY;
  delete process.env.AI_API_KEY;
});

describe('t/501 settling: which identity the key lookup uses', () => {
  it('(a) an anonymous visitor with a session cookie: the key lookup asks for _local', async () => {
    const key = await runWithUser(ANON, () => config.getApiKey('gemini'));
    expect(h.calls.map(c => c.userId)).toEqual(['_local']);
    expect(key).toBe('LOCAL-SLOT-KEY-NOT-PRINTED'); // the owner's key is returned to an anonymous visitor on main
  });

  it('(b) a signed-in user with no key of their own: asks for their own identity, never _local', async () => {
    const key = await runWithUser(ALICE, () => config.getApiKey('gemini'));
    expect(h.calls.map(c => c.userId)).toEqual(['alice']);
    expect(h.calls.some(c => c.userId === '_local')).toBe(false);
    expect(key).toBeNull();
  });

  it('(c) a signed-in user with their own key: asks for their own identity and gets their key', async () => {
    h.keysByUser.alice = ['ALICE-OWN-KEY-NOT-PRINTED'];
    const key = await runWithUser(ALICE, () => config.getApiKey('gemini'));
    expect(h.calls.map(c => c.userId)).toEqual(['alice']);
    expect(key).toBe('ALICE-OWN-KEY-NOT-PRINTED');
  });

  it('getApiKeys (the chain used by the op-ed adapter) resolves the same way for each case', async () => {
    await runWithUser(ANON, () => config.getApiKeys('gemini'));
    await runWithUser(ALICE, () => config.getApiKeys('gemini'));
    expect(h.calls.map(c => c.userId)).toEqual(['_local', 'alice']);
  });
});
