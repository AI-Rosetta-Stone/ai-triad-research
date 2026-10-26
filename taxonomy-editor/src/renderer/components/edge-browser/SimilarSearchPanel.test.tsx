// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4364 (t/4355 child): similar-search results must drop superseded node ids — a stale
// embedding match to a node that's since been superseded should never surface as a result.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => null }));
vi.mock('../settings/ApiKeyErrorMessage', () => ({ ApiKeyErrorMessage: () => <div /> }));
vi.mock('../shared/DescriptionToggle', () => ({
  useDescriptionMode: () => ['full'],
  resolveDescription: (node: { description?: string } | undefined) => ({ text: node?.description ?? '' }),
}));

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    similarResults: null,
    similarLoading: false,
    similarError: null,
    similarThreshold: 75,
    setSimilarThreshold: vi.fn(),
    clearSimilarSearch: vi.fn(),
    getLabelForId: (id: string) => id,
    navigateToNode: vi.fn(),
    accelerationist: null,
    safetyist: null,
    skeptic: null,
    situations: null,
    conflicts: [],
    ...overrides,
  };
}

vi.mock('../../hooks/useTaxonomyStore', () => ({ useTaxonomyStore: vi.fn() }));

import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
const mockStore = useTaxonomyStore as unknown as ReturnType<typeof vi.fn>;
(mockStore as unknown as { getState: typeof mockStore }).getState = mockStore;

const { SimilarSearchPanel } = await import('./SimilarSearchPanel');

describe('SimilarSearchPanel — drops superseded ids from results (t/4364)', () => {
  it('excludes a superseded id and keeps a live one at the same score', () => {
    mockStore.mockReturnValue(makeStore({
      similarResults: [
        { id: 'acc-beliefs-002', score: 0.9 },
        { id: 'acc-beliefs-001', score: 0.9 },
      ],
      getLabelForId: (id: string) => ({ 'acc-beliefs-001': 'Live belief', 'acc-beliefs-002': 'Old belief' } as Record<string, string>)[id] ?? id,
      accelerationist: {
        nodes: [
          { id: 'acc-beliefs-002', label: 'Old belief', description: 'old', category: 'Beliefs', superseded_by: 'acc-beliefs-001' },
          { id: 'acc-beliefs-001', label: 'Live belief', description: 'live', category: 'Beliefs' },
        ],
      },
    }));

    render(<SimilarSearchPanel />);

    expect(screen.getByText('Live belief')).toBeInTheDocument();
    expect(screen.queryByText('Old belief')).not.toBeInTheDocument();
    expect(screen.queryByText('acc-beliefs-002')).not.toBeInTheDocument();
  });
});
