// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Output formatters for the CLI debate runner.
 * Slug generation, Markdown export, diagnostics/harvest output builders.
 */

import type { DebateSession, SpeakerId, TranscriptEntry } from './types.js';
import { POVER_INFO, normalizeVerdict } from './types.js';
import { orderSynthesisLists } from './synthesisOrder.js';
import {
  extractConflictCandidates,
  extractSteelmanCandidates,
  extractDebateRefCandidates,
  extractVerdictCandidates,
  extractConceptCandidates,
} from './harvestUtils.js';

// ── Slug generation (port of New-Slug.ps1) ───────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'of', 'in', 'to', 'for', 'with', 'on', 'at',
  'is', 'it', 'by', 'that', 'this', 'be', 'are', 'was', 'or', 'not',
]);

export function generateSlug(text: string, maxLength: number = 60): string {
  // Normalize Unicode → ASCII approximation
  let slug = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  slug = slug.toLowerCase();
  slug = slug.replace(/[^\w\s-]/g, '');  // keep word chars, spaces, hyphens
  slug = slug.replace(/[\s_]+/g, '-');    // collapse whitespace to hyphens
  slug = slug.replace(/^-+|-+$/g, '');    // trim leading/trailing hyphens

  // Remove stop words
  slug = slug.split('-').filter(w => !STOP_WORDS.has(w)).join('-');
  slug = slug.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');

  if (slug.length > maxLength) {
    slug = slug.substring(0, maxLength);
    const lastHyphen = slug.lastIndexOf('-');
    if (lastHyphen > 10) slug = slug.substring(0, lastHyphen);
  }

  if (!slug) {
    slug = `debate-${new Date().toISOString().slice(0, 10)}`;
  }

  return slug;
}

// ── Markdown export ──────────────────────────────────────

function speakerLabel(speaker: string): string {
  if (speaker === 'user') return 'Moderator';
  if (speaker === 'system') return 'System';
  const info = POVER_INFO[speaker as Exclude<SpeakerId, 'user'>];
  return info ? `${info.label} (${info.pov})` : speaker;
}

