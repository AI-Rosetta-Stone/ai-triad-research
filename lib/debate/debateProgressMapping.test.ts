// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { createDebateProgressTracker, stageProgress, type DebateProgressUpdate } from './debateProgressMapping.js';
import type { DebateProgress } from './debateEngine/internals.js';

function makeProgress(overrides: Partial<DebateProgress> & { phase: string; message: string }): DebateProgress {
  return overrides;
}

describe('createDebateProgressTracker', () => {
  it('rises monotonically across a full simulated run (openings, debate rounds, closing phases)', () => {
    const updates: DebateProgressUpdate[] = [];
    const track = createDebateProgressTracker(u => updates.push(u));

    track(makeProgress({ phase: 'setup', message: 'Evaluating topic quality' }));
    track(makeProgress({ phase: 'opening', speaker: 'accelerationist', totalRounds: 2, message: 'Accelerationist preparing opening statement' }));
    track(makeProgress({ phase: 'opening', speaker: 'safetyist', totalRounds: 2, message: 'Safetyist preparing opening statement' }));
    track(makeProgress({ phase: 'opening', speaker: 'skeptic', totalRounds: 2, message: 'Skeptic preparing opening statement' }));
    for (const round of [1, 2]) {
      for (const speaker of ['accelerationist', 'safetyist', 'skeptic']) {
        track(makeProgress({ phase: 'debate', speaker, round, totalRounds: 2, message: `${speaker} responding (round ${round})` }));
      }
    }
    track(makeProgress({ phase: 'concluding', totalRounds: 2, message: 'Generating synthesis' }));
    track(makeProgress({ phase: 'evaluation', totalRounds: 2, message: 'Neutral evaluation: final' }));
    track(makeProgress({ phase: 'compression', totalRounds: 2, message: 'Compressing debate history' }));

    for (let i = 1; i < updates.length; i++) {
      expect(updates[i].fraction).toBeGreaterThanOrEqual(updates[i - 1].fraction);
    }
    expect(updates[0].fraction).toBe(0); // 'setup' carries no totalRounds yet in this sequence's first event
    expect(updates[updates.length - 1].fraction).toBe(1);
  });

  it('never decreases the fraction on a retry event, but does update detail', () => {
    const updates: DebateProgressUpdate[] = [];
    const track = createDebateProgressTracker(u => updates.push(u));

    track(makeProgress({ phase: 'opening', speaker: 'accelerationist', totalRounds: 2, message: 'x' }));
    track(makeProgress({ phase: 'opening', speaker: 'safetyist', totalRounds: 2, message: 'x' }));
    const beforeRetry = updates[updates.length - 1].fraction;

    track(makeProgress({ phase: 'retry', message: 'retrying', retry: { attempt: 1, maxRetries: 3, backoffSeconds: 5 } }));
    const retryUpdate = updates[updates.length - 1];

    expect(retryUpdate.fraction).toBe(beforeRetry);
    expect(retryUpdate.detail).toBe('Waiting to retry…');
  });

  it('never decreases the fraction for a brief.* event', () => {
    const updates: DebateProgressUpdate[] = [];
    const track = createDebateProgressTracker(u => updates.push(u));

    track(makeProgress({ phase: 'debate', speaker: 'accelerationist', round: 1, totalRounds: 2, message: 'x' }));
    const before = updates[updates.length - 1].fraction;

    track(makeProgress({ phase: 'brief.timeout', message: 'Brief timed out', brief: { agent: 'accelerationist', attempt: 1, maxRetries: 2, elapsedMs: 5000 } }));
    expect(updates[updates.length - 1].fraction).toBe(before);
  });

  it('ratchets through a stale out-of-order event instead of decreasing', () => {
    const updates: DebateProgressUpdate[] = [];
    const track = createDebateProgressTracker(u => updates.push(u));

    // Advance well into round 2 of 2.
    for (const round of [1, 2]) {
      for (const speaker of ['accelerationist', 'safetyist', 'skeptic']) {
        track(makeProgress({ phase: 'debate', speaker, round, totalRounds: 2, message: 'x' }));
      }
    }
    const peak = updates[updates.length - 1].fraction;

    // A stale, already-seen round-1 event arrives late (duplicate, not new information).
    track(makeProgress({ phase: 'debate', speaker: 'accelerationist', round: 1, totalRounds: 2, message: 'x' }));
    expect(updates[updates.length - 1].fraction).toBe(peak);
    expect(updates[updates.length - 1].fraction).toBeGreaterThanOrEqual(peak);
  });

  it('dedupes repeated evaluation checkpoints into one closing milestone', () => {
    const updates: DebateProgressUpdate[] = [];
    const track = createDebateProgressTracker(u => updates.push(u));

    track(makeProgress({ phase: 'evaluation', totalRounds: 1, message: 'Neutral evaluation: midpoint' }));
    const afterFirst = updates[updates.length - 1].fraction;
    track(makeProgress({ phase: 'evaluation', totalRounds: 1, message: 'Neutral evaluation: final' }));
    expect(updates[updates.length - 1].fraction).toBe(afterFirst);
  });

  it('clamps the fraction to [0, 1] even with no totalRounds known', () => {
    const updates: DebateProgressUpdate[] = [];
    const track = createDebateProgressTracker(u => updates.push(u));
    track(makeProgress({ phase: 'setup', message: 'x' }));
    expect(updates[0].fraction).toBeGreaterThanOrEqual(0);
    expect(updates[0].fraction).toBeLessThanOrEqual(1);
  });
});

