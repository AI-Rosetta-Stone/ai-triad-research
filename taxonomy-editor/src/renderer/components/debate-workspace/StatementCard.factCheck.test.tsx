// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/1716 — FactCheckCard renders the new `partially_accurate` verdict with distinct
// styling (not folded into supported/pass) and surfaces the evidence-gated
// discrepancy (claimed → actual, dimension, severity), with `major` severity reading
// as a caveat rather than a pass.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FactCheckCard } from './StatementCard';
import type { TranscriptEntry } from '@lib/debate/types';
import type { FactDiscrepancy } from '@lib/debate/types';

vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: {} }));
vi.mock('./utils', () => ({
  speakerLabel: (s: string) => s, speakerColor: () => '#999', pctFmt: (v: number) => `${v}`,
  focusMainWindowNode: vi.fn(), fixMarkdownLinks: (s: string) => s, stripLeadingHeadings: (s: string) => s,
  kindLabel: (t: string) => t, countOccurrences: () => 0,
}));
vi.mock('../../hooks/useDebateStore', () => ({
  useDebateStore: Object.assign((sel: any) => sel({ activeDebate: null }), { getState: () => ({ activeDebate: null, setSelectedRef: vi.fn() }) }),
}));
vi.mock('../../utils/lineageMatcher', () => ({ lineageMarkdownComponents: {}, extractLineageNames: () => [] }));
vi.mock('./TaxonomyRefs', () => ({ TaxonomyRefsSection: () => <div /> }));

afterEach(() => vi.clearAllMocks());

function factCheckEntry(fc: Record<string, unknown>): TranscriptEntry {
  return {
    id: 'fc1', timestamp: '2026-01-01T00:00:00Z', type: 'fact-check', speaker: 'system',
    content: 'Fact Check body', taxonomy_refs: [], metadata: { fact_check: fc },
  };
}

const discrepancy: FactDiscrepancy = {
  dimension: 'magnitude', claimed: '12 states', actual: '10 states', source: 'sit-001', severity: 'minor',
};

describe('FactCheckCard (t/764)', () => {
  it('shows the pill text, the checked claim in quotes and the finding', () => {
    const { container } = render(<FactCheckCard entry={factCheckEntry({
      verdict: 'supported', explanation: 'Long reasoning.', checked_text: 'Labs help', finding: 'Accurate. A 2017 study agrees.',
      finding_points: ['Holmes et al., 2017.'], limit: 'One discipline only.',
    })} />);
    expect(container.querySelector('.debate-fact-check-verdict')?.textContent).toBe('SUPPORTED');
    expect(container.querySelector('.debate-fact-check-checked-text')?.textContent).toBe('“Labs help”');
    expect(container.querySelector('.debate-fact-check-finding')?.textContent).toBe('Accurate. A 2017 study agrees.');
    expect(container.querySelector('.debate-fact-check-limit-label')?.textContent).toBe('Limit');
    expect(container.querySelector('.debate-fact-check-limit')?.textContent).toContain('One discipline only.');
  });

  it('partially_accurate shows Claimed / Source says instead of the points', () => {
    const { container } = render(<FactCheckCard entry={factCheckEntry({
      verdict: 'partially_accurate', discrepancy, explanation: '', checked_text: 'x', finding: 'Partly accurate. Off by two.', finding_points: ['p'],
    })} />);
    expect(container.querySelector('.debate-fact-check-verdict')?.textContent).toBe('PARTLY ACCURATE');
    const pair = container.querySelector('.debate-fact-check-pair');
    expect(pair?.textContent).toContain('Claimed12 states');
    expect(pair?.textContent).toContain('Source says10 states');
    expect(container.querySelector('.debate-fact-check-points')).toBeNull();
  });

  it('an old entry uses the first non-"This matters" sentence of the explanation as the finding', () => {
    const { container } = render(<FactCheckCard entry={factCheckEntry({
      verdict: 'disputed', explanation: 'This matters because policy follows. Studies disagree on the effect size.', checked_text: 'x',
    })} />);
    expect(container.querySelector('.debate-fact-check-finding')?.textContent).toBe('Studies disagree on the effect size.');
  });

  it('Show details expands in place with aria-expanded; the Web Evidence button is gone', async () => {
    const user = userEvent.setup();
    const { container } = render(<FactCheckCard entry={factCheckEntry({
      verdict: 'supported', explanation: 'Full reasoning text.', checked_text: 'x', finding: 'Accurate.',
      web_search_used: true, web_search_queries: ['q1', 'q2'],
      web_search_citations: [{ uri: 'https://www.example.org/a', title: 'A study', segments: [] }],
    })} />);
    expect(screen.queryByText(/Show Web Evidence/i)).toBeNull();
    expect(container.querySelector('.debate-fact-check-details')).toBeNull();
    const btn = screen.getByRole('button', { name: 'Show details' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    await user.click(btn);
    expect(screen.getByRole('button', { name: 'Hide details' }).getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.debate-fact-check-details')?.textContent).toContain('Full reasoning text.');
    expect(container.querySelector('.debate-fact-check-details')?.textContent).toContain('Searched: “q1” · “q2”');
  });

  it('shows a Sources row with short links and +N beyond three', () => {
    const cites = ['a', 'b', 'c', 'd', 'e'].map(h => ({ uri: `https://www.${h}.org/x`, title: `Study ${h}`, segments: [] }));
    const { container } = render(<FactCheckCard entry={factCheckEntry({ verdict: 'supported', explanation: '', checked_text: 'x', finding: 'Accurate.', web_search_citations: cites })} />);
    const row = container.querySelector('.debate-fact-check-sources-row');
    expect(row?.querySelectorAll('a').length).toBe(3);
    expect(row?.textContent).toContain('Study a');
    expect(row?.textContent).toContain('+2');
  });
});
