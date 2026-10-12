// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3370 regression: makeElectronAIAdapter used to hardcode scenario: 'Debate' for all
// three callers (debate, op-ed generation, brief export), mislabeling the non-debate
// call-log entries. This asserts the scenario now comes from the caller-supplied param.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGenerateText = vi.hoisted(() => vi.fn());
const mockWriteAICallLogEntry = vi.hoisted(() => vi.fn());
// t/4088: Model/Backend/KeySource context, computed once per call and reused for success/failure.
const mockResolveAiCallLogContext = vi.hoisted(() => vi.fn(() => ({ model: 'gemini-2.0-flash', backend: 'gemini', keySource: 'store' })));

vi.mock('../embeddings.js', () => ({ generateText: mockGenerateText, resolveAiCallLogContext: mockResolveAiCallLogContext }));
vi.mock('../aiCallLog.js', () => ({ writeAICallLogEntry: mockWriteAICallLogEntry }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: vi.fn(() => null) }));
// t/3614: electronAIAdapter now reads PROJECT_ROOT + a cached registry to satisfy AIAdapter's
// required `registry` member — mock both so this test never touches Electron's `app` or disk.
vi.mock('../fileIO.js', () => ({ PROJECT_ROOT: '/fake/root' }));
vi.mock('../modelConfigCache.js', () => ({ getMainRegistry: vi.fn(() => ({ backends: [], models: [] })) }));

import { makeElectronAIAdapter } from '../electronAIAdapter.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('makeElectronAIAdapter — scenario parameterization (t/3370)', () => {
  it('logs with the caller-supplied scenario, not a hardcoded "Debate"', async () => {
    mockGenerateText.mockResolvedValue({ text: 'generated text' });
    const adapter = makeElectronAIAdapter('OpEd Generation');
    await adapter.generateText('a prompt', 'gemini-2.0-flash');

    expect(mockWriteAICallLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({ scenario: 'OpEd Generation', status: '200' }),
    );
  });

  it('logs the same caller-supplied scenario on failure', async () => {
    mockGenerateText.mockRejectedValue(new Error('boom'));
    const adapter = makeElectronAIAdapter('Brief Export');
    await expect(adapter.generateText('a prompt', 'gemini-2.0-flash')).rejects.toThrow();

    expect(mockWriteAICallLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({ scenario: 'Brief Export', status: 'error' }),
    );
  });

  it('still supports the original Debate scenario for the debate engine caller', async () => {
    mockGenerateText.mockResolvedValue({ text: 'generated text' });
    const adapter = makeElectronAIAdapter('Debate');
    await adapter.generateText('a prompt', 'gemini-2.0-flash');

    expect(mockWriteAICallLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({ scenario: 'Debate', status: '200' }),
    );
  });
});

describe('makeElectronAIAdapter — Model/Backend/KeySource on every log entry (t/4088)', () => {
  it('success: the resolved context reaches the log entry', async () => {
    mockResolveAiCallLogContext.mockReturnValue({ model: 'claude-opus-5', backend: 'claude', keySource: 'store' });
    mockGenerateText.mockResolvedValue({ text: 'generated text' });
    const adapter = makeElectronAIAdapter('Debate');
    await adapter.generateText('a prompt', 'claude-opus-5');

    expect(mockWriteAICallLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-opus-5', backend: 'claude', keySource: 'store', status: '200' }),
    );
  });

  it('failure: the SAME resolved context (computed before the call) reaches the log entry — not re-derived from the error', async () => {
    mockResolveAiCallLogContext.mockReturnValue({ model: 'groq-qwen-qwen3.6-27b', backend: 'groq', keySource: 'none' });
    mockGenerateText.mockRejectedValue(new Error('boom'));
    const adapter = makeElectronAIAdapter('Debate');
    await expect(adapter.generateText('a prompt', 'groq-qwen-qwen3.6-27b')).rejects.toThrow();

    expect(mockWriteAICallLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'groq-qwen-qwen3.6-27b', backend: 'groq', keySource: 'none', status: 'error' }),
    );
  });
});
