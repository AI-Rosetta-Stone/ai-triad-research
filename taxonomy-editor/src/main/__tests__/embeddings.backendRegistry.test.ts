// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4141 — generateText, generateChatStream and generateTextWithSearch must resolve `backend`
// from the REGISTRY, never an id-prefix guess. Each one passes resolveBackend's model id to a
// registry entry whose backend DISAGREES with what the id's prefix would suggest — the exact
// shape of the bug class t/4087/t/4099/t/4101 fixed elsewhere in the repo. `backend` isn't
// cosmetic here: it picks which backend's key is loaded (loadApiKey(backend)) and which provider
// receives the request, so a wrong value is a real key-routing/request-routing bug, not forensics.
//
// Mock scaffold mirrors embeddings.servedModel.test.ts.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import type { ModelRegistry } from '../../../../lib/ai-client/index.js';

const mockNetFetch = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({
  net: { fetch: mockNetFetch },
  app: { getPath: vi.fn(() => '/tmp/test-app') },
}));

vi.mock('../fileIO.js', () => ({
  PROJECT_ROOT: '/fake/root',
  resolveDataPath: vi.fn(),
}));

const mockLoadApiKey = vi.hoisted(() => vi.fn(() => 'fake-api-key'));
vi.mock('../apiKeyStore.js', () => ({
  loadApiKey: mockLoadApiKey,
  hasApiKey: vi.fn(() => true),
}));

vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: vi.fn(() => null),
  setGlobalRecorder: vi.fn(),
}));

vi.mock('../../../../lib/embeddings/onnxEmbedding.js', () => ({
  tryWarmup: vi.fn(), computeEmbedding: vi.fn(), computeEmbeddings: vi.fn(),
  getExecutionProvider: vi.fn(), dispose: vi.fn(),
}));
vi.mock('../../../../lib/embeddings/embeddingResolver.js', () => ({ resolveEmbeddings: vi.fn() }));
vi.mock('../../../../lib/electron-shared/embeddingIO.js', () => ({
  createEmbeddingIO: vi.fn(() => ({ read: vi.fn(), write: vi.fn(), invalidateCache: vi.fn() })),
}));

const mockTavilySearch = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/search/tavily.js', () => ({
  tavilySearch: mockTavilySearch,
  buildSearchAugmentedPrompt: vi.fn((prompt: string) => ({ augmentedPrompt: prompt, searchQueries: [], citations: [] })),
}));

const mockCallProvider = vi.hoisted(() => vi.fn());
const mockGenerateViaGeminiStream = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/ai-client/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/ai-client/index.js')>();
  return {
    ...actual,
    callProvider: mockCallProvider,
    withRetry: actual.withRetry,
    generateViaDeepSeekStream: vi.fn(),
    generateViaGeminiStream: mockGenerateViaGeminiStream,
  };
});

// Two mismatches, each direction: an id prefixed 'claude' registered as 'gemini', and an id
// prefixed 'gemini' registered as 'claude'. inferBackend (the prefix table) would get both wrong.
const FAKE_REGISTRY: ModelRegistry = {
  backends: [
    { id: 'gemini', label: 'Google Gemini' },
    { id: 'claude', label: 'Anthropic Claude' },
  ],
  models: [
    { id: 'claude-lookalike-t4141', apiModelId: 'claude-lookalike-t4141-api', label: 'Lookalike A', backend: 'gemini' }, // model-lint:allow-nonselect synthetic registry entry: proves Backend comes from the registry, not the id prefix (t/4141)
    { id: 'gemini-lookalike-t4141', apiModelId: 'gemini-lookalike-t4141-api', label: 'Lookalike B', backend: 'claude' }, // model-lint:allow-nonselect synthetic registry entry (t/4141)
  ],
};

const FAKE_FD = 99;
const FAKE_MTIME = 1_700_000_000_000;

import { generateText, generateChatStream, generateTextWithSearch } from '../embeddings.js';

