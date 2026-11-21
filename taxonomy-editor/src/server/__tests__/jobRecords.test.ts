// @vitest-environment node
//
// t/4216 (t/181) — listUserJobRecords + createInquiryJobRecordIfAbsent / createBriefExportJobRecordIfAbsent.
// Two in-memory backends stand in for user-content (inquiry records) and brief-export storage, so
// the tests also prove each kind is read through its own store's backend.
//
// The fakes are installed with fileIO's real setters, NOT vi.mock('../storage/fileIO.js') with
// importOriginal: fileIO's re-exports reach inquiryResultStore → inquiryJobStore, so under such a
// mock inquiryJobStore binds to the REAL fileIO and writes to the real data root.

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

const { serverWarn } = vi.hoisted(() => ({ serverWarn: vi.fn() }));
vi.mock('../logger.js', () => ({
  log: {
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    server: { info: vi.fn(), warn: serverWarn, error: vi.fn(), debug: vi.fn() },
  },
  getRequestId: () => 'req-test',
  LOG_MAX_LINE_BYTES: 65536,
  writeFramedNdjson: vi.fn(),
}));

function makeFake(name: string) {
  const files = new Map<string, string>();
  const fail: { list?: Error; read?: Error } = {};
  return {
    files, fail,
    backend: {
      backendName: name,
      async readFile(p: string) { if (fail.read) throw fail.read; return files.get(p) ?? null; },
      async writeFile(p: string, c: string) { files.set(p, c); return { version: '' }; },
      async writeFileIfAbsent(p: string, c: string) {
        if (files.has(p)) return 'exists' as const;
        files.set(p, c);
        return 'created' as const;
      },
      async listDirectory(dir: string) {
        if (fail.list) throw fail.list;
        const prefix = dir.replace(/[\\/]+$/, '') + (dir.includes('\\') ? '\\' : '/');
        return [...files.keys()].filter(k => k.startsWith(prefix) && !k.slice(prefix.length).match(/[\\/]/))
          .map(k => k.slice(prefix.length));
      },
      async deleteFile(p: string) { files.delete(p); },
      async fileExists(p: string) { return files.has(p); },
      async readBinaryFile() { return null; },
      async writeBinaryFile() { /* unused */ },
    },
  };
}
const uc = makeFake('user-content');
const be = makeFake('brief-export');

import path from 'path';
import { setUserContentBackend, setBriefExportBackend, getUserContentBackend, getBriefExportBackend } from '../storage/fileIO.js';
import type { StorageBackend } from '../storage/storageBackend.js';
import { runWithUser, type UserContext } from '../security/userContext.js';
import { listUserJobRecords } from '../storage/jobRecords.js';
import { createInquiryJobRecordIfAbsent, getInquiryJobsDir, type InquiryJobRecord } from '../storage/inquiryJobStore.js';
import { createBriefExportJobRecordIfAbsent, getBriefExportJobsDir, type BriefExportJobRecord } from '../storage/briefExportJobStore.js';
import { resolveDataPath } from '../config.js';

const OWNER: UserContext = { principalName: 'owner-1', idp: 'github', storageUserId: 'owner-1', isAnonymous: false };
const ANON: UserContext = { principalName: '', idp: 'anon', storageUserId: '_local', isAnonymous: true };

function inquiry(jobId: string, userId = 'owner-1'): InquiryJobRecord {
  return { jobId, userId, bootId: 'b', status: 'running', lastHeartbeatAt: new Date().toISOString(),
    resultId: null, error: null, debateId: null, startedAt: Date.now() } as InquiryJobRecord;
}
function brief(jobId: string, userId = 'owner-1'): BriefExportJobRecord {
  return { jobId, userId, debateId: 'd1', status: 'running', progressPct: 0, warnings: [], error: null,
    errorCode: null, exportId: null, startedAt: Date.now(), lastHeartbeatAt: new Date().toISOString() } as BriefExportJobRecord;
}
const warnsWith = (cause: string) => serverWarn.mock.calls.filter(c => c[0]?.cause === cause);

