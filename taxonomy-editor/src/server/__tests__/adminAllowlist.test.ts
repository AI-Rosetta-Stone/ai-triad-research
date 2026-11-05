// @vitest-environment node
//
// t/3498 (t/3495 epic) — admin CRUD for the Gemini-allowlist: GET/POST/DELETE
// /api/admin/allowlist. Guards tested: requireAdmin (403 non-admin / no-context)
// before any work; POST body validation (userId + email both required — no
// server-side email→userId derivation per TL t/3498#2/#4); pass-through to
// allowlistStore (mocked so no storage is touched).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';

const getEntries = vi.fn();
const addEntry = vi.fn();
const removeEntry = vi.fn();
vi.mock('../storage/allowlistStore.js', () => ({
  getEntries: (...a: unknown[]) => getEntries(...a),
  addEntry: (...a: unknown[]) => addEntry(...a),
  removeEntry: (...a: unknown[]) => removeEntry(...a),
}));

import { runWithUser, type UserContext } from '../security/userContext.js';
import { createRouter } from '../httpKit.js';
import { registerAdminRoutes } from '../routes/admin.js';

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
  registerAdminRoutes(createRouter(routes as never), { serverRecorder: null, ensureSessionBranch: async () => {}, appendServerLogs: () => {} } as never);
  return routes.find(r => r.method === method && r.path === path)!.handler;
}

beforeEach(() => {
  prevAdminUsers = process.env.ADMIN_USERS;
  process.env.ADMIN_USERS = `github:${ADMIN_ID}`; // t/4328: idp-qualified entry
  getEntries.mockReset(); addEntry.mockReset(); removeEntry.mockReset();
});
afterEach(() => { if (prevAdminUsers === undefined) delete process.env.ADMIN_USERS; else process.env.ADMIN_USERS = prevAdminUsers; });

describe('t/3498 — GET /api/admin/allowlist (admin-gated)', () => {
  it('403 for a non-admin', async () => {
    const res = mockRes();
    await asUser('someone-else', () => handlerFor('GET', '/api/admin/allowlist')({}, res, undefined));
    expect(res.statusCode).toBe(403);
    expect(getEntries).not.toHaveBeenCalled();
  });

  it('admin → 200 + AdminAllowlistResponse', async () => {
    getEntries.mockReturnValue([{ userId: 'u1', email: 'a@b.com', addedAt: '2026-01-01T00:00:00.000Z' }]);
    const res = mockRes();
    await asUser(ADMIN_ID, () => handlerFor('GET', '/api/admin/allowlist')({}, res, undefined));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ entries: [{ userId: 'u1', email: 'a@b.com', addedAt: '2026-01-01T00:00:00.000Z' }] });
  });
});

describe('t/3498 — POST /api/admin/allowlist (admin-gated)', () => {
  it('403 for a non-admin — before any validation/write', async () => {
    const res = mockRes();
    await asUser('someone-else', () => handlerFor('POST', '/api/admin/allowlist')({}, res, { userId: 'u1', email: 'a@b.com' }));
    expect(res.statusCode).toBe(403);
    expect(addEntry).not.toHaveBeenCalled();
  });

  it('400 when userId is missing — no server-side email→userId derivation (TL t/3498#2/#4)', async () => {
    const res = mockRes();
    await asUser(ADMIN_ID, () => handlerFor('POST', '/api/admin/allowlist')({}, res, { email: 'a@b.com' }));
    expect(res.statusCode).toBe(400);
    expect(addEntry).not.toHaveBeenCalled();
  });

  it('400 when email is missing', async () => {
    const res = mockRes();
    await asUser(ADMIN_ID, () => handlerFor('POST', '/api/admin/allowlist')({}, res, { userId: 'u1' }));
    expect(res.statusCode).toBe(400);
    expect(addEntry).not.toHaveBeenCalled();
  });

  it('admin + valid body → 200 + addEntry called with userId, email, addedAt', async () => {
    const res = mockRes();
    await asUser(ADMIN_ID, () => handlerFor('POST', '/api/admin/allowlist')({}, res, { userId: 'u1', email: 'a@b.com' }));
    expect(res.statusCode).toBe(200);
    expect(addEntry).toHaveBeenCalledTimes(1);
    const entry = addEntry.mock.calls[0][0];
    expect(entry.userId).toBe('u1');
    expect(entry.email).toBe('a@b.com');
    expect(typeof entry.addedAt).toBe('string');
  });
});

describe('t/3498 — DELETE /api/admin/allowlist/:userId (admin-gated)', () => {
  it('403 for a non-admin', async () => {
    const res = mockRes();
    await asUser('someone-else', () => handlerFor('DELETE', '/api/admin/allowlist/:userId')({ url: '/api/admin/allowlist/u1' }, res, undefined));
    expect(res.statusCode).toBe(403);
    expect(removeEntry).not.toHaveBeenCalled();
  });

  it('admin → 200 + removeEntry called with userId', async () => {
    const res = mockRes();
    await asUser(ADMIN_ID, () => handlerFor('DELETE', '/api/admin/allowlist/:userId')({ url: '/api/admin/allowlist/u1' }, res, undefined));
    expect(res.statusCode).toBe(200);
    expect(removeEntry).toHaveBeenCalledWith('u1');
  });
});
