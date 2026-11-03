// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * GraphQL batched blob read tests for GitHubAPIBackend.readFilesBatch
 * (t/4499, TL design t/4499#18) — split into its own file (not appended to
 * githubApi.test.ts) because that file is already at its max-lines ceiling
 * (2000), per the project's split-on-budget convention (ADR-007, see
 * githubApiOverlayPrecondition.test.ts for the precedent). Minimal
 * self-contained mock harness mirroring githubApi.test.ts's setup — see that
 * file for the full GitHub API mock surface this doesn't need.
 *
 * LOCAL-ONLY FAILURE MODE (t/2281/t/3444): see githubApi.test.ts header —
 * these tests are gated on isUndiciMajorAlignedWithRuntime() for the same
 * reason.
 *
 * The consumption side (nodeSourceIndex.ts falling back per-path and
 * producing a byte-identical index either way) is covered separately in
 * nodeSourceIndexBatchRead.test.ts, without a real GitHub API mock.
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
  'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000',
  'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
};

function mockFetchResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: new Headers(defaultRateLimitHeaders) });
}

type MockHandler = (url: string, init: RequestInit) => { status: number; body?: unknown } | null;
let apiHandlers: MockHandler[] = [];

const MAIN_SHA = 'abc123def456789000000000000000000000dead';
const TREE_SHA = 'tree-sha-000000000000000000000000000dead';

