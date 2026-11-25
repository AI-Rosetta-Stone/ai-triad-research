// @vitest-environment node
// t/492 (browser path): GET /api/doc-titles falls back to the sources index when the filesystem has no sources
// directory or no titles. The handler is the real one, found through the real router. The index comes from the
// storage reader (mocked here). Each case resets the route module so its caches start empty.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type http from 'http';

const h = vi.hoisted(() => ({
  index: null as unknown,
  loadSourcesIndexCalls: 0,
  warn: vi.fn(),
}));

// No sources directory on disk: .aitriad.json is never found, so the filesystem read gives nothing.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const existsSync = () => false;
  return { ...actual, default: { ...actual, existsSync }, existsSync };
});
vi.mock('../storage/sourcesIndexReader.js', () => ({
  loadSourcesIndex: async () => { h.loadSourcesIndexCalls += 1; return h.index; },
}));
vi.mock('../logger.js', () => ({
  log: { server: { info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() }, api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { createRouter } from '../httpKit.js';

async function docTitlesHandler(): Promise<(req: unknown, res: unknown) => unknown> {
  vi.resetModules();
  const { registerSourcesRoutes } = await import('../routes/sources.js');
  const routes: Array<{ method: string; path: string; handler: (req: unknown, res: unknown, body: unknown) => unknown }> = [];
  registerSourcesRoutes(createRouter(routes as never) as never, {} as never);
  return routes.find(r => r.method === 'GET' && r.path === '/api/doc-titles')!.handler as never;
}

function fakeRes() {
  const r = { statusCode: 200, body: '' as string, writableEnded: false, headersSent: false };
  return Object.assign(r, {
    writeHead(code: number) { r.statusCode = code; r.headersSent = true; return r; },
    setHeader() { return r; },
    end(b?: string) { r.body = b ?? ''; r.writableEnded = true; return r; },
    write() { return true; },
    on() { return r; },
  }) as unknown as http.ServerResponse & { statusCode: number; body: string };
}

async function get(): Promise<unknown> {
  const handler = await docTitlesHandler();
  const res = fakeRes();
  await handler({ method: 'GET', url: '/api/doc-titles', headers: {} }, res);
  return JSON.parse((res as unknown as { body: string }).body);
}

const INDEX = {
  schema_version: 1,
  docs: [
    { id: 'doc-a', title: 'The Title of A', resolved_url: 'https://example.org/a', provenance: [{ id: 'prov-a' }] },
    { id: 'doc-b', title: '1703.06856v3' }, // an identifier-only title counts as no title (t/492, Comp-Linguist)
  ],
};

beforeEach(() => {
  h.index = null;
  h.loadSourcesIndexCalls = 0;
  h.warn.mockClear();
});

describe('t/492: /api/doc-titles falls back to the sources index', () => {
  it('no sources directory and an index with titles: the route returns the index titles, and logs the fallback', async () => {
    h.index = INDEX;
    const body = await get();
    expect(body).toEqual({
      'doc-a': { title: 'The Title of A', resolved_url: 'https://example.org/a', provenance_label: 'prov-a' },
    });
    expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ component: 'sources-routes' }), expect.stringContaining('fell back to sources-index.json'));
  });

  it('no sources directory and a null index: the route returns null', async () => {
    h.index = null;
    const body = await get();
    expect(body).toBeNull();
  });

  it('an index with no usable titles gives null, not an empty map', async () => {
    h.index = { schema_version: 1, docs: [{ id: 'doc-b', title: '1703.06856v3' }] };
    expect(await get()).toBeNull();
  });

  it('the index read is cached for the TTL, so a burst of requests reads the index once', async () => {
    h.index = INDEX;
    const handler = await docTitlesHandler();
    for (let i = 0; i < 3; i += 1) {
      const res = fakeRes();
      await handler({ method: 'GET', url: '/api/doc-titles', headers: {} }, res);
    }
    expect(h.loadSourcesIndexCalls).toBe(1);
  });
});
