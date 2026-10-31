// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// ── Ask a Question debate-phase progress mapping (t/4710/t/4711) ───────
//
// The Debate stage is the longest part of an Ask a Question run by far, and both hosts
// (server/inquiryJobs.ts, main/ipc/inquiryHandlers.ts) used to report a single fixed
// percentage for the whole stage — the bar sat at 40% for most of the run. The debate
// engine already reports per-turn DebateProgress (headlessRunner.ts); this module turns
// that into a monotonic [0,1] fraction + a short human detail line, and provides the one
// shared stage-to-percent mapping both hosts read instead of each carrying its own
// PROGRESS table.

import type { DebateProgress } from './debateEngine/internals.js';
import type { InquiryJobStatus } from '../inquiry/jobStatus.js';

export interface DebateProgressUpdate {
  /** [0, 1], monotonic — never decreases across the life of one tracker. */
  fraction: number;
  /** Short human line, e.g. "Opening statements" or "Round 2 of 4 · Skeptic responding". */
  detail: string;
}

/** The three POV debaters. Fixed — the engine is a three-agent BDI debate (AGENTS.md). */
const SPEAKER_COUNT = 3;

/** Closing-phase names, in the order the synthesis pipeline emits them (synthesisPipeline.ts).
 *  Treated as discrete milestones toward the final chunk of the fraction — multiple events
 *  for the same phase (e.g. several 'evaluation' checkpoints) count once each. */
const CLOSING_PHASES: ReadonlySet<string> = new Set(['concluding', 'evaluation', 'compression']);

function capitalize(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Short human line for a progress event. Never throws, never empty. */
function describeProgress(p: DebateProgress): string {
  if (p.phase === 'retry') return 'Waiting to retry…';
  if (p.phase === 'opening') return 'Opening statements';
  if (p.phase === 'debate' && p.round != null && p.totalRounds != null) {
    const who = p.speaker ? ` · ${capitalize(p.speaker)} responding` : '';
    return `Round ${p.round} of ${p.totalRounds}${who}`;
  }
  return p.message;
}

/**
 * Create a fresh, stateful tracker for one debate run. Feed it every `DebateProgress`
 * event in order (as `headlessRunner.ts`'s `onProgress` fires); it calls `onUpdate` with
 * a monotonic fraction and a detail line.
 *
 * - Retry/backoff events (`phase === 'retry'`) and brief-timeout events (`phase` starting
 *   with `'brief.'`) update `detail` but never move the fraction — they're not a unit of
 *   debate work completing.
 * - The fraction is a ratchet (`Math.max` against every fraction computed so far), so a
 *   stale or out-of-order event can only ever fail to raise it, never lower it.
 * - `totalRounds` is read from the first event that carries it (every real engine event
 *   does, per `DebateEngine.progress()`) and locked in — expected debate-turn count never
 *   changes mid-run.
 */
export function createDebateProgressTracker(
  onUpdate: (p: DebateProgressUpdate) => void,
): (p: DebateProgress) => void {
  let maxFraction = 0;
  let totalRounds: number | undefined;
  const openingsSeen = new Set<string>();
  const debateTurnsSeen = new Set<string>();
  const closingPhasesSeen = new Set<string>();

  return (p: DebateProgress): void => {
    const detail = describeProgress(p);
    const isRetryOrBrief = p.phase === 'retry' || p.phase.startsWith('brief.');

    if (!isRetryOrBrief) {
      if (totalRounds === undefined && p.totalRounds != null) totalRounds = p.totalRounds;

      if (p.phase === 'opening' && p.speaker) {
        openingsSeen.add(p.speaker);
      } else if (p.phase === 'debate' && p.speaker && p.round != null) {
        debateTurnsSeen.add(`${p.round}:${p.speaker}`);
      } else if (CLOSING_PHASES.has(p.phase)) {
        closingPhasesSeen.add(p.phase);
      }

      const expectedDebateTurns = (totalRounds ?? 0) * SPEAKER_COUNT;
      const totalUnits = SPEAKER_COUNT + expectedDebateTurns + CLOSING_PHASES.size;
      const completedUnits = openingsSeen.size + debateTurnsSeen.size + closingPhasesSeen.size;
      const rawFraction = totalUnits > 0 ? completedUnits / totalUnits : 0;
      maxFraction = Math.max(maxFraction, Math.min(1, Math.max(0, rawFraction)));
    }

    onUpdate({ fraction: maxFraction, detail });
  };
}

const GROUNDING_PCT = 15;
const DEBATE_LOW_PCT = 15;
const DEBATE_HIGH_PCT = 80;
const JUDGING_PCT = 92;
const SYNTHESIZING_PCT = 100;

/**
 * The one stage-to-percent mapping for an Ask a Question job, replacing both hosts'
 * local `PROGRESS` tables (server/inquiryJobs.ts, main/ipc/inquiryHandlers.ts).
 * `debateFraction` (from `createDebateProgressTracker`, [0, 1]) only matters while
 * `status === 'debating'` — it's ignored (and may be omitted) for every other status.
 */
export function stageProgress(status: InquiryJobStatus, debateFraction: number = 0): number {
  switch (status) {
    case 'queued': return 0;
    case 'grounding': return GROUNDING_PCT;
    case 'debating': {
      const clamped = Math.min(1, Math.max(0, debateFraction));
      return DEBATE_LOW_PCT + clamped * (DEBATE_HIGH_PCT - DEBATE_LOW_PCT);
    }
    case 'judging': return JUDGING_PCT;
    case 'synthesizing': return SYNTHESIZING_PCT;
    case 'done': case 'done_truncated': case 'failed': return 100;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
