// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4196 Stage 1 — the two key-routing sites in aiBackends.ts (filterChainForExplicitKey,
// generateTextWithSearch) must resolve `backend` from the REGISTRY, never an id-prefix guess.
// Each test uses a model id whose prefix DISAGREES with its registered backend — the exact
// shape of the bug class t/4087/t/4099/t/4101/t/4141 fixed elsewhere. A wrong value here sends
// a caller's key to the wrong provider, or picks the wrong branch (Gemini grounded search vs.
// Tavily+LLM) — not cosmetic. Mock scaffold mirrors aiBackendsFixedTemperature.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Two mismatches, each direction: an id prefixed 'claude' registered as 'gemini', and an id
// prefixed 'gemini' registered as 'claude'. inferBackend (the prefix table) would get both wrong.
const CLAUDE_LOOKALIKE = { id: 'claude-lookalike-t4196', apiModelId: 'claude-lookalike-t4196-api', label: 'Lookalike A', backend: 'gemini' }; // model-lint:allow-nonselect synthetic registry entry (t/4196)
const GEMINI_LOOKALIKE = { id: 'gemini-lookalike-t4196', apiModelId: 'gemini-lookalike-t4196-api', label: 'Lookalike B', backend: 'claude' }; // model-lint:allow-nonselect synthetic registry entry (t/4196)
const GEMINI_REAL = { id: 'gemini-flash-t4196', apiModelId: 'gemini-flash-t4196-api', label: 'Real gemini', backend: 'gemini' };

const REGISTRY_JSON = JSON.stringify({
  backends: [
    { id: 'gemini', label: 'Google Gemini' },
    { id: 'claude', label: 'Anthropic Claude' },
  ],
  models: [CLAUDE_LOOKALIKE, GEMINI_LOOKALIKE, GEMINI_REAL],
});

vi.mock('../ai/fsCache.js', () => ({
  readFileWithMtime: vi.fn(() => ({ content: REGISTRY_JSON, mtimeMs: 1 })),
}));

vi.mock('../config.js', async (importActual) => {
  const actual = await importActual<typeof import('../config.js')>();
  return {
    ...actual,
    getProjectRoot: vi.fn(() => '/fake-root'),
    getApiKey: vi.fn(async (backend: string) => (backend === 'tavily' ? 'fake-tavily-key' : 'fake-gemini-key')),
  };
});

vi.mock('../ai/keyRotator.js', () => ({
  callWithKeyRotation: vi.fn(async (_backend: string, keys: string[], fn: (key: string) => Promise<unknown>) => fn(keys[0])),
}));

const mockGeminiGroundedSearch = vi.hoisted(() => vi.fn());
const mockCallProvider = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/ai-client/index.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../../lib/ai-client/index.js')>();
  return {
    ...actual,
    withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()), // no retries — fast, deterministic
    geminiGroundedSearch: mockGeminiGroundedSearch,
    callProvider: mockCallProvider,
  };
});

const mockTavilySearch = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/search/tavily.js', () => ({
  tavilySearch: mockTavilySearch,
  buildSearchAugmentedPrompt: vi.fn((prompt: string) => ({ augmentedPrompt: prompt, searchQueries: [], citations: [] })),
}));

import { generateTextWithSearch, filterChainForExplicitKey, getModelRegistry } from '../ai/aiBackends.js';

beforeEach(() => {
  mockGeminiGroundedSearch.mockReset();
  mockGeminiGroundedSearch.mockResolvedValue({ text: 'ok' });
  mockCallProvider.mockReset();
  mockCallProvider.mockResolvedValue({ text: 'ok', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
  mockTavilySearch.mockReset();
  mockTavilySearch.mockResolvedValue({ answer: 'ok', results: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('generateTextWithSearch: backend is the registry value, not a prefix guess (t/4196)', () => {
  it("an id prefixed 'claude' but registered as 'gemini' takes the Gemini grounded-search branch, never Tavily", async () => {
    await generateTextWithSearch('prompt', 'claude-lookalike-t4196'); // model-lint:allow-nonselect synthetic registry entry (t/4196)
    expect(mockGeminiGroundedSearch).toHaveBeenCalledTimes(1);
    expect(mockTavilySearch).not.toHaveBeenCalled();
  });

  it("an id prefixed 'gemini' but registered as 'claude' takes the non-Gemini (Tavily) branch", async () => {
    await generateTextWithSearch('prompt', 'gemini-lookalike-t4196'); // model-lint:allow-nonselect synthetic registry entry (t/4196)
    expect(mockGeminiGroundedSearch).not.toHaveBeenCalled();
    expect(mockTavilySearch).toHaveBeenCalledTimes(1);
  });
});

describe('filterChainForExplicitKey: grouping is by registry backend, not id prefix (t/4196)', () => {
  it('with an explicit key, keeps the claude-prefixed-but-gemini-registered lookalike alongside the real gemini model, and drops the gemini-prefixed-but-claude-registered one', () => {
    const registry = getModelRegistry();
    const chain = [CLAUDE_LOOKALIKE.id, GEMINI_LOOKALIKE.id, GEMINI_REAL.id];
    const filtered = filterChainForExplicitKey(chain, true, registry);
    // A prefix-based (wrong) implementation would do the exact opposite of this.
    expect(filtered).toEqual([CLAUDE_LOOKALIKE.id, GEMINI_REAL.id]);
  });
});
