// @vitest-environment node
//
// t/2119 — GET /api/preferences + PUT /api/preferences transport routes.
// t/629 (t/638, Security p/93#85): both routes use the USER-CONTENT backend (Blob when hosted), never the data repo.
// The old data-repo copy is read once, read-only, as a legacy fallback. No session branch, no overlay commit.
// Drives real handlers via a captured Router + minimal req/res (same pattern as mentions.test.ts).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const h = vi.hoisted(() => ({
  ucRead: vi.fn<[string, unknown?], Promise<string | null>>(),
  ucWrite: vi.fn<[string, string], Promise<{ version: string }>>(),
  repoRead: vi.fn<[string, unknown?], Promise<string | null>>(),
  repoWrite: vi.fn<[string, string], Promise<{ version: string }>>(),
  sameBackend: false,
  hostedAnon: false,
  storageId: '_local',
  record: vi.fn(),
  warn: vi.fn(),
}));

const userContent = { readFile: h.ucRead, writeFile: h.ucWrite };
const dataRepo = { readFile: h.repoRead, writeFile: h.repoWrite };

vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: h.record }) }));
vi.mock('../security/userContext.js', () => ({ getStorageUserId: () => h.storageId, getCurrentUserId: () => h.storageId, isHostedAnonymousRequest: () => h.hostedAnon }));
vi.mock('../config.js', () => ({ resolveDataPath: (p: string) => `/data/${p}` }));
vi.mock('../logger.js', () => ({ log: { server: { info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() } }, getRequestId: () => 'req-prefs' }));
vi.mock('../storage/fileIO.js', () => ({
  getUserContentBackend: () => (h.sameBackend ? dataRepo : userContent),
  getBackend: () => dataRepo,
}));

import type { ServerCtx } from '../routes/context.js';
import { createRouter, type Handler } from '../httpKit.js';
import { registerPreferencesRoutes } from '../routes/preferences.js';

const ensureSessionBranch = vi.fn();
const fakeCtx = { ensureSessionBranch } as unknown as ServerCtx;

function makeRes(): ServerResponse & { _status: number; _body: unknown } {
  let _status = 200;
  let _body: unknown;
  return {
    writableEnded: false, headersSent: false,
    writeHead(s: number) { _status = s; (this as { headersSent: boolean }).headersSent = true; },
    end(b?: string) { _body = b ? JSON.parse(b) : undefined; (this as { writableEnded: boolean }).writableEnded = true; },
    get _status() { return _status; },
    get _body() { return _body; },
  } as unknown as ServerResponse & { _status: number; _body: unknown };
}

const makeReq = (method: string) => ({ url: '/api/preferences', method, headers: {} } as unknown as IncomingMessage);

async function invoke(method: 'GET' | 'PUT', body?: unknown): Promise<{ status: number; body: unknown }> {
  const routes: { method: string; path: string; handler: Handler }[] = [];
  registerPreferencesRoutes(createRouter(routes), fakeCtx);
  const route = routes.find(r => r.method === method && r.path === '/api/preferences');
  if (!route) throw new Error(`${method} /api/preferences not registered`);
  const res = makeRes();
  await route.handler(makeReq(method), res, body);
  return { status: res._status, body: res._body };
}

beforeEach(() => {
  for (const f of [h.ucRead, h.repoRead, h.record, h.warn, ensureSessionBranch]) f.mockReset();
  h.ucWrite.mockReset().mockResolvedValue({ version: 'v' });
  h.repoWrite.mockReset().mockResolvedValue({ version: 'v' });
  h.ucRead.mockResolvedValue(null);
  h.repoRead.mockResolvedValue(null);
  h.sameBackend = false;
  h.hostedAnon = false;
  h.storageId = '_local';
});

