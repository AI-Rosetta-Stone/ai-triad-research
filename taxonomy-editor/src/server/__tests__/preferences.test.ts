// @vitest-environment node
//
// t/2119 — GET /api/preferences + PUT /api/preferences transport routes.
// t/4375: both routes go through getBackend() (overlay-aware), not a raw fs write / the
// non-overlay-aware readDataFile() — so flight-recorder, userContext, config, fileIO (getBackend),
// and the overlay scheduler are mocked. Drives real handlers via a captured Router + minimal
// req/res (same pattern as mentions.test.ts).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const {
  readFileMock, writeFileMock, recordMock, getStorageUserIdMock, getCurrentUserIdMock,
  resolveDataPathMock, scheduleOverlayCommitMock, ensureSessionBranchMock,
} = vi.hoisted(() => ({
  readFileMock: vi.fn<[string, unknown?], Promise<string | null>>(),
  writeFileMock: vi.fn<[string, string], Promise<{ version: string }>>(),
  recordMock: vi.fn(),
  getStorageUserIdMock: vi.fn(() => '_local'),
  getCurrentUserIdMock: vi.fn(() => '_local'),
  resolveDataPathMock: vi.fn((p: string) => `/data/${p}`),
  scheduleOverlayCommitMock: vi.fn(),
  ensureSessionBranchMock: vi.fn<[], Promise<void>>(),
}));

vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: recordMock }) }));
vi.mock('../security/userContext.js', () => ({ getStorageUserId: getStorageUserIdMock, getCurrentUserId: getCurrentUserIdMock }));
vi.mock('../config.js', () => ({ resolveDataPath: resolveDataPathMock }));
vi.mock('../storage/fileIO.js', () => ({ getBackend: () => ({ readFile: readFileMock, writeFile: writeFileMock }) }));
vi.mock('../storage/overlayCommitScheduler.js', () => ({ scheduleOverlayCommit: scheduleOverlayCommitMock }));

import type { ServerCtx } from '../routes/context.js';
import { createRouter, type Handler } from '../httpKit.js';
import { registerPreferencesRoutes } from '../routes/preferences.js';

const fakeCtx = { ensureSessionBranch: ensureSessionBranchMock } as unknown as ServerCtx;

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

function makeReq(method: string): IncomingMessage {
  return { url: '/api/preferences', method, headers: {} } as unknown as IncomingMessage;
}

async function invokeGet(): Promise<{ status: number; body: unknown }> {
  const routes: { method: string; path: string; handler: Handler }[] = [];
  registerPreferencesRoutes(createRouter(routes), fakeCtx);
  const route = routes.find(r => r.method === 'GET' && r.path === '/api/preferences');
  if (!route) throw new Error('GET /api/preferences not registered');
  const res = makeRes();
  await route.handler(makeReq('GET'), res, undefined);
  return { status: res._status, body: res._body };
}

async function invokePut(body: unknown): Promise<{ status: number }> {
  const routes: { method: string; path: string; handler: Handler }[] = [];
  registerPreferencesRoutes(createRouter(routes), fakeCtx);
  const route = routes.find(r => r.method === 'PUT' && r.path === '/api/preferences');
  if (!route) throw new Error('PUT /api/preferences not registered');
  const res = makeRes();
  await route.handler(makeReq('PUT'), res, body);
  return { status: res._status };
}

describe('GET /api/preferences (t/2119, t/4375)', () => {
  beforeEach(() => { readFileMock.mockReset(); recordMock.mockReset(); });

  it('returns null when no prefs file exists', async () => {
    readFileMock.mockResolvedValue(null);
    const { status, body } = await invokeGet();
    expect(status).toBe(200);
    expect(body).toBeNull();
  });

  it('reads through getBackend().readFile with optional:true (no throw on a missing file)', async () => {
    readFileMock.mockResolvedValue(null);
    await invokeGet();
    expect(readFileMock).toHaveBeenCalledWith(expect.stringContaining('_local.json'), { optional: true });
  });

  it('returns stored prefs when file exists (valid file round-trips)', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ viewMode: 'advanced' }));
    const { status, body } = await invokeGet();
    expect(status).toBe(200);
    expect(body).toEqual({ viewMode: 'advanced' });
  });

  // t/3537 (t/3534): a present-but-invalid stored file must degrade to defaults +
  // an FR WARN naming the offending field — NOT a 500, NOT the raw bad value. This
  // is the unvalidated-read gap the shared schema (t/3535) closes.
  it('malformed stored file → defaults + a flight-recorder WARN naming the field', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ viewMode: 'superuser' }));
    const { status, body } = await invokeGet();
    expect(status).toBe(200);
    expect(body).toEqual({ viewMode: 'simple' }); // DEFAULT_USER_PREFERENCES
    const warn = recordMock.mock.calls.find(c => c[0]?.level === 'warn');
    expect(warn, 'a warn-level FR event should be recorded').toBeTruthy();
    expect(warn![0].message).toContain('viewMode'); // names the offending field
  });

  it('non-object stored content → defaults + WARN (never throws / 500)', async () => {
    readFileMock.mockResolvedValue(JSON.stringify('garbage'));
    const { status, body } = await invokeGet();
    expect(status).toBe(200);
    expect(body).toEqual({ viewMode: 'simple' });
    expect(recordMock.mock.calls.some(c => c[0]?.level === 'warn')).toBe(true);
  });

  it('a readFile throw (unexpected infra error) surfaces as 500', async () => {
    readFileMock.mockRejectedValue(new Error('boom'));
    const { status } = await invokeGet();
    expect(status).toBe(500);
  });
});

describe('PUT /api/preferences (t/2119, t/4375)', () => {
  beforeEach(() => {
    writeFileMock.mockReset().mockResolvedValue({ version: 'abc123' });
    ensureSessionBranchMock.mockReset().mockResolvedValue(undefined);
    scheduleOverlayCommitMock.mockReset();
    recordMock.mockReset();
  });

  it('ensures a session branch BEFORE writing (never a direct-main-commit on an anonymous/no-session caller)', async () => {
    const callOrder: string[] = [];
    ensureSessionBranchMock.mockImplementation(async () => { callOrder.push('ensure'); });
    writeFileMock.mockImplementation(async () => { callOrder.push('write'); return { version: 'x' }; });
    await invokePut({ viewMode: 'simple' });
    expect(callOrder).toEqual(['ensure', 'write']);
  });

  it('writes through getBackend().writeFile and schedules the overlay commit, returns 204', async () => {
    const { status } = await invokePut({ viewMode: 'simple' });
    expect(status).toBe(204);
    expect(writeFileMock).toHaveBeenCalledWith(
      expect.stringContaining('_local.json'),
      JSON.stringify({ viewMode: 'simple' }),
    );
    expect(scheduleOverlayCommitMock).toHaveBeenCalledWith('_local');
  });

  it('returns 400 and does not write for an invalid schema', async () => {
    const { status } = await invokePut({ viewMode: 'superuser' });
    expect(status).toBe(400);
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(ensureSessionBranchMock).not.toHaveBeenCalled();
  });

  it('an ensureSessionBranch failure surfaces as 500 and never reaches writeFile', async () => {
    ensureSessionBranchMock.mockRejectedValue(new Error('branch creation failed'));
    const { status } = await invokePut({ viewMode: 'simple' });
    expect(status).toBe(500);
    expect(writeFileMock).not.toHaveBeenCalled();
  });
});
