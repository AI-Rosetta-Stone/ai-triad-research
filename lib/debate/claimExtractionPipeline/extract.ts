// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { ExtendedAIAdapter } from '../aiAdapter.js';
import type {
  SpeakerId,
  DebatePhase,
  ClaimExtractionTrace,
  ProcessRewardEntry,
  EntailmentRepairEvent,
} from '../types.js';
import { POVER_INFO, POV_KEYS } from '../types.js';
import type { PovKey } from '../types.js';

import { generateId, nowISO, parseJsonRobust, wordOverlap } from '../helpers.js';
import {
  extractClaimsPrompt,
  classifyClaimsPrompt,
  updateUnansweredLedger,
  processExtractedClaims,
  factCheckToBaseStrength,
  computeClaimTaxonomyAttribution,
  sampleNodesForEntailment,
} from '../argumentNetwork.js';
import type { RawExtractedClaim } from '../argumentNetwork.js';
import { computeQbafStrengths, computeQbafConvergence } from '../qbaf.js';
import { computeConvergenceSignals, boostConvergenceOnConcession, boostConvergenceFromTaxonomyEdges } from '../convergenceSignals.js';
import { detectConcessionCascade, transitionCrux, updateCruxTracker, isTerminalCruxState } from '../cruxResolution.js';
import { computeProcessReward } from '../processReward.js';
import { checkClaimExclusionBoundary, EXCLUSION_RATIO_THRESHOLD } from '../exclusionGuard.js';
import { entailmentRepairPrompt, cruxRefreshPrompt } from '../prompts.js';
import { callByUsage } from '../../ai-client/usageRegistry.js';
import { getGlobalRecorder } from '../../flight-recorder/index.js';
import { hashString, looksTruncated, updateExtractionSummary } from './helpers.js';
import { runNliDirectionGate, buildNliNodeProp } from './nliDirectionGate.js';
import type { ClaimExtractionContext } from './context.js';

