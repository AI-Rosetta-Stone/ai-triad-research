// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// ── Unanswered Claims Ledger ────────────────────────────

import type { ArgumentNetworkNode, ArgumentNetworkEdge } from '../types.js';
import type { UnansweredClaimEntry } from '../types.js';
import { effectiveCamp } from './utils.js';
import { appendGroundingLine } from './prompts.js';

/**
 * Update the unanswered claims ledger after claim extraction.
 * Tracks claims with base_strength > 0.4 that have no incoming edges (not responded to).
 * Complements the 8-entry compression window (tactical) with a debate-wide view (strategic).
 */
export function updateUnansweredLedger(
  ledger: UnansweredClaimEntry[],
  nodes: ArgumentNetworkNode[],
  edges: ArgumentNetworkEdge[],
  currentRound: number,
): UnansweredClaimEntry[] {
  const updated = [...ledger];
  const targeted = new Set(edges.map(e => e.target));
  const ledgerIds = new Set(updated.map(e => e.claim_id));

  for (const node of nodes) {
    if ((node.base_strength ?? 0) <= 0.4) continue;

    const isAddressed = targeted.has(node.id);
    const existing = updated.find(e => e.claim_id === node.id);

    if (existing) {
      // Already tracked — check if now addressed
      if (isAddressed && !existing.addressed_round) {
        // Find who addressed it
        const addressingEdge = edges.find(e => e.target === node.id);
        const addressingNode = addressingEdge
          ? nodes.find(n => n.id === addressingEdge.source)
          : undefined;
        existing.addressed_round = currentRound;
        existing.addressed_by = addressingNode?.speaker as string | undefined;
      }
    } else if (!isAddressed && !ledgerIds.has(node.id)) {
      // New unanswered claim
      updated.push({
        claim_id: node.id,
        claim_text: node.text,
        speaker: node.speaker as string,
        first_unanswered_round: currentRound,
      });
    }
  }

  return updated;
}

/**
 * Format a moderator hint for the oldest unanswered claim.
 * Returns a hint string every 3 rounds, empty string otherwise.
 */
export function formatUnansweredClaimsHint(
  ledger: UnansweredClaimEntry[],
  currentRound: number,
): string {
  if (currentRound % 3 !== 0) return '';

  const unanswered = ledger
    .filter(e => !e.addressed_round)
    .sort((a, b) => a.first_unanswered_round - b.first_unanswered_round);

  if (unanswered.length === 0) return '';

  const oldest = unanswered[0];
  const age = currentRound - oldest.first_unanswered_round;

  return `\n\nSTRATEGIC NOTE: ${unanswered.length} claim(s) remain unanswered across the debate. ` +
    `The oldest (${age} rounds unanswered, from round ${oldest.first_unanswered_round}) is by ${oldest.speaker}: ` +
    `"${oldest.claim_text}". Consider directing the next responder to address it.`;
}

/**
 * Detect isolated high-strength claims from different speakers with no edges between them.
 * This pattern — strong positions coexisting without engagement — signals debaters talking
 * past each other. The fix is a SPECIFY move: force one side to state what would falsify
 * their position, making the disagreement testable.
 */
