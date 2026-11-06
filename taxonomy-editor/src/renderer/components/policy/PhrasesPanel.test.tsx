// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const loadSyntheticCorpus = vi.hoisted(() => vi.fn());
const readResearchFile = vi.hoisted(() => vi.fn());
vi.mock('@bridge', () => ({ api: { loadSyntheticCorpus, readResearchFile } }));

const mockRecord = vi.hoisted(() => vi.fn());
vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: mockRecord }),
}));

const { PhrasesPanel, __resetPhrasesCacheForTests } = await import('./PhrasesPanel');

const syntheticEntry = (over: Partial<Record<string, unknown>> = {}) => ({
  node_id: 'acc-B-001', statement: 'Default statement', archetype: 'surface_claim',
  audience: null, model: 'test-model', pruned: false, prune_reason: null, rationale: '', ...over,
});

beforeEach(() => {
  loadSyntheticCorpus.mockReset();
  readResearchFile.mockReset();
  mockRecord.mockClear();
  __resetPhrasesCacheForTests();
});

describe('PhrasesPanel default-expand (t/4919)', () => {
  it('defaults the first archetype group open on the synthetic-corpus path, with aria-expanded set', async () => {
    loadSyntheticCorpus.mockResolvedValue({
      pov: 'acc',
      entries: [
        syntheticEntry({ statement: 'A surface claim', archetype: 'surface_claim' }),
        syntheticEntry({ statement: 'A policy implication', archetype: 'policy_implication' }),
      ],
    });
    render(<PhrasesPanel nodeId="acc-B-001" />);
    const surfaceHeader = await screen.findByText('Surface Claims');
    await waitFor(() => expect(surfaceHeader.closest('button')).toHaveAttribute('aria-expanded', 'true'));
    expect(screen.getByText('A surface claim')).toBeInTheDocument();
    expect(screen.queryByText('A policy implication')).toBeNull();
    expect(screen.getByText('Policy Implications').closest('button')).toHaveAttribute('aria-expanded', 'false');
  });

  it('collapsing the default-expanded archetype holds across a re-render for the same node (Quality condition)', async () => {
    loadSyntheticCorpus.mockResolvedValue({
      pov: 'acc',
      entries: [syntheticEntry({ statement: 'A surface claim', archetype: 'surface_claim' })],
    });
    const { rerender } = render(<PhrasesPanel nodeId="acc-B-001" />);
    const header = await screen.findByText('Surface Claims');
    await waitFor(() => expect(header.closest('button')).toHaveAttribute('aria-expanded', 'true'));
    fireEvent.click(header); // user collapses the default-opened archetype
    expect(header.closest('button')).toHaveAttribute('aria-expanded', 'false');

    // New (but equal-content) entries array for the SAME node — must not reopen the collapsed group.
    loadSyntheticCorpus.mockResolvedValue({
      pov: 'acc',
      entries: [syntheticEntry({ statement: 'A surface claim', archetype: 'surface_claim' })],
    });
    rerender(<PhrasesPanel nodeId="acc-B-001" />);
    expect(screen.getByText('Surface Claims').closest('button')).toHaveAttribute('aria-expanded', 'false');
  });

  it('a node switch re-applies the default to the new node\'s first archetype', async () => {
    // Both nodes share one POV corpus (loadSyntheticForPov caches per-POV, not per-node) —
    // the component filters client-side by node_id, so one mocked resolution covers both.
    loadSyntheticCorpus.mockResolvedValue({
      pov: 'acc',
      entries: [
        syntheticEntry({ node_id: 'acc-B-001', statement: 'A surface claim', archetype: 'surface_claim' }),
        syntheticEntry({ node_id: 'acc-B-002', statement: 'Another node\'s claim', archetype: 'surface_claim' }),
      ],
    });
    const { rerender } = render(<PhrasesPanel nodeId="acc-B-001" />);
    const header = await screen.findByText('Surface Claims');
    await waitFor(() => expect(header.closest('button')).toHaveAttribute('aria-expanded', 'true'));
    fireEvent.click(header);
    expect(header.closest('button')).toHaveAttribute('aria-expanded', 'false');

    rerender(<PhrasesPanel nodeId="acc-B-002" />);
    await waitFor(() => expect(screen.getByText('Surface Claims').closest('button')).toHaveAttribute('aria-expanded', 'true'));
    expect(screen.getByText('Another node\'s claim')).toBeInTheDocument();
  });

  it('the legacy-corpus fallback renders a flat list with nothing to default-expand', async () => {
    loadSyntheticCorpus.mockResolvedValue({ pov: 'acc', entries: [] });
    readResearchFile.mockResolvedValue({ pairs: [{ text: 'A legacy phrase', node_id: 'acc-B-001', source: 'x', weight: 1 }] });
    render(<PhrasesPanel nodeId="acc-B-001" />);
    await screen.findByText('A legacy phrase');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('an empty node renders the empty state without throwing (nothing to default-expand)', async () => {
    loadSyntheticCorpus.mockResolvedValue({ pov: 'acc', entries: [] });
    readResearchFile.mockResolvedValue({ pairs: [] });
    render(<PhrasesPanel nodeId="acc-B-999" />);
    await screen.findByText('No synthetic phrases for this node.');
  });
});
