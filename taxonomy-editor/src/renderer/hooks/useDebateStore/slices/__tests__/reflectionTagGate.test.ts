// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4214 R-2 and R-3 (spec t/4211 §3, §4): the tag stamp and the apply-time tag gate, against the real tag
// registry and the real bundled souls. Only the judge (the model call) is mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRecord } = vi.hoisted(() => ({ mockRecord: vi.fn() }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: mockRecord }) }));

const { annotateTagChecks, evaluateTagGate, checkedTextHash, tagsFingerprint } = await import('../reflectionTagGate');
import type { ReflectionEdit } from '../../types';

function makeEdit(over: Partial<ReflectionEdit> = {}): ReflectionEdit {
  return {
    edit_type: 'revise', node_id: 'skp-beliefs-001', category: 'Beliefs',
    current_label: 'Old', proposed_label: 'New', current_description: 'old d', proposed_description: 'new d',
    rationale: 'r', confidence: 'high', evidence_entries: ['AN-1'], status: 'pending', ...over,
  };
}

const judgeSays = (verdicts: { soul: string; verdict: string; cited?: string | null }[]) =>
  vi.fn().mockResolvedValue({ text: JSON.stringify({ verdicts: verdicts.map(v => ({ cited: null, reason: 'because', ...v })) }) });

async function stamp(edit: ReflectionEdit, opts: { pov?: string; seatTag: string | null; nodeTags: string[] | undefined; generateText?: ReturnType<typeof vi.fn> }) {
  const generateText = opts.generateText ?? vi.fn();
  await annotateTagChecks([edit], { pov: opts.pov ?? 'skeptic', seatTag: opts.seatTag, model: 'm', nodeTags: () => opts.nodeTags, generateText }, () => true);
  return { stamp: edit.tag_check!, generateText };
}

const gate = (edit: ReflectionEdit, liveTags: string[] | undefined, pov = 'skeptic', label = edit.proposed_label, desc = edit.proposed_description) =>
  evaluateTagGate(edit, pov, liveTags, label, desc);

beforeEach(() => { mockRecord.mockClear(); });

describe('R-2 annotateTagChecks: the stamp', () => {
  it('own: no judge call, and the edit applies', async () => {
    const edit = makeEdit();
    const { stamp: s, generateText } = await stamp(edit, { seatTag: 'critical', nodeTags: ['critical'] });
    expect(s).toMatchObject({ relation: 'own', custodians: [], tags_fp: 'critical' });
    expect(generateText).not.toHaveBeenCalled();
    expect(gate(edit, ['critical']).block).toBeNull();
  });

  it('a POV with no tags (Accelerationist) is no_tags: no judge call, never gated', async () => {
    const edit = makeEdit({ node_id: 'acc-beliefs-001' });
    const { stamp: s, generateText } = await stamp(edit, { pov: 'accelerationist', seatTag: null, nodeTags: undefined });
    expect(s.relation).toBe('no_tags');
    expect(generateText).not.toHaveBeenCalled();
    expect(gate(makeEdit({ node_id: 'acc-beliefs-001' }), undefined, 'accelerationist').block).toBeNull();
  });

  it('shared: one judge call at temperature 0 against the other wing, with the real soul content', async () => {
    const generateText = judgeSays([{ soul: 'skeptic.institutional', verdict: 'consistent' }]);
    const { stamp: s } = await stamp(makeEdit(), { seatTag: 'critical', nodeTags: ['critical', 'institutional'], generateText });
    expect(s).toMatchObject({ relation: 'shared', custodians: ['skeptic.institutional'], model: 'm' });
    expect(generateText).toHaveBeenCalledTimes(1);
    const [prompt, model, , temperature] = generateText.mock.calls[0];
    expect(model).toBe('m');
    expect(temperature).toBe(0);
    expect(prompt).toContain('Deployment evidence over capability evidence'); // Institutional's first value
  });

  it('the judge throwing gives unchecked and a WARN, never a pass', async () => {
    const generateText = vi.fn().mockRejectedValue(new Error('429 rate limited'));
    const edit = makeEdit();
    const { stamp: s } = await stamp(edit, { seatTag: 'critical', nodeTags: ['critical', 'institutional'], generateText });
    expect(s.unchecked).toMatch(/429/);
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', component: 'reflection-tag-check' }));
    expect(gate(edit, ['critical', 'institutional']).block).toBe('unchecked');
  });

  it('an unusable judge answer (missing verdict) gives unchecked and a WARN', async () => {
    const generateText = vi.fn().mockResolvedValue({ text: JSON.stringify({ verdicts: [] }) });
    const edit = makeEdit();
    const { stamp: s } = await stamp(edit, { seatTag: 'critical', nodeTags: ['critical', 'institutional'], generateText });
    expect(s.unchecked).toBeTruthy();
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }));
  });

  it('edit types the gate does not check (add) are not stamped', async () => {
    const edit = makeEdit({ edit_type: 'add', node_id: null });
    await stamp(edit, { seatTag: 'critical', nodeTags: undefined });
    expect(edit.tag_check).toBeUndefined();
  });
});

