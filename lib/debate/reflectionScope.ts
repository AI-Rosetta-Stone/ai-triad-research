// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Reflection scope + evidence validation (t/3512).
//
// A camp's post-debate reflection used to receive its ENTIRE POV file (207-361 nodes, 28-46k
// tokens) while a debate injects ~230 and cites ~38. The reflector therefore proposed edits to
// nodes the debate never touched, and nothing checked whether the `evidence_entries` it cited
// actually referenced the node. Debate 55447f02: 3 of 4 reflection edits targeted nodes that were
// never injected and never cited, with claim ids that do not reference them.
//
// This module computes, per camp, the nodes the debate ACTUALLY engaged (injected / cited /
// referenced by argument-network claims), ranked by engagement, and validates an edit's cited
// evidence against the argument network. Pure — no IO, no store, renderer-safe.

import type { ArgumentNetworkNode, ArgumentNetworkEdge } from './types/argumentNetwork.js';

/** Per-node engagement record for one camp, as the reflection prompt sees it. */
export interface NodeEngagement {
  nodeId: string;
  /** The node was in a turn's injection manifest (offered to a debater). */
  injected: boolean;
  /** Times a transcript turn cited the node in taxonomy_refs (reflection turns excluded). */
  citations: number;
  /** Argument-network claims whose taxonomy_refs name this node. */
  claimIds: string[];
  /** Claims citing this node that were attacked by another claim. */
  attackedClaimIds: string[];
  /** Strongest attack (lowest-to-highest computed_strength of attacking claims), 0 when unattacked. */
  strongestAttack: number;
  /** Ranking score — see rankByEngagement. */
  score: number;
}

/** Transcript shape this module needs (structurally satisfied by DebateSession['transcript']). */
export interface EngagementTranscriptEntry {
  type: string;
  taxonomy_refs?: ReadonlyArray<string | { node_id: string }> | null;
  metadata?: { injection_manifest?: { povNodeIds?: string[] } | null } | null;
}

export interface EngagementInput {
  transcript: ReadonlyArray<EngagementTranscriptEntry>;
  anNodes: ReadonlyArray<ArgumentNetworkNode>;
  anEdges: ReadonlyArray<ArgumentNetworkEdge>;
}

/** Entry types that are debate content. A reflection turn's own refs must never count as
 *  engagement — that would let a reflection justify itself (the 55447f02 miscount). */
const NON_DEBATE_ENTRY_TYPES = new Set(['reflection', 'system']);

const refId = (r: string | { node_id: string }): string => (typeof r === 'string' ? r : r.node_id);

/**
 * Engagement for every node of `povPrefix` (e.g. 'saf-') that the debate touched.
 * A node absent from the result was neither injected nor cited nor claim-referenced.
 */
export function computeNodeEngagement(input: EngagementInput, povPrefix: string): NodeEngagement[] {
  const byId = new Map<string, NodeEngagement>();
  const get = (id: string): NodeEngagement => {
    let e = byId.get(id);
    if (!e) {
      e = { nodeId: id, injected: false, citations: 0, claimIds: [], attackedClaimIds: [], strongestAttack: 0, score: 0 };
      byId.set(id, e);
    }
    return e;
  };
  const mine = (id: string): boolean => id.startsWith(povPrefix);

  for (const entry of input.transcript) {
    for (const id of entry.metadata?.injection_manifest?.povNodeIds ?? []) {
      if (mine(id)) get(id).injected = true;
    }
    if (NON_DEBATE_ENTRY_TYPES.has(entry.type)) continue;
    for (const r of entry.taxonomy_refs ?? []) {
      const id = refId(r);
      if (mine(id)) get(id).citations++;
    }
  }

  const attackedTargets = new Map<string, number>(); // claim id → strongest attacker strength
  for (const edge of input.anEdges) {
    if (edge.type !== 'attacks') continue;
    const attacker = input.anNodes.find(n => n.id === edge.source);
    const strength = attacker?.computed_strength ?? 0;
    attackedTargets.set(edge.target, Math.max(attackedTargets.get(edge.target) ?? 0, strength));
  }

  for (const claim of input.anNodes) {
    for (const r of claim.taxonomy_refs ?? []) {
      const id = refId(r);
      if (!mine(id)) continue;
      const e = get(id);
      e.claimIds.push(claim.id);
      const attack = attackedTargets.get(claim.id);
      if (attack !== undefined) {
        e.attackedClaimIds.push(claim.id);
        e.strongestAttack = Math.max(e.strongestAttack, attack);
      }
    }
  }

  return rankByEngagement([...byId.values()]);
}

