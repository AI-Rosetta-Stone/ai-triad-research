// @vitest-environment node
// t/723 / t/724: the anonymous Quick Take limits over REAL HTTP, through the real gates and the real anonymous
// identity, with no mocked predicate. Each request runs enforceAuthGate, enforceAnonRouteGuard, anonRequestIdentity and
// runWithUser exactly as server.ts does, then the real checks from routes/anonDebateLimits.ts in the order the routes
// call them. A request that passes everything reaches a stub that answers 200 "reached". The saved sessions live in an
// in-memory map keyed by the storage id the request context reports, standing in for the anonymous session store.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';

vi.mock('../logger.js', () => {
  const l = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { log: { server: l(), api: l(), ai: l(), security: l() }, getRequestId: () => 'r' };
});
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { enforceAuthGate, enforceAnonRouteGuard, type AuthGateCtx, type AuthGateDeps } from '../authGates.js';
import { normalizedRequestPath } from '../httpKit.js';
import { computeIsPublicPath } from '../publicPaths.js';
import { anonRequestIdentity } from '../anonRequestIdentity.js';
import { runWithUser, getStorageUserId } from '../security/userContext.js';
import { setAnonSessionSecret, signAnonSessionId } from '../security/anonSessionSigning.js';
import {
  anonDebateLimitsApply, refuseAnonDebateSave, refuseAnonDebatePatch, refuseAnonDebateCall, invalidateAnonDebateShape,
  _resetAnonDebateShapeCacheForTest,
} from '../routes/anonDebateLimits.js';
import type { DebateDelta } from '../../../../lib/debate/types/session.js';

const DEPS: AuthGateDeps = { getAuthorizedUsers: () => null, isUserAuthorized: () => true };
const ENV = ['AUTH_OPTIONAL', 'AUTH_DISABLED', 'FREE_TIER_GEMINI_KEY'];
const saved: Record<string, string | undefined> = {};
const store = new Map<string, Map<string, Record<string, unknown>>>();
const loadOwn = async (id: string): Promise<unknown> => store.get(getStorageUserId())?.get(id) ?? null;
let server: http.Server;
let base: string;

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown> : {};
}

/** The three routes, each calling the real checks the way routes/debates.ts and routes/ai.ts do. */
async function dispatch(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): Promise<void> {
  const body = await readJson(req);
  const reached = (): void => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('reached'); };
  if (req.method === 'PUT' && urlPath === '/api/debates') {
    if (refuseAnonDebateSave(res, body)) return;
    const mine = store.get(getStorageUserId()) ?? new Map<string, Record<string, unknown>>();
    store.set(getStorageUserId(), mine);
    mine.set(String(body.id), body);
    invalidateAnonDebateShape(String(body.id));
    return reached();
  }
  if (req.method === 'PATCH' && urlPath.startsWith('/api/debates/')) {
    if (anonDebateLimitsApply() && await refuseAnonDebatePatch(res, body as unknown as DebateDelta, loadOwn)) return;
    return reached();
  }
  if (req.method === 'POST' && urlPath === '/api/ai/generate') {
    if (anonDebateLimitsApply() && await refuseAnonDebateCall(res, typeof body.debateId === 'string' ? body.debateId : undefined, loadOwn)) return;
    return reached();
  }
  res.writeHead(404); res.end();
}

