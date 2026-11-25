// @vitest-environment node
// t/548 (Security p/93#44, TL p/16#327): GET /api/sync/status for a hosted anonymous visitor returns the empty status
// before any session or GitHub call. The visitor is keyed as '_local', the owner's principal; before this, the route read
// the owner's branch and PR, and resolveSyncBranchState could run mergeBranch (a GitHub write) on an anonymous GET.
// The real route and the real userContext run under the request context server.ts builds; the backend and session
// manager are fakes that record every call, and '_local' is given a branch that is behind main so a leak would show.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

vi.mock('../storage/overlayCommitScheduler.js', () => ({ getOverlayCommitStatusShared: vi.fn(async () => ({ state: 'pending', at: 1 })) })); // t/553
vi.mock('../community/community.js', () => ({ isAdmin: () => false }));
vi.mock('../community/admin/reviewRegistry.js', () => ({ requireAdmin: vi.fn(() => true) }));
vi.mock('../community/nodeConflicts.js', () => ({ computeNodeConflicts: vi.fn() }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('../logger.js', () => {
  const l = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() });
  return { log: { server: l(), api: l() } };
});

import { runWithUser } from '../security/userContext.js';
import { registerSyncRoutes, ANON_SYNC_STATUS } from '../routes/sync.js';
import type { ServerCtx } from '../routes/context.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void> | void;

// server.ts's contexts: an anonymous visitor (principal '_local', anon storage key) and a signed-in user.
const ANON = { principalName: '_local', idp: '', storageUserId: 'anon-0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11', stableId: undefined, isAnonymous: true, anonymousSessionId: '0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11' };
const SIGNED = { principalName: 'alice', idp: 'github', storageUserId: 'alice', stableId: 'github:1', isAnonymous: false };

const calls: string[] = [];
const sessionManager = {
  getActiveBranch: vi.fn((u: string) => { calls.push(`getActiveBranch:${u}`); return `api-session/${u}`; }),
  getSessionState: vi.fn((u: string) => { calls.push(`getSessionState:${u}`); return { prNumber: 42, prUrl: `https://example.invalid/pr/${u}` }; }),
};
const backend = {
  // ahead 0, behind 5: the shape that makes resolveSyncBranchState fast-forward with mergeBranch.
  compareBranches: vi.fn(async (_a: string, b: string) => { calls.push(`compareBranches:${b}`); return { files: ['a.json'], ahead_by: 0, behind_by: 5, status: 'behind', merge_base_sha: 'old' }; }),
  mergeBranch: vi.fn(async (b: string) => { calls.push(`mergeBranch:${b}`); return { ok: true, sha: 'new', conflicts: false, message: 'Merged' }; }),
  getMainSha: () => 'main-sha', getCacheHitRate: () => 1, getLastPollAge: () => 0,
};

function handler(): Handler {
  const handlers: Record<string, Handler> = {};
  const reg = (m: string) => (p: string, h: Handler) => { handlers[`${m} ${p}`] = h; };
  registerSyncRoutes({ get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), del: reg('DELETE') } as never,
    { getGithubBackend: () => backend, getSessionManager: () => sessionManager } as unknown as ServerCtx);
  return handlers['GET /api/sync/status'];
}

function fakeRes() {
  const res: Record<string, unknown> = {
    writableEnded: false, headersSent: false, _statusCode: 200, _body: undefined as unknown,
    writeHead: vi.fn((code: number) => { res._statusCode = code; res.headersSent = true; }),
    end: vi.fn((b?: string) => { res._body = b !== undefined ? JSON.parse(b) : undefined; res.writableEnded = true; }),
    setHeader: vi.fn(),
  };
  return res as unknown as ServerResponse & { _body: Record<string, unknown>; _statusCode: number };
}
const req = { url: '/api/sync/status', headers: {} } as unknown as IncomingMessage;

const savedAuth = process.env.AUTH_DISABLED;
beforeEach(() => { calls.length = 0; vi.clearAllMocks(); delete process.env.AUTH_DISABLED; });
afterEach(() => { if (savedAuth === undefined) delete process.env.AUTH_DISABLED; else process.env.AUTH_DISABLED = savedAuth; });

describe('t/548: GET /api/sync/status for an anonymous visitor', () => {
  it('returns the empty status with 200 and makes no session read and no GitHub call (no compareBranches, no mergeBranch)', async () => {
    const res = fakeRes();
    await runWithUser(ANON, () => handler()(req, res));
    expect(res._statusCode).toBe(200);
    expect(res._body).toEqual({ ...ANON_SYNC_STATUS });
    expect(res._body).toMatchObject({ session_branch: null, pr_number: null, pr_url: null, overlay_commit: null });
    expect(calls).toEqual([]);
    expect(backend.compareBranches).not.toHaveBeenCalled();
    expect(backend.mergeBranch).not.toHaveBeenCalled();
  });

  it('a signed-in user is unchanged: their own branch, PR and overlay status, and the fast-forward still runs', async () => {
    const res = fakeRes();
    await runWithUser(SIGNED, () => handler()(req, res));
    expect(res._statusCode).toBe(200);
    expect(res._body).toMatchObject({ session_branch: 'api-session/alice', pr_number: 42, pr_url: 'https://example.invalid/pr/alice', overlay_commit: { state: 'pending', at: 1 } });
    expect(calls).toContain('getActiveBranch:alice');
    expect(calls).toContain('compareBranches:api-session/alice');
    expect(calls).toContain('mergeBranch:api-session/alice');
  });

  it('AUTH_DISABLED single-operator mode (outside production) keeps the operator\'s own status, as with the key gate', async () => {
    process.env.AUTH_DISABLED = '1';
    const res = fakeRes();
    await runWithUser(ANON, () => handler()(req, res));
    expect(res._body).toMatchObject({ session_branch: 'api-session/_local' });
    expect(calls).toContain('getActiveBranch:_local');
  });
});
