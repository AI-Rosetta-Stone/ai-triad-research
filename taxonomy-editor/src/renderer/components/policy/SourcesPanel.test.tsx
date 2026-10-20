import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const MOCK_INDEX = vi.hoisted(() => ({
  'acc-B-001': [
    {
      docId: 'doc-1',
      title: 'AI Governance Report',
      pov: 'accelerationist',
      stance: 'aligned',
      point: 'Supports open development',
      verbatim: 'AI development should be open',
      excerptContext: 'Section 3.1',
      url: null,
      sourceType: 'paper',
      datePublished: '2025-06-01',
    },
    {
      docId: 'doc-1',
      title: 'AI Governance Report',
      pov: 'accelerationist',
      stance: 'strongly_aligned',
      point: 'Promotes innovation',
      verbatim: '',
      excerptContext: '',
      url: null,
      sourceType: 'paper',
      datePublished: '2025-06-01',
    },
  ],
}));

vi.mock('@bridge', () => ({
  api: {
    buildNodeSourceIndex: vi.fn().mockResolvedValue(MOCK_INDEX),
  },
}));

const mockRecord = vi.hoisted(() => vi.fn());
vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: mockRecord }),
}));

import { SourcesPanel } from './SourcesPanel';

describe('SourcesPanel first-render timing (t/4336 step 0)', () => {
  const firstRenders = () => mockRecord.mock.calls.map(c => c[0]).filter(e => e.message === 'sources-panel.first-render');

  it('records time to data with the cache state and the counts, once per open', async () => {
    mockRecord.mockClear();
    const { unmount } = render(<SourcesPanel nodeId="acc-B-001" />);
    await waitFor(() => expect(firstRenders()).toHaveLength(1));
    const e = firstRenders()[0];
    expect(e).toMatchObject({ component: 'sources-panel', level: 'info', data: { nodeId: 'acc-B-001', refs: 2, rows: 1 } });
    expect(['hit', 'miss']).toContain(e.data.cache);
    expect(typeof e.data.ms).toBe('number');
    unmount();

    // A second open reuses the loaded index, so it reports a cache hit.
    render(<SourcesPanel nodeId="acc-B-001" />);
    await waitFor(() => expect(firstRenders()).toHaveLength(2));
    expect(firstRenders()[1].data.cache).toBe('hit');
  });
});

describe('SourcesPanel', () => {
  it('shows empty state when no sources match the nodeId', async () => {
    render(<SourcesPanel nodeId="acc-B-999" />);
    await waitFor(() => {
      expect(screen.getByText('No sources reference this node.')).toBeDefined();
    });
  });

  it('renders reference count summary', async () => {
    render(<SourcesPanel nodeId="acc-B-001" />);
    await waitFor(() => {
      expect(screen.getByText(/2 references across 1 document/)).toBeDefined();
    });
  });

  it('expands a document group on click to show references', async () => {
    render(<SourcesPanel nodeId="acc-B-001" />);
    await waitFor(() => {
      expect(screen.getByText('AI Governance Report')).toBeDefined();
    });
    fireEvent.click(screen.getByText('AI Governance Report'));
    expect(screen.getByText('Supports open development')).toBeDefined();
    expect(screen.getByText('Aligned')).toBeDefined();
    expect(screen.getByText('Strongly Aligned')).toBeDefined();
  });

  it('collapses a document group when clicked again', async () => {
    render(<SourcesPanel nodeId="acc-B-001" />);
    await waitFor(() => {
      expect(screen.getByText('AI Governance Report')).toBeDefined();
    });
    fireEvent.click(screen.getByText('AI Governance Report'));
    expect(screen.getByText('Supports open development')).toBeDefined();
    fireEvent.click(screen.getByText('AI Governance Report'));
    expect(screen.queryByText('Supports open development')).toBeNull();
  });
});
