// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4336: per-node fetch (getNodeSources), one row per real document, per-node stale-while-revalidate cache.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { SourceReference, SourceCardMeta } from '../../../../../lib/sourceIndex/types';

const getNodeSources = vi.hoisted(() => vi.fn());
const openExternal = vi.hoisted(() => vi.fn());
vi.mock('@bridge', () => ({ api: { getNodeSources, openExternal } }));

const mockRecord = vi.hoisted(() => vi.fn());
vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: mockRecord }),
}));

const { SourcesPanel, __resetSourcesCacheForTests } = await import('./SourcesPanel');
const { __resetGroupingWarnForTests } = await import('./sourceGrouping');

const ref = (over: Partial<SourceReference>): SourceReference => ({
  docId: 'doc-1', canonicalDocId: 'doc-1', title: 'AI Governance Report', pov: 'accelerationist', stance: 'aligned',
  point: 'Supports open development', verbatim: 'AI development should be open', excerptContext: 'Section 3.1',
  url: null, sourceType: 'paper', datePublished: '2025-06-01', ...over,
});
const CARD: SourceCardMeta = {
  title: 'AI Governance Report', url: 'https://example.org/report', authors: ['A. Author'],
  datePublished: '2025-06-01', topicTags: ['governance'], oneLiner: 'Argues for open development.',
};
const payload = (sources: SourceReference[], indexVersion = 1, cards: Record<string, SourceCardMeta> = {}) =>
  ({ sources, cards, indexVersion });

const TWO_REFS = payload([
  ref({}),
  ref({ stance: 'strongly_aligned', point: 'Promotes innovation', verbatim: '', excerptContext: '' }),
]);

const records = () => mockRecord.mock.calls.map(c => c[0]);
const firstRenders = () => records().filter(e => e.message === 'sources-panel.first-render');
const errors = () => records().filter(e => e.type === 'system.error');
const warns = () => records().filter(e => e.level === 'warn');

beforeEach(() => {
  getNodeSources.mockReset();
  openExternal.mockReset();
  mockRecord.mockClear();
  __resetSourcesCacheForTests();
  __resetGroupingWarnForTests();
});

describe('SourcesPanel fetch', () => {
  it('fetches only the open node, through getNodeSources', async () => {
    getNodeSources.mockResolvedValue(TWO_REFS);
    render(<SourcesPanel nodeId="acc-B-001" />);
    await screen.findByText(/2 references across 1 document/);
    expect(getNodeSources).toHaveBeenCalledWith('acc-B-001');
  });

  it('shows the empty state when the node has no sources', async () => {
    getNodeSources.mockResolvedValue(payload([]));
    render(<SourcesPanel nodeId="acc-B-999" />);
    await screen.findByText('No sources reference this node.');
  });
});

