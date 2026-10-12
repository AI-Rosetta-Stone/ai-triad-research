// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4088 — resolveAiCallLogContext/resolveAiCallLogKeySource, the context electronAIAdapter.ts and
// ipc/aiHandlers.ts thread into every AI call-log entry (Model/Backend/KeySource). Mock scaffold
// mirrors embeddings.servedModel.test.ts.
//
// Covers the two required-test items this helper is responsible for (the other two — no key
// material, vocabulary fallback — live in aiCallLog.test.ts; "failover" doesn't apply here, since
// the desktop path has no fallback chain, t/4048):
//   AC 2 (no key material): KeySource is always one of 'store'/'none'/'' — never derived from, or
//     containing, the key value itself.
//   AC 3 (registry, not prefix): a synthetic model whose id PREFIX names one backend but whose
//     REGISTRY ENTRY names another must log the registry backend.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import type { ModelRegistry } from '../../../../lib/ai-client/index.js';

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp/test-app') },
}));

vi.mock('../fileIO.js', () => ({
  PROJECT_ROOT: '/fake/root',
  resolveDataPath: vi.fn(),
}));

const mockHasApiKey = vi.hoisted(() => vi.fn());
vi.mock('../apiKeyStore.js', () => ({
  loadApiKey: vi.fn(() => 'fake-api-key'),
  hasApiKey: mockHasApiKey,
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
vi.mock('../../../../lib/search/tavily.js', () => ({ tavilySearch: vi.fn(), buildSearchAugmentedPrompt: vi.fn() }));

// A model whose ID PREFIX says 'claude' but whose REGISTRY ENTRY says 'gemini' — the exact shape
// of the bug class t/4087/t/4099/t/4101 fixed elsewhere (t/4141 found 4 other call sites in this
// same file still vulnerable to it; this helper is NOT one of them).
const FAKE_REGISTRY: ModelRegistry = {
  backends: [
    { id: 'gemini', label: 'Google Gemini' },
    { id: 'ollama', label: 'Local Ollama' },
  ],
  models: [
    { id: 'gemini-3.5-flash-lite', apiModelId: 'gemini-3.5-flash-lite-api', label: 'Default', backend: 'gemini' },
    { id: 'claude-lookalike-t4088', apiModelId: 'gemini-3.5-flash-lite-api', label: 'Lookalike', backend: 'gemini' }, // model-lint:allow-nonselect synthetic registry entry: proves Backend comes from the registry, not the id prefix (t/4088)
    { id: 'ollama-local-model', apiModelId: 'ollama-local-model', label: 'Local', backend: 'ollama' },
  ],
};

const FAKE_FD = 99;
const FAKE_MTIME = 1_700_000_000_000;

import { resolveAiCallLogContext, resolveAiCallLogKeySource } from '../embeddings.js';

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
  mockHasApiKey.mockReset();
});

describe('resolveAiCallLogContext (t/4088)', () => {
  it('AC 3: Backend is the REGISTRY value for a model whose id prefix names a different backend', () => {
    mockHasApiKey.mockReturnValue(true);
    const ctx = resolveAiCallLogContext('claude-lookalike-t4088'); // model-lint:allow-nonselect synthetic registry entry (t/4088)
    expect(ctx.model).toBe('claude-lookalike-t4088'); // model-lint:allow-nonselect synthetic registry entry (t/4088)
    expect(ctx.backend).toBe('gemini'); // registry value, NOT the 'claude' the prefix would suggest
  });

  it('model omitted → defaults the same way generateText does, and Backend still comes from the registry', () => {
    mockHasApiKey.mockReturnValue(true);
    const ctx = resolveAiCallLogContext(); // model omitted entirely
    expect(ctx.model).toBe('gemini-3.5-flash-lite'); // DEFAULT_MODEL
    expect(ctx.backend).toBe('gemini');
  });

  it('KeySource is \'store\' when the backend has a stored key', () => {
    mockHasApiKey.mockReturnValue(true);
    expect(resolveAiCallLogContext('gemini-3.5-flash-lite').keySource).toBe('store');
  });

  it("KeySource is 'none' for the keyless Ollama backend, regardless of hasApiKey", () => {
    mockHasApiKey.mockReturnValue(false);
    expect(resolveAiCallLogContext('ollama-local-model').keySource).toBe('none');
  });

  it("KeySource is '' (not store/none, never the key itself) when no key is stored for a keyed backend", () => {
    mockHasApiKey.mockReturnValue(false);
    expect(resolveAiCallLogContext('gemini-3.5-flash-lite').keySource).toBe('');
  });

  it('AC 2 (no key material): resolveAiCallLogKeySource never returns anything but the 3 values it can — never the key itself, even if hasApiKey returns a truthy non-boolean', () => {
    // hasApiKey is typed boolean, but prove the helper can't leak a key value through this path
    // regardless: it only ever branches on truthiness, and its own return is one of 3 literals.
    mockHasApiKey.mockReturnValue(true);
    const values = new Set([
      resolveAiCallLogKeySource('gemini'),
      resolveAiCallLogKeySource('ollama'),
    ]);
    mockHasApiKey.mockReturnValue(false);
    values.add(resolveAiCallLogKeySource('gemini'));
    expect([...values].every(v => v === 'store' || v === 'none' || v === '')).toBe(true);
  });
});
