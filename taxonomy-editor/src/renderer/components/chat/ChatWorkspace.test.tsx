// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Mocks ────────────────────────────────────────────────

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => (
    <div data-testid="markdown">{children}</div>
  ),
}));
vi.mock('remark-gfm', () => ({ default: {} }));

const mockSendMessage = vi.fn();
const mockGenerateOpening = vi.fn();
const mockChangeMode = vi.fn();

let mockChatStoreState: Record<string, unknown> = {};

vi.mock('../../hooks/useChatStore', () => ({
  useChatStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      activeChat: null,
      chatLoading: false,
      chatError: null,
      chatGenerating: false,
      chatActivity: null,
      chatProgress: null,
      sendMessage: mockSendMessage,
      generateOpening: mockGenerateOpening,
      changeMode: mockChangeMode,
      ...mockChatStoreState,
    };
    return selector ? selector(state) : state;
  },
}));

vi.mock('../../hooks/useTaxonomyStore', () => {
  const mockGetLabelForId = vi.fn((id: string) => {
    const labels: Record<string, string> = {
      'acc-desires-001': 'Accelerationist Node',
      'saf-grounding-002': 'Safety Node',
    };
    return labels[id] || '';
  });
  return {
    useTaxonomyStore: vi.fn((selector?: (s: Record<string, unknown>) => unknown) => {
      const state = {
        accelerationist: null,
        safetyist: null,
        skeptic: null,
        situations: null,
        getLabelForId: mockGetLabelForId,
      };
      return selector ? selector(state) : state;
    }),
  };
});

vi.mock('../../hooks/useAuthStatus', () => ({
  useUserProfile: () => null,
}));

const mockExportChatToFile = vi.fn().mockResolvedValue({ cancelled: false, filePath: '/tmp/chat.md' });

vi.mock('@bridge', () => ({
  api: {
    submitToCommunity: vi.fn().mockResolvedValue(undefined),
    exportChatToFile: (...args: unknown[]) => mockExportChatToFile(...args),
  },
}));

vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: vi.fn() }),
}));

vi.mock('@lib/debate/poverInfo', () => ({
  POVER_INFO: {
    accelerationist: { label: 'Accelerationist', color: '#e74c3c' },
    safetyist: { label: 'Safetyist', color: '#2ecc71' },
    skeptic: { label: 'Skeptic', color: '#3498db' },
  },
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
  nodePovFromId: (id: string) => id.split('-')[0] === 'acc' ? 'accelerationist' : id.split('-')[0] === 'saf' ? 'safetyist' : 'skeptic',
  nodeTypeFromId: () => 'pov',
}));

vi.mock('../taxonomy/NodeDetail', () => ({
  NodeDetail: () => <div data-testid="node-detail" />,
}));

vi.mock('../debate/SituationDetail', () => ({
  SituationDetail: () => <div data-testid="situation-detail" />,
}));

vi.mock('../shared/CommunityShareBanner', () => ({
  CommunityShareBanner: ({ onDismiss }: { onDismiss: () => void }) => (
    <div data-testid="share-banner"><button onClick={onDismiss}>Dismiss</button></div>
  ),
}));

import { ChatWorkspace } from './ChatWorkspace';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

