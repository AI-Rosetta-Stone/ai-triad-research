// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/725 step 3 (t/793; server contract t/724#4):
//  (a) the order the server's debate checks rely on: a new debate is saved (PUT) before the bridge can attach its id
//      to any AI call, so check B ("every anonymous debate call belongs to a saved Quick Take") never sees an
//      unsaved id from an honest client; and a refused first save leaves no active id behind.
//  (b) a refused save or call shows Design's line, never the server's text or "check your API key".

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSession, mockApi } from './storeTestHarness';
import { useDebateStore } from '../../useDebateStore';
import { setActiveDebateId } from '@bridge';
// The harness mocks utils/errorMessages; these tests need the real mapper.
const { mapErrorToUserMessage } = await vi.importActual<typeof import('../../../utils/errorMessages')>('../../../utils/errorMessages');

function refusal(httpStatus: number, body: Record<string, unknown>) {
  return Object.assign(new Error('raw server text'), {
    httpStatus,
    problem: `PUT /api/debates failed with HTTP ${httpStatus}: ${JSON.stringify(body)}`,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.saveDebateSession.mockResolvedValue(undefined);
});

describe('a new debate is saved before the bridge can tag an AI call with its id (t/725 duty)', () => {
  it('createDebate: the PUT lands, then the active id is set; no AI call is made in between', async () => {
    const order: string[] = [];
    mockApi.saveDebateSession.mockImplementation(async () => { order.push('PUT'); });
    mockApi.generateText.mockImplementation(async () => { order.push('AI'); return { text: '' }; });
    vi.mocked(setActiveDebateId).mockImplementation(() => { order.push('setActiveDebateId'); });

    const id = await useDebateStore.getState().createDebate('Topic', ['accelerationist', 'safetyist'], false);

    expect(id).toBeTruthy();
    expect(order.indexOf('PUT')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('setActiveDebateId')).toBeGreaterThan(order.indexOf('PUT'));
    expect(order).not.toContain('AI');
    expect(vi.mocked(setActiveDebateId)).toHaveBeenCalledWith(id);
  });

  it('a first save the server refuses leaves no active debate id for the bridge to attach', async () => {
    mockApi.saveDebateSession.mockRejectedValue(refusal(403, { reason: 'anon_limit', code: 'anon_debate_kind', signInRequired: true }));
    await expect(useDebateStore.getState().createDebate('Topic', ['accelerationist', 'safetyist'], false)).rejects.toThrow();
    expect(vi.mocked(setActiveDebateId)).not.toHaveBeenCalled();
  });
});

describe("a refused save shows Design's line (t/725)", () => {
  async function saveRefused(httpStatus: number, body: Record<string, unknown>) {
    useDebateStore.setState({
      activeDebate: makeSession({ phase: 'debate', transcript: [] }) as never,
      debateError: null,
      _saveInFlight: false,
    } as never);
    mockApi.saveDebateSession.mockRejectedValue(refusal(httpStatus, body));
    await useDebateStore.getState().saveDebate('test');
    return useDebateStore.getState().debateError;
  }

  it('403 anon_debate_turns: the length-limit line, not "check your API key"', async () => {
    const err = await saveRefused(403, { reason: 'anon_limit', code: 'anon_debate_turns', limit: 13, signInRequired: true });
    expect(err).toBe('This debate has reached the length limit for debates without signing in. Sign in to continue it.');
    expect(err).not.toMatch(/API key|HTTP 403/);
  });

  it('401 no_session: the session-ended line', async () => {
    expect(await saveRefused(401, { reason: 'no_session' })).toBe('Your session has ended. Sign in to continue.');
  });

  it('503 retryable: a failure to retry, not a sign-in prompt', async () => {
    const err = await saveRefused(503, { error: 'store unavailable', retryable: true });
    expect(err).toBe('Something went wrong on our side. Try again in a moment.');
    expect(err).not.toMatch(/Sign in/);
  });

  it('a 403 that is not one of these refusals keeps the existing text', async () => {
    const err = await saveRefused(403, { reason: 'anon_route_blocked' });
    expect(err).toMatch(/server rejected this save/);
  });
});

describe("an AI call the server refused maps to Design's line (t/725)", () => {
  it.each([
    [403, { reason: 'anon_limit', code: 'anon_debate_kind' }, 'Sign in to run Deep dive and Socratic debates.'],
    [403, { reason: 'anon_limit', code: 'anon_debate_unsaved' }, "This debate couldn't be saved, so it can't continue. Try starting it again."],
    [403, { reason: 'anon_limit', code: 'anon_debate_budget', limit: 160 }, 'This debate has used all the AI calls allowed without signing in. Sign in to continue it.'],
    [403, { reason: 'anon_limit', code: 'anon_debate_daily' }, "You've started all the debates allowed per day without signing in. Sign in to start more, or try again tomorrow."],
    [401, { reason: 'no_session' }, 'Your session has ended. Sign in to continue.'],
  ])('HTTP %s %j', (status, body, line) => {
    const err = Object.assign(new Error('raw'), { httpStatus: status, problem: `POST /api/ai/generate failed with HTTP ${status}: ${JSON.stringify(body)}` });
    expect(mapErrorToUserMessage(err)).toBe(line);
  });

  it('never shows the server sentence, and an unrelated error is unchanged', () => {
    const err = Object.assign(new Error('raw'), { httpStatus: 403, problem: `POST /api/ai/generate failed with HTTP 403: ${JSON.stringify({ error: 'SERVER SENTENCE', reason: 'anon_limit', code: 'anon_debate_kind' })}` });
    expect(mapErrorToUserMessage(err)).not.toContain('SERVER SENTENCE');
    expect(mapErrorToUserMessage(new Error('plain failure'))).toBe('plain failure');
  });
});
