// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/4584 (incident)/t/4586 (observability follow-up) — GitHubAPIBackend's
 * null-read reason taxonomy (`not_found` / `rate_limited` / `circuit_open` /
 * `no_creds` / `status=<n>`) and `readFileStrict`, which throws
 * `{ kind: 'transient', reason }` for every one of those except a genuine
 * `not_found`, instead of silently collapsing them to the same `null` plain
 * `readFile` serves. Split into its own file (not appended to
 * githubApi.test.ts, already at its max-lines ceiling) per the project's
 * split-on-budget convention — same minimal mock harness as
 * readFilesBatch.test.ts.
 *
 * LOCAL-ONLY FAILURE MODE (t/2281/t/3444): see githubApi.test.ts header —
 * these tests are gated on isUndiciMajorAlignedWithRuntime() for the same
 * reason.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isUndiciMajorAlignedWithRuntime } from '../storage/undiciInvariant.js';
import type { FlightRecorder, RecordInput } from '../../../../lib/flight-recorder/index';

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

const getCredentialsMock = vi.fn().mockResolvedValue({ repo: 'testowner/testrepo', token: 'test-token-abc123', mode: 'pat' as const });
vi.mock('../security/githubAppAuth', () => ({
  getCredentials: getCredentialsMock,
  getRepoSlug: vi.fn().mockReturnValue('testowner/testrepo'),
  getTokenExpiryMs: vi.fn().mockReturnValue(0),
}));

vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: vi.fn().mockReturnValue(null),
  FlightRecorder: vi.fn(),
}));

const defaultRateLimitHeaders = {
  'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000',
  'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
};

function mockFetchResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: new Headers({ ...defaultRateLimitHeaders, ...headers }) });
}

type MockHandler = (url: string, init: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> } | null;
let apiHandlers: MockHandler[] = [];

const MAIN_SHA = 'abc123def456789000000000000000000000dead';
const TREE_SHA = 'tree-sha-000000000000000000000000000dead';

