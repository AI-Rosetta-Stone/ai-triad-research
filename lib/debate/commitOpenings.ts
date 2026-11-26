// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/784: the concluding phase sends one COMMIT (final-position request) per debater, each generated
 * fresh. Without knowing what earlier ones said, the model opened each with the same recap sentence.
 * This returns the opening sentence of every COMMIT intervention already in the transcript, so the
 * next one can be told not to reuse it.
 */

interface EntryLike {
  type: string;
  content?: string;
  intervention_metadata?: { move?: string };
}

/** First sentence of `text` (up to the first . ! or ? followed by space or end), trimmed and capped. */
function firstSentence(text: string, max = 240): string {
  const t = text.trim();
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(t);
  return (m ? m[0] : t).trim().slice(0, max);
}

export function priorCommitOpenings(transcript: readonly EntryLike[]): string[] {
  return transcript
    .filter(e => e.type === 'intervention' && e.intervention_metadata?.move === 'COMMIT' && typeof e.content === 'string' && e.content.trim())
    .map(e => firstSentence(e.content as string));
}
