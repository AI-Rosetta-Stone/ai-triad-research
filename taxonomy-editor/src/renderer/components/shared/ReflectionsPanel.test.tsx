// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReflectionsPanel } from './ReflectionsPanel';

// ── Mocks ────────────────────────────────────────────────────

vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: vi.fn() }),
}));

const generatePlainPreview = vi.fn();
vi.mock('../../utils/regeneratePlainDescription', () => ({
  generatePlainPreview: (...args: unknown[]) => generatePlainPreview(...args),
}));

const debateStore: Record<string, any> = {
  reflections: [],
  newItemProposalStatus: {},
  debateGenerating: null,
  activeDebate: null,
  enrichmentStatus: {},
  requestReflections: vi.fn(),
  applyReflectionEdit: vi.fn(),
  retryReflectionEditAfterFix: vi.fn(),
  dismissReflectionEdit: vi.fn(),
  applyReflectionProposal: vi.fn(),
  dismissReflectionProposal: vi.fn(),
  retryEnrichment: vi.fn(),
  clearEnrichmentStatus: vi.fn(),
};

vi.mock('../../hooks/useDebateStore', () => ({
  useDebateStore: (selector: any) => selector(debateStore),
}));

const taxStore: Record<string, any> = { navigateToNode: vi.fn() };
vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: (selector: any) => selector(taxStore),
}));

vi.mock('zustand/react/shallow', () => ({ useShallow: (fn: any) => fn }));

vi.mock('../../types/debate', () => ({
  POVER_INFO: {
    accelerationist: { label: 'Accelerationist', color: 'var(--color-acc)' },
    safetyist: { label: 'Safetyist', color: 'var(--color-saf)' },
    skeptic: { label: 'Skeptic', color: 'var(--color-skp)' },
  },
}));

const LONG_FORMAL = 'A sufficiently long formal DOLCE description that exceeds the minimum length.';

function addReflection() {
  debateStore.reflections = [{
    pover: 'accelerationist',
    label: 'Accelerationist',
    reflection_summary: '',
    edits: [{
      edit_type: 'add',
      status: 'pending',
      category: 'Beliefs',
      node_id: '',
      proposed_label: 'New belief',
      proposed_description: LONG_FORMAL,
      rationale: 'because evidence supports it',
      evidence_entries: [],
    }],
  }];
}

beforeEach(() => {
  localStorage.clear(); // description mode defaults to 'plain'
  addReflection();
});

afterEach(() => { vi.clearAllMocks(); });

