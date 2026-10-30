// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { DebateEngineInternals } from './internals.js';
import { type SpeakerId } from '../types.js';
import { formatCommitments, formatEstablishedPoints } from '../argumentNetwork.js';
import { ESTABLISHED_POINTS_LIMIT } from '../debateConfig.js';
import { makeGroundingLookup } from '../syntheticStatementLookup.js';

// ── Commitment context ─────────────────────────────────────

export function getCommitmentContext(engine: DebateEngineInternals, poverId: Exclude<SpeakerId, 'user'>): string {
  const commitments = engine.session.commitments?.[poverId];
  if (!commitments) return '';

  const an = engine.session.argument_network;
  const priorClaims = an?.nodes
    .filter(n => n.speaker === poverId)
    .map(n => ({ text: n.text }));

  return formatCommitments(commitments, priorClaims);
}

/** Get recent claims from other debaters so the current speaker doesn't echo them */
export function getEstablishedPointsContext(engine: DebateEngineInternals, poverId: Exclude<SpeakerId, 'user'>): string {
  const an = engine.session.argument_network;
  if (!an || an.nodes.length === 0) return '';

  const allNodes = an.nodes.map(n => ({
    id: n.id,
    text: n.canonical_proposition || n.text,
    speaker: n.speaker as string,
    steelman_of: n.steelman_of,
    verification_status: n.verification_status,
    verification_evidence: n.verification_evidence,
    embedding: n.embedding,
    claim_taxonomy_attribution: n.claim_taxonomy_attribution,
  }));

  const groundingLookup = makeGroundingLookup(engine.taxonomy.embeddings, engine.taxonomy.syntheticStatements);

  return formatEstablishedPoints(allNodes, poverId, ESTABLISHED_POINTS_LIMIT, an.edges.filter(e => e.type !== 'revoice_of') as { source: string; target: string; type: 'supports' | 'attacks' }[], groundingLookup);
}
