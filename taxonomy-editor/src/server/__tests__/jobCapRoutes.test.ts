// @vitest-environment node
//
// t/182 (#4942) — route-level tests for durable idempotency + per-user caps on POST /api/inquiry and
// POST /api/debates/:debateId/exports. Nothing about the job records, the cap checker or the stores is
// mocked: the real routes run against a temp FilesystemBackend with real job records on disk. Only the
// expensive edges are stubbed (the inquiry pipeline, the brief pipeline, model resolution, debate load).

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';

const h = vi.hoisted(() => ({
  cap: 1,
  pending: [] as Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }>,
  pipelineCalls: 0,
}));

vi.mock('../routes/generationContext.js', () => ({
  resolveGenerationContext: () => ({ tier: { limits: { requestsPerMinute: 100000 } }, limitKey: 'k', backend: 'gemini' }),
  enforceBackendAllowed: () => false,
}));
vi.mock('../ai/aiBackends.js', () => ({ isRegisteredModel: () => true }));
vi.mock('../ai/opedAdapter.js', () => ({ createWebOpEdAdapter: () => ({ generateText: vi.fn() }) }));
vi.mock('../routes/exportModel.js', () => ({
  resolveExportModel: () => ({ ok: true, modelId: 'gemini-2.5-flash', modelSource: 'Default', tier: { level: 'free' }, backend: 'gemini' }),
}));

// Never-finishing pipelines the test settles explicitly, so a job stays "running" until told otherwise.
function hangingPipeline(): Promise<never> {
  h.pipelineCalls++;
  return new Promise((resolve, reject) => { h.pending.push({ resolve: resolve as (v: unknown) => void, reject }); });
}
vi.mock('../inquiryPipelineDeps.js', () => ({ buildInquiryRunPipeline: () => () => hangingPipeline() }));
vi.mock('../../../../lib/brief/pipeline.js', () => ({ runBriefPipeline: () => hangingPipeline() }));

vi.mock('../storage/fileIO.js', async (orig) => ({
  ...(await orig<typeof import('../storage/fileIO.js')>()),
  loadDebateSession: async () => ({ phase: 'closed' }),
}));
vi.mock('../storage/briefExportStore.js', async (orig) => ({
  ...(await orig<typeof import('../storage/briefExportStore.js')>()),
  getBriefExportsQuotaStatus: async () => ({ allowed: true, resource: 'brief-exports', current: 0, limit: 25 }),
  saveBriefExport: async () => {},
}));

// The caps are module constants (1); expose them as a getter so a test can run the cap-2 case.
vi.mock('../inquiryJobs.js', async (orig) => {
  const m = { ...(await orig<typeof import('../inquiryJobs.js')>()) };
  Object.defineProperty(m, 'MAX_CONCURRENT_INQUIRY_JOBS', { get: () => h.cap, enumerable: true });
  return m;
});
vi.mock('../briefExportJobs.js', async (orig) => {
  const m = { ...(await orig<typeof import('../briefExportJobs.js')>()) };
  Object.defineProperty(m, 'MAX_CONCURRENT_EXPORT_JOBS', { get: () => h.cap, enumerable: true });
  return m;
});

import { createRouter, type Handler } from '../httpKit.js';
import { registerInquiryRoutes } from '../routes/inquiry.js';
import { registerBriefExportsRoutes } from '../routes/briefExports.js';
import { runWithUser } from '../security/userContext.js';
import { FilesystemBackend } from '../storage/filesystemBackend.js';
import { setBackend, setUserContentBackend, setBriefExportBackend } from '../storage/fileIO.js';
import { listUserJobRecords } from '../storage/jobRecords.js';
import { getInquiryJobsDir, INQUIRY_HEARTBEAT_STALE_MS, type InquiryJobRecord } from '../storage/inquiryJobStore.js';
import { getBriefExportJobsDir, BRIEF_EXPORT_HEARTBEAT_STALE_MS, type BriefExportJobRecord } from '../storage/briefExportJobStore.js';
import { _resetInquiryJobsForTest } from '../inquiryJobs.js';

// The cutoff the cap checker applies (jobCapChecker reads these constants): 30s for both kinds.
const STALE_MS = 30_000;

let tmpRoot: string;
let prevRoot: string | undefined;
const backend = new FilesystemBackend();
const handlers = new Map<string, Handler>();

beforeAll(() => {
  prevRoot = process.env.AI_TRIAD_DATA_ROOT;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't182-jobcap-'));
  process.env.AI_TRIAD_DATA_ROOT = tmpRoot;
  setBackend(backend); setUserContentBackend(backend); setBriefExportBackend(backend);
  const routes: Array<{ method: string; path: string; handler: Handler }> = [];
  const router = createRouter(routes);
  registerInquiryRoutes(router, {} as never);
  registerBriefExportsRoutes(router, {} as never);
  for (const r of routes) handlers.set(`${r.method} ${r.path}`, r.handler);
});

