// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/4428: `fileExists` gains `opts.ref`, same contract as `readFile`/
 * `readBinaryFile` (t/4393). Two real, previously-latent gaps closed here:
 *
 * 1. The disk-cache manifest and in-memory `repoTree` represent `baseBranch`
 *    only (same class as t/4215/t/4393's cache-pollution fix) — a non-base
 *    ref must skip them and resolve via the Contents API instead.
 * 2. (TL t/4428#2 condition 1) the session-overlay check must itself be
 *    skipped when `opts.ref` is explicitly pinned away from the session's
 *    effective ref — otherwise a pin to 'main' could still answer from the
 *    session's own staged overlay, defeating the pin.
 *
 * LOCAL-ONLY FAILURE MODE (t/2281): if this fails with "undici major-version
 * skew", your local Node is outside the required range (package.json
 * engines: ">=22 <23"). CI uses node:22.23.2. Not a test or code defect.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isUndiciMajorAlignedWithRuntime } from '../storage/undiciInvariant.js';

const UNDICI_ALIGNED = isUndiciMajorAlignedWithRuntime();

vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const src = (actual.default ?? actual) as Record<string, unknown>;
  const patched = { ...src, promises: { ...(src.promises as object), rename: vi.fn().mockResolvedValue(undefined) } };
  return { ...patched, default: patched };
});

vi.mock('../security/githubAppAuth', () => ({
  getCredentials: vi.fn().mockResolvedValue({ repo: 'testowner/testrepo', token: 'test-token-abc123', mode: 'pat' as const }),
  getRepoSlug: vi.fn().mockReturnValue('testowner/testrepo'),
  getTokenExpiryMs: vi.fn().mockReturnValue(0),
}));

vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: vi.fn().mockReturnValue(null),
  FlightRecorder: vi.fn(),
}));

const defaultRateLimitHeaders = {
  'x-ratelimit-remaining': '4999',
  'x-ratelimit-limit': '5000',
  'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: new Headers({ ...defaultRateLimitHeaders, ...headers }) });
}

async function createBackend() {
  const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
  const backend = new GitHubAPIBackend({ cacheDir: '/var/cache/taxonomy-test', pollIntervalMs: 999_999_999, coherencyProbeRate: 0 });
  await backend.initialize();
  return backend;
}