describe('ReflectionsPanel — plain description for new (add) proposals', () => {
  it('generates the plain preview on render when default mode is plain (AC1/AC2)', async () => {
    generatePlainPreview.mockResolvedValue('Plain-language version of the belief.');
    render(<ReflectionsPanel onClose={vi.fn()} />);

    await waitFor(() => expect(generatePlainPreview).toHaveBeenCalledWith(LONG_FORMAL));
    expect(await screen.findByText('Plain-language version of the belief.')).toBeInTheDocument();
  });

  it('surfaces a Retry affordance when generation fails instead of silently showing formal (AC3)', async () => {
    generatePlainPreview.mockResolvedValue(null); // AI/vernacular-model failure
    render(<ReflectionsPanel onClose={vi.fn()} />);

    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(retry).toBeInTheDocument();
    expect(screen.getByText(/Couldn't generate a plain description/)).toBeInTheDocument();

    // Retry re-arms generation; a subsequent success replaces the error.
    generatePlainPreview.mockResolvedValue('Recovered plain text.');
    fireEvent.click(retry);
    expect(await screen.findByText('Recovered plain text.')).toBeInTheDocument();
  });
});

// ── Revise cards: current-description box visibility (t/3402) ─
// Regression: EditCardCurrentDesc's visibility guard used to require
// current_description !== proposed_description, hiding the CURRENT box
// entirely on a label-only revise (where the descriptions genuinely match) —
// the user saw the proposed description with zero context on the original.

function addReviseReflection(descriptionChanged: boolean) {
  debateStore.reflections = [{
    pover: 'accelerationist',
    label: 'Accelerationist',
    reflection_summary: '',
    edits: [{
      edit_type: 'revise',
      status: 'pending',
      category: 'Beliefs',
      node_id: 'acc-beliefs-001',
      proposed_label: 'Revised label',
      current_description: 'The original current description.',
      proposed_description: descriptionChanged ? 'A meaningfully different proposed description.' : 'The original current description.',
      rationale: 'because the label was imprecise',
      evidence_entries: [],
    }],
  }];
}

describe('ReflectionsPanel — Revise card current-description visibility (t/3402)', () => {
  it('shows the CURRENT description box on a label-only revise (descriptions match)', () => {
    addReviseReflection(false);
    render(<ReflectionsPanel onClose={vi.fn()} />);
    expect(screen.getByText('CURRENT')).toBeInTheDocument();
    // The current description text renders even though it equals the proposed text.
    expect(screen.getAllByText('The original current description.').length).toBeGreaterThan(0);
  });

  it('still shows the CURRENT description box when the description genuinely changed (regression guard)', () => {
    addReviseReflection(true);
    render(<ReflectionsPanel onClose={vi.fn()} />);
    expect(screen.getByText('CURRENT')).toBeInTheDocument();
    expect(screen.getByText('The original current description.')).toBeInTheDocument();
  });
});

// ── Plain PROPOSED view for revise/qualify (t/3873) ────────────
// Previously only 'add' proposals generated a plain preview; a revise/qualify
// diff in plain mode just showed the raw formal proposed text.

describe('ReflectionsPanel — plain PROPOSED view for revise/qualify edits (t/3873)', () => {
  const PROPOSED = 'A meaningfully different proposed description.';

  it('generates and shows the plain preview for a revise diff in plain mode, with a toggle beside PROPOSED', async () => {
    generatePlainPreview.mockResolvedValue('Plain version of the revision.');
    addReviseReflection(true);
    render(<ReflectionsPanel onClose={vi.fn()} />);

    await waitFor(() => expect(generatePlainPreview).toHaveBeenCalledWith(PROPOSED));
    expect(await screen.findByText('Plain version of the revision.')).toBeInTheDocument();
    // One toggle on the CURRENT box, one beside PROPOSED.
    expect(screen.getAllByRole('radiogroup', { name: 'Description style' })).toHaveLength(2);
  });

  it('surfaces Retry on generation failure and recovers on retry', async () => {
    generatePlainPreview.mockResolvedValue(null);
    addNoOpGuardReflection({ proposed_description: PROPOSED }); // qualify with a real diff
    render(<ReflectionsPanel onClose={vi.fn()} />);

    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByText(/Couldn't generate a plain description/)).toBeInTheDocument();

    generatePlainPreview.mockResolvedValue('Recovered plain qualification.');
    fireEvent.click(retry);
    expect(await screen.findByText('Recovered plain qualification.')).toBeInTheDocument();
  });

  it('does not generate in formal mode — shows the word diff instead', () => {
    localStorage.setItem('taxonomy-editor-description-mode', 'formal');
    addReviseReflection(true);
    const { container } = render(<ReflectionsPanel onClose={vi.fn()} />);

    expect(generatePlainPreview).not.toHaveBeenCalled();
    expect(container.querySelector('mark.rp-diff-added')).not.toBeNull();
  });

  it('does not generate for a label-only revise (no description diff to render)', async () => {
    addReviseReflection(false);
    render(<ReflectionsPanel onClose={vi.fn()} />);
    // Give any (incorrect) effect a tick to fire before asserting it didn't.
    await new Promise(r => setTimeout(r, 0));
    expect(generatePlainPreview).not.toHaveBeenCalled();
  });
});

// ── No-op edit guard (t/3814) ──────────────────────────────────
// Defense-in-depth backstop for t/3813: the generator can propose the current
// description back unchanged (QUALIFY has no way to decline). A true no-op —
// neither label nor description actually changed — must not render as a live,
// approvable proposal. A label-only revise (description unchanged, label
// genuinely different) is a real edit and must stay approvable (t/3402).

function addNoOpGuardReflection(overrides: Partial<{ edit_type: 'revise' | 'qualify'; current_label: string; proposed_label: string; current_description: string; proposed_description: string }>) {
  debateStore.reflections = [{
    pover: 'accelerationist',
    label: 'Accelerationist',
    reflection_summary: '',
    edits: [{
      edit_type: 'qualify',
      status: 'pending',
      category: 'Beliefs',
      node_id: 'acc-beliefs-001',
      current_label: 'Stable label',
      proposed_label: 'Stable label',
      current_description: 'The original current description.',
      proposed_description: 'The original current description.',
      rationale: 'because the evidence qualified this claim',
      evidence_entries: [],
      ...overrides,
    }],
  }];
}

describe('ReflectionsPanel — no-op edit guard (t/3814)', () => {
  it('shows a non-actionable "no change proposed" state when neither label nor description changed', () => {
    addNoOpGuardReflection({});
    render(<ReflectionsPanel onClose={vi.fn()} />);
    expect(screen.getByText(/No change proposed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve & Apply' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('tolerates incidental whitespace differences when deciding no-op', () => {
    addNoOpGuardReflection({ proposed_description: '  The original current   description. ' });
    render(<ReflectionsPanel onClose={vi.fn()} />);
    expect(screen.getByText(/No change proposed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve & Apply' })).not.toBeInTheDocument();
  });

  it('stays actionable when the description genuinely changed', () => {
    addNoOpGuardReflection({ proposed_description: 'A meaningfully different proposed description.' });
    render(<ReflectionsPanel onClose={vi.fn()} />);
    expect(screen.queryByText(/No change proposed/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve & Apply' })).toBeInTheDocument();
  });

  it('stays actionable on a label-only revise even though the description matches (t/3402 — no regression)', () => {
    addNoOpGuardReflection({ edit_type: 'revise', proposed_label: 'A genuinely different label' });
    render(<ReflectionsPanel onClose={vi.fn()} />);
    expect(screen.queryByText(/No change proposed/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve & Apply' })).toBeInTheDocument();
  });
});

// ── propose_new item proposals (t/1773 AC1) ───────────────────

function addProposalReflection() {
  debateStore.reflections = [{
    pover: 'accelerationist',
    label: 'Accelerationist',
    reflection_summary: '',
    edits: [],
    new_item_proposals: [{
      kind: 'propose_new',
      source: 'reflection_new_item',
      node_id: '',
      reason: 'r',
      debate_id: 'd1',
      requires_human_review: true,
      pov: 'accelerationist',
      category: 'Beliefs',
      label: 'Proposed New Belief',
      description: 'A newly proposed belief description.',
      rationale: 'It was surfaced repeatedly in the debate.',
      proposed_edges: [
        { target_node_id: 'acc-B-001', edge_type: 'SUPPORTS', new_node_role: 'source', rationale: 'supports the parent claim', confidence: 0.8 },
      ],
    }],
  }];
}

describe('ReflectionsPanel — propose_new item proposals (t/1773 AC1)', () => {
  beforeEach(() => {
    addProposalReflection();
    debateStore.newItemProposalStatus = {};
  });

  it('renders the new-item option with its label, proposed edges, and Approve/Dismiss actions', () => {
    render(<ReflectionsPanel onClose={vi.fn()} />);
    expect(screen.getByText('Proposed New Belief')).toBeInTheDocument();
    expect(screen.getByText('New Item')).toBeInTheDocument();
    expect(screen.getByText(/Proposed edges \(1\)/)).toBeInTheDocument();
    expect(screen.getByText('acc-B-001')).toBeInTheDocument();
    expect(screen.getByText(/SUPPORTS/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve & Apply' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('Approve & Apply calls applyReflectionProposal with the pov + proposal index', async () => {
    debateStore.applyReflectionProposal.mockResolvedValue({ ok: true, createdNodeId: 'acc-B-042' });
    render(<ReflectionsPanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve & Apply' }));
    await waitFor(() => expect(debateStore.applyReflectionProposal).toHaveBeenCalledWith('accelerationist', 0));
  });

  it('Dismiss calls dismissReflectionProposal', () => {
    render(<ReflectionsPanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(debateStore.dismissReflectionProposal).toHaveBeenCalledWith('accelerationist', 0);
  });
});

describe('ReflectionsPanel — propose_new wing tags (t/4214 R-6b)', () => {
  function addSkepticProposal() {
    addProposalReflection();
    const r = debateStore.reflections[0];
    r.pover = 'skeptic';
    r.label = 'Skeptic';
    r.new_item_proposals[0].pov = 'skeptic';
    debateStore.newItemProposalStatus = {};
  }
  afterEach(() => { debateStore.activeDebate = null; });

  it('a tagged seat starts with its own tag checked, and the choice is passed to apply', async () => {
    addSkepticProposal();
    debateStore.activeDebate = { seat_tags: { skeptic: { pov_tag: 'critical', tag_mode: 'scope' } } };
    debateStore.applyReflectionProposal.mockResolvedValue({ ok: true, createdNodeId: 'skp-beliefs-500' });
    render(<ReflectionsPanel onClose={vi.fn()} />);
    expect(screen.getByRole('group', { name: 'Wing tags for the new node' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Critical' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Institutional' })).not.toBeChecked();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Institutional' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve & Apply' }));
    await waitFor(() => expect(debateStore.applyReflectionProposal).toHaveBeenCalledWith('skeptic', 0, { povTags: ['critical', 'institutional'] }));
  });

  it('clearing every tag warns that the node leaves every wing\'s Scope, and applies untagged', async () => {
    addSkepticProposal();
    debateStore.activeDebate = { seat_tags: { skeptic: { pov_tag: 'critical', tag_mode: 'scope' } } };
    debateStore.applyReflectionProposal.mockResolvedValue({ ok: true });
    render(<ReflectionsPanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Critical' }));
    expect(screen.getByText('No wing tag: this node will be left out of Critical and Institutional Scope debates. To share it, tag both wings.')).toBeInTheDocument();
    expect(screen.queryByText(/common ground/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve & Apply' }));
    await waitFor(() => expect(debateStore.applyReflectionProposal).toHaveBeenCalledWith('skeptic', 0, { povTags: [] }));
  });

  it('an untagged seat starts with no tag checked', () => {
    addSkepticProposal();
    render(<ReflectionsPanel onClose={vi.fn()} />);
    expect(screen.getByRole('checkbox', { name: 'Critical' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Institutional' })).not.toBeChecked();
  });

  it('a POV with no tags shows no tag editor', () => {
    addProposalReflection();
    render(<ReflectionsPanel onClose={vi.fn()} />);
    expect(screen.queryByRole('group', { name: 'Wing tags for the new node' })).not.toBeInTheDocument();
  });
});

// ── Evidence check (t/3512) ──────────────────────────────────

describe('ReflectionsPanel — unsupported-evidence edits (t/3512)', () => {
  function addFlaggedEdit() {
    debateStore.reflections = [{
      pover: 'accelerationist',
      label: 'Accelerationist',
      reflection_summary: '',
      edits: [{
        edit_type: 'revise',
        status: 'pending',
        category: 'Beliefs',
        node_id: 'acc-beliefs-003',
        current_label: 'Old label',
        proposed_label: 'New label',
        current_description: 'old description',
        proposed_description: LONG_FORMAL,
        rationale: 'because the debate showed it',
        evidence_entries: ['AN-6'],
        evidence_supported: false,
        evidence_note: 'No debate evidence ties this edit to acc-beliefs-003: 1 cited claim(s) do not reference acc-beliefs-003 (AN-6)',
        engagement: { injected: false, citations: 0, claim_count: 0, attacked_count: 0 },
      }],
    }];
  }

  beforeEach(() => { addFlaggedEdit(); });

  it('shows the unsupported badge, the reason, and the never-engaged debate record', () => {
    render(<ReflectionsPanel onClose={vi.fn()} />);
    expect(screen.getByText('Unsupported by debate evidence')).toBeInTheDocument();
    expect(screen.getByText(/do not reference acc-beliefs-003/)).toBeInTheDocument();
    expect(screen.getByText('This debate never offered or cited this node.')).toBeInTheDocument();
  });

  it('first Approve click surfaces the refusal and arms an explicit override', async () => {
    debateStore.applyReflectionEdit.mockResolvedValue({ ok: false, error: 'Unsupported by debate evidence — no cited claim references this node.' });
    render(<ReflectionsPanel onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Approve & Apply' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply anyway (no evidence)' })).toBeInTheDocument());
    expect(debateStore.applyReflectionEdit).toHaveBeenCalledWith('accelerationist', 0, undefined, { regeneratePhrases: false });
    expect(debateStore.applyReflectionEdit).toHaveBeenCalledTimes(1);
  });

  it('the armed override passes allowUnsupportedEvidence', async () => {
    debateStore.applyReflectionEdit.mockResolvedValue({ ok: false, error: 'Unsupported by debate evidence' });
    render(<ReflectionsPanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve & Apply' }));
    const overrideBtn = await screen.findByRole('button', { name: 'Apply anyway (no evidence)' });

    debateStore.applyReflectionEdit.mockResolvedValue({ ok: true });
    fireEvent.click(overrideBtn);

    await waitFor(() => expect(debateStore.applyReflectionEdit).toHaveBeenLastCalledWith(
      'accelerationist', 0, undefined, { regeneratePhrases: false, allowUnsupportedEvidence: true },
    ));
  });

  it('Approve All skips flagged edits', async () => {
    render(<ReflectionsPanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Approve All/ }));
    await waitFor(() => expect(debateStore.applyReflectionEdit).not.toHaveBeenCalled());
  });
});

describe('tag check on edit cards (t/4214 R-6)', () => {
  const BOUNDARY = 'The speed of capability gains is not the speed of societal impact';

  function addTaggedEdit(tagCheck: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    debateStore.reflections = [{
      pover: 'skeptic',
      label: 'Skeptic',
      reflection_summary: '',
      edits: [{
        edit_type: 'revise',
        status: 'pending',
        category: 'Beliefs',
        node_id: 'skp-beliefs-010',
        current_label: 'Old label',
        proposed_label: 'New label',
        current_description: 'old description',
        proposed_description: LONG_FORMAL,
        rationale: 'because the debate showed it',
        evidence_entries: [],
        tag_check: { custodians: [], seat_tag: 'critical', tags_fp: '', text_hash: '', ...tagCheck },
        ...extra,
      }],
    }];
  }

  it('shows the target tags, the relation, and each verdict with its cited boundary', () => {
    addTaggedEdit({
      relation: 'shared', target_tags: ['critical', 'institutional'], custodians: ['skeptic.institutional'],
      verdicts: [{ soul: 'skeptic.institutional', verdict: 'conflict', cited: BOUNDARY, reason: 'It asserts the opposite.' }],
    });
    render(<ReflectionsPanel onClose={vi.fn()} />);
    const banner = screen.getByRole('note', { name: 'Tag check' });
    expect(banner).toHaveTextContent('Shared with another wing');
    expect(banner).toHaveTextContent('institutional');
    expect(banner).toHaveTextContent('seat: critical');
    expect(banner).toHaveTextContent('conflict');
    expect(banner).not.toHaveTextContent('Possible'); // the interim rule is lifted (t/4230)
    expect(screen.getByTitle('skeptic.institutional')).toHaveTextContent('Institutional'); // the label, id kept as title
    expect(banner).toHaveTextContent(BOUNDARY);
    expect(banner).toHaveTextContent('It asserts the opposite.');
  });

  it('a verdict whose citation failed verification says so', () => {
    addTaggedEdit({
      relation: 'shared', target_tags: ['critical', 'institutional'],
      verdicts: [{ soul: 'skeptic.institutional', verdict: 'tension', cited: null, reason: 'r', citation_unverified: true }],
    });
    render(<ReflectionsPanel onClose={vi.fn()} />);
    const banner = screen.getByRole('note', { name: 'Tag check' });
    expect(banner).toHaveTextContent('(no verified citation)');
    expect(banner).toHaveTextContent('tension');
    expect(banner).not.toHaveTextContent('Possible');
  });

  it('a POV with no tags shows no tag banner', () => {
    addTaggedEdit({ relation: 'no_tags', target_tags: [], seat_tag: null });
    render(<ReflectionsPanel onClose={vi.fn()} />);
    expect(screen.queryByRole('note', { name: 'Tag check' })).not.toBeInTheDocument();
  });

  it('a cross-tag refusal is shown and arms an explicit cross-wing override, which passes allowCrossTag', async () => {
    addTaggedEdit({ relation: 'foreign', target_tags: ['institutional'] });
    debateStore.applyReflectionEdit.mockResolvedValue({ ok: false, error: 'This node belongs to institutional, not critical. Review it; apply anyway to override.', refusedBy: 'cross_tag' });
    render(<ReflectionsPanel onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Approve & Apply' }));
    const overrideBtn = await screen.findByRole('button', { name: 'Apply anyway (cross-wing)' });
    expect(screen.getByText(/belongs to institutional, not critical/)).toBeInTheDocument();
    expect(debateStore.applyReflectionEdit).toHaveBeenCalledWith('skeptic', 0, undefined, { regeneratePhrases: false });

    debateStore.applyReflectionEdit.mockResolvedValue({ ok: true });
    fireEvent.click(overrideBtn);
    await waitFor(() => expect(debateStore.applyReflectionEdit).toHaveBeenLastCalledWith(
      'skeptic', 0, undefined, { regeneratePhrases: false, allowCrossTag: true },
    ));
  });

  it('an edit flagged by both gates needs both overrides, armed one at a time', async () => {
    addTaggedEdit({ relation: 'foreign', target_tags: ['institutional'] }, { evidence_supported: false, evidence_note: 'no cited claim references it' });
    debateStore.applyReflectionEdit.mockResolvedValueOnce({ ok: false, error: 'Unsupported by debate evidence', refusedBy: 'evidence' });
    render(<ReflectionsPanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve & Apply' }));
    const evidenceBtn = await screen.findByRole('button', { name: 'Apply anyway (no evidence)' });

    debateStore.applyReflectionEdit.mockResolvedValueOnce({ ok: false, error: 'This node belongs to institutional.', refusedBy: 'cross_tag' });
    fireEvent.click(evidenceBtn);
    const crossBtn = await screen.findByRole('button', { name: 'Apply anyway (cross-wing)' });

    debateStore.applyReflectionEdit.mockResolvedValueOnce({ ok: true });
    fireEvent.click(crossBtn);
    await waitFor(() => expect(debateStore.applyReflectionEdit).toHaveBeenLastCalledWith(
      'skeptic', 0, undefined, { regeneratePhrases: false, allowUnsupportedEvidence: true, allowCrossTag: true },
    ));
  });

  it('Approve All skips tag-flagged edits', async () => {
    addTaggedEdit({ relation: 'foreign', target_tags: ['institutional'] });
    render(<ReflectionsPanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Approve All/ }));
    expect(await screen.findByRole('status')).toHaveTextContent('Applied 0. Skipped 1 flagged by a check; review them one by one.');
    expect(debateStore.applyReflectionEdit).not.toHaveBeenCalled();
  });

  it('the relation is worded for the reviewer, not the seat', () => {
    addTaggedEdit({ relation: 'foreign', target_tags: ['institutional'] });
    render(<ReflectionsPanel onClose={vi.fn()} />);
    expect(screen.getByRole('note', { name: 'Tag check' })).toHaveTextContent("Another wing's node (not the seat's)");
  });

  it('Approve All still applies an own-wing edit', async () => {
    addTaggedEdit({ relation: 'own', target_tags: ['critical'] });
    debateStore.applyReflectionEdit.mockResolvedValue({ ok: true });
    render(<ReflectionsPanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Approve All/ }));
    await waitFor(() => expect(debateStore.applyReflectionEdit).toHaveBeenCalledWith('skeptic', 0));
    expect(await screen.findByRole('status')).toHaveTextContent('Applied 1.');
  });
});

describe('tag check wording for untagged targets (CL #3315 review)', () => {
  it('an untagged target is described as out of every wing\'s Scope, not as shared ground', () => {
    debateStore.reflections = [{
      pover: 'skeptic', label: 'Skeptic', reflection_summary: '',
      edits: [{
        edit_type: 'revise', status: 'pending', category: 'Beliefs', node_id: 'skp-beliefs-011',
        current_label: 'Old', proposed_label: 'New', current_description: 'old', proposed_description: LONG_FORMAL,
        rationale: 'r', evidence_entries: [],
        tag_check: { relation: 'untagged_target', custodians: [], seat_tag: 'critical', target_tags: [], tags_fp: '', text_hash: '' },
      }],
    }];
    render(<ReflectionsPanel onClose={vi.fn()} />);
    const banner = screen.getByRole('note', { name: 'Tag check' });
    expect(banner).toHaveTextContent("Untagged node (in neither wing's Scope)");
    expect(banner).not.toHaveTextContent('common ground');
  });
});
