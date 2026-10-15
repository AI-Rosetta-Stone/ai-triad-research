// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4214 R-5: each reflection decision (applied, dismissed, overridden) is saved into the debate file's
// reflection snapshot, so CL's M2 can measure the override rate (spec t/4211 §6). Before this, the snapshot
// was written once at request time and every stored edit read `pending`.
// t/4214 R-4: a new node from a tagged seat carries the seat's tag; an untagged seat on a tagged POV leaves it
// untagged with a coverage-gap WARN (spec t/4211 §3.1); Accelerationist and Safetyist are unchanged.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mockApi, mockTaxonomyState, makeSession } from './storeTestHarness';
import { useDebateStore } from '../../useDebateStore';
import type { ReflectionResult } from '../types';

// The shared harness leaves the recorder unmocked (getGlobalRecorder() is null), so the WARNs this file
// asserts on are captured here, as debateSlices.test.ts does.
const { mockRecord } = vi.hoisted(() => ({ mockRecord: vi.fn() }));
vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: mockRecord, setEventContext: vi.fn() }),
}));

const povNode = (id: string) => ({ id, category: 'Beliefs', label: `L ${id}`, description: `D ${id}` });

function seedAccDebate() {
  mockTaxonomyState.accelerationist = { nodes: [povNode('acc-beliefs-003'), povNode('acc-beliefs-010')] } as never;
  useDebateStore.setState({
    activeDebate: makeSession({
      phase: 'debate',
      active_povers: ['accelerationist'],
      transcript: [{
        id: 'e1', timestamp: 't', type: 'statement', speaker: 'accelerationist', content: 'X',
        taxonomy_refs: [{ node_id: 'acc-beliefs-010' }],
        metadata: { injection_manifest: { povNodeIds: ['acc-beliefs-010'] } },
      }],
      argument_network: {
        nodes: [{ id: 'AN-1', text: 'claim', speaker: 'accelerationist', source_entry_id: 'e1', taxonomy_refs: ['acc-beliefs-010'], turn_number: 1, computed_strength: 0.6 }],
        edges: [],
      },
    }) as never,
  });
}

function respondWithEdits(...edits: Record<string, unknown>[]) {
  mockApi.generateText.mockResolvedValue({
    text: JSON.stringify({
      reflection_summary: 's',
      edits: edits.map(e => ({ disposition: 'edit_existing', category: 'Beliefs', current_label: 'Old', proposed_label: 'New', current_description: 'd', proposed_description: 'nd', rationale: 'r', confidence: 'high', ...e })),
    }),
  });
}

/** The edits as saved in the debate file: the reflection transcript entry's snapshot. */
function savedSnapshot(pover = 'accelerationist'): ReflectionResult | undefined {
  const entry = useDebateStore.getState().activeDebate!.transcript.filter(e => e.type === 'reflection').at(-1);
  return (entry?.metadata as { reflection_results?: ReflectionResult[] } | undefined)?.reflection_results?.find(r => r.pover === pover);
}

const records = () => mockRecord.mock.calls.map(c => c[0] as { message: string; level: string; data?: Record<string, unknown> });

afterEach(() => {
  mockTaxonomyState.accelerationist = { nodes: [] } as never;
  mockTaxonomyState.skeptic = { nodes: [] } as never;
  mockTaxonomyState.createPovNode.mockReturnValue('new-node-id');
});

describe('saving reflection decisions into the debate file (t/4214 R-5)', () => {
  it('starts pending in the snapshot, and an apply saves `applied` and calls saveDebate', async () => {
    seedAccDebate();
    respondWithEdits({ edit_type: 'revise', node_id: 'acc-beliefs-010', evidence_entries: ['AN-1'] });
    await useDebateStore.getState().requestReflections();
    expect(savedSnapshot()!.edits[0].status).toBe('pending');
    mockApi.saveDebateSession.mockClear();

    const result = await useDebateStore.getState().applyReflectionEdit('accelerationist', 0);

    expect(result.ok).toBe(true);
    expect(savedSnapshot()!.edits[0]).toMatchObject({ status: 'approved', decision: { outcome: 'applied' } });
    expect(savedSnapshot()!.edits[0].decision!.overrides).toBeUndefined();
    expect(mockApi.saveDebateSession).toHaveBeenCalled();
  });

  it('an evidence-gate override is saved as `overridden` with overrides ["evidence"]', async () => {
    seedAccDebate();
    respondWithEdits({ edit_type: 'revise', node_id: 'acc-beliefs-003', evidence_entries: ['prose, not a claim id'] });
    await useDebateStore.getState().requestReflections();

    const refused = await useDebateStore.getState().applyReflectionEdit('accelerationist', 0);
    expect(refused.ok).toBe(false);
    expect(savedSnapshot()!.edits[0].decision).toBeUndefined();

    await useDebateStore.getState().applyReflectionEdit('accelerationist', 0, undefined, { allowUnsupportedEvidence: true });
    expect(savedSnapshot()!.edits[0].decision).toMatchObject({ outcome: 'overridden', overrides: ['evidence'] });
  });

  it('a dismissal is saved as `dismissed`, and decisions on other edits are untouched', async () => {
    seedAccDebate();
    respondWithEdits(
      { edit_type: 'revise', node_id: 'acc-beliefs-010', evidence_entries: ['AN-1'] },
      { edit_type: 'qualify', node_id: 'acc-beliefs-010', evidence_entries: ['AN-1'] },
    );
    await useDebateStore.getState().requestReflections();

    useDebateStore.getState().dismissReflectionEdit('accelerationist', 1);
    await vi.waitFor(() => expect(savedSnapshot()!.edits[1].decision?.outcome).toBe('dismissed'));
    expect(savedSnapshot()!.edits[1].status).toBe('dismissed');
    expect(savedSnapshot()!.edits[0].decision).toBeUndefined();
    expect(savedSnapshot()!.edits[0].status).toBe('pending');
  });

  it('a debate with no reflection snapshot logs a WARN and keeps the in-memory decision', async () => {
    seedAccDebate();
    useDebateStore.setState({
      reflections: [{ pover: 'accelerationist', label: 'A', reflection_summary: 's', edits: [{ edit_type: 'revise', node_id: 'acc-beliefs-010', category: 'Beliefs', current_label: 'Old', proposed_label: 'New', current_description: 'd', proposed_description: 'nd', rationale: 'r', confidence: 'high', evidence_entries: ['AN-1'], status: 'pending' }] }],
    });
    useDebateStore.getState().dismissReflectionEdit('accelerationist', 0);
    await vi.waitFor(() => expect(records().some(r => r.message.startsWith('reflection decision not saved'))).toBe(true));
    expect(useDebateStore.getState().reflections[0].edits[0].status).toBe('dismissed');
  });
});