let realUserContent: StorageBackend;
let realBriefExport: StorageBackend;
beforeAll(() => {
  realUserContent = getUserContentBackend();
  realBriefExport = getBriefExportBackend();
  setUserContentBackend(uc.backend as unknown as StorageBackend);
  setBriefExportBackend(be.backend as unknown as StorageBackend);
});
afterAll(() => {
  setUserContentBackend(realUserContent);
  setBriefExportBackend(realBriefExport);
});
// Guard: if a fake were ever bypassed again, fail loudly instead of touching the real data root.
beforeEach(() => {
  if (getUserContentBackend() !== uc.backend || getBriefExportBackend() !== be.backend) {
    throw new Error('jobRecords.test: a fake backend is not installed — refusing to run against real storage');
  }
});

describe('create*JobRecordIfAbsent (t/181)', () => {
  beforeEach(() => { uc.files.clear(); be.files.clear(); serverWarn.mockClear(); });

  it('inquiry: two replicas creating the same jobId → one created, one exists; the first record is kept', async () => {
    const replicaA = runWithUser(OWNER, () => createInquiryJobRecordIfAbsent({ ...inquiry('job-x'), bootId: 'replica-A' }));
    const replicaB = runWithUser(OWNER, () => createInquiryJobRecordIfAbsent({ ...inquiry('job-x'), bootId: 'replica-B' }));
    expect((await Promise.all([replicaA, replicaB])).sort()).toEqual(['created', 'exists']);
    const stored = await runWithUser(OWNER, () => listUserJobRecords('owner-1', 'inquiry'));
    expect(stored).toHaveLength(1);
    expect(stored[0].bootId).toBe('replica-A');
  });

  it('brief-export: second create of the same jobId → exists, written through the brief-export backend', async () => {
    expect(await runWithUser(OWNER, () => createBriefExportJobRecordIfAbsent(brief('job-y')))).toBe('created');
    expect(await runWithUser(OWNER, () => createBriefExportJobRecordIfAbsent({ ...brief('job-y'), progressPct: 50 }))).toBe('exists');
    expect(uc.files.size).toBe(0);
    expect(be.files.size).toBe(1);
    expect(JSON.parse([...be.files.values()][0]).progressPct).toBe(0);
  });

  it('anonymous: no-op returning created (no durable record), same as save*', async () => {
    expect(await runWithUser(ANON, () => createInquiryJobRecordIfAbsent(inquiry('job-z', '_local')))).toBe('created');
    expect(await runWithUser(ANON, () => createBriefExportJobRecordIfAbsent(brief('job-z', '_local')))).toBe('created');
    expect(uc.files.size + be.files.size).toBe(0);
  });

  it('rejects an unsafe jobId before writing', async () => {
    await expect(runWithUser(OWNER, () => createInquiryJobRecordIfAbsent(inquiry('../evil')))).rejects.toThrow();
    expect(uc.files.size).toBe(0);
  });
});

