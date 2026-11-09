// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4898: cardTitle's precedence for a community Question — a renamed `title` wins over
// `question`, mirroring lib's inquiryDisplayTitle. Regression for the TS fix that reordered
// cardTitle's checks (CommunityInquiry.title is now optional, so the old `'title' in item`
// check-first order needed its type guard narrowed too).

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CommunityCard } from './CommunityLibrary';
import type { CommunityInquiry } from '../../hooks/useCommunityStore';

const inquiry = (over: Partial<CommunityInquiry> = {}): CommunityInquiry => ({
  id: 'inq-1', question: 'Is AI hype outrunning evidence?', created_at: '2026-01-01', updated_at: '2026-01-01',
  camps: [], verdict_count: 0, ...over,
});
const card = (item: CommunityInquiry) =>
  render(<CommunityCard item={item} isAdmin={false} onCopy={vi.fn()} onRemove={vi.fn()} />);

describe('CommunityCard Question title precedence (t/4898)', () => {
  it('shows the question when untitled', () => {
    card(inquiry());
    expect(screen.getByText('Is AI hype outrunning evidence?')).toBeInTheDocument();
  });

  it('shows the renamed title instead of the question once admin-renamed', () => {
    card(inquiry({ title: 'Hype vs. Evidence' }));
    expect(screen.getByText('Hype vs. Evidence')).toBeInTheDocument();
    expect(screen.queryByText('Is AI hype outrunning evidence?')).toBeNull();
  });
});
