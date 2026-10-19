// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/4258/t/4281 (TL, e/310#4): the two GitHub rate-limit alerts
 * (alert-github-rate-limit-warning/-critical, main.bicep) query
 * ContainerAppConsoleLogs_CL for "github.api.rate_limit"/"remaining"/"degraded",
 * but `updateRateLimit()` and the 429 branch in `handleNonOkStatus()` only
 * called `deps.record()` (FlightRecorder's in-memory ring buffer — never
 * console). Captures the actual Pino output and asserts the exact event
 * text/fields each branch now emits, fault-injected per branch.
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

const githubWarnCalls: unknown[][] = [];
const githubErrorCalls: unknown[][] = [];
vi.mock('../logger.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const logActual = actual.log as Record<string, { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void }>;
  return {
    ...actual,
    log: {
      ...logActual,
      github: {
        ...logActual.github,
        warn: (...args: unknown[]) => githubWarnCalls.push(args),
        error: (...args: unknown[]) => githubErrorCalls.push(args),
      },
    },
  };
});

const defaultRateLimitHeaders = {
  'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000',
  'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
};

function mockFetchResponse(status: number, body: unknown, headers: Record<string, string> = defaultRateLimitHeaders): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: new Headers(headers) });
}

type MockHandler = (url: string, init: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> } | null;
let apiHandlers: MockHandler[] = [];

function handleDefaultGithubApi(url: string, method: string): Response {
  const path = url.replace('https://api.github.com', '');
  if (method === 'GET' && path.includes('/commits/main')) return mockFetchResponse(200, { sha: 'main-sha-0000000000000000000000000000dead' });
  return mockFetchResponse(404, { message: 'Not Found' });
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  apiHandlers = [];
  githubWarnCalls.length = 0;
  githubErrorCalls.length = 0;
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

describe.skipIf(!UNDICI_ALIGNED)('GitHubRestClient — t/4258/t/4281 rate-limit alert emitters', () => {
  it('remaining < 1000 (warning tier): logs github.api.rate_limit with "remaining" but not "degraded"', async () => {
    apiHandlers.push((url, init) => {
      if ((init?.method ?? 'GET') === 'GET' && url.includes('/commits/main')) {
        return { status: 200, body: { sha: 'main-sha-0000000000000000000000000000dead' },
          headers: { ...defaultRateLimitHeaders, 'x-ratelimit-remaining': '800' } };
      }
      return null;
    });
    await createBackend();

    expect(githubWarnCalls.length).toBeGreaterThanOrEqual(1);
    const [data, message] = githubWarnCalls[0] as [{ remaining: number; degraded: boolean }, string];
    expect(message).toContain('github.api.rate_limit');
    expect(message).toContain('remaining');
    expect(message).not.toContain('degraded');
    expect(data.remaining).toBe(800);
    expect(data.degraded).toBe(false);
  });

  it('remaining < 500 (critical tier): logs github.api.rate_limit with "degraded"', async () => {
    apiHandlers.push((url, init) => {
      if ((init?.method ?? 'GET') === 'GET' && url.includes('/commits/main')) {
        return { status: 200, body: { sha: 'main-sha-0000000000000000000000000000dead' },
          headers: { ...defaultRateLimitHeaders, 'x-ratelimit-remaining': '450' } };
      }
      return null;
    });
    await createBackend();

    expect(githubWarnCalls.length).toBeGreaterThanOrEqual(1);
    const [data, message] = githubWarnCalls[0] as [{ remaining: number; degraded: boolean }, string];
    expect(message).toContain('github.api.rate_limit');
    expect(message).toContain('degraded');
    expect(data.remaining).toBe(450);
    expect(data.degraded).toBe(true);
  });

  it('remaining >= 1000: no rate-limit log at all', async () => {
    apiHandlers.push((url, init) => {
      if ((init?.method ?? 'GET') === 'GET' && url.includes('/commits/main')) {
        return { status: 200, body: { sha: 'main-sha-0000000000000000000000000000dead' },
          headers: { ...defaultRateLimitHeaders, 'x-ratelimit-remaining': '4999' } };
      }
      return null;
    });
    await createBackend();
    expect(githubWarnCalls.length).toBe(0);
  });

  it('a 429 response: logs github.api.rate_limit with "degraded" (the primary-429 arm of the critical alert)', async () => {
    apiHandlers.push((url, init) => {
      if ((init?.method ?? 'GET') === 'GET' && url.includes('/commits/main')) {
        return { status: 429, body: { message: 'rate limited' },
          headers: { ...defaultRateLimitHeaders, 'x-ratelimit-remaining': '0' } };
      }
      return null;
    });
    // initialize() swallows the resulting fetch failure into _dataLoadStatus — no throw expected.
    await createBackend();

    const call = githubWarnCalls.find(([, message]) => (message as string).includes('429'));
    expect(call).toBeDefined();
    const [data, message] = call as [{ remaining: number }, string];
    expect(message).toContain('github.api.rate_limit');
    expect(message).toContain('degraded');
  });
});
