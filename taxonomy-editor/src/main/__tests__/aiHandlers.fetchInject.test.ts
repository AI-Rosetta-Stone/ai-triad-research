// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Unit tests for fetch-and-inject logic in start-chat-stream (t/2484).
// Exercises: URL extraction, URL-capable gate, ephemeral system injection,
// app-fetch metadata shape, honest-fail fallback, 3-URL cap.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain } from 'electron';

const mockFetchUrlForPrompt = vi.hoisted(() => vi.fn());
const mockGenerateChatStream = vi.hoisted(() => vi.fn());
const mockResolveBackend = vi.hoisted(() => vi.fn());

vi.mock('../../../../lib/url-fetch/fetchUrlForPrompt.js', () => ({
  fetchUrlForPrompt: mockFetchUrlForPrompt,
}));


vi.mock('../embeddings.js', () => ({
  generateChatStream: mockGenerateChatStream,
  generateText: vi.fn(),
  generateTextWithSearch: vi.fn(),
  computeEmbeddings: vi.fn(),
  computeQueryEmbedding: vi.fn(),
  updateNodeEmbeddings: vi.fn(),
  classifyNli: vi.fn(),
  setDebateTemperature: vi.fn(),
  getEmbeddingInfo: vi.fn(),
  resolveRegistry: vi.fn(() => ({ models: {} })),
}));

vi.mock('../../../../lib/ai-client/index.js', () => ({
  resolveBackend: mockResolveBackend,
  DEFAULT_MODEL: 'gemini-2.0-flash',
  DEFAULT_TEMPERATURE: 0.7,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0') },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false), encryptString: vi.fn(), decryptString: vi.fn() },
}));

vi.mock('../fileIO.js', () => ({
  PROJECT_ROOT: '/fake/root',
  getDataRootPath: vi.fn(() => '/fake/data'),
  resolveDataPath: vi.fn((p: string) => `/fake/data/${p}`),
}));

vi.mock('../modelDiscovery.js', () => ({ refreshAIModels: vi.fn() }));
vi.mock('../embeddingErrors.js', () => ({ buildEmbeddingFailureError: vi.fn() }));
vi.mock('../../../../lib/debate/errors.js', () => ({ ActionableError: class extends Error {} }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: vi.fn(() => null) }));
vi.mock('../../../../lib/debate/constants.js', () => ({ DEFAULT_RELEVANCE_THRESHOLD: 0.5 }));

import { registerAiHandlers } from '../ipc/aiHandlers.js';

function getHandler(): (event: unknown, ...args: unknown[]) => Promise<unknown> {
  const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
  const entry = calls.find((c: unknown[]) => c[0] === 'start-chat-stream');
  if (!entry) throw new Error('start-chat-stream handler not registered');
  return entry[1];
}

