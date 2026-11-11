// @vitest-environment node
//
// t/3581 — POST /api/inquiry + GET /api/inquiry/:jobId route behavior. The job-store internals are
// covered by inquiryJobs.test.ts; here the collaborators are mocked so we test the ROUTE logic:
// authenticated-only gate (ADR-0002 #8), strict validation, model-override registry check, rate
// limit, concurrency cap, idempotency, and the GET state / persisted-result / 404 paths.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const h = vi.hoisted(() => ({
  user: null as { principalName: string; idp: string; isAnonymous: boolean } | null,
  storageUserId: 'alice',
  rpmAllowed: true,
  backendBlocked: false,
  registered: true,
  running: 0,
  idempotent: null as { jobId: string } | null,
  jobById: new Map<string, Record<string, unknown>>(),
  hasById: new Set<string>(),
  persisted: new Map<string, unknown>(),
  summaries: [] as unknown[],
  /** Controls the markJobFailedIfStale mock (t/3728 tier-3).
   *  false = null (no record / past window); 'stale' = failed verdict; 'live' = live verdict. */
  markStaleReturn: false as false | 'stale' | 'live',
  /** Controls durable cap/idempotency mocks (t/182). */
  capCountError: null as null | { reason: string },
  capCount: 0,
  durableIdempotent: null as { jobId: string } | null,
}));

vi.mock('../security/userContext.js', () => ({
  getCurrentUser: () => h.user,
  getStorageUserId: () => h.storageUserId,
}));
vi.mock('../security/rateLimiter.js', () => ({
  checkRequestRate: () => ({ allowed: h.rpmAllowed, retryAfterMs: 1000 }),
}));
vi.mock('../routes/generationContext.js', () => ({
  resolveGenerationContext: () => ({ tier: { limits: { requestsPerMinute: 100 } }, limitKey: 'alice', backend: 'gemini' }),
  enforceBackendAllowed: (res: ServerResponse) => { if (h.backendBlocked) { (res as unknown as { writeHead: (n: number) => void }).writeHead(403); (res as unknown as { end: (s?: string) => void }).end(JSON.stringify({ error: 'backend' })); return true; } return false; },
}));
vi.mock('../ai/aiBackends.js', () => ({ isRegisteredModel: () => h.registered }));
const startInquiryJob = vi.fn((args: { userId: string }) => { const jobId = 'job-new'; h.jobById.set(jobId, { jobId, status: 'queued' }); return { jobId, userId: args.userId, status: 'queued', progressPct: 0, resultId: null, error: null }; });
const dropInquiryJob = vi.fn((jobId: string) => { h.jobById.delete(jobId); });
vi.mock('../inquiryJobs.js', async () => ({
  MAX_CONCURRENT_INQUIRY_JOBS: 1,
  INQUIRY_BOOT_ID: 'boot-test',
  startInquiryJob: (args: { userId: string }) => startInquiryJob(args),
  getInquiryJob: (jobId: string, userId: string) => { const j = h.jobById.get(jobId); return j && (j.userId === userId || j.userId === undefined) ? j : null; },
  hasInquiryJob: (jobId: string) => h.hasById.has(jobId) || h.jobById.has(jobId),
  countRunningInquiryJobs: () => h.running,
  findIdempotentInquiryJob: () => h.idempotent,
  deriveTruncation: (r: { truncated?: boolean }) => ({ truncated: !!r.truncated, terminationReason: r.truncated ? 'api_ceiling' : undefined }),
  buildPollView: (p: { jobId: string; status: string; resultId: string | null; error: string | null; debateId: string | null; terminationReason: string | null }) => ({
    jobId: p.jobId, status: p.status, progressPct: 0, terminationReason: p.terminationReason, resultId: p.resultId, error: p.error, debateId: p.debateId,
  }),
  // t/3728 tier-3: three-state mock matching InquiryTier3Result discriminated union.
  markJobFailedIfStale: async (_jobId: string) => {
    if (h.markStaleReturn === 'stale') return { verdict: 'failed' as const, error: { code: 'restart', message: 'Server restarted while this inquiry was in progress.' } };
    if (h.markStaleReturn === 'live') return { verdict: 'live' as const, record: { jobId: _jobId, userId: 'alice', bootId: 'boot-x', status: 'debating', lastHeartbeatAt: new Date().toISOString(), resultId: null, error: null, debateId: null, startedAt: Date.now() - 5_000 } };
    return null;
  },
  // t/4897 (Quality review t/4897#4): use the REAL classifier, not a hand-rolled status
  // list — a hand-rolled list can drift from lib/inquiry/jobStatus.ts and silently let the
  // 409-while-running test pass even if the route started checking only 'debating'.
  isTerminalStatus: (await vi.importActual<typeof import('../../../../lib/inquiry/index.js')>('../../../../lib/inquiry/index.js')).isTerminalStatus,
  dropInquiryJob: (jobId: string) => dropInquiryJob(jobId),
}));
vi.mock('../storage/jobCapChecker.js', () => ({
  countUserJobRecords: async (_userId: string, _kind: string, _isRunning: (r: unknown) => boolean) => {
    if (h.capCountError) return { count: null, error: h.capCountError };
    return { count: h.capCount, error: null };
  },
  findRunningJobByIdempotencyKey: async (_userId: string, _kind: string, idempotencyKey: string | undefined, _debateId: string | undefined, _isRunning: (r: unknown) => boolean) => {
    if (!idempotencyKey) return null;
    return h.durableIdempotent;
  },
  reserveSubmissionSlot: (_userId: string, _kind: string, _debateId: string | undefined) => true, // Always allow in tests
  releaseSubmissionReservation: (_userId: string, _kind: string, _debateId: string | undefined) => {},
}));
const renameInquiryResult = vi.fn(async (jobId: string, title: string) => { h.persisted.set(jobId, { ...(h.persisted.get(jobId) as object ?? {}), title }); });
const deleteInquiryResult = vi.fn(async (jobId: string) => { h.persisted.delete(jobId); });
vi.mock('../storage/inquiryResultStore.js', () => ({
  loadInquiryResult: async (jobId: string) => h.persisted.get(jobId) ?? null,
  listInquiryResults: async () => h.summaries,
  renameInquiryResult: (jobId: string, title: string) => renameInquiryResult(jobId, title),
  deleteInquiryResult: (jobId: string) => deleteInquiryResult(jobId),
}));
vi.mock('../inquiryPipelineDeps.js', () => ({ buildInquiryRunPipeline: () => vi.fn() }));
const recordMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: recordMock }) }));

