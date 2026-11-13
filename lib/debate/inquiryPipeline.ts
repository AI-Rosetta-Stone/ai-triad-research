// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Shared runInquiryPipeline orchestrator (t/3585).
 *
 * The ONE sequencing of the five inquiry stages — both the Electron in-process runner
 * (t/3579) and the server job store (t/3578) call this, so there is no second copy of
 * the stage sequence to drift. Mirrors lib/brief/pipeline.ts exactly.
 *
 * Caller contract: the caller owns all host-specific concerns — job lifecycle,
 * storage, progress HTTP updates, TTL, error-code mapping. The pipeline owns the
 * five stages and returns a validated InquiryResult. Only unexpected stage faults
 * propagate; budget/truncation surfaces as structured data on the result.
 */

import { deriveDebateConfig } from './inquiryConfig.js';
import { ActionableError } from './errors.js';
import { buildGroundingEnvelope } from './inquiryGrounding.js';
import type { GroundingTaxonomy } from './inquiryGrounding.js';
import type { GroundingEnvelope, AppliedTag } from '../inquiry/index.js';
import { projectTrust, getRawMetrics } from './calibrationLogger/trustProjection.js';
import { synthesizeInquiry } from './inquirySynthesis.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';
import type { ModelRegistry } from '../ai-client/registry.js';
import type { AIAdapter } from './aiAdapter.js';
import type { DebateSession, TranscriptEntry } from './types/session.js';
import type { DebateConfig } from './debateEngine/internals.js';
import type { InquiryRequest, InquiryResult } from '../inquiry/schema.js';
import type { TerminationReason } from './calibrationLogger/extract.js';
import { createDebateProgressTracker, type DebateProgressUpdate } from './debateProgressMapping.js';
import type { DebateProgress } from './debateEngine/internals.js';

// ── Public types ──────────────────────────────────────────────────────────────

/** Pipeline stage labels — mirrors brief's ExportJobState vocabulary. */
export type InquiryStage = 'deriving' | 'grounding' | 'debating' | 'projecting' | 'synthesizing';

/**
 * Everything the five stages need. Host-specific concerns (job ID, TTL, storage)
 * are NOT here — those belong to each runner (t/3578 server, t/3579 Electron).
 *
 * `getRawMetrics` is NOT injected (TL t/3585#2): it is a pure function over data
 * already in hand with no host-specific concern, so injecting it would let each
 * host wire different extraction logic and cause trust projection to diverge between
 * desktop and web on the same debate. Import it directly instead.
 */
export interface InquiryPipelineDeps {
  registry: ModelRegistry;
  taxonomy: GroundingTaxonomy;
  embed: (texts: string[]) => Promise<number[][]>;
  /**
   * Run the debate engine. Injected because each host supplies something genuinely
   * different: the Electron runner wires it in-process, the server runner wires it
   * via a job queue. terminationReason uses the closed union from extract.ts so a
   * typo is a compile error, not a silent false-trust verdict (TL t/3585#2).
   */
  runDebate: (
    config: DebateConfig,
    question: string,
    /** t/4711: forwarded straight to `runHeadlessDebate`'s own `onProgress` — the host's
     *  implementation doesn't need to know about debate-progress mapping, just relay it. */
    onProgress?: (p: DebateProgress) => void,
  ) => Promise<{ session: DebateSession; terminationReason?: TerminationReason }>;
  adapter: AIAdapter;
  /** Optional progress sink. Emits each stage label as it begins. */
  onStage?: (stage: InquiryStage) => void;
  /**
   * Optional fine-grained progress sink for the Debate stage specifically (t/4710/t/4711):
   * a monotonic [0,1] fraction + a short detail line, derived from `runHeadlessDebate`'s
   * per-turn `DebateProgress` events. The host passes `stageProgress('debating', fraction)`
   * (`debateProgressMapping.ts`) through to its own poll/IPC response.
   */
  onDebateProgress?: (p: DebateProgressUpdate) => void;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function warn(message: string): void {
  getGlobalRecorder()?.record({
    type: 'system.error',
    component: 'inquiryPipeline',
    level: 'warn',
    message,
  });
}

/**
 * t/4304: Emit error-level flight-recorder events when a broken-injection
 * signature is detected at the end of a headless inquiry debate.
 *
 * Signature 1 — 100% unattributed claims: every extracted claim failed
 * attribution, which can signal structural injection failure (though legitimate
 * causes exist, e.g. forecasting questions outside the taxonomy). NEVER fails
 * the job — telemetry only.
 *
 * Signature 2 — all turns used lexical scoring while embeddings are present:
 * the embedding adapter was unavailable for every turn even though the taxonomy
 * has embeddings, which degrades relevance selection precision.
 */
function warnSignature1(session: DebateSession, debateId: string | undefined): void {
  const UNATTRIBUTED_CLAIM_THRESHOLD = 5;
  const exs = session.extraction_summary;
  if (exs && exs.unattributed_claim_ratio === 1.0) {
    const totalClaims = (exs.attribution_attributed ?? 0) + (exs.attribution_unattributed ?? 0);
    if (totalClaims >= UNATTRIBUTED_CLAIM_THRESHOLD) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'inquiryPipeline',
        level: 'error',
        debate_id: debateId,
        message: `broken-injection signature 1 (100% unattributed claims): debate ${debateId ?? 'unknown'} — ${totalClaims} claims, 0 attributed`,
        data: { signature: 'all_claims_unattributed', debate_id: debateId, total_claims: totalClaims, unattributed_claim_ratio: exs.unattributed_claim_ratio },
      });
    }
  }
}

