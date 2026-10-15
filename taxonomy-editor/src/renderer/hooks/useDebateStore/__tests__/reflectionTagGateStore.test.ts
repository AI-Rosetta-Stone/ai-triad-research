// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4214 R-2 and R-3 end to end through the store: a Critical-wing Skeptic seat's edit to an Institutional-only node
// is stamped `foreign` during requestReflections. With TAG_GATE_ENFORCED on (the default since R-6), it is refused
// by applyReflectionEdit and applied only with `allowCrossTag`, saved as a `cross_tag` override. Off, it applies with
// a would-block WARN and a note (CL p/785#5).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockApi, mockTaxonomyState, makeSession } from './storeTestHarness';
import { useDebateStore } from '../../useDebateStore';
import type { ReflectionResult } from '../types';

const { mockRecord, gateFlags } = vi.hoisted(() => ({ mockRecord: vi.fn(), gateFlags: { enforced: true } }));
vi.mock('../slices/reflectionTagGate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slices/reflectionTagGate')>();
  return { ...actual, get TAG_GATE_ENFORCED() { return gateFlags.enforced; } };
});
vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: mockRecord, setEventContext: vi.fn() }),
}));

function seedSkepticDebate(nodeTags: string[]) {
  mockTaxonomyState.skeptic = {
    nodes: [{ id: 'skp-beliefs-010', category: 'Beliefs', label: 'L', description: 'D', pov_tags: nodeTags }],
  } as never;
  useDebateStore.setState({
    activeDebate: makeSession({
      phase: 'debate',
      active_povers: ['skeptic'],
      seat_tags: { skeptic: { pov_tag: 'critical', tag_mode: 'scope' } },
      transcript: [{
        id: 'e1', timestamp: 't', type: 'statement', speaker: 'skeptic', content: 'X',
        taxonomy_refs: [{ node_id: 'skp-beliefs-010' }],
        metadata: { injection_manifest: { povNodeIds: ['skp-beliefs-010'] } },
      }],
      argument_network: {
        nodes: [{ id: 'AN-1', text: 'claim', speaker: 'skeptic', source_entry_id: 'e1', taxonomy_refs: ['skp-beliefs-010'], turn_number: 1, computed_strength: 0.6 }],
        edges: [],
      },
    }) as never,
  });
  mockApi.generateText.mockResolvedValue({
    text: JSON.stringify({ reflection_summary: 's', edits: [{ disposition: 'edit_existing', edit_type: 'revise', node_id: 'skp-beliefs-010', category: 'Beliefs', current_label: 'L', proposed_label: 'New', current_description: 'D', proposed_description: 'New description', rationale: 'r', confidence: 'high', evidence_entries: ['AN-1'] }] }),
  });
}

const savedEdit = () => {
  const entry = useDebateStore.getState().activeDebate!.transcript.filter(e => e.type === 'reflection').at(-1);
  return (entry?.metadata as { reflection_results: ReflectionResult[] }).reflection_results[0].edits[0];
};

afterEach(() => { mockTaxonomyState.skeptic = { nodes: [] } as never; gateFlags.enforced = true; });

describe('tag gate through the store (t/4214 R-2, R-3)', () => {
  it('the gate is enforced now that R-6 ships the confirm control (CL p/785#8)', async () => {
    const { TAG_GATE_ENFORCED } = await vi.importActual<typeof import('../slices/reflectionTagGate')>('../slices/reflectionTagGate');
    expect(TAG_GATE_ENFORCED).toBe(true);
  });

  it('unenforced: a foreign edit applies, with a would-block WARN and the reason as a note', async () => {
    gateFlags.enforced = false;
    seedSkepticDebate(['institutional']);
    await useDebateStore.getState().requestReflections();
    const applied = await useDebateStore.getState().applyReflectionEdit('skeptic', 0);
    expect(applied.ok).toBe(true);
    expect(applied.note).toMatch(/belongs to institutional, not critical/);
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ message: 'applyReflectionEdit.cross_tag_would_block', level: 'warn' }));
    expect(mockRecord).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'applyReflectionEdit.refused_cross_tag' }));
    expect(savedEdit().decision).toMatchObject({ outcome: 'applied' });
  });

  it('unenforced: an edit with no stamp (saved before #3307) applies', async () => {
    gateFlags.enforced = false;
    seedSkepticDebate(['critical']);
    await useDebateStore.getState().requestReflections();
    delete useDebateStore.getState().reflections[0].edits[0].tag_check;
    const applied = await useDebateStore.getState().applyReflectionEdit('skeptic', 0);
    expect(applied.ok).toBe(true);
    expect(applied.note).toMatch(/no tag check/);
  });

  it('enforced: a foreign edit is stamped, refused, then applied only under allowCrossTag, saved as a cross_tag override', async () => {
    gateFlags.enforced = true;
    seedSkepticDebate(['institutional']);
    await useDebateStore.getState().requestReflections();

    const edit = useDebateStore.getState().reflections[0].edits[0];
    expect(edit.tag_check).toMatchObject({ relation: 'foreign', seat_tag: 'critical', target_tags: ['institutional'] });
    expect(savedEdit().tag_check?.relation).toBe('foreign'); // the stamp is in the saved snapshot too

    const refused = await useDebateStore.getState().applyReflectionEdit('skeptic', 0);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/belongs to institutional, not critical/);
    expect(refused.refusedBy).toBe('cross_tag'); // the panel arms the cross-wing override from this (R-6)
    expect(mockTaxonomyState.updatePovNode).not.toHaveBeenCalled();
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ message: 'applyReflectionEdit.refused_cross_tag' }));

    const applied = await useDebateStore.getState().applyReflectionEdit('skeptic', 0, undefined, { allowCrossTag: true });
    expect(applied.ok).toBe(true);
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ message: 'applyReflectionEdit.cross_tag_overridden', level: 'warn' }));
    expect(savedEdit().decision).toMatchObject({ outcome: 'overridden', overrides: ['cross_tag'] });
  });

  it('an edit to the seat\'s own node applies without any override', async () => {
    seedSkepticDebate(['critical']);
    await useDebateStore.getState().requestReflections();
    expect(useDebateStore.getState().reflections[0].edits[0].tag_check?.relation).toBe('own');
    const applied = await useDebateStore.getState().applyReflectionEdit('skeptic', 0);
    expect(applied.ok).toBe(true);
    expect(savedEdit().decision).toMatchObject({ outcome: 'applied' });
  });
});