describe('SourcesPanel grouping (one row per real document)', () => {
  it('collapses split parts into one row and counts repeated references once', async () => {
    getNodeSources.mockResolvedValue(payload([
      ref({ docId: 'doc-1-1', canonicalDocId: 'doc-1', point: 'p1', verbatim: 'v1' }),
      ref({ docId: 'doc-1-2', canonicalDocId: 'doc-1', point: 'p1', verbatim: 'v1' }), // same reference, other part
      ref({ docId: 'doc-1-2', canonicalDocId: 'doc-1', point: 'p2', verbatim: 'v2' }),
      ref({ docId: 'doc-2', canonicalDocId: 'doc-2', title: 'Other Paper', point: 'p3' }),
    ]));
    render(<SourcesPanel nodeId="acc-B-001" />);
    await screen.findByText(/3 references across 2 documents/);
    expect(screen.getAllByText('AI Governance Report')).toHaveLength(1);
  });

  it('expands a row to show the source card and the distinct references, and collapses it again', async () => {
    getNodeSources.mockResolvedValue({ ...TWO_REFS, cards: { 'doc-1': CARD } });
    render(<SourcesPanel nodeId="acc-B-001" />);
    fireEvent.click(await screen.findByText('AI Governance Report'));
    expect(screen.getByLabelText('Source details')).toBeInTheDocument();
    expect(screen.getByText('Argues for open development.')).toBeInTheDocument();
    expect(screen.getByText('Supports open development')).toBeInTheDocument();
    expect(screen.getByText('Strongly Aligned')).toBeInTheDocument();
    fireEvent.click(screen.getAllByText('AI Governance Report')[0]);
    expect(screen.queryByText('Supports open development')).toBeNull();
  });

  it('without a card, a javascript: reference URL is not rendered as a link', async () => {
    getNodeSources.mockResolvedValue(payload([ref({ url: 'javascript:alert(1)' })]));
    render(<SourcesPanel nodeId="acc-B-001" />);
    fireEvent.click(await screen.findByText('AI Governance Report'));
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('SourcesPanel per-node cache', () => {
  it('a reopened node renders from cache at once (hit) and revalidates in the background', async () => {
    getNodeSources.mockResolvedValue(TWO_REFS);
    const { unmount } = render(<SourcesPanel nodeId="acc-B-001" />);
    await waitFor(() => expect(firstRenders()).toHaveLength(1));
    expect(firstRenders()[0]).toMatchObject({ level: 'info', data: { nodeId: 'acc-B-001', cache: 'miss', refs: 2, rows: 1 } });
    unmount();

    let resolve!: (v: unknown) => void;
    getNodeSources.mockReturnValue(new Promise(r => { resolve = r; }));
    render(<SourcesPanel nodeId="acc-B-001" />);
    // Shown before the revalidation answers.
    expect(screen.getByText(/2 references across 1 document/)).toBeInTheDocument();
    expect(firstRenders()[1].data.cache).toBe('hit');
    expect(getNodeSources).toHaveBeenCalledTimes(2);
    await act(async () => { resolve(TWO_REFS); });
    expect(firstRenders()).toHaveLength(2); // revalidation with the same version doesn't record again
  });

  it('a newer indexVersion replaces the cached view', async () => {
    getNodeSources.mockResolvedValue(TWO_REFS);
    const { unmount } = render(<SourcesPanel nodeId="acc-B-001" />);
    await screen.findByText(/2 references across 1 document/);
    unmount();

    getNodeSources.mockResolvedValue(payload([ref({ point: 'only one now' })], 2));
    render(<SourcesPanel nodeId="acc-B-001" />);
    await screen.findByText(/1 reference across 1 document/);
  });

  it('a response for a node the user has left is dropped', async () => {
    let resolveFirst!: (v: unknown) => void;
    getNodeSources.mockReturnValueOnce(new Promise(r => { resolveFirst = r; }));
    getNodeSources.mockResolvedValueOnce(payload([]));
    const { rerender } = render(<SourcesPanel nodeId="node-a" />);
    rerender(<SourcesPanel nodeId="node-b" />);
    await screen.findByText('No sources reference this node.');
    await act(async () => { resolveFirst(TWO_REFS); });
    expect(screen.getByText('No sources reference this node.')).toBeInTheDocument();
  });
});

describe('SourcesPanel fault arms', () => {
  it('a failed fetch with nothing cached records system.error and shows an inline error', async () => {
    getNodeSources.mockRejectedValue(new Error('503 Service Unavailable'));
    render(<SourcesPanel nodeId="acc-B-001" />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not load the sources/);
    expect(errors()).toHaveLength(1);
    expect(errors()[0]).toMatchObject({ component: 'sources-panel', level: 'error' });
    expect(errors()[0].error.message).toContain('503');
    expect(screen.queryByText('No sources reference this node.')).toBeNull(); // a failure is not "no sources"
  });

  it('a failed revalidation keeps the cached view, with system.error and a WARN', async () => {
    getNodeSources.mockResolvedValue(TWO_REFS);
    const { unmount } = render(<SourcesPanel nodeId="acc-B-001" />);
    await screen.findByText(/2 references across 1 document/);
    unmount();

    getNodeSources.mockRejectedValue(new Error('network down'));
    render(<SourcesPanel nodeId="acc-B-001" />);
    await waitFor(() => expect(errors()).toHaveLength(1));
    expect(warns().map(w => w.message)).toContain('sources fetch failed; showing the cached sources for this node (may be stale)');
    expect(screen.getByText(/2 references across 1 document/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the desktop build without the IPC handler (t/4342) shows the error, not an empty panel', async () => {
    getNodeSources.mockRejectedValue(Object.assign(new Error('The desktop IPC handler for getNodeSources is not installed in this build (t/4342).'), { name: 'ActionableError' }));
    render(<SourcesPanel nodeId="acc-B-001" />);
    await screen.findByRole('alert');
    expect(errors()[0].error.name).toBe('ActionableError');
  });
});
