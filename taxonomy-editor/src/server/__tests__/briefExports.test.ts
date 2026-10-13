// @vitest-environment node
//
// t/2804 (T6, spec §5/§6) — the Brief Export REST route layer. The job runner
// (briefExportJobs.test.ts) and store (briefExportStore) are mocked so this suite pins
// the ROUTE contract: the billable-surface gates (auth, closed-phase, entitlement, PDF,
// live-snapshot), idempotency/concurrency 202-vs-429, and artifact download/delete.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

// ── Controllable collaborators ──
const { isAnonymousUser, getStorageUserId } = vi.hoisted(() => ({
  isAnonymousUser: vi.fn(() => false),
  getStorageUserId: vi.fn(() => 'user-1'),
}));
vi.mock('../security/userContext.js', () => ({ isAnonymousUser, getStorageUserId }));

const { loadDebateSession } = vi.hoisted(() => ({ loadDebateSession: vi.fn() }));
vi.mock('../storage/fileIO.js', () => ({ loadDebateSession }));

const { resolveExportModel } = vi.hoisted(() => ({ resolveExportModel: vi.fn() }));
vi.mock('../routes/exportModel.js', () => ({ resolveExportModel }));

const { enforceBackendAllowed } = vi.hoisted(() => ({ enforceBackendAllowed: vi.fn(() => false) }));
vi.mock('../routes/generationContext.js', () => ({ enforceBackendAllowed }));

vi.mock('../ai/opedAdapter.js', () => ({ createWebOpEdAdapter: () => ({ generateText: vi.fn() }) }));

const { startExportJob, getExportJob, hasExportJob, resolveBriefExportJobPoll, sweepExportJobs, countRunningExportJobs, findIdempotentJob } = vi.hoisted(() => ({
  startExportJob: vi.fn(async () => ({ jobId: 'job-1' })),
  getExportJob: vi.fn(),
  hasExportJob: vi.fn(() => false),
  resolveBriefExportJobPoll: vi.fn(async () => null),
  sweepExportJobs: vi.fn(),
  countRunningExportJobs: vi.fn(() => 0),
  findIdempotentJob: vi.fn(() => null),
}));
vi.mock('../briefExportJobs.js', () => ({
  startExportJob, getExportJob, hasExportJob, resolveBriefExportJobPoll, sweepExportJobs, countRunningExportJobs, findIdempotentJob,
  MAX_CONCURRENT_EXPORT_JOBS: 1,
}));

const { listBriefExports, loadBriefExportRecord, loadBriefArtifact, deleteBriefExport, getBriefExportsQuotaStatus } = vi.hoisted(() => ({
  listBriefExports: vi.fn(), loadBriefExportRecord: vi.fn(), loadBriefArtifact: vi.fn(), deleteBriefExport: vi.fn(),
  getBriefExportsQuotaStatus: vi.fn(() => Promise.resolve({ allowed: true, resource: 'brief-exports', current: 0, limit: 25 })),
}));
vi.mock('../storage/briefExportStore.js', () => ({ listBriefExports, loadBriefExportRecord, loadBriefArtifact, deleteBriefExport, getBriefExportsQuotaStatus }));

import { registerBriefExportsRoutes } from '../routes/briefExports.js';
import { BRIEF_ARTIFACTS } from '../../../../lib/brief/types.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void> | void;

function makeRouter() {
  const handlers: Record<string, Handler> = {};
  const reg = (m: string) => (p: string, h: Handler) => { handlers[`${m} ${p}`] = h; };
  return { router: { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), del: reg('DELETE') }, handlers };
}
function fakeReq(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { url, headers } as unknown as IncomingMessage;
}
function fakeRes(): ServerResponse & { _status?: number; _body?: string; _headers?: Record<string, string> } {
  const res = {
    writeHead: vi.fn((s: number, h?: Record<string, string>) => { res._status = s; res._headers = h; }),
    end: vi.fn((b?: string) => { res._body = typeof b === 'string' ? b : res._body; }),
    setHeader: vi.fn(),
  } as unknown as ServerResponse & { _status?: number; _body?: string; _headers?: Record<string, string> };
  return res;
}

const OK_MODEL = { ok: true, modelId: 'gemini-2.5-flash', modelSource: 'Default', tier: { level: 'free' }, backend: 'gemini' };
const validBody = { preset: 'policymaker', model: 'gemini-2.5-flash' };

