// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Both-arms coverage for t/3370: the generate-text IPC handler must write an AI
// call-log entry when AI_CALL_LOG_ENABLED is on, and must write nothing when it is
// off. Uses the REAL writeAICallLogEntry (not mocked) against a temp data root so the
// flag gate itself is exercised, not just "the handler calls the writer" — mirrors the
// temp-dir pattern noted in AGENTS.md for modules that pull in electron.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ipcMain } from 'electron';

const mockGenerateText = vi.hoisted(() => vi.fn());
// t/4088: Model/Backend/KeySource context, computed once per call and reused for success/failure.
const mockResolveAiCallLogContext = vi.hoisted(() => vi.fn(() => ({ model: 'gemini-2.0-flash', backend: 'gemini', keySource: 'store' })));

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
  resolveAiCallLogContext: mockResolveAiCallLogContext,
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

let dataRoot: string;

vi.mock('../fileIO.js', () => ({
  PROJECT_ROOT: '/fake/root',
  getDataRootPath: vi.fn(() => dataRoot),
  resolveDataPath: vi.fn((p: string) => path.join(dataRoot, p)),
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

function readLogLines(): unknown[] {
  const logPath = path.join(dataRoot, 'ai-call-log.jsonl');
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

const ORIGINAL_FLAG = process.env.AI_CALL_LOG_ENABLED;

beforeEach(() => {
  vi.clearAllMocks();
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-call-log-t3370-'));
  registerAiHandlers();
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
  if (ORIGINAL_FLAG === undefined) delete process.env.AI_CALL_LOG_ENABLED;
  else process.env.AI_CALL_LOG_ENABLED = ORIGINAL_FLAG;
});

describe('generate-text — AI call log wiring (t/3370)', () => {
  it('flag ON: logs 1 entry with scenario Debate on success', async () => {
    process.env.AI_CALL_LOG_ENABLED = '1';
    mockGenerateText.mockResolvedValue({ text: 'ok' });
    const handler = getHandler('generate-text');
    const { sender } = makeSender();
    await handler({ sender }, { prompt: 'prompt-text', requestId: 'req-log-1' });

    const lines = readLogLines() as Array<{ Scenario: string; PromptStart: string; Status: string }>;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ Scenario: 'Debate', PromptStart: 'prompt-text', Status: '200' });
  });

  it('flag ON: logs a non-200 status on failure', async () => {
    process.env.AI_CALL_LOG_ENABLED = '1';
    mockGenerateText.mockRejectedValue(new Error('boom'));
    const handler = getHandler('generate-text');
    const { sender } = makeSender();
    await expect(handler({ sender }, { prompt: 'prompt-text', requestId: 'req-log-2' })).rejects.toThrow();

    const lines = readLogLines() as Array<{ Scenario: string; Status: string }>;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ Scenario: 'Debate', Status: 'error' });
  });

  it('flag OFF (default): writes nothing', async () => {
    delete process.env.AI_CALL_LOG_ENABLED;
    mockGenerateText.mockResolvedValue({ text: 'ok' });
    const handler = getHandler('generate-text');
    const { sender } = makeSender();
    await handler({ sender }, { prompt: 'prompt-text', requestId: 'req-log-3' });

    expect(readLogLines()).toHaveLength(0);
  });
});

describe('generate-text — Model/Backend/KeySource on every log entry (t/4088)', () => {
  it('success: the resolved context reaches the log entry', async () => {
    process.env.AI_CALL_LOG_ENABLED = '1';
    mockResolveAiCallLogContext.mockReturnValue({ model: 'claude-opus-5', backend: 'claude', keySource: 'store' });
    mockGenerateText.mockResolvedValue({ text: 'ok' });
    const handler = getHandler('generate-text');
    const { sender } = makeSender();
    await handler({ sender }, { prompt: 'prompt-text', model: 'claude-opus-5', requestId: 'req-log-4' });

    const lines = readLogLines() as Array<{ Model: string; Backend: string; KeySource: string }>;
    expect(lines[0]).toMatchObject({ Model: 'claude-opus-5', Backend: 'claude', KeySource: 'store' });
  });

  it('failure: the SAME resolved context (computed before the call) reaches the log entry', async () => {
    process.env.AI_CALL_LOG_ENABLED = '1';
    mockResolveAiCallLogContext.mockReturnValue({ model: 'groq-qwen-qwen3.6-27b', backend: 'groq', keySource: 'none' });
    mockGenerateText.mockRejectedValue(new Error('boom'));
    const handler = getHandler('generate-text');
    const { sender } = makeSender();
    await expect(handler({ sender }, { prompt: 'prompt-text', model: 'groq-qwen-qwen3.6-27b', requestId: 'req-log-5' })).rejects.toThrow();

    const lines = readLogLines() as Array<{ Model: string; Backend: string; KeySource: string }>;
    expect(lines[0]).toMatchObject({ Model: 'groq-qwen-qwen3.6-27b', Backend: 'groq', KeySource: 'none' });
  });
});
