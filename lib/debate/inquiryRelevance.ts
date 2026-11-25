// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// ── Inquiry gross-drift signal (t/284 item 5) ─────────────────────────
//
// Per-turn embedding similarity between each debater turn and the user's question, on the same
// embedding model as the ArCo anchors. Pure functions here; the pipeline does the I/O.
//
// What it is: an internal signal that a debate has left the question's field. Off-field and
// unrelated turns score below RELEVANCE_MEAN_WARN, and their consecutive runs fall under
// RELEVANCE_LOW_TURN, so they raise the flag.
// What it is not: a measure of whether the debate answers the question. A debate on a
// neighbouring question in the same field scores in the same range as one on the question itself,
// so no threshold on this number separates the two (controls on t/284#77 and t/284#80). That
// case is t/496. The flag is not shown to users.
//
// The thresholds are stipulated, not calibrated: the TL's starting point (t/284#3 item 3).

import { cosineSimilarity } from '../embeddings/similarity.js';
import type { TranscriptEntry } from './types/session.js';

export const RELEVANCE_MEAN_WARN = 0.35;
export const RELEVANCE_LOW_TURN = 0.25;
export const RELEVANCE_LOW_RUN = 3;

export interface TurnRelevance {
  entry_id: string;
  similarity: number;
}

export interface RelevanceResult {
  question_similarity: TurnRelevance[];
  mean: number | null;
  drift_warning: boolean;
  drift_reason?: string;
  unavailable_reason?: string;
  /**
   * Residual similarity per turn, and its mean (t/496): similarity to the question after the
   * field's centroid is removed from both. Absent when the host has no taxonomy vectors.
   *
   * RECORDED FOR STUDY ONLY. It has no threshold and raises no WARN, it is not shown to anyone,
   * and NO consumer branches on it. That is why adding it is a T0 change (TL p/32#159). THE
   * EXEMPTION LAPSES the moment any code path reads `residual_similarity` or `residual_mean` to
   * make a DECISION (a flag, a threshold, a warning, a display): at that point it is part of the
   * consumer contract, and the change that introduces the read needs its own tier and review.
   */
  residual_similarity?: TurnRelevance[];
  residual_mean?: number | null;
}

/** Debater turns: non-empty content from a speaker, not the system or the moderator. */
export function debaterTurns(transcript: TranscriptEntry[]): TranscriptEntry[] {
  return transcript.filter(e =>
    e.type !== 'system' && e.speaker !== 'system' && e.speaker !== 'moderator' && e.content.trim().length > 0,
  );
}

/** Per-turn similarity of each turn vector to the question vector, in the same order. */
export function scoreTurns(entries: TranscriptEntry[], turnVectors: number[][], questionVector: number[]): TurnRelevance[] {
  return entries.map((e, i) => ({ entry_id: e.id, similarity: cosineSimilarity(turnVectors[i], questionVector) }));
}

/** Gross-drift test: mean below RELEVANCE_MEAN_WARN, or RELEVANCE_LOW_RUN consecutive turns below RELEVANCE_LOW_TURN. */
export function relevanceDrift(scores: TurnRelevance[]): { warn: boolean; reason?: string } {
  if (scores.length === 0) return { warn: false };
  const mean = scores.reduce((s, t) => s + t.similarity, 0) / scores.length;
  if (mean < RELEVANCE_MEAN_WARN) return { warn: true, reason: `mean similarity ${mean.toFixed(3)} below ${RELEVANCE_MEAN_WARN}` };
  let run = 0;
  for (const t of scores) {
    run = t.similarity < RELEVANCE_LOW_TURN ? run + 1 : 0;
    if (run >= RELEVANCE_LOW_RUN) return { warn: true, reason: `${RELEVANCE_LOW_RUN} consecutive turns below ${RELEVANCE_LOW_TURN}` };
  }
  return { warn: false };
}

export function relevanceResult(scores: TurnRelevance[]): RelevanceResult {
  const mean = scores.length === 0 ? null : scores.reduce((s, t) => s + t.similarity, 0) / scores.length;
  const drift = relevanceDrift(scores);
  return { question_similarity: scores, mean, drift_warning: drift.warn, drift_reason: drift.reason };
}

// ── Residual similarity (t/496) ───────────────────────────────────────
//
// Every text in one field shares a large common component, which is why a debate on a neighbouring
// question scores almost as high as a debate on the asked one. Residual similarity subtracts the
// field's centroid (the mean of the taxonomy node vectors) from both the turn and the question
// before comparing. On saved debates it ranks an on-question debate above a neighbouring-question
// one more often than plain similarity does (t/496#4), and still misses about half of the hard
// cases, so it is recorded for study and nothing more.

/** The mean of the field's vectors, or undefined when there are none of the right dimension. */
export function fieldCentroid(vectors: number[][], dimension: number): number[] | undefined {
  const usable = vectors.filter(v => Array.isArray(v) && v.length === dimension);
  if (usable.length === 0) return undefined;
  const sum = new Array<number>(dimension).fill(0);
  for (const v of usable) for (let i = 0; i < dimension; i++) sum[i] += v[i];
  return sum.map(x => x / usable.length);
}

/** Cosine similarity of two vectors after the field centroid is subtracted from each. */
export function residualSimilarity(a: number[], b: number[], centroid: number[]): number {
  return cosineSimilarity(a.map((x, i) => x - centroid[i]), b.map((x, i) => x - centroid[i]));
}

/** Per-turn residual similarity to the question, in the same order as the entries, and its mean. */
export function residualScores(
  entries: TranscriptEntry[], turnVectors: number[][], questionVector: number[], centroid: number[],
): { residual_similarity: TurnRelevance[]; residual_mean: number | null } {
  const residual_similarity = entries.map((e, i) => ({ entry_id: e.id, similarity: residualSimilarity(turnVectors[i], questionVector, centroid) }));
  const residual_mean = residual_similarity.length === 0 ? null : residual_similarity.reduce((s, t) => s + t.similarity, 0) / residual_similarity.length;
  return { residual_similarity, residual_mean };
}
