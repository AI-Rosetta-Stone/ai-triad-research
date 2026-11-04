// @vitest-environment node
//
// t/3484 — POST /api/admin/community/opeds/backfill-shares: the admin-gated one-time backfill that
// mints shareIds + writes public projections for all existing community op-eds (completes the t/3481
// public index). Guards tested: requireAdmin (403 non-admin / no-context) before any work; admin →
// 200 + the run tally. The real requireAdmin runs (ADMIN_USERS env + runWithUser, per t/2645 pattern);
// backfillCommunityOpedShares (Server Community) is mocked so no storage is touched.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';

const backfillCommunityOpedShares = vi.fn();
vi.mock('../community/community.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../community/community.js')>();
  return { ...actual, backfillCommunityOpedShares: (...a: unknown[]) => backfillCommunityOpedShares(...a) };
});

import { runWithUser, type UserContext } from '../security/userContext.js';
import { createRouter } from '../httpKit.js';
import { registerAdminRoutes } from '../routes/admin.js';

const ROUTE = '/api/admin/community/opeds/backfill-shares';
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

beforeEach(() => { prevAdminUsers = process.env.ADMIN_USERS; process.env.ADMIN_USERS = `github:${ADMIN_ID}` /* t/4328: idp-qualified entry */; backfillCommunityOpedShares.mockReset(); });
afterEach(() => { if (prevAdminUsers === undefined) delete process.env.ADMIN_USERS; else process.env.ADMIN_USERS = prevAdminUsers; });

describe('t/3484 — POST /api/admin/community/opeds/backfill-shares (admin-gated)', () => {
  it('403 for a non-admin — before any backfill work', async () => {
    const res = mockRes();
    await asUser('someone-else', () => handlerFor('POST', ROUTE)({}, res, {}));
    expect(res.statusCode).toBe(403);
    expect(backfillCommunityOpedShares).not.toHaveBeenCalled();
  });

  it('no-context (_local) is also rejected (403)', async () => {
    const res = mockRes();
    await handlerFor('POST', ROUTE)({}, res, {});
    expect(res.statusCode).toBe(403);
    expect(backfillCommunityOpedShares).not.toHaveBeenCalled();
  });

  it('admin → 200 + the run tally from backfillCommunityOpedShares', async () => {
    backfillCommunityOpedShares.mockResolvedValue({ minted: 3, alreadyShared: 2, skipped: 1, skippedIds: ['oped-bad'] });
    const res = mockRes();
    await asUser(ADMIN_ID, () => handlerFor('POST', ROUTE)({}, res, {}));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ minted: 3, alreadyShared: 2, skipped: 1, skippedIds: ['oped-bad'] });
    expect(backfillCommunityOpedShares).toHaveBeenCalledTimes(1);
  });

  it('admin + backfill throws → 500 (not a swallowed false-200)', async () => {
    backfillCommunityOpedShares.mockRejectedValue(new Error('blob unreachable'));
    const res = mockRes();
    await asUser(ADMIN_ID, () => handlerFor('POST', ROUTE)({}, res, {}));
    expect(res.statusCode).toBe(500);
  });
});
