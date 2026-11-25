// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/595: the read-only community chat view shows an answer's Why (BDI grounding) and How (raw prompt
// and response) through the shared BdiGroundingView and HowPanel, and renders a chat that carries
// neither exactly as before. ChatWorkspace, BdiGroundingView and HowPanel are the real components.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const { mockApi } = vi.hoisted(() => ({
  mockApi: { loadCommunityChatSession: vi.fn() },
}));

vi.mock('@bridge', () => ({ api: mockApi, isElectronMode: () => false, setActiveDebateId: () => undefined }));

import { CommunityChatDetail } from './ChatTab';
import type { CommunityChat } from '../../hooks/useCommunityStore';
import type { ChatSession } from '../../types/chat';

const ROW = { id: 'cc-1', title: 'A shared chat', mode: 'brainstorm', created_at: '2026-06-30T09:21:45.448Z', updated_at: '2026-06-30T09:46:28.136Z' } as unknown as CommunityChat;

function session(answer: Partial<ChatSession['transcript'][number]>): ChatSession {
  return {
    id: 'cc-1', title: 'A shared chat', created_at: ROW.created_at, updated_at: ROW.updated_at,
    mode: 'brainstorm', topic: 'Which policies matter most?', pover: 'accelerationist',
    transcript: [
      { id: 'u1', timestamp: '2026-06-30T09:22:00.000Z', speaker: 'user', content: 'A user question', taxonomy_refs: [] },
      { id: 'a1', timestamp: '2026-06-30T09:22:34.804Z', speaker: 'accelerationist', content: 'The answer text.', taxonomy_refs: [], ...answer },
    ],
  } as ChatSession;
}

async function renderDetail(full: ChatSession) {
  mockApi.loadCommunityChatSession.mockResolvedValue(full);
  const view = render(<CommunityChatDetail chat={ROW} />);
  await screen.findByText('The answer text.');
  return view;
}

describe('CommunityChatDetail Why and How (t/595)', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it('shows the BDI grounding groups and the How panel for an answer that carries refs and raw fields', async () => {
    const { container } = await renderDetail(session({
      taxonomy_refs: [
        { node_id: 'acc-desires-001', relevance: 'Why this desire applies.' },
        { node_id: 'acc-beliefs-051', relevance: 'Why this belief applies.' },
        { node_id: 'sit-019', relevance: 'The situation it speaks to.' },
      ],
      raw_prompt: 'THE RAW PROMPT',
      raw_response: 'THE RAW RESPONSE',
    }));

    // Why and How sit in one body column under the answer, not beside it.
    const body = container.querySelector('.chat-message-body');
    expect(body?.querySelector('.chat-message-content')).not.toBeNull();
    expect(body?.querySelector('.chat-why')).not.toBeNull();
    expect(body?.querySelector('.how-panel')).not.toBeNull();

    // Why: the shared view, grouped by BDI, one row per ref.
    expect(container.querySelectorAll('.chat-why')).toHaveLength(1);
    expect(screen.getByRole('group', { name: /Desires, 1 node/ })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /Beliefs, 1 node/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /acc-desires-001/ })).toBeInTheDocument();
    expect(screen.getByText('Why this belief applies.')).toBeInTheDocument();

    // How: the shared panel, collapsed until opened, then showing the raw prompt.
    const how = screen.getByRole('button', { name: 'How' });
    expect(how).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(how);
    expect(screen.getByText('THE RAW PROMPT')).toBeInTheDocument();

    // Only the answer gets them: one Why, one How, for a transcript of one question and one answer.
    expect(screen.getAllByRole('button', { name: 'How' })).toHaveLength(1);
  });

  it('renders a chat with no refs and no raw fields as before: the answer only, no Why, no How, no empty-state line', async () => {
    const { container } = await renderDetail(session({}));

    expect(container.querySelectorAll('.chat-message')).toHaveLength(2);
    expect(container.querySelector('.chat-message-body')).toBeNull(); // no wrapper: same DOM as before t/595
    expect(container.querySelector('.chat-why')).toBeNull();
    expect(container.querySelector('.chat-message-why-eyebrow')).toBeNull();
    expect(container.querySelector('.how-panel')).toBeNull();
    expect(screen.queryByText(/No taxonomy grounding recorded/)).toBeNull();
    expect(screen.queryByText(/not recorded for this message/)).toBeNull();
  });

  it('shows Why without How when an older chat has refs but no raw fields', async () => {
    const { container } = await renderDetail(session({ taxonomy_refs: [{ node_id: 'acc-intentions-074', relevance: 'r' }] }));

    expect(screen.getByRole('group', { name: /Intentions, 1 node/ })).toBeInTheDocument();
    expect(container.querySelector('.how-panel')).toBeNull();
  });
});
