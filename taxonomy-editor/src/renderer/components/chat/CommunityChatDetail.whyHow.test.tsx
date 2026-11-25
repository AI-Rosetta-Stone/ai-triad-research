// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/595: the read-only community chat view shows an answer's Why (BDI grounding) and How (raw prompt
// and response) as two collapsed disclosures, through the shared BdiGroundingView and HowPanel, and
// renders a chat that carries neither exactly as before. ChatWorkspace, BdiGroundingView and HowPanel are the real components.

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

  it('shows collapsed Why and How toggles under an answer that carries refs and raw fields, and opens each', async () => {
    const { container } = await renderDetail(session({
      taxonomy_refs: [
        { node_id: 'acc-desires-001', relevance: 'Why this desire applies.' },
        { node_id: 'acc-beliefs-051', relevance: 'Why this belief applies.' },
        { node_id: 'sit-019', relevance: 'The situation it speaks to.' },
      ],
      raw_prompt: 'THE RAW PROMPT',
      raw_response: 'THE RAW RESPONSE',
    }));

    // Both toggles sit in one row inside the answer's body column, Why first (Design, p/53#61).
    const row = container.querySelector('.chat-message-body > .community-answer-provenance');
    expect(row).not.toBeNull();
    expect(container.querySelector('.chat-message-body > .chat-message-content')).not.toBeNull();
    const toggles = [...row!.querySelectorAll('button.how-toggle')];
    expect(toggles.map((b) => b.textContent)).toEqual(['▸Why (3)', '▸How']);

    // Why: collapsed by default, with the ref count; nothing of the grounding is rendered yet.
    const why = screen.getByRole('button', { name: 'Why (3)' });
    expect(why).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('.chat-why')).toBeNull();
    expect(container.querySelector('.chat-message-why-eyebrow')).toBeNull();

    // Opened: the shared BDI view, grouped, one row per ref. Closing hides it again.
    fireEvent.click(why);
    expect(why).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('group', { name: /Desires, 1 node/ })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /Beliefs, 1 node/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /acc-desires-001/ })).toBeInTheDocument();
    expect(screen.getByText('Why this belief applies.')).toBeInTheDocument();
    fireEvent.click(why);
    expect(container.querySelector('.chat-why')).toBeNull();

    // How: the shared panel, collapsed until opened, then showing the raw prompt.
    const how = screen.getByRole('button', { name: 'How' });
    expect(how).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(how);
    expect(screen.getByText('THE RAW PROMPT')).toBeInTheDocument();

    // Only the answer gets them: the user message has no toggles.
    expect(container.querySelectorAll('.community-answer-provenance')).toHaveLength(1);
  });

  it('renders a chat with no refs and no raw fields as before: the answer only, no toggles, no empty-state line', async () => {
    const { container } = await renderDetail(session({}));

    expect(container.querySelectorAll('.chat-message')).toHaveLength(2);
    expect(container.querySelector('.chat-message-body')).toBeNull(); // no wrapper: same DOM as before t/595
    expect(container.querySelector('.community-answer-provenance')).toBeNull();
    expect(container.querySelector('.how-toggle')).toBeNull();
    expect(container.querySelector('.how-panel')).toBeNull();
    expect(screen.queryByText(/No taxonomy grounding recorded/)).toBeNull();
    expect(screen.queryByText(/not recorded for this message/)).toBeNull();
  });

  it('shows the Why toggle without How when an older chat has refs but no raw fields', async () => {
    const { container } = await renderDetail(session({ taxonomy_refs: [{ node_id: 'acc-intentions-074', relevance: 'r' }] }));

    expect(container.querySelector('.how-panel')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Why (1)' }));
    expect(screen.getByRole('group', { name: /Intentions, 1 node/ })).toBeInTheDocument();
  });

  it('shows the How toggle without Why when an answer has raw fields but no refs', async () => {
    await renderDetail(session({ raw_prompt: 'P', raw_response: 'R' }));

    expect(screen.queryByRole('button', { name: /^Why/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'How' })).toHaveAttribute('aria-expanded', 'false');
  });
});