/**
 * Rank engaged nodes so the reflector reviews what carried the debate first. Citations and
 * claim references dominate; a node whose claims were attacked ranks above an unchallenged one
 * (that is where a debate actually tested a position); bare injection is the weakest signal.
 */
export function rankByEngagement(engagements: NodeEngagement[]): NodeEngagement[] {
  for (const e of engagements) {
    e.score = e.citations * 3
      + e.claimIds.length * 2
      + e.attackedClaimIds.length * 2
      + e.strongestAttack
      + (e.injected ? 1 : 0);
  }
  return engagements.sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId));
}

// ── Evidence validation ────────────────────────────────────────────────

export interface EvidenceValidation {
  /** At least one cited id resolves to a claim that references the edited node. */
  supported: boolean;
  /** Cited ids that resolve to a claim referencing the node. */
  supportingClaimIds: string[];
  /** Cited ids that name a real claim which does NOT reference the node. */
  unrelatedClaimIds: string[];
  /** Cited entries that are not claim ids at all (prose, transcript labels, unknown ids). */
  unresolvedEntries: string[];
  /** One-line human-readable reason, for the UI badge and the flight recorder. */
  reason: string;
}

/** Claim-id shapes a reflector cites: "AN-15", "an-15", "[AN-15]". Transcript ids ("S13") are
 *  deliberately NOT claim ids — they cannot prove the NODE was engaged, only that a turn exists. */
const CLAIM_ID_RE = /^\[?(AN-\d+)\]?$/i;

/**
 * Validate an edit's cited evidence against the argument network: does any cited claim actually
 * reference the node being edited? Returns the breakdown; the caller decides what to do with an
 * unsupported edit (we flag rather than silently drop — the reflection may still be right).
 */
export function validateEditEvidence(
  nodeId: string | null | undefined,
  evidenceEntries: ReadonlyArray<string> | undefined,
  anNodes: ReadonlyArray<ArgumentNetworkNode>,
): EvidenceValidation {
  const supportingClaimIds: string[] = [];
  const unrelatedClaimIds: string[] = [];
  const unresolvedEntries: string[] = [];

  // A new-node proposal has no node to have been engaged — nothing to validate against.
  if (!nodeId) {
    return { supported: true, supportingClaimIds, unrelatedClaimIds, unresolvedEntries, reason: 'No node id (new-node proposal) — evidence check not applicable' };
  }

  const claimsById = new Map(anNodes.map(n => [n.id.toUpperCase(), n]));
  for (const raw of evidenceEntries ?? []) {
    const m = CLAIM_ID_RE.exec(String(raw).trim());
    if (!m) { unresolvedEntries.push(String(raw)); continue; }
    const claim = claimsById.get(m[1].toUpperCase());
    if (!claim) { unresolvedEntries.push(String(raw)); continue; }
    const refs = (claim.taxonomy_refs ?? []).map(refId);
    if (refs.includes(nodeId)) supportingClaimIds.push(claim.id);
    else unrelatedClaimIds.push(claim.id);
  }

  const supported = supportingClaimIds.length > 0;
  let reason: string;
  if (supported) {
    reason = `${supportingClaimIds.length} cited claim(s) reference ${nodeId}: ${supportingClaimIds.join(', ')}`;
  } else if (unrelatedClaimIds.length > 0 || unresolvedEntries.length > 0) {
    const parts: string[] = [];
    if (unrelatedClaimIds.length > 0) parts.push(`${unrelatedClaimIds.length} cited claim(s) do not reference ${nodeId} (${unrelatedClaimIds.join(', ')})`);
    if (unresolvedEntries.length > 0) parts.push(`${unresolvedEntries.length} citation(s) are not resolvable claim ids (${unresolvedEntries.slice(0, 3).join(', ')})`);
    reason = `No debate evidence ties this edit to ${nodeId}: ${parts.join('; ')}`;
  } else {
    reason = `No evidence cited for ${nodeId}`;
  }
  return { supported, supportingClaimIds, unrelatedClaimIds, unresolvedEntries, reason };
}

