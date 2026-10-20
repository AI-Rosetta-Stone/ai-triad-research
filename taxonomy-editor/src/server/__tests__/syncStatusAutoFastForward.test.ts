// @vitest-environment node
//
// t/4324 — a session branch with no unique commits of its own (ahead_by === 0) that's
// fallen behind main carries stale data forever; nothing else ever moves it. GET
// /api/sync/status now auto-fast-forwards that case via the existing mergeBranch()
// primitive and logs a WARN with the old/new SHAs.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const { isAdminMock, warnMock } = vi.hoisted(() => ({
  isAdminMock: vi.fn<[], boolean>(),
  warnMock: vi.fn(),
}));

vi.mock('../storage/overlayCommitScheduler.js', () => ({ getOverlayCommitStatus: vi.fn(() => undefined) }));
vi.mock('../security/userContext.js', () => ({ getCurrentUserId: () => 'tester', isAnonymousUser: () => false }));
vi.mock('../community/community.js', () => ({ isAdmin: isAdminMock }));
vi.mock('../community/admin/reviewRegistry.js', () => ({ requireAdmin: vi.fn(() => true) }));
vi.mock('../community/nodeConflicts.js', () => ({ computeNodeConflicts: vi.fn() }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('../logger.js', () => ({ log: { server: { warn: warnMock, error: vi.fn(), info: vi.fn(), debug: vi.fn() } } }));

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

const FAKE_SESSION_MANAGER = {
  getActiveBranch: () => 'api-session/stale-user',
  getSessionState: () => undefined,
};

describe('GET /api/sync/status — auto fast-forward of a clean, stale session branch (t/4324)', () => {
  beforeEach(() => {
    isAdminMock.mockReset();
    isAdminMock.mockReturnValue(true);
    warnMock.mockReset();
  });

  it('fast-forwards (ahead_by=0, behind_by>0) and reports behind_by=0 afterwards', async () => {
    const mergeBranch = vi.fn(async () => ({ ok: true, sha: 'new-sha', conflicts: false, message: 'Merged' }));
    const backend = {
      compareBranches: vi.fn(async () => ({
        files: ['a.json'], ahead_by: 0, behind_by: 323, status: 'behind', merge_base_sha: 'old-sha',
      })),
      mergeBranch,
      getMainSha: () => 'new-sha',
      getCacheHitRate: () => 1,
      getLastPollAge: () => 0,
    };
    const get = registerAndGetHandler(backend, FAKE_SESSION_MANAGER);
    const res = fakeRes();
    await get(fakeReq(), res);

    expect(mergeBranch).toHaveBeenCalledWith('api-session/stale-user');
    expect(res._body.behind_by).toBe(0);
    expect(res._body.has_conflicts).toBe(false);
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'api-session/stale-user', oldSha: 'old-sha', newSha: 'new-sha', behindBy: 323 }),
      expect.stringContaining('Auto-fast-forwarded'),
    );
  });

  it('does not fast-forward when the branch has its own unique commits (ahead_by > 0)', async () => {
    const mergeBranch = vi.fn();
    const backend = {
      compareBranches: vi.fn(async () => ({
        files: ['a.json'], ahead_by: 2, behind_by: 5, status: 'diverged', merge_base_sha: 'base-sha',
      })),
      mergeBranch,
      getMainSha: () => 'main-sha',
      getCacheHitRate: () => 1,
      getLastPollAge: () => 0,
    };
    const get = registerAndGetHandler(backend, FAKE_SESSION_MANAGER);
    const res = fakeRes();
    await get(fakeReq(), res);

    expect(mergeBranch).not.toHaveBeenCalled();
    expect(res._body.behind_by).toBe(5);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('does not fast-forward when not behind (behind_by=0)', async () => {
    const mergeBranch = vi.fn();
    const backend = {
      compareBranches: vi.fn(async () => ({
        files: [], ahead_by: 0, behind_by: 0, status: 'identical', merge_base_sha: 'same-sha',
      })),
      mergeBranch,
      getMainSha: () => 'main-sha',
      getCacheHitRate: () => 1,
      getLastPollAge: () => 0,
    };
    const get = registerAndGetHandler(backend, FAKE_SESSION_MANAGER);
    const res = fakeRes();
    await get(fakeReq(), res);

    expect(mergeBranch).not.toHaveBeenCalled();
    expect(res._body.behind_by).toBe(0);
  });

  it('degrades gracefully (keeps reporting stale behind_by) when the fast-forward attempt throws', async () => {
    const mergeBranch = vi.fn(async () => { throw new Error('GitHub API returned 500'); });
    const backend = {
      compareBranches: vi.fn(async () => ({
        files: ['a.json'], ahead_by: 0, behind_by: 10, status: 'behind', merge_base_sha: 'old-sha',
      })),
      mergeBranch,
      getMainSha: () => 'main-sha',
      getCacheHitRate: () => 1,
      getLastPollAge: () => 0,
    };
    const get = registerAndGetHandler(backend, FAKE_SESSION_MANAGER);
    const res = fakeRes();
    await get(fakeReq(), res);

    expect(res._statusCode).toBe(200);
    expect(res._body.behind_by).toBe(10);
  });
});
