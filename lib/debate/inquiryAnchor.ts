// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Inquiry anchoring (t/284): an inquiry debate must answer the user's literal question.
 *  - assertTopicAnchored: topic.final must equal request.question.
 *  - checkEntityAlignment: debater turns must mention the question's named entities.
 */

import { ActionableError } from './errors.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';
import type { DebateSession, TranscriptEntry } from './types/session.js';

/** Mean per-turn entity coverage below this raises the alignment WARN. */
export const ALIGNMENT_WARN_THRESHOLD = 0.4;

export function assertTopicAnchored(session: DebateSession, question: string): void {
  const final = session.topic.final;
  if (final === question) return;
  throw new ActionableError({
    goal: `Anchor inquiry debate to the user's question: "${question.slice(0, 60)}"`,
    problem: `topic.final is "${String(final).slice(0, 60)}"; inquiry debates must not reframe the question`,
    location: 'inquiryAnchor.assertTopicAnchored',
    nextSteps: [
      'Check that wisdomAutoReframe is false for inquiry debates (inquiryConfig.deriveDebateConfig)',
      'Store any refinement as topic.critique_suggestion, never as topic.final',
    ],
  });
}

/**
 * Named entities from the question: quoted phrases, plus capitalised words that are
 * not the first word of a sentence. Deterministic; no LLM call.
 */
export function extractQuestionEntities(question: string): string[] {
  const found = new Set<string>();
  const unquoted = question.replace(/["“]([^"”]{2,})["”]/g, (_m, phrase: string) => {
    found.add(phrase.trim());
    return ' ';
  });
  for (const sentence of unquoted.split(/(?<=[.?!])\s+/)) {
    const words = sentence.split(/\s+/).slice(1);
    for (const w of words) {
      const word = w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
      if (/^[A-Z][A-Za-z0-9-]+$/.test(word)) found.add(word);
    }
  }
  return [...found];
}

function mentions(text: string, entity: string): boolean {
  const escaped = entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, 'i').test(text);
}

const DEBATER_TURNS: ReadonlySet<TranscriptEntry['type']> = new Set(['opening', 'statement', 'concluding']);

/** Per debater turn: the fraction of `entities` the turn mentions. */
export function entityCoveragePerTurn(transcript: TranscriptEntry[], entities: string[]): number[] {
  if (entities.length === 0) return [];
  return transcript
    .filter((e) => DEBATER_TURNS.has(e.type))
    .map((e) => entities.filter((ent) => mentions(e.content, ent)).length / entities.length);
}

export function checkEntityAlignment(session: DebateSession, question: string): void {
  const entities = extractQuestionEntities(question);
  if (entities.length === 0) return;
  const scores = entityCoveragePerTurn(session.transcript, entities);
  if (scores.length === 0) return;
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  if (mean >= ALIGNMENT_WARN_THRESHOLD) return;
  getGlobalRecorder()?.record({
    type: 'inquiry.alignment-gate',
    component: 'inquiry-pipeline',
    level: 'warn',
    debate_id: session.id,
    message: `Inquiry turns mention ${(mean * 100).toFixed(0)}% of the question's entities on average (threshold ${ALIGNMENT_WARN_THRESHOLD * 100}%): ${entities.join(', ')}`,
    data: { entities, mean_coverage: mean, turn_count: scores.length },
  });
}
