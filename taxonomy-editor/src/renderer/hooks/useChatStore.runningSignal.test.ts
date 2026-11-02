// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4690: registerRun must be called from the store-level run loop (generateOpening/sendMessage),
// exactly once per run, with the outcome the shell's RunToastHost depends on — 'done' on success,
// 'error' on a thrown failure, and 'aborted' as the default for every isStillValid() early-return
// path (the run was invalidated, not succeeded or failed). Per TL p/864#1 / t/4687#1/#3.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockApi, mockRegisterRun, mockFinishRun } = vi.hoisted(() => {
  const mockFinishRun = vi.fn();
  const mockRegisterRun = vi.fn().mockReturnValue(mockFinishRun);
  const mockApi = {
    listChatSessions: vi.fn().mockResolvedValue([]),
    loadChatSession: vi.fn(),
    saveChatSession: vi.fn().mockResolvedValue(undefined),
    deleteChatSession: vi.fn().mockResolvedValue(undefined),
    startChatStream: vi.fn(),
    onChatStreamChunk: vi.fn().mockReturnValue(() => {}),
    trackEvent: vi.fn(),
  };
  return { mockApi, mockRegisterRun, mockFinishRun };
});

vi.mock('@bridge', () => ({ api: mockApi }));

vi.mock('../navigation/runningSignal', () => ({
  registerRun: mockRegisterRun,
}));

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
  getGlobalRecorder: () => ({ record: vi.fn() }),
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

describe('useChatStore — running signal wiring (t/4690)', () => {
  afterEach(() => {
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

  it('generateOpening registers once and reports "done" on success', async () => {
    mockApi.startChatStream.mockResolvedValueOnce(
      JSON.stringify({ response: 'Opening reply', taxonomy_refs: [] }),
    );
    useChatStore.setState({ activeChatId: 'chat-1', activeChat: makeChatSession() as never });

    await useChatStore.getState().generateOpening();

    expect(mockRegisterRun).toHaveBeenCalledTimes(1);
    expect(mockRegisterRun).toHaveBeenCalledWith('chat', 'chat-1', 'Test topic');
    expect(mockFinishRun).toHaveBeenCalledTimes(1);
    expect(mockFinishRun).toHaveBeenCalledWith('done');
  });

  it('generateOpening reports "error" when the stream throws', async () => {
    mockApi.startChatStream.mockRejectedValueOnce(new Error('stream failed'));
    useChatStore.setState({ activeChatId: 'chat-1', activeChat: makeChatSession() as never });

    await useChatStore.getState().generateOpening();

    expect(mockFinishRun).toHaveBeenCalledTimes(1);
    expect(mockFinishRun).toHaveBeenCalledWith('error');
  });

  it('generateOpening reports "aborted" when the chat is no longer active once the stream resolves', async () => {
    let resolveStream: ((text: string) => void) | null = null;
    mockApi.startChatStream.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveStream = resolve; }),
    );
    useChatStore.setState({ activeChatId: 'chat-1', activeChat: makeChatSession() as never });

    const generating = useChatStore.getState().generateOpening();
    // Navigated away mid-stream: another chat becomes active before this one resolves.
    useChatStore.setState({ activeChatId: 'chat-2', activeChat: makeChatSession({ id: 'chat-2' }) as never });
    resolveStream!(JSON.stringify({ response: 'Late reply', taxonomy_refs: [] }));
    await generating;

    expect(mockFinishRun).toHaveBeenCalledTimes(1);
    expect(mockFinishRun).toHaveBeenCalledWith('aborted');
  });

  it('sendMessage registers once and reports "done" on success', async () => {
    mockApi.startChatStream.mockResolvedValueOnce(
      JSON.stringify({ response: 'Reply', taxonomy_refs: [] }),
    );
    useChatStore.setState({ activeChatId: 'chat-1', activeChat: makeChatSession() as never });

    await useChatStore.getState().sendMessage('hello');

    expect(mockRegisterRun).toHaveBeenCalledWith('chat', 'chat-1', 'Test topic');
    expect(mockFinishRun).toHaveBeenCalledWith('done');
  });

  it('sendMessage reports "error" when the stream throws', async () => {
    mockApi.startChatStream.mockRejectedValueOnce(new Error('stream failed'));
    useChatStore.setState({ activeChatId: 'chat-1', activeChat: makeChatSession() as never });

    await useChatStore.getState().sendMessage('hello');

    expect(mockFinishRun).toHaveBeenCalledWith('error');
  });
});
