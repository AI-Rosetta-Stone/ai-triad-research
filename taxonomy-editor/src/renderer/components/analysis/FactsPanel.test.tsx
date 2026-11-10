// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => null }));
vi.mock('@bridge', () => ({
  api: {
    loadSourceEvidenceIndex: () => Promise.resolve({
      'node-facts': { facts: [{ claim: 'GDP rose 3% in 2024', label: 'Economic growth', doc_id: 'doc-42', specificity: 'precise', temporal_bound: '2024' }] },
      'node-empty': { facts: [] },
      'node-mention': { facts: [{ claim: 'Anthropic released a model', label: 'Model release', doc_id: 'doc-7', specificity: 'precise', temporal_bound: null }] },
    }),
    // Mention-render kit dependency (t/1901 bridge). Returns a stored mention for the
    // mention node; empty (plain text) for everything else.
    getContainerMentions: (containerId: string) => Promise.resolve(
      containerId === 'sei:node-mention'
        ? { containerId, mentions: [{ entity_ref: 'org-anthropic', quote: 'Anthropic', offset: 0, discovered_by: 'extraction' }] }
        : { containerId, mentions: [] },
    ),
  },
}));

const { FactsPanel, __resetFactsCacheForTests } = await import('./FactsPanel');

describe('FactsPanel (t/1025, t/1906)', () => {
  // t/82: the facts index is a module-level cache; start every test cold so no test sees
  // another test's (or another file's) fixture data.
  beforeEach(() => { __resetFactsCacheForTests(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('shows an empty state for a node with no linked evidence', async () => {
    render(<FactsPanel nodeId="node-empty" />);
    await waitFor(() => expect(screen.getByText(/No source evidence linked/)).toBeInTheDocument());
  });

  it('lists facts; clicking an already-expanded card collapses it (firing onSelectFact(null))', async () => {
    const onSelectFact = vi.fn();
    render(<FactsPanel nodeId="node-facts" onSelectFact={onSelectFact} />);
    // t/4919: the only (first) fact is default-expanded once facts load, so doc-42 ends up
    // visible without a click — but the label (always rendered, expanded or not) can commit
    // one render before the separate default-expand effect's setExpanded(0) does, so this
    // must itself be awaited rather than asserted synchronously right after the label's own
    // waitFor (that race is real: it was intermittently failing when another test ran first
    // and perturbed the exact timing).
    await waitFor(() => expect(screen.getByText(/doc-42/)).toBeInTheDocument());
    expect(screen.getByText('Economic growth')).toBeInTheDocument();
    expect(screen.getByText(/1 fact from source documents/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Economic growth'));
    expect(screen.queryByText(/doc-42/)).not.toBeInTheDocument();
    expect(onSelectFact).toHaveBeenCalledWith(null);

    fireEvent.click(screen.getByText('Economic growth'));
    expect(screen.getByText(/doc-42/)).toBeInTheDocument();
    expect(onSelectFact).toHaveBeenCalledWith(expect.objectContaining({ label: 'Economic growth' }));
  });

  describe('default-expand first fact (t/4919)', () => {
    it('expands the first fact on mount (async load) without calling onSelectFact', async () => {
      const onSelectFact = vi.fn();
      render(<FactsPanel nodeId="node-facts" onSelectFact={onSelectFact} />);
      await waitFor(() => expect(screen.getByText(/doc-42/)).toBeInTheDocument());
      expect(screen.getByText('Economic growth').closest('.facts-card')).toHaveAttribute('aria-expanded', 'true');
      // The reset effect calls onSelectFact(null) on mount/node-change (unchanged, pre-existing
      // behavior) — but the default-expand path itself must never call it with a fact.
      expect(onSelectFact).not.toHaveBeenCalledWith(expect.objectContaining({ label: expect.any(String) }));
    });

    it('re-applies the default to the new node\'s first fact on a node change', async () => {
      const onSelectFact = vi.fn();
      const { rerender } = render(<FactsPanel nodeId="node-facts" onSelectFact={onSelectFact} />);
      await waitFor(() => expect(screen.getByText(/doc-42/)).toBeInTheDocument());

      rerender(<FactsPanel nodeId="node-mention" onSelectFact={onSelectFact} />);
      await waitFor(() => expect(screen.getByText(/Anthropic released a model/)).toBeInTheDocument());
      expect(screen.getByText('Model release').closest('.facts-card')).toHaveAttribute('aria-expanded', 'true');
    });

    it('applies the node-switch default from the NEW node\'s loaded facts, not the stale previous-node render (t/83)', async () => {
      // Same race as SourcesPanel/PhrasesPanel (p/356#162): right after a nodeId change, one
      // commit still holds the PREVIOUS node's `facts`, and an ungated default-expand effect
      // would consume `defaultAppliedFor` on that stale data. It's invisible in the UI today
      // only because the default is the bare index 0, which is right for any node's first
      // fact — key the default by anything node-specific and it breaks. So the
      // `loadedFor === nodeId` guard is NOT redundant; this test pins it by checking WHEN the
      // default lands: gated, B's card first commits collapsed and then flips open (the effect
      // reacted to B's facts); ungated, it's inserted already open (the default was pre-applied
      // from A's stale facts).
      const { container, rerender } = render(<FactsPanel nodeId="node-facts" />);
      await waitFor(() => expect(screen.getByText(/doc-42/)).toBeInTheDocument());

      const flips: Array<{ label: string | null; from: string | null; to: string | null }> = [];
      const observer = new MutationObserver((records) => {
        for (const r of records) {
          const el = r.target as HTMLElement;
          flips.push({ label: el.querySelector('.facts-label')?.textContent ?? null, from: r.oldValue, to: el.getAttribute('aria-expanded') });
        }
      });
      observer.observe(container, { subtree: true, attributes: true, attributeFilter: ['aria-expanded'], attributeOldValue: true });

      rerender(<FactsPanel nodeId="node-mention" />);
      await waitFor(() => expect(screen.getByText('Model release').closest('.facts-card')).toHaveAttribute('aria-expanded', 'true'));
      await new Promise((r) => setTimeout(r, 0)); // let the observer deliver its records
      observer.disconnect();

      expect(flips).toContainEqual({ label: 'Model release', from: 'false', to: 'true' });
    });

    it('collapsing the default-expanded fact works, and it does not reopen on an unrelated re-render', async () => {
      const onSelectFact = vi.fn();
      const { rerender } = render(<FactsPanel nodeId="node-facts" onSelectFact={onSelectFact} />);
      await waitFor(() => expect(screen.getByText(/doc-42/)).toBeInTheDocument());

      fireEvent.click(screen.getByText('Economic growth'));
      expect(screen.queryByText(/doc-42/)).not.toBeInTheDocument();

      // Re-render with the same nodeId (e.g. a parent re-render) — must not reopen the
      // collapsed card (Quality's condition, t/4919#4: defaultAppliedFor is a ref, so the
      // [facts, nodeId] effect is a no-op once already applied for this node).
      rerender(<FactsPanel nodeId="node-facts" onSelectFact={onSelectFact} onSelectRef={undefined} />);
      expect(screen.queryByText(/doc-42/)).not.toBeInTheDocument();
    });

    it('an empty fact list renders without throwing and applies no default', async () => {
      render(<FactsPanel nodeId="node-empty" />);
      await waitFor(() => expect(screen.getByText(/No source evidence linked/)).toBeInTheDocument());
    });
  });

  it('linkifies a stored mention and routes via the wired onSelectRef (t/1906)', async () => {
    const onSelectRef = vi.fn();
    render(<FactsPanel nodeId="node-mention" onSelectRef={onSelectRef} />);
    // Links render only in the EXPANDED claim (the muted collapsed preview stays plain
    // text for WCAG AA — see FactsPanel §9 note). t/4919: the only (first) fact is
    // default-expanded once facts load, so no click is needed to expand it here.
    await waitFor(() => expect(screen.getByText('Model release')).toBeInTheDocument());
    // "Anthropic" in the expanded claim renders as a ref-link button (kind via aria-label).
    const link = await screen.findByRole('button', { name: /Organization: Anthropic/ });
    expect(link).toHaveClass('ref-link');
    // Clicking routes through the injected handler with the parsed ref (not a dead link).
    fireEvent.click(link);
    expect(onSelectRef).toHaveBeenCalledWith({ kind: 'organization', id: 'org-anthropic' });
  });

  it('renders mentions as PLAIN text when no onSelectRef is wired (t/1977 — no dead links)', async () => {
    render(<FactsPanel nodeId="node-mention" />); // no co-mounted pane → no handler
    // t/4919: default-expanded, no click needed.
    await waitFor(() => expect(screen.getByText('Model release')).toBeInTheDocument());
    // The claim text is present, but "Anthropic" is NOT a link (would be a dead click).
    expect(screen.getByText(/Anthropic released a model/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Organization: Anthropic/ })).toBeNull();
  });
});
