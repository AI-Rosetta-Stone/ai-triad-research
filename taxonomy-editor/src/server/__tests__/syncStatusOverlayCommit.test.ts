// @vitest-environment node
//
// t/4258/t/4276 — GET /api/sync/status surfaces the current user's pending/committed/failed
// overlay-commit state (scheduleOverlayCommit, t/4277 C3) so the UI can show "not yet saved
// to GitHub" for a write made outside taxonomyDataSlice.save() instead of implying it's durable.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const { getOverlayCommitStatusMock, isAdminMock } = vi.hoisted(() => ({
  getOverlayCommitStatusMock: vi.fn(),
  isAdminMock: vi.fn<[], boolean>(),
}));

vi.mock('../storage/overlayCommitScheduler.js', () => ({ getOverlayCommitStatus: getOverlayCommitStatusMock }));
vi.mock('../security/userContext.js', () => ({ getCurrentUserId: () => 'tester', isAnonymousUser: () => false }));
vi.mock('../community/community.js', () => ({ isAdmin: isAdminMock }));
vi.mock('../community/admin/reviewRegistry.js', () => ({ requireAdmin: vi.fn(() => true) }));
vi.mock('../community/nodeConflicts.js', () => ({ computeNodeConflicts: vi.fn() }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { registerSyncRoutes } from '../routes/sync.js';
import type { ServerCtx } from '../routes/context.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void> | void;

function makeRouter() {
  const handlers: Record<string, Handler> = {};
  const reg = (m: string) => (p: string, h: Handler) => { handlers[`${m} ${p}`] = h; };
  return { router: { get: reg('GET'), post: reg('POST') }, handlers };
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

const fakeReq = (): IncomingMessage => ({ url: '/api/sync/status', headers: {} } as unknown as IncomingMessage);

function registerAndGetHandler(githubBackend: unknown, sessionManager: unknown): Handler {
  const r = makeRouter();
  const ctx = {
    getGithubBackend: () => githubBackend,
    getSessionManager: () => sessionManager,
  } as unknown as ServerCtx;
  registerSyncRoutes(r.router as never, ctx);
  return r.handlers['GET /api/sync/status'];
}

const FAKE_BACKEND = {
  compareBranches: vi.fn(async () => ({ files: [], behind_by: 0, status: 'synced' })),
  getMainSha: () => 'abc123',
  getCacheHitRate: () => 1,
  getLastPollAge: () => 0,
};
const FAKE_SESSION_MANAGER = {
  getActiveBranch: () => null,
  getSessionState: () => undefined,
};

describe('GET /api/sync/status — overlay_commit field (t/4276)', () => {
  beforeEach(() => {
    getOverlayCommitStatusMock.mockReset();
    isAdminMock.mockReset();
    isAdminMock.mockReturnValue(true); // full response (includes main_sha/cache, orthogonal to overlay_commit)
  });

  it('is null when the current user has no scheduled/past overlay commit', async () => {
    getOverlayCommitStatusMock.mockReturnValue(undefined);
    const get = registerAndGetHandler(FAKE_BACKEND, FAKE_SESSION_MANAGER);
    const res = fakeRes();
    await get(fakeReq(), res);
    expect(res._body.overlay_commit).toBeNull();
    expect(getOverlayCommitStatusMock).toHaveBeenCalledWith('tester');
  });

  it('surfaces a pending overlay commit', async () => {
    getOverlayCommitStatusMock.mockReturnValue({ state: 'pending', at: 1000 });
    const get = registerAndGetHandler(FAKE_BACKEND, FAKE_SESSION_MANAGER);
    const res = fakeRes();
    await get(fakeReq(), res);
    expect(res._body.overlay_commit).toEqual({ state: 'pending', at: 1000 });
  });

  it('surfaces a failed overlay commit with its error', async () => {
    getOverlayCommitStatusMock.mockReturnValue({ state: 'failed', at: 2000, error: 'network error' });
    const get = registerAndGetHandler(FAKE_BACKEND, FAKE_SESSION_MANAGER);
    const res = fakeRes();
    await get(fakeReq(), res);
    expect(res._body.overlay_commit).toEqual({ state: 'failed', at: 2000, error: 'network error' });
  });

  it('is null when sync is disabled (no github backend)', async () => {
    const get = registerAndGetHandler(null, null);
    const res = fakeRes();
    await get(fakeReq(), res);
    expect(res._body.enabled).toBe(false);
    expect(res._body.overlay_commit).toBeNull();
  });
});
