// @vitest-environment node
//
// t/2610 — REAL-SOCKET regression test for POST /api/oped-sets SSE cancel-persistence.
//
// The pre-start unit tests (opedRoutes.test.ts) return before the stream; they never
// exercise real Node socket 'close' semantics. This test stands up a real http.Server,
// drives the ACTUAL create handler, and aborts a real client fetch mid-generation — the
// only thing that distinguishes res.on('close') (correct) from req.on('close') (dead:
// fires at message-complete on Node ≥15, nodejs/node#33035). Both arms (TL gate):
//   CLEAN ARM  — a normal run persists the FULL set. A req.on('close') revert would
//                false-abort at message-complete → the core would yield a PARTIAL, so
//                the finalized set would be missing voice 2. Fails this arm.
//   FAILURE ARM — a real client abort mid-run cancels in-flight voices but STILL persists
//                the partial set with the completed voice (TL gap 1). Proves the drain-to-
//                complete cancel-persistence, not discard.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { createRouter } from '../httpKit.js';
import { registerOpedRoutes } from '../routes/oped.js';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, ms: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) { if (pred()) return true; await sleep(10); }
  return pred();
}

// Controllable core generator + a capture of what gets persisted.
const h = vi.hoisted(() => ({
  genImpl: null as null | ((req: { set_id: string; topic: string; params: unknown; povs: string[]; signal?: AbortSignal }) => AsyncGenerator<Record<string, unknown>>),
  finalized: [] as unknown[],
  genCalled: 0,
  events: [] as Array<{ type: string; message?: string }>,
}));

// The route dynamic-imports lib/oped/generate.js via '../../../../lib/oped/generate.js'
// (4-ups — dist/tsc/vitest-correct); the same specifier from this test file resolves to
// the same real module, so this mock intercepts it.
vi.mock('../../../../lib/oped/generate.js', () => ({
  generateOpEdSet: (req: never) => { h.genCalled++; return h.genImpl!(req); },
}));

vi.mock('../storage/opedStore.js', () => ({
  getOpedSetsQuotaStatus: async () => ({ allowed: true, resource: 'opeds', current: 0, limit: 15 }),
  finalizeOpedSet: async (set: unknown) => { h.finalized.push(set); },
  listOpedSets: vi.fn(), loadOpedSet: vi.fn(), deleteOpedSet: vi.fn(),
}));
vi.mock('../ai/opedAdapter.js', () => ({ createWebOpEdAdapter: () => ({ generateText: vi.fn() }) }));
vi.mock('../security/userContext.js', () => ({
  isAnonymousUser: () => false, getStorageUserId: () => 'user-1',
  getCurrentUser: () => ({ principalName: 'u', idp: 'aad', isAnonymous: false }),
}));
vi.mock('../ai/proxyTiers.js', () => ({
  resolveTier: () => ({ level: 'platform', allowedBackends: ['gemini'], pinnedModel: undefined }),
  isBackendAllowed: () => true,
  byokGeminiFallbackApplies: () => false, // t/616: platform tier, so never the free pool
}));
vi.mock('../ai/aiBackends.js', () => ({ resolveBackend: () => 'gemini', isRegisteredModel: () => true }));
vi.mock('../../../../lib/ai-client/index.js', () => ({ DEFAULT_MODEL: 'gemini-flash' }));
vi.mock('../config.js', () => ({ getProjectRoot: () => '/repo' }));
vi.mock('../storage/fileIO.js', () => ({
  isSafeId: (v: string) => /^[a-zA-Z0-9_-]+$/.test(v),
  // t/2893: oped.ts now persists run-control via these (re-exported from fileIO) — no-op stubs;
  // this integration test asserts the PARTIAL-set persist (opedStore), not the run-control store.
  upsertOpedRun: async () => {},
  countRunningOpedRuns: async () => 0,
  getOpedRun: async () => null,
}));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: (e: { type: string; message?: string }) => { h.events.push(e); } }) }));

function member(pov: string, status: 'complete' | 'cancelled'): Record<string, unknown> {
  return { pov, status, headline: status === 'complete' ? `H-${pov}` : '', subtitle: '', body: status === 'complete' ? `B-${pov}` : '', wordCount: status === 'complete' ? 800 : 0, grounding: [] };
}
function set(setId: string, topic: string, params: unknown, opeds: Record<string, unknown>[]): Record<string, unknown> {
  return { schema_version: 1, set_id: setId, topic, params, created_at: 'c', opeds };
}

