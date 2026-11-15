// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { mapErrorToUserMessage } from './errorMessages';
import { ActionableError } from '@lib/debate/errors';
import { nextStepsForStatus } from '../bridge/httpErrorSteps';

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
    ['permission', new Error('EACCES: permission denied')],
    ['disk full', new Error('ENOSPC: no space left on device')],
    ['file not found', new Error('ENOENT: no such file or directory, open foo.txt')],
    ['context length', new Error('context_too_long')],
    ['generic 4xx', new Error('HTTP 403 Forbidden')],
    ['unclassified', new Error('some totally novel failure mode')],
  ])('%s maps identically for both kinds', (_label, err) => {
    expect(mapErrorToUserMessage(err, { kind: 'operation' })).toBe(mapErrorToUserMessage(err, { kind: 'ai' }));
    expect(mapErrorToUserMessage(err, { kind: 'operation' })).toBe(mapErrorToUserMessage(err));
  });
});

describe('mapErrorToUserMessage — kind option: operation-neutral timeout/5xx/503/connection/JSON text (t/122)', () => {
  const aborted = (): Error => {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    return e;
  };
  // [label, error, existing default/'ai' text (origin/main), 'operation' text]
  const cases: Array<[string, Error, string, string]> = [
    ['timeout', new Error('Request timed out after 30000ms'),
      'Operation timed out. The AI service may be slow — try again or switch to a faster model.',
      'The server took too long to respond. Try again.'],
    ['500', new Error('HTTP 500 Internal Server Error'),
      'The AI service ran into a problem. Retrying automatically — hang tight.',
      'The server ran into a problem. Try again in a moment.'],
    ['502', new Error('HTTP 502 Bad Gateway'),
      'A gateway error occurred. Retrying shortly.',
      "The server couldn't be reached. Try again in a moment."],
    ['504', new Error('HTTP 504 Gateway Timeout'),
      'A gateway error occurred. Retrying shortly.',
      "The server couldn't be reached. Try again in a moment."],
    ['503', new Error('HTTP 503 Service Unavailable'),
      'AI service is temporarily overloaded. Try again in a few seconds.',
      'The service is busy right now. Try again in a few seconds.'],
    ['529 overloaded', new Error('HTTP 529 overloaded'),
      'AI service is temporarily overloaded. Try again in a few seconds.',
      'The service is busy right now. Try again in a few seconds.'],
    ['AbortError', aborted(),
      'Connection interrupted. Retrying…',
      'The connection was interrupted. Try again.'],
    ['circuit open', new Error('Circuit breaker is OPEN for gemini'),
      'The service is temporarily unavailable. Your debate is paused — it will resume automatically.',
      'The service is temporarily unavailable. Try again in a minute.'],
    ['JSON (AI response branch)', new Error('Unexpected token < in JSON response'),
      'The AI returned an invalid response. Try again — this sometimes happens with complex prompts.',
      "The data couldn't be read. Try again, and reload if it keeps happening."],
    ['JSON (data-file branch)', new Error('Unexpected token } in JSON at position 12'),
      'Data file is corrupted: Unexpected token } in JSON at position 12',
      "The data couldn't be read. Try again, and reload if it keeps happening."],
  ];

  it.each(cases)("%s: kind 'operation' gets the neutral text", (_label, err, _existing, operation) => {
    expect(mapErrorToUserMessage(err, { kind: 'operation' })).toBe(operation);
  });

  it.each(cases)("%s: default and kind 'ai' keep the existing text", (_label, err, existing) => {
    expect(mapErrorToUserMessage(err)).toBe(existing);
    expect(mapErrorToUserMessage(err, { kind: 'ai' })).toBe(existing);
  });

  it('no operation string mentions models, debates, AI, or automatic retrying', () => {
    const produced = cases.map(([, err]) => mapErrorToUserMessage(err, { kind: 'operation' }));
    // \bAI\b: a bare /AI/i would match "again" / "unavailable" in the table's own strings.
    for (const text of produced) expect(text).not.toMatch(/model|debate|\bAI\b|retrying|automatically/i);
  });
});

