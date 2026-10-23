// @vitest-environment node
//
// t/4448 (t/4446 C1) — the merged-PR webhook cleanup in routes/sync.ts matched the
// hardcoded 'api-session/' literal, so it ignored SESSION_BRANCH_PREFIX. It now uses
// sessionBranchManager's isSessionBranchRef/stripSessionBranchPrefix, so a deployment
// only ever cleans up branches under its OWN configured prefix. Each case resets the
// module registry and re-imports under a fresh env (sessionBranchPrefixConfig pattern).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../storage/overlayCommitScheduler.js', () => ({ getOverlayCommitStatus: vi.fn(() => undefined) }));
vi.mock('../security/userContext.js', () => ({ getCurrentUserId: () => 'tester', isAnonymousUser: () => false }));
vi.mock('../community/community.js', () => ({ isAdmin: vi.fn(() => false) }));
vi.mock('../community/admin/reviewRegistry.js', () => ({ requireAdmin: vi.fn(() => true) }));
vi.mock('../community/nodeConflicts.js', () => ({ computeNodeConflicts: vi.fn() }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('../logger.js', () => {
  const l = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { log: { server: l, github: l } };
});

function mergedPr(headRef: string): Record<string, unknown> {
  return { action: 'closed', pull_request: { merged: true, base: { ref: 'main' }, head: { ref: headRef } } };
}

function fakeSessionManager(branches: Array<{ userId: string; branch: string }>) {
  return {
    getActiveBranches: vi.fn(() => branches),
    deleteBranch: vi.fn(() => Promise.resolve()),
  };
}

async function loadCleanup() {
  const mod = await import('../routes/sync.js');
  return mod.handleMergedPrBranchCleanup;
}

describe('merged-PR session-branch cleanup honours the configured prefix (t/4448)', () => {
  const orig = process.env.SESSION_BRANCH_PREFIX;

  beforeEach(() => { vi.resetModules(); });

  afterEach(() => {
    if (orig === undefined) delete process.env.SESSION_BRANCH_PREFIX;
    else process.env.SESSION_BRANCH_PREFIX = orig;
  });

  it('a staging-configured server ignores a merged PR from the default api-session/ namespace', async () => {
    process.env.SESSION_BRANCH_PREFIX = 'staging-api-session/';
    const cleanup = await loadCleanup();
    const sm = fakeSessionManager([{ userId: 'alice', branch: 'api-session/alice' }]);

    cleanup(mergedPr('api-session/alice'), sm as never);

    expect(sm.getActiveBranches).not.toHaveBeenCalled();
    expect(sm.deleteBranch).not.toHaveBeenCalled();
  });

  it('a staging-configured server cleans up its own staging-api-session/ branch', async () => {
    process.env.SESSION_BRANCH_PREFIX = 'staging-api-session/';
    const cleanup = await loadCleanup();
    const sm = fakeSessionManager([{ userId: 'alice', branch: 'staging-api-session/alice' }]);

    cleanup(mergedPr('staging-api-session/alice'), sm as never);

    expect(sm.deleteBranch).toHaveBeenCalledWith('alice', 'pr-merged');
  });

  it('with the prefix unset, the default api-session/ branch is still cleaned up (prod unchanged)', async () => {
    delete process.env.SESSION_BRANCH_PREFIX;
    const cleanup = await loadCleanup();
    const sm = fakeSessionManager([{ userId: 'alice', branch: 'api-session/alice' }]);

    cleanup(mergedPr('api-session/alice'), sm as never);

    expect(sm.deleteBranch).toHaveBeenCalledWith('alice', 'pr-merged');
  });

  it('a prod-configured server ignores a staging-api-session/ branch', async () => {
    delete process.env.SESSION_BRANCH_PREFIX;
    const cleanup = await loadCleanup();
    const sm = fakeSessionManager([{ userId: 'alice', branch: 'staging-api-session/alice' }]);

    cleanup(mergedPr('staging-api-session/alice'), sm as never);

    expect(sm.deleteBranch).not.toHaveBeenCalled();
  });
});
