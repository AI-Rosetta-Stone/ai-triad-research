// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/204: getStoredUserKeysBeforeFreePool is precedence step 2 on the free-pool paths (request key →
// stored Settings key → free pool → paid fallback on a pool 429). The routes' use of it is covered in
// freePoolGeoRouteIntegration.test.ts; this pins the helper's own contract.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  keys: [] as string[], throwErr: null as Error | null, anonymous: false,
  warn: vi.fn(),
}));
vi.mock('../security/keyStore.js', () => ({
  getKeyStore: () => ({ getKeys: async () => { if (h.throwErr) throw h.throwErr; return h.keys; } }),
}));
vi.mock('../security/userContext.js', () => ({ getCurrentUserId: () => 'test-user', isAnonymousUser: () => h.anonymous }));
vi.mock('../logger.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../logger.js')>();
  return { ...orig, log: { ...orig.log, server: { ...orig.log.server, warn: h.warn } } };
});

import { getStoredUserKeysBeforeFreePool } from '../config.js';

let savedGemini: string | undefined;
beforeEach(() => {
  h.keys = []; h.throwErr = null; h.anonymous = false; h.warn.mockClear();
  savedGemini = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
});
afterEach(() => { if (savedGemini === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedGemini; });

describe('getStoredUserKeysBeforeFreePool (t/204)', () => {
  it('returns the signed-in user\'s stored keys', async () => {
    h.keys = ['user-gemini-key'];
    expect(await getStoredUserKeysBeforeFreePool('gemini')).toEqual(['user-gemini-key']);
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('returns [] with no WARN when the user has no stored key (the free pool then applies, unchanged)', async () => {
    expect(await getStoredUserKeysBeforeFreePool('gemini')).toEqual([]);
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('an unreadable key store WARNs and returns [], so the caller continues to the free pool', async () => {
    h.throwErr = new Error('blob read failed');
    expect(await getStoredUserKeysBeforeFreePool('gemini')).toEqual([]);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls[0][1]).toMatch(/falling back to the free pool/);
  });

  it('anonymous callers have no stored key — the store is never read', async () => {
    h.anonymous = true;
    h.keys = ['should-not-be-read'];
    expect(await getStoredUserKeysBeforeFreePool('gemini')).toEqual([]);
  });

  it('ignores server env keys: only the user\'s own stored key counts', async () => {
    process.env.GEMINI_API_KEY = 'server-env-key';
    expect(await getStoredUserKeysBeforeFreePool('gemini')).toEqual([]);
  });
});
