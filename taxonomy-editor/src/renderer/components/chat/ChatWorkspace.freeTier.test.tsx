// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// t/1480: handleSend() must thread the locally-computed `freeTier` into the
// Gemini onboarding check so free-tier/anonymous sessions (which use the server
// key, not BYOK) are never prompted for a Gemini key. This guards the *wiring* —
// the hook's own free-tier short-circuit is covered in t/1478's scope.

const checkAndShow = vi.fn().mockResolvedValue(true);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tierValue: any;

vi.mock('../../hooks/useGeminiOnboarding', () => ({
  useGeminiOnboarding: () => ({ modalProps: { open: false, onClose: () => {} }, checkAndShow }),
}));

vi.mock('../../hooks/useTierInfo', () => ({
  useTierInfo: () => ({ tier: tierValue, usage: null, loading: false, refresh: vi.fn() }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isFreeTier: (t: any) => t?.level === 'free',
}));

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: {} }));

const mockSendMessage = vi.fn();

vi.mock('../../hooks/useChatStore', () => ({
  useChatStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      activeChat: {
        id: 'chat-1',
        title: 'Test Chat',
        mode: 'brainstorm',
        topic: 'AI Safety',
        pover: 'accelerationist',
        transcript: [
          { id: 'm1', speaker: 'accelerationist', content: 'Hello', taxonomy_refs: [], timestamp: '2026-01-01T00:00:00Z' },
        ],
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      chatLoading: false,
      chatError: null,
      chatGenerating: false,
      chatActivity: null,
      chatProgress: null,
      sendMessage: mockSendMessage,
      generateOpening: vi.fn(),
      changeMode: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: () => ({
    accelerationist: { nodes: [] },
    safetyist: { nodes: [] },
    skeptic: { nodes: [] },
    situations: { nodes: [] },
  }),
}));

vi.mock('../../hooks/useAuthStatus', () => ({
  useUserProfile: () => null,
}));

vi.mock('@bridge', () => ({
  api: {
    submitToCommunity: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: vi.fn() }),
}));

vi.mock('../../types/debate', () => ({
  POVER_INFO: {
    accelerationist: { label: 'Accelerationist', color: '#e74c3c' },
    safetyist: { label: 'Safetyist', color: '#2ecc71' },
    skeptic: { label: 'Skeptic', color: '#3498db' },
  },
}));

vi.mock('../../types/chat', () => ({
  CHAT_MODE_INFO: {
    brainstorm: { label: 'Brainstorm', description: 'Explore ideas freely' },
    inform: { label: 'Inform', description: 'Learn about a topic' },
    decide: { label: 'Decide', description: 'Work through a decision' },
  },
}));

vi.mock('@lib/debate/nodeIdUtils', () => ({
  nodePovFromId: () => 'accelerationist',
  nodeTypeFromId: () => 'pov',
}));

vi.mock('../taxonomy/NodeDetail', () => ({
  NodeDetail: () => <div data-testid="node-detail" />,
}));

vi.mock('../debate/SituationDetail', () => ({
  SituationDetail: () => <div data-testid="situation-detail" />,
}));

vi.mock('../shared/CommunityShareBanner', () => ({
  CommunityShareBanner: () => null,
}));

vi.mock('../settings/GeminiOnboardingModal', () => ({
  GeminiOnboardingModal: ({ open }: { open: boolean }) => (open ? <div data-testid="gemini-modal" /> : null),
}));

vi.mock('../settings/geminiOnboardingState', () => ({
  shouldShowGeminiOnboarding: () => true,
  clearSessionDismiss: () => {},
}));

const freeTierValue = {
  level: 'free',
  pinnedModel: 'gemini-flash',
  allowedBackends: ['gemini'],
  limits: { requestsPerMinute: 5, tokensPerDay: 100_000 },
};
const byokTierValue = {
  level: 'byok',
  pinnedModel: null,
  allowedBackends: ['gemini'],
  limits: { requestsPerMinute: 60, tokensPerDay: 1_000_000 },
};

const { ChatWorkspace } = await import('./ChatWorkspace');

describe('ChatWorkspace — free-tier Gemini onboarding (t/1480)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('passes freeTier=true into the onboarding check on a free-tier session (no BYOK prompt)', async () => {
    tierValue = freeTierValue;
    render(<ChatWorkspace />);

    const textarea = screen.getByPlaceholderText(/Ask the Accelerationist a follow-up/);
    await userEvent.type(textarea, 'test message');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(checkAndShow).toHaveBeenCalledWith({ freeTier: true }));
    expect(screen.queryByTestId('gemini-modal')).not.toBeInTheDocument();
  });

  it('passes freeTier=false on a non-free (BYOK) session so the check still runs', async () => {
    tierValue = byokTierValue;
    render(<ChatWorkspace />);

    const textarea = screen.getByPlaceholderText(/Ask the Accelerationist a follow-up/);
    await userEvent.type(textarea, 'test message');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(checkAndShow).toHaveBeenCalledWith({ freeTier: false }));
  });
});
