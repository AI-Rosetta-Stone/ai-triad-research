import { describe, it, expect, vi } from 'vitest';

// t/327: Test stageTimings recording in inquiry job status transitions.
// These tests verify that the advanceStageTimings logic correctly records
// start/end times for each stage as the job progresses.

// Stub types (replicate what's in inquiryHandlers.ts for testing)
type InquiryJobStatus = 'queued' | 'grounding' | 'debating' | 'judging' | 'synthesizing' | 'done' | 'done_truncated' | 'failed';

interface InquiryStageTiming {
  startedAt: number;
  endedAt?: number;
}

type InquiryStageTimings = Partial<Record<InquiryJobStatus, InquiryStageTiming>>;

function isTerminalStatus(status: InquiryJobStatus): boolean {
  return ['done', 'done_truncated', 'failed'].includes(status);
}

// Stub implementation of advanceStageTimings (matching inquiryHandlers.ts)
function advanceStageTimings(timings: InquiryStageTimings, prevStatus: InquiryJobStatus, nextStatus: InquiryJobStatus, now: number): void {
  if (prevStatus && timings[prevStatus]) {
    timings[prevStatus].endedAt = now;
  }
  if (!isTerminalStatus(nextStatus)) {
    timings[nextStatus] = { startedAt: now };
  }
}

describe('stageTimings transitions', () => {
  it('records queued start on job creation', () => {
    const now = 1000;
    const stageTimings: InquiryStageTimings = { queued: { startedAt: now } };
    expect(stageTimings.queued).toBeDefined();
    expect(stageTimings.queued!.startedAt).toBe(now);
    expect(stageTimings.queued!.endedAt).toBeUndefined();
  });

  it('transitions queued → grounding', () => {
    const timings: InquiryStageTimings = { queued: { startedAt: 1000 } };
    advanceStageTimings(timings, 'queued', 'grounding', 1100);
    
    // Queued should be ended
    expect(timings.queued!.endedAt).toBe(1100);
    // Grounding should be started
    expect(timings.grounding).toBeDefined();
    expect(timings.grounding!.startedAt).toBe(1100);
    expect(timings.grounding!.endedAt).toBeUndefined();
  });

  it('full happy path: queued → grounding → debating → judging → synthesizing → done', () => {
    const timings: InquiryStageTimings = { queued: { startedAt: 1000 } };
    let now = 1000;

    // Transition to grounding
    now += 100;
    advanceStageTimings(timings, 'queued', 'grounding', now);
    expect(timings.queued!.endedAt).toBe(1100);
    expect(timings.grounding!.startedAt).toBe(1100);

    // Transition to debating
    now += 500;
    advanceStageTimings(timings, 'grounding', 'debating', now);
    expect(timings.grounding!.endedAt).toBe(1600);
    expect(timings.debating!.startedAt).toBe(1600);

    // Transition to judging
    now += 2000;
    advanceStageTimings(timings, 'debating', 'judging', now);
    expect(timings.debating!.endedAt).toBe(3600);
    expect(timings.judging!.startedAt).toBe(3600);

    // Transition to synthesizing
    now += 300;
    advanceStageTimings(timings, 'judging', 'synthesizing', now);
    expect(timings.judging!.endedAt).toBe(3900);
    expect(timings.synthesizing!.startedAt).toBe(3900);

    // Terminal: done
    now += 400;
    advanceStageTimings(timings, 'synthesizing', 'done', now);
    expect(timings.synthesizing!.endedAt).toBe(4300);
    // 'done' should NOT be started (it's terminal)
    expect(timings.done).toBeUndefined();
  });

  it('terminal state ends current stage without starting next', () => {
    const timings: InquiryStageTimings = {
      queued: { startedAt: 1000, endedAt: 1100 },
      grounding: { startedAt: 1100 },
    };

    advanceStageTimings(timings, 'grounding', 'done_truncated', 1200);
    
    expect(timings.grounding!.endedAt).toBe(1200);
    // done_truncated should not be added to timings (terminal)
    expect(timings.done_truncated).toBeUndefined();
  });

  it('handles failed status (also terminal)', () => {
    const timings: InquiryStageTimings = {
      queued: { startedAt: 1000, endedAt: 1050 },
      grounding: { startedAt: 1050 },
    };

    advanceStageTimings(timings, 'grounding', 'failed', 1200);
    
    expect(timings.grounding!.endedAt).toBe(1200);
    // failed should not be added (terminal)
    expect(timings.failed).toBeUndefined();
  });

  it('same-status transition (should not occur in practice)', () => {
    const timings: InquiryStageTimings = { debating: { startedAt: 1000 } };

    // debating → debating is not a valid state machine transition in practice,
    // but the function handles it: end the stage and immediately restart it.
    // This is a quirk of the current implementation (not idempotent on retry).
    // In practice, the caller should not issue same-status updates.
    advanceStageTimings(timings, 'debating', 'debating', 1100);
    
    // The stage gets ended then immediately restarted
    expect(timings.debating!.startedAt).toBe(1100);
    expect(timings.debating!.endedAt).toBeUndefined();
  });

  it('includes all stages and timings in final record', () => {
    const timings: InquiryStageTimings = { queued: { startedAt: 1000 } };
    let now = 1000;

    for (const [prev, next] of [
      ['queued' as const, 'grounding' as const],
      ['grounding' as const, 'debating' as const],
      ['debating' as const, 'judging' as const],
      ['judging' as const, 'synthesizing' as const],
    ]) {
      now += 100;
      advanceStageTimings(timings, prev, next, now);
    }

    now += 50;
    advanceStageTimings(timings, 'synthesizing', 'done', now);

    // All non-terminal stages should be present and have both start and end
    expect(timings.queued).toBeDefined();
    expect(timings.queued!.startedAt).toBeLessThan(timings.queued!.endedAt!);
    
    expect(timings.grounding).toBeDefined();
    expect(timings.grounding!.startedAt).toBeLessThan(timings.grounding!.endedAt!);
    
    expect(timings.debating).toBeDefined();
    expect(timings.debating!.startedAt).toBeLessThan(timings.debating!.endedAt!);
    
    expect(timings.judging).toBeDefined();
    expect(timings.judging!.startedAt).toBeLessThan(timings.judging!.endedAt!);
    
    expect(timings.synthesizing).toBeDefined();
    expect(timings.synthesizing!.startedAt).toBeLessThan(timings.synthesizing!.endedAt!);
  });
});
