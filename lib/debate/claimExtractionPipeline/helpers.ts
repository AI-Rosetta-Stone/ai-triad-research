// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type {
  SpeakerId,
  ArgumentNetworkNode,
  ClaimExtractionTrace,
  ExtractionSummary,
} from '../types.js';
import { POVER_INFO } from '../types.js';
import { generateId, nowISO } from '../helpers.js';
import { factCheckToBaseStrength } from '../argumentNetwork.js';
import { retrieveEvidence } from '../evidenceRetriever.js';
import { buildEvidenceQbaf } from '../evidenceQbaf.js';
import type { ClaimExtractionContext } from './context.js';

/** Lightweight string hash (djb2) — for detecting prompt drift across runs. */
export function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/** Heuristic: response looks truncated if it ends mid-JSON or has unbalanced braces. */
export function looksTruncated(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const last = trimmed[trimmed.length - 1];
  if (last !== '}' && last !== ']' && last !== '`') return true;
  let opens = 0, closes = 0;
  for (const ch of trimmed) {
    if (ch === '{') opens++;
    else if (ch === '}') closes++;
  }
  return opens !== closes;
}

/**
 * Detect sycophancy: if self_similarity decreased monotonically for 3+ turns
 * AND opponent_similarity increased monotonically for any opponent for 3+ turns
 * AND no concessions were made during those turns.
 */
export function detectSycophancy(
  ctx: ClaimExtractionContext,
  openingClaims: Map<string, Array<{ id: string; text: string; embedding: number[] }>>,
  speaker: Exclude<SpeakerId, 'user'>,
  round: number,
): void {
  // Per-claim tracking handles sycophancy detection when active
  if (openingClaims.size > 0) return;

  const drift = ctx.session.position_drift ?? [];
  const speakerDrift = drift.filter(d => d.speaker === speaker);
  if (speakerDrift.length < 3) return;

  const recent = speakerDrift.slice(-3);

  // Check monotonic self_similarity decrease
  const selfDecreasing = recent.every((d, i) =>
    i === 0 || d.self_similarity < recent[i - 1].self_similarity,
  );
  if (!selfDecreasing) return;

  // Check if any opponent similarity is monotonically increasing
  const opponents = Object.keys(recent[0].opponent_similarities);
  const driftingToward = opponents.find(opp =>
    recent.every((d, i) =>
      i === 0 || (d.opponent_similarities[opp] ?? 0) > (recent[i - 1].opponent_similarities[opp] ?? 0),
    ),
  );
  if (!driftingToward) return;

  // Check no concessions in those turns
  const concessions = ctx.session.commitments?.[speaker]?.conceded ?? [];
  // If recent concessions exist, this might be genuine agreement
  if (concessions.length > 0) {
    // Check if any concessions were made in the drift window (heuristic: recent concessions)
    const recentRounds = new Set(recent.map(d => d.round));
    // Can't precisely match concession to round, so skip flag if ANY concessions exist recently
    return;
  }

  const speakerLabel = POVER_INFO[speaker]?.label ?? speaker;
  const opponentLabel = POVER_INFO[driftingToward as Exclude<SpeakerId, 'user'>]?.label ?? driftingToward;

  const sycEntry = ctx.addEntry({
    type: 'system',
    speaker: 'system',
    content: `[Sycophancy guard] ${speakerLabel} appears to be drifting toward ${opponentLabel}'s position over the last 3 turns without explicit concession. Self-similarity: ${recent.map(d => d.self_similarity.toFixed(2)).join(' → ')}. Consider whether this represents genuine agreement or accommodation.`,
    taxonomy_refs: [],
  });
  ctx.recordDiagnostic(sycEntry.id, {
    raw_response: JSON.stringify({ speaker, drifting_toward: driftingToward, recent_drift: recent }),
  });
}

/**
 * Run evidence QBAF pipeline for a single Belief claim:
 * 1. Retrieve top-K evidence from source corpus
 * 2. LLM classifies as support/contradict/irrelevant
 * 3. Build QBAF sub-graph and compute strength
 * Returns true if evidence was found and claim was scored.
 */
export async function runEvidenceQbaf(
  ctx: ClaimExtractionContext,
  node: ArgumentNetworkNode,
  sourcesDir: string,
): Promise<boolean> {
  const evidenceItems = retrieveEvidence(node.text, sourcesDir, {
    topK: 10,
    nodeEmbeddings: ctx.taxonomy.embeddings,
  });

  if (evidenceItems.length === 0) return false;

  const evalModel = ctx.resolveStageModel('evaluator');
  const result = await buildEvidenceQbaf(
    node.text,
    evidenceItems,
    ctx.adapter,
    evalModel,
    {
      standardizedTerms: ctx.config.vocabulary?.standardizedTerms,
      claimBaseStrength: 0.5,
    },
  );

  if (result.evidence_items.length === 0) return false;

  // Update node with evidence QBAF results
  node.base_strength = factCheckToBaseStrength('evidence_qbaf', undefined, result.computed_strength);
  node.scoring_method = 'fact_check';
  node.verification_status = result.computed_strength >= 0.6 ? 'supported'
    : result.computed_strength <= 0.4 ? 'disputed' : 'unverifiable';
  node.evidence_graph = {
    evidence_items: result.evidence_items,
    computed_strength: result.computed_strength,
    qbaf_iterations: result.qbaf_iterations,
  };

  // Log to transcript
  const supportCount = result.evidence_items.filter(e => e.relation === 'support').length;
  const contradictCount = result.evidence_items.filter(e => e.relation === 'contradict').length;
  ctx.session.transcript.push({
    id: generateId(),
    timestamp: nowISO(),
    type: 'fact-check',
    speaker: 'system',
    content: `Claim ${node.id} — evidence QBAF: strength=${result.computed_strength.toFixed(2)} (${supportCount} support, ${contradictCount} contradict, ${result.qbaf_iterations} iterations)`,
    taxonomy_refs: [],
    metadata: {
      source: 'evidence_qbaf',
      claim_id: node.id,
      claim_text: node.text,
      evidence_count: result.evidence_items.length,
      support_count: supportCount,
      contradict_count: contradictCount,
      computed_strength: result.computed_strength,
      qbaf_iterations: result.qbaf_iterations,
    },
  });

  return true;
}