import { createRouter, type Handler } from '../httpKit.js';
import { registerInquiryRoutes } from '../routes/inquiry.js';

function res() {
  const r = { statusCode: 0, body: '', writableEnded: false, headersSent: false,
    writeHead(s: number) { r.statusCode = s; r.headersSent = true; return r; },
    setHeader() {}, write() { return true; },
    end(b?: string) { r.body = b ?? ''; r.writableEnded = true; return r; } };
  return r as unknown as ServerResponse & { statusCode: number; body: string };
}
function req(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { url, method: 'POST', headers } as unknown as IncomingMessage;
}
function handler(method: string, path: string): Handler {
  const routes: { method: string; path: string; handler: Handler }[] = [];
  registerInquiryRoutes(createRouter(routes as never), {} as never);
  return routes.find(r => r.method === method && r.path === path)!.handler;
}
const AUTHED = { principalName: 'alice@example.com', idp: 'aad', isAnonymous: false };
const VALID = { question: 'What counts as an AI harm?', fidelity: 'standard' };

beforeEach(() => {
  h.user = AUTHED; h.storageUserId = 'alice'; h.rpmAllowed = true; h.backendBlocked = false;
  h.registered = true; h.running = 0; h.idempotent = null; h.markStaleReturn = false;
  h.capCountError = null; h.capCount = 0; h.durableIdempotent = null;
  h.jobById.clear(); h.hasById.clear(); h.persisted.clear(); h.summaries = [];
  startInquiryJob.mockClear();
  recordMock.mockClear();
  dropInquiryJob.mockClear();
  renameInquiryResult.mockClear();
  deleteInquiryResult.mockClear();
});

