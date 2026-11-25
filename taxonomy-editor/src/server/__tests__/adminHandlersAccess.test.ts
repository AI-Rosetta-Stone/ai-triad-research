// @vitest-environment node
// t/592 (incident t/579, root fix 2): five GET handlers that the anonymous gate (#5500) refuses to anonymous callers
// had no check of their own, so a signed-in non-admin could read them. Now each checks in the handler: admin/health,
// analytics/query and calibration log/history are admin-only; analytics/engagement is admin-only except a signed-in
// caller's own activity, which an anonymous caller (derived id '_local', the owner's) can never match. The real routes
// and the real userContext and admin check run under server.ts's request contexts; storage and analytics are fakes
// that record every read.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const h = vi.hoisted(() => ({ reads: [] as string[] }));

vi.mock('../logger.js', () => {
  const l = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { log: { server: l(), api: l(), fr: l(), ai: l() }, getRequestId: () => 'req-t592' };
});
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }), setGlobalRecorder: vi.fn() }));
vi.mock('../community/analytics.js', () => ({
  queryAggregated: vi.fn(async () => { h.reads.push('analytics.aggregate'); return { total: 1 }; }),
  queryRawEvents: vi.fn(async () => { h.reads.push('analytics.raw'); return []; }),
  queryEngagement: vi.fn(async (_f: string, _t: string, o: { user?: string }) => { h.reads.push(`analytics.engagement:${o.user ?? '-'}`); return { tree: [], users: ['u'], sessions: [] }; }),
  recordEvent: vi.fn(), recordEvents: vi.fn(),
}));
vi.mock('../storage/fileIO.js', async (orig) => ({
  ...(await orig<typeof import('../storage/fileIO.js')>()),
  listErrorEntries: vi.fn(async () => { h.reads.push('fileIO.errors'); return { items: [] }; }),
  listFeedbackEntries: vi.fn(async () => { h.reads.push('fileIO.feedback'); return { items: [] }; }),
}));

import { runWithUser, deriveStorageUserId } from '../security/userContext.js';
import { registerAdminRoutes } from '../routes/admin.js';
import { registerSessionRoutes } from '../routes/session.js';
import { registerDiagnosticsRoutes } from '../routes/diagnostics.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void> | void;

const BOB_ID = deriveStorageUserId('bob', 'github');
const ALICE_ID = deriveStorageUserId('alice', 'github');
const ANON = { principalName: '_local', idp: '', storageUserId: 'anon-0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11', stableId: undefined, isAnonymous: true, anonymousSessionId: '0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11' };
const MEMBER = { principalName: 'bob', idp: 'github', storageUserId: BOB_ID, stableId: 'github:2', isAnonymous: false };
const ADMIN = { principalName: 'alice', idp: 'github', storageUserId: ALICE_ID, stableId: 'github:1', isAnonymous: false };
const HEADERS: Record<string, Record<string, string>> = {
  anon: {},
  member: { 'x-ms-client-principal-name': 'bob', 'x-ms-client-principal-idp': 'github' },
  admin: { 'x-ms-client-principal-name': 'alice', 'x-ms-client-principal-idp': 'github' },
};
const LOCAL_ID = deriveStorageUserId('_local', '_local');