describe('describeProgress / detail strings (via createDebateProgressTracker)', () => {
  it('renders "Opening statements" for the opening phase', () => {
    const updates: DebateProgressUpdate[] = [];
    const track = createDebateProgressTracker(u => updates.push(u));
    track(makeProgress({ phase: 'opening', speaker: 'skeptic', totalRounds: 2, message: 'ignored' }));
    expect(updates[0].detail).toBe('Opening statements');
  });

  it('renders "Round N of M · Speaker responding" for the debate phase', () => {
    const updates: DebateProgressUpdate[] = [];
    const track = createDebateProgressTracker(u => updates.push(u));
    track(makeProgress({ phase: 'debate', speaker: 'skeptic', round: 2, totalRounds: 4, message: 'ignored' }));
    expect(updates[0].detail).toBe('Round 2 of 4 · Skeptic responding');
  });

  it('falls back to the raw message for other phases', () => {
    const updates: DebateProgressUpdate[] = [];
    const track = createDebateProgressTracker(u => updates.push(u));
    track(makeProgress({ phase: 'compression', message: 'Compressing debate history' }));
    expect(updates[0].detail).toBe('Compressing debate history');
  });
});

describe('stageProgress', () => {
  it('maps the non-debating boundaries', () => {
    expect(stageProgress('queued')).toBe(0);
    expect(stageProgress('grounding')).toBe(15);
    expect(stageProgress('judging')).toBe(92);
    expect(stageProgress('synthesizing')).toBe(100);
    expect(stageProgress('done')).toBe(100);
    expect(stageProgress('done_truncated')).toBe(100);
    expect(stageProgress('failed')).toBe(100);
  });

  it('interpolates 15-80 across the debating fraction', () => {
    expect(stageProgress('debating', 0)).toBe(15);
    expect(stageProgress('debating', 1)).toBe(80);
    expect(stageProgress('debating', 0.5)).toBeCloseTo(47.5);
  });

  it('clamps an out-of-range debating fraction', () => {
    expect(stageProgress('debating', -1)).toBe(15);
    expect(stageProgress('debating', 2)).toBe(80);
  });

  it('defaults the debating fraction to 0 when omitted', () => {
    expect(stageProgress('debating')).toBe(15);
  });
});
