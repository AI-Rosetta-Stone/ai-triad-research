// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4535 (PI request p/351#29): the debate-context pair (shown when activeTab is 'debate' or
// 'chat') reorders to Chat before Debate, matching the new primary nav order. The other pair
// (Taxonomy, Debate) already matched the new relative order and is unchanged — covered here for
// completeness.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const mockTaxonomyStore = {
  activeTab: 'debate' as string,
  setActiveTab: vi.fn(),
  toolbarPanel: null as string | null,
  setToolbarPanel: vi.fn(),
  clearSimilarSearch: vi.fn(),
};
vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: Object.assign(() => mockTaxonomyStore, { setState: vi.fn() }),
}));

const { mockBreakpoint } = vi.hoisted(() => ({ mockBreakpoint: { value: 'phone' as string } }));
vi.mock('../../hooks/useBreakpoint', () => ({ useBreakpoint: () => mockBreakpoint.value }));

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { BottomNav } from './BottomNav';

describe('BottomNav — primary nav order (t/4535)', () => {
  it('shows Chat before Debate in the debate-context pair', () => {
    mockBreakpoint.value = 'phone';
    mockTaxonomyStore.activeTab = 'debate';
    render(<BottomNav />);
    const chat = screen.getByRole('button', { name: /Chat/ });
    const debate = screen.getByRole('button', { name: /Debate/ });
    expect(chat.compareDocumentPosition(debate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps Debate before Taxonomy in the non-debate-context pair (already matched the new order)', () => {
    mockBreakpoint.value = 'tablet'; // !isPhone, so the Debate button in this branch is shown
    mockTaxonomyStore.activeTab = 'accelerationist';
    render(<BottomNav />);
    const taxonomy = screen.getByRole('button', { name: /Taxonomy/ });
    const debate = screen.getByRole('button', { name: /Debate/ });
    expect(taxonomy.compareDocumentPosition(debate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
