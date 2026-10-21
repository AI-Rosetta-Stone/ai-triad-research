// @vitest-environment node
//
// t/4372 (t/4264#2) — POST /api/data/set-root is a desktop/local-server-only feature; refuse it
// on hosted. Keyed on isLocalDeployment() (STORAGE_MODE==='filesystem' && NODE_ENV!=='production'),
// not STORAGE_MODE alone, because the prod rollback runbook can set STORAGE_MODE=filesystem on
// hosted prod (t/4229's exact trap) — same predicate /api/models/refresh's `accept` gate uses.
// STORAGE_MODE is a module-load const, so it's mocked via a controllable getter (NODE_ENV is a
// real env var, set directly per test).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';

const cfgMock = vi.hoisted(() => ({ storageMode: 'filesystem' as string }));
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    get STORAGE_MODE() { return cfgMock.storageMode; },
    isLocalDeployment: () => cfgMock.storageMode === 'filesystem' && process.env.NODE_ENV !== 'production',
  };
});

import { runWithUser, type UserContext } from '../security/userContext.js';
import { createRouter } from '../httpKit.js';
import { registerDataRoutes } from '../routes/data.js';

const ADMIN_ID = 'admin-user';
let prevAdminUsers: string | undefined;
let prevNodeEnv: string | undefined;

function mockRes(): http.ServerResponse & { statusCode: number; body: string } {
  const r = {
    statusCode: 0, body: '', writableEnded: false, headersSent: false,
    writeHead(code: number) { r.statusCode = code; return r; },
    setHeader() {}, write() { return true; },
    end(b?: string) { r.body = b ?? ''; r.writableEnded = true; return r; },
    on() { return r; },
  };
  return r as unknown as http.ServerResponse & { statusCode: number; body: string };
}
function asAdmin<T>(fn: () => T): T {
  const c: UserContext = { principalName: ADMIN_ID, idp: 'github', storageUserId: ADMIN_ID, isAnonymous: false };
  return runWithUser(c, fn);
}
function setRootHandler(): (req: unknown, res: unknown, body: unknown) => Promise<void> {
  const routes: Array<{ method: string; path: string; handler: (req: unknown, res: unknown, body: unknown) => Promise<void> }> = [];
  registerDataRoutes(createRouter(routes as never), { serverRecorder: null } as never);
  return routes.find(r => r.method === 'POST' && r.path === '/api/data/set-root')!.handler;
}

beforeEach(() => {
  prevAdminUsers = process.env.ADMIN_USERS;
  process.env.ADMIN_USERS = ADMIN_ID;
  prevNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test'; // non-production baseline
  cfgMock.storageMode = 'filesystem';
});
afterEach(() => {
  if (prevAdminUsers === undefined) delete process.env.ADMIN_USERS; else process.env.ADMIN_USERS = prevAdminUsers;
  if (prevNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNodeEnv;
});

describe('POST /api/data/set-root hosted gate (t/4372, t/4264#2)', () => {
  it('filesystem + non-production (genuine desktop/local server): not refused by the gate', async () => {
    const res = mockRes();
    await asAdmin(() => setRootHandler()({}, res, { newRoot: '/does/not/exist' }));
    // Past the gate, it 400s on the nonexistent directory — proves the gate let it through.
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/does not exist/);
  });

  it('github-api mode: refused with 409, nothing touches process.env.AI_TRIAD_DATA_ROOT', async () => {
    cfgMock.storageMode = 'github-api';
    const before = process.env.AI_TRIAD_DATA_ROOT;
    const res = mockRes();
    await asAdmin(() => setRootHandler()({}, res, { newRoot: '/does/not/exist' }));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('SET_ROOT_NOT_SUPPORTED_ON_HOSTED');
    expect(process.env.AI_TRIAD_DATA_ROOT).toBe(before);
  });

  it('filesystem + production (the t/4229 prod-rollback-runbook trap): refused with 409', async () => {
    process.env.NODE_ENV = 'production';
    cfgMock.storageMode = 'filesystem'; // STORAGE_MODE alone would fail OPEN here
    const res = mockRes();
    await asAdmin(() => setRootHandler()({}, res, { newRoot: '/does/not/exist' }));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('SET_ROOT_NOT_SUPPORTED_ON_HOSTED');
  });

  it('non-admin is still refused before the hosted gate even runs', async () => {
    const res = mockRes();
    await setRootHandler()({}, res, { newRoot: '/does/not/exist' }); // no user context → not admin
    expect(res.statusCode).toBe(403);
  });
});