describe('R-3 evaluateTagGate: each relation and verdict', () => {
  it('foreign is refused, naming the owning wing', async () => {
    const edit = makeEdit();
    await stamp(edit, { seatTag: 'critical', nodeTags: ['institutional'] });
    const g = gate(edit, ['institutional']);
    expect(g.block).toBe('foreign');
    expect(g.reason).toMatch(/belongs to institutional, not critical/);
  });

  it('a conflict verdict is refused and quotes the cited boundary', async () => {
    const edit = makeEdit();
    await stamp(edit, { seatTag: 'critical', nodeTags: ['critical', 'institutional'], generateText: judgeSays([{ soul: 'skeptic.institutional', verdict: 'conflict', cited: 'Resilience over prevention' }]) });
    const g = gate(edit, ['critical', 'institutional']);
    expect(g.block).toBe('conflict');
    expect(g.reason).toContain('Resilience over prevention');
  });

  it('tension is shown in the stamp but does not block', async () => {
    const edit = makeEdit();
    await stamp(edit, { seatTag: 'critical', nodeTags: ['critical', 'institutional'], generateText: judgeSays([{ soul: 'skeptic.institutional', verdict: 'tension', cited: 'x' }]) });
    expect(edit.tag_check!.verdicts![0].verdict).toBe('tension');
    expect(gate(edit, ['critical', 'institutional']).block).toBeNull();
  });

  it('deprecate on shared ground from a tagged seat is always a conflict, with the remove-the-tag note, and no judge call', async () => {
    const edit = makeEdit({ edit_type: 'deprecate' });
    const { generateText } = await stamp(edit, { seatTag: 'critical', nodeTags: ['critical', 'institutional'] });
    expect(generateText).not.toHaveBeenCalled();
    const g = gate(edit, ['critical', 'institutional']);
    expect(g.block).toBe('conflict');
    expect(g.reason).toMatch(/remove the critical tag instead/);
  });

  it('untagged seat on a tagged node checks against that node\'s wing (umbrella_on_tagged)', async () => {
    const edit = makeEdit();
    const { stamp: s } = await stamp(edit, { seatTag: null, nodeTags: ['critical'], generateText: judgeSays([{ soul: 'skeptic.critical', verdict: 'consistent' }]) });
    expect(s).toMatchObject({ relation: 'umbrella_on_tagged', custodians: ['skeptic.critical'] });
    expect(gate(edit, ['critical']).block).toBeNull();
  });

  it('stale after the node\'s tags change', async () => {
    const edit = makeEdit();
    await stamp(edit, { seatTag: 'critical', nodeTags: ['critical'] });
    expect(gate(edit, ['critical', 'institutional']).block).toBe('stale');
  });

  it('stale after the reviewer overrides the label or description', async () => {
    const edit = makeEdit();
    await stamp(edit, { seatTag: 'critical', nodeTags: ['critical'] });
    expect(gate(edit, ['critical'], 'skeptic', 'A different label').block).toBe('stale');
    expect(gate(edit, ['critical'], 'skeptic', edit.proposed_label, 'a different description').block).toBe('stale');
    expect(gate(edit, ['critical']).block).toBeNull();
  });

  it('an edit with no stamp on a tagged POV fails closed as unchecked', () => {
    expect(gate(makeEdit(), ['critical']).block).toBe('unchecked');
  });

  it('the stamp helpers are order-insensitive and text-sensitive', () => {
    expect(tagsFingerprint(['institutional', 'critical'])).toBe(tagsFingerprint(['critical', 'institutional']));
    expect(checkedTextHash('a', 'b')).not.toBe(checkedTextHash('a', 'c'));
  });
});
