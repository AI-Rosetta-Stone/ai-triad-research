// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4214 R-2 and R-3 (spec t/4211 §3, §4): the tag stamp and the apply-time tag gate, against the real tag
// registry and the real bundled souls. Only the judge (the model call) is mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRecord } = vi.hoisted(() => ({ mockRecord: vi.fn() }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: mockRecord }) }));

const { annotateTagChecks, evaluateTagGate, checkedTextHash, tagsFingerprint, TENSION_NEEDS_CONFIRMATION, CUSTODIAN_CHECK_MODEL, CUSTODIAN_CHECK_BACKEND, NO_CHECK_KEY_REASON } = await import('../reflectionTagGate');
import aiModelsRegistry from '../../../../../../../ai-models.json';
import type { ReflectionEdit } from '../../types';

function makeEdit(over: Partial<ReflectionEdit> = {}): ReflectionEdit {
  return {
    edit_type: 'revise', node_id: 'skp-beliefs-001', category: 'Beliefs',
    current_label: 'Old Speed Concern', proposed_label: 'New Speed Concern',
    current_description: 'Capability gains and societal impact occur at different speeds.',
    proposed_description: 'Rapid capability gains outpace societal adaptation mechanisms in deployment.',
    rationale: 'r', confidence: 'high', evidence_entries: ['AN-1'], status: 'pending', ...over,
  };
}

// Real Skeptic-Institutional boundary text: the D-2 parser verifies each citation against the custodian soul (#3300).
const HARD_BOUNDARY = 'The speed of capability gains is not the speed of societal impact';
const SOFT_BOUNDARY = 'Existing frameworks are adequate for a given sector';
// Evidence span: verbatim substring of makeEdit()'s proposedDescription, verifiable by the judge v2 parser.
const CONFLICT_EVIDENCE = 'capability gains outpace societal adaptation';

type JudgeVerdict = { soul: string; verdict: string; cited?: string | null; boundary_checks?: Array<{ boundary: string; asserted: boolean }>; evidence?: string | null };
const judgeSays = (verdicts: JudgeVerdict[]) =>
  vi.fn().mockResolvedValue({ text: JSON.stringify({ verdicts: verdicts.map(v => ({
    cited: null,
    reason: 'because',
    boundary_checks: [{ boundary: HARD_BOUNDARY, asserted: v.verdict === 'conflict' }],
    evidence: v.verdict === 'conflict' ? CONFLICT_EVIDENCE : null,
    ...v,
  })) }) });

