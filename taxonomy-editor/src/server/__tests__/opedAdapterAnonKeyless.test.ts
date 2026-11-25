// @vitest-environment node
// t/501 (TL p/16#286): an anonymous op-ed run reaches the provider with no key-store key. This drives the real
// op-ed adapter (createWebOpEdAdapter) under the real anonymous user context (runWithUser, as server.ts builds it),
// with the owner's _local key present in the key store and in the environment, and a recorded provider fetch.
// Expected after the gate: no key-store read for an anonymous request, and no provider call carrying an owner key.
// This is an adapter-level run, not an HTTP request into routes/oped.ts; the pool routing and the HTTP-level run
// follow in the root-fix PR.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  keyStoreReads: [] as Array<{ backend: string; userId: string }>,
  fetchCalls: [] as Array<{ url: string; headers: Record<string, string> }>,
}));

vi.mock('../security/keyStore.js', () => ({
  getKeyStore: () => ({
    getKeys: async (backend: string, userId: string) => {
      h.keyStoreReads.push({ backend, userId });
      return ['OWNER-LOCAL-KEY-NOT-PRINTED'];
    },
    addKey: async () => [], removeKey: async () => [], set: async () => undefined, delete: async () => undefined,
  }),
}));
vi.mock('../logger.js', () => ({
  log: { server: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { runWithUser } from '../security/userContext.js';
import { createWebOpEdAdapter } from '../ai/opedAdapter.js';

// server.ts:894-900 for an anonymous request with cookie uuid U.
const ANON = { principalName: '_local', idp: '', storageUserId: 'anon-0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11', stableId: undefined, isAnonymous: true, anonymousSessionId: '0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11' };

const realFetch = globalThis.fetch;
let savedEnv: string | undefined;

beforeEach(() => {
  h.keyStoreReads.length = 0;
  h.fetchCalls.length = 0;
  savedEnv = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'OWNER-ENV-KEY-NOT-PRINTED';
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    h.fetchCalls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(JSON.stringify({ error: { code: 400, message: 'API key not valid' } }), { status: 400 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedEnv === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedEnv;
});

describe('t/501: an anonymous op-ed run never reads a key-store key or sends an owner key', () => {
  it('the adapter call under the anonymous context makes no key-store read and no provider call with an owner key', async () => {
    const adapter = createWebOpEdAdapter();
    const outcome = await runWithUser(ANON, () =>
      adapter.generateText('Write a short op-ed.', 'gemini-3.5-flash-lite', { maxTokens: 200 }).then(
        () => 'resolved', (err: unknown) => `refused: ${(err as Error).name}`));
    expect(h.keyStoreReads).toEqual([]);
    for (const c of h.fetchCalls) {
      expect(JSON.stringify(c.headers) + c.url).not.toMatch(/OWNER-/);
    }
    expect(h.fetchCalls.length).toBe(0);
    expect(outcome).toMatch(/refused|resolved/);
  });
});
