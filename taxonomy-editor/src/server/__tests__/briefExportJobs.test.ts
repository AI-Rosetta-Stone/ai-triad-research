// @vitest-environment node
//
// t/2804 (T6) — the async export-job runner + registry. The lib/brief pipeline stages
// (extract/narrate/render/verify) are mocked so this suite is a fast unit test of the
// ORCHESTRATION contract, not the pipeline (that is lib/brief's own suite):
//
//   • TL MUST (b): a FAILED export still persists its audit-manifest — proven for the
//     verify-gate-failure path (manifest produced, then hardFailures ⇒ 'failed'), which
//     is the case where a manifest exists to persist.
//   • a stage THROW persists whatever artifacts were collected (diagnosable) + maps to a
//     stable ExportErrorCode, never leaves the job stuck non-terminal.
//   • the happy path persists deck_spec + narration + pptx + manifest and sets exportId.
//   • registry helpers: per-user concurrency count, idempotency lookup, TTL sweep.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { extractDeckSpec, narrate, render, verify, saveBriefExport } = vi.hoisted(() => ({
  extractDeckSpec: vi.fn(),
  narrate: vi.fn(),
  render: vi.fn(),
  verify: vi.fn(),
  saveBriefExport: vi.fn(async () => {}),
}));
vi.mock('../../../../lib/brief/extract.js', () => ({ extractDeckSpec }));
vi.mock('../../../../lib/brief/narrate.js', () => ({ narrate }));
vi.mock('../../../../lib/brief/render/index.js', () => ({ render }));
vi.mock('../../../../lib/brief/verify.js', () => ({ verify }));
vi.mock('../storage/briefExportStore.js', () => ({ saveBriefExport }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => undefined }));

// t/4177: the durable job-record store runs for real against an in-memory backend shared by
// "both replicas" — the record is the only state another replica can see.
const { blobs, heartbeatGate } = vi.hoisted(() => ({
  blobs: new Map<string, string>(),
  // When set, a write of a non-terminal record waits on it (simulates a slow in-flight heartbeat).
  heartbeatGate: { wait: null as Promise<void> | null },
}));
vi.mock('../storage/fileIO.js', () => ({
  getBriefExportBackend: () => ({
    readFile: async (p: string) => blobs.get(p) ?? null,
    writeFile: async (p: string, c: string) => {
      const status = (JSON.parse(c) as { status: string }).status;
      if (heartbeatGate.wait && status !== 'done' && status !== 'failed') await heartbeatGate.wait;
      blobs.set(p, c);
    },
    deleteFile: async (p: string) => { blobs.delete(p); },
  }),
  assertSafeId: () => {},
}));
vi.mock('../config.js', () => ({ resolveDataPath: (p: string) => `/data/${p}` }));
vi.mock('../logger.js', () => ({ log: { server: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } } }));
vi.mock('../security/userContext.js', () => ({ getStorageUserId: () => 'user-1', isAnonymousUser: () => false }));

import {
  startExportJob, getExportJob, countRunningExportJobs, findIdempotentJob,
  sweepExportJobs, EXPORT_JOB_TTL_MS, resolveBriefExportJobPoll, type CreateJobArgs,
} from '../briefExportJobs.js';
import { BRIEF_ARTIFACTS } from '../../../../lib/brief/types.js';

const SPEC = { meta: { title: 'Should AI be paused?', model: 'gemini-2.5-flash', phase: 'closed' }, slides: [] };
const NARRATION = { slides: [] };
const MANIFEST = { trace_coverage_pct: 100, warnings: [] as string[] };

function baseArgs(over: Partial<CreateJobArgs> = {}): CreateJobArgs {
  return {
    userId: 'user-1',
    session: { phase: 'closed' } as never,
    debateId: 'deb-1',
    models: { modelId: 'gemini-2.5-flash', modelSource: 'Default' },
    request: { preset: 'policymaker', skipNarration: false },
    toolVersions: { node: 'v20', brief: '1.0' },
    timestamp: '2026-08-19T00:00:00.000Z',
    adapter: { generateText: vi.fn() } as never,
    ...over,
  };
}

/** artifact names handed to the single saveBriefExport call. */
function savedArtifactNames(): string[] {
  const [, artifacts] = saveBriefExport.mock.calls[0] as [unknown, { name: string }[]];
  return artifacts.map(a => a.name);
}

async function waitTerminal(job: { status: string }) {
  await vi.waitFor(() => expect(['done', 'failed']).toContain(job.status));
}

