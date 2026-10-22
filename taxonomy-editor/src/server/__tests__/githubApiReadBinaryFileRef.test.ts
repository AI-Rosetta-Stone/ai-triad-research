// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/4393: `readBinaryFile` gains `opts.ref`, same contract as `readFile`/
 * `listDirectory`. `opts.ref` wins over the session's effective ref, and the
 * disk cache (main-only, same as `readFileFromMainCache`/`readFileAtRef`)
 * is now gated on `ref === baseBranch` — fixing a latent bug where every
 * call used `getEffectiveRef()` unconditionally and could serve or pollute
 * the main cache from a non-main session branch.
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

function rawResponse(status: number, body: Buffer, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: new Headers({ ...defaultRateLimitHeaders, ...headers }) });
}

async function createBackend() {
  const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
  const backend = new GitHubAPIBackend({ cacheDir: '/var/cache/taxonomy-test', pollIntervalMs: 999_999_999, coherencyProbeRate: 0 });
  await backend.initialize();
  return backend;
}

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend.readBinaryFile — opts.ref (t/4393)', () => {
  const fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];
  const originalFetch = globalThis.fetch;
  const content = Buffer.from([0xde, 0xad, 0xbe, 0xef]);

  function stubFetch(seenRefs: string[]): void {
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      fetchCalls.push({ url, headers });

      if (url.includes('/git/trees/')) return jsonResponse(200, { sha: 'tree-sha', tree: [] });
      if (url.includes('/git/refs/heads/')) return jsonResponse(200, { object: { sha: 'main-sha' } });
      if (url.includes('/contents/some/binary.bin')) {
        const refMatch = /[?&]ref=([^&]+)/.exec(url);
        seenRefs.push(refMatch ? decodeURIComponent(refMatch[1]) : '(none)');
        if (headers.Accept === 'application/vnd.github.raw+json') return rawResponse(200, content);
        return jsonResponse(200, { sha: 'blob-sha', size: content.length, type: 'file' });
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

  it('opts.ref wins over an active session branch', async () => {
    const seenRefs: string[] = [];
    stubFetch(seenRefs);
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    const result = await backend.readBinaryFile('/some/binary.bin', { ref: 'main' });

    expect(Buffer.compare(result!, content)).toBe(0);
    expect(seenRefs.every(r => r === 'main')).toBe(true);
    expect(seenRefs.length).toBeGreaterThan(0);

    backend.shutdown();
  });

  it('falls back to the session\'s effective ref when opts.ref is omitted', async () => {
    const seenRefs: string[] = [];
    stubFetch(seenRefs);
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    await backend.readBinaryFile('/some/binary.bin');

    expect(seenRefs.every(r => r === 'api-session/alice')).toBe(true);
    expect(seenRefs.length).toBeGreaterThan(0);

    backend.shutdown();
  });

  // The cache-pollution fix, its own arm (TL p/538#182): before this ticket, readBinaryFile
  // read/wrote the disk cache unconditionally regardless of ref — a non-main session read
  // could serve or pollute the main-only cache. Verified directly against the manifest,
  // without asserting on private fs mocks: a pre-seeded manifest entry must never be served
  // for a non-main ref (it always re-fetches), and a non-main read must never seed one either.
  describe('cache-pollution fix: the disk cache is main-only', () => {
    it('a pre-seeded cache entry is ignored for a non-main ref — always re-fetches', async () => {
      const seenRefs: string[] = [];
      stubFetch(seenRefs);
      const backend = await createBackend();
      // Seed the manifest as if main had already cached this path with different bytes.
      (backend as unknown as { manifest: { files: Record<string, unknown> } }).manifest = {
        files: { 'some/binary.bin': { sha: 'stale-sha', etag: '', cachedAt: new Date().toISOString() } },
      } as never;

      const result = await backend.readBinaryFile('/some/binary.bin', { ref: 'feature-branch' });

      // Got the freshly-fetched bytes, not whatever the stale cache entry implied —
      // proving the cache was never consulted for this ref.
      expect(Buffer.compare(result!, content)).toBe(0);
      expect(seenRefs).toEqual(['feature-branch']);

      backend.shutdown();
    });

    it('a non-main read never seeds the main cache manifest', async () => {
      const seenRefs: string[] = [];
      stubFetch(seenRefs);
      const backend = await createBackend();

      await backend.readBinaryFile('/some/binary.bin', { ref: 'feature-branch' });

      const manifest = (backend as unknown as { manifest: { files: Record<string, unknown> } | null }).manifest;
      expect(manifest?.files['some/binary.bin']).toBeUndefined();

      backend.shutdown();
    });

    it('a main-ref read does seed the manifest (unchanged behavior for the default case)', async () => {
      const seenRefs: string[] = [];
      stubFetch(seenRefs);
      const backend = await createBackend();

      await backend.readBinaryFile('/some/binary.bin', { ref: 'main' });

      const manifest = (backend as unknown as { manifest: { files: Record<string, unknown> } | null }).manifest;
      expect(manifest?.files['some/binary.bin']).toBeDefined();

      backend.shutdown();
    });
  });
});