describe('listUserJobRecords (t/181)', () => {
  beforeEach(() => {
    uc.files.clear(); be.files.clear(); serverWarn.mockClear();
    delete uc.fail.list; delete uc.fail.read; delete be.fail.list; delete be.fail.read;
  });

  const put = (fake: typeof uc, dir: string, name: string, body: unknown) =>
    fake.files.set(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));

  it('returns this user\'s records of the asked kind, each from its own backend', async () => {
    put(uc, getInquiryJobsDir('owner-1'), 'job-1.json', inquiry('job-1'));
    put(uc, getInquiryJobsDir('owner-1'), 'job-2.json', inquiry('job-2'));
    put(be, getBriefExportJobsDir('owner-1'), 'job-3.json', brief('job-3'));
    put(uc, getInquiryJobsDir('someone-else'), 'job-9.json', inquiry('job-9', 'someone-else'));

    expect((await listUserJobRecords('owner-1', 'inquiry')).map(r => r.jobId).sort()).toEqual(['job-1', 'job-2']);
    expect((await listUserJobRecords('owner-1', 'brief-export')).map(r => r.jobId)).toEqual(['job-3']);
  });

  it('missing directory → []', async () => {
    expect(await listUserJobRecords('nobody', 'inquiry')).toEqual([]);
  });

  it('ignores non-record names (temp files from a create in flight)', async () => {
    const dir = getInquiryJobsDir('owner-1');
    put(uc, dir, 'job-1.json', inquiry('job-1'));
    put(uc, dir, 'job-1.json.4f2c.create-tmp', inquiry('job-1'));
    put(uc, dir, 'job-2.json.tmp', inquiry('job-2'));
    expect((await listUserJobRecords('owner-1', 'inquiry')).map(r => r.jobId)).toEqual(['job-1']);
  });

  it('skips unparseable, wrong-shape and other-user records, each with a WARN', async () => {
    const dir = getInquiryJobsDir('owner-1');
    put(uc, dir, 'job-1.json', inquiry('job-1'));
    put(uc, dir, 'job-2.json', '{not json');
    put(uc, dir, 'job-3.json', { hello: 'world' });
    put(uc, dir, 'job-4.json', inquiry('job-4', 'intruder'));
    expect((await listUserJobRecords('owner-1', 'inquiry')).map(r => r.jobId)).toEqual(['job-1']);
    expect(warnsWith('job-record-unparseable')).toHaveLength(1);
    expect(warnsWith('job-record-wrong-shape')).toHaveLength(1);
    expect(warnsWith('job-record-wrong-user')).toHaveLength(1);
  });

  it('a listing failure throws JOB_RECORD_LIST_FAILED (so a cap can fail closed) — never []', async () => {
    uc.fail.list = new Error('blob service unavailable');
    await expect(listUserJobRecords('owner-1', 'inquiry')).rejects.toMatchObject({ code: 'JOB_RECORD_LIST_FAILED', httpStatus: 503 });
  });

  it('a read failure on a listed record throws JOB_RECORD_LIST_FAILED — the record is not silently dropped', async () => {
    put(uc, getInquiryJobsDir('owner-1'), 'job-1.json', inquiry('job-1'));
    uc.fail.read = new Error('read timeout');
    await expect(listUserJobRecords('owner-1', 'inquiry')).rejects.toMatchObject({ code: 'JOB_RECORD_LIST_FAILED' });
  });

  it("'_local' reads the legacy unscoped directory, like the stores", async () => {
    expect(getInquiryJobsDir('_local')).toBe(resolveDataPath('inquiry-jobs'));
    put(uc, resolveDataPath('inquiry-jobs'), 'job-1.json', inquiry('job-1', '_local'));
    expect((await listUserJobRecords('_local', 'inquiry')).map(r => r.jobId)).toEqual(['job-1']);
  });

  it.each(['', '.', '..', '../owner-2', 'a/b', 'a\\b'])('rejects an unsafe userId %j before touching storage', async (bad) => {
    await expect(listUserJobRecords(bad, 'inquiry')).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('accepts a sanitized email-derived storage id with "+" (assertSafeId would reject it)', async () => {
    const id = 'a+b-at-example-com';
    put(uc, getInquiryJobsDir(id), 'job-1.json', inquiry('job-1', id));
    expect(await listUserJobRecords(id, 'inquiry')).toHaveLength(1);
  });

  it('t/268 (item 5): GitHub listDirectory degraded [] with circuit breaker → throws, fails closed for job caps', async () => {
    // Mock GitHubAPIBackend instance that returns [] (degraded) but listDirectoryStrict throws (transient).
    // Use a real GitHubAPIBackend instance to pass instanceof check.
    const { GitHubAPIBackend } = await import('../storage/githubAPIBackend.js');
    // Create a minimal instance with mocked methods (avoid full init).
    const mockBackend = Object.create(GitHubAPIBackend.prototype);
    mockBackend.backendName = 'github-api';
    mockBackend.listDirectory = vi.fn().mockResolvedValue([]);
    mockBackend.listDirectoryStrict = vi.fn().mockRejectedValue(
      Object.assign(new Error('circuit breaker open'), { kind: 'transient' as const })
    );
    mockBackend.readFile = vi.fn().mockResolvedValue(null);
    mockBackend.writeFile = vi.fn().mockResolvedValue({ version: '' });
    mockBackend.writeFileIfAbsent = vi.fn().mockResolvedValue('created' as const);
    mockBackend.deleteFile = vi.fn().mockResolvedValue(undefined);
    mockBackend.fileExists = vi.fn().mockResolvedValue(false);

    const realBackend = getUserContentBackend();
    try {
      setUserContentBackend(mockBackend as unknown as StorageBackend);
      await expect(listUserJobRecords('owner-1', 'inquiry')).rejects.toMatchObject({ code: 'JOB_RECORD_LIST_FAILED' });
    } finally {
      setUserContentBackend(realBackend);
    }
  });
});
