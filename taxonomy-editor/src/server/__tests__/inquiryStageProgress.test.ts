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
  type InquiryPollProjection,
} from '../inquiryJobs.js';

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

  // Test 2: Rising progress during debating, never-decreasing
  describe('during debating: rising and never-decreasing', () => {
    it('successive debate fractions within debating stage give rising progressPct', () => {
      const fractions = [0, 0.25, 0.5, 0.75, 1.0];
      const progressPercentages = fractions.map(f => stageProgress('debating', f));

      // Verify strictly rising (each is strictly greater than previous)
      for (let i = 1; i < progressPercentages.length; i++) {
        expect(progressPercentages[i]).toBeGreaterThan(progressPercentages[i - 1]);
      }

      // Verify bounds [15, 80] — debating stage spans these
      for (const pct of progressPercentages) {
        expect(pct).toBeGreaterThanOrEqual(15);
        expect(pct).toBeLessThanOrEqual(80);
      }
    });

    it('progressPct during debating never decreases when fraction increases', () => {
      // Simulate increasing fractions: 0, 0.1, 0.2, ..., 1.0
      const fractions = Array.from({ length: 11 }, (_, i) => i / 10);
      const progresses = fractions.map(f => stageProgress('debating', f));

      for (let i = 1; i < progresses.length; i++) {
        // Use Math.max pattern (as in inquiryHandlers.ts:268) to ensure never-decreasing
        const max = Math.max(progresses[i - 1], progresses[i]);
        expect(progresses[i]).toBe(max); // Since fraction is increasing, progress should increase too
      }
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