export function formatDebateMarkdown(session: DebateSession): string {
  const lines: string[] = [];

  // Header
  lines.push(`# Debate: ${session.title}`);
  lines.push('');
  lines.push(`**Date:** ${session.created_at.slice(0, 10)} | **Model:** ${session.debate_model ?? 'default'} | **Protocol:** ${session.protocol_id ?? 'structured'}`);
  lines.push(`**Debaters:** ${session.active_povers.filter(p => p !== 'user').map(p => speakerLabel(p)).join(', ')}`);
  lines.push('');

  // Topic
  lines.push('## Topic');
  lines.push('');
  lines.push(session.topic.final);
  if (session.topic.refined && session.topic.refined !== session.topic.original) {
    lines.push('');
    lines.push(`*Original:* ${session.topic.original}`);
    lines.push(`*Refined:* ${session.topic.refined}`);
  }
  lines.push('');

  // Group transcript by phases
  const openings = session.transcript.filter(e => e.type === 'opening');
  const debates = session.transcript.filter(e =>
    e.type === 'statement' || e.type === 'question' || e.type === 'probing',
  );
  const synthesis = session.transcript.find(e => e.type === 'concluding');
  const factChecks = session.transcript.filter(e => e.type === 'fact-check');

  // Opening Statements
  if (openings.length > 0) {
    lines.push('## Opening Statements');
    lines.push('');
    for (const entry of openings) {
      lines.push(`### ${speakerLabel(entry.speaker)}`);
      lines.push('');
      lines.push(entry.content);
      lines.push('');
      if (entry.taxonomy_refs.length > 0) {
        lines.push(`*Taxonomy refs:* ${entry.taxonomy_refs.map(r => `\`${r.node_id}\``).join(', ')}`);
        lines.push('');
      }
    }
  }

  // Debate Rounds
  if (debates.length > 0) {
    lines.push('## Debate');
    lines.push('');
    for (const entry of debates) {
      const meta = entry.metadata as Record<string, unknown> | undefined;
      const focusPoint = meta?.focus_point as string | undefined;
      const addressing = entry.addressing;

      if (entry.type === 'question') {
        lines.push(`### Moderator`);
      } else if (entry.type === 'probing') {
        lines.push('### Probing Questions');
      } else {
        const target = addressing ? ` → ${speakerLabel(addressing as string)}` : '';
        lines.push(`### ${speakerLabel(entry.speaker)}${target}`);
      }

      if (focusPoint) {
        lines.push(`\\textcolor{NavyBlue}{\\textit{Focus: ${focusPoint.replace(/[\\{}]/g, '\\$&')}}}`);
        lines.push('');
      }
      lines.push('');
      if (entry.type === 'probing') {
        // Ensure each numbered question is separated by a blank line for pandoc
        const questions = entry.content.split(/\n(?=\*?\d+\.\s)/);
        for (const q of questions) {
          lines.push(q.trim().replace(/\\/g, '\\\\').replace(/@/g, '\\@'));
          lines.push('');
        }
      } else {
        // Escape @ mentions so pandoc doesn't treat them as citations
        lines.push(entry.content.replace(/\\/g, '\\\\').replace(/@/g, '\\@'));
        lines.push('');
      }

      if (entry.taxonomy_refs.length > 0) {
        lines.push(`*Refs:* ${entry.taxonomy_refs.map(r => `\`${r.node_id}\``).join(', ')}`);
        lines.push('');
      }
      if (entry.policy_refs && entry.policy_refs.length > 0) {
        lines.push(`*Policy refs:* ${entry.policy_refs.map(r => `\`${typeof r === 'string' ? r : r.policy_id}\``).join(', ')}`);
        lines.push('');
      }
    }
  }

  // Synthesis
  if (synthesis) {
    lines.push('## Synthesis');
    lines.push('');

    // Use the structured synthesis data if available for proper markdown formatting
    const rawSynth = (synthesis.metadata as Record<string, unknown>)?.synthesis as Record<string, unknown> | undefined;
    // t/769: the same relevance order the synthesis card shows.
    const synthData = orderSynthesisLists(rawSynth);
    if (synthData) {
      // Areas of Agreement
      const agreements = synthData.areas_of_agreement as { point: string; povers: string[] }[] | undefined;
      if (agreements?.length) {
        lines.push('### Areas of Agreement');
        lines.push('');
        for (const a of agreements) {
          const povers = a.povers?.map(p => POVER_INFO[p as Exclude<SpeakerId, 'user'>]?.label ?? p).join(', ') ?? '';
          lines.push(`- ${a.point}${povers ? ` (${povers})` : ''}`);
        }
        lines.push('');
      }

      // Areas of Disagreement
      const disagreements = synthData.areas_of_disagreement as { point: string; type?: string; bdi_layer?: string; resolvability?: string; positions?: { pover: string; stance: string }[] }[] | undefined;
      if (disagreements?.length) {
        lines.push('### Areas of Disagreement');
        lines.push('');
        for (const d of disagreements) {
          const typeTag = d.type ? ` [${d.type}]` : '';
          const bdiTag = d.bdi_layer ? ` {${d.bdi_layer}}` : '';
          lines.push(`- **${d.point}**${typeTag}${bdiTag}`);
          for (const pos of d.positions ?? []) {
            const label = POVER_INFO[pos.pover as Exclude<SpeakerId, 'user'>]?.label ?? pos.pover;
            lines.push(`  - **${label}:** ${pos.stance}`);
          }
          if (d.resolvability) {
            lines.push(`  - *Resolution path: ${d.resolvability.replace(/_/g, ' ')}*`);
          }
        }
        lines.push('');
      }

      // Cruxes
      const cruxes = synthData.cruxes as { question: string; if_yes?: string; if_no?: string; type?: string }[] | undefined;
      if (cruxes?.length) {
        lines.push('### Cruxes');
        lines.push('');
        for (const c of cruxes) {
          lines.push(`- ${c.question}${c.type ? ` [${c.type}]` : ''}`);
          if (c.if_yes) lines.push(`    - If yes, weakens: ${c.if_yes}`);
          if (c.if_no) lines.push(`    - If no, weakens: ${c.if_no}`);
          lines.push('');
        }
      }

      // Unresolved Questions
      const unresolved = synthData.unresolved_questions as string[] | undefined;
      if (unresolved?.length) {
        lines.push('### Unresolved Questions');
        lines.push('');
        for (const q of unresolved) {
          lines.push(`- ${q}`);
          lines.push('');
        }
        lines.push('');
      }

      // Preferences
      const preferences = synthData.preferences as { conflict: string; prevails: string; criterion: string; rationale: string; what_would_change_this?: string }[] | undefined;
      if (preferences?.length) {
        lines.push('### Resolution Analysis');
        lines.push('');
        for (const p of preferences) {
          if (p.prevails === 'undecidable') {
            lines.push(`- **${p.conflict}** — Undecidable`);
          } else {
            lines.push(`- **${p.conflict}** — Stronger: ${p.prevails} (${p.criterion?.replace(/_/g, ' ')})`);
          }
          lines.push(`  - *${p.rationale}*`);
          if (p.what_would_change_this) {
            lines.push(`  - Would change if: ${p.what_would_change_this}`);
          }
        }
        lines.push('');
      }
    } else {
      // Fallback to raw content
      lines.push(synthesis.content);
      lines.push('');
    }
  }

  // Fact Checks
  if (factChecks.length > 0) {
    const counts: Record<string, number> = {};
    for (const fc of factChecks) {
      const v = ((fc.metadata as Record<string, unknown> | undefined)?.verdict as string | undefined) ?? 'unknown';
      counts[v] = (counts[v] ?? 0) + 1;
    }
    const summary = Object.entries(counts).map(([v, n]) => `${n} ${v}`).join(', ');

    lines.push('## Fact Checks');
    lines.push('');
    lines.push(`*${factChecks.length} check${factChecks.length === 1 ? '' : 's'}: ${summary}*`);
    lines.push('');
    for (const fc of factChecks) {
      const meta = fc.metadata as Record<string, unknown> | undefined;
      const verdict = (meta?.verdict as string | undefined) ?? 'unknown';
      const source = (meta?.source as string | undefined) === 'auto' ? 'auto' : 'user';
      const confidence = meta?.confidence ? ` (confidence: ${meta.confidence})` : '';
      lines.push(`- **${verdict}** _[${source}]_${confidence}: ${fc.content.slice(0, 240)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Diagnostics output ───────────────────────────────────

export function buildDiagnosticsOutput(session: DebateSession): object {
  return {
    debate_id: session.id,
    entries: session.diagnostics?.entries ?? {},
    overview: session.diagnostics?.overview ?? {
      total_ai_calls: 0,
      total_response_time_ms: 0,
      claims_accepted: 0,
      claims_rejected: 0,
      move_type_counts: {},
      disagreement_type_counts: {},
    },
    verification: computeVerificationDiagnostics(session),
  };
}

/**
 * Aggregate fact-check activity across the transcript and argument network.
 * Covers both auto-verification (inline, Gemini-grounded) and user-invoked checks.
 */
function computeVerificationDiagnostics(session: DebateSession): {
  total_checks: number;
  auto_checks: number;
  user_checks: number;
  verdict_counts: Record<string, number>;
  auto_verdict_counts: Record<string, number>;
  user_verdict_counts: Record<string, number>;
  confidence_counts: Record<string, number>;
  precise_belief_claims: number;
  precise_beliefs_verified: number;
  precise_belief_coverage: number;
  claim_verification_status_counts: Record<string, number>;
} {
  const factChecks = session.transcript.filter(e => e.type === 'fact-check');
  const verdictCounts: Record<string, number> = {};
  const autoVerdictCounts: Record<string, number> = {};
  const userVerdictCounts: Record<string, number> = {};
  const confidenceCounts: Record<string, number> = {};
  let autoChecks = 0;
  let userChecks = 0;

  for (const fc of factChecks) {
    const meta = (fc.metadata ?? {}) as Record<string, unknown>;
    const verdict = (meta.verdict as string | undefined) ?? 'unknown';
    const source = (meta.source as string | undefined) === 'auto' ? 'auto' : 'user';
    const confidence = meta.confidence as string | undefined;

    verdictCounts[verdict] = (verdictCounts[verdict] ?? 0) + 1;
    if (source === 'auto') {
      autoChecks++;
      autoVerdictCounts[verdict] = (autoVerdictCounts[verdict] ?? 0) + 1;
    } else {
      userChecks++;
      userVerdictCounts[verdict] = (userVerdictCounts[verdict] ?? 0) + 1;
    }
    if (confidence) confidenceCounts[confidence] = (confidenceCounts[confidence] ?? 0) + 1;
  }

  // Coverage: how many precise Belief claims in the argument network got verified
  const anNodes = session.argument_network?.nodes ?? [];
  const preciseBeliefs = anNodes.filter(
    (n: { bdi_category?: string; specificity?: string }) =>
      n.bdi_category === 'belief' && n.specificity === 'precise',
  );
  const verifiedPreciseBeliefs = preciseBeliefs.filter(
    (n: { verification_status?: string }) =>
      n.verification_status && n.verification_status !== 'pending',
  );
  const claimStatusCounts: Record<string, number> = {};
  for (const n of anNodes as { verification_status?: string }[]) {
    // Read-time alias shim: bucket legacy 'verified' under 'supported' in the counts.
    const s = n.verification_status ? normalizeVerdict(n.verification_status) : 'unchecked';
    claimStatusCounts[s] = (claimStatusCounts[s] ?? 0) + 1;
  }

  return {
    total_checks: factChecks.length,
    auto_checks: autoChecks,
    user_checks: userChecks,
    verdict_counts: verdictCounts,
    auto_verdict_counts: autoVerdictCounts,
    user_verdict_counts: userVerdictCounts,
    confidence_counts: confidenceCounts,
    precise_belief_claims: preciseBeliefs.length,
    precise_beliefs_verified: verifiedPreciseBeliefs.length,
    precise_belief_coverage: preciseBeliefs.length > 0
      ? verifiedPreciseBeliefs.length / preciseBeliefs.length
      : 0,
    claim_verification_status_counts: claimStatusCounts,
  };
}

// ── Harvest output ───────────────────────────────────────

export function buildHarvestOutput(
  session: DebateSession,
  getNodeLabel: (id: string) => string | null,
  allNodeIds: Set<string>,
): object {
  const degradedTurnIds = session.transcript
    .filter(e => e.degraded)
    .map(e => e.id);

  return {
    debate_id: session.id,
    debate_title: session.title,
    conflicts: extractConflictCandidates(session),
    steelmans: extractSteelmanCandidates(session, getNodeLabel),
    debate_refs: extractDebateRefCandidates(session, getNodeLabel),
    verdicts: extractVerdictCandidates(session),
    concepts: extractConceptCandidates(session, allNodeIds),
    degraded_turn_ids: degradedTurnIds.length > 0 ? degradedTurnIds : undefined,
  };
}
