// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * Overlay baseSha precondition tests for GitHubAPIBackend — split out of
 * githubApi.test.ts (t/4187, p/775#18/#28) because that file was already at
 * its max-lines ceiling (2000) before this coverage existed, per the project's
 * split-on-budget convention (ADR-007). Minimal self-contained mock harness
 * mirroring githubApi.test.ts's setup — see that file for the full GitHub API
 * mock surface this doesn't need (branches, PRs, merges, etc.).
 *
 * LOCAL-ONLY FAILURE MODE (t/2281/t/3444): see githubApi.test.ts header — these
 * tests are gated on isUndiciMajorAlignedWithRuntime() for the same reason.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import { isUndiciMajorAlignedWithRuntime } from '../storage/undiciInvariant.js';
import { gitBlobSha } from '../storage/gitBlobSha.js';
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

// t/4224 (TL, p/538#48): writes/edit-loads with no pending overlay entry now
// read the session branch live (eb2b66f6) instead of falling back to the
// repo-tree/main cache — tests that need a specific live-lookup result (most
// of this file's first write in each test) push a handler here rather than
// relying on handleDefaultGithubApi's single fixed sha.
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

// t/4224 (TL, p/538#48): with no pending overlay entry, a write/edit-load now
// reads the session branch live instead of falling back to the repo-tree —
// mock that live lookup to return `sha` for taxonomy/nodes.json on the given
// branch, so a test's `baseSha` (still 'blob1' throughout this file, matching
// the pre-t/4224 repo-tree sha) keeps matching.
function mockSessionBranchLookup(branch: string, sha: string, content = '{"test": true}'): void {
  const refQuery = `ref=${encodeURIComponent(branch)}`;
  apiHandlers.push((url, init) => {
    if ((init?.method ?? 'GET') !== 'GET' || !url.includes('/contents/taxonomy/nodes.json') || !url.includes(refQuery)) {
      return null;
    }
    return { status: 200, body: { content: Buffer.from(content).toString('base64'), encoding: 'base64', sha } };
  });
}

// t/4187 (Rosetta Stone, p/775#18): the overlay fast path is where every
// hosted user save lands — baseSha must be enforced here too, or the fix
// protects no one on the web. 'blob1' is the sha mockSessionBranchLookup
// reports for this path's first write in each test below.
describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — overlay baseSha precondition (t/4187)', () => {
  it('sequential saves succeed when each uses the prior write\'s returned version', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    mockSessionBranchLookup('api-session/alice', 'blob1');

    const v1 = await backend.writeFile('/taxonomy/nodes.json', '{"v": 1}', { baseSha: 'blob1' });
    expect(v1.version).toBeTruthy();
    const v2 = await backend.writeFile('/taxonomy/nodes.json', '{"v": 2}', { baseSha: v1.version });

    expect(v2.version).toBeTruthy();
    expect(v2.version).not.toBe(v1.version);
    expect(backend.getSessionOverlay('alice')?.get('taxonomy/nodes.json')).toBe('{"v": 2}');
    backend.shutdown();
  });

  it('a stale baseSha conflicts — another tab already saved this session', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    mockSessionBranchLookup('api-session/alice', 'blob1');
    await backend.writeFile('/taxonomy/nodes.json', '{"v": 1}', { baseSha: 'blob1' });

    const err = await backend.writeFile('/taxonomy/nodes.json', '{"lost-update": true}', { baseSha: 'blob1' })
      .then(() => null, (e: unknown) => e) as { httpStatus?: number; code?: string } | null;

    expect(err?.httpStatus).toBe(409);
    expect(err?.code).toBe('WRITE_CONFLICT');
    expect(backend.getSessionOverlay('alice')?.get('taxonomy/nodes.json')).toBe('{"v": 1}');
    backend.shutdown();
  });

  it('no baseSha skips the precondition (direct fileIO caller, not the save route)', async () => {
    const recorder = createTestRecorder();
    const backend = await createBackend(recorder);
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    mockSessionBranchLookup('api-session/alice', 'blob1');
    await backend.writeFile('/taxonomy/nodes.json', '{"v": 1}', { baseSha: 'blob1' });

    const result = await backend.writeFile('/taxonomy/nodes.json', '{"v": 2}');

    expect(result.version).toBeTruthy();
    expect(recorder.events.find(e => e.type === 'storage.fallback')).toBeDefined();
    backend.shutdown();
  });

  // SO fault-arm (C1, e/302#4): the first push of this precondition only
  // re-checked the overlay once, before awaiting the live session-branch
  // lookup. Two concurrent saves of the same path by the same user (two
  // tabs — exactly the case this precondition exists for), with no overlay
  // entry yet, both saw the live lookup match their shared baseSha and both
  // wrote — the second silently overwrote the first, with no conflict ever
  // raised. Delaying the lookup here forces both writes to overlap at that
  // await, so this only passes once the overlay is re-checked synchronously
  // after the lookup resolves (githubAPIBackend.ts writeOverlayWithPrecondition).
  it('two concurrent saves with the same baseSha and a delayed lookup: exactly one succeeds, the other conflicts', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    const refQuery = `ref=${encodeURIComponent('api-session/alice')}`;
    let releaseFirst: () => void = () => {};
    const secondArrived = new Promise<void>(resolve => { releaseFirst = resolve; });
    let lookupCalls = 0;
    const priorFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if ((init?.method ?? 'GET') === 'GET' && url.includes('/contents/taxonomy/nodes.json') && url.includes(refQuery)) {
        lookupCalls++;
        if (lookupCalls === 1) {
          // Hold the first lookup open until the second save has also
          // reached its own lookup — proving both were in flight together,
          // not serialized — then let both resolve with the same sha.
          await secondArrived;
        } else {
          releaseFirst();
        }
        return mockFetchResponse(200, { content: Buffer.from('{"test": true}').toString('base64'), encoding: 'base64', sha: 'blob1' });
      }
      return priorFetch(input, init);
    }) as unknown as typeof fetch;

    const [a, b] = await Promise.allSettled([
      backend.writeFile('/taxonomy/nodes.json', '{"from": "tab-a"}', { baseSha: 'blob1' }),
      backend.writeFile('/taxonomy/nodes.json', '{"from": "tab-b"}', { baseSha: 'blob1' }),
    ]);

    expect(lookupCalls).toBe(2); // both saves actually overlapped at the live lookup
    const results = [a, b];
    const succeeded = results.filter((r): r is PromiseFulfilledResult<{ version: string }> => r.status === 'fulfilled');
    const conflicted = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(succeeded).toHaveLength(1);
    expect(conflicted).toHaveLength(1);
    expect(conflicted[0].reason).toMatchObject({ httpStatus: 409, code: 'WRITE_CONFLICT' });

    backend.shutdown();
  });

  // SO note on C1 (e/302#7): the re-check also sees a tombstone (a delete
  // staged by another concurrent call), and a tombstone means no version to
  // match — deliberately a conflict, same as 'absent', not a compare against
  // the stale pre-delete branch SHA.
  it('a save whose path was tombstoned by a concurrent delete conflicts, not a silent re-create', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    mockSessionBranchLookup('api-session/alice', 'blob1');
    await backend.deleteFile('/taxonomy/nodes.json');

    const err = await backend.writeFile('/taxonomy/nodes.json', '{"v": 1}', { baseSha: 'blob1' })
      .then(() => null, (e: unknown) => e) as { httpStatus?: number; code?: string } | null;

    expect(err?.httpStatus).toBe(409);
    expect(err?.code).toBe('WRITE_CONFLICT');
    backend.shutdown();
  });
});

