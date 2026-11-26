// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/784: the concluding phase sends one COMMIT (final-position request) per debater, each generated
 * fresh. Without knowing what earlier ones said, the model opened each with the same recap sentence.
 * This returns every COMMIT intervention already in the transcript, whole, so the next one can be
 * told not to reuse it, and WARNs when a new one still shares a 6-word run with an earlier one.
 */

import { getGlobalRecorder } from '../flight-recorder/index.js';

interface EntryLike {
  type: string;
  speaker?: string;
  content?: string;
  intervention_metadata?: { move?: string };
}

/**
 * The target debater's most recent turn (opening or statement), so a COMMIT can press a point that
 * is recognisably theirs (Design, t/784). The 4-entry recent transcript often holds none of it.
 */
export function latestTurnOf(transcript: readonly EntryLike[], speaker: string, maxChars = 1500): string | undefined {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if (e.speaker === speaker && (e.type === 'statement' || e.type === 'opening') && typeof e.content === 'string' && e.content.trim()) {
      return e.content.trim().slice(0, maxChars);
    }
  }
  return undefined;
}

/** Design's repetition check (t/784): the first run of `n` identical consecutive words two texts share, or undefined. */
export function sharedWordRun(a: string, b: string, n = 6): string | undefined {
  const tok = (s: string) => s.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean);
  const ta = tok(a);
  const runs = new Set<string>();
  for (let i = 0; i + n <= ta.length; i++) runs.add(ta.slice(i, i + n).join(' '));
  const tb = tok(b);
  for (let i = 0; i + n <= tb.length; i++) {
    const r = tb.slice(i, i + n).join(' ');
    if (runs.has(r)) return r;
  }
  return undefined;
}

/** Earlier COMMIT texts in the transcript, whole, for the repetition check. */
export function priorCommitTexts(transcript: readonly EntryLike[]): string[] {
  return transcript
    .filter(e => e.type === 'intervention' && e.intervention_metadata?.move === 'COMMIT' && typeof e.content === 'string' && e.content.trim())
    .map(e => (e.content as string).trim());
}

/** The first earlier COMMIT the new text shares a 6-word run with, as { run }, or undefined. */
export function commitRepeat(newText: string, transcript: readonly EntryLike[]): { run: string } | undefined {
  for (const prior of priorCommitTexts(transcript)) {
    const run = sharedWordRun(newText, prior);
    if (run) return { run };
  }
  return undefined;
}

/** Design's check (t/784): WARN when a new COMMIT shares a 6-word run with an earlier one. Logs only. */
export function warnOnCommitRepeat(newText: string, transcript: readonly EntryLike[], round: number): void {
  const repeat = newText ? commitRepeat(newText, transcript) : undefined;
  if (!repeat) return;
  getGlobalRecorder()?.record({
    type: 'system.error', component: 'orchestration', level: 'warn',
    message: `Moderator COMMIT (round ${round}) shares a 6-word run with an earlier COMMIT: "${repeat.run}"`,
    data: { round, run: repeat.run },
  });
}
