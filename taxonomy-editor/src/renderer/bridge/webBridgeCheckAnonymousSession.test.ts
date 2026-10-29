// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4628: checkAnonymousSession() backs the anonymous-session model/backend default (settingsSlice
// applyAnonymousSessionDefaults). It must fail closed to "signed-in" (false) on any /api/auth/me
// failure — the OPPOSITE fail-safe from isAnonymous()'s other callers, which cache `true` on
// failure. A signed-in user hitting a flaky auth check must never lose their saved model.
// vi.resetModules() + a fresh dynamic import per test isolates each case from the module-level
// _authAnonymous memoization cache (TL condition 1, t/4628#2).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRecord = vi.fn();
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: mockRecord }) }));

describe('web-bridge checkAnonymousSession (t/4628)', () => {
  beforeEach(() => {
    vi.resetModules();
    mockRecord.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('resolves true when /api/auth/me reports an anonymous session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ anonymous: true }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const { api } = await import('./web-bridge');
    await expect(api.checkAnonymousSession()).resolves.toBe(true);
  });

  it('resolves false when /api/auth/me reports a signed-in session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ anonymous: false }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const { api } = await import('./web-bridge');
    await expect(api.checkAnonymousSession()).resolves.toBe(false);
  });

  it('TL condition 1: fails closed to signed-in (false) on a non-OK auth response, with a WARN', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    const { api } = await import('./web-bridge');

    await expect(api.checkAnonymousSession()).resolves.toBe(false);

    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warn',
      message: expect.stringContaining('signed-in for model selection'),
    }));
  });

  it('TL condition 1: fails closed to signed-in (false) on a network error, with a WARN', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const { api } = await import('./web-bridge');

    await expect(api.checkAnonymousSession()).resolves.toBe(false);

    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warn',
      message: expect.stringContaining('signed-in for model selection'),
    }));
  });
});
