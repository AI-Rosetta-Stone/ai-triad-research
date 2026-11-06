// @vitest-environment node

/**
 * t/4712 — Inquiry stage progress integration with lib's stageProgress().
 *
 * Verifies:
 * 1. Web job progressPct matches lib's stageProgress() for every status
 * 2. During debating, successive onDebateProgress calls give rising progressPct [15,80], never-decreasing
 * 3. Late debate events after debating ends are ignored (guard: only update if job.status === 'debating')
 * 4. Old consumers without stageDetail field still work (field is optional)
 */

import { describe, it, expect } from 'vitest';
import { stageProgress } from '../../../lib/debate/debateProgressMapping.js';
import type { InquiryJobStatus } from '../../../lib/inquiry/index.js';
import {
  buildPollView,
  applyDebateProgressToJob,
  type InquiryPollProjection,
  type InquiryJob,
} from '../inquiryJobs.js';
import { jobProjection } from '../routes/inquiry.js';

describe('t/4712 — Inquiry stage progress (stageProgress parity)', () => {
  // Test 1: Parity with lib's stageProgress() for every status
  const allStatuses: InquiryJobStatus[] = [
    'queued', 'grounding', 'debating', 'judging', 'synthesizing',
    'done', 'done_truncated', 'failed',
  ];

  describe('parity with lib stageProgress()', () => {
    allStatuses.forEach((status) => {
      it(`status '${status}' produces progressPct matching stageProgress()`, () => {
        const projection: InquiryPollProjection = {
          jobId: 'test-job', status, resultId: null, error: null,
          debateId: null, terminationReason: null,
        };
        const poll = buildPollView(projection);
        const expected = stageProgress(status);
        expect(poll.progressPct).toBe(expected);
      });
    });
  });

  // t/4917: through the REAL path the GET /api/inquiry/:jobId route uses — applyDebateProgressToJob
  // (the production update function) -> jobProjection -> buildPollView. This is the regression test
  // the ticket requires: it fails on pre-fix main, where buildPollView's own stageProgress(p.status)
  // call (no fraction) pins progressPct at 15 for the whole debating stage regardless of what
  // applyDebateProgressToJob wrote into job.currentDebateFraction.
  describe('t/4917 — the poll rises through the debate as fractions arrive (not stuck at 15)', () => {
    function makeDebatingJob(): InquiryJob {
      return {
        jobId: 'job-1', userId: 'alice', status: 'debating', progressPct: 15,
        resultId: null, error: null, debateId: null, startedAt: Date.now(),
        currentDebateFraction: 0,
      };
    }

    it('rises strictly within [15, 80] as fraction updates arrive at 25%, 50%, 100%, and ends at 80', () => {
      const job = makeDebatingJob();
      const seenPct: number[] = [];

      for (const fraction of [0.25, 0.5, 1.0]) {
        applyDebateProgressToJob(job, { fraction, detail: `Round at ${fraction}` });
        const poll = buildPollView(jobProjection(job));
        expect(poll.progressPct).toBeGreaterThanOrEqual(15);
        expect(poll.progressPct).toBeLessThanOrEqual(80);
        expect(poll.stageDetail).toBe(`Round at ${fraction}`);
        seenPct.push(poll.progressPct as number);
      }

      for (let i = 1; i < seenPct.length; i++) expect(seenPct[i]).toBeGreaterThan(seenPct[i - 1]);
      expect(seenPct[seenPct.length - 1]).toBe(80);
    });

    it('never moves backward even if a later update reports a smaller fraction (retry/reorder)', () => {
      const job = makeDebatingJob();
      applyDebateProgressToJob(job, { fraction: 0.5, detail: 'mid' });
      const highPct = buildPollView(jobProjection(job)).progressPct as number;

      applyDebateProgressToJob(job, { fraction: 0.2, detail: 'stale retry' });
      const afterPct = buildPollView(jobProjection(job)).progressPct as number;

      expect(afterPct).toBe(highPct);
    });

    it('a late debate-progress event after the job left the debating stage is ignored', () => {
      const job = makeDebatingJob();
      applyDebateProgressToJob(job, { fraction: 0.5, detail: 'mid-debate' });
      job.status = 'judging';
      job.progressPct = stageProgress('judging');

      applyDebateProgressToJob(job, { fraction: 1.0, detail: 'stray post-debate event' });

      // progressPct is untouched by the stray event (guarded on job.status === 'debating'),
      // but currentDebateFraction/currentStageDetail still record it for observability — only
      // the guard inside applyDebateProgressToJob, not the poll, is under test here.
      expect(job.progressPct).toBe(stageProgress('judging'));
      const poll = buildPollView(jobProjection(job));
      expect(poll.progressPct).toBe(stageProgress('judging'));
    });
  });

  // Test 3: Late events after debating ends are ignored
  describe('ignoring late events after debating ends', () => {
    it('a debate progress event after debating is ignored (guard: status !== debating)', () => {
      // Simulate: job moves to 'judging' status (debate is over)
      // A stray onDebateProgress event should not update the status
      const projection: InquiryPollProjection = {
        jobId: 'test-job', status: 'judging',
        resultId: null, error: null, debateId: null, terminationReason: null,
      };
      const poll = buildPollView(projection);

      // Progress should be judging's value, not affected by any debate fraction
      const expectedJudgingProgress = stageProgress('judging');
      expect(poll.progressPct).toBe(expectedJudgingProgress);

      // Verify it's fixed at the judging value (no debate fraction applied)
      const judging_with_fraction_0 = stageProgress('judging', 0);
      const judging_with_fraction_1 = stageProgress('judging', 1);
      // For non-debating stages, fraction is ignored, so both should match
      expect(judging_with_fraction_0).toBe(judging_with_fraction_1);
      expect(poll.progressPct).toBe(judging_with_fraction_0);
    });
  });

  // Test 4: Old consumers without stageDetail still work (optional field)
  describe('backwards compatibility: optional stageDetail field', () => {
    it('poll response includes stageDetail when provided', () => {
      const projection: InquiryPollProjection = {
        jobId: 'test-job', status: 'debating',
        resultId: null, error: null, debateId: null, terminationReason: null,
        stageDetail: 'Round 1 of 3 · Accelerationist opening',
      };
      const poll = buildPollView(projection);
      expect(poll.stageDetail).toBe('Round 1 of 3 · Accelerationist opening');
    });

    it('poll response omits stageDetail when not provided (old consumers still work)', () => {
      const projection: InquiryPollProjection = {
        jobId: 'test-job', status: 'debating',
        resultId: null, error: null, debateId: null, terminationReason: null,
        // stageDetail intentionally omitted
      };
      const poll = buildPollView(projection);
      expect(poll.stageDetail).toBeUndefined();
      // Old consumers read progressPct; verify it's present
      expect(poll.progressPct).toBeDefined();
    });
  });
});