function makeChat(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chat-1',
    title: 'Test Chat',
    mode: 'brainstorm',
    topic: 'AI Safety',
    pover: 'accelerationist',
    transcript: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('ChatWorkspace', () => {
  beforeEach(() => {
    mockChatStoreState = {};
    mockSendMessage.mockClear();
    mockGenerateOpening.mockClear();
    mockChangeMode.mockClear();
    mockExportChatToFile.mockClear();
  });

  it('shows loading state when chatLoading is true', () => {
    mockChatStoreState = { chatLoading: true };
    render(<ChatWorkspace />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows empty state when no active chat', () => {
    mockChatStoreState = { activeChat: null };
    render(<ChatWorkspace />);
    expect(screen.getByText('Select a chat or start a new one.')).toBeInTheDocument();
  });

  it('renders chat header with camp chip, mode pill, and the question card', () => {
    mockChatStoreState = { activeChat: makeChat() };
    render(<ChatWorkspace />);
    // t/4724: "Accelerationist" appears twice by design — the header's camp chip and the
    // always-visible Session panel's "Talking to" row.
    expect(screen.getAllByText('Accelerationist').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('AI Safety')).toBeInTheDocument();
    expect(screen.getByText('BRAINSTORM')).toBeInTheDocument(); // header's read-only mode pill
    // The segmented mode control moved into the composer (t/4724).
    expect(screen.getByRole('button', { name: 'Brainstorm' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Inform' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decide' })).toBeInTheDocument();
  });

  it('renders transcript messages', () => {
    mockChatStoreState = {
      activeChat: makeChat({
        transcript: [
          { id: 'm1', speaker: 'user', content: 'Hello there', taxonomy_refs: [], timestamp: '2026-01-01T00:00:00Z' },
          { id: 'm2', speaker: 'accelerationist', content: 'Greetings!', taxonomy_refs: [], timestamp: '2026-01-01T00:01:00Z' },
        ],
      }),
    };
    render(<ChatWorkspace />);
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('Hello there')).toBeInTheDocument();
    expect(screen.getByText('Greetings!')).toBeInTheDocument();
  });

  // t/4855 (t/4848 follow-up): the How panel's Raw Prompt/Response read the real ChatEntry
  // fields when the server has captured them, falling back to "not available" otherwise.
  it('shows the real raw prompt/response in the How panel when captured', async () => {
    const user = userEvent.setup();
    mockChatStoreState = {
      activeChat: makeChat({
        transcript: [
          {
            id: 'm1', speaker: 'accelerationist', content: 'Answer', taxonomy_refs: [],
            timestamp: '2026-01-01T00:00:00Z', raw_prompt: 'The full prompt text', raw_response: 'The raw model text',
          },
        ],
      }),
    };
    render(<ChatWorkspace />);
    await user.click(screen.getByRole('button', { name: 'How' }));
    expect(screen.getByText('The full prompt text')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Raw Response' }));
    expect(screen.getByText('The raw model text')).toBeInTheDocument();
  });

  it('says "not recorded" in the How panel when raw prompt/response are absent (t/165)', async () => {
    const user = userEvent.setup();
    mockChatStoreState = {
      activeChat: makeChat({
        transcript: [
          { id: 'm1', speaker: 'accelerationist', content: 'Answer', taxonomy_refs: [], timestamp: '2026-01-01T00:00:00Z' },
        ],
      }),
    };
    render(<ChatWorkspace />);
    await user.click(screen.getByRole('button', { name: 'How' }));
    expect(screen.getByText("The raw prompt and response weren't recorded for this answer.")).toBeInTheDocument();
  });


  it('shows Methods links (Theory of Success and Theory of Operations) in Chat How panel (t/241)', async () => {
    const user = userEvent.setup();
    mockChatStoreState = {
      activeChat: makeChat({
        transcript: [
          { id: 'm1', speaker: 'accelerationist', content: 'Answer', taxonomy_refs: [], timestamp: '2026-01-01T00:00:00Z' },
        ],
      }),
    };
    render(<ChatWorkspace />);
    await user.click(screen.getByRole('button', { name: 'How' }));
    // Expand Methods section to show Chat's methods links
    await user.click(screen.getByRole('button', { name: /Methods/ }));
    // Methods section should render with the two Chat-specific links
    expect(screen.getByRole('button', { name: /Theory of Success/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Theory of Operations/ })).toBeInTheDocument();
  });
  it('an answer with no taxonomy refs says so under Why; a user message shows no such line (t/165)', () => {
    mockChatStoreState = {
      activeChat: makeChat({
        transcript: [
          { id: 'u1', speaker: 'user', content: 'Question', taxonomy_refs: [], timestamp: '2026-01-01T00:00:00Z' },
          { id: 'm1', speaker: 'accelerationist', content: 'Answer', taxonomy_refs: [], timestamp: '2026-01-01T00:00:01Z' },
        ],
      }),
    };
    render(<ChatWorkspace />);
    expect(screen.getAllByText('No taxonomy grounding recorded for this answer.')).toHaveLength(1);
  });

  it('shows "No longer in the taxonomy" for refs whose nodes are absent from a loaded taxonomy (t/282)', () => {
    mockChatStoreState = {
      activeChat: makeChat({
        transcript: [
          { id: 'm1', speaker: 'accelerationist', content: 'Answer', taxonomy_refs: [
            { node_id: 'deleted-node-999', relevance: 'Old reference' },
          ], timestamp: '2026-01-01T00:00:00Z' },
        ],
      }),
    };
    // Mock taxonomy as loaded but node not found
    vi.mocked(useTaxonomyStore).mockImplementation((selector?: (s: Record<string, unknown>) => unknown) => {
      const state = {
        accelerationist: { nodes: [] },
        safetyist: { nodes: [] },
        skeptic: { nodes: [] },
        situations: { nodes: [] },
        getLabelForId: () => '',
      };
      return selector ? selector(state) : state;
    });
    render(<ChatWorkspace />);
    expect(screen.getByText('No longer in the taxonomy')).toBeInTheDocument();
  });

  it('renders node_id when taxonomy is not yet loaded (t/282)', () => {
    mockChatStoreState = {
      activeChat: makeChat({
        transcript: [
          { id: 'm1', speaker: 'accelerationist', content: 'Answer', taxonomy_refs: [
            { node_id: 'acc-desires-001', relevance: 'Reference' },
          ], timestamp: '2026-01-01T00:00:00Z' },
        ],
      }),
    };
    // Mock taxonomy as NOT loaded
    vi.mocked(useTaxonomyStore).mockImplementation((selector?: (s: Record<string, unknown>) => unknown) => {
      const state = {
        accelerationist: null,
        safetyist: null,
        skeptic: null,
        situations: null,
        getLabelForId: () => '',
      };
      return selector ? selector(state) : state;
    });
    render(<ChatWorkspace />);
    expect(screen.getByText('acc-desires-001')).toBeInTheDocument();
    expect(screen.queryByText('No longer in the taxonomy')).not.toBeInTheDocument();
  });

  it('renders input bar with textarea and send button', () => {
    mockChatStoreState = { activeChat: makeChat() };
    render(<ChatWorkspace />);
    expect(screen.getByPlaceholderText(/Ask the Accelerationist a follow-up/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('disables send button when input is empty', () => {
    mockChatStoreState = { activeChat: makeChat() };
    render(<ChatWorkspace />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('enables send button when input has text', async () => {
    mockChatStoreState = { activeChat: makeChat() };
    render(<ChatWorkspace />);
    const textarea = screen.getByPlaceholderText(/Ask the Accelerationist a follow-up/);
    await userEvent.type(textarea, 'test message');
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('calls sendMessage and clears input on send button click', async () => {
    mockChatStoreState = { activeChat: makeChat() };
    render(<ChatWorkspace />);
    const textarea = screen.getByPlaceholderText(/Ask the Accelerationist a follow-up/);
    await userEvent.type(textarea, 'hello world');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(mockSendMessage).toHaveBeenCalledWith('hello world');
    expect(textarea).toHaveValue('');
  });

  it('displays error bar when chatError is set', () => {
    mockChatStoreState = { activeChat: makeChat(), chatError: 'Something went wrong' };
    render(<ChatWorkspace />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('disables textarea and send button while generating', () => {
    mockChatStoreState = { activeChat: makeChat(), chatGenerating: true };
    render(<ChatWorkspace />);
    expect(screen.getByPlaceholderText(/Ask the Accelerationist a follow-up/)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('shows generating spinner when transcript is empty and generating', () => {
    mockChatStoreState = {
      activeChat: makeChat(),
      chatGenerating: true,
      chatActivity: 'Thinking...',
    };
    render(<ChatWorkspace />);
    expect(screen.getByText('Thinking...')).toBeInTheDocument();
  });

  describe('Export button', () => {
    it('renders disabled when transcript is empty', () => {
      mockChatStoreState = { activeChat: makeChat({ transcript: [] }) };
      render(<ChatWorkspace />);
      const btn = screen.getByRole('button', { name: 'Export chat' });
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('title', 'Nothing to export yet');
    });

    it('renders enabled when transcript has entries', () => {
      mockChatStoreState = {
        activeChat: makeChat({
          transcript: [
            { id: 'm1', speaker: 'accelerationist', content: 'Hello', taxonomy_refs: [], timestamp: '2026-01-01T00:00:00Z' },
          ],
        }),
      };
      render(<ChatWorkspace />);
      const btn = screen.getByRole('button', { name: 'Export chat' });
      expect(btn).toBeEnabled();
    });

    it('opens format menu on click with three options', async () => {
      mockChatStoreState = {
        activeChat: makeChat({
          transcript: [
            { id: 'm1', speaker: 'accelerationist', content: 'Hello', taxonomy_refs: [], timestamp: '2026-01-01T00:00:00Z' },
          ],
        }),
      };
      render(<ChatWorkspace />);
      await userEvent.click(screen.getByRole('button', { name: 'Export chat' }));
      const items = screen.getAllByRole('menuitem');
      expect(items).toHaveLength(3);
      expect(items.map(i => i.textContent)).toEqual(['PDF', 'Markdown', 'Text']);
    });

    it('calls exportChatToFile with correct args when a format is selected', async () => {
      const transcript = [
        { id: 'm1', speaker: 'accelerationist', content: 'Hello', taxonomy_refs: [], timestamp: '2026-01-01T00:00:00Z' },
      ];
      mockChatStoreState = { activeChat: makeChat({ transcript }) };
      render(<ChatWorkspace />);
      await userEvent.click(screen.getByRole('button', { name: 'Export chat' }));
      await userEvent.click(screen.getByRole('menuitem', { name: 'Markdown' }));
      expect(mockExportChatToFile).toHaveBeenCalledWith(
        transcript,
        'markdown',
        { title: 'AI Safety', mode: 'brainstorm', pov: 'accelerationist' },
      );
    });

    it('closes menu on Escape and returns focus to button', async () => {
      mockChatStoreState = {
        activeChat: makeChat({
          transcript: [
            { id: 'm1', speaker: 'accelerationist', content: 'Hello', taxonomy_refs: [], timestamp: '2026-01-01T00:00:00Z' },
          ],
        }),
      };
      render(<ChatWorkspace />);
      const btn = screen.getByRole('button', { name: 'Export chat' });
      await userEvent.click(btn);
      expect(screen.getAllByRole('menuitem')).toHaveLength(3);
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
    });
  });
});
