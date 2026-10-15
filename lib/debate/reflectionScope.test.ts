// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3512 — reflection scope: only debate-engaged nodes reach the reflector, ranked by engagement,
// and an edit's cited evidence must actually reference the node it edits.

import { describe, it, expect } from 'vitest';
import {
  computeNodeEngagement,
  rankByEngagement,
  validateEditEvidence,
  classifyTagRelation,
  type EngagementInput,
  type NodeEngagement,
  type PovTagEntry,
} from './reflectionScope.js';
import type { ArgumentNetworkNode, ArgumentNetworkEdge } from './types/argumentNetwork.js';

const claim = (id: string, refs: string[], strength = 0.5): ArgumentNetworkNode => ({
  id, text: `claim ${id}`, speaker: 'safetyist', source_entry_id: 'e1', taxonomy_refs: refs,
  turn_number: 1, computed_strength: strength,
} as ArgumentNetworkNode);

const attack = (source: string, target: string): ArgumentNetworkEdge =>
  ({ id: `${source}->${target}`, source, target, type: 'attacks' } as ArgumentNetworkEdge);

const input = (over: Partial<EngagementInput> = {}): EngagementInput => ({
  transcript: [],
  anNodes: [],
  anEdges: [],
  ...over,
});

describe('computeNodeEngagement', () => {
  it('returns only nodes the debate touched, and only for the requested camp', () => {
    const result = computeNodeEngagement(input({
      transcript: [
        { type: 'statement', taxonomy_refs: [{ node_id: 'saf-beliefs-220' }], metadata: { injection_manifest: { povNodeIds: ['saf-beliefs-001', 'acc-beliefs-003'] } } },
      ],
      anNodes: [claim('AN-1', ['saf-intentions-228'])],
    }), 'saf-');
    expect(result.map(e => e.nodeId).sort()).toEqual(['saf-beliefs-001', 'saf-beliefs-220', 'saf-intentions-228']);
    // Never-touched and other-camp nodes are simply absent.
    expect(result.find(e => e.nodeId === 'acc-beliefs-003')).toBeUndefined();
  });

  it('does not count a reflection turn\'s own refs as engagement', () => {
    const result = computeNodeEngagement(input({
      transcript: [
        { type: 'reflection', taxonomy_refs: [{ node_id: 'saf-beliefs-120' }] },
        { type: 'system', taxonomy_refs: [{ node_id: 'saf-beliefs-121' }] },
        { type: 'statement', taxonomy_refs: [{ node_id: 'saf-beliefs-220' }] },
      ],
    }), 'saf-');
    expect(result.map(e => e.nodeId)).toEqual(['saf-beliefs-220']);
  });

  it('records citations, claims and attacks', () => {
    const result = computeNodeEngagement(input({
      transcript: [
        { type: 'statement', taxonomy_refs: [{ node_id: 'saf-beliefs-220' }] },
        { type: 'statement', taxonomy_refs: ['saf-beliefs-220'] },
      ],
      anNodes: [claim('AN-1', ['saf-beliefs-220']), claim('AN-2', ['saf-beliefs-220']), claim('AN-9', [], 0.8)],
      anEdges: [attack('AN-9', 'AN-1')],
    }), 'saf-');
    const e = result[0];
    expect(e.citations).toBe(2);
    expect(e.claimIds).toEqual(['AN-1', 'AN-2']);
    expect(e.attackedClaimIds).toEqual(['AN-1']);
    expect(e.strongestAttack).toBeCloseTo(0.8, 5);
  });

  it('marks injected-but-uncited nodes as injected with zero citations', () => {
    const result = computeNodeEngagement(input({
      transcript: [{ type: 'statement', metadata: { injection_manifest: { povNodeIds: ['saf-desires-002'] } } }],
    }), 'saf-');
    expect(result).toEqual([expect.objectContaining({ nodeId: 'saf-desires-002', injected: true, citations: 0, score: 1 })]);
  });
});

describe('rankByEngagement', () => {
  const mk = (nodeId: string, over: Partial<NodeEngagement>): NodeEngagement => ({
    nodeId, injected: false, citations: 0, claimIds: [], attackedClaimIds: [], strongestAttack: 0, score: 0, ...over,
  });

  it('ranks cited-and-attacked above cited above merely injected', () => {
    const ranked = rankByEngagement([
      mk('saf-a', { injected: true }),
      mk('saf-b', { citations: 5, claimIds: ['AN-1'] }),
      mk('saf-c', { citations: 5, claimIds: ['AN-2'], attackedClaimIds: ['AN-2'], strongestAttack: 0.9 }),
    ]);
    expect(ranked.map(e => e.nodeId)).toEqual(['saf-c', 'saf-b', 'saf-a']);
  });

  it('is deterministic for equal scores (id order)', () => {
    const ranked = rankByEngagement([mk('saf-z', { citations: 1 }), mk('saf-a', { citations: 1 })]);
    expect(ranked.map(e => e.nodeId)).toEqual(['saf-a', 'saf-z']);
  });
});

