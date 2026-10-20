// @vitest-environment node
//
// t/4335 — GET /api/node-source-index/:nodeId (per-node transport, replacing the whole-corpus
// GET /api/node-source-index for the Sources tab's actual use case). The storage-layer
// build/cache/invalidation itself is covered by nodeSourceIndex.test.ts (t/4334); this only
// drives the route: param extraction, the pass-through JSON shape, and error mapping.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const { getNodeSourcesMock, buildNodeSourceIndexMock, recordMock } = vi.hoisted(() => ({
  getNodeSourcesMock: vi.fn(),
  buildNodeSourceIndexMock: vi.fn(async () => ({})),
  recordMock: vi.fn(),
}));

vi.mock('../storage/fileIO.js', () => ({
  getNodeSources: getNodeSourcesMock,
  buildNodeSourceIndex: buildNodeSourceIndexMock,
  buildPolicySourceIndex: vi.fn(async () => ({})),
}));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: recordMock }) }));

import { createRouter } from '../httpKit.js';
import { registerEdgesRoutes } from '../routes/edges.js';
import type { ServerCtx } from '../routes/context.js';

async function invoke(method: string, path: string): Promise<{ status: number; body: unknown }> {
  const routes: { method: string; path: string; handler: Function }[] = [];
  const router = createRouter(routes);
  registerEdgesRoutes(router, {} as unknown as ServerCtx);
  const route = routes.find(r => r.method === method && r.path === path);
  if (!route) throw new Error(`route not found: ${method} ${path}`);

  const req = { url: path.replace(':nodeId', 'acc-desires-021'), method, headers: {} } as unknown as IncomingMessage;
  let status = 200;
  let body: unknown;
  const res = {
    writableEnded: false, headersSent: false, req,
    writeHead(s: number) { status = s; this.headersSent = true; },
    end(b?: string) { body = b ? JSON.parse(b) : undefined; this.writableEnded = true; },
  } as unknown as ServerResponse;

  await route.handler(req, res);
  return { status, body };
}

beforeEach(() => {
  getNodeSourcesMock.mockReset();
  buildNodeSourceIndexMock.mockClear();
  recordMock.mockReset();
});

describe('GET /api/node-source-index/:nodeId (t/4335)', () => {
  it('passes the :nodeId param through to fileIO.getNodeSources and returns its result', async () => {
    getNodeSourcesMock.mockResolvedValue({ sources: [{ docId: 'd1' }], cards: { d1: { title: 'T' } }, indexVersion: 3 });

    const { status, body } = await invoke('GET', '/api/node-source-index/:nodeId');

    expect(getNodeSourcesMock).toHaveBeenCalledWith('acc-desires-021');
    expect(status).toBe(200);
    expect(body).toEqual({ sources: [{ docId: 'd1' }], cards: { d1: { title: 'T' } }, indexVersion: 3 });
  });

  it('maps a storage failure to 500 and records it', async () => {
    getNodeSourcesMock.mockRejectedValue(new Error('index build failed'));

    const { status } = await invoke('GET', '/api/node-source-index/:nodeId');

    expect(status).toBe(500);
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }));
  });
});

describe('GET /api/node-source-index (deprecated whole-corpus route, t/4335)', () => {
  it('still serves the whole index, but now logs at warn level', async () => {
    buildNodeSourceIndexMock.mockResolvedValue({ 'some-node': [] });

    const { status, body } = await invoke('GET', '/api/node-source-index');

    expect(status).toBe(200);
    expect(body).toEqual({ 'some-node': [] });
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }));
  });
});