describe('t/3581 — POST /api/inquiry', () => {
  const post = () => handler('POST', '/api/inquiry');

  it('401 when anonymous (authenticated-only, ADR-0002 #8)', async () => {
    h.user = { ...AUTHED, isAnonymous: true };
    const r = res(); await post()(req('/api/inquiry'), r, VALID);
    expect(r.statusCode).toBe(401);
    expect(startInquiryJob).not.toHaveBeenCalled();
  });

  it('401 when no user context at all', async () => {
    h.user = null;
    const r = res(); await post()(req('/api/inquiry'), r, VALID);
    expect(r.statusCode).toBe(401);
  });

  it('400 on an unknown key (strict schema)', async () => {
    const r = res(); await post()(req('/api/inquiry'), r, { ...VALID, situationID: 'x' }); // wrong case
    expect(r.statusCode).toBe(400);
    expect(startInquiryJob).not.toHaveBeenCalled();
  });

  it('400 on an unregistered model override', async () => {
    h.registered = false;
    const r = res(); await post()(req('/api/inquiry'), r, { ...VALID, models: { debaters: 'gemini-retired' } });
    expect(r.statusCode).toBe(400);
    expect(startInquiryJob).not.toHaveBeenCalled();
  });

  it('429 when the concurrency cap is already reached', async () => {
    h.capCount = 1;
    const r = res(); await post()(req('/api/inquiry'), r, VALID);
    expect(r.statusCode).toBe(429);
    expect(startInquiryJob).not.toHaveBeenCalled();
  });

  it('503 when the cap checker backend fails (fail-closed: reject new request)', async () => {
    h.capCountError = { reason: 'list_failed' };
    const r = res(); await post()(req('/api/inquiry'), r, VALID);
    expect(r.statusCode).toBe(503);
    expect(startInquiryJob).not.toHaveBeenCalled();
  });

  it('429 when rate-limited', async () => {
    h.rpmAllowed = false;
    const r = res(); await post()(req('/api/inquiry'), r, VALID);
    expect(r.statusCode).toBe(429);
  });

  it('idempotency: returns the in-window jobId without starting a new job', async () => {
    h.durableIdempotent = { jobId: 'job-existing' };
    const r = res(); await post()(req('/api/inquiry', { 'idempotency-key': 'k1' }), r, VALID);
    expect(r.statusCode).toBe(202);
    expect(JSON.parse(r.body)).toEqual({ jobId: 'job-existing' });
    expect(startInquiryJob).not.toHaveBeenCalled();
  });

  it('valid → 202 { jobId } and starts the job', async () => {
    const r = res(); await post()(req('/api/inquiry'), r, VALID);
    expect(r.statusCode).toBe(202);
    expect(JSON.parse(r.body)).toEqual({ jobId: 'job-new' });
    expect(startInquiryJob).toHaveBeenCalledTimes(1);
  });

  // t/3724 change 3: creation event, independent of t/3728.
  it('t/3724 — records inquiry.created after startInquiryJob succeeds', async () => {
    const r = res(); await post()(req('/api/inquiry'), r, VALID);
    expect(r.statusCode).toBe(202);
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'inquiry.created', level: 'info',
      data: expect.objectContaining({ jobId: 'job-new', fidelity: 'standard', hasIdempotencyKey: false }),
    }));
  });

  it('t/3724 — does NOT record inquiry.created when the request is rejected before starting a job', async () => {
    h.capCount = 1; // 429 concurrency cap
    const r = res(); await post()(req('/api/inquiry'), r, VALID);
    expect(r.statusCode).toBe(429);
    expect(recordMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'inquiry.created' }));
  });
});