async function stamp(edit: ReflectionEdit, opts: { pov?: string; seatTag: string | null; nodeTags: string[] | undefined; generateText?: ReturnType<typeof vi.fn> }) {
  const generateText = opts.generateText ?? vi.fn();
  await annotateTagChecks([edit], { pov: opts.pov ?? 'skeptic', seatTag: opts.seatTag, nodeTags: () => opts.nodeTags, generateText, hasCheckKey: async () => true }, () => true);
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
    expect(s).toMatchObject({ relation: 'shared', custodians: ['skeptic.institutional'], model: CUSTODIAN_CHECK_MODEL });
    expect(generateText).toHaveBeenCalledTimes(1);
    const [prompt, model, , temperature] = generateText.mock.calls[0];
    expect(model).toBe(CUSTODIAN_CHECK_MODEL); // pinned, not the reflection's model (t/4230)
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
    await stamp(edit, { seatTag: 'critical', nodeTags: ['critical', 'institutional'], generateText: judgeSays([{ soul: 'skeptic.institutional', verdict: 'conflict', cited: HARD_BOUNDARY }]) });
    const g = gate(edit, ['critical', 'institutional']);
    expect(g.block).toBe('conflict');
    expect(g.reason).toContain(HARD_BOUNDARY);
  });

  it('a conflict citing text that is not in the custodian soul is unverified, so the edit is unchecked (fails closed)', async () => {
    const edit = makeEdit();
    await stamp(edit, { seatTag: 'critical', nodeTags: ['critical', 'institutional'], generateText: judgeSays([{ soul: 'skeptic.institutional', verdict: 'conflict', cited: 'A boundary the judge made up and that no soul contains' }]) });
    expect(edit.tag_check!.unchecked).toBeTruthy();
    expect(gate(edit, ['critical', 'institutional']).block).toBe('unchecked');
  });

  it('the interim rule is lifted now that the v2 judge passed M1 on the pinned model (t/4230, CL p/785#34)', () => {
    expect(TENSION_NEEDS_CONFIRMATION).toBe(false);
  });

  it('the custodian check is pinned to gemini-3.1-pro-preview, a model the registry knows (t/4230)', () => {
    expect(CUSTODIAN_CHECK_MODEL).toBe('gemini-3.1-pro-preview');
    const entry = (aiModelsRegistry as { models: { id: string; backend: string }[] }).models.find(m => m.id === CUSTODIAN_CHECK_MODEL);
    expect(entry?.backend).toBe('gemini');
  });

  it('interim rule on (CL t/4214#6): tension needs confirmation, showing the verdict and the citation', async () => {
    const edit = makeEdit();
    await stamp(edit, { seatTag: 'critical', nodeTags: ['critical', 'institutional'], generateText: judgeSays([{ soul: 'skeptic.institutional', verdict: 'tension', cited: SOFT_BOUNDARY }]) });
    expect(edit.tag_check!.verdicts![0].verdict).toBe('tension');
    const g = evaluateTagGate(edit, 'skeptic', ['critical', 'institutional'], edit.proposed_label, edit.proposed_description, true);
    expect(g.block).toBe('tension');
    expect(g.reason).toContain(SOFT_BOUNDARY);
    expect(g.reason).toMatch(/In tension with skeptic\.institutional/);
  });

  it('interim rule on: a tension whose citation failed verification says so instead of quoting "null"', async () => {
    const edit = makeEdit();
    await stamp(edit, { seatTag: 'critical', nodeTags: ['critical', 'institutional'], generateText: judgeSays([{ soul: 'skeptic.institutional', verdict: 'tension', cited: 'Text that no soul contains anywhere at all' }]) });
    expect(edit.tag_check!.verdicts![0]).toMatchObject({ verdict: 'tension', cited: null });
    const g = evaluateTagGate(edit, 'skeptic', ['critical', 'institutional'], edit.proposed_label, edit.proposed_description, true);
    expect(g.block).toBe('tension');
    expect(g.reason).not.toContain('null');
    expect(g.reason).toContain('(no verified citation)');
  });

  it('once the interim rule is lifted (the constant set to false), tension is shown but does not block', async () => {
    const edit = makeEdit();
    await stamp(edit, { seatTag: 'critical', nodeTags: ['critical', 'institutional'], generateText: judgeSays([{ soul: 'skeptic.institutional', verdict: 'tension', cited: SOFT_BOUNDARY }]) });
    expect(evaluateTagGate(edit, 'skeptic', ['critical', 'institutional'], edit.proposed_label, edit.proposed_description, false).block).toBeNull();
  });

  it('all consistent verdicts still apply without confirmation', async () => {
    const edit = makeEdit();
    await stamp(edit, { seatTag: 'critical', nodeTags: ['critical', 'institutional'], generateText: judgeSays([{ soul: 'skeptic.institutional', verdict: 'consistent' }]) });
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

describe('no API key for the pinned judge (t/4230, CL p/785#38)', () => {
  const sharedEdits = () => [makeEdit(), makeEdit({ node_id: 'skp-beliefs-002' })];
  const run = (edits: ReflectionEdit[], hasCheckKey: () => Promise<boolean>, generateText = vi.fn(), pov = 'skeptic') =>
    annotateTagChecks(edits, { pov, seatTag: 'critical', nodeTags: () => ['critical', 'institutional'], generateText, hasCheckKey }, () => true);

  it('the backend comes from the registry', () => {
    expect(CUSTODIAN_CHECK_BACKEND).toBe('gemini');
  });

  it('skips every call, stamps each edit unchecked with the actionable reason, and records ONE WARN with the count', async () => {
    const edits = sharedEdits();
    const generateText = vi.fn();
    const hasCheckKey = vi.fn().mockResolvedValue(false);
    await run(edits, hasCheckKey, generateText);
    expect(generateText).not.toHaveBeenCalled();
    expect(hasCheckKey).toHaveBeenCalledTimes(1); // asked once per run
    for (const e of edits) expect(e.tag_check!.unchecked).toBe(NO_CHECK_KEY_REASON);
    expect(NO_CHECK_KEY_REASON).toMatch(/needs a Gemini API key/);
    const warns = mockRecord.mock.calls.map(c => c[0]).filter(r => r.component === 'reflection-tag-check' && r.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ data: { backend: 'gemini', unchecked_count: 2 } });
    expect(gate(edits[0], ['critical', 'institutional']).block).toBe('unchecked'); // fails closed
  });

  it('with a key the calls run, and the key is asked only once for the run', async () => {
    const edits = sharedEdits();
    const hasCheckKey = vi.fn().mockResolvedValue(true);
    const generateText = judgeSays([{ soul: 'skeptic.institutional', verdict: 'consistent' }]);
    await run(edits, hasCheckKey, generateText);
    expect(hasCheckKey).toHaveBeenCalledTimes(1);
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('a POV with no tags never asks for the key', async () => {
    const hasCheckKey = vi.fn();
    await run([makeEdit({ node_id: 'acc-beliefs-001' })], hasCheckKey, vi.fn(), 'accelerationist');
    expect(hasCheckKey).not.toHaveBeenCalled();
  });

  it('a key lookup that throws is logged and the calls are tried anyway', async () => {
    const generateText = judgeSays([{ soul: 'skeptic.institutional', verdict: 'consistent' }]);
    const hasCheckKey = () => { throw new Error('bridge down'); };
    const edits = sharedEdits();
    await run(edits, hasCheckKey as never, generateText);
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', message: expect.stringMatching(/API-key lookup failed/) }));
  });
});
