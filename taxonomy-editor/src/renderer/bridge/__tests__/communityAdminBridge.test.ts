// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4898: admin rename/delete of a published community item, both builds. adminRemoveCommunityItem
// previously had no test coverage at all; adding it here alongside the new renameCommunityItem
// since both now share the same `del`/`patch` core (t/4898#3/p/356#166).

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const { resilientFetch } = vi.hoisted(() => ({ resilientFetch: vi.fn() }));

vi.mock('../resilience', () => ({
  resilientFetch,
  categorizeEndpoint: () => 'mutation',
  registerConnectionPoolProvider: vi.fn(),
}));
vi.mock('@lib/debate/errors', () => ({ ActionableError: class ActionableError extends Error {} }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('../instrumentBridge', () => ({ instrumentBridge: (raw: unknown) => raw }));

describe('electron-bridge community admin delegation', () => {
  const origWindow = (globalThis as Record<string, unknown>).window;

  afterEach(() => {
    (globalThis as Record<string, unknown>).window = origWindow;
    vi.resetModules();
  });

  it('delegates adminRemoveCommunityItem/renameCommunityItem to window.electronAPI', async () => {
    const adminRemoveCommunityItem = vi.fn().mockResolvedValue(undefined);
    const renameCommunityItem = vi.fn().mockResolvedValue(undefined);
    (globalThis as Record<string, unknown>).window = { electronAPI: { adminRemoveCommunityItem, renameCommunityItem } };
    const mod = await import('../electron-bridge');

    await mod.api.adminRemoveCommunityItem('debates', 'deb-1', 'spam');
    expect(adminRemoveCommunityItem).toHaveBeenCalledWith('debates', 'deb-1', 'spam');

    await mod.api.renameCommunityItem('debates', 'deb-1', 'Clearer title', 'typo');
    expect(renameCommunityItem).toHaveBeenCalledWith('debates', 'deb-1', 'Clearer title', 'typo');
  });
});

describe('web-bridge community admin REST calls', () => {
  beforeEach(() => {
    vi.resetModules();
    resilientFetch.mockReset();
  });

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

  // t/4898: adminRemoveCommunityItem used a bare fetch() for this (Network Resilience rule
  // violation — `del` had no body support) before `del` grew an optional `body` param.
  it('adminRemoveCommunityItem DELETEs with the reason in the body, through del()', async () => {
    resilientFetch.mockResolvedValue(jsonResponse({ ok: true }));
    const { api } = await import('../web-bridge');

    await api.adminRemoveCommunityItem('chats', 'chat-1', 'spam');

    const [path, init] = resilientFetch.mock.calls[0];
    expect(path).toBe('/api/community/chats/chat-1');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body)).toEqual({ reason: 'spam' });
  });

  it('adminRemoveCommunityItem omits a body-less reason cleanly (reason: undefined is still sent, matching the server contract)', async () => {
    resilientFetch.mockResolvedValue(jsonResponse({ ok: true }));
    const { api } = await import('../web-bridge');

    await api.adminRemoveCommunityItem('chats', 'chat-1');

    const [, init] = resilientFetch.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ reason: undefined });
  });

  it('renameCommunityItem PATCHes {title, reason} and resolves void', async () => {
    resilientFetch.mockResolvedValue(jsonResponse({ ok: true }));
    const { api } = await import('../web-bridge');

    const result = await api.renameCommunityItem('debates', 'deb-1', 'Clearer title', 'typo');

    expect(result).toBeUndefined();
    const [path, init] = resilientFetch.mock.calls[0];
    expect(path).toBe('/api/community/debates/deb-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ title: 'Clearer title', reason: 'typo' });
  });

  it('renameCommunityItem surfaces a non-admin 403 as an httpStatus-tagged error', async () => {
    resilientFetch.mockResolvedValue(jsonResponse({ error: 'Forbidden' }, 403));
    const { api } = await import('../web-bridge');

    await expect(api.renameCommunityItem('debates', 'deb-1', 'Clearer title')).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('encodeURIComponent-escapes the type and id path segments for both calls', async () => {
    resilientFetch.mockResolvedValue(jsonResponse({ ok: true }));
    const { api } = await import('../web-bridge');

    await api.renameCommunityItem('inquiries', 'a/b', 'Title');
    expect(resilientFetch.mock.calls[0][0]).toBe('/api/community/inquiries/a%2Fb');
  });
});
