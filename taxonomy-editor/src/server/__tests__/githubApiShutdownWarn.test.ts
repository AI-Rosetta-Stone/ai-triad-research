// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/4258 Part 1: shutdown() and commitOverlay() failure both WARN about
 * uncommitted overlay entries instead of silently losing them. Minimal
 * self-contained mock harness mirroring githubApiOverlayPrecondition.test.ts.
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

const recordedEvents: unknown[] = [];
vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: vi.fn().mockReturnValue({ record: (e: unknown) => recordedEvents.push(e) }),
  FlightRecorder: vi.fn(),
}));

const warnCalls: unknown[][] = [];
vi.mock('../logger.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const logActual = actual.log as Record<string, { warn: (...args: unknown[]) => void }>;
  return {
    ...actual,
    log: { ...logActual, storage: { ...logActual.storage, warn: (...args: unknown[]) => warnCalls.push(args) } },
  };
});

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

function handleDefaultGithubApi(url: string, method: string): Response {
  const path = url.replace('https://api.github.com', '');
  if (method === 'GET' && path.includes('/commits/main')) return mockFetchResponse(200, { sha: MAIN_SHA });
  if (method === 'GET' && path.match(/\/git\/commits\/[a-f0-9]/)) return mockFetchResponse(200, { sha: MAIN_SHA, tree: { sha: TREE_SHA } });
  if (method === 'GET' && path.includes('/git/trees/')) {
    return mockFetchResponse(200, {
      sha: TREE_SHA, truncated: false,
      tree: [{ path: 'taxonomy/nodes.json', mode: '100644', type: 'blob', sha: 'blob1', size: 100 }],
    });
  }
  if (method === 'PUT' && path.includes('/contents/')) return mockFetchResponse(200, { content: { sha: 'new-blob-sha' } });
  if (method === 'GET' && path.includes('/contents/')) {
    return mockFetchResponse(200, { content: Buffer.from('{"test": true}').toString('base64'), encoding: 'base64', sha: 'blob-sha' });
  }
  return mockFetchResponse(404, { message: 'Not Found' });
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  apiHandlers = [];
  recordedEvents.length = 0;
  warnCalls.length = 0;
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

function mockSessionBranchLookup(branch: string, sha: string, content = '{"test": true}'): void {
  const refQuery = `ref=${encodeURIComponent(branch)}`;
  apiHandlers.push((url, init) => {
    if ((init?.method ?? 'GET') !== 'GET' || !url.includes('/contents/taxonomy/nodes.json') || !url.includes(refQuery)) {
      return null;
    }
    return { status: 200, body: { content: Buffer.from(content).toString('base64'), encoding: 'base64', sha } };
  });
}

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — t/4258 uncommitted-overlay WARN', () => {
  it('shutdown() with a populated overlay logs a WARN with the entry count and paths', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    mockSessionBranchLookup('api-session/alice', 'blob1');
    await backend.writeFile('/taxonomy/nodes.json', '{"v": 1}', { baseSha: 'blob1' });

    backend.shutdown();

    expect(warnCalls.length).toBe(1);
    const [meta] = warnCalls[0] as [{ summary: { userId: string; entryCount: number; paths: string[] }[] }];
    expect(meta.summary).toEqual([{ userId: 'alice', entryCount: 1, paths: ['taxonomy/nodes.json'] }]);
    expect(recordedEvents.length).toBe(1);
    expect((recordedEvents[0] as { level: string }).level).toBe('warn');
  });

  it('getUncommittedOverlaySummary() exposes the same summary used by the shutdown WARN (t/4276)', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    mockSessionBranchLookup('api-session/alice', 'blob1');
    await backend.writeFile('/taxonomy/nodes.json', '{"v": 1}', { baseSha: 'blob1' });

    expect(backend.getUncommittedOverlaySummary()).toEqual([
      { userId: 'alice', entryCount: 1, paths: ['taxonomy/nodes.json'] },
    ]);

    backend.shutdown();
  });

  it('getUncommittedOverlaySummary() returns [] when no overlay is dirty', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    expect(backend.getUncommittedOverlaySummary()).toEqual([]);
    backend.shutdown();
  });

  it('shutdown() with no pending overlay entries logs nothing', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    backend.shutdown();

    expect(warnCalls.length).toBe(0);
    expect(recordedEvents.length).toBe(0);
  });

  it('commitOverlay() failure logs a WARN before rethrowing, and the overlay is left intact', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    mockSessionBranchLookup('api-session/alice', 'blob1');
    await backend.writeFile('/taxonomy/nodes.json', '{"v": 1}', { baseSha: 'blob1' });

    // Force step 4 (ref update) to fail.
    apiHandlers.push((url, init) => {
      if ((init?.method ?? 'GET') === 'PATCH' && url.includes('/git/refs/heads/')) {
        return { status: 409, body: { message: 'ref update conflict' } };
      }
      return null;
    });

    await expect(backend.commitOverlay('alice')).rejects.toThrow();

    expect(warnCalls.length).toBe(1);
    expect(recordedEvents.length).toBe(1);
    expect((recordedEvents[0] as { level: string }).level).toBe('warn');
    expect(backend.getSessionOverlay('alice')?.get('taxonomy/nodes.json')).toBe('{"v": 1}');
    backend.shutdown();
  });
});
