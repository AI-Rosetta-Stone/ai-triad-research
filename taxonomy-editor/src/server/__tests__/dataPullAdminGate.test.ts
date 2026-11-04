// @vitest-environment node
//
// t/2645 + t/2649 — the "no git-pull on github-api mode" story for the data-mutation routes.
// /api/data/pull + /api/data/check-updates run destructive git ops (reset --hard, clean -fd,
// fetch) on the shared data worktree at getDataRoot(). Two guards, tested here:
//   t/2645 — requireAdmin: they were the data routes left ungated (siblings set-root/clone gate).
//   t/2649 — on STORAGE_MODE=github-api the GitHub API is authoritative, so the /mnt/shared git
//            path is vestigial + hazardous → skipped entirely (also moots the dubious-ownership
//            false-healthy 200 that check-updates was returning ~every 30s on ACA).
//
// STORAGE_MODE is a module-load const, so config is mocked to 'github-api' (the prod mode).
// requireAdmin runs first, so the non-admin 403 tests are unaffected by the mode.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, STORAGE_MODE: 'github-api' };
});

import { runWithUser, type UserContext } from '../security/userContext.js';
import { createRouter } from '../httpKit.js';
import { registerDataRoutes } from '../routes/data.js';

const ADMIN_ID = 'admin-user';
let prevAdminUsers: string | undefined;

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
function asUser<T>(storageUserId: string, fn: () => T): T {
  const c: UserContext = { principalName: storageUserId, idp: 'github', storageUserId, stableId: `github:${storageUserId}`, isAnonymous: false };
  return runWithUser(c, fn);
}
function handlerFor(method: string, path: string): (req: unknown, res: unknown, body: unknown) => Promise<void> {
  const routes: Array<{ method: string; path: string; handler: (req: unknown, res: unknown, body: unknown) => Promise<void> }> = [];
  registerDataRoutes(createRouter(routes as never), { serverRecorder: null } as never);
  return routes.find(r => r.method === method && r.path === path)!.handler;
}

beforeEach(() => { prevAdminUsers = process.env.ADMIN_USERS; process.env.ADMIN_USERS = `github:${ADMIN_ID}` /* t/4328: idp-qualified entry */; });
afterEach(() => { if (prevAdminUsers === undefined) delete process.env.ADMIN_USERS; else process.env.ADMIN_USERS = prevAdminUsers; });

describe('t/2645 — data mutation routes require admin (before any git op)', () => {
  it('POST /api/data/pull → 403 for a non-admin', async () => {
    const res = mockRes();
    await asUser('someone-else', () => handlerFor('POST', '/api/data/pull')({}, res, {}));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('Forbidden');
  });
  it('POST /api/data/check-updates → 403 for a non-admin', async () => {
    const res = mockRes();
    await asUser('someone-else', () => handlerFor('POST', '/api/data/check-updates')({}, res, {}));
    expect(res.statusCode).toBe(403);
  });
  it('no-context (_local) is also rejected', async () => {
    const res = mockRes();
    await handlerFor('POST', '/api/data/pull')({}, res, {});
    expect(res.statusCode).toBe(403);
  });
});

describe('t/2649 — github-api mode skips git entirely (no reset --hard / clean -fd / fetch)', () => {
  it('admin POST /api/data/pull → 200 "skipped", never runs git', async () => {
    const res = mockRes();
    await asUser(ADMIN_ID, () => handlerFor('POST', '/api/data/pull')({}, res, {}));
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/skipped|github-api|source of truth/i);
  });
  it('admin POST /api/data/check-updates → honest {available:false} (not a swallowed-error false 200)', async () => {
    const res = mockRes();
    await asUser(ADMIN_ID, () => handlerFor('POST', '/api/data/check-updates')({}, res, {}));
    const body = JSON.parse(res.body);
    expect(body.available).toBe(false);
    expect(body.reason).toMatch(/github-api/i);
  });
});
