// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4031 part (1): the refresh bridge contract. A plain refresh must look exactly as it did before (no IPC
// argument, no POST body), so the silent New Debate / New Op-Ed refreshes are unaffected; opts, when given,
// reach the host unchanged.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RefreshModelsRequest } from '../types';

const mockResilientFetch = vi.fn<(path: string, init: RequestInit, opts: unknown) => Promise<Response>>();

vi.mock('../resilience', () => ({
  resilientFetch: (...args: unknown[]) => mockResilientFetch(args[0] as string, args[1] as RequestInit, args[2]),
  categorizeEndpoint: () => 'data',
  registerConnectionPoolProvider: vi.fn(),
  getResilienceState: vi.fn(),
  subscribeResilience: vi.fn(),
  resetResilience: vi.fn(),
}));

vi.mock('@lib/debate/errors', () => ({
  ActionableError: class ActionableError extends Error {},
}));

vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: vi.fn() }),
}));

vi.mock('../instrumentBridge', () => ({
  instrumentBridge: (raw: unknown) => raw,
}));

vi.mock('../../utils/keyShareCrypto', () => ({
  encryptKeysForSharing: vi.fn(),
  decryptKeysFromSharing: vi.fn(),
}));

vi.mock('../../hooks/useQuotaWarning', () => ({
  onQuotaMilestone: vi.fn(),
}));

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    clone() { return okJson(body); },
  } as unknown as Response;
}

const proposal = { catalogFingerprint: 'fp-1', hash: 'h-1', changes: [{ slot: 'defaults.debate', from: 'old-model', to: 'new-model' }] };
const acceptOpts = { accept: { proposal, approvedBy: 'Ada', reason: 'vendor retired old-model' } } as unknown as RefreshModelsRequest;

describe('web-bridge refreshAIModels (t/4031)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResilientFetch.mockResolvedValue(okJson({ written: false, totalModels: 0 }));
  });

  it('a plain refresh POSTs with no body, as before', async () => {
    const { api } = await import('../web-bridge');
    await api.refreshAIModels();
    const [path, init] = mockResilientFetch.mock.calls[0];
    expect(path).toBe('/api/models/refresh');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('a dry run sends { dryRun: true } as the body', async () => {
    const { api } = await import('../web-bridge');
    await api.refreshAIModels({ dryRun: true });
    expect(JSON.parse(mockResilientFetch.mock.calls[0][1].body as string)).toEqual({ dryRun: true });
  });

  it('an accept sends the exact proposal, name and reason, and returns the server result', async () => {
    mockResilientFetch.mockResolvedValue(okJson({ written: true, totalModels: 9 }));
    const { api } = await import('../web-bridge');
    const result = await api.refreshAIModels(acceptOpts);
    expect(JSON.parse(mockResilientFetch.mock.calls[0][1].body as string)).toEqual(acceptOpts);
    expect(result).toEqual({ written: true, totalModels: 9 });
  });
});

describe('electron-bridge refreshAIModels (t/4031)', () => {
  const origWindow = (globalThis as Record<string, unknown>).window;
  const refresh = vi.fn().mockResolvedValue({ written: false, totalModels: 0 });

  beforeEach(() => {
    refresh.mockClear();
    (globalThis as Record<string, unknown>).window = { electronAPI: { refreshAIModels: refresh } };
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).window = origWindow;
    vi.resetModules();
  });

  it('a plain refresh invokes IPC with no argument, as before', async () => {
    const { api } = await import('../electron-bridge');
    await api.refreshAIModels();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0]).toEqual([]);
  });

  it('opts are forwarded unchanged', async () => {
    const { api } = await import('../electron-bridge');
    await api.refreshAIModels(acceptOpts);
    expect(refresh).toHaveBeenCalledWith(acceptOpts);
  });
});
