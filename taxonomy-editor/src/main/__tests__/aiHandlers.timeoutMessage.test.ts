// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3417 regression: AbortSignal.timeout() (the ai-client per-attempt fetch deadline)
// fires with .name === 'TimeoutError', not 'AbortError' — it must NOT be treated as a
// user-initiated cancel, and must surface a timeout-specific ActionableError instead of
// the generic "check your API key / rate limits" message.

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

vi.mock('../aiCallLog.js', () => ({ writeAICallLogEntry: vi.fn() }));
vi.mock('../modelDiscovery.js', () => ({ refreshAIModels: vi.fn() }));
vi.mock('../embeddingErrors.js', () => ({ buildEmbeddingFailureError: vi.fn() }));
vi.mock('../../../../lib/debate/errors.js', () => ({
  ActionableError: class ActionableError extends Error {
    problem: string; goal: string; location: string; nextSteps: string[];
    constructor(args: { goal: string; problem: string; location: string; nextSteps: string[]; innerError?: unknown }) {
      super(args.problem);
      this.name = 'ActionableError';
      this.goal = args.goal; this.problem = args.problem; this.location = args.location; this.nextSteps = args.nextSteps;
    }
  },
}));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: vi.fn(() => null) }));
vi.mock('../../../../lib/debate/constants.js', () => ({ DEFAULT_RELEVANCE_THRESHOLD: 0.5 }));
vi.mock('../../../../lib/url-fetch/fetchUrlForPrompt.js', () => ({ fetchUrlForPrompt: vi.fn() }));

import { registerAiHandlers } from '../ipc/aiHandlers.js';
import { ActionableError } from '../../../../lib/debate/errors.js';

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

describe('generate-text — TimeoutError surfaces a distinct, actionable message (t/3417)', () => {
  it('wraps a TimeoutError with timeout-specific guidance, not the generic API-key message', async () => {
    const timeoutErr = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    mockGenerateText.mockRejectedValue(timeoutErr);

    const handler = getHandler('generate-text');
    const { sender } = makeSender();
    const err = await handler({ sender }, { prompt: 'prompt' }).catch(e => e);

    expect(err).toBeInstanceOf(ActionableError);
    const ae = err as ActionableError;
    expect(ae.problem).toContain('did not respond within the allotted timeout');
    expect(ae.nextSteps.join(' ')).not.toContain('Verify your API key');
    expect(ae.nextSteps.join(' ')).toContain('Retry');
  });

  it('a TimeoutError does NOT hit the user-cancel path (no requestId, no cancel)', async () => {
    const timeoutErr = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    mockGenerateText.mockRejectedValue(timeoutErr);

    const handler = getHandler('generate-text');
    const { sender } = makeSender();
    const err = await handler({ sender }, { prompt: 'prompt', requestId: 'req-timeout-1' }).catch(e => e);

    // A genuine cancel rethrows the raw error verbatim; a timeout must be wrapped.
    expect(err).toBeInstanceOf(ActionableError);
  });

  it('a genuine AbortError (user cancel) is still rethrown raw, unaffected by this change', async () => {
    const abortErr = new DOMException('The user aborted a request', 'AbortError');
    mockGenerateText.mockRejectedValue(abortErr);

    const handler = getHandler('generate-text');
    const { sender } = makeSender();
    const err = await handler({ sender }, { prompt: 'prompt', requestId: 'req-cancel-1' }).catch(e => e);

    expect(err).toBe(abortErr);
    expect(err).not.toBeInstanceOf(ActionableError);
  });
});