describe('t/3581 — GET /api/inquiry/:jobId', () => {
  const get = () => handler('GET', '/api/inquiry/:jobId');

  it('401 when anonymous', async () => {
    h.user = null;
    const r = res(); await get()(req('/api/inquiry/job-1'), r, undefined);
    expect(r.statusCode).toBe(401);
  });

  it('returns the job state for a running job', async () => {
    h.jobById.set('job-1', { jobId: 'job-1', userId: 'alice', status: 'debating', progressPct: 40, resultId: null, error: null });
    const r = res(); await get()(req('/api/inquiry/job-1'), r, undefined);
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).status).toBe('debating');
  });

  it('includes the persisted result on a terminal job', async () => {
    h.jobById.set('job-1', { jobId: 'job-1', userId: 'alice', status: 'done', progressPct: 100, resultId: 'job-1', error: null });
    h.persisted.set('job-1', { schemaVersion: 1, singleRunCaveat: 'one run' });
    const r = res(); await get()(req('/api/inquiry/job-1'), r, undefined);
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).result).toMatchObject({ schemaVersion: 1 });
  });

  it('cross-restart fallback: job absent from map → serves the persisted result', async () => {
    h.persisted.set('job-gone', { truncated: true, schemaVersion: 1 });
    const r = res(); await get()(req('/api/inquiry/job-gone'), r, undefined);
    expect(r.statusCode).toBe(200);
    const parsed = JSON.parse(r.body);
    expect(parsed.status).toBe('done_truncated');       // derived from the result's truncation
    expect(parsed.terminationReason).toBe('api_ceiling');
    expect(parsed.result).toBeTruthy();
  });

  it('404 when neither a job nor a persisted result exists', async () => {
    const r = res(); await get()(req('/api/inquiry/nope'), r, undefined);
    expect(r.statusCode).toBe(404);
  });
});

describe('t/3619 — GET /api/inquiry (My Questions list)', () => {
  const get = () => handler('GET', '/api/inquiry');

  it('401 when anonymous (authenticated-only, ADR-0002 #8)', async () => {
    h.user = { ...AUTHED, isAnonymous: true };
    const r = res(); await get()(req('/api/inquiry'), r, undefined);
    expect(r.statusCode).toBe(401);
  });

  it('401 when no user context at all', async () => {
    h.user = null;
    const r = res(); await get()(req('/api/inquiry'), r, undefined);
    expect(r.statusCode).toBe(401);
  });

  it('returns the caller\'s inquiry summaries as a bare array (mirrors /api/debates shape)', async () => {
    h.summaries = [
      { jobId: 'job-1', question: 'What counts as an AI harm?', debateId: 'deb-1', truncated: false, createdAt: '2026-02-01T00:00:00.000Z' },
      { jobId: 'job-2', question: 'Is alignment tractable?', debateId: null, truncated: true, terminationReason: 'api_ceiling', createdAt: '2026-01-01T00:00:00.000Z' },
    ];
    const r = res(); await get()(req('/api/inquiry'), r, undefined);
    expect(r.statusCode).toBe(200);
    const parsed = JSON.parse(r.body);
    expect(Array.isArray(parsed)).toBe(true); // bare array, not an { items } envelope
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ jobId: 'job-1', question: 'What counts as an AI harm?' });
  });

  it('returns an empty array when the caller has no inquiries', async () => {
    const r = res(); await get()(req('/api/inquiry'), r, undefined);
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual([]);
  });
});

