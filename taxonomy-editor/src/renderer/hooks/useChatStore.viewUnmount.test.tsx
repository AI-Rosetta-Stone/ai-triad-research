// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4687 (precondition for t/4685 option C — items open in place): a running chat must keep
// generating, and land its response in the store, when the item view unmounts (rail switch, or
// navigating to another tool) and is later reopened. Exercises the real useChatStore module (not
// mocked, mirroring useChatStore.test.ts) through an actual React mount/unmount boundary, since
// the risk is specifically whether anything tied to the view's lifecycle (an effect cleanup, a
// stale closure) interrupts the store's in-flight stream — a pure store-call test wouldn't see
// that, because the store is a module-level singleton independent of any one subscriber.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const { mockApi, mockRecord } = vi.hoisted(() => {
  const mockRecord = vi.fn();
  const mockApi = {
    listChatSessions: vi.fn().mockResolvedValue([]),
    loadChatSession: vi.fn(),
    saveChatSession: vi.fn().mockResolvedValue(undefined),
    deleteChatSession: vi.fn().mockResolvedValue(undefined),
    startChatStream: vi.fn(),
    onChatStreamChunk: vi.fn().mockReturnValue(() => {}),
    trackEvent: vi.fn(),
  };
  return { mockApi, mockRecord };
});

vi.mock('@bridge', () => ({ api: mockApi }));

vi.mock('./useTaxonomyStore', () => ({
  useTaxonomyStore: {
    getState: () => ({
      accelerationist: { nodes: [] },
      safetyist: { nodes: [] },
      skeptic: { nodes: [] },
      situations: { nodes: [] },
      aiBackend: 'gemini',
      geminiModel: 'gemini-flash-lite-latest',
      getLabelForId: () => 'resolved-label',
    }),
  },
  MODELS_BY_BACKEND: { gemini: [{ value: 'gemini-flash-lite-latest', label: 'Flash Lite' }] },
  getStoredModel: () => 'gemini-flash-lite-latest',
  backendForModel: () => 'gemini',
}));

vi.mock('../utils/taxonomyContext', () => ({
  formatTaxonomyContext: vi.fn().mockReturnValue('mock-taxonomy-context'),
}));

vi.mock('../utils/errorMessages', () => ({
  mapErrorToUserMessage: (err: unknown) => err instanceof Error ? err.message : String(err),
}));

vi.mock('../prompts/chat', () => ({
  chatSystemPrompt: vi.fn().mockReturnValue('system-prompt'),
  chatOpeningPrompt: vi.fn().mockReturnValue('opening-prompt'),
  chatContinuationPrompt: vi.fn().mockReturnValue('continuation-prompt'),
  CHAT_MODE_TEMPERATURE: { brainstorm: 0.9, inform: 0.3, decide: 0.5 },
}));

vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: mockRecord }),
}));

import { useChatStore } from './useChatStore';

function makeChatSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chat-1',
    title: 'Test Chat',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    mode: 'brainstorm',
    topic: 'Test topic',
    pover: 'accelerationist',
    transcript: [],
    ...overrides,
  };
}

/** Stands in for the "item view" (ChatWorkspace, mounted only while Chat is the active tool) —
 *  a real subscriber to the real store, so an unmount genuinely drops the only component
 *  reading chat state, the same as switching the rail to another tool would. */
function ChatItemView() {
  const activeChat = useChatStore(s => s.activeChat);
  return <div data-testid="transcript">{JSON.stringify(activeChat?.transcript ?? [])}</div>;
}

describe('useChatStore — surviving a view unmount mid-generation (t/4687)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  beforeEach(() => {
    useChatStore.setState({
      sessions: [],
      sessionsLoading: false,
      activeChatId: null,
      activeChat: null,
      chatLoading: false,
      chatGenerating: false,
      chatError: null,
      chatStreamingText: null,
      chatActivity: null,
      chatModel: null,
    });
  });

  it('a stream started while the view is mounted lands its full response after the view unmounts and remounts, with no duplicate request', async () => {
    let resolveStream: ((text: string) => void) | null = null;
    mockApi.startChatStream.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveStream = resolve; }),
    );

    useChatStore.setState({
      activeChatId: 'chat-1',
      activeChat: makeChatSession() as never,
    });

    const { unmount } = render(<ChatItemView />);

    // Start generation while the view is mounted (e.g. the user just sent a message).
    const generating = useChatStore.getState().generateOpening();
    expect(mockApi.startChatStream).toHaveBeenCalledTimes(1);

    // Rail switch: the item view unmounts while the stream is still in flight.
    unmount();
    expect(useChatStore.getState().chatGenerating).toBe(true);

    // The model finishes responding while nothing is subscribed to the store.
    resolveStream!(JSON.stringify({ response: 'Full reply after navigating away', taxonomy_refs: [] }));
    await generating;

    // The response landed in the store even with no view mounted to receive it.
    const stateAfterResolve = useChatStore.getState();
    expect(stateAfterResolve.chatGenerating).toBe(false);
    expect(stateAfterResolve.activeChat!.transcript).toHaveLength(1);
    expect(stateAfterResolve.activeChat!.transcript[0].content).toBe('Full reply after navigating away');
    expect(mockApi.saveChatSession).toHaveBeenCalledTimes(1);

    // Reopening (rail switch back) remounts the view as a fresh instance; it just re-subscribes,
    // no reload triggered, no second stream request, and the full response is visible.
    const { getByTestId } = render(<ChatItemView />);
    expect(mockApi.startChatStream).toHaveBeenCalledTimes(1);
    expect(mockApi.loadChatSession).not.toHaveBeenCalled();
    expect(getByTestId('transcript').textContent).toContain('Full reply after navigating away');
  });
});
