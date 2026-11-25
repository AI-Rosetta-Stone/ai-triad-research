// @vitest-environment node
// t/522 (Comp-Linguist, t/492#18): with a sources directory on disk, GET /api/doc-titles leaves out a document whose
// metadata title is only an identifier (an arXiv id, or the document's own id), and keeps a document with a real title.
// The handler is the real one, found through the real router, reading a real temporary sources directory. Only the
// .aitriad.json lookup is redirected to that directory.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import realFs from 'fs';
import type http from 'http';

const h = vi.hoisted(() => ({ sourcesRoot: '' }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const isConfig = (p: unknown) => typeof p === 'string' && path.basename(p) === '.aitriad.json';
  const existsSync = (p: realFs.PathLike) => (isConfig(p) ? true : actual.existsSync(p));
  const readFileSync = ((p: realFs.PathOrFileDescriptor, ...rest: unknown[]) =>
    isConfig(p) ? JSON.stringify({ sources_root: h.sourcesRoot }) : (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)) as typeof actual.readFileSync;
  return { ...actual, default: { ...actual, existsSync, readFileSync }, existsSync, readFileSync };
});
vi.mock('../storage/sourcesIndexReader.js', () => ({ loadSourcesIndex: async () => null }));
vi.mock('../logger.js', () => ({
  log: { server: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { createRouter } from '../httpKit.js';

function writeDoc(id: string, meta: Record<string, unknown>): void {
  realFs.mkdirSync(path.join(h.sourcesRoot, id), { recursive: true });
  realFs.writeFileSync(path.join(h.sourcesRoot, id, 'metadata.json'), JSON.stringify(meta));
}

beforeAll(() => {
  h.sourcesRoot = realFs.mkdtempSync(path.join(os.tmpdir(), 't522-sources-'));
  writeDoc('doc-real', { title: '  A Real Title  ', url: 'https://example.org/real' });
  writeDoc('doc-arxiv', { title: '1703.06856v3', url: 'https://arxiv.org/abs/1703.06856v3' });
  writeDoc('doc-arxiv-prefixed', { title: 'arXiv:2503.22732' });
  writeDoc('doc-own-id', { title: 'doc-own-id' });
});
afterAll(() => { realFs.rmSync(h.sourcesRoot, { recursive: true, force: true }); });

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

describe('t/522: the filesystem title reader drops identifier-only titles', () => {
  it('a bare arXiv number, an arXiv: id and a title equal to the doc id are absent; a real title is present', async () => {
    vi.resetModules();
    const { registerSourcesRoutes } = await import('../routes/sources.js');
    const routes: Array<{ method: string; path: string; handler: (req: unknown, res: unknown, body: unknown) => unknown }> = [];
    registerSourcesRoutes(createRouter(routes as never) as never, {} as never);
    const handler = routes.find(r => r.method === 'GET' && r.path === '/api/doc-titles')!.handler;
    const res = fakeRes();
    await handler({ method: 'GET', url: '/api/doc-titles', headers: {} }, res, undefined);
    const titles = JSON.parse((res as unknown as { body: string }).body) as Record<string, { title: string; resolved_url?: string }>;

    expect(titles['doc-real']).toEqual({ title: 'A Real Title', resolved_url: 'https://example.org/real' });
    expect(titles).not.toHaveProperty('doc-arxiv');
    expect(titles).not.toHaveProperty('doc-arxiv-prefixed');
    expect(titles).not.toHaveProperty('doc-own-id');
  });
});