describe('mapErrorToUserMessage — bridge ActionableErrors map by httpStatus, never raw HTTP/JSON (t/108)', () => {
  // Built exactly as web-bridge.ts assertMutationOk/get do: raw problem + nextStepsForStatus, then
  // throwHttpError stamps `httpStatus` on the instance.
  function bridgeError(method: string, path: string, status: number, body: string): ActionableError {
    const err = new ActionableError({
      goal: 'Send data to server',
      problem: `${method} ${path} failed with HTTP ${status}: ${body}`,
      location: `web-bridge.${method.toLowerCase()}`,
      nextSteps: nextStepsForStatus(status, body),
    });
    (err as ActionableError & { httpStatus: number }).httpStatus = status;
    return err;
  }
  const del = (status: number, body: string) => bridgeError('DELETE', '/api/chats/chat-123', status, body);

  const cases: Array<[number, string, 'ai' | 'operation' | undefined, string]> = [
    // TL p/10#38: a bridge error with no kind defaults to 'operation'; only an explicit 'ai' gets AI text.
    [429, '{"error":"Too many requests"}', undefined, 'Too many requests. Wait a minute and try again.'],
    [429, '{"error":"Too many requests"}', 'operation', 'Too many requests. Wait a minute and try again.'],
    [429, '{"error":"Too many requests"}', 'ai',
      'API rate limited. Wait a minute and try again, or switch to a different model in Settings.'],
    [500, '{"error":"Internal error"}', 'operation', 'The server ran into a problem. Try again in a moment.'],
    // TL p/10#39: a bridge 5xx gets the operation text even when the caller says 'ai'.
    [500, '{"error":"Internal error"}', undefined, 'The server ran into a problem. Try again in a moment.'],
    [500, '{"error":"Internal error"}', 'ai', 'The server ran into a problem. Try again in a moment.'],
    [502, '{"error":"Bad gateway"}', 'operation', "The server couldn't be reached. Try again in a moment."],
    [503, '{"error":"Service unavailable"}', 'operation', 'The service is busy right now. Try again in a few seconds.'],
    // Design t/108#10: 401 is a signed-out session, 403 a signed-in user without permission.
    [401, '{"error":"Unauthorized"}', 'operation', 'Your session has expired. Sign in again.'],
    [401, '{"error":"Unauthorized"}', undefined, 'Your session has expired. Sign in again.'],
    [403, '{"error":"Forbidden"}', 'operation', "You don't have permission to do that."],
    [403, '{"error":"Forbidden"}', undefined, "You don't have permission to do that."],
    [404, '{"error":"Chat not found"}', 'operation', 'That item no longer exists.'],
    [404, '{"error":"Chat not found"}', undefined, 'That item no longer exists.'],
    [400, '{"error":"Bad request"}', 'operation', 'An unexpected error occurred. If this persists, try reloading.'],
  ];

  it.each(cases)('HTTP %i %s (kind %s) maps by status',(status, body, kind, expected) => {
    expect(mapErrorToUserMessage(del(status, body), kind ? { kind } : undefined)).toBe(expected);
  });

  it('no mapped result contains raw HTTP status text or JSON', () => {
    for (const [status, body, kind] of cases) {
      const shown = mapErrorToUserMessage(del(status, body), kind ? { kind } : undefined);
      expect(shown).not.toContain('HTTP 4');
      expect(shown).not.toContain('HTTP 5');
      expect(shown).not.toContain('{');
    }
  });

  it('a status-less ActionableError still returns its problem', () => {
    const err = new ActionableError({ goal: 'g', problem: 'Pop-up was blocked.', location: 'web-bridge · printBriefToPdf', nextSteps: [] });
    expect(mapErrorToUserMessage(err, { kind: 'operation' })).toBe('Pop-up was blocked.');
  });

  it('a status-bearing problem the bridge words itself is kept verbatim (WRITE_CONFLICT, daily limit)', () => {
    const conflict = new ActionableError({ goal: 'g', problem: 'Someone else changed this file. Reload to see their version.', location: 'web-bridge.post', nextSteps: [] });
    Object.assign(conflict, { httpStatus: 409, code: 'WRITE_CONFLICT' });
    expect(mapErrorToUserMessage(conflict)).toBe('Someone else changed this file. Reload to see their version.');
    const daily = new ActionableError({ goal: 'g', problem: 'Daily token limit exceeded. Try again tomorrow or use your own API key.', location: 'web-bridge.post', nextSteps: [] });
    Object.assign(daily, { httpStatus: 429 });
    expect(mapErrorToUserMessage(daily)).toBe('Daily token limit exceeded. Try again tomorrow or use your own API key.');
  });

  // TL p/10#36: only the bridge's exact "<METHOD> <path> failed with HTTP <n>:" prefix is remapped.
  it('a hand-written problem that merely quotes "HTTP <n>" is kept verbatim', () => {
    const quoted = new ActionableError({ goal: 'g', problem: 'The upstream returned HTTP 429 earlier; your draft is saved locally.', location: 'web-bridge.post', nextSteps: [] });
    Object.assign(quoted, { httpStatus: 429 });
    expect(mapErrorToUserMessage(quoted, { kind: 'operation' })).toBe('The upstream returned HTTP 429 earlier; your draft is saved locally.');
  });

  // TL p/10#36: nothing retries a plain bridge call, so a bridge 5xx never promises a retry, under any
  // kind. The plain-Error AI paths that do retry keep their wording (checked in the last assertion).
  it('a bridge 5xx never promises an automatic retry, under any kind', () => {
    for (const status of [500, 502, 503, 504, 529]) {
      for (const kind of [undefined, 'ai', 'operation'] as const) {
        const shown = mapErrorToUserMessage(del(status, '{"error":"x"}'), kind ? { kind } : undefined);
        expect(shown, `HTTP ${status} kind ${String(kind)}`).not.toMatch(/retrying|automatically|shortly/i);
      }
    }
    expect(mapErrorToUserMessage(new Error('500 Internal Server Error'))).toMatch(/Retrying automatically/);
  });
});
