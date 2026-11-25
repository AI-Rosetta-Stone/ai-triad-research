// @vitest-environment node
// t/326: the inquiry job records when each pipeline stage started and ended, the status response
// carries it, and a durable record without the field still loads. Same store mocks as inquiryJobs.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InquiryResult, InquiryRequest } from '../../../../lib/inquiry/index.js';

const persisted = new Map<string, InquiryResult>();
vi.mock('../storage/inquiryResultStore.js', () => ({
  saveInquiryResult: vi.fn(async (jobId: string, result: InquiryResult) => { persisted.set(jobId, result); }),
  loadInquiryResult: vi.fn(async (jobId: string) => persisted.get(jobId) ?? null),
  listInquiryResults: vi.fn(async () => []),
}));
vi.mock('../storage/inquiryJobStore.js', () => ({
  saveInquiryJobRecord: vi.fn(async () => undefined),
  deleteInquiryJobRecord: vi.fn(async () => undefined),
  markJobFailedIfStale: vi.fn(async () => null),
  INQUIRY_HEARTBEAT_WORST_SYNC_BLOCK_MS: 8_000,
  INQUIRY_HEARTBEAT_INTERVAL_MS: 5_000,
  INQUIRY_HEARTBEAT_STALE_MS: 30_000,
}));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('../logger.js', () => ({
  log: { server: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
  getRequestId: () => 'req-test',
}));

import {
  startInquiryJob, getInquiryJob, buildPollView, _resetInquiryJobsForTest,
  type InquiryPipelineRunner,
} from '../inquiryJobs.js';
import { jobProjection } from '../routes/inquiry.js';
import { saveInquiryJobRecord } from '../storage/inquiryJobStore.js';

const USER = 'user-1';
const REQUEST: InquiryRequest = { question: 'What counts as an AI harm?', fidelity: 'standard' };
const pause = (ms = 5) => new Promise(r => setTimeout(r, ms));
function cleanResult(): InquiryResult {
  return { calibration: [{ metric: 'situation_crux_alignment', value: 0.8, trust: { verdict: 'trust', reason: 'natural conclusion', terminationReason: 'natural' } }] } as unknown as InquiryResult;
}

beforeEach(() => {
  _resetInquiryJobsForTest();
  persisted.clear();
  vi.mocked(saveInquiryJobRecord).mockClear();
});

describe('t/326 — stage timings recorded as the job moves', () => {
  it('the status response shows each stage with a start, and each finished stage with an end, in order', async () => {
    const runPipeline: InquiryPipelineRunner = async (_req, ctx) => {
      ctx.onStage('grounding'); await pause();
      ctx.onStage('debating'); await pause();
      ctx.onStage('judging'); await pause();
      ctx.onStage('synthesizing'); await pause();
      return cleanResult();
    };
    const job = await startInquiryJob({ userId: USER, request: REQUEST, runPipeline, jobId: 'job-t326-a' });
    for (let i = 0; i < 100 && getInquiryJob('job-t326-a', USER)?.status !== 'done'; i++) await pause(10);

    const finished = getInquiryJob('job-t326-a', USER)!;
    expect(finished.status).toBe('done');
    const t = finished.stageTimings;
    for (const stage of ['grounding', 'debating', 'judging', 'synthesizing'] as const) {
      expect(t[stage].startedAt).toBeTypeOf('number');
      expect(t[stage].endedAt).toBeTypeOf('number');
      expect(t[stage].endedAt!).toBeGreaterThanOrEqual(t[stage].startedAt!);
    }
    // Stages do not overlap: each starts at or after the previous one ended.
    expect(t.debating.startedAt!).toBeGreaterThanOrEqual(t.grounding.endedAt!);
    expect(t.judging.startedAt!).toBeGreaterThanOrEqual(t.debating.endedAt!);
    expect(t.synthesizing.startedAt!).toBeGreaterThanOrEqual(t.judging.endedAt!);

    // The status response carries them (the real projection the route uses).
    const body = buildPollView(jobProjection(finished));
    expect(body.stageTimings).toEqual(t);
    expect(job.jobId).toBe('job-t326-a');
  });

  it('a failed job closes the stage it was in, so the timing shows where it stopped', async () => {
    const runPipeline: InquiryPipelineRunner = async (_req, ctx) => {
      ctx.onStage('grounding'); await pause();
      ctx.onStage('debating'); await pause();
      throw new Error('pipeline exploded');
    };
    await startInquiryJob({ userId: USER, request: REQUEST, runPipeline, jobId: 'job-t326-b' });
    for (let i = 0; i < 100 && getInquiryJob('job-t326-b', USER)?.status !== 'failed'; i++) await pause(10);

    const failed = getInquiryJob('job-t326-b', USER)!;
    expect(failed.status).toBe('failed');
    expect(failed.stageTimings.debating.startedAt).toBeTypeOf('number');
    expect(failed.stageTimings.debating.endedAt).toBeTypeOf('number');
    expect(failed.stageTimings.judging.startedAt).toBeUndefined(); // never entered
  });

  it('a repeated stage is not re-timed: the first start is kept', async () => {
    let job!: Awaited<ReturnType<typeof startInquiryJob>>;
    const runPipeline: InquiryPipelineRunner = async (_req, ctx) => {
      ctx.onStage('debating');
      const firstStart = getInquiryJob('job-t326-c', USER)!.stageTimings.debating.startedAt;
      await pause(20);
      ctx.onStage('debating'); // same stage again
      expect(getInquiryJob('job-t326-c', USER)!.stageTimings.debating.startedAt).toBe(firstStart);
      return cleanResult();
    };
    job = await startInquiryJob({ userId: USER, request: REQUEST, runPipeline, jobId: 'job-t326-c' });
    for (let i = 0; i < 100 && getInquiryJob('job-t326-c', USER)?.status !== 'done'; i++) await pause(10);
    expect(job.jobId).toBe('job-t326-c');
  });

  it('the durable job record carries the timings, so a poll after a restart can show them', async () => {
    const runPipeline: InquiryPipelineRunner = async (_req, ctx) => { ctx.onStage('grounding'); await pause(); return cleanResult(); };
    await startInquiryJob({ userId: USER, request: REQUEST, runPipeline, jobId: 'job-t326-d' });
    for (let i = 0; i < 100 && getInquiryJob('job-t326-d', USER)?.status !== 'done'; i++) await pause(10);
    const writes = vi.mocked(saveInquiryJobRecord).mock.calls.map(c => c[0] as { stageTimings?: unknown });
    expect(writes.some(r => r.stageTimings !== undefined)).toBe(true);
  });
});

describe('t/326 — an older durable record without the field', () => {
  it('its status response has no stageTimings and no error', () => {
    const body = buildPollView({
      jobId: 'old-job', status: 'debating', resultId: null, error: null, debateId: null, terminationReason: null,
      // stageTimings deliberately absent: a record written before t/326
    });
    expect(body.stageTimings).toBeUndefined();
    expect('stageTimings' in body).toBe(false);
    expect(body.status).toBe('debating');
  });
});
