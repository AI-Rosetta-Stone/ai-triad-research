// @vitest-environment node
// t/500 (t/666; TL t/500#49): the four required expiry tests THROUGH THE REAL ROUTES (GET /api/oped-sets/:id and
// GET /api/oped-sets), over the real opedStore (t/665) and an in-memory user-content backend, with a controlled clock.
//   1. a read at 23 h 59 m keeps the set and resets the clock;
//   2. a read past 24 h is 404, and the blob is gone from storage;
//   3. the sweep deletes an unread expired set (the next read is 404);
//   4. nothing but the owner's own read extends it: another session's read, a list, and the sweep leave the stamp alone.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const { _store, mockBackend, norm } = vi.hoisted(() => {
  const _store = new Map<string, string>();
  const norm = (p: string) => p.split(String.fromCharCode(92)).join('/');
  const mockBackend = {
    readFile: vi.fn(async (p: string) => _store.get(norm(p)) ?? null),
    writeFile: vi.fn(async (p: string, c: string) => { _store.set(norm(p), c); }),
    deleteFile: vi.fn(async (p: string) => { _store.delete(norm(p)); }),
    listDirectory: vi.fn(async (dir: string) => {
      const d = norm(dir); const prefix = d.endsWith('/') ? d : d + '/';
      return [..._store.keys()].filter(k => k.startsWith(prefix))
        .map(k => k.slice(prefix.length).split('/')[0]).filter((v, i, a) => a.indexOf(v) === i);
    }),
    fileExists: vi.fn(async (p: string) => _store.has(norm(p))),
    readBinaryFile: vi.fn(), writeBinaryFile: vi.fn(),
  };
  return { _store, mockBackend, norm };
});
const { ctx } = vi.hoisted(() => ({ ctx: { storageUserId: '_local', anonymous: true } }));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  resolveDataPath: (rel: string) => `/data/${rel}`, getDataRoot: () => '/data',
}));
vi.mock('../logger.js', () => {
  const l = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { log: { server: l(), api: l(), ai: l(), security: l() }, getRequestId: () => 'r' };
});
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('../security/userContext.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../security/userContext.js')>()),
  getStorageUserId: () => ctx.storageUserId,
  isAnonymousUser: () => ctx.anonymous,
}));
vi.mock('../security/quotas.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../security/quotas.js')>()),
  checkQuota: (resource: string, count: number) => ({ allowed: count < 10, resource, current: count, limit: 10 }),
}));
// An explicit mock, never importOriginal: fileIO and opedStore import each other, and spreading the real module bound the
// store to the REAL filesystem backend (it wrote under /data). Only what opedStore and routes/oped.ts use is provided.
vi.mock('../storage/fileIO.js', () => ({
  getUserContentBackend: () => mockBackend,
  assertSafeId: (value: string, label: string) => {
    if (!value || !/^[a-zA-Z0-9_-]+$/.test(value)) throw Object.assign(new Error(`Invalid ${label}: "${value}"`), { statusCode: 400 });
  },
  isSafeId: (v: string) => !!v && /^[a-zA-Z0-9_-]+$/.test(v),
  fetchUrlContent: vi.fn(), upsertOpedRun: vi.fn(async () => undefined), countRunningOpedRuns: vi.fn(async () => 0), getOpedRun: vi.fn(async () => null),
}));
vi.mock('../storage/opedShareStore.js', () => ({ unpublishOpedShare: async () => false, publishOpedShare: vi.fn(), refreshOpedShareIfShared: vi.fn(async () => false) }));

import { registerOpedRoutes } from '../routes/oped.js';
import { finalizeOpedSet, sweepExpiredAnonOpedSets, resetAnonOpedSweepCursorForTests } from '../storage/opedStore.js';
import type { OpEdSet } from '../../../../lib/oped/types.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-9222-222222222222';
const H = 60 * 60 * 1000;
const M = 60 * 1000;
const T0 = Date.parse('2026-11-25T00:00:00.000Z');
const SET_ID = 'set-a1';

type Handler = (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void> | void;
const handlers: Record<string, Handler> = {};
const reg = (m: string) => (p: string, fn: Handler) => { handlers[`${m} ${p}`] = fn; };
registerOpedRoutes({ get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), del: reg('DELETE') } as never, {} as never);

const as = (uuid: string) => { ctx.storageUserId = `anon-${uuid}`; ctx.anonymous = true; };
const at = (ms: number) => vi.setSystemTime(new Date(ms));
const blobExists = () => [..._store.keys()].some(k => k.startsWith(`/data/anon-oped/${UUID_A}/`) && k.includes(SET_ID) && !k.endsWith('_index.json'));

async function call(method: 'GET', route: string, url: string, params: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  let status = 200; let raw = '';
  const res = {
    headersSent: false, writableEnded: false, setHeader() {}, getHeader() { return undefined; },
    writeHead(s: number) { status = s; return this; }, end(b?: string) { raw = b ?? ''; },
  } as unknown as ServerResponse;
  await handlers[`${method} ${route}`]({ url, method, headers: {}, params } as unknown as IncomingMessage, res);
  return { status, body: raw ? JSON.parse(raw) : null };
}
const read = () => call('GET', '/api/oped-sets/:id', `/api/oped-sets/${SET_ID}`, { id: SET_ID });
const list = () => call('GET', '/api/oped-sets', '/api/oped-sets');

const SET = { schema_version: 1, set_id: SET_ID, topic: 'T', params: { model: 'm', wordCount: 300 }, created_at: new Date(T0).toISOString(), opeds: [] } as unknown as OpEdSet;

beforeEach(async () => {
  _store.clear();
  resetAnonOpedSweepCursorForTests?.();
  vi.useFakeTimers({ toFake: ['Date'] });
  at(T0);
  as(UUID_A);
  await finalizeOpedSet(SET);
  expect(blobExists()).toBe(true);
});
afterEach(() => { vi.useRealTimers(); });

describe('t/500: anonymous op-ed expiry through the real routes', () => {
  it('1. a read at 23 h 59 m keeps the set and resets the clock', async () => {
    at(T0 + 23 * H + 59 * M);
    expect((await read()).status).toBe(200);
    at(T0 + 23 * H + 59 * M + 23 * H + 59 * M); // ~48 h after creation, 23 h 59 m after the last open
    expect((await read()).status).toBe(200);
  });

  it('2. a read past 24 h is 404, and the blob is gone from storage', async () => {
    at(T0 + 24 * H + M);
    expect((await read()).status).toBe(404);
    expect(blobExists()).toBe(false);
  });

  it('3. the sweep deletes an unread expired set', async () => {
    at(T0 + 25 * H);
    const r = await sweepExpiredAnonOpedSets({ now: T0 + 25 * H });
    expect(r.setsDeleted).toBeGreaterThanOrEqual(1);
    expect(blobExists()).toBe(false);
    expect((await read()).status).toBe(404);
  });

  it("4. only the owner's own read extends it: another session, a list and the sweep do not", async () => {
    at(T0 + 12 * H);
    as(UUID_B);
    expect((await read()).status).toBe(404); // another session never sees it
    as(UUID_A);
    expect((await list()).status).toBe(200); // the owner's list does not refresh the stamp
    await sweepExpiredAnonOpedSets({ now: T0 + 23 * H }); // nor does a sweep that finds it live
    at(T0 + 24 * H + M);
    expect((await read()).status).toBe(404); // still expires 24 h after the last OPEN (creation)
    expect(blobExists()).toBe(false);
  });
});
