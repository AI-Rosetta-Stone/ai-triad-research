// @vitest-environment node

/**
 * t/4162 Part 2 (T2/SO; TL p/522#398) — route-level gating for `POST /api/models/refresh`:
 * Zod validation (malformed body → 400), and `accept` (the actual write path) now requires
 * admin via the real `requireAdmin` (not mocked — same pattern as dataPullAdminGate.test.ts:
 * real `isAdmin()` reading `ADMIN_USERS` + ALS via `runWithUser`). `principal` is always
 * host-set inside `ai.refreshAIModels` (t/4162#1/#3 C3, covered in refreshAIModels.test.ts) —
 * not re-tested here. A Zod-valid plain/dryRun body passes through unchanged (dryRun-coercion
 * is ai.refreshAIModels's own concern, refreshAIModels.test.ts).
 *
 * Six SO-designed arms (t/4162#1): (1) admin accept → passes through to refreshAIModels here;
 * (2) non-admin accept → 403, nothing reaches refreshAIModels, here; (3) anonymous → 403, already
 * covered globally by accessControl's isAnonBlockedRoute (accessControl.test.ts), not this
 * route's own gate; (4) malformed → 400, here; (5) non-admin non-dryRun without accept →
 * coerced, covered in refreshAIModels.test.ts (the route passes the body through unchanged,
 * covered by the "plain refresh" test here); (6) a hand-edited/stale proposal → refused
 * `proposal-changed`, the lib already does this (modelDiscovery.ts) — the route-level test here
 * confirms the route surfaces that result unchanged, not re-testing the lib's own refusal logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const refreshAIModelsMock = vi.hoisted(() => vi.fn(async () => ({ written: false, dryRun: true, totalModels: 0 })));
vi.mock('../ai/aiBackends.js', () => ({ refreshAIModels: refreshAIModelsMock }));

import { runWithUser, type UserContext } from '../security/userContext.js';
import type { ServerCtx } from '../routes/context.js';
import { createRouter, type Handler } from '../httpKit.js';
import { registerDataRoutes } from '../routes/data.js';

interface InvokeResult { status: number; body: unknown }

function asUser<T>(storageUserId: string, fn: () => T): T {
  const c: UserContext = { principalName: storageUserId, idp: 'github', storageUserId, isAnonymous: false };
  return runWithUser(c, fn);
}

async function postRefresh(body: unknown, userId?: string): Promise<InvokeResult> {
  const routes: { method: string; path: string; handler: Handler }[] = [];
  registerDataRoutes(createRouter(routes), { serverRecorder: { record: vi.fn() } } as unknown as ServerCtx);
  const route = routes.find(r => r.path === '/api/models/refresh' && r.method === 'POST');
  if (!route) throw new Error('POST /api/models/refresh route not registered');

  const req = { url: '/api/models/refresh', method: 'POST', headers: {}, socket: {} } as unknown as IncomingMessage;
  const result: InvokeResult = { status: 200, body: undefined };
  const res = {
    writableEnded: false, headersSent: false,
    setHeader() {}, getHeader() { return undefined; },
    writeHead(s: number) { result.status = s; this.headersSent = true; return this; },
    end(b?: string) { result.body = b ? JSON.parse(b) : undefined; this.writableEnded = true; },
  } as unknown as ServerResponse;

  const run = () => route.handler(req, res, body);
  await (userId ? asUser(userId, run) : run());
  return result;
}

const PROPOSAL = { catalogFingerprint: 'fp1', hash: 'h1', changes: [] };
const ACCEPT_BODY = { accept: { proposal: PROPOSAL, approvedBy: 'Alice', reason: 'r' } };

const ADMIN_ID = 'admin-user';
let prevAdminUsers: string | undefined;

beforeEach(() => {
  refreshAIModelsMock.mockClear();
  prevAdminUsers = process.env.ADMIN_USERS;
  process.env.ADMIN_USERS = ADMIN_ID;
});
afterEach(() => { if (prevAdminUsers === undefined) delete process.env.ADMIN_USERS; else process.env.ADMIN_USERS = prevAdminUsers; });

describe('POST /api/models/refresh — Part 2: admin-gated accept (t/4162, t/4234)', () => {
  it('a malformed body (unknown key) gets 400 and never reaches refreshAIModels', async () => {
    const res = await postRefresh({ bogusField: true }, ADMIN_ID);
    expect(res.status).toBe(400);
    expect(refreshAIModelsMock).not.toHaveBeenCalled();
  });

  it('(arm 1) admin + accept → passes through to refreshAIModels, no 403', async () => {
    refreshAIModelsMock.mockResolvedValueOnce({ written: true, dryRun: false, totalModels: 3 });
    const res = await postRefresh(ACCEPT_BODY, ADMIN_ID);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ written: true, dryRun: false, totalModels: 3 });
    expect(refreshAIModelsMock).toHaveBeenCalledWith(ACCEPT_BODY);
  });

  it('(arm 2) non-admin + accept → 403, nothing written', async () => {
    const res = await postRefresh(ACCEPT_BODY, 'someone-else');
    expect(res.status).toBe(403);
    expect(refreshAIModelsMock).not.toHaveBeenCalled();
  });

  it('(arm 2) no-context (_local) + accept is also rejected', async () => {
    const res = await postRefresh(ACCEPT_BODY);
    expect(res.status).toBe(403);
    expect(refreshAIModelsMock).not.toHaveBeenCalled();
  });

  it('(arm 6) a stale/hand-edited proposal is surfaced as proposal-changed, unchanged, not an error', async () => {
    const refusal = { reason: 'proposal-changed', accepted: PROPOSAL, recomputed: { ...PROPOSAL, hash: 'h2' } };
    refreshAIModelsMock.mockResolvedValueOnce(refusal);
    const res = await postRefresh(ACCEPT_BODY, ADMIN_ID);
    expect(res.status).toBe(200); // not an HTTP error — a structured refusal in the 200 body
    expect(res.body).toEqual(refusal);
  });

  it('(arm 5) a plain refresh (no accept) passes the parsed body through to refreshAIModels for any signed-in caller', async () => {
    const res = await postRefresh({ dryRun: false }, 'someone-else');
    expect(res.status).toBe(200);
    expect(refreshAIModelsMock).toHaveBeenCalledWith({ dryRun: false });
  });

  it('a missing body (undefined) is treated as a plain refresh, not a parse failure', async () => {
    const res = await postRefresh(undefined, ADMIN_ID);
    expect(res.status).toBe(200);
    expect(refreshAIModelsMock).toHaveBeenCalledWith({});
  });
});
