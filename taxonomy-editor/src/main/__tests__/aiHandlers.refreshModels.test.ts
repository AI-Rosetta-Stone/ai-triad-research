// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4161 — the refresh-ai-models IPC handler: Zod-validated opts reach
// refreshAIModels(); a malformed payload throws an ActionableError and refreshAIModels
// is NEVER called (it must not silently fall through to a plain refresh).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain } from 'electron';

const mockGenerateText = vi.hoisted(() => vi.fn());
const mockRefreshAIModels = vi.hoisted(() => vi.fn(async () => ({ proposal: null, updated: false })));

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
  resolveAiCallLogContext: vi.fn(() => ({ model: 'gemini-2.0-flash', backend: 'gemini', keySource: 'store' })),
}));

vi.mock('../modelDiscovery.js', () => ({ refreshAIModels: mockRefreshAIModels }));

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
  getDataRootPath: vi.fn(() => '/fake/data-root'),
  resolveDataPath: vi.fn((p: string) => p),
}));

vi.mock('../modelDiscovery.js', () => ({ refreshAIModels: mockRefreshAIModels }));
vi.mock('../embeddingErrors.js', () => ({ buildEmbeddingFailureError: vi.fn() }));
vi.mock('../../../../lib/debate/errors.js', () => ({
  ActionableError: class extends Error {
    goal: string; problem: string; location: string; nextSteps: string[];
    constructor(opts: { goal: string; problem: string; location: string; nextSteps: string[] }) {
      super(opts.problem);
      this.goal = opts.goal; this.problem = opts.problem; this.location = opts.location; this.nextSteps = opts.nextSteps;
    }
  },
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
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

beforeEach(() => {
  vi.clearAllMocks();
  registerAiHandlers();
});

describe('refresh-ai-models IPC handler (t/4161)', () => {
  it('no opts: identical to today — refreshAIModels called with no argument', async () => {
    const handler = getHandler('refresh-ai-models');
    await handler({});
    expect(mockRefreshAIModels).toHaveBeenCalledWith();
  });

  it('valid dryRun reaches refreshAIModels', async () => {
    const handler = getHandler('refresh-ai-models');
    await handler({}, { dryRun: true });
    expect(mockRefreshAIModels).toHaveBeenCalledWith({ dryRun: true });
  });

  it('valid accept reaches refreshAIModels with the exact parsed shape', async () => {
    const proposal = { catalogFingerprint: 'sha256:a', hash: 'sha256:b', changes: [] };
    const handler = getHandler('refresh-ai-models');
    await handler({}, { accept: { proposal, approvedBy: 'Jane', reason: 'vendor rotation' } });
    expect(mockRefreshAIModels).toHaveBeenCalledWith({ accept: { proposal, approvedBy: 'Jane', reason: 'vendor rotation' } });
  });

  it('an unknown key throws an ActionableError and refreshAIModels is never called', async () => {
    const handler = getHandler('refresh-ai-models');
    await expect(handler({}, { dryRun: true, extra: 1 })).rejects.toThrow(ActionableError);
    expect(mockRefreshAIModels).not.toHaveBeenCalled();
  });

  it('an empty reason throws an ActionableError and refreshAIModels is never called', async () => {
    const proposal = { catalogFingerprint: 'sha256:a', hash: 'sha256:b', changes: [] };
    const handler = getHandler('refresh-ai-models');
    await expect(handler({}, { accept: { proposal, approvedBy: 'Jane', reason: '' } })).rejects.toThrow(ActionableError);
    expect(mockRefreshAIModels).not.toHaveBeenCalled();
  });

  it('a wrong-typed field throws an ActionableError and refreshAIModels is never called', async () => {
    const handler = getHandler('refresh-ai-models');
    await expect(handler({}, { dryRun: 'yes' })).rejects.toThrow(ActionableError);
    expect(mockRefreshAIModels).not.toHaveBeenCalled();
  });

  it('malformed opts never falls through to a plain refresh', async () => {
    const handler = getHandler('refresh-ai-models');
    await expect(handler({}, { bogus: true })).rejects.toThrow();
    expect(mockRefreshAIModels).not.toHaveBeenCalled();
  });
});