type BackendInternals = {
  manifest: { files: Record<string, unknown> } | null;
  sessionOverlays: Map<string, Map<string, string>>;
};

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend.fileExists — opts.ref (t/4428)', () => {
  const fetchCalls: Array<{ url: string }> = [];
  const originalFetch = globalThis.fetch;

  /** `existsFor` maps a ref -> whether the Contents HEAD call for that ref
   *  should report the file present. Any ref not listed reports absent. */
  function stubFetch(existsFor: Record<string, boolean>, seenRefs: string[]): void {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      fetchCalls.push({ url });

      if (url.includes('/git/trees/')) return jsonResponse(200, { sha: 'tree-sha', tree: [] });
      if (url.includes('/git/refs/heads/')) return jsonResponse(200, { object: { sha: 'main-sha' } });
      if (url.includes('/contents/')) {
        // fileExistsViaContentsApi omits `?ref=` entirely when ref === baseBranch.
        const refMatch = /[?&]ref=([^&]+)/.exec(url);
        const ref = refMatch ? decodeURIComponent(refMatch[1]) : 'main';
        seenRefs.push(ref);
        return existsFor[ref] ? jsonResponse(200, { sha: 'blob-sha', size: 1, type: 'file' }) : jsonResponse(404, { message: 'Not Found' });
      }
      return jsonResponse(404, { message: 'Not Found' });
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    fetchCalls.length = 0;
    vi.stubEnv('AI_TRIAD_DATA_ROOT', '/var/cache/taxonomy-test');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  // Condition 1a (t/4428#2): an explicit pin away from the session's
  // effective ref must skip the session overlay entirely, not just the
  // main-only manifest/repoTree.
  it('an opts.ref pin away from the session skips the overlay, even if the overlay has the path', async () => {
    const seenRefs: string[] = [];
    stubFetch({ main: false }, seenRefs);
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    (backend as unknown as BackendInternals).sessionOverlays.set('alice', new Map([['some/file.json', 'STAGED CONTENT']]));

    const result = await backend.fileExists('/some/file.json', { ref: 'main' });

    // The overlay says this path exists (staged content); the pin to 'main'
    // must win, and main (per the stub) says it doesn't.
    expect(result).toBe(false);
    expect(seenRefs).toEqual(['main']);

    backend.shutdown();
  });

  it('opts.ref equal to the effective ref still consults the overlay (unaffected)', async () => {
    const seenRefs: string[] = [];
    stubFetch({}, seenRefs);
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    (backend as unknown as BackendInternals).sessionOverlays.set('alice', new Map([['some/file.json', 'STAGED CONTENT']]));

    const result = await backend.fileExists('/some/file.json', { ref: 'api-session/alice' });

    expect(result).toBe(true);
    expect(seenRefs).toEqual([]); // overlay hit — no API call at all

    backend.shutdown();
  });

  // Test arm (b) from t/4428#2: the behavior change. No opts, session
  // active, file present only on main's manifest — now correctly false,
  // where it would previously have (incorrectly) returned true.
  it('session active, no opts, file only in main\'s manifest — false (the behavior change)', async () => {
    const seenRefs: string[] = [];
    stubFetch({ 'api-session/alice': false }, seenRefs);
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    (backend as unknown as BackendInternals).manifest = { files: { 'some/main-only.json': { sha: 'x', etag: '', cachedAt: new Date().toISOString() } } };

    const result = await backend.fileExists('/some/main-only.json');

    expect(result).toBe(false);
    expect(seenRefs).toEqual(['api-session/alice']);

    backend.shutdown();
  });

  // Test arm (c): base branch, no session — unchanged path, manifest hit,
  // zero Contents API calls.
  it('base branch, no session, manifest hit — true, no Contents API call', async () => {
    const seenRefs: string[] = [];
    stubFetch({}, seenRefs);
    const backend = await createBackend();
    (backend as unknown as BackendInternals).manifest = { files: { 'some/base.json': { sha: 'x', etag: '', cachedAt: new Date().toISOString() } } };

    const result = await backend.fileExists('/some/base.json');

    expect(result).toBe(true);
    expect(fetchCalls.some(c => c.url.includes('/contents/'))).toBe(false);

    backend.shutdown();
  });

  // Test arm (d), the proof arm: a stale/wrong manifest entry for a
  // non-base ref must never be consulted. If the base-branch gate on the
  // manifest/repoTree check were removed, this would read `true` straight
  // from the manifest and go red.
  it('proof: a manifest entry is never consulted for a non-base ref', async () => {
    const seenRefs: string[] = [];
    stubFetch({ 'feature-branch': false }, seenRefs);
    const backend = await createBackend();
    // Seed the manifest as if main already has this file — if the fix were
    // reverted (manifest checked unconditionally), this would short-circuit
    // to `true` without ever calling the Contents API.
    (backend as unknown as BackendInternals).manifest = { files: { 'some/path.json': { sha: 'x', etag: '', cachedAt: new Date().toISOString() } } };

    const result = await backend.fileExists('/some/path.json', { ref: 'feature-branch' });

    expect(result).toBe(false);
    expect(seenRefs).toEqual(['feature-branch']);

    backend.shutdown();
  });

  it('opts.ref wins over an active session branch (no overlay entry)', async () => {
    const seenRefs: string[] = [];
    stubFetch({ main: true }, seenRefs);
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    const result = await backend.fileExists('/some/pinned.json', { ref: 'main' });

    expect(result).toBe(true);
    expect(seenRefs).toEqual(['main']);

    backend.shutdown();
  });
});
