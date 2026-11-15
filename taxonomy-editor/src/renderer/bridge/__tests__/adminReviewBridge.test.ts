// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/85: adminReviewQueue/Stats/Detail/Action called a bare `fetch()` inside web-bridge itself,
// skipping the shared get/post helpers' timeout, retry and 429/503 handling. They now route
// through `get`/`post`, which call `resilientFetch` — so these assert on that mock.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { resilientFetch } = vi.hoisted(() => ({ resilientFetch: vi.fn() }));

vi.mock('../resilience', () => ({
  resilientFetch,
  categorizeEndpoint: () => 'mutation',
  registerConnectionPoolProvider: vi.fn(),
}));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('../instrumentBridge', () => ({ instrumentBridge: (raw: unknown) => raw }));

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    clone() { return jsonResponse(body, status); },
  } as unknown as Response;
}

const ACTION = { domain: 'community', groupId: 'g1', action: 'approve', itemIds: ['i1'] };

describe('web-bridge admin review REST calls (t/85)', () => {
  beforeEach(() => {
    vi.resetModules();
    resilientFetch.mockReset();
  });

  it('adminReviewQueue GETs the queue through get() and unwraps { items }', async () => {
    const items = [{ id: 'g1' }];
    resilientFetch.mockResolvedValue(jsonResponse({ items }));
    const { api } = await import('../web-bridge');

    await expect(api.adminReviewQueue()).resolves.toEqual({ items });
    const [path, init] = resilientFetch.mock.calls[0];
    expect(path).toBe('/api/admin/review/queue');
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('adminReviewQueue still accepts a bare-array body', async () => {
    const items = [{ id: 'g1' }];
    resilientFetch.mockResolvedValue(jsonResponse(items));
    const { api } = await import('../web-bridge');

    await expect(api.adminReviewQueue()).resolves.toEqual({ items });
  });

  it('adminReviewStats GETs the stats through get()', async () => {
    resilientFetch.mockResolvedValue(jsonResponse({ total: 2, byDomain: { community: 2 } }));
    const { api } = await import('../web-bridge');

    await expect(api.adminReviewStats()).resolves.toEqual({ total: 2, byDomain: { community: 2 } });
    const [path, init] = resilientFetch.mock.calls[0];
    expect(path).toBe('/api/admin/review/stats');
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('adminReviewDetail GETs an encodeURIComponent-escaped group id through get()', async () => {
    resilientFetch.mockResolvedValue(jsonResponse({ found: true }));
    const { api } = await import('../web-bridge');

    await expect(api.adminReviewDetail('community:a/b')).resolves.toEqual({ found: true });
    const [path, init] = resilientFetch.mock.calls[0];
    expect(path).toBe('/api/admin/review/detail/community%3Aa%2Fb');
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('adminReviewAction POSTs the action as the JSON body through post() and resolves void', async () => {
    resilientFetch.mockResolvedValue(jsonResponse({ ok: true }));
    const { api } = await import('../web-bridge');

    await expect(api.adminReviewAction(ACTION)).resolves.toBeUndefined();
    const [path, init] = resilientFetch.mock.calls[0];
    expect(path).toBe('/api/admin/review/action');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(ACTION);
  });

  it.each([
    ['adminReviewQueue', (a: typeof import('../web-bridge').api) => a.adminReviewQueue()],
    ['adminReviewStats', (a: typeof import('../web-bridge').api) => a.adminReviewStats()],
    ['adminReviewDetail', (a: typeof import('../web-bridge').api) => a.adminReviewDetail('g1')],
  ])('%s throws with .httpStatus on a non-2xx', async (_name, call) => {
    resilientFetch.mockResolvedValue(jsonResponse({ error: 'Forbidden' }, 403));
    const { api } = await import('../web-bridge');

    await expect(call(api)).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('adminReviewAction throws with .httpStatus and an "HTTP 409" message on a conflict', async () => {
    resilientFetch.mockResolvedValue(jsonResponse({ error: 'already promoted' }, 409));
    const { api } = await import('../web-bridge');

    const err = await api.adminReviewAction(ACTION).then(() => null, (e: unknown) => e);
    expect((err as { httpStatus?: number }).httpStatus).toBe(409);
    // CommunityReviewViewer parses /HTTP (\d+)/ from the message to detect a benign 409.
    expect(/HTTP (\d+)/.exec((err as Error).message)?.[1]).toBe('409');
  });
});