describe('validateEditEvidence', () => {
  const an = [claim('AN-6', ['saf-beliefs-999']), claim('AN-7', ['saf-beliefs-220'])];

  it('supports an edit whose cited claim references the node', () => {
    const v = validateEditEvidence('saf-beliefs-220', ['AN-7'], an);
    expect(v.supported).toBe(true);
    expect(v.supportingClaimIds).toEqual(['AN-7']);
    expect(v.reason).toContain('AN-7');
  });

  it('rejects when the cited claims reference a different node (the acc-beliefs-003 case)', () => {
    const v = validateEditEvidence('acc-beliefs-003', ['AN-6', 'AN-7'], an);
    expect(v.supported).toBe(false);
    expect(v.unrelatedClaimIds).toEqual(['AN-6', 'AN-7']);
    expect(v.reason).toContain('do not reference acc-beliefs-003');
  });

  it('rejects prose evidence (the saf-beliefs-120 case)', () => {
    const v = validateEditEvidence('saf-beliefs-120', ['Skeptic turns on hardware leakage', 'S13'], an);
    expect(v.supported).toBe(false);
    expect(v.unresolvedEntries).toEqual(['Skeptic turns on hardware leakage', 'S13']);
    expect(v.reason).toContain('not resolvable claim ids');
  });

  it('rejects an edit that cites nothing', () => {
    expect(validateEditEvidence('saf-beliefs-220', [], an).supported).toBe(false);
    expect(validateEditEvidence('saf-beliefs-220', undefined, an).supported).toBe(false);
  });

  it('accepts bracketed and lowercase claim ids', () => {
    expect(validateEditEvidence('saf-beliefs-220', ['[AN-7]'], an).supported).toBe(true);
    expect(validateEditEvidence('saf-beliefs-220', ['an-7'], an).supported).toBe(true);
  });

  it('does not apply to new-node proposals (no node id)', () => {
    const v = validateEditEvidence(null, ['AN-6'], an);
    expect(v.supported).toBe(true);
    expect(v.reason).toContain('not applicable');
  });
});

// ── classifyTagRelation (t/4213 D-1) ──────────────────────────────────────

describe('classifyTagRelation', () => {
  const reg: PovTagEntry[] = [
    { id: 'critical', soul_doc: 'skeptic.critical' },
    { id: 'institutional', soul_doc: 'skeptic.institutional' },
  ];

  it('no_tags — empty registry is a no-op regardless of seat or target', () => {
    expect(classifyTagRelation('critical', ['critical'], [])).toEqual({ relation: 'no_tags', custodians: [] });
    expect(classifyTagRelation(null, [], [])).toEqual({ relation: 'no_tags', custodians: [] });
  });

  it('own — tagged seat, target is exactly {s}', () => {
    expect(classifyTagRelation('critical', ['critical'], reg)).toEqual({ relation: 'own', custodians: [] });
  });

  it('shared — tagged seat, s ∈ T, |T| > 1', () => {
    const r = classifyTagRelation('critical', ['critical', 'institutional'], reg);
    expect(r.relation).toBe('shared');
    expect(r.custodians).toEqual(['skeptic.institutional']);
  });

  it('foreign — tagged seat, s ∉ T, T ≠ ∅', () => {
    expect(classifyTagRelation('critical', ['institutional'], reg)).toEqual({ relation: 'foreign', custodians: [] });
  });

  it('untagged_target (tagged seat) — tagged seat, T = ∅', () => {
    // custodians: umbrella + all tag souls except s
    const r = classifyTagRelation('critical', [], reg);
    expect(r.relation).toBe('untagged_target');
    expect(r.custodians).toContain('skeptic');              // umbrella
    expect(r.custodians).toContain('skeptic.institutional'); // the other tag soul
    expect(r.custodians).not.toContain('skeptic.critical'); // not s itself
  });

  it('untagged_target (tagged seat) — undefined targetTags treated as ∅', () => {
    const r = classifyTagRelation('institutional', undefined, reg);
    expect(r.relation).toBe('untagged_target');
    expect(r.custodians).toContain('skeptic');
    expect(r.custodians).toContain('skeptic.critical');
    expect(r.custodians).not.toContain('skeptic.institutional');
  });

  it('umbrella_on_tagged — untagged seat, T ≠ ∅', () => {
    const r = classifyTagRelation(null, ['critical'], reg);
    expect(r.relation).toBe('umbrella_on_tagged');
    expect(r.custodians).toEqual(['skeptic.critical']);
  });

  it('untagged_target (untagged seat) — untagged seat, T = ∅', () => {
    // custodians: every tag soul, NO umbrella (seat is the umbrella)
    const r = classifyTagRelation(null, [], reg);
    expect(r.relation).toBe('untagged_target');
    expect(r.custodians).toContain('skeptic.critical');
    expect(r.custodians).toContain('skeptic.institutional');
    expect(r.custodians).not.toContain('skeptic'); // umbrella NOT included
  });

  it('untagged_target (untagged seat) — undefined targetTags treated as ∅', () => {
    const r = classifyTagRelation(null, undefined, reg);
    expect(r.relation).toBe('untagged_target');
    expect(r.custodians).toHaveLength(2);
    expect(r.custodians).not.toContain('skeptic');
  });
});
