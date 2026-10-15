// @vitest-environment node

/**
 * t/4162 Part 1 (T1; TL p/522#398) — route-level gating for `POST /api/models/refresh`:
 * Zod validation (malformed body → 400) and `accept` refused outright (403) until Part 2
 * (admin-gated accept, T2/SO). A Zod-valid plain/dryRun body passes through to
 * `ai.refreshAIModels` unchanged, which does the dryRun-coercion itself (refreshAIModels.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const refreshAIModelsMock = vi.hoisted(() => vi.fn(async () => ({ written: false, dryRun: true, totalModels: 0 })));
vi.mock('../ai/aiBackends.js', () => ({ refreshAIModels: refreshAIModelsMock }));

import type { ServerCtx } from '../routes/context.js';
import { createRouter, type Handler } from '../httpKit.js';
import { registerDataRoutes } from '../routes/data.js';

interface InvokeResult { status: number; body: unknown }

async function postRefresh(body: unknown): Promise<InvokeResult> {
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

  await route.handler(req, res, body);
  return result;
}

const PROPOSAL = { catalogFingerprint: 'fp1', hash: 'h1', changes: [] };

beforeEach(() => { refreshAIModelsMock.mockClear(); });

describe('POST /api/models/refresh — Part 1: Zod + accept refused (t/4162)', () => {
  it('a malformed body (unknown key) gets 400 and never reaches refreshAIModels', async () => {
    const res = await postRefresh({ bogusField: true });
    expect(res.status).toBe(400);
    expect(refreshAIModelsMock).not.toHaveBeenCalled();
  });

  it('accept is refused 403 (Part 2 not landed), regardless of who sends it', async () => {
    const res = await postRefresh({ accept: { proposal: PROPOSAL, approvedBy: 'Alice', reason: 'r' } });
    expect(res.status).toBe(403);
    expect(refreshAIModelsMock).not.toHaveBeenCalled();
  });

  it('a plain refresh (no accept) passes the parsed body through to refreshAIModels', async () => {
    const res = await postRefresh({ dryRun: false });
    expect(res.status).toBe(200);
    expect(refreshAIModelsMock).toHaveBeenCalledWith({ dryRun: false });
  });

  it('a missing body (undefined) is treated as a plain refresh, not a parse failure', async () => {
    const res = await postRefresh(undefined);
    expect(res.status).toBe(200);
    expect(refreshAIModelsMock).toHaveBeenCalledWith({});
  });
});
