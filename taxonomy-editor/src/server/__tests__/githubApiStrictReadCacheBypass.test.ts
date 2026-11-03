// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/4778: readFileStrict bypasses disk cache to avoid serving stale "absent"
 * markers from a previous revision on cold start. A file may be marked "absent"
 * in the old revision's cache, but exist on the new revision's main branch.
 * readFileStrict always fetches fresh instead of returning the stale cache entry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isUndiciMajorAlignedWithRuntime } from '../storage/undiciInvariant.js';

const UNDICI_ALIGNED = isUndiciMajorAlignedWithRuntime();

const fakeFs = new Map<string, string>();

vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(async (p: string) => {
      const v = fakeFs.get(p);
      if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return v;
    }),
    writeFile: vi.fn(async (p: string, content: string) => { fakeFs.set(p, content); }),
    rename: vi.fn(async (from: string, to: string) => {
      const v = fakeFs.get(from);
      fakeFs.delete(from);
      if (v !== undefined) fakeFs.set(to, v);
    }),
    unlink: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const src = (actual.default ?? actual) as Record<string, unknown>;
  const patched = {
    ...src,
    promises: {
      ...(src.promises as object),
      rename: vi.fn(async (from: string, to: string) => {
        const v = fakeFs.get(from);
        fakeFs.delete(from);
        if (v !== undefined) fakeFs.set(to, v);
      }),
    },
  };
  return { ...patched, default: patched };
});

vi.mock('../security/githubAppAuth', () => ({
  getCredentials: vi.fn().mockResolvedValue({
    repo: 'testowner/testrepo',
    token: 'test-token-abc123',
    mode: 'pat' as const,
  }),
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

const MAIN_SHA = 'a'.repeat(40);

interface FetchCall { url: string; }

function makeFetchMock(opts: {
  treeFiles: string[];
  contentsHandler?: (repoPath: string) => Response;
  calls: FetchCall[];
}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    opts.calls.push({ url });

    // getLatestCommitSha(): GET /repos/{repo}/commits/{branch}
    if (url.includes('/commits/main') && !url.includes('/git/commits/')) {
      return jsonResponse(200, { sha: MAIN_SHA });
    }
    // fetchRepoTree(): GET /repos/{repo}/git/commits/{sha}
    if (url.includes('/git/commits/')) {
      return jsonResponse(200, { tree: { sha: 'tree-sha' } });
    }
    // getTree(): GET /repos/{repo}/git/trees/{sha}?recursive=1
    if (url.includes('/git/trees/')) {
      return jsonResponse(200, {
        sha: 'tree-sha',
        tree: opts.treeFiles.map(p => ({ path: p, mode: '100644', type: 'blob', sha: 'blobsha' })),
      });
    }
    if (url.includes('/contents/')) {
      const repoPath = decodeURIComponent(url.split('/contents/')[1].split('?')[0]);
      if (opts.contentsHandler) return opts.contentsHandler(repoPath);
      return jsonResponse(404, { message: 'Not Found' });
    }
    return jsonResponse(404, { message: 'Not Found' });
  }) as unknown as typeof fetch;
}

async function createBackend(opts: { pollIntervalMs?: number } = {}) {
  const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
  const backend = new GitHubAPIBackend({
    cacheDir: '/var/cache/taxonomy-test-t4778',
    pollIntervalMs: opts.pollIntervalMs ?? 999_999_999,
    coherencyProbeRate: 0,
  });
  await backend.initialize();
  return backend;
}

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend strict reads bypass disk cache (t/4778)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fakeFs.clear();
    vi.stubEnv('AI_TRIAD_DATA_ROOT', '/var/cache/taxonomy-test-t4778');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('readFileStrict bypasses stale cache marker from previous revision', async () => {
    // Simulate a cold-start scenario:
    // 1. Old revision: file was absent, cache marked it as null
    // 2. New revision: file now exists on main
    // 3. readFileStrict should always fetch fresh, not return cached null

    const calls: FetchCall[] = [];

    // First, populate the cache with a stale "absent" marker by reading
    // a file that doesn't exist yet (simulating old revision)
    globalThis.fetch = makeFetchMock({
      treeFiles: [], // file not in tree (it will exist in new revision)
      calls,
    });

    const backend1 = await createBackend();
    // This read will cache the absence (null)
    const missingRead = await backend1.readFile('/taxonomy/entities.json', { optional: true });
    expect(missingRead).toBeNull(); // Correctly absent in old revision
    backend1.shutdown();

    // Now simulate new revision: file exists on main
    const callsNewRevision: FetchCall[] = [];
    globalThis.fetch = makeFetchMock({
      treeFiles: ['taxonomy/entities.json'],
      contentsHandler: (repoPath) => {
        if (repoPath === 'taxonomy/entities.json') {
          return jsonResponse(200, {
            content: Buffer.from('{"entities": []}').toString('base64'),
            encoding: 'base64',
            sha: 'new-sha',
            type: 'file',
          });
        }
        return jsonResponse(404, { message: 'Not Found' });
      },
      calls: callsNewRevision,
    });

    const backend2 = await createBackend();
    // readFileStrict should NOT use the stale cache, must fetch fresh
    const strictRead = await backend2.readFileStrict('/taxonomy/entities.json');

    expect(strictRead).toBe('{"entities": []}'); // File now exists, fresh fetch returned it
    // Verify that a GitHub API call was made (not served from stale cache)
    expect(callsNewRevision.some(c => c.url.includes('/contents/taxonomy/entities.json'))).toBe(true);

    backend2.shutdown();
  });

  it('readFile (non-strict) can use disk cache, readFileStrict always fetches fresh', async () => {
    // Shows the difference: readFile can use cache for performance,
    // but readFileStrict always gets fresh data for correctness.

    const calls: FetchCall[] = [];

    globalThis.fetch = makeFetchMock({
      treeFiles: ['taxonomy/node.json'],
      contentsHandler: (repoPath) => {
        if (repoPath === 'taxonomy/node.json') {
          return jsonResponse(200, {
            content: Buffer.from('node-data').toString('base64'),
            encoding: 'base64',
            sha: 'node-sha',
            type: 'file',
          });
        }
        return jsonResponse(404, { message: 'Not Found' });
      },
      calls,
    });

    const backend = await createBackend();

    // First readFile — cache miss, fetches from GitHub
    const firstRead = await backend.readFile('/taxonomy/node.json', { ref: 'main' });
    expect(firstRead).toBe('node-data');
    const callsAfterFirst = calls.length;

    // Second readFile — cache hit, no new API call
    const secondRead = await backend.readFile('/taxonomy/node.json', { ref: 'main' });
    expect(secondRead).toBe('node-data');
    expect(calls.length).toBe(callsAfterFirst); // No new fetch

    // readFileStrict — bypasses cache, makes fresh API call
    const strictRead = await backend.readFileStrict('/taxonomy/node.json');
    expect(strictRead).toBe('node-data');
    expect(calls.length).toBeGreaterThan(callsAfterFirst); // New fetch made

    backend.shutdown();
  });
});