// ── Tag-relation classifier (t/4213 D-1) ──────────────────────────────────

/** A single tag entry from pov-tags.json, sufficient for relation classification. */
export interface PovTagEntry {
  id: string;
  soul_doc: string;
}

/** How an edit seat's tag relates to the target node's tags (spec §2). */
export type TagRelation =
  | 'own'               // seat owns the target exclusively
  | 'shared'            // seat co-owns the target with other tag souls
  | 'foreign'           // target belongs to a different wing — refused unless reviewer overrides
  | 'untagged_target'   // target is untagged — umbrella/all-tag custodians apply
  | 'umbrella_on_tagged' // untagged seat editing a tagged target
  | 'no_tags';          // POV has no tags — rule is a no-op

/**
 * Classify how the editing seat's tag relates to the target node's tags (spec §2 table).
 *
 * @param seatTag   The seat's pov_tag id (e.g. 'critical'), or null for an untagged seat.
 * @param targetTags The target node's pov_tags array, or undefined/empty for an untagged node.
 * @param registry  The POV's tag entries from pov-tags.json (pre-filtered to the POV).
 *                  Pass [] when the POV has no tags — returns 'no_tags'.
 * @returns relation and the custodian soul ids to check (empty when no check is needed).
 */
export function classifyTagRelation(
  seatTag: string | null,
  targetTags: string[] | undefined,
  registry: PovTagEntry[],
): { relation: TagRelation; custodians: string[] } {
  if (registry.length === 0) return { relation: 'no_tags', custodians: [] };

  const T = targetTags && targetTags.length > 0 ? targetTags : [];
  const umbrellaSoul = registry[0].soul_doc.split('.')[0]; // e.g. 'skeptic'
  const soulDocOf = (tagId: string): string =>
    registry.find(e => e.id === tagId)?.soul_doc ?? `${umbrellaSoul}.${tagId}`;

  if (seatTag !== null) {
    if (T.length === 0) {
      // tagged seat, T = ∅ → untagged_target: umbrella + all tag souls except s
      return {
        relation: 'untagged_target',
        custodians: [umbrellaSoul, ...registry.filter(e => e.id !== seatTag).map(e => e.soul_doc)],
      };
    }
    if (T.length === 1 && T[0] === seatTag) {
      return { relation: 'own', custodians: [] };
    }
    if (T.includes(seatTag)) {
      // s ∈ T, |T| > 1 → shared: souls of T \ {s}
      return { relation: 'shared', custodians: T.filter(t => t !== seatTag).map(soulDocOf) };
    }
    // s ∉ T, T ≠ ∅ → foreign
    return { relation: 'foreign', custodians: [] };
  }

  // untagged seat
  if (T.length > 0) {
    // T ≠ ∅ → umbrella_on_tagged: souls of T
    return { relation: 'umbrella_on_tagged', custodians: T.map(soulDocOf) };
  }
  // T = ∅ → untagged_target: every tag soul (no umbrella — seat IS the umbrella)
  return { relation: 'untagged_target', custodians: registry.map(e => e.soul_doc) };
}
