// @vitest-environment node
//
// t/376 — the admin error detail keeps its stored stack (GET /api/admin/errors/:id is the one opt-in route);
// every other response strips it. Only the admin gate and the report lookup are mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const h = vi.hoisted(() => ({
  report: null as null | Record<string, unknown>,
}));

vi.mock('../community/admin/reviewRegistry.js', async (orig) => ({
  ...(await orig<typeof import('../community/admin/reviewRegistry.js')>()),
  requireAdmin: () => true,
}));
vi.mock('../storage/fileIO.js', async (orig) => ({
  ...(await orig<typeof import('../storage/fileIO.js')>()),
  getErrorReport: async () => h.report,
}));

import { createRouter, type Handler } from '../httpKit.js';
import { registerAdminRoutes } from '../routes/admin.js';

const routes: Array<{ method: string; path: string; handler: Handler }> = [];
registerAdminRoutes(createRouter(routes), {
  serverRecorder: { record: () => {} }, ensureSessionBranch: async () => {}, appendServerLogs: () => {},
} as never);
const detail = routes.find(r => r.method === 'GET' && r.path === '/api/admin/errors/:id')!.handler;

const FRAMES = 'Error: boom\n    at handler (/srv/app/routes/x.ts:10:5)\n    at run (/srv/app/y.ts:3:1)';

async function get(handler: Handler, url: string): Promise<{ status: number; text: string }> {
  const out: { status?: number; text?: string } = {};
  const res = {
    writeHead: (s: number) => { out.status = s; }, end: (t?: string) => { out.text = t; },
    setHeader: () => {}, writableEnded: false, headersSent: false,
  } as unknown as ServerResponse;
  const req = { url, headers: {}, method: 'GET' } as unknown as IncomingMessage;
  await handler(req, res, null);
  return { status: out.status ?? 200, text: out.text ?? '' };
}

beforeEach(() => {
  h.report = {
    id: 'err-1', timestamp: '2026-11-14T00:00:00.000Z',
    error: { name: 'Error', message: 'boom', stack: FRAMES }, stack: FRAMES,
  };
});

describe('admin error detail keeps its stack (t/376)', () => {
  it('GET /api/admin/errors/:id returns the stored stack', async () => {
    const r = await get(detail, '/api/admin/errors/err-1');
    expect(r.status).toBe(200);
    const body = JSON.parse(r.text) as { entry: { stack: string; error: { stack: string } } };
    expect(body.entry.stack).toBe(FRAMES);
    expect(body.entry.error.stack).toBe(FRAMES);
  });

  it('a normal error response on the same routes carries no stack key at any depth', async () => {
    h.report = null; // not found: the route answers through error()
    const r = await get(detail, '/api/admin/errors/missing');
    expect(r.status).toBe(404);
    expect(r.text).not.toContain('"stack"');
    expect(r.text).not.toMatch(/\.ts:\d+:\d+/);
  });
});