/** Recompute the session-level extraction summary + fire plateau system entry on first detection. */
export function updateExtractionSummary(
  ctx: ClaimExtractionContext,
  trace: ClaimExtractionTrace,
): void {
  const diag = ctx.session.diagnostics!;
  const traces: ClaimExtractionTrace[] = [];
  for (const entryDiag of Object.values(diag.entries)) {
    if (entryDiag.extraction_trace) traces.push(entryDiag.extraction_trace);
  }

  let totalProposed = 0, totalAccepted = 0, totalRejected = 0;
  const reasonTotals: Record<string, number> = {};
  const growth: { round: number; cumulative_count: number }[] = [];
  for (const t of traces) {
    totalProposed += t.candidates_proposed;
    totalAccepted += t.candidates_accepted;
    totalRejected += t.candidates_rejected;
    for (const [reason, count] of Object.entries(t.rejection_reasons)) {
      reasonTotals[reason] = (reasonTotals[reason] ?? 0) + count;
    }
    growth.push({ round: t.round, cumulative_count: t.an_node_count_after });
  }

  // Plateau: 2+ consecutive recent turns with zero AN nodes added.
  let plateauDetected = false;
  let plateauStartedAt: number | undefined;
  let plateauLastId: string | undefined;
  const ordered = [...traces].sort((a, b) => a.round - b.round);
  let zeroRun = 0;
  let zeroRunStart: number | undefined;
  for (const t of ordered) {
    if (t.an_nodes_added_ids.length === 0) {
      if (zeroRun === 0) zeroRunStart = t.round;
      zeroRun++;
      if (zeroRun >= 2 && !plateauDetected) {
        plateauDetected = true;
        plateauStartedAt = zeroRunStart;
        plateauLastId = `AN-${t.an_node_count_before}`;
      }
    } else {
      zeroRun = 0;
      zeroRunStart = undefined;
    }
  }

  const wasDetected = ctx.session.extraction_summary?.plateau_detected === true;
  // Compute unattributed claim ratio from attribution traces
  let totalAttributed = 0, totalUnattributed = 0;
  for (const t of traces) {
    totalAttributed += t.attribution_attributed ?? 0;
    totalUnattributed += t.attribution_unattributed ?? 0;
  }
  const totalAttrClaims = totalAttributed + totalUnattributed;
  const unattributedRatio = totalAttrClaims > 0 ? totalUnattributed / totalAttrClaims : undefined;

  if (unattributedRatio !== undefined && unattributedRatio > 0.50) {
    console.warn(`[attribution.high-unattributed] ${(unattributedRatio * 100).toFixed(0)}% of claims unattributed (${totalUnattributed}/${totalAttrClaims}) — may indicate stale taxonomy or broken injection`);
  }

  const summary: ExtractionSummary = {
    total_turns: traces.length,
    total_proposed: totalProposed,
    total_accepted: totalAccepted,
    total_rejected: totalRejected,
    acceptance_rate: totalProposed > 0 ? totalAccepted / totalProposed : 0,
    an_growth_series: growth,
    plateau_detected: plateauDetected,
    plateau_started_at_turn: plateauStartedAt,
    plateau_last_an_id: plateauLastId,
    rejection_reason_totals: reasonTotals,
    unattributed_claim_ratio: unattributedRatio,
    attribution_attributed: totalAttributed,
    attribution_unattributed: totalUnattributed,
  };
  ctx.session.extraction_summary = summary;

  // Emit a one-shot [Extraction plateau] system entry when plateau is first detected.
  if (plateauDetected && !wasDetected) {
    const reasonCluster = Object.entries(trace.rejection_reasons)
      .map(([r, c]) => `${r}×${c}`).join(', ') || 'empty_response';
    const lastId = plateauLastId ?? 'AN-?';
    const plateauEntry = ctx.addEntry({
      type: 'system',
      speaker: 'system',
      content:
        `[Extraction plateau] No new AN nodes since ${lastId} (turn ${plateauStartedAt}). ` +
        `Reason cluster: ${reasonCluster}. See Diagnostics → Extraction Timeline.`,
      taxonomy_refs: [],
    });
    ctx.recordDiagnostic(plateauEntry.id, {
      raw_response: JSON.stringify(summary),
    });
  }
}
