// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4514: TaxonomyRefsSection's inline Explain wiring — the card trigger's open/close toggle and
// aria-expanded state, and the right-click-selection bus hand-off, scoped per the ticket (card
// explains the whole exchange, right-click explains the selection). ExplainPanel itself (loading/
// result/error/actions) is covered in ExplainPanel.test.tsx — this file is wiring-only, so
// ExplainPanel is stubbed to capture the props TaxonomyRefsSection passed it.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import type { TranscriptEntry } from '../../types/debate';
import { TaxonomyRefsSection } from './TaxonomyRefs';
import { requestExplainForSelection } from './explainRequestBus';

vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: {} }));

vi.mock('./utils', () => ({
  nodeIdToTab: () => ({ tab: 'acc', colorVar: 'var(--color-acc)' }),
  getNodeLabel: (id: string) => `Label for ${id}`,
  getNodeWeight: () => null,
  focusMainWindowNode: vi.fn(),
  buildExplainPrompt: (entry: TranscriptEntry) => `whole-entry prompt for ${entry.id}`,
  buildSelectionExplainPrompt: (text: string) => `selection prompt: ${text}`,
  fixMarkdownLinks: (s: string) => s,
  resolvePolRef: () => ({ id: '', relevance: null }),
  getPolicyAction: () => undefined,
}));

vi.mock('../../utils/humanizeSpeakers', () => ({ humanizeSpeakerIds: (ids: string[]) => ids.join(', ') }));

vi.mock('./ExplainPanel', () => ({
  ExplainPanel: ({ prompt, scopeLabel, onClose }: { prompt: string; scopeLabel: string; onClose: () => void }) => (
    <div data-testid="explain-panel">
      <span data-testid="explain-prompt">{prompt}</span>
      <span data-testid="explain-scope">{scopeLabel}</span>
      <button onClick={onClose}>stub-close</button>
    </div>
  ),
}));

const entry = (overrides: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  id: 'entry-1', timestamp: '2026-01-01T00:00:00Z', type: 'statement', speaker: 'accelerationist',
  content: 'The statement text', taxonomy_refs: [], ...overrides,
} as TranscriptEntry);

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('TaxonomyRefsSection — Explain wiring (t/4514)', () => {
  it('clicking Explain opens the panel with the whole-entry prompt, aria-expanded true', () => {
    render(<TaxonomyRefsSection refs={[]} entry={entry()} />);
    const trigger = screen.getByRole('button', { name: 'Explain' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('explain-prompt').textContent).toBe('whole-entry prompt for entry-1');
    expect(screen.getByTestId('explain-scope').textContent).toBe('this exchange');
  });

  it('clicking Explain again collapses the panel, aria-expanded false', () => {
    render(<TaxonomyRefsSection refs={[]} entry={entry()} />);
    const trigger = screen.getByRole('button', { name: 'Explain' });
    fireEvent.click(trigger);
    expect(screen.queryByTestId('explain-panel')).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByTestId('explain-panel')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it("the panel's onClose collapses it (e.g. Esc/Collapse from inside ExplainPanel)", () => {
    render(<TaxonomyRefsSection refs={[]} entry={entry()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Explain' }));
    fireEvent.click(screen.getByText('stub-close'));
    expect(screen.queryByTestId('explain-panel')).not.toBeInTheDocument();
  });

  it('a right-click selection request routed through the bus opens the panel scoped to the selection', () => {
    render(<TaxonomyRefsSection refs={[]} entry={entry({ id: 'entry-42' })} />);
    expect(screen.queryByTestId('explain-panel')).not.toBeInTheDocument();

    let handled = false;
    act(() => { handled = requestExplainForSelection('entry-42', 'the selected excerpt'); });
    expect(handled).toBe(true);

    expect(screen.getByTestId('explain-prompt').textContent).toBe('selection prompt: the selected excerpt');
    expect(screen.getByTestId('explain-scope').textContent).toBe('this selection');
  });

  it('a selection request for a different entry id is not handled by this instance', () => {
    render(<TaxonomyRefsSection refs={[]} entry={entry({ id: 'entry-A' })} />);
    const handled = requestExplainForSelection('entry-B', 'text');
    expect(handled).toBe(false);
    expect(screen.queryByTestId('explain-panel')).not.toBeInTheDocument();
  });

  it('unmounting unregisters the bus handler for that entry id', () => {
    const { unmount } = render(<TaxonomyRefsSection refs={[]} entry={entry({ id: 'entry-7' })} />);
    unmount();
    expect(requestExplainForSelection('entry-7', 'text')).toBe(false);
  });

  it('renders no Explain trigger when there is no entry', () => {
    render(<TaxonomyRefsSection refs={[{ node_id: 'acc-beliefs-001', relevance: 'r' }]} />);
    expect(screen.queryByRole('button', { name: 'Explain' })).not.toBeInTheDocument();
  });
});