describe('t/3728 — tier-3 fallback ordering (AC arms)', () => {
  const get = () => handler('GET', '/api/inquiry/:jobId');

  it('arm 1 — stale heartbeat: absent from map + no result → fails with restart error, NOT 404', async () => {
    h.markStaleReturn = 'stale';  // markJobFailedIfStale returns failed verdict (heartbeat expired)
    const r = res(); await get()(req('/api/inquiry/job-stale'), r, undefined);
    expect(r.statusCode).toBe(200);
    const parsed = JSON.parse(r.body);
    expect(parsed.status).toBe('failed');
    expect(typeof parsed.error).toBe('string');
    expect(parsed.debateId).toBe(null);   // shape-compatible with buildPollView (SO condition 5)
  });

  it('arm 2 — fresh heartbeat: absent from map + no result → 200 in-progress (deploy overlap — must NOT 404)', async () => {
    h.markStaleReturn = 'live';  // markJobFailedIfStale returns live verdict (another process owns the job)
    const r = res(); await get()(req('/api/inquiry/job-fresh'), r, undefined);
    expect(r.statusCode).toBe(200);
    const parsed = JSON.parse(r.body);
    expect(parsed.status).toBe('debating');   // live record's own status — honest "still running"
    expect(parsed.error).toBe(null);
  });

  it('arm 3 — unknown jobId → 404 (no in-map entry, no persisted result, no job record)', async () => {
    const r = res(); await get()(req('/api/inquiry/no-such-job'), r, undefined);
    expect(r.statusCode).toBe(404);
  });

  // This is the critical regression: if tier 3 ever ran before tier 2, a completed job would report
  // `failed` and this arm would catch it. h.markStaleReturn=true ensures tier 3 would fire if reached.
  it('arm 4 — completed job (tier 2 precedence): serves the persisted result, tier 3 never consulted', async () => {
    h.persisted.set('job-done', { schemaVersion: 1, truncated: false });
    h.markStaleReturn = 'stale';  // would fire if tier ordering were wrong
    const r = res(); await get()(req('/api/inquiry/job-done'), r, undefined);
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).status).toBe('done');   // NOT 'failed' — tier 2 wins
  });

  it("arm 5 — cross-user: another user's jobId → 404, tiers 2/3 never entered", async () => {
    h.jobById.set('job-bob', { jobId: 'job-bob', userId: 'bob', status: 'debating', progressPct: 40 });
    const r = res(); await get()(req('/api/inquiry/job-bob'), r, undefined);
    expect(r.statusCode).toBe(404);   // hasInquiryJob=true → !hasInquiryJob block skipped → straight 404
  });
});

describe('t/3724 — inquiry.not_found event', () => {
  const get = () => handler('GET', '/api/inquiry/:jobId');

  it('records inquiry.not_found with the jobId on genuine absence (no map entry, no persisted result, no durable record)', async () => {
    const r = res(); await get()(req('/api/inquiry/no-such-job'), r, undefined);
    expect(r.statusCode).toBe(404);
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'inquiry.not_found', level: 'warn',
      data: expect.objectContaining({ jobId: 'no-such-job', fallback_attempted: true, fallback_outcome: 'no_persisted_result' }),
    }));
  });

  it("does NOT record inquiry.not_found for the owned-by-other-user case — must not log that jobId", async () => {
    h.jobById.set('job-bob', { jobId: 'job-bob', userId: 'bob', status: 'debating', progressPct: 40 });
    const r = res(); await get()(req('/api/inquiry/job-bob'), r, undefined);
    expect(r.statusCode).toBe(404);
    expect(recordMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'inquiry.not_found' }));
  });

  it('does NOT record inquiry.not_found when the persisted-result fallback succeeds (tier 2)', async () => {
    h.persisted.set('job-gone', { truncated: false, schemaVersion: 1 });
    const r = res(); await get()(req('/api/inquiry/job-gone'), r, undefined);
    expect(r.statusCode).toBe(200);
    expect(recordMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'inquiry.not_found' }));
  });

  it('does NOT record inquiry.not_found when tier 3 resolves the job as failed or live', async () => {
    h.markStaleReturn = 'stale';
    const r = res(); await get()(req('/api/inquiry/job-stale'), r, undefined);
    expect(r.statusCode).toBe(200);
    expect(recordMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'inquiry.not_found' }));
  });
});

