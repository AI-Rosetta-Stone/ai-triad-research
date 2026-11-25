// @vitest-environment node
//
// t/4312/t/4315 — POST /api/sync/overlay-conflicts/{use-theirs,keep-mine}.
// Whole-batch per TL's correction (p/538#97) / Rosetta Stone's catch (p/641#10/#11):
// neither route takes a `paths` field, and both act on the caller's entire staged overlay.
// Backend methods (discardConflictedOverlayEntries, rebaseAndRecommitConflictedOverlayEntries)
// are Server Storage's (githubAPIBackend.ts) — mocked here; this file tests the HTTP layer only.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const { getCurrentUserIdMock, recordMock } = vi.hoisted(() => ({
  getCurrentUserIdMock: vi.fn<[], string>(() => 'tester'),
  recordMock: vi.fn(),
}));
vi.mock('../security/userContext.js', () => ({ getCurrentUserId: getCurrentUserIdMock }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: recordMock }) }));

import type { ServerCtx } from '../routes/context.js';
import { createRouter } from '../httpKit.js';
import { registerOverlayConflictsRoutes } from '../routes/overlayConflicts.js';

type InvokeOpts = { ctx?: Partial<ServerCtx> };

async function invoke(path: string, opts: InvokeOpts = {}): Promise<{ status: number; body: unknown }> {
  const routes: { method: string; path: string; handler: Function }[] = [];
  const router = createRouter(routes);
  const ctx = (opts.ctx ?? {}) as ServerCtx;
  registerOverlayConflictsRoutes(router, ctx);

  const route = routes.find(r => r.method === 'POST' && r.path === path);
  if (!route) throw new Error(`route not found: ${path}`);

  const req = { url: path, method: 'POST', headers: {} } as unknown as IncomingMessage;
  let status = 200;
  let body: unknown;
  const res = {
    writableEnded: false,
    headersSent: false,
    req,
    writeHead(s: number) { status = s; this.headersSent = true; },
    end(b?: string) { body = b ? JSON.parse(b) : undefined; this.writableEnded = true; },
  } as unknown as ServerResponse;

  await route.handler(req, res, {});
  return { status, body };
}

beforeEach(() => {
  getCurrentUserIdMock.mockReset().mockReturnValue('tester');
  recordMock.mockReset();
});

describe('POST /api/sync/overlay-conflicts/use-theirs (t/4315)', () => {
  it('discards the whole staged overlay and returns the discarded paths', async () => {
    const discardConflictedOverlayEntriesAsync = vi.fn().mockResolvedValue(['a.json', 'b.json']);
    const { status, body } = await invoke('/api/sync/overlay-conflicts/use-theirs', {
      ctx: { getGithubBackend: () => ({ discardConflictedOverlayEntriesAsync } as any) },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ discarded: ['a.json', 'b.json'] });
    expect(discardConflictedOverlayEntriesAsync).toHaveBeenCalledWith('tester');
  });

  it('returns an empty discarded array (not an error) when nothing was staged', async () => {
    const discardConflictedOverlayEntriesAsync = vi.fn().mockResolvedValue([]);
    const { status, body } = await invoke('/api/sync/overlay-conflicts/use-theirs', {
      ctx: { getGithubBackend: () => ({ discardConflictedOverlayEntriesAsync } as any) },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ discarded: [] });
  });

  it('no-ops with an empty result in filesystem mode (no backend)', async () => {
    const { status, body } = await invoke('/api/sync/overlay-conflicts/use-theirs', {
      ctx: { getGithubBackend: () => null },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ discarded: [] });
  });

  it('returns 500 and records a flight-recorder event when the backend throws', async () => {
    const discardConflictedOverlayEntriesAsync = vi.fn(async () => { throw new Error('boom'); });
    const { status } = await invoke('/api/sync/overlay-conflicts/use-theirs', {
      ctx: { getGithubBackend: () => ({ discardConflictedOverlayEntriesAsync } as any) },
    });
    expect(status).toBe(500);
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ level: 'error', message: 'overlay-conflicts/use-theirs failed' }));
  });

  // t/553 (ServerStorage p/52#48): with shared overlay state on, another replica can hold the commit lease.
  it('maps OVERLAY_COMMIT_BUSY to 409 overlay_commit_busy (retryable), not a 500, and records no error', async () => {
    const discardConflictedOverlayEntriesAsync = vi.fn(async () => { throw Object.assign(new Error('busy'), { code: 'OVERLAY_COMMIT_BUSY' }); });
    const { status, body } = await invoke('/api/sync/overlay-conflicts/use-theirs', {
      ctx: { getGithubBackend: () => ({ discardConflictedOverlayEntriesAsync } as any) },
    });
    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'overlay_commit_busy' });
    expect(recordMock).not.toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }));
  });
});

