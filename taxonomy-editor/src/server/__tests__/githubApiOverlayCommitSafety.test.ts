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
 * Interleaving is forced with deferred signals (onRequestStarted/gateRequest)
 * tied to real control-flow checkpoints in the code under test — not timers
 * or microtask-count assumptions (e/310#10: an earlier version of this file
 * relied on implicit microtask ordering between a scheduled `.then()` and a
 * subsequent `await`, which was wrong under CI's Node 22 and produced flaky
 * false failures; `onRequestStarted('GET', '/git/refs/heads/')` instead
 * awaits the actual first network call a commit makes, which — by
 * commitOverlayImpl's own control flow — cannot fire before its synchronous
 * pre-commit snapshot has already been taken).
 *
 * Each [SAFE] test is paired with a [FAULT ARM] test proving the defect
 * class it guards against is real — and that it's real against the actual
 * commitOverlayImpl, under the actual forced interleaving, not a standalone
 * demonstration (e/308#14 — an earlier version of C1's arm never called
 * commitOverlayImpl at all, so a pass there proved nothing about this file's
 * code): C1's arm monkey-patches the private clearing step to delegate to
 * the still-present `clearSessionOverlay` (now teardown-only) — reproducing
 * exactly what `commitOverlayImpl` called at that point before C1 — and
 * runs the identical [SAFE] C1 scenario, showing the write is lost. C2's arm
 * calls the unguarded `commitOverlayImpl` directly, twice, bypassing the
 * public `commitOverlay()`'s serialization, and — using `gateRequest(...).
 * reached(2)` to deterministically wait until both calls are inside the gate
 * before releasing it (not a guess about which arrives first) — shows two
 * PATCH calls run concurrently.
 *
 * LOCAL-ONLY FAILURE MODE (t/2281/t/3444): gated on isUndiciMajorAlignedWithRuntime
 * for the same reason as the other githubApi* test files.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isUndiciMajorAlignedWithRuntime } from '../storage/undiciInvariant.js';
import { gitBlobSha } from '../storage/gitBlobSha.js';

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

// t/4312: the commit-time base fence compares each overlay path's recorded
// base against a live tree fetch, so this default mock must reflect what was
// actually just committed — not a fixed 'blob1' forever — or the fence sees
// a spurious mismatch against its own prior commit. Tracks only
// 'taxonomy/nodes.json', the only path these tests write to by default.
let committedNodesJsonSha = 'blob1';
let pendingNodesJsonTreeOp: { sha?: string | null; content?: string } | undefined;

/** t/4312: tracks what the mock's recursive-tree GET should report for
 *  'taxonomy/nodes.json' — the commit-time base fence compares a recorded
 *  base against a live tree fetch, so this mock must reflect what was
 *  actually just committed, not a fixed 'blob1' forever, or the fence sees a
 *  spurious mismatch against its own prior commit. Runs ahead of apiHandlers
 *  so a test's own gateRequest/onRequestStarted handler intercepting the
 *  PATCH or POST can't silently skip it. */
function trackCommittedNodesJsonSha(url: string, method: string, init?: RequestInit): void {
  const path = url.replace('https://api.github.com', '');
  if (method === 'POST' && path.includes('/git/trees')) {
    const body = init?.body ? JSON.parse(init.body as string) as { tree: { path: string; sha?: string | null; content?: string }[] } : null;
    pendingNodesJsonTreeOp = body?.tree.find(e => e.path === 'taxonomy/nodes.json');
  } else if (method === 'PATCH' && path.includes('/git/refs/heads/')) {
    if (pendingNodesJsonTreeOp?.content !== undefined) committedNodesJsonSha = gitBlobSha(pendingNodesJsonTreeOp.content);
    pendingNodesJsonTreeOp = undefined;
  }
}

function handleDefaultGithubApi(url: string, method: string): Response {
  const path = url.replace('https://api.github.com', '');
  if (method === 'GET' && path.includes('/git/refs/heads/')) return mockFetchResponse(200, { object: { sha: MAIN_SHA } });
  if (method === 'POST' && path.includes('/git/trees')) return mockFetchResponse(200, { sha: TREE_SHA });
  if (method === 'POST' && path.includes('/git/commits')) return mockFetchResponse(200, { sha: `commit-${Math.random().toString(16).slice(2)}` });
  if (method === 'PATCH' && path.includes('/git/refs/heads/')) return mockFetchResponse(200, { object: { sha: MAIN_SHA } });
  if (method === 'GET' && path.includes('/git/trees/')) {
    return mockFetchResponse(200, {
      sha: TREE_SHA, truncated: false,
      tree: [{ path: 'taxonomy/nodes.json', mode: '100644', type: 'blob', sha: committedNodesJsonSha, size: 100 }],
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
  committedNodesJsonSha = 'blob1';
  pendingNodesJsonTreeOp = undefined;
  vi.stubEnv('AI_TRIAD_DATA_ROOT', '/var/cache/taxonomy-test');
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    // t/4312: observe-only, ahead of apiHandlers — a test's own gateRequest/
    // onRequestStarted handler can short-circuit a PATCH or POST before
    // handleDefaultGithubApi's own branch for it ever runs, which would
    // silently stop committedNodesJsonSha from tracking what was committed.
    trackCommittedNodesJsonSha(url, method, init);
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

/**
 * Deferred signal that resolves the instant a matching request is made (the
 * handler returns null, so it never blocks anything — purely an observation
 * point). `commitOverlayImpl`'s pre-commit snapshot (getOverlayEntries) is
 * synchronous and runs before any awaited call, including the first GET ref —
 * so awaiting this signal is a hard proof the snapshot has already happened,
 * not a guess about how many microtask ticks that takes.
 */
function onRequestStarted(method: string, urlSubstr: string): Promise<void> {
  let resolveFn!: () => void;
  const started = new Promise<void>((res) => { resolveFn = res; });
  apiHandlers.push((url, init) => {
    if ((init?.method ?? 'GET') === method && url.includes(urlSubstr)) resolveFn();
    return null;
  });
  return started;
}

/**
 * Real gate on a matching request — blocks until release() is called. Tracks
 * concurrency/total calls, and `reached(n)` resolves once `n` calls are
 * simultaneously inside the gate — the deterministic way to know a fault-arm
 * scenario's concurrent calls have actually arrived before releasing them,
 * instead of guessing from call order (e/308#14).
 */
function gateRequest(method: string, urlSubstr: string) {
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  let inFlight = 0;
  let maxConcurrent = 0;
  let total = 0;
  const reachedResolvers = new Map<number, () => void>();
  apiHandlers.push(async (url, init) => {
    if ((init?.method ?? 'GET') === method && url.includes(urlSubstr)) {
      total++;
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      reachedResolvers.get(inFlight)?.();
      await gate;
      inFlight--;
      return { status: 200, body: { object: { sha: MAIN_SHA } } };
    }
    return null;
  });
  return {
    release: () => release(),
    get total() { return total; },
    get maxConcurrent() { return maxConcurrent; },
    reached(n: number): Promise<void> {
      if (inFlight >= n) return Promise.resolve();
      return new Promise((res) => { reachedResolvers.set(n, res); });
    },
  };
}

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — t/4258/t/4277 overlay commit safety', () => {
  it('[SAFE] C1: a write that lands during a commit is NOT cleared, and a later commit persists it', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    mockSessionBranchLookup('api-session/alice', 'blob1');
    const firstWrite = await backend.writeFile('/taxonomy/nodes.json', '{"v": 1}', { baseSha: 'blob1' });

    const getRefStarted = onRequestStarted('GET', '/git/refs/heads/');
    const patch = gateRequest('PATCH', '/git/refs/heads/');
    const commitPromise = backend.commitOverlay('alice');
    await getRefStarted; // proof: the pre-commit snapshot has already been taken

    // Lands while the commit is blocked on the gated PATCH.
    await backend.writeFile('/taxonomy/nodes.json', '{"v": 2}', { baseSha: firstWrite.version });
    backend.writeToOverlay('/taxonomy/other.json', '{"new": true}');

    patch.release();
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

  it('[FAULT ARM] C1: with the clearing step patched to clear-all, the same interleaving loses the write', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'dave', branchName: 'api-session/dave' });
    mockSessionBranchLookup('api-session/dave', 'blob1');
    const firstWrite = await backend.writeFile('/taxonomy/nodes.json', '{"v": 1}', { baseSha: 'blob1' });

    // Patch the private clearing step to reproduce exactly what
    // commitOverlayImpl called at this point before C1 — clearSessionOverlay's
    // full clear-all, still present today for real session teardown. This
    // still runs the real commitOverlayImpl, under the same forced
    // interleaving as [SAFE] C1 above — only the clearing behavior changes,
    // so a pass here is not tautological (e/308#14).
    (backend as unknown as { clearCommittedOverlayEntries: (userId: string) => void }).clearCommittedOverlayEntries =
      (userId: string) => backend.clearSessionOverlay(userId);

    const getRefStarted = onRequestStarted('GET', '/git/refs/heads/');
    const patch = gateRequest('PATCH', '/git/refs/heads/');
    const commitPromise = backend.commitOverlay('dave');
    await getRefStarted;

    await backend.writeFile('/taxonomy/nodes.json', '{"v": 2}', { baseSha: firstWrite.version });
    backend.writeToOverlay('/taxonomy/other.json', '{"new": true}');

    patch.release();
    await commitPromise;

    expect(backend.getSessionOverlay('dave')).toBeUndefined(); // lost — the bug C1 fixes
  });

  it('[SAFE] C2: concurrent commitOverlay() calls for one user never run two PATCH ref calls in parallel', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'bob', branchName: 'api-session/bob' });
    mockSessionBranchLookup('api-session/bob', 'blob1');
    const firstWrite = await backend.writeFile('/taxonomy/nodes.json', '{"v": 1}', { baseSha: 'blob1' });

    const getRefStarted = onRequestStarted('GET', '/git/refs/heads/');
    const patch = gateRequest('PATCH', '/git/refs/heads/');

    const first = backend.commitOverlay('bob');
    await getRefStarted; // proof: commitPending was cleared — first is genuinely running, blocked at the gated PATCH

    // Second write + two triggers land while the first commit is still
    // running (provably — not assumed from timing).
    await backend.writeFile('/taxonomy/nodes.json', '{"v": 2}', { baseSha: firstWrite.version });
    const second = backend.commitOverlay('bob');
    const third = backend.commitOverlay('bob');

    patch.release();
    await Promise.all([first, second, third]);

    expect(patch.maxConcurrent).toBe(1); // never two PATCH ref calls for 'bob' at once
    expect(patch.total).toBe(2); // the original commit + exactly one coalesced follow-up
    expect(backend.getSessionOverlay('bob')).toBeUndefined();
  });

  it('[FAULT ARM] C2: without the serialization lock, two concurrent commits DO run PATCH in parallel', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'carol', branchName: 'api-session/carol' });
    mockSessionBranchLookup('api-session/carol', 'blob1');
    await backend.writeFile('/taxonomy/nodes.json', '{"v": 1}', { baseSha: 'blob1' });

    const patch = gateRequest('PATCH', '/git/refs/heads/');
    // commitOverlayImpl is the unguarded inner method the public
    // commitOverlay() serializes access to via commitChain/commitPending.
    // Calling it directly, twice, bypasses that lock — reproducing exactly
    // the race C2 exists to prevent.
    // Deliberate backdoor for the fault-arm test.
    const callDirect = (backend as any).commitOverlayImpl.bind(backend);
    const p1 = callDirect('carol');
    const p2 = callDirect('carol');

    // Deterministic: release only once BOTH calls are inside the gate, not
    // on the hope that neither has reached it yet (e/308#14).
    await patch.reached(2);
    patch.release();
    await Promise.allSettled([p1, p2]);

    expect(patch.maxConcurrent).toBe(2); // the exact race C2's lock prevents
  });
});
