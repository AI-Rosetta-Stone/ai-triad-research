// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Regression for t/3039: adminReviewAction embedded the HTTP status only in the
// message string ("POST action failed: HTTP {status}"), forcing consumers to
// string-match /HTTP (\d+)/ to detect a 409. It now throws via throwHttpError, so
// the error carries a structured .httpStatus (matching bridgePost/patchDebateDelta)
// and consumers can use err.httpStatus === 409 instead of the fragile string-match.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => undefined }));

import { api } from './web-bridge';

const ACTION = { domain: 'community', groupId: 'g1', action: 'approve', itemIds: ['i1'] };

describe('web-bridge adminReviewAction .httpStatus (t/3039)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('attaches a structured .httpStatus on a 409 (no string-match needed)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('conflict', { status: 409 })));
    const err = await api.adminReviewAction(ACTION).then(() => null, (e: unknown) => e);
    expect(err, 'expected adminReviewAction to reject on 409').toBeTruthy();
    expect((err as { httpStatus?: number }).httpStatus).toBe(409);
  });

  it('propagates the actual status (e.g. 500) on .httpStatus', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));
    const err = await api.adminReviewAction(ACTION).then(() => null, (e: unknown) => e);
    expect((err as { httpStatus?: number }).httpStatus).toBe(500);
  });

  it('resolves when the server accepts the action', async () => {
    // t/85: now routed through post(), which parses the body — the server route replies
    // `{ ok: true }` (routes/admin.ts), so the fixture mirrors that contract.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await expect(api.adminReviewAction(ACTION)).resolves.toBeUndefined();
  });
});