beforeAll(() => {
  vi.spyOn(fs, 'existsSync').mockReturnValue(false);
  vi.spyOn(fs, 'openSync').mockReturnValue(FAKE_FD as ReturnType<typeof fs.openSync>);
  vi.spyOn(fs, 'fstatSync').mockReturnValue({ mtimeMs: FAKE_MTIME } as unknown as fs.Stats);
  vi.spyOn(fs, 'readFileSync').mockImplementation(
    ((fdOrPath: unknown) =>
      fdOrPath === FAKE_FD ? JSON.stringify(FAKE_REGISTRY) : '') as typeof fs.readFileSync,
  );
  vi.spyOn(fs, 'closeSync').mockImplementation((() => {}) as typeof fs.closeSync);
});

beforeEach(() => {
  mockCallProvider.mockReset();
  mockCallProvider.mockResolvedValue({ text: 'ok' });
  mockGenerateViaGeminiStream.mockReset();
  mockGenerateViaGeminiStream.mockResolvedValue({ text: 'ok' });
  mockLoadApiKey.mockClear();
  mockTavilySearch.mockReset();
});

describe('generateText: backend is the registry value, not a prefix guess (t/4141)', () => {
  it("an id prefixed 'claude' but registered as 'gemini' loads a gemini key and calls the gemini-registered provider", async () => {
    await generateText('prompt', 'claude-lookalike-t4141'); // model-lint:allow-nonselect synthetic registry entry (t/4141)
    expect(mockLoadApiKey).toHaveBeenCalledWith('gemini');
    expect(mockCallProvider.mock.calls[0]?.[1]).toBe('gemini'); // callProvider(fetch, backend, ...)
  });

  it("an id prefixed 'gemini' but registered as 'claude' loads a claude key and calls the claude-registered provider", async () => {
    await generateText('prompt', 'gemini-lookalike-t4141'); // model-lint:allow-nonselect synthetic registry entry (t/4141)
    expect(mockLoadApiKey).toHaveBeenCalledWith('claude');
    expect(mockCallProvider.mock.calls[0]?.[1]).toBe('claude');
  });
});

describe('generateChatStream: backend is the registry value, not a prefix guess (t/4141)', () => {
  it("an id prefixed 'claude' but registered as 'gemini' takes the gemini stream path, not the generic provider path", async () => {
    await generateChatStream('system', [{ role: 'user', content: 'hi' }], () => {}, 'claude-lookalike-t4141'); // model-lint:allow-nonselect synthetic registry entry (t/4141)
    expect(mockLoadApiKey).toHaveBeenCalledWith('gemini');
    expect(mockGenerateViaGeminiStream).toHaveBeenCalledTimes(1);
    expect(mockCallProvider).not.toHaveBeenCalled();
  });

  it("an id prefixed 'gemini' but registered as 'claude' takes the generic provider path with backend 'claude'", async () => {
    await generateChatStream('system', [{ role: 'user', content: 'hi' }], () => {}, 'gemini-lookalike-t4141'); // model-lint:allow-nonselect synthetic registry entry (t/4141)
    expect(mockLoadApiKey).toHaveBeenCalledWith('claude');
    expect(mockGenerateViaGeminiStream).not.toHaveBeenCalled();
    expect(mockCallProvider.mock.calls[0]?.[1]).toBe('claude');
  });
});

describe('generateTextWithSearch: backend is the registry value, not a prefix guess (t/4141)', () => {
  it("an id prefixed 'claude' but registered as 'gemini' takes the Gemini grounded-search branch, never Tavily", async () => {
    mockNetFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }),
    });
    await generateTextWithSearch('prompt', 'claude-lookalike-t4141'); // model-lint:allow-nonselect synthetic registry entry (t/4141)
    expect(mockLoadApiKey).toHaveBeenCalledWith('gemini');
    expect(mockTavilySearch).not.toHaveBeenCalled();
  });

  it("an id prefixed 'gemini' but registered as 'claude' takes the non-Gemini (Tavily/generateText) branch", async () => {
    mockLoadApiKey.mockImplementation((backend?: string) => (backend === 'tavily' ? 'fake-tavily-key' : 'fake-api-key'));
    mockTavilySearch.mockResolvedValue({ answer: 'ok', results: [] });
    await generateTextWithSearch('prompt', 'gemini-lookalike-t4141'); // model-lint:allow-nonselect synthetic registry entry (t/4141)
    expect(mockTavilySearch).toHaveBeenCalledTimes(1);
  });
});
