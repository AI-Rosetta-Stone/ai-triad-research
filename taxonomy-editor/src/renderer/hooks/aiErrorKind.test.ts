// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/131: a bridge 429 on an AI generation call must read as an AI rate limit ("… or switch to a different
// model in Settings"), not the neutral operation text. Bridge errors default to 'operation' unless the caller
// passes kind 'ai' (TL p/10#38), so every AI call site has to pass it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { ActionableError } from '@lib/debate/errors';
import { mapErrorToUserMessage } from '../utils/errorMessages';

vi.mock('@bridge', () => ({ api: {}, setActiveDebateId: () => undefined, isElectronMode: () => false }));

const AI_429 = 'API rate limited. Wait a minute and try again, or switch to a different model in Settings.';
const OP_429 = 'Too many requests. Wait a minute and try again.';
const bridge429 = (): ActionableError => {
  const err = new ActionableError({ goal: 'Generate', problem: 'POST /api/ai/generate failed with HTTP 429: {"error":"rate"}', location: 'web-bridge.post', nextSteps: [] });
  (err as ActionableError & { httpStatus: number }).httpStatus = 429;
  return err;
};

describe('t/131: bridge 429 on AI paths', () => {
  it('reads as an AI rate limit with kind ai, and as the neutral text without it', () => {
    expect(mapErrorToUserMessage(bridge429(), { kind: 'ai' })).toBe(AI_429);
    expect(mapErrorToUserMessage(bridge429())).toBe(OP_429);
  });

  it('a bridge 5xx stays operation text even with kind ai (nothing retries a bridge call, TL p/10#39)', () => {
    const err = new ActionableError({ goal: 'Generate', problem: 'POST /api/ai/generate failed with HTTP 503: {}', location: 'web-bridge.post', nextSteps: [] });
    (err as ActionableError & { httpStatus: number }).httpStatus = 503;
    expect(mapErrorToUserMessage(err, { kind: 'ai' })).toBe(mapErrorToUserMessage(err));
  });

  it('chat send failures use the AI text (chatErrorText)', async () => {
    const { chatErrorText } = await import('./useChatStore');
    expect(chatErrorText(bridge429(), 'Response failed')).toBe(`Response failed: ${AI_429}`);
  });

  // Guard: the AI-generation files pass kind 'ai' at every call. searchSlice.ts is exempt on purpose: its two
  // sites wrap embedding calls only, where model advice would be false.
  const AI_FILES = [
    'useDebateStore/slices/synthesisSlice.ts',
    'useDebateStore/slices/clarificationSlice.ts',
    'useDebateStore/slices/debateReflectionSlice.ts',
    'useDebateStore/slices/debatePhaseSlice.ts',
    'useDebateStore/slices/debateLoopSlice.ts',
    'useTaxonomyStore/slices/analysisSlice.ts',
    'useChatStore.ts',
  ];
  it.each(AI_FILES)('%s passes kind ai at every mapErrorToUserMessage call', (rel) => {
    const src = readFileSync(join(__dirname, rel), 'utf8');
    const calls = src.match(/mapErrorToUserMessage\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toContain("kind: 'ai'");
  });
});
