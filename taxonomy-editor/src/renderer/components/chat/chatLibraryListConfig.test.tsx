// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4718: camp chip beside each chat's title, My and Community. Tests `rowCampChip` directly
// (mirrors debateLibraryConfig.test.ts's pattern for renderDebateStatus) rather than through a
// full LibraryListPage render, since the chip is the only new logic here — getTitle/filter are
// untouched by this ticket.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { rowCampChip } from './chatLibraryListConfig';
import type { ChatSessionSummary } from '../../types/chat';
import type { CommunityChat } from '../../hooks/useCommunityStore';

function myRow(overrides: Partial<ChatSessionSummary> = {}): ChatSessionSummary {
  return {
    id: 'c1', title: 'Test chat', created_at: '', updated_at: '',
    mode: 'inform', pover: 'accelerationist', ...overrides,
  };
}

function communityRow(overrides: Partial<CommunityChat> = {}): CommunityChat {
  return { id: 'c2', title: 'Community chat', created_at: '', updated_at: '', ...overrides };
}

describe('rowCampChip', () => {
  it('renders a chip with the right camp and label for each POV, on My', () => {
    const cases: [ChatSessionSummary['pover'], string, string][] = [
      ['accelerationist', 'acc', 'Accelerationist'],
      ['safetyist', 'saf', 'Safetyist'],
      ['skeptic', 'skp', 'Skeptic'],
    ];
    for (const [pover, camp, label] of cases) {
      const html = renderToStaticMarkup(rowCampChip(myRow({ pover }), 'my'));
      expect(html).toContain(`data-camp="${camp}"`);
      expect(html).toContain(label);
    }
  });

  it('renders a chip for a Community row once pover is present (t/4721)', () => {
    const html = renderToStaticMarkup(rowCampChip(communityRow({ pover: 'skeptic' }), 'community'));
    expect(html).toContain('data-camp="skp"');
    expect(html).toContain('Skeptic');
  });

  it('renders no chip for a missing pover on Community (pre-t/4721 rows)', () => {
    expect(rowCampChip(communityRow(), 'community')).toBeNull();
  });

  it('renders no chip for an unresolvable pover value rather than an empty chip', () => {
    expect(rowCampChip(myRow({ pover: 'not-a-real-pover' as ChatSessionSummary['pover'] }), 'my')).toBeNull();
  });
});