describe('tagging new nodes from reflection proposals (t/4214 R-4)', () => {
  const proposal = (pov: 'accelerationist' | 'skeptic', target: string) => ({
    kind: 'propose_new' as const, source: 'reflection_new_item' as const, node_id: '', reason: 'r', debate_id: 'debate-1',
    requires_human_review: true, pov, category: 'Beliefs' as const, label: 'New Belief', description: 'A new belief', rationale: 'why',
    proposed_edges: [{ target_node_id: target, edge_type: 'SUPPORTS' as const, new_node_role: 'source' as const, rationale: 'e', confidence: 0.8 }],
  });

  function seedProposal(pov: 'accelerationist' | 'skeptic', seatTag?: string) {
    const target = pov === 'skeptic' ? 'skp-beliefs-001' : 'acc-beliefs-001';
    mockTaxonomyState[pov] = { nodes: [povNode(target)] } as never;
    mockTaxonomyState.saveError = null;
    useDebateStore.setState({
      activeDebateId: 'debate-1',
      activeDebate: makeSession({ active_povers: [pov], ...(seatTag ? { seat_tags: { [pov]: { pov_tag: seatTag, tag_mode: 'scope' } } } : {}) }) as never,
      reflections: [{ pover: pov, label: pov, reflection_summary: 's', edits: [], new_item_proposals: [proposal(pov, target)] }] as never,
      newItemProposalStatus: {},
    });
  }

  const writtenNode = () => mockTaxonomyState.updatePovNode.mock.calls.at(-1)![2] as Record<string, unknown>;

  beforeEach(() => { mockTaxonomyState.updatePovNode.mockClear(); });

  it('a tagged Skeptic seat tags the new node with its own tag', async () => {
    mockTaxonomyState.createPovNode.mockReturnValue('skp-beliefs-999');
    seedProposal('skeptic', 'institutional');
    const result = await useDebateStore.getState().applyReflectionProposal('skeptic', 0);
    expect(result.ok).toBe(true);
    expect(writtenNode().pov_tags).toEqual(['institutional']);
  });

  it('an untagged Skeptic seat leaves the node untagged and logs a coverage-gap WARN naming it', async () => {
    mockTaxonomyState.createPovNode.mockReturnValue('skp-beliefs-998');
    seedProposal('skeptic');
    await useDebateStore.getState().applyReflectionProposal('skeptic', 0);
    expect(writtenNode()).not.toHaveProperty('pov_tags');
    const warn = records().find(r => r.message.startsWith('reflection.new_node_untagged'));
    expect(warn).toMatchObject({ level: 'warn', data: { node_id: 'skp-beliefs-998', pov: 'skeptic' } });
  });

  it('a seat tag that fails validatePovTags is not written, and is logged', async () => {
    mockTaxonomyState.createPovNode.mockReturnValue('skp-beliefs-997');
    seedProposal('skeptic', 'not-a-registered-tag');
    await useDebateStore.getState().applyReflectionProposal('skeptic', 0);
    expect(writtenNode()).not.toHaveProperty('pov_tags');
    expect(records().some(r => r.message.startsWith('reflection.new_node_tag_invalid'))).toBe(true);
  });

  it('Accelerationist (no tags in the registry) is unchanged: no pov_tags, no WARN', async () => {
    mockTaxonomyState.createPovNode.mockReturnValue('acc-beliefs-999');
    seedProposal('accelerationist');
    await useDebateStore.getState().applyReflectionProposal('accelerationist', 0);
    expect(writtenNode()).not.toHaveProperty('pov_tags');
    expect(records().some(r => r.message.startsWith('reflection.new_node_untagged'))).toBe(false);
  });
});