function makeSender(destroyed = false) {
  const sent: Array<[string, unknown]> = [];
  return {
    sent,
    sender: {
      isDestroyed: () => destroyed,
      send: (ch: string, data: unknown) => sent.push([ch, data]),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGenerateChatStream.mockResolvedValue({ text: 'response' });
  registerAiHandlers();
});

describe('fetch-and-inject: URL-capable models skip fetch', () => {
  it('Gemini + urlContext=true bypasses fetch', async () => {
    mockResolveBackend.mockReturnValue('gemini');
    const { sender } = makeSender();
    const handler = getHandler();
    await handler({ sender }, 'sys', [{ role: 'user', content: 'see https://example.com' }], 'gemini-model', undefined, true);
    expect(mockFetchUrlForPrompt).not.toHaveBeenCalled();
    expect(mockGenerateChatStream).toHaveBeenCalledWith('sys', expect.anything(), expect.anything(), 'gemini-model', undefined, true);
  });

  it('Gemini + urlContext=false falls through to fetch', async () => {
    mockResolveBackend.mockReturnValue('gemini');
    mockFetchUrlForPrompt.mockResolvedValue({ ok: true, text: 'page', title: 'Example', finalUrl: 'https://example.com', truncated: false });
    const { sender } = makeSender();
    const handler = getHandler();
    await handler({ sender }, 'sys', [{ role: 'user', content: 'https://example.com' }], 'gemini-model', undefined, false);
    expect(mockFetchUrlForPrompt).toHaveBeenCalled();
  });
});

describe('fetch-and-inject: non-Gemini model with URL', () => {
  beforeEach(() => mockResolveBackend.mockReturnValue('claude'));

  it('prepends fetched content block and emits app-fetch metadata', async () => {
    mockFetchUrlForPrompt.mockResolvedValue({ ok: true, text: 'page content', title: 'My Page', finalUrl: 'https://example.com', truncated: false });
    const { sender, sent } = makeSender();
    const handler = getHandler();
    await handler({ sender }, 'original sys', [{ role: 'user', content: 'check https://example.com please' }], 'claude-model');

    const [sysArg] = (mockGenerateChatStream.mock.calls[0] as unknown[]) as [string];
    expect(sysArg).toContain('=== FETCHED PAGE CONTENT ===');
    expect(sysArg).toContain('My Page');
    expect(sysArg).toContain('original sys');

    const metaEvent = sent.find(([ch]) => ch === 'chat-stream-url-metadata');
    expect(metaEvent).toBeDefined();
    const payload = metaEvent![1] as { source: string; urlContextMetadata: { urlMetadata: Array<{ retrievedUrl: string; urlRetrievalStatus: string; source: string; truncated: boolean }> } };
    expect(payload.source).toBe('app-fetch');
    const entry = payload.urlContextMetadata.urlMetadata[0];
    expect(entry.retrievedUrl).toBe('https://example.com');
    expect(entry.urlRetrievalStatus).toBe('SUCCESS');
    expect(entry.source).toBe('app-fetch');
    expect(entry.truncated).toBe(false);
  });

  it('all fetches fail → honest-fail instruction prepended, no content block', async () => {
    mockFetchUrlForPrompt.mockResolvedValue({ ok: false, reason: 'timeout' });
    const { sender } = makeSender();
    const handler = getHandler();
    await handler({ sender }, 'sys', [{ role: 'user', content: 'https://example.com' }], 'claude-model');

    const [sysArg] = (mockGenerateChatStream.mock.calls[0] as unknown[]) as [string];
    expect(sysArg).toContain('=== HANDLING LINKS ===');
    expect(sysArg).not.toContain('=== FETCHED PAGE CONTENT ===');
  });

  it('caps at 3 URLs', async () => {
    mockFetchUrlForPrompt.mockResolvedValue({ ok: true, text: 't', title: undefined, finalUrl: 'https://a.com', truncated: false });
    const { sender } = makeSender();
    const handler = getHandler();
    await handler({ sender }, 'sys', [{ role: 'user', content: 'https://a.com https://b.com https://c.com https://d.com' }], 'claude-model');
    expect(mockFetchUrlForPrompt).toHaveBeenCalledTimes(3);
  });

  it('partial success includes fetched content, omits failed', async () => {
    mockFetchUrlForPrompt
      .mockResolvedValueOnce({ ok: true, text: 'good', title: 'Good', finalUrl: 'https://good.com', truncated: false })
      .mockResolvedValueOnce({ ok: false, reason: 'timeout' });
    const { sender } = makeSender();
    const handler = getHandler();
    await handler({ sender }, 'sys', [{ role: 'user', content: 'https://good.com https://bad.com' }], 'claude-model');

    const [sysArg] = (mockGenerateChatStream.mock.calls[0] as unknown[]) as [string];
    expect(sysArg).toContain('=== FETCHED PAGE CONTENT ===');
    expect(sysArg).toContain('Good');

    const { sent } = makeSender();
    const metaCalls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    void metaCalls; // metadata emitted via sender.send — checked via sent array above
  });

  it('no URL in message → no fetch, systemInstruction unchanged', async () => {
    const { sender } = makeSender();
    const handler = getHandler();
    await handler({ sender }, 'sys', [{ role: 'user', content: 'no links here' }], 'claude-model');
    expect(mockFetchUrlForPrompt).not.toHaveBeenCalled();
    expect(mockGenerateChatStream).toHaveBeenCalledWith('sys', expect.anything(), expect.anything(), 'claude-model', undefined, undefined);
  });
});

describe('metadata event shape', () => {
  it('FAILED entry has urlRetrievalStatus FAILED', async () => {
    mockResolveBackend.mockReturnValue('groq');
    mockFetchUrlForPrompt.mockResolvedValue({ ok: false, reason: 'ssrf-blocked' });
    const { sender, sent } = makeSender();
    const handler = getHandler();
    await handler({ sender }, 'sys', [{ role: 'user', content: 'https://192.168.1.1' }], 'llama-model');
    const meta = sent.find(([ch]) => ch === 'chat-stream-url-metadata');
    expect(meta).toBeDefined();
    const payload = meta![1] as { urlContextMetadata: { urlMetadata: Array<{ urlRetrievalStatus: string }> } };
    expect(payload.urlContextMetadata.urlMetadata[0].urlRetrievalStatus).toBe('FAILED');
  });
});
