// @vitest-environment node
// t/501: an anonymous request never reads the key store, the platform env key, or the AI_API_KEY fallback.
// Anonymous requests carry principalName '_local' (server.ts), so getCurrentUserId() is the owner's own
// '_local' for every anonymous visitor. Before this gate, an anonymous op-ed run read that slot.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  getKeys: vi.fn(async (_backend: string, _userId: string): Promise<string[]> => ['OWNER-KEY-DO-NOT-USE']),
  addKey: vi.fn(async () => []),
  set: vi.fn(async () => undefined),
}));

vi.mock('../security/keyStore.js', () => ({
  getKeyStore: () => ({ getKeys: h.getKeys, addKey: h.addKey, removeKey: vi.fn(), set: h.set, delete: vi.fn() }),
}));
vi.mock('../logger.js', () => ({
  log: { server: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { runWithUser } from '../security/userContext.js';
import * as config from '../config.js';

const ANON_CTX = { principalName: '_local', idp: '', storageUserId: 'anon-0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11', stableId: undefined, isAnonymous: true, anonymousSessionId: '0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11' };
const SIGNED_CTX = { principalName: 'alice', idp: 'github', storageUserId: 'alice', stableId: 'github:1', isAnonymous: false };

const saved = { gemini: process.env.GEMINI_API_KEY, ai: process.env.AI_API_KEY };
beforeEach(() => {
  h.getKeys.mockClear(); h.addKey.mockClear(); h.set.mockClear();
  delete process.env.GEMINI_API_KEY; delete process.env.AI_API_KEY;
});
afterEach(() => {
  if (saved.gemini === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved.gemini;
  if (saved.ai === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = saved.ai;
});

describe('t/501: anonymous requests never read the key store or the platform key', () => {
  it('getApiKey returns null and never reads the _local slot for an anonymous request', async () => {
    const key = await runWithUser(ANON_CTX, () => config.getApiKey('gemini'));
    expect(key).toBeNull();
    expect(h.getKeys).not.toHaveBeenCalled();
  });

  it('the platform env key is not returned to an anonymous request', async () => {
    process.env.GEMINI_API_KEY = 'PLATFORM-KEY-DO-NOT-USE';
    const key = await runWithUser(ANON_CTX, () => config.getApiKey('gemini'));
    expect(key).toBeNull();
  });

  it('the AI_API_KEY fallback is not returned to an anonymous request', async () => {
    process.env.AI_API_KEY = 'FALLBACK-KEY-DO-NOT-USE';
    const key = await runWithUser(ANON_CTX, () => config.getApiKey('gemini'));
    expect(key).toBeNull();
  });

  it('getApiKeys returns an empty list for an anonymous request, so the chain throws no-key rather than calling the provider', async () => {
    process.env.GEMINI_API_KEY = 'PLATFORM-KEY-DO-NOT-USE';
    const keys = await runWithUser(ANON_CTX, () => config.getApiKeys('gemini'));
    expect(keys).toEqual([]);
    expect(h.getKeys).not.toHaveBeenCalled();
  });

  it('writes are refused for an anonymous request and never reach the store', async () => {
    await expect(runWithUser(ANON_CTX, () => config.storeApiKey('NEW-KEY', 'gemini'))).rejects.toThrow(/no key store/);
    await expect(runWithUser(ANON_CTX, () => config.addApiKey('NEW-KEY', 'gemini'))).rejects.toThrow(/no key store/);
    expect(h.set).not.toHaveBeenCalled();
    expect(h.addKey).not.toHaveBeenCalled();
  });

  it('a signed-in request keeps its own key lookup, unchanged', async () => {
    const key = await runWithUser(SIGNED_CTX, () => config.getApiKey('gemini'));
    expect(key).toBe('OWNER-KEY-DO-NOT-USE');
    expect(h.getKeys).toHaveBeenCalledWith('gemini', 'alice');
  });
});

// SO p/252#24: single-operator local mode (AUTH_DISABLED=1) makes every request anonymous-flagged. The operator is
// the owner, so the owner's keys must still apply: the hosted gate does not fire.
describe('t/501: AUTH_DISABLED single-operator mode keeps the owner\'s key lookup', () => {
  const saved = process.env.AUTH_DISABLED;
  beforeEach(() => { process.env.AUTH_DISABLED = '1'; });
  afterEach(() => { if (saved === undefined) delete process.env.AUTH_DISABLED; else process.env.AUTH_DISABLED = saved; });

  it('an anonymous-flagged request under AUTH_DISABLED reads the owner\'s key as before', async () => {
    const key = await runWithUser(ANON_CTX, () => config.getApiKey('gemini'));
    expect(h.getKeys).toHaveBeenCalledWith('gemini', '_local');
    expect(key).toBe('OWNER-KEY-DO-NOT-USE');
  });
});

