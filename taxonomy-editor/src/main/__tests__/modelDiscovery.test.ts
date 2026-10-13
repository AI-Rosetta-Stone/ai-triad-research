// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4161 — main/modelDiscovery.ts's refreshAIModels wrapper. The renderer bridge
// contract (RefreshModelsRequest) only carries proposal/approvedBy/reason — the
// authenticated identity is HOST-SET (t/4160): on desktop there's no session distinct
// from the OS account, so both `principal` and `osUser` must be filled from
// os.userInfo(), never taken from the IPC payload.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('os', () => ({
  default: { userInfo: () => ({ username: 'test-os-user' }) },
  userInfo: () => ({ username: 'test-os-user' }),
}));

vi.mock('../apiKeyStore.js', () => ({ loadApiKey: vi.fn(() => 'fake-key') }));
vi.mock('../fileIO.js', () => ({ PROJECT_ROOT: '/fake/root' }));

const mockLibRefreshAIModels = vi.hoisted(() => vi.fn(async () => ({ proposal: null, updated: false })));
vi.mock('../../../../lib/electron-shared/modelDiscovery.js', () => ({
  refreshAIModels: mockLibRefreshAIModels,
}));

import { refreshAIModels } from '../modelDiscovery.js';

beforeEach(() => {
  mockLibRefreshAIModels.mockClear();
});

describe('refreshAIModels (t/4161)', () => {
  it('no opts: a plain refresh — no accept, no dryRun', async () => {
    await refreshAIModels();
    const [, opts] = mockLibRefreshAIModels.mock.calls[0];
    expect(opts).toEqual({ dryRun: undefined });
  });

  it('dryRun passes through unchanged', async () => {
    await refreshAIModels({ dryRun: true });
    const [, opts] = mockLibRefreshAIModels.mock.calls[0];
    expect(opts.dryRun).toBe(true);
  });

  it('accept gets the OS user filled in as BOTH principal and osUser — never from the request', async () => {
    const proposal = { catalogFingerprint: 'sha256:a', hash: 'sha256:b', changes: [] };
    await refreshAIModels({ accept: { proposal, approvedBy: 'Jane', reason: 'vendor rotation' } });
    const [, opts] = mockLibRefreshAIModels.mock.calls[0];
    expect(opts.accept).toEqual({
      proposal, approvedBy: 'Jane', reason: 'vendor rotation',
      principal: 'test-os-user', osUser: 'test-os-user',
    });
  });

  it('the loadApiKey dep still forwards to apiKeyStore', async () => {
    await refreshAIModels();
    const [deps] = mockLibRefreshAIModels.mock.calls[0];
    expect(deps.loadApiKey('gemini')).toBe('fake-key');
    expect(deps.repoRoot).toBe('/fake/root');
  });
});
