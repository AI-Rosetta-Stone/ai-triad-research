// @vitest-environment node

/**
 * t/2895 — runtime per-user credential override is deprecated in hosted (non-filesystem) mode.
 * App-install token is the canonical hosted auth path; per-user map is dead code in hosted.
 *
 * Covers:
 *   - setRuntimeCredentials() throws ActionableError { statusCode: 409 } in hosted mode
 *   - clearRuntimeCredentials() is a no-op (does not throw) in hosted mode
 *   - getCredentials() returns App install token in hosted mode, never per-user map
 *   - getCredentials() falls back to GITHUB_TOKEN env in hosted mode
 *   - getCredentials() emits a FR system.error when all rungs exhausted (Condition 1, t/2895)
 *   - getCredentials() emits FR error when GITHUB_REPO is unset
 *   - getRepoSlug() returns env GITHUB_REPO in hosted mode, ignoring any map entry
 *   - ALS isolation: set attempt throws, subsequent getCredentials() under any principal
 *     returns the shared token, not the rejected value
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runWithUser, type UserContext } from '../security/userContext.js';

// ── STORAGE_MODE mock (must be before the module under test is imported) ──
vi.mock('../config.js', () => ({ STORAGE_MODE: 'blob', CACHE_DIR: '/tmp/test-cache' }));

// ── Flight recorder mock ──
const frRecord = vi.fn();
vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: () => ({ record: frRecord }),
}));

// ── getInstallationToken mock (module-internal; accessed via vi.mock of the module) ──
// We mock the fetch used inside getInstallationToken instead of the function directly.
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  setRuntimeCredentials,
  clearRuntimeCredentials,
  getCredentials,
  getRepoSlug,
} from '../security/githubAppAuth.js';

function asUser<T>(principalName: string, fn: () => T): T {
  const ctx: UserContext = { principalName, idp: 'github', storageUserId: principalName, isAnonymous: false };
  return runWithUser(ctx, fn);
}

const SAVED: Record<string, string | undefined> = {};
const ENV_KEYS = ['GITHUB_REPO', 'GITHUB_TOKEN', 'GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_APP_PRIVATE_KEY'];

beforeEach(() => {
  for (const k of ENV_KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; }
  frRecord.mockClear();
  mockFetch.mockReset();
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
});

describe('t/2895 hosted-mode credential gating (STORAGE_MODE !== filesystem)', () => {
  it('setRuntimeCredentials() throws ActionableError { statusCode: 409 } in hosted mode', () => {
    expect(() => asUser('alice', () => setRuntimeCredentials('alice/repo', 'tok-alice')))
      .toThrow();
    try {
      asUser('alice', () => setRuntimeCredentials('alice/repo', 'tok-alice'));
    } catch (err) {
      expect((err as { statusCode?: number }).statusCode).toBe(409);
      expect((err as { goal?: string }).goal).toBeDefined();
      expect((err as { problem?: string }).problem).toBeDefined();
      expect((err as { location?: string }).location).toBeDefined();
      expect(Array.isArray((err as { nextSteps?: unknown[] }).nextSteps)).toBe(true);
    }
  });

  it('clearRuntimeCredentials() is a no-op (does not throw) in hosted mode', () => {
    expect(() => asUser('alice', () => clearRuntimeCredentials())).not.toThrow();
  });

  it('getRepoSlug() returns env GITHUB_REPO in hosted mode', () => {
    process.env.GITHUB_REPO = 'owner/hosted-repo';
    expect(getRepoSlug()).toBe('owner/hosted-repo');
  });

  it('getRepoSlug() returns null when GITHUB_REPO is unset in hosted mode', () => {
    expect(getRepoSlug()).toBeNull();
  });

  it('getCredentials() returns GITHUB_TOKEN env when no App install token in hosted mode', async () => {
    process.env.GITHUB_REPO = 'owner/repo';
    process.env.GITHUB_TOKEN = 'pat-env-token';
    // No GITHUB_APP_ID → getInstallationToken() returns null without network call
    const creds = await getCredentials();
    expect(creds).toEqual({ repo: 'owner/repo', token: 'pat-env-token', mode: 'pat' });
  });

  it('getCredentials() NEVER returns per-user map entry in hosted mode even if map were populated', async () => {
    process.env.GITHUB_REPO = 'owner/repo';
    process.env.GITHUB_TOKEN = 'shared-env-token';
    // Attempt to set per-user creds — will throw; creds NOT stored
    try { asUser('alice', () => setRuntimeCredentials('alice/repo', 'tok-alice')); } catch { /* expected */ }
    // getCredentials() should return shared env token, not alice's rejected creds
    const creds = await asUser('alice', () => getCredentials());
    expect(creds?.token).toBe('shared-env-token');
    expect(creds?.repo).toBe('owner/repo');
  });

  it('getCredentials() emits FR system.error when all credential rungs are exhausted', async () => {
    process.env.GITHUB_REPO = 'owner/repo';
    // No GITHUB_APP_ID, no GITHUB_TOKEN → both rungs fail
    const creds = await getCredentials();
    expect(creds).toBeNull();
    expect(frRecord).toHaveBeenCalledOnce();
    const call = frRecord.mock.calls[0][0] as { type: string; level: string; message: string };
    expect(call.type).toBe('system.error');
    expect(call.level).toBe('error');
    expect(call.message).toMatch(/getCredentials\(\) resolved to null in hosted mode/);
  });

  it('getCredentials() absorbs getInstallationToken() throw and falls back to GITHUB_TOKEN env', async () => {
    // App configured but network blips — fetch throws inside getInstallationToken().
    // Must NOT propagate; must fall through to GITHUB_TOKEN and return it.
    process.env.GITHUB_REPO = 'owner/repo';
    process.env.GITHUB_TOKEN = 'pat-fallback';
    process.env.GITHUB_APP_ID = 'app-123';
    process.env.GITHUB_APP_INSTALLATION_ID = 'inst-456';
    process.env.GITHUB_APP_PRIVATE_KEY = 'dummy-key-triggers-fetch';
    mockFetch.mockRejectedValueOnce(new Error('network failure'));
    const creds = await getCredentials();
    // Must not throw; must return the PAT fallback
    expect(creds).toEqual({ repo: 'owner/repo', token: 'pat-fallback', mode: 'pat' });
    // t/653: the fallback is no longer silent; it records exactly one WARN event (no "all rungs exhausted" error).
    expect(frRecord).toHaveBeenCalledOnce();
    expect((frRecord.mock.calls[0][0] as { error: { name: string } }).error.name).toBe('PatFallbackTaken');
  });

  it('getCredentials() absorbs getInstallationToken() throw and emits FR error when no fallback', async () => {
    // App configured, network blips, and no GITHUB_TOKEN → all rungs exhausted → null + FR error.
    process.env.GITHUB_REPO = 'owner/repo';
    process.env.GITHUB_APP_ID = 'app-123';
    process.env.GITHUB_APP_INSTALLATION_ID = 'inst-456';
    process.env.GITHUB_APP_PRIVATE_KEY = 'dummy-key-triggers-fetch';
    mockFetch.mockRejectedValueOnce(new Error('network failure'));
    const creds = await getCredentials();
    expect(creds).toBeNull();
    expect(frRecord).toHaveBeenCalledOnce();
    const call = frRecord.mock.calls[0][0] as { type: string; level: string; message: string };
    expect(call.type).toBe('system.error');
    expect(call.message).toMatch(/getCredentials\(\) resolved to null in hosted mode/);
  });

  it('getCredentials() emits FR system.error when GITHUB_REPO is unset', async () => {
    process.env.GITHUB_TOKEN = 'pat-env-token';
    // GITHUB_REPO not set → repo is invalid
    const creds = await getCredentials();
    expect(creds).toBeNull();
    expect(frRecord).toHaveBeenCalledOnce();
    const call = frRecord.mock.calls[0][0] as { message: string };
    expect(call.message).toMatch(/GITHUB_REPO/);
  });

  it('ALS isolation: set fails in hosted, getCredentials under any principal returns shared token', async () => {
    process.env.GITHUB_REPO = 'owner/repo';
    process.env.GITHUB_TOKEN = 'shared-token';
    // Both alice and bob try to set; both fail; both get the shared env token
    for (const user of ['alice', 'bob']) {
      try { asUser(user, () => setRuntimeCredentials(`${user}/repo`, `tok-${user}`)); } catch { /* expected */ }
    }
    const aliceCreds = await asUser('alice', () => getCredentials());
    const bobCreds = await asUser('bob', () => getCredentials());
    expect(aliceCreds?.token).toBe('shared-token');
    expect(bobCreds?.token).toBe('shared-token');
    expect(aliceCreds?.repo).toBe('owner/repo');
    expect(bobCreds?.repo).toBe('owner/repo');
  });
});