export function formatSpecifyHint(
  nodes: { id: string; text: string; speaker: string; base_strength?: number; computed_strength?: number }[],
  edges: { source: string; target: string }[],
): string {
  const strongNodes = nodes.filter(n => (n.computed_strength ?? n.base_strength ?? 0.5) >= 0.6);
  if (strongNodes.length < 2) return '';

  // Build edge adjacency (undirected — any edge between two nodes counts as engagement)
  const connected = new Set<string>();
  for (const e of edges) {
    connected.add(`${e.source}|${e.target}`);
    connected.add(`${e.target}|${e.source}`);
  }

  // Find pairs of strong claims from different speakers with no edge between them
  const isolatedPairs: { a: typeof strongNodes[0]; b: typeof strongNodes[0] }[] = [];
  for (let i = 0; i < strongNodes.length; i++) {
    for (let j = i + 1; j < strongNodes.length; j++) {
      const a = strongNodes[i], b = strongNodes[j];
      if (a.speaker === b.speaker) continue;
      if (!connected.has(`${a.id}|${b.id}`)) {
        isolatedPairs.push({ a, b });
      }
    }
  }

  if (isolatedPairs.length === 0) return '';

  // Pick the pair with the highest combined strength
  isolatedPairs.sort((x, y) => {
    const xStr = (x.a.computed_strength ?? x.a.base_strength ?? 0.5) + (x.b.computed_strength ?? x.b.base_strength ?? 0.5);
    const yStr = (y.a.computed_strength ?? y.a.base_strength ?? 0.5) + (y.b.computed_strength ?? y.b.base_strength ?? 0.5);
    return yStr - xStr;
  });

  const best = isolatedPairs[0];
  const aStr = (best.a.computed_strength ?? best.a.base_strength ?? 0.5).toFixed(2);
  const bStr = (best.b.computed_strength ?? best.b.base_strength ?? 0.5).toFixed(2);

  return `\n\nSPECIFY OPPORTUNITY: ${best.a.id} (${best.a.speaker}, strength ${aStr}) and ` +
    `${best.b.id} (${best.b.speaker}, strength ${bStr}) are both strong claims with NO direct ` +
    `engagement between them — the debaters may be talking past each other. Consider using ` +
    `a SPECIFY move: direct one debater to state what specific evidence or outcome would ` +
    `falsify their position. This forces testable predictions and makes the disagreement resolvable.`;
}

/**
 * QBAF-Grounded Concession Opportunity (QGCO).
 *
 * Surfaces opponent claims whose QBAF computed_strength exceeds `threshold` and
 * that the current speaker has not yet attacked or conceded. The debater can
 * choose to grant these points — counterbalancing the move-type rotation rule
 * that blocks consecutive CONCEDE openings and was causing debaters to never
 * concede anything.
 *
 * Returns '' if no qualifying candidates exist. The caller is responsible for
 * any round-based gating (e.g. fire only when no recent concession).
 */
export function formatConcessionCandidatesHint(
  nodes: { id: string; text: string; speaker: string; base_strength?: number; computed_strength?: number; embedding?: number[]; claim_taxonomy_attribution?: { primary_ref?: string } }[],
  edges: { source: string; target: string; type: string }[],
  currentSpeaker: string,
  priorConceded: string[] = [],
  threshold: number = 0.45,
  maxCandidates: number = 3,
  /** t/4644: looks up the attributed node's best-matching synthetic statement for a claim. */
  groundingLookup?: (nodeId: string, claimEmbedding: number[] | undefined) => string | undefined,
): string {
  const concededSet = new Set(priorConceded);
  const attackedByMe = new Set(
    edges
      .filter(e => e.type === 'attacks')
      .filter(e => nodes.find(n => n.id === e.source)?.speaker === currentSpeaker)
      .map(e => e.target),
  );

  const candidates = nodes
    .filter(n => effectiveCamp(n) !== currentSpeaker)
    .filter(n => !attackedByMe.has(n.id))
    .filter(n => !concededSet.has(n.id) && !concededSet.has(n.text))
    .map(n => ({ node: n, strength: n.computed_strength ?? n.base_strength ?? 0 }))
    .filter(c => c.strength >= threshold)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, maxCandidates);

  if (candidates.length === 0) return '';

  const lines = [
    '',
    '=== POTENTIAL CONCESSIONS ===',
    'These opponent claims are well-supported. You SHOULD concede at least one unless you have specific, concrete counter-evidence.',
    'Refusing to concede strong opposing points makes your overall argument weaker, not stronger.',
    'If you grant a point, name it explicitly and pivot to what you still contest.',
    'If you decline ALL candidates, you must explain specifically why each one is wrong — "I disagree" is not sufficient.',
  ];
  candidates.forEach((c, i) => {
    lines.push(
      `${i + 1}. [${c.node.id}] ${c.node.speaker} (strength ${c.strength.toFixed(2)}): "${c.node.text}"`,
    );
    appendGroundingLine(lines, c.node.claim_taxonomy_attribution?.primary_ref, c.node.embedding, groundingLookup);
  });
  lines.push('If you decline to concede, set "concession_considered": "declined" in your JSON response.');
  return lines.join('\n') + '\n';
}
