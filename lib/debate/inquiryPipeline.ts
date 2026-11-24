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
import type { DebateSession } from './types/session.js';
import { debaterTurns, scoreTurns, relevanceResult, fieldCentroid, residualScores } from './inquiryRelevance.js';
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
  /**
   * Optional: save the debate session (t/284 item 5, t/476). Called once, after the debate returns
   * and the question relevance is recorded on the session, so post-debate fields are stored. A
   * host that saves inside `runDebate` stores the session without them. The pipeline awaits it;
   * a rejection is logged with a WARN and the inquiry continues, since the session is an audit
   * copy and a failed save must not break the answer. Absent: the pipeline saves nothing.
   */
  persistSession?: (session: DebateSession) => Promise<void>;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * t/284 item 5: score each debater turn's similarity to the question and store the result on the
 * session, as an internal gross-drift signal. It does not say whether the debate answers the question.
 * If embedding fails or the counts do not line up, store "unavailable" and WARN. Never a fake value.
 */
/**
 * t/496: add the residual similarity to the stored signal, for study only. No threshold, no drift
 * flag. Without taxonomy vectors there is no field centroid, so it is left off, with a WARN.
 */
function recordResidual(
  session: DebateSession, entries: ReturnType<typeof debaterTurns>, turnVectors: number[][], questionVector: number[], fieldVectors: number[][],
): void {
  const centroid = fieldCentroid(fieldVectors, questionVector.length);
  if (!centroid) {
    warn(`inquiry residual similarity not recorded (session ${session.id ?? 'unknown'}): no taxonomy vectors of dimension ${questionVector.length} to take a field centroid from (${fieldVectors.length} supplied)`);
    return;
  }
  Object.assign(session.relevance!, residualScores(entries, turnVectors, questionVector, centroid));
}

async function recordQuestionRelevance(
  session: DebateSession,
  question: string,
  embed: (texts: string[]) => Promise<number[][]>,
  fieldVectors: number[][] = [],
): Promise<void> {
  const entries = debaterTurns(session.transcript ?? []);
  if (entries.length === 0) {
    session.relevance = { question_similarity: [], mean: null, drift_warning: false, unavailable_reason: 'no debater turns' };
    return;
  }
  try {
    const [questionVector, ...turnVectors] = await embed([question, ...entries.map(e => e.content)]);
    if (!questionVector || turnVectors.length !== entries.length) {
      throw new ActionableError({
        goal: 'Score debater turns against the literal question',
        problem: `embedding count mismatch: ${turnVectors.length} vectors for ${entries.length} turns`,
        location: 'inquiryPipeline.ts › recordQuestionRelevance',
        nextSteps: ['Check that the embedding adapter returns one vector per input text'],
      });
    }
    session.relevance = relevanceResult(scoreTurns(entries, turnVectors, questionVector));
    recordResidual(session, entries, turnVectors, questionVector, fieldVectors);
    if (session.relevance.drift_warning) {
      warn(`inquiry gross-drift signal raised (session ${session.id ?? 'unknown'}): ${session.relevance.drift_reason}`);
    }
  } catch (err) {
    session.relevance = { question_similarity: [], mean: null, drift_warning: false, unavailable_reason: String(err) };
    warn(`inquiry gross-drift signal unavailable (session ${session.id ?? 'unknown'}): ${String(err)}`);
  }
}

/** Hand the finished session to the host's save, if it supplied one. A failed save never fails the inquiry. */
async function persistSessionIfSupplied(session: DebateSession, persistSession: InquiryPipelineDeps['persistSession']): Promise<void> {
  if (!persistSession) return;
  try {
    await persistSession(session);
  } catch (err) {
    warn(`inquiry session save failed (session ${session.id ?? 'unknown'}); the answer is returned without a stored debate: ${String(err)}`);
  }
}

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

// t/284 item 1, pre-flight: the debate must run on the user's literal question with no reframe.
// Checked before grounding and the debate spend, so a violation cannot throw after the spend.
// topicPipeline sets topic.final = config.topic, and it reframes only when wisdomAutoReframe is on.
function assertLiteralQuestionPreflight(request: InquiryRequest, config: DebateConfig): void {
  if (config.topic === request.question && config.wisdomAutoReframe === false) return;
  throw new ActionableError({
    goal: 'Run the inquiry debate on the user\'s literal question',
    problem: `debate config would not keep the question as topic.final (config.topic ${config.topic === request.question ? 'matches' : 'differs'}, wisdomAutoReframe=${String(config.wisdomAutoReframe)})`,
    location: 'runInquiryPipeline',
    nextSteps: [
      'Check that inquiryConfig sets topic: request.question and wisdomAutoReframe: false',
    ],
  });
}

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
  assertLiteralQuestionPreflight(request, config);

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

  // t/284 item 5: per-turn similarity to the question, stored on the session as a gross-drift signal.
  await recordQuestionRelevance(session, request.question, deps.embed, Object.values(deps.taxonomy.nodeEmbeddings).map(e => e.vector));
  // Save only now, so the stored session carries the relevance metric (t/476).
  await persistSessionIfSupplied(session, deps.persistSession);

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