afterAll(() => {
  if (prevRoot === undefined) delete process.env.AI_TRIAD_DATA_ROOT; else process.env.AI_TRIAD_DATA_ROOT = prevRoot;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

afterEach(async () => {
  for (const p of h.pending.splice(0)) p.reject(new Error('test teardown'));
  await new Promise(resolve => setTimeout(resolve, 150)); // let the failed-record writes land before the next test / rm
  h.cap = 1;
  h.pipelineCalls = 0;
  _resetInquiryJobsForTest();
});

let userSeq = 0;
const newUser = () => `user-${++userSeq}`;

interface Posted { status: number; body: { jobId?: string; error?: string } }

async function post(routePath: string, url: string, userId: string, body: unknown, headers: Record<string, string> = {}): Promise<Posted> {
  const out: { status?: number; text?: string } = {};
  const res = {
    writeHead: (s: number) => { out.status = s; },
    end: (t?: string) => { out.text = t; },
    setHeader: () => {},
    writableEnded: false, headersSent: false,
  } as unknown as ServerResponse;
  const req = { url, headers, method: 'POST' } as unknown as IncomingMessage;
  const handler = handlers.get(`POST ${routePath}`)!;
  await runWithUser({ principalName: `${userId}@example.com`, idp: 'github', storageUserId: userId, isAnonymous: false }, () => handler(req, res, body));
  return { status: out.status!, body: out.text ? JSON.parse(out.text) : {} };
}

const postInquiry = (userId: string, headers: Record<string, string> = {}) =>
  post('/api/inquiry', '/api/inquiry', userId, { question: 'Is it safe?', fidelity: 'quick' }, headers);
const postExport = (userId: string, debateId = 'deb-1', headers: Record<string, string> = {}) =>
  post('/api/debates/:debateId/exports', `/api/debates/${debateId}/exports`, userId, { preset: 'policymaker', model: 'gemini-2.5-flash' }, headers);

async function writeInquiryRecord(userId: string, jobId: string, over: Partial<InquiryJobRecord> = {}): Promise<void> {
  const rec: InquiryJobRecord = {
    jobId, userId, bootId: 'other-replica', status: 'debating', lastHeartbeatAt: new Date().toISOString(),
    resultId: null, error: null, debateId: null, startedAt: Date.now(), idempotencyKey: null, ...over,
  };
  await backend.writeFile(path.join(getInquiryJobsDir(userId), `job-${jobId}.json`), JSON.stringify(rec));
}
async function writeExportRecord(userId: string, jobId: string, over: Partial<BriefExportJobRecord> = {}): Promise<void> {
  const rec: BriefExportJobRecord = {
    jobId, userId, debateId: 'deb-1', status: 'narrating', progressPct: 40, warnings: [], error: null, errorCode: null,
    exportId: null, startedAt: Date.now(), lastHeartbeatAt: new Date().toISOString(), idempotencyKey: null, ...over,
  };
  await backend.writeFile(path.join(getBriefExportJobsDir(userId), `job-${jobId}.json`), JSON.stringify(rec));
}
const staleBeat = (over = 1_000) => new Date(Date.now() - STALE_MS - over).toISOString();

describe('jobCapChecker staleness cutoff matches the store constants', () => {
  it('is 30s for both kinds', () => {
    expect(INQUIRY_HEARTBEAT_STALE_MS).toBe(STALE_MS);
    expect(BRIEF_EXPORT_HEARTBEAT_STALE_MS).toBe(STALE_MS);
  });
});

describe('POST /api/inquiry — durable idempotency and caps (real records)', () => {
  it('same Idempotency-Key returns the same jobId, starts one pipeline, and persists the key', async () => {
    const u = newUser();
    const a = await postInquiry(u, { 'idempotency-key': 'k-1' });
    const b = await postInquiry(u, { 'idempotency-key': 'k-1' });
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(b.body.jobId).toBe(a.body.jobId);
    expect(h.pipelineCalls).toBe(1);
    const recs = await listUserJobRecords(u, 'inquiry');
    expect(recs).toHaveLength(1);
    expect(recs[0].idempotencyKey).toBe('k-1');
  });

  it('a retry that lands on another replica (key only in the shared records) returns that job', async () => {
    const u = newUser();
    await writeInquiryRecord(u, 'remote-job', { idempotencyKey: 'k-remote' });
    const r = await postInquiry(u, { 'idempotency-key': 'k-remote' });
    expect(r.status).toBe(202);
    expect(r.body.jobId).toBe('remote-job');
    expect(h.pipelineCalls).toBe(0);
  });

  it('a fresh running record from another replica counts toward the cap (429)', async () => {
    const u = newUser();
    await writeInquiryRecord(u, 'remote-job', { lastHeartbeatAt: staleBeat(-5_000) });
    expect((await postInquiry(u)).status).toBe(429);
  });

  it('a record with a stale heartbeat (past the 30s cutoff) is not counted', async () => {
    const u = newUser();
    await writeInquiryRecord(u, 'crashed-job', { lastHeartbeatAt: staleBeat() });
    const r = await postInquiry(u);
    expect(r.status).toBe(202);
    expect(r.body.jobId).not.toBe('crashed-job');
  });

  it('at cap-1, two concurrent POSTs give one 202 and one 429', async () => {
    const u = newUser();
    const rs = await Promise.all([postInquiry(u), postInquiry(u)]);
    expect(rs.map(r => r.status).sort()).toEqual([202, 429]);
    expect(h.pipelineCalls).toBe(1);
  });

  it('at cap 2 with 0 running, two concurrent POSTs both give 202 (and a third gets 429)', async () => {
    h.cap = 2;
    const u = newUser();
    const rs = await Promise.all([postInquiry(u), postInquiry(u)]);
    expect(rs.map(r => r.status)).toEqual([202, 202]);
    expect(new Set(rs.map(r => r.body.jobId)).size).toBe(2);
    expect((await postInquiry(u)).status).toBe(429);
  });

  it('after the job reaches a terminal status, a new POST starts a new job', async () => {
    const u = newUser();
    const first = await postInquiry(u);
    expect(first.status).toBe(202);
    expect((await postInquiry(u)).status).toBe(429);
    h.pending.splice(0).forEach(p => p.reject(new Error('pipeline failed')));
    await vi.waitFor(async () => {
      const recs = await listUserJobRecords(u, 'inquiry');
      expect(recs.map(r => r.status)).toEqual(['failed']);
    });
    const second = await postInquiry(u);
    expect(second.status).toBe(202);
    expect(second.body.jobId).not.toBe(first.body.jobId);
  });
});

describe('POST /api/debates/:debateId/exports — durable idempotency and caps (real records)', () => {
  it('same Idempotency-Key returns the same jobId, starts one pipeline, and persists the key', async () => {
    const u = newUser();
    const a = await postExport(u, 'deb-1', { 'idempotency-key': 'k-1' });
    const b = await postExport(u, 'deb-1', { 'idempotency-key': 'k-1' });
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(b.body.jobId).toBe(a.body.jobId);
    expect(h.pipelineCalls).toBe(1);
    const recs = await listUserJobRecords(u, 'brief-export');
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ idempotencyKey: 'k-1', debateId: 'deb-1' });
  });

  it('a retry that lands on another replica returns that job, scoped to the debate', async () => {
    const u = newUser();
    await writeExportRecord(u, 'remote-job', { idempotencyKey: 'k-remote', debateId: 'deb-1' });
    const r = await postExport(u, 'deb-1', { 'idempotency-key': 'k-remote' });
    expect(r.status).toBe(202);
    expect(r.body.jobId).toBe('remote-job');
    expect(h.pipelineCalls).toBe(0);
    // Same key on a different debate is not a retry of that job; the cap then rejects it.
    expect((await postExport(u, 'deb-2', { 'idempotency-key': 'k-remote' })).status).toBe(429);
  });

  it('a record with a stale heartbeat (past the 30s cutoff) is not counted; a fresh one is', async () => {
    const fresh = newUser();
    await writeExportRecord(fresh, 'live-job', { lastHeartbeatAt: staleBeat(-5_000) });
    expect((await postExport(fresh)).status).toBe(429);

    const stale = newUser();
    await writeExportRecord(stale, 'crashed-job', { lastHeartbeatAt: staleBeat() });
    const r = await postExport(stale);
    expect(r.status).toBe(202);
    expect(r.body.jobId).not.toBe('crashed-job');
  });

  it('at cap-1, concurrent exports of two different debates give one 202 and one 429', async () => {
    const u = newUser();
    const rs = await Promise.all([postExport(u, 'deb-1'), postExport(u, 'deb-2')]);
    expect(rs.map(r => r.status).sort()).toEqual([202, 429]);
    expect(h.pipelineCalls).toBe(1);
  });

  it('at cap 2 with 0 running, two concurrent exports both give 202 (and a third gets 429)', async () => {
    h.cap = 2;
    const u = newUser();
    const rs = await Promise.all([postExport(u, 'deb-1'), postExport(u, 'deb-2')]);
    expect(rs.map(r => r.status)).toEqual([202, 202]);
    expect((await postExport(u, 'deb-3')).status).toBe(429);
  });

  it('after the job reaches a terminal status, a new POST starts a new job', async () => {
    const u = newUser();
    const first = await postExport(u);
    expect(first.status).toBe(202);
    expect((await postExport(u, 'deb-2')).status).toBe(429);
    h.pending.splice(0).forEach(p => p.reject(new Error('pipeline failed')));
    await vi.waitFor(async () => {
      const recs = await listUserJobRecords(u, 'brief-export');
      expect(recs.map(r => r.status)).toEqual(['failed']);
    });
    const second = await postExport(u);
    expect(second.status).toBe(202);
    expect(second.body.jobId).not.toBe(first.body.jobId);
  });
});