describe('Brief Export routes (t/2804)', () => {
  let handlers: Record<string, Handler>;
  beforeEach(() => {
    isAnonymousUser.mockReset().mockReturnValue(false);
    getStorageUserId.mockReset().mockReturnValue('user-1');
    loadDebateSession.mockReset().mockResolvedValue({ phase: 'closed' });
    resolveExportModel.mockReset().mockReturnValue(OK_MODEL);
    enforceBackendAllowed.mockReset().mockReturnValue(false);
    startExportJob.mockReset().mockResolvedValue({ jobId: 'job-1' });
    getExportJob.mockReset();
    hasExportJob.mockReset().mockReturnValue(false);
    resolveBriefExportJobPoll.mockReset().mockResolvedValue(null);
    sweepExportJobs.mockReset();
    countRunningExportJobs.mockReset().mockReturnValue(0);
    findIdempotentJob.mockReset().mockReturnValue(null);
    listBriefExports.mockReset(); loadBriefExportRecord.mockReset(); loadBriefArtifact.mockReset(); deleteBriefExport.mockReset();
    getBriefExportsQuotaStatus.mockReset().mockResolvedValue({ allowed: true, resource: 'brief-exports', current: 0, limit: 25 });
    const r = makeRouter();
    registerBriefExportsRoutes(r.router as never, {} as never);
    handlers = r.handlers;
  });

  const post = (body: unknown, url = '/api/debates/deb-1/exports') =>
    handlers['POST /api/debates/:debateId/exports'](fakeReq(url), fakeRes_(), body);
  let lastRes: ReturnType<typeof fakeRes>;
  function fakeRes_() { lastRes = fakeRes(); return lastRes; }

  // ── POST gates ──

  it('202 { jobId } on the happy path — starts a job with the resolved models', async () => {
    await post(validBody);
    expect(lastRes._status).toBe(202);
    expect(JSON.parse(lastRes._body!)).toEqual({ jobId: 'job-1' });
    expect(startExportJob).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1', debateId: 'deb-1',
      models: expect.objectContaining({ modelId: 'gemini-2.5-flash', modelSource: 'Default' }),
    }));
  });

  it('403 for anonymous callers — export is billable, never anon', async () => {
    isAnonymousUser.mockReturnValue(true);
    await post(validBody);
    expect(lastRes._status).toBe(403);
    expect(loadDebateSession).not.toHaveBeenCalled();
  });

  it('400 on an invalid preset', async () => {
    await post({ ...validBody, preset: 'nonsense' });
    expect(lastRes._status).toBe(400);
  });

  it('400 when format includes pdf — PDF is desktop-only, never silently omitted', async () => {
    await post({ ...validBody, format: ['pdf'] });
    expect(lastRes._status).toBe(400);
    expect(lastRes._body).toMatch(/desktop app/i);
    expect(startExportJob).not.toHaveBeenCalled();
  });

  it('?allowOpen=true on a non-closed debate runs the pipeline (202) with request.allowOpen (t/2851)', async () => {
    loadDebateSession.mockResolvedValue({ phase: 'open' });
    await post(validBody, '/api/debates/deb-1/exports?allowOpen=true');
    expect(lastRes._status).toBe(202);
    expect(JSON.parse(lastRes._body!)).toEqual({ jobId: 'job-1' });
    // allowOpen is threaded into the job so extractDeckSpec produces the watermarked snapshot.
    expect(startExportJob).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ allowOpen: true }),
    }));
  });

  it('404 when the debate does not exist', async () => {
    loadDebateSession.mockResolvedValue(null);
    await post(validBody);
    expect(lastRes._status).toBe(404);
  });

  it('409 when the debate is not closed — only closed debates export', async () => {
    loadDebateSession.mockResolvedValue({ phase: 'open' });
    await post(validBody);
    expect(lastRes._status).toBe(409);
    expect(startExportJob).not.toHaveBeenCalled();
  });

  it('400 when the narrator model cannot be resolved', async () => {
    resolveExportModel.mockReturnValue({ ok: false, message: "Model 'x' is not available" });
    await post(validBody);
    expect(lastRes._status).toBe(400);
    expect(startExportJob).not.toHaveBeenCalled();
  });

  it('entitlement 403: when enforceBackendAllowed writes a 403, the route stops before starting a job', async () => {
    enforceBackendAllowed.mockReturnValue(true); // signals "already responded 403"
    await post(validBody);
    expect(startExportJob).not.toHaveBeenCalled();
  });

  it('checker model is resolved independently and threaded into the job', async () => {
    resolveExportModel
      .mockReturnValueOnce(OK_MODEL) // narrator
      .mockReturnValueOnce({ ok: true, modelId: 'claude-opus-4', modelSource: 'Explicit', tier: { level: 'platform' }, backend: 'claude' });
    await post({ ...validBody, checkerModel: 'claude-opus-4' });
    expect(lastRes._status).toBe(202);
    expect(startExportJob).toHaveBeenCalledWith(expect.objectContaining({
      models: expect.objectContaining({ checkerModelId: 'claude-opus-4', checkerModelSource: 'Explicit' }),
    }));
  });

  it('idempotency: a matching in-window job returns its jobId (202) without starting a new job', async () => {
    findIdempotentJob.mockReturnValue({ jobId: 'existing-9' });
    await handlers['POST /api/debates/:debateId/exports'](fakeReq('/api/debates/deb-1/exports', { 'idempotency-key': 'k-1' }), fakeRes_(), validBody);
    expect(lastRes._status).toBe(202);
    expect(JSON.parse(lastRes._body!)).toEqual({ jobId: 'existing-9' });
    expect(startExportJob).not.toHaveBeenCalled();
  });

  it('429 when the per-user concurrency cap is reached', async () => {
    countRunningExportJobs.mockReturnValue(1); // == MAX_CONCURRENT_EXPORT_JOBS
    await post(validBody);
    expect(lastRes._status).toBe(429);
    expect(JSON.parse(lastRes._body!).error).toBe('concurrency_limit');
    expect(startExportJob).not.toHaveBeenCalled();
  });

  // ── GET job / list ──

  it('GET /api/export-jobs/:jobId returns the job view; 404 when unknown', async () => {
    getExportJob.mockReturnValue({ status: 'rendering', progressPct: 70, warnings: [], error: null, errorCode: undefined, exportId: null });
    const res = fakeRes();
    await handlers['GET /api/export-jobs/:jobId'](fakeReq('/api/export-jobs/job-1'), res, undefined);
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body!)).toMatchObject({ status: 'rendering', progressPct: 70 });

    getExportJob.mockReturnValue(null);
    const res2 = fakeRes();
    await handlers['GET /api/export-jobs/:jobId'](fakeReq('/api/export-jobs/nope'), res2, undefined);
    expect(res2._status).toBe(404);
  });

  it('POST answers 503 (and starts nothing) when the durable job record cannot be created (t/4177)', async () => {
    startExportJob.mockRejectedValue(new Error('blob down'));
    const res = fakeRes();
    await handlers['POST /api/debates/:debateId/exports'](fakeReq('/api/debates/deb-1/exports'), res, validBody);
    expect(res._status).toBe(503);
    expect(res._body).toContain('job storage is unavailable');
  });

  // t/4177: a poll that lands on a replica without the job in its Map answers from the durable record.
  it('GET /api/export-jobs/:jobId falls back to the durable record when the job is not in this replica', async () => {
    getExportJob.mockReturnValue(null);
    resolveBriefExportJobPoll.mockResolvedValue({ jobId: 'job-9', userId: 'user-1', debateId: 'deb-1', status: 'narrating', progressPct: 30, warnings: ['w'], error: null, errorCode: null, exportId: null, startedAt: 1, lastHeartbeatAt: '2026-10-13T00:00:00.000Z' });
    const res = fakeRes();
    await handlers['GET /api/export-jobs/:jobId'](fakeReq('/api/export-jobs/job-9'), res, undefined);
    expect(resolveBriefExportJobPoll).toHaveBeenCalledWith('job-9');
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body!)).toEqual({ status: 'narrating', progressPct: 30, warnings: ['w'], error: null, errorCode: null, exportId: null });
  });

  it('GET /api/export-jobs/:jobId does not consult the durable record for a job in this Map owned by another user', async () => {
    getExportJob.mockReturnValue(null);
    hasExportJob.mockReturnValue(true);
    const res = fakeRes();
    await handlers['GET /api/export-jobs/:jobId'](fakeReq('/api/export-jobs/job-other'), res, undefined);
    expect(resolveBriefExportJobPoll).not.toHaveBeenCalled();
    expect(res._status).toBe(404);
  });

  it('GET /api/export-jobs/:jobId answers 404 (not 500) when the durable lookup throws', async () => {
    getExportJob.mockReturnValue(null);
    resolveBriefExportJobPoll.mockRejectedValue(new Error('blob down'));
    const res = fakeRes();
    await handlers['GET /api/export-jobs/:jobId'](fakeReq('/api/export-jobs/job-x'), res, undefined);
    expect(res._status).toBe(404);
  });

  it('GET /api/debates/:debateId/exports lists the debate’s exports', async () => {
    const rows = [{ exportId: 'e1', debateId: 'deb-1', status: 'done' }];
    listBriefExports.mockResolvedValue(rows);
    const res = fakeRes();
    await handlers['GET /api/debates/:debateId/exports'](fakeReq('/api/debates/deb-1/exports'), res, undefined);
    expect(res._status).toBe(200);
    expect(listBriefExports).toHaveBeenCalledWith('deb-1');
    expect(JSON.parse(res._body!)).toEqual(rows);
  });

  // ── artifact download ──

  it('GET artifact: unknown name ⇒ 404 before any store read', async () => {
    const res = fakeRes();
    await handlers['GET /api/exports/:exportId/artifacts/:name'](fakeReq('/api/exports/e1/artifacts/evil.json'), res, undefined);
    expect(res._status).toBe(404);
    expect(loadBriefArtifact).not.toHaveBeenCalled();
  });

  it('GET artifact: pptx ⇒ binary content-type + attachment', async () => {
    loadBriefArtifact.mockResolvedValue({ bytes: Buffer.from([1, 2, 3]) });
    const res = fakeRes();
    await handlers['GET /api/exports/:exportId/artifacts/:name'](fakeReq(`/api/exports/e1/artifacts/${BRIEF_ARTIFACTS.pptx}`), res, undefined);
    expect(res._status).toBe(200);
    expect(res._headers?.['Content-Type']).toMatch(/presentationml/);
    expect(res._headers?.['Content-Disposition']).toMatch(/attachment/);
  });

  it('GET artifact: brief.html ⇒ text/html content-type (t/2838)', async () => {
    loadBriefArtifact.mockResolvedValue({ text: '<!DOCTYPE html><html></html>' });
    const res = fakeRes();
    await handlers['GET /api/exports/:exportId/artifacts/:name'](fakeReq(`/api/exports/e1/artifacts/${BRIEF_ARTIFACTS.htmlDoc}`), res, undefined);
    expect(res._status).toBe(200);
    expect(res._headers?.['Content-Type']).toMatch(/text\/html/);
    expect(res._body).toBe('<!DOCTYPE html><html></html>');
  });

  it('GET artifact: json ⇒ text/json body, 404 when absent', async () => {
    loadBriefArtifact.mockResolvedValue({ text: '{"a":1}' });
    const res = fakeRes();
    await handlers['GET /api/exports/:exportId/artifacts/:name'](fakeReq(`/api/exports/e1/artifacts/${BRIEF_ARTIFACTS.manifest}`), res, undefined);
    expect(res._status).toBe(200);
    expect(res._headers?.['Content-Type']).toBe('application/json');
    expect(res._body).toBe('{"a":1}');

    loadBriefArtifact.mockResolvedValue(null);
    const res2 = fakeRes();
    await handlers['GET /api/exports/:exportId/artifacts/:name'](fakeReq(`/api/exports/e1/artifacts/${BRIEF_ARTIFACTS.deckSpec}`), res2, undefined);
    expect(res2._status).toBe(404);
  });

  // ── DELETE ──

  // ── quota (t/2831) ──

  it('429 quota_exceeded when brief-export count quota is at the limit, BEFORE any model call', async () => {
    getBriefExportsQuotaStatus.mockResolvedValue({ allowed: false, resource: 'brief-exports', current: 25, limit: 25 });
    await post(validBody);
    expect(lastRes._status).toBe(429);
    expect(JSON.parse(lastRes._body!).error).toBe('quota_exceeded');
    expect(resolveExportModel).not.toHaveBeenCalled();
    expect(startExportJob).not.toHaveBeenCalled();
  });

  it('GET /api/brief-exports/quota-status: 200 + QuotaCheckResult (mirrors oped-sets/quota-status pattern)', async () => {
    getBriefExportsQuotaStatus.mockResolvedValue({ allowed: true, resource: 'brief-exports', current: 3, limit: 25 });
    const res = fakeRes();
    await handlers['GET /api/brief-exports/quota-status'](fakeReq('/api/brief-exports/quota-status'), res, undefined);
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body!)).toMatchObject({ allowed: true, resource: 'brief-exports', current: 3, limit: 25 });
    expect(getBriefExportsQuotaStatus).toHaveBeenCalled();
  });

  // ── DELETE ──

  it('DELETE: 403 anon, 404 unknown, ok:true on success', async () => {
    isAnonymousUser.mockReturnValue(true);
    const resAnon = fakeRes();
    await handlers['DELETE /api/exports/:exportId'](fakeReq('/api/exports/e1'), resAnon, undefined);
    expect(resAnon._status).toBe(403);

    isAnonymousUser.mockReturnValue(false);
    loadBriefExportRecord.mockResolvedValue(null);
    const res404 = fakeRes();
    await handlers['DELETE /api/exports/:exportId'](fakeReq('/api/exports/ghost'), res404, undefined);
    expect(res404._status).toBe(404);
    expect(deleteBriefExport).not.toHaveBeenCalled();

    loadBriefExportRecord.mockResolvedValue({ exportId: 'e1' });
    deleteBriefExport.mockResolvedValue(undefined);
    const resOk = fakeRes();
    await handlers['DELETE /api/exports/:exportId'](fakeReq('/api/exports/e1'), resOk, undefined);
    expect(resOk._status).toBe(200);
    expect(JSON.parse(resOk._body!)).toEqual({ ok: true });
    expect(deleteBriefExport).toHaveBeenCalledWith('e1');
  });
});
