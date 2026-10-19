// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/4258/t/4276 C5 (SO, e/311#2/e/315#2): flushOverlaysWithDeadline exercised against a REAL
 * GitHubAPIBackend (mocked fetch) and the REAL overlayCommitScheduler.ts — a fakeBackend never
 * runs the real commitOverlay/commitOverlayImpl HTTP sequence, so a pass there proves nothing
 * about the actual commit path. Harness mirrors githubApiOverlayCommitSafety.test.ts.
 *
 * [SAFE]: a write scheduled via the real scheduler, flushed before its debounce fires, lands in
 * the committed tree with the PATCH targeting the user's session branch.
 *
 * [FAULT ARM] vs [SAFE]: NOTE — the SO's original ask (e/315#2) was to put a retry-backoff user
 * through flushPendingOverlayCommits() and assert they're still dirty. By the time this test was
 * written, Server Storage had already closed that exact gap in overlayCommitScheduler.ts
 * (retryingOverlayCommits tracking, #3412) — flushPendingOverlayCommits() now finds and commits
 * a backoff-pending user too, so that premise no longer produces a fault. Verified directly:
 * running the retry-backoff scenario through flushPendingOverlayCommits() now empties the
 * overlay. Substituting a still-real fault: a write whose overlay entry exists but for which
 * scheduleOverlayCommit() was NEVER called at all (the historical bug class this ticket exists
 * for — e.g. routes/policyRegistry.ts's direct getBackend().writeFile() before t/4276 added the
 * scheduling call). flushPendingOverlayCommits() has nothing to find for such a user (empty
 * pending/retrying maps) and leaves them dirty; this file's flushOverlaysWithDeadline() still
 * commits them because it sweeps the backend's actual overlay contents, not scheduler state.
 *
 * LOCAL-ONLY FAILURE MODE (t/2281/t/3444): gated on isUndiciMajorAlignedWithRuntime for the same
 * reason as the other githubApi* test files.
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

// security/userContext.js and config.js are left UNMOCKED (matches githubApiOverlayCommitSafety.
// test.ts) — backend.setSessionContext({userId, branchName}) is the test-compatibility fallback
// getEffectiveRef()/getEffectiveUserId() use once the real (unmocked) AsyncLocalStorage lookup
// finds no active request scope, and toRepoPath() needs the real getDataRoot() (resolves from
// AI_TRIAD_DATA_ROOT, stubbed below). A partial mock of either previously broke the real backend
// with a missing-export error — this file never calls getCurrentUserId() itself (every user id
// is a literal test string), so there's nothing of userContext.js's surface to mock anyway.

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
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); vi.resetModules(); });

async function createBackend() {
  const { GitHubAPIBackend } = await import('../storage/githubAPIBackend.js');
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

/** Observes matching requests without blocking them, recording each call's URL + body. */
function observeRequests(method: string, urlSubstr: string): { calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  apiHandlers.push((url, init) => {
    if ((init?.method ?? 'GET') === method && url.includes(urlSubstr)) {
      calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined });
    }
    return null;
  });
  return { calls };
}

/** Points overlayCommitScheduler.ts's getBackend() at `backend`, then imports the real scheduler
 *  + flushOverlaysWithDeadline fresh so they bind to it. Must run AFTER `backend` is constructed. */
async function wireSchedulerTo(backend: Awaited<ReturnType<typeof createBackend>>) {
  vi.doMock('../storage/fileIO.js', () => ({ getBackend: () => backend }));
  vi.resetModules();
  const scheduler = await import('../storage/overlayCommitScheduler.js');
  const flush = await import('../shutdownOverlayFlush.js');
  return { ...scheduler, flushOverlaysWithDeadline: flush.flushOverlaysWithDeadline };
}

describe.skipIf(!UNDICI_ALIGNED)('flushOverlaysWithDeadline — real backend + real scheduler (t/4258/t/4276 C5)', () => {
  it('[SAFE] a write scheduled via the real scheduler, flushed before its debounce fires, lands in the committed tree with the PATCH targeting the session branch', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    mockSessionBranchLookup('api-session/alice', 'blob1');
    await backend.writeFile('/taxonomy/nodes.json', '{"v": 1}', { baseSha: 'blob1' });

    const treeCalls = observeRequests('POST', '/git/trees');
    const patchCalls = observeRequests('PATCH', '/git/refs/heads/');

    const { scheduleOverlayCommit, flushOverlaysWithDeadline } = await wireSchedulerTo(backend);
    scheduleOverlayCommit('alice'); // debounce is 2s — not fired yet

    await flushOverlaysWithDeadline(backend, Promise.resolve());

    expect(backend.getUncommittedOverlaySummary()).toEqual([]);
    expect(treeCalls.calls.length).toBeGreaterThan(0);
    const treeBody = treeCalls.calls[0].body as { tree: { path: string }[] };
    expect(treeBody.tree.some(t => t.path === 'taxonomy/nodes.json')).toBe(true);
    expect(patchCalls.calls.length).toBeGreaterThan(0);
    expect(patchCalls.calls[0].url).toContain('api-session/alice');
  });

  it('[FAULT ARM vs SAFE] a write whose overlay entry exists but was never scheduled stays dirty through flushPendingOverlayCommits(), but this flush still commits it', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    mockSessionBranchLookup('api-session/alice', 'blob1');
    // Deliberately no scheduleOverlayCommit('alice') call — reproduces the historical bug class
    // (e.g. routes/policyRegistry.ts's direct getBackend().writeFile() before t/4276 added the
    // scheduling call): the overlay is dirty, but the scheduler has never heard of this user.
    await backend.writeFile('/taxonomy/nodes.json', '{"v": 1}', { baseSha: 'blob1' });

    const { flushPendingOverlayCommits, flushOverlaysWithDeadline } = await wireSchedulerTo(backend);

    // [FAULT ARM]: the scheduler's bulk flush only drains users it knows about (its pending +
    // retrying maps) — empty here, since scheduleOverlayCommit was never called — so it does
    // nothing for alice, who stays dirty.
    await flushPendingOverlayCommits();
    expect(backend.getUncommittedOverlaySummary()).toHaveLength(1); // still dirty — the fault this arm proves

    // [SAFE]: this flush sweeps the backend's actual overlay contents instead, independent of
    // whether the scheduler was ever invoked, so it still finds and commits alice.
    await flushOverlaysWithDeadline(backend, Promise.resolve());
    expect(backend.getUncommittedOverlaySummary()).toEqual([]);
  });
});
