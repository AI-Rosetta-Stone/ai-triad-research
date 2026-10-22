// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4423 (t/4355 AC 2) — the web save path keeps `superseded_by` byte-identical. Drives the real
// GET + PUT /api/taxonomy/:pov handlers over the real fileIO serializer (in-memory backend), so a
// field dropped or rewritten anywhere between load, authorship stamping and the write would show.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { StorageBackend } from '../storage/storageBackend.js';

vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('../featureFlags.js', () => ({ getFlag: () => false }));
vi.mock('../groundingReconcileHook.js', () => ({ enqueueGroundingReconcile: vi.fn() }));
vi.mock('../security/userContext.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../security/userContext.js')>()),
  isAnonymousUser: () => false,
  getCurrentUserId: () => 'tester',
}));

import * as fileIO from '../storage/fileIO.js';
import { registerTaxonomyRoutes, __resetTaxonomyGetCacheForTest } from '../routes/taxonomy.js';
import type { ServerCtx } from '../routes/context.js';

class MemoryBackend implements StorageBackend {
  readonly backendName = 'memory';
  files = new Map<string, string>();
  private norm(p: string) { return p.replace(/\\/g, '/'); }
  private version(c: string) { return crypto.createHash('sha1').update(c).digest('hex'); }
  async readFile(p: string) { return this.files.get(this.norm(p)) ?? null; }
  async readFileWithVersion(p: string) {
    const content = this.files.get(this.norm(p));
    return content === undefined ? null : { content, version: this.version(content) };
  }
  async writeFile(p: string, content: string) { this.files.set(this.norm(p), content); return { version: this.version(content) }; }
  async listDirectory() { return []; }
  async deleteFile() { /* unused */ }
  async fileExists(p: string) { return this.files.has(this.norm(p)); }
  async readBinaryFile() { return null; }
  async writeBinaryFile() { /* unused */ }
}

type Handler = (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void> | void;
type FakeRes = ServerResponse & { _status: number; _text: string; _headers: Record<string, string> };

function fakeRes(): FakeRes {
  const res = {
    writableEnded: false, headersSent: false, _status: 200, _text: '', _headers: {} as Record<string, string>,
    writeHead(code: number) { res._status = code; res.headersSent = true; },
    end(b?: string | Buffer) { res._text = b === undefined ? '' : String(b); res.writableEnded = true; },
    setHeader(name: string, value: string) { res._headers[name] = value; },
  };
  return res as unknown as FakeRes;
}

const req = (headers: Record<string, string> = {}) =>
  ({ url: '/api/taxonomy/accelerationist', headers }) as unknown as IncomingMessage;

const LIVE = { id: 'acc-beliefs-001', label: 'Live node', description: 'The survivor.' };
const HELD = {
  id: 'acc-beliefs-002', label: 'Retired twin', description: 'Merged into 001.',
  superseded_by: 'acc-beliefs-001',
  _edit_meta: { last_edited_by: 'curator', last_edited_at: '2026-10-01T00:00:00.000Z', created_by: 'curator', created_at: '2026-09-01T00:00:00.000Z' },
};
// The canonical POV-file format (t/4353): JSON.stringify(o, null, 2) + "\n".
const SEED = JSON.stringify({ nodes: [LIVE, HELD] }, null, 2) + '\n';

let dataRoot: string;
let mem: MemoryBackend;
let filePath: string;
let handlers: Record<string, Handler>;

async function load(): Promise<{ body: { nodes: Array<Record<string, unknown>> }; etag: string }> {
  const res = fakeRes();
  await handlers['GET /api/taxonomy/:pov'](req(), res);
  expect(res._status).toBe(200);
  return { body: JSON.parse(res._text), etag: res._headers.ETag };
}

async function save(body: unknown, etag: string): Promise<void> {
  const res = fakeRes();
  await handlers['PUT /api/taxonomy/:pov'](req({ 'if-match': etag }), res, body);
  expect(res._status, res._text).toBe(200);
}

const stored = () => mem.files.get(filePath)!;
const block = (node: unknown) => JSON.stringify(node, null, 2);

describe('PUT /api/taxonomy/:pov keeps superseded_by byte-identical (t/4423)', () => {
  beforeAll(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'superseded-rt-'));
    process.env.AI_TRIAD_DATA_ROOT = dataRoot;
  });
  afterAll(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    delete process.env.AI_TRIAD_DATA_ROOT;
  });
  beforeEach(async () => {
    mem = new MemoryBackend();
    fileIO.setBackend(mem);
    __resetTaxonomyGetCacheForTest();
    filePath = (await fileIO.resolveTaxonomyFilePath('accelerationist')).replace(/\\/g, '/');
    mem.files.set(filePath, SEED);
    const reg: Record<string, Handler> = {};
    const add = (m: string) => (p: string, h: Handler) => { reg[`${m} ${p}`] = h; };
    registerTaxonomyRoutes(
      { get: add('GET'), put: add('PUT'), post: add('POST'), patch: add('PATCH'), del: add('DELETE') } as never,
      { ensureSessionBranch: vi.fn(async () => undefined) } as unknown as ServerCtx,
    );
    handlers = reg;
  });

  it('an unchanged load → save writes the file back byte-for-byte', async () => {
    const { body, etag } = await load();
    await save(body, etag);
    expect(stored()).toBe(SEED);
  });

  it('editing another node leaves the superseded node byte-identical', async () => {
    const { body, etag } = await load();
    body.nodes[0] = { ...body.nodes[0], label: 'Live node (edited)' };
    await save(body, etag);

    const written = JSON.parse(stored()) as { nodes: Array<Record<string, unknown>> };
    expect(written.nodes[0]._edit_meta).toBeDefined(); // the edit itself was stamped
    expect(block(written.nodes[1])).toBe(block(HELD));
    expect(stored()).toContain(block(HELD).replace(/\n/g, '\n    ')); // same bytes at file indentation

    const reloaded = await load();
    expect(reloaded.body.nodes[1].superseded_by).toBe('acc-beliefs-001');
  });

  it('editing the superseded node itself keeps its superseded_by value', async () => {
    const { body, etag } = await load();
    body.nodes[1] = { ...body.nodes[1], description: 'Merged into 001 (note updated).' };
    await save(body, etag);

    const written = JSON.parse(stored()) as { nodes: Array<Record<string, unknown>> };
    expect(written.nodes[1].superseded_by).toBe('acc-beliefs-001');
    expect(stored()).toContain('"superseded_by": "acc-beliefs-001"');
  });
});
