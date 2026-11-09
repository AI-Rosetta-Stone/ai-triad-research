// @vitest-environment node

/**
 * t/2559 — route-layer contract for GET /api/analytics/engagement (spec §7):
 * param validation (safe-ID class, t/2526), admin gating of the session/subject/
 * sessions extensions (TL p/333#89), and response shaping. The aggregation math
 * lives in community/analytics.ts and is covered by analytics.engagement.test.ts;
 * here the analytics module is mocked so we assert *only* the route's behavior.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

// Admin identity is a single flag both isAdmin() and requireAdmin() read, mirroring
// how the real requireAdmin derives admin state from the request context.
let adminState = false;
vi.mock('../community/community.js', () => ({ isAdmin: () => adminState }));
vi.mock('../community/admin/reviewRegistry.js', () => ({
  requireAdmin: (res: ServerResponse & { _status?: number; _body?: string }) => {
    if (adminState) return true;
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden' }));
    return false;
  },
}));

const queryEngagement = vi.fn();
const querySubjectBreakdown = vi.fn();
vi.mock('../community/analytics.js', () => ({
  queryEngagement: (...a: unknown[]) => queryEngagement(...a),
  querySubjectBreakdown: (...a: unknown[]) => querySubjectBreakdown(...a),
}));

import { registerSessionRoutes } from '../routes/session.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void> | void;

function makeRouter() {
  const handlers: Record<string, Handler> = {};
  const reg = (m: string) => (p: string, h: Handler) => { handlers[`${m} ${p}`] = h; };
  return {
    router: { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), del: reg('DELETE') },
    handlers,
  };
}

function fakeReq(query = ''): IncomingMessage {
  return { url: `/api/analytics/engagement${query}`, method: 'GET', headers: {} } as unknown as IncomingMessage;
}

function fakeRes(): ServerResponse & { _status?: number; _body?: string } {
  const res = {
    writeHead: vi.fn((s: number) => { res._status = s; }),
    end: vi.fn((b?: string) => { res._body = b; }),
    setHeader: vi.fn(),
  } as unknown as ServerResponse & { _status?: number; _body?: string };
  return res;
}

const ENGAGE_RESULT = {
  aggregate: { tool: { visits: 1 }, camps: {}, tabs: {} },
  daily: [],
  users: [{ user: 'alice' }],
  sessions: [{ session: 's1', startTime: '2026-08-10T09:00:00Z', engagedMs: 100, nodeCount: 1 }],
};

describe('GET /api/analytics/engagement — route layer (t/2559)', () => {
  let engagement: Handler;
  beforeEach(() => {
    adminState = false;
    queryEngagement.mockReset().mockResolvedValue(ENGAGE_RESULT);
    querySubjectBreakdown.mockReset().mockResolvedValue({ rows: [{ user: 'alice', engagedMs: 100, visits: 2 }] });
    const { router, handlers } = makeRouter();
    // ctx only needs broadcastEvent for /focus-node; engagement handler ignores it.
    registerSessionRoutes(router as never, { broadcastEvent: vi.fn() } as never);
    engagement = handlers['GET /api/analytics/engagement'];
  });

  // ── Safe-ID validation (t/2526), before any auth or query ──
  it('400s a non-safe-ID session param', async () => {
    const res = fakeRes();
    await engagement(fakeReq('?session=bad%2Fid'), res, undefined);
    expect(res._status).toBe(400);
    expect(queryEngagement).not.toHaveBeenCalled();
  });

  it('400s a non-safe-ID subject param', async () => {
    const res = fakeRes();
    await engagement(fakeReq('?subject=bad%2Fid&groupBy=user'), res, undefined);
    expect(res._status).toBe(400);
    expect(querySubjectBreakdown).not.toHaveBeenCalled();
  });

  // ── Subject WHO breakdown (§7.3) — admin-only, groupBy required ──
  it('403s a non-admin subject breakdown', async () => {
    const res = fakeRes();
    await engagement(fakeReq('?subject=acc-bel-001&groupBy=user'), res, undefined);
    expect(res._status).toBe(403);
    expect(querySubjectBreakdown).not.toHaveBeenCalled();
  });

  it('400s subject breakdown with a missing/invalid groupBy (admin)', async () => {
    adminState = true;
    const res = fakeRes();
    await engagement(fakeReq('?subject=acc-bel-001&groupBy=teams'), res, undefined);
    expect(res._status).toBe(400);
    expect(querySubjectBreakdown).not.toHaveBeenCalled();
  });

  it('serves subject breakdown for an admin and threads the optional user filter (TL addendum)', async () => {
    adminState = true;
    const res = fakeRes();
    await engagement(fakeReq('?subject=acc-bel-001&groupBy=session&user=alice'), res, undefined);
    expect(res._status ?? 200).toBe(200);
    // t/4962: the 6th arg is the analytics exclusion options (none requested here).
    expect(querySubjectBreakdown).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'acc-bel-001', 'session', 'alice', {});
    expect(JSON.parse(res._body!)).toEqual({ rows: [{ user: 'alice', engagedMs: 100, visits: 2 }] });
    expect(queryEngagement).not.toHaveBeenCalled();
  });

  // ── Session scope (§7.1) — admin-only ──
  it('403s a non-admin ?session= request', async () => {
    const res = fakeRes();
    await engagement(fakeReq('?session=s1'), res, undefined);
    expect(res._status).toBe(403);
    expect(queryEngagement).not.toHaveBeenCalled();
  });

  it('serves a session-scoped tree for an admin and passes session through', async () => {
    adminState = true;
    const res = fakeRes();
    await engagement(fakeReq('?session=s1'), res, undefined);
    expect(res._status ?? 200).toBe(200);
    expect(queryEngagement).toHaveBeenCalledWith(expect.any(String), expect.any(String), { user: undefined, session: 's1', includeSessions: true });
  });

  // ── Response shaping / gating of users + sessions (§7.2) ──
  it('strips users and sessions for a non-admin base request', async () => {
    const res = fakeRes();
    await engagement(fakeReq(''), res, undefined);
    expect(res._status ?? 200).toBe(200);
    // non-admin → includeSessions:false
    expect(queryEngagement).toHaveBeenCalledWith(expect.any(String), expect.any(String), { user: undefined, session: undefined, includeSessions: false });
    const body = JSON.parse(res._body!);
    expect(body).toHaveProperty('aggregate');
    expect(body).not.toHaveProperty('users');
    expect(body).not.toHaveProperty('sessions');
  });

  it('includes users and sessions for an admin base request', async () => {
    adminState = true;
    const res = fakeRes();
    await engagement(fakeReq(''), res, undefined);
    expect(queryEngagement).toHaveBeenCalledWith(expect.any(String), expect.any(String), { user: undefined, session: undefined, includeSessions: true });
    const body = JSON.parse(res._body!);
    expect(body.users).toEqual(ENGAGE_RESULT.users);
    expect(body.sessions).toEqual(ENGAGE_RESULT.sessions);
  });

  it('403s a non-admin querying another user (existing gating unchanged)', async () => {
    const res = fakeRes();
    await engagement(fakeReq('?user=someone-else'), res, undefined);
    expect(res._status).toBe(403);
    expect(queryEngagement).not.toHaveBeenCalled();
  });
});