describe('t/2610 — POST /api/oped-sets cancel-persistence over a real socket', () => {
  let server: http.Server;
  let url: string;

  beforeEach(async () => {
    h.genImpl = null; h.finalized = [];
    const routes: Array<{ method: string; path: string; handler: (req: unknown, res: unknown, body: unknown) => Promise<void> }> = [];
    registerOpedRoutes(createRouter(routes as never), {} as never);
    const handler = routes.find(r => r.method === 'POST' && r.path === '/api/oped-sets')!.handler;
    // Parse the body first (request message completes BEFORE the handler runs — the exact
    // production sequence that makes req.on('close') dead), then dispatch to the real handler.
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => { void handler(req, res, body ? JSON.parse(body) : {}); });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/oped-sets`;
  });

  afterEach(async () => { await new Promise<void>(r => server.close(() => r())); });

  const body = JSON.stringify({ topic: 'AI safety', params: { model: 'gemini-flash', wordCount: 800 }, povs: ['accelerationist', 'safetyist'] });

  it('CLEAN ARM: a normal run persists the FULL set (no false-abort at message-complete)', async () => {
    // Voice 1 completes, then a delay long enough that a req.on('close') false-abort would
    // flip the signal before voice 2, then voice 2 completes → full set.
    h.genImpl = async function* (req) {
      yield { type: 'voice_start', pov: 'acc' };
      yield { type: 'voice_complete', pov: 'acc', member: member('acc', 'complete') };
      await sleep(120);
      if (req.signal?.aborted) { yield { type: 'voice_cancelled', pov: 'saf' }; yield { type: 'complete', set: set(req.set_id, req.topic, req.params, [member('acc', 'complete'), member('saf', 'cancelled')]) }; return; }
      yield { type: 'voice_complete', pov: 'saf', member: member('saf', 'complete') };
      yield { type: 'complete', set: set(req.set_id, req.topic, req.params, [member('acc', 'complete'), member('saf', 'complete')]) };
    };

    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(res.status).toBe(200);
    await res.text(); // drain the SSE stream to completion
    await sleep(40);  // allow the post-completion res 'close' to fire (must NOT corrupt the persisted set)

    expect(h.genCalled).toBe(1);                                   // the core generator ran (not a caught import failure)
    expect(h.events.some(e => e.type === 'system.error')).toBe(false); // no error recorded on the clean path
    expect(h.finalized).toHaveLength(1);
    const persisted = h.finalized[0] as { opeds: { pov: string; status: string }[] };
    expect(persisted.opeds.map(m => `${m.pov}:${m.status}`)).toEqual(['acc:complete', 'saf:complete']); // FULL set
  });

  it('FAILURE ARM: a real client abort mid-run persists the PARTIAL set with the completed voice', async () => {
    h.genImpl = async function* (req) {
      yield { type: 'voice_start', pov: 'acc' };
      yield { type: 'voice_complete', pov: 'acc', member: member('acc', 'complete') };
      await sleep(150); // window for the client to abort mid-run
      if (req.signal?.aborted) { yield { type: 'voice_cancelled', pov: 'saf' }; yield { type: 'complete', set: set(req.set_id, req.topic, req.params, [member('acc', 'complete'), member('saf', 'cancelled')]) }; return; }
      yield { type: 'voice_complete', pov: 'saf', member: member('saf', 'complete') };
      yield { type: 'complete', set: set(req.set_id, req.topic, req.params, [member('acc', 'complete'), member('saf', 'complete')]) };
    };

    const ac = new AbortController();
    const req = fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: ac.signal }).catch(() => { /* aborted */ });
    await sleep(60); // let voice 1 stream, mid-run
    ac.abort();       // real client disconnect → res.on('close') → signal abort → core cancels + drains to partial complete

    const persistedOne = await waitUntil(() => h.finalized.length > 0, 2000);
    expect(persistedOne).toBe(true);
    const persisted = h.finalized[0] as { opeds: { pov: string; status: string }[] };
    // The completed voice survives the cancel (TL gap 1); the aborted one is a marker, not lost work.
    expect(persisted.opeds.map(m => `${m.pov}:${m.status}`)).toEqual(['acc:complete', 'saf:cancelled']);
    await req;
  });
});