export async function extractClaims(
  ctx: ClaimExtractionContext,
  statement: string,
  speaker: Exclude<SpeakerId, 'user'>,
  entryId: string,
  taxonomyRefIds: string[],
  debaterClaims?: { claim: string; targets: string[]; steelman_of?: string }[],
): Promise<void> {
  const an = ctx.session.argument_network!;
  // Include all prior claims but cap at last 30 to keep the prompt manageable.
  // Earlier claims are still in the network but won't be offered as relationship targets.
  const allPriorClaims = an.nodes.map(n => ({
    id: n.id,
    text: n.text,
    speaker: POVER_INFO[n.speaker as Exclude<SpeakerId, 'user'>]?.label ?? n.speaker,
  }));
  const priorClaims = allPriorClaims.slice(-30);

  let prompt: string;
  if (debaterClaims && debaterClaims.length > 0) {
    prompt = classifyClaimsPrompt(statement, POVER_INFO[speaker].label, debaterClaims, priorClaims, ctx.session.audience, ctx.session.phase === 'opening');
  } else {
    prompt = extractClaimsPrompt(statement, POVER_INFO[speaker].label, priorClaims, ctx.session.audience, ctx.session.topic.final, ctx.session.phase === 'opening');
  }

  const anNodeCountBefore = an.nodes.length;
  const turnNumber = ctx.session.transcript.length;

  // Build the lifecycle trace as we go.
  const trace: ClaimExtractionTrace = {
    entry_id: entryId,
    round: turnNumber,
    speaker,
    status: 'ok',
    attempt_count: 1,
    prompt_chars: prompt.length,
    prompt_token_estimate: Math.round(prompt.length / 4),
    response_chars: 0,
    response_truncated: false,
    model: ctx.resolveStageModel('evaluator'),
    response_time_ms: 0,
    candidates_proposed: 0,
    candidates_accepted: 0,
    candidates_rejected: 0,
    rejection_reasons: {},
    rejected_overlap_pcts: [],
    max_overlap_vs_existing: 0,
    an_node_count_before: anNodeCountBefore,
    an_node_count_after: anNodeCountBefore,
    an_nodes_added_ids: [],
    prompt_hash: hashString(prompt),
    extraction_prompt_version: debaterClaims && debaterClaims.length > 0 ? 'classify-v2-nli' : 'extract-v2-nli',
  };

  let text: string;
  const extractStart = Date.now();
  try {
    text = await ctx.generateWithEvaluator(prompt, 'Claim extraction', 180_000);
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'ai.error', component: 'debate-engine', level: 'error', debate_id: ctx.session?.id, message: `Claim extraction adapter error for ${POVER_INFO[speaker].label}`, error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    trace.status = 'adapter_error';
    trace.error_message = err instanceof Error ? err.message : String(err);
    trace.response_time_ms = Date.now() - extractStart;
    ctx.recordDiagnostic(entryId, { extraction_trace: trace });
    updateExtractionSummary(ctx, trace);
    // Stamp failure onto entry so adaptive-staging confidence gate gets a real signal.
    const entryOnErr = ctx.session.transcript.find(e => e.id === entryId);
    if (entryOnErr) {
      if (!entryOnErr.metadata) entryOnErr.metadata = {};
      (entryOnErr.metadata as Record<string, unknown>).claim_extraction_status = 'parse_error';
      (entryOnErr.metadata as Record<string, unknown>).extracted_claims_accepted = 0;
    }
    ctx.warn(`Claim extraction for ${POVER_INFO[speaker].label}`, err, 'Skipping — argument network will be incomplete for this turn');
    return;
  }
  const extractElapsed = Date.now() - extractStart;
  trace.response_time_ms = extractElapsed;
  trace.response_chars = text.length;
  trace.response_truncated = looksTruncated(text);

  let claims: RawExtractedClaim[] = [];
  try {
    const parsed = parseJsonRobust(text) as { claims?: RawExtractedClaim[] };
    claims = parsed.claims ?? [];
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'error', debate_id: ctx.session?.id, message: `Claim extraction parse error for ${POVER_INFO[speaker].label}`, error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    trace.status = 'parse_error';
    trace.error_message = err instanceof Error ? err.message : String(err);
    ctx.recordDiagnostic(entryId, {
      extraction_trace: trace,
      claim_extraction: {
        prompt, raw_response: text, response_time_ms: extractElapsed,
        claims_parsed: 0, schemes_classified: [],
      },
    });
    updateExtractionSummary(ctx, trace);
    ctx.warn(`Parsing claim extraction response for ${POVER_INFO[speaker].label}`, err, 'Skipping — argument network will be incomplete for this turn');
    return;
  }

  trace.candidates_proposed = claims.length;
  if (claims.length === 0) {
    trace.status = trace.response_truncated ? 'truncated_response' : 'empty_response';
  }

  const overlapThreshold = (debaterClaims && debaterClaims.length > 0) ? 0.1 : 0.15;
  const claimsResult = await processExtractedClaims(
    {
      claims,
      statement,
      speaker,
      entryId,
      taxonomyRefIds,
      turnNumber,
      existingNodes: an.nodes,
      existingEdgeCount: an.edges.length,
      startNodeId: an.nodes.length + 1,
      taxonomyEdges: ctx.taxonomy.edges?.edges,
      knownNodeIds: ctx.getKnownNodeIds(),
      resolveRef: ctx.resolveRef,
      activatedSituations: ctx.getActivatedSituations().length > 0 ? ctx.getActivatedSituations() : undefined,
      audience: ctx.session.audience,
    },
    {
      groundingOverlapThreshold: overlapThreshold,
      isClassifyPath: !!(debaterClaims && debaterClaims.length > 0),
      colloquialTerms: ctx.config.vocabulary?.colloquialTerms,
      adapter: ctx.adapter,
    },
  );

  an.nodes.push(...claimsResult.newNodes);
  an.edges.push(...claimsResult.newEdges);

  // Entailment post-pass: BDI-category-aware sampling, detect-and-repair
  const entailmentRepairs: EntailmentRepairEvent[] = [];
  if (claimsResult.newNodes.length > 0) {
    const sampled = sampleNodesForEntailment(claimsResult.newNodes);
    for (const node of sampled) {
      try {
        const eprompt = entailmentRepairPrompt(statement, node.text);
        const eText = await ctx.generateWithEvaluator(eprompt, 'Entailment check');
        const eResult = parseJsonRobust(eText) as {
          verdict?: string;
          explanation?: string;
          repaired_claim?: string | null;
        };
        const verdict = eResult.verdict as EntailmentRepairEvent['verdict'] ?? 'entailed';
        const overlap = wordOverlap(node.text, statement);
        const event: EntailmentRepairEvent = {
          node_id: node.id,
          bdi_category: node.bdi_category ?? 'unknown',
          verdict,
          explanation: eResult.explanation ?? '',
          original_text: node.text,
          repaired_text: eResult.repaired_claim ?? null,
          overlap_pct: Math.round(overlap * 100),
        };
        entailmentRepairs.push(event);

        if ((verdict === 'partial' || verdict === 'not_entailed') && eResult.repaired_claim) {
          node.text = eResult.repaired_claim;
        }
      } catch (eErr) {
        getGlobalRecorder()?.record({ type: 'ai.error', component: 'debate-engine', level: 'warn', debate_id: ctx.session?.id, message: `Entailment check failed for ${node.id}`, error: { name: (eErr as Error).name ?? 'Error', message: String(eErr), stack: (eErr as Error).stack } });
        ctx.warn(`Entailment check for ${node.id}`, eErr, 'Skipping — claim text unchanged');
      }
    }
  }

  // Embed new AN nodes for AN-based taxonomy relevance scoring (non-blocking)
  const adapter = ctx.adapter as ExtendedAIAdapter;
  if (adapter.computeQueryEmbedding && claimsResult.newNodes.length > 0) {
    for (const node of claimsResult.newNodes) {
      try {
        const { vector } = await adapter.computeQueryEmbedding(node.text.slice(0, 300));
        if (vector && vector.length > 0) node.embedding = vector;
      } catch { /* telemetry — silent by design: per-node AN embedding is best-effort */ }
      if (node.attribution_text_genus) {
        try {
          const { vector } = await adapter.computeQueryEmbedding(node.attribution_text_genus.slice(0, 300));
          if (vector && vector.length > 0) node.attribution_embedding = vector;
        } catch { /* best-effort: falls back to node.embedding for attribution */ }
      }
    }
  }

  // Per-claim taxonomy attribution (t/110): compare AN embeddings against same-POV Belief nodes
  if (claimsResult.newNodes.length > 0) {
    const speakerPov = POVER_INFO[speaker as Exclude<SpeakerId, 'user'>]?.pov;
    if (speakerPov) {
      const povNodes = ctx.taxonomy[speakerPov as PovKey]?.nodes ?? [];
      // Include all-POV node IDs so steelman nodes can be attributed to the steelmanned camp.
      const allCandidateNodeIds = new Set<string>();
      for (const pov of POV_KEYS) {
        for (const n of ctx.taxonomy[pov as PovKey]?.nodes ?? []) {
          allCandidateNodeIds.add(n.id);
        }
      }
      const attrResult = computeClaimTaxonomyAttribution(
        claimsResult.newNodes, speakerPov, ctx.taxonomy.embeddings, allCandidateNodeIds,
        3, ctx.taxonomy.syntheticStatements ?? {},
      );
      trace.attribution_attributed = attrResult.attributed;
      trace.attribution_unattributed = attrResult.unattributed;
      trace.attribution_missing_embedding = attrResult.missing_embedding;
      trace.attribution_novel_argument = attrResult.novel_argument;
      trace.attribution_decisions = attrResult.decisions;

      // V4 NLI direction gate (t/2746): demote 'opposes' claims to direction_mismatch
      const nodeTextById = new Map(povNodes.map(n => [n.id, buildNliNodeProp(n.label, n.description)]));
      const nliResult = runNliDirectionGate(claimsResult.newNodes, nodeTextById, speakerPov);
      const { opposingIds, counts: nliCounts } = nliResult;
      getGlobalRecorder()?.record({
        type: 'an.nli_direction_gate', component: 'debate-engine', level: 'info',
        speaker, debate_id: ctx.session?.id,
        message: `NLI gate: ${opposingIds.size} demoted`,
        data: { ...nliCounts },
      });
      if (opposingIds.size > 0) {
        for (const node of claimsResult.newNodes) {
          if (!opposingIds.has(node.id)) continue;
          node.claim_taxonomy_attribution = {
            primary_ref: '',
            attribution_confidence: node.claim_taxonomy_attribution?.attribution_confidence ?? 0,
            unattributed_reason: 'direction_mismatch',
          };
          const dec = trace.attribution_decisions?.find(d => d.claim_id === node.id);
          if (dec) {
            dec.primary_ref = null;
            dec.unattributed_reason = 'direction_mismatch';
            dec.secondary_refs_count = 0;
          }
        }
        const nliDemoted = opposingIds.size;
        trace.attribution_attributed = (trace.attribution_attributed ?? 0) - nliDemoted;
        trace.attribution_unattributed = (trace.attribution_unattributed ?? 0) + nliDemoted;
        trace.attribution_novel_argument = (trace.attribution_novel_argument ?? 0) + nliDemoted;
      }

      // Log warning if zero statement-level taxonomy_refs (injection may have failed upstream)
      if (taxonomyRefIds.length === 0 && claimsResult.newNodes.length > 0) {
        console.warn(`[attribution.no-statement-refs] speaker=${speaker} entry=${entryId} — no taxonomy_refs on parent statement`);
      }
    }
  }

  // Exclusion boundary guard (t/450): flag claims in a node's excluded scope
  const nodesWithEmbeddingAndRef = claimsResult.newNodes.filter(
    n => n.embedding && n.claim_taxonomy_attribution?.primary_ref,
  );
  const refsWithExclusionVec = new Set(
    nodesWithEmbeddingAndRef
      .map(n => n.claim_taxonomy_attribution!.primary_ref!)
      .filter(ref => (ctx.taxonomy.embeddings[ref] as { exclusion_vector?: number[] })?.exclusion_vector),
  ).size;
  const exclusionViolations = checkClaimExclusionBoundary(
    claimsResult.newNodes, ctx.taxonomy.embeddings,
  );
  trace.exclusion_guard = {
    checked: nodesWithEmbeddingAndRef.length,
    refs_with_exclusion_vector: refsWithExclusionVec,
    violations: exclusionViolations,
    threshold: EXCLUSION_RATIO_THRESHOLD,
  };
  if (exclusionViolations.length > 0) {
    trace.exclusion_violations = exclusionViolations;
    getGlobalRecorder()?.record({
      type: 'an.exclusion_violation', component: 'debate-engine', level: 'warn',
      speaker, debate_id: ctx.session?.id,
      message: `${exclusionViolations.length} claim(s) flagged in exclusion zone`,
      data: { violations: exclusionViolations },
    });
  }

  const commits = ctx.session.commitments![speaker];
  commits.asserted.push(...claimsResult.commitments.asserted);
  commits.conceded.push(...claimsResult.commitments.conceded);
  commits.challenged.push(...claimsResult.commitments.challenged);

  trace.candidates_accepted = claimsResult.accepted.length;
  trace.candidates_rejected = claimsResult.rejected.length;
  trace.rejection_reasons = claimsResult.rejectionReasons;
  trace.rejected_overlap_pcts = claimsResult.rejectedOverlapPcts;
  trace.max_overlap_vs_existing = claimsResult.maxOverlapVsExisting;

  const accepted = claimsResult.accepted;
  const rejected = claimsResult.rejected;

  ctx.session.diagnostics!.overview.claims_accepted += accepted.length;
  ctx.session.diagnostics!.overview.claims_rejected += rejected.length;

  // QBAF: recompute strengths after each extraction
  if (an.nodes.some(n => n.base_strength != null)) {
    const qbafNodes = an.nodes
      .filter(n => n.base_strength != null)
      .map(n => ({ id: n.id, base_strength: n.base_strength! }));
    const qbafEdges = an.edges.map(e => ({
      source: e.source,
      target: e.target,
      type: e.type,
      weight: e.weight ?? 0.5,
      attack_type: e.attack_type,
    }));
    const result = computeQbafStrengths(qbafNodes, qbafEdges);
    ctx.session.last_qbaf_result = { iterations: result.iterations, converged: result.converged, oscillationDetected: result.oscillationDetected, dampingLevel: result.dampingLevel };
    ctx.session.max_qbaf_damping_level = Math.max(ctx.session.max_qbaf_damping_level ?? 0, result.dampingLevel ?? 0);
    ctx.session.qbaf_runs_total = (ctx.session.qbaf_runs_total ?? 0) + 1;
    if ((result.dampingLevel ?? 0) > 0) ctx.session.qbaf_runs_oscillated = (ctx.session.qbaf_runs_oscillated ?? 0) + 1;
    if (!result.converged) {
      console.warn(`[qbaf-non-convergence] iterations=${result.iterations} oscillation=${result.oscillationDetected} damping=${result.dampingLevel} nodes=${qbafNodes.length} edges=${qbafEdges.length}`);
      getGlobalRecorder()?.record({
        type: 'qbaf.non_convergence', component: 'debate-engine', level: 'warn',
        debate_id: ctx.session?.id,
        message: `QBAF non-convergence: ${result.iterations} iterations, damping level ${result.dampingLevel}`,
        data: { iterations: result.iterations, oscillationDetected: result.oscillationDetected, dampingLevel: result.dampingLevel, nodes: qbafNodes.length, edges: qbafEdges.length },
      });
    }
    for (const node of an.nodes) {
      const strength = result.strengths.get(node.id);
      if (strength !== undefined && Number.isFinite(strength)) node.computed_strength = strength;
    }

    // Update convergence tracker with QBAF strengths (t/284: also update
    // the heuristic `convergence` field so it doesn't stay at default 0.5)
    if (ctx.session.convergence_tracker) {
      for (const issue of ctx.session.convergence_tracker.issues) {
        const qbafConv = computeQbafConvergence(issue.claim_ids, result.strengths);
        if (qbafConv !== undefined) {
          issue.qbaf_strength = qbafConv;
          issue.convergence = qbafConv;
          issue.history.push({ turn: turnNumber, value: qbafConv });
        }
      }
      ctx.session.convergence_tracker.last_updated_turn = turnNumber;
    }

    // Snapshot timeline: capture all computed_strengths at this turn
    if (!ctx.session.qbaf_timeline) ctx.session.qbaf_timeline = [];
    const strengths: Record<string, number> = {};
    const bdiBd: Record<string, import('../types.js').BdiSubScores> = {};
    for (const node of an.nodes) {
      if (node.computed_strength != null) strengths[node.id] = node.computed_strength;
      if (node.bdi_sub_scores) bdiBd[node.id] = node.bdi_sub_scores;
    }
    ctx.session.qbaf_timeline.push({
      turn: turnNumber,
      strengths,
      bdi_breakdown: Object.keys(bdiBd).length > 0 ? bdiBd : undefined,
    });

    // Compute per-entry net delta: sum of strength changes caused by this turn's claims
    const prevSnapshot = ctx.session.qbaf_timeline.length >= 2
      ? ctx.session.qbaf_timeline[ctx.session.qbaf_timeline.length - 2].strengths
      : {};
    let netDelta = 0;
    for (const [id, strength] of Object.entries(strengths)) {
      netDelta += strength - (prevSnapshot[id] ?? 0);
    }
    // Store on the transcript entry metadata
    const entry = ctx.session.transcript.find(e => e.id === entryId);
    if (entry) {
      if (!entry.metadata) entry.metadata = {};
      entry.metadata.qbaf_net_delta = netDelta;
    }
  }

  // Convergence signals + process rewards (t/282, t/283)
  try {
    // Build turn embeddings map from cached session data + current turn
    let turnEmbeddings: Map<string, number[]> | undefined;
    const cached = ctx.session.turn_embeddings ?? {};
    const adapter = ctx.adapter as ExtendedAIAdapter;
    if (adapter.computeQueryEmbedding) {
      const currentEntry = ctx.session.transcript.find(e => e.id === entryId);
      if (currentEntry && !cached[entryId]) {
        try {
          const { vector } = await adapter.computeQueryEmbedding(currentEntry.content.slice(0, 1000));
          if (vector && vector.length > 0) cached[entryId] = vector;
        } catch { /* telemetry — silent by design: turn embedding is best-effort */ }
      }
      // Prune stale entries — keep most recent 30
      const recentIds = new Set(ctx.session.transcript.slice(-30).map(e => e.id));
      for (const key of Object.keys(cached)) {
        if (!recentIds.has(key)) delete cached[key];
      }
      ctx.session.turn_embeddings = cached;
      if (Object.keys(cached).length > 0) {
        turnEmbeddings = new Map(Object.entries(cached));
      }
    }

    // Precomputed QBAF strengths map (available from the QBAF block above)
    const precomputedStrengths = new Map<string, number>();
    for (const node of an.nodes) {
      if (node.computed_strength != null) precomputedStrengths.set(node.id, node.computed_strength);
    }

    const sig = computeConvergenceSignals(
      entryId,
      speaker,
      ctx.session.transcript,
      an.nodes,
      an.edges,
      ctx.session.convergence_signals ?? [],
      turnEmbeddings,
      precomputedStrengths,
      ctx.session.topic?.embedding,
      ctx.session.topic?.clause_embeddings,
      ctx.session.crux_tracker,
    );
    if (!ctx.session.convergence_signals) ctx.session.convergence_signals = [];
    ctx.session.convergence_signals.push(sig);

    if (sig.concession_opportunity.outcome === 'taken' && ctx.session.convergence_tracker) {
      const cruxIds = ctx.session.crux_tracker
        ? new Set(ctx.session.crux_tracker.flatMap(c => c.attacking_claim_ids))
        : undefined;
      const boostedIds = boostConvergenceOnConcession(
        ctx.session.convergence_tracker,
        sig,
        entryId,
        speaker,
        an.nodes,
        an.edges,
        turnNumber,
        cruxIds,
      );
      if (boostedIds.length > 0) {
        getGlobalRecorder()?.record({
          type: 'debate.signal', component: 'debate-engine', level: 'info',
          debate_id: ctx.session?.id,
          message: `Concession convergence boost: ${boostedIds.length} issue(s) boosted for ${speaker}`,
          data: { boosted_issue_ids: boostedIds, speaker },
        });
      }
    }

    // Taxonomy CONVERGES_WITH edge boost
    if (ctx.session.convergence_tracker && ctx.taxonomy.edges?.edges) {
      const taxBoostedIds = boostConvergenceFromTaxonomyEdges(
        ctx.session.convergence_tracker,
        ctx.taxonomy.edges.edges,
        an.nodes,
        turnNumber,
      );
      if (taxBoostedIds.length > 0) {
        getGlobalRecorder()?.record({
          type: 'debate.signal', component: 'debate-engine', level: 'info',
          debate_id: ctx.session?.id,
          message: `Taxonomy CONVERGES_WITH boost: ${taxBoostedIds.length} issue(s) boosted`,
          data: { boosted_issue_ids: taxBoostedIds },
        });
      }
    }

    // Crux refresh after concession cascade
    if (ctx.session.convergence_signals && ctx.session.crux_tracker) {
      const activeCruxes = ctx.session.crux_tracker.filter(c => !isTerminalCruxState(c.state));
      if (activeCruxes.length > 0) {
        const cascade = detectConcessionCascade(ctx.session.convergence_signals);
        if (cascade.detected) {
          const recentConcessions = cascade.concessions.map(c => {
            const entry = ctx.session.transcript.find(e => e.id === c.entry_id);
            return { speaker: c.speaker, conceded_text: entry?.content?.slice(0, 300) ?? '' };
          });
          const recentTranscript = ctx.session.transcript
            .slice(-6)
            .map(e => `[${e.speaker}]: ${e.content?.slice(0, 200) ?? ''}`)
            .join('\n');
          const refreshPrompt = cruxRefreshPrompt(
            activeCruxes.map(c => ({ id: c.id, description: c.description, polarity: c.support_polarity, disagreement_type: c.disagreement_type })),
            recentConcessions,
            recentTranscript,
            (ctx.session.topic as { text?: string })?.text ?? '',
          );
          try {
            const cruxModel = ctx.resolveStageModel('crux');
            const refreshRaw = ctx.config.usageDeps
              ? (await callByUsage('debate.crux-refresh', { prompt: refreshPrompt }, ctx.config.usageDeps, { model: cruxModel })).text
              : await ctx.adapter.generateText(refreshPrompt, cruxModel, { timeoutMs: 15_000 });
            const refreshData = parseJsonRobust(refreshRaw) as {
              crux_verdicts?: { id: string; verdict: string; reason: string }[];
              emerging_cruxes?: { description: string; speakers_involved: string[]; disagreement_type: string; reason: string }[];
            };
            let transitioned = 0;
            if (refreshData?.crux_verdicts) {
              for (const v of refreshData.crux_verdicts) {
                if (v.verdict === 'resolved' || v.verdict === 'superseded') {
                  const idx = ctx.session.crux_tracker!.findIndex(c => c.id === v.id);
                  if (idx >= 0) {
                    ctx.session.crux_tracker![idx] = transitionCrux(
                      ctx.session.crux_tracker![idx], 'resolved', turnNumber,
                      `${v.verdict} by concession cascade: ${v.reason}`,
                    );
                    transitioned++;
                  }
                }
              }
            }
            getGlobalRecorder()?.record({
              type: 'debate.crux_refresh', component: 'debate-engine', level: 'info',
              debate_id: ctx.session?.id,
              message: `Crux refresh after cascade: ${transitioned} transitioned, ${refreshData?.emerging_cruxes?.length ?? 0} emerging`,
              data: {
                cascade_concessions: cascade.concessions.length,
                verdicts: refreshData?.crux_verdicts ?? [],
                emerging: refreshData?.emerging_cruxes ?? [],
                transitioned,
              },
            });
          } catch (err) {
            getGlobalRecorder()?.record({
              type: 'system.error', component: 'debate-engine', level: 'warn',
              debate_id: ctx.session?.id,
              message: `Crux refresh failed: ${String(err)}`,
              error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
            });
          }
        }
      }
    }

    // Process reward — requires turn validation from this entry
    const turnTrail = ctx.session.turn_validations?.[entryId];
    const turnValidation = turnTrail?.final;
    if (turnValidation) {
      const currentEntry = ctx.session.transcript.find(e => e.id === entryId);
      const entryMeta = currentEntry?.metadata as Record<string, unknown> | undefined;
      const moveTypes = (entryMeta?.move_types as (string | import('../helpers.js').MoveAnnotation)[]) ?? [];
      const phase = ((entryMeta?.debate_phase as string) ?? 'argumentation') as DebatePhase;

      const priorSpeakerEntry = ctx.session.transcript
        .filter(e => e.speaker === speaker && e.type === 'statement')
        .slice(-2)[0];
      const priorMeta = priorSpeakerEntry?.metadata as Record<string, unknown> | undefined;
      const priorMoves = (priorMeta?.move_types as (string | import('../helpers.js').MoveAnnotation)[]) ?? [];

      const pr = computeProcessReward({
        convergenceSignals: sig,
        turnValidation,
        phase,
        moveCount: moveTypes.length,
        priorMoveCount: priorMoves.length > 0 ? priorMoves.length : undefined,
        taxonomyRefCount: currentEntry?.taxonomy_refs?.length ?? 0,
        activeCruxCount: ctx.session.crux_tracker
          // `undecided` is terminal (t/1676) — exclude so a finalized crux does not inflate the process-reward signal.
          ? ctx.session.crux_tracker.filter(c => !isTerminalCruxState(c.state)).length
          : 0,
      });

      const prEntry: ProcessRewardEntry = {
        entry_id: entryId,
        round: sig.round,
        speaker,
        phase,
        score: pr.score,
        components: pr.components,
      };
      if (!ctx.session.process_rewards) ctx.session.process_rewards = [];
      ctx.session.process_rewards.push(prEntry);
    }
  } catch (convErr) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: ctx.session?.id, message: 'Convergence signal/process-reward computation failed', error: { name: (convErr as Error).name ?? 'Error', message: String(convErr), stack: (convErr as Error).stack } });
    console.warn('[Convergence] Signal/process-reward computation failed (non-blocking):', convErr);
  }

  // Finalize trace
  trace.candidates_accepted = accepted.length;
  trace.candidates_rejected = rejected.length;
  trace.an_node_count_after = an.nodes.length;
  trace.an_nodes_added_ids = accepted.map(a => a.id);
  if (accepted.length === 0 && trace.status === 'ok') {
    trace.status = 'no_new_nodes';
  }

  ctx.recordDiagnostic(entryId, {
    extracted_claims: { accepted, rejected },
    claim_extraction: {
      prompt,
      raw_response: text,
      response_time_ms: extractElapsed,
      claims_parsed: claims.length,
      schemes_classified: claims.flatMap(c => c.responds_to ?? [])
        .filter(r => r.argumentation_scheme)
        .map(r => r.argumentation_scheme!),
    },
    extraction_trace: trace,
    entailment_repairs: entailmentRepairs.length > 0 ? entailmentRepairs : undefined,
  });

  updateExtractionSummary(ctx, trace);

  // Stamp extraction results onto the entry so the adaptive-staging confidence
  // gate reads actual extraction quality each round (t/2208).
  const entryOnSuccess = ctx.session.transcript.find(e => e.id === entryId);
  if (entryOnSuccess) {
    if (!entryOnSuccess.metadata) entryOnSuccess.metadata = {};
    const confStatus: 'ok' | 'truncated' | 'parse_error' =
      (trace.status === 'ok' || trace.status === 'no_new_nodes') ? 'ok'
      : trace.status === 'truncated_response' ? 'truncated'
      : 'parse_error';
    (entryOnSuccess.metadata as Record<string, unknown>).claim_extraction_status = confStatus;
    (entryOnSuccess.metadata as Record<string, unknown>).extracted_claims_accepted = trace.candidates_accepted;
  }

  // Update unanswered claims ledger
  ctx.session.unanswered_claims_ledger = updateUnansweredLedger(
    ctx.session.unanswered_claims_ledger ?? [],
    an.nodes,
    an.edges,
    turnNumber,
  );

  // Update crux resolution tracker
  ctx.session.crux_tracker = updateCruxTracker(
    ctx.session.crux_tracker,
    an.nodes,
    an.edges,
    ctx.session.commitments ?? {},
    turnNumber,
  );
}
