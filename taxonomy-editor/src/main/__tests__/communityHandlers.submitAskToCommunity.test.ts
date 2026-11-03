// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4746/t/4612: the 'submit-ask-to-community' IPC handler — uploads the full InquiryResult to
// the unauthenticated draft endpoint for desktop Ask "Share to Community" (a desktop result has
// no server-side counterpart, t/4611). Mirrors the shape of the existing 'community-submit'
// handler in the same file (same CORS-bypass rationale, same SSRF guard, same
// never-swallow-errors contract), with its own (stricter) payload schema (t/4743).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  net: { fetch: (...args: unknown[]) => fetchMock(...args) },
}));

vi.mock('../communityReviewIO.js', () => ({
  isAzureReviewConfigured: vi.fn(() => false),
  adminReviewQueue: vi.fn(),
  adminReviewStats: vi.fn(),
  adminReviewDetail: vi.fn(),
  adminReviewAction: vi.fn(),
  adminRemoveCommunityItem: vi.fn(),
}));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: vi.fn(() => null) }));

import { ipcMain } from 'electron';
import { registerCommunityHandlers } from '../ipc/communityHandlers.js';
import type { InquiryResult } from '../../../../lib/inquiry/index.js';

type Handler = (...args: unknown[]) => unknown;
function handlers(): Record<string, Handler> {
  const map: Record<string, Handler> = {};
  for (const [ch, fn] of (ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }).mock.calls) map[ch] = fn;
  return map;
}

function fakeResult(): InquiryResult {
  return {
    schemaVersion: 1,
    request: { question: 'Should AI be paused?', fidelity: 'quick' },
    campVerdicts: [], convergences: [], evidenceLayers: [], unresolvedGaps: [], calibration: [],
    derivation: { fidelity: 'quick', models: {}, rounds: 4, callBudget: 20 },
    grounding: { nodesByCamp: {} },
    singleRunCaveat: 'Single run; not yet replicated.',
  } as unknown as InquiryResult;
}

const BASE_URL = 'https://community.example.com';

describe('submit-ask-to-community IPC handler (t/4746)', () => {
  beforeEach(() => {
    (ipcMain.handle as unknown as { mockReset: () => void }).mockReset();
    fetchMock.mockReset();
    registerCommunityHandlers();
  });

  it('POSTs the validated { result, note } payload to /api/community/submit/draft and returns { draftId, link }', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ draftId: 'abc123', link: 'https://community.example.com/share/ask-draft/abc123' }),
    });
    const h = handlers();
    const result = await h['submit-ask-to-community'](null, BASE_URL, fakeResult(), 'my note');

    expect(result).toEqual({ draftId: 'abc123', link: 'https://community.example.com/share/ask-draft/abc123' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://community.example.com/api/community/submit/draft');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.result.schemaVersion).toBe(1);
    expect(body.note).toBe('my note');
  });

  it('defaults note to empty string when omitted (t/4743 schema default)', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ draftId: 'x', link: 'https://x' }) });
    const h = handlers();
    await h['submit-ask-to-community'](null, BASE_URL, fakeResult(), undefined);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.note).toBe('');
  });

  it('rejects a non-http(s) baseUrl before any network call', async () => {
    const h = handlers();
    await expect(h['submit-ask-to-community'](null, 'file:///etc/passwd', fakeResult(), 'note')).rejects.toThrow(/http\(s\)/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid payload (oversized note) before any network call', async () => {
    const h = handlers();
    await expect(h['submit-ask-to-community'](null, BASE_URL, fakeResult(), 'x'.repeat(5001))).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid payload (malformed result) before any network call', async () => {
    const h = handlers();
    await expect(h['submit-ask-to-community'](null, BASE_URL, { bogus: true }, 'note')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces the server error message on a non-ok response (t/4611: never swallowed)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, statusText: 'Too Many Requests', json: async () => ({ error: 'Client submissions at quota' }) });
    const h = handlers();
    await expect(h['submit-ask-to-community'](null, BASE_URL, fakeResult(), 'note')).rejects.toThrow('Client submissions at quota');
  });

  it('rethrows a network failure (t/4611: never swallowed)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const h = handlers();
    await expect(h['submit-ask-to-community'](null, BASE_URL, fakeResult(), 'note')).rejects.toThrow('ECONNREFUSED');
  });
});
