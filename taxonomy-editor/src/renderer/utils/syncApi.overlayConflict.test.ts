// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4313: the save-conflict plumbing the Sync banner (t/4314) builds on. Contract: #3467's body.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

const { overlayConflictPaths, resolveOverlayConflictUseTheirs, resolveOverlayConflictKeepMine } = await import('./syncApi');
import type { SyncStatus } from './syncApi';

const base: SyncStatus = {
  enabled: true, unsynced_count: 2, session_branch: 'session/u', pr_number: null, pr_url: null,
  push_pending: false, github_configured: true, main_updated_available: false, rebase_in_progress: false,
};

let fetchSpy: ReturnType<typeof vi.fn>;
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
beforeEach(() => { fetchSpy = vi.fn(); globalThis.fetch = fetchSpy as unknown as typeof fetch; });
afterEach(() => { vi.restoreAllMocks(); });

describe('overlayConflictPaths', () => {
  it('returns the conflicted files when the state is conflict', () => {
    expect(overlayConflictPaths({ ...base, overlay_commit: { state: 'conflict', at: 1, conflictedPaths: ['skeptic.json', 'edges.json'] } }))
      .toEqual(['skeptic.json', 'edges.json']);
  });

  it('is null for every other state, for an empty list, and when the field is absent (server flag off)', () => {
    expect(overlayConflictPaths({ ...base, overlay_commit: { state: 'pending', at: 1 } })).toBeNull();
    expect(overlayConflictPaths({ ...base, overlay_commit: { state: 'failed', at: 1, error: 'x' } })).toBeNull();
    expect(overlayConflictPaths({ ...base, overlay_commit: { state: 'conflict', at: 1, conflictedPaths: [] } })).toBeNull();
    expect(overlayConflictPaths(base)).toBeNull();
  });
});

describe('resolution calls (whole batch, POST, no retry, with a timeout)', () => {
  it('"Use theirs" posts an empty body to the use-theirs route and returns what was discarded', async () => {
    fetchSpy.mockResolvedValue(ok({ discarded: ['skeptic.json', 'edges.json'] }));
    await expect(resolveOverlayConflictUseTheirs()).resolves.toEqual({ discarded: ['skeptic.json', 'edges.json'] });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/sync/overlay-conflicts/use-theirs');
    expect(init).toMatchObject({ method: 'POST', body: '{}' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('"Keep mine" posts an empty body to the keep-mine route and returns the commit result', async () => {
    fetchSpy.mockResolvedValue(ok({ committed: true, commitSha: 'abc', filesCommitted: 2, stillConflicted: [] }));
    await expect(resolveOverlayConflictKeepMine()).resolves.toMatchObject({ committed: true, stillConflicted: [] });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/sync/overlay-conflicts/keep-mine');
    expect(init).toMatchObject({ method: 'POST', body: '{}' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('a failed resolution throws an actionable error and is NOT retried', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 503, json: async () => ({}), text: async () => 'unavailable' });
    await expect(resolveOverlayConflictKeepMine()).rejects.toThrow(/keep-mine failed with HTTP 503/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
