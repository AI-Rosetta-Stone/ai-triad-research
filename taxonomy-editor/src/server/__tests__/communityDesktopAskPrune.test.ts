// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { collectAllNodeIds, pruneUnknownNodeRefs } from '../community/community.js';
import type { InquiryResult } from '../../../../lib/inquiry/index.js';

// One distinct nodeId per schema site, so each test can tell exactly which site was pruned.
const SIT = 'sit-001';
const BY_CAMP = 'acc-beliefs-001';
const VERDICT = 'acc-desires-002';
const CONV = 'saf-beliefs-003';
const ALL = [SIT, BY_CAMP, VERDICT, CONV];

const fakeResult = (): InquiryResult => ({
  schemaVersion: 1,
  request: { question: 'test', fidelity: 'standard' },
  campVerdicts: [
    { camp: 'acc', verdict: 'acc verdict', nodes: [{ nodeId: VERDICT, label: 'V', camp: 'acc' }] },
  ],
  convergences: [
    { claim: 'shared claim', nodes: [{ nodeId: CONV, label: 'C', camp: 'saf' }] },
  ],
  evidenceLayers: [],
  unresolvedGaps: [],
  calibration: [],
  derivation: { fidelity: 'standard', models: {}, rounds: 1, callBudget: 100 },
  grounding: {
    anchorSituationId: SIT,
    situationNodes: [{ nodeId: SIT, label: 'Situation' }],
    nodesByCamp: { acc: [{ nodeId: BY_CAMP, label: 'B', camp: 'acc' }] },
  },
  singleRunCaveat: 'test',
} as unknown as InquiryResult);

const knownExcept = (missing: string): ReadonlySet<string> => new Set(ALL.filter(id => id !== missing));

function prunedOk(missing: string): InquiryResult {
  const r = pruneUnknownNodeRefs(fakeResult(), knownExcept(missing));
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  expect(r.droppedRefs).toEqual([missing]);
  expect(collectAllNodeIds(r.result)).not.toContain(missing);
  return r.result;
}

describe('Desktop Ask: collectAllNodeIds (t/4744 B3)', () => {
  it('finds the nodeId at every schema site', () => {
    expect(collectAllNodeIds(fakeResult()).sort()).toEqual([...ALL].sort());
  });

  it('survives nesting far deeper than a recursive walk could (client-supplied payload)', () => {
    let deep: unknown = { nodeId: 'deep-1' };
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(collectAllNodeIds(deep)).toEqual(['deep-1']);
  });
});

describe('Desktop Ask: pruneUnknownNodeRefs removes the ref at each site (t/4744 B2)', () => {
  it('grounding.situationNodes', () => {
    expect(prunedOk(SIT).grounding.situationNodes).toEqual([]);
  });

  it('grounding.nodesByCamp', () => {
    expect(prunedOk(BY_CAMP).grounding.nodesByCamp.acc).toEqual([]);
  });

  it('campVerdicts[].nodes, keeping the verdict text', () => {
    const v = prunedOk(VERDICT).campVerdicts[0];
    expect(v.nodes).toEqual([]);
    expect(v.verdict).toBe('acc verdict');
  });

  it('convergences[].nodes, keeping the convergence claim', () => {
    const c = prunedOk(CONV).convergences;
    expect(c).toHaveLength(1);
    expect(c[0].nodes).toEqual([]);
  });

  it('a nodeId site the schema does not have yet (generic, so new sites cannot be missed)', () => {
    const withNewSite = { ...fakeResult(), evidenceLayers: [{ nodes: [{ nodeId: 'new-site-9' }] }] } as unknown as InquiryResult;
    const r = pruneUnknownNodeRefs(withNewSite, new Set(ALL));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.droppedRefs).toEqual(['new-site-9']);
      expect(collectAllNodeIds(r.result)).not.toContain('new-site-9');
    }
  });
});

describe('Desktop Ask: pruneUnknownNodeRefs outcomes', () => {
  it('keeps every ref and drops nothing when all are known', () => {
    const r = pruneUnknownNodeRefs(fakeResult(), new Set(ALL));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.droppedRefs).toEqual([]);
      expect(collectAllNodeIds(r.result).sort()).toEqual([...ALL].sort());
    }
  });

  it('does not mutate the input', () => {
    const input = fakeResult();
    pruneUnknownNodeRefs(input, knownExcept(SIT));
    expect(input.grounding.situationNodes).toHaveLength(1);
  });

  it('returns all_refs_unknown (not a throw) when no ref is known', () => {
    const r = pruneUnknownNodeRefs(fakeResult(), new Set());
    expect(r).toEqual({ ok: false, reason: 'all_refs_unknown', droppedRefs: expect.arrayContaining(ALL) });
  });

  it('fails closed with unprunable_ref when an unknown ref is not an array element', () => {
    const odd = { ...fakeResult(), extra: { nodeId: 'lonely-1' } } as unknown as InquiryResult;
    const r = pruneUnknownNodeRefs(odd, new Set(ALL));
    expect(r).toEqual({ ok: false, reason: 'unprunable_ref', droppedRefs: ['lonely-1'] });
  });
});
