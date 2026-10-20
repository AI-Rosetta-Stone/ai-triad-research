// @vitest-environment node
//
// t/4312 (SO condition F5, e/333#4) — POST /api/sync/commit must not report ok:true when
// commitOverlay() returns a conflict (filesCommitted: 0, conflictedPaths populated). A false
// success there would show the user a successful save while the edit stays staged — a restart
// then loses it unrecoverably. Applies regardless of OVERLAY_CONFLICT_STATE_ENABLED.
// ServerAPI sign-off test for the fix in routes/sync.ts (p/541#111).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const { getCurrentUserIdMock, recordMock } = vi.hoisted(() => ({
  getCurrentUserIdMock: vi.fn<[], string>(() => 'tester'),
  recordMock: vi.fn(),
}));
vi.mock('../security/userContext.js', () => ({ getCurrentUserId: getCurrentUserIdMock, isAnonymousUser: () => false }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: recordMock }) }));

import type { ServerCtx } from '../routes/context.js';
import { createRouter } from '../httpKit.js';
import { registerSyncRoutes } from '../routes/sync.js';

async function invoke(ctxOverrides: Partial<ServerCtx>): Promise<{ status: number; body: unknown }> {
  const routes: { method: string; path: string; handler: Function }[] = [];
  const router = createRouter(routes);
  const ctx = ctxOverrides as ServerCtx;
  registerSyncRoutes(router, ctx);

  const route = routes.find(r => r.method === 'POST' && r.path === '/api/sync/commit');
  if (!route) throw new Error('route not found');

  const req = { url: '/api/sync/commit', method: 'POST', headers: {} } as unknown as IncomingMessage;
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

describe('POST /api/sync/commit — conflict handling (SO F5, t/4312)', () => {
  it('returns 409 OVERLAY_CONFLICT, not ok:true, when commitOverlay reports conflicted paths', async () => {
    const getOverlayEntries = vi.fn().mockReturnValue({ writes: [], deletes: [] });
    const commitOverlay = vi.fn().mockResolvedValue({ commitSha: '', filesCommitted: 0, conflictedPaths: ['a.json'] });
    const broadcastTaxonomyUpdate = vi.fn();
    const { status, body } = await invoke({
      getGithubBackend: () => ({ getOverlayEntries, commitOverlay } as any),
      broadcastTaxonomyUpdate,
    });
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'OVERLAY_CONFLICT', conflictedPaths: ['a.json'] });
    expect(broadcastTaxonomyUpdate).not.toHaveBeenCalled(); // nothing committed — no update to broadcast
  });

  it('still reports ok:true on a clean commit (no conflictedPaths)', async () => {
    const getOverlayEntries = vi.fn().mockReturnValue({ writes: [{ path: 'a.json', content: '{}' }], deletes: [] });
    const commitOverlay = vi.fn().mockResolvedValue({ commitSha: 'sha123', filesCommitted: 1 });
    const broadcastTaxonomyUpdate = vi.fn().mockResolvedValue(undefined);
    const { status, body } = await invoke({
      getGithubBackend: () => ({ getOverlayEntries, commitOverlay } as any),
      broadcastTaxonomyUpdate,
    });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, commitSha: 'sha123', filesCommitted: 1 });
    expect(broadcastTaxonomyUpdate).toHaveBeenCalled();
  });
});