beforeAll(async () => {
  setAnonSessionSecret(crypto.randomBytes(32));
  server = http.createServer((req, res) => {
    const urlPath = normalizedRequestPath(req);
    const ctx: AuthGateCtx = {
      urlPath, isPublicPath: computeIsPublicPath(urlPath),
      authDisabled: process.env.AUTH_DISABLED === '1', authOptional: process.env.AUTH_OPTIONAL === '1',
      principalName: '', idp: '',
    };
    if (enforceAuthGate(req, res, ctx, DEPS)) return;
    if (enforceAnonRouteGuard(req, res, ctx)) return;
    const anon = anonRequestIdentity(req);
    // As server.ts resolveRequestUserContext builds an anonymous UserContext.
    const userCtx = { principalName: '_local', idp: '_local', branchName: undefined, storageUserId: anon.storageUserId, isAnonymous: true, anonymousSessionId: anon.anonymousSessionId, stableId: undefined };
    void runWithUser(userCtx as never, () => dispatch(req, res, urlPath));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(() => {
  for (const n of ENV) { saved[n] = process.env[n]; delete process.env[n]; }
  process.env.AUTH_OPTIONAL = '1'; // hosted: sign-in optional, anonymous sessions allowed
  process.env.FREE_TIER_GEMINI_KEY = 'AIzaFAKE-NOT-A-KEY'; // the free tier is on, so anonymous generate passes the route guard
  store.clear();
  _resetAnonDebateShapeCacheForTest();
});
afterEach(() => { for (const n of ENV) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; } });

const A = '0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11';
const B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const signed = (uuid: string): string => `auth_anonymous=1; anon_session_id=${signAnonSessionId(uuid)}`;
const BARE = `auth_anonymous=1; anon_session_id=${A}`;
const FORGED = `auth_anonymous=1; anon_session_id=${A}.${'0'.repeat(64)}`;
const NO_SESSION_COOKIE = 'auth_anonymous=1';

interface Reply { status: number; reason: string | null; json: Record<string, unknown> | null; text: string }
async function send(method: string, path: string, cookie: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* the "reached" stub answers text */ }
  return { status: res.status, reason: res.headers.get('x-auth-reason'), json, text };
}

const DEBATERS = ['accelerationist', 'safetyist', 'skeptic'];
const entry = (type: string, speaker: string) => ({ id: crypto.randomUUID(), type, speaker, content: 'x', taxonomy_refs: [] });
function session(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, protocol_id: 'structured', active_povers: DEBATERS, _saveVersion: 1,
    adaptive_staging: { enabled: true, step_mode: false, phase_bounds_override: { maxConfrontationRounds: 1, maxArgumentationRounds: 1, maxConcludingRounds: 1 } },
    transcript: DEBATERS.map(d => entry('opening', d)), ...over,
  };
}
const deep = (id: string) => session(id, { protocol_id: 'deliberation', adaptive_staging: { enabled: true, phase_bounds_override: { maxConfrontationRounds: 1, maxArgumentationRounds: 3, maxConcludingRounds: 1 } } });
const delta = (id: string, over: Record<string, unknown>) => ({ debateId: id, baseVersion: 1, newTranscriptEntries: [], changedNodes: [], changedEdges: [], newMutations: [], ...over });
const expectAnonLimit = (r: Reply, code: string): void => {
  expect(r.status).toBe(403);
  expect(r.reason).toBe('anon_limit');
  expect(r.json).toMatchObject({ reason: 'anon_limit', code, signInRequired: true, retryable: false });
};

describe('t/724 over real HTTP: an anonymous visitor with a valid session', () => {
  it('saves a Quick Take, patches it within the limit, and its AI calls pass', async () => {
    expect((await send('PUT', '/api/debates', signed(A), session('q1'))).text).toBe('reached');
    expect((await send('PATCH', '/api/debates/q1', signed(A), delta('q1', { newTranscriptEntries: [entry('statement', 'skeptic')] }))).text).toBe('reached');
    expect((await send('POST', '/api/ai/generate', signed(A), { prompt: 'p', debateId: 'q1' })).text).toBe('reached');
  });

  it('an AI call with no debate id is not checked', async () => {
    expect((await send('POST', '/api/ai/generate', signed(A), { prompt: 'p' })).text).toBe('reached');
  });

  it.each([
    ['a Deep dive', deep('d1')],
    ['a Socratic debate', session('d1', { protocol_id: 'socratic' })],
    ['step mode', session('d1', { adaptive_staging: { enabled: true, step_mode: true, phase_bounds_override: { maxConfrontationRounds: 1, maxArgumentationRounds: 1, maxConcludingRounds: 1 } } })],
    ['an unknown entry type', session('d1', { transcript: [entry('monologue', 'skeptic')] })],
  ])('PUT of %s is 403 anon_debate_kind and nothing is stored', async (_n, body) => {
    expectAnonLimit(await send('PUT', '/api/debates', signed(A), body), 'anon_debate_kind');
    expect(store.get(`anon-${A}`)?.has('d1') ?? false).toBe(false);
  });

  it('PUT with one debater entry over the limit is 403 anon_debate_turns with the limit', async () => {
    const over = Array.from({ length: 14 }, (_, i) => entry(i < 3 ? 'opening' : 'statement', DEBATERS[i % 3]));
    const r = await send('PUT', '/api/debates', signed(A), session('d1', { transcript: over }));
    expectAnonLimit(r, 'anon_debate_turns');
    expect(r.json?.limit).toBe(13);
    const atLimit = await send('PUT', '/api/debates', signed(A), session('d1', { transcript: over.slice(0, 13) }));
    expect(atLimit.text).toBe('reached');
  });

  it('PATCH that turns a saved Quick Take into a Deep dive is refused', async () => {
    await send('PUT', '/api/debates', signed(A), session('q1'));
    expectAnonLimit(await send('PATCH', '/api/debates/q1', signed(A), delta('q1', { changedFields: { protocol_id: 'deliberation' } })), 'anon_debate_kind');
  });

  it('an AI call is refused for an unsaved id and for another visitor\'s debate, with the same response', async () => {
    await send('PUT', '/api/debates', signed(A), session('q1'));
    const missing = await send('POST', '/api/ai/generate', signed(B), { prompt: 'p', debateId: 'nope' });
    const others = await send('POST', '/api/ai/generate', signed(B), { prompt: 'p', debateId: 'q1' });
    expectAnonLimit(missing, 'anon_debate_unsaved');
    expect(others.text).toBe(missing.text);
    expect(others.reason).toBe(missing.reason);
    // The owner's own call still passes.
    expect((await send('POST', '/api/ai/generate', signed(A), { prompt: 'p', debateId: 'q1' })).text).toBe('reached');
  });

  it('an existing Deep dive is read-only: AI calls and content changes are refused, a title-only PATCH passes', async () => {
    store.set(`anon-${A}`, new Map([['old', deep('old')]])); // saved before the limits shipped
    expectAnonLimit(await send('POST', '/api/ai/generate', signed(A), { prompt: 'p', debateId: 'old' }), 'anon_debate_kind');
    expectAnonLimit(await send('PATCH', '/api/debates/old', signed(A), delta('old', { newTranscriptEntries: [entry('statement', 'skeptic')] })), 'anon_debate_kind');
    expectAnonLimit(await send('PUT', '/api/debates', signed(A), deep('old')), 'anon_debate_kind');
    expect((await send('PATCH', '/api/debates/old', signed(A), delta('old', { meta: { title: 'Renamed' } }))).text).toBe('reached');
  });
});

describe('t/724 over real HTTP: the title-only rename delta (Rosetta Stone p/74#42)', () => {
  it('exactly the rename body the renderer sends passes on an existing Deep dive; anything beyond meta.title does not', async () => {
    store.set(`anon-${A}`, new Map([['old', deep('old')]]));
    // The body renameDebate sends: debateId, baseVersion, four empty arrays, meta { title } (no changedFields, no updated_at).
    const rename = { debateId: 'old', baseVersion: 1, newTranscriptEntries: [], changedNodes: [], changedEdges: [], newMutations: [], meta: { title: 'Renamed' } };
    expect((await send('PATCH', '/api/debates/old', signed(A), rename)).text).toBe('reached');
    expectAnonLimit(await send('PATCH', '/api/debates/old', signed(A), { ...rename, meta: { title: 'x', protocol_id: 'structured' } }), 'anon_debate_kind');
    expectAnonLimit(await send('PATCH', '/api/debates/old', signed(A), { ...rename, changedFields: ['title'] }), 'anon_debate_kind');
    expectAnonLimit(await send('PATCH', '/api/debates/old', signed(A), { ...rename, newMutations: [{ id: 'm' }] }), 'anon_debate_kind');
    expectAnonLimit(await send('PATCH', '/api/debates/old', signed(A), { ...rename, meta: {} }), 'anon_debate_kind');
  });
});

describe('t/724 over real HTTP, B1: no valid anonymous session', () => {
  it.each([['a bare (unsigned) cookie', BARE], ['a forged signature', FORGED], ['no session cookie', NO_SESSION_COOKIE]])(
    '%s: PUT, PATCH and a debate AI call are 401 no_session, and nothing is stored', async (_n, cookie) => {
      for (const r of [
        await send('PUT', '/api/debates', cookie, session('q1')),
        await send('PATCH', '/api/debates/q1', cookie, delta('q1', {})),
        await send('POST', '/api/ai/generate', cookie, { prompt: 'p', debateId: 'q1' }),
      ]) {
        expect(r.status).toBe(401);
        expect(r.reason).toBe('no_session');
      }
      expect(store.size).toBe(0);
    });
});
