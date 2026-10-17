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
import { projectTrust, getRawMetrics } from './calibrationLogger/trustProjection.js';
import { synthesizeInquiry } from './inquirySynthesis.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';
import type { ModelRegistry } from '../ai-client/registry.js';
import type { AIAdapter } from './aiAdapter.js';
import type { DebateSession } from './types/session.js';
import type { DebateConfig } from './debateEngine/internals.js';
import type { InquiryRequest, InquiryResult } from '../inquiry/schema.js';
import type { TerminationReason } from './calibrationLogger/extract.js';

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
  ) => Promise<{ session: DebateSession; terminationReason?: TerminationReason }>;
  adapter: AIAdapter;
  /** Optional progress sink. Emits each stage label as it begins. */
  onStage?: (stage: InquiryStage) => void;
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
  // buildGroundingEnvelope itself; pipeline continues.
  deps.onStage?.('grounding');
  const { envelope: grounding, appliedTag } = await buildGroundingEnvelope(
    request.question,
    deps.taxonomy,
    deps.embed,
    { situationId: request.situationId, tagSelection: request.tagSelection },
  );
  if (appliedTag) derivation.tag = appliedTag;

  // Fail loudly on objectively wrong grounding outcomes (t/4255).
  if (request.tagSelection && !appliedTag) {
    throw new ActionableError({
      goal: `Ground Inquiry on ${request.tagSelection.pov}/${request.tagSelection.tag}`,
      problem: `tagSelection was requested but grounding returned no appliedTag — the camp was empty or the pov is not a recognized value`,
      location: 'inquiryPipeline.ts › runInquiryPipeline',
      nextSteps: [
        `Check that embedding.pov values use a known camp code (acc/saf/skp/cc) or file name (accelerationist/safetyist/skeptic/cross-cutting).`,
        'Run Update-TaxEmbeddings to refresh the embedding corpus.',
      ],
    });
  }
  const embeddingCount = Object.keys(deps.taxonomy.nodeEmbeddings).length;
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

  // ── Stage 3: run debate ────────────────────────────────────────────────────
  deps.onStage?.('debating');
  const { session, terminationReason } = await deps.runDebate(config, request.question);

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
  return synthesizeInquiry(session, grounding, calibration, derivation, request, deps.adapter, debateId);
}
