// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3582 — "Ask a question" bridge methods (startInquiry / getInquiry), both builds.
// Route contract: t/3582#1 (server: routes/inquiry.ts, t/3581).

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const { resilientFetch } = vi.hoisted(() => ({ resilientFetch: vi.fn() }));

vi.mock('../resilience', () => ({
  resilientFetch,
  categorizeEndpoint: () => 'mutation',
  registerConnectionPoolProvider: vi.fn(),
}));
vi.mock('@lib/debate/errors', () => ({ ActionableError: class ActionableError extends Error {} }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('../instrumentBridge', () => ({ instrumentBridge: (raw: unknown) => raw }));

describe('electron-bridge inquiry delegation', () => {
  const origWindow = (globalThis as Record<string, unknown>).window;

  afterEach(() => {
    (globalThis as Record<string, unknown>).window = origWindow;
    vi.resetModules();
  });

  it('delegates startInquiry/getInquiry to window.electronAPI when present', async () => {
    const startInquiry = vi.fn().mockResolvedValue({ jobId: 'job-1' });
    const getInquiry = vi.fn().mockResolvedValue({ jobId: 'job-1', status: 'done', progressPct: 100, terminationReason: null, resultId: 'job-1', error: null });
    (globalThis as Record<string, unknown>).window = { electronAPI: { startInquiry, getInquiry } };
    const mod = await import('../electron-bridge');

    await mod.api.startInquiry({ question: 'q', fidelity: 'quick' }, 'idem-key');
    expect(startInquiry).toHaveBeenCalledWith({ question: 'q', fidelity: 'quick' }, 'idem-key');

    await mod.api.getInquiry('job-1');
    expect(getInquiry).toHaveBeenCalledWith('job-1');
  });

  it('maps a null getInquiry result (unknown job) to a thrown error, matching the web bridge 404 (t/3579)', async () => {
    const getInquiry = vi.fn().mockResolvedValue(null);
    (globalThis as Record<string, unknown>).window = { electronAPI: { startInquiry: vi.fn(), getInquiry } };
    const mod = await import('../electron-bridge');

    await expect(mod.api.getInquiry('missing-job')).rejects.toThrow();
  });

  // t/4898/t/4895: desktop parity for rename/delete.
  it('delegates renameInquiry/deleteInquiry to window.electronAPI', async () => {
    const renameInquiry = vi.fn().mockResolvedValue(undefined);
    const deleteInquiry = vi.fn().mockResolvedValue(undefined);
    (globalThis as Record<string, unknown>).window = { electronAPI: { renameInquiry, deleteInquiry } };
    const mod = await import('../electron-bridge');

    await mod.api.renameInquiry('job-1', 'New title');
    expect(renameInquiry).toHaveBeenCalledWith('job-1', 'New title');

    await mod.api.deleteInquiry('job-1');
    expect(deleteInquiry).toHaveBeenCalledWith('job-1');
  });
});

describe('web-bridge inquiry REST calls', () => {
  beforeEach(() => {
    vi.resetModules();
    resilientFetch.mockReset();
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
      clone() { return jsonResponse(body, status); },
    } as unknown as Response;
  }

  it('startInquiry POSTs to /api/inquiry with the Idempotency-Key header, not in the body', async () => {
    resilientFetch.mockResolvedValue(jsonResponse({ jobId: 'job-9' }, 202));
    const { api } = await import('../web-bridge');

    const result = await api.startInquiry({ question: 'What counts as harm?', fidelity: 'standard' }, 'idem-1');

    expect(result).toEqual({ jobId: 'job-9' });
    const [path, init] = resilientFetch.mock.calls[0];
    expect(path).toBe('/api/inquiry');
    expect(init.headers['Idempotency-Key']).toBe('idem-1');
    const sentBody = JSON.parse(init.body);
    expect(sentBody).toEqual({ question: 'What counts as harm?', fidelity: 'standard' });
    expect(sentBody['Idempotency-Key']).toBeUndefined();
  });

  it('startInquiry omits the Idempotency-Key header when none is given', async () => {
    resilientFetch.mockResolvedValue(jsonResponse({ jobId: 'job-10' }, 202));
    const { api } = await import('../web-bridge');

    await api.startInquiry({ question: 'q', fidelity: 'quick' });

    const [, init] = resilientFetch.mock.calls[0];
    expect(init.headers['Idempotency-Key']).toBeUndefined();
  });

  it('getInquiry GETs /api/inquiry/:jobId and returns the poll view, including a terminal result', async () => {
    const view = {
      jobId: 'job-9', status: 'done_truncated', progressPct: 100,
      terminationReason: 'api_ceiling', resultId: 'job-9', error: null,
      result: { schemaVersion: 1 },
    };
    resilientFetch.mockResolvedValue(jsonResponse(view));
    const { api } = await import('../web-bridge');

    const result = await api.getInquiry('job-9');

    expect(result).toEqual(view);
    const [path] = resilientFetch.mock.calls[0];
    expect(path).toBe('/api/inquiry/job-9');
  });

  it('encodeURIComponent-escapes the jobId path segment', async () => {
    resilientFetch.mockResolvedValue(jsonResponse({ jobId: 'a/b', status: 'queued', progressPct: 0, terminationReason: null, resultId: null, error: null }));
    const { api } = await import('../web-bridge');

    await api.getInquiry('a/b');

    const [path] = resilientFetch.mock.calls[0];
    expect(path).toBe('/api/inquiry/a%2Fb');
  });

  // t/4898/t/4897: rename/delete — AppAPI types these Promise<void> (Quality, t/4898#3/p/356#166),
  // so the web route's response body is discarded rather than returned to the caller.
  it('renameInquiry PATCHes /api/inquiry/:jobId with {title} and resolves void', async () => {
    resilientFetch.mockResolvedValue(jsonResponse({ jobId: 'job-9', title: 'New title' }));
    const { api } = await import('../web-bridge');

    const result = await api.renameInquiry('job-9', 'New title');

    expect(result).toBeUndefined();
    const [path, init] = resilientFetch.mock.calls[0];
    expect(path).toBe('/api/inquiry/job-9');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ title: 'New title' });
  });

  it('deleteInquiry DELETEs /api/inquiry/:jobId and resolves void', async () => {
    resilientFetch.mockResolvedValue(jsonResponse({ jobId: 'job-9', deleted: true }));
    const { api } = await import('../web-bridge');

    const result = await api.deleteInquiry('job-9');

    expect(result).toBeUndefined();
    const [path, init] = resilientFetch.mock.calls[0];
    expect(path).toBe('/api/inquiry/job-9');
    expect(init.method).toBe('DELETE');
  });

  it('deleteInquiry surfaces a 409 (still running) as an httpStatus-tagged error, not a generic failure', async () => {
    resilientFetch.mockResolvedValue(jsonResponse({ error: 'Inquiry is still running — wait for it to finish before deleting' }, 409));
    const { api } = await import('../web-bridge');

    await expect(api.deleteInquiry('job-9')).rejects.toMatchObject({ httpStatus: 409 });
  });
});