describe('POST /api/sync/overlay-conflicts/keep-mine (t/4315)', () => {
  function fakeBackend(overrides: Partial<{ rebaseAndRecommitConflictedOverlayEntries: any; getOverlayEntriesForBroadcast: any }> = {}) {
    return {
      getOverlayEntriesForBroadcast: vi.fn().mockResolvedValue({ writes: [{ path: 'a.json', content: '{}' }], deletes: [] }),
      rebaseAndRecommitConflictedOverlayEntries: vi.fn().mockResolvedValue({
        committed: true, commitSha: 'sha123', filesCommitted: 1, stillConflicted: [],
      }),
      ...overrides,
    };
  }

  it('rebases and commits, then broadcasts the update, on success', async () => {
    const backend = fakeBackend();
    const broadcastTaxonomyUpdate = vi.fn().mockResolvedValue(undefined);
    const { status, body } = await invoke('/api/sync/overlay-conflicts/keep-mine', {
      ctx: {
        getGithubBackend: () => backend as any,
        getSessionManager: () => ({ getActiveBranch: () => 'api-session/tester' } as any),
        broadcastTaxonomyUpdate,
      },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ committed: true, commitSha: 'sha123', filesCommitted: 1, stillConflicted: [] });
    expect(backend.rebaseAndRecommitConflictedOverlayEntries).toHaveBeenCalledWith('tester', 'api-session/tester');
    expect(broadcastTaxonomyUpdate).toHaveBeenCalledWith(backend, { writes: [{ path: 'a.json', content: '{}' }], deletes: [] }, 'tester');
  });

  // t/691: in shared mode a store failure yields null entries; the commit still answers, the broadcast gets null (skipped).
  it('passes null entries through to the broadcast when the store listing failed', async () => {
    const backend = fakeBackend({ getOverlayEntriesForBroadcast: vi.fn().mockResolvedValue(null) });
    const broadcastTaxonomyUpdate = vi.fn().mockResolvedValue(undefined);
    const { status } = await invoke('/api/sync/overlay-conflicts/keep-mine', {
      ctx: {
        getGithubBackend: () => backend as any,
        getSessionManager: () => ({ getActiveBranch: () => 'api-session/tester' } as any),
        broadcastTaxonomyUpdate,
      },
    });
    expect(status).toBe(200);
    expect(backend.getOverlayEntriesForBroadcast).toHaveBeenCalledWith('tester');
    expect(broadcastTaxonomyUpdate).toHaveBeenCalledWith(backend, null, 'tester');
  });

  it('does not broadcast when nothing committed (empty overlay)', async () => {
    const backend = fakeBackend({
      rebaseAndRecommitConflictedOverlayEntries: vi.fn().mockResolvedValue({ committed: false, stillConflicted: [] }),
    });
    const broadcastTaxonomyUpdate = vi.fn();
    const { status, body } = await invoke('/api/sync/overlay-conflicts/keep-mine', {
      ctx: {
        getGithubBackend: () => backend as any,
        getSessionManager: () => ({ getActiveBranch: () => 'api-session/tester' } as any),
        broadcastTaxonomyUpdate,
      },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ committed: false, stillConflicted: [] });
    expect(broadcastTaxonomyUpdate).not.toHaveBeenCalled();
  });

  it('surfaces stillConflicted without erroring when another conflict lands mid-resolution', async () => {
    const backend = fakeBackend({
      rebaseAndRecommitConflictedOverlayEntries: vi.fn().mockResolvedValue({ committed: false, stillConflicted: ['c.json'] }),
    });
    const { status, body } = await invoke('/api/sync/overlay-conflicts/keep-mine', {
      ctx: {
        getGithubBackend: () => backend as any,
        getSessionManager: () => ({ getActiveBranch: () => 'api-session/tester' } as any),
        broadcastTaxonomyUpdate: vi.fn(),
      },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ committed: false, stillConflicted: ['c.json'] });
  });

  it('no-ops with an empty result when there is no session branch (nothing staged)', async () => {
    const backend = fakeBackend();
    const { status, body } = await invoke('/api/sync/overlay-conflicts/keep-mine', {
      ctx: {
        getGithubBackend: () => backend as any,
        getSessionManager: () => ({ getActiveBranch: () => null } as any),
        broadcastTaxonomyUpdate: vi.fn(),
      },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ committed: false, stillConflicted: [] });
    expect(backend.rebaseAndRecommitConflictedOverlayEntries).not.toHaveBeenCalled();
  });

  it('no-ops with an empty result in filesystem mode (no backend/session manager)', async () => {
    const { status, body } = await invoke('/api/sync/overlay-conflicts/keep-mine', {
      ctx: { getGithubBackend: () => null, getSessionManager: () => null },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ committed: false, stillConflicted: [] });
  });

  it('returns 500 and records a flight-recorder event when the backend throws', async () => {
    const backend = fakeBackend({
      rebaseAndRecommitConflictedOverlayEntries: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const { status } = await invoke('/api/sync/overlay-conflicts/keep-mine', {
      ctx: {
        getGithubBackend: () => backend as any,
        getSessionManager: () => ({ getActiveBranch: () => 'api-session/tester' } as any),
        broadcastTaxonomyUpdate: vi.fn(),
      },
    });
    expect(status).toBe(500);
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ level: 'error', message: 'overlay-conflicts/keep-mine failed' }));
  });
});