const saved = { admins: process.env.ADMIN_USERS, auth: process.env.AUTH_DISABLED, web: process.env.WEBSITE_AUTH_ENABLED };
beforeEach(() => {
  h.reads.length = 0;
  process.env.ADMIN_USERS = 'github:1';
  process.env.WEBSITE_AUTH_ENABLED = 'true';
  delete process.env.AUTH_DISABLED;
});
afterEach(() => {
  for (const [k, v] of [['ADMIN_USERS', saved.admins], ['AUTH_DISABLED', saved.auth], ['WEBSITE_AUTH_ENABLED', saved.web]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

function routes(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const reg = (m: string) => (p: string, fn: Handler) => { handlers[`${m} ${p}`] = fn; };
  const router = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), del: reg('DELETE') } as never;
  const ctx = {
    serverRecorder: { buildDump: () => ({ ndjson: '' }), record: vi.fn() },
    appendServerLogs: (s: string) => s, ensureSessionBranch: vi.fn(async () => undefined), broadcastEvent: vi.fn(),
  } as never;
  registerAdminRoutes(router, ctx);
  registerSessionRoutes(router, ctx);
  registerDiagnosticsRoutes(router, ctx);
  return handlers;
}

function fakeRes() {
  const r = { status: 200, body: '', headersSent: false, writableEnded: false };
  const res = {
    writeHead(code: number) { r.status = code; r.headersSent = true; return res; },
    setHeader() { return res; },
    end(b?: string) { r.body = b ?? ''; r.writableEnded = true; return res; },
    write() { return true; }, on() { return res; },
    get headersSent() { return r.headersSent; }, get writableEnded() { return r.writableEnded; },
  };
  return { res: res as unknown as ServerResponse, r };
}

async function get(user: object, who: keyof typeof HEADERS, route: string, url: string) {
  const { res, r } = fakeRes();
  await runWithUser(user as never, () => routes()[`GET ${route}`]({ url, headers: HEADERS[who] } as IncomingMessage, res, undefined));
  return r;
}

const ADMIN_ONLY: Array<[string, string]> = [
  ['/api/admin/health', '/api/admin/health'],
  ['/api/analytics/query', '/api/analytics/query?from=2026-11-01&to=2026-11-25'],
  ['/api/calibration/log', '/api/calibration/log'],
  ['/api/calibration/history', '/api/calibration/history'],
];

describe('t/592: admin-only handlers refuse anonymous and non-admin callers', () => {
  it.each(ADMIN_ONLY)('%s: anonymous and signed-in non-admin get 403 and nothing is read', async (route, url) => {
    for (const [user, who] of [[ANON, 'anon'], [MEMBER, 'member']] as const) {
      const r = await get(user, who, route, url);
      expect(r.status).toBe(403);
    }
    expect(h.reads).toEqual([]);
  });

  it.each(ADMIN_ONLY)('%s: an admin is not refused', async (route, url) => {
    const r = await get(ADMIN, 'admin', route, url);
    expect(r.status).not.toBe(403);
  });

  it('AUTH_DISABLED single-operator mode keeps the operator\'s access', async () => {
    process.env.AUTH_DISABLED = '1';
    const r = await get(ANON, 'anon', '/api/analytics/query', '/api/analytics/query');
    expect(r.status).toBe(200);
  });
});

describe('t/592: analytics/engagement is admin-only except a signed-in caller\'s own activity', () => {
  const eng = (q: string) => `/api/analytics/engagement?from=2026-11-01&to=2026-11-25${q}`;

  it('a signed-in non-admin reads their own activity (?user=<self>), without the users or sessions lists', async () => {
    const r = await get(MEMBER, 'member', '/api/analytics/engagement', eng(`&user=${encodeURIComponent(BOB_ID)}`));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).not.toHaveProperty('users');
    expect(h.reads).toEqual([`analytics.engagement:${BOB_ID}`]);
  });

  it.each([
    ['the site aggregate (no user)', ''],
    ['another user', `&user=${encodeURIComponent(ALICE_ID)}`],
    ['a session', '&session=abc'],
    ['a subject breakdown', '&subject=acc-beliefs-001'],
  ])('a signed-in non-admin asking for %s gets 403 and nothing is read', async (_label, q) => {
    const r = await get(MEMBER, 'member', '/api/analytics/engagement', eng(q));
    expect(r.status).toBe(403);
    expect(h.reads).toEqual([]);
  });

  it('an anonymous caller asking for the _local id (the owner\'s) gets 403: it is never "own" activity', async () => {
    const r = await get(ANON, 'anon', '/api/analytics/engagement', eng(`&user=${encodeURIComponent(LOCAL_ID)}`));
    expect(r.status).toBe(403);
    expect(h.reads).toEqual([]);
  });

  it('an admin reads the aggregate with the users list', async () => {
    const r = await get(ADMIN, 'admin', '/api/analytics/engagement', eng(''));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toHaveProperty('users');
  });
});
