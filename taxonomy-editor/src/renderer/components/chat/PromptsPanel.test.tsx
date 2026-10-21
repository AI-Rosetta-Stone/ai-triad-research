// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4359 — a selected/cited node id that's superseded (held aside in supersededNodes, out of
// state.<pov>.nodes per t/4355 PR 1) must still resolve for display, via allNodesById rather
// than a manual state.<pov>.nodes.find(). Setup mirrors SupersededReaders.test.tsx.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { PovNode, PovTaxonomyFile } from '../../types/taxonomy';
import type { PromptCatalogEntry } from '../../data/promptCatalog';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('@bridge', () => ({
  api: {
    hasApiKey: vi.fn().mockResolvedValue(false),
    getAvailableBackends: vi.fn().mockResolvedValue([]),
    clipboardWriteText: vi.fn().mockResolvedValue(undefined),
  },
}));

const { useTaxonomyStore } = await import('../../hooks/useTaxonomyStore');
const { splitForState, EMPTY_HELD, __resetSupersededCacheForTests } = await import('../../hooks/useTaxonomyStore/superseded');
const { PromptsPanel, PromptDetailPanel } = await import('./PromptsPanel');

const node = (id: string, over: Partial<PovNode> = {}): PovNode =>
  ({ id, category: 'Beliefs', label: `label ${id}`, description: `desc ${id}`, parent_id: null, children: [], situation_refs: [], ...over } as PovNode);
const LIVE = node('acc-beliefs-001');
const OLD = node('acc-beliefs-002', { superseded_by: 'acc-beliefs-001' });

beforeEach(() => {
  __resetSupersededCacheForTests();
  const file = { pov: 'accelerationist', last_modified: '2026-01-01', nodes: [LIVE, OLD] } as PovTaxonomyFile;
  useTaxonomyStore.setState({
    supersededNodes: EMPTY_HELD, safetyist: null, skeptic: null, situations: null, selectedNodeId: null,
    ...splitForState({ supersededNodes: EMPTY_HELD, accelerationist: null, safetyist: null, skeptic: null }, { accelerationist: file }),
  } as never);
});

describe('PromptsPanel selected-node lookup (t/4359)', () => {
  it('resolves a superseded selectedNodeId to show its label', () => {
    useTaxonomyStore.setState({ selectedNodeId: 'acc-beliefs-002' } as never);
    render(<PromptsPanel onSelectPrompt={() => {}} />);
    expect(screen.getByText(OLD.label)).toBeInTheDocument();
  });

  it('still resolves a live selectedNodeId', () => {
    useTaxonomyStore.setState({ selectedNodeId: 'acc-beliefs-001' } as never);
    render(<PromptsPanel onSelectPrompt={() => {}} />);
    expect(screen.getByText(LIVE.label)).toBeInTheDocument();
  });
});

const researchEntry: PromptCatalogEntry = {
  id: 'research', title: 'Research', group: 'research', source: 'x', description: 'd',
  template: 't', purpose: 'p', applicableDataSources: [],
  generate: (label: string, description: string) => `Research: ${label} — ${description}`,
};

describe('PromptDetailPanel selected-node lookup (t/4359)', () => {
  it('resolves a superseded selectedNodeId for prompt generation', async () => {
    useTaxonomyStore.setState({ selectedNodeId: 'acc-beliefs-002' } as never);
    render(<PromptDetailPanel entry={researchEntry} />);
    const textarea = await screen.findByRole('textbox');
    expect(textarea).toHaveValue(`Research: ${OLD.label} — ${OLD.description}`);
  });
});
