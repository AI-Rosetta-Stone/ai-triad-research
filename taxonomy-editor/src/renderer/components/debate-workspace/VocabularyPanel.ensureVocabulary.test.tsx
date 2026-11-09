// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/39: VocabTermsView retries the vocabulary dictionary load when it opens with none loaded.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { VocabTermsView } from './VocabularyPanel';

const mockEnsureVocabulary = vi.fn<[], Promise<void>>();
let mockState: {
  vocabularyTerms: { colloquial: unknown[]; standardized: unknown[] } | null;
  activeDebateId: string | null;
  ensureVocabulary: typeof mockEnsureVocabulary;
};

vi.mock('../../hooks/useDebateStore', () => ({
  useDebateStore: (selector: (s: typeof mockState) => unknown) => selector(mockState),
}));

vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: (selector: (s: { navigateToLineage: () => void }) => unknown) =>
    selector({ navigateToLineage: () => {} }),
}));

vi.mock('../../utils/lineageMatcher', () => ({ extractLineageNames: () => [] }));
vi.mock('../../data/lineageLookup', () => ({ getLineageInfo: () => undefined, getAllLineages: () => ({}) }));

const resolutions = [{ colloquial: 'AGI', canonical: 'agi', offset: 0 }];

describe('VocabTermsView dictionary retry (t/39)', () => {
  beforeEach(() => {
    mockEnsureVocabulary.mockReset().mockResolvedValue(undefined);
    mockState = { vocabularyTerms: null, activeDebateId: 'deb-1', ensureVocabulary: mockEnsureVocabulary };
  });

  it('calls ensureVocabulary once on mount when the dictionary is not loaded', () => {
    render(<VocabTermsView resolutions={resolutions} />);
    expect(mockEnsureVocabulary).toHaveBeenCalledTimes(1);
  });

  it('does not call ensureVocabulary when the dictionary is already loaded', () => {
    mockState.vocabularyTerms = { colloquial: [], standardized: [] };
    render(<VocabTermsView resolutions={resolutions} />);
    expect(mockEnsureVocabulary).not.toHaveBeenCalled();
  });

  it('retries when the active debate changes and the dictionary is still missing, not on re-render', () => {
    const { rerender } = render(<VocabTermsView resolutions={resolutions} />);
    rerender(<VocabTermsView resolutions={resolutions} />);
    expect(mockEnsureVocabulary).toHaveBeenCalledTimes(1);
    mockState = { ...mockState, activeDebateId: 'deb-2' };
    rerender(<VocabTermsView resolutions={resolutions} />);
    expect(mockEnsureVocabulary).toHaveBeenCalledTimes(2);
  });
});
