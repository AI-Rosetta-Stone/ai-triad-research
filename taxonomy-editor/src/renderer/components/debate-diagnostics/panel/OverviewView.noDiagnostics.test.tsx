// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/725 (TL p/16#466, TaxonomyServer p/74#45): the server no longer keeps `diagnostics` on an anonymous debate's
// save, so a reloaded anonymous debate has the field missing. The Overview panel reads `activeDebate.diagnostics`
// directly; it must render the same debate without it, showing the empty state and no Session Statistics.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const state = vi.hoisted(() => ({ activeDebate: null as unknown }));

vi.mock('../../../hooks/useDebateStore', () => ({
  useDebateStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector({ activeDebate: state.activeDebate, askQuestion: vi.fn(), debateGenerating: null }),
    { getState: () => ({ activeDebate: state.activeDebate }) },
  ),
}));
vi.mock('zustand/react/shallow', () => ({ useShallow: (fn: unknown) => fn }));
vi.mock('../../../hooks/useFeatureFlags', () => ({ useFlag: () => false }));
vi.mock('../../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: Object.assign(
    (selector?: (s: unknown) => unknown) => (selector ? selector({}) : {}),
    { getState: () => ({ accelerationist: { nodes: [] }, safetyist: { nodes: [] }, skeptic: { nodes: [] }, supersededNodes: {} }) },
  ),
}));
vi.mock('../../../hooks/useTaxonomyStore/superseded', () => ({ allNodesById: () => new Map() }));

import { OverviewView } from './OverviewView';

afterEach(() => { cleanup(); state.activeDebate = null; });

const reloaded = (extra: Record<string, unknown> = {}) => ({
  id: 'deb-1',
  title: 'A reloaded anonymous debate',
  phase: 'debate',
  active_povers: ['accelerationist', 'safetyist'],
  transcript: [
    { id: 'e1', type: 'opening', speaker: 'accelerationist', content: 'x', timestamp: 't', taxonomy_refs: [] },
    { id: 'e2', type: 'statement', speaker: 'safetyist', content: 'y', timestamp: 't', taxonomy_refs: [] },
  ],
  // no `diagnostics`: the server dropped it on save
  ...extra,
});

describe('OverviewView on a debate whose diagnostics field is missing (t/725)', () => {
  it('renders without throwing, with the empty state and no Session Statistics', () => {
    state.activeDebate = reloaded();
    expect('diagnostics' in (state.activeDebate as object)).toBe(false);
    expect(() => render(<OverviewView />)).not.toThrow();
    expect(screen.getByText(/No diagnostic data available/)).toBeTruthy();
    expect(screen.queryByText('Session Statistics')).toBeNull();
  });

  it('with diagnostics present it still shows Session Statistics (the missing field is the only difference)', () => {
    state.activeDebate = reloaded({
      diagnostics: {
        enabled: true,
        entries: {},
        overview: { total_ai_calls: 3, total_response_time_ms: 1000, claims_accepted: 1, claims_rejected: 0, move_type_counts: {}, disagreement_type_counts: {} },
      },
    });
    render(<OverviewView />);
    expect(screen.getByText('Session Statistics')).toBeTruthy();
    expect(screen.queryByText(/No diagnostic data available/)).toBeNull();
  });
});
