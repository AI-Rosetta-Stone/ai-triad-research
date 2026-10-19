// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/4258/t/4277 (SO-approved, e/308#2): C1 (commitOverlayImpl must clear only
 * the entries it actually committed, not the whole user overlay) and C2 (one
 * commit at a time per user, with concurrent triggers coalesced into exactly
 * one follow-up — never two PATCH /git/refs/heads/<branch> calls in flight
 * for the same user). Harness mirrors githubApiShutdownWarn.test.ts.
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

function mockFetchResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: new Headers(defaultRateLimitHeaders) });
}

type MockHandler = (url: string, init: RequestInit) => { status: number; body?: unknown } | null | Promise<{ status: number; body?: unknown } | null>;
let apiHandlers: MockHandler[] = [];

const MAIN_SHA = 'abc123def456789000000000000000000000dead';
const TREE_SHA = 'tree-sha-000000000000000000000000000dead';

function handleDefaultGithubApi(url: string, method: string): Response {
  const path = url.replace('https://api.github.com', '');
  if (method === 'GET' && path.includes('/git/refs/heads/')) return mockFetchResponse(200, { object: { sha: MAIN_SHA } });
  if (method === 'POST' && path.includes('/git/trees')) return mockFetchResponse(200, { sha: TREE_SHA });
  if (method === 'POST' && path.includes('/git/commits')) return mockFetchResponse(200, { sha: `commit-${Math.random().toString(16).slice(2)}` });
  if (method === 'PATCH' && path.includes('/git/refs/heads/')) return mockFetchResponse(200, { object: { sha: MAIN_SHA } });
  if (method === 'GET' && path.includes('/git/trees/')) {
    return mockFetchResponse(200, {
      sha: TREE_SHA, truncated: false,
      tree: [{ path: 'taxonomy/nodes.json', mode: '100644', type: 'blob', sha: 'blob1', size: 100 }],
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
      const result = await handler(url, init ?? {});
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

/** Delays every PATCH /git/refs/heads/<branch> until `release()` is called. */
function delayPatchRef(): { release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  apiHandlers.push(async (url, init) => {
    if ((init?.method ?? 'GET') === 'PATCH' && url.includes('/git/refs/heads/')) {
      await gate;
      return { status: 200, body: { object: { sha: MAIN_SHA } } };
    }
    return null;
  });
  return { release };
}

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — t/4258/t/4277 overlay commit safety', () => {
  it('C1: a write that lands during a commit is NOT cleared, and a later commit persists it', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    mockSessionBranchLookup('api-session/alice', 'blob1');
    const first = await backend.writeFile('/taxonomy/nodes.json', '{"v": 1}', { baseSha: 'blob1' });

    const gate = delayPatchRef();
    const commitPromise = backend.commitOverlay('alice');

    // Lands while the first commit's PATCH ref is in flight.
    await backend.writeFile('/taxonomy/nodes.json', '{"v": 2}', { baseSha: first.version });
    backend.writeToOverlay('/taxonomy/other.json', '{"new": true}');

    gate.release();
    await commitPromise;

    // Neither the overwritten path nor the new path were part of what got
    // committed — both must still be staged.
    const overlay = backend.getSessionOverlay('alice');
    expect(overlay?.get('taxonomy/nodes.json')).toBe('{"v": 2}');
    expect(overlay?.get('taxonomy/other.json')).toBe('{"new": true}');

    // A second commit persists them.
    const second = await backend.commitOverlay('alice');
    expect(second?.filesCommitted).toBe(2);
    expect(backend.getSessionOverlay('alice')).toBeUndefined();
  });

  it('C2: concurrent commitOverlay() calls for one user never run two PATCH ref calls in parallel', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'bob', branchName: 'api-session/bob' });
    mockSessionBranchLookup('api-session/bob', 'blob1');
    const firstWrite = await backend.writeFile('/taxonomy/nodes.json', '{"v": 1}', { baseSha: 'blob1' });

    let inFlightPatches = 0;
    let maxConcurrentPatches = 0;
    let totalPatches = 0;
    apiHandlers.push(async (url, init) => {
      if ((init?.method ?? 'GET') === 'PATCH' && url.includes('/git/refs/heads/')) {
        totalPatches++;
        inFlightPatches++;
        maxConcurrentPatches = Math.max(maxConcurrentPatches, inFlightPatches);
        await new Promise((r) => setTimeout(r, 5));
        inFlightPatches--;
        return { status: 200, body: { object: { sha: MAIN_SHA } } };
      }
      return null;
    });

    // Second write + two triggers land while the first commit is still
    // running. `second`/`third` arrive close enough together that they must
    // coalesce into exactly one follow-up commit, not two.
    const first = backend.commitOverlay('bob');
    await backend.writeFile('/taxonomy/nodes.json', '{"v": 2}', { baseSha: firstWrite.version });
    const second = backend.commitOverlay('bob');
    const third = backend.commitOverlay('bob');

    await Promise.all([first, second, third]);

    expect(maxConcurrentPatches).toBe(1); // never two PATCH ref calls for 'bob' at once
    expect(totalPatches).toBe(2); // the original commit + exactly one coalesced follow-up
    expect(backend.getSessionOverlay('bob')).toBeUndefined();
  });
});
