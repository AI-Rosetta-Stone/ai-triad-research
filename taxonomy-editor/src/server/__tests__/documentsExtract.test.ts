// @vitest-environment node
//
// t/274 — POST /api/documents/extract. The route reads its own capped stream, so these tests drive the real
// handler with a Readable request. Only the user context is mocked; extraction is the real lib/extraction.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';
import type { IncomingMessage, ServerResponse } from 'http';

const h = vi.hoisted(() => ({
  user: null as null | { storageUserId: string; isAnonymous: boolean },
}));

vi.mock('../security/userContext.js', async (orig) => ({
  ...(await orig<typeof import('../security/userContext.js')>()),
  getCurrentUser: () => h.user,
}));

import { createRouter, type Handler } from '../httpKit.js';
import { registerDocumentsRoutes } from '../routes/documents.js';

const routes: Array<{ method: string; path: string; handler: Handler }> = [];
registerDocumentsRoutes(createRouter(routes), {} as never);
const handler = routes.find(r => r.method === 'POST' && r.path === '/api/documents/extract')!.handler;

const SIGNED_IN = { storageUserId: 'user-1', isAnonymous: false };
const MB = 1024 * 1024;

async function post(opts: { body?: Buffer | Buffer[]; headers?: Record<string, string> } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const out: { status?: number; text?: string } = {};
  const res = {
    writeHead: (s: number) => { out.status = s; },
    end: (t?: string) => { out.text = t; },
    setHeader: () => {},
    writableEnded: false, headersSent: false,
  } as unknown as ServerResponse;
  const chunks = opts.body === undefined ? [] : Array.isArray(opts.body) ? opts.body : [opts.body];
  const stream = Readable.from(chunks) as unknown as IncomingMessage;
  Object.assign(stream, { method: 'POST', url: '/api/documents/extract', headers: opts.headers ?? {} });
  await handler(stream, res, null);
  return { status: out.status ?? 200, body: out.text ? JSON.parse(out.text) : {} };
}

const named = (name: string, extra: Record<string, string> = {}) => ({ 'x-document-name': encodeURIComponent(name), ...extra });

beforeEach(() => { h.user = SIGNED_IN; });

describe('POST /api/documents/extract (t/274)', () => {
  it('refuses an anonymous caller with 401 and reads nothing', async () => {
    h.user = { storageUserId: 'anon', isAnonymous: true };
    const r = await post({ body: Buffer.from('hello'), headers: named('a.txt') });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('UNAUTHENTICATED');
  });

  it('refuses a missing or invalid X-Document-Name with 400', async () => {
    expect((await post({ body: Buffer.from('hello') })).status).toBe(400);
    expect((await post({ body: Buffer.from('hello'), headers: { 'x-document-name': '%E0%A4%A' } })).status).toBe(400);
    expect((await post({ body: Buffer.from('hello'), headers: named('x'.repeat(256)) })).status).toBe(400);
  });

  it('refuses a declared Content-Length over 10 MB with 413 before reading the body', async () => {
    const r = await post({ body: [], headers: named('a.txt', { 'content-length': String(11 * MB) }) });
    expect(r.status).toBe(413);
    expect(r.body.code).toBe('SIZE_LIMIT_EXCEEDED');
  });

  it('stops a streamed upload at 10 MB with 413, even with no Content-Length', async () => {
    const r = await post({ body: [Buffer.alloc(6 * MB, 0x61), Buffer.alloc(6 * MB, 0x61)], headers: named('a.txt') });
    expect(r.status).toBe(413);
    expect(r.body.code).toBe('SIZE_LIMIT_EXCEEDED');
  });

  it('refuses an empty upload with 400', async () => {
    const r = await post({ body: [], headers: named('a.txt') });
    expect(r.status).toBe(400);
  });

  it('refuses a PDF with 415 PDF_PENDING_T393 until t/393 lands, even when the name says .txt', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('renamed .txt')]);
    const r = await post({ body: pdf, headers: named('renamed.txt') });
    expect(r.status).toBe(415);
    expect(r.body.code).toBe('PDF_PENDING_T393');
  });

  it('extracts a plain-text upload: 200 with text, format, words and warnings', async () => {
    const r = await post({ body: Buffer.from('Alpha beta gamma.\n\nDelta epsilon.'), headers: named('essay.txt') });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ format: 'txt', words: 5 });
    expect(typeof r.body.text).toBe('string');
    expect(Array.isArray(r.body.warnings)).toBe(true);
  });

  it('maps a whitespace-only document to 422 EMPTY_DOCUMENT', async () => {
    const r = await post({ body: Buffer.from('   \n\t  '), headers: named('blank.txt') });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('EMPTY_DOCUMENT');
  });

  it('maps an unrecognised binary to 415 UNSUPPORTED_FORMAT', async () => {
    const junk = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x00, 0x09, 0x00, 0x00, 0x7f]);
    const r = await post({ body: junk, headers: named('blob.bin') });
    expect(r.status).toBe(415);
    expect(r.body.code).toBe('UNSUPPORTED_FORMAT');
  });
});
