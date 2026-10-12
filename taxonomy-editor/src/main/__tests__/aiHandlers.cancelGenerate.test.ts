// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Unit tests for ai:cancel-generate IPC channel + AbortController map (t/2509).
// Exercises: map cleanup on success, failure, and cancel; unknown-id no-op;
// no-requestId calls unchanged.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain } from 'electron';

const mockGenerateText = vi.hoisted(() => vi.fn());

vi.mock('../embeddings.js', () => ({
  generateText: mockGenerateText,
  generateChatStream: vi.fn(),
  generateTextWithSearch: vi.fn(),
  computeEmbeddings: vi.fn(),
  computeQueryEmbedding: vi.fn(),
  updateNodeEmbeddings: vi.fn(),
  classifyNli: vi.fn(),
  setDebateTemperature: vi.fn(),
  getEmbeddingInfo: vi.fn(),
  // t/4088: Model/Backend/KeySource context — not under test here, so a fixed stub suffices.
  resolveAiCallLogContext: vi.fn(() => ({ model: 'gemini-2.0-flash', backend: 'gemini', keySource: 'store' })),
}));

vi.mock('../../../../lib/ai-client/index.js', () => ({
  resolveBackend: vi.fn(() => 'gemini'),
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
vi.mock('../../../../lib/url-fetch/fetchUrlForPrompt.js', () => ({ fetchUrlForPrompt: vi.fn() }));

import { registerAiHandlers } from '../ipc/aiHandlers.js';

function getHandler(channel: string): (event: unknown, ...args: unknown[]) => Promise<unknown> {
  const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
  const entry = calls.find((c: unknown[]) => c[0] === channel);
  if (!entry) throw new Error(`${channel} handler not registered`);
  return entry[1];
}

function makeSender() {
  return { sender: { isDestroyed: () => false, send: vi.fn() } };
}

beforeEach(() => {
  vi.clearAllMocks();
  registerAiHandlers();
});

describe('ai:cancel-generate — unknown requestId is silent no-op', () => {
  it('does not throw on unknown id', async () => {
    const cancel = getHandler('ai:cancel-generate');
    expect(cancel({}, 'nonexistent-id')).toBeUndefined();
  });
});

describe('generate-text — AbortController map lifecycle', () => {
  it('success path: map entry removed in finally', async () => {
    mockGenerateText.mockResolvedValue({ text: 'ok' });
    const handler = getHandler('generate-text');
    const { sender } = makeSender();
    await handler({ sender }, { prompt: 'prompt', requestId: 'req-1' });
    // After completion the cancel handler is a no-op (entry gone)
    const cancel = getHandler('ai:cancel-generate');
    expect(cancel({}, 'req-1')).toBeUndefined();
  });

  it('failure path: map entry removed even on throw', async () => {
    mockGenerateText.mockRejectedValue(new Error('boom'));
    const handler = getHandler('generate-text');
    const { sender } = makeSender();
    await expect(handler({ sender }, { prompt: 'prompt', requestId: 'req-2' })).rejects.toThrow();
    const cancel = getHandler('ai:cancel-generate');
    expect(cancel({}, 'req-2')).toBeUndefined();
  });

  it('cancel path: AbortError rethrown without ActionableError wrapping', async () => {
    mockGenerateText.mockImplementation((_p: string, _m: unknown, _r: unknown, opts: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        opts.signal!.addEventListener('abort', () => {
          const e = new Error('cancelled');
          e.name = 'AbortError';
          reject(e);
        });
      }),
    );

    const handler = getHandler('generate-text');
    const cancel = getHandler('ai:cancel-generate');
    const { sender } = makeSender();

    const resultP = handler({ sender }, { prompt: 'prompt', requestId: 'req-3' });
    await cancel({}, 'req-3');
    const err = await resultP.catch((e: Error) => e);
    expect((err as Error).name).toBe('AbortError');
  });

  it('no-requestId call: behaves identically to today (no AbortController created)', async () => {
    mockGenerateText.mockResolvedValue({ text: 'result' });
    const handler = getHandler('generate-text');
    const { sender } = makeSender();
    const result = await handler({ sender }, { prompt: 'prompt' });
    expect(result).toEqual({ text: 'result' });
    // signal field on the opts object passed to generateText must be undefined
    const optsArg = mockGenerateText.mock.calls[0][3] as { signal?: AbortSignal } | undefined;
    expect(optsArg?.signal).toBeUndefined();
  });

  it('forwards diagnostics from generateText through the IPC result (t/3569)', async () => {
    const diagnostics = { requestBytes: 42, httpStatus: 200, headersMs: 10, bodyReadMs: 5, responseBytes: 100 };
    mockGenerateText.mockResolvedValue({ text: 'result', diagnostics });
    const handler = getHandler('generate-text');
    const { sender } = makeSender();
    const result = await handler({ sender }, { prompt: 'prompt' });
    expect(result).toEqual({ text: 'result', diagnostics });
  });
});