// t/4201 (p/775#30/#31): readFileWithVersion must check the session overlay
// first, the same precedence as readFile — otherwise a hosted user's GET
// after a save served main's stale content instead of the overlay, so every
// later save in that session got WRITE_CONFLICT until the overlay committed.
describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — readFileWithVersion overlay precedence (t/4201)', () => {
  it('save, then GET via readFileWithVersion, then save with the returned version — succeeds, no WRITE_CONFLICT', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    mockSessionBranchLookup('api-session/alice', 'blob1');

    const v1 = await backend.writeFile('/taxonomy/nodes.json', '{"v": 1}', { baseSha: 'blob1' });

    const got = await backend.readFileWithVersion('/taxonomy/nodes.json');
    expect(got?.content).toBe('{"v": 1}');
    expect(got?.version).toBe(v1.version); // the overlay's own content hash, not main's stale blob1

    const v2 = await backend.writeFile('/taxonomy/nodes.json', '{"v": 2}', { baseSha: got?.version });
    expect(v2.version).toBeTruthy();
    expect(backend.getSessionOverlay('alice')?.get('taxonomy/nodes.json')).toBe('{"v": 2}');
    backend.shutdown();
  });
});

// t/4224 (TL design, p/538#40/#48): with no pending overlay entry,
// readFileWithVersion must read the session branch live — never main's
// on-disk cache. Disabling this branch previously failed no test, because
// every other test here already has an overlay entry by the time it calls
// readFileWithVersion (t/4201's precedence test above).
describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — readFileWithVersion reads the session branch live (t/4224)', () => {
  it('an edit load on a session branch (no overlay entry) returns the branch content, not main\'s cache', async () => {
    const backend = await createBackend();

    // TL fault-arm (p/538#50): a bare mocked live lookup doesn't catch
    // disabling the session-branch branch, because `ref` is computed once,
    // outside that branch's gate, as the session ref — so a disabled gate
    // still falls through to readFileWithVersionFromMainCache's *fetch*,
    // which (with no manifest entry) hits the same session-ref URL and the
    // same mock. A genuinely warm main cache makes the two paths diverge:
    // the main-cache path then returns synchronously from the manifest/disk
    // entry below, with no fetch at all, so a disabled gate surfaces
    // mainContent/mainSha instead of silently reproducing branchContent.
    const mainContent = '{"test": true}'; // matches handleDefaultGithubApi's content
    const mainSha = gitBlobSha(mainContent);
    vi.mocked(fsPromises.readFile).mockResolvedValue(mainContent);
    (backend as unknown as { manifest: { version: 1; generation: number; lastCommitSha: string; lastUpdated: string; files: Record<string, { sha: string; etag: string; cachedAt: string }> } }).manifest = {
      version: 1, generation: 1, lastCommitSha: 'main-commit-sha', lastUpdated: new Date().toISOString(),
      files: { 'taxonomy/nodes.json': { sha: mainSha, etag: 'main-etag', cachedAt: new Date().toISOString() } },
    };

    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    // Deliberately different from the warm main cache above — if the
    // session-branch branch were disabled, the call would return mainContent/
    // mainSha instead of these, and the assertions below would catch it.
    const branchContent = JSON.stringify({ v: 'on-the-branch' });
    mockSessionBranchLookup('api-session/alice', 'branch-sha', branchContent);

    const result = await backend.readFileWithVersion('/taxonomy/nodes.json');

    expect(result).toEqual({ content: branchContent, version: 'branch-sha' });
    expect(result?.content).not.toBe(mainContent);
    expect(result?.version).not.toBe(mainSha);

    backend.shutdown();
  });
});
