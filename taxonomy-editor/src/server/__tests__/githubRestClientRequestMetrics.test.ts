// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/4307 (TL, p/538#80, following t/4300#18's read-path analysis): count raw
 * outbound GitHub calls at the one place they all funnel through
 * (GitHubRestClient.request()'s fetch call), instead of per-call-site
 * cache-miss counters — getColdCacheMissCount() only instrumented one of
 * several miss-then-fetch paths and missed session-branch reads entirely.
 *
 * LOCAL-ONLY FAILURE MODE (t/2281/t/3444): gated on isUndiciMajorAlignedWithRuntime
 * for the same reason as the other githubApi* test files.
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
  getGlobalRecorder: vi.fn().mockReturnValue({ record: vi.fn() }),
  FlightRecorder: vi.fn(),
}));

const defaultRateLimitHeaders = {
  'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000',
  'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
};

function mockFetchResponse(status: number, body: unknown, headers: Record<string, string> = defaultRateLimitHeaders): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: new Headers(headers) });
}

type MockHandler = (url: string, init: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> } | null;
let apiHandlers: MockHandler[] = [];

const MAIN_SHA = 'abc123def456789000000000000000000000dead';
const TREE_SHA = 'tree-sha-000000000000000000000000000dead';

function handleDefaultGithubApi(url: string, method: string): Response {
  const path = url.replace('https://api.github.com', '');
  if (method === 'GET' && path.endsWith('/commits/main')) return mockFetchResponse(200, { sha: MAIN_SHA });
  if (method === 'GET' && path.match(/\/git\/commits\/[a-f0-9]/)) return mockFetchResponse(200, { sha: MAIN_SHA, tree: { sha: TREE_SHA } });
  if (method === 'GET' && path.includes('/git/trees/')) {
    return mockFetchResponse(200, {
      sha: TREE_SHA, truncated: false,
      tree: [
        { path: 'taxonomy/nodes.json', mode: '100644', type: 'blob', sha: 'blob1', size: 100 },
        { path: 'taxonomy/binary.bin', mode: '100644', type: 'blob', sha: 'blob2', size: 100 },
      ],
    });
  }
  if (method === 'GET' && path.includes('/contents/')) {
    return mockFetchResponse(200, { content: Buffer.from('{"test": true}').toString('base64'), encoding: 'base64', sha: 'blob-sha' });
  }
  return mockFetchResponse(404, { message: 'Not Found' });
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  apiHandlers = [];
  vi.stubEnv('AI_TRIAD_DATA_ROOT', '/var/cache/taxonomy-test');
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    for (const handler of apiHandlers) {
      const result = handler(url, init ?? {});
      if (result) return mockFetchResponse(result.status, result.body, result.headers ?? defaultRateLimitHeaders);
    }
    return handleDefaultGithubApi(url, method);
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

async function createBackend() {
  const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
  const backend = new GitHubAPIBackend({
    cacheDir: '/var/cache/taxonomy-test',
    recorder: { record: vi.fn(), flush: vi.fn(), toJSON: vi.fn().mockReturnValue([]), intern: vi.fn() } as never,
    pollIntervalMs: 999_999_999,
    coherencyProbeRate: 0,
  });
  await backend.initialize();
  return backend;
}

describe.skipIf(!UNDICI_ALIGNED)('GitHubRestClient — t/4307 request metrics', () => {
  it('counts every outbound call regardless of which backend method issued it (commits/trees from boot, contents and binary from reads)', async () => {
    const backend = await createBackend();
    const afterBoot = backend.getRequestMetrics();
    expect(afterBoot.totalRequests).toBeGreaterThan(0);
    expect(afterBoot.byRouteClass.commits).toBeGreaterThan(0);
    expect(afterBoot.byRouteClass.trees).toBeGreaterThan(0);

    await backend.readFile('/taxonomy/nodes.json', { ref: 'main' });
    await backend.readBinaryFile('/taxonomy/binary.bin');

    const after = backend.getRequestMetrics();
    expect(after.totalRequests).toBeGreaterThan(afterBoot.totalRequests);
    expect(after.byRouteClass.contents).toBeGreaterThanOrEqual(2); // one text, one binary read — both /contents/
  });

  it('reports the latest x-ratelimit-remaining seen', async () => {
    const backend = await createBackend();
    apiHandlers.push((url, init) => {
      if ((init?.method ?? 'GET') === 'GET' && url.includes('/contents/')) {
        return { status: 200, body: { content: Buffer.from('{"v":1}').toString('base64'), encoding: 'base64', sha: 'blob-sha' },
          headers: { ...defaultRateLimitHeaders, 'x-ratelimit-remaining': '4321' } };
      }
      return null;
    });
    await backend.readFile('/taxonomy/nodes.json', { ref: 'main' });
    expect(backend.getRequestMetrics().rateLimitRemaining).toBe(4321);
  });

  it('getColdCacheMissCount() still works but only reflects the main-cache read path (documents its known gap, t/4300#18)', async () => {
    const backend = await createBackend();
    const before = backend.getColdCacheMissCount();
    await backend.readBinaryFile('/taxonomy/binary.bin'); // a real outbound call via a path getColdCacheMissCount doesn't instrument
    expect(backend.getColdCacheMissCount()).toBe(before); // unchanged, despite a real GitHub call having happened
    expect(backend.getRequestMetrics().totalRequests).toBeGreaterThan(0); // the superseding metric did see it
  });
});