describe('GET /api/preferences (t/2119, t/629)', () => {
  it('returns null when no prefs exist anywhere', async () => {
    const { status, body } = await invoke('GET');
    expect(status).toBe(200);
    expect(body).toBeNull();
    expect(h.ucRead).toHaveBeenCalledWith(expect.stringContaining('_local.json'), { optional: true });
  });

  it('reads from the user-content backend; the data repo is not read when user content has the file', async () => {
    h.ucRead.mockResolvedValue(JSON.stringify({ viewMode: 'advanced' }));
    const { body } = await invoke('GET');
    expect(body).toEqual({ viewMode: 'advanced' });
    expect(h.repoRead).not.toHaveBeenCalled();
  });

  it('legacy: falls back to the pre-t/629 data-repo copy, read-only, with a WARN', async () => {
    h.repoRead.mockResolvedValue(JSON.stringify({ viewMode: 'advanced' }));
    const { body } = await invoke('GET');
    expect(body).toEqual({ viewMode: 'advanced' });
    expect(h.warn).toHaveBeenCalled();
    expect(h.repoWrite).not.toHaveBeenCalled();
  });

  it('filesystem mode (one backend): no second legacy read', async () => {
    h.sameBackend = true;
    await invoke('GET');
    expect(h.repoRead).toHaveBeenCalledTimes(1);
  });

  // t/3537 (t/3534): a present-but-invalid stored file degrades to defaults + an FR WARN naming the field.
  it('malformed stored file → defaults + a flight-recorder WARN naming the field', async () => {
    h.ucRead.mockResolvedValue(JSON.stringify({ viewMode: 'superuser' }));
    const { status, body } = await invoke('GET');
    expect(status).toBe(200);
    expect(body).toEqual({ viewMode: 'simple' });
    const warn = h.record.mock.calls.find(c => c[0]?.level === 'warn');
    expect(warn![0].message).toContain('viewMode');
  });

  it('a user-content read throw (unexpected infra error) surfaces as 500', async () => {
    h.ucRead.mockRejectedValue(new Error('boom'));
    expect((await invoke('GET')).status).toBe(500);
  });
});

describe('PUT /api/preferences (t/2119, t/629)', () => {
  it('writes to the user-content backend, returns 204, and never touches the data repo or a session branch', async () => {
    const { status } = await invoke('PUT', { viewMode: 'simple' });
    expect(status).toBe(204);
    expect(h.ucWrite).toHaveBeenCalledWith(expect.stringContaining('_local.json'), JSON.stringify({ viewMode: 'simple' }));
    expect(h.repoWrite).not.toHaveBeenCalled();
    expect(ensureSessionBranch).not.toHaveBeenCalled();
  });

  it('returns 400 and does not write for an invalid schema', async () => {
    expect((await invoke('PUT', { viewMode: 'superuser' })).status).toBe(400);
    expect(h.ucWrite).not.toHaveBeenCalled();
  });

  it('a user-content write failure (e.g. hosted with Blob down, fail closed) surfaces as 500', async () => {
    h.ucWrite.mockRejectedValue(new Error('user content unavailable'));
    expect((await invoke('PUT', { viewMode: 'simple' })).status).toBe(500);
    expect(h.repoWrite).not.toHaveBeenCalled();
  });
});

describe('t/574 stopgap: a hosted anonymous request with no session (storage id _local) gets 401 no_session', () => {
  it('GET and PUT are refused, and neither backend is read or written', async () => {
    h.hostedAnon = true;
    expect((await invoke('GET')).status).toBe(401);
    expect((await invoke('PUT', { viewMode: 'simple' })).status).toBe(401);
    expect(h.ucRead).not.toHaveBeenCalled();
    expect(h.repoRead).not.toHaveBeenCalled();
    expect(h.ucWrite).not.toHaveBeenCalled();
  });

  it('a hosted anonymous request WITH a session (anon-<uuid>) is served from its own file', async () => {
    h.hostedAnon = true;
    h.storageId = 'anon-0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11';
    expect((await invoke('PUT', { viewMode: 'simple' })).status).toBe(204);
    expect(h.ucWrite).toHaveBeenCalledWith(expect.stringContaining('anon-0f8fad5b'), expect.any(String));
  });

  it('local AUTH_DISABLED mode (_local, not hosted) is unaffected', async () => {
    expect((await invoke('PUT', { viewMode: 'simple' })).status).toBe(204);
  });
});
