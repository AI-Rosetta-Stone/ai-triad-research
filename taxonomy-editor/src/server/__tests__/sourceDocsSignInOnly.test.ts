// @vitest-environment node
// t/677 (TL p/16#435, PI t/574#13; Rosetta Stone p/74#30): source documents are sign-in only, through the real routes.
//   - GET /api/snapshots/:sourceId and GET /api/source-documents/:docId/file: a hosted anonymous caller gets 403
//     anon_route_blocked (the gate's shape); a signed-in caller gets 200.
//   - GET /api/source-documents/:docId: a hosted anonymous caller gets ONLY { available, type, signInRequired: true },
//     for every type and on the error path too; a signed-in caller gets the full resolution unchanged.
//   - Local AUTH_DISABLED mode (not hosted) is unaffected.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const h = vi.hoisted(() => ({ hostedAnon: false }));
vi.mock('../security/userContext.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../security/userContext.js')>()),
  isHostedAnonymousRequest: () => h.hostedAnon,
}));
vi.mock('../storage/fileIO.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../storage/fileIO.js')>()),
  loadSnapshot: vi.fn(async () => '# Snapshot text SECRET-SNAPSHOT'),
  readSourceDocumentPdf: vi.fn(async () => Buffer.from('%PDF-1.4 SECRET-PDF')),
  resolveSourceDocument: vi.fn(async () => ({ available: true, type: 'md', content: 'SECRET-CONTENT', path: '/data/sources/x/snapshot.md' })),
}));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import * as fileIO from '../storage/fileIO.js';
import { createRouter, type Handler } from '../httpKit.js';
import type { ServerCtx } from '../routes/context.js';
import { registerSourcesRoutes } from '../routes/sources.js';

type Res = { status: number; headers: Record<string, string>; raw: Buffer | string };
async function call(path: string, url: string, params: Record<string, string>): Promise<Res> {
  const routes: { method: string; path: string; handler: Handler }[] = [];
  registerSourcesRoutes(createRouter(routes), {} as ServerCtx);
  const route = routes.find(r => r.method === 'GET' && r.path === path)!;
  const out: Res = { status: 200, headers: {}, raw: '' };
  const res = {
    writableEnded: false, headersSent: false,
    setHeader(n: string, v: string) { out.headers[n.toLowerCase()] = String(v); }, getHeader() { return undefined; },
    writeHead(s: number, hd?: Record<string, unknown>) { out.status = s; for (const [k, v] of Object.entries(hd ?? {})) out.headers[k.toLowerCase()] = String(v); this.headersSent = true; return this; },
    end(b?: Buffer | string) { out.raw = b ?? ''; this.writableEnded = true; },
  } as unknown as ServerResponse;
  await route.handler({ url, method: 'GET', headers: {}, params, socket: {} } as unknown as IncomingMessage, res, undefined);
  return out;
}
const body = (r: Res) => JSON.parse(String(r.raw));

beforeEach(() => { h.hostedAnon = false; });

describe('t/677: source snapshots and files are sign-in only', () => {
  for (const [path, url, params] of [
    ['/api/snapshots/:sourceId', '/api/snapshots/src-1', { sourceId: 'src-1' }],
    ['/api/source-documents/:docId/file', '/api/source-documents/doc-1/file', { docId: 'doc-1' }],
  ] as const) {
    it(`${path}: anonymous gets 403 anon_route_blocked and no content`, async () => {
      h.hostedAnon = true;
      const r = await call(path, url, params);
      expect(r.status).toBe(403);
      expect(r.headers['x-auth-reason']).toBe('anon_route_blocked');
      expect(body(r)).toMatchObject({ error: 'Sign in required', reason: 'anon_route_blocked' });
      expect(String(r.raw)).not.toMatch(/SECRET/);
    });

    it(`${path}: signed in (or local operator) gets 200`, async () => {
      const r = await call(path, url, params);
      expect(r.status).toBe(200);
    });
  }
});

describe('t/677: GET /api/source-documents/:docId tells an anonymous caller only that it exists', () => {
  const PATH = '/api/source-documents/:docId';
  const go = () => call(PATH, '/api/source-documents/doc-1', { docId: 'doc-1' });

  it('anonymous: exactly { available, type, signInRequired: true }, for every type', async () => {
    h.hostedAnon = true;
    for (const doc of [
      { available: true, type: 'md', content: 'SECRET-CONTENT', path: '/data/x/snapshot.md' },
      { available: true, type: 'pdf', path: '/data/x/raw.pdf', title: 'SECRET-TITLE' },
      { available: false, type: null },
    ]) {
      vi.mocked(fileIO.resolveSourceDocument).mockResolvedValueOnce(doc as never);
      const b = body(await go());
      expect(Object.keys(b).sort()).toEqual(['available', 'signInRequired', 'type']);
      expect(b).toEqual({ available: doc.available, type: doc.type, signInRequired: true });
    }
  });

  it('anonymous, error path: still only those three keys', async () => {
    h.hostedAnon = true;
    vi.mocked(fileIO.resolveSourceDocument).mockRejectedValueOnce(new Error('boom'));
    const b = body(await go());
    expect(b).toEqual({ available: false, type: null, signInRequired: true });
  });

  it('signed in: the full resolution, unchanged', async () => {
    const b = body(await go());
    expect(b).toEqual({ available: true, type: 'md', content: 'SECRET-CONTENT', path: '/data/sources/x/snapshot.md' });
  });
});