describe('t/4897 — PATCH /api/inquiry/:jobId (rename)', () => {
  const patch = () => handler('PATCH', '/api/inquiry/:jobId');

  it('401 when anonymous', async () => {
    h.user = null;
    const r = res(); await patch()(req('/api/inquiry/job-1'), r, { title: 'New title' });
    expect(r.statusCode).toBe(401);
    expect(renameInquiryResult).not.toHaveBeenCalled();
  });

  it('400 on an empty title', async () => {
    h.persisted.set('job-1', { schemaVersion: 1 });
    const r = res(); await patch()(req('/api/inquiry/job-1'), r, { title: '   ' });
    expect(r.statusCode).toBe(400);
    expect(renameInquiryResult).not.toHaveBeenCalled();
  });

  it('400 on a title over 200 characters', async () => {
    h.persisted.set('job-1', { schemaVersion: 1 });
    const r = res(); await patch()(req('/api/inquiry/job-1'), r, { title: 'x'.repeat(201) });
    expect(r.statusCode).toBe(400);
    expect(renameInquiryResult).not.toHaveBeenCalled();
  });

  it('400 when title is not a string', async () => {
    h.persisted.set('job-1', { schemaVersion: 1 });
    const r = res(); await patch()(req('/api/inquiry/job-1'), r, { title: 42 });
    expect(r.statusCode).toBe(400);
  });

  it("404 when the job isn't the caller's (or doesn't exist)", async () => {
    const r = res(); await patch()(req('/api/inquiry/no-such-job'), r, { title: 'New title' });
    expect(r.statusCode).toBe(404);
    expect(renameInquiryResult).not.toHaveBeenCalled();
  });

  it('the owner can rename: 200 and calls renameInquiryResult with the trimmed title', async () => {
    h.persisted.set('job-1', { schemaVersion: 1, title: 'Old title' });
    const r = res(); await patch()(req('/api/inquiry/job-1'), r, { title: '  New title  ' });
    expect(r.statusCode).toBe(200);
    expect(renameInquiryResult).toHaveBeenCalledWith('job-1', '  New title  ');
    expect(JSON.parse(r.body)).toEqual({ jobId: 'job-1', title: 'New title' });
  });
});

describe('t/4897 — DELETE /api/inquiry/:jobId', () => {
  const del = () => handler('DELETE', '/api/inquiry/:jobId');

  it('401 when anonymous', async () => {
    h.user = null;
    const r = res(); await del()(req('/api/inquiry/job-1'), r, undefined);
    expect(r.statusCode).toBe(401);
    expect(deleteInquiryResult).not.toHaveBeenCalled();
  });

  // t/4897 (Quality review t/4897#4): every real in-flight status, not just 'debating' — a
  // route that regressed to checking only one status would still pass a single-status test.
  it.each(['queued', 'grounding', 'debating', 'judging', 'synthesizing'])('409 while the job is still running (status: %s)', async (status) => {
    h.jobById.set('job-1', { jobId: 'job-1', userId: 'alice', status });
    const r = res(); await del()(req('/api/inquiry/job-1'), r, undefined);
    expect(r.statusCode).toBe(409);
    expect(deleteInquiryResult).not.toHaveBeenCalled();
  });

  it('a terminal (done) job in the map is still deletable — 409 only guards in-flight statuses', async () => {
    h.jobById.set('job-1', { jobId: 'job-1', userId: 'alice', status: 'done' });
    h.persisted.set('job-1', { schemaVersion: 1 });
    const r = res(); await del()(req('/api/inquiry/job-1'), r, undefined);
    expect(r.statusCode).toBe(200);
  });

  it("404 when the job isn't the caller's (or doesn't exist)", async () => {
    const r = res(); await del()(req('/api/inquiry/no-such-job'), r, undefined);
    expect(r.statusCode).toBe(404);
    expect(deleteInquiryResult).not.toHaveBeenCalled();
  });

  it("another user's job in the map → 404 (cross-user), not 409 — getInquiryJob is user-scoped", async () => {
    h.jobById.set('job-bob', { jobId: 'job-bob', userId: 'bob', status: 'debating' });
    const r = res(); await del()(req('/api/inquiry/job-bob'), r, undefined);
    expect(r.statusCode).toBe(404);
  });

  it('the owner can delete: 200, calls deleteInquiryResult, and drops the in-memory job entry', async () => {
    h.jobById.set('job-1', { jobId: 'job-1', userId: 'alice', status: 'done' });
    h.persisted.set('job-1', { schemaVersion: 1 });
    const r = res(); await del()(req('/api/inquiry/job-1'), r, undefined);
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ jobId: 'job-1', deleted: true });
    expect(deleteInquiryResult).toHaveBeenCalledWith('job-1');
    expect(dropInquiryJob).toHaveBeenCalledWith('job-1');
  });

  it('deleting a result with no in-memory job entry at all still succeeds (cross-restart durability)', async () => {
    h.persisted.set('job-gone', { schemaVersion: 1 });
    const r = res(); await del()(req('/api/inquiry/job-gone'), r, undefined);
    expect(r.statusCode).toBe(200);
    expect(deleteInquiryResult).toHaveBeenCalledWith('job-gone');
  });
});
