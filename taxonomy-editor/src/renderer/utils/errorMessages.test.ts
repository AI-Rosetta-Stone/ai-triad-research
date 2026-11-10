// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { mapErrorToUserMessage } from './errorMessages';
import { ActionableError } from '@lib/debate/errors';

describe('mapErrorToUserMessage — ActionableError surfaces .problem, not the raw block (t/2491)', () => {
  it('returns the one-line problem, not the full Goal/Error/Location/Resolve message', () => {
    const err = new ActionableError({
      goal: 'Stream chat response',
      problem: 'Rate limit exceeded. Retry in 30s.',
      location: 'web-bridge.startChatStream',
      nextSteps: ['Wait for the rate limit to reset', 'Use your own API key'],
    });
    // Sanity: the raw .message IS the formatted block we must NOT show.
    expect(err.message).toMatch(/Goal:|Resolve:|Location:/);

    const shown = mapErrorToUserMessage(err);
    expect(shown).toBe('Rate limit exceeded. Retry in 30s.');
    expect(shown).not.toMatch(/Goal:|Location:|Resolve:/);
  });

  it('a missing-key 422 ActionableError shows only its problem line', () => {
    const err = new ActionableError({
      goal: 'Stream chat response',
      problem: 'No API key configured for the selected backend.',
      location: 'web-bridge.startChatStream',
      nextSteps: ['Open Settings → API Keys'],
    });
    expect(mapErrorToUserMessage(err)).toBe('No API key configured for the selected backend.');
  });

  it('non-ActionableError paths are unchanged (rate-limit heuristic still maps)', () => {
    expect(mapErrorToUserMessage(new Error('HTTP 429 rate limit'))).toMatch(/rate limited/i);
  });

  it('a plain string error is returned mapped, not crashed', () => {
    expect(typeof mapErrorToUserMessage('something went wrong')).toBe('string');
  });
});

describe('mapErrorToUserMessage — HTTP status → friendly text (t/2906)', () => {
  it('HTTP 500 maps to the friendly server-problem string, not raw', () => {
    const shown = mapErrorToUserMessage(new Error('HTTP 500 Internal Server Error'));
    expect(shown).toBe('The AI service ran into a problem. Retrying automatically — hang tight.');
    expect(shown).not.toMatch(/HTTP 500|Internal Server Error/);
  });

  it('a bare "Internal Server Error" (no code) also maps to the 500 string', () => {
    expect(mapErrorToUserMessage(new Error('Internal Server Error'))).toBe(
      'The AI service ran into a problem. Retrying automatically — hang tight.',
    );
  });

  it('HTTP 502 / 504 gateway errors map to the gateway string', () => {
    expect(mapErrorToUserMessage(new Error('HTTP 502 Bad Gateway'))).toBe('A gateway error occurred. Retrying shortly.');
    expect(mapErrorToUserMessage(new Error('HTTP 504 Gateway Timeout'))).toBe('A gateway error occurred. Retrying shortly.');
  });

  it('an AbortError maps to the connection-interrupted string', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    expect(mapErrorToUserMessage(err)).toBe('Connection interrupted. Retrying…');
  });

  it('a circuit-breaker-open error maps to the paused string', () => {
    expect(mapErrorToUserMessage(new Error('Circuit breaker is OPEN for gemini'))).toBe(
      'The service is temporarily unavailable. Your debate is paused — it will resume automatically.',
    );
  });

  it('a generic HTTP 401/422 hits the friendly catch-all, not raw leak', () => {
    expect(mapErrorToUserMessage(new Error('HTTP 401 Unauthorized'))).toBe('An unexpected error occurred. If this persists, try reloading.');
    expect(mapErrorToUserMessage(new Error('Request failed with HTTP 422'))).toBe('An unexpected error occurred. If this persists, try reloading.');
  });

  it('no regression: 429 and 503 still return their existing strings (specific guards win)', () => {
    expect(mapErrorToUserMessage(new Error('HTTP 429 Too Many Requests'))).toMatch(/rate limited/i);
    expect(mapErrorToUserMessage(new Error('HTTP 503 Service Unavailable'))).toMatch(/temporarily overloaded/i);
  });

  it('an unrecognised error still hits the safe default (non-empty), not an empty string', () => {
    const shown = mapErrorToUserMessage(new Error('some totally novel failure mode'));
    expect(shown).toBe('some totally novel failure mode');
    expect(shown.length).toBeGreaterThan(0);
  });
});

describe('mapErrorToUserMessage — kind option: operation-neutral 429 text (t/108)', () => {
  const rateLimited = new Error('HTTP 429 Too Many Requests');

  it('429 with no options keeps the existing AI text', () => {
    expect(mapErrorToUserMessage(rateLimited)).toBe(
      'API rate limited. Wait a minute and try again, or switch to a different model in Settings.',
    );
    expect(mapErrorToUserMessage(rateLimited, { kind: 'ai' })).toBe(mapErrorToUserMessage(rateLimited));
  });

  it("429 with kind 'operation' gets neutral text that doesn't mention models", () => {
    expect(mapErrorToUserMessage(rateLimited, { kind: 'operation' })).toBe('Too many requests. Wait a minute and try again.');
  });

  it.each([
    ['503 overload', new Error('HTTP 503 Service Unavailable')],
    ['500 server error', new Error('HTTP 500 Internal Server Error')],
    ['permission', new Error('EACCES: permission denied')],
    ['generic 4xx', new Error('HTTP 403 Forbidden')],
    ['unclassified', new Error('some totally novel failure mode')],
  ])('%s maps identically for both kinds', (_label, err) => {
    expect(mapErrorToUserMessage(err, { kind: 'operation' })).toBe(mapErrorToUserMessage(err, { kind: 'ai' }));
    expect(mapErrorToUserMessage(err, { kind: 'operation' })).toBe(mapErrorToUserMessage(err));
  });
});
