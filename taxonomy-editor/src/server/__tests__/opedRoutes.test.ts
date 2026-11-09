// @vitest-environment node

/**
 * t/2573 — the /api/oped-sets library routes (list/load/delete). The handlers are
 * thin over storage/opedStore.ts (unit-tested in opedStore.test.ts), so this suite
 * pins the *route-layer* contract:
 *   - list returns the store's row summaries verbatim
 *   - load returns the full OpEdSet, and a PARTIAL set passes through UNTOUCHED
 *     (a member's 'failed'/'cancelled' status is data, not an error) — the AC
 *   - a missing set is a 404 (store returns null), not a 200/500
 *   - an unsafe set_id is rejected at the boundary with 400 BEFORE any store call
 *     (the t/2526 audit class)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

// Controllable store — the routes import the public opedStore API directly.
// vi.hoisted so the mock fns exist when the hoisted vi.mock factory runs.
const { listOpedSets, loadOpedSet, deleteOpedSet, getOpedSetsQuotaStatus, finalizeOpedSet } = vi.hoisted(() => ({
  listOpedSets: vi.fn(), loadOpedSet: vi.fn(), deleteOpedSet: vi.fn(), getOpedSetsQuotaStatus: vi.fn(), finalizeOpedSet: vi.fn(),
}));
vi.mock('../storage/opedStore.js', () => ({ listOpedSets, loadOpedSet, deleteOpedSet, getOpedSetsQuotaStatus, finalizeOpedSet }));

// t/4927: rename calls refreshOpedShareIfShared after finalizeOpedSet persists. Controllable
// so tests can assert the call and exercise its best-effort failure path independent of the
// real registry/backend (publishOpedShare/unpublishOpedShare aren't exercised by this file's
// routes, so a bare stub is enough).
const { refreshOpedShareIfShared, publishOpedShare, unpublishOpedShare } = vi.hoisted(() => ({
  refreshOpedShareIfShared: vi.fn(async () => false),
  publishOpedShare: vi.fn(),
  unpublishOpedShare: vi.fn(),
}));
vi.mock('../storage/opedShareStore.js', () => ({ refreshOpedShareIfShared, publishOpedShare, unpublishOpedShare }));

const { serverWarn } = vi.hoisted(() => ({ serverWarn: vi.fn() }));
vi.mock('../logger.js', () => ({
  log: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, server: { info: vi.fn(), warn: serverWarn, error: vi.fn(), debug: vi.fn() } },
  getRequestId: () => 'req-test', LOG_MAX_LINE_BYTES: 65536, writeFramedNdjson: vi.fn(),
}));

// Controllable auth + tier context for the create-route pre-start gate (t/2610).
const { isAnonymousUser, getStorageUserId, getCurrentUser, resolveTier, resolveBackend, isRegisteredModel } = vi.hoisted(() => ({
  isAnonymousUser: vi.fn(() => false),
  getStorageUserId: vi.fn(() => 'user-1'),
  getCurrentUser: vi.fn(() => ({ principalName: 'u', idp: 'aad', isAnonymous: false })),
  resolveTier: vi.fn(() => ({ level: 'platform', allowedBackends: ['gemini', 'claude', 'groq'], pinnedModel: undefined })),
  resolveBackend: vi.fn(() => 'gemini'),
  isRegisteredModel: vi.fn(() => true),
}));
vi.mock('../security/userContext.js', () => ({ isAnonymousUser, getStorageUserId, getCurrentUser }));
vi.mock('../ai/proxyTiers.js', () => ({ resolveTier, isBackendAllowed: (tier: { allowedBackends: string[] }, b: string) => tier.allowedBackends.includes(b) }));
vi.mock('../ai/aiBackends.js', () => ({ resolveBackend, isRegisteredModel }));
// accessControl (callerTierIdentity, clientSafeMessage) is pure — use the real module
// so httpKit's error() path keeps clientSafeMessage. Only the tier/backend + user context
// need controlling, and those are mocked above.
vi.mock('../../../../lib/ai-client/index.js', () => ({ DEFAULT_MODEL: 'gemini-2.5-flash' }));
// Stub the adapter so importing the route never pulls the heavy aiBackends provider
// chain — the pre-start gate tests return before any generation.
vi.mock('../ai/opedAdapter.js', () => ({ createWebOpEdAdapter: () => ({ generateText: vi.fn() }) }));

// isSafeId comes from fileIO; mock it to the SAME whitelist as fileIO's SAFE_ID_RE
// (/^[a-zA-Z0-9_-]+$/) so this test never pulls the heavy fileIO backend chain.
// fetchUrlContent (t/2807) is also mocked here so the URL-source path is controllable
// without the real network/SSRF stack (that stack is covered by t720Security.test.ts).
const { fetchUrlContent } = vi.hoisted(() => ({ fetchUrlContent: vi.fn() }));
// t/2893: oped.ts now imports the run-control store fns (re-exported via fileIO) — stub them.
const { upsertOpedRun, countRunningOpedRuns, getOpedRun } = vi.hoisted(() => ({
  upsertOpedRun: vi.fn(async () => {}),
  countRunningOpedRuns: vi.fn(async () => 0),   // no existing runs → create passes the concurrency gate
  getOpedRun: vi.fn(async () => null),          // unknown run → status GET 404s
}));
vi.mock('../storage/fileIO.js', () => ({
  isSafeId: (v: string) => !!v && /^[a-zA-Z0-9_-]+$/.test(v),
  fetchUrlContent,
  upsertOpedRun, countRunningOpedRuns, getOpedRun,
}));

// t/2807: controllable generator so the URL happy-path can assert the request handed to
// the core carries sourceMaterial, without driving real AI generation.
const { generateOpEdSet } = vi.hoisted(() => ({ generateOpEdSet: vi.fn() }));
vi.mock('../../../../lib/oped/generate.js', () => ({ generateOpEdSet }));

import { registerOpedRoutes } from '../routes/oped.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void> | void;

function makeRouter() {
  const handlers: Record<string, Handler> = {};
  const reg = (m: string) => (p: string, h: Handler) => { handlers[`${m} ${p}`] = h; };
  return { router: { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), del: reg('DELETE') }, handlers };
}

function fakeReq(url: string): IncomingMessage {
  return { url } as IncomingMessage;
}

function fakeRes(): ServerResponse & { _status?: number; _body?: string } {
  const res = {
    writeHead: vi.fn((s: number) => { res._status = s; }),
    end: vi.fn((b?: string) => { res._body = b; }),
    setHeader: vi.fn(),
    // SSE path (t/2807 URL happy-path drives the stream): write/on must exist.
    write: vi.fn(),
    on: vi.fn(),
  } as unknown as ServerResponse & { _status?: number; _body?: string };
  return res;
}

describe('/api/oped-sets routes (t/2573)', () => {
  let handlers: Record<string, Handler>;
  beforeEach(() => {
    listOpedSets.mockReset(); loadOpedSet.mockReset(); deleteOpedSet.mockReset(); getOpedSetsQuotaStatus.mockReset(); finalizeOpedSet.mockReset();
    const r = makeRouter();
    registerOpedRoutes(r.router as never, {} as never);
    handlers = r.handlers;
  });

  it('GET /api/oped-sets returns the store summaries', async () => {
    const rows = [{ set_id: 's1', topic: 'AI safety', camps: ['acc', 'saf'], voice_count: 2, created_at: 'c', updated_at: 'u' }];
    listOpedSets.mockResolvedValue(rows);
    const res = fakeRes();
    await handlers['GET /api/oped-sets'](fakeReq('/api/oped-sets'), res, undefined);
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body!)).toEqual(rows);
  });

  it('GET /api/oped-sets/quota-status returns the store quota status', async () => {
    const status = { allowed: true, resource: 'opeds', current: 2, limit: 15 };
    getOpedSetsQuotaStatus.mockResolvedValue(status);
    const res = fakeRes();
    await handlers['GET /api/oped-sets/quota-status'](fakeReq('/api/oped-sets/quota-status'), res, undefined);
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body!)).toEqual(status);
    // The literal must be registered as its own handler (not swallowed by :id) —
    // routeTable.test.ts's collision-pair gate proves the first-match ordering.
    expect(loadOpedSet).not.toHaveBeenCalled();
  });

  it('GET /api/oped-sets/:id returns the full set, partial members passing through untouched', async () => {
    const set = {
      schema_version: 1, set_id: 'set-1', topic: 'T', params: { wordCount: 800, model: 'm' }, created_at: 'c',
      opeds: [
        { pov: 'acc', status: 'complete', headline: 'H', subtitle: '', body: 'B', wordCount: 800, grounding: [] },
        { pov: 'saf', status: 'failed', headline: '', subtitle: '', body: '', wordCount: 0, grounding: [] },
        { pov: 'skp', status: 'cancelled', headline: '', subtitle: '', body: '', wordCount: 0, grounding: [] },
      ],
    };
    loadOpedSet.mockResolvedValue(set);
    const res = fakeRes();
    await handlers['GET /api/oped-sets/:id'](fakeReq('/api/oped-sets/set-1'), res, undefined);
    expect(loadOpedSet).toHaveBeenCalledWith('set-1');
    expect(res._status).toBe(200);
    // The partial-set contract: failed/cancelled member statuses survive the route verbatim.
    expect(JSON.parse(res._body!)).toEqual(set);
  });

  it('GET /api/oped-sets/:id returns 404 when the set is absent', async () => {
    loadOpedSet.mockResolvedValue(null);
    const res = fakeRes();
    await handlers['GET /api/oped-sets/:id'](fakeReq('/api/oped-sets/nope'), res, undefined);
    expect(res._status).toBe(404);
  });

  it('GET /api/oped-sets/:id rejects an unsafe set_id with 400 before any store read', async () => {
    const res = fakeRes();
    await handlers['GET /api/oped-sets/:id'](fakeReq('/api/oped-sets/evil.id'), res, undefined);
    expect(res._status).toBe(400);
    expect(loadOpedSet).not.toHaveBeenCalled();
  });

  it('DELETE /api/oped-sets/:id deletes and returns { ok: true }', async () => {
    deleteOpedSet.mockResolvedValue(undefined);
    const res = fakeRes();
    await handlers['DELETE /api/oped-sets/:id'](fakeReq('/api/oped-sets/set-1'), res, undefined);
    expect(deleteOpedSet).toHaveBeenCalledWith('set-1');
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body!)).toEqual({ ok: true });
  });

  it('DELETE /api/oped-sets/:id rejects an unsafe set_id with 400 before any store call', async () => {
    const res = fakeRes();
    await handlers['DELETE /api/oped-sets/:id'](fakeReq('/api/oped-sets/evil.id'), res, undefined);
    expect(res._status).toBe(400);
    expect(deleteOpedSet).not.toHaveBeenCalled();
  });

  // ── PUT /api/oped-sets/:id — rename (topic-only, update-only) — t/2594 ──

  const storedSet = {
    schema_version: 1, set_id: 'set-1', topic: 'Old topic', params: { wordCount: 800, model: 'm' }, created_at: 'c',
    opeds: [{ pov: 'acc', status: 'complete', headline: 'H', subtitle: 's', body: 'B', wordCount: 800, grounding: [] }],
  };

  it('PUT /api/oped-sets/:id renames the topic on an EXISTING set, members untouched', async () => {
    loadOpedSet.mockResolvedValue(structuredClone(storedSet));
    finalizeOpedSet.mockResolvedValue(undefined);
    const res = fakeRes();
    await handlers['PUT /api/oped-sets/:id'](fakeReq('/api/oped-sets/set-1'), res, { topic: 'New topic' });
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body!)).toEqual({ ok: true });
    // Only topic changed; every member passed through verbatim.
    expect(finalizeOpedSet).toHaveBeenCalledWith({ ...storedSet, topic: 'New topic' });
  });

  // ── t/4927: rename refreshes an existing public share in place ──

  it('PUT /api/oped-sets/:id calls refreshOpedShareIfShared(id) after the rename persists', async () => {
    loadOpedSet.mockResolvedValue(structuredClone(storedSet));
    finalizeOpedSet.mockResolvedValue(undefined);
    refreshOpedShareIfShared.mockResolvedValue(true);
    const res = fakeRes();
    await handlers['PUT /api/oped-sets/:id'](fakeReq('/api/oped-sets/set-1'), res, { topic: 'New topic' });
    expect(res._status).toBe(200);
    expect(refreshOpedShareIfShared).toHaveBeenCalledWith('set-1');
  });

  it('PUT /api/oped-sets/:id still returns 200/{ok:true} and logs a WARN when the refresh rejects (best-effort)', async () => {
    loadOpedSet.mockResolvedValue(structuredClone(storedSet));
    finalizeOpedSet.mockResolvedValue(undefined);
    refreshOpedShareIfShared.mockRejectedValueOnce(new Error('refresh boom'));
    serverWarn.mockClear();
    const res = fakeRes();
    await handlers['PUT /api/oped-sets/:id'](fakeReq('/api/oped-sets/set-1'), res, { topic: 'New topic' });
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body!)).toEqual({ ok: true });
    expect(serverWarn).toHaveBeenCalledWith(
      expect.objectContaining({ setId: 'set-1' }),
      expect.stringContaining('refresh'),
    );
  });

  it('PUT /api/oped-sets/:id applies ONLY topic — ignores other body fields (never mutates members)', async () => {
    loadOpedSet.mockResolvedValue(structuredClone(storedSet));
    finalizeOpedSet.mockResolvedValue(undefined);
    const res = fakeRes();
    // Client sends a full OpEdSet body with tampered members + a new topic.
    await handlers['PUT /api/oped-sets/:id'](fakeReq('/api/oped-sets/set-1'), res, {
      ...storedSet, topic: 'Renamed', opeds: [{ pov: 'skp', status: 'complete', headline: 'HACKED', subtitle: '', body: 'HACKED', wordCount: 1, grounding: [] }],
    });
    expect(res._status).toBe(200);
    // Persisted set keeps the STORED members; only topic is taken from the body.
    expect(finalizeOpedSet).toHaveBeenCalledWith({ ...storedSet, topic: 'Renamed' });
  });

  it('PUT /api/oped-sets/:id returns 404 for an absent set — never creates', async () => {
    loadOpedSet.mockResolvedValue(null);
    const res = fakeRes();
    await handlers['PUT /api/oped-sets/:id'](fakeReq('/api/oped-sets/ghost'), res, { topic: 'X' });
    expect(res._status).toBe(404);
    expect(finalizeOpedSet).not.toHaveBeenCalled();
  });

  it('PUT /api/oped-sets/:id rejects an empty/blank topic with 400', async () => {
    const res = fakeRes();
    await handlers['PUT /api/oped-sets/:id'](fakeReq('/api/oped-sets/set-1'), res, { topic: '   ' });
    expect(res._status).toBe(400);
    expect(loadOpedSet).not.toHaveBeenCalled();
    expect(finalizeOpedSet).not.toHaveBeenCalled();
  });

  it('PUT /api/oped-sets/:id rejects an unsafe set_id with 400 before any store call', async () => {
    const res = fakeRes();
    await handlers['PUT /api/oped-sets/:id'](fakeReq('/api/oped-sets/evil.id'), res, { topic: 'New' });
    expect(res._status).toBe(400);
    expect(loadOpedSet).not.toHaveBeenCalled();
    expect(finalizeOpedSet).not.toHaveBeenCalled();
  });
});

// ── POST /api/oped-sets create pre-start gate + run-status (t/2610) ──
// These assert the pre-start contract, which returns BEFORE the SSE stream / any
// generation — so no lib/oped generator mock is needed. The SSE happy-path is covered
// by the AC's live smoke; the real-socket abort→cancel+partial-finalize test is routed
// through TL (gate-integrity, real http.Server + aborted fetch).
describe('POST /api/oped-sets create pre-start gate (t/2610)', () => {
  let handlers: Record<string, Handler>;
  const validBody = { topic: 'AI safety', params: { model: 'gemini-2.5-flash', wordCount: 800 }, povs: ['accelerationist', 'safetyist'] };
  beforeEach(() => {
    isAnonymousUser.mockReset().mockReturnValue(false);
    getStorageUserId.mockReset().mockReturnValue('user-1');
    getOpedSetsQuotaStatus.mockReset().mockResolvedValue({ allowed: true, resource: 'opeds', current: 0, limit: 15 });
    finalizeOpedSet.mockReset();
    getCurrentUser.mockReset().mockReturnValue({ principalName: 'u', idp: 'aad', isAnonymous: false });
    resolveTier.mockReset().mockReturnValue({ level: 'platform', allowedBackends: ['gemini', 'claude', 'groq'], pinnedModel: undefined });
    resolveBackend.mockReset().mockReturnValue('gemini');
    isRegisteredModel.mockReset().mockReturnValue(true);
    fetchUrlContent.mockReset();
    generateOpEdSet.mockReset();
    const r = makeRouter();
    registerOpedRoutes(r.router as never, {} as never);
    handlers = r.handlers;
  });

  it('403 when the caller’s tier does not allow the selected backend (no premium via params.model)', async () => {
    resolveTier.mockReturnValue({ level: 'platform', allowedBackends: ['gemini'], pinnedModel: undefined });
    resolveBackend.mockReturnValue('claude'); // the requested model resolves to a disallowed backend
    const res = fakeRes();
    await handlers['POST /api/oped-sets'](fakeReq('/api/oped-sets'), res, { ...validBody, params: { model: 'claude-opus-4', wordCount: 800 } });
    expect(res._status).toBe(403);
    // t/2635: entitlement now flows through the shared enforceBackendAllowed
    // (routes/generationContext.ts), whose 403 carries the tier context — asserting the
    // body shape locks the op-ed route onto the ONE consolidated gate, not the old mirror.
    expect(JSON.parse(res._body ?? '{}')).toMatchObject({ tier_level: 'platform', requested_backend: 'claude' });
    expect(getOpedSetsQuotaStatus).not.toHaveBeenCalled(); // gated before quota + any generation
  });

  it('free tier is PINNED — a premium request is not 403’d, it proceeds on the pinned backend (t/2635)', async () => {
    // The consolidation's core behaviour via resolveGenerationContext: a free user asking for a
    // premium model is served the tier's pinned model (an allowed backend), NOT rejected. We stop
    // at the quota gate (429) to prove entitlement passed without kicking off real generation.
    resolveTier.mockReturnValue({ level: 'free', allowedBackends: ['gemini'], pinnedModel: 'gemini-2.5-flash' });
    resolveBackend.mockReturnValue('gemini'); // effectiveModel = pinned gemini-2.5-flash → gemini backend
    getOpedSetsQuotaStatus.mockResolvedValue({ allowed: false, resource: 'opeds', current: 15, limit: 15 });
    // Free-tier limit-keying calls getClientIp, so this req needs headers + socket (bare fakeReq doesn't).
    const freeReq = { url: '/api/oped-sets', headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage;
    const res = fakeRes();
    await handlers['POST /api/oped-sets'](freeReq, res, { ...validBody, params: { model: 'claude-opus-4', wordCount: 800 } });
    expect(res._status).toBe(429); // reached quota ⇒ entitlement did NOT 403 the pinned free user
    expect(getOpedSetsQuotaStatus).toHaveBeenCalled();
  });

  it('403 for anonymous users (no anonymous op-ed tier)', async () => {
    isAnonymousUser.mockReturnValue(true);
    const res = fakeRes();
    await handlers['POST /api/oped-sets'](fakeReq('/api/oped-sets'), res, validBody);
    expect(res._status).toBe(403);
    expect(getOpedSetsQuotaStatus).not.toHaveBeenCalled();
  });

  it('400 when the model is not a registered id — rejected before any generation (t/2687)', async () => {
    // Prevents an unregistered model (e.g. a stale/misconfigured default) from reaching the
    // provider and silently failing mid-generation ("voice failed — 0 words").
    isRegisteredModel.mockReturnValue(false);
    const res = fakeRes();
    await handlers['POST /api/oped-sets'](fakeReq('/api/oped-sets'), res, { ...validBody, params: { model: 'gemini-flash-lite-latest', wordCount: 800 } });
    expect(res._status).toBe(400);
    expect(getOpedSetsQuotaStatus).not.toHaveBeenCalled(); // gated before quota + any generation
  });

  it('400 on a file/PDF/DOCX `source` upload — still desktop-only (t/2807 keeps this blocked)', async () => {
    const res = fakeRes();
    await handlers['POST /api/oped-sets'](fakeReq('/api/oped-sets'), res, { ...validBody, source: { name: 'doc.pdf' } });
    expect(res._status).toBe(400);
    expect(fetchUrlContent).not.toHaveBeenCalled();
  });

  // t/2807 Part 1: URL source is fetched via the hardened fileIO.fetchUrlContent and
  // flows into the generator as sourceMaterial.
  it('URL source: fetches via fetchUrlContent and hands sourceMaterial to the generator', async () => {
    fetchUrlContent.mockResolvedValue({ content: '# Fetched article\nBody.' });
    let capturedReq: { sourceMaterial?: string } | undefined;
    generateOpEdSet.mockImplementation(async function* (req: { set_id: string; topic: string; params: unknown; sourceMaterial?: string }) {
      capturedReq = req;
      yield { type: 'complete', set: { schema_version: 1, set_id: req.set_id, topic: req.topic, params: req.params, created_at: 'c', opeds: [] } };
    });
    finalizeOpedSet.mockResolvedValue(undefined);
    const res = fakeRes();
    await handlers['POST /api/oped-sets'](fakeReq('/api/oped-sets'), res, { ...validBody, url: 'https://example.com/article' });
    // Fetch happened AFTER the gate (quota was checked) and BEFORE generation.
    expect(getOpedSetsQuotaStatus).toHaveBeenCalled();
    expect(fetchUrlContent).toHaveBeenCalledWith('https://example.com/article');
    expect(res._status).toBe(200); // SSE committed → generation ran
    expect(capturedReq?.sourceMaterial).toBe('# Fetched article\nBody.');
  });

  // t/2807 MUST: a fetch failure returns a clean HTTP error and NEVER proceeds with
  // empty sourceMaterial (the t/2722 empty-source regression). No SSE, no generation.
  it('URL source: a fetch failure returns 502 and does NOT start generation', async () => {
    fetchUrlContent.mockResolvedValue({ content: '', error: 'blocked host' });
    const res = fakeRes();
    await handlers['POST /api/oped-sets'](fakeReq('/api/oped-sets'), res, { ...validBody, url: 'https://169.254.169.254/latest/meta-data' });
    expect(res._status).toBe(502);
    expect(generateOpEdSet).not.toHaveBeenCalled();
    expect(finalizeOpedSet).not.toHaveBeenCalled();
  });

  it('URL source: fetch runs only AFTER the quota gate — an over-quota caller never triggers a fetch', async () => {
    getOpedSetsQuotaStatus.mockResolvedValue({ allowed: false, resource: 'opeds', current: 15, limit: 15 });
    const res = fakeRes();
    await handlers['POST /api/oped-sets'](fakeReq('/api/oped-sets'), res, { ...validBody, url: 'https://example.com/article' });
    expect(res._status).toBe(429);
    expect(fetchUrlContent).not.toHaveBeenCalled();
  });

  it('400 when topic is missing/blank', async () => {
    const res = fakeRes();
    await handlers['POST /api/oped-sets'](fakeReq('/api/oped-sets'), res, { ...validBody, topic: '   ' });
    expect(res._status).toBe(400);
  });

  it('400 when no voices are selected', async () => {
    const res = fakeRes();
    await handlers['POST /api/oped-sets'](fakeReq('/api/oped-sets'), res, { ...validBody, povs: [] });
    expect(res._status).toBe(400);
  });

  it('400 when params.model is missing', async () => {
    const res = fakeRes();
    await handlers['POST /api/oped-sets'](fakeReq('/api/oped-sets'), res, { topic: 'x', povs: ['accelerationist'], params: { wordCount: 800 } });
    expect(res._status).toBe(400);
  });

  it('wordCount is OPTIONAL — a default create (no wordCount ⇒ outlet band) passes validation, not a 400 (t/2685)', async () => {
    // Regression for the UAT bug: the default create ("Use outlet band") sends no wordCount and
    // was wrongly 400'd. Prove it now passes validation by advancing to the quota gate (429) —
    // if wordCount were still required this would 400 BEFORE quota is ever checked.
    getOpedSetsQuotaStatus.mockResolvedValue({ allowed: false, resource: 'opeds', current: 15, limit: 15 });
    const res = fakeRes();
    await handlers['POST /api/oped-sets'](fakeReq('/api/oped-sets'), res, { topic: 'x', povs: ['accelerationist'], params: { model: 'gemini-2.5-flash' } });
    expect(res._status).toBe(429);
    expect(JSON.parse(res._body!).error).toBe('quota_exceeded');
  });

  it('429 quota_exceeded when the op-ed quota is full — BEFORE any generation', async () => {
    getOpedSetsQuotaStatus.mockResolvedValue({ allowed: false, resource: 'opeds', current: 15, limit: 15 });
    const res = fakeRes();
    await handlers['POST /api/oped-sets'](fakeReq('/api/oped-sets'), res, validBody);
    expect(res._status).toBe(429);
    expect(JSON.parse(res._body!).error).toBe('quota_exceeded');
    expect(finalizeOpedSet).not.toHaveBeenCalled();
  });

  // t/3858: outlet validation — unknown value → 400 before the run starts; absent/known → valid
  it('400 when params.outlet is an unrecognised value (typo stops before the run, not after) (t/3858)', async () => {
    const res = fakeRes();
    await handlers['POST /api/oped-sets'](fakeReq('/api/oped-sets'), res, {
      ...validBody, params: { ...validBody.params, outlet: 'TechPolicyPres' },
    });
    expect(res._status).toBe(400);
    const body = JSON.parse(res._body!);
    expect(body.error).toContain('TechPolicyPres');
    expect(body.error).toContain('Valid:');
    expect(finalizeOpedSet).not.toHaveBeenCalled();
  });

  it('absent outlet passes validation — band default applies, not a 400 (t/3858 AC: absent is valid)', async () => {
    // The common case: a default create sends no outlet. This MUST pass the outlet check
    // and advance to the quota gate. A strict implementation that rejects absent is the AC's
    // named failure mode, so gate on the quota 429 (not just "not 400").
    getOpedSetsQuotaStatus.mockResolvedValue({ allowed: false, resource: 'opeds', current: 15, limit: 15 });
    const res = fakeRes();
    await handlers['POST /api/oped-sets'](fakeReq('/api/oped-sets'), res, {
      topic: 'x', povs: ['accelerationist'], params: { model: 'gemini-2.5-flash' },
    });
    expect(res._status).toBe(429);
  });

  it('known outlet passes validation (t/3858)', async () => {
    getOpedSetsQuotaStatus.mockResolvedValue({ allowed: false, resource: 'opeds', current: 15, limit: 15 });
    const res = fakeRes();
    await handlers['POST /api/oped-sets'](fakeReq('/api/oped-sets'), res, {
      ...validBody, params: { ...validBody.params, outlet: 'WashingtonPost' },
    });
    expect(res._status).toBe(429); // reached quota ⇒ outlet validation passed
  });

  // t/3993: parseOpEdRequest gate — unknown tag (pov not in povs → always fails regardless of registry)
  it('400 when tagSelection.pov is not in the requested povs — rejected before quota (t/3993)', async () => {
    const res = fakeRes();
    await handlers['POST /api/oped-sets'](fakeReq('/api/oped-sets'), res, {
      ...validBody, // povs: ['accelerationist', 'safetyist']
      params: { ...validBody.params, tagSelection: { pov: 'skeptic', tag: 'critical', mode: 'scope' } },
    });
    expect(res._status).toBe(400);
    expect(getOpedSetsQuotaStatus).not.toHaveBeenCalled(); // gated before quota
  });

  it('untagged request passes parseOpEdRequest unchanged — advances to quota gate (t/3993)', async () => {
    // No tagSelection → parseOpEdRequest is a no-op; prove it passes by reaching the quota 429.
    getOpedSetsQuotaStatus.mockResolvedValue({ allowed: false, resource: 'opeds', current: 15, limit: 15 });
    const res = fakeRes();
    await handlers['POST /api/oped-sets'](fakeReq('/api/oped-sets'), res, validBody);
    expect(res._status).toBe(429);
    expect(JSON.parse(res._body!).error).toBe('quota_exceeded');
  });

  it('GET /api/oped-runs/:runId returns 404 for an unknown run', async () => {
    const res = fakeRes();
    await handlers['GET /api/oped-runs/:runId'](fakeReq('/api/oped-runs/nope-1'), res, undefined);
    expect(res._status).toBe(404);
  });
});