function warnSignature2(session: DebateSession, embeddingCount: number, debateId: string | undefined): void {
  const overview = session.diagnostics?.overview;
  const lexicalTurns = overview?.lexical_turn_count ?? 0;
  const embeddingTurns = overview?.embedding_turn_count ?? 0;
  if (embeddingCount > 0 && lexicalTurns > 0 && embeddingTurns === 0) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'inquiryPipeline',
      level: 'error',
      debate_id: debateId,
      message: `broken-injection signature 2 (all turns lexical despite embeddings): debate ${debateId ?? 'unknown'} — ${lexicalTurns} lexical turns, 0 embedding turns, ${embeddingCount} embeddings in taxonomy`,
      data: { signature: 'all_turns_lexical_with_embeddings', debate_id: debateId, lexical_turn_count: lexicalTurns, embedding_turn_count: embeddingTurns, taxonomy_embedding_count: embeddingCount },
    });
  }
}

function warnBrokenInjection(
  session: DebateSession,
  embeddingCount: number,
  debateId: string | undefined,
): void {
  warnSignature1(session, debateId);
  warnSignature2(session, embeddingCount, debateId);
}

function assertGroundingNonEmpty(
  request: InquiryRequest,
  grounding: GroundingEnvelope,
  embeddingCount: number,
  appliedTag: AppliedTag | undefined,
): void {
  if (request.tagSelection && !appliedTag) {
    throw new ActionableError({
      goal: `Ground Inquiry on ${request.tagSelection.pov}/${request.tagSelection.tag}`,
      problem: `tagSelection was requested but grounding returned no appliedTag — the camp was empty or the pov is not a recognized value`,
      location: 'inquiryPipeline.ts › runInquiryPipeline',
      nextSteps: [
        'Check that embedding.pov values use a known camp code (acc/saf/skp/cc) or file name (accelerationist/safetyist/skeptic/cross-cutting).',
        'Run Update-TaxEmbeddings to refresh the embedding corpus.',
      ],
    });
  }
  const allCampsEmpty = (['acc', 'saf', 'skp', 'cc'] as const).every(
    c => !grounding.nodesByCamp[c] || grounding.nodesByCamp[c]!.length === 0,
  );
  if (embeddingCount > 0 && allCampsEmpty) {
    throw new ActionableError({
      goal: `Ground Inquiry for: "${request.question.slice(0, 80)}"`,
      problem: `buildGroundingEnvelope returned zero nodes across all camps despite ${embeddingCount} entries in the embedding map — every embedding.pov was unrecognized or vectors were degenerate`,
      location: 'inquiryPipeline.ts › runInquiryPipeline',
      nextSteps: [
        'Check that embedding.pov values use a known camp code (acc/saf/skp/cc) or file name (accelerationist/safetyist/skeptic/cross-cutting).',
        'Run Update-TaxEmbeddings to regenerate the embedding corpus.',
      ],
    });
  }
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * Run the five inquiry pipeline stages and return a validated InquiryResult.
 *
 * Stage faults propagate (the caller maps them to its own error codes). Budget /
 * truncation does NOT throw — terminationReason from runDebate flows into
 * projectTrust and surfaces as CalibrationEntry.trust.verdict = 'censored' on
 * affected convergence metrics. The result is always returned.
 */
export async function runInquiryPipeline(
  request: InquiryRequest,
  deps: InquiryPipelineDeps,
): Promise<InquiryResult> {
  // ── Stage 1: derive debate config ──────────────────────────────────────────
  deps.onStage?.('deriving');
  const { config, derivation } = deriveDebateConfig(request, deps.registry);

  // ── Stage 2: build grounding envelope ─────────────────────────────────────
  // ADR-001: empty envelope on zero-hit / empty-corpus inputs — WARN logged in
  // buildGroundingEnvelope itself. An empty envelope is valid at the grounding layer
  // but fatal here when an embedding corpus exists (assertGroundingNonEmpty below).
  deps.onStage?.('grounding');
  const { envelope: grounding, appliedTag } = await buildGroundingEnvelope(
    request.question,
    deps.taxonomy,
    deps.embed,
    { situationId: request.situationId, tagSelection: request.tagSelection },
  );
  if (appliedTag) derivation.tag = appliedTag;
  assertGroundingNonEmpty(request, grounding, Object.keys(deps.taxonomy.nodeEmbeddings).length, appliedTag);

  // ── Stage 3: run debate ────────────────────────────────────────────────────
  deps.onStage?.('debating');
  const onProgress = deps.onDebateProgress
    ? createDebateProgressTracker(deps.onDebateProgress)
    : undefined;
  const { session, terminationReason } = await deps.runDebate(config, request.question, onProgress);

  // ── Inquiry anchor validation (t/284): ensure topic.final === request.question ──────
  // For inquiry debates, the topic must stay anchored to the user's literal question.
  // If it drifted (e.g. due to accidental reframe), throw so the user knows.
  if (session.topic.final !== request.question) {
    throw new ActionableError({
      goal: `Anchor inquiry debate to user's question: "${request.question.slice(0, 60)}"`,
      problem: `topic.final drifted to: "${session.topic.final.slice(0, 60)}" — inquiry debates must not reframe the question`,
      location: 'lib/debate/inquiryPipeline.ts › runInquiryPipeline',
      nextSteps: [
        'Check that wisdomAutoReframe is false in inquiryConfig.ts for this request',
        'If the debate legitimately refined the question, store the refinement as topic.critique_suggestion instead',
      ],
    });
  }

  // ── Alignment gate (t/284): verify turns reference key entities from the question ──────
  // Extract entities from ArCo clause decomposition (if available) as alignment targets.
  // Heuristic fallback: extract capitalized phrases from question (basic NER fallback).
  const clauseEntities = extractEntitiesFromClauses(session.topic.clauses ?? []);
  const questionEntities = extractEntitiesFromQuestion(request.question);
  const alignmentEntities = clauseEntities.length > 0 ? clauseEntities : questionEntities;
  
  if (alignmentEntities.length > 0) {
    const alignmentScores = measureAlignmentPerTurn(session.transcript, alignmentEntities);
    const meanAlignment = alignmentScores.length > 0
      ? alignmentScores.reduce((a, b) => a + b, 0) / alignmentScores.length
      : 0;
    if (meanAlignment < 0.4) {
      const msg = `Inquiry debate alignment gate: mean entity coverage ${(meanAlignment * 100).toFixed(1)}% ` +
        `(threshold 40%). Turns may not adequately reference question entities. ` +
        `Question: "${request.question.slice(0, 60)}". Entity list: [${alignmentEntities.slice(0, 5).join(', ')}${alignmentEntities.length > 5 ? '…' : ''}]`;
      getGlobalRecorder()?.record({
        type: 'inquiry.alignment-gate',
        component: 'inquiry-pipeline',
        level: 'warn',
        debate_id: session.id,
        message: msg,
        data: {
          alignment_mean: meanAlignment,
          entity_count: alignmentEntities.length,
        },
      });
    }
  }

  // ── Stage 4: project trust ─────────────────────────────────────────────────
  deps.onStage?.('projecting');
  const rawMetrics = getRawMetrics(session);
  if (rawMetrics.length === 0) {
    // This is an unusual fallback — a session with no extractable numeric metrics
    // (e.g. a degenerate single-turn run). The synthesis still proceeds but the
    // InquiryResult will have an empty calibration array, rendering as "no trust
    // badges" rather than a trust verdict. Log so the missing data is diagnosable.
    warn(
      'runInquiryPipeline: getRawMetrics returned empty array — synthesizing with empty calibration ' +
      `(session id: ${session.id}, terminationReason: ${terminationReason ?? 'none'})`,
    );
  }
  const calibration = projectTrust(rawMetrics, terminationReason);

  // ── Stage 5: synthesize ────────────────────────────────────────────────────
  deps.onStage?.('synthesizing');
  const debateId = session.id || undefined;
  if (!debateId) {
    warn(
      'runInquiryPipeline: session.id is missing — debateId omitted from InquiryResult ' +
      `(terminationReason: ${terminationReason ?? 'none'})`,
    );
  }
  // t/4304: check for broken-injection signatures before returning
  warnBrokenInjection(session, Object.keys(deps.taxonomy.nodeEmbeddings).length, debateId);

  return synthesizeInquiry(session, grounding, calibration, derivation, request, deps.adapter, debateId);
}

// ── Alignment gate helpers (t/284) ────────────────────────────────────────────

/** Extract entities from ArCo clause decomposition (if available).
 *  Clauses are semantic chunks of the resolution; their text is the entity source. */
function extractEntitiesFromClauses(clauses: string[]): string[] {
  if (!clauses || clauses.length === 0) return [];
  const entities = new Set<string>();
  for (const clause of clauses) {
    // Heuristic: extract capitalized phrases (basic NER) from clause text
    const matches = clause.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || [];
    matches.forEach(m => {
      if (m.length > 2) entities.add(m); // Filter out single letters
    });
  }
  return Array.from(entities);
}

/** Extract entities from the user's question using heuristic fallback (capitalized phrases).
 *  Used when ArCo clauses are unavailable. */
function extractEntitiesFromQuestion(question: string): string[] {
  const entities = new Set<string>();
  // Heuristic: extract capitalized phrases (2+ words or >4 chars)
  const matches = question.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || [];
  matches.forEach(m => {
    if (m.length > 2 || m.split(' ').length > 1) {
      entities.add(m);
    }
  });
  // Also extract common technical/policy terms (lowercase patterns)
  const terms = question.match(/\b(AI|machine learning|artificial intelligence|regulation|policy|development|safety|alignment)\b/gi) || [];
  terms.forEach(t => entities.add(t));
  return Array.from(entities);
}

/** Measure alignment between turn content and target entities.
 *  Returns array of alignment scores per turn: how many target entities appear in the turn. */
function measureAlignmentPerTurn(transcript: TranscriptEntry[], targetEntities: string[]): number[] {
  const scores: number[] = [];
  const lowerTargets = targetEntities.map(e => e.toLowerCase());
  for (const entry of transcript) {
    // Skip opening and system turns
    if (entry.type === 'opening' || entry.type === 'system') continue;
    const turnText = entry.content.toLowerCase();
    let hitCount = 0;
    for (const entity of lowerTargets) {
      // Simple substring match (case-insensitive word boundary would be better with regex)
      if (turnText.includes(entity.toLowerCase())) hitCount++;
    }
    const score = lowerTargets.length > 0 ? hitCount / lowerTargets.length : 0;
    scores.push(score);
  }
  return scores;
}
