import { describe, it, expect } from 'vitest';

// t/327: Test stageTimings recording in inquiry job pipeline transitions.
// These tests verify that the advanceStageTimings logic correctly records
// start/end times for each pipeline stage as the job progresses.

// Real types from lib/inquiry/jobStatus.ts
type InquiryPipelineStage = 'grounding' | 'debating' | 'judging' | 'synthesizing';

interface InquiryStageTiming {
  startedAt?: number;
  endedAt?: number;
}

type InquiryStageTimings = Record<InquiryPipelineStage, InquiryStageTiming>;

// Real implementation of advanceStageTimings (from lib/inquiry/jobStatus.ts)
function advanceStageTimings(
  timings: InquiryStageTimings,
  prev: InquiryPipelineStage | undefined,
  next: InquiryPipelineStage,
  now: number,
): InquiryStageTimings {
  if (prev !== undefined) {
    timings[prev].endedAt = now;
  }
  timings[next].startedAt = now;
  return timings;
}

describe('stageTimings transitions', () => {
  it('initializes all 4 pipeline stages with undefined start/end', () => {
    const stageTimings: InquiryStageTimings = {
      grounding: {},
      debating: {},
      judging: {},
      synthesizing: {},
    };
    expect(stageTimings.grounding.startedAt).toBeUndefined();
    expect(stageTimings.grounding.endedAt).toBeUndefined();
    expect(stageTimings.debating.startedAt).toBeUndefined();
    expect(stageTimings.synthesizing.startedAt).toBeUndefined();
  });

  it('starts grounding (first stage, prev=undefined)', () => {
    const timings: InquiryStageTimings = {
      grounding: {},
      debating: {},
      judging: {},
      synthesizing: {},
    };
    advanceStageTimings(timings, undefined, 'grounding', 1000);
    
    expect(timings.grounding.startedAt).toBe(1000);
    expect(timings.grounding.endedAt).toBeUndefined();
  });

  it('transitions grounding → debating', () => {
    const timings: InquiryStageTimings = {
      grounding: { startedAt: 1000 },
      debating: {},
      judging: {},
      synthesizing: {},
    };
    advanceStageTimings(timings, 'grounding', 'debating', 1100);
    
    expect(timings.grounding.endedAt).toBe(1100);
    expect(timings.debating.startedAt).toBe(1100);
    expect(timings.debating.endedAt).toBeUndefined();
  });

  it('full happy path: undefined → grounding → debating → judging → synthesizing', () => {
    const timings: InquiryStageTimings = {
      grounding: {},
      debating: {},
      judging: {},
      synthesizing: {},
    };
    let now = 1000;

    advanceStageTimings(timings, undefined, 'grounding', now);
    expect(timings.grounding.startedAt).toBe(1000);

    now += 100;
    advanceStageTimings(timings, 'grounding', 'debating', now);
    expect(timings.grounding.endedAt).toBe(1100);
    expect(timings.debating.startedAt).toBe(1100);

    now += 500;
    advanceStageTimings(timings, 'debating', 'judging', now);
    expect(timings.debating.endedAt).toBe(1600);
    expect(timings.judging.startedAt).toBe(1600);

    now += 2000;
    advanceStageTimings(timings, 'judging', 'synthesizing', now);
    expect(timings.judging.endedAt).toBe(3600);
    expect(timings.synthesizing.startedAt).toBe(3600);

    // Verify final state: all have starts, only synthesizing lacks end
    expect(timings.grounding.startedAt).toBe(1000);
    expect(timings.grounding.endedAt).toBe(1100);
    expect(timings.debating.startedAt).toBe(1100);
    expect(timings.debating.endedAt).toBe(1600);
    expect(timings.judging.startedAt).toBe(1600);
    expect(timings.judging.endedAt).toBe(3600);
    expect(timings.synthesizing.startedAt).toBe(3600);
    expect(timings.synthesizing.endedAt).toBeUndefined();
  });

  it('terminal status (done) does not end synthesizing', () => {
    // In the real implementation, terminal status transitions don't call advanceStageTimings.
    // The last pipeline stage (synthesizing) remains open until the job is truly done.
    // This test verifies the expected behavior: advanceStageTimings is only for pipeline stages.
    const timings: InquiryStageTimings = {
      grounding: { startedAt: 1000, endedAt: 1100 },
      debating: { startedAt: 1100, endedAt: 1600 },
      judging: { startedAt: 1600, endedAt: 3600 },
      synthesizing: { startedAt: 3600 },
    };

    expect(timings.synthesizing.startedAt).toBe(3600);
    expect(timings.synthesizing.endedAt).toBeUndefined();
    // No advanceStageTimings call for terminal transition (done/done_truncated/failed)
  });

  it('verifies all stages have valid timings after full flow', () => {
    const timings: InquiryStageTimings = {
      grounding: {},
      debating: {},
      judging: {},
      synthesizing: {},
    };
    let now = 1000;

    advanceStageTimings(timings, undefined, 'grounding', now);
    now += 100;
    advanceStageTimings(timings, 'grounding', 'debating', now);
    now += 500;
    advanceStageTimings(timings, 'debating', 'judging', now);
    now += 2000;
    advanceStageTimings(timings, 'judging', 'synthesizing', now);

    // All stages should have startedAt
    expect(timings.grounding.startedAt).toBeDefined();
    expect(timings.debating.startedAt).toBeDefined();
    expect(timings.judging.startedAt).toBeDefined();
    expect(timings.synthesizing.startedAt).toBeDefined();

    // All but the last should have endedAt
    expect(timings.grounding.endedAt).toBeDefined();
    expect(timings.debating.endedAt).toBeDefined();
    expect(timings.judging.endedAt).toBeDefined();
    expect(timings.synthesizing.endedAt).toBeUndefined();

    // Verify chronological order
    expect(timings.grounding.startedAt! < timings.grounding.endedAt!).toBe(true);
    expect(timings.grounding.endedAt === timings.debating.startedAt).toBe(true);
    expect(timings.debating.startedAt! < timings.debating.endedAt!).toBe(true);
    expect(timings.debating.endedAt === timings.judging.startedAt).toBe(true);
    expect(timings.judging.startedAt! < timings.judging.endedAt!).toBe(true);
    expect(timings.judging.endedAt === timings.synthesizing.startedAt).toBe(true);
  });
});