describe('brief export runner (t/2804)', () => {
  beforeEach(() => {
    extractDeckSpec.mockReset().mockReturnValue(SPEC);
    narrate.mockReset().mockResolvedValue({ narration: NARRATION });
    render.mockReset().mockResolvedValue({ pptxBytes: new Uint8Array([1, 2, 3]), htmlDoc: '<html></html>', slideModels: [], warnings: [] });
    verify.mockReset().mockResolvedValue({ manifest: MANIFEST, hardFailures: [] });
    saveBriefExport.mockReset().mockResolvedValue(undefined);
  });

  it('happy path: persists deck_spec + narration + pptx + manifest and sets exportId', async () => {
    const job = await startExportJob(baseArgs());
    await waitTerminal(job);
    expect(job.status).toBe('done');
    expect(job.exportId).toBeTruthy();
    expect(job.errorCode).toBeUndefined();
    expect(saveBriefExport).toHaveBeenCalledTimes(1);
    const [rec] = saveBriefExport.mock.calls[0] as [{ status: string; title: string; traceCoveragePct: number }];
    expect(rec.status).toBe('done');
    expect(rec.title).toBe('Should AI be paused?');       // threaded from spec.meta.title
    expect(rec.traceCoveragePct).toBe(100);
    expect(savedArtifactNames()).toEqual(expect.arrayContaining([
      BRIEF_ARTIFACTS.deckSpec, BRIEF_ARTIFACTS.narration, BRIEF_ARTIFACTS.pptx, BRIEF_ARTIFACTS.manifest,
    ]));
  });

  it('TL MUST (b): a verify-gate FAILURE still persists the audit-manifest', async () => {
    verify.mockResolvedValue({ manifest: MANIFEST, hardFailures: ['trace coverage 60% < 80% threshold'] });
    const job = await startExportJob(baseArgs());
    await waitTerminal(job);
    expect(job.status).toBe('failed');
    expect(job.exportId).toBeNull();                       // a failed export is not returned as a downloadable id
    expect(job.errorCode).toBe('TraceGateFailure');        // mapped from the hardFailure text
    expect(saveBriefExport).toHaveBeenCalledTimes(1);
    // The manifest — the record of WHY it failed — is present even though the export failed.
    expect(savedArtifactNames()).toContain(BRIEF_ARTIFACTS.manifest);
    const [rec] = saveBriefExport.mock.calls[0] as [{ status: string; errorCode: string }];
    expect(rec.status).toBe('failed');
    expect(rec.errorCode).toBe('TraceGateFailure');
  });

  it('a schema hardFailure maps to SpecSchemaFailure (checked before trace)', async () => {
    verify.mockResolvedValue({ manifest: MANIFEST, hardFailures: ['deck_spec schema invalid', 'trace unresolved'] });
    const job = await startExportJob(baseArgs());
    await waitTerminal(job);
    expect(job.errorCode).toBe('SpecSchemaFailure');
  });

  it('a narrate THROW persists the partial artifacts (deck_spec) + maps to ModelUnavailable', async () => {
    narrate.mockRejectedValue(new Error('provider 503'));
    const job = await startExportJob(baseArgs());
    await waitTerminal(job);
    expect(job.status).toBe('failed');
    expect(job.errorCode).toBe('ModelUnavailable');
    // Diagnosable: the deck_spec captured before the throw is still persisted.
    expect(saveBriefExport).toHaveBeenCalledTimes(1);
    expect(savedArtifactNames()).toEqual([BRIEF_ARTIFACTS.deckSpec]);
    expect(render).not.toHaveBeenCalled();
  });

  it('skipNarration path still renders + verifies + persists', async () => {
    const job = await startExportJob(baseArgs({ request: { preset: 'classroom', skipNarration: true } }));
    await waitTerminal(job);
    expect(job.status).toBe('done');
    expect(narrate).toHaveBeenCalledWith(expect.objectContaining({ skipNarration: true }), expect.anything());
  });

  it('allowOpen: extracts a watermarked snapshot and surfaces the in-progress maturity warning (t/2851)', async () => {
    extractDeckSpec.mockReturnValue({ ...SPEC, meta: { ...SPEC.meta, snapshot: true, snapshot_note: 'IN PROGRESS' } });
    const job = await startExportJob(baseArgs({ session: { phase: 'open' } as never, request: { preset: 'policymaker', skipNarration: false, allowOpen: true } }));
    await waitTerminal(job);
    // extract was asked for the snapshot (allowOpen threaded through)
    expect(extractDeckSpec).toHaveBeenCalledWith(expect.objectContaining({ phase: 'open' }), { allowOpen: true });
    // an explicit maturity warning — a snapshot never masquerades as a final export
    expect(job.warnings.some(w => w.startsWith('in_progress_snapshot:'))).toBe(true);
  });

  it('allowOpen unset: a closed export passes no snapshot opts and adds no maturity warning (t/2851)', async () => {
    const job = await startExportJob(baseArgs());
    await waitTerminal(job);
    // Since t/2858 the call routes through runBriefPipeline, which always passes an opts object
    // `{ allowOpen: input.allowOpen }` — so an unset allowOpen is `{ allowOpen: undefined }`, not
    // bare `undefined`. Semantically identical (extract's opts.allowOpen is undefined either way).
    expect(extractDeckSpec).toHaveBeenCalledWith(expect.objectContaining({ phase: 'closed' }), { allowOpen: undefined });
    expect(job.warnings.some(w => w.startsWith('in_progress_snapshot:'))).toBe(false);
  });

  it('registry: getExportJob is user-scoped (another user cannot read the job)', async () => {
    const job = await startExportJob(baseArgs());
    await waitTerminal(job);
    expect(getExportJob(job.jobId, 'user-1')).not.toBeNull();
    expect(getExportJob(job.jobId, 'other-user')).toBeNull();
  });

  it('registry: idempotency lookup returns the in-window job for the same (user, debate, key)', async () => {
    const job = await startExportJob(baseArgs({ idempotencyKey: 'k-1' }));
    await waitTerminal(job);
    expect(findIdempotentJob('user-1', 'deb-1', 'k-1')?.jobId).toBe(job.jobId);
    expect(findIdempotentJob('user-1', 'deb-1', 'other-key')).toBeNull();
    expect(findIdempotentJob('user-1', 'deb-1', undefined)).toBeNull(); // no key ⇒ never idempotent
  });

  it('registry: sweep drops terminal jobs older than the TTL', async () => {
    const job = await startExportJob(baseArgs());
    await waitTerminal(job);
    // Backdate the terminal timestamp beyond the TTL, then sweep.
    (getExportJob(job.jobId, 'user-1') as { startedAt: number }).startedAt -= EXPORT_JOB_TTL_MS + 1000;
    sweepExportJobs();
    expect(getExportJob(job.jobId, 'user-1')).toBeNull();
    expect(countRunningExportJobs('user-1')).toBe(0);
  });

  // ── t/4177: another replica can answer the poll from the durable record ──

  it('replica-safety: the creation record exists before startExportJob resolves', async () => {
    let releaseNarrate!: () => void;
    narrate.mockImplementation(() => new Promise(r => { releaseNarrate = () => r({ narration: NARRATION }); }));
    const job = await startExportJob(baseArgs());
    const view = await resolveBriefExportJobPoll(job.jobId);   // what a second replica would read
    expect(view).not.toBeNull();
    expect(['queued', 'extracting', 'narrating']).toContain(view!.status);
    await vi.waitFor(() => expect(narrate).toHaveBeenCalled());
    releaseNarrate();
    await waitTerminal(job);
    expect(job.status).toBe('done');
  });

  it('replica-safety: a finished job is readable from the durable record with its exportId', async () => {
    const job = await startExportJob(baseArgs());
    await waitTerminal(job);
    await vi.waitFor(async () => expect((await resolveBriefExportJobPoll(job.jobId))?.status).toBe('done'));
    const view = await resolveBriefExportJobPoll(job.jobId);
    expect(view).toMatchObject({ status: 'done', progressPct: 100, exportId: job.exportId, error: null });
  });

  it('replica-safety: a heartbeat still in flight when the job ends cannot overwrite the terminal record', async () => {
    vi.useFakeTimers();
    try {
      let releaseNarrate!: () => void;
      narrate.mockImplementation(() => new Promise(r => { releaseNarrate = () => r({ narration: NARRATION }); }));
      const job = await startExportJob(baseArgs());
      let releaseHeartbeat!: () => void;
      heartbeatGate.wait = new Promise<void>(r => { releaseHeartbeat = r; });
      await vi.advanceTimersByTimeAsync(5_000);          // a heartbeat write starts and blocks
      releaseNarrate();
      await vi.waitFor(() => expect(job.status).toBe('done'));
      releaseHeartbeat();                                // the slow heartbeat lands now
      heartbeatGate.wait = null;
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(async () => expect((await resolveBriefExportJobPoll(job.jobId))?.status).toBe('done'));
      await vi.advanceTimersByTimeAsync(60_000);         // long past the staleness window
      expect((await resolveBriefExportJobPoll(job.jobId))?.status).toBe('done');
    } finally {
      heartbeatGate.wait = null;
      vi.useRealTimers();
    }
  });

  it('replica-safety: a failed job is readable from the durable record with its error code', async () => {
    narrate.mockRejectedValue(new Error('provider 503'));
    const job = await startExportJob(baseArgs());
    await waitTerminal(job);
    await vi.waitFor(async () => expect((await resolveBriefExportJobPoll(job.jobId))?.status).toBe('failed'));
    expect(await resolveBriefExportJobPoll(job.jobId)).toMatchObject({ status: 'failed', errorCode: 'ModelUnavailable' });
  });
});