// `initialize()` needs a minimal valid tree-fetch sequence before any test's
// own readFilesBatch call — this backend never calls listDirectory/readFile,
// so the tree itself is never consulted beyond that boot sequence.
function handleDefaultGithubApi(url: string, method: string): Response {
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
  vi.stubEnv('AI_TRIAD_DATA_ROOT', '/var/cache/taxonomy-test');
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    for (const handler of apiHandlers) {
      const result = handler(url, init ?? {});
      if (result) return mockFetchResponse(result.status, result.body);
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

function pathsFor(...names: string[]): string[] {
  return names.map(n => `/var/cache/taxonomy-test/summaries/${n}.json`);
}

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — readFilesBatch (t/4499)', () => {
  it('batches multiple paths into one GraphQL query and returns their content', async () => {
    const backend = await createBackend();
    const graphqlCalls: unknown[] = [];
    apiHandlers.push((url, init) => {
      if (!url.endsWith('/graphql')) return null;
      graphqlCalls.push(JSON.parse(init.body as string));
      return {
        status: 200,
        body: {
          data: {
            repository: {
              b0: { text: '{"a":1}', isTruncated: false },
              b1: { text: '{"b":2}', isTruncated: false },
            },
            rateLimit: { cost: 2 },
          },
        },
      };
    });

    const paths = pathsFor('doc-a', 'doc-b');
    const result = await backend.readFilesBatch(paths);

    expect(result.contents.get(paths[0])).toBe('{"a":1}');
    expect(result.contents.get(paths[1])).toBe('{"b":2}');
    expect(result.fallbackCount).toBe(0);
    expect(result.graphqlCost).toBe(2);
    expect(graphqlCalls).toHaveLength(1); // one chunk — well under the 80-path chunk size

    backend.shutdown();
  });

  it('a truncated blob falls back (not included in contents, counted in fallbackCount)', async () => {
    const backend = await createBackend();
    apiHandlers.push((url) => {
      if (!url.endsWith('/graphql')) return null;
      return {
        status: 200,
        body: {
          data: {
            repository: {
              b0: { text: '{"a":1}', isTruncated: false },
              b1: { text: null, isTruncated: true },
            },
            rateLimit: { cost: 2 },
          },
        },
      };
    });

    const paths = pathsFor('doc-a', 'doc-b');
    const result = await backend.readFilesBatch(paths);

    expect(result.contents.get(paths[0])).toBe('{"a":1}');
    expect(result.contents.has(paths[1])).toBe(false);
    expect(result.fallbackCount).toBe(1);

    backend.shutdown();
  });

  it('a null object (deleted/renamed blob) falls back the same way as a truncated one', async () => {
    const backend = await createBackend();
    apiHandlers.push((url) => {
      if (!url.endsWith('/graphql')) return null;
      return { status: 200, body: { data: { repository: { b0: null }, rateLimit: { cost: 1 } } } };
    });

    const result = await backend.readFilesBatch(pathsFor('doc-a'));

    expect(result.contents.size).toBe(0);
    expect(result.fallbackCount).toBe(1);

    backend.shutdown();
  });

  it('a chunk request failure falls back every path in that chunk, never throws', async () => {
    const backend = await createBackend();
    apiHandlers.push((url) => (url.endsWith('/graphql') ? { status: 500, body: { message: 'boom' } } : null));

    const paths = pathsFor('doc-a', 'doc-b', 'doc-c');
    const result = await backend.readFilesBatch(paths);

    expect(result.contents.size).toBe(0);
    expect(result.fallbackCount).toBe(3);
    expect(result.graphqlCost).toBe(0);

    backend.shutdown();
  });

  it('GraphQL body-level errors alongside partial data still return the data that came back', async () => {
    const backend = await createBackend();
    apiHandlers.push((url) => {
      if (!url.endsWith('/graphql')) return null;
      return {
        status: 200,
        body: {
          data: { repository: { b0: { text: '{"a":1}', isTruncated: false } }, rateLimit: { cost: 1 } },
          errors: [{ message: 'b1 object not found' }],
        },
      };
    });

    const result = await backend.readFilesBatch(pathsFor('doc-a'));
    expect(result.contents.get(pathsFor('doc-a')[0])).toBe('{"a":1}');

    backend.shutdown();
  });

  it('chunks a large path list into multiple GraphQL queries', async () => {
    const backend = await createBackend();
    const chunkSizes: number[] = [];
    apiHandlers.push((url, init) => {
      if (!url.endsWith('/graphql')) return null;
      const body = JSON.parse(init.body as string) as { query: string };
      const aliasCount = (body.query.match(/\bb\d+:/g) ?? []).length;
      chunkSizes.push(aliasCount);
      const repository: Record<string, { text: string; isTruncated: boolean }> = {};
      for (let i = 0; i < aliasCount; i++) repository[`b${i}`] = { text: '{}', isTruncated: false };
      return { status: 200, body: { data: { repository, rateLimit: { cost: aliasCount } } } };
    });

    const manyPaths = pathsFor(...Array.from({ length: 95 }, (_, i) => `doc-${i}`));
    const result = await backend.readFilesBatch(manyPaths);

    expect(chunkSizes.slice().sort((a, b) => a - b)).toEqual([15, 80]); // BATCH_CHUNK_SIZE = 80, concurrent chunks may resolve out of order
    expect(result.fallbackCount).toBe(0);
    expect(result.graphqlCost).toBe(95);

    backend.shutdown();
  });

  it('returns immediately with everything as fallback when given no credentials', async () => {
    const authModule = await import('../security/githubAppAuth');
    vi.mocked(authModule.getCredentials).mockResolvedValueOnce(null as never);
    const backend = await createBackend();

    const result = await backend.readFilesBatch(pathsFor('doc-a'));
    expect(result.contents.size).toBe(0);
    expect(result.fallbackCount).toBe(1);

    backend.shutdown();
  });

  it('an empty path list is a no-op (no GraphQL call)', async () => {
    const backend = await createBackend();
    let graphqlCalled = false;
    apiHandlers.push((url) => {
      if (url.endsWith('/graphql')) graphqlCalled = true;
      return null;
    });

    const result = await backend.readFilesBatch([]);
    expect(result.contents.size).toBe(0);
    expect(result.fallbackCount).toBe(0);
    expect(graphqlCalled).toBe(false);

    backend.shutdown();
  });
});
