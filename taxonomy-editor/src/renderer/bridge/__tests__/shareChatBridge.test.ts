// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4922 (transport for t/4871): shareChat/unshareChat. Electron has no public share
// surface (mirrors shareOpEdSet/unshareOpEdSet) and rejects; the web bridge computes
// url/isNew client-side since #4545's real response has neither field (TL t/4922#4).

import { describe, it, expect, vi } from 'vitest';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => undefined }));

describe('electron-bridge shareChat/unshareChat (t/4922)', () => {
  it('shareChat rejects — no public share surface on the desktop app', async () => {
    const mod = await import('../electron-bridge');
    await expect(mod.api.shareChat('chat-1', { title: 't', messages: [] }))
      .rejects.toThrow('not available in the desktop app');
  });

  it('unshareChat rejects — no public share surface on the desktop app', async () => {
    const mod = await import('../electron-bridge');
    await expect(mod.api.unshareChat('chat-1')).rejects.toThrow('not available in the desktop app');
  });
});

describe('web-bridge shareChat request shape (t/4922)', () => {
  it('POSTs the title/messages body to /api/chat/:id/share, and computes shareId/url/isNew from a 201 response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'abc123', expires_at: '2026-12-06T00:00:00.000Z' }), {
        status: 201, headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', { origin: 'https://app.example.com', pathname: '/' } as unknown as Location);

    const { api } = await import('../web-bridge');
    const result = await api.shareChat('chat-1', { title: 'My chat', messages: [{ role: 'user', content: 'hi' }] });

    expect(result).toEqual({
      shareId: 'abc123',
      url: 'https://app.example.com/share/chat/abc123',
      expiresAt: '2026-12-06T00:00:00.000Z',
      isNew: true,
    });

    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/chat/chat-1/share'));
    expect(call, 'expected a POST to /api/chat/chat-1/share').toBeTruthy();
    const init = call![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ title: 'My chat', messages: [{ role: 'user', content: 'hi' }] });

    vi.unstubAllGlobals();
  });

  it('forwards replace=true in the request body, and reads isNew=false from a 200 (idempotent) response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'existing-1', expires_at: '2026-12-01T00:00:00.000Z' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', { origin: 'https://app.example.com', pathname: '/' } as unknown as Location);

    const { api } = await import('../web-bridge');
    const result = await api.shareChat('chat-1', { title: 'My chat', messages: [], replace: true });

    expect(result.isNew).toBe(false);
    expect(result.shareId).toBe('existing-1');
    expect(result.url).toBe('https://app.example.com/share/chat/existing-1');

    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/chat/chat-1/share'));
    expect(JSON.parse((call![1] as RequestInit).body as string)).toMatchObject({ replace: true });

    vi.unstubAllGlobals();
  });

  it('unshareChat sends DELETE to /api/chat/:id/share and resolves (discarding the body)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'abc123' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { api } = await import('../web-bridge');
    await expect(api.unshareChat('chat-1')).resolves.toBeUndefined();

    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/chat/chat-1/share'));
    expect((call![1] as RequestInit | undefined)?.method).toBe('DELETE');

    vi.unstubAllGlobals();
  });
});
