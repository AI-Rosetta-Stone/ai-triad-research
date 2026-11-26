// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/725 (t/723; server contract t/724#4): refusals map on reason + code, never on the server's sentence.

import { describe, it, expect } from 'vitest';
import {
  anonRefusalFromBody, anonRefusalOf, anonRefusalLine, refusalOffersSignIn, isRetryableFailure, RETRYABLE_FAILURE_LINE,
  type AnonLimitCode,
} from './anonLimit';
import { preStreamFreePoolCode } from './opedFreePool';

const CODES: AnonLimitCode[] = ['anon_oped_voices', 'anon_debate_kind', 'anon_debate_turns', 'anon_debate_unsaved', 'anon_debate_budget', 'anon_debate_daily'];

describe('anonRefusalFromBody', () => {
  it.each(CODES)('403 anon_limit + %s is a limit refusal', (code) => {
    expect(anonRefusalFromBody(403, { error: 'any sentence at all', reason: 'anon_limit', code, signInRequired: true, retryable: false })).toEqual({ kind: 'limit', code });
  });

  it('carries the limit number when the server sends one', () => {
    expect(anonRefusalFromBody(403, { reason: 'anon_limit', code: 'anon_debate_turns', limit: 13 })).toEqual({ kind: 'limit', code: 'anon_debate_turns', limit: 13 });
  });

  it('401 no_session is a no-session refusal', () => {
    expect(anonRefusalFromBody(401, { error: 'x', reason: 'no_session' })).toEqual({ kind: 'no_session' });
  });

  it('maps on reason + code, not the sentence: the right sentence with the wrong reason or code is not a refusal', () => {
    expect(anonRefusalFromBody(403, { error: 'Sign in to run Deep dive and Socratic debates.' })).toBeNull();
    expect(anonRefusalFromBody(403, { reason: 'anon_route_blocked', code: 'anon_debate_kind' })).toBeNull();
    expect(anonRefusalFromBody(403, { reason: 'anon_limit', code: 'something_new' })).toBeNull();
    expect(anonRefusalFromBody(403, { reason: 'anon_limit' })).toBeNull();
  });

  it('the status must match: a 200, 429 or 500 with the same body is not a refusal', () => {
    for (const status of [200, 400, 429, 500, 503]) {
      expect(anonRefusalFromBody(status, { reason: 'anon_limit', code: 'anon_debate_kind' })).toBeNull();
    }
    expect(anonRefusalFromBody(403, { reason: 'no_session' })).toBeNull();
  });

  it('ignores a body that is not an object', () => {
    expect(anonRefusalFromBody(403, null)).toBeNull();
    expect(anonRefusalFromBody(403, 'anon_limit')).toBeNull();
  });
});

describe('anonRefusalOf (a bridge error)', () => {
  const bridgeError = (httpStatus: number, body: unknown) =>
    Object.assign(new Error('x'), { httpStatus, problem: `POST /api/ai/generate failed with HTTP ${httpStatus}: ${JSON.stringify(body)}` });

  it('reads the refusal out of the body embedded in the error text', () => {
    expect(anonRefusalOf(bridgeError(403, { error: 'e', reason: 'anon_limit', code: 'anon_debate_budget', limit: 160 }))).toEqual({ kind: 'limit', code: 'anon_debate_budget', limit: 160 });
    expect(anonRefusalOf(bridgeError(401, { reason: 'no_session' }))).toEqual({ kind: 'no_session' });
  });

  it('a 503 retryable failure is not a refusal', () => {
    expect(anonRefusalOf(bridgeError(503, { reason: 'anon_limit', code: 'anon_debate_budget', retryable: true }))).toBeNull();
  });

  it('is null for an error without a status, or an unrelated 403', () => {
    expect(anonRefusalOf(new Error('boom'))).toBeNull();
    expect(anonRefusalOf(bridgeError(403, { reason: 'anon_route_blocked' }))).toBeNull();
    expect(anonRefusalOf(null)).toBeNull();
  });

  it('a refusal already on the error wins', () => {
    const err = Object.assign(new Error('x'), { anonRefusal: { kind: 'no_session' as const } });
    expect(anonRefusalOf(err)).toEqual({ kind: 'no_session' });
  });
});

describe("Design's lines (t/725#3, p/25#221), verbatim", () => {
  const line = (code: AnonLimitCode) => anonRefusalLine({ kind: 'limit', code });
  it('one per code', () => {
    expect(line('anon_oped_voices')).toBe('Sign in to create more than one voice at a time.');
    expect(line('anon_debate_kind')).toBe('Sign in to run Deep dive and Socratic debates.');
    expect(line('anon_debate_turns')).toBe('This debate has reached the length limit for debates without signing in. Sign in to continue it.');
    expect(line('anon_debate_unsaved')).toBe("This debate couldn't be saved, so it can't continue. Try starting it again.");
    expect(line('anon_debate_budget')).toBe('This debate has used all the AI calls allowed without signing in. Sign in to continue it.');
    expect(line('anon_debate_daily')).toBe("You've started all the debates allowed per day without signing in. Sign in to start more, or try again tomorrow.");
    expect(anonRefusalLine({ kind: 'no_session' })).toBe('Your session has ended. Sign in to continue.');
  });

  it('only anon_debate_unsaved is not a sign-in prompt (signing in does not fix an unsaved debate)', () => {
    expect(refusalOffersSignIn({ kind: 'limit', code: 'anon_debate_unsaved' })).toBe(false);
    for (const code of CODES.filter(c => c !== 'anon_debate_unsaved')) expect(refusalOffersSignIn({ kind: 'limit', code })).toBe(true);
    expect(refusalOffersSignIn({ kind: 'no_session' })).toBe(true);
  });
});

describe('isRetryableFailure', () => {
  it('a 503 with retryable true is a failure to retry, with its own line', () => {
    expect(isRetryableFailure(503, { retryable: true })).toBe(true);
    expect(RETRYABLE_FAILURE_LINE).toBe('Something went wrong on our side. Try again in a moment.');
  });
  it('not for a 503 without the flag, or for any other status', () => {
    expect(isRetryableFailure(503, { retryable: false })).toBe(false);
    expect(isRetryableFailure(503, {})).toBe(false);
    expect(isRetryableFailure(500, { retryable: true })).toBe(false);
  });
});

describe('op-ed create: anon_oped_voices (preStreamFreePoolCode)', () => {
  it('maps 403 reason anon_limit + code anon_oped_voices, whatever the sentence says', () => {
    expect(preStreamFreePoolCode(403, { error: 'whatever', reason: 'anon_limit', code: 'anon_oped_voices', limit: 1 })).toBe('anon_oped_voices');
  });
  it('does not map the sentence alone, or another code', () => {
    expect(preStreamFreePoolCode(403, { error: 'anon_oped_voices' })).toBeNull();
    expect(preStreamFreePoolCode(403, { reason: 'anon_limit', code: 'anon_debate_kind' })).toBeNull();
  });
});
