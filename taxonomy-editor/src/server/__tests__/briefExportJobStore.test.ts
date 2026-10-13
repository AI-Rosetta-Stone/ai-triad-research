// @vitest-environment node
//
// t/4177 — the brief export job record store (cross-replica poll fallback). Mirrors
// inquiryJobStoreInvariant.test.ts: the staleness invariant, plus every verdict of
// resolveBriefExportJobPoll tested against the real predicate with controlled time.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { blobs } = vi.hoisted(() => ({ blobs: new Map<string, string>() }));
vi.mock('../storage/fileIO.js', () => ({
  getBriefExportBackend: () => ({
    readFile: async (p: string) => blobs.get(p) ?? null,
    writeFile: async (p: string, c: string) => { blobs.set(p, c); },
    deleteFile: async (p: string) => { blobs.delete(p); },
  }),
  assertSafeId: () => {},
}));
vi.mock('../config.js', () => ({ resolveDataPath: (p: string) => `/data/${p}` }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => null }));
vi.mock('../logger.js', () => ({ log: { server: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } } }));
const { isAnon } = vi.hoisted(() => ({ isAnon: { value: false } }));
vi.mock('../security/userContext.js', () => ({ getStorageUserId: () => 'user-1', isAnonymousUser: () => isAnon.value }));

import {
  BRIEF_EXPORT_HEARTBEAT_STALE_MS, BRIEF_EXPORT_HEARTBEAT_INTERVAL_MS, BRIEF_EXPORT_HEARTBEAT_WORST_SYNC_BLOCK_MS,
  BRIEF_EXPORT_JOB_RECORD_WINDOW_MS, STALE_EXPORT_ERROR,
  saveBriefExportJobRecord, loadBriefExportJobRecord, resolveBriefExportJobPoll, type BriefExportJobRecord,
} from '../storage/briefExportJobStore.js';

const NOW = 1_800_000_000_000;

function rec(over: Partial<BriefExportJobRecord> = {}): BriefExportJobRecord {
  return {
    jobId: 'job-1', userId: 'user-1', debateId: 'deb-1', status: 'narrating', progressPct: 30,
    warnings: [], error: null, errorCode: null, exportId: null,
    startedAt: NOW - 60_000, lastHeartbeatAt: new Date(NOW).toISOString(), ...over,
  };
}

describe('t/4177 — brief export job record store', () => {
  beforeEach(() => { blobs.clear(); isAnon.value = false; vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it('staleness invariant: STALE_MS ≥ WORST_SYNC_BLOCK_MS + 2 × INTERVAL_MS', () => {
    expect(BRIEF_EXPORT_HEARTBEAT_STALE_MS).toBeGreaterThanOrEqual(
      BRIEF_EXPORT_HEARTBEAT_WORST_SYNC_BLOCK_MS + 2 * BRIEF_EXPORT_HEARTBEAT_INTERVAL_MS,
    );
  });

  it('absent record → null (the route answers 404)', async () => {
    expect(await resolveBriefExportJobPoll('job-1')).toBeNull();
  });

  it('fresh heartbeat on a running job → served as live (another replica owns it)', async () => {
    await saveBriefExportJobRecord(rec({ lastHeartbeatAt: new Date(NOW - (BRIEF_EXPORT_HEARTBEAT_STALE_MS - 1_000)).toISOString() }));
    expect(await resolveBriefExportJobPoll('job-1')).toMatchObject({ status: 'narrating', progressPct: 30, error: null });
  });

  it('stale heartbeat on a running job → served as failed, and the failed state is written back', async () => {
    await saveBriefExportJobRecord(rec({ lastHeartbeatAt: new Date(NOW - BRIEF_EXPORT_HEARTBEAT_STALE_MS - 1_000).toISOString() }));
    const view = await resolveBriefExportJobPoll('job-1');
    expect(view).toMatchObject({ status: 'failed', progressPct: 100, error: STALE_EXPORT_ERROR, errorCode: 'RenderFailure' });
    await vi.waitFor(async () => expect((await loadBriefExportJobRecord('job-1'))?.status).toBe('failed'));
  });

  it('terminal record within the window → served as-is', async () => {
    await saveBriefExportJobRecord(rec({ status: 'done', progressPct: 100, exportId: 'exp-1', lastHeartbeatAt: new Date(NOW - 3_600_000).toISOString() }));
    expect(await resolveBriefExportJobPoll('job-1')).toMatchObject({ status: 'done', exportId: 'exp-1' });
  });

  it('terminal record past the retention window → null and deleted', async () => {
    await saveBriefExportJobRecord(rec({ status: 'failed', startedAt: NOW - BRIEF_EXPORT_JOB_RECORD_WINDOW_MS - 1 }));
    expect(await resolveBriefExportJobPoll('job-1')).toBeNull();
    await vi.waitFor(() => expect(blobs.size).toBe(0));
  });

  it('unparseable record → treated as absent', async () => {
    blobs.set('/data/users/user-1/brief-export-jobs/job-1.json', '{not json');
    expect(await resolveBriefExportJobPoll('job-1')).toBeNull();
  });

  it('anonymous caller: writes are no-ops and reads are null', async () => {
    isAnon.value = true;
    await saveBriefExportJobRecord(rec());
    expect(blobs.size).toBe(0);
    expect(await resolveBriefExportJobPoll('job-1')).toBeNull();
  });
});