function handleDefaultGithubApi(url: string, method: string): Response {
  // t/4585: force raw.githubusercontent.com to fall back to REST — every
  // scenario in this file is specifically about the REST-path null/throw
  // reason taxonomy (rate_limited, circuit_open, status=<n>), which a raw
  // "hit" or a raw "not in tree" 404 would short-circuit before reaching.
  if (url.startsWith('https://raw.githubusercontent.com/')) {
    return mockFetchResponse(500, { message: 'raw not mocked in this test file' });
  }
  const path = url.replace('https://api.github.com', '');
  if (method === 'GET' && path.includes('/commits/main')) return mockFetchResponse(200, { sha: MAIN_SHA });
  if (method === 'GET' && path.match(/\/git\/commits\/[a-f0-9]/)) return mockFetchResponse(200, { sha: MAIN_SHA, tree: { sha: TREE_SHA } });
  if (method === 'GET' && path.includes('/git/trees/')) {
    return mockFetchResponse(200, { sha: TREE_SHA, truncated: false, tree: [] });
  }
  return mockFetchResponse(404, { message: 'Not Found' });
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  apiHandlers = [];
  getCredentialsMock.mockResolvedValue({ repo: 'testowner/testrepo', token: 'test-token-abc123', mode: 'pat' as const });
  vi.stubEnv('AI_TRIAD_DATA_ROOT', '/var/cache/taxonomy-test');
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    for (const handler of apiHandlers) {
      const result = handler(url, init ?? {});
      if (result) return mockFetchResponse(result.status, result.body, result.headers);
    }
    return handleDefaultGithubApi(url, method);
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

function createTestRecorder(): FlightRecorder & { events: RecordInput[] } {
  const events: RecordInput[] = [];
  return { events, record: (input: RecordInput) => { events.push(input); }, flush: vi.fn(), toJSON: vi.fn().mockReturnValue([]), intern: vi.fn() } as unknown as FlightRecorder & { events: RecordInput[] };
}

async function createBackend(recorder?: FlightRecorder) {
  const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
  const backend = new GitHubAPIBackend({
    cacheDir: '/var/cache/taxonomy-test',
    recorder: recorder ?? createTestRecorder(),
    pollIntervalMs: 999_999_999,
    coherencyProbeRate: 0,
  });
  await backend.initialize();
  return backend;
}

const FILE_PATH = '/var/cache/taxonomy-test/taxonomy/Origin/entities.json';

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend.readFileStrict — null-read reason taxonomy (t/4584/t/4586)', () => {
  it('a genuine 404 still returns null, not a throw', async () => {
    const backend = await createBackend();
    apiHandlers.push((url) => (url.includes('/contents/') ? { status: 404, body: { message: 'Not Found' } } : null));

    const result = await backend.readFileStrict(FILE_PATH);
    expect(result).toBeNull();

    backend.shutdown();
  });


  it('403 with the shared quota exhausted throws reason rate_limited', async () => {
    const backend = await createBackend();
    apiHandlers.push((url) => (url.includes('/contents/') ? { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0' } } : null));

    await expect(backend.readFileStrict(FILE_PATH)).rejects.toMatchObject({ kind: 'transient', reason: 'rate_limited' });

    backend.shutdown();
  });

  it('429 throws reason rate_limited too', async () => {
    const backend = await createBackend();
    apiHandlers.push((url) => (url.includes('/contents/') ? { status: 429, body: { message: 'Too Many Requests' } } : null));

    await expect(backend.readFileStrict(FILE_PATH)).rejects.toMatchObject({ kind: 'transient', reason: 'rate_limited' });

    backend.shutdown();
  });

  it('a 500 (exhausting GitHubRestClient\'s own retries) throws reason status=500', async () => {
    const backend = await createBackend();
    apiHandlers.push((url) => (url.includes('/contents/') ? { status: 500, body: { message: 'Internal Server Error' } } : null));

    await expect(backend.readFileStrict(FILE_PATH)).rejects.toMatchObject({ kind: 'transient', reason: 'status=500' });

    backend.shutdown();
  });

  it('no credentials throws reason no_creds', async () => {
    getCredentialsMock.mockResolvedValue(null);
    const backend = await createBackend();

    await expect(backend.readFileStrict(FILE_PATH)).rejects.toMatchObject({ kind: 'transient', reason: 'no_creds' });

    backend.shutdown();
  });

  it('a tripped circuit breaker throws reason circuit_open without making a new request', async () => {
    const backend = await createBackend();
    // Trip the circuit: 5 consecutive 500s on contents reads (CIRCUIT_FAILURE_THRESHOLD).
    apiHandlers.push((url) => (url.includes('/contents/') ? { status: 500, body: { message: 'boom' } } : null));
    for (let i = 0; i < 5; i++) {
      await expect(backend.readFileStrict(`${FILE_PATH}-${i}`)).rejects.toMatchObject({ kind: 'transient' });
    }
    expect(backend.getCircuitState()).toBe('open');

    const contentsCallsBefore = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter(([u]) => String(u).includes('/contents/')).length;

    await expect(backend.readFileStrict(FILE_PATH)).rejects.toMatchObject({ kind: 'transient', reason: 'circuit_open' });

    const contentsCallsAfter = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter(([u]) => String(u).includes('/contents/')).length;
    expect(contentsCallsAfter).toBe(contentsCallsBefore); // short-circuited, no new fetch

    backend.shutdown();
  });

  it('plain readFile (non-strict) still returns null for every one of these — no behavior change for existing callers', async () => {
    const backend = await createBackend();
    apiHandlers.push((url) => (url.includes('/contents/') ? { status: 403, body: { message: 'API rate limit exceeded' } } : null));

    const result = await backend.readFile(FILE_PATH, { ref: 'main' });
    expect(result).toBeNull();

    backend.shutdown();
  });

  it('a successful read returns content and is cached to disk (same as readFile)', async () => {
    const backend = await createBackend();
    const content = JSON.stringify({ entities: [{ id: 'ent-001' }] });
    apiHandlers.push((url) => (url.includes('/contents/')
      ? { status: 200, body: { content: Buffer.from(content).toString('base64'), encoding: 'base64', sha: 'blob-sha-1' } }
      : null));

    const result = await backend.readFileStrict(FILE_PATH);
    expect(result).toBe(content);

    backend.shutdown();
  });
});
