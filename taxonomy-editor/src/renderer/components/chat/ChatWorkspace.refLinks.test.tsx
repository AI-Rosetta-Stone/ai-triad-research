// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/1777 — ChatWorkspace linkifies ID-token refs (node/sit/pol) in message text via the
// shared remarkLinkifyRefs plugin + a RefLinkSpan md-component, and clicking one opens the
// shared DetailPane (the converged pane, also driven by taxonomy-ref pills). Integration:
// real react-markdown + real remark plugins + real scanRefs/parseEntityRef; DetailPane is
// mocked to assert the EntityRef the surface drives into it.

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { EntityRef } from '@lib/entities/types';

vi.mock('../shared/DetailPane', () => ({
  DetailPane: ({ selectedRef }: { selectedRef: EntityRef | null }) => (
    <div data-testid="chat-detail-pane">{selectedRef ? `${selectedRef.kind}:${selectedRef.id}` : ''}</div>
  ),
}));

let mockChatStoreState: Record<string, unknown> = {};
vi.mock('../../hooks/useChatStore', () => ({
  useChatStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      activeChat: null, chatLoading: false, chatError: null, chatGenerating: false,
      chatActivity: null, chatProgress: null,
      sendMessage: vi.fn(), generateOpening: vi.fn(), changeMode: vi.fn(),
      ...mockChatStoreState,
    };
    return selector ? selector(state) : state;
  },
}));

const lookupPinnedData = vi.fn((id: string) => ({
  type: 'situations' as const,
  node: { id, label: `Label for ${id}` },
}));
vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: (selector: (s: Record<string, unknown>) => unknown) => selector({ lookupPinnedData }),
}));
vi.mock('../../hooks/useAuthStatus', () => ({ useUserProfile: () => null }));
vi.mock('@bridge', () => ({ api: { submitToCommunity: vi.fn(), exportChatToFile: vi.fn() } }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('../../types/debate', () => ({
  POVER_INFO: {
    accelerationist: { label: 'Accelerationist', color: '#e74c3c' },
    safetyist: { label: 'Safetyist', color: '#2ecc71' },
    skeptic: { label: 'Skeptic', color: '#3498db' },
  },
}));
vi.mock('../../types/chat', () => ({
  CHAT_MODE_INFO: {
    brainstorm: { label: 'Brainstorm', description: '' },
    inform: { label: 'Inform', description: '' },
    decide: { label: 'Decide', description: '' },
  },
}));
vi.mock('@lib/debate/nodeIdUtils', () => ({
  nodePovFromId: (id: string) => (id.startsWith('acc') ? 'accelerationist' : id.startsWith('saf') ? 'safetyist' : 'skeptic'),
  nodeTypeFromId: () => 'pov',
}));
vi.mock('../shared/CommunityShareBanner', () => ({ CommunityShareBanner: () => null }));

import { ChatWorkspace } from './ChatWorkspace';

function makeChat(over: Record<string, unknown> = {}) {
  return {
    id: 'chat-1', title: 'T', mode: 'brainstorm', topic: 'AI', pover: 'accelerationist',
    transcript: [], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...over,
  };
}

function messageWith(content: string, taxonomy_refs: Array<{ node_id: string; relevance: string }> = []) {
  return { id: 'm1', speaker: 'accelerationist', content, taxonomy_refs, timestamp: '2026-01-01T00:00:00Z' };
}

beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });
beforeEach(() => { mockChatStoreState = {}; });

describe('ChatWorkspace — inline ID-ref links (t/1777)', () => {
  it('renders an ID token in message text as a selectable ref-link button (AC#1)', () => {
    mockChatStoreState = { activeChat: makeChat({ transcript: [messageWith('See acc-beliefs-001 for context.')] }) };
    render(<ChatWorkspace />);
    const link = screen.getByRole('button', { name: 'acc-beliefs-001' });
    expect(link).toHaveClass('ref-link');
  });

  it('clicking an inline ref link opens the shared DetailPane with the parsed EntityRef (AC#1)', () => {
    mockChatStoreState = { activeChat: makeChat({ transcript: [messageWith('See acc-beliefs-001 now.')] }) };
    render(<ChatWorkspace />);
    expect(screen.queryByTestId('chat-detail-pane')).toBeNull(); // pane closed until a ref is selected
    fireEvent.click(screen.getByRole('button', { name: 'acc-beliefs-001' }));
    expect(screen.getByTestId('chat-detail-pane')).toHaveTextContent('node:acc-beliefs-001');
  });

  it('does not linkify non-ref tokens', () => {
    mockChatStoreState = { activeChat: makeChat({ transcript: [messageWith('Just some ordinary prose here.')] }) };
    render(<ChatWorkspace />);
    expect(screen.queryByRole('button', { name: /beliefs/ })).toBeNull();
  });

  // t/4627: a BDI ref pill now opens an inline detail under the reply instead of the side
  // DetailPane — the side pane stays reserved for in-text ref links (above), pending the PI's
  // answer on whether to keep both paths. Full open/toggle/switch/independence coverage lives
  // in TaxonomyRefsSection.test.tsx; this just confirms the pill no longer drives the shared pane.
  it('a taxonomy-ref pill opens inline detail, not the shared DetailPane (t/4627)', () => {
    mockChatStoreState = { activeChat: makeChat({ transcript: [messageWith('Hello', [{ node_id: 'sit-5', relevance: 'r' }])] }) };
    render(<ChatWorkspace />);
    const pill = screen.getByText('sit-5'); // single match before the detail (which also shows the id) opens
    fireEvent.click(pill);
    expect(screen.queryByTestId('chat-detail-pane')).toBeNull();
    expect(screen.getByText('Label for sit-5')).toBeInTheDocument();
  });
});
