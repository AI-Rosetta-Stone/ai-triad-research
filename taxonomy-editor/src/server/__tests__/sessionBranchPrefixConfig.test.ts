// @vitest-environment node
//
// t/4446 C1 (SO e/353#2) — BRANCH_PREFIX was a hardcoded 'api-session/' constant
// shared by every deployment, so a user signed into both staging and prod resolved
// to the SAME branch in the shared ai-triad-data repo. It is now derived from
// SESSION_BRANCH_PREFIX at module load, so each case resets the module registry
// and re-imports under a fresh env (same pattern as configCacheDir.test.ts).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('session-branch prefix is per-environment config (t/4446 C1)', () => {
  const orig = process.env.SESSION_BRANCH_PREFIX;

  beforeEach(() => { vi.resetModules(); });

  afterEach(() => {
    if (orig === undefined) delete process.env.SESSION_BRANCH_PREFIX;
    else process.env.SESSION_BRANCH_PREFIX = orig;
  });

  async function loadModule() {
    return import('../storage/sessionBranchManager.js');
  }

  it('defaults to api-session/ when SESSION_BRANCH_PREFIX is unset (prod/dev unchanged)', async () => {
    delete process.env.SESSION_BRANCH_PREFIX;
    const mod = await loadModule();
    expect(mod.BRANCH_PREFIX).toBe('api-session/');
    expect(mod.sessionBranchNameFor('alice')).toBe('api-session/alice');
    expect(mod.isSessionBranchRef('api-session/alice')).toBe(true);
  });

  it('a staging-configured backend never resolves or creates a bare api-session/ ref', async () => {
    process.env.SESSION_BRANCH_PREFIX = 'staging-api-session/';
    const mod = await loadModule();
    expect(mod.BRANCH_PREFIX).toBe('staging-api-session/');
    expect(mod.sessionBranchNameFor('alice')).toBe('staging-api-session/alice');

    // The core isolation invariant: a branch under the OTHER environment's
    // namespace is never recognized as this deployment's own session branch.
    expect(mod.isSessionBranchRef('api-session/alice')).toBe(false);
    // And this deployment's own branch is correctly recognized, under its own prefix.
    expect(mod.isSessionBranchRef('staging-api-session/alice')).toBe(true);
  });

  it('stripSessionBranchPrefix strips exactly this deployment\'s configured prefix', async () => {
    process.env.SESSION_BRANCH_PREFIX = 'staging-api-session/';
    const mod = await loadModule();
    expect(mod.stripSessionBranchPrefix('staging-api-session/alice')).toBe('alice');
  });

  it('normalizes a prefix missing a trailing slash', async () => {
    process.env.SESSION_BRANCH_PREFIX = 'staging-api-session';
    const mod = await loadModule();
    expect(mod.BRANCH_PREFIX).toBe('staging-api-session/');
  });
});
