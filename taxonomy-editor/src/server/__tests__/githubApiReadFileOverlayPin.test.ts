// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/4510: `readFile`'s session-overlay check ran before `opts.ref` was
 * resolved, so a pin to 'main' could still answer from the session's own
 * staged overlay — defeating the pin. Same bug class, same fix shape, as
 * t/4428#2's `fileExists` condition 1 (which TL asked to be checked here and
 * filed separately rather than folded into that PR).
 *
 * Not a blanket "always skip overlay when pinned" — `calibrationStore.ts`'s
 * append-within-request flows pin to 'main' while deliberately needing to
 * see the SAME request's own earlier append (which lands in the session
 * overlay, since the effective ref during an active session is the session
 * branch, not 'main'). Those call sites opt back in via
 * `opts.consultOverlayOnPin: true`, preserving their exact pre-fix behavior.
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

function base64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64');
}

async function createBackend() {
  const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
  const backend = new GitHubAPIBackend({ cacheDir: '/var/cache/taxonomy-test', pollIntervalMs: 999_999_999, coherencyProbeRate: 0 });
  await backend.initialize();
  return backend;
}

type BackendInternals = {
  sessionOverlays: Map<string, Map<string, string>>;
};

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend.readFile — overlay-before-pin (t/4510)', () => {
  const fetchCalls: Array<{ url: string }> = [];
  const originalFetch = globalThis.fetch;

  function stubFetch(mainContent: string): void {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      fetchCalls.push({ url });

      if (url.includes('/git/refs/heads/')) return jsonResponse(200, { object: { sha: 'main-sha' } });
      if (url.includes('/contents/')) {
        return jsonResponse(200, { sha: 'blob-sha', size: mainContent.length, type: 'file', encoding: 'base64', content: base64(mainContent) });
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

  // The fix: an explicit pin away from the session's effective ref must skip
  // the session overlay entirely, not just the main-only cache paths.
  it('an opts.ref pin away from the session skips the overlay, even if the overlay has the path', async () => {
    stubFetch('MAIN CONTENT');
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    (backend as unknown as BackendInternals).sessionOverlays.set('alice', new Map([['some/file.json', 'STAGED CONTENT']]));

    const result = await backend.readFile('/some/file.json', { ref: 'main' });

    expect(result).toBe('MAIN CONTENT');
    expect(fetchCalls.some(c => c.url.includes('/contents/'))).toBe(true);

    backend.shutdown();
  });

  // Unaffected: no pin (or a pin equal to the effective ref) still consults
  // the overlay exactly as before.
  it('opts.ref equal to the effective ref still consults the overlay (unaffected)', async () => {
    stubFetch('MAIN CONTENT');
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    (backend as unknown as BackendInternals).sessionOverlays.set('alice', new Map([['some/file.json', 'STAGED CONTENT']]));

    const result = await backend.readFile('/some/file.json', { ref: 'api-session/alice' });

    expect(result).toBe('STAGED CONTENT');
    expect(fetchCalls.length).toBe(0);

    backend.shutdown();
  });

  it('no opts at all still consults the overlay (unaffected — the common case)', async () => {
    stubFetch('MAIN CONTENT');
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    (backend as unknown as BackendInternals).sessionOverlays.set('alice', new Map([['some/file.json', 'STAGED CONTENT']]));

    const result = await backend.readFile('/some/file.json');

    expect(result).toBe('STAGED CONTENT');
    expect(fetchCalls.length).toBe(0);

    backend.shutdown();
  });

  // The documented exception (calibrationStore.ts's append-within-request
  // flows): consultOverlayOnPin opts back into pre-t/4510 behavior.
  it('consultOverlayOnPin: true consults the overlay even when pinned away (the calibrationStore exception)', async () => {
    stubFetch('MAIN CONTENT');
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    (backend as unknown as BackendInternals).sessionOverlays.set('alice', new Map([['some/file.json', 'STAGED CONTENT']]));

    const result = await backend.readFile('/some/file.json', { ref: 'main', consultOverlayOnPin: true });

    expect(result).toBe('STAGED CONTENT');
    expect(fetchCalls.length).toBe(0);

    backend.shutdown();
  });

  it('opts.ref wins over an active session branch (no overlay entry)', async () => {
    stubFetch('MAIN CONTENT');
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    const result = await backend.readFile('/some/pinned.json', { ref: 'main' });

    expect(result).toBe('MAIN CONTENT');

    backend.shutdown();
  });

  it('base branch, no session — unaffected (overlay lookup is a no-op either way)', async () => {
    stubFetch('MAIN CONTENT');
    const backend = await createBackend();

    const result = await backend.readFile('/some/base.json');

    expect(result).toBe('MAIN CONTENT');

    backend.shutdown();
  });
});
