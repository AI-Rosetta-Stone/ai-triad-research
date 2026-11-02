// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4746/t/4612: web build's REST implementation of the desktop/web-shared Ask
// "Share to Community" upload — POST /api/community/submit/draft. Extracted out of
// web-bridge.ts (ADR-007 line budget); tested standalone so importing it doesn't require
// mocking the rest of web-bridge.ts's large dependency surface.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { resilientFetch } = vi.hoisted(() => ({ resilientFetch: vi.fn() }));

vi.mock('../resilience', () => ({
  resilientFetch,
  categorizeEndpoint: () => 'mutation',
}));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { submitAskToCommunityRest } from '../communityAskSubmit';

function jsonResponse(body: unknown, ok = true, status = 200, statusText = 'OK'): Response {
  return { ok, status, statusText, json: async () => body } as unknown as Response;
}

describe('submitAskToCommunityRest (t/4746)', () => {
  beforeEach(() => {
    resilientFetch.mockReset();
  });

  it('POSTs { result, note } to /api/community/submit/draft and returns { draftId, link }', async () => {
    resilientFetch.mockResolvedValue(jsonResponse({ draftId: 'd1', link: 'https://x/share/ask-draft/d1' }));
    const result = await submitAskToCommunityRest({ schemaVersion: 1 }, 'my note');

    expect(result).toEqual({ draftId: 'd1', link: 'https://x/share/ask-draft/d1' });
    expect(resilientFetch).toHaveBeenCalledTimes(1);
    const [path, init, opts] = resilientFetch.mock.calls[0];
    expect(path).toBe('/api/community/submit/draft');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ result: { schemaVersion: 1 }, note: 'my note' });
    expect(opts.maxRetries).toBe(0); // non-idempotent POST — never auto-retried
  });

  it('throws the server-supplied error message on a non-ok response', async () => {
    resilientFetch.mockResolvedValue(jsonResponse({ error: 'Client submissions at quota' }, false, 429, 'Too Many Requests'));
    await expect(submitAskToCommunityRest({}, 'note')).rejects.toThrow('Client submissions at quota');
  });

  it('falls back to statusText when the non-ok response body is not valid JSON', async () => {
    resilientFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error', json: async () => { throw new Error('not json'); } } as unknown as Response);
    await expect(submitAskToCommunityRest({}, 'note')).rejects.toThrow('Internal Server Error');
  });

  it('falls back to "HTTP {status}" when the non-ok JSON body has no error field', async () => {
    resilientFetch.mockResolvedValue(jsonResponse({}, false, 500, 'Internal Server Error'));
    await expect(submitAskToCommunityRest({}, 'note')).rejects.toThrow('HTTP 500');
  });

  it('rethrows a network failure (t/4611: never swallowed)', async () => {
    resilientFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(submitAskToCommunityRest({}, 'note')).rejects.toThrow('ECONNREFUSED');
  });
});
